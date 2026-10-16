#!/usr/bin/env node
/**
 * 主线 C（首项任务）· 本地两阶段事实快照与回答数字检查 —— 离线单测（合成数据；零依赖）
 *
 * 覆盖：prepare（有效四事实/组合扣发/缺字段/空事实/非法输入/错误意图与作用域/不修改输入/确定性）；
 *       快照（字段白名单/冻结/不随原输入变化/不保留完整 review）；
 *       check（numbers_passed 且声明仅数字子集/伪造数字 withheld/固定无数字文字不回退候选/失败不泄出/确定性）；
 *       llm_mode='offline_fallback' 与 source='offline_stub'；无 plan_id/延迟/代理记录字段；
 *       已知限制如实记录（中文数字不识别、数字通过≠语义正确；未解决，不宣称）。
 * 边界：纯函数测试；通过仅证明快照与检查语义与单测一致，不证明在线链路（百炼/代理）或产品端到端验收通过。
 * 运行：node tests/agent/answer-facts.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { FACT_SET_VERSION } from '../../src/agent/factExport.js';
import { NUMBER_CHECK_CODES } from '../../src/agent/numberCheck.js';
import {
  prepareAnswerFacts,
  checkPreparedAnswer,
  ANSWER_FACTS_CODES,
  ANSWER_FACTS_WITHHELD_TEXT,
} from '../../src/agent/answerFacts.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity, src = true) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  ...(src ? { source: { file: 'mini.csv', line: 2 } } : {}),
});
const A_CLEAN = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100), mk('T002', '2024-09-27', '000000', 'sell', 11, 100)];
const B_CLEAN = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10), mk('B102', '2024-09-30', '888888', 'sell', 105, 10)];

const buildFull = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12, '888888': 110 }, valuation: VAL });
const buildDegraded = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12 }, valuation: VAL });
const prepareFull = () => prepareAnswerFacts({ review: buildFull(), intent: 'loss_overview', scope: 'portfolio' });
// 手算夹具：买入成本 ¥2,000 / 实际 ¥2,150 / 对照 ¥2,300 → +7.5% / +15.0% / +7.5pp / ¥150.00
const OK_ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';

/* ==== ① 有效四事实：prepare 快照 ==== */
{
  const prepared = prepareFull();
  check('prepare：status=prepared 且恰四事实', prepared.status === 'prepared' && prepared.facts.length === 4, JSON.stringify(prepared));
  const byKey = Object.fromEntries(prepared.facts.map((f) => [f.key, f]));
  check('prepare：键集合恰为 actualRet/ghostRet/drag/dragMoney', ['actualRet', 'ghostRet', 'drag', 'dragMoney'].every((k) => byKey[k] !== undefined) && prepared.facts.length === 4);
  check('prepare：display 对照手算（+7.5% / +15.0% / +7.5pp / ¥150.00）', byKey.actualRet.display === '+7.5%' && byKey.ghostRet.display === '+15.0%' && byKey.drag.display === '+7.5pp' && byKey.dragMoney.display === '¥150.00', JSON.stringify(prepared.facts.map((f) => f.display)));
  check('prepare：intent/scope 为唯一支持组合；fact_set_version 沿用候选版本', prepared.intent === 'loss_overview' && prepared.scope === 'portfolio' && prepared.fact_set_version === FACT_SET_VERSION);
  const allowed = new Set(['fact_ref', 'key', 'value', 'unit', 'display']);
  check('快照：逐事实字段 ⊆ 白名单（无 scope/symbol/trade 痕迹）', prepared.facts.every((f) => Object.keys(f).every((k) => allowed.has(k))));
  check('快照：冻结（对象/数组/每事实）', Object.isFrozen(prepared) && Object.isFrozen(prepared.facts) && prepared.facts.every((f) => Object.isFrozen(f)));
  const before = prepared.facts[0].value;
  let threw = false;
  try { prepared.facts[0].value = 0; } catch { threw = true; }
  check('快照：strict 模式改写抛错且值不变', threw === true && prepared.facts[0].value === before);
  const s = JSON.stringify(prepared);
  check('快照：不保留完整 review（无 verify_id/provenance/blocked_facts/recompute 与交易痕迹）', !s.includes('"verify_id"') && !s.includes('"provenance"') && !s.includes('"blocked_facts"') && !s.includes('"recompute"') && !s.includes('"trade_id"') && !s.includes('"T001"') && !s.includes('"mini.csv"') && !s.includes('"symbol"'), s.slice(0, 200));
}

/* ==== ② check 成功：numbers_passed（仅数字子集） ==== */
{
  const prepared = prepareFull();
  const r = checkPreparedAnswer({ prepared, answerText: OK_ANSWER });
  check('check：四 display 通过 → numbers_passed（checked=4/matched=4/failed=0）', r.status === 'numbers_passed' && r.check_record.checked === 4 && r.check_record.matched_count === 4 && r.check_record.failed_count === 0, JSON.stringify(r));
  check('check：声明仅数字子集（verification_scope + note 明示不表示语义/已发布/在线完成）', r.verification_scope === 'recognizable_numbers_subset' && typeof r.note === 'string' && r.note.includes('不表示'));
  check('check：llm_mode=offline_fallback、source=offline_stub，且无 plan_id/延迟/代理记录字段', r.llm_mode === 'offline_fallback' && r.source === 'offline_stub' && ['plan_id', 'latency', 'call_record', 'proxy_record'].every((k) => !(k in r)));
  const r2 = checkPreparedAnswer({ prepared, answerText: '损耗金额 ¥150.00，择时损耗 +7.5pp。' });
  check('check：display 精确匹配类通过（checked=2）', r2.status === 'numbers_passed' && r2.check_record.checked === 2, JSON.stringify(r2));
}

/* ==== ③ 失败：伪造数字 → withheld + 固定无数字文字 + 不泄出 ==== */
{
  const prepared = prepareFull();
  const forged = '实际收益 +99.9%，损耗金额 ¥999.00。';
  const r = checkPreparedAnswer({ prepared, answerText: forged });
  check('失败：伪造数字 → withheld（NUMBERS_FAILED）', r.status === 'withheld' && r.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.NUMBERS_FAILED), JSON.stringify(r.diagnostics));
  check('失败：text 为固定无数字文字（零数字，非原候选）', r.text === ANSWER_FACTS_WITHHELD_TEXT && !/[0-9０-９]/.test(r.text));
  const s = JSON.stringify(r);
  check('失败：不泄出候选回答全文与失败数字原文（无 raw/reason/99.9/999）', !s.includes(forged) && !s.includes('+99.9%') && !s.includes('¥999.00') && !s.includes('99.9') && !s.includes('999'), s.slice(0, 300));
  check('失败：check_record 只含计数与错误码（E_NUMCHECK_NOT_IN_FACTS）', r.check_record.checked === 2 && r.check_record.matched_count === 0 && r.check_record.failed_count === 2 && r.check_record.failed_codes.includes(NUMBER_CHECK_CODES.NOT_IN_FACTS), JSON.stringify(r.check_record));
  const mixed = checkPreparedAnswer({ prepared, answerText: '实际收益 +7.5%，另有人说是 +99.9%。' });
  check('失败：混合（1 合法 1 伪造）→ withheld，计数 matched=1/failed=1 且不泄出伪造数字', mixed.status === 'withheld' && mixed.check_record.checked === 2 && mixed.check_record.matched_count === 1 && mixed.check_record.failed_count === 1 && !JSON.stringify(mixed).includes('99.9'), JSON.stringify(mixed));
}

/* ==== ④ prepared 无效 / 上游 withheld / answerText 非法 ==== */
{
  const wp = prepareAnswerFacts({ review: buildDegraded(), intent: 'loss_overview', scope: 'portfolio' });
  const r1 = checkPreparedAnswer({ prepared: wp, answerText: OK_ANSWER });
  check('上游 withheld：check 仍 withheld（PREPARE_WITHHELD）且固定文字', r1.status === 'withheld' && r1.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PREPARE_WITHHELD) && r1.text === ANSWER_FACTS_WITHHELD_TEXT);
  const r2 = checkPreparedAnswer({ prepared: null, answerText: OK_ANSWER });
  check('prepared 非法：null → withheld（PREPARED_INVALID），零计数', r2.status === 'withheld' && r2.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PREPARED_INVALID) && r2.check_record.checked === 0);
  const r3 = checkPreparedAnswer({ prepared: { status: 'prepared', facts: [] }, answerText: '+7.5%' });
  check('prepared 形状不符：facts 空缺 → withheld（不拿空集放行）', r3.status === 'withheld' && r3.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PREPARED_INVALID));
  const prepared = prepareFull();
  const r4 = checkPreparedAnswer({ prepared: { ...prepared, facts: prepared.facts.slice(0, 3) }, answerText: '+7.5%' });
  check('prepared 形状不符：缺一事实（三键）→ withheld', r4.status === 'withheld' && r4.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PREPARED_INVALID));
  const r5 = checkPreparedAnswer({ prepared, answerText: 123 });
  check('answerText 非字符串 → withheld（INPUT_INVALID）', r5.status === 'withheld' && r5.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.INPUT_INVALID));
  const r6 = checkPreparedAnswer({});
  check('check 无入参 → withheld（PREPARED_INVALID）', r6.status === 'withheld' && r6.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PREPARED_INVALID));
}

/* ==== ⑤ 错误意图/作用域：唯一支持组合之外一律 withheld ==== */
{
  const review = buildFull();
  for (const [intent, scope] of [['worst_trade', 'portfolio'], ['loss_overview', '000000'], ['loss_overview', null], [null, 'portfolio'], ['out_of_scope', 'portfolio']]) {
    const r = prepareAnswerFacts({ review, intent, scope });
    check(`组合：intent=${String(intent)}/scope=${String(scope)} → withheld（COMBO_UNSUPPORTED）`, r.status === 'withheld' && r.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.COMBO_UNSUPPORTED), JSON.stringify(r.diagnostics));
  }
  const badScope = prepareAnswerFacts({ review, intent: 'loss_overview', scope: '000000' });
  check('组合：不支持组合不回显原始 scope 输入（000000 不出现在结果中）', !JSON.stringify(badScope).includes('000000'), JSON.stringify(badScope));
}

/* ==== ⑥ 组合扣发 / 空事实 / 导出非 ok ==== */
{
  const degraded = prepareAnswerFacts({ review: buildDegraded(), intent: 'loss_overview', scope: 'portfolio' });
  check('组合扣发：缺价降级（portfolio_published=false）→ withheld（PORTFOLIO_WITHHELD）', degraded.status === 'withheld' && degraded.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PORTFOLIO_WITHHELD), JSON.stringify(degraded.diagnostics));
  const emptyTrades = runReview({ trades: [], closes: { '000000': 12 } });
  const empty = prepareAnswerFacts({ review: emptyTrades, intent: 'loss_overview', scope: 'portfolio' });
  check('空事实：空 trades（blocked、组合未发布）→ withheld', empty.status === 'withheld' && empty.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.PORTFOLIO_WITHHELD));
  const nullReview = prepareAnswerFacts({ review: null, intent: 'loss_overview', scope: 'portfolio' });
  check('非法输入：review=null → withheld（INPUT_INVALID）', nullReview.status === 'withheld' && nullReview.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.INPUT_INVALID));
  const noProv = prepareAnswerFacts({ review: { ...buildFull(), provenance: null }, intent: 'loss_overview', scope: 'portfolio' });
  check('导出非 ok：组合已发布但 provenance 缺失（导出 invalid）→ withheld（EXPORT_NOT_OK）', noProv.status === 'withheld' && noProv.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.EXPORT_NOT_OK), JSON.stringify(noProv.diagnostics));
}

/* ==== ⑦ 缺字段：组合四事实不齐 ==== */
{
  const full = buildFull();
  const dropDragMoney = { ...full, provenance: { ...full.provenance, items: full.provenance.items.filter((i) => i.fact_id !== 'portfolio.dragMoney') } };
  const r = prepareAnswerFacts({ review: dropDragMoney, intent: 'loss_overview', scope: 'portfolio' });
  check('缺字段：dragMoney 无 provenance → 导出缺项 → withheld（FACTS_INCOMPLETE 列明缺少的键）', r.status === 'withheld' && r.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.FACTS_INCOMPLETE && d.message.includes('dragMoney')), JSON.stringify(r.diagnostics));
  const dropAll = { ...full, provenance: { ...full.provenance, items: full.provenance.items.filter((i) => !String(i.fact_id).startsWith('portfolio.')) } };
  const r2 = prepareAnswerFacts({ review: dropAll, intent: 'loss_overview', scope: 'portfolio' });
  check('空事实：组合事实全部无 provenance → 四键全缺 → withheld', r2.status === 'withheld' && r2.diagnostics.some((d) => d.code === ANSWER_FACTS_CODES.FACTS_INCOMPLETE));
}

/* ==== ⑧ 快照不随原输入变化 + 不修改输入 + 确定性 ==== */
{
  const review = buildFull();
  const reviewBefore = JSON.stringify(review);
  const prepared = prepareAnswerFacts({ review, intent: 'loss_overview', scope: 'portfolio' });
  check('纯净：prepare 不修改输入 review', JSON.stringify(review) === reviewBefore);
  const snapshot = JSON.stringify(prepared);
  review.published_facts.forEach((f) => { f.value = 99999; f.display = '¥9,999.00'; });
  review.portfolio_published = false;
  check('快照：原 review 被改写后快照逐字节不变', JSON.stringify(prepared) === snapshot);
  const rOk = checkPreparedAnswer({ prepared, answerText: OK_ANSWER });
  check('check：不重新读取 review（原 review 已改写，仍按旧快照通过）', rOk.status === 'numbers_passed');
  const rNew = checkPreparedAnswer({ prepared, answerText: '损耗金额 ¥9,999.00。' });
  check('check：改写后的新数字不在旧快照内 → withheld（不重算、不采用新值）', rNew.status === 'withheld');
  const p1 = prepareAnswerFacts({ review: buildFull(), intent: 'loss_overview', scope: 'portfolio' });
  const p2 = prepareAnswerFacts({ review: buildFull(), intent: 'loss_overview', scope: 'portfolio' });
  check('确定性：两次独立 prepare 快照 JSON 一致', JSON.stringify(p1) === JSON.stringify(p2));
  const c1 = checkPreparedAnswer({ prepared: p1, answerText: OK_ANSWER });
  const c2 = checkPreparedAnswer({ prepared: p1, answerText: OK_ANSWER });
  check('确定性：两次 check 结果完全一致', JSON.stringify(c1) === JSON.stringify(c2));
}

/* ==== ⑨ 已知限制如实记录（未解决，不宣称） ==== */
{
  const prepared = prepareFull();
  const rCn = checkPreparedAnswer({ prepared, answerText: '组合实际收益为百分之七点五。' });
  check('限制：中文数字不纳入识别 → checked=0 且通过（如实保留，未解决）', rCn.status === 'numbers_passed' && rCn.check_record.checked === 0);
  const rSem = checkPreparedAnswer({ prepared, answerText: '对照收益 +7.5%。' });
  check('限制：+7.5% 实为 actualRet，标注为对照收益仍通过（数字子集不检查语义；如实保留，未解决）', rSem.status === 'numbers_passed' && rSem.check_record.checked === 1);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
