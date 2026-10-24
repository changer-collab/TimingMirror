#!/usr/bin/env node
/**
 * 操作类型归因 —— 离线单测（合成夹具；不调用行情/网络）
 *
 * 覆盖：7 类不重不漏且加总等于逐笔分解；同笔按优先级只归一类；
 *       5 日涨跌与持仓事实的判定；缺持仓证据回落其他；行为不可用或分解阻断时不分类。
 * 运行：node tests/operation-attribution.test.mjs（或 npm run check）
 */
import { buildOperationAttribution } from '../src/engine/operationAttribution.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const item = (tradeId, dragMoney) => ({ trade_id: tradeId, symbol: '000000', trade_date: '2024-09-27', quantity: 100, dragMoney });
const decomposition = (items, total, extra = {}) => ({
  items,
  total: { value: total, display: `¥${total.toFixed(2)}` },
  blocked: false,
  checks: { sum_equals_total: near(items.reduce((s, it) => s + it.dragMoney, 0), total) },
  ...extra,
});
const behavior = (patterns) => ({ available: true, reason: '', data: { patterns } });
const rebuy = (sellId) => ({ pattern_id: 'sell_rebuy_within_2d', evidence: [{ trade_id: 'B9', prior_trade_id: sellId }] });
const flip = (sellId) => ({ pattern_id: 'quick_flip', evidence: [{ trade_id: sellId, prior_trade_id: 'B9' }] });

/* ==== ① 三桶分类与加总 ==== */
{
  const d = decomposition([item('S1', 100), item('S2', 50), item('S3', -20)], 130);
  const r = buildOperationAttribution({ decomposition: d, behavior: behavior([rebuy('S1'), flip('S2')]) });
  const bucket = (id) => r.buckets.find((b) => b.id === id);
  check('归因：回补/快进快出/其他三桶笔数与金额正确', r.ok === true
    && bucket('rebuy').count === 1 && near(bucket('rebuy').money, 100)
    && bucket('quick_flip').count === 1 && near(bucket('quick_flip').money, 50)
    && bucket('other').count === 1 && near(bucket('other').money, -20), JSON.stringify(r.buckets));
  check('归因：三桶金额加总等于逐笔分解总额', r.ok === true
    && near(r.buckets.reduce((s, b) => s + b.money, 0), 130) && near(r.total.value, 130), JSON.stringify(r.total));
  check('归因：占比按组合总差额计算，不显示正号', r.ok === true
    && near(bucket('rebuy').share, 100 / 130) && near(bucket('other').share, -20 / 130)
    && bucket('rebuy').display.share === '76.9%', JSON.stringify(bucket('rebuy')));
  check('归因：口径说明不评价动机', r.ok === true && r.basis.includes('不是对动机的判断'), r.basis);
}

/* ==== ② 同一卖出命中两类：只归回补 ==== */
{
  const d = decomposition([item('S1', 100), item('S2', 30)], 130);
  const r = buildOperationAttribution({ decomposition: d, behavior: behavior([rebuy('S2'), flip('S2')]) });
  const bucket = (id) => r.buckets.find((b) => b.id === id);
  check('归因：同时命中回补与快进快出 → 只归回补，不重复计数', r.ok === true
    && bucket('rebuy').count === 1 && bucket('rebuy').trade_ids.includes('S2')
    && bucket('quick_flip').count === 0, JSON.stringify(r.buckets));
}

/* ==== ③ 行为证据缺失：不强行分类 ==== */
{
  const d = decomposition([item('S1', 100), item('S2', 30)], 130);
  const none = buildOperationAttribution({ decomposition: d, behavior: behavior([]) });
  const bucket = (r, id) => r.buckets.find((b) => b.id === id);
  check('归因：行为可用但无命中证据 → 全部归其他，不虚构类型', none.ok === true
    && bucket(none, 'other').count === 2 && near(bucket(none, 'other').money, 130)
    && bucket(none, 'rebuy').count === 0, JSON.stringify(none.buckets));

  const unavailable = buildOperationAttribution({ decomposition: d, behavior: { available: false, reason: '行为发现失败' } });
  check('归因：行为不可用 → ok=false 且不分类', unavailable.ok === false && /行为发现失败/.test(unavailable.reason), JSON.stringify(unavailable));
}

/* ==== ④ 分解阻断或加总不一致：不展示 ==== */
{
  const d = decomposition([item('S1', 100)], 100, { blocked: true });
  const blocked = buildOperationAttribution({ decomposition: d, behavior: behavior([rebuy('S1')]) });
  check('归因：逐笔分解阻断 → ok=false', blocked.ok === false && /校验/.test(blocked.reason), JSON.stringify(blocked));

  const broken = decomposition([item('S1', 100)], 130);
  broken.checks.sum_equals_total = false;
  const mismatch = buildOperationAttribution({ decomposition: broken, behavior: behavior([rebuy('S1')]) });
  check('归因：加总与总额不一致 → ok=false', mismatch.ok === false && /不一致/.test(mismatch.reason), JSON.stringify(mismatch));

  const missing = buildOperationAttribution({ decomposition: null, behavior: behavior([]) });
  check('归因：缺少逐笔分解 → ok=false', missing.ok === false, JSON.stringify(missing));
}

/* ==== ⑤ 7 类：5 日涨跌、清仓/减仓、缺持仓回落 ==== */
const DAYS = ['2024-09-02', '2024-09-03', '2024-09-04', '2024-09-05', '2024-09-06', '2024-09-09', '2024-09-10'];
const CLOSES = {
  '000000': { '2024-09-02': 10, '2024-09-09': 9.4 },
  '000001': { '2024-09-02': 10, '2024-09-09': 10.6 },
  '000002': { '2024-09-02': 10, '2024-09-09': 10.2 },
  '000003': { '2024-09-02': 10, '2024-09-09': 9.8 },
};
const market = {
  tradingDays: DAYS,
  resolveValuation: (date) => (DAYS.includes(date) ? { blocked: false, effective_date: date } : { blocked: true }),
  getClose: (symbol, date) => CLOSES[symbol]?.[date] ?? null,
};
const trade = (tradeId, symbol, side, quantity, line) => ({
  trade_id: tradeId, symbol, side, quantity, trade_date: '2024-09-10', source: { file: 'x.csv', line },
});
const buys = [
  trade('B1', '000000', 'buy', 100, 2), trade('B2', '000001', 'buy', 200, 3),
  trade('B3', '000002', 'buy', 100, 4), trade('B4', '000003', 'buy', 200, 5),
];
const sells = [
  trade('S1', '000000', 'sell', 100, 6), trade('S2', '000001', 'sell', 100, 7),
  trade('S3', '000002', 'sell', 100, 8), trade('S4', '000003', 'sell', 100, 9),
  trade('S5', '000004', 'sell', 100, 10),
];
const sellItem = (tradeId, symbol, dragMoney) => ({
  trade_id: tradeId, symbol, trade_date: '2024-09-10', quantity: 100, dragMoney,
});
{
  const items = [sellItem('S1', '000000', 100), sellItem('S2', '000001', 50), sellItem('S3', '000002', 30), sellItem('S4', '000003', 20), sellItem('S5', '000004', 10)];
  const r = buildOperationAttribution({
    decomposition: decomposition(items, 210),
    behavior: behavior([]),
    trades: [...buys, ...sells],
    market,
  });
  const bucket = (id) => r.buckets.find((b) => b.id === id);
  check('归因 v2：7 类桶齐全（含 0 笔）', r.ok === true && r.buckets.length === 7
    && r.buckets.map((b) => b.id).join(',') === 'rebuy,quick_flip,down,up,clear,trim,other', JSON.stringify(r.buckets.map((b) => [b.id, b.count])));
  check('归因 v2：下跌中/上涨中按 5 日收盘变化判定', bucket('down').trade_ids.join() === 'S1' && bucket('up').trade_ids.join() === 'S2'
    && Math.abs(r.by_trade.S1.evidence.change - (-0.06)) < 1e-9 && Math.abs(r.by_trade.S2.evidence.change - 0.06) < 1e-9, JSON.stringify(r.by_trade));
  check('归因 v2：涨跌未达阈值时按持仓归清仓/部分减仓', bucket('clear').trade_ids.join() === 'S3'
    && bucket('trim').trade_ids.join() === 'S4' && r.by_trade.S4.evidence.holding_after === 100, JSON.stringify(r.by_trade.S4));
  check('归因 v2：缺持仓证据（卖前无买入）回落其他', bucket('other').trade_ids.join() === 'S5'
    && r.by_trade.S5.evidence.kind === 'unknown', JSON.stringify(r.by_trade.S5));
  check('归因 v2：笔数与金额仍不重不漏', r.buckets.reduce((s, b) => s + b.count, 0) === items.length
    && near(r.buckets.reduce((s, b) => s + b.money, 0), 210), JSON.stringify(r.buckets.map((b) => [b.id, b.count, b.money])));
  check('归因 v2：阈值写在配置里（5 日 / 5%）', r.config.momentum_window_days === 5 && r.config.momentum_threshold === 0.05, JSON.stringify(r.config));
}

/* ==== ⑥ 优先级：回补 > 快进快出 > 涨跌 > 仓位 ==== */
{
  const base = { decomposition: decomposition([sellItem('S1', '000000', 100)], 100), trades: [...buys, ...sells], market };
  const rebuyHit = buildOperationAttribution({ ...base, behavior: behavior([rebuy('S1'), flip('S1')]) });
  check('归因 v2：回补优先于快进快出与下跌中', rebuyHit.buckets.find((b) => b.id === 'rebuy').count === 1
    && rebuyHit.buckets.find((b) => b.id === 'quick_flip').count === 0
    && rebuyHit.buckets.find((b) => b.id === 'down').count === 0, JSON.stringify(rebuyHit.by_trade.S1));
  const flipHit = buildOperationAttribution({ ...base, behavior: behavior([flip('S1')]) });
  check('归因 v2：快进快出优先于下跌中', flipHit.buckets.find((b) => b.id === 'quick_flip').count === 1
    && flipHit.buckets.find((b) => b.id === 'down').count === 0, JSON.stringify(flipHit.by_trade.S1));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
