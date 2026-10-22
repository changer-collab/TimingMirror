// 报告页示例场景：合成账单 + 冻结合成行情。
// 目的：让示例报告与行情来自同一套合成数据，避免“假成交价 + 真实行情”的错配；
// 用户真实账单仍走 Tushare 动态行情，不在本模块内回退。
import { createMarketCache } from '../engine/marketCache.js';

export const DEMO_REPORT_MARKET_SOURCE = Object.freeze({
  id: 'demo-frozen',
  label: '示例行情（冻结合成）',
  shortLabel: '示例行情',
  note: '合成价格，仅用于演示不同报告状态；占位代码非真实证券，非实时行情',
  demo: true,
  signed: false,
  dynamic: false,
});

const START = '2024-12-02';
const END = '2025-06-30';

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function weekdays(start, end) {
  const days = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(isoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export const DEMO_TRADING_DAYS = Object.freeze(weekdays(START, END));
export const DEMO_VALUATION_DATE = DEMO_TRADING_DAYS[DEMO_TRADING_DAYS.length - 1];

const round2 = (v) => Math.round(v * 100) / 100;

function priceAt(anchors, index) {
  if (index <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i += 1) {
    const [endIndex, endPrice] = anchors[i];
    if (index <= endIndex) {
      const [startIndex, startPrice] = anchors[i - 1];
      const t = (index - startIndex) / (endIndex - startIndex);
      return round2(startPrice + (endPrice - startPrice) * t);
    }
  }
  return anchors[anchors.length - 1][1];
}

function buildBars(anchors) {
  return DEMO_TRADING_DAYS.map((date, index) => {
    const close = priceAt(anchors, index);
    return {
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 100000,
    };
  });
}

const SYMBOL_ANCHORS = {
  900001: [[0, 82], [40, 88], [50, 96], [55, 102], [60, 135], [70, 122], [78, 105], [90, 142], [100, 150], [139, 165], [150, 168]],
  900002: [[0, 38], [40, 42], [60, 50], [70, 60], [80, 62], [90, 72], [100, 78], [110, 84], [139, 86], [150, 88]],
  900003: [[0, 95], [40, 96], [60, 94], [75, 92], [90, 80], [100, 70], [120, 72], [139, 64], [150, 62]],
};

const bars = Object.fromEntries(
  Object.entries(SYMBOL_ANCHORS).map(([symbol, anchors]) => {
    const series = buildBars(anchors);
    return [symbol, { bars: series, bars_fwdadj: series.map((bar) => ({ ...bar })) }];
  }),
);

export const DEMO_MARKET_SNAPSHOT = Object.freeze({
  snapshot_id: 'demo-report-snapshot-v1',
  range: { start: DEMO_TRADING_DAYS[0], end: DEMO_VALUATION_DATE },
  latest_trade_date: DEMO_VALUATION_DATE,
  adjustment_basis: 'none',
  adjustment_basis_note: '示例行情：不复权与前复权同值',
});

class ScenarioTable {
  constructor(rows) {
    this.header = ['日期', '标的', '方向', '价格', '数量', '费用', '税费'];
    this.rows = rows.map((row, index) => ({
      line: index + 2,
      cells: [
        DEMO_TRADING_DAYS[row[0]],
        String(row[1]),
        row[2] === 'buy' ? '买入' : '卖出',
        priceAt(SYMBOL_ANCHORS[row[1]], row[0]).toFixed(2),
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
    story: '两次在短期大涨后买入，之后止损卖出；看得到行为发现和规则候选。',
    expectation: {
      behavior_status: '成立',
      sample_n: 2,
      evaluated_n: 3,
      behavior_visible: true,
      candidate_visible: true,
      ai_blind_spot: '行为已由确定性引擎识别，AI 不应扩大或改写命中笔数。',
    },
    rows: [
      [60, 900001, 'buy', 100],
      [62, 900001, 'buy', 100],
      [75, 900002, 'buy', 200],
      [78, 900001, 'sell', 100],
      [90, 900001, 'sell', 50],
      [110, 900002, 'sell', 100],
    ],
  },
  {
    id: 'early',
    title: '卖得太早',
    tag: '卖出后继续上涨',
    headline: '卖早之后，<br>差距在哪。',
    story: '把上涨中的持仓提前卖出；报告把“少拿的部分”摆出来，不展示未成立的行为模式。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 2,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '趋势卖出不是追高，AI 不应把它包装成已识别的行为模式。',
    },
    rows: [
      [70, 900002, 'buy', 200],
      [80, 900003, 'buy', 100],
      [90, 900002, 'sell', 100],
      [100, 900002, 'sell', 100],
    ],
  },
  {
    id: 'stop',
    title: '及时止损',
    tag: '卖出后继续下跌',
    headline: '止损之后，<br>差距在哪。',
    story: '在下跌中卖出；报告显示“相对一直持有少亏”，而不是只讲代价。',
    expectation: {
      behavior_status: '证据不足',
      sample_n: 0,
      evaluated_n: 1,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '只有一笔可评估买入，AI 不应据此下重复模式结论。',
    },
    rows: [
      [75, 900003, 'buy', 300],
      [100, 900003, 'sell', 300],
    ],
  },
  {
    id: 'hold',
    title: '一直持有',
    tag: '没有卖出',
    headline: '一直持有，<br>差距在哪。',
    story: '只买入、不卖出；没有单笔反事实，报告保持简短。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 2,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '没有卖出行为，AI 不应虚构择时损失或规则候选。',
    },
    rows: [
      [70, 900002, 'buy', 200],
      [80, 900003, 'buy', 100],
    ],
  },
  {
    id: 'no_pattern',
    title: '无明显模式',
    tag: '行为不成立 · 无候选',
    headline: '没有模式，<br>也是一种结果。',
    story: '几笔交易都很普通，没有重复追高；报告不硬凑行为结论，也不给规则候选。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 3,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: 'AI 容易把普通交易描述成“习惯”；这里必须承认没有可识别模式。',
    },
    rows: [
      [75, 900002, 'buy', 100],
      [80, 900003, 'buy', 100],
      [90, 900002, 'sell', 100],
      [100, 900001, 'buy', 100],
      [100, 900003, 'sell', 100],
      [110, 900001, 'sell', 100],
    ],
  },
  {
    id: 'low_sample',
    title: '样本不足',
    tag: '证据不足 · 不下结论',
    headline: '只有一次，<br>先别下结论。',
    story: '只有一笔可评估买入，虽然命中追高条件，但没有达到最小重复数。',
    expectation: {
      behavior_status: '证据不足',
      sample_n: 1,
      evaluated_n: 1,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: '单次命中不是重复模式；AI 不得把 n=1 说成稳定行为。',
    },
    rows: [
      [60, 900001, 'buy', 100],
      [78, 900001, 'sell', 100],
    ],
  },
  {
    id: 'sell_rebuy',
    title: '卖后追回',
    tag: '行为不成立 · AI 观察点',
    headline: '卖了又追回，<br>引擎看不出来。',
    story: '卖出后两个交易日内又买回；现有引擎仍判为不成立，留给 AI 观察盲区。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 2,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: 'AI 可观察“卖后 2 个交易日内追回”；后端 P0 兜底不识别该模式。',
    },
    rows: [
      [70, 900002, 'buy', 200],
      [90, 900002, 'sell', 200],
      [92, 900002, 'buy', 100],
      [110, 900002, 'sell', 100],
    ],
  },
  {
    id: 'overtrading',
    title: '频繁交易',
    tag: '行为不成立 · 无模板',
    headline: '来回四次，<br>没有一条规则。',
    story: '四次完整往返、收益接近持平；AI 可能观察到频率，但现有模板给不出可执行推荐。',
    expectation: {
      behavior_status: '不成立',
      sample_n: 0,
      evaluated_n: 4,
      behavior_visible: false,
      candidate_visible: false,
      ai_blind_spot: 'AI 可观察交易频率偏高，但不得编造不存在的规则模板或买卖指令。',
    },
    rows: [
      [40, 900003, 'buy', 100],
      [45, 900003, 'sell', 100],
      [50, 900003, 'buy', 100],
      [55, 900003, 'sell', 100],
      [60, 900003, 'buy', 100],
      [65, 900003, 'sell', 100],
      [70, 900003, 'buy', 100],
      [75, 900003, 'sell', 100],
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
      },
    });
  }
  return marketCache.get(scenario.id);
}
