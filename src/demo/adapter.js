// 演示数据适配层 —— 页面唯一数据出口。
// 数据链路（报告页）：演示账单 CSV 文本 → csvNormalize → marketCache（m0 合成夹具）→ indicators → provenance。
// 未接线：真实 CSV 上传、真实行情、百炼、契约匹配（分别由后续任务接入）；导入页仍读 m0 标准化夹具。
// 边界：本层只做取数与编排，不实现计算口径；数字与展示字符串一律来自 src/engine/*（页面不重新格式化）。
import { parseCsvText, normalizeRows } from '../engine/csvNormalize.js';
import { createMarketCache, fromFixtures } from '../engine/marketCache.js';
import { computeIndicators, RESULT_LABELS } from '../engine/indicators.js';
import { buildProvenanceReport } from '../engine/provenance.js';

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
  bailian: { ready: false, label: '百炼·未接入（离线）' },
  marketCache: { ready: false, label: '行情缓存·合成夹具（草案·演示口径）' },
  contractEngine: { ready: false, label: '契约引擎·未接入' },
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

  // 2) 行情（合成夹具）→ 估值日解析 → 末笔检查 → 取价（缺价阻断，不回落）
  const market = await demoMarket();
  out.marketRange = { ...market.range };
  out.snapshot = market.snapshot;
  const val = market.resolveValuation(DEMO_VALUATION_DATE);
  out.valuation = val;
  if (val.blocked) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push({ line: 0, code: val.code, message: `估值日 ${val.requested_date} 无法解析有效交易日（不静默改期）` });
    return out;
  }
  const lastTradeDate = trades.map((t) => t.trade_date).sort()[trades.length - 1];
  const lastCheck = market.checkLastTrade(val.effective_date, lastTradeDate);
  if (lastCheck.blocked) {
    out.status = 'blocked';
    out.blocked = true;
    out.errors.push({ line: 0, code: lastCheck.code, message: `有效估值日 ${val.effective_date} 早于账单末笔交易日 ${lastTradeDate}` });
    return out;
  }
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const prices = market.resolvePrices(symbols, val.effective_date);
  out.prices = prices;
  const unblocked = symbols.filter((s) => !prices.per_symbol[s].blocked);
  out.blockedSymbols = symbols.filter((s) => prices.per_symbol[s].blocked);
  if (out.blockedSymbols.length > 0) {
    out.poolBlocked = true; // B4：不按剩余标的重算冒充完整组合
    for (const s of out.blockedSymbols) {
      out.errors.push({ line: 0, code: prices.per_symbol[s].code, message: `标的 ${s} 在估值日 ${val.effective_date} 缺价：该标的结果不发布；组合结果同样不发布（未回退其他日期）` });
    }
  }
  if (unblocked.length === 0) {
    out.status = 'blocked';
    out.blocked = true;
    return out;
  }

  // 3) 计算（只喂未阻断标的；引擎抛错不被吞掉）
  const closes = {};
  for (const s of unblocked) closes[s] = prices.per_symbol[s].close;
  const usableTrades = trades.filter((t) => unblocked.includes(t.symbol));
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
    out.provenance = buildProvenanceReport({ report, trades: usableTrades, closes, valuation: val });
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

/* —— 契约规则候选（演示数据；契约引擎未接入，阈值解析与匹配未实现） —— */
export function demoRuleCandidates() {
  return [
    {
      id: 'RC-1',
      text: '当天涨幅超过 5% 的票，我绝不买入。',
      trigger: '申报买入时：该标的当日涨幅 > 5%',
      backread: '回看：过去 N 次追涨买入的持有期表现（历史统计）',
      note: '演示候选（合成）——契约引擎未接入，阈值解析与匹配判定未实现',
    },
    {
      id: 'RC-2',
      text: '卖出后 3 个交易日内不追回同一只票。',
      trigger: '卖出后 3 个交易日内出现同标的买入申报',
      backread: '回看：过去相似“卖出即买回”的记录',
      note: '演示候选（合成）',
    },
  ];
}

// 对话离线降级占位（百炼未接入；不引用事实 JSON）
export function offlineChatReply(question) {
  const q = String(question || '').trim();
  const base = q ? `已记录你的问题：「${q}」` : '（空问题）';
  return {
    text: `${base}\n\n百炼未接入：当前为离线降级模式，无法执行意图分类与事实复述。接入后，回答将基于事实 JSON 复述（数字不离开事实 JSON、不外推）。可先在「报告 · 证据」页查看演示数据。`,
    mode: 'offline',
  };
}