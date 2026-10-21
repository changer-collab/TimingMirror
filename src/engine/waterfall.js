// 收益瀑布（P0）—— 本金 → 买入不动收益 → 择时损耗 → 实际到手。
// 恒等式：buyCost + (ghostValue − buyCost) − dragMoney = actualValue。
// 边界：只重排 computeIndicators 已算出的组合数字，不引入新口径；标的自身涨幅是另一张卡，不混入本瀑布。
import { fmtMoney, fmtPct, fmtPP } from './display.js';

export const WATERFALL_FORMULA_TEXT = 'buyCost + (ghostValue − buyCost) − dragMoney = actualValue';

function nearlyEqual(a, b) {
  return Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(Math.round(a * 100) - Math.round(b * 100)) === 0;
}

export function buildReturnWaterfall({ report } = {}) {
  const p = report?.portfolio;
  if (!p || !Number.isFinite(p.buyCost) || !Number.isFinite(p.actualValue) || !Number.isFinite(p.ghostValue)) {
    throw new TypeError('buildReturnWaterfall：report.portfolio 缺少 buyCost/actualValue/ghostValue');
  }
  const ghostGain = p.ghostValue - p.buyCost;
  const actualGain = p.actualValue - p.buyCost;
  const dragLoss = p.dragMoney;
  const items = [
    {
      key: 'cost',
      label: '投入本金',
      kind: 'base',
      amount: p.buyCost,
      bar_start: 0,
      bar_end: p.buyCost,
      cumulative: p.buyCost,
      display: { amount: fmtMoney(p.buyCost), ratio: '100%' },
      note: '按买入成交价汇总，不含费用税费',
    },
    {
      key: 'ghost_gain',
      label: '买入不动收益',
      kind: ghostGain >= 0 ? 'gain' : 'loss',
      amount: ghostGain,
      bar_start: p.buyCost,
      bar_end: p.ghostValue,
      cumulative: p.ghostValue,
      display: { amount: fmtMoney(ghostGain), ratio: fmtPct(p.ghostRet) },
      note: '同样的钱、同样的股数，买入后不动的对照收益',
    },
    {
      key: 'drag',
      label: dragLoss >= 0 ? '择时损耗' : '择时改善',
      kind: dragLoss >= 0 ? 'loss' : 'gain',
      amount: -dragLoss,
      bar_start: p.actualValue,
      bar_end: p.ghostValue,
      cumulative: p.actualValue,
      display: { amount: fmtMoney(dragLoss), ratio: fmtPP(p.drag) },
      note: dragLoss >= 0
        ? '对照 − 实际；正数表示操作相对买入不动少拿到的金额'
        : '负值表示实际结果优于买入不动；这里按“改善”展示',
    },
    {
      key: 'actual',
      label: '实际到手收益',
      kind: 'total',
      amount: actualGain,
      bar_start: 0,
      bar_end: p.actualValue,
      cumulative: p.actualValue,
      display: { amount: fmtMoney(actualGain), ratio: fmtPct(p.actualRet) },
      note: '已复核的组合结果',
    },
  ];
  const scaleMax = Math.max(p.buyCost, p.ghostValue, p.actualValue, 0);
  const scaleMin = Math.min(p.buyCost, p.ghostValue, p.actualValue, 0);
  const identityOk = nearlyEqual(p.buyCost + ghostGain - dragLoss, p.actualValue);
  return {
    items,
    scale: { min: scaleMin, max: scaleMax },
    total: {
      buy_cost: p.buyCost,
      ghost_value: p.ghostValue,
      actual_value: p.actualValue,
      drag_money: dragLoss,
      display: { ghost_value: fmtMoney(p.ghostValue), actual_value: fmtMoney(p.actualValue) },
    },
    checks: { identity_ok: identityOk },
    formula_text: WATERFALL_FORMULA_TEXT,
    notes: [
      '“买入不动收益”按你的实际买入价与股数计算，不是标的自身涨幅；标的自身涨幅另卡展示。',
      '瀑布只重排已复核的组合数字，不重新计算行情或收益率。',
      '费用与税费未纳入现有指标口径；瀑布沿用同一口径。',
    ],
  };
}
