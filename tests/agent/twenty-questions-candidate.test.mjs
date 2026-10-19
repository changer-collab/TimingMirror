#!/usr/bin/env node
/**
 * M1-C10 · 离线二十问候选验收矩阵（candidate-1；非冻结、非最终验收）
 *
 * 性质：candidate fixture + 结构/安全边界断言。题目取自当前已实现的 12 类 intent、planner 模板与
 *       factExport/answerFacts 离线能力；不代表 20 问清单已定稿，也不代表 R3 在线降级演练通过。
 * 覆盖：
 *   a 成功路径（loss_overview + portfolio）     b unsupported intent
 *   c 非法 scope                                 d 缺失 portfolio_published
 *   e 缺失四事实之一                             f review withheld
 *   g 草稿数字校验失败                           h 带数字草稿但上游失败 → 固定无数字降级
 *   i 成功数字只来自 facts                       j offline_fallback / offline_stub 标记
 *   k plan_id 与 buildPlan 一致                  l plan.status=needs_context 的真实含义（仅留痕、不执行）
 *   m trace 仅步骤/状态/计数/错误码              n 不输出原始交易、凭证或环境变量
 * 已知限制（未解决，不宣称）：中文数字不纳入数字校验；数字子集通过不等于语义正确。
 * 边界：纯本地；不联网、不调用百炼/代理；不改 chatView / toolRegistry / 任何能力 ready 状态。
 * 运行：node tests/agent/twenty-questions-candidate.test.mjs
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { buildPlan, INTENTS } from '../../src/agent/planner.js';
import { exportFacts } from '../../src/agent/factExport.js';
import { checkNumbers } from '../../src/agent/numberCheck.js';
import {
  runOfflineDialogue,
  OFFLINE_DIALOGUE_CODES,
  OFFLINE_DIALOGUE_FALLBACK_TEXT,
} from '../../src/agent/offlineDialogue.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity, src = true) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  ...(src ? { source: { file: 'mini.csv', line: 2 } } : {}),
});
const A_CLEAN = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100), mk('T002', '2024-09-27', '000000', 'sell', 11, 100)];
const A_DIRTY = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100, false), mk('T002', '2024-09-27', '000000', 'sell', 11, 100, false)];
const B_CLEAN = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10), mk('B102', '2024-09-30', '888888', 'sell', 105, 10)];

const buildFull = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12, '888888': 110 }, valuation: VAL });
const buildDegraded = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12 }, valuation: VAL });
const buildEmpty = () => runReview({ trades: [], closes: { '000000': 12 } });
const buildDirty = () => runReview({ trades: A_DIRTY(), closes: { '000000': 12 } });
const dropProv = (review, factId) => ({
  ...review,
  provenance: { ...review.provenance, items: review.provenance.items.filter((i) => i.fact_id !== factId) },
});

/* candidate fixture：非 frozen、非 accepted、非最终验收结论 */
const CANDIDATE_DATASET = Object.freeze({
  dataset_id: 'M1-C10-20Q-candidate-1',
  status: 'candidate',
  frozen: false,
});

const passed = () => ({ status: 'numbers_passed', reason: null });
const combo = () => ({ status: 'withheld', reason: OFFLINE_DIALOGUE_CODES.COMBO_UNSUPPORTED });
const shut = (reason) => ({ status: 'withheld', reason });

const QUESTIONS = Object.freeze([
  /* a. loss_overview + portfolio 成功路径（5） */
  { id: 'Q01', coverage: 'a', question: '我的组合整体表现怎么样？', intent: 'loss_overview', scope: 'portfolio', review: buildFull, expect: passed() },
  { id: 'Q02', coverage: 'a', question: '这段时间我的实际收益和对照收益差多少？', intent: 'loss_overview', scope: 'portfolio', review: buildFull, expect: passed() },
  { id: 'Q03', coverage: 'a', question: '组合的择时损耗是多少？', intent: 'loss_overview', scope: 'portfolio', review: buildFull, expect: passed() },
  { id: 'Q04', coverage: 'a', question: '我的组合比买入不动差了多少？', intent: 'loss_overview', scope: 'portfolio', review: buildFull, expect: passed() },
  { id: 'Q05', coverage: 'a', question: '帮我看一下组合层面的收益总览。', intent: 'loss_overview', scope: 'portfolio', review: buildFull, expect: passed() },

  /* b. unsupported intent（均为 planner 已定义的 12 类意图；本阶段对话层仅支持 loss_overview） */
  { id: 'Q06', coverage: 'b', question: '我最错的一笔是哪个？', intent: 'worst_trade', scope: 'portfolio', review: buildFull, expect: combo() },
  { id: 'Q07', coverage: 'b', question: '为什么说我追高？', intent: 'pattern_explain', scope: 'portfolio', review: buildFull, expect: combo() },
  { id: 'Q08', coverage: 'b', question: '我该怎么改？', intent: 'how_to_change', scope: 'portfolio', review: buildFull, expect: combo() },
  { id: 'Q09', coverage: 'b', question: '帮我模拟一下那天不卖出会怎样？', intent: 'what_if', scope: 'portfolio', review: buildFull, expect: combo() },
  { id: 'Q10', coverage: 'b', question: '这个数字是怎么算出来的？', intent: 'meta_calc', scope: 'portfolio', review: buildFull, expect: combo() },
  { id: 'Q11', coverage: 'b', question: '我是谁？', intent: 'profile', scope: 'portfolio', review: buildFull, expect: combo() },

  /* c. 非法 scope（本阶段仅组合级） */
  { id: 'Q12', coverage: 'c', question: '这只股票的实际收益是多少？', intent: 'loss_overview', scope: '000000', review: buildFull, expect: combo() },
  { id: 'Q13', coverage: 'c', question: '帮我按单只标的看下损耗。', intent: 'loss_overview', scope: '888888', review: buildFull, expect: combo() },

  /* d. 缺失 portfolio_published（缺价降级） */
  { id: 'Q14', coverage: 'd', question: '组合总览为什么没有结论？', intent: 'loss_overview', scope: 'portfolio', review: buildDegraded, expect: shut('W_ANSWER_PORTFOLIO_WITHHELD') },

  /* e. 缺失四事实之一 */
  { id: 'Q15', coverage: 'e', question: '组合损耗金额是多少？', intent: 'loss_overview', scope: 'portfolio', review: () => dropProv(buildFull(), 'portfolio.dragMoney'), expect: shut('W_ANSWER_FACTS_INCOMPLETE') },
  { id: 'Q16', coverage: 'e', question: '组合对照收益是多少？', intent: 'loss_overview', scope: 'portfolio', review: () => dropProv(buildFull(), 'portfolio.ghostRet'), expect: shut('W_ANSWER_FACTS_INCOMPLETE') },

  /* f. review withheld（空账单 / 脏账单均 blocked） */
  { id: 'Q17', coverage: 'f', question: '空账单的组合表现如何？', intent: 'loss_overview', scope: 'portfolio', review: buildEmpty, expect: shut('W_ANSWER_PORTFOLIO_WITHHELD') },
  { id: 'Q18', coverage: 'f', question: '这份脏账单的组合损耗是多少？', intent: 'loss_overview', scope: 'portfolio', review: buildDirty, expect: shut('W_ANSWER_PORTFOLIO_WITHHELD') },

  /* g. 草稿数字校验失败 */
  { id: 'Q19', coverage: 'g', question: '组合实际收益是多少？', intent: 'loss_overview', scope: 'portfolio', review: buildFull, draft: '实际收益 +99.9%，损耗金额 ¥999.00。', expect: shut('W_ANSWER_NUMBERS_FAILED') },

  /* h. 候选草稿含数字、但上游失败 → 固定无数字降级，草稿数字不得泄出 */
  { id: 'Q20', coverage: 'h', question: '组合整体收益和损耗是多少？', intent: 'loss_overview', scope: 'portfolio', review: () => dropProv(buildFull(), 'portfolio.dragMoney'), draft: '组合实际收益 +7.5%，损耗金额 ¥150.00。', expect: shut('W_ANSWER_FACTS_INCOMPLETE') },
]);

/* —— 执行 20 问（candidate fixture） —— */
const OUT = new Map();
for (const q of QUESTIONS) {
  const r = runOfflineDialogue({
    question: q.question,
    intent: q.intent,
    scope: q.scope,
    review: q.review(),
    answerDraft: q.draft ?? null,
  });
  OUT.set(q.id, r);
  check(
    `${q.id} [${q.coverage}] ${q.question} → ${q.expect.status}${q.expect.reason ? '/' + q.expect.reason : ''}`,
    r.answer_status === q.expect.status && r.fallback_reason === q.expect.reason,
    JSON.stringify({ status: r.answer_status, reason: r.fallback_reason }),
  );
}

/* —— 数据集与题目来源 —— */
check('数据集标记：candidate（非 frozen、非 accepted、非最终验收结论）', CANDIDATE_DATASET.status === 'candidate' && CANDIDATE_DATASET.frozen === false);
check('题目：恰 20 条，intent 均属 planner 已定义 12 类（不发明能力）', QUESTIONS.length === 20 && QUESTIONS.every((q) => INTENTS.includes(q.intent)));
const coverage = new Set(QUESTIONS.map((q) => q.coverage));
check('题目：a–h 分组齐备', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].every((c) => coverage.has(c)), JSON.stringify([...coverage]));

/* —— j. offline 标记 —— */
const all = [...OUT.values()];
check('j 标记：20 条结果均为 llm_mode=offline_fallback / source=offline_stub', all.every((r) => r.llm_mode === 'offline_fallback' && r.source === 'offline_stub'));

/* —— 输出结构：必需字段 —— */
const REQUIRED = ['request_id', 'intent', 'scope', 'plan', 'answer_status', 'verification_scope', 'numbers_checked', 'fallback_reason', 'trace'];
check('结构：20 条结果均含必需字段', all.every((r) => REQUIRED.every((k) => k in r)));

/* —— a. 成功路径 —— */
const successItems = QUESTIONS.filter((q) => q.expect.status === 'numbers_passed');
const successes = successItems.map((q) => OUT.get(q.id));
check('a 成功路径：5 条均 numbers_passed / checked=4 / 数字子集声明', successItems.length === 5 && successes.every((r) => r.answer_status === 'numbers_passed' && r.numbers_checked === 4 && r.verification_scope === 'recognizable_numbers_subset' && r.fallback_reason === null && r.text !== OFFLINE_DIALOGUE_FALLBACK_TEXT));
check('a 成功路径：note 明示仅数字子集（不表示语义/已发布/在线完成）', successes.every((r) => typeof r.note === 'string' && r.note.includes('仅表示可识别数字子集') && r.note.includes('不表示')));
check('a 成功路径：draft 步先于 number_check 步', successes.every((r) => r.trace.map((t) => t.step).join('>') === 'input>intent_scope_gate>plan>prepare_facts>draft>number_check'));

/* —— b. unsupported intent —— */
const unsupported = QUESTIONS.filter((q) => q.intent !== 'loss_overview').map((q) => OUT.get(q.id));
check('b unsupported intent：6 条 → COMBO_UNSUPPORTED，未进入 planner（plan=null）', unsupported.length === 6 && unsupported.every((r) => r.fallback_reason === OFFLINE_DIALOGUE_CODES.COMBO_UNSUPPORTED && r.plan === null && !r.trace.some((t) => t.step === 'plan')));

/* —— c. 非法 scope —— */
const badScope = ['Q12', 'Q13'].map((id) => OUT.get(id));
check('c 非法 scope：2 条 → COMBO_UNSUPPORTED，未生成计划', badScope.every((r) => r.fallback_reason === OFFLINE_DIALOGUE_CODES.COMBO_UNSUPPORTED && r.plan === null));

/* —— d/e. 缺失 portfolio_published 与缺失四事实 —— */
check('d 缺失 portfolio_published：Q14 → PORTFOLIO_WITHHELD', OUT.get('Q14').fallback_reason === 'W_ANSWER_PORTFOLIO_WITHHELD');
const missingFact = ['Q15', 'Q16'].map((id) => OUT.get(id));
check('e 缺失四事实之一：Q15/Q16 → FACTS_INCOMPLETE', missingFact.every((r) => r.fallback_reason === 'W_ANSWER_FACTS_INCOMPLETE'));

/* —— f. review withheld —— */
check('f review withheld：Q17/Q18 前置 review 为 blocked 且 → PORTFOLIO_WITHHELD', buildEmpty().status === 'blocked' && buildDirty().status === 'blocked' && ['Q17', 'Q18'].every((id) => OUT.get(id).fallback_reason === 'W_ANSWER_PORTFOLIO_WITHHELD'));

/* —— g. 草稿数字校验失败 —— */
{
  const r = OUT.get('Q19');
  const s = JSON.stringify(r);
  check('g 草稿数字校验失败：NUMBERS_FAILED（checked=2 仅计数）且固定无数字降级', r.fallback_reason === 'W_ANSWER_NUMBERS_FAILED' && r.numbers_checked === 2 && r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT && !/[0-9０-９]/.test(r.text));
  check('g 草稿数字校验失败：草稿与失败数字原文不泄出', !s.includes('+99.9%') && !s.includes('¥999.00') && !s.includes('99.9') && !s.includes('实际收益 +99.9%'));
  check('g 草稿数字校验失败：trace 记录 draft(caller) → number_check(withheld)', r.trace.some((t) => t.step === 'draft' && t.source === 'caller') && r.trace.some((t) => t.step === 'number_check' && t.status === 'withheld' && t.code === 'W_ANSWER_NUMBERS_FAILED'));
}

/* —— h. 带数字草稿 + 上游失败 —— */
{
  const r = OUT.get('Q20');
  const s = JSON.stringify(r);
  check('h 上游失败+带数字草稿：固定无数字降级、草稿未被使用（无 draft 步）', r.fallback_reason === 'W_ANSWER_FACTS_INCOMPLETE' && r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT && !r.trace.some((t) => t.step === 'draft'));
  check('h 上游失败+带数字草稿：草稿及四事实数字均不泄出', !s.includes('+7.5%') && !s.includes('¥150.00') && !s.includes('组合实际收益 +7.5%'));
}

/* —— i. 成功数字只来自 facts —— */
{
  const review = buildFull();
  const allowed = exportFacts({ review, intent: 'loss_overview', scope: 'portfolio' }).facts
    .filter((f) => ['actualRet', 'ghostRet', 'drag', 'dragMoney'].includes(f.key));
  const r = OUT.get('Q01');
  const num = checkNumbers(r.text, { status: 'ok', facts: allowed });
  check('i 成功数字只来自 facts：可识别数字全部命中组合四事实（checked=4）', allowed.length === 4 && num.ok === true && num.checked === 4, JSON.stringify(num.failed));
  check('i 成功数字只来自 facts：不含四事实之外的组合 display（如成本/市值）', !r.text.includes('¥2,000.00') && !r.text.includes('¥2,150.00') && !r.text.includes('¥2,300.00'));
}

/* —— k. plan_id 与 buildPlan 一致 —— */
{
  const planCases = QUESTIONS.filter((q) => OUT.get(q.id).plan !== null);
  const ok = planCases.every((q) => {
    const expected = buildPlan({ question: q.question, intentJson: { intent: q.intent, slots: {}, confidence: 1 } });
    return OUT.get(q.id).plan.plan_id === expected.plan_id;
  });
  check(`k plan_id：${planCases.length} 条含计划用例均与 buildPlan 输出一致`, ok && planCases.length === 12);
}

/* —— l. plan.status=needs_context 的真实含义 —— */
{
  const plans = successes.map((r) => r.plan);
  check('l needs_context：计划仅留痕不执行（missing_params、无参数值、executed=false）', plans.every((p) => p.status === 'needs_context' && p.steps.length === 2 && p.steps.every((s) => s.status === 'missing_params' && !('params' in s)) && p.pending_params.length === 2) && successes.every((r) => r.trace.find((t) => t.step === 'plan').executed === false));
  check('l needs_context：不阻断事实快照链（成功回答不依赖计划执行、不重算）', successes.every((r) => r.answer_status === 'numbers_passed') && successes.every((r) => !('report' in r) && !JSON.stringify(r).includes('dual_path')));
}

/* —— m. trace 字段最小化 —— */
{
  const TRACE_KEYS = new Set(['step', 'status', 'code', 'checked', 'source', 'executed']);
  const TRACE_STEPS = new Set(['input', 'intent_scope_gate', 'plan', 'prepare_facts', 'draft', 'number_check', 'fallback']);
  const traces = all.flatMap((r) => r.trace);
  check('m trace：仅含步骤/状态/计数/错误码字段与已知步骤名', traces.every((t) => Object.keys(t).every((k) => TRACE_KEYS.has(k)) && TRACE_STEPS.has(t.step)));
  check('m trace：无时间戳/延迟/代理记录字段', traces.every((t) => ['ts', 'ms', 'latency', 'duration', 'call_record', 'proxy_record'].every((k) => !(k in t))));
}

/* —— n. 不输出原始交易、凭证或环境变量 —— */
{
  const s = JSON.stringify(all);
  const banned = ['T001', 'B101', 'mini.csv', 'trade_id', 'API_KEY', 'api_key', 'Authorization', 'DASHSCOPE', 'BAILIAN', 'process.env', 'token'];
  check('n 安全：20 条结果不含原始交易/文件/凭证/环境变量标记', banned.every((x) => !s.includes(x)), banned.filter((x) => s.includes(x)).join(','));
}

/* —— 所有降级文本固定且无数字 —— */
check('降级：全部 withheld 使用同一固定无数字文本', all.filter((r) => r.answer_status === 'withheld').every((r) => r.text === OFFLINE_DIALOGUE_FALLBACK_TEXT) && !/[0-9０-９]/.test(OFFLINE_DIALOGUE_FALLBACK_TEXT));

/* —— 已知限制如实记录（未解决，不宣称已理解中文数字） —— */
{
  const r = runOfflineDialogue({
    question: '组合实际收益是多少？',
    intent: 'loss_overview',
    scope: 'portfolio',
    review: buildFull(),
    answerDraft: '组合实际收益为百分之七点五。',
  });
  check('限制：中文数字不纳入识别 → checked=0 通过（未解决，不宣称已实现）', r.answer_status === 'numbers_passed' && r.numbers_checked === 0);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
