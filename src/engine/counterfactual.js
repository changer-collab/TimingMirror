// M1-C4 单笔反事实（S1 主口径：「假如这笔没卖」）—— 对齐 m0/calc-baseline case-2 与 schema.candidate.json（CALC_CF_REPLACE_SELL_V1 / SIG-3）。
// 边界：单标的账单作用域——trades 含非 symbol 标的一律抛错（多标的的补救%基数未定义，候选问题待三方定夺；不静默混算）；
//       替换按原卖出价/量与估值日不复权 close 重算，不引入假设价格；不改写其他成交（输入不被修改）。
// S3 买入侧/早卖替换需要假设执行价（C1 未定）→ 明确抛错。
// B5：v1 不支持股数事件——替换路径的持有区间内不得含送转/拆合股事件（依赖缓存侧保证，清单签收时约定）。
// 序列（T1-12 单笔反事实曲线，供 UI 夹具渲染）：逐交易日 { actual, ghost, cf, gap }；
//       gap＝红缺口＝cf − actual（对照−实际口径，F-2；正＝替换可挽回）；缺价日不回落（B4）：各值为 null 并计入 missing_dates。

import { fmtMoney, fmtPct, fmtPP } from './display.js';
import { sortTrades } from './indicators.js';

// 反事实输出数字的 formula_id 映射（衍生数字按其基准公式挂靠；候选结构，待接口冻结）
export const CF_FORMULA_IDS = Object.freeze({
  cfSellProceeds: 'CALC_SELL_PROCEEDS_V1',
  cfHeldShares: 'CALC_HELD_SHARES_V1',
  cfValue: 'CALC_CF_REPLACE_SELL_V1',
  cfRet: 'CALC_RET_V1',
  recoveredMoney: 'CALC_CF_REPLACE_SELL_V1',
  recoveredPP: 'CALC_DRAG_PP_V1',
  remainingDragMoney: 'CALC_DRAG_MONEY_V1',
});

/**
 * @param {object} p
 * @param {string} p.symbol 标的（单标的账单）
 * @param {Array} p.trades 标准化交易（trade_id/side/price/quantity/trade_date）
 * @param {string} p.tradeId 被替换的卖出笔
 * @param {string} p.effectiveDate 估值日（由 M1-C1 解析）
 * @param {(date: string) => number|null} p.closeOf 该标的不复权逐日 close（缺价返回 null，不回落 B4）
 * @param {string[]} p.tradingDays 交易日历（序列枚举用）
 */
export function replaceSell({ symbol, trades, tradeId, effectiveDate, closeOf, tradingDays }) {
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('replaceSell：trades 为空');
  if (!Array.isArray(tradingDays) || !tradingDays.includes(effectiveDate)) throw new TypeError(`估值日不在交易日历：${effectiveDate}`);
  const sorted = sortTrades(trades);
  // 兼容两种输入形状：产品标准化交易带 t.symbol；m0 夹具交易不带（标的由本函数 symbol 参数声明）。
  // 仅当明确带出其他标的时拒绝——防止多标的账单被静默混算（补救%基数未定义，候选问题待三方定夺）。
  const foreign = sorted.find((t) => t.symbol !== undefined && t.symbol !== symbol);
  if (foreign) {
    throw new TypeError(`replaceSell：多标的账单的补救%基数未定义（候选问题，待三方定夺）——仅接受单标的 trades，请先按 symbol 过滤（发现 ${foreign.symbol}，trade_id ${foreign.trade_id}）`);
  }
  const replaced = sorted.find((t) => t.trade_id === tradeId);
  if (!replaced) throw new TypeError(`找不到交易：${tradeId}`);
  if (replaced.side !== 'sell') throw new TypeError(`S1 仅支持替换卖出笔（买入侧替换 S3 需假设执行价，C1 未定，v1 未定义）：${tradeId}`);

  const closeEff = closeOf(effectiveDate);
  if (!Number.isFinite(closeEff)) throw new TypeError(`估值日 ${effectiveDate} 缺价（不回落 B4）`);

  let buyCost = 0; let sellProceeds = 0; let boughtQty = 0; let soldQty = 0;
  for (const t of sorted) {
    if (t.side === 'buy') { buyCost += t.price * t.quantity; boughtQty += t.quantity; }
    else { sellProceeds += t.price * t.quantity; soldQty += t.quantity; }
  }
  const heldShares = boughtQty - soldQty;
  const actualValue = sellProceeds + heldShares * closeEff;
  const ghostValue = boughtQty * closeEff;
  const actualRet = actualValue / buyCost - 1;

  const replacedAmount = replaced.price * replaced.quantity;
  const cfSellProceeds = sellProceeds - replacedAmount;
  const cfHeldShares = heldShares + replaced.quantity;
  const cfValue = cfSellProceeds + cfHeldShares * closeEff;
  const cfRet = cfValue / buyCost - 1;
  const recoveredMoney = cfValue - actualValue;
  const recoveredPP = recoveredMoney / buyCost;
  const remainingDragMoney = ghostValue - cfValue;

  const start = sorted[0].trade_date;
  const window = tradingDays.filter((d) => d >= start && d <= effectiveDate);
  if (window.length === 0) throw new TypeError(`估值日 ${effectiveDate} 早于首笔交易日 ${start}`);

  const points = []; const missingDates = [];
  let bQty = 0; let sQty = 0; let sProceeds = 0; let idx = 0; let replacedApplied = false;
  for (const d of window) {
    while (idx < sorted.length && sorted[idx].trade_date <= d) {
      const t = sorted[idx];
      if (t.side === 'buy') bQty += t.quantity;
      else { sQty += t.quantity; sProceeds += t.price * t.quantity; if (t.trade_id === tradeId) replacedApplied = true; }
      idx++;
    }
    const close = closeOf(d);
    if (!Number.isFinite(close)) {
      missingDates.push(d);
      points.push({ date: d, close: null, actual: null, ghost: null, cf: null, gap: null });
      continue;
    }
    const held = bQty - sQty;
    const actual = sProceeds + held * close;
    const ghost = bQty * close;
    const cf = replacedApplied ? (sProceeds - replacedAmount + (held + replaced.quantity) * close) : actual;
    points.push({ date: d, close, actual, ghost, cf, gap: cf - actual });
  }

  return {
    scope: symbol,
    replace: {
      replaced: { trade_id: replaced.trade_id, trade_date: replaced.trade_date, price: replaced.price, quantity: replaced.quantity },
      buyCost, actualValue, actualRet, ghostValue,
      cf_sellProceeds: cfSellProceeds, cf_heldShares: cfHeldShares, cfValue, cfRet,
      recoveredMoney, recoveredPP, remainingDragMoney,
      display: {
        cfValue: fmtMoney(cfValue),
        cfRet: fmtPct(cfRet),
        recoveredPP: fmtPP(recoveredPP),
        remainingDragMoney: fmtMoney(remainingDragMoney),
      },
      formula_ids: CF_FORMULA_IDS,
    },
    series: {
      start, end: effectiveDate,
      complete: missingDates.length === 0,
      missing_dates: missingDates,
      points,
    },
  };
}

// 路径区间：同一笔卖出持有到不同交易日，差额（cf − actual）的最小/最大落点；不是概率预测。
export function pathRangeOf(counterfactual) {
  const sellDate = counterfactual?.replace?.replaced?.trade_date ?? counterfactual?.trade_date;
  const points = Array.isArray(counterfactual?.series?.points) ? counterfactual.series.points : [];
  const usable = points.filter((p) => (!sellDate || p.date >= sellDate) && Number.isFinite(p.gap));
  if (usable.length < 2) return null;
  let low = usable[0];
  let high = usable[0];
  for (const p of usable) {
    if (p.gap < low.gap) low = p;
    if (p.gap > high.gap) high = p;
  }
  return {
    low: { date: low.date, gap: low.gap },
    high: { date: high.date, gap: high.gap },
    flat: Math.abs(high.gap - low.gap) < 0.005,
    points: usable.length,
  };
}
