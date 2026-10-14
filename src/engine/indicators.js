// M1-C3 计算引擎 —— 实际/幽灵/损耗三指标（单标的与组合）；对齐 m0/calc-baseline/schema.candidate.json 候选 v1（frozen:false）。
// 边界：纯函数、零依赖、数据源无关——估值日不复权 close 由调用方经行情缓存解析后传入（M1-C1），
//       合成夹具与真实缓存同走本模块，数据源替换不改公式（停止条件：真实缓存未就绪 → 合成缓存跑通引擎）。
// 口径：Q1 费用/税费只记录并标注、不入公式；Q2 分红未计入；F-2 损耗＝对照−实际、display 字符串由本层生成；
//       B3/B4 估值日解析与缺价阻断属行情缓存（M1-C1），本模块不回落、缺价直接拒绝。
// 双路径（附A.2）：dragMoney = 逐笔卖出重放 vs 聚合公式（ghost−actual）；ghostValue = 买入批次累计 vs 总量×close。
//       两路径随结果以 dual_path 输出，供独立复核（M1-C7）编排消费；恒等式①②③④在 tests/indicators.test.mjs 断言。
// 不在本模块：单笔反事实（M1-C4）、复核编排与 provenance steps（M1-C7/C8，消费本模块 formula_ids 映射）。

import { fmtMoney, fmtPct, fmtPP } from './display.js';

// 公式注册表（formula_text 逐字引自 m0/calc-baseline/schema.candidate.json「formulas」；供复核/provenance 消费）
export const CALC_FORMULAS = Object.freeze({
  CALC_BUY_COST_V1: { formula_id: 'CALC_BUY_COST_V1', formula_text: 'buyCost = Σ 买入(quantity × price)', unit: '元', status: '候选' },
  CALC_SELL_PROCEEDS_V1: { formula_id: 'CALC_SELL_PROCEEDS_V1', formula_text: 'sellProceeds = Σ 卖出(quantity × price)', unit: '元', status: '候选' },
  CALC_HELD_SHARES_V1: { formula_id: 'CALC_HELD_SHARES_V1', formula_text: 'heldShares = Σ 买入 quantity − Σ 卖出 quantity（≥ 0，O3 保证）', unit: '股', status: '候选' },
  CALC_ACTUAL_VALUE_V1: { formula_id: 'CALC_ACTUAL_VALUE_V1', formula_text: 'actualValue = sellProceeds + heldShares × close(effective_date)', unit: '元', status: '候选' },
  CALC_GHOST_VALUE_V1: { formula_id: 'CALC_GHOST_VALUE_V1', formula_text: 'ghostValue = Σ 买入 quantity × close(effective_date)', unit: '元', status: '候选' },
  CALC_RET_V1: { formula_id: 'CALC_RET_V1', formula_text: 'actualRet = actualValue / buyCost − 1；ghostRet = ghostValue / buyCost − 1', unit: '无量纲（展示 %，1 位小数）', status: '候选' },
  CALC_DRAG_MONEY_V1: { formula_id: 'CALC_DRAG_MONEY_V1', formula_text: 'dragMoney = ghostValue − actualValue', unit: '元（展示 2 位小数＋千分位）', status: '候选' },
  CALC_DRAG_PP_V1: { formula_id: 'CALC_DRAG_PP_V1', formula_text: 'drag = ghostRet − actualRet（＝ dragMoney / buyCost）；正＝相对损耗，负＝实际优于对照', unit: 'pp（展示 1 位小数）', status: '候选' },
  CALC_CF_REPLACE_SELL_V1: { formula_id: 'CALC_CF_REPLACE_SELL_V1', formula_text: '单笔替换：actualValue_cf = (sellProceeds − 被替换笔金额) + (heldShares + 被替换笔股数) × close(effective_date)', unit: '元', status: '候选（S1）' },
});

// §4-3：每个数字须带 formula_id 与 display 字段（provenance 由 changer 编排消费，M1-C7/C8）
export const INDICATOR_FORMULA_IDS = Object.freeze({
  buyCost: 'CALC_BUY_COST_V1',
  sellProceeds: 'CALC_SELL_PROCEEDS_V1',
  heldShares: 'CALC_HELD_SHARES_V1',
  actualValue: 'CALC_ACTUAL_VALUE_V1',
  ghostValue: 'CALC_GHOST_VALUE_V1',
  actualRet: 'CALC_RET_V1',
  ghostRet: 'CALC_RET_V1',
  dragMoney: 'CALC_DRAG_MONEY_V1',
  drag: 'CALC_DRAG_PP_V1',
});

// 组合层不汇总个股股数，故不含 heldShares
export const PORTFOLIO_FORMULA_IDS = Object.freeze(
  Object.fromEntries(Object.entries(INDICATOR_FORMULA_IDS).filter(([k]) => k !== 'heldShares')),
);

// 结果口径标注（确认项：Q1/Q2；“未计入滑点”为【建议】待负责人确认，C2 未定，故未置于此）
export const RESULT_LABELS = Object.freeze({
  fees_taxes: '未计入费用、税费（Q1）',
  dividend: '分红未计入（Q2）',
});

// 双路径一致性容差（候选值；正式复核容差未冻结——m0/calc-baseline open_items C4）
const DUAL_PATH_REL_TOL = 1e-9;

function dualPath(pathA, pathB) {
  const diff = pathA - pathB;
  const tol = DUAL_PATH_REL_TOL * Math.max(1, Math.abs(pathA), Math.abs(pathB));
  return { path_a: pathA, path_b: pathB, diff, tol, consistent: Math.abs(diff) <= tol };
}

// 规范顺序：按 trade_date 升序、同日按原始下标稳定（Q7 候选；反事实逐日重放共用同一顺序）
export function sortTrades(trades) {
  return trades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.trade_date < b.t.trade_date ? -1 : a.t.trade_date > b.t.trade_date ? 1 : a.i - b.i))
    .map((x) => x.t);
}

function computeOne(symbol, list, close) {
  let buyCost = 0; let sellProceeds = 0; let boughtQty = 0; let soldQty = 0;
  let ghostBatchAccum = 0; let dragSellReplay = 0;
  let feeSum = 0; let taxSum = 0;
  const feeMissing = []; const taxMissing = []; const dragLines = [];
  for (const t of list) {
    if (t.side === 'buy') {
      buyCost += t.price * t.quantity;
      boughtQty += t.quantity;
      ghostBatchAccum += t.quantity * close; // 双路径 P-A：买入批次累计
    } else {
      sellProceeds += t.price * t.quantity;
      soldQty += t.quantity;
      const dragMoney = t.quantity * (close - t.price); // 双路径 P-A：逐笔卖出重放（恒等式①的逐笔项）
      dragSellReplay += dragMoney;
      dragLines.push({ trade_id: t.trade_id, trade_date: t.trade_date, quantity: t.quantity, price: t.price, close, dragMoney });
    }
    if (t.fee_missing === true || !Number.isFinite(t.fee)) feeMissing.push(t.trade_id); else feeSum += t.fee;
    if (t.tax_missing === true || !Number.isFinite(t.tax)) taxMissing.push(t.trade_id); else taxSum += t.tax;
  }
  if (buyCost === 0) throw new TypeError(`${symbol} 无买入交易（buyCost=0），无法计算收益率`);

  const heldShares = boughtQty - soldQty;
  const actualValue = sellProceeds + heldShares * close; // 双路径 P-B：聚合公式
  const ghostValue = boughtQty * close; // 双路径 P-B：直接乘积
  const actualRet = actualValue / buyCost - 1;
  const ghostRet = ghostValue / buyCost - 1;
  const dragMoney = ghostValue - actualValue;
  const drag = ghostRet - actualRet;

  return {
    symbol,
    buyCost, sellProceeds, heldShares, actualValue, ghostValue,
    actualRet, ghostRet, dragMoney, drag,
    display: {
      buyCost: fmtMoney(buyCost), actualValue: fmtMoney(actualValue), ghostValue: fmtMoney(ghostValue),
      actualRet: fmtPct(actualRet), ghostRet: fmtPct(ghostRet),
      dragMoney: fmtMoney(dragMoney), drag: fmtPP(drag),
    },
    formula_ids: INDICATOR_FORMULA_IDS,
    recorded: { fee_recorded_sum: feeSum, tax_recorded_sum: taxSum, fee_missing_lines: feeMissing, tax_missing_lines: taxMissing },
    drag_lines: dragLines,
    dual_path: {
      dragMoney: dualPath(dragSellReplay, dragMoney),
      ghostValue: dualPath(ghostBatchAccum, ghostValue),
    },
  };
}

function aggregate(stocks) {
  const sum = (k) => stocks.reduce((s, x) => s + x[k], 0);
  const buyCost = sum('buyCost'); const sellProceeds = sum('sellProceeds');
  const actualValue = sum('actualValue'); const ghostValue = sum('ghostValue');
  const actualRet = actualValue / buyCost - 1;
  const ghostRet = ghostValue / buyCost - 1;
  const dragMoney = ghostValue - actualValue;
  const drag = ghostRet - actualRet;
  return {
    buyCost, sellProceeds, actualValue, ghostValue,
    actualRet, ghostRet, dragMoney, drag,
    display: {
      buyCost: fmtMoney(buyCost), actualValue: fmtMoney(actualValue), ghostValue: fmtMoney(ghostValue),
      actualRet: fmtPct(actualRet), ghostRet: fmtPct(ghostRet),
      dragMoney: fmtMoney(dragMoney), drag: fmtPP(drag),
    },
    formula_ids: PORTFOLIO_FORMULA_IDS,
    recorded: {
      fee_recorded_sum: stocks.reduce((s, x) => s + x.recorded.fee_recorded_sum, 0),
      tax_recorded_sum: stocks.reduce((s, x) => s + x.recorded.tax_recorded_sum, 0),
      fee_missing_lines: stocks.flatMap((x) => x.recorded.fee_missing_lines),
      tax_missing_lines: stocks.flatMap((x) => x.recorded.tax_missing_lines),
    },
    dual_path: {
      dragMoney: dualPath(stocks.reduce((s, x) => s + x.dual_path.dragMoney.path_a, 0), dragMoney),
      ghostValue: dualPath(stocks.reduce((s, x) => s + x.dual_path.ghostValue.path_a, 0), ghostValue),
    },
  };
}

/**
 * 计算单标的与组合三指标。closes 为各标的估值日（effective_date）不复权 close，由调用方解析（M1-C1）；
 * 缺价不回落（B4）：closes 缺少成交中出现过的标的时抛错，由调用方在阻断提示后不调用本模块。
 */
export function computeIndicators({ trades, closes }) {
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('computeIndicators：trades 为空，无计算输入');
  const sorted = sortTrades(trades);
  const bySymbol = new Map();
  for (const t of sorted) {
    if (t.side !== 'buy' && t.side !== 'sell') throw new TypeError(`未知方向：${t.side}（仅支持 buy/sell）`);
    if (!Number.isFinite(closes?.[t.symbol])) throw new TypeError(`缺少 ${t.symbol} 的 close（缺价不回落 B4；调用方须先经行情缓存解析）`);
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  }
  const per_stock = {};
  for (const [sym, list] of bySymbol) per_stock[sym] = computeOne(sym, list, closes[sym]);
  return { per_stock, portfolio: aggregate(Object.values(per_stock)) };
}
