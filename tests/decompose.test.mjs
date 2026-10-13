#!/usr/bin/env node
/**
 * M2-C1 数据侧（二）损耗分解（src/engine/decompose.js）—— 产品侧单元测试 v1
 *
 * 定位（T1-13）：占比可回原成交（trade_id + source）；加总=总损耗（逐标的与组合双层）；
 *   case-2 手算复算（T003 200 / T004 75 → 占比 72.7% / 27.3%）；带符号分解（负损耗项）；
 *   无卖出笔空分解；展示序确定性（dragMoney 降序）；source 悬空 / 加总破坏 → blocked。
 * 边界：本模块只保证工具性（加总+回源+确定性排序）：“主要矛盾”属推理层引用。
 * 运行：node tests/decompose.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDragDecomposition, DECOMPOSE_CODES } from '../src/engine/decompose.js';
import { computeIndicators } from '../src/engine/indicators.js';
import { parseCsvText, normalizeRows } from '../src/engine/csvNormalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const readText = (rel) => readFileSync(join(REPO, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const clone = (x) => JSON.parse(JSON.stringify(x));

const normA = normalizeRows(parseCsvText(readText('m0/csv-input/fixtures/demo-bill.csv')), 'demo-bill.csv').trades;
const CLOSES = { '000000': 125.0, '888888': 1560.0 };
const reportA = computeIndicators({ trades: normA, closes: CLOSES });

/* ---- A 账单：双层加总 + 占比 + 回源 ---- */
{
  const d = buildDragDecomposition({ report: reportA, trades: normA });
  check('A：不阻断且加总=总损耗（逐标的与组合双层 ID-1）', d.blocked === false && d.checks.sum_equals_total === true && d.checks.per_symbol.every((s) => s.ok), JSON.stringify(d.checks));
  check('A：total = 组合 dragMoney（0,000 标的 3,000.00 在分解中）', near(d.total.value, reportA.portfolio.dragMoney) && d.total.formula_id === 'CALC_DRAG_MONEY_V1' && d.total.display.startsWith('¥'), JSON.stringify(d.total));
  check('A：分解项全部为卖出笔且含 source（占比可回原成交）', d.items.every((it) => it.side === 'sell' && it.source_resolved && it.source.file === 'demo-bill.csv' && Number.isFinite(it.source.line)), JSON.stringify(d.items.map((i) => i.source)));
  check('A：by_symbol 覆盖 2 标的、逐标的 line_count 与 items 一致', d.by_symbol.length === 2 && d.by_symbol.reduce((s, x) => s + x.line_count, 0) === d.items.length, JSON.stringify(d.by_symbol.map((s) => [s.symbol, s.line_count])));
  const shares = d.items.map((i) => i.share);
  check('A：单项占比加总 ≈ 100%（带符号分解）', Math.abs(shares.reduce((s, x) => s + x, 0) - 1) <= 1e-12, JSON.stringify(shares));
  check('A：display.share 为 1 位小数百分号字符串', d.items.every((i) => /^[+-]?\d+\.\d%$/.test(i.display.share)), JSON.stringify(d.items.map((i) => i.display.share)));
  check('A：notes 声明工具性（主要矛盾属推理层）与双向归因', d.notes.some((s) => s.includes('主要矛盾')) && d.notes.some((s) => s.includes('双向归因')), '');
}

/* ---- case-2 手算：T003 200 / T004 75 → 占比 72.7% / 27.3%，降序展示 ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const trades = fx.inputs.trades.map((t, i) => ({ ...t, symbol: fx.inputs.symbol, source: { file: 'm0/calc-baseline/fixtures/case-2-single-replace.json', line: 2 + i } }));
  const report = computeIndicators({ trades, closes: { [fx.inputs.symbol]: fx.expected.close_unadj } });
  const d = buildDragDecomposition({ report, trades });
  check('case-2：分解 = [T003 200.00 → 72.7%, T004 75.00 → 27.3%]（降序、占比 1 位小数）', eqArr(d.items.map((i) => i.trade_id), ['T003', 'T004']) && near(d.items[0].dragMoney, 200) && near(d.items[1].dragMoney, 75) && d.items[0].display.share === '+72.7%' && d.items[1].display.share === '+27.3%', JSON.stringify(d.items.map((i) => [i.trade_id, i.dragMoney, i.display.share])));
  check('case-2：total = 275.00 且与手算一致', near(d.total.value, fx.expected.dragMoney) && d.total.display === '¥275.00', d.total.display);
  check('case-2：每项含 path 值（close/price/quantity 可复算 200=100×(13−11)）', d.items[0].quantity === 100 && near(d.items[0].price, 11) && near(d.items[0].close, 13), JSON.stringify(d.items[0]));
}

/* ---- 带符号分解：一笔正一笔负（负＝实际优于对照） ---- */
{
  const trades = [
    { trade_id: 'T001', trade_date: '2024-09-02', symbol: '000000', side: 'buy', price: 10, quantity: 200, source: { file: 'syn.csv', line: 2 } },
    { trade_id: 'T002', trade_date: '2024-09-03', symbol: '000000', side: 'sell', price: 12, quantity: 100, source: { file: 'syn.csv', line: 3 } },
    { trade_id: 'T003', trade_date: '2024-09-04', symbol: '000000', side: 'sell', price: 9, quantity: 100, source: { file: 'syn.csv', line: 4 } },
  ];
  const report = computeIndicators({ trades, closes: { '000000': 11 } });
  const d = buildDragDecomposition({ report, trades });
  check('带符号：T002 = 100×(11−12) = −100（负＝优于对照）、T003 = +200；total = +100', near(d.items.find((i) => i.trade_id === 'T002').dragMoney, -100) && near(d.items.find((i) => i.trade_id === 'T003').dragMoney, 200) && near(d.total.value, 100), JSON.stringify(d.items.map((i) => [i.trade_id, i.dragMoney])));
  check('带符号：展示序 T003(+200) 先于 T002(−100)；占比 +200% / −100% 且加总 100%', eqArr(d.items.map((i) => i.trade_id), ['T003', 'T002']) && d.items[0].display.share === '+200.0%' && d.items[1].display.share === '-100.0%', JSON.stringify(d.items.map((i) => i.display.share)));
  check('带符号：notes 说明负占比/超 100% 属预期（带符号分解）', d.notes.some((s) => s.includes('带符号') && s.includes('预期')), '');
}

/* ---- 空分解：无卖出笔 ---- */
{
  const trades = [{ trade_id: 'T001', trade_date: '2024-09-02', symbol: '000000', side: 'buy', price: 10, quantity: 100, source: { file: 'syn.csv', line: 2 } }];
  const report = computeIndicators({ trades, closes: { '000000': 11 } });
  const d = buildDragDecomposition({ report, trades });
  check('空分解：无卖出笔 → items=[]、total=0、加总通过、不阻断、注明“无卖出笔”', d.items.length === 0 && d.total.value === 0 && d.checks.sum_equals_total === true && d.blocked === false && d.notes.some((s) => s.includes('无卖出笔')), JSON.stringify({ items: d.items.length, total: d.total.value }));
}

/* ---- 阻断：source 悬空 / 加总破坏 ---- */
{
  const trades = normA.map((t) => (t.trade_id === 'T004' ? { ...t, source: undefined } : t));
  const d = buildDragDecomposition({ report: computeIndicators({ trades, closes: CLOSES }), trades });
  check('悬空：抽掉 T004 source（卖出笔）→ 该分解项 source_resolved=false、blocked、错误码 E_DECOMPOSE_SOURCE_DANGLING', d.blocked === true && d.checks.provenance_complete === false && d.items.some((i) => i.trade_id === 'T004' && i.source_resolved === false && i.source === null) && d.errors.some((e) => e.code === DECOMPOSE_CODES.SOURCE_DANGLING && e.trade_id === 'T004'), JSON.stringify(d.errors));

  const r = clone(reportA);
  r.per_stock['000000'].dragMoney += 10;
  const d2 = buildDragDecomposition({ report: r, trades: normA });
  check('加总破坏：注入 per_stock.dragMoney+10 → 逐标的校验 fail、blocked、码 E_DECOMPOSE_SUM_MISMATCH', d2.blocked === true && d2.checks.per_symbol.find((s) => s.symbol === '000000').ok === false && d2.errors.some((e) => e.code === DECOMPOSE_CODES.SUM_MISMATCH && e.scope === '000000'), JSON.stringify(d2.errors));
}

/* ---- 确定性 + 入参 ---- */
{
  const d1 = buildDragDecomposition({ report: reportA, trades: normA });
  const d2 = buildDragDecomposition({ report: reportA, trades: normA });
  check('确定性：同输入两次构建结果一致', JSON.stringify(d1) === JSON.stringify(d2), '');
  check('入参：缺 report → 抛错', throws(() => buildDragDecomposition({ trades: normA })), '');
  check('入参：trades 为空 → 抛错', throws(() => buildDragDecomposition({ report: reportA, trades: [] })), '');
}

/* ---- 汇总 ---- */
let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
