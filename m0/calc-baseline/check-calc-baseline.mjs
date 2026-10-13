#!/usr/bin/env node
/**
 * M0 · 确定性计算基线候选（calc-baseline）—— 3 组手算样例离线校验（v1）
 *
 * 定位：按 schema.candidate.json 的候选公式与口径，对 fixtures 下 3 组合成样例
 *       重算并与夹具期望值逐项比较，附恒等式断言（Σ逐笔=总损耗、dragMoney=drag×buyCost、股数守恒）。
 * 边界：非产品实现（产品侧为 M1-C3/C4）；全部数据为合成夹具，非真实证券/行情；
 *       通过仅证明候选口径与样例一致，不证明真实行情可用、产品引擎或端到端验证通过。
 * 运行：node m0/calc-baseline/check-calc-baseline.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures');
const load = (f) => JSON.parse(readFileSync(join(FX, f), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const case1 = load('case-1-basic.json');
const case2 = load('case-2-single-replace.json');
const case3 = load('case-3-fees-label.json');

const EPS = 1e-12;
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));

/* ---- F-2 展示格式（与 src/ui/views/reportView.js 一致） ---- */
const fmtMoney = (v) => '¥' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const fmtPP = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;

/* ---- 估值日解析：非交易日取不晚于请求日的最近交易日（B3） ---- */
function resolveValuation(requested, calendar) {
  return [...calendar].reverse().find((d) => d <= requested) ?? null;
}

/* ---- 计算口径（候选公式 CALC_*_V1） ---- */
function computeIndicators(trades, close) {
  const sorted = [...trades]
    .map((t, i) => ({ ...t, _i: i }))
    .sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a._i - b._i));
  let buyCost = 0, sellProceeds = 0, buyQty = 0, sellQty = 0;
  for (const t of sorted) {
    if (t.side === 'buy') { buyCost += t.price * t.quantity; buyQty += t.quantity; }
    else { sellProceeds += t.price * t.quantity; sellQty += t.quantity; }
  }
  const heldShares = buyQty - sellQty;
  const actualValue = sellProceeds + heldShares * close;
  const ghostValue = buyQty * close;
  const actualRet = actualValue / buyCost - 1;
  const ghostRet = ghostValue / buyCost - 1;
  const dragMoney = ghostValue - actualValue;
  const drag = ghostRet - actualRet;
  return { buyCost, sellProceeds, heldShares, actualValue, ghostValue, actualRet, ghostRet, dragMoney, drag };
}

function assertIndicators(prefix, got, exp) {
  for (const k of ['buyCost', 'sellProceeds', 'actualValue', 'ghostValue', 'dragMoney']) {
    check(`${prefix}：${k} = ${exp[k]}`, near(got[k], exp[k]), `got ${got[k]}`);
  }
  for (const k of ['actualRet', 'ghostRet', 'drag']) {
    check(`${prefix}：${k} 与手算一致`, near(got[k], exp[k]), `got ${got[k]}`);
  }
}

/* ---- 夹具来源性质：全部合成、占位代码 ---- */
for (const [name, c] of [['case-1', case1], ['case-2', case2], ['case-3', case3]]) {
  check(`夹具标注：${name} 明确标记为合成`, c.artifact === 'synthetic-fixture' && typeof c.note === 'string' && c.note.includes('合成'), c.artifact);
  check(`夹具标注：${name} 使用占位代码 000000`, c.inputs.symbol === '000000', c.inputs.symbol);
}

/* ---- case-1：基础三指标 + 期末持仓 + 非交易日映射 + 恒等式 ---- */
{
  const c = case1;
  const eff = resolveValuation(c.inputs.requested_date, c.inputs.calendar);
  check('case-1：非交易日映射 2024-10-03 → 2024-09-30', eff === c.expected.effective_date, eff);
  const bar = c.inputs.bars.find((b) => b.date === eff);
  check('case-1：effective_date 取到不复权 close = 13.00', bar?.close === c.expected.close_unadj, bar?.close);
  const got = computeIndicators(c.inputs.trades, bar.close);
  assertIndicators('case-1', got, c.expected);
  check('case-1：股数守恒 heldShares = Σ买 − Σ卖 = 50', got.heldShares === 50 && got.heldShares === c.expected.heldShares, got.heldShares);
  check('case-1：恒等式③ dragMoney = drag × buyCost', near(got.dragMoney, got.drag * got.buyCost), `${got.dragMoney} vs ${got.drag * got.buyCost}`);
  const d = c.expected.display;
  check('case-1：展示 actualRet = +4.5%（F-2 1 位小数）', fmtPct(got.actualRet) === d.actualRet, fmtPct(got.actualRet));
  check('case-1：展示 ghostRet = +18.2%', fmtPct(got.ghostRet) === d.ghostRet, fmtPct(got.ghostRet));
  check('case-1：展示 drag = +13.6pp', fmtPP(got.drag) === d.drag, fmtPP(got.drag));
  check('case-1：展示 dragMoney = ¥300.00（F-2 金额 2 位＋千分位）', fmtMoney(got.dragMoney) === d.dragMoney, fmtMoney(got.dragMoney));
}

/* ---- case-2：S1 单笔替换 + 逐笔损耗可加总 ---- */
{
  const c = case2;
  const eff = resolveValuation(c.inputs.requested_date, c.inputs.calendar);
  check('case-2：估值日 = 2024-09-30（交易日）', eff === c.expected.effective_date, eff);
  const bar = c.inputs.bars.find((b) => b.date === eff);
  const got = computeIndicators(c.inputs.trades, bar.close);
  assertIndicators('case-2', got, c.expected);

  const perSum = c.expected.per_trade_drag.reduce((s, x) => s + x.dragMoney, 0);
  check('case-2：恒等式① Σ逐笔替换损耗 = 总损耗（200 + 75 = 275）', near(perSum, got.dragMoney), perSum);
  for (const x of c.expected.per_trade_drag) {
    const t = c.inputs.trades.find((tr) => tr.trade_id === x.trade_id);
    const v = t.quantity * (bar.close - t.price);
    check(`case-2：逐笔 ${x.trade_id} 损耗 = ${x.dragMoney}`, near(v, x.dragMoney), v);
  }

  const rep = c.inputs.trades.find((t) => t.trade_id === c.inputs.replace_trade_id);
  const cfSellProceeds = got.sellProceeds - rep.price * rep.quantity;
  const cfHeld = got.heldShares + rep.quantity;
  const cfValue = cfSellProceeds + cfHeld * bar.close;
  const expect = c.expected.replace_T003;
  check('case-2：cf_sellProceeds = 575.00', near(cfSellProceeds, expect.cf_sellProceeds), cfSellProceeds);
  check('case-2：cf_heldShares = 150', cfHeld === expect.cf_heldShares, cfHeld);
  check('case-2：cfValue = 2,525.00（替换笔不引入假设价格：仅取消该笔卖出）', near(cfValue, expect.cfValue), cfValue);
  check('case-2：cfRet = +14.7727…%（展示 +14.8%）', near(cfValue / got.buyCost - 1, expect.cfRet) && fmtPct(cfValue / got.buyCost - 1) === expect.display.cfRet, cfValue / got.buyCost - 1);
  const recovered = cfValue - got.actualValue;
  check('case-2：替换补救 = 200.00（= 1/11 = +9.0909pp）', near(recovered, expect.recoveredMoney) && near(recovered / got.buyCost, expect.recoveredPP) && fmtPP(recovered / got.buyCost) === expect.display.recoveredPP, recovered);
  check('case-2：替换后剩余损耗 = 75.00（替换不改变其余成交）', near(got.ghostValue - cfValue, expect.remainingDragMoney) && near(recovered + (got.ghostValue - cfValue), got.dragMoney), got.ghostValue - cfValue);
}

/* ---- case-3：费用/税费记录但不入公式 + 缺失标注 + anti-pattern ---- */
{
  const c = case3;
  const eff = resolveValuation(c.inputs.requested_date, c.inputs.calendar);
  const bar = c.inputs.bars.find((b) => b.date === eff);
  const got = computeIndicators(c.inputs.trades, bar.close);
  const c1 = computeIndicators(case1.inputs.trades, case1.inputs.bars.find((b) => b.date === eff).close);
  assertIndicators('case-3', got, c.expected);
  check('case-3：指标与 case-1 完全一致（费用税费不入公式，Q1）', got.actualValue === c1.actualValue && got.buyCost === c1.buyCost && got.dragMoney === c1.dragMoney, `${got.actualValue}/${c1.actualValue}`);

  const feeSum = c.inputs.trades.filter((t) => !t.fee_missing).reduce((s, t) => s + t.fee, 0);
  const taxSum = c.inputs.trades.reduce((s, t) => s + t.tax, 0);
  const missing = c.inputs.trades.filter((t) => t.fee_missing).map((t) => t.trade_id);
  check('case-3：记录值 费用合计 11.00（T003 缺失按 0 并标记）', near(feeSum, c.recorded_fees_taxes.fee_recorded_sum) && JSON.stringify(missing) === JSON.stringify(c.recorded_fees_taxes.fee_missing_lines), `${feeSum}/${missing}`);
  check('case-3：记录值 税费合计 16.50', near(taxSum, c.recorded_fees_taxes.tax_recorded_sum), taxSum);

  const ap = c.expected.anti_pattern;
  const wrongBuyCost = got.buyCost + feeSum + taxSum;
  const wrongRet = got.actualValue / wrongBuyCost - 1;
  check('case-3：anti-pattern 误计入费用税费 → buyCost 2,227.50', near(wrongBuyCost, ap.wrongBuyCost), wrongBuyCost);
  check('case-3：anti-pattern 错误收益率 +3.3% ≠ 正确 +4.5%', near(wrongRet, ap.wrongActualRet) && fmtPct(wrongRet) === ap.wrongDisplay && fmtPct(wrongRet) !== fmtPct(got.actualRet), wrongRet);
  check('case-3：结果标注含“未计入费用、税费”（Q1）', c.expected.result_labelling.some((s) => s.includes('未计入费用、税费')), JSON.stringify(c.expected.result_labelling));
  check('case-3：结果标注含“分红未计入”（Q2）', c.expected.result_labelling.some((s) => s.includes('分红未计入')), JSON.stringify(c.expected.result_labelling));
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
