// 演示用历史账单组：4 份已发布 + 1 份未发布，离线可跑跨账单同类操作检索。
// 边界：全部为冻结示例，scope=demo_group；不冒充云端账单，也不含真实账户数据。
import { buildHistoryIndex, refOf } from '../agent/historyIndex.js';

const PATTERNS = Object.freeze({
  chase_high_buy: '追高买入',
  sell_rebuy_within_2d: '卖出后两日内买回',
  quick_flip: '买入后三日内卖出',
  overtrading: '交易频率偏高',
});

function patternRows(list) {
  return list.map(([id, status, sampleN, evaluatedN]) => ({
    pattern_id: id,
    name: PATTERNS[id],
    status,
    sample_n: sampleN,
    evaluated_n: evaluatedN,
    min_samples: 3,
    rule: null,
  }));
}

function snapshotOf({ at, tradeCount, patterns, published = true }) {
  const latest = {
    profile_key: 'd3m0h1st',
    at,
    bill: { trade_count: tradeCount },
    behavior: { config_version: 'demo', scope: { trade_count: tradeCount }, patterns: patternRows(patterns) },
    review: { portfolio_published: published },
  };
  return {
    version: 2,
    at,
    profile_key: 'd3m0h1st',
    bill: { trade_count: tradeCount },
    review: { portfolio_published: published },
    profile: { latest },
    report: published ? { demo: true, portfolio: null } : null,
    report_available: published,
  };
}

const trade = (tradeDate, symbol, side) => ({
  trade_date: tradeDate, symbol, side, price: 10, quantity: 100, fee: 0, tax: 0,
});

const ENTRIES = Object.freeze([
  {
    ref: refOf('demo-history-1'),
    effective_date: '2026-09-30',
    snapshot: snapshotOf({
      at: '2026-09-30T10:00:00.000Z',
      tradeCount: 6,
      patterns: [
        ['sell_rebuy_within_2d', '成立', 2, 4],
        ['chase_high_buy', '成立', 3, 5],
      ],
    }),
    trades: [
      trade('2026-09-01', '600519', 'buy'),
      trade('2026-09-02', '600519', 'sell'),
      trade('2026-09-03', '600519', 'buy'),
      trade('2026-09-08', '000001', 'buy'),
      trade('2026-09-09', '000001', 'sell'),
      trade('2026-09-28', '300750', 'buy'),
    ],
  },
  {
    ref: refOf('demo-history-2'),
    effective_date: '2026-08-29',
    snapshot: snapshotOf({
      at: '2026-08-29T10:00:00.000Z',
      tradeCount: 4,
      patterns: [
        ['quick_flip', '成立', 2, 3],
        ['chase_high_buy', '成立', 1, 3],
      ],
    }),
    trades: [
      trade('2026-08-03', '000001', 'buy'),
      trade('2026-08-04', '000001', 'sell'),
      trade('2026-08-20', '600519', 'buy'),
      trade('2026-08-21', '600519', 'sell'),
    ],
  },
  {
    ref: refOf('demo-history-3'),
    effective_date: '2026-07-31',
    snapshot: snapshotOf({
      at: '2026-07-31T10:00:00.000Z',
      tradeCount: 5,
      patterns: [
        ['sell_rebuy_within_2d', '成立', 1, 3],
        ['overtrading', '不成立', 1, 3],
      ],
    }),
    trades: [
      trade('2026-07-06', '300750', 'buy'),
      trade('2026-07-07', '300750', 'sell'),
      trade('2026-07-08', '300750', 'buy'),
      trade('2026-07-20', '600519', 'buy'),
      trade('2026-07-24', '600519', 'sell'),
    ],
  },
  {
    ref: refOf('demo-history-4'),
    effective_date: '2026-06-30',
    snapshot: snapshotOf({
      at: '2026-06-30T10:00:00.000Z',
      tradeCount: 2,
      patterns: [
        ['chase_high_buy', '证据不足', 0, 2],
        ['quick_flip', '不成立', 0, 1],
      ],
    }),
    trades: [
      trade('2026-06-02', '000001', 'buy'),
      trade('2026-06-18', '000001', 'sell'),
    ],
  },
  {
    ref: refOf('demo-history-5'),
    effective_date: '2026-05-31',
    snapshot: snapshotOf({
      at: '2026-05-31T10:00:00.000Z',
      tradeCount: 3,
      published: false,
      patterns: [['chase_high_buy', '成立', 2, 3]],
    }),
    trades: [],
  },
]);

export const DEMO_HISTORY_INDEX = Object.freeze(buildHistoryIndex({
  entries: ENTRIES,
  synthetic: true,
  scope: 'demo_group',
}));

export function getDemoHistoryIndex() {
  return DEMO_HISTORY_INDEX;
}
