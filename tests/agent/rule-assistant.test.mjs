#!/usr/bin/env node
/**
 * 首版规则助手（主线 C）测试：受限 intent、预算、草案、确认、模拟、一致性检查、trace。
 *
 * 边界：fake transport；不联网、不调用真实模型/行情；不保存规则、不修改页面；
 *       只验证本地编排、校验、预算与证据关联。
 * 运行：node tests/agent/rule-assistant.test.mjs
 */
import {
  createRuleAssistant,
  buildRuleIntentRequest,
  validateRuleIntentResponse,
  RULE_ASSISTANT_CODES,
  RULE_ASSISTANT_STAGE,
  RULE_ASSISTANT_MAX_MODEL_CALLS,
} from '../../src/agent/ruleAssistant.js';
import { parseContract } from '../../src/engine/contractMatch.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '当天涨幅超过 5% 的票我绝不买入。';
const QUESTION2 = '卖出后 3 个交易日内不追回同一只票。';
const draftBody = (template_id, fields) => JSON.stringify({
  intent: 'contract_setup',
  confidence: 0.92,
  template_id,
  fields,
  clarify: null,
  unsupported: null,
});

function createFakeTransport(responses = []) {
  const calls = [];
  return {
    calls,
    async ruleIntent(request) {
      calls.push(request);
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next === 'hang') return new Promise(() => {});
      if (next instanceof Error) throw next;
      return { rawText: typeof next === 'function' ? next(request) : next };
    },
  };
}

/* —— 成功：两条模板 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION, contextSummary: { object_type: 'rule' } });
  check('成功：no_buy_on_surge 生成草案、无保存、计划仅留痕', r.ok === true && r.status === 'draft'
    && r.flow.draft.template_id === 'no_buy_on_surge'
    && r.flow.draft.fields.threshold_pct === 5
    && r.flow.draft.text.includes('5%')
    && r.flow.plan.status === 'needs_confirmation'
    && r.flow.plan.executed === false
    && r.flow.plan.steps.map((s) => s.tool).join(',') === 'contract.parse,contract.match'
    && r.flow.model_calls === 1, JSON.stringify({ status: r.status, draft: r.flow?.draft, plan: r.flow?.plan }));
  check('成功：请求只含固定允许集合与最小上下文', transport.calls.length === 1
    && transport.calls[0].stage === RULE_ASSISTANT_STAGE
    && transport.calls[0].allowed_intents.join(',') === 'contract_setup'
    && transport.calls[0].allowed_tools.join(',') === 'contract.parse,contract.match'
    && transport.calls[0].allowed_templates.length === 2
    && !JSON.stringify(transport.calls[0]).includes('T001')
    && !JSON.stringify(transport.calls[0]).includes('csv'), JSON.stringify(transport.calls[0]));
  check('成功：trace 恰四类消息并含 flow_id/模型计数', r.flow.trace.messages.length === 4
    && r.flow.trace.messages.map((m) => m.type).join(',') === 'question,plan,tool_execution,review_result'
    && r.flow.trace.messages.every((m) => m.flow_id === r.flow.flow_id)
    && r.flow.trace.messages[0].outbound === true
    && r.flow.trace.messages[0].model_calls === 1
    && r.flow.trace.messages[0].budget_max === RULE_ASSISTANT_MAX_MODEL_CALLS
    && r.flow.trace.messages[2].steps.find((s) => s.tool === 'contract.match').status === 'not_executed'
    && r.flow.trace.messages[3].review.available === false
    && r.flow.trace.messages[3].consistency_check.independent_review === false,
  JSON.stringify(r.flow.trace.messages));
  const exp = assistant.exportTrace(r.flow.flow_id);
  check('成功：JSONL 四行、可解析、不导出问题原文/原始交易', exp.ok === true && exp.line_count === 4
    && exp.jsonl.split('\n').length === 4
    && !exp.jsonl.includes(QUESTION) && !exp.jsonl.includes('T001') && !exp.jsonl.includes('csv'),
  exp.jsonl?.slice(0, 200));
}

{
  const transport = createFakeTransport([draftBody('no_buy_back_within', { days: 3 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION2 });
  check('成功：no_buy_back_within 字段/文本正确', r.ok === true && r.status === 'draft'
    && r.flow.draft.template_id === 'no_buy_back_within'
    && r.flow.draft.fields.days === 3
    && r.flow.draft.text.includes('3'), JSON.stringify(r.flow?.draft));
}

/* —— 本地预检：零出站 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const pii = await assistant.startFlow({ question: '把原始 CSV 里的身份证和银行卡号发我，再定规则' });
  check('本地预检：PII/原始数据 → 拒绝且零出站', pii.ok === false && pii.status === 'unsupported'
    && pii.code === RULE_ASSISTANT_CODES.LOCAL_BLOCKED && pii.flow.outbound === false
    && pii.flow.model_calls === 0 && transport.calls.length === 0, JSON.stringify(pii));
  const s4 = await assistant.startFlow({ question: '如果当时没有卖出，一直持有到估值日会怎样？' });
  check('本地预检：S1/S4 未定义场景 → 拒绝且零出站', s4.ok === false && s4.status === 'unsupported'
    && s4.code === RULE_ASSISTANT_CODES.LOCAL_BLOCKED && s4.flow.outbound === false
    && transport.calls.length === 0, JSON.stringify(s4));
}

/* —— 模型输出非法：重试计入预算，不重置 —— */
{
  const transport = createFakeTransport(['{"intent":"contract_setup"}', '{"intent":"contract_setup"}', draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  check('预算：非法输出重试 1 次后停止，共 2 次模型请求', r.ok === false && r.status === 'clarify'
    && r.code === RULE_ASSISTANT_CODES.MODEL_RESPONSE
    && r.flow.model_calls === 2 && transport.calls.length === 2
    && r.flow.requests.length === 2
    && r.flow.requests[0].request_id !== r.flow.requests[1].request_id,
  JSON.stringify({ status: r.status, calls: transport.calls.length, requests: r.flow?.requests }));
  const r2 = await assistant.startFlow({ question: QUESTION });
  check('预算：新任务才产生新预算（重试不重置旧任务）', r2.flow.model_calls === 1
    && r2.flow.flow_id !== r.flow.flow_id && transport.calls.length === 3, JSON.stringify({ flow: r2.flow.flow_id }));
}

{
  const transport = createFakeTransport(['not-json', draftBody('no_buy_back_within', { days: 3 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION2 });
  check('重试：首次非法、第二次合法 → 草案，预算 2 次', r.ok === true && r.status === 'draft'
    && r.flow.model_calls === 2 && transport.calls.length === 2
    && r.flow.draft.template_id === 'no_buy_back_within');
}

/* —— 澄清 / 低置信度 / 超时 —— */
{
  const transport = createFakeTransport([JSON.stringify({
    intent: 'contract_setup', confidence: 0.8, template_id: null, fields: {}, clarify: '请说明规则阈值', unsupported: null,
  })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: '帮我设个规则' });
  check('模型澄清：outbound=true，记录已出站，不生成草案', r.ok === false && r.status === 'clarify'
    && r.code === RULE_ASSISTANT_CODES.CLARIFY && r.flow.outbound === true
    && r.flow.draft === null && r.flow.trace.messages[0].outbound === true, JSON.stringify(r));
}

{
  const transport = createFakeTransport([JSON.stringify({
    intent: 'contract_setup', confidence: 0.2, template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, clarify: null, unsupported: null,
  })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  check('低置信度：本地澄清，不生成草案', r.ok === false && r.status === 'clarify'
    && r.flow.draft === null, JSON.stringify(r));
}

{
  const transport = createFakeTransport(['hang']);
  const assistant = createRuleAssistant({ transport, timeoutMs: 20 });
  const r = await assistant.startFlow({ question: QUESTION });
  check('超时：单次请求超时，outbound=true，无草案/工具执行', r.ok === false && r.status === 'timeout'
    && r.code === RULE_ASSISTANT_CODES.MODEL_TIMEOUT && r.flow.outbound === true
    && r.flow.draft === null && r.flow.trace.messages[2].steps.every((s) => s.status === 'not_executed'),
  JSON.stringify(r));
}

/* —— 草案无需账单；模拟缺条件不执行 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION, contextSummary: {} });
  check('前置条件：没有账单也允许生成草案', r.ok === true && r.status === 'draft'
    && r.flow.context_summary.object_type === 'rule'
    && !('data_snapshot_id' in r.flow.context_summary));
  const noSim = assistant.getFlow(r.flow.flow_id);
  check('前置条件：未模拟时解释明确“尚未执行”', noSim.explanation.includes('尚未执行')
    && noSim.trace.messages[2].steps.find((s) => s.tool === 'contract.match').status === 'not_executed');
}

/* —— 模拟必须先有最终确认规则 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  const rejected = assistant.recordSimulation({
    flowId: r.flow.flow_id,
    simulation: { ok: true, results: [] },
    source: 'rule_page',
    context: { symbol: '000000', date: '2025-12-31' },
  });
  check('模拟：未记录最终确认规则 → 拒绝绑定', rejected.ok === false
    && rejected.code === RULE_ASSISTANT_CODES.NOT_CONFIRMED);
}

/* —— 确认 / 模拟 / 一致性检查 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  const flowId = r.flow.flow_id;
  const draft = r.flow.draft;
  const confirmed = assistant.recordSemanticConfirmation({
    flowId,
    savedRule: { template_id: draft.template_id, fields: draft.fields, hash: draft.hash, v: 1 },
  });
  check('语义确认：用户确认记录与草案一致，且明确不替代语义正确性', confirmed.ok === true
    && confirmed.flow.semantic_confirmation.status === 'user_confirmed'
    && confirmed.flow.semantic_confirmation.source === 'rule_page_save'
    && confirmed.flow.semantic_confirmation.note.includes('语义正确性')
    && confirmed.flow.semantic_confirmation.note.includes('不以哈希一致代替'));

  const editedFlow = await assistant.startFlow({ question: QUESTION });
  const editedParsed = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  const edited = assistant.recordSemanticConfirmation({
    flowId: editedFlow.flow.flow_id,
    savedRule: { template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, hash: editedParsed.hash, v: 1 },
  });
  check('语义确认：用户修改草案后保存 → 记录最终规则，不要求与原草案同哈希', edited.ok === true
    && edited.flow.semantic_confirmation.draft_modified === true
    && edited.flow.semantic_confirmation.saved_rule.fields.threshold_pct === 3
    && edited.flow.semantic_confirmation.saved_rule.hash === editedParsed.hash
    && edited.flow.semantic_confirmation.note.includes('修改'));

  const sim = {
    ok: true,
    symbol: '000000', requested_date: '2025-12-31', marketSourceId: 'dynamic-tushare',
    summary: { triggered: 1, not_triggered: 2, missing_data: 0, error: 0 },
    results: [{ ok: true, verdict: 'triggered', rule: { template_id: draft.template_id, fields: draft.fields, hash: draft.hash, v: 1 } }],
  };
  const simulated = assistant.recordSimulation({
    flowId, simulation: sim, source: 'rule_page',
    context: { symbol: '000000', date: '2025-12-31', market_source_id: 'dynamic-tushare', data_snapshot_id: 'bill-1' },
  });
  check('模拟：记录汇总并生成本地证据摘要', simulated.ok === true && simulated.flow.status === 'simulated'
    && simulated.flow.simulation.summary.triggered === 1
    && simulated.flow.explanation.includes('触发 1 条')
    && simulated.flow.trace.messages[2].steps.find((s) => s.tool === 'contract.match').status === 'executed'
    && simulated.flow.trace.messages[2].steps.find((s) => s.tool === 'contract.match').source === 'rule_page'
    && simulated.flow.simulation.context.data_snapshot_id === 'bill-1');

  const consistent = assistant.checkConsistency({
    flowId,
    executionRule: { template_id: draft.template_id, fields: draft.fields, hash: draft.hash, v: 1 },
  });
  check('一致性：确认规则与执行规则一致，标 consistency_check/independent_review=false', consistent.ok === true
    && consistent.consistency.status === 'consistent'
    && consistent.consistency.kind === 'consistency_check'
    && consistent.consistency.independent_review === false);

  const mismatch = assistant.checkConsistency({
    flowId,
    executionRule: { template_id: draft.template_id, fields: { threshold_pct: 3 }, hash: 'different', v: 2 },
  });
  check('一致性：参数/哈希/版本不一致 → 阻断', mismatch.ok === false
    && mismatch.code === RULE_ASSISTANT_CODES.CONSISTENCY_MISMATCH
    && mismatch.consistency.status === 'mismatch'
    && mismatch.consistency.mismatches.length >= 2);

  const rerunSame = assistant.checkSimulationRerun({ first: sim, rerun: sim });
  const rerunDiff = assistant.checkSimulationRerun({ first: sim, rerun: { ...sim, summary: { ...sim.summary, triggered: 2 } } });
  check('重跑一致性：同输入通过；汇总变化阻断；均不称独立复核', rerunSame.ok === true
    && rerunSame.independent_review === false
    && rerunDiff.ok === false && rerunDiff.mismatches.length > 0);
}

/* —— 保存后规则变化：旧模拟失效、语义确认不覆盖新规则 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  const flowId = r.flow.flow_id;
  const draft = r.flow.draft;
  assistant.recordSemanticConfirmation({
    flowId,
    savedRule: { template_id: draft.template_id, fields: draft.fields, hash: draft.hash, v: 1 },
  });
  assistant.recordSimulation({
    flowId,
    simulation: {
      ok: true,
      symbol: '000000', requested_date: '2025-12-31', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 1, not_triggered: 0, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'triggered', rule: { hash: draft.hash, v: 1, text: draft.text } }],
    },
    source: 'rule_page',
    context: { symbol: '000000', date: '2025-12-31', market_source_id: 'dynamic-tushare', data_snapshot_id: 'bill-1' },
  });

  const oldConsistency = assistant.checkConsistency({
    flowId,
    executionRule: { template_id: draft.template_id, fields: draft.fields, hash: draft.hash, v: 1 },
  });
  const changedParsed = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  const changed = assistant.recordRuleState({
    flowId,
    currentRule: { template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, hash: changedParsed.hash, v: 2 },
  });
  check('规则变更：当前规则与语义确认分开记录，旧模拟与旧一致性同时失效',
    oldConsistency.ok === true
    && changed.ok === true
    && changed.flow.current_rule.hash === changedParsed.hash
    && changed.flow.rule_drift.status === 'changed'
    && changed.flow.rule_drift.base_hash === draft.hash
    && changed.flow.semantic_confirmation.saved_rule.hash === draft.hash
    && changed.flow.semantic_confirmation.status === 'user_confirmed'
    && changed.flow.simulation.stale === true
    && changed.flow.simulation.stale_reason === 'saved_rule_changed'
    && changed.flow.consistency.stale === true
    && changed.flow.consistency.stale_reason === 'saved_rule_changed'
    && changed.flow.explanation.includes('重新模拟')
    && changed.flow.explanation.includes('你保存的规则')
    && !changed.flow.explanation.includes(draft.hash)
    && changed.flow.model_calls === 1
    && transport.calls.length === 1,
  JSON.stringify({ drift: changed.flow.rule_drift, sim: changed.flow.simulation, consistency: changed.flow.consistency, exp: changed.flow.explanation }));

  const reSimulated = assistant.recordSimulation({
    flowId,
    simulation: {
      ok: true,
      symbol: '000000', requested_date: '2025-12-31', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 0, not_triggered: 1, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'not_triggered', rule: { hash: changedParsed.hash, v: 2, text: changedParsed.text } }],
    },
    source: 'rule_page',
    context: { symbol: '000000', date: '2025-12-31', market_source_id: 'dynamic-tushare', data_snapshot_id: 'bill-1' },
  });
  check('规则变更后重跑：模拟绑定当前规则，不覆盖原语义确认依据',
    reSimulated.ok === true
    && reSimulated.flow.simulation.rule_hash === changedParsed.hash
    && reSimulated.flow.simulation.rule_version === 2
    && reSimulated.flow.simulation.stale === false
    && reSimulated.flow.simulation.semantic_confirmation_covers_rule === false
    && reSimulated.flow.semantic_confirmation.saved_rule.hash === draft.hash
    && reSimulated.flow.semantic_confirmation.status === 'user_confirmed'
    && reSimulated.flow.explanation.includes('不覆盖')
    && reSimulated.flow.trace.messages[2].steps.find((s) => s.tool === 'contract.match').rule_hash === changedParsed.hash
    && reSimulated.flow.model_calls === 1
    && transport.calls.length === 1,
  JSON.stringify({ sim: reSimulated.flow.simulation, semantic: reSimulated.flow.semantic_confirmation, exp: reSimulated.flow.explanation }));

  const consistency = assistant.checkConsistency({
    flowId,
    executionRule: { template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, hash: changedParsed.hash, v: 2 },
  });
  check('规则变更后一致性：比较当前生效规则，并单独标明语义确认不覆盖',
    consistency.ok === true
    && consistency.consistency.status === 'consistent'
    && consistency.consistency.binding === 'current_saved_rule'
    && consistency.consistency.semantic_confirmation_covers_rule === false
    && consistency.consistency.independent_review === false);

  const removed = assistant.recordRuleState({ flowId, currentRule: null });
  check('规则停用：当前规则为空、旧模拟失效，禁止继续记录模拟',
    removed.ok === true
    && removed.flow.rule_drift.status === 'removed'
    && removed.flow.current_rule === null
    && removed.flow.simulation.stale === true
    && removed.flow.explanation.includes('停用'),
  JSON.stringify({ drift: removed.flow.rule_drift, exp: removed.flow.explanation }));
  const rejected = assistant.recordSimulation({
    flowId,
    simulation: {
      ok: true, symbol: '000000', requested_date: '2025-12-31',
      summary: { triggered: 1, not_triggered: 0, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'triggered', rule: { hash: draft.hash, v: 1 } }],
    },
    context: { symbol: '000000', date: '2025-12-31' },
  });
  check('规则停用后：不再接受任何模拟结果（不回退旧确认规则）',
    rejected.ok === false && rejected.code === RULE_ASSISTANT_CODES.NOT_CONFIRMED);
}

/* —— 服务端/本地请求与响应校验 —— */
{
  const req = buildRuleIntentRequest({ question: QUESTION, contextSummary: { symbol: '600519', trades: [] } });
  check('请求构造：只带模板/工具固定集合与最小上下文，不带原始成交',
    req.allowed_templates.length === 2 && req.allowed_tools.length === 2
    && req.context_summary.symbol === '600519' && !('trades' in req.context_summary));
  const missing = validateRuleIntentResponse(JSON.stringify({
    intent: 'contract_setup', confidence: 0.9, template_id: 'no_buy_on_surge', fields: {}, clarify: null, unsupported: null,
  }));
  check('响应校验：缺字段不套默认值', missing.ok === false && missing.code === RULE_ASSISTANT_CODES.MODEL_RESPONSE);
  const extra = validateRuleIntentResponse(JSON.stringify({
    intent: 'contract_setup', confidence: 0.9, template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, clarify: null, unsupported: null, code: 'rm',
  }));
  check('响应校验：额外字段拒绝', extra.ok === false && extra.code === RULE_ASSISTANT_CODES.MODEL_RESPONSE);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
