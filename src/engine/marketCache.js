// M1-C1 行情缓存引擎 —— 确定性估值日解析与取价（对齐 m0/market-cache/schema.candidate.json v1.1）。
// 边界：纯函数、不发起网络请求、不读取账户数据；输入为已加载的缓存对象（合成夹具、已签收静态件或 Tushare 动态响应）。
// 口径：B2 估值只用不复权、前复权仅用于注明口径的展示；B3 非交易日取不晚于请求日的最近交易日、超范围阻断且不静默改期；
//       B4 缺价返回 null 不回退到其他日期；有效估值日早于账单末笔交易日 → 阻断（S5）。
// 候选新增：E_NO_EFFECTIVE_TRADING_DAY（请求日位于范围内但早于首个交易日；B7 授权的候选细化，待三方审校）。
// R2 签收门：assessCacheDoc 校验 frozen + sign_off 自描述签名；未签收/未冻结的缓存不得进入产品链路。
// 不在本模块：股数事件检测（按 C1/D1 v1 不实现；300750 2023-04-26 靠演示避让与用户账单风险披露）。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^\d{6}$/;
const SERIES_FIELD = { unadj: 'bars', fwdadj: 'bars_fwdadj' };

export const MARKET_CACHE_CODES = Object.freeze({
  OUT_OF_RANGE: 'E_VALUATION_OUT_OF_RANGE',
  NO_EFFECTIVE_DAY: 'E_NO_EFFECTIVE_TRADING_DAY',
  BEFORE_LAST_TRADE: 'E_VALUATION_BEFORE_LAST_TRADE',
  PRICE_MISSING: 'E_PRICE_MISSING',
});

export const MARKET_CACHE_GATE_CODES = Object.freeze({
  NOT_FROZEN: 'NOT_FROZEN',
  NOT_SIGNED: 'NOT_SIGNED',
  MALFORMED: 'MALFORMED',
});

export const MARKET_DYNAMIC_GATE_CODES = Object.freeze({
  NOT_DYNAMIC: 'NOT_DYNAMIC',
  MALFORMED: 'MALFORMED',
});

const CHECKSUM_RE = /^[0-9a-f]{64}$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function assertDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new TypeError(`日期须为 YYYY-MM-DD：${value}`);
}

// R2 签收门：自描述签收缓存（artifact=market-cache-signed、frozen=true、内嵌 sign_off）才 usable。
export function assessCacheDoc(doc) {
  const fail = (reason, detail = null) => ({ usable: false, signed: false, reason, detail });
  if (!doc || typeof doc !== 'object') return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'document');
  if (doc.artifact !== 'market-cache-signed') return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'artifact');
  if (doc.frozen !== true) return fail(MARKET_CACHE_GATE_CODES.NOT_FROZEN);
  const so = doc.sign_off;
  if (!so || typeof so.accepted_by !== 'string' || so.accepted_by.trim() === ''
    || typeof so.accepted_date !== 'string' || !DATE_RE.test(so.accepted_date)) {
    return fail(MARKET_CACHE_GATE_CODES.NOT_SIGNED);
  }
  const m = doc.manifest;
  if (!m || !Array.isArray(m.symbols) || m.symbols.length === 0 || !m.symbols.every((s) => typeof s === 'string' && SYMBOL_RE.test(s))) {
    return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'manifest.symbols');
  }
  if (!m.date_range || !DATE_RE.test(m.date_range.start) || !DATE_RE.test(m.date_range.end) || m.date_range.start > m.date_range.end) {
    return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'manifest.date_range');
  }
  if (typeof m.asOfDate !== 'string' || !DATE_RE.test(m.asOfDate) || m.asOfDate < m.date_range.start || m.asOfDate > m.date_range.end) {
    return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'manifest.asOfDate');
  }
  const days = doc.calendar?.trading_days;
  if (!Array.isArray(days) || days.length === 0 || !days.every((d) => typeof d === 'string' && DATE_RE.test(d))) {
    return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'calendar.trading_days');
  }
  if (!doc.symbols || typeof doc.symbols !== 'object' || Array.isArray(doc.symbols)) {
    return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'symbols');
  }
  const keys = Object.keys(doc.symbols);
  if (keys.length !== m.symbols.length || m.symbols.some((s) => !doc.symbols[s])) {
    return fail(MARKET_CACHE_GATE_CODES.MALFORMED, 'symbols.coverage');
  }
  return {
    usable: true,
    signed: true,
    reason: null,
    detail: null,
    accepted_by: so.accepted_by,
    accepted_date: so.accepted_date,
    manifest_version: doc.manifest_version ?? null,
    symbols: [...m.symbols],
    range: { ...m.date_range },
    asOfDate: m.asOfDate,
  };
}

// 动态行情门：服务端 Tushare 响应（artifact=market-cache-dynamic）的形状/范围/序列校验。
// 与静态签收门不同：动态数据没有人工签收，必须带 fetched_at / snapshot_id / checksum 供展示留痕；
// 任一不符即不可用，不静默回退静态缓存或合成行情（由调用方明确阻断）。
export function assessDynamicCacheDoc(doc) {
  const fail = (reason, detail = null) => ({
    usable: false, dynamic: true, signed: false, reason, detail,
  });
  if (!doc || typeof doc !== 'object') return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'document');
  if (doc.artifact !== 'market-cache-dynamic') return fail(MARKET_DYNAMIC_GATE_CODES.NOT_DYNAMIC, 'artifact');
  if (doc.source?.provider !== 'tushare') return fail(MARKET_DYNAMIC_GATE_CODES.NOT_DYNAMIC, 'source.provider');
  if (typeof doc.fetched_at !== 'string' || !ISO_TIME_RE.test(doc.fetched_at) || Number.isNaN(Date.parse(doc.fetched_at))) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'fetched_at');
  }
  if (typeof doc.checksum !== 'string' || !CHECKSUM_RE.test(doc.checksum)) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'checksum');
  }
  const m = doc.manifest;
  if (!m || !Array.isArray(m.symbols) || m.symbols.length === 0
    || !m.symbols.every((s) => typeof s === 'string' && SYMBOL_RE.test(s))
    || new Set(m.symbols).size !== m.symbols.length) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'manifest.symbols');
  }
  if (!m.date_range || !DATE_RE.test(m.date_range.start) || !DATE_RE.test(m.date_range.end) || m.date_range.start > m.date_range.end) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'manifest.date_range');
  }
  if (typeof m.asOfDate !== 'string' || !DATE_RE.test(m.asOfDate) || m.asOfDate < m.date_range.start || m.asOfDate > m.date_range.end) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'manifest.asOfDate');
  }
  const snap = doc.snapshot;
  if (!snap || typeof snap !== 'object'
    || typeof snap.snapshot_id !== 'string' || snap.snapshot_id.trim() === ''
    || snap.latest_trade_date !== m.asOfDate) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'snapshot');
  }
  const days = doc.calendar?.trading_days;
  if (!Array.isArray(days) || days.length === 0
    || !days.every((d) => typeof d === 'string' && DATE_RE.test(d))
    || days.some((d, i) => d < m.date_range.start || d > m.date_range.end || (i > 0 && d <= days[i - 1]))) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'calendar.trading_days');
  }
  if (!doc.symbols || typeof doc.symbols !== 'object' || Array.isArray(doc.symbols)) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'symbols');
  }
  const keys = Object.keys(doc.symbols);
  if (keys.length !== m.symbols.length || m.symbols.some((s) => !doc.symbols[s])) {
    return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, 'symbols.coverage');
  }
  const daySet = new Set(days);
  for (const sym of m.symbols) {
    const series = doc.symbols[sym];
    if (!series || typeof series !== 'object') return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, `symbols.${sym}`);
    for (const field of ['bars', 'bars_fwdadj']) {
      const bars = series[field];
      if (!Array.isArray(bars)) return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, `symbols.${sym}.${field}`);
      let prev = null;
      for (const bar of bars) {
        if (!bar || typeof bar !== 'object'
          || typeof bar.date !== 'string' || !DATE_RE.test(bar.date) || !daySet.has(bar.date)
          || (prev !== null && bar.date <= prev)) {
          return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, `symbols.${sym}.${field}.date`);
        }
        prev = bar.date;
        if (typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0) {
          return fail(MARKET_DYNAMIC_GATE_CODES.MALFORMED, `symbols.${sym}.${field}.close`);
        }
      }
    }
  }
  return {
    usable: true,
    dynamic: true,
    signed: false,
    reason: null,
    detail: null,
    provider: doc.source.provider,
    fetched_at: doc.fetched_at,
    snapshot_id: snap.snapshot_id,
    checksum: doc.checksum,
    latest_trade_date: snap.latest_trade_date,
    manifest_version: doc.manifest_version ?? null,
    symbols: [...m.symbols],
    range: { ...m.date_range },
    asOfDate: m.asOfDate,
  };
}

// 沪深 300 第三线是可选附加序列：形状不合法时静默忽略（不阻断个股估值），
// 但绝不补价、补日期或拿个股冒充指数。
export function normalizeBenchmarkDoc(benchmark, tradingDays) {
  if (!benchmark || typeof benchmark !== 'object' || benchmark.available !== true) return null;
  if (!Array.isArray(benchmark.bars) || benchmark.bars.length === 0) return null;
  const daySet = new Set(tradingDays);
  const bars = [];
  let previous = null;
  for (const bar of benchmark.bars) {
    if (!bar || typeof bar !== 'object'
      || typeof bar.date !== 'string' || !DATE_RE.test(bar.date) || !daySet.has(bar.date)
      || (previous !== null && bar.date <= previous)) return null;
    if (typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0) return null;
    bars.push({ date: bar.date, close: bar.close });
    previous = bar.date;
  }
  return {
    ts_code: typeof benchmark.ts_code === 'string' ? benchmark.ts_code : null,
    name: typeof benchmark.name === 'string' ? benchmark.name : '沪深300',
    source: typeof benchmark.source === 'string' ? benchmark.source : null,
    as_of: typeof benchmark.as_of === 'string' ? benchmark.as_of : null,
    base_date: bars[0].date,
    base_close: bars[0].close,
    bars,
  };
}

export function createMarketCache({ tradingDays, range, symbols, snapshot = null, benchmark = null }) {
  const days = [...tradingDays].sort();
  const closeIndex = new Map();
  for (const [sym, series] of Object.entries(symbols)) {
    closeIndex.set(sym, {
      bars: new Map((series.bars ?? []).map((b) => [b.date, b.close])),
      bars_fwdadj: new Map((series.bars_fwdadj ?? []).map((b) => [b.date, b.close])),
    });
  }
  const benchmarkIndex = normalizeBenchmarkDoc(benchmark, days);
  const benchmarkCloses = new Map((benchmarkIndex?.bars ?? []).map((b) => [b.date, b.close]));

  function getClose(symbol, date, seriesKey = 'unadj') {
    assertDate(date);
    const field = SERIES_FIELD[seriesKey];
    if (!field) throw new TypeError(`未知序列：${seriesKey}（仅支持 unadj/fwdadj）`);
    const close = closeIndex.get(symbol)?.[field].get(date);
    return close === undefined ? null : close; // 缺价不回落（B4）
  }

  function getBenchmarkClose(date) {
    assertDate(date);
    const close = benchmarkCloses.get(date);
    return close === undefined ? null : close;
  }

  function resolveValuation(requestedDate) {
    assertDate(requestedDate);
    if (requestedDate < range.start || requestedDate > range.end) {
      return { requested_date: requestedDate, effective_date: null, blocked: true, code: MARKET_CACHE_CODES.OUT_OF_RANGE };
    }
    let effective = null;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i] <= requestedDate) { effective = days[i]; break; }
    }
    if (effective === null) {
      return { requested_date: requestedDate, effective_date: null, blocked: true, code: MARKET_CACHE_CODES.NO_EFFECTIVE_DAY };
    }
    return { requested_date: requestedDate, effective_date: effective, blocked: false, code: null };
  }

  function resolvePrices(symbolList, effectiveDate) {
    assertDate(effectiveDate);
    const per = {};
    for (const sym of symbolList) {
      const close = getClose(sym, effectiveDate, 'unadj');
      per[sym] = close === null
        ? { blocked: true, code: MARKET_CACHE_CODES.PRICE_MISSING, close: null, no_fallback_used: true }
        : { blocked: false, code: null, close };
    }
    const anyMissing = Object.values(per).some((r) => r.blocked);
    return {
      effective_date: effectiveDate,
      per_symbol: per,
      portfolio: { blocked: anyMissing, code: anyMissing ? MARKET_CACHE_CODES.PRICE_MISSING : null },
    };
  }

  function checkLastTrade(effectiveDate, lastTradeDate) {
    assertDate(effectiveDate);
    assertDate(lastTradeDate);
    return effectiveDate < lastTradeDate
      ? { blocked: true, code: MARKET_CACHE_CODES.BEFORE_LAST_TRADE }
      : { blocked: false, code: null };
  }

  return {
    range: { ...range }, snapshot, symbols: Object.keys(symbols), tradingDays: days,
    benchmark: benchmarkIndex, getBenchmarkClose, getClose, resolveValuation, resolvePrices, checkLastTrade,
  };
}

// 数据形状适配：签收缓存 data/market-cache.json 与 Tushare 动态响应共用同一取用形状
export function fromPullDraft(doc) {
  return {
    tradingDays: doc.calendar.trading_days,
    range: doc.manifest.date_range,
    symbols: doc.symbols,
    snapshot: doc.snapshot ?? null,
    benchmark: doc.benchmark ?? null,
  };
}

// 数据形状适配：m0 合成夹具（mock-calendar.json + mock-daily-bars.json）
export function fromFixtures(calendar, barsDoc) {
  return { tradingDays: calendar.trading_days, range: barsDoc.snapshot.range, symbols: barsDoc.symbols, snapshot: barsDoc.snapshot };
}
