#!/usr/bin/env node
/**
 * M1-C3 计算引擎（src/engine/indicators.js）—— 产品侧单元测试 v1
 *
 * 定位：移植 m0/calc-baseline 55 项候选校验中属计算引擎的部分——三组手算样例（case-1/2/3）、
 *       恒等式①②③④、F-2 展示串、Q1 费用税费口径、formula_id 结构与结果标注；
 *       另加 A/A′ 受影响指标按预期变化（R1）与「行情缓存 → 计算引擎」链路（合成缓存跑通引擎）。
 * 边界：case-2 的单笔替换（cf_*）属 M1-C4，本测试不覆盖；容差为候选值（正式复核容差未冻结，M0 项）。
 * 运行：node tests/indicators.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeIndicators, CALC_FORMULAS, RESULT_LABELS } from '../src/engine/indicators.js';
import { createMarketCache, fromFixtures } from '../src/engine/marketCache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sumBy = (list, f) => list.reduce((s, x) => s + f(x), 0);

const case1 = load('m0/calc-baseline/fixtures/case-1-basic.json');
const case2 = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
const case3 = load('m0/calc-baseline/fixtures/case-3-fees-label.json');

// 与 m0 校验一致：估值日经行情缓存解析（B3），close 取不复权序列（B2）；fixture 轨道→标准化交易补 symbol 字段
function closeAtValuation(fx) {
  const sym = fx.inputs.symbol;
  const cache = createMarketCache({
    tradingDays: fx.inputs.calendar,
    range: { start: fx.inputs.calendar[0], end: fx.inputs.calendar[fx.inputs.calendar.length - 1] },
    symbols: { [sym]: { bars: fx.inputs.bars } },
  });
  const val = cache.resolveValuation(fx.inputs.requested_date);
  const close = val.blocked ? null : cache.getClose(sym, val.effective_date);
  const trades = fx.inputs.trades.map((t) => ({ ...t, symbol: sym }));
  const lastTradeDate = trades.map((t) => t.trade_date).sort().at(-1);
  return { cache, val, close, trades, lastTradeDate };
}

/* ---- 注册表与标注（§4-3：每数字带 formula_id；Q1/Q2 标注） ---- */
{
  const ids = ['CALC_BUY_COST_V1', 'CALC_SELL_PROCEEDS_V1', 'CALC_HELD_SHARES_V1', 'CALC_ACTUAL_VALUE_V1', 'CALC_GHOST_VALUE_V1', 'CALC_RET_V1', 'CALC_DRAG_MONEY_V1', 'CALC_DRAG_PP_V1', 'CALC_CF_REPLACE_SELL_V1'];
  check('注册表：9 个候选公式齐全且 formula_text 非空（含 S1 替换公式）', Object.keys(CALC_FORMULAS).length === 9 && ids.every((id) => CALC_FORMULAS[id]?.formula_text?.length > 0), Object.keys(CALC_FORMULAS).join(','));
  check('注册表：formula_id 字段与键一致、状态为候选', Object.entries(CALC_FORMULAS).every(([k, v]) => v.formula_id === k && String(v.status).startsWith('候选')), '');
  check('标注：RESULT_LABELS 含 Q1/Q2 口径', RESULT_LABELS.fees_taxes.includes('未计入费用、税费') && RESULT_LABELS.dividend.includes('分红未计入'), JSON.stringify(RESULT_LABELS));
}

/* ---- case-1：基础三指标 + 期末持仓 + 非交易日映射 + 恒等式 ---- */
{
  const fx = case1;
  check('夹具标注：case-1 为合成夹具（占位代码 000000）', fx.artifact === 'synthetic-fixture' && fx.inputs.symbol === '000000', fx.artifact);
  const { cache, val, close, trades, lastTradeDate } = closeAtValuation(fx);
  check('case-1：经行情缓存映射 2024-10-03 → 2024-09-30', val.blocked === false && val.effective_date === fx.expected.effective_date, JSON.stringify(val));
  check('case-1：effective_date 取不复权 close = 13.00（B2）', close === fx.expected.close_unadj, close);
  check('case-1：effective_date ≥ 账单末笔交易日（checkLastTrade 不阻断）', cache.checkLastTrade(val.effective_date, lastTradeDate).blocked === false, lastTradeDate);

  const exp = fx.expected;
  const got = computeIndicators({ trades, closes: { [fx.inputs.symbol]: close } }).per_stock[fx.inputs.symbol];
  for (const k of ['buyCost', 'sellProceeds', 'heldShares', 'actualValue', 'ghostValue']) {
    check(`case-1：${k} = ${exp[k]}`, near(got[k], exp[k]), `got ${got[k]}`);
  }
  for (const k of ['actualRet', 'ghostRet', 'dragMoney', 'drag']) {
    check(`case-1：${k} 与手算一致`, near(got[k], exp[k]), `got ${got[k]}`);
  }

  const d = exp.display;
  check('case-1：display.actualRet = +4.5%', got.display.actualRet === d.actualRet, got.display.actualRet);
  check('case-1：display.ghostRet = +18.2%', got.display.ghostRet === d.ghostRet, got.display.ghostRet);
  check('case-1：display.drag = +13.6pp', got.display.drag === d.drag, got.display.drag);
  check('case-1：display.dragMoney = ¥300.00', got.display.dragMoney === d.dragMoney, got.display.dragMoney);
  check('case-1：display.buyCost/actualValue/ghostValue 与夹具一致', got.display.buyCost === d.buyCost && got.display.actualValue === d.actualValue && got.display.ghostValue === d.ghostValue, `${got.display.buyCost}/${got.display.actualValue}/${got.display.ghostValue}`);

  check('case-1：恒等式② dragMoney = ghostValue − actualValue', Math.abs(got.dragMoney - (got.ghostValue - got.actualValue)) <= 1e-9, `${got.dragMoney}/${got.ghostValue - got.actualValue}`);
  check('case-1：恒等式③ dragMoney = drag × buyCost', near(got.dragMoney, got.drag * got.buyCost), `${got.dragMoney} vs ${got.drag * got.buyCost}`);
  const held = sumBy(trades, (t) => (t.side === 'buy' ? t.quantity : -t.quantity));
  check('case-1：恒等式④ 股数守恒 heldShares = Σ买 − Σ卖 = 50', got.heldShares === held && held === 50, `${got.heldShares}/${held}`);
  check('case-1：恒等式① Σ逐笔卖出重放 = dragMoney', near(sumBy(got.drag_lines, (l) => l.dragMoney), got.dragMoney), sumBy(got.drag_lines, (l) => l.dragMoney));

  check('case-1：双路径 dragMoney 一致（逐笔重放 vs 聚合公式）', got.dual_path.dragMoney.consistent === true, JSON.stringify(got.dual_path.dragMoney));
  check('case-1：双路径 ghostValue 一致（批次累计 vs 直接乘积）', got.dual_path.ghostValue.consistent === true, JSON.stringify(got.dual_path.ghostValue));

  const keys = ['buyCost', 'sellProceeds', 'heldShares', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'];
  check('case-1：每个数字带 formula_id 且均在注册表内', keys.every((k) => CALC_FORMULAS[got.formula_ids[k]]?.formula_text), JSON.stringify(got.formula_ids));
  check('case-1：formula_id 映射抽查（buyCost/dragMoney/drag）', got.formula_ids.buyCost === 'CALC_BUY_COST_V1' && got.formula_ids.dragMoney === 'CALC_DRAG_MONEY_V1' && got.formula_ids.drag === 'CALC_DRAG_PP_V1', '');
}

/* ---- case-2：多笔卖出 + 逐笔替换损耗可加总（恒等式①）；cf_* 属 M1-C4 ---- */
{
  const fx = case2;
  const { val, close, trades } = closeAtValuation(fx);
  check('case-2：估值日 = 2024-09-30（交易日）', val.blocked === false && val.effective_date === fx.expected.effective_date, JSON.stringify(val));
  const exp = fx.expected;
  const got = computeIndicators({ trades, closes: { [fx.inputs.symbol]: close } }).per_stock[fx.inputs.symbol];
  for (const k of ['buyCost', 'sellProceeds', 'heldShares', 'actualValue', 'ghostValue']) {
    check(`case-2：${k} = ${exp[k]}`, near(got[k], exp[k]), `got ${got[k]}`);
  }
  for (const k of ['actualRet', 'ghostRet', 'dragMoney', 'drag']) {
    check(`case-2：${k} 与手算一致`, near(got[k], exp[k]), `got ${got[k]}`);
  }
  check('case-2：display.actualRet = +5.7%', got.display.actualRet === exp.display.actualRet, got.display.actualRet);
  check('case-2：display.ghostRet = +18.2%', got.display.ghostRet === exp.display.ghostRet, got.display.ghostRet);
  check('case-2：display.drag = +12.5pp（精确 1/8）', got.display.drag === exp.display.drag, got.display.drag);
  check('case-2：display.dragMoney = ¥275.00', got.display.dragMoney === exp.display.dragMoney, got.display.dragMoney);

  check('case-2：逐笔明细条数 = 2（仅卖出笔进入重放）', got.drag_lines.length === exp.per_trade_drag.length, got.drag_lines.length);
  for (const x of exp.per_trade_drag) {
    const line = got.drag_lines.find((l) => l.trade_id === x.trade_id);
    check(`case-2：逐笔 ${x.trade_id} 损耗 = ${x.dragMoney}`, line !== undefined && line.quantity === x.quantity && near(line.dragMoney, x.dragMoney), JSON.stringify(line));
  }
  check('case-2：恒等式① Σ逐笔替换损耗 = 总损耗（200 + 75 = 275）', near(sumBy(got.drag_lines, (l) => l.dragMoney), got.dragMoney) && near(got.dragMoney, 275), got.dragMoney);
  check('case-2：双路径一致（dragMoney / ghostValue）', got.dual_path.dragMoney.consistent && got.dual_path.ghostValue.consistent, '');
}

/* ---- case-3：费用/税费记录但不入公式（Q1）+ 缺失标注 + anti-pattern 防御 ---- */
{
  const fx = case3;
  const { close, trades } = closeAtValuation(fx);
  const exp = fx.expected;
  const got = computeIndicators({ trades, closes: { [fx.inputs.symbol]: close } }).per_stock[fx.inputs.symbol];
  check('case-3：buyCost = 2,200.00（费用税费未进入公式，Q1）', near(got.buyCost, exp.buyCost), got.buyCost);
  check('case-3：actualValue = 2,300.00；ghostValue = 2,600.00', near(got.actualValue, exp.actualValue) && near(got.ghostValue, exp.ghostValue), `${got.actualValue}/${got.ghostValue}`);
  check('case-3：actualRet = +4.5%（与 case-1 一致，不因费用税费存在而变化）', near(got.actualRet, exp.actualRet) && got.display.actualRet === '+4.5%', `${got.actualRet}/${got.display.actualRet}`);
  check('case-3：dragMoney = ¥300.00；drag = +13.6pp', near(got.dragMoney, exp.dragMoney) && got.display.drag === '+13.6pp', `${got.dragMoney}/${got.display.drag}`);
  check('case-3：anti-pattern 防御——buyCost ≠ 2,227.50（误计入费用税费的错值）', !near(got.buyCost, exp.anti_pattern.wrongBuyCost), got.buyCost);

  const rec = fx.recorded_fees_taxes;
  check('case-3：记录值 费用合计 11.00（T003 缺失按 0 并标记）', near(got.recorded.fee_recorded_sum, rec.fee_recorded_sum), got.recorded.fee_recorded_sum);
  check('case-3：记录值 税费合计 16.50', near(got.recorded.tax_recorded_sum, rec.tax_recorded_sum), got.recorded.tax_recorded_sum);
  check('case-3：fee_missing_lines = [T003]；tax 无缺失', eqArr(got.recorded.fee_missing_lines, rec.fee_missing_lines) && eqArr(got.recorded.tax_missing_lines, []), JSON.stringify(got.recorded));
  check('case-3：结果标注含 Q1/Q2 两条', exp.result_labelling.filter((s) => s.includes('（Q1）') || s.includes('（Q2）')).every((s) => Object.values(RESULT_LABELS).includes(s)), JSON.stringify(exp.result_labelling));
}

/* ---- A/A′：R1 受影响指标按预期变化、其余保持不变 ---- */
{
  const expA = load('m0/csv-input/fixtures/demo-bill.expected.json');
  const expAp = load('m0/csv-input/fixtures/demo-bill-aprime.expected.json');
  const closes = expA.assumptions.asof_prices;
  const runA = computeIndicators({ trades: expA.standardized.trades, closes });
  const runAp = computeIndicators({ trades: expAp.standardized.trades, closes });

  for (const sym of Object.keys(expA.expected_indicators.per_stock)) {
    const e = expA.expected_indicators.per_stock[sym];
    const g = runA.per_stock[sym];
    const keys = ['buyCost', 'heldShares', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'];
    const bad = keys.filter((k) => !near(g[k], e[k]));
    check(`A：${sym} 8 项指标与夹具一致`, bad.length === 0, `差异 [${bad.join(',')}]`);
    check(`A：${sym} 展示串一致`, g.display.actualRet === e.display.actualRet && g.display.ghostRet === e.display.ghostRet && g.display.dragMoney === e.display.dragMoney && g.display.drag === e.display.drag, `${g.display.actualRet}/${g.display.ghostRet}/${g.display.dragMoney}/${g.display.drag}`);
  }
  const eP = expA.expected_indicators.portfolio;
  const gP = runA.portfolio;
  check('A：portfolio 7 项指标与夹具一致', ['buyCost', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'].every((k) => near(gP[k], eP[k])), JSON.stringify({ got: gP.actualRet, exp: eP.actualRet }));
  check('A：portfolio 展示串一致（+4.9% / +16.0% / ¥3,900.00 / +11.1pp）', gP.display.actualRet === eP.display.actualRet && gP.display.ghostRet === eP.display.ghostRet && gP.display.dragMoney === eP.display.dragMoney && gP.display.drag === eP.display.drag, `${gP.display.actualRet}/${gP.display.ghostRet}/${gP.display.dragMoney}/${gP.display.drag}`);

  const PICK = (run, path) => { const [a, b] = path.split('.'); return a === 'portfolio' ? run.portfolio[b] : run.per_stock[a][b]; };
  const delta = expAp.delta_vs_demo_bill;
  for (const item of delta.affected) {
    check(`Δ ${item.path}: ${item.from} → ${item.to}（受影响按预期变化）`, near(PICK(runA, item.path), item.from) && near(PICK(runAp, item.path), item.to), `实际 ${PICK(runA, item.path)} → ${PICK(runAp, item.path)}`);
  }
  const drifted = delta.unchanged.filter((p) => !near(PICK(runA, p), PICK(runAp, p)));
  check(`Δ 不变指标 ${delta.unchanged.length} 项全部保持不变`, drifted.length === 0, JSON.stringify(drifted));
  check('A′：portfolio 展示 +7.7% / +8.3pp（受影响后）', runAp.portfolio.display.actualRet === expAp.expected_indicators.portfolio.display.actualRet && runAp.portfolio.display.drag === expAp.expected_indicators.portfolio.display.drag, `${runAp.portfolio.display.actualRet}/${runAp.portfolio.display.drag}`);
}

/* ---- 链路：合成行情缓存 → 计算引擎（停止条件：数据源替换不改公式） ---- */
{
  const calendar = load('m0/market-cache/fixtures/mock-calendar.json');
  const bars = load('m0/market-cache/fixtures/mock-daily-bars.json');
  const cache = createMarketCache(fromFixtures(calendar, bars));
  const val = cache.resolveValuation('2024-10-03');
  check('链路：2024-10-03（非交易日）→ 2024-09-30', val.blocked === false && val.effective_date === '2024-09-30', JSON.stringify(val));
  const prices = cache.resolvePrices(['000000'], val.effective_date);
  check('链路：000000 @ 2024-09-30 不复权 close = 104.0', prices.per_symbol['000000'].blocked === false && prices.per_symbol['000000'].close === 104.0, JSON.stringify(prices.per_symbol['000000']));

  const trades = [
    { trade_id: 'X1', trade_date: '2024-09-25', symbol: '000000', side: 'buy', price: 100, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false },
    { trade_id: 'X2', trade_date: '2024-09-27', symbol: '000000', side: 'sell', price: 110, quantity: 50, fee: 0, tax: 0, fee_missing: false, tax_missing: false },
  ];
  const ind = computeIndicators({ trades, closes: { '000000': prices.per_symbol['000000'].close } }).per_stock['000000'];
  // 手算：buyCost = 100×100 = 10,000；proceeds = 50×110 = 5,500；held = 50；actual = 5,500 + 50×104 = 10,700
  check('链路：actualValue = 10,700.00（手算）', near(ind.actualValue, 10700), ind.actualValue);
  check('链路：ghostValue = 10,400.00（手算）', near(ind.ghostValue, 10400), ind.ghostValue);
  check('链路：dragMoney = −300.00（卖价高于估值日 close，负损耗＝实际优于对照）', near(ind.dragMoney, -300) && near(ind.drag, -0.03), `${ind.dragMoney}/${ind.drag}`);
  check('链路：双路径一致 + display.drag = -3.0pp', ind.dual_path.dragMoney.consistent === true && ind.display.drag === '-3.0pp', ind.display.drag);
}

/* ---- 边界：缺价不回落（B4）、未知方向、空输入 ---- */
{
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('边界：空 trades 抛错', throws(() => computeIndicators({ trades: [], closes: {} })), '');
  check('边界：缺 close 抛错（缺价不回落 B4）', throws(() => computeIndicators({ trades: [{ trade_id: 'X', trade_date: '2024-09-25', symbol: '000000', side: 'buy', price: 100, quantity: 100 }], closes: {} })), '');
  check('边界：未知方向抛错', throws(() => computeIndicators({ trades: [{ trade_id: 'X', trade_date: '2024-09-25', symbol: '000000', side: 'hold', price: 100, quantity: 100 }], closes: { '000000': 100 } })), '');
  check('边界：无买入（buyCost=0）抛错', throws(() => computeIndicators({ trades: [{ trade_id: 'X', trade_date: '2024-09-25', symbol: '000000', side: 'sell', price: 100, quantity: 100 }], closes: { '000000': 100 } })), '');
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
