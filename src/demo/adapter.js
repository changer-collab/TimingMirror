// 数据适配层 —— 页面唯一数据出口。
// 行情来源：示例场景默认 Tushare 动态日线（同源站点 Function 取最新已收盘日线，服务端持有 token；非实时）；
//   A/A′ 保留 m0 合成夹具作回归场景。动态响应过 assessDynamicCacheDoc 校验；不可用即明确阻断，不回落静态缓存或合成夹具。
// 本地账单（已确认用户 CSV）仅使用已签收真实行情缓存（data/market-cache.json；签收门 assessCacheDoc、固定估值日不回退）；
//   签收门失败、加载失败、固定估值日不在日历等一律明确阻断，不回退动态行情、静态缓存或合成夹具。
// 数据链路（报告页·示例场景）：夹具 CSV 文本 → csvNormalize → 按交易标的/日期取所选行情 → indicators → provenance。
// 数据链路（报告页·用户账单）：确认后的标准化 state.bill → 签收真实缓存共享市场段 → runReview 复核与发布门槛 → published_facts。
// 数据链路（导入页·用户账单）：本地 CSV 文本（FileReader）→ csvNormalize 校验（仅本机，不上传、不落 localStorage）。
//   浏览器只向同源函数发送标的代码与日期范围；不发送成交、数量、价格、文件名或 CSV 内容，计算全部在本地。
// 数据链路（契约页）：CONTRACT_TEMPLATES → parseContract 预览；版本记录 → contractRuleSet（按哈希合并、重新解析、每个模板派生唯一当前规则）；
//   历史情境：每个模板的当前规则 → 按账单模式选择行情（本地账单＝已签收缓存；示例＝所选行情来源）→ dayChangePct / 交易来源 → matchContract。
// 未接线：实时/分钟级行情（当前为最新已收盘日线）、百炼真实调用；契约为候选口径（占位哈希，待 M0-C1 冻结）。
// 对话页在线复述：仅复用已确认本地账单的 review，经站点同源边界发送组合四事实（当前 fake 验证；函数未发布/激活时走兜底）。
// 边界：本层只做取数与编排，不实现计算口径；数字与展示字符串一律来自 src/engine/*（页面不重新格式化）。
import { parseCsvText, normalizeRows } from '../engine/csvNormalize.js';
import { assessCacheDoc, assessDynamicCacheDoc, createMarketCache, fromFixtures, fromPullDraft } from '../engine/marketCache.js';
import { computeIndicators, RESULT_LABELS } from '../engine/indicators.js';
import { buildProvenanceReport } from '../engine/provenance.js';
import { runReview } from '../agent/reviewPipeline.js';
import { replaceSell } from '../engine/counterfactual.js';
import { CONTRACT_TEMPLATES, parseContract, dayChangePct, matchContract } from '../engine/contractMatch.js';

// 动态行情 Endpoint（同源；服务端注入 TUSHARE_TOKEN，浏览器不接触 token）
export const MARKET_SNAPSHOT_URL = '/functions/v1/app/api/market/snapshot';
export const DEFAULT_MARKET_SOURCE = 'dynamic-tushare';
export const MARKET_SYMBOL_LIMIT = 10;
const MARKET_RANGE_PADDING_DAYS = 14;
const MARKET_TTL_MS = 60 * 1000;
const DEMO_SYMBOLS = Object.freeze(['600519', '300750', '601318']);

// 已签收真实行情缓存（本地账单专用；冻结快照，非实时）
const REAL_MARKET_URL = '/data/market-cache.json';
const REAL_MARKET_LABEL = '已签收真实行情缓存';
let signedMarketPromise = null;

const MARKET_SOURCE_META = Object.freeze({
  'dynamic-tushare': Object.freeze({
    id: 'dynamic-tushare',
    label: 'Tushare 动态日线（服务端获取，非实时）',
    shortLabel: 'Tushare 动态日线',
    cacheName: '动态行情（Tushare）',
    note: '每次打开或刷新页面时由服务端取最新已收盘日线；非实时、不含分钟级数据',
  }),
  'synthetic-fixture': Object.freeze({
    id: 'synthetic-fixture',
    label: '合成演示行情（非真实行情）',
    shortLabel: '合成演示行情',
    cacheName: '合成行情缓存',
    note: '占位代码与合成价格（m0 夹具）',
  }),
  'signed-cache': Object.freeze({
    id: 'signed-cache',
    label: REAL_MARKET_LABEL,
    shortLabel: '已签收真实缓存',
    cacheName: '已签收真实行情缓存',
    note: '本地签收的冻结行情快照（data/market-cache.json）；本地账单仅使用该缓存，非实时',
  }),
});
export const MARKET_SOURCES = Object.freeze(Object.values(MARKET_SOURCE_META));

const MARKET_FIXTURES = {
  calendar: '/m0/market-cache/fixtures/mock-calendar.json',
  bars: '/m0/market-cache/fixtures/mock-daily-bars.json',
};
// 合成夹具固定估值日（动态行情使用服务端返回的 asOfDate；已签收缓存使用 manifest 固定估值日）
export const SYNTHETIC_VALUATION_DATE = '2024-10-11';
export const DEMO_VALUATION_DATE = SYNTHETIC_VALUATION_DATE;

// 能力状态（供页面准确显示；ready 仅在完整链路验收后才置 true——PR #6 §6）
export const CAPABILITY = {
  engine: { ready: false, label: '计算引擎·仅报告页接入' },
  bailian: { ready: false, label: '百炼·未接通（对话页 fake 验证）' },
  marketCache: { ready: false, label: '行情：示例走 Tushare 动态日线（非实时）；本地账单走已签收真实缓存（签收门）' },
  contractEngine: { ready: false, label: '契约引擎·已接入（候选口径）' },
};

// 数据模式标识（PR #6 §1.1：模式必须显式标注）；本地账单模式由 USER_BILL_DATA_MODE 单独标注。
export const DATA_MODE = Object.freeze({
  id: 'demo_bill_dynamic_market',
  label: '示例交易 + Tushare 动态行情',
  note: '示例交易为合成构造，非真实账户；行情为服务端取最新已收盘日线，非实时、非投资建议；数字由本地确定性引擎计算',
});
export const SYNTHETIC_DATA_MODE = Object.freeze({
  id: 'synthetic_demo',
  label: '合成演示数据',
  note: '占位代码与合成价格（m0 夹具）；非真实账户、非真实行情；数字由本地确定性引擎计算',
});

// 场景定义：R/R′ 用 Tushare 动态行情；A/A′ 保留合成夹具作回归场景。
export const SCENARIOS = Object.freeze({
  R: {
    key: 'R', base: 'R', marketSource: 'dynamic-tushare', label: '示例 R · Tushare 动态行情',
    csv: '/m0/csv-input/fixtures/demo-bill-real.csv',
    note: '示例交易（600519 / 300750 / 601318）+ Tushare 最新已收盘日线（服务端获取，非实时）',
  },
  Rprime: {
    key: 'Rprime', base: 'R', marketSource: 'dynamic-tushare', label: '示例 R′ · 仅改一笔卖出',
    csv: '/m0/csv-input/fixtures/demo-bill-real-aprime.csv',
    note: 'R′ 场景定义：仅改第 7 行 600519 卖出价 1389.72 → 1400.00，其余交易不变',
  },
  A: {
    key: 'A', base: 'A', marketSource: 'synthetic-fixture', label: '基准账单 A',
    csv: '/m0/csv-input/fixtures/demo-bill.csv',
    note: '合成演示账单（5 笔交易；占位代码 000000 / 888888）',
  },
  Aprime: {
    key: 'Aprime', base: 'A', marketSource: 'synthetic-fixture', label: 'A′（仅改一笔卖出）',
    csv: '/m0/csv-input/fixtures/demo-bill-aprime.csv',
    note: 'A′ 场景定义：仅改第 5 行卖出价 110.00 → 115.00，其余交易不变',
  },
});
export const DEFAULT_SCENARIO = 'R';

export { RESULT_LABELS };

const textCache = new Map();

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`本地资源加载失败：${url}（HTTP ${res.status}）`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`本地资源加载失败：${url}（HTTP ${res.status}）`);
  return res.text();
}

// 同一资源只取一次；失败不缓存（重新渲染可重试）
function cachedText(url) {
  if (!textCache.has(url)) {
    textCache.set(url, fetchText(url).catch((e) => { textCache.delete(url); throw e; }));
  }
  return textCache.get(url);
}

let syntheticPromise = null;
function syntheticMarket() {
  if (!syntheticPromise) {
    syntheticPromise = (async () => {
      const [calendar, barsDoc] = await Promise.all([fetchJson(MARKET_FIXTURES.calendar), fetchJson(MARKET_FIXTURES.bars)]);
      const market = createMarketCache(fromFixtures(calendar, barsDoc));
      return {
        market,
        valuationDate: SYNTHETIC_VALUATION_DATE,
        source: {
          ...MARKET_SOURCE_META['synthetic-fixture'],
          signed: false,
          range: { ...market.range },
          symbols: [...market.symbols],
          asOfDate: SYNTHETIC_VALUATION_DATE,
          snapshot: market.snapshot,
        },
      };
    })().catch((e) => { syntheticPromise = null; throw e; });
  }
  return syntheticPromise;
}

function localTodayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDate(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// 动态行情请求范围：只含标的代码与日期区间，不含任何成交/账单信息。
// 报告与反事实只取账单标的；契约情境额外加入 3 个示例标的，便于在示例上测试规则。
export function marketScopeFromTrades(trades, { includeDemo = false } = {}) {
  const set = new Set(includeDemo ? DEMO_SYMBOLS : []);
  for (const t of trades ?? []) if (t && typeof t.symbol === 'string') set.add(t.symbol);
  const symbols = [...set].sort();
  if (symbols.length === 0) throw new Error('没有可用于行情请求的标的');
  if (symbols.length > MARKET_SYMBOL_LIMIT) {
    throw new Error(`行情标的数 ${symbols.length} 超过单次上限 ${MARKET_SYMBOL_LIMIT}：不截断、不用部分标的冒充完整组合；请拆分账单后重试`);
  }
  const dates = (trades ?? [])
    .map((t) => t && t.trade_date)
    .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (dates.length === 0) throw new Error('交易缺少可比对日期，无法确定行情范围');
  return { symbols, start: shiftDate(dates[0], -MARKET_RANGE_PADDING_DAYS), end: localTodayIso() };
}

// 短 TTL 缓存：同一标的/范围在 60 秒内复用；过期后刷新页面或再次操作会重新取最新已收盘日线。
const dynamicCache = new Map();
async function dynamicMarket(scope) {
  const key = `${scope.start}|${scope.end}|${scope.symbols.join(',')}`;
  const hit = dynamicCache.get(key);
  if (hit && Date.now() - hit.at <= MARKET_TTL_MS) return hit.promise;
  const promise = (async () => {
    let res;
    try {
      res = await fetch(MARKET_SNAPSHOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: scope.symbols, start: scope.start, end: scope.end }),
      });
    } catch {
      throw new Error('动态行情请求失败：无法连接服务端；不回落静态缓存或合成行情');
    }
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    if (!res.ok || !payload || payload.ok !== true) {
      const code = payload && typeof payload.code === 'string' ? payload.code : `HTTP_${res.status}`;
      const message = payload && typeof payload.message === 'string' ? payload.message : '服务端未返回可用响应';
      throw new Error(`动态行情获取失败：${code} · ${message}；不回落静态缓存或合成行情`);
    }
    const doc = payload.market;
    const gate = assessDynamicCacheDoc(doc);
    if (!gate.usable) {
      throw new Error(`动态行情未通过校验：${gate.reason}${gate.detail ? `（${gate.detail}）` : ''}；不回落静态缓存或合成行情`);
    }
    const missing = scope.symbols.filter((s) => !gate.symbols.includes(s));
    if (missing.length > 0) {
      throw new Error(`动态行情响应缺少请求标的：${missing.join('、')}；不回落静态缓存或合成行情`);
    }
    const market = createMarketCache(fromPullDraft(doc));
    return {
      market,
      valuationDate: gate.asOfDate,
      source: {
        ...MARKET_SOURCE_META['dynamic-tushare'],
        signed: false,
        dynamic: true,
        artifact: doc.artifact,
        provider: gate.provider,
        manifestVersion: gate.manifest_version,
        fetchedAt: gate.fetched_at,
        latestTradeDate: gate.latest_trade_date,
        snapshotId: gate.snapshot_id,
        checksum: gate.checksum,
        range: { ...gate.range },
        symbols: [...gate.symbols],
        asOfDate: gate.asOfDate,
        snapshot: doc.snapshot ?? null,
      },
    };
  })().catch((e) => {
    dynamicCache.delete(key);
    throw e;
  });
  dynamicCache.set(key, { at: Date.now(), promise });
  return promise;
}

async function loadMarket(sourceId = DEFAULT_MARKET_SOURCE, scope = null) {
  if (sourceId === 'dynamic-tushare') {
    if (!scope) throw new Error('动态行情缺少标的与日期范围（内部调用未提供）');
    return dynamicMarket(scope);
  }
  if (sourceId === 'synthetic-fixture') return syntheticMarket();
  throw new Error(`未知行情来源：${sourceId}`);
}

function marketMeta(mkt) {
  const { source, market } = mkt;
  return {
    id: source.id,
    label: source.label,
    shortLabel: source.shortLabel,
    note: source.note,
    signed: source.signed === true,
    dynamic: source.dynamic === true,
    provider: source.provider ?? null,
    fetchedAt: source.fetchedAt ?? null,
    latestTradeDate: source.latestTradeDate ?? null,
    checksum: source.checksum ?? null,
    manifestVersion: source.manifestVersion ?? null,
    snapshotId: source.snapshotId ?? null,
    asOfDate: mkt.valuationDate,
    range: { ...market.range },
    symbols: [...market.symbols],
    snapshot: market.snapshot,
  };
}

function supportScope(mkt) {
  const meta = marketMeta(mkt);
  return {
    signed: meta.signed,
    dynamic: meta.dynamic,
    provider: meta.provider,
    fetchedAt: meta.fetchedAt,
    latestTradeDate: meta.latestTradeDate,
    checksum: meta.checksum,
    snapshotId: meta.snapshotId,
    symbols: meta.symbols,
    range: meta.range,
    asOfDate: meta.asOfDate,
  };
}

// 共享市场段（示例场景）：估值日 → 末笔检查 → 取价；缺价/超范围阻断，不回落其他日期或另一行情源
function runMarketStage(trades, mkt) {
  const { market, source } = mkt;
  const val = market.resolveValuation(mkt.valuationDate);
  if (val.blocked) {
    return { ok: false, market, val, source, errors: [{ line: 0, code: val.code, message: `估值日 ${val.requested_date} 无法解析有效交易日（不静默改期）` }] };
  }
  const lastTradeDate = trades.map((t) => t.trade_date).sort()[trades.length - 1];
  const lastCheck = market.checkLastTrade(val.effective_date, lastTradeDate);
  if (lastCheck.blocked) {
    return { ok: false, market, val, source, errors: [{ line: 0, code: lastCheck.code, message: `有效估值日 ${val.effective_date} 早于账单末笔交易日 ${lastTradeDate}` }] };
  }
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const prices = market.resolvePrices(symbols, val.effective_date);
  const unblocked = symbols.filter((s) => !prices.per_symbol[s].blocked);
  const blockedSymbols = symbols.filter((s) => prices.per_symbol[s].blocked);
  const errors = blockedSymbols.map((s) => ({
    line: 0,
    code: prices.per_symbol[s].code,
    message: market.symbols.includes(s)
      ? `标的 ${s} 在估值日 ${val.effective_date} 缺价：该标的结果不发布；组合结果同样不发布（未回退其他日期）`
      : `标的 ${s} 不在${source.cacheName}支持范围（${market.symbols.join('、')}）：该标的结果不发布；组合结果同样不发布`,
  }));
  return { ok: true, market, val, source, prices, symbols, unblocked, blockedSymbols, errors };
}

/* —— 已签收真实行情缓存：本地账单专用市场段（签收门 → 固定估值日 → 准入边界 → 取价）—— */
function sourceMetadata(market, gate = null, doc = null) {
  const signed = gate?.usable === true;
  const marketSource = {
    id: doc || gate ? 'real-cache' : 'synthetic-fixture',
    label: signed ? REAL_MARKET_LABEL : doc || gate ? '真实行情缓存（不可用）' : '合成演示行情（非真实行情）',
    signed, artifact: doc?.artifact ?? null, manifestVersion: gate?.manifest_version ?? null,
    snapshotId: market?.snapshot?.snapshot_id ?? null, fetchTime: market?.snapshot?.fetch_time ?? null,
    dataSource: doc?.manifest?.data_source ?? (doc || gate ? '不可用' : 'm0 合成夹具'), calendarSource: doc?.manifest?.calendar_source ?? null,
    gate,
  };
  return {
    marketSource,
    supportScope: market ? { symbols: [...(gate?.symbols ?? market.symbols)], range: { ...market.range }, snapshot: market.snapshot, signed } : null,
    asOfDate: signed ? gate.asOfDate : doc || gate ? null : DEMO_VALUATION_DATE,
    marketRange: market ? { ...market.range } : null, snapshot: market?.snapshot ?? null,
  };
}

async function marketContext(bill) {
  if (!(bill?.status === 'confirmed' && bill.sourceType === 'local')) {
    const market = (await syntheticMarket()).market;
    return { ok: true, market, ...sourceMetadata(market), errors: [] };
  }
  if (!signedMarketPromise) {
    signedMarketPromise = (async () => {
      try {
        const doc = await fetchJson(REAL_MARKET_URL);
        const gate = assessCacheDoc(doc);
        if (!gate.usable) return {
          ok: false, market: null, ...sourceMetadata(null, gate, doc),
          errors: [{ line: 0, kind: 'CACHE_GATE', code: 'E_MARKET_CACHE_GATE', message: `真实行情缓存签收门失败：${gate.reason}${gate.detail ? `（${gate.detail}）` : ''}；禁止回退合成行情。` }],
        };
        const market = createMarketCache(fromPullDraft(doc));
        const context = { ok: true, market, ...sourceMetadata(market, gate, doc), errors: [] };
        const val = market.resolveValuation(gate.asOfDate);
        if (val.blocked) return { ...context, ok: false, val, errors: [{ line: 0, kind: 'VALUATION_OUT_OF_RANGE', code: val.code, message: `估值日 ${val.requested_date} 超出支持范围或无法解析有效交易日（不改用其他日期）` }] };
        if (val.effective_date !== gate.asOfDate) return { ...context, ok: false, val: { ...val, blocked: true, code: 'E_MARKET_ASOF_NOT_TRADING_DAY' }, errors: [{ line: 0, kind: 'NO_EFFECTIVE_DAY', code: 'E_MARKET_ASOF_NOT_TRADING_DAY', message: `已签收固定估值日 ${gate.asOfDate} 不在缓存交易日历中，禁止改用 ${val.effective_date}。` }] };
        return { ...context, val };
      } catch (e) {
        return {
          ok: false, market: null, ...sourceMetadata(null, { usable: false, signed: false, reason: 'LOAD_FAILED', detail: null }),
          errors: [{ line: 0, kind: 'CACHE_LOAD', code: 'E_MARKET_CACHE_LOAD', message: `真实行情缓存加载失败：${String(e?.message ?? e)}；禁止回退合成行情。` }],
        };
      }
    })();
  }
  const context = await signedMarketPromise;
  if (!context.ok) signedMarketPromise = null;
  return context;
}

// 本地账单准入边界：global（末笔早于估值日 / 成交日期超范围 / 已知公司行为事件）整批阻断；
// unsupported（范围外标的）不整批阻断——该标的不取价、随复核按 B4 扣发，其余受支持标的照常发布。
function localMarketBoundary(trades, context) {
  const { market, asOfDate } = context;
  const global = [];
  const unsupported = [];
  for (const symbol of new Set(trades.map((t) => t.symbol))) {
    if (!market.symbols.includes(symbol)) unsupported.push({ line: 0, kind: 'OUT_OF_SUPPORT', symbol, code: 'E_MARKET_OUT_OF_SUPPORT', message: `标的 ${symbol} 不在已签收真实行情缓存支持清单（${market.symbols.join('、')}）：该标的结果不发布；组合结果同样不发布（不按剩余标的重算）。` });
  }
  const last = trades.map((t) => t.trade_date).sort().at(-1);
  if (last > asOfDate) global.push({ line: 0, kind: 'BEFORE_LAST_TRADE', code: 'E_VALUATION_BEFORE_LAST_TRADE', message: `估值日 ${asOfDate} 早于账单末笔交易日 ${last}，本次结果阻断（不改用其他日期）。` });
  for (const t of trades) {
    if (t.trade_date < market.range.start || t.trade_date > market.range.end) global.push({ line: t.source?.line ?? 0, kind: 'TRADE_OUT_OF_RANGE', symbol: t.symbol, code: 'E_MARKET_TRADE_OUT_OF_RANGE', message: `成交日期 ${t.trade_date} 超出行情支持范围 ${market.range.start} 至 ${market.range.end}，本次结果阻断。` });
  }
  // C1 不检测或校正公司行为；已知事件前的 300750 交易一律不准入（即使实际持仓已清仓，买入后持有的对照路径仍可能跨越事件，不能断言放行是安全的），是针对已知事件的额外限制，不是通用公司行为检测。
  if (trades.some((t) => t.symbol === '300750' && t.trade_date < '2023-04-26')) global.push({ line: 0, kind: 'CORPORATE_ACTION_BOUNDARY', symbol: '300750', code: 'E_MARKET_CORPORATE_ACTION_BOUNDARY', message: '300750 涉及 2023-04-26 已知股数事件前交易，超出当前公司行为支持边界；v1 不检测、不校正公司行为，本次结果阻断（不是缺价）。即使实际持仓在事件前已清仓，买入后持有的对照路径仍可能跨越该事件，当前无法断言放行是安全的，故一律保守阻断。' });
  return { global, unsupported };
}

// 共享市场段（本地账单）：签收缓存上下文 → 准入边界 → 末笔检查 → 取价（范围外标的不取价，随复核按 B4 扣发）
async function runUserMarketStage(trades, bill = null) {
  const context = await marketContext(bill);
  if (!context.ok) return { ...context, val: context.val ?? null };
  const { market, asOfDate } = context;
  const val = context.val ?? market.resolveValuation(asOfDate);
  if (val.blocked) return { ...context, ok: false, val, errors: [{ line: 0, kind: 'VALUATION_OUT_OF_RANGE', code: val.code, message: `估值日 ${val.requested_date} 超出支持范围或无法解析有效交易日（不改用其他日期）` }] };
  let admissionErrors = [];
  if (isConfirmedLocalBill(bill)) {
    const boundary = localMarketBoundary(trades, context);
    if (boundary.global.length) return { ...context, ok: false, val, errors: boundary.global };
    admissionErrors = boundary.unsupported;
    // 全部标的都范围外：没有可发布标的，整批阻断（复核不运行，避免把准入问题误标为缺价）。
    if (admissionErrors.length && admissionErrors.length === new Set(trades.map((t) => t.symbol)).size) {
      return { ...context, ok: false, val, errors: admissionErrors };
    }
  }
  const lastTradeDate = trades.map((t) => t.trade_date).sort().at(-1);
  const lastCheck = market.checkLastTrade(val.effective_date, lastTradeDate);
  if (lastCheck.blocked) return { ...context, ok: false, val, errors: [{ line: 0, kind: 'BEFORE_LAST_TRADE', code: lastCheck.code, message: `有效估值日 ${val.effective_date} 早于账单末笔交易日 ${lastTradeDate}` }] };
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const unsupportedSymbols = admissionErrors.map((e) => e.symbol);
  const priceSymbols = unsupportedSymbols.length ? symbols.filter((s) => !unsupportedSymbols.includes(s)) : symbols;
  const prices = market.resolvePrices(priceSymbols, val.effective_date);
  const priceBlocked = priceSymbols.filter((s) => prices.per_symbol[s].blocked);
  const unblocked = priceSymbols.filter((s) => !prices.per_symbol[s].blocked);
  const blockedSymbols = [...unsupportedSymbols, ...priceBlocked];
  const stageErrors = [
    ...admissionErrors,
    ...priceBlocked.map((s) => ({
      line: 0, symbol: s, kind: market.symbols.includes(s) ? 'MISSING_PRICE' : 'OUT_OF_SUPPORT', code: prices.per_symbol[s].code,
      message: market.symbols.includes(s)
        ? `标的 ${s} 在有效估值日 ${val.effective_date} 当日缺收盘价：该标的及组合结果不发布（未回退其他日期）`
        : `标的 ${s} 不在行情缓存支持范围（${market.symbols.join('、')}）：该标的及组合结果不发布`,
    })),
  ];
  return { ...context, ok: true, val, prices, symbols, unblocked, blockedSymbols, errors: stageErrors };
}

async function normalizeBillCsv(url, fileName) {
  const text = await cachedText(url);
  return normalizeRows(parseCsvText(text), fileName ?? url.split('/').pop());
}

/* —— 导入页：示例账单（按场景来源标注；R 为 Tushare 动态行情） —— */
export const DEMO_SOURCE_NOTE = '示例数据 · m0/csv-input/fixtures（交易为合成构造，非真实账户）';

export async function loadDemoBill(scenario = DEFAULT_SCENARIO) {
  const cfg = SCENARIOS[scenario] ?? SCENARIOS[DEFAULT_SCENARIO];
  const normalized = await normalizeBillCsv(cfg.csv);
  const scope = cfg.marketSource === 'dynamic-tushare' ? marketScopeFromTrades(normalized.trades) : null;
  const mkt = await loadMarket(cfg.marketSource, scope);
  const dynamic = cfg.marketSource === 'dynamic-tushare';
  return {
    scenario: cfg.key,
    trades: normalized.trades,
    warnings: normalized.warnings,
    blocked: normalized.blocked,
    dataMode: dynamic ? DATA_MODE : SYNTHETIC_DATA_MODE,
    marketSource: marketMeta(mkt),
    supportScope: supportScope(mkt),
    sourceNote: `来源：${cfg.csv.split('/').pop()}（${dynamic ? '示例交易 + Tushare 动态日线（非实时）' : '合成夹具；占位代码非真实证券'}）`,
    resultLabelling: RESULT_LABELS,
  };
}

// 本地账单模式：仅接已签收真实行情缓存（签收门）；失败明确阻断、不回退动态行情或合成夹具。
export const USER_BILL_DATA_MODE = Object.freeze({
  id: 'user_bill_real_cache',
  label: '用户本地账单 + 真实行情缓存（须通过签收门）',
  note: '交易文件仅在本机处理；确认后只使用签收门通过的真实缓存，失败明确阻断、不回退动态行情或合成行情',
});

export async function loadUserBillFromText(csvText, fileName) {
  const name = String(fileName || 'user-bill.csv');
  const normalized = normalizeRows(parseCsvText(String(csvText)), name);
  return {
    sourceType: 'local',
    dataMode: USER_BILL_DATA_MODE,
    fileName: name,
    blocked: normalized.blocked,
    trades: normalized.trades,
    warnings: normalized.warnings,
    errors: normalized.errors,
    sourceNote: `来源：${name}（本机文件，未上传；schema ${normalized.schema_version}）`,
    resultLabelling: RESULT_LABELS,
  };
}

/* —— 报告页：示例场景引擎链路 ——
   输出契约（页面消费）：
   { scenario, scenarioMeta, dataMode, marketSource, supportScope,
     status('ok'|'partial'|'blocked'|'error'), blocked, warnings[], errors[],
     valuation{requested_date,effective_date,blocked,code}, marketRange, snapshot, prices,
     blockedSymbols[], poolBlocked, perStock{}, pool|null, display|null, provenance|null, labels } */
export async function loadReportEngine(scenario = DEFAULT_SCENARIO) {
  const key = SCENARIOS[scenario] ? scenario : DEFAULT_SCENARIO;
  const cfg = SCENARIOS[key];
  const out = {
    scenario: key,
    scenarioMeta: cfg,
    dataMode: cfg.marketSource === 'dynamic-tushare' ? DATA_MODE : SYNTHETIC_DATA_MODE,
    marketSource: null,
    supportScope: null,
    status: 'ok',
    blocked: false,
    warnings: [],
    errors: [],
    valuation: null,
    marketRange: null,
    snapshot: null,
    prices: null,
    blockedSymbols: [],
    poolBlocked: false,
    trades: [],
    perStock: {},
    pool: null,
    display: null,
    provenance: null,
    labels: RESULT_LABELS,
  };

  // 1) CSV 文本 → 标准化交易（整批阻断则不再进入后续步骤）
  const fileName = cfg.csv.split('/').pop();
  const normalized = await normalizeBillCsv(cfg.csv, fileName);
  out.warnings.push(...normalized.warnings);
  if (normalized.blocked || normalized.trades.length === 0) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push(...(normalized.errors.length ? normalized.errors : [{ line: 0, code: 'E_EMPTY', message: '账单无可计算交易' }]));
    return out;
  }
  const trades = normalized.trades;
  out.trades = trades; // 供「单笔反事实」区复用同一标准化账单（页面不解析 CSV）

  // 2) 行情来源 → 共享市场段（估值日 → 末笔检查 → 取价）；来源不可用即阻断，不回退另一来源
  let mkt;
  try {
    const scope = cfg.marketSource === 'dynamic-tushare' ? marketScopeFromTrades(trades) : null;
    mkt = await loadMarket(cfg.marketSource, scope);
  } catch (e) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push({ line: 0, code: 'E_MARKET_SOURCE', message: String(e && e.message ? e.message : e) });
    return out;
  }
  out.marketSource = marketMeta(mkt);
  out.supportScope = supportScope(mkt);
  out.marketRange = { ...mkt.market.range };
  out.snapshot = mkt.market.snapshot;
  const stage = runMarketStage(trades, mkt);
  out.valuation = stage.val;
  if (!stage.ok) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push(...stage.errors);
    return out;
  }
  out.prices = stage.prices;
  out.blockedSymbols = stage.blockedSymbols;
  if (stage.blockedSymbols.length > 0) {
    out.poolBlocked = true; // B4：不按剩余标的重算冒充完整组合
    out.errors.push(...stage.errors);
  }
  if (stage.unblocked.length === 0) {
    out.status = 'blocked';
    out.blocked = true;
    return out;
  }

  // 3) 计算（只喂未阻断标的；引擎抛错不被吞掉）
  const closes = {};
  for (const s of stage.unblocked) closes[s] = stage.prices.per_symbol[s].close;
  const usableTrades = trades.filter((t) => stage.unblocked.includes(t.symbol));
  let report;
  try {
    report = computeIndicators({ trades: usableTrades, closes });
  } catch (e) {
    out.status = 'error';
    out.errors.push({ line: 0, code: 'E_ENGINE', message: `计算引擎错误：${String(e && e.message ? e.message : e)}` });
    return out;
  }
  out.perStock = report.per_stock;
  out.pool = out.poolBlocked ? null : report.portfolio;
  out.display = out.pool ? out.pool.display : null;

  // 4) 计算路径（provenance）：阻断则对应视图不发布（主指标不受影响）
  try {
    out.provenance = buildProvenanceReport({ report, trades: usableTrades, closes, valuation: stage.val });
  } catch (e) {
    out.provenance = {
      blocked: true,
      dangling_refs: [],
      items: [],
      summary: { n: 0, blocked_n: 0 },
      errors: [{ code: 'E_PROVENANCE', message: `计算路径生成失败：${String(e && e.message ? e.message : e)}` }],
    };
  }

  out.status = out.blockedSymbols.length > 0 ? 'partial' : 'ok';
  return out;
}

/* —— 报告页：用户账单引擎链路（仅已签收真实行情缓存）——
   输出契约（页面消费）：
   { sourceType:'local', fileName, dataMode, marketSource, supportScope, asOfDate,
     status('ok'|'partial'|'blocked'|'error'), blocked, warnings[], errors[],
     valuation, marketRange, snapshot, prices, blockedSymbols[], poolBlocked,
     review, factsByScope{}, provenance, labels } */
export async function loadUserBillReport(bill) {
  const out = {
    sourceType: 'local',
    fileName: bill && bill.fileName ? bill.fileName : '',
    dataMode: USER_BILL_DATA_MODE,
    marketSource: null,
    supportScope: null,
    status: 'ok',
    blocked: false,
    warnings: [],
    errors: [],
    valuation: null,
    marketRange: null,
    snapshot: null,
    prices: null,
    blockedSymbols: [],
    poolBlocked: false,
    review: null,
    factsByScope: {},
    provenance: null,
    labels: RESULT_LABELS,
  };
  if (!bill || bill.status !== 'confirmed' || bill.sourceType !== 'local' || bill.blocked || !Array.isArray(bill.trades) || bill.trades.length === 0) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push({ line: 0, code: 'E_BILL_NOT_CONFIRMED', message: '账单未确认或校验未通过：不能进入报告（不回退演示数据）' });
    return out;
  }
  const trades = bill.trades;
  out.warnings = [...(bill.warnings ?? [])];

  const stage = await runUserMarketStage(trades, bill);
  Object.assign(out, { marketSource: stage.marketSource, supportScope: stage.supportScope, asOfDate: stage.asOfDate, marketRange: stage.marketRange, snapshot: stage.snapshot, valuation: stage.val });
  if (!stage.ok) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push(...stage.errors);
    return out;
  }
  out.prices = stage.prices;
  out.blockedSymbols = [...stage.blockedSymbols];
  out.errors.push(...stage.errors);

  // 2) runReview（全量标的 closes：范围外/缺价置 null，由复核统一扣发该标的与组合）
  const closes = {};
  for (const s of stage.symbols) {
    const p = stage.prices.per_symbol[s];
    closes[s] = p ? (p.blocked ? null : p.close) : null;
  }
  const review = runReview({ trades, closes, valuation: stage.val });
  out.review = review;
  out.provenance = review.provenance;

  const byScope = {};
  for (const f of review.published_facts) {
    (byScope[f.scope] ??= {})[f.key] = { value: f.value, display: f.display, formula_id: f.formula_id, fact_id: f.fact_id };
  }
  out.factsByScope = byScope;
  for (const b of review.blocked_symbols) {
    if (!out.blockedSymbols.includes(b.symbol)) out.blockedSymbols.push(b.symbol);
  }
  out.poolBlocked = !review.portfolio_published;

  // 3) 状态映射（词汇与演示契约一致：ok / partial / blocked；review blocked 时透出降级原因）
  if (review.status === 'blocked') {
    out.status = 'blocked';
    out.blocked = true;
    for (const d of review.degraded) out.errors.push({ line: 0, code: d.code, message: d.message });
  } else {
    out.status = review.status === 'degraded' ? 'partial' : 'ok';
  }
  return out;
}

/* —— 对话页在线复述：只取已确认本地账单的复核输出 ——
   示例账单未经 runReview，不生成 review、不回退演示数据；页面据此给出明确兜底。 */
export const CHAT_REVIEW_CODES = Object.freeze({
  BILL_NOT_CONFIRMED: 'W_CHAT_BILL_NOT_CONFIRMED',
  REVIEW_UNAVAILABLE: 'W_CHAT_REVIEW_UNAVAILABLE',
});

export async function loadChatReview(bill) {
  if (!isConfirmedLocalBill(bill)) {
    return {
      ok: false,
      code: CHAT_REVIEW_CODES.BILL_NOT_CONFIRMED,
      message: '在线复述仅使用已确认的本地账单；示例账单未经复核发布流程，不参与在线复述。',
    };
  }
  const bundle = await loadUserBillReport(bill);
  if (!bundle.review) {
    return {
      ok: false,
      code: CHAT_REVIEW_CODES.REVIEW_UNAVAILABLE,
      message: '复核未运行或行情层阻断：没有可复述的已发布事实（不回退演示数据）。',
    };
  }
  return { ok: true, review: bundle.review };
}

// 单笔卖出反事实（S1 幽灵线缺口图）—— 示例场景与用户确认账单共用本入口。
// 用户账单（bill）走已签收缓存；示例场景按 marketSource 选择行情，两者不互相回退。
export const CF_CODES = Object.freeze({
  NO_TRADES: 'E_CF_NO_TRADES',
  BAD_SCOPE: 'E_CF_BAD_SCOPE',
  SYMBOL_NOT_IN_BILL: 'E_CF_SYMBOL_NOT_IN_BILL',
  NO_SELL: 'E_CF_NO_SELL',
  TRADE_NOT_FOUND: 'E_CF_TRADE_NOT_FOUND',
  NOT_SELL: 'E_CF_NOT_SELL',
  MARKET_BLOCKED: 'E_CF_MARKET_BLOCKED',
  MARKET_SOURCE: 'E_CF_MARKET_SOURCE',
  PRICE_MISSING: 'E_CF_PRICE_MISSING',
  ENGINE_ERROR: 'E_CF_ENGINE_ERROR',
});

export async function loadSellCounterfactual({ trades, symbol, tradeId, bill = null, marketSource = DEFAULT_MARKET_SOURCE } = {}) {
  const sourceId = bill ? 'signed-cache' : (marketSource === 'synthetic-fixture' ? 'synthetic-fixture' : 'dynamic-tushare');
  const fail = (code, message) => ({
    ok: false, code, message, symbol: symbol ?? null, tradeId: tradeId ?? null,
    sellOptions: [], markers: [], replace: null, series: null, valuation: null, marketRange: null, marketSourceId: sourceId, labels: RESULT_LABELS,
  });
  if (bill && !isConfirmedLocalBill(bill)) return fail(CF_CODES.MARKET_BLOCKED, '本地账单未确认或校验未通过，不回退示例行情。');
  if (!Array.isArray(trades) || trades.length === 0) return fail(CF_CODES.NO_TRADES, '账单交易为空，无法计算单笔反事实');
  if (!symbol || symbol === 'pool') return fail(CF_CODES.BAD_SCOPE, '单笔反事实仅支持单标的作用域（组合 scope 不进入 replaceSell）');
  const symbolTrades = trades.filter((t) => t && t.symbol === symbol);
  if (symbolTrades.length === 0) return fail(CF_CODES.SYMBOL_NOT_IN_BILL, `标的 ${symbol} 不在账单中`);
  const sells = symbolTrades
    .filter((t) => t.side === 'sell')
    .sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : (a.source?.line ?? 0) - (b.source?.line ?? 0)));
  if (sells.length === 0) {
    return fail(CF_CODES.NO_SELL, `标的 ${symbol} 没有卖出记录：S1 仅支持替换卖出笔（买入侧替换 S3 未定义，v1 不做）`);
  }

  let stage;
  if (bill) {
    stage = await runUserMarketStage(trades, bill);
  } else {
    let mkt;
    try {
      const scope = marketSource === 'synthetic-fixture' ? null : marketScopeFromTrades(trades);
      mkt = await loadMarket(marketSource, scope);
    } catch (e) {
      return fail(CF_CODES.MARKET_SOURCE, String(e && e.message ? e.message : e));
    }
    stage = runMarketStage(symbolTrades, mkt);
  }
  if (!stage.ok) return fail(CF_CODES.MARKET_BLOCKED, stage.errors.map((e) => `${e.code} · ${e.message}`).join('；'));
  if (stage.blockedSymbols.includes(symbol)) {
    const e = stage.errors.find((x) => x.message && x.message.includes(symbol));
    return fail(CF_CODES.PRICE_MISSING, e ? e.message : `标的 ${symbol} 在估值日 ${stage.val.effective_date} 缺价（不回落其他日期）`);
  }

  let selected;
  if (tradeId === undefined || tradeId === null || tradeId === '') {
    selected = sells[0]; // 默认：时间排序后的第一笔可替换卖出笔
  } else {
    selected = symbolTrades.find((t) => t.trade_id === tradeId);
    if (!selected) return fail(CF_CODES.TRADE_NOT_FOUND, `找不到交易：${tradeId}（标的 ${symbol}）`);
    if (selected.side !== 'sell') return fail(CF_CODES.NOT_SELL, `S1 仅支持替换卖出笔：${tradeId} 是买入（买入侧替换 S3 未定义）`);
  }

  let result;
  try {
    result = replaceSell({
      symbol,
      trades: symbolTrades,
      tradeId: selected.trade_id,
      effectiveDate: stage.val.effective_date,
      closeOf: (d) => stage.market.getClose(symbol, d),
      tradingDays: stage.market.tradingDays,
    });
  } catch (e) {
    return fail(CF_CODES.ENGINE_ERROR, String(e && e.message ? e.message : e));
  }
  const out = {
    ok: true,
    code: null,
    marketSourceId: sourceId,
    symbol,
    tradeId: selected.trade_id,
    sellOptions: sells.map((t) => ({ trade_id: t.trade_id, trade_date: t.trade_date, price: t.price, quantity: t.quantity })),
    markers: symbolTrades.map((t) => ({
      trade_id: t.trade_id, trade_date: t.trade_date, side: t.side, price: t.price, quantity: t.quantity,
      replaced: t.trade_id === selected.trade_id,
    })),
    replace: result.replace,
    series: result.series,
    valuation: stage.val,
    marketRange: { ...stage.market.range },
    labels: RESULT_LABELS,
  };
  if (bill) return { ...out, marketSource: stage.marketSource, supportScope: stage.supportScope, asOfDate: stage.asOfDate };
  return { ...out, marketSource: marketMeta({ market: stage.market, valuationDate: stage.val.effective_date, source: stage.source ?? { ...MARKET_SOURCE_META[sourceId] } }) };
}

/* —— A′ 与 A 的差异（引擎输出之间的字段对比；不引入夹具期望值）
   注：仅对比引擎带 display 的字段（buyCost/actualValue/ghostValue/actualRet/ghostRet/dragMoney/drag；
   heldShares、sellProceeds 无 display，页面不做二次格式化，故不在差异行内展示） —— */
const DELTA_FIELDS = ['buyCost', 'sellProceeds', 'heldShares', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'];

export function computeScopeDelta(baseBundle, altBundle, scope) {
  const pick = (b) => (scope === 'pool' ? b.pool : b.perStock[scope]);
  const a = baseBundle ? pick(baseBundle) : null;
  const b = altBundle ? pick(altBundle) : null;
  if (!a || !b) return null;
  const changed = [];
  const unchanged = [];
  for (const f of DELTA_FIELDS) {
    if (a[f] === undefined || b[f] === undefined) continue;
    if (a.display && a.display[f] !== undefined) {
      if (a[f] === b[f]) unchanged.push(f);
      else changed.push({ field: f, from: a.display[f], to: b.display[f] });
    } else if (a[f] === b[f]) unchanged.push(f);
  }
  return { changed, unchanged };
}

/* —— 契约：模板读取 / 规则预览 / 历史情境判定（src/engine/contractMatch.js；候选口径，哈希为占位算法，待 M0-C1 冻结） —— */
export const CONTRACT_SIM_LABEL = 'Tushare 动态日线（服务端获取，非实时）· 不构成投资建议';
export const CONTRACT_SIM_SCOPE_NOTE = '最新已收盘日线（非实时）· 候选规则口径（待 M0-C1 冻结）· 不构成投资建议';
export const CONTRACT_SIM_LABEL_SIGNED = `${REAL_MARKET_LABEL} · 不构成投资建议`;
export const CONTRACT_SIM_SCOPE_NOTE_SIGNED = '真实缓存快照 · 非实时行情 · 候选口径（待 M0-C1 冻结）· 不构成投资建议';
export const CONTRACT_SIM_LABEL_SYNTHETIC = '合成回归行情 · 不构成投资建议';
export const CONTRACT_SIM_SCOPE_NOTE_SYNTHETIC = '合成夹具（非真实行情）· 候选口径（待 M0-C1 冻结）· 不构成投资建议';
export const CONTRACT_HASH_NOTE = '候选哈希，待 M0-C1 冻结';
export const CONTRACT_SIM_INPUT_INVALID = 'E_CONTRACT_SIM_INPUT_INVALID';

export const CONTRACT_MARKET_OPTIONS = Object.freeze([
  { id: 'dynamic-tushare', label: 'Tushare 动态行情' },
  { id: 'synthetic-fixture', label: '合成回归' },
]);

export function contractSimLabels(sourceId = DEFAULT_MARKET_SOURCE) {
  if (sourceId === 'signed-cache') {
    return {
      id: 'signed-cache',
      label: CONTRACT_SIM_LABEL_SIGNED,
      scopeNote: CONTRACT_SIM_SCOPE_NOTE_SIGNED,
      marketLabel: MARKET_SOURCE_META['signed-cache'].label,
    };
  }
  const synthetic = sourceId === 'synthetic-fixture';
  return {
    id: synthetic ? 'synthetic-fixture' : 'dynamic-tushare',
    label: synthetic ? CONTRACT_SIM_LABEL_SYNTHETIC : CONTRACT_SIM_LABEL,
    scopeNote: synthetic ? CONTRACT_SIM_SCOPE_NOTE_SYNTHETIC : CONTRACT_SIM_SCOPE_NOTE,
    marketLabel: synthetic ? MARKET_SOURCE_META['synthetic-fixture'].label : MARKET_SOURCE_META['dynamic-tushare'].label,
  };
}

export function contractTemplates() {
  return Object.values(CONTRACT_TEMPLATES).map((t) => ({
    template_id: t.template_id,
    name: t.name,
    kind: t.kind,
    text_template: t.text_template,
    reminder: t.reminder,
    fields: Object.entries(t.fields).map(([key, f]) => ({ key, label: f.label, default: f.default, min: f.min, integer: f.integer })),
  }));
}

export function previewContract({ template_id, fields } = {}) {
  return parseContract({ template_id, fields });
}

/* —— 契约规则集合与版本状态机（版本＝候选哈希；记录只追加不删除）——
   记录级启用：同一哈希最新一条决策为“已确认/已改写”；“已拒绝”＝不启用。
   当前规则：每个模板最多一条——启用且校验通过的同模板规则中，最近一次启用（保存 / 恢复）的那条；
   其余同模板启用规则派生为“已被较新的同类型规则替代”（只派生、不改写记录；下次对该模板写入时补追加状态记录）。 */
const CONTRACT_RECORD_SCHEMA = 'contract-v1';
const ENABLED_STATUS = new Set(['已确认', '已改写']);
const REPLACE_VIA = new Set(['替代', '整理']);
export const CONTRACT_RULE_HASH_MISMATCH = 'E_CONTRACT_RULE_HASH_MISMATCH';

const isRuleRecord = (r) => !!r && typeof r === 'object' && r.schema === CONTRACT_RECORD_SCHEMA && typeof r.hash === 'string';

function fieldsTextOf(template_id, fields) {
  const t = CONTRACT_TEMPLATES[template_id];
  return Object.entries(fields ?? {}).map(([k, v]) => `${t?.fields[k]?.label ?? k}：${v}`).join('；');
}

export function contractRuleSet(versions = []) {
  const list = Array.isArray(versions) ? versions : [];
  const groups = new Map();
  list.forEach((r, idx) => {
    if (!isRuleRecord(r)) return;
    let g = groups.get(r.hash);
    if (!g) { g = { hash: r.hash, v: null, records: [], activated: -1 }; groups.set(r.hash, g); }
    g.records.push(r);
    if (Number.isFinite(r.v) && (g.v === null || r.v < g.v)) g.v = r.v;
    if (ENABLED_STATUS.has(r.status)) g.activated = idx;
    g.latest = r;
    g.order = idx;
  });
  const rules = [...groups.values()].map((g) => {
    const first = g.records[0];
    const v = g.v ?? first.v;
    // 判定只用引擎按记录模板＋参数重新解析的结果；与记录哈希不一致时不判定（不猜测、不改写记录）
    const parsed = parseContract({ template_id: first.template_id, fields: first.fields ?? {} });
    const integrity = !parsed.supported
      ? { ok: false, code: parsed.code, message: `记录无法被引擎重新解析：${parsed.message}` }
      : parsed.hash !== g.hash
        ? { ok: false, code: CONTRACT_RULE_HASH_MISMATCH, message: `记录哈希 ${g.hash} 与引擎按其模板参数重新计算的 ${parsed.hash} 不一致：本规则不参与判定结果（不猜测、不改写记录）。` }
        : { ok: true, code: null, message: '' };
    const lastEnabled = [...g.records].reverse().find((r) => ENABLED_STATUS.has(r.status));
    const kind = CONTRACT_TEMPLATES[first.template_id]?.kind ?? null;
    return {
      hash: g.hash,
      short_hash: g.hash.slice(0, 8),
      v,
      status: g.latest.status,
      enabled: ENABLED_STATUS.has(g.latest.status),
      reenable_status: lastEnabled ? lastEnabled.status : '已确认',
      template_id: first.template_id,
      template_name: first.template_name,
      kind,
      uses_trades: kind === 'sell_buyback_window',
      fields: { ...(first.fields ?? {}) },
      fields_text: fieldsTextOf(first.template_id, first.fields),
      text: first.text,
      hash_algorithm: first.hash_algorithm,
      records: g.records,
      latest: g.latest,
      order: g.order,
      activated: g.activated,
      duplicates: [...new Set(g.records.map((r) => r.v))].filter((x) => x !== v),
      notes: [...new Set(g.records.map((r) => r.note).filter(Boolean))],
      latest_note: [...g.records].reverse().find((r) => r.note)?.note ?? '',
      integrity,
      parsed: integrity.ok ? parsed : null,
    };
  });
  const currentByTpl = new Map();
  for (const r of rules) {
    if (!r.enabled || !r.integrity.ok) continue;
    const c = currentByTpl.get(r.template_id);
    if (!c || r.activated > c.activated) currentByTpl.set(r.template_id, r);
  }
  const byHash = new Map(rules.map((r) => [r.hash, r]));
  const refOf = (r, cur) => ({ v: r.v, hash: r.hash, text: r.text, is_current: r === cur });
  for (const r of rules) {
    const cur = currentByTpl.get(r.template_id) ?? null;
    let by = null;
    if (cur === r) r.state = 'current';
    else if (r.enabled && !r.integrity.ok) r.state = 'reconfirm';
    else if (r.enabled) { r.state = 'superseded'; by = refOf(cur, cur); }
    else if (REPLACE_VIA.has(r.latest.via)) {
      r.state = 'replaced';
      const target = byHash.get(r.latest.replaced_by_hash ?? r.latest.kept_hash);
      by = target ? refOf(target, cur) : { v: r.latest.replaced_by_v ?? r.latest.kept_v ?? null, hash: null, text: null, is_current: false };
    } else r.state = 'stopped';
    r.replaced_by = by;
    r.restorable = r.integrity.ok && r.state !== 'current';
  }
  const byRecent = [...rules].sort((a, b) => b.order - a.order);
  const byVersion = (a, b) => (Number.isFinite(a.v) ? a.v : Infinity) - (Number.isFinite(b.v) ? b.v : Infinity) || a.order - b.order;
  const slots = Object.entries(CONTRACT_TEMPLATES).map(([template_id, t]) => ({ template_id, template_name: t.name, kind: t.kind, current: currentByTpl.get(template_id) ?? null }));
  const current = slots.map((s) => s.current).filter(Boolean);
  return {
    rules: byRecent,
    slots,
    current,
    // executable＝真正参与判定的规则（每个模板唯一当前规则）；needsReconfirm＝启用但内容与哈希不一致（不判定、不自动修正）
    executable: current,
    needsReconfirm: rules.filter((r) => r.state === 'reconfirm').sort(byVersion),
    history: byRecent.filter((r) => r.state !== 'current' && r.state !== 'reconfirm'),
    legacy: list.filter((r) => r && typeof r === 'object' && !isRuleRecord(r)),
    next_version: list.reduce((m, r) => (r && Number.isFinite(r.v) ? Math.max(m, r.v) : m), 0) + 1,
  };
}

// 编辑弹窗状态：new＝新版本；restore＝与历史规则同哈希（恢复该版本，不新增版本号）；unchanged＝与当前规则相同；blocked＝同哈希记录校验不一致
export function contractEditorState(versions, parsed) {
  const ruleSet = contractRuleSet(versions);
  const base = { ruleSet, current: null, same: null, action: 'invalid', canSave: false, next_version: ruleSet.next_version };
  if (!parsed || !parsed.supported) return base;
  const current = ruleSet.slots.find((s) => s.template_id === parsed.template_id)?.current ?? null;
  const same = ruleSet.rules.find((r) => r.hash === parsed.hash) ?? null;
  const action = !same ? 'new' : same.state === 'current' ? 'unchanged' : same.integrity.ok ? 'restore' : 'blocked';
  return { ...base, current, same, action, canSave: action === 'new' || action === 'restore' };
}

function recordBase(src, note) {
  return {
    schema: CONTRACT_RECORD_SCHEMA,
    template_id: src.template_id,
    template_name: src.template_name,
    fields: { ...src.fields },
    text: src.text,
    threshold_display: src.threshold_display,
    hash: src.hash,
    hash_algorithm: src.hash_algorithm,
    at: new Date().toISOString(),
    note: String(note ?? '').trim() || null,
  };
}

// 同模板其余启用规则（含派生替代的旧并行规则）各追加一条“已拒绝 · 经替代”状态记录；版本号不变、不删除记录、不涉及其他模板
function retireSameTemplate(ruleSet, template_id, by, at) {
  return ruleSet.rules
    .filter((r) => r.template_id === template_id && r.hash !== by.hash && r.enabled && r.integrity.ok)
    .map((r) => ({
      ...recordBase(r.latest, null), at, v: r.v, status: '已拒绝', transition_from: r.status,
      via: '替代', replaced_by_v: by.v, replaced_by_hash: by.hash, reason: `被同类型规则 v${by.v} 替代`,
    }));
}

// 保存并启用：新哈希 → 新版本成为该模板唯一当前规则（有当前规则时记为“已改写”）；历史同哈希 → 恢复该版本；与当前相同 → 不写入
export function contractSaveRecords(versions, { parsed, note } = {}) {
  const d = contractEditorState(versions, parsed);
  if (!d.canSave) return [];
  if (d.action === 'restore') return contractRestoreRecords(versions, { hash: parsed.hash, note });
  const at = new Date().toISOString();
  const retired = retireSameTemplate(d.ruleSet, parsed.template_id, { v: d.next_version, hash: parsed.hash }, at);
  const rec = {
    ...recordBase({ ...parsed, threshold_display: parsed.threshold.display }, note), at,
    v: d.next_version, status: d.current ? '已改写' : '已确认', from_v: d.current ? d.current.v : null,
    replaces_v: retired.map((r) => r.v),
  };
  return [rec, ...retired];
}

// 恢复历史规则为当前规则：追加一条“经恢复”的状态记录（版本号不变），同模板原当前规则经替代进入历史
export function contractRestoreRecords(versions, { hash, note } = {}) {
  const ruleSet = contractRuleSet(versions);
  const rule = ruleSet.rules.find((r) => r.hash === hash);
  if (!rule || !rule.restorable) return [];
  const at = new Date().toISOString();
  const rec = { ...recordBase(rule.latest, note), at, v: rule.v, status: rule.reenable_status, transition_from: rule.status, via: '恢复' };
  return [rec, ...retireSameTemplate(ruleSet, rule.template_id, rule, at)];
}

// 停用当前规则（或待重新确认规则）：仅状态变更，版本号不变；同模板派生替代的旧启用记录一并补追加替代记录，避免旧规则“复活”
export function contractStopRecords(versions, { hash } = {}) {
  const ruleSet = contractRuleSet(versions);
  const rule = ruleSet.rules.find((r) => r.hash === hash);
  if (!rule || (rule.state !== 'current' && rule.state !== 'reconfirm')) return [];
  const at = new Date().toISOString();
  const rec = { ...recordBase(rule.latest, null), at, v: rule.v, status: '已拒绝', transition_from: rule.status, via: '停用' };
  return rule.state === 'current' ? [rec, ...retireSameTemplate(ruleSet, rule.template_id, rule, at)] : [rec];
}

const demoTradesPromises = new Map();
function demoTradesFor(marketSource) {
  const scenarioKey = marketSource === 'synthetic-fixture' ? 'A' : 'R';
  if (!demoTradesPromises.has(scenarioKey)) {
    const cfg = SCENARIOS[scenarioKey];
    demoTradesPromises.set(scenarioKey, normalizeBillCsv(cfg.csv).then((n) => n.trades).catch((e) => {
      demoTradesPromises.delete(scenarioKey);
      throw e;
    }));
  }
  return demoTradesPromises.get(scenarioKey);
}

// 交易来源：已确认、未阻断、有标准化交易的本地账单 → 用户账单（仅签收缓存）；其余用所选行情来源对应的示例账单（不混用、不互相回退）
function isConfirmedLocalBill(bill) {
  return !!bill && bill.status === 'confirmed' && bill.sourceType === 'local' && !bill.blocked && Array.isArray(bill.trades) && bill.trades.length > 0;
}

function isLocalBill(bill) {
  return !!bill && bill.status === 'confirmed' && bill.sourceType === 'local';
}

export function contractTradeSource(bill, marketSource = DEFAULT_MARKET_SOURCE) {
  if (isLocalBill(bill)) {
    const name = String(bill.fileName || 'user-bill.csv');
    return {
      kind: 'user_bill',
      label: `已确认本地账单（${name}）`,
      fileName: name,
      market_label: REAL_MARKET_LABEL,
      marketSource: 'signed-cache',
      key: `user:${bill.contextId ?? ''}:${name}:${JSON.stringify(bill.trades)}`,
    };
  }
  const sourceId = marketSource === 'synthetic-fixture' ? 'synthetic-fixture' : 'dynamic-tushare';
  const marketLabel = MARKET_SOURCE_META[sourceId].label;
  if (sourceId === 'synthetic-fixture') {
    return {
      kind: 'demo_bill_a',
      label: '演示账单 A（demo-bill.csv，合成）',
      fileName: 'demo-bill.csv',
      market_label: marketLabel,
      marketSource: sourceId,
      key: `demo:A:${sourceId}`,
    };
  }
  return {
    kind: 'demo_bill_r',
    label: '示例账单 R（demo-bill-real.csv，示例交易）',
    fileName: 'demo-bill-real.csv',
    market_label: marketLabel,
    marketSource: sourceId,
    key: `demo:R:${sourceId}`,
  };
}

async function sourceTrades(bill, marketSource) {
  const source = contractTradeSource(bill, marketSource);
  return { source, trades: source.kind === 'user_bill' ? bill.trades : await demoTradesFor(marketSource) };
}

// 本地账单的契约情境标签（签收缓存口径；签收门/加载/固定估值日失败时随 error 返回，不回退示例行情）
function simulationLabels(context) {
  return context.marketSource.id === 'real-cache'
    ? { label: context.marketSource.label, scopeNote: '真实缓存快照 · 非实时行情 · 不构成投资建议' }
    : { label: CONTRACT_SIM_LABEL_SYNTHETIC, scopeNote: CONTRACT_SIM_SCOPE_NOTE_SYNTHETIC };
}

export async function contractSimContext({ bill, marketSource = DEFAULT_MARKET_SOURCE } = {}) {
  if (isLocalBill(bill)) {
    const context = await marketContext(bill);
    const source = contractTradeSource(bill, marketSource);
    const meta = { ...simulationLabels(context), sourceKey: source.key, marketSource: context.marketSource, supportScope: context.supportScope, asOfDate: context.asOfDate };
    if (!context.ok) return { ...meta, error: context.errors.map((e) => `${e.code} · ${e.message}`).join('；') };
    if (source.kind === 'user_bill' && !isConfirmedLocalBill(bill)) return { ...meta, error: 'E_BILL_NOT_CONFIRMED · 本地账单校验未通过，禁止回退演示数据。' };
    const { market } = context;
    const { trades } = await sourceTrades(bill, marketSource);
    const boundary = localMarketBoundary(trades, context);
    if (boundary.global.length) return { ...meta, error: boundary.global.map((e) => `${e.code} · ${e.message}`).join('；') };
    const billSymbols = [...new Set(trades.map((t) => t.symbol))].sort();
    const symbols = [...billSymbols, ...market.symbols.filter((s) => !billSymbols.includes(s))];
    return {
      ...meta, tradesSource: { ...source, market_label: context.marketSource.label },
      symbols: symbols.map((s) => ({ symbol: s, in_market_cache: market.symbols.includes(s), in_bill: billSymbols.includes(s) })),
      range: { ...market.range }, tradingDays: [...market.tradingDays],
      sells: trades.filter((t) => t.side === 'sell').map((t) => ({ trade_id: t.trade_id, symbol: t.symbol, trade_date: t.trade_date })),
    };
  }
  const labels = contractSimLabels(marketSource);
  const { source, trades } = await sourceTrades(bill, labels.id);
  const billSymbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const scope = labels.id === 'dynamic-tushare' ? marketScopeFromTrades(trades, { includeDemo: true }) : null;
  const mkt = await loadMarket(labels.id, scope);
  const market = mkt.market;
  const symbols = [...billSymbols, ...market.symbols.filter((s) => !billSymbols.includes(s))];
  return {
    label: labels.label,
    scopeNote: labels.scopeNote,
    marketSource: marketMeta(mkt),
    sourceKey: source.key,
    tradesSource: source,
    symbols: symbols.map((s) => ({ symbol: s, in_market_cache: market.symbols.includes(s), in_bill: billSymbols.includes(s) })),
    range: { ...market.range },
    tradingDays: [...market.tradingDays],
    sells: trades.filter((t) => t.side === 'sell').map((t) => ({ trade_id: t.trade_id, symbol: t.symbol, trade_date: t.trade_date })),
  };
}

async function evaluateRuleSigned(rule, { symbol, date, bill, context }) {
  const out = {
    ok: false, ...simulationLabels(context), symbol: symbol ?? null, requested_date: date ?? null,
    rule: { hash: rule.hash, short_hash: rule.short_hash, v: rule.v, status: rule.status, text: rule.text, template_name: rule.template_name, fields_text: rule.fields_text },
    verdict: null, code: null, message: '', change: null, match: null,
    tradesSource: { ...contractTradeSource(bill), market_label: context.marketSource.label }, uses_trades: CONTRACT_TEMPLATES[rule.template_id]?.kind === 'sell_buyback_window', in_market_cache: null,
  };
  if (!rule.integrity.ok) return { ...out, code: rule.integrity.code, message: rule.integrity.message };
  if (out.tradesSource.kind === 'user_bill' && !isConfirmedLocalBill(bill)) return { ...out, code: 'E_BILL_NOT_CONFIRMED', message: '本地账单校验未通过，禁止回退演示数据。' };
  if (!context.ok) return { ...out, code: context.errors[0].code, message: context.errors.map((e) => e.message).join('；') };
  const parsed = rule.parsed;
  try {
    const market = context.market;
    out.in_market_cache = market.symbols.includes(symbol);
    if (context.marketSource.signed) {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ...out, code: CONTRACT_SIM_INPUT_INVALID, message: '情境日期无效（须为 YYYY-MM-DD）' };
      if (date < market.range.start || date > market.range.end) return { ...out, ok: true, verdict: 'missing_data', code: 'E_VALUATION_OUT_OF_RANGE', message: `情境日期 ${date} 超出已签收缓存日期范围，不改用其他日期。` };
      if (!market.symbols.includes(symbol)) return { ...out, code: 'E_MARKET_OUT_OF_SUPPORT', message: `标的 ${symbol} 不在已签收缓存支持清单，不能进行本次测试（不是缺价）。` };
      if (!market.tradingDays.includes(date)) return { ...out, ok: true, verdict: 'missing_data', code: 'E_DATE_NOT_IN_CALENDAR', message: `日期 ${date} 不在已签收缓存交易日历中，不改用其他日期。` };
      const boundary = localMarketBoundary(bill.trades, context);
      if (boundary.global.length) return { ...out, code: boundary.global[0].code, message: boundary.global.map((e) => e.message).join('；') };
    }
    if (parsed.kind === 'change_pct_threshold') {
      const change = dayChangePct(market, symbol, date);
      const match = matchContract(parsed, {
        symbol,
        date: change.complete ? change.effective_date : date,
        changePct: change.complete ? change.change_pct : null,
        reason_code: change.complete ? null : change.code,
      });
      return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, change, match };
    }
    const { source, trades } = await sourceTrades(bill, 'signed-cache');
    const match = matchContract(parsed, { symbol, date, trades, tradingDays: market.tradingDays });
    return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, match, tradesSource: { ...source, market_label: context.marketSource.label } };
  } catch (e) {
    return { ...out, code: CONTRACT_SIM_INPUT_INVALID, message: `情境输入无效：${String(e && e.message ? e.message : e)}` };
  }
}

async function evaluateRuleDemo(rule, { symbol, date, bill, marketSource }) {
  const labels = contractSimLabels(marketSource);
  const out = {
    ok: false, label: labels.label, scopeNote: labels.scopeNote, symbol: symbol ?? null, requested_date: date ?? null,
    rule: { hash: rule.hash, short_hash: rule.short_hash, v: rule.v, status: rule.status, text: rule.text, template_name: rule.template_name, fields_text: rule.fields_text },
    verdict: null, code: null, message: '', change: null, match: null,
    tradesSource: contractTradeSource(bill, labels.id), uses_trades: CONTRACT_TEMPLATES[rule.template_id]?.kind === 'sell_buyback_window', in_market_cache: null,
  };
  if (!rule.integrity.ok) return { ...out, code: rule.integrity.code, message: rule.integrity.message };
  const parsed = rule.parsed;
  try {
    const { source, trades } = await sourceTrades(bill, labels.id);
    const scope = labels.id === 'dynamic-tushare' ? marketScopeFromTrades(trades, { includeDemo: true }) : null;
    const market = (await loadMarket(labels.id, scope)).market;
    out.in_market_cache = market.symbols.includes(symbol);
    if (parsed.kind === 'change_pct_threshold') {
      const change = dayChangePct(market, symbol, date);
      const match = matchContract(parsed, {
        symbol,
        date: change.complete ? change.effective_date : date,
        changePct: change.complete ? change.change_pct : null,
        reason_code: change.complete ? null : change.code,
      });
      return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, change, match, tradesSource: source };
    }
    const match = matchContract(parsed, { symbol, date, trades, tradingDays: market.tradingDays });
    return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, match, tradesSource: source };
  } catch (e) {
    return { ...out, code: CONTRACT_SIM_INPUT_INVALID, message: `情境输入无效：${String(e && e.message ? e.message : e)}` };
  }
}

// 一次情境、每个模板唯一的当前规则逐条判定（各自走引擎链路，结果按规则分别返回，互不覆盖）；
// 历史规则不参与；完整性失败的启用规则不参与判定，仅在 needs_reconfirm 中如实回传（不猜测、不改写记录）。
// 本地账单走已签收缓存（marketSource 参数不改变本地账单的行情来源）；示例账单按所选行情来源判定。
export async function simulateContracts({ versions, symbol, date, bill, marketSource = DEFAULT_MARKET_SOURCE } = {}) {
  const { executable, needsReconfirm } = contractRuleSet(versions);
  const needsReconfirmOut = needsReconfirm.map((r) => ({
    hash: r.hash, short_hash: r.short_hash, v: r.v, status: r.status, text: r.text,
    template_name: r.template_name, fields_text: r.fields_text, code: r.integrity.code, message: r.integrity.message,
  }));
  const rulesUsed = executable.map((r) => ({ hash: r.hash, v: r.v, text: r.text, template_name: r.template_name }));
  const summary = { triggered: 0, not_triggered: 0, missing_data: 0, error: 0 };
  if (isLocalBill(bill)) {
    const context = await marketContext(bill);
    const results = [];
    for (const rule of executable) results.push(await evaluateRuleSigned(rule, { symbol, date, bill, context }));
    for (const r of results) summary[r.ok ? r.verdict : 'error'] += 1;
    return {
      ...simulationLabels(context), marketSource: context.marketSource, supportScope: context.supportScope, asOfDate: context.asOfDate,
      marketSourceId: 'signed-cache',
      symbol: symbol ?? null,
      requested_date: date ?? null,
      tradesSource: { ...contractTradeSource(bill), market_label: context.marketSource.label },
      rules_n: executable.length,
      rules_used: rulesUsed,
      empty: executable.length === 0,
      needs_reconfirm_n: needsReconfirm.length,
      needs_reconfirm: needsReconfirmOut,
      summary,
      results,
    };
  }
  const labels = contractSimLabels(marketSource);
  const results = [];
  for (const rule of executable) results.push(await evaluateRuleDemo(rule, { symbol, date, bill, marketSource: labels.id }));
  for (const r of results) summary[r.ok ? r.verdict : 'error'] += 1;
  return {
    label: labels.label,
    scopeNote: labels.scopeNote,
    marketSourceId: labels.id,
    symbol: symbol ?? null,
    requested_date: date ?? null,
    tradesSource: contractTradeSource(bill, labels.id),
    rules_n: executable.length,
    rules_used: rulesUsed,
    empty: executable.length === 0,
    needs_reconfirm_n: needsReconfirm.length,
    needs_reconfirm: needsReconfirmOut,
    summary,
    results,
  };
}
