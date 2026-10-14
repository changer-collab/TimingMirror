#!/usr/bin/env node
/**
 * M2-C1 数据侧（四）计算路径 steps→provenance（src/engine/provenance.js）—— 产品侧单元测试 v1
 *
 * 定位（T1-15 ＋ 附 A.4）：
 *   ① 全量 refs 解析通过（26 fact × steps 全通过、无悬空）；
 *   ② 悬空引用 → 告警 + 阻断（作用域内 blocked）；
 *   ③ 验算视图数据完备（steps＝口径→批次→逐批→排序，每步有 detail；走查渲染属 UI）；
 *   ④ 步骤可回源（逐笔行与 refs 含 file/line/trade_id）；
 *   另：case-2 手算 275.00 路径、valuation 透传、确定性、入参抛错。
 * 运行：node tests/provenance.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildProvenance, buildProvenanceReport, listFactIds, PROVENANCE_CODES } from '../src/engine/provenance.js';
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

const normA = normalizeRows(parseCsvText(readText('m0/csv-input/fixtures/demo-bill.csv')), 'demo-bill.csv').trades;
const CLOSES = { '000000': 125.0, '888888': 1560.0 };
const reportA = computeIndicators({ trades: normA, closes: CLOSES });

/* ---- ① 全量 fact provenance 通过 ---- */
{
  const ids = listFactIds(reportA);
  check('① listFactIds：26 项（2 标的 × 9 + 组合 8）', ids.length === 26 && ids.includes('000000.heldShares') && !ids.includes('portfolio.heldShares'), JSON.stringify(ids.length));
  const rep = buildProvenanceReport({ report: reportA, trades: normA, closes: CLOSES });
  check('① 全量 fact 不阻断、items 26、无悬空', rep.blocked === false && rep.items.length === 26 && rep.dangling_refs.length === 0, JSON.stringify(rep.summary));
  check('① 每 fact 含 formula_id/formula_text/inputs/source_refs/steps', rep.items.every((it) => it.formula_id && it.formula_text && it.inputs.trade_ids.length > 0 && it.source_refs.length > 0 && it.steps.length === 4), JSON.stringify(rep.items.find((it) => it.blocked)));
  check('① 全量 source_refs 均可解析（file+line）', rep.items.every((it) => it.source_refs.every((r) => r.file && Number.isFinite(r.line))), '');
}

/* ---- ③④ steps 结构：口径→批次→逐批→排序；逐笔行可回源 ---- */
{
  const p = buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: '000000.dragMoney' });
  check('③ steps 四步顺序与标签 = 口径/批次/逐批/排序', eqArr(p.steps.map((s) => s.kind), ['caliber', 'batch', 'lines', 'sort']) && eqArr(p.steps.map((s) => s.label), ['口径', '批次', '逐批（逐笔明细）', '排序']), JSON.stringify(p.steps.map((s) => s.label)));
  check('③ 每步含 detail（留痕）；S3 含逐笔行', p.steps.every((s) => typeof s.detail === 'string' && s.detail.length > 0) && p.steps[2].lines.length === p.inputs.trade_ids.length, '');
  check('④ 逐笔行含 trade_id/date/side/price/quantity/amount + ref(file/line)', p.steps[2].lines.every((l) => l.trade_id && l.trade_date && l.side && Number.isFinite(l.price) && Number.isFinite(l.quantity) && near(l.amount, l.price * l.quantity) && l.ref.file === 'demo-bill.csv' && Number.isFinite(l.ref.line)), JSON.stringify(p.steps[2].lines[0]));
  check('④ S4 排出规范顺序（trade_date 升序）且顺序=逐笔行顺序', eqArr(p.steps[3].order, p.steps[2].lines.map((l) => l.trade_id)), JSON.stringify(p.steps[3].order));
  check('value/display：《000000.dragMoney》= 3,000.00 且 formula 引自注册表', near(p.value, 3000) && p.display === '¥3,000.00' && p.formula_id === 'CALC_DRAG_MONEY_V1' && p.formula_text.includes('ghostValue − actualValue'), JSON.stringify({ v: p.value, d: p.display }));
  check('S2 批次含双路径值（P-A/P-B/diff）', p.steps[1].detail.includes('P-A=') && p.steps[1].detail.includes('P-B=') && p.steps[1].detail.includes('diff'), p.steps[1].detail);
  const held = buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: '000000.heldShares' });
  check('display：heldShares = “0 股”（无 % / ¥ 修饰）', held.display === '0 股' && held.formula_id === 'CALC_HELD_SHARES_V1', held.display);
}

/* ---- case-2 手算：275.00 路径 + valuation 透传 ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const trades = fx.inputs.trades.map((t, i) => ({ ...t, symbol: fx.inputs.symbol, source: { file: 'm0/calc-baseline/fixtures/case-2-single-replace.json', line: 2 + i } }));
  const closes = { [fx.inputs.symbol]: fx.expected.close_unadj };
  const p = buildProvenance({
    report: computeIndicators({ trades, closes }), trades, closes, fact_id: '000000.dragMoney',
    valuation: { requested_date: '2024-09-30', effective_date: '2024-09-30' },
  });
  check('case-2：dragMoney 路径 = 275.00（双路径一致），4 笔逐批明细', near(p.value, 275) && p.steps[2].lines.length === 4 && p.steps[2].lines.map((l) => l.trade_id).join(',') === 'T001,T002,T003,T004', JSON.stringify(p.steps[2].lines.map((l) => l.trade_id)));
  check('case-2：S1 透传估值日解析（requested → effective）', p.steps[0].detail.includes('requested=2024-09-30') && p.steps[0].detail.includes('effective=2024-09-30'), p.steps[0].detail);
  check('case-2：S1 含 formula 全文与 B2/B3/B4 口径', p.steps[0].detail.includes('不复权') && p.steps[0].detail.includes('B3') && p.steps[0].detail.includes('B4'), '');
}

/* ---- ② 悬空引用 → 阻断 ---- */
{
  const trades = normA.map((t) => (t.trade_id === 'T004' ? { ...t, source: undefined } : t));
  const rep = buildProvenanceReport({ report: computeIndicators({ trades, closes: CLOSES }), trades, closes: CLOSES });
  const blockedScopes = new Set(rep.items.filter((it) => it.blocked).map((it) => it.scope));
  check('② 抽掉 T004 source → 000000 与 portfolio 的 fact 全部阻断，888888 不阻断', rep.blocked === true && blockedScopes.has('000000') && blockedScopes.has('portfolio') && !blockedScopes.has('888888') && rep.summary.blocked_n === 17, JSON.stringify({ n: rep.summary.blocked_n, scopes: [...blockedScopes] }));
  check('② 错误码 E_PROV_DANGLING_REF 且点名 T004（悬空引用不发布）', rep.items.find((it) => it.fact_id === '000000.buyCost').errors.some((e) => e.code === PROVENANCE_CODES.DANGLING_REF && e.message.includes('T004')), JSON.stringify(rep.items.find((it) => it.fact_id === '000000.buyCost').errors));
  check('② dangling_refs 汇总（含 portfolio 作用域）', rep.dangling_refs.length === 17 && rep.dangling_refs.some((d) => d.scope === 'portfolio' && d.fact_id === 'portfolio.dragMoney'), JSON.stringify(rep.dangling_refs.length));
  check('② 阻断项的 S3 逐笔行仍保留（ref.file=null 可定位缺口）', rep.items.find((it) => it.fact_id === '000000.dragMoney').steps[2].lines.some((l) => l.trade_id === 'T004' && l.ref.file === null && l.ref.line === null), '');
}

/* ---- 确定性 + 入参 ---- */
{
  const p1 = buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: 'portfolio.ghostValue' });
  const p2 = buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: 'portfolio.ghostValue' });
  check('确定性：同输入两次构建一致', JSON.stringify(p1) === JSON.stringify(p2), '');
  check('组合 fact：inputs 为全量成交、close_basis 标注', p1.inputs.trade_ids.length === normA.length && p1.inputs.close_basis.includes('不复权'), JSON.stringify(p1.inputs));
  check('入参：fact_id 非法/不存在 → 抛错', throws(() => buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: 'xyz' })) && throws(() => buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: 'portfolio.heldShares' })) && throws(() => buildProvenance({ report: reportA, trades: normA, closes: CLOSES, fact_id: '999999.buyCost' })), '');
  check('入参：缺 report / trades 空 / closes 缺失 → 抛错', throws(() => buildProvenance({ trades: normA, closes: CLOSES, fact_id: '000000.buyCost' })) && throws(() => buildProvenance({ report: reportA, trades: [], closes: CLOSES, fact_id: '000000.buyCost' })) && throws(() => buildProvenance({ report: reportA, trades: normA, fact_id: '000000.buyCost' })), '');
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
