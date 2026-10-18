#!/usr/bin/env node
/**
 * 主线 C · 离线对话消费契约适配器 —— 离线单测（合成数据；零依赖）
 *
 * 覆盖：成功闭环（intent/scope 门 → planner → answerFacts → 草稿 → numberCheck）、调用方草稿路径、
 *       缺失事实、上游 withheld、数字校验失败、非法组合、计划兜底、非法输入、
 *       固定无数字降级文本 / 不泄出候选数字 / trace 无时间戳延迟与原始交易 / 输出字段齐备 / 确定性。
 * 边界：纯函数测试；通过仅证明本地适配器语义与单测一致，不证明在线链路（百炼/代理）或页面接线。
 * 运行：node tests/agent/offline-dialogue.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { buildPlan } from '../../src/agent/planner.js';
import {
  runOfflineDialogue,
  OFFLINE_DIALOGUE_CODES,
  OFFLINE_DIALOGUE_FALLBACK_TEXT,
} from '../../src/agent/offlineDialogue.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  source: { file: 'mini.csv', line: 2 },
});
const A_CLEAN = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100), mk('T002', '2024-09-27', '000000', 'sell', 11, 100)];
const B_CLEAN = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10), mk('B102', '2024-09-30', '888888', 'sell', 105, 10)];
const buildFull = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12, '888888': 110 }, valuation: VAL });
const buildDegraded = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12 }, valuation: VAL });
const QUESTION = '我的组合整体表现如何？';
const runFull = (extra = {}) => runOfflineDialogue({ question: QUESTION, intent: 'loss_overview', scope: 'portfolio', review: buildFull(), ...extra });
const DISPLAYS = ['+7.5%', '+15.0%', '+7.5pp', '¥150.00'];

/* ==== ① 成功闭环 ==== */
{
  const review = buildFull();
  const reviewBefore = JSON.stringify(review);
  const r = runFull({ review });
  check('成功：answer_status=numbers_passed（仅数字子集）', r.answer_status === 'numbers_passed' && r.verification_scope === 'recognizable_numbers_subset' && r.numbers_checked === 4 && r.fallback_reason === null, JSON.stringify(r));
  check('成功：输出必需字段齐备', ['request_id', 'intent', 'scope', 'plan', 'answer_status', 'verification_scope', 'numbers_checked', 'fallback_reason', 'trace'].every((k) => k in r));
  check('成功：request_id 为确定性本地标识（req-8hex）', /^req-[0-9a-f]{8}$/.test(r.request_id), r.request_id);
  check('成功：plan 复用 planner（plan_id 一致；仅留痕不执行）', r.plan !== null && r.plan.plan_id === buildPlan({ question: QUESTION, intentJson: { intent: 'loss_overview', slots: {}, confidence: 1 } }).plan_id && r.trace.find((t) => t.step === 'plan').executed === false);
  check('成功：plan.status 如实为 needs_context（未传工具上下文，不重算）', r.plan.status === 'needs_context' && r.plan.steps.every((s) => s.status === 'missing_params' && !('params' in s)), JSON.stringify(r.plan));
  check('成功：草稿含四事实 display；链路顺序 draft 在 number_check 之前', DISPLAYS.every((d) => r.text.includes(d)) && r.trace.map((t) => t.step).join('>') === 'input>intent_scope_gate>plan>prepare_facts>draft>number_check');
  check('成功：note 明示仅数字子集（不表示语义/已发布/在线完成）', typeof r.note === 'string' && r.note.includes('仅表示可识别数字子集') && r.note.includes('不表示'));
  check('成功：llm_mode=offline_fallback / source=offline_stub', r.llm_mode === 'offline_fallback' && r.source === 'offline_stub');
  check('成功：输出无原始交易痕迹与时间戳/延迟/代理记录', !JSON.stringify(r).includes('T001') && !JSON.stringify(r).includes('B101') && !JSON.stringify(r).includes('mini.csv') && ['ts', 'ms', 'latency', 'call_record', 'proxy_record'].every((k) => !(k in r) && r.trace.every((t) => !(k in t))));
  check('纯净：不修改输入 review', JSON.stringify(review) === reviewBefore);
}

/* ==== ② 调用方草稿：numberCheck 校验的是草稿本身 ==== */
{
  const draft = '组合实际收益 +7.5%。';
  const r = runFull({ answerDraft: draft });
  check('调用方草稿：通过且 text 为已校验草稿（checked=1）', r.answer_status === 'numbers_passed' && r.text === draft && r.numbers_checked === 1, JSON.stringify(r));
  check('调用方草稿：trace 记录 source=caller', r.trace.find((t) => t.step === 'draft').source === 'caller');
}

/* ==== ③ 缺失事实：prepare withheld → 固定降级 ==== */
{
  const full = buildFull();
  const missing = { ...full, provenance: { ...full.provenance, items: full.provenance.items.filter((i) => i.fact_id !== 'portfolio.dragMoney') } };
  const r = runFull({ review: missing });
  check('缺失事实：withheld + FACTS_INCOMPLETE（固定降级文本）', r.answer_status === 'withheld' && r.fallback_reason === 'W_ANSWER_FACTS_INCOMPLETE' && r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT && r.numbers_checked === 0, JSON.stringify(r));
  check('缺失事实：降级文本无数字且结果不含四事实 display', !/[0-9０-９]/.test(r.text) && DISPLAYS.every((d) => !JSON.stringify(r).includes(d)));
  check('缺失事实：trace 停在 prepare_facts 并记录 fallback', r.trace.some((t) => t.step === 'prepare_facts' && t.status === 'withheld' && t.code === 'W_ANSWER_FACTS_INCOMPLETE') && r.trace[r.trace.length - 1].step === 'fallback');
}

/* ==== ④ 上游 withheld：组合未发布 ==== */
{
  const r = runFull({ review: buildDegraded() });
  check('上游 withheld：缺价降级 → PORTFOLIO_WITHHELD + 固定降级', r.answer_status === 'withheld' && r.fallback_reason === 'W_ANSWER_PORTFOLIO_WITHHELD' && r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT, JSON.stringify(r));
  const leakDraft = '实际收益 +88.8%。';
  const r2 = runFull({ review: buildDegraded(), answerDraft: leakDraft });
  check('上游失败：候选草稿不被使用（无 draft 步、数字不泄出）', !r2.trace.some((t) => t.step === 'draft') && !JSON.stringify(r2).includes('+88.8%') && !JSON.stringify(r2).includes('88.8'));
}

/* ==== ⑤ 数字校验失败：草稿生成后被 numberCheck 拦截 ==== */
{
  const bad = '实际收益 +99.9%，损耗金额 ¥999.00。';
  const r = runFull({ answerDraft: bad });
  check('数字校验失败：withheld（NUMBERS_FAILED）+ 固定降级文本', r.answer_status === 'withheld' && r.fallback_reason === 'W_ANSWER_NUMBERS_FAILED' && r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT, JSON.stringify(r));
  check('数字校验失败：numbers_checked=2（仅计数）；不泄出草稿与数字原文', r.numbers_checked === 2 && !JSON.stringify(r).includes(bad) && !JSON.stringify(r).includes('+99.9%') && !JSON.stringify(r).includes('¥999.00') && !JSON.stringify(r).includes('99.9'));
  check('数字校验失败：trace 记录 number_check withheld 与 fallback', r.trace.some((t) => t.step === 'number_check' && t.status === 'withheld' && t.code === 'W_ANSWER_NUMBERS_FAILED') && r.trace[r.trace.length - 1].step === 'fallback');
}

/* ==== ⑥ 非法组合：唯一支持 loss_overview + portfolio ==== */
{
  for (const [intent, scope] of [['worst_trade', 'portfolio'], ['loss_overview', '000000'], ['loss_overview', null], [null, 'portfolio'], ['out_of_scope', 'portfolio']]) {
    const r = runOfflineDialogue({ question: QUESTION, intent, scope, review: buildFull() });
    check(`非法组合：intent=${String(intent)}/scope=${String(scope)} → COMBO_UNSUPPORTED（plan=null）`, r.answer_status === 'withheld' && r.fallback_reason === OFFLINE_DIALOGUE_CODES.COMBO_UNSUPPORTED && r.plan === null && r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT, JSON.stringify(r));
  }
}

/* ==== ⑦ 计划兜底与非法输入 ==== */
{
  const r1 = runOfflineDialogue({ question: '', intent: 'loss_overview', scope: 'portfolio', review: buildFull() });
  check('计划兜底：空问题 → PLAN_FALLBACK（计划仍留痕）', r1.answer_status === 'withheld' && r1.fallback_reason === OFFLINE_DIALOGUE_CODES.PLAN_FALLBACK && r1.plan !== null && r1.plan.status === 'fallback', JSON.stringify(r1));
  const r2 = runOfflineDialogue({ question: 42, intent: 'loss_overview', scope: 'portfolio', review: buildFull() });
  check('非法输入：question 非字符串 → INPUT_INVALID', r2.answer_status === 'withheld' && r2.fallback_reason === OFFLINE_DIALOGUE_CODES.INPUT_INVALID && r2.text === OFFLINE_DIALOGUE_FALLBACK_TEXT);
  const r3 = runFull({ answerDraft: 123 });
  check('非法输入：answerDraft 非字符串 → INPUT_INVALID', r3.answer_status === 'withheld' && r3.fallback_reason === OFFLINE_DIALOGUE_CODES.INPUT_INVALID);
  const r4 = runFull({ answerDraft: '   ' });
  check('非法输入：空白草稿 → INPUT_INVALID（不放行空数字集）', r4.answer_status === 'withheld' && r4.fallback_reason === OFFLINE_DIALOGUE_CODES.INPUT_INVALID);
}

/* ==== ⑧ 确定性与降级文本固定 ==== */
{
  const a = runFull();
  const b = runFull();
  check('确定性：同输入两次运行结果逐字节一致', JSON.stringify(a) === JSON.stringify(b));
  const c = runFull({ requestId: 'req-local-001' });
  check('request_id：允许调用方传入本地标识', c.request_id === 'req-local-001');
  check('降级文本：固定常量、无数字', OFFLINE_DIALOGUE_FALLBACK_TEXT === '该问题当前无法基于已复核事实回答，已停止输出；离线模式不展示未经校验的数字。' && !/[0-9０-９]/.test(OFFLINE_DIALOGUE_FALLBACK_TEXT));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
