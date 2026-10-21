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
import { parseRuleSpec } from '../../src/engine/ruleSpec.js';

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

/* —— 限定股票：保存身份、旧结果失效与原语义确认保留 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  const flowId = r.flow.flow_id;
  const scoped = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, scope: { kind: 'symbol', symbol: '600519' } });
  const confirmed = assistant.recordSemanticConfirmation({
    flowId,
    savedRule: { template_id: scoped.template_id, fields: scoped.fields, hash: scoped.hash, scope: scoped.scope, v: 1 },
  });
  check('限定股票：保存后助手识别 scope 与 contract-v2 身份',
    confirmed.ok === true
    && confirmed.flow.semantic_confirmation.saved_rule.scope.kind === 'symbol'
    && confirmed.flow.semantic_confirmation.saved_rule.scope.symbol === '600519'
    && confirmed.flow.semantic_confirmation.saved_rule.hash === scoped.hash
    && confirmed.flow.semantic_confirmation.draft_modified === true
    && confirmed.flow.current_rule.scope.symbol === '600519',
  JSON.stringify(confirmed.flow?.semantic_confirmation));

  const simulated = assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-09-27', marketSourceId: 'synthetic-fixture',
      summary: { triggered: 1, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 0 },
      results: [{ ok: true, verdict: 'triggered', display_verdict: 'triggered', rule: { hash: scoped.hash, template_id: scoped.template_id } }],
    },
    context: { symbol: '600519', date: '2024-09-27', market_source_id: 'synthetic-fixture' },
  });
  check('限定股票：模拟按 scope 哈希绑定并记录执行完成',
    simulated.ok === true && simulated.status === 'simulated'
    && simulated.flow.simulation.rule_scope.symbol === '600519'
    && simulated.flow.simulation.summary.triggered === 1
    && simulated.flow.simulation.status === 'completed',
  JSON.stringify(simulated.flow?.simulation));

  const next = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 6 }, scope: { kind: 'symbol', symbol: '600519' } });
  const changed = assistant.recordRuleState({
    flowId,
    currentRule: { template_id: next.template_id, fields: next.fields, hash: next.hash, scope: next.scope, v: 2 },
  });
  check('限定股票：调整后当前规则 v2、旧模拟/一致性失效、原语义确认仍指向 v1',
    changed.ok === true
    && changed.flow.rule_drift.status === 'changed'
    && changed.flow.current_rule.hash === next.hash
    && changed.flow.semantic_confirmation.saved_rule.hash === scoped.hash
    && changed.flow.simulation.stale === true
    && changed.flow.explanation.includes('不覆盖'),
  JSON.stringify({ drift: changed.flow.rule_drift, sim: changed.flow.simulation, semantic: changed.flow.semantic_confirmation?.saved_rule }));
}

/* —— 模拟接收：逐项 ok、不适用与失败，不要求全部命中 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const r = await assistant.startFlow({ question: QUESTION });
  const flowId = r.flow.flow_id;
  const draft = r.flow.draft;
  assistant.recordSemanticConfirmation({ flowId, savedRule: { ...draft, v: 1 } });

  const failed = assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-09-27',
      summary: { triggered: 0, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 1 },
      results: [{ ok: false, verdict: null, display_verdict: 'error', code: 'E_MARKET_SOURCE', message: '行情不可用', rule: { hash: draft.hash, template_id: draft.template_id } }],
    },
    context: { symbol: '600519', date: '2024-09-27' },
  });
  check('模拟失败：按逐项 ok 判失败，保留为本次尝试，不冒充有效结果',
    failed.ok === true && failed.status === 'simulation_failed'
    && failed.flow.status === 'simulation_failed'
    && failed.flow.simulation === null
    && failed.flow.simulationAttempt.status === 'failed'
    && failed.flow.simulationAttempt.summary.error === 1
    && failed.flow.explanation.includes('本次模拟执行失败'),
  JSON.stringify({ status: failed.status, sim: failed.flow?.simulationAttempt }));

  const notApplicable = assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-09-27',
      summary: { triggered: 0, not_triggered: 0, missing_data: 0, not_applicable: 1, error: 0 },
      results: [{ ok: true, verdict: 'not_applicable', display_verdict: 'not_applicable', code: 'I_RULE_ACTION_NOT_APPLICABLE', message: '本次是卖出情境', rule: { hash: draft.hash, template_id: draft.template_id } }],
    },
    context: { symbol: '600519', date: '2024-09-27' },
  });
  check('模拟不适用：执行完成但仍保留不适用计数与原因，不要求命中',
    notApplicable.ok === true && notApplicable.status === 'simulated'
    && notApplicable.flow.simulation.status === 'completed'
    && notApplicable.flow.simulation.summary.not_applicable === 1
    && notApplicable.flow.simulation.summary.triggered === 0
    && notApplicable.flow.simulation.results[0].code === 'I_RULE_ACTION_NOT_APPLICABLE'
    && notApplicable.flow.simulationAttempt === null,
  JSON.stringify(notApplicable.flow?.simulation));

  const consistency = assistant.checkConsistency({
    flowId,
    executionRule: { template_id: draft.template_id, fields: draft.fields, hash: draft.hash, v: 1, scope: { kind: 'all' } },
  });
  check('一致性：只说明规则/输入依据，不宣称模拟成功或独立复核',
    consistency.ok === true
    && consistency.consistency.status === 'consistent'
    && consistency.consistency.independent_review === false
    && consistency.consistency.note.includes('不代表模拟执行成功')
    && consistency.consistency.note.includes('不是独立复核'),
  JSON.stringify(consistency.consistency));
}

/* —— 两入口共享模型预算：同一 flow 不能换入口刷新 —— */
{
  const transport = createFakeTransport([draftBody('no_buy_on_surge', { threshold_pct: 5 })]);
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const started = await assistant.startFlow({ question: QUESTION });
  const flowId = started.flow.flow_id;
  const external = assistant.recordExternalModelCall({ flowId, stage: 'rule_nl', status: 'ok' });
  const exhausted = assistant.recordExternalModelCall({ flowId, stage: 'rule_nl', status: 'ok' });
  check('预算边界：助手 flow 已用 1 次后，规则页入口只能再用 1 次，第三次阻断',
    external.ok === true && external.flow.model_calls === 2
    && exhausted.ok === false && exhausted.code === RULE_ASSISTANT_CODES.BUDGET_EXHAUSTED
    && external.flow.budget_max === RULE_ASSISTANT_MAX_MODEL_CALLS,
  JSON.stringify({ external, exhausted }));

  const independent = assistant.beginExternalFlow({ stage: 'rule_nl' });
  const first = assistant.recordExternalModelCall({ flowId: independent.flow_id, status: 'ok' });
  const second = assistant.recordExternalModelCall({ flowId: independent.flow_id, status: 'ok' });
  const third = assistant.recordExternalModelCall({ flowId: independent.flow_id, status: 'ok' });
  check('预算边界：独立规则任务各自 2 次，用完即阻断',
    independent.flow_id !== flowId
    && first.ok === true && second.ok === true && third.ok === false
    && third.code === RULE_ASSISTANT_CODES.BUDGET_EXHAUSTED,
  JSON.stringify({ independent: independent.flow_id, third }));
}

/* —— 结果解释：canonical、绑定、预算与失效 —— */
{
  const explanationCalls = [];
  const transport = {
    async ruleIntent() { return { rawText: draftBody('no_buy_on_surge', { threshold_pct: 5 }) }; },
    async resultExplanation(payload) {
      explanationCalls.push(payload);
      const binding = {
        flow_id: payload.flow_id,
        request_id: payload.request_id,
        rule_version: payload.rule.version,
        rule_hash: payload.rule.hash,
        scope: payload.rule.scope,
        simulation_result_id: payload.simulation.result_id,
      };
      return { rawText: JSON.stringify({ answer_text: '本次模拟执行完成，结果为 triggered。', binding }) };
    },
  };
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const started = await assistant.startFlow({ question: QUESTION });
  const flowId = started.flow.flow_id;
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  assistant.recordSemanticConfirmation({ flowId, savedRule: { ...saved, v: 1 } });
  const simulated = assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
      results: [{ ok: true, verdict: 'triggered', display_verdict: 'triggered', code: null, message: '命中', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
    context: { symbol: '600519', date: '2024-10-01', market_source_id: 'dynamic-tushare' },
  });
  const resultId = simulated.flow.simulation.result_id;
  const eligibility = assistant.getExplanationEligibility(flowId);
  const explained = await assistant.explainSimulationResult({ flowId, requestId: 'assistant-explain-1' });
  const review = explained.flow?.trace?.messages?.find((m) => m.type === 'review_result');
  const sent = { ...explanationCalls[0] };
  delete sent.signal;
  check('结果解释：成功模拟可解释；请求仅含白名单结构化事实',
    eligibility.ok === true
    && explained.ok === true
    && explanationCalls.length === 1
    && Object.keys(sent).sort().join(',') === 'flow_id,request_id,rule,simulation,stage'
    && Object.keys(sent.simulation.results[0]).sort().join(',') === 'code,display_verdict,effective_date,message,requested_date,verdict'
    && !JSON.stringify(sent).includes('fileName')
    && !JSON.stringify(sent).includes('trades')
    && explained.flow.model_calls === 2,
  JSON.stringify({ eligibility, payload: sent, calls: explained.flow?.model_calls }));

  check('结果解释：绑定 flow/request/版本/哈希/scope/result_id，且不改语义确认',
    explained.ok === true
    && explained.explanation.binding.flow_id === flowId
    && explained.explanation.binding.request_id === 'assistant-explain-1'
    && explained.explanation.binding.rule_hash === saved.hash
    && explained.explanation.binding.rule_version === 1
    && explained.explanation.binding.scope.kind === 'all'
    && explained.explanation.binding.simulation_result_id === resultId
    && explained.flow.semantic_confirmation.saved_rule.hash === saved.hash
    && review?.result_explanation?.stage === 'result_explanation'
    && review?.result_explanation?.answer_text.includes('triggered')
    && review?.consistency_check?.independent_review === false,
  JSON.stringify({ explanation: explained.explanation, review }));

  const next = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 6 } });
  const changed = assistant.recordRuleState({
    flowId,
    currentRule: { template_id: next.template_id, fields: next.fields, hash: next.hash, v: 2 },
  });
  check('结果解释：规则变化后旧解释失效，不能复用',
    changed.ok === true
    && changed.flow.result_explanation === null
    && changed.flow.result_explanation_attempt?.status === 'stale'
    && assistant.getExplanationEligibility(flowId).ok === false,
  JSON.stringify({ changed: changed.flow?.result_explanation, attempt: changed.flow?.result_explanation_attempt }));
}

{
  const calls = [];
  const transport = {
    async ruleIntent() { return { rawText: draftBody('no_buy_on_surge', { threshold_pct: 5 }) }; },
    async resultExplanation(payload) {
      calls.push(payload);
      return { rawText: 'not-json' };
    },
  };
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const started = await assistant.startFlow({ question: QUESTION });
  const flowId = started.flow.flow_id;
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  assistant.recordSemanticConfirmation({ flowId, savedRule: { ...saved, v: 1 } });
  assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
      results: [{ ok: true, verdict: 'not_triggered', display_verdict: 'not_triggered', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
    context: { symbol: '600519', date: '2024-10-01', market_source_id: 'dynamic-tushare' },
  });
  const first = await assistant.explainSimulationResult({ flowId, requestId: 'assistant-explain-fail' });
  const afterFailure = assistant.getExplanationEligibility(flowId);
  const second = await assistant.explainSimulationResult({ flowId, requestId: 'assistant-explain-retry' });
  check('结果解释：失败计入同一 flow 预算；2/2 后不再出站',
    first.ok === false && calls.length === 1
    && first.flow.model_calls === 2
    && first.flow.result_explanation === null
    && first.flow.result_explanation_attempt?.status === 'failed'
    && afterFailure.ok === false && afterFailure.code === RULE_ASSISTANT_CODES.RESULT_EXPLANATION_BUDGET
    && second.ok === false && calls.length === 1,
  JSON.stringify({ first, afterFailure, second, calls: calls.length }));
}

{
  const calls = [];
  const transport = {
    async ruleIntent() { return { rawText: draftBody('no_buy_on_surge', { threshold_pct: 5 }) }; },
    async resultExplanation(payload) {
      calls.push(payload);
      const binding = {
        flow_id: payload.flow_id,
        request_id: payload.request_id,
        rule_version: payload.rule.version,
        rule_hash: payload.rule.hash,
        scope: payload.rule.scope,
        simulation_result_id: 'wrong-result-id',
      };
      return { rawText: JSON.stringify({ answer_text: '错误绑定', binding }) };
    },
  };
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const started = await assistant.startFlow({ question: QUESTION });
  const flowId = started.flow.flow_id;
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  assistant.recordSemanticConfirmation({ flowId, savedRule: { ...saved, v: 1 } });
  assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
      results: [{ ok: true, verdict: 'not_triggered', display_verdict: 'not_triggered', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
    context: { symbol: '600519', date: '2024-10-01', market_source_id: 'dynamic-tushare' },
  });
  const out = await assistant.explainSimulationResult({ flowId, requestId: 'assistant-explain-bad-binding' });
  check('结果解释：错误 result_id 绑定被丢弃，不覆盖有效解释',
    out.ok === false
    && out.code === RULE_ASSISTANT_CODES.RESULT_EXPLANATION_STALE
    && out.flow.result_explanation === null
    && out.flow.result_explanation_attempt?.status === 'stale'
    && calls.length === 1,
  JSON.stringify({ out, calls: calls.length }));
}

{
  const transport = {
    async ruleIntent() { return { rawText: draftBody('no_buy_on_surge', { threshold_pct: 5 }) }; },
    async resultExplanation() { throw new Error('should-not-call'); },
  };
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const started = await assistant.startFlow({ question: QUESTION });
  const flowId = started.flow.flow_id;
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  assistant.recordSemanticConfirmation({ flowId, savedRule: { ...saved, v: 1 } });
  assistant.recordSimulation({
    flowId,
    simulation: {
      symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
      results: [{ ok: true, verdict: 'not_applicable', display_verdict: 'not_applicable', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
    context: { symbol: '600519', date: '2024-10-01', market_source_id: 'dynamic-tushare' },
  });
  const eligibility = assistant.getExplanationEligibility(flowId);
  const out = await assistant.explainSimulationResult({ flowId, requestId: 'assistant-explain-na' });
  check('结果解释：不适用虽执行完成但零出站，只保留本地摘要',
    eligibility.ok === false && out.ok === false
    && out.code === RULE_ASSISTANT_CODES.RESULT_EXPLANATION_NOT_READY
    && started.flow.model_calls === 1,
  JSON.stringify({ eligibility, out }));
}

/* —— 重新模拟：内容相同也生成新的 result_id，旧解释不能复用 —— */
{
  const transport = {
    async ruleIntent() { return { rawText: draftBody('no_buy_on_surge', { threshold_pct: 5 }) }; },
    async resultExplanation() { throw new Error('should-not-call'); },
  };
  const assistant = createRuleAssistant({ transport, timeoutMs: 1000 });
  const started = await assistant.startFlow({ question: QUESTION });
  const flowId = started.flow.flow_id;
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  assistant.recordSemanticConfirmation({ flowId, savedRule: { ...saved, v: 1 } });
  const sim = {
    symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
    results: [{ ok: true, verdict: 'not_triggered', display_verdict: 'not_triggered', rule: { hash: saved.hash, template_id: saved.template_id } }],
  };
  const context = { symbol: '600519', date: '2024-10-01', market_source_id: 'dynamic-tushare' };
  const first = assistant.recordSimulation({ flowId, simulation: sim, context });
  const second = assistant.recordSimulation({ flowId, simulation: sim, context });
  check('重新模拟：相同内容生成不同 result_id，旧结果解释清除',
    first.ok === true && second.ok === true
    && first.flow.simulation.result_hash === second.flow.simulation.result_hash
    && first.flow.simulation.result_id !== second.flow.simulation.result_id
    && second.flow.latest_simulation_result_id === second.flow.simulation.result_id
    && second.flow.result_explanation === null,
  JSON.stringify({ first: first.flow?.simulation?.result_id, second: second.flow?.simulation?.result_id }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
