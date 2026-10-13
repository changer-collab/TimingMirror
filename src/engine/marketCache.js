// M1-C1 行情缓存引擎 —— 确定性估值日解析与取价（对齐 m0/market-cache/schema.candidate.json v1.1）。
// 边界：纯函数、不发起网络请求、不读取账户数据；输入为已加载的缓存对象（合成夹具或拉数草案皆可）。
// 口径：B2 估值只用不复权、前复权仅用于注明口径的展示；B3 非交易日取不晚于请求日的最近交易日、超范围阻断且不静默改期；
//       B4 缺价返回 null 不回退到其他日期；有效估值日早于账单末笔交易日 → 阻断（S5）。
// 候选新增：E_NO_EFFECTIVE_TRADING_DAY（请求日位于范围内但早于首个交易日；B7 授权的候选细化，待三方审校）。
// 不在本模块：股数事件检测（事件输入与识别依据未提供，M3 未决；B5）。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SERIES_FIELD = { unadj: 'bars', fwdadj: 'bars_fwdadj' };

export const MARKET_CACHE_CODES = Object.freeze({
  OUT_OF_RANGE: 'E_VALUATION_OUT_OF_RANGE',
  NO_EFFECTIVE_DAY: 'E_NO_EFFECTIVE_TRADING_DAY',
  BEFORE_LAST_TRADE: 'E_VALUATION_BEFORE_LAST_TRADE',
  PRICE_MISSING: 'E_PRICE_MISSING',
});

function assertDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new TypeError(`日期须为 YYYY-MM-DD：${value}`);
}

export function createMarketCache({ tradingDays, range, symbols, snapshot = null }) {
  const days = [...tradingDays].sort();
  const closeIndex = new Map();
  for (const [sym, series] of Object.entries(symbols)) {
    closeIndex.set(sym, {
      bars: new Map((series.bars ?? []).map((b) => [b.date, b.close])),
      bars_fwdadj: new Map((series.bars_fwdadj ?? []).map((b) => [b.date, b.close])),
    });
  }

  function getClose(symbol, date, seriesKey = 'unadj') {
    assertDate(date);
    const field = SERIES_FIELD[seriesKey];
    if (!field) throw new TypeError(`未知序列：${seriesKey}（仅支持 unadj/fwdadj）`);
    const close = closeIndex.get(symbol)?.[field].get(date);
    return close === undefined ? null : close; // 缺价不回落（B4）
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

  return { range: { ...range }, snapshot, symbols: Object.keys(symbols), tradingDays: days, getClose, resolveValuation, resolvePrices, checkLastTrade };
}

// 数据形状适配：拉数草案 data/market-cache.json（以及未来签收后的缓存文件）
export function fromPullDraft(doc) {
  return { tradingDays: doc.calendar.trading_days, range: doc.manifest.date_range, symbols: doc.symbols, snapshot: doc.snapshot ?? null };
}

// 数据形状适配：m0 合成夹具（mock-calendar.json + mock-daily-bars.json）
export function fromFixtures(calendar, barsDoc) {
  return { tradingDays: calendar.trading_days, range: barsDoc.snapshot.range, symbols: barsDoc.symbols, snapshot: barsDoc.snapshot };
}
