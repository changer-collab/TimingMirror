#!/usr/bin/env node
/**
 * 右侧助手控制器测试（本地 fake transport；不触发真实模型/行情/网络）
 *
 * 覆盖：规则草案生成、送入规则页、用户确认记录、模拟读取、一致性检查、
 *       上下文变化旧响应隔离、预算/出站字段展示、1440/390 开合默认值。
 * 运行：node tests/agent/assistant-controller.test.mjs
 */
import { createRuleAssistant } from '../../src/agent/ruleAssistant.js';
import {
  createAssistantController,
  buildAssistantContext,
  assistantDefaultOpen,
} from '../../src/ui/assistantPanel.js';
import { defaultAssistant } from '../../src/state.js';
import * as adapter from '../../src/demo/adapter.js';
import { parseContract } from '../../src/engine/contractMatch.js';
import { parseRuleSpec } from '../../src/engine/ruleSpec.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '当天涨幅超过 5% 的票我绝不买入。';
const DRAFT_BODY = JSON.stringify({
  intent: 'contract_setup', confidence: 0.92,
  template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 },
  clarify: null, unsupported: null,
});

function fakeTransport(body = DRAFT_BODY) {
  const calls = [];
  return {
    calls,
    async ruleIntent(request) {
      calls.push(request);
      return { rawText: body };
    },
  };
}

function makeState() {
  return {
    route: 'contract',
    bill: {
      status: 'confirmed', sourceType: 'local', contextId: 'bill-1',
      supportScope: { asOfDate: '2025-12-31' },
    },
    report: { symbol: '000000' },
    contracts: { versions: [], modal: null, draft: null, sim: { symbol: '', date: '', result: null, running: false } },
    assistant: defaultAssistant(),
  };
}

function makeSet(state) {
  return (patch) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && state[k] && typeof state[k] === 'object' && !Array.isArray(state[k])) {
        state[k] = { ...state[k], ...v };
      } else {
        state[k] = v;
      }
    }
  };
}

/* —— 布局默认值/上下文 —— */
{
  check('布局：宽屏默认打开、窄屏默认折叠', assistantDefaultOpen(1440) === true
    && assistantDefaultOpen(390) === false && assistantDefaultOpen(undefined) === true);
  const state = makeState();
  const ctx = buildAssistantContext(state);
  check('上下文：只带最小字段（快照/标的/估值日/规则版本），不带成交/CSV',
    ctx.object_type === 'rule' && ctx.symbol === '000000'
    && ctx.as_of_date === '2025-12-31' && ctx.data_snapshot_id === 'bill-1'
    && !('trades' in ctx) && JSON.stringify(ctx).indexOf('csv') === -1,
    JSON.stringify(ctx));
}

/* —— 草案 → 规则页确认 → 用户确认 → 模拟 → 一致性 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const transport = fakeTransport();
  const client = createRuleAssistant({ transport, timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: (r) => { state.route = r; }, adapter });

  await controller.submit(QUESTION);
  const draft = state.assistant.draft;
  check('控制器：提交后生成草案，记录 flowId/预算/出站', state.assistant.pending === false
    && draft && draft.template_id === 'no_buy_on_surge'
    && state.assistant.flowId && state.assistant.modelCalls === 1
    && state.assistant.outbound === true
    && state.assistant.messages.some((m) => m.kind === 'draft'), JSON.stringify(state.assistant));

  controller.confirmInContract();
  check('控制器：草案送入规则页既有弹窗，未直接保存', state.contracts.modal?.mode === 'add'
    && state.contracts.draft?.template_id === draft.template_id
    && String(state.contracts.draft?.fields?.threshold_pct) === '5'
    && state.contracts.versions.length === 0, JSON.stringify(state.contracts));

  const edited = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  state.contracts.versions = [{
    schema: 'contract-v1', hash: edited.hash, v: 1,
    template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, text: edited.text,
    status: 'confirmed', note: '', at: '2026-10-20T00:00:00.000Z',
    assistant_flow_id: state.assistant.flowId,
  }];
  controller.syncFromState();
  check('控制器：保存成功后自动记录最终确认规则，支持用户修改草案', state.assistant.semanticConfirmation?.status === 'user_confirmed'
    && state.assistant.semanticConfirmation.draft_modified === true
    && state.assistant.semanticConfirmation.saved_rule.fields.threshold_pct === 3
    && state.assistant.semanticConfirmation.saved_rule.hash === edited.hash
    && state.assistant.semanticConfirmation.note.includes('修改')
    && state.assistant.semanticConfirmation.note.includes('语义正确性')
    && state.assistant.consistency === null, JSON.stringify(state.assistant.semanticConfirmation));

  state.contracts.sim = {
    symbol: '000000', date: '2025-12-31',
    result: {
      ok: true,
      symbol: '000000', requested_date: '2025-12-31', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 1, not_triggered: 0, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'triggered', rule: { hash: edited.hash, v: 1, text: edited.text, template_name: '涨幅超阈值不买入', fields_text: '涨幅阈值（%）：3' } }],
    },
  };
  controller.syncFromState();
  check('控制器：模拟完成后自动接收结果、绑定上下文并做一致性检查', state.assistant.consistency?.status === 'consistent'
    && state.assistant.consistency.independent_review === false
    && state.assistant.explanation.includes('触发 1 条')
    && state.assistant.explanation.includes('2025-12-31')
    && state.assistant.simulation?.summary?.triggered === 1
    && state.assistant.simulation?.context?.symbol === '000000'
    && state.assistant.trace.messages[2].steps.find((s) => s.tool === 'contract.match').source === 'rule_page', JSON.stringify({ c: state.assistant.consistency, e: state.assistant.explanation }));

  state.contracts.sim = {
    symbol: '600519', date: '2026-01-05',
    result: {
      ok: true,
      symbol: '600519', requested_date: '2026-01-05', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 0, not_triggered: 0, missing_data: 1, error: 0 },
      results: [{ ok: true, verdict: 'missing_data', rule: { hash: edited.hash, v: 1, text: edited.text } }],
    },
  };
  controller.syncFromState();
  check('控制器：同一规则再次模拟会更新为最新数据上下文，不保留旧结果', state.assistant.simulation?.context?.date === '2026-01-05'
    && state.assistant.simulation?.summary?.missing_data === 1
    && state.assistant.simulationKey.includes('2026-01-05'), JSON.stringify(state.assistant.simulation));

  const trace = state.assistant.trace;
  check('控制器：trace 四类消息且含 flow_id/最终确认/一致性', trace.messages.length === 4
    && trace.messages.every((m) => m.flow_id === state.assistant.flowId)
    && trace.messages[1].draft_modified === true
    && trace.messages[3].semantic_confirmation?.status === 'user_confirmed'
    && trace.messages[3].semantic_confirmation?.draft_modified === true
    && trace.messages[3].consistency_check?.status === 'consistent'
    && trace.messages[3].review.available === false,
  JSON.stringify(trace.messages[3]));
}

/* —— 第二条模板完整闭环：卖出后 N 日不追回 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const daysBody = JSON.stringify({
    intent: 'contract_setup', confidence: 0.93,
    template_id: 'no_buy_back_within', fields: { days: 3 },
    clarify: null, unsupported: null,
  });
  const transport = fakeTransport(daysBody);
  const client = createRuleAssistant({ transport, timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, adapter });
  await controller.submit('卖出后 3 个交易日内不追回同一只票。');
  const draft = state.assistant.draft;
  check('第二模板：自然语言映射到 no_buy_back_within', draft?.template_id === 'no_buy_back_within'
    && draft.fields.days === 3 && draft.text.includes('3'), JSON.stringify(draft));
  controller.confirmInContract();
  const parsed = parseContract({ template_id: 'no_buy_back_within', fields: { days: 3 } });
  state.contracts.versions = [{
    schema: 'contract-v1', hash: parsed.hash, v: 1,
    template_id: 'no_buy_back_within', fields: { days: 3 }, text: parsed.text,
    status: 'confirmed', note: '', at: '2026-10-20T00:00:00.000Z',
    assistant_flow_id: state.assistant.flowId,
  }];
  controller.syncFromState();
  check('第二模板：保存后自动确认，draft_rule/saved_rule 对应且未修改', state.assistant.semanticConfirmation?.saved_rule.template_id === 'no_buy_back_within'
    && state.assistant.semanticConfirmation.saved_rule.fields.days === 3
    && state.assistant.semanticConfirmation.draft_rule.fields.days === 3
    && state.assistant.semanticConfirmation.draft_modified === false, JSON.stringify(state.assistant.semanticConfirmation));
  state.contracts.sim = {
    symbol: '600519', date: '2024-09-27',
    result: {
      ok: true, symbol: '600519', requested_date: '2024-09-27', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 0, not_triggered: 1, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'not_triggered', rule: { hash: parsed.hash, v: 1, text: parsed.text } }],
    },
  };
  controller.syncFromState();
  check('第二模板：模拟自动接收、source=rule_page、一致性通过', state.assistant.simulation?.source === 'rule_page'
    && state.assistant.simulation.summary.not_triggered === 1
    && state.assistant.consistency?.status === 'consistent'
    && state.assistant.trace.messages[2].steps.find((s) => s.tool === 'contract.match').source === 'rule_page',
  JSON.stringify({ sim: state.assistant.simulation, c: state.assistant.consistency }));
}

/* —— 保存后调整规则：旧结果失效、返回编辑保留当前规则、行情失败仍可检查 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const transport = fakeTransport();
  const client = createRuleAssistant({ transport, timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: (r) => { state.route = r; }, adapter });

  await controller.submit(QUESTION);
  controller.confirmInContract();
  const v1Parsed = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  state.contracts.versions = [{
    schema: 'contract-v1', hash: v1Parsed.hash, v: 1,
    template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, text: v1Parsed.text,
    status: '已确认', note: '', at: '2026-10-20T00:00:00.000Z',
    assistant_flow_id: state.assistant.flowId,
  }];
  controller.syncFromState();
  state.contracts.sim = {
    symbol: '000000', date: '2025-12-31',
    result: {
      ok: true, symbol: '000000', requested_date: '2025-12-31', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 1, not_triggered: 0, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'triggered', rule: { hash: v1Parsed.hash, v: 1, text: v1Parsed.text } }],
    },
  };
  controller.syncFromState();
  check('自动接收/一致性：仅更新本地状态，不再调用模型或新建 flow', state.assistant.simulation?.rule_hash === v1Parsed.hash
    && state.assistant.simulation?.stale === false && state.assistant.consistency?.status === 'consistent'
    && state.assistant.modelCalls === 1 && transport.calls.length === 1,
  JSON.stringify({ sim: state.assistant.simulation, consistency: state.assistant.consistency, calls: transport.calls.length }));

  const v2Parsed = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 4 } });
  const records = adapter.contractSaveRecords(state.contracts.versions, { parsed: v2Parsed, note: '用户返回调整' });
  state.contracts.versions = [...state.contracts.versions, ...records];
  state.contracts.sim = { symbol: '000000', date: '2025-12-31', result: null, running: false };
  controller.syncFromState();
  check('规则页保存新内容：旧模拟与旧一致性同时失效，语义确认不自动更新',
    state.assistant.ruleDrift?.status === 'changed'
    && state.assistant.currentRule?.hash === v2Parsed.hash
    && state.assistant.semanticConfirmation?.saved_rule.hash === v1Parsed.hash
    && state.assistant.semanticConfirmation?.status === 'user_confirmed'
    && state.assistant.semanticConfirmation?.source === 'rule_page_save'
    && state.assistant.simulation?.stale === true
    && state.assistant.consistency?.stale === true
    && state.assistant.consistency?.stale_reason === 'saved_rule_changed'
    && state.assistant.trace?.messages[3]?.consistency_check?.stale === true
    && state.assistant.explanation.includes('重新模拟')
    && state.assistant.modelCalls === 1
    && transport.calls.length === 1,
  JSON.stringify({ drift: state.assistant.ruleDrift, sim: state.assistant.simulation, consistency: state.assistant.consistency, exp: state.assistant.explanation }));

  const versionsBeforeActions = state.contracts.versions.length;
  controller.goSimulation();
  check('前往历史模拟：只切页，不自动执行模拟、不再调用模型、不改规则版本',
    state.route === 'contract'
    && state.contracts.sim.result === null
    && state.contracts.versions.length === versionsBeforeActions
    && transport.calls.length === 1);

  controller.returnToRuleEdit();
  check('返回调整规则：带入当前保存规则（非旧草案），保留版本与旧结果标记',
    state.contracts.modal?.mode === 'edit'
    && state.contracts.modal?.targetHash === v2Parsed.hash
    && String(state.contracts.draft?.fields?.threshold_pct) === '4'
    && state.contracts.versions.length === versionsBeforeActions
    && state.assistant.semanticConfirmation?.saved_rule.hash === v1Parsed.hash
    && state.assistant.simulation?.stale === true,
  JSON.stringify({ modal: state.contracts.modal, draft: state.contracts.draft }));

  const v2Record = adapter.contractRuleSet(state.contracts.versions).current.find((r) => r.hash === v2Parsed.hash);
  state.contracts.sim = {
    symbol: '000000', date: '2025-12-31',
    result: {
      ok: true, symbol: '000000', requested_date: '2025-12-31', marketSourceId: 'dynamic-tushare',
      summary: { triggered: 0, not_triggered: 1, missing_data: 0, error: 0 },
      results: [{ ok: true, verdict: 'not_triggered', rule: { hash: v2Parsed.hash, v: v2Record.v, text: v2Parsed.text } }],
    },
  };
  controller.syncFromState();
  check('新规则模拟：结果绑定当前规则，不覆盖原语义确认依据，也不新增模型调用',
    state.assistant.simulation?.rule_hash === v2Parsed.hash
    && state.assistant.simulation?.stale === false
    && state.assistant.simulation?.semantic_confirmation_covers_rule === false
    && state.assistant.consistency?.status === 'consistent'
    && state.assistant.consistency?.semantic_confirmation_covers_rule === false
    && state.assistant.semanticConfirmation?.saved_rule.hash === v1Parsed.hash
    && state.assistant.semanticConfirmation?.status === 'user_confirmed'
    && state.assistant.semanticConfirmation?.draft_modified === true
    && state.assistant.explanation.includes('不覆盖')
    && state.assistant.modelCalls === 1
    && transport.calls.length === 1,
  JSON.stringify({ sim: state.assistant.simulation, consistency: state.assistant.consistency, semantic: state.assistant.semanticConfirmation, exp: state.assistant.explanation }));

  state.contracts.simContext = { error: '动态行情获取失败：E_MARKET_RESPONSE_INVALID · 行情服务响应格式非法；不回落静态缓存或合成行情' };
  controller.syncFromState();
  check('行情阻断：助手显示错误且保留规则检查入口，不新增模型/行情调用',
    state.assistant.marketNotice?.code === 'E_MARKET_RESPONSE_INVALID'
    && state.assistant.marketNotice.message.includes('不回落静态缓存或合成行情')
    && state.assistant.currentRule?.hash === v2Parsed.hash
    && transport.calls.length === 1
    && state.assistant.modelCalls === 1,
  JSON.stringify(state.assistant.marketNotice));

  state.contracts.simContext = null;
  controller.syncFromState();
  check('行情恢复：清除阻断提示', state.assistant.marketNotice === null);
}

/* —— 缺数据/缺账单：保留草案，不执行、不回退演示 —— */
{
  const state = makeState();
  state.bill = { status: 'none', sourceType: null, contextId: 'bill-x' };
  const set = makeSet(state);
  const client = createRuleAssistant({ transport: fakeTransport(), timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, adapter });
  await controller.submit(QUESTION);
  controller.syncFromState();
  check('前置条件：无已确认本地账单时不自动执行模拟，草案保留', state.assistant.draft
    && state.assistant.simulation === null
    && state.assistant.explanation.includes('尚未执行'), JSON.stringify(state.assistant.error));
}

/* —— 上下文变化：旧响应丢弃并记录 stale —— */
{
  const state = makeState();
  const set = makeSet(state);
  let resolveFlow;
  const client = {
    startFlow() {
      return new Promise((resolve) => { resolveFlow = resolve; });
    },
    recordSemanticConfirmation() { return { ok: false }; },
    recordSimulation() { return { ok: false }; },
    checkConsistency() { return { ok: false, consistency: { status: 'not_run' } }; },
  };
  const controller = createAssistantController({ client, state, set, go: () => {}, adapter });
  const pending = controller.submit(QUESTION);
  state.bill.contextId = 'bill-2';
  resolveFlow({ ok: true, flow: { flow_id: 'flow-stale', draft: { template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, text: 'x', hash: 'h' }, model_calls: 1, budget_max: 2, outbound: true } });
  await pending;
  check('旧响应隔离：上下文变化后丢弃结果并记录 stale', state.assistant.draft === null
    && state.assistant.staleNotice?.includes('旧回复已丢弃')
    && state.assistant.pending === false, JSON.stringify(state.assistant));
}

/* —— 行情响应格式非法：fail-closed，不回落 —— */
{
  const bill = {
    status: 'confirmed', sourceType: 'local', blocked: false,
    contextId: 'bill-market-fail', fileName: 'market-fail.csv',
    errors: [], warnings: [],
    trades: [
      { trade_id: 'M001', trade_date: '2024-10-08', symbol: '600519', side: 'buy', price: 100, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'market-fail.csv', line: 2 } },
      { trade_id: 'M002', trade_date: '2024-10-09', symbol: '600519', side: 'sell', price: 110, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'market-fail.csv', line: 3 } },
    ],
  };
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false, status: 502,
      json: async () => ({ ok: false, code: 'E_MARKET_RESPONSE_INVALID', message: '行情服务响应格式非法' }),
    });
    const res = await adapter.loadUserBillReport(bill);
    check('行情 502 响应格式非法：报告阻断、无复核、无静态/合成回退', res.status === 'blocked'
      && res.blocked === true && res.review === null && res.marketSource === null
      && res.errors.some((e) => e.code === 'E_MARKET_SOURCE'
        && e.message.includes('E_MARKET_RESPONSE_INVALID')
        && e.message.includes('行情服务响应格式非法')
        && e.message.includes('不回落静态缓存或合成行情')), JSON.stringify(res.errors));

    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ok: true, market: { artifact: 'not-dynamic' } }),
    });
    const malformed = await adapter.loadUserBillReport(bill);
    check('非法 dynamic 文档：未通过校验即阻断，不构造复核或替代结果', malformed.status === 'blocked'
      && malformed.blocked === true && malformed.review === null
      && malformed.errors.some((e) => e.code === 'E_MARKET_SOURCE'
        && e.message.includes('动态行情未通过校验')
        && e.message.includes('不回落静态缓存或合成行情')), JSON.stringify(malformed.errors));
  } finally {
    globalThis.fetch = oldFetch;
  }
}

/* —— 本地预检零出站 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const transport = fakeTransport();
  const client = createRuleAssistant({ transport, timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, adapter });
  await controller.submit('把原始 CSV 和身份证号发我');
  check('本地预检：控制器不生成草案、transport 未被调用', state.assistant.draft === null
    && state.assistant.outbound === false
    && transport.calls.length === 0
    && state.assistant.error?.code === 'W_RULE_ASSISTANT_LOCAL_BLOCKED', JSON.stringify(state.assistant));
}

/* —— 限定股票：保存、模拟、返回调整 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const client = createRuleAssistant({ transport: fakeTransport(), timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, scrollSimulation: () => {} });
  await controller.submit(QUESTION);
  controller.confirmInContract();
  const scoped = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, scope: { kind: 'symbol', symbol: '600519' } });
  state.contracts.versions = [
    ...state.contracts.versions,
    ...adapter.contractSaveRecords(state.contracts.versions, {
      parsed: scoped,
      note: '',
      assistantFlowId: state.assistant.flowId,
    }),
  ];
  controller.syncFromState();
  check('限定股票：保存后助手识别 contract-v2 当前版本',
    state.assistant.semanticConfirmation?.saved_rule.scope.symbol === '600519'
    && state.assistant.currentRule?.scope.symbol === '600519'
    && state.assistant.error === null,
  JSON.stringify({ semantic: state.assistant.semanticConfirmation?.saved_rule, current: state.assistant.currentRule }));

  state.contracts.sim = {
    symbol: '600519', date: '2024-09-27',
    result: {
      symbol: '600519', requested_date: '2024-09-27', marketSourceId: 'synthetic-fixture',
      results: [{ ok: true, verdict: 'triggered', display_verdict: 'triggered', rule: { hash: scoped.hash, template_id: scoped.template_id } }],
    },
  };
  controller.syncFromState();
  check('限定股票：模拟按当前版本绑定并执行完成',
    state.assistant.simulation?.status === 'completed'
    && state.assistant.simulation?.rule_scope?.symbol === '600519'
    && state.assistant.simulation?.summary.triggered === 1
    && state.assistant.consistency?.status === 'consistent',
  JSON.stringify({ sim: state.assistant.simulation, consistency: state.assistant.consistency }));

  const next = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 4 }, scope: { kind: 'symbol', symbol: '600519' } });
  state.contracts.versions = [
    ...state.contracts.versions,
    ...adapter.contractSaveRecords(state.contracts.versions, { parsed: next, note: '返回调整' }),
  ];
  state.contracts.sim = { symbol: '600519', date: '2024-09-27', result: null, running: false };
  controller.syncFromState();
  check('限定股票：返回调整后旧模拟与一致性失效，原语义确认仍指向 v1',
    state.assistant.ruleDrift?.status === 'changed'
    && state.assistant.currentRule?.hash === next.hash
    && state.assistant.semanticConfirmation?.saved_rule.hash === scoped.hash
    && state.assistant.simulation?.stale === true
    && state.assistant.consistency?.stale === true,
  JSON.stringify({ drift: state.assistant.ruleDrift, sim: state.assistant.simulation, semantic: state.assistant.semanticConfirmation?.saved_rule }));
}

/* —— 保存归属：取消助手弹窗后，无关保存不被认领 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const client = createRuleAssistant({ transport: fakeTransport(), timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, scrollSimulation: () => {} });
  await controller.submit(QUESTION);
  controller.confirmInContract();
  const other = parseContract({ template_id: 'no_buy_back_within', fields: { days: 2 } });
  state.contracts.modal = null;
  state.contracts.draft = null;
  state.contracts.versions = [
    ...state.contracts.versions,
    ...adapter.contractSaveRecords(state.contracts.versions, { parsed: other, note: '' }),
  ];
  controller.syncFromState();
  check('保存归属：没有 assistant_flow_id 的无关保存不会被助手认领',
    state.assistant.semanticConfirmation === null
    && state.assistant.pendingConfirmationFlowId === state.assistant.flowId,
  JSON.stringify({ semantic: state.assistant.semanticConfirmation, pending: state.assistant.pendingConfirmationFlowId }));
}

/* —— 模拟接收：失败/不适用与本次/历史区分 —— */
{
  const state = makeState();
  const set = makeSet(state);
  const client = createRuleAssistant({ transport: fakeTransport(), timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, scrollSimulation: () => {} });
  await controller.submit(QUESTION);
  controller.confirmInContract();
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  state.contracts.versions = [
    ...state.contracts.versions,
    ...adapter.contractSaveRecords(state.contracts.versions, { parsed: saved, note: '', assistantFlowId: state.assistant.flowId }),
  ];
  controller.syncFromState();
  state.contracts.sim = {
    symbol: '600519', date: '2024-09-27',
    result: {
      symbol: '600519', requested_date: '2024-09-27', marketSourceId: 'synthetic-fixture',
      results: [{ ok: false, verdict: null, display_verdict: 'error', code: 'E_MARKET_SOURCE', message: '行情不可用', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
  };
  controller.syncFromState();
  check('模拟失败：以逐项 ok 判失败，本次尝试单独展示，不冒充有效结果',
    state.assistant.simulation === null
    && state.assistant.simulationAttempt?.status === 'failed'
    && state.assistant.simulationAttempt?.error?.code === 'E_RULE_ASSISTANT_SIMULATION_FAILED'
    && state.assistant.error === null,
  JSON.stringify({ attempt: state.assistant.simulationAttempt, sim: state.assistant.simulation }));

  state.contracts.sim = {
    symbol: '600519', date: '2024-09-27',
    result: {
      symbol: '600519', requested_date: '2024-09-27', marketSourceId: 'synthetic-fixture',
      results: [{ ok: true, verdict: 'not_applicable', display_verdict: 'not_applicable', code: 'I_RULE_ACTION_NOT_APPLICABLE', message: '本次是卖出情境', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
  };
  controller.syncFromState();
  check('模拟不适用：执行完成并保留不适用计数，不要求命中',
    state.assistant.simulation?.status === 'completed'
    && state.assistant.simulation?.summary.not_applicable === 1
    && state.assistant.simulationAttempt === null
    && state.assistant.consistency?.status === 'consistent',
  JSON.stringify({ sim: state.assistant.simulation, consistency: state.assistant.consistency }));
}

/* —— 任务连续性：新请求失败不清掉已保存规则与历史依据 —— */
{
  const state = makeState();
  const set = makeSet(state);
  let calls = 0;
  const transport = {
    async ruleIntent() {
      calls += 1;
      if (calls === 1) return { rawText: DRAFT_BODY };
      throw new Error('offline');
    },
  };
  const client = createRuleAssistant({ transport, timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, scrollSimulation: () => {} });
  await controller.submit(QUESTION);
  controller.confirmInContract();
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  state.contracts.versions = [
    ...state.contracts.versions,
    ...adapter.contractSaveRecords(state.contracts.versions, { parsed: saved, note: '', assistantFlowId: state.assistant.flowId }),
  ];
  controller.syncFromState();
  const oldFlow = state.assistant.flowId;
  const oldHash = state.assistant.semanticConfirmation?.saved_rule?.hash;
  const oldDataContext = state.assistant.dataContextKey;
  state.bill.contextId = 'bill-2';
  await controller.submit('卖出后 3 个交易日内不追回同一只票。');
  check('新请求失败：保留原 flow/草案/已保存规则/数据上下文，失败作为 lastAttempt',
    state.assistant.flowId === oldFlow
    && state.assistant.draft?.template_id === 'no_buy_on_surge'
    && state.assistant.semanticConfirmation?.saved_rule?.hash === oldHash
    && state.assistant.dataContextKey === oldDataContext
    && state.assistant.pending === false
    && state.assistant.lastAttempt?.status === 'unavailable'
    && state.assistant.error?.code === 'W_RULE_ASSISTANT_MODEL_UNAVAILABLE'
    && calls === 2,
  JSON.stringify({ flow: state.assistant.flowId, draft: state.assistant.draft?.template_id, semantic: state.assistant.semanticConfirmation?.saved_rule, data: state.assistant.dataContextKey, last: state.assistant.lastAttempt, error: state.assistant.error }));
}

/* —— 结果解释：仅主动点击、绑定当前结果、迟到丢弃 —— */
{
  const explanationCalls = [];
  const transport = {
    async ruleIntent() { return { rawText: DRAFT_BODY }; },
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
  const state = makeState();
  const set = makeSet(state);
  const client = createRuleAssistant({ transport, timeoutMs: 1000 });
  const controller = createAssistantController({ client, state, set, go: () => {}, scrollSimulation: () => {} });
  await controller.submit(QUESTION);
  controller.confirmInContract();
  const saved = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  state.contracts.versions = [
    ...state.contracts.versions,
    ...adapter.contractSaveRecords(state.contracts.versions, { parsed: saved, note: '', assistantFlowId: state.assistant.flowId }),
  ];
  controller.syncFromState();
  state.contracts.sim = {
    symbol: '600519', date: '2024-10-01',
    result: {
      symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
      results: [{ ok: true, verdict: 'triggered', display_verdict: 'triggered', code: null, message: '命中', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
  };
  controller.syncFromState();
  check('结果解释：自动接收不调用解释模型', explanationCalls.length === 0
    && state.assistant.resultExplanation === null
    && state.assistant.currentSimulationStatus === 'completed',
  JSON.stringify({ calls: explanationCalls.length, state: state.assistant }));

  await controller.explainResult();
  const review = state.assistant.trace?.messages?.find((m) => m.type === 'review_result');
  check('结果解释：用户点击后调用一次并绑定当前 result_id；不改语义确认',
    explanationCalls.length === 1
    && state.assistant.resultExplanation?.answer_text.includes('triggered')
    && state.assistant.resultExplanation?.binding.simulation_result_id === state.assistant.currentSimulationResultId
    && state.assistant.resultExplanation?.binding.rule_hash === saved.hash
    && state.assistant.modelCalls === 2
    && state.assistant.semanticConfirmation?.saved_rule.hash === saved.hash
    && review?.result_explanation?.stage === 'result_explanation'
    && review?.consistency_check?.independent_review === false,
  JSON.stringify({ explanation: state.assistant.resultExplanation, review, calls: explanationCalls.length }));

  const oldResultId = state.assistant.currentSimulationResultId;
  state.contracts.sim = {
    symbol: '600519', date: '2024-10-01',
    result: {
      symbol: '600519', requested_date: '2024-10-01', marketSourceId: 'dynamic-tushare',
      results: [{ ok: true, verdict: 'not_triggered', display_verdict: 'not_triggered', code: null, message: '未命中', rule: { hash: saved.hash, template_id: saved.template_id } }],
    },
  };
  controller.syncFromState();
  check('结果解释：重新模拟后旧解释失效且 result_id 改变',
    state.assistant.resultExplanation === null
    && state.assistant.currentSimulationResultId !== oldResultId
    && state.assistant.currentSimulationStatus === 'completed',
  JSON.stringify({ old: oldResultId, now: state.assistant.currentSimulationResultId, exp: state.assistant.resultExplanation }));
}

/* —— 结果解释：迟到响应按 flow/route/result 丢弃 —— */
{
  let resolveExplain;
  const client = {
    async startFlow() { return { ok: true, flow: { flow_id: 'flow-late', draft: { template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, text: 'x', hash: 'h' }, model_calls: 1, budget_max: 2, outbound: true } }; },
    getExplanationEligibility() { return { ok: true, remaining: 1 }; },
    explainSimulationResult() { return new Promise((resolve) => { resolveExplain = resolve; }); },
    getFlow() { return null; },
    recordSemanticConfirmation() { return { ok: false }; },
    recordSimulation() { return { ok: false }; },
    checkConsistency() { return { ok: false, consistency: { status: 'not_run' } }; },
    getTrace() { return null; },
  };
  const state = makeState();
  state.assistant.flowId = 'flow-late';
  state.assistant.currentSimulationResultId = 'sim-late';
  state.assistant.currentSimulationStatus = 'completed';
  state.assistant.simulation = { result_id: 'sim-late', status: 'completed', rule_hash: 'h', rule_version: 1, rule_scope: { kind: 'all' }, context: { symbol: '600519', date: '2024-10-01', market_source_id: 'dynamic-tushare' }, summary: { triggered: 1, not_triggered: 0, not_applicable: 0, missing_data: 0, error: 0 }, results: [], explainable: true };
  state.assistant.currentRule = { template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, hash: 'h', v: 1, scope: { kind: 'all' } };
  state.assistant.semanticConfirmation = { status: 'user_confirmed', saved_rule: state.assistant.currentRule };
  state.assistant.simulationKey = 'sim-key';
  const set = makeSet(state);
  const controller = createAssistantController({ client, state, set, go: () => {}, scrollSimulation: () => {} });
  const pending = controller.explainResult();
  state.route = 'home';
  resolveExplain({
    ok: true,
    explanation: { answer_text: '迟到的解释', binding: { flow_id: 'flow-late', request_id: state.assistant.resultExplanationRequestId, rule_hash: 'h', rule_version: 1, scope: { kind: 'all' }, simulation_result_id: 'sim-late' } },
    flow: { model_calls: 2, budget_max: 2, trace: null, outbound: true },
  });
  await pending;
  check('结果解释：切页后的迟到响应不覆盖当前状态',
    state.assistant.resultExplanation === null
    && state.assistant.resultExplanationPending === false
    && state.assistant.resultExplanationNotice?.includes('丢弃'),
  JSON.stringify({ exp: state.assistant.resultExplanation, notice: state.assistant.resultExplanationNotice }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
