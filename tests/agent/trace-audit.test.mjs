#!/usr/bin/env node
/**
 * M2-C6 · 四类消息 trace 关联与 JSONL 导出（离线定向测试）
 *
 * 覆盖：
 *   · 一次成功问答：question → plan → tool_execution → review_result；
 *   · 复核未通过 + 无备用重算：review_result 携带真实 recompute_log，最终回答 withheld；
 *   · 在线复述路径：无 planner 时 plan 如实标 not_used；本地门禁拒绝时 outbound=false；
 *   · JSONL 恰四行、稳定、无问题原文/原始成交/文件名/凭据；样例标记 offline_sample。
 * 边界：只使用本地合成夹具、fake transport 与 runReview 实际输出；不调用真实模型/Tushare/网络。
 * 运行：node tests/agent/trace-audit.test.mjs
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { runOfflineDialogue } from '../../src/agent/offlineDialogue.js';
import { createChatOnline } from '../../src/agent/chatOnline.js';
import { createFakeTransport, jsonResponse } from './fake-online-transport.mjs';
import {
  buildChatTrace,
  exportTraceJsonl,
  TRACE_MESSAGE_TYPES,
  TRACE_AUDIT_CODES,
} from '../../src/agent/traceAudit.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '组合整体表现如何？';
const ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';
const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity, withSource = true) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  ...(withSource ? { source: { file: 'trace-synthetic.csv', line: 2 } } : {}),
});
const TRADES = (withSource = true) => [
  mk('T001', '2024-09-24', '000000', 'buy', 10, 100, withSource),
  mk('T002', '2024-09-27', '000000', 'sell', 11, 100, withSource),
  mk('B101', '2024-09-25', '888888', 'buy', 100, 10, withSource),
  mk('B102', '2024-09-30', '888888', 'sell', 105, 10, withSource),
];
const buildClean = () => runReview({ trades: TRADES(true), closes: { '000000': 12, '888888': 110 }, valuation: VAL });
const buildDirty = () => runReview({ trades: TRADES(false), closes: { '000000': 12, '888888': 110 }, valuation: VAL });

const messageTypes = (trace) => trace.messages.map((m) => m.type).join(',');
const toolSteps = (trace) => trace.messages[2].steps.map((s) => s.step).join(',');

/* ==== 成功问答：四类消息 + 可导出 ==== */
let clean;
let successTrace;
let successJsonl;
{
  const review = buildClean();
  const dialogue = runOfflineDialogue({
    question: QUESTION, intent: 'loss_overview', scope: 'portfolio', review,
  });
  successTrace = buildChatTrace({ question: QUESTION, dialogue, review, sample: true });
  clean = { review, dialogue };

  check('成功：trace 恰四类消息（question/plan/tool_execution/review_result）',
    successTrace.ok === true && successTrace.messages.length === 4
    && messageTypes(successTrace) === TRACE_MESSAGE_TYPES.join(','), messageTypes(successTrace));
  check('成功：问题消息只含哈希/范围，不含问题原文',
    successTrace.messages[0].question_hash.length === 16
    && !JSON.stringify(successTrace.messages[0]).includes(QUESTION)
    && successTrace.messages[0].outbound === false, JSON.stringify(successTrace.messages[0]));
  check('成功：计划消息含 plan_id/模板/工具，且仅留痕不执行',
    successTrace.messages[1].status === 'needs_context'
    && String(successTrace.messages[1].plan_id).startsWith('plan-')
    && successTrace.messages[1].steps.map((s) => s.tool).join(',') === 'indicators.compute,decompose.drag'
    && successTrace.messages[1].executed === false, JSON.stringify(successTrace.messages[1]));
  check('成功：工具消息记录 prepare_facts → draft → number_check',
    toolSteps(successTrace) === 'prepare_facts,draft,number_check'
    && successTrace.messages[2].steps.map((s) => s.status).join(',') === 'prepared,generated,passed',
    JSON.stringify(successTrace.messages[2]));
  check('成功：复核消息含 verify_id/发布计数/无重算，最终回答 numbers_passed',
    successTrace.messages[3].review.status === 'published'
    && String(successTrace.messages[3].review.verify_id).startsWith('V-')
    && successTrace.messages[3].review.portfolio_published === true
    && successTrace.messages[3].review.published_count > 0
    && successTrace.messages[3].review.recompute_log.length === 0
    && successTrace.messages[3].verification.status === 'numbers_passed'
    && successTrace.messages[3].verification.numbers_checked === 4,
    JSON.stringify(successTrace.messages[3]));

  successJsonl = exportTraceJsonl(successTrace);
  const lines = successJsonl.ok ? successJsonl.jsonl.split('\n') : [];
  check('导出：JSONL 恰四行且每行可解析/索引正确',
    successJsonl.ok === true && lines.length === 4
    && lines.map((l) => JSON.parse(l).message_index).join(',') === '1,2,3,4'
    && lines.map((l) => JSON.parse(l).message_type).join(',') === TRACE_MESSAGE_TYPES.join(','),
    JSON.stringify(successJsonl).slice(0, 300));
  check('导出：样例标记 offline_sample / offline_fallback',
    successTrace.sample_kind === 'offline_sample' && successTrace.llm_mode === 'offline_fallback'
    && JSON.parse(lines[0]).sample_kind === 'offline_sample');
  const again = exportTraceJsonl(buildChatTrace({ question: QUESTION, dialogue: clean.dialogue, review: clean.review, sample: true }));
  check('导出：同一输入重复导出完全一致', again.ok === true && again.jsonl === successJsonl.jsonl);
}

/* ==== 复核未通过 + 重算回流：真实 recompute_log 进入第四条消息 ==== */
{
  const review = buildDirty();
  const dialogue = runOfflineDialogue({
    question: QUESTION, intent: 'loss_overview', scope: 'portfolio', review,
  });
  const trace = buildChatTrace({ question: QUESTION, dialogue, review, sample: true });
  const rr = trace.messages[3];
  check('回流：复核 blocked 且真实 recompute_log 进入 review_result',
    rr.review.available === true && rr.review.status === 'blocked'
    && rr.review.recompute_log.length === 1
    && rr.review.recompute_log[0].result === 'no_alternative'
    && rr.review.recompute_log[0].final_status === 'aborted'
    && rr.review.recompute_log[0].code === 'E_REVIEW_RECOMPUTE_NO_ALTERNATIVE',
    JSON.stringify(rr.review));
  check('回流：工具消息停在 prepare_facts(withheld)，最终回答 withheld 且无数字',
    toolSteps(trace) === 'prepare_facts'
    && trace.messages[2].steps[0].status === 'withheld'
    && trace.messages[2].steps[0].code === 'W_ANSWER_PORTFOLIO_WITHHELD'
    && rr.verification.status === 'withheld'
    && rr.verification.fallback_reason === 'W_ANSWER_PORTFOLIO_WITHHELD'
    && !/[0-9０-９]/.test(String(rr.final.text ?? '')), JSON.stringify(rr.verification));
  const jsonl = exportTraceJsonl(trace);
  check('回流：四类消息仍完整导出', jsonl.ok === true && jsonl.line_count === 4);
}

/* ==== 在线复述路径：无 planner 时如实标 not_used；门禁拒绝零出站 ==== */
{
  const review = buildClean();
  const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: ANSWER }) });
  const chat = createChatOnline({ transport, timeoutMs: 3000 });
  const onlineOk = await chat.ask({ question: QUESTION, review });
  const traceOk = buildChatTrace({
    question: QUESTION, online: onlineOk, review,
    intent: 'loss_overview', scope: 'portfolio', llmMode: 'test_fake', sample: true,
  });
  check('在线：无 planner 时 plan=not_used（不补造计划）',
    onlineOk.ok === true && traceOk.messages[1].status === 'not_used'
    && traceOk.messages[1].plan_id === null && traceOk.messages[1].executed === false,
    JSON.stringify(traceOk.messages[1]));
  check('在线：问题消息 outbound=true，工具消息记录 restate，最终数字核对 4/4',
    traceOk.messages[0].outbound === true
    && traceOk.messages[2].steps[0].step === 'restate' && traceOk.messages[2].steps[0].status === 'ok'
    && traceOk.messages[3].verification.status === 'numbers_passed'
    && traceOk.messages[3].verification.number_check.checked === 4
    && traceOk.messages[3].final.text === ANSWER,
    JSON.stringify(traceOk.messages[3]));

  const blockedQuestion = '组合收益会涨吗？';
  // 入口层现在负责范围拦截；chatOnline 保持 main 的在线边界实现。
  const onlineBlocked = {
    ok: false,
    stage: 'scope',
    code: 'W_CHAT_SCOPE_UNSUPPORTED',
    message: '当前问题不在在线复述范围（仅支持组合整体表现的四项结果）；未发送问题或事实',
  };
  const traceBlocked = buildChatTrace({
    question: blockedQuestion, online: onlineBlocked, review,
    intent: 'loss_overview', scope: 'portfolio', llmMode: 'test_fake', sample: true,
  });
  check('在线门禁（入口层）：outbound=false，工具消息记录 scope 拒绝，最终无文本',
    onlineBlocked.ok === false && onlineBlocked.code === 'W_CHAT_SCOPE_UNSUPPORTED'
    && traceBlocked.messages[0].outbound === false
    && traceBlocked.messages[2].steps[0].step === 'scope'
    && traceBlocked.messages[2].steps[0].status === 'withheld'
    && traceBlocked.messages[2].steps[0].code === 'W_CHAT_SCOPE_UNSUPPORTED'
    && traceBlocked.messages[3].final.text === null,
    JSON.stringify(traceBlocked.messages[2]));
}

/* ==== 隐私/无效输入 ==== */
{
  const jsonl = successJsonl.ok ? successJsonl.jsonl : '';
  const banned = ['组合整体表现如何', 'T001', 'B101', 'trace-synthetic.csv', 'API_KEY', 'Authorization', 'DASHSCOPE', 'process.env'];
  check('隐私：导出不含问题原文/原始成交/文件名/凭据标记',
    banned.every((x) => !jsonl.includes(x)), banned.filter((x) => jsonl.includes(x)).join(','));
  check('无效输入：dialogue 与 online 必须恰有一个',
    buildChatTrace({ question: QUESTION }).ok === false
    && buildChatTrace({ question: QUESTION }).code === TRACE_AUDIT_CODES.INPUT_INVALID
    && buildChatTrace({ question: QUESTION, dialogue: clean.dialogue, online: { ok: true } }).ok === false);
  check('无效输入：非四类消息的 trace 不导出',
    exportTraceJsonl({ ok: true, messages: [] }).ok === false
    && exportTraceJsonl({ ok: true, messages: [{ type: 'question' }] }).code === TRACE_AUDIT_CODES.EXPORT_INVALID);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
