#!/usr/bin/env node
/**
 * M1-C7 · 复核与重算编排 —— 离线单测（合成数据；零依赖）
 *
 * 覆盖（首轮验收）：①正常验证并发布；②校验失败后 blocked；③缺价后不发布组合结论；
 *                 ④必要重算后 provenance 可追溯；⑤工具异常后的降级状态；⑥重放确定性；
 *                 ⑦重算候选作用域校验（丢失/新增标的、close 无效 → 拒绝采纳，回归）；⑧连续两次无改善即停止；
 *                 ⑨A.2 单侧注入（engine 层可测；编排层无注入 seam——如实记录为遗留项）。
 * 边界：只调用现有引擎导出（未改公式）；通过仅证明编排语义与单测一致，不证明产品端到端验收通过。
 * 运行：node tests/agent/review-pipeline.test.mjs（或 npm run check）
 */
import { runReview, REVIEW_CODES, MAX_RECOMPUTE_ATTEMPTS } from '../../src/agent/reviewPipeline.js';
import { computeIndicators } from '../../src/engine/indicators.js';
import { buildVerifyReport } from '../../src/engine/verify.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };

function mk(id, date, symbol, side, price, quantity, withSource = true) {
  return {
    trade_id: id, trade_date: date, symbol, side, price, quantity,
    fee: 0, tax: 0, fee_missing: false, tax_missing: false,
    ...(withSource ? { source: { file: 'mini.csv', line: id === 'T001' ? 2 : 3 } } : {}),
  };
}
const A_CLEAN = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100), mk('T002', '2024-09-27', '000000', 'sell', 11, 100)];
const A_DIRTY = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100, false), mk('T002', '2024-09-27', '000000', 'sell', 11, 100, false)];
const B_CLEAN = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10), mk('B102', '2024-09-30', '888888', 'sell', 105, 10)];
const B_DIRTY = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10, false), mk('B102', '2024-09-30', '888888', 'sell', 105, 10, false)];
const CLOSES2 = { '000000': 12, '888888': 110 };

/* ==== ① 正常验证并发布 ==== */
{
  const r = runReview({ trades: A_CLEAN(), closes: { '000000': 12 }, valuation: VAL });
  check('正常：状态 published', r.status === 'published', r.status);
  check('正常：发布 17 项 fact（9 标的 + 8 组合）、0 阻断', r.published_facts.length === 17 && r.blocked_facts.length === 0, `${r.published_facts.length}/${r.blocked_facts.length}`);
  check('正常：组合结论发布（portfolio_published=true）', r.portfolio_published === true);
  check('正常：复核全过（fail=0、恒等式 0 失败）', r.verify.summary.fail === 0 && r.verify.summary.identities_fail === 0, JSON.stringify(r.verify.summary));
  check('正常：无重算（无回调且无缺参）', r.meta.recompute_attempts === 0 && r.recompute_log.length === 0);
  check('正常：verify_id 为内容摘要（V- 前缀）', typeof r.meta.verify_id === 'string' && r.meta.verify_id.startsWith('V-'));
  const bc = r.published_facts.find((f) => f.fact_id === '000000.buyCost');
  check('正常：fact 值可追溯（buyCost=1000 且带 display）', bc && near(bc.value, 1000) && bc.display === '¥1,000.00', JSON.stringify(bc));
  check('正常：provenance 覆盖全部已发布 fact（无悬空、非阻断）', r.provenance.blocked === false && r.provenance.dangling_refs.length === 0
    && r.published_facts.every((f) => r.provenance.items.some((i) => i.fact_id === f.provenance_fact_id && !i.blocked)));
}

/* ==== ② 校验失败后 blocked（来源不可定位 → facts fail；无重算可用） ==== */
{
  const r = runReview({ trades: A_DIRTY(), closes: { '000000': 12 } });
  check('校验失败：状态 blocked、发布 0 项', r.status === 'blocked' && r.published_facts.length === 0, JSON.stringify({ s: r.status, n: r.published_facts.length }));
  check('校验失败：17 项全部阻断且 final_status=blocked（无可用重算）', r.blocked_facts.length === 17 && r.blocked_facts.every((b) => b.final_status === 'blocked'), JSON.stringify(r.blocked_facts[0]));
  check('校验失败：原因码含 E_VERIFY_SOURCE_UNRESOLVED（附A.2 ④）', r.blocked_facts.every((b) => b.reason_codes.includes('E_VERIFY_SOURCE_UNRESOLVED')), JSON.stringify(r.blocked_facts[0].reason_codes));
  check('校验失败：组合结论未发布', r.portfolio_published === false);
  check('校验失败：重算日志记录"无备用"（attempt 0 / aborted）', r.recompute_log.length === 1 && r.recompute_log[0].attempt === 0 && r.recompute_log[0].result === 'no_alternative' && r.recompute_log[0].final_status === 'aborted', JSON.stringify(r.recompute_log[0]));
  check('校验失败：degraded 含 E_REVIEW_RECOMPUTE_NO_ALTERNATIVE', r.degraded.some((d) => d.code === REVIEW_CODES.RECOMPUTE_NO_ALTERNATIVE));

  const sellOnly = [mk('S001', '2024-09-24', '000000', 'sell', 10, 100)];
  const r2 = runReview({ trades: sellOnly, closes: { '000000': 12 } });
  check('工具异常（主实现抛错：无买入无法算收益率）→ blocked + E_REVIEW_COMPUTE_FAILED', r2.status === 'blocked' && r2.verify === null && r2.degraded[0].code === REVIEW_CODES.COMPUTE_FAILED, JSON.stringify(r2.degraded));
}

/* ==== ③ 缺价后不发布组合结论 ==== */
{
  const r = runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12 }, valuation: VAL });
  check('缺价：状态 degraded、888888 记为 blocked_symbols', r.status === 'degraded' && r.blocked_symbols.length === 1 && r.blocked_symbols[0].symbol === '888888' && r.blocked_symbols[0].code === REVIEW_CODES.PRICE_MISSING, JSON.stringify(r.blocked_symbols));
  check('缺价：组合结论未发布（portfolio_published=false）', r.portfolio_published === false);
  check('缺价：发布 9 项（000000 完整保留，B4）且不含 portfolio 作用域', r.published_facts.length === 9 && r.published_facts.every((f) => f.scope === '000000'), JSON.stringify(r.published_facts.map((f) => f.fact_id).slice(0, 3)));
  check('缺价：8 项组合 fact 扣发（reason=E_REVIEW_PORTFOLIO_WITHHELD）', r.blocked_facts.length === 8
    && r.blocked_facts.every((b) => b.scope === 'portfolio' && b.reason_codes.includes(REVIEW_CODES.PORTFOLIO_WITHHELD)), JSON.stringify(r.blocked_facts[0]));
  check('缺价：未按剩余标的重算组合（verify 仅覆盖 000000 的 fact 集）', r.verify.facts.every((f) => f.fact_id.startsWith('000000.') || f.fact_id.startsWith('portfolio.')));
  const r2 = runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12, '888888': NaN } });
  check('缺价（NaN 变体）：同样不发布组合结论', r2.status === 'degraded' && r2.portfolio_published === false && r2.blocked_symbols[0].symbol === '888888');
}

/* ==== ④ 必要重算后 provenance 可追溯 ==== */
{
  const recompute = ({ attempt }) => (attempt === 1 ? { trades: A_CLEAN(), closes: { '000000': 12 }, path_used: 'reload-fixture' } : null);
  const r = runReview({ trades: A_DIRTY(), closes: { '000000': 12 }, valuation: VAL, recompute });
  check('重算：状态 published（数据重载后复核全过）', r.status === 'published', r.status);
  check('重算：调用了 1 次（A.3 ①：脏数据→重载 pass）', r.meta.recompute_attempts === 1 && r.recompute_log.length === 1, JSON.stringify(r.recompute_log));
  check('重算：日志字段完整（attempt/path_used/result=pass/adopted/trigger）', r.recompute_log[0].attempt === 1 && r.recompute_log[0].path_used === 'reload-fixture'
    && r.recompute_log[0].result === 'pass' && r.recompute_log[0].final_status === 'adopted'
    && r.recompute_log[0].trigger.failed_facts === 17 && /^R-[0-9a-f]{8}$/.test(r.recompute_log[0].recompute_id), JSON.stringify(r.recompute_log[0]));
  check('重算：最终复核 verdict 变化（fail 17→0）；verify_id 覆盖 verdict/provenance_complete——来源修复后摘要变化',
    r.recompute_log[0].trigger.failed_facts === 17 && r.verify.summary.fail === 0 && r.meta.verify_id !== r.recompute_log[0].trigger.verify_id,
    JSON.stringify({ triggerFail: r.recompute_log[0].trigger.failed_facts, finalFail: r.verify.summary.fail, idChanged: r.meta.verify_id !== r.recompute_log[0].trigger.verify_id }));
  check('重算结果可追溯到 provenance：17 项全部链接且非阻断', r.published_facts.length === 17
    && r.published_facts.every((f) => f.provenance_fact_id === f.fact_id)
    && r.provenance.items.every((i) => !i.blocked) && r.provenance.dangling_refs.length === 0, `${r.provenance.summary.n} items`);
  check('重算后数值与直算一致（buyCost=1000、dragMoney=100）', near(r.published_facts.find((f) => f.fact_id === '000000.buyCost').value, 1000)
    && near(r.published_facts.find((f) => f.fact_id === '000000.dragMoney').value, 100));
}

/* ==== ⑤ 工具异常后的降级状态（重算回调连续抛错） ==== */
{
  const boom = () => { throw new Error('合成重算失败'); };
  const r = runReview({ trades: [...A_CLEAN(), ...B_DIRTY()], closes: CLOSES2, recompute: boom });
  check('工具异常：状态 degraded（部分发布）', r.status === 'degraded', r.status);
  check('工具异常：发布 9 项（000000 完整）、阻断 17 项（888888+组合）', r.published_facts.length === 9 && r.blocked_facts.length === 17, `${r.published_facts.length}/${r.blocked_facts.length}`);
  check('工具异常：阻断项 final_status=insufficient_evidence（重算已耗尽）', r.blocked_facts.every((b) => b.final_status === 'insufficient_evidence'));
  check('工具异常：重算尝试 ≤2 次且全部记录为 error/aborted', MAX_RECOMPUTE_ATTEMPTS === 2 && r.recompute_log.length === 2
    && r.recompute_log.every((x) => x.result === 'error' && x.final_status === 'aborted'), JSON.stringify(r.recompute_log));
  check('工具异常：degraded 记录 E_REVIEW_RECOMPUTE_TOOL_ERROR ×2（不崩溃、如实降级）', r.degraded.filter((d) => d.code === REVIEW_CODES.RECOMPUTE_TOOL_ERROR).length === 2);
  check('工具异常：组合结论未发布', r.portfolio_published === false);
}

/* ==== ⑥ 重放确定性 ==== */
{
  const recompute = ({ attempt }) => (attempt === 1 ? { trades: A_CLEAN(), closes: { '000000': 12 }, path_used: 'reload-fixture' } : null);
  const args = { trades: A_DIRTY(), closes: { '000000': 12 }, valuation: VAL, recompute };
  const r1 = runReview(args);
  const r2 = runReview(args);
  check('确定性：同输入两次编排输出完全一致（含 verify_id/recompute_log）', JSON.stringify(r1) === JSON.stringify(r2));
  const r3 = runReview({ trades: A_CLEAN(), closes: { '000000': 12 } });
  const r4 = runReview({ trades: A_CLEAN(), closes: { '000000': 12 } });
  check('确定性：正常路径两次输出一致', JSON.stringify(r3) === JSON.stringify(r4));
  check('确定性：now 未注入时日志 ts 为 null', r1.recompute_log[0].ts === null && r1.recompute_log[0].ms === null);
  const r5 = runReview({ trades: A_DIRTY(), closes: { '000000': 12 }, now: 'T0' });
  check('确定性：now 注入时仅透传到日志 ts', r5.recompute_log[0].ts === 'T0' && JSON.stringify({ ...r5, recompute_log: [] }) === JSON.stringify({ ...runReview({ trades: A_DIRTY(), closes: { '000000': 12 } }), recompute_log: [] }));
}

/* ==== ⑦ 重算候选作用域校验（回归：丢失标的不得被采纳） ==== */
{
  const A = A_CLEAN();
  const initial = [...A, ...B_DIRTY()];

  // 场景 A：候选只返回一个标的（丢失 888888）——自身可复核通过也不得采纳
  const r = runReview({ trades: initial, closes: CLOSES2, recompute: () => ({ trades: A, closes: CLOSES2, path_used: 'subset-candidate' }) });
  check('回归：丢失标的候选被拒绝（两次均 rejected/not_adopted + 候选错误码）', r.recompute_log.length === 2
    && r.recompute_log.every((x) => x.result === 'rejected' && x.final_status === 'not_adopted' && x.code === REVIEW_CODES.CANDIDATE_SCOPE_CHANGED), JSON.stringify(r.recompute_log[0]));
  check('回归：degraded 记录拒绝原因（含缺少的 888888）', r.degraded.some((d) => d.code === REVIEW_CODES.CANDIDATE_SCOPE_CHANGED && d.message.includes('888888')), JSON.stringify(r.degraded.filter((d) => d.code === REVIEW_CODES.CANDIDATE_SCOPE_CHANGED)));
  check('回归：组合结论不发布（portfolio_published=false，发布项不含 portfolio）', r.portfolio_published === false && r.published_facts.every((f) => f.scope !== 'portfolio'));
  check('回归：仅 000000 的 9 项发布（完整数据照常保留）', r.published_facts.length === 9 && r.published_facts.every((f) => f.scope === '000000'));
  check('回归：原失败事实保持 insufficient_evidence（888888 9 项 + 组合 8 项）', r.blocked_facts.length === 17
    && r.blocked_facts.filter((b) => b.scope === '888888').length === 9
    && r.blocked_facts.filter((b) => b.scope === 'portfolio').length === 8
    && r.blocked_facts.every((b) => b.final_status === 'insufficient_evidence'), JSON.stringify(r.blocked_facts.map((b) => [b.scope, b.final_status]).slice(0, 3)));
  check('回归：候选未采纳（最终复核仍为初始 26 项、fail=17）、尝试 2 次', r.verify.facts.length === 26 && r.verify.summary.fail === 17 && r.meta.recompute_attempts === 2);
  check('回归：状态 degraded', r.status === 'degraded');

  // 场景 B：候选新增未请求标的（999999）
  const C_EXTRA = [mk('C001', '2024-09-25', '999999', 'buy', 5, 100), mk('C002', '2024-09-26', '999999', 'sell', 6, 100)];
  const r2 = runReview({ trades: initial, closes: CLOSES2, recompute: () => ({ trades: [...A, ...B_CLEAN(), ...C_EXTRA], closes: { ...CLOSES2, '999999': 7 }, path_used: 'extra-symbol' }) });
  check('回归：新增未请求标的同样拒绝（detail 含 999999）', r2.recompute_log[0].result === 'rejected' && r2.recompute_log[0].code === REVIEW_CODES.CANDIDATE_SCOPE_CHANGED
    && r2.degraded.some((d) => d.code === REVIEW_CODES.CANDIDATE_SCOPE_CHANGED && d.message.includes('999999')));

  // 场景 C：候选标的集齐但某作用域 close 无效（NaN）
  const r3 = runReview({ trades: initial, closes: CLOSES2, recompute: () => ({ trades: [...A, ...B_CLEAN()], closes: { '000000': 12, '888888': NaN }, path_used: 'bad-close' }) });
  check('回归：候选缺有效 close 同样拒绝（E_REVIEW_CANDIDATE_CLOSE_INVALID，detail 含 888888）', r3.recompute_log[0].result === 'rejected'
    && r3.recompute_log[0].code === REVIEW_CODES.CANDIDATE_CLOSE_INVALID
    && r3.degraded.some((d) => d.code === REVIEW_CODES.CANDIDATE_CLOSE_INVALID && d.message.includes('888888')));

  // 场景 D：第一次候选被拒后，第二次合法候选可正常采纳
  const r4 = runReview({ trades: initial, closes: CLOSES2, recompute: ({ attempt }) => (attempt === 1
    ? { trades: A, closes: CLOSES2, path_used: 'subset-candidate' }
    : { trades: [...A, ...B_CLEAN()], closes: CLOSES2, path_used: 'full-reload' }) });
  check('回归：拒绝不终止重算——第二次合法候选被采纳（published）', r4.status === 'published' && r4.recompute_log.length === 2
    && r4.recompute_log[0].result === 'rejected' && r4.recompute_log[1].result === 'pass' && r4.recompute_log[1].final_status === 'adopted'
    && r4.meta.recompute_attempts === 2, JSON.stringify(r4.recompute_log.map((x) => [x.result, x.final_status])));
  check('回归：采纳后全作用域发布（26 项、组合可发布）', r4.published_facts.length === 26 && r4.portfolio_published === true);
}

/* ==== ⑧ 连续两次无改善即停止（不抛异常） ==== */
{
  let calls = 0;
  const dirty = [...A_CLEAN(), ...B_DIRTY()];
  const r = runReview({ trades: dirty, closes: CLOSES2, recompute: () => { calls += 1; return { trades: dirty, closes: CLOSES2, path_used: 'reload-same' }; } });
  check('无改善：回调被调用恰好 2 次后停止（不超次）', calls === 2, calls);
  check('无改善：两次均记录 no_improvement/not_adopted', r.recompute_log.length === 2 && r.recompute_log.every((x) => x.result === 'no_improvement' && x.final_status === 'not_adopted'), JSON.stringify(r.recompute_log.map((x) => x.result)));
  check('无改善：最终与初始一致（000000 发布 9 项；888888+组合 17 项 insufficient_evidence）', r.published_facts.length === 9 && r.blocked_facts.length === 17 && r.blocked_facts.every((b) => b.final_status === 'insufficient_evidence'));
  check('无改善：状态 degraded、组合结论未发布', r.status === 'degraded' && r.portfolio_published === false);
}

/* ==== ⑨ A.2 单侧注入：engine 层可测；编排层无注入 seam（如实记录，不宣称已覆盖） ==== */
{
  const A = A_CLEAN();
  const report = computeIndicators({ trades: A, closes: { '000000': 12 } });
  const tampered = JSON.parse(JSON.stringify(report));
  const d = tampered.per_stock['000000'].dual_path.dragMoney;
  tampered.per_stock['000000'].dual_path.dragMoney = { ...d, path_a: d.path_a + 1 };
  const v = buildVerifyReport({ report: tampered, trades: A, closes: { '000000': 12 } });
  const f = v.facts.find((x) => x.fact_id === '000000.dragMoney');
  check('A.2 注入（engine 层可测）：单侧篡改双路径 → E_VERIFY_DUAL_PATH_MISMATCH 命中', !!f && f.verdict === 'fail'
    && f.reasons.some((rr) => rr.code === 'E_VERIFY_DUAL_PATH_MISMATCH'), JSON.stringify(f && f.reasons));
  check('A.2 注入：仅受影响 fact 失败（ghostValue 未篡改仍 pass）', v.summary.fail === 1
    && v.facts.find((x) => x.fact_id === '000000.ghostValue').verdict === 'pass', JSON.stringify(v.summary));
  const r = runReview({ trades: A, closes: { '000000': 12 }, report: tampered });
  check('A.2 注入：编排层不接受 report 注入（额外参数被忽略、按自算结果发布）——「编排层单侧注入 seam 缺失」如实记为遗留项',
    r.status === 'published' && r.verify.summary.fail === 0 && near(r.published_facts.find((x) => x.fact_id === '000000.dragMoney').value, 100), JSON.stringify({ s: r.status, fail: r.verify.summary.fail }));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
