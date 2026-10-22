// 数据适配层 —— 页面唯一数据出口。
// 行情来源：示例场景与已确认本地账单均默认 Tushare 动态日线（同源站点 Function 取最新已收盘日线，服务端持有 token；非实时）；
//   A/A′ 保留 m0 合成夹具作回归场景。动态响应过 assessDynamicCacheDoc 校验；不可用即明确阻断，不回落静态缓存或合成夹具。
// 本地账单（已确认用户 CSV）使用与示例相同的动态行情链路，不读取 data/market-cache.json；
//   取数失败、标的未知、超过单次标的上限或估值日早于末笔交易日等一律明确阻断，不回退静态缓存或合成夹具。
// 数据链路（报告页·示例场景）：夹具 CSV 文本 → csvNormalize → 按交易标的/日期取所选行情 → indicators → provenance。
// 数据链路（报告页·用户账单）：确认后的标准化 state.bill → Tushare 动态行情共享市场段 → runReview 复核与发布门槛 → published_facts。
// 数据链路（导入页·用户账单）：本地 CSV 文本（FileReader）→ csvNormalize 校验（仅本机，不上传、不落 localStorage）。
//   浏览器只向同源函数发送标的代码与日期范围；不发送成交、数量、价格、文件名或 CSV 内容，计算全部在本地。
// 数据链路（契约页）：CONTRACT_TEMPLATES → parseRuleSpec 预览（适用范围：全部股票 / 单个 6 位代码）；自然语言描述 → 站点函数 /api/llm/rule 意图识别 → ruleIntent 确定性映射到模板 → parseRuleSpec；
//   版本记录 → contractRuleSet（按哈希合并、重新解析、每个模板派生唯一当前规则）；
//   历史情境：每个模板的当前规则 → 按账单模式选择行情（本地账单＝已签收缓存；示例＝所选行情来源）→ dayChangePct / 交易来源 → matchContract。
// 未接线：实时/分钟级行情（当前为最新已收盘日线）、百炼真实调用；契约为候选口径（占位哈希，待 M0-C1 冻结）。
// 对话页在线复述：仅复用已确认本地账单的 review，经站点同源边界发送组合四事实（当前 fake 验证；函数未发布/激活时走兜底）。
// 边界：本层只做取数与编排，不实现计算口径；数字与展示字符串一律来自 src/engine/*（页面不重新格式化）。
import { parseCsvText, normalizeRows } from '../engine/csvNormalize.js';
import { assessDynamicCacheDoc, createMarketCache, fromFixtures, fromPullDraft } from '../engine/marketCache.js';
import { computeIndicators, RESULT_LABELS } from '../engine/indicators.js';
import { buildProvenanceReport } from '../engine/provenance.js';
import { runReview } from '../agent/reviewPipeline.js';
import { replaceSell } from '../engine/counterfactual.js';
import { buildBenchmarkLine } from '../engine/benchmarkLine.js';
import { buildDragDecomposition } from '../engine/decompose.js';
import { buildPatternList } from '../engine/behavior.js';
import { buildBehaviorFactsRequest } from '../engine/behaviorFacts.js';
import { buildReturnWaterfall } from '../engine/waterfall.js';
import { computeStockSelf } from '../engine/stockSelf.js';
import { computePGR } from '../engine/pgr.js';
import { DEMO_REPORT_MARKET_SOURCE, getReportScenario, loadReportScenarioMarket } from './reportScenarios.js';
import { CONTRACT_CODES, CONTRACT_TEMPLATES, dayChangePct, matchContract, canonicalHash, HASH_ALGORITHM } from '../engine/contractMatch.js';
import { buildRuleLedger } from '../engine/ruleLedger.js';
import {
  parseRuleSpec, scopeApplies, notApplicableMessage, scopeLabel, normalizeScope,
  actionApplies, notApplicableActionMessage, actionLabel, RULE_SCHEMA_V1, RULE_SCHEMA_V2, RULE_SPEC_CODES, RULE_CAPABILITIES,
} from '../engine/ruleSpec.js';
import { recognizeRule, confirmationState, RULE_TEXT_MAX_CHARS, SUPPORTED_RULE_EXAMPLES } from '../agent/ruleIntent.js';

// 动态行情 Endpoint（同源；服务端注入 TUSHARE_TOKEN，浏览器不接触 token）
export const MARKET_SNAPSHOT_URL = '/functions/v1/app/api/market/snapshot';
export const DEFAULT_MARKET_SOURCE = 'dynamic-tushare';
export const MARKET_SYMBOL_LIMIT = 10;
const MARKET_RANGE_PADDING_DAYS = 14;
const MARKET_TTL_MS = 60 * 1000;
const DEMO_SYMBOLS = Object.freeze(['600519', '300750', '601318']);

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
    label: '已签收真实行情缓存',
    shortLabel: '已签收真实缓存',
    cacheName: '已签收真实行情缓存',
    note: '本地签收的冻结行情快照（data/market-cache.json）；仅用于离线核查，不进入页面行情链路',
  }),
  'demo-frozen': Object.freeze({ ...DEMO_REPORT_MARKET_SOURCE, cacheName: '示例行情' }),
});
export const MARKET_SOURCES = Object.freeze(Object.values(MARKET_SOURCE_META));

const MARKET_FIXTURES = {
  calendar: '/m0/market-cache/fixtures/mock-calendar.json',
  bars: '/m0/market-cache/fixtures/mock-daily-bars.json',
};
// 合成夹具固定估值日（动态行情使用服务端返回的 asOfDate；合成夹具使用固定估值日）
export const SYNTHETIC_VALUATION_DATE = '2024-10-11';
export const DEMO_VALUATION_DATE = SYNTHETIC_VALUATION_DATE;

// 能力状态（供页面准确显示；ready 仅在完整链路验收后才置 true——PR #6 §6）
export const CAPABILITY = {
  engine: { ready: false, label: '计算引擎·仅报告页接入' },
  bailian: { ready: false, label: '百炼·未接通（对话页 fake 验证）' },
  marketCache: { ready: false, label: '行情：示例与本地账单均走 Tushare 动态日线（服务端获取，非实时）' },
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

let signedPromise = null;
function signedMarket() {
  if (!signedPromise) {
    signedPromise = (async () => {
      const doc = await fetchJson('/data/market-cache.json');
      const market = createMarketCache(fromPullDraft(doc));
      const meta = MARKET_SOURCE_META['signed-cache'];
      const asOfDate = doc.manifest?.asOfDate ?? market.range.end;
      return {
        market,
        valuationDate: asOfDate,
        source: {
          ...meta,
          signed: true,
          artifact: doc.artifact ?? null,
          provider: doc.manifest?.data_source ?? null,
          manifestVersion: doc.manifest_version ?? null,
          fetchedAt: doc.fetched_at ?? null,
          latestTradeDate: doc.snapshot?.latest_trade_date ?? null,
          snapshotId: doc.snapshot?.snapshot_id ?? null,
          checksum: doc.checksum ?? null,
          range: { ...market.range },
          symbols: [...market.symbols],
          asOfDate,
          snapshot: market.snapshot,
        },
      };
    })().catch((e) => { signedPromise = null; throw e; });
  }
  return signedPromise;
}

async function loadMarket(sourceId = DEFAULT_MARKET_SOURCE, scope = null) {
  if (sourceId === 'dynamic-tushare') {
    if (!scope) throw new Error('动态行情缺少标的与日期范围（内部调用未提供）');
    return dynamicMarket(scope);
  }
  if (sourceId === 'synthetic-fixture') return syntheticMarket();
  if (sourceId === 'signed-cache') return signedMarket();
  if (sourceId === 'demo-frozen') {
    if (!scope?.scenarioId) throw new Error('示例行情缺少场景标识（内部调用未提供）');
    return loadReportScenarioMarket(scope.scenarioId);
  }
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
    demo: source.demo === true,
    artifact: source.artifact ?? null,
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
    benchmark: market.benchmark
      ? {
        name: market.benchmark.name,
        ts_code: market.benchmark.ts_code,
        source: market.benchmark.source,
        base_date: market.benchmark.base_date,
      }
      : null,
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
    symbol: s,
    code: prices.per_symbol[s].code,
    message: market.symbols.includes(s)
      ? `标的 ${s} 在估值日 ${val.effective_date} 缺价：该标的结果不发布；组合结果同样不发布（未回退其他日期）`
      : `标的 ${s} 不在${source.cacheName}支持范围（${market.symbols.join('、')}）：该标的结果不发布；组合结果同样不发布`,
  }));
  return { ok: true, market, val, source, prices, symbols, unblocked, blockedSymbols, errors };
}

const CORPORATE_ACTION_EVENT_DATE = '2023-04-26';

// 本地账单的行情无关安全边界：v1 不检测、不校正公司行为；已知 300750 股数事件前的交易一律保守阻断。
// 即使实际持仓在事件前已清仓，买入后持有的对照路径仍可能跨越事件，不能断言放行是安全的。
function localTradeBoundary(trades) {
  return trades.some((t) => t.symbol === '300750' && t.trade_date < CORPORATE_ACTION_EVENT_DATE)
    ? [{
      line: 0, kind: 'CORPORATE_ACTION_BOUNDARY', symbol: '300750', code: 'E_MARKET_CORPORATE_ACTION_BOUNDARY',
      message: '300750 涉及 2023-04-26 已知股数事件前交易，超出当前公司行为支持边界；v1 不检测、不校正公司行为，本次结果阻断（不是缺价）。即使实际持仓在事件前已清仓，买入后持有的对照路径仍可能跨越该事件，当前无法断言放行是安全的，故一律保守阻断。',
    }]
    : [];
}

// 共享市场段（本地账单）：默认 Tushare 动态行情；8 个示例场景显式使用冻结的 Tushare 历史日线快照。
// 两条来源不互相回退：示例场景不会请求网络，真实账单也不会回落到示例价格。
async function runUserMarketStage(trades, { marketSource = DEFAULT_MARKET_SOURCE, demoScenarioId = null } = {}) {
  const boundary = localTradeBoundary(trades);
  if (boundary.length) {
    return { ok: false, market: null, marketSource: null, supportScope: null, asOfDate: null, marketRange: null, snapshot: null, val: null, errors: boundary };
  }
  let mkt;
  try {
    const scope = marketSource === 'demo-frozen'
      ? { scenarioId: demoScenarioId }
      : marketScopeFromTrades(trades);
    mkt = await loadMarket(marketSource, scope);
  } catch (e) {
    return {
      ok: false, market: null, marketSource: null, supportScope: null, asOfDate: null, marketRange: null, snapshot: null, val: null,
      errors: [{ line: 0, kind: 'MARKET_SOURCE', code: 'E_MARKET_SOURCE', message: String(e?.message ?? e) }],
    };
  }
  const stage = runMarketStage(trades, mkt);
  return {
    ...stage,
    market: mkt.market,
    marketSource: marketMeta(mkt),
    supportScope: supportScope(mkt),
    asOfDate: mkt.valuationDate,
    marketRange: { ...mkt.market.range },
    snapshot: mkt.market.snapshot,
  };
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

// 本地账单模式：与示例相同的 Tushare 动态行情链路；失败明确阻断、不回退静态缓存或合成夹具。
export const USER_BILL_DATA_MODE = Object.freeze({
  id: 'user_bill_dynamic_market',
  label: '用户本地账单 + Tushare 动态行情',
  note: '交易文件仅在本机处理；服务端只接收标的代码与日期范围，取最新已收盘日线（非实时）；取数失败或超出单次标的上限时报告明确阻断，不回退静态缓存或合成行情',
});

export const USER_BILL_AI_DATA_MODE = Object.freeze({
  id: 'user_bill_ai_assisted_dynamic_market',
  label: '用户本地账单（AI 识别后校对） + Tushare 动态行情',
  note: '原始文件未上传；只有你点击 AI 识别时，提取出的文字会发送给模型整理交易明细；行情服务端只接收标的代码与日期范围，取数失败时阻断、不回退静态或合成行情',
});

export const USER_BILL_VISION_DATA_MODE = Object.freeze({
  id: 'user_bill_vision_assisted_dynamic_market',
  label: '用户本地账单（截图/页面识别后校对） + Tushare 动态行情',
  note: '原始文件未上传；只有你点击识别时，所选压缩截图或本地渲染页面图片才会发送给视觉模型整理交易明细；行情服务端只接收标的代码与日期范围，取数失败时阻断、不回退静态或合成行情',
});

export const DEMO_REPORT_DATA_MODE = Object.freeze({
  id: 'demo_report_frozen_market',
  label: '示例场景 + Tushare 历史行情快照',
  note: '示例交易按真实历史收盘价构造；行情为 Tushare 历史日线冻结快照（2024-12-02～2025-06-30），非实时、非投资建议',
});

/** 导入页示例场景 → 已确认示例账单；报告仍走同一复核链路，但行情固定为同一份 Tushare 历史快照。 */
export async function loadReportScenarioBill(id, { contextId = null } = {}) {
  const scenario = getReportScenario(id);
  if (!scenario) throw new Error(`未知示例场景：${id}`);
  const normalized = normalizeRows(scenario.table, scenario.fileName);
  if (normalized.blocked || normalized.trades.length === 0) {
    throw new Error(`示例场景数据未通过校验：${normalized.errors.map((e) => e.message).join('；') || '没有可计算交易'}`);
  }
  return {
    status: 'confirmed',
    sourceType: 'local',
    source: 'demo',
    confirmed: true,
    fileName: scenario.fileName,
    fileSize: 0,
    trades: normalized.trades,
    warnings: normalized.warnings,
    errors: normalized.errors,
    blocked: false,
    dataMode: DEMO_REPORT_DATA_MODE,
    sourceNote: `示例场景：${scenario.title}（示例交易按真实历史收盘价构造 + Tushare 历史日线快照；非真实账户）`,
    resultLabelling: RESULT_LABELS,
    contextId,
    demo: true,
    demoScenarioId: scenario.id,
    demoScenario: { id: scenario.id, title: scenario.title, tag: scenario.tag, story: scenario.story, headline: scenario.headline },
    marketSource: 'demo-frozen',
    importMethod: 'demo',
  };
}

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

/** 表格（CSV/TSV/Excel/PDF 提取或 AI 草稿）→ 用户账单；正式入账仍走默认整表校验。
    `scenario` 仅在用户上传下载的示例 CSV 时传入，用于把行情固定到该场景的 Tushare 历史快照。 */
export async function loadUserBillFromTable(table, fileName, { method = 'manual', modality = 'text', note = '', scenario = null } = {}) {
  const name = String(fileName || 'user-bill.csv');
  const normalized = normalizeRows(table, name);
  const methodText = method === 'ai'
    ? (modality === 'vision' ? '视觉识别后由你校对' : 'AI 识别后由你校对')
    : '本机解析';
  const dataMode = method !== 'ai'
    ? USER_BILL_DATA_MODE
    : (modality === 'vision' ? USER_BILL_VISION_DATA_MODE : USER_BILL_AI_DATA_MODE);
  return {
    sourceType: 'local',
    dataMode: scenario ? DEMO_REPORT_DATA_MODE : dataMode,
    fileName: name,
    ...(scenario ? {
      demo: true,
      demoScenarioId: scenario.id,
      demoScenario: { id: scenario.id, title: scenario.title, tag: scenario.tag, story: scenario.story, headline: scenario.headline },
      marketSource: 'demo-frozen',
    } : {}),
    blocked: normalized.blocked,
    trades: normalized.trades,
    warnings: normalized.warnings,
    errors: normalized.errors,
    sourceNote: scenario
      ? `示例场景：${scenario.title}（上传的示例 CSV，本机解析；示例交易 + Tushare 历史日线快照；非真实账户）`
      : `来源：${name}（${methodText}，未上传原始文件；schema ${normalized.schema_version}）${note ? `；${note}` : ''}`,
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

/* —— 报告页补充分析（非 Agent）：只消费已复核发布的数据与同一份行情实例 ——
   原则：组合结果未发布时不生成任何图表/画像结论；行为、标的自身涨幅、PGR/PLR 均为候选补充口径。 */
export function emptyUserInsights(reason = '尚未生成补充分析') {
  return {
    portfolio: {
      available: false, reason, report: null, decomposition: null, waterfall: null,
      counterfactuals: [], counterfactual_errors: [],
    },
    behavior: { available: false, reason, data: null },
    stock_self: { available: false, reason, data: null },
    pgr: { available: false, reason, data: null },
    review_summary: null,
  };
}

function reviewSummaryOf(review) {
  if (!review) return null;
  return {
    status: review.status,
    portfolio_published: review.portfolio_published === true,
    published_count: Array.isArray(review.published_facts) ? review.published_facts.length : 0,
    blocked_count: Array.isArray(review.blocked_facts) ? review.blocked_facts.length : 0,
    degraded_count: Array.isArray(review.degraded) ? review.degraded.length : 0,
    verify_id: review.meta?.verify_id ?? null,
    provenance_summary: review.provenance?.summary ?? null,
  };
}

function buildUserInsights({ stage, trades, closes, review }) {
  const insights = emptyUserInsights('');
  insights.review_summary = reviewSummaryOf(review);
  if (!review || review.portfolio_published !== true) {
    const reason = review?.blocked_symbols?.length
      ? '复核未发布组合结果：有标的缺价或被扣发，图表与补充画像不生成'
      : '复核未发布组合结果：补充分析不生成，避免展示未经复核的数字';
    insights.portfolio.reason = reason;
    insights.behavior.reason = reason;
    insights.stock_self.reason = reason;
    insights.pgr.reason = reason;
    return insights;
  }

  let report = null;
  try {
    report = computeIndicators({ trades, closes });
    insights.portfolio.available = true;
    insights.portfolio.reason = '';
    insights.portfolio.report = report;
  } catch (e) {
    const reason = `组合指标重算失败：${String(e && e.message ? e.message : e)}`;
    insights.portfolio.reason = reason;
    insights.portfolio.available = false;
  }

  if (report) {
    try {
      insights.portfolio.decomposition = buildDragDecomposition({ report, trades });
    } catch (e) {
      insights.portfolio.counterfactual_errors.push({
        code: 'E_INSIGHT_DECOMPOSE', message: `损耗分解失败：${String(e && e.message ? e.message : e)}`,
      });
    }
    try {
      insights.portfolio.waterfall = buildReturnWaterfall({ report });
    } catch (e) {
      insights.portfolio.counterfactual_errors.push({
        code: 'E_INSIGHT_WATERFALL', message: `收益瀑布失败：${String(e && e.message ? e.message : e)}`,
      });
    }

    const valuationDate = stage.val.effective_date;
    const sells = trades
      .filter((t) => t && t.side === 'sell')
      .sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : (a.source?.line ?? 0) - (b.source?.line ?? 0)));
    const maxCharts = 24;
    for (const sell of sells.slice(0, maxCharts)) {
      try {
        const symbolTrades = trades.filter((t) => t.symbol === sell.symbol);
        const result = replaceSell({
          symbol: sell.symbol,
          trades: symbolTrades,
          tradeId: sell.trade_id,
          effectiveDate: valuationDate,
          closeOf: (d) => stage.market.getClose(sell.symbol, d),
          tradingDays: stage.market.tradingDays,
        });
        const benchmarkLine = stage.market.benchmark
          ? buildBenchmarkLine({
            points: result.series.points,
            buyCost: result.replace.buyCost,
            closeOf: (d) => stage.market.getBenchmarkClose(d),
            meta: {
              name: stage.market.benchmark.name,
              ts_code: stage.market.benchmark.ts_code,
              source: stage.market.benchmark.source,
            },
          })
          : null;
        const series = benchmarkLine?.available
          ? { ...result.series, points: benchmarkLine.points, benchmark: benchmarkLine.meta }
          : result.series;
        insights.portfolio.counterfactuals.push({
          symbol: sell.symbol,
          trade_id: sell.trade_id,
          trade_date: sell.trade_date,
          price: sell.price,
          quantity: sell.quantity,
          replace: result.replace,
          series,
          markers: symbolTrades.map((t) => ({
            trade_id: t.trade_id,
            trade_date: t.trade_date,
            side: t.side,
            price: t.price,
            quantity: t.quantity,
            replaced: t.trade_id === sell.trade_id,
          })),
        });
      } catch (e) {
        insights.portfolio.counterfactual_errors.push({
          code: 'E_INSIGHT_CF',
          trade_id: sell.trade_id,
          symbol: sell.symbol,
          message: `单笔反事实失败：${String(e && e.message ? e.message : e)}`,
        });
      }
    }
  }

  try {
    insights.behavior.data = buildPatternList({ trades, market: stage.market });
    insights.behavior.available = true;
    insights.behavior.reason = '';
  } catch (e) {
    insights.behavior.reason = `行为发现失败：${String(e && e.message ? e.message : e)}`;
  }

  try {
    insights.stock_self.data = computeStockSelf({
      trades,
      valuationDate: stage.val.effective_date,
      resolveDate: (d) => stage.market.resolveValuation(d),
      closeOf: (symbol, d) => stage.market.getClose(symbol, d),
    });
    insights.stock_self.available = insights.stock_self.data.available === true;
    insights.stock_self.reason = insights.stock_self.available ? '' : '标的自身涨幅覆盖不足';
  } catch (e) {
    insights.stock_self.reason = `标的自身涨幅失败：${String(e && e.message ? e.message : e)}`;
  }

  try {
    insights.pgr.data = computePGR({ trades, closes });
    insights.pgr.available = insights.pgr.data.ok === true;
    insights.pgr.reason = insights.pgr.available ? '' : 'PGR/PLR 样本或行情不足';
  } catch (e) {
    insights.pgr.reason = `PGR/PLR 失败：${String(e && e.message ? e.message : e)}`;
  }
  return insights;
}

/* —— 报告页：用户账单引擎链路（Tushare 动态行情）——
   输出契约（页面消费）：
   { sourceType:'local', fileName, dataMode, marketSource, supportScope, asOfDate,
     status('ok'|'partial'|'blocked'|'error'), blocked, warnings[], errors[],
     valuation, marketRange, snapshot, prices, blockedSymbols[], poolBlocked,
     review, closes, market, factsByScope{}, provenance, labels,
     insights: { portfolio, behavior, stock_self, pgr, review_summary },
     behaviorFacts: null | { protocol, events[], buy_windows[] } }
   closes/market 只供同一进程内的 planner 上下文复用（同一行情实例，不额外取价）；页面不展示。
   behaviorFacts 只含脱敏事件序号、标的代号与买入窗口，不含日期、价格、数量或文件名。 */
export async function loadUserBillReport(bill) {
  const demo = bill?.demo === true && bill?.marketSource === 'demo-frozen';
  const out = {
    sourceType: 'local',
    fileName: bill && bill.fileName ? bill.fileName : '',
    dataMode: (bill && bill.dataMode) || USER_BILL_DATA_MODE,
    demo,
    demoScenario: demo ? (bill.demoScenario ?? { id: bill.demoScenarioId ?? null, title: '示例场景', headline: '示例报告' }) : null,
    marketSourceId: demo ? 'demo-frozen' : DEFAULT_MARKET_SOURCE,
    marketSource: null,
    supportScope: null,
    asOfDate: null,
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
    closes: null,
    market: null,
    factsByScope: {},
    provenance: null,
    labels: RESULT_LABELS,
    insights: emptyUserInsights('账单未确认：补充分析不生成'),
    behaviorFacts: null,
  };
  if (!bill || bill.status !== 'confirmed' || bill.sourceType !== 'local' || bill.blocked || !Array.isArray(bill.trades) || bill.trades.length === 0) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push({ line: 0, code: 'E_BILL_NOT_CONFIRMED', message: '账单未确认或校验未通过：不能进入报告（不回退演示数据）' });
    return out;
  }
  const trades = bill.trades;
  out.warnings = [...(bill.warnings ?? [])];

  const stage = await runUserMarketStage(trades, {
    marketSource: out.marketSourceId,
    demoScenarioId: bill.demoScenarioId ?? bill.demoScenario?.id ?? null,
  });
  Object.assign(out, { marketSource: stage.marketSource, supportScope: stage.supportScope, asOfDate: stage.asOfDate, marketRange: stage.marketRange, snapshot: stage.snapshot, valuation: stage.val });
  if (!stage.ok) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push(...stage.errors);
    out.insights = emptyUserInsights('行情未就绪：补充分析不生成');
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
  out.closes = closes;
  out.market = stage.market;
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

  // 4) 补充分析（非 Agent）：组合未发布时整体不生成；其余为候选口径
  try {
    out.insights = buildUserInsights({ stage, trades, closes, review });
  } catch (e) {
    out.insights = emptyUserInsights(`补充分析生成失败：${String(e && e.message ? e.message : e)}`);
    out.insights.review_summary = reviewSummaryOf(review);
  }
  try {
    const facts = buildBehaviorFactsRequest({
      trades,
      behavior: out.insights?.behavior?.data ?? null,
      tradingDays: stage.market.tradingDays,
    });
    out.behaviorFacts = facts.ok ? facts.request : null;
  } catch {
    out.behaviorFacts = null;
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
// 用户账单（bill）与示例场景均按所选行情来源取数（默认 Tushare 动态日线），两者不互相回退。
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
  const sourceId = marketSource === 'synthetic-fixture' ? 'synthetic-fixture' : 'dynamic-tushare';
  const fail = (code, message) => ({
    ok: false, code, message, symbol: symbol ?? null, tradeId: tradeId ?? null,
    sellOptions: [], markers: [], replace: null, series: null, valuation: null, marketRange: null, marketSourceId: sourceId, labels: RESULT_LABELS,
  });
  if (bill && !isConfirmedLocalBill(bill)) return fail(CF_CODES.MARKET_BLOCKED, '本地账单未确认或校验未通过，不回退示例行情。');
  if (!Array.isArray(trades) || trades.length === 0) return fail(CF_CODES.NO_TRADES, '账单交易为空，无法计算单笔反事实');
  if (bill) {
    const boundary = localTradeBoundary(trades);
    if (boundary.length) return fail(CF_CODES.MARKET_BLOCKED, boundary.map((e) => `${e.code} · ${e.message}`).join('；'));
  }
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
    stage = await runUserMarketStage(trades);
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
      label: MARKET_SOURCE_META['signed-cache'].label,
      scopeNote: '已签收冻结行情快照（仅离线核查）· 不构成投资建议',
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
    action: RULE_CAPABILITIES.conditions[t.template_id]?.action ?? 'buy',
    text_template: t.text_template,
    reminder: t.reminder,
    timing: RULE_CAPABILITIES.conditions[t.template_id]?.timing ?? '',
    fields: Object.entries(t.fields).map(([key, f]) => ({ key, label: f.label, default: f.default, min: f.min, integer: f.integer })),
  }));
}

export const CONTRACT_SCOPE_OPTIONS = Object.freeze([
  { kind: 'all', label: RULE_CAPABILITIES.scopes.all.label },
  { kind: 'symbol', label: RULE_CAPABILITIES.scopes.symbol.label, note: RULE_CAPABILITIES.scopes.symbol.note },
]);

// 全部股票 → 与 parseContract 完全相同的文本与哈希（contract-v1）；单个 6 位代码 → contract-v2
export function previewContract({ template_id, fields, scope } = {}) {
  return parseRuleSpec({ template_id, fields, scope });
}

// 自然语言规则识别：只把规则文本发往同源站点函数；返回结果中的 parsed 由引擎 parseRuleSpec / parseContract 生成
export { RULE_TEXT_MAX_CHARS as CONTRACT_NL_MAX_CHARS, SUPPORTED_RULE_EXAMPLES as CONTRACT_NL_EXAMPLES };
export function recognizeContractText(text, opts = {}) {
  return recognizeRule(text, opts);
}

// 自然语言结果能否保存：待确认项均选了系统支持的选项、用户已核对完整表达、且版本状态允许保存
export function contractNlSaveState(versions, result, { choices = {}, ack = false, dupAck = false } = {}) {
  if (!result || result.status !== 'supported') return { canSave: false, reason: 'not_supported', editor: null, confirm: null };
  const confirm = confirmationState(result, choices);
  const editor = contractEditorState(versions, result.parsed);
  const dupPending = editor.action === 'duplicate' && !dupAck;
  const reason = !confirm.ok ? (confirm.blocked.length ? 'choice_unsupported' : 'choice_pending') : !ack ? 'ack_pending' : !editor.canSave ? `editor_${editor.action}` : dupPending ? 'dup_pending' : null;
  return { canSave: reason === null, reason, editor, confirm };
}

/* —— 契约规则集合与版本状态机（版本＝候选哈希；记录只追加不删除）——
   记录级启用：同一哈希最新一条决策为”已确认/已改写”；”已拒绝”＝不启用。
   当前规则：每个模板 × 适用范围最多一条——启用且校验通过的同模板同范围规则中，最近一次启用（保存 / 恢复 / 编辑）的那条；
   同模板不同范围（全部股票 / 单个代码）可各自有一条当前规则并行生效；
   其余同模板同范围的启用规则派生为”已被较新的同类型规则替代”（只派生、不改写记录；下次对该模板写入时补追加状态记录）。
   记录格式：全部股票＝contract-v1（原样，不迁移）；单个 6 位代码＝contract-v2（含 scope）。
   自定义规则：custom-v1（template_id: null, kind: 'custom', rule_id, text, action, scope, understanding）。 */
const CONTRACT_RECORD_SCHEMA = RULE_SCHEMA_V1;
const RULE_SCHEMAS = new Set([RULE_SCHEMA_V1, RULE_SCHEMA_V2]);
const CUSTOM_RULE_SCHEMA = 'custom-v1';
const CUSTOM_SCHEMAS = new Set([CUSTOM_RULE_SCHEMA]);
const ENABLED_STATUS = new Set(['已确认', '已改写']);
const REPLACE_VIA = new Set(['替代', '整理']);
export const CONTRACT_RULE_HASH_MISMATCH = 'E_CONTRACT_RULE_HASH_MISMATCH';
export const CONTRACT_RULE_SCHEMA_MISMATCH = 'E_CONTRACT_RULE_SCHEMA_MISMATCH';

const isRuleRecord = (r) => !!r && typeof r === 'object' && (RULE_SCHEMAS.has(r.schema) || CUSTOM_SCHEMAS.has(r.schema)) && typeof r.hash === 'string';
const isCustomRecord = (r) => !!r && typeof r === 'object' && CUSTOM_SCHEMAS.has(r.schema);

function fieldsTextOf(template_id, fields) {
  const t = CONTRACT_TEMPLATES[template_id];
  return Object.entries(fields ?? {}).map(([k, v]) => `${t?.fields?.[k]?.label ?? k}：${v}`).join('；');
}

// 按记录格式重新解析：v1 不读取任何 scope（v1 记录带 scope 视为异常，避免回退到旧版时范围被静默放大）；v2 必须是单个代码
function reparseGroup(g) {
  const first = g.records[0];
  const schemas = new Set(g.records.map((r) => r.schema));
  if (schemas.size > 1) {
    return { parsed: null, integrity: { ok: false, code: CONTRACT_RULE_SCHEMA_MISMATCH, message: `同一哈希 ${g.hash} 下的记录格式不一致（${[...schemas].join(' / ')}）：本规则不参与判定结果（不猜测、不改写记录）。` } };
  }
  if (first.schema === RULE_SCHEMA_V1 && g.records.some((r) => r.scope !== undefined)) {
    return { parsed: null, integrity: { ok: false, code: CONTRACT_RULE_SCHEMA_MISMATCH, message: 'contract-v1 记录不应包含适用范围字段：本规则不参与判定结果（不猜测、不改写记录）。' } };
  }
  let parsed;
  // 后续状态记录也必须对应同一内容，不能仅凭首条记录的哈希信任后续的启用状态。
  for (const rec of g.records) {
    const current = parseRuleSpec({ template_id: rec.template_id, fields: rec.fields ?? {}, scope: rec.schema === RULE_SCHEMA_V2 ? (rec.scope ?? null) : undefined });
    if (!current.supported) return { parsed: null, integrity: { ok: false, code: current.code, message: `记录无法被引擎重新解析：${current.message}` } };
    if (current.schema !== rec.schema) {
      return { parsed: null, integrity: { ok: false, code: CONTRACT_RULE_SCHEMA_MISMATCH, message: `记录格式 ${rec.schema} 与其适用范围（${current.scope_text}）不一致：本规则不参与判定结果（不猜测、不改写记录）。` } };
    }
    if (current.hash !== g.hash || rec.text !== current.text || (rec.hash_algorithm && rec.hash_algorithm !== current.hash_algorithm)) {
      return { parsed: null, integrity: { ok: false, code: CONTRACT_RULE_HASH_MISMATCH, message: `记录哈希 ${g.hash}、文本或算法标识与引擎重新生成的规则不一致（计算哈希 ${current.hash}）：本规则不参与判定结果（不猜测、不改写记录）。` } };
    }
    parsed ??= current;
  }
  return { parsed, integrity: { ok: true, code: null, message: '' } };
}

function recordScopeOf(first) {
  if (first.schema !== RULE_SCHEMA_V2) return { kind: 'all' };
  const s = normalizeScope(first.scope ?? null);
  return s.ok ? s.scope : null;
}

export function contractRuleSet(versions = []) {
  const list = Array.isArray(versions) ? versions : [];
  // 模板规则：按哈希分组
  const groups = new Map();
  // 自定义规则：同一身份的每个内容版本独立归档。
  const customGroups = new Map();
  list.forEach((r, idx) => {
    if (!isRuleRecord(r)) return;
    if (isCustomRecord(r)) {
      const rid = r.rule_id ?? r.hash;
      const key = JSON.stringify([rid, r.hash]);
      let g = customGroups.get(key);
      if (!g) { g = { rule_id: rid, hash: r.hash, v: null, records: [], activated: -1 }; customGroups.set(key, g); }
      g.records.push(r);
      if (Number.isFinite(r.v) && (g.v === null || r.v < g.v)) g.v = r.v;
      if (ENABLED_STATUS.has(r.status)) g.activated = idx;
      g.latest = r;
      g.order = idx;
      return;
    }
    let g = groups.get(r.hash);
    if (!g) { g = { hash: r.hash, v: null, records: [], activated: -1 }; groups.set(r.hash, g); }
    g.records.push(r);
    if (Number.isFinite(r.v) && (g.v === null || r.v < g.v)) g.v = r.v;
    if (ENABLED_STATUS.has(r.status)) g.activated = idx;
    g.latest = r;
    g.order = idx;
  });
  // 模板规则解析
  const rules = [...groups.values()].map((g) => {
    const first = g.records[0];
    const v = g.v ?? first.v;
    const { parsed, integrity } = reparseGroup(g);
    const scope = parsed ? parsed.scope : recordScopeOf(first);
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
      action: RULE_CAPABILITIES.conditions[first.template_id]?.action ?? 'buy',
      uses_trades: kind === 'sell_buyback_window' || kind === 'buy_sell_window',
      fields: { ...(first.fields ?? {}) },
      fields_text: fieldsTextOf(first.template_id, first.fields),
      text: first.text,
      schema: first.schema,
      scope,
      scope_text: scope ? scopeLabel(scope) : '适用范围无效',
      timing: RULE_CAPABILITIES.conditions[first.template_id]?.timing ?? '',
      hash_algorithm: first.hash_algorithm,
      records: g.records,
      latest: g.latest,
      order: g.order,
      activated: g.activated,
      duplicates: [...new Set(g.records.map((r) => r.v))].filter((x) => x !== v),
      notes: [...new Set(g.records.map((r) => r.note).filter(Boolean))],
      latest_note: [...g.records].reverse().find((r) => r.note)?.note ?? '',
      // 决定自述：保存时随版本冻结，只作承诺记录展示；不参与判定、不进入哈希、不随规则修改改写
      decision_statement: (() => {
        const rec = [...g.records].reverse().find((r) => r.note);
        return rec ? { text: rec.note, at: rec.at ?? null, v: Number.isFinite(rec.v) ? rec.v : v, frozen: true } : null;
      })(),
      origin_text: g.records.find((r) => r.origin && r.origin.kind === 'natural_language' && typeof r.origin.text === 'string')?.origin.text ?? null,
      origin_confirmations: { ...(g.records.find((r) => r.origin && r.origin.kind === 'natural_language')?.origin.confirmations ?? {}) },
      integrity,
      parsed: integrity.ok ? parsed : null,
      is_custom: false,
    };
  });
  // 自定义规则解析
  const customRules = [...customGroups.values()].map((g) => {
    const first = g.records[0];
    const v = g.v ?? first.v;
    const lastEnabled = [...g.records].reverse().find((r) => ENABLED_STATUS.has(r.status));
    const scope = normalizeScope(first.scope ?? null);
    const scopeOk = scope.ok;
    const scopeValue = scopeOk ? scope.scope : { kind: 'all' };
    // 自定义规则完整性：校验哈希是否与记录内容一致
    const expectedCanonical = {
      schema: first.schema ?? CUSTOM_RULE_SCHEMA,
      kind: 'custom',
      text: String(first.text ?? '').trim(),
      action: first.action ?? 'unconfirmed',
      scope: first.scope && first.scope.kind === 'symbol' ? { kind: 'symbol', symbol: first.scope.symbol } : { kind: 'all' },
    };
    const expectedHash = computeCustomHash(expectedCanonical);
    const integrity = first.hash === expectedHash
      ? { ok: true, code: null, message: '' }
      : { ok: false, code: CONTRACT_RULE_HASH_MISMATCH, message: `自定义规则哈希不一致（记录 ${first.hash}，计算 ${expectedHash}）：不参与判定。` };
    return {
      hash: g.hash,
      rule_id: g.rule_id,
      short_hash: g.hash.slice(0, 8),
      v,
      status: g.latest.status,
      enabled: ENABLED_STATUS.has(g.latest.status),
      reenable_status: lastEnabled ? lastEnabled.status : '已确认',
      template_id: null,
      template_name: '自定义规则',
      kind: 'custom',
      action: first.action ?? null,
      uses_trades: false,
      fields: {},
      fields_text: '',
      text: first.text,
      schema: first.schema,
      scope: scopeValue,
      scope_text: scopeOk ? scopeLabel(scopeValue) : '适用范围无效',
      timing: '',
      hash_algorithm: first.hash_algorithm ?? HASH_ALGORITHM,
      records: g.records,
      latest: g.latest,
      order: g.order,
      activated: g.activated,
      duplicates: [...new Set(g.records.map((r) => r.v))].filter((x) => x !== v),
      notes: [...new Set(g.records.map((r) => r.note).filter(Boolean))],
      latest_note: [...g.records].reverse().find((r) => r.note)?.note ?? '',
      origin_text: first.text,
      origin_confirmations: {},
      understanding: first.understanding ?? null,
      integrity,
      parsed: null,
      is_custom: true,
    };
  });
  const allRules = [...rules, ...customRules];
  // 模板规则：同模板+同范围只保留一条当前规则（最新启用版本），其余进入历史
  // 不同范围（全部股票 vs 单个代码）即使同模板也可并行共存
  const scopeKey = (r) => {
    const s = r.scope ?? r.latest?.scope;
    if (!s || s.kind === 'all') return 'all';
    return `${s.kind}:${s.symbol ?? ''}`;
  };
  const tplBest = new Map();
  for (const r of rules) {
    if (!r.enabled || !r.integrity.ok) continue;
    const key = `${r.template_id}|${scopeKey(r)}`;
    const c = tplBest.get(key);
    if (!c || r.activated > c.activated) tplBest.set(key, r);
  }
  // 自定义规则：每个 rule_id 最多一条当前规则（编辑产生新版本，旧版本被替代）
  const currentByRuleId = new Map();
  for (const r of customRules) {
    if (!r.enabled || !r.integrity.ok) continue;
    const c = currentByRuleId.get(r.rule_id);
    if (!c || r.activated > c.activated) currentByRuleId.set(r.rule_id, r);
  }
  const byHash = new Map(allRules.map((r) => [r.hash, r]));
  const refOf = (r, cur) => ({ v: r.v, hash: r.hash, text: r.text, is_current: r === cur });
  // 模板规则状态：同模板+同范围只有最新版本是 current，其余启用规则为 superseded
  for (const r of rules) {
    const key = `${r.template_id}|${scopeKey(r)}`;
    let by = null;
    if (r.enabled && r.integrity.ok && tplBest.get(key) === r) r.state = 'current';
    else if (r.enabled && !r.integrity.ok) r.state = 'reconfirm';
    else if (r.enabled) {
      const winner = tplBest.get(key);
      r.state = 'superseded'; by = winner ? refOf(winner, winner) : null;
    } else if (REPLACE_VIA.has(r.latest.via)) {
      r.state = 'replaced';
      const target = byHash.get(r.latest.replaced_by_hash ?? r.latest.kept_hash);
      by = target ? refOf(target, null) : { v: r.latest.replaced_by_v ?? r.latest.kept_v ?? null, hash: null, text: null, is_current: false };
    } else r.state = 'stopped';
    r.replaced_by = by;
    r.restorable = r.integrity.ok && r.state !== 'current';
  }
  // 自定义规则状态
  for (const r of customRules) {
    const cur = currentByRuleId.get(r.rule_id) ?? null;
    let by = null;
    if (cur === r) r.state = 'current';
    else if (r.enabled && !r.integrity.ok) r.state = 'reconfirm';
    else if (r.enabled) { r.state = 'superseded'; by = refOf(cur, cur); }
    else if (REPLACE_VIA.has(r.latest.via)) {
      r.state = 'replaced';
      const target = customRules.find((x) => x.rule_id === r.rule_id && x.hash === (r.latest.replaced_by_hash ?? r.latest.kept_hash));
      by = target ? refOf(target, cur) : { v: r.latest.replaced_by_v ?? r.latest.kept_v ?? null, hash: null, text: null, is_current: false };
    } else r.state = 'stopped';
    r.replaced_by = by;
    r.restorable = r.integrity.ok && r.state !== 'current';
  }
  const byRecent = [...allRules].sort((a, b) => b.order - a.order);
  const byVersion = (a, b) => (Number.isFinite(a.v) ? a.v : Infinity) - (Number.isFinite(b.v) ? b.v : Infinity) || a.order - b.order;
  // 按模板收集当前规则（同模板不同范围可有多条当前）
  const currentsByTemplate = new Map();
  for (const r of tplBest.values()) {
    const arr = currentsByTemplate.get(r.template_id) ?? [];
    arr.push(r);
    currentsByTemplate.set(r.template_id, arr);
  }
  const slots = Object.entries(CONTRACT_TEMPLATES).map(([template_id, t]) => {
    const currents = currentsByTemplate.get(template_id) ?? [];
    return { template_id, template_name: t.name, kind: t.kind, currents, current: currents[0] ?? null };
  });
  const current = [...tplBest.values()].sort((a, b) => b.order - a.order);
  const customCurrent = [...currentByRuleId.values()];
  return {
    rules: byRecent,
    slots,
    current,
    customRules: customRules.sort((a, b) => b.order - a.order),
    customCurrent,
    executable: [...current, ...customCurrent],
    needsReconfirm: allRules.filter((r) => r.state === 'reconfirm').sort(byVersion),
    history: byRecent.filter((r) => r.state !== 'current' && r.state !== 'reconfirm'),
    legacy: list.filter((r) => r && typeof r === 'object' && !isRuleRecord(r)),
    next_version: list.reduce((m, r) => (r && Number.isFinite(r.v) ? Math.max(m, r.v) : m), 0) + 1,
  };
}

// 自定义规则哈希计算：基于 schema + kind + text + action + scope
function computeCustomHash(canonical) {
  return canonicalHash(canonical);
}
export { computeCustomHash as CONTRACT_CUSTOM_HASH };

// 编辑弹窗状态：edit＝编辑当前规则（创建新版本，旧版本进入历史）；new＝新模板规则（同模板不同范围可并存）；
// restore＝与历史规则同哈希（恢复该版本）；duplicate＝同哈希已存在为当前规则但用户可强制新增；blocked＝校验不一致；
// unchanged＝与目标规则完全相同
export function contractEditorState(versions, parsed, { targetHash = null } = {}) {
  const ruleSet = contractRuleSet(versions);
  const base = { ruleSet, current: null, same: null, action: 'invalid', canSave: false, next_version: ruleSet.next_version };
  if (!parsed || !parsed.supported) return base;
  // 查找同模板+同范围的当前规则
  const slot = ruleSet.slots.find((s) => s.template_id === parsed.template_id);
  const parsedScope = parsed.scope ?? { kind: 'all', symbol: null };
  const currentRule = slot?.currents?.find((r) => {
    const rScope = r.scope ?? r.latest?.scope ?? { kind: 'all', symbol: null };
    return rScope.kind === parsedScope.kind && rScope.symbol === parsedScope.symbol;
  }) ?? null;
  const anyCurrentRule = slot?.currents?.[0] ?? null;
  const same = ruleSet.rules.find((r) => r.hash === parsed.hash) ?? null;
  if (targetHash) {
    const target = ruleSet.current.find((r) => r.hash === targetHash && r.template_id === parsed.template_id);
    if (!target) return { ...base, action: 'blocked' };
    if (parsed.hash === target.hash) return { ...base, current: target, same: target, action: 'unchanged' };
    if (same) return { ...base, current: target, same, action: 'blocked' };
    return { ...base, current: target, action: 'edit', canSave: true };
  }
  let action;
  if (!same) {
    action = currentRule ? 'edit' : 'new';
  } else if (same.state === 'current') {
    action = 'duplicate';
  } else if (same.integrity.ok) {
    action = 'restore';
  } else {
    action = 'blocked';
  }
  const canSave = action === 'new' || action === 'edit' || action === 'restore' || action === 'duplicate';
  return { ...base, current: currentRule ?? anyCurrentRule, same, action, canSave };
}

// 从历史恢复前的预览：是否可恢复、同模板/同 rule_id 的当前规则（用于展示参考）、范围变化
export function contractRestoreState(versions, { hash, rule_id } = {}) {
  const ruleSet = contractRuleSet(versions);
  const rule = ruleSet.rules.find((r) => r.hash === hash && (rule_id == null ? !r.is_custom : r.rule_id === rule_id)) ?? null;
  let currents = rule?.is_custom
    ? ruleSet.customCurrent.filter((r) => r.rule_id === rule.rule_id && r.hash !== rule.hash)
    : rule ? (ruleSet.slots.find((s) => s.template_id === rule.template_id)?.currents ?? []).filter((r) => r.hash !== rule.hash) : [];
  if (rule && !rule.is_custom) {
    const visited = new Set([rule.hash]);
    let successor = rule;
    while (successor?.latest?.replaced_by_hash && !visited.has(successor.latest.replaced_by_hash)) {
      visited.add(successor.latest.replaced_by_hash);
      successor = ruleSet.rules.find((r) => !r.is_custom && r.hash === successor.latest.replaced_by_hash);
    }
    const sameScope = (r) => r.scope?.kind === rule.scope?.kind && (r.scope?.symbol ?? '') === (rule.scope?.symbol ?? '');
    const linked = successor?.state === 'current' ? successor : null;
    const same = currents.find(sameScope);
    if (linked && same && linked.hash !== same.hash) return { rule, currents, current: linked, restorable: false, scope_change: null, conflict: true };
    currents = [linked ?? same].filter(Boolean);
  }
  const current = currents[0] ?? null;
  const changed = current && (current.scope?.kind !== rule.scope?.kind || (current.scope?.symbol ?? '') !== (rule.scope?.symbol ?? ''));
  const scope_change = changed ? { requires_ack: true, message: `恢复后将用“${rule.scope_text}”替换当前“${current.scope_text}”规则。` } : null;
  const restorable = !!(rule && rule.restorable);
  return { rule, currents, current, restorable, scope_change };
}

function recordBase(src, note) {
  const rec = {
    schema: src.schema === RULE_SCHEMA_V2 ? RULE_SCHEMA_V2 : CONTRACT_RECORD_SCHEMA,
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
  if (rec.schema === RULE_SCHEMA_V2) rec.scope = src.scope && typeof src.scope === 'object' ? { ...src.scope } : src.scope ?? null;
  return rec;
}

// 保存并启用：edit＝编辑当前规则（创建新版本，旧版本进入历史）；new＝新模板规则（同模板不同范围可并存，互不替代）；
// restore＝历史同哈希→恢复该版本；duplicate＝同哈希已存在为当前规则但用户可强制新增；origin 仅作记录展示
export function contractSaveRecords(versions, { parsed, note, origin = null, confirmScopeChange = false, forceDuplicate = false, assistantFlowId = null, targetHash = null } = {}) {
  const d = contractEditorState(versions, parsed, { targetHash });
  if (!d.canSave) return [];
  if (d.action === 'duplicate' && !forceDuplicate) return [];
  if (d.action === 'restore') return contractRestoreRecords(versions, { hash: parsed.hash, note, confirmScopeChange, assistantFlowId });
  const at = new Date().toISOString();
  const rec = {
    ...recordBase({ ...parsed, threshold_display: parsed.threshold.display }, note), at,
    v: d.next_version, status: '已确认', from_v: null,
  };
  if (typeof assistantFlowId === 'string' && assistantFlowId) rec.assistant_flow_id = assistantFlowId;
  if (origin && typeof origin.text === 'string' && origin.text.trim()) {
    rec.origin = { kind: 'natural_language', text: origin.text.trim(), confirmations: { ...(origin.confirmations ?? {}) } };
  }
  // edit：编辑当前规则，旧版本进入历史（标记为"替代"）
  if (d.action === 'edit' && d.current) {
    const oldRec = { ...recordBase(d.current.latest, null), at, v: d.current.v, status: '已拒绝', transition_from: d.current.status, via: '替代', replaced_by_v: rec.v, replaced_by_hash: rec.hash };
    return [oldRec, rec];
  }
  return [rec];
}

// 恢复历史规则为当前规则：追加一条”经恢复”的状态记录（版本号不变）；多规则共存，不影响其余规则
export function contractRestoreRecords(versions, { hash, rule_id, note, confirmScopeChange = false, assistantFlowId = null } = {}) {
  const ruleSet = contractRuleSet(versions);
  const preview = contractRestoreState(versions, { hash, rule_id });
  const rule = preview.rule;
  if (!rule || !preview.restorable || (preview.scope_change?.requires_ack && !confirmScopeChange)) return [];
  const at = new Date().toISOString();
  if (rule.is_custom) {
    const rec = { ...customRecordBase(rule.latest, note, at, rule.v), status: rule.reenable_status, transition_from: rule.status, via: '恢复' };
    if (typeof assistantFlowId === 'string' && assistantFlowId) rec.assistant_flow_id = assistantFlowId;
    const current = ruleSet.customCurrent.find((r) => r.rule_id === rule.rule_id && r.hash !== rule.hash);
    const retired = current ? [{ ...customRecordBase(current.latest, null, at, current.v), status: '已拒绝', transition_from: current.status, via: '替代', replaced_by_v: rule.v, replaced_by_hash: rule.hash }] : [];
    return [rec, ...retired];
  }
  // 模板规则恢复：查找同模板+同范围的当前规则，标记为"替代"
  const rec = { ...recordBase(rule.latest, note), at, v: rule.v, status: rule.reenable_status, transition_from: rule.status, via: '恢复' };
  if (typeof assistantFlowId === 'string' && assistantFlowId) rec.assistant_flow_id = assistantFlowId;
  const currentRule = preview.current;
  const retired = currentRule ? [{ ...recordBase(currentRule.latest, null), at, v: currentRule.v, status: '已拒绝', transition_from: currentRule.status, via: '替代', replaced_by_v: rule.v, replaced_by_hash: rule.hash }] : [];
  return [rec, ...retired];
}

// 停用某条规则（仅状态变更，版本号不变）；多规则共存，不影响同模板其余规则
export function contractStopRecords(versions, { hash, rule_id } = {}) {
  const ruleSet = contractRuleSet(versions);
  const rule = ruleSet.rules.find((r) => r.hash === hash && (rule_id == null ? !r.is_custom : r.rule_id === rule_id));
  if (!rule || (rule.state !== 'current' && rule.state !== 'reconfirm')) return [];
  // 自定义规则停用
  if (rule.is_custom) {
    const at = new Date().toISOString();
    const rec = customRecordBase(rule.latest, null, at, rule.v);
    rec.status = '已拒绝';
    rec.transition_from = rule.status;
    rec.via = '停用';
    return [rec];
  }
  const at = new Date().toISOString();
  const rec = { ...recordBase(rule.latest, null), at, v: rule.v, status: '已拒绝', transition_from: rule.status, via: '停用' };
  return [rec];
}

// 自定义规则记录基础
function customRecordBase(src, note, at, v) {
  const rec = {
    schema: CUSTOM_RULE_SCHEMA,
    rule_id: src.rule_id,
    kind: 'custom',
    template_id: null,
    template_name: '自定义规则',
    text: src.text,
    action: src.action ?? null,
    scope: src.scope ? { ...src.scope } : { kind: 'all' },
    understanding: src.understanding ?? null,
    hash: src.hash,
    hash_algorithm: src.hash_algorithm ?? HASH_ALGORITHM,
    at: at ?? new Date().toISOString(),
    v,
    note: String(note ?? '').trim() || null,
  };
  return rec;
}

// 自定义规则编辑状态
export function contractCustomEditorState(versions, { rule_id, text, action, scope, understanding, hash }) {
  const ruleSet = contractRuleSet(versions);
  const base = { ruleSet, current: null, same: null, action: 'new', canSave: true, next_version: ruleSet.next_version };
  // 查找同 rule_id 的当前规则
  const current = ruleSet.customRules.find((r) => r.rule_id === rule_id && r.state === 'current') ?? null;
  // 查找同哈希的规则
  const same = ruleSet.customRules.find((r) => r.rule_id === rule_id && r.hash === hash) ?? null;
  if (same && same.state === 'current') return { ...base, current: same, same, action: 'unchanged', canSave: false };
  if (same && same.integrity.ok) return { ...base, current, same, action: 'restore', canSave: true };
  if (same && !same.integrity.ok) return { ...base, current, same, action: 'blocked', canSave: false };
  return { ...base, current, same: null, action: current ? 'edit' : 'new', canSave: true };
}

// 保存自定义规则
export function contractSaveCustomRecords(versions, { rule_id, text, action, scope, understanding, hash, note, assistantFlowId = null } = {}) {
  const d = contractCustomEditorState(versions, { rule_id, text, action, scope, understanding, hash });
  if (!d.canSave) return [];
  const at = new Date().toISOString();
  if (d.action === 'restore') {
    // 恢复历史版本
    return contractRestoreRecords(versions, { hash: d.same.hash, rule_id, note, assistantFlowId });
  }
  // 新版本或编辑
  const rec = customRecordBase({ rule_id, text, action, scope, understanding, hash }, note, at, d.next_version);
  rec.status = d.current ? '已改写' : '已确认';
  rec.from_v = d.current ? d.current.v : null;
  if (typeof assistantFlowId === 'string' && assistantFlowId) rec.assistant_flow_id = assistantFlowId;
  const retired = [];
  if (d.current && d.current.hash !== hash) {
    // 停用旧版本
    const oldRec = customRecordBase(d.current.latest, null, at, d.current.v);
    oldRec.status = '已拒绝';
    oldRec.transition_from = d.current.status;
    oldRec.via = '替代';
    oldRec.replaced_by_v = d.next_version;
    oldRec.replaced_by_hash = hash;
    oldRec.reason = `被同 rule_id 规则 v${d.next_version} 替代`;
    retired.push(oldRec);
  }
  return [rec, ...retired];
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

// 交易来源：已确认、未阻断、有标准化交易的本地账单 → 用户账单（Tushare 动态行情）；其余用所选行情来源对应的示例账单（不混用、不互相回退）
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
      market_label: MARKET_SOURCE_META['dynamic-tushare'].label,
      marketSource: 'dynamic-tushare',
      key: `user:dynamic-tushare:${bill.contextId ?? ''}:${name}:${JSON.stringify(bill.trades)}`,
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

// 契约情境的行情范围：示例账单加入 3 个示例标的；本地账单仅在不超过单次上限时加入，超限则只取账单标的（不截断账单标的）。
function contractMarketScope(trades, local) {
  if (!local) return marketScopeFromTrades(trades, { includeDemo: true });
  const billSymbols = new Set(trades.map((t) => t.symbol));
  const includeDemo = billSymbols.size + DEMO_SYMBOLS.filter((s) => !billSymbols.has(s)).length <= MARKET_SYMBOL_LIMIT;
  return marketScopeFromTrades(trades, { includeDemo });
}

// 情境上下文：本地账单与示例账单均按所选行情来源（默认 Tushare 动态日线）取数。
// 本地账单先过已知公司行为边界；取数/校验失败原样返回 error，不回落示例账单或其他行情来源。
export async function contractSimContext({ bill, marketSource = DEFAULT_MARKET_SOURCE, versions = [] } = {}) {
  const labels = contractSimLabels(marketSource);
  const local = isLocalBill(bill);
  const { source, trades } = await sourceTrades(bill, labels.id);
  const meta = { label: labels.label, scopeNote: labels.scopeNote, sourceKey: source.key };
  if (local && !isConfirmedLocalBill(bill)) return { ...meta, error: 'E_BILL_NOT_CONFIRMED · 本地账单校验未通过，禁止回退演示数据。' };
  const boundary = local ? localTradeBoundary(trades) : [];
  if (boundary.length) return { ...meta, error: boundary.map((e) => `${e.code} · ${e.message}`).join('；') };
  try {
    const billSymbols = [...new Set(trades.map((t) => t.symbol))].sort();
    const scope = labels.id === 'dynamic-tushare' ? contractMarketScope(trades, local) : null;
    const mkt = await loadMarket(labels.id, scope);
    const market = mkt.market;
    const symbols = [...billSymbols, ...market.symbols.filter((s) => !billSymbols.includes(s))];
    return {
      ...meta,
      marketSource: marketMeta(mkt),
      supportScope: supportScope(mkt),
      asOfDate: mkt.valuationDate,
      tradesSource: source,
      symbols: symbols.map((s) => ({ symbol: s, in_market_cache: market.symbols.includes(s), in_bill: billSymbols.includes(s) })),
      range: { ...market.range },
      tradingDays: [...market.tradingDays],
      sells: trades.filter((t) => t.side === 'sell').map((t) => ({ trade_id: t.trade_id, symbol: t.symbol, trade_date: t.trade_date })),
      buys: trades.filter((t) => t.side === 'buy').map((t) => ({ trade_id: t.trade_id, symbol: t.symbol, trade_date: t.trade_date })),
      ledger: buildRuleLedger({ rules: contractRuleSet(versions).current, trades, market }),
    };
  } catch (e) {
    return { ...meta, error: String(e && e.message ? e.message : e) };
  }
}

function simRuleOut(rule) {
  return {
    hash: rule.hash, short_hash: rule.short_hash, v: rule.v, status: rule.status, text: rule.text, template_id: rule.template_id, template_name: rule.template_name, fields_text: rule.fields_text,
    schema: rule.schema, scope: rule.scope, scope_text: rule.scope_text, timing: rule.timing, action: rule.action, action_label: actionLabel(rule.action), kind: rule.kind,
    rule_id: rule.rule_id ?? null,
  };
}

// 适用范围或提醒动作不匹配：不读取行情与交易，直接“不适用”（不计入命中 / 未命中 / 数据不足）
function scopeGate(out, rule, symbol, action) {
  if (!scopeApplies(rule.scope, symbol)) {
    return { ...out, ok: true, verdict: 'not_applicable', code: RULE_SPEC_CODES.SCOPE_NOT_APPLICABLE, message: notApplicableMessage(rule.scope, symbol) };
  }
  if (!actionApplies(rule.action, action)) {
    return { ...out, ok: true, verdict: 'not_applicable', code: RULE_SPEC_CODES.ACTION_NOT_APPLICABLE, message: notApplicableActionMessage(rule.action, action) };
  }
  return null;
}

const ruleReadsTrades = (rule) => {
  const kind = CONTRACT_TEMPLATES[rule.template_id]?.kind;
  return kind === 'sell_buyback_window' || kind === 'buy_sell_window';
};

// 非交易日处理沿用各来源现有 v1 路径（待统一）：签收缓存路径非交易日一律“数据不足”；示例路径涨幅规则按 B3 映射到不晚于申报日的最近交易日、不追回规则“数据不足”。
// B3 映射发生时如实返回申报日与实际使用的交易日；缺价（B4）不回退任何日期。
function dateMappingOf(requestedDate, change, market) {
  const valuation = change?.complete ? { blocked: false, effective_date: change.effective_date } : market.resolveValuation(requestedDate);
  if (valuation.blocked || valuation.effective_date === requestedDate) return null;
  const effective = valuation.effective_date;
  return {
    requested_date: requestedDate,
    effective_date: effective,
    basis: 'B3',
    has_price: !!change?.complete,
    message: `申报日 ${requestedDate} 不是交易日：按“不晚于申报日的最近交易日”映射为 ${effective}。${change?.complete ? `使用该日收盘数据（前收日 ${change.prev_date}）。` : '该日或前收日数据不足，不改用其他日期的价格。'}`,
  };
}

async function evaluateRuleDemo(rule, { symbol, date, bill, marketSource, action }) {
  const labels = contractSimLabels(marketSource);
  const applies = scopeApplies(rule.scope, symbol) && actionApplies(rule.action, action);
  const local = isLocalBill(bill);
  const out = {
    ok: false, label: labels.label, scopeNote: labels.scopeNote, symbol: symbol ?? null, requested_date: date ?? null, scenario_action: action,
    rule: simRuleOut(rule),
    verdict: null, code: null, message: '', change: null, match: null, date_mapping: null,
    tradesSource: applies ? contractTradeSource(bill, labels.id) : null, uses_trades: ruleReadsTrades(rule), in_market_cache: null,
  };
  if (!rule.integrity.ok) return { ...out, code: rule.integrity.code, message: rule.integrity.message };
  const gated = scopeGate(out, rule, symbol, action);
  if (gated) return gated;
  if (local && !isConfirmedLocalBill(bill)) return { ...out, code: 'E_BILL_NOT_CONFIRMED', message: '本地账单校验未通过，禁止回退演示数据。' };
  const parsed = rule.parsed;
  try {
    const { source, trades } = await sourceTrades(bill, labels.id);
    if (local) {
      const boundary = localTradeBoundary(trades);
      if (boundary.length) return { ...out, code: boundary[0].code, message: boundary.map((e) => e.message).join('；'), tradesSource: source };
    }
    const scope = labels.id === 'dynamic-tushare' ? contractMarketScope(trades, local) : null;
    const market = (await loadMarket(labels.id, scope)).market;
    out.in_market_cache = market.symbols.includes(symbol);
    // 签收缓存路径沿用 v1 口径：范围内非交易日不映射、不补价；日期超范围由缓存引擎报 OUT_OF_RANGE。
    const signedCache = marketSource === 'signed-cache';
    const inCacheRange = date >= market.range.start && date <= market.range.end;
    if (parsed.kind === 'change_pct_threshold') {
      if (signedCache && inCacheRange && !market.tradingDays.includes(date)) {
        return { ...out, ok: true, verdict: 'missing_data', code: CONTRACT_CODES.DATE_NOT_IN_CALENDAR, message: `申报日 ${date} 不是交易日；签收缓存路径不映射、不补价，按数据不足处理（B3/B4）。`, tradesSource: source };
      }
      if (!out.in_market_cache) {
        return { ...out, ok: true, verdict: 'missing_data', code: 'E_MARKET_OUT_OF_SUPPORT', message: `标的 ${symbol} 不在行情缓存支持范围（范围外，非当日缺价 R2）。`, tradesSource: source };
      }
      const change = dayChangePct(market, symbol, date);
      const match = matchContract(parsed, {
        symbol,
        date: change.complete ? change.effective_date : date,
        changePct: change.complete ? change.change_pct : null,
        reason_code: change.complete ? null : change.code,
      });
      return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, change, match, tradesSource: source, date_mapping: signedCache ? null : dateMappingOf(date, change, market) };
    }
    if (signedCache && !inCacheRange) {
      return { ...out, ok: true, verdict: 'missing_data', code: 'E_VALUATION_OUT_OF_RANGE', message: `日期 ${date} 超出签收缓存范围（${market.range.start} 至 ${market.range.end}）；不改用其他日期。`, tradesSource: source };
    }
    const match = matchContract(parsed, { symbol, date, trades, tradingDays: market.tradingDays });
    return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, match, tradesSource: source };
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    return local
      ? { ...out, code: 'E_MARKET_SOURCE', message: `动态行情获取失败：${message}` }
      : { ...out, code: CONTRACT_SIM_INPUT_INVALID, message: `情境输入无效：${message}` };
  }
}

function simulationDisplay(result) {
  const display_verdict = result.code === 'E_MARKET_OUT_OF_SUPPORT' ? 'missing_data' : result.ok ? result.verdict : 'error';
  return { ...result, display_verdict };
}

// 自定义规则不走模板引擎（rule.parsed 为 null）：范围/动作不匹配直接“不适用”（不调用模型、不读行情）；
// 适用的规则由页面层逐条请求模型辅助判定，这里只负责整理判定所需的最小情境数据（不上传价格、金额与其他标的记录）。
const CUSTOM_CALENDAR_MAX_DAYS = 500;
async function evaluateCustomRule(rule, { symbol, date, bill, marketSource, action }) {
  const labels = contractSimLabels(marketSource);
  const applies = scopeApplies(rule.scope, symbol) && actionApplies(rule.action, action);
  const local = isLocalBill(bill);
  const out = {
    ok: false, label: labels.label, scopeNote: labels.scopeNote, symbol: symbol ?? null, requested_date: date ?? null, scenario_action: action,
    rule: simRuleOut(rule),
    verdict: null, code: null, message: '', change: null, match: null, date_mapping: null,
    tradesSource: applies ? contractTradeSource(bill, labels.id) : null, uses_trades: false, in_market_cache: null,
    custom: null,
  };
  if (!rule.integrity.ok) return { ...out, code: rule.integrity.code, message: rule.integrity.message };
  const gated = scopeGate(out, rule, symbol, action);
  if (gated) return gated;
  if (local && !isConfirmedLocalBill(bill)) return { ...out, code: 'E_BILL_NOT_CONFIRMED', message: '本地账单校验未通过，禁止回退演示数据。' };
  try {
    const { source, trades } = await sourceTrades(bill, labels.id);
    if (local) {
      const boundary = localTradeBoundary(trades);
      if (boundary.length) return { ...out, code: boundary[0].code, message: boundary.map((e) => e.message).join('；'), tradesSource: source };
    }
    const scope = labels.id === 'dynamic-tushare' ? contractMarketScope(trades, local) : null;
    const market = (await loadMarket(labels.id, scope)).market;
    out.in_market_cache = market.symbols.includes(symbol);
    const change = dayChangePct(market, symbol, date);
    const mapping = marketSource === 'signed-cache' ? null : dateMappingOf(date, change, market);
    const buys = trades.filter((t) => t.side === 'buy' && t.symbol === symbol).map((t) => t.trade_date).sort();
    const sells = trades.filter((t) => t.side === 'sell' && t.symbol === symbol).map((t) => t.trade_date).sort();
    const anchor = [...buys, ...sells, date].sort()[0] ?? date;
    const calendarAll = market.tradingDays.filter((d) => d >= anchor && d <= date);
    const calendarTruncated = calendarAll.length > CUSTOM_CALENDAR_MAX_DAYS;
    const data = {
      symbol,
      requested_date: date,
      effective_date: change.complete ? change.effective_date : (mapping ? mapping.effective_date : null),
      change_pct: change.complete ? change.change_pct : null,
      market_label: labels.label,
      buys,
      sells,
      trading_days: calendarTruncated ? calendarAll.slice(-CUSTOM_CALENDAR_MAX_DAYS) : calendarAll,
      calendar_truncated: calendarTruncated,
    };
    return { ...out, ok: true, verdict: 'custom_pending', code: null, message: '', change, tradesSource: source, date_mapping: mapping, custom: { status: 'pending', data } };
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    return local
      ? { ...out, code: 'E_MARKET_SOURCE', message: `动态行情获取失败：${message}` }
      : { ...out, code: CONTRACT_SIM_INPUT_INVALID, message: `情境输入无效：${message}` };
  }
}

// 一次情境、所有当前规则逐条判定（各自走引擎链路，结果按规则分别返回，互不覆盖）；
// 历史规则不参与；完整性失败的启用规则不参与判定，仅在 needs_reconfirm 中如实回传（不猜测、不改写记录）。
// 模板规则走确定性引擎；自定义规则只做范围/动作筛选并整理最小情境数据（verdict=custom_pending），
// 由页面层逐条请求模型辅助判定后再回填结果。本地账单使用动态行情并检查公司行为边界；示例账单按所选行情来源判定。
export async function simulateContracts({ versions, symbol, date, bill, marketSource = DEFAULT_MARKET_SOURCE, action = 'buy' } = {}) {
  if (action !== 'buy' && action !== 'sell') throw new TypeError('情境动作须为 buy（假如买入）或 sell（假如卖出）');
  const { executable, needsReconfirm } = contractRuleSet(versions);
  const needsReconfirmOut = needsReconfirm.map((r) => ({
    hash: r.hash, short_hash: r.short_hash, v: r.v, status: r.status, text: r.text,
    template_name: r.template_name, fields_text: r.fields_text, code: r.integrity.code, message: r.integrity.message,
  }));
  const rulesUsed = executable.map((r) => ({ hash: r.hash, v: r.v, text: r.text, template_name: r.template_name, scope_text: r.scope_text, action: r.action, action_label: actionLabel(r.action) }));
  const summary = { triggered: 0, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 0, unable: 0, custom_pending: 0 };
  const labels = contractSimLabels(marketSource);
  const results = [];
  for (const rule of executable) {
    if (rule.is_custom) results.push(simulationDisplay(await evaluateCustomRule(rule, { symbol, date, bill, marketSource, action })));
    else results.push(simulationDisplay(await evaluateRuleDemo(rule, { symbol, date, bill, marketSource, action })));
  }
  for (const r of results) summary[r.display_verdict] = (summary[r.display_verdict] ?? 0) + 1;
  return {
    label: labels.label,
    scopeNote: labels.scopeNote,
    marketSourceId: labels.id,
    symbol: symbol ?? null,
    requested_date: date ?? null,
    scenario_action: action,
    tradesSource: executable.some((r) => scopeApplies(r.scope, symbol) && actionApplies(r.action, action)) ? contractTradeSource(bill, labels.id) : null,
    rules_n: executable.length,
    rules_used: rulesUsed,
    empty: executable.length === 0,
    needs_reconfirm_n: needsReconfirm.length,
    needs_reconfirm: needsReconfirmOut,
    summary,
    results,
  };
}
