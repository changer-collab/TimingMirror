// M2-C1 数据侧（二）OUTPUT01 损耗分解（T1-13）—— 占比条数据：总量=工具、主要矛盾=推理。
// 输入：computeIndicators 结果（drag_lines 为逐笔卖出重放项）＋原始标准化交易（取 source 供回源）。
// 输出：{ total, items[], by_symbol[], checks, blocked, errors[], notes[] }。
// 口径：损耗全部来自卖出笔（dragMoney = Σ卖出 quantity×(close−price)，恒等式① ID-1）；
//       单笔占比 = 该项 dragMoney / 组合总损耗（带符号；含负项时单项可为负或绝对值超 100%，属预期）；
//       金额比较统一舍入到分；source 悬空或加总不符 → blocked（不发布，与 A.2/A.4 联动）。
// 边界：本模块只保证「可加总 + 可回原成交 + 确定性排序（候选展示序）」；
//       “主要矛盾”的语义定位属推理层引用本分解，数字不得重算或改写（F-2）。

import { fmtMoney, fmtPct } from './display.js';
import { CALC_FORMULAS } from './indicators.js';

export const DECOMPOSE_CODES = Object.freeze({
  SUM_MISMATCH: 'E_DECOMPOSE_SUM_MISMATCH',
  SOURCE_DANGLING: 'E_DECOMPOSE_SOURCE_DANGLING',
});

const moneyEqual = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(Math.round(a * 100) - Math.round(b * 100)) === 0;

const shareOf = (v, total) => (total === 0 ? null : v / total);
const shareDisplay = (s) => (s === null ? '—' : fmtPct(s));

export function buildDragDecomposition({ report, trades }) {
  if (!report?.per_stock || !report?.portfolio) throw new TypeError('buildDragDecomposition：report 须为 computeIndicators 结果');
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('buildDragDecomposition：trades 为空');

  const tradeIndex = new Map(trades.map((t) => [t.trade_id, t]));
  const errors = [];
  const items = [];
  const by_symbol = [];

  for (const [sym, entry] of Object.entries(report.per_stock)) {
    let lineSum = 0;
    for (const line of entry.drag_lines ?? []) {
      const t = tradeIndex.get(line.trade_id);
      const resolved = Boolean(t?.source?.file) && Number.isFinite(t?.source?.line);
      if (!resolved) {
        errors.push({ code: DECOMPOSE_CODES.SOURCE_DANGLING, scope: sym, trade_id: line.trade_id, message: `分解项 ${line.trade_id} 源行不可定位（T1-13 占比可回原成交；不发布）` });
      }
      lineSum += line.dragMoney;
      items.push({
        trade_id: line.trade_id,
        trade_date: line.trade_date,
        symbol: sym,
        side: 'sell',
        quantity: line.quantity,
        price: line.price,
        close: line.close,
        dragMoney: line.dragMoney,
        display: { dragMoney: fmtMoney(line.dragMoney), share: null },
        share: null,
        source: resolved ? { file: t.source.file, line: t.source.line } : null,
        source_resolved: resolved,
      });
    }
    const ok = moneyEqual(lineSum, entry.dragMoney);
    if (!ok) errors.push({ code: DECOMPOSE_CODES.SUM_MISMATCH, scope: sym, message: `${sym} 逐笔加总 ${lineSum} ≠ 总损耗 ${entry.dragMoney}（恒等式 ID-1 破坏；不发布）` });
    by_symbol.push({
      symbol: sym,
      dragMoney: entry.dragMoney,
      display: { dragMoney: fmtMoney(entry.dragMoney), share: null },
      share: null,
      line_count: (entry.drag_lines ?? []).length,
      sum_lines: lineSum,
      sum_ok: ok,
    });
  }

  const total = report.portfolio.dragMoney;
  for (const it of items) {
    it.share = shareOf(it.dragMoney, total);
    it.display.share = shareDisplay(it.share);
  }
  for (const s of by_symbol) {
    s.share = shareOf(s.dragMoney, total);
    s.display.share = shareDisplay(s.share);
  }

  // 展示序（候选）：dragMoney 降序、同额按 trade_id 升序——确定性；「主要矛盾」定位属推理层
  items.sort((a, b) => (b.dragMoney - a.dragMoney) || (a.trade_id < b.trade_id ? -1 : a.trade_id > b.trade_id ? 1 : 0));

  const itemsSum = items.reduce((s, x) => s + x.dragMoney, 0);
  const sum_equals_total = moneyEqual(itemsSum, total);
  if (!sum_equals_total) {
    errors.push({ code: DECOMPOSE_CODES.SUM_MISMATCH, scope: 'portfolio', message: `分解加总 ${itemsSum} ≠ 组合总损耗 ${total}（恒等式 ID-1 破坏；不发布）` });
  }
  const provenance_complete = errors.every((e) => e.code !== DECOMPOSE_CODES.SOURCE_DANGLING);

  return {
    total: {
      value: total,
      display: fmtMoney(total),
      formula_id: CALC_FORMULAS.CALC_DRAG_MONEY_V1.formula_id,
      formula_text: CALC_FORMULAS.CALC_DRAG_MONEY_V1.formula_text,
      line_count: items.length,
    },
    items,
    by_symbol,
    checks: {
      sum_equals_total,
      sum_items: itemsSum,
      provenance_complete,
      per_symbol: by_symbol.map((s) => ({ symbol: s.symbol, sum_lines: s.sum_lines, dragMoney: s.dragMoney, ok: s.sum_ok })),
    },
    blocked: errors.length > 0,
    errors,
    notes: [
      'T1-13：占比可回原成交（每项含 trade_id + source）；加总=总损耗（恒等式 ID-1，逐标的与组合双层校验）。',
      '总量与加总由工具保证；“主要矛盾”定位属推理层引用本分解（F-2：数字不得重算或改写）；items 已按 dragMoney 降序作确定性展示序（候选）。',
      '损耗反向（负值）＝该笔卖出价高于估值日 close：实际优于对照（双向归因）。',
      '占比以组合总损耗为分母（带符号）：含负项时单项占比可为负或绝对值超 100%，属预期行为。',
      items.length === 0 ? '无卖出笔：损耗为 0，无可分解明细。' : `分解覆盖 ${items.length} 笔卖出（损耗已实现部分；未卖出持仓不产生损耗行）。`,
    ],
  };
}
