// PGR/PLR 处置效应（Odean 1998；P1）—— 候选补充口径。
//   PGR = 已实现盈利卖出笔数 / (已实现盈利卖出笔数 + 纸面盈利持仓数)
//   PLR = 已实现亏损卖出笔数 / (已实现亏损卖出笔数 + 纸面亏损持仓数)
//   DE  = PGR − PLR
// 判盈亏基准：卖出价 vs 移动加权平均买入成本；纸面盈亏按估值日持仓与收盘价。
// 边界：按“笔数/持仓数”计数，不是金额加权；不含费用税费与分红；同一标的多笔卖出各计一笔；
//       零盈亏不计入任何一边。该结果未进入 runReview 发布链路，页面须标注候选补充口径。
import { sortTrades } from './indicators.js';

export const PGR_BENCHMARKS = Object.freeze({
  cn: Object.freeze({ value: 1.64, label: '中国散户均值约 1.64', source: 'Feng & Seasholes (2005)' }),
  us: Object.freeze({ value: 1.51, label: '美国投资者均值约 1.51', source: 'Odean (1998)' }),
});

export const PGR_CODES = Object.freeze({
  OVERSOLD: 'E_PGR_OVERSOLD',
  MISSING_CLOSE: 'E_PGR_MISSING_CLOSE',
});

const fmtRatio = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const counts = () => ({ gain: 0, loss: 0, flat: 0, total: 0 });

export function computePGR({ trades, closes } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('computePGR：trades 为空');
  if (!closes || typeof closes !== 'object') throw new TypeError('computePGR：closes 缺失');

  const positions = new Map();
  const errors = [];
  const realized = counts();
  for (const t of sortTrades(trades)) {
    if (!positions.has(t.symbol)) positions.set(t.symbol, { quantity: 0, cost: 0 });
    const pos = positions.get(t.symbol);
    if (t.side === 'buy') {
      pos.quantity += t.quantity;
      pos.cost += t.price * t.quantity;
      continue;
    }
    if (t.side !== 'sell') {
      errors.push({ code: PGR_CODES.OVERSOLD, message: `未知方向 ${t.side}（${t.trade_id}）` });
      continue;
    }
    if (pos.quantity <= 0 || t.quantity > pos.quantity + 1e-9) {
      errors.push({
        code: PGR_CODES.OVERSOLD,
        message: `卖出 ${t.trade_id}（${t.symbol} ${t.quantity} 股）超过当时持仓 ${pos.quantity} 股：账单不完整或顺序异常，PGR/PLR 不发布`,
      });
      continue;
    }
    const avgCost = pos.cost / pos.quantity;
    const profit = (t.price - avgCost) * t.quantity;
    realized.total += 1;
    if (profit > 0) realized.gain += 1;
    else if (profit < 0) realized.loss += 1;
    else realized.flat += 1;
    pos.quantity -= t.quantity;
    pos.cost -= avgCost * t.quantity;
    if (Math.abs(pos.quantity) < 1e-9) {
      pos.quantity = 0;
      pos.cost = 0;
    }
  }

  const paper = counts();
  for (const [symbol, pos] of positions) {
    if (pos.quantity <= 0) continue;
    const close = closes[symbol];
    if (!Number.isFinite(close)) {
      errors.push({ code: PGR_CODES.MISSING_CLOSE, message: `持仓 ${symbol} 在估值日缺价：纸面盈亏无法计数，PGR/PLR 不发布` });
      continue;
    }
    const avgCost = pos.cost / pos.quantity;
    const profit = (close - avgCost) * pos.quantity;
    paper.total += 1;
    if (profit > 0) paper.gain += 1;
    else if (profit < 0) paper.loss += 1;
    else paper.flat += 1;
  }

  const realizedGainDen = realized.gain + paper.gain;
  const realizedLossDen = realized.loss + paper.loss;
  const blocked = errors.length > 0;
  const pgr = !blocked && realizedGainDen > 0 ? realized.gain / realizedGainDen : null;
  const plr = !blocked && realizedLossDen > 0 ? realized.loss / realizedLossDen : null;
  const de = pgr !== null && plr !== null ? pgr - plr : null;
  const ok = !blocked;
  return {
    ok,
    status: ok ? (pgr === null && plr === null ? 'insufficient' : 'ok') : 'blocked',
    pgr,
    plr,
    de,
    counts: { realized, paper },
    display: { pgr: fmtRatio(pgr), plr: fmtRatio(plr), de: fmtRatio(de) },
    benchmarks: PGR_BENCHMARKS,
    errors,
    notes: [
      '按卖出笔数与持仓数计数，不是金额加权；同一标的多笔卖出各计一笔。',
      '判盈亏基准为卖出价/估值日收盘价 vs 移动加权平均买入成本；零盈亏不计入任何一边。',
      '不含费用、税费与分红；结果仅描述当前账单区间，不预测未来。',
      'PGR/PLR 为候选补充口径，未进入复核发布链路。',
    ],
  };
}
