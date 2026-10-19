// 演示数据适配层 —— 页面唯一数据出口。
// 数据链路（报告页·演示账单）：夹具 CSV 文本 → csvNormalize → marketCache（m0 合成夹具）→ indicators → provenance。
// 数据链路（报告页·用户账单）：确认后的标准化 state.bill → 同一市场段（合成夹具）→ runReview 复核与发布门槛 → published_facts。
// 数据链路（导入页·用户账单）：本地 CSV 文本（FileReader）→ csvNormalize 校验（仅本机，不上传、不落 localStorage）。
// 数据链路（契约页）：CONTRACT_TEMPLATES → parseContract 预览；版本记录 → contractRuleSet（按哈希合并、重新解析、每个模板派生唯一当前规则）；
//   历史情境：每个模板的当前规则 → marketCache（合成夹具）→ dayChangePct / 交易来源（已确认本地账单，否则演示账单 A）→ matchContract。
// 未接线：真实行情、百炼真实调用；契约为候选口径（占位哈希，待 M0-C1 冻结）；行情为 m0 合成夹具（草案·演示口径，非真实行情）。
// 对话页在线复述：仅复用已确认本地账单的 review，经站点同源边界发送组合四事实（当前 fake 验证；函数未发布/激活时走兜底）。
// 边界：本层只做取数与编排，不实现计算口径；数字与展示字符串一律来自 src/engine/*（页面不重新格式化）。
import { parseCsvText, normalizeRows } from '../engine/csvNormalize.js';
import { createMarketCache, fromFixtures } from '../engine/marketCache.js';
import { computeIndicators, RESULT_LABELS } from '../engine/indicators.js';
import { buildProvenanceReport } from '../engine/provenance.js';
import { runReview } from '../agent/reviewPipeline.js';
import { replaceSell } from '../engine/counterfactual.js';
import { CONTRACT_TEMPLATES, parseContract, dayChangePct, matchContract } from '../engine/contractMatch.js';

// 导入页使用的标准化夹具（保持现状：导入页未在本轮接线范围）
const FIXTURE = {
  A: '/m0/csv-input/fixtures/demo-bill.expected.json',
  Aprime: '/m0/csv-input/fixtures/demo-bill-aprime.expected.json',
};

// 报告页引擎链路使用的合成演示数据（占位代码与合成价格；非真实行情）
const REPORT_CSV = {
  A: '/m0/csv-input/fixtures/demo-bill.csv',
  Aprime: '/m0/csv-input/fixtures/demo-bill-aprime.csv',
};
const MARKET_FIXTURES = {
  calendar: '/m0/market-cache/fixtures/mock-calendar.json',
  bars: '/m0/market-cache/fixtures/mock-daily-bars.json',
};
// 合成夹具快照 range.end（非真实 asOfDate；{symbols,date_range} 清单尚未签收）
export const DEMO_VALUATION_DATE = '2024-10-11';

// 能力状态（供页面准确显示；ready 仅在完整链路验收后才置 true——PR #6 §6）
export const CAPABILITY = {
  engine: { ready: false, label: '计算引擎·仅报告页接入' },
  bailian: { ready: false, label: '百炼·未接通（对话页 fake 验证）' },
  marketCache: { ready: false, label: '行情缓存·合成夹具（草案·演示口径）' },
  contractEngine: { ready: false, label: '契约引擎·已接入（候选口径）' },
};

// 数据模式标识（PR #6 §1.1：三种模式必须显式标注；当前仅合成演示可用）
export const DATA_MODE = Object.freeze({
  id: 'synthetic_demo',
  label: '合成演示数据',
  note: '占位代码与合成价格（m0 夹具）；非真实账户、非真实行情；数字由本地确定性引擎计算',
});

// 场景定义（A′ 的改动是场景输入本身的事实：第 5 行卖出价 110 → 115）
export const SCENARIOS = Object.freeze({
  A: { key: 'A', label: '基准账单 A', note: '合成演示账单（5 笔交易；占位代码 000000 / 888888）' },
  Aprime: { key: 'Aprime', label: 'A′（仅改一笔卖出）', note: 'A′ 场景定义：仅改第 5 行卖出价 110.00 → 115.00，其余交易不变' },
});

export { RESULT_LABELS };

const cache = new Map();

async function loadFixture(scenario) {
  const key = scenario === 'Aprime' ? 'Aprime' : 'A';
  if (!cache.has(key)) {
    const res = await fetch(FIXTURE[key]);
    if (!res.ok) throw new Error(`演示夹具加载失败：${FIXTURE[key]}（HTTP ${res.status}）`);
    cache.set(key, await res.json());
  }
  return cache.get(key);
}

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

let marketPromise = null;
function demoMarket() {
  if (!marketPromise) {
    marketPromise = (async () => {
      const [calendar, barsDoc] = await Promise.all([fetchJson(MARKET_FIXTURES.calendar), fetchJson(MARKET_FIXTURES.bars)]);
      return createMarketCache(fromFixtures(calendar, barsDoc));
    })();
  }
  return marketPromise;
}

async function runSyntheticMarketStage(trades) {
  const market = await demoMarket();
  const val = market.resolveValuation(DEMO_VALUATION_DATE);
  if (val.blocked) {
    return { ok: false, market, val, errors: [{ line: 0, code: val.code, message: `估值日 ${val.requested_date} 无法解析有效交易日（不静默改期）` }] };
  }
  const lastTradeDate = trades.map((t) => t.trade_date).sort()[trades.length - 1];
  const lastCheck = market.checkLastTrade(val.effective_date, lastTradeDate);
  if (lastCheck.blocked) {
    return { ok: false, market, val, errors: [{ line: 0, code: lastCheck.code, message: `有效估值日 ${val.effective_date} 早于账单末笔交易日 ${lastTradeDate}` }] };
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
      : `标的 ${s} 不在合成行情缓存支持范围（${market.symbols.join('、')}）：该标的结果不发布；组合结果同样不发布`,
  }));
  return { ok: true, market, val, prices, symbols, unblocked, blockedSymbols, errors };
}

/* —— 导入页：演示账单标准化夹具（保持现状，未在本轮接线范围） —— */
export const DEMO_SOURCE_NOTE = '演示数据 · 合成夹具（m0/csv-input/fixtures）；非真实账户交易结果';

export async function loadDemoBill(scenario = 'A') {
  const fx = await loadFixture(scenario);
  return {
    scenario: fx.fixture === 'demo-bill.csv' ? 'A' : 'Aprime',
    trades: fx.standardized.trades,
    warnings: fx.standardized.warnings,
    blocked: fx.standardized.blocked ?? false,
    sourceNote: `来源：${fx.fixture}（合成夹具；占位代码非真实证券）`,
    resultLabelling: fx.result_labelling,
  };
}

const USER_BILL_DATA_MODE = Object.freeze({
  id: 'user_bill_synthetic_market',
  label: '用户本地账单 + 合成演示行情',
  note: '交易文件仅在本机处理；当前行情为合成演示缓存，非真实行情，支持范围有限',
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

/* —— 报告页：引擎链路（合成演示）——
   输出契约（页面消费）：
   { scenario, dataMode, status('ok'|'partial'|'blocked'|'error'), blocked, warnings[], errors[],
     valuation{requested_date,effective_date,blocked,code}, marketRange, snapshot, prices,
     blockedSymbols[], poolBlocked, perStock{}, pool|null, display|null, provenance|null, labels, scenarioMeta } */
export async function loadReportEngine(scenario = 'A') {
  const key = scenario === 'Aprime' ? 'Aprime' : 'A';
  const out = {
    scenario: key,
    scenarioMeta: SCENARIOS[key],
    dataMode: DATA_MODE,
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
  const csvUrl = REPORT_CSV[key];
  const fileName = csvUrl.split('/').pop();
  const text = await fetchText(csvUrl);
  const normalized = normalizeRows(parseCsvText(text), fileName);
  out.warnings.push(...normalized.warnings);
  if (normalized.blocked || normalized.trades.length === 0) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push(...(normalized.errors.length ? normalized.errors : [{ line: 0, code: 'E_EMPTY', message: '账单无可计算交易' }]));
    return out;
  }
  const trades = normalized.trades;
  out.trades = trades; // 供「单笔反事实」区复用同一标准化账单（页面不解析 CSV）

  // 2) 行情（合成夹具）→ 估值日解析 → 末笔检查 → 取价（缺价阻断，不回落）——共享市场段
  const stage = await runSyntheticMarketStage(trades);
  out.marketRange = { ...stage.market.range };
  out.snapshot = stage.market.snapshot;
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

export async function loadUserBillReport(bill) {
  const out = {
    sourceType: 'local',
    fileName: bill && bill.fileName ? bill.fileName : '',
    dataMode: USER_BILL_DATA_MODE,
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

  // 1) 共享市场段：估值日 → 末笔检查 → 取价（硬阻断即返回，不回退演示账单）
  const stage = await runSyntheticMarketStage(trades);
  out.marketRange = { ...stage.market.range };
  out.snapshot = stage.market.snapshot;
  out.valuation = stage.val;
  if (!stage.ok) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push(...stage.errors);
    return out;
  }
  out.prices = stage.prices;
  out.blockedSymbols = [...stage.blockedSymbols];
  out.errors.push(...stage.errors);

  // 2) runReview（全量标的 closes：缺价置 null，由复核统一扣发该标的与组合）
  const closes = {};
  for (const s of stage.symbols) closes[s] = stage.prices.per_symbol[s].blocked ? null : stage.prices.per_symbol[s].close;
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
   演示账单未经 runReview，不生成 review、不回退演示数据；页面据此给出明确兜底。 */
export const CHAT_REVIEW_CODES = Object.freeze({
  BILL_NOT_CONFIRMED: 'W_CHAT_BILL_NOT_CONFIRMED',
  REVIEW_UNAVAILABLE: 'W_CHAT_REVIEW_UNAVAILABLE',
});

export async function loadChatReview(bill) {
  if (!isConfirmedLocalBill(bill)) {
    return {
      ok: false,
      code: CHAT_REVIEW_CODES.BILL_NOT_CONFIRMED,
      message: '在线复述仅使用已确认的本地账单；演示账单未经复核发布流程，不参与在线复述。',
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

// 单笔卖出反事实（S1 幽灵线缺口图）—— 演示账单与用户确认账单共用本入口。
export const CF_CODES = Object.freeze({
  NO_TRADES: 'E_CF_NO_TRADES',
  BAD_SCOPE: 'E_CF_BAD_SCOPE',
  SYMBOL_NOT_IN_BILL: 'E_CF_SYMBOL_NOT_IN_BILL',
  NO_SELL: 'E_CF_NO_SELL',
  TRADE_NOT_FOUND: 'E_CF_TRADE_NOT_FOUND',
  NOT_SELL: 'E_CF_NOT_SELL',
  MARKET_BLOCKED: 'E_CF_MARKET_BLOCKED',
  PRICE_MISSING: 'E_CF_PRICE_MISSING',
  ENGINE_ERROR: 'E_CF_ENGINE_ERROR',
});

export async function loadSellCounterfactual({ trades, symbol, tradeId } = {}) {
  const fail = (code, message) => ({
    ok: false, code, message, symbol: symbol ?? null, tradeId: tradeId ?? null,
    sellOptions: [], markers: [], replace: null, series: null, valuation: null, marketRange: null, labels: RESULT_LABELS,
  });
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

  const stage = await runSyntheticMarketStage(symbolTrades);
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
  return {
    ok: true,
    code: null,
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
export const CONTRACT_SIM_LABEL = '合成行情 · 演示口径，不构成投资建议';
export const CONTRACT_SIM_SCOPE_NOTE = '非真实行情 · 候选口径（待 M0-C1 冻结）· 不构成投资建议';
export const CONTRACT_HASH_NOTE = '候选哈希，待 M0-C1 冻结';
export const CONTRACT_SIM_INPUT_INVALID = 'E_CONTRACT_SIM_INPUT_INVALID';
const SIM_MARKET_LABEL = '合成演示行情（m0 夹具，非真实行情）';
const DEMO_TRADES_LABEL = '演示账单 A（demo-bill.csv，合成）';

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

let demoTradesPromise = null;
function demoTradesA() {
  if (!demoTradesPromise) {
    demoTradesPromise = (async () => {
      const csvUrl = REPORT_CSV.A;
      const normalized = normalizeRows(parseCsvText(await fetchText(csvUrl)), csvUrl.split('/').pop());
      return normalized.trades;
    })();
  }
  return demoTradesPromise;
}

// 交易来源：已确认、未阻断、有标准化交易的本地账单 → 用户账单；其余一律演示账单 A（不混用、不互相回退）
function isConfirmedLocalBill(bill) {
  return !!bill && bill.status === 'confirmed' && bill.sourceType === 'local' && !bill.blocked && Array.isArray(bill.trades) && bill.trades.length > 0;
}

export function contractTradeSource(bill) {
  if (isConfirmedLocalBill(bill)) {
    const name = String(bill.fileName || 'user-bill.csv');
    return {
      kind: 'user_bill',
      label: `已确认本地账单（${name}）`,
      fileName: name,
      market_label: SIM_MARKET_LABEL,
      key: `user:${name}:${JSON.stringify(bill.trades.map((t) => [t.trade_id, t.symbol, t.side, t.trade_date]))}`,
    };
  }
  return { kind: 'demo_bill_a', label: DEMO_TRADES_LABEL, fileName: 'demo-bill.csv', market_label: SIM_MARKET_LABEL, key: 'demo:A' };
}

async function sourceTrades(bill) {
  const source = contractTradeSource(bill);
  return { source, trades: source.kind === 'user_bill' ? bill.trades : await demoTradesA() };
}

export async function contractSimContext({ bill } = {}) {
  const [market, { source, trades }] = await Promise.all([demoMarket(), sourceTrades(bill)]);
  const billSymbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const symbols = [...billSymbols, ...market.symbols.filter((s) => !billSymbols.includes(s))];
  return {
    label: CONTRACT_SIM_LABEL,
    scopeNote: CONTRACT_SIM_SCOPE_NOTE,
    sourceKey: source.key,
    tradesSource: source,
    symbols: symbols.map((s) => ({ symbol: s, in_market_cache: market.symbols.includes(s), in_bill: billSymbols.includes(s) })),
    range: { ...market.range },
    tradingDays: [...market.tradingDays],
    sells: trades.filter((t) => t.side === 'sell').map((t) => ({ trade_id: t.trade_id, symbol: t.symbol, trade_date: t.trade_date })),
  };
}

async function evaluateRule(rule, { symbol, date, bill }) {
  const out = {
    ok: false, label: CONTRACT_SIM_LABEL, scopeNote: CONTRACT_SIM_SCOPE_NOTE, symbol: symbol ?? null, requested_date: date ?? null,
    rule: { hash: rule.hash, short_hash: rule.short_hash, v: rule.v, status: rule.status, text: rule.text, template_name: rule.template_name, fields_text: rule.fields_text },
    verdict: null, code: null, message: '', change: null, match: null,
    tradesSource: contractTradeSource(bill), uses_trades: CONTRACT_TEMPLATES[rule.template_id]?.kind === 'sell_buyback_window', in_market_cache: null,
  };
  if (!rule.integrity.ok) return { ...out, code: rule.integrity.code, message: rule.integrity.message };
  const parsed = rule.parsed;
  try {
    const market = await demoMarket();
    out.in_market_cache = market.symbols.includes(symbol);
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
    const { source, trades } = await sourceTrades(bill);
    const match = matchContract(parsed, { symbol, date, trades, tradingDays: market.tradingDays });
    return { ...out, ok: true, verdict: match.verdict, code: match.code, message: match.message, match, tradesSource: source };
  } catch (e) {
    return { ...out, code: CONTRACT_SIM_INPUT_INVALID, message: `情境输入无效：${String(e && e.message ? e.message : e)}` };
  }
}

// 一次情境、每个模板唯一的当前规则逐条判定（各自走引擎链路，结果按规则分别返回，互不覆盖）；
// 历史规则不参与；完整性失败的启用规则不参与判定，仅在 needs_reconfirm 中如实回传（不猜测、不改写记录）。
export async function simulateContracts({ versions, symbol, date, bill } = {}) {
  const { executable, needsReconfirm } = contractRuleSet(versions);
  const results = [];
  for (const rule of executable) results.push(await evaluateRule(rule, { symbol, date, bill }));
  const summary = { triggered: 0, not_triggered: 0, missing_data: 0, error: 0 };
  for (const r of results) summary[r.ok ? r.verdict : 'error'] += 1;
  return {
    label: CONTRACT_SIM_LABEL,
    scopeNote: CONTRACT_SIM_SCOPE_NOTE,
    symbol: symbol ?? null,
    requested_date: date ?? null,
    tradesSource: contractTradeSource(bill),
    rules_n: executable.length,
    rules_used: executable.map((r) => ({ hash: r.hash, v: r.v, text: r.text, template_name: r.template_name })),
    empty: executable.length === 0,
    needs_reconfirm_n: needsReconfirm.length,
    needs_reconfirm: needsReconfirm.map((r) => ({
      hash: r.hash, short_hash: r.short_hash, v: r.v, status: r.status, text: r.text,
      template_name: r.template_name, fields_text: r.fields_text, code: r.integrity.code, message: r.integrity.message,
    })),
    summary,
    results,
  };
}
