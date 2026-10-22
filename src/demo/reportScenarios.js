// 报告页示例场景：真实 A 股历史收盘价 + 冻结的 Tushare 区间行情。
// 目的：让示例报告与行情来自同一份真实历史快照，避免“假成交价 + 真实行情”的错配；
// 示例交易按当日收盘价构造，非真实成交；用户真实账单仍走 Tushare 动态行情，不在本模块内回退。
import { createMarketCache } from '../engine/marketCache.js';
import { REPORT_SCENARIO_MARKET } from './reportScenarioMarket.js';

export const DEMO_REPORT_MARKET_SOURCE = Object.freeze({
  id: 'demo-frozen',
  label: '示例行情（Tushare 历史日线快照）',
  shortLabel: '示例行情 · Tushare',
  note: '真实历史日线，冻结区间 2024-12-02～2025-06-30；非实时、非投资建议',
  demo: true,
  signed: false,
  dynamic: false,
});

export const DEMO_TRADING_DAYS = Object.freeze([...REPORT_SCENARIO_MARKET.trading_days]);
export const DEMO_VALUATION_DATE = REPORT_SCENARIO_MARKET.asOfDate;

const bars = Object.fromEntries(
  Object.entries(REPORT_SCENARIO_MARKET.symbols).map(([symbol, series]) => {
    const unadjusted = DEMO_TRADING_DAYS.map((date, index) => ({ date, close: series.closes[index] }));
    const forwardAdjusted = DEMO_TRADING_DAYS.map((date, index) => ({ date, close: series.fwdadj[index] }));
    return [symbol, { bars: unadjusted, bars_fwdadj: forwardAdjusted }];
  }),
);

const closeIndex = new Map(
  Object.entries(bars).map(([symbol, series]) => [symbol, new Map(series.bars.map((bar) => [bar.date, bar.close]))]),
);

function priceAt(symbol, date) {
  const close = closeIndex.get(symbol)?.get(date);
  if (!Number.isFinite(close)) throw new Error(`示例行情缺少 ${symbol} ${date} 的收盘价`);
  return close;
}

export const DEMO_MARKET_SNAPSHOT = Object.freeze({
  snapshot_id: REPORT_SCENARIO_MARKET.snapshot_id,
  range: { ...REPORT_SCENARIO_MARKET.range },
  latest_trade_date: DEMO_VALUATION_DATE,
  adjustment_basis: '前复权展示；不复权估值',
  adjustment_basis_note: '示例行情来自 Tushare 历史日线；估值只用不复权 close，前复权仅用于展示',
  provider: REPORT_SCENARIO_MARKET.provider,
  fetched_at: REPORT_SCENARIO_MARKET.fetched_at,
  checksum: REPORT_SCENARIO_MARKET.checksum,
});

class ScenarioTable {
  constructor(rows) {
    this.header = ['日期', '标的', '方向', '价格', '数量', '费用', '税费'];
    this.rows = rows.map((row, index) => ({
      line: index + 2,
      cells: [
        row[0],
        String(row[1]),
        row[2] === 'buy' ? '买入' : '卖出',
        priceAt(row[1], row[0]).toFixed(2),
        String(row[3]),
        '5.00',
        row[2] === 'sell' ? '10.00' : '0.00',
      ],
    }));
  }
}

const DEFINITIONS = [
  {
    id: 'chase',
    title: '追高止损',
    tag: '行为成立 · 有规则候选',
    headline: '追高之后，<br>差距在哪。',
    story: '两次在比亚迪（002594）短期大涨后买入，之后止损卖出；看得到行为发现和规则候选。',
    expectation: {
      behavior_status: '成立',
      sample_n: 2,
      evaluated_n: 3,
      behavior_visible: true,
      candidate_visible: true,
      ai_blind_spot: '行为已由确定性引擎识别，AI 不应扩大或改写命中笔数。',
    },
    rows: [
      ['2025-03-20', '002594', 'buy', 100],
      ['2025-03-21', '002594', 'buy', 100],
      ['2025-03-24', '600036', 'buy', 200],
      ['2025-04-07', '002594', 'sell', 100],
      ['2025-04-09', '002594', 'sell', 50],
      ['2025-04-16', '600036', 'sell', 100],
    ],
  },
  {
    id: 'early',
    title: '卖得太早',
    tag: '卖出后继续上涨',
    headline: '卖早之后，<br>差距在哪。',
    story: '在招商银行（600036）上涨途中分两次卖出；报告把“少拿的部分”摆出来，不展示未成立的行为模式。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 2,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '趋势卖出不是追高，AI 不应把它包装成已识别的行为模式。',
    },
    rows: [
      ['2025-01-14', '600036', 'buy', 200],
      ['2025-02-05', '600036', 'buy', 100],
      ['2025-04-16', '600036', 'sell', 100],
      ['2025-05-13', '600036', 'sell', 100],
    ],
  },
  {
    id: 'stop',
    title: '及时止损',
    tag: '卖出后继续下跌',
    headline: '止损之后，<br>差距在哪。',
    story: '在五粮液（000858）下跌中卖出；报告显示“相对一直持有少亏”，而不是只讲代价。',
    expectation: {
      behavior_status: '证据不足',
      sample_n: 0,
      evaluated_n: 1,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '只有一笔可评估买入，AI 不应据此下重复模式结论。',
    },
    rows: [
      ['2025-03-17', '000858', 'buy', 300],
      ['2025-04-07', '000858', 'sell', 300],
    ],
  },
  {
    id: 'hold',
    title: '一直持有',
    tag: '没有卖出',
    headline: '一直持有，<br>差距在哪。',
    story: '只买入招商银行（600036）与中国平安（601318）、不卖出；没有单笔反事实，报告保持简短。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 2,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '没有卖出行为，AI 不应虚构择时损失或规则候选。',
    },
    rows: [
      ['2025-01-14', '600036', 'buy', 200],
      ['2025-02-05', '601318', 'buy', 100],
    ],
  },
  {
    id: 'no_pattern',
    title: '无明显模式',
    tag: '行为不成立 · 无候选',
    headline: '没有模式，<br>也是一种结果。',
    story: '三只真实标的、三笔普通买卖，没有重复追高；报告不硬凑行为结论，也不给规则候选。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 3,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: 'AI 容易把普通交易描述成“习惯”；这里必须承认没有可识别模式。',
    },
    rows: [
      ['2025-01-14', '600519', 'buy', 100],
      ['2025-02-05', '601318', 'buy', 100],
      ['2025-03-17', '000001', 'buy', 100],
      ['2025-03-17', '600519', 'sell', 100],
      ['2025-04-16', '601318', 'sell', 100],
      ['2025-05-13', '000001', 'sell', 100],
    ],
  },
  {
    id: 'low_sample',
    title: '样本不足',
    tag: '证据不足 · 不下结论',
    headline: '只有一次，<br>先别下结论。',
    story: '只有一笔可评估买入（紫金矿业 601899），虽然命中追高条件，但没有达到最小重复数。',
    expectation: {
      behavior_status: '证据不足',
      sample_n: 1,
      evaluated_n: 1,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '单次命中不是重复模式；AI 不得把 n=1 说成稳定行为。',
    },
    rows: [
      ['2025-04-16', '601899', 'buy', 100],
      ['2025-05-13', '601899', 'sell', 100],
    ],
  },
  {
    id: 'sell_rebuy',
    title: '卖后追回',
    tag: '行为成立 · 有规则候选',
    headline: '卖了又追回，<br>现在看得见了。',
    story: '两次在宁德时代（300750）卖出后两个交易日内买回；引擎识别重复模式，并给出“卖出后不追回”的规则候选。',
    expectation: {
      pattern_id: 'sell_rebuy_within_2d',
      behavior_status: '成立',
      sample_n: 2,
      evaluated_n: 2,
      behavior_visible: true,
      candidate_visible: true,
      ai_blind_spot: '本地引擎已识别卖后追回；AI 不应改写命中笔数或窗口。',
    },
    rows: [
      ['2025-02-17', '300750', 'buy', 200],
      ['2025-02-24', '300750', 'sell', 200],
      ['2025-02-26', '300750', 'buy', 100],
      ['2025-03-10', '300750', 'sell', 100],
      ['2025-03-12', '300750', 'buy', 100],
    ],
  },
  {
    id: 'overtrading',
    title: '频繁交易',
    tag: '行为成立 · 暂无规则模板',
    headline: '来回四次，<br>先看见频率。',
    story: '招商银行（600036）四次完整往返；引擎识别交易频率偏高，但现有模板还没有对应规则。',
    expectation: {
      pattern_id: 'overtrading',
      behavior_status: '成立',
      sample_n: 4,
      evaluated_n: 4,
      behavior_visible: true,
      candidate_visible: false,
      ai_blind_spot: '频率模式已由本地引擎识别；当前没有对应规则模板，不得编造规则或买卖指令。',
    },
    rows: [
      ['2025-01-14', '600036', 'buy', 100],
      ['2025-02-05', '600036', 'sell', 100],
      ['2025-02-17', '600036', 'buy', 100],
      ['2025-03-03', '600036', 'sell', 100],
      ['2025-03-13', '600036', 'buy', 100],
      ['2025-03-27', '600036', 'sell', 100],
      ['2025-04-08', '600036', 'buy', 100],
      ['2025-04-22', '600036', 'sell', 100],
    ],
  },
];

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function tableToCsv(table) {
  const lines = [table.header, ...table.rows.map((row) => row.cells)];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function scenarioRowKey(cells = []) {
  return [cells[0], cells[1], cells[2], cells[4]].map((value) => String(value ?? '').trim()).join('|');
}

function scenarioSignature(table) {
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  return rows.map((row) => scenarioRowKey(row.cells)).sort().join('~');
}

export const REPORT_SCENARIOS = Object.freeze(DEFINITIONS.map((definition) => {
  const table = new ScenarioTable(definition.rows);
  return Object.freeze({
    ...definition,
    fileName: `示例场景-${definition.title}.csv`,
    table,
    csv: tableToCsv(table),
  });
}));

export function getReportScenario(id) {
  return REPORT_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}

export function getReportScenarioByFileName(fileName) {
  const name = String(fileName ?? '').trim().toLowerCase();
  if (!name) return null;
  return REPORT_SCENARIOS.find((scenario) => scenario.fileName.toLowerCase() === name) ?? null;
}

/** 下载后重新上传时识别示例场景：优先比对交易内容，文件名用于容忍价格/数量微调。 */
export function matchReportScenario({ fileName = '', table = null } = {}) {
  const byName = getReportScenarioByFileName(fileName);
  if (!table?.rows?.length) return byName;
  const signature = scenarioSignature(table);
  if (!signature) return byName;
  return REPORT_SCENARIOS.find((scenario) => scenarioSignature(scenario.table) === signature) ?? byName;
}

const marketCache = new Map();

export function loadReportScenarioMarket(id) {
  const scenario = getReportScenario(id);
  if (!scenario) throw new Error(`未知示例场景：${id}`);
  if (!marketCache.has(scenario.id)) {
    const market = createMarketCache({
      tradingDays: DEMO_TRADING_DAYS,
      range: DEMO_MARKET_SNAPSHOT.range,
      symbols: bars,
      snapshot: DEMO_MARKET_SNAPSHOT,
    });
    marketCache.set(scenario.id, {
      market,
      valuationDate: DEMO_VALUATION_DATE,
      source: {
        ...DEMO_REPORT_MARKET_SOURCE,
        demoScenario: scenario.id,
        range: { ...market.range },
        symbols: [...market.symbols],
        asOfDate: DEMO_VALUATION_DATE,
        snapshot: DEMO_MARKET_SNAPSHOT,
        provider: REPORT_SCENARIO_MARKET.provider,
        fetchedAt: REPORT_SCENARIO_MARKET.fetched_at,
        snapshotId: DEMO_MARKET_SNAPSHOT.snapshot_id,
        checksum: DEMO_MARKET_SNAPSHOT.checksum,
        manifestVersion: 'tushare-frozen-v1',
      },
    });
  }
  return marketCache.get(scenario.id);
}
