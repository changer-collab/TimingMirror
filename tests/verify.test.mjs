#!/usr/bin/env node
/**
 * M2-C1 数据侧（一）双路径复核（src/engine/verify.js）—— 产品侧单元测试 v1
 *
 * 定位（附 A.2 五用例）：
 *   ① 手算 fixture 双路径一致（A/A′ 与 case-2 全 fact 通过、恒等式全通过）
 *   ② 计算错误注入（单侧实现中间值）→ 可捕获（双路径 diff / 独立重算 / 恒等式破坏）
 *   ③ 数据源错误注入（共享行情缓存行）→ 注明检测依据；不承诺双路径必然捕获（同源同错时如实不报）
 *   ④ 抽掉 source → provenance 缺失 / 源行不可定位 → fact 阻断发布（verdict=fail）
 *   ⑤ 全量 fact 必有 verdict；verify_id 确定性
 * 边界：重算回流（A.3）与复核编排属 M1-C7（changer）；容差为候选值（金额到分、收益率 1e-9），正式容差随 M0。
 * 运行：node tests/verify.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildVerifyReport, VERIFY_CODES } from '../src/engine/verify.js';
import { computeIndicators, INDICATOR_FORMULA_IDS, PORTFOLIO_FORMULA_IDS } from '../src/engine/indicators.js';
import { parseCsvText, normalizeRows } from '../src/engine/csvNormalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const readText = (rel) => readFileSync(join(REPO, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const clone = (x) => JSON.parse(JSON.stringify(x));

const normA = normalizeRows(parseCsvText(readText('m0/csv-input/fixtures/demo-bill.csv')), 'demo-bill.csv').trades;
const normAprime = normalizeRows(parseCsvText(readText('m0/csv-input/fixtures/demo-bill-aprime.csv')), 'demo-bill-aprime.csv').trades;
const CLOSES = { '000000': 125.0, '888888': 1560.0 };
const reportA = computeIndicators({ trades: normA, closes: CLOSES });

/* ---- ① 夹具双路径一致（A 账单）＋结构断言 ---- */
{
  const vr = buildVerifyReport({ report: reportA, trades: normA, closes: CLOSES });
  check('① 全 fact 通过（2 标的 × 9 + 组合 8 = 26 项，fail 0）', vr.summary.n_facts === 26 && vr.summary.fail === 0, JSON.stringify(vr.summary));
  check('① 恒等式清单全通过（ID-1..4 × 标的 + ID-1..3 × 组合 = 11 项）', vr.identity_checks.length === 11 && vr.identity_checks.every((i) => i.verdict === 'pass'), JSON.stringify(vr.identity_checks.map((i) => `${i.identity_id}:${i.scope}:${i.verdict}`)));
  check('① provenance 完整（无悬空引用）', vr.provenance_complete === true && vr.dangling_refs.length === 0, JSON.stringify(vr.dangling_refs));
  check('⑤ 全量 fact 必有 verdict 与唯一 fact_id', vr.facts.every((f) => f.verdict === 'pass' || f.verdict === 'fail') && new Set(vr.facts.map((f) => f.fact_id)).size === 26, '');

  const f1 = vr.facts.find((f) => f.fact_id === '000000.dragMoney');
  check('结构：fact 含 value/path_a/path_b/diff/tol/verdict/reasons/formula_id', f1 && near(f1.value, 3000) && near(f1.path_a, 3000) && near(f1.path_b, 3000) && f1.tol.kind === 'round_to_cent' && f1.reasons.length === 0, JSON.stringify(f1));
  check('结构：金额容差=统一舍入到分；收益率容差=1e-9 相对（候选）', vr.facts.find((f) => f.fact_id === '000000.buyCost').tol.kind === 'round_to_cent' && vr.facts.find((f) => f.fact_id === '000000.drag').tol.kind === 'relative' && vr.facts.find((f) => f.fact_id === '000000.heldShares').tol.kind === 'exact', '');
  check('结构：formula_id 取自公式注册表（标的与组合两套）', f1.formula_id === INDICATOR_FORMULA_IDS.dragMoney && vr.facts.find((f) => f.fact_id === 'portfolio.drag').formula_id === PORTFOLIO_FORMULA_IDS.drag, '');
  check('结构：inputs 与 source_refs 可回原始成交换行', f1.inputs.trade_ids.length === 3 && f1.source_refs.length === 3 && f1.source_refs[0].file === 'demo-bill.csv' && Number.isFinite(f1.source_refs[0].line), JSON.stringify(f1.source_refs));
  check('③（前置说明）data_source_notes 声明“不承诺双路径必然捕获”（附 A.2）', vr.data_source_notes[0].message.includes('不承诺必然捕获') && vr.error_taxonomy.calculation.includes('可被本报告捕获') && vr.error_taxonomy.data_source.includes('不承诺'), '');

  const vr2 = buildVerifyReport({ report: reportA, trades: normA, closes: CLOSES });
  check('⑤ verify_id 确定性（同输入同 id，形如 V-xxxxxxxx）', vr.verify_id === vr2.verify_id && /^V-[0-9a-f]{8}$/.test(vr.verify_id), vr.verify_id);
}

/* ---- ① A′ 账单同样全通过 ---- */
{
  const aprime = buildVerifyReport({
    report: computeIndicators({ trades: normAprime, closes: CLOSES }),
    trades: normAprime,
    closes: CLOSES,
  });
  check('① A′（仅改一笔卖出）全 fact 通过、恒等式全通过', aprime.summary.fail === 0 && aprime.identity_checks.every((i) => i.verdict === 'pass') && aprime.provenance_complete === true, JSON.stringify(aprime.summary));
}

/* ---- ① case-2 手算夹具（双路径一致，金额与夹具预期一致） ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const trades = fx.inputs.trades.map((t, i) => ({ ...t, symbol: fx.inputs.symbol, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'm0/calc-baseline/fixtures/case-2-single-replace.json', line: 2 + i } }));
  const closes = { [fx.inputs.symbol]: fx.expected.close_unadj };
  const vr = buildVerifyReport({ report: computeIndicators({ trades, closes }), trades, closes });
  const dm = vr.facts.find((f) => f.fact_id === `${fx.inputs.symbol}.dragMoney`);
  check('① case-2：dragMoney = 275.00 双路径一致（P-A 逐笔重放 = 聚合公式）', near(dm.value, fx.expected.dragMoney) && near(dm.path_b, fx.expected.dragMoney) && dm.verdict === 'pass', JSON.stringify(dm));
  check('① case-2：holdings/聚合值与手算基准一致', near(vr.facts.find((f) => f.fact_id === '000000.buyCost').value, 2200) && vr.facts.find((f) => f.fact_id === '000000.heldShares').value === 50 && near(vr.facts.find((f) => f.fact_id === '000000.actualValue').value, 2325), '');
  check('① case-2：恒等式④（Σ买 − Σ卖 = heldShares）通过', vr.identity_checks.find((i) => i.identity_id === 'ID-4').verdict === 'pass', '');
}

/* ---- ② 计算错误注入（单侧实现中间值）→ 可捕获 ---- */
{
  const r1 = clone(reportA);
  r1.per_stock['000000'].dual_path.dragMoney.path_a += 10; // 注入：单侧路径中间值
  const vr1 = buildVerifyReport({ report: r1, trades: normA, closes: CLOSES });
  const f = vr1.facts.find((x) => x.fact_id === '000000.dragMoney');
  check('② 注入单侧路径中间值（+10）→ 该 fact fail 且归因“计算错误·双路径不一致”', f.verdict === 'fail' && f.reasons.some((r) => r.code === VERIFY_CODES.DUAL_PATH_MISMATCH && r.kind === '计算错误'), JSON.stringify(f.reasons));
  check('② 注入单侧路径 → 仅命中项受影响（组合 dragMoney 仍 pass）', vr1.summary.fail === 1 && vr1.facts.find((x) => x.fact_id === 'portfolio.dragMoney').verdict === 'pass', JSON.stringify(vr1.summary));

  const r2 = clone(reportA);
  r2.per_stock['000000'].buyCost += 1; // 注入：主实现值偏差
  const vr2 = buildVerifyReport({ report: r2, trades: normA, closes: CLOSES });
  const fb = vr2.facts.find((x) => x.fact_id === '000000.buyCost');
  check('② 注入主实现值（buyCost+1）→ 独立重算不一致（计算错误）', fb.verdict === 'fail' && fb.reasons.some((r) => r.code === VERIFY_CODES.RECOMPUTE_MISMATCH && r.kind === '计算错误'), JSON.stringify(fb.reasons));
  check('② 注入 buyCost → 恒等式③（drag×buyCost = dragMoney）随之破坏并归因', vr2.identity_checks.some((i) => i.identity_id === 'ID-3' && i.scope === '000000' && i.verdict === 'fail' && i.code === VERIFY_CODES.IDENTITY_BREAK), JSON.stringify(vr2.identity_checks.filter((i) => i.verdict === 'fail')));
}

/* ---- ③ 数据源错误注入（共享行情缓存行）→ 检测依据注明；不承诺必然捕获 ---- */
{
  const closesBad = { '000000': 130.0, '888888': 1560.0 }; // 看似合理的错误 close（共用同源）
  const vb = buildVerifyReport({ report: computeIndicators({ trades: normA, closes: closesBad }), trades: normA, closes: closesBad });
  check('③ 看似合理的共享源错误：双路径/重算/恒等式均不报（如实——不承诺必然捕获）', vb.summary.fail === 0 && vb.identity_checks.every((i) => i.verdict === 'pass'), JSON.stringify(vb.summary));
  check('③ 报告含“数据源错误检测依据”说明（口径核对兜底）', vb.data_source_notes.some((n) => n.message.includes('不承诺必然捕获') && n.message.includes('口径核对')), JSON.stringify(vb.data_source_notes));

  const closesSilly = { '000000': -5.0, '888888': 1560.0 }; // 违反校验的 close
  const vs = buildVerifyReport({ report: computeIndicators({ trades: normA, closes: closesSilly }), trades: normA, closes: closesSilly });
  check('③ 违反校验的共享源错误（close ≤ 0）→ 源校验告警命中（检测依据之一）', vs.data_source_notes.some((n) => n.code === VERIFY_CODES.SOURCE_VALIDATION && n.scope === '000000' && n.message.includes('close 非正数')), JSON.stringify(vs.data_source_notes));
}

/* ---- ④ 抽掉 source → provenance 缺失 / 源行不可定位 → fact 阻断发布 ---- */
{
  const trades4 = normA.map((t) => (t.trade_id === 'T003' ? { ...t, source: undefined } : t));
  const vr4 = buildVerifyReport({ report: computeIndicators({ trades: trades4, closes: CLOSES }), trades: trades4, closes: CLOSES });
  check('④ 抽掉 T003 source → 000000 全部 fact fail（源行不可定位）', vr4.facts.filter((f) => f.fact_id.startsWith('000000.')).every((f) => f.verdict === 'fail' && f.reasons.some((r) => r.code === VERIFY_CODES.SOURCE_UNRESOLVED)), JSON.stringify(vr4.summary));
  check('④ 组合 fact 同样阻断（T003 属其输入），888888 不受影响仍 pass', vr4.facts.filter((f) => f.fact_id.startsWith('portfolio.')).every((f) => f.verdict === 'fail') && vr4.facts.filter((f) => f.fact_id.startsWith('888888.')).every((f) => f.verdict === 'pass'), JSON.stringify(vr4.summary));
  check('④ provenance_complete = false 且 dangling_refs 记录 T003（含组合作用域）', vr4.provenance_complete === false && vr4.dangling_refs.some((d) => d.fact_scope === '000000' && d.ref.key === 'T003') && vr4.dangling_refs.some((d) => d.fact_scope === 'portfolio' && d.ref.key === 'T003'), JSON.stringify(vr4.dangling_refs));
  check('④ 源校验同时给出“源行不完整”告警（检测依据）', vr4.data_source_notes.some((n) => n.scope === 'T003' && n.message.includes('源行不完整')), '');
}

/* ---- 入参校验 ---- */
{
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('入参：缺 report → 抛错', throws(() => buildVerifyReport({ trades: normA, closes: CLOSES })), '');
  check('入参：trades 为空 → 抛错', throws(() => buildVerifyReport({ report: reportA, trades: [], closes: CLOSES })), '');
  check('入参：report 缺少成交中出现的标的 → 抛错（不静默漏算）', throws(() => buildVerifyReport({ report: { per_stock: { '000000': reportA.per_stock['000000'] }, portfolio: reportA.portfolio }, trades: normA, closes: CLOSES })), '');
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
