// 标的自身涨幅（候选补充口径）—— 把“选股”和“择时”分开看：
//   stockRet = close(估值日) / close(首次买入日) − 1；组合按各标的买入成本加权。
// 边界：只做价格涨幅，不含费用、税费、分红与仓位变化；未进入 runReview 发布链路，
//       页面必须标注“候选补充口径”，不得与已复核的 actual/ghost/drag 混写。
import { fmtPct } from './display.js';
import { sortTrades } from './indicators.js';

export const STOCK_SELF_FORMULA = Object.freeze({
  formula_id: 'CANDIDATE_STOCK_SELF_V1',
  formula_text: 'stockRet = close(估值日) / close(首次买入日) − 1；组合 = Σ(buyCost_i × stockRet_i) / Σ(buyCost_i)',
  status: '候选（补充口径，未进入复核发布）',
  notes: Object.freeze([
    '首次买入日取该标的第一笔买入的成交日，起点价格取该日收盘价（不复权），不是成交价。',
    '组合按各标的买入成本加权；费用、税费、分红与卖出后的现金不再投资收益，均不纳入。',
    '该口径回答“这些标的从你第一次买入到现在本身涨了多少”，不等于“买入不动”（后者按你的实际买入价与股数计算）。',
  ]),
});

function groupBuys(trades) {
  const bySymbol = new Map();
  for (const t of sortTrades(trades)) {
    if (t.side !== 'buy') continue;
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  }
  return bySymbol;
}

export function computeStockSelf({ trades, closeOf, resolveDate, valuationDate } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('computeStockSelf：trades 为空');
  if (typeof closeOf !== 'function') throw new TypeError('computeStockSelf：closeOf 必须为函数');
  if (typeof resolveDate !== 'function') throw new TypeError('computeStockSelf：resolveDate 必须为函数');
  if (typeof valuationDate !== 'string' || !valuationDate) throw new TypeError('computeStockSelf：valuationDate 缺失');

  const groups = groupBuys(trades);
  const perSymbol = [];
  for (const [symbol, buys] of groups) {
    const first = buys[0];
    const buyCost = buys.reduce((sum, t) => sum + t.price * t.quantity, 0);
    const base = {
      symbol,
      first_buy_date: first.trade_date,
      buy_cost: buyCost,
      available: false,
      ret: null,
      start_date: null,
      start_close: null,
      valuation_close: null,
      display: { ret: '—' },
      reason: null,
    };
    let resolved;
    try {
      resolved = resolveDate(first.trade_date);
    } catch (e) {
      perSymbol.push({ ...base, reason: `首次买入日无法解析：${String(e && e.message ? e.message : e)}` });
      continue;
    }
    if (!resolved || resolved.blocked) {
      perSymbol.push({ ...base, reason: `首次买入日 ${first.trade_date} 无可解析估值日（${resolved?.code ?? 'UNKNOWN'}）` });
      continue;
    }
    const startDate = resolved.effective_date;
    const startClose = closeOf(symbol, startDate);
    const valuationClose = closeOf(symbol, valuationDate);
    if (!Number.isFinite(startClose) || !Number.isFinite(valuationClose)) {
      perSymbol.push({
        ...base,
        start_date: startDate,
        start_close: Number.isFinite(startClose) ? startClose : null,
        valuation_close: Number.isFinite(valuationClose) ? valuationClose : null,
        reason: `缺价：${!Number.isFinite(startClose) ? `首次买入日 ${startDate}` : `估值日 ${valuationDate}`}（不回落其他日期）`,
      });
      continue;
    }
    const ret = valuationClose / startClose - 1;
    perSymbol.push({
      ...base,
      available: true,
      ret,
      start_date: startDate,
      start_close: startClose,
      valuation_close: valuationClose,
      display: { ret: fmtPct(ret) },
    });
  }
  perSymbol.sort((a, b) => (b.buy_cost - a.buy_cost) || (a.symbol < b.symbol ? -1 : 1));

  const totalBuyCost = perSymbol.reduce((s, x) => s + x.buy_cost, 0);
  const coveredBuyCost = perSymbol.filter((x) => x.available).reduce((s, x) => s + x.buy_cost, 0);
  const complete = perSymbol.length > 0 && perSymbol.every((x) => x.available);
  const ret = complete
    ? perSymbol.reduce((s, x) => s + x.ret * x.buy_cost, 0) / totalBuyCost
    : null;
  const unavailable = perSymbol.filter((x) => !x.available);

  return {
    status: perSymbol.length === 0 ? 'unavailable' : complete ? 'complete' : 'partial',
    available: coveredBuyCost > 0,
    ret,
    display: { ret: ret === null ? '—' : fmtPct(ret) },
    per_symbol: perSymbol,
    coverage: {
      total_buy_cost: totalBuyCost,
      covered_buy_cost: coveredBuyCost,
      ratio: totalBuyCost === 0 ? null : coveredBuyCost / totalBuyCost,
      complete,
    },
    formula: STOCK_SELF_FORMULA,
    reasons: unavailable.map((x) => `${x.symbol}：${x.reason}`),
  };
}
