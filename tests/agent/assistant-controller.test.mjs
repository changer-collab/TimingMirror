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

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
