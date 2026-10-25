#!/usr/bin/env node
/**
 * 报告证据草案 → 规则保存状态（本地 DOM 桩；不联网、不调用模型）
 *
 * 覆盖：草案关联从载入/编辑/改范围保留到保存；保存中/成功/失败；
 *       成功后收起草案与按钮；取消、校验失败、保存失败保留草案；
 *       无关规则保存与新草案不被旧结果误清；失败重试不重复版本。
 * 运行：node tests/ui/rule-save-draft.test.mjs
 */
import { defaultAssistant, defaultBill, defaultContracts } from '../../src/state.js';
import { openRuleCandidateInAssistant } from '../../prototype/user-frontend/ruleCandidates.js';
import * as adapter from '../../src/demo/adapter.js';
import { createRuleSaveFlow, RULE_SAVE_STATE, RULE_SAVE_FAILED_TEXT } from '../../src/ui/ruleSaveFlow.js';

class FakeNode {}
function createTextNode(text) {
  const node = Object.create(FakeNode.prototype);
  node.__text = String(text);
  node.children = [];
  node.attrs = {};
  node.listeners = {};
  node.parentNode = null;
  return node;
}
function makeEl(tag) {
  const node = Object.create(FakeNode.prototype);
  node.tagName = String(tag).toUpperCase();
  node.children = [];
  node.attrs = {};
  node.listeners = {};
  node.value = '';
  node.disabled = false;
  node.parentNode = null;
  node.setAttribute = function setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'disabled') this.disabled = true;
  };
  node.getAttribute = function getAttribute(key) { return this.attrs[key]; };
  node.removeAttribute = function removeAttribute(key) { delete this.attrs[key]; };
  node.addEventListener = function addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); };
  node.append = function append(...children) {
    for (const child of children) {
      if (child == null) continue;
      if (typeof child === 'object') child.parentNode = this;
      this.children.push(child);
    }
  };
  node.replaceChildren = function replaceChildren(...children) {
    this.children = children.filter((child) => child != null);
    for (const child of this.children) if (child && typeof child === 'object') child.parentNode = this;
  };
  Object.defineProperty(node, 'className', {
    get() { return this.attrs.class ?? ''; },
    set(value) { this.attrs.class = String(value); },
  });
  return node;
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: makeEl, createTextNode };
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };

const { createAssistantController, renderAssistantPanel } = await import('../../src/ui/assistantPanel.js');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function allText(node) {
  if (!node) return '';
  if (node.__text !== undefined) return node.__text;
  return (node.children ?? []).map(allText).join(' ');
}
function nodesByRole(node, role) {
  const out = [];
  const walk = (current) => {
    if (!current || current.__text !== undefined) return;
    if (current.attrs?.['data-role'] === role) out.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return out;
}

function makeState() {
  return {
    route: 'contract',
    bill: {
      ...defaultBill(), status: 'confirmed', sourceType: 'local', blocked: false,
      contextId: 'rule-save-bill', trades: [{ trade_id: 'T1' }],
    },
    report: { symbol: 'pool' },
    contracts: defaultContracts(),
    assistant: defaultAssistant(),
  };
}
function makeSet(state) {
  return (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])) {
        state[key] = { ...state[key], ...value };
      } else {
        state[key] = value;
      }
    }
  };
}
const CANDIDATE = {
  candidate_id: 'chase_high_buy',
  status: 'available',
  template_id: 'no_buy_on_surge',
  fields: { threshold_pct: '10' },
  text: '当天涨幅超过 10% 的票，我绝不买入。',
  basis: '本账单中有 3 笔买入发生在回看窗口涨幅 ≥ 10% 的情境。',
  reason: '行为发现“追高买入”成立：命中 3 笔。',
  caveat: '模板判定的是申报当天涨幅，与行为发现的回看窗口不是同一口径。',
  evidence: [{ trade_date: '2024-09-24', symbol: '600519', rise: 0.12, line: '2024-09-24 600519 买入，窗口涨幅 12.0%' }],
};

function setup({ candidate = CANDIDATE } = {}) {
  const state = makeState();
  const set = makeSet(state);
  const ctx = { state, set, isOverlayLayout: () => false, focusAssistant: () => {} };
  openRuleCandidateInAssistant(ctx, candidate);
  const controller = createAssistantController({
    client: {}, state, set, go: (route) => { state.route = route; }, scrollSimulation: () => {},
  });
  controller.confirmInContract();
  return { state, set, controller, ctx };
}

function editContract(state, { fields, scope } = {}) {
  const draft = state.contracts.draft;
  if (fields) draft.fields = { ...draft.fields, ...fields };
  if (scope) draft.scope = scope;
  const parsed = adapter.previewContract({
    template_id: draft.template_id,
    fields: draft.fields,
    scope: draft.scope,
  });
  const recs = adapter.contractSaveRecords(state.contracts.versions, {
    parsed,
    note: draft.note,
    assistantDraftId: draft.assistantDraftId,
    assistantCandidateId: draft.assistantCandidateId,
  });
  return { parsed, recs };
}

const simReset = (state) => ({ ...state.contracts.sim, result: null, running: false, runId: null, fallback: null });

/* ==== 载入 → 打开编辑 → 修改范围 → 保存成功收起 ==== */
{
  const { state, set, controller } = setup();
  const draftId = state.assistant.draft?.draft_id;
  check('草案载入：有本地 draft_id，未伪造 AI flowId',
    typeof draftId === 'string' && state.assistant.draft.flow_id === null
    && state.assistant.flowId === null && state.assistant.draftId === draftId,
    JSON.stringify({ draft: state.assistant.draft, flowId: state.assistant.flowId }));

  check('打开编辑：关联标识与候选来源进入规则草稿',
    state.contracts.draft.assistantDraftId === draftId
    && state.contracts.draft.assistantCandidateId === 'chase_high_buy'
    && state.assistant.pendingDraftId === draftId,
    JSON.stringify(state.contracts.draft));

  const { parsed, recs } = editContract(state, {
    fields: { threshold_pct: '12' },
    scope: { kind: 'symbol', symbol: '600519' },
  });
  check('修改参数/范围后：保存记录沿用同一关联并保留来源',
    parsed.supported === true
    && recs.length === 1
    && recs[0].assistant_draft_id === draftId
    && recs[0].assistant_candidate_id === 'chase_high_buy'
    && recs[0].note.includes('报告行为证据')
    && recs[0].scope.symbol === '600519',
    JSON.stringify(recs));

  const calls = [];
  const flow = createRuleSaveFlow({
    getContracts: () => state.contracts,
    set,
    saveRules: async ({ versions }) => { calls.push(versions); },
  });
  check('保存中：状态为 saving，规则版本尚未本地生效',
    await (async () => {
      const pending = flow.saveVersions([...state.contracts.versions, ...recs], { extra: { modal: null }, simReset: simReset(state) });
      const during = state.contracts.saveState?.status === RULE_SAVE_STATE.SAVING
        && state.contracts.versions.length === 0;
      await pending;
      return during;
    })(),
    JSON.stringify(state.contracts.saveState));

  check('保存成功：云端结果返回后才应用版本',
    calls.length === 1
    && state.contracts.versions.length === recs.length
    && state.contracts.saveState?.status === RULE_SAVE_STATE.SAVED
    && state.contracts.modal === null,
    JSON.stringify({ versions: state.contracts.versions, saveState: state.contracts.saveState }));

  controller.syncFromState();
  check('保存成功：收起未保存草案与操作，显示已保存并启用',
    state.assistant.draft === null
    && state.assistant.draftId === null
    && state.assistant.pendingDraftId === null
    && state.assistant.savedNotice?.text === '规则已保存并启用'
    && state.assistant.currentRule?.hash === recs[0].hash
    && state.assistant.messages.at(-1)?.text.includes('规则已保存并启用')
    && !state.assistant.messages.at(-1)?.text.includes('模拟'),
    JSON.stringify(state.assistant));

  const root = makeEl('div');
  renderAssistantPanel(root, {
    state,
    set,
    go: (route) => { state.route = route; },
    assistantTitle: 'AI 助手',
    assistantSubtitle: '当前页面帮助',
    globalAssistant: true,
    qaDeps: { getReportBundle: () => null },
  });
  const panel = root.children[0];
  check('保存成功：页面不再出现未保存草案卡与丢弃/编辑按钮',
    !allText(panel).includes('来自报告证据的建议（尚未保存）')
    && !allText(panel).includes('丢弃草案')
    && !allText(panel).includes('前往编辑规则')
    && nodesByRole(panel, 'assistant-saved-notice').length === 1
    && nodesByRole(panel, 'assistant-view-rule').length === 1,
    allText(panel).slice(0, 360));

  controller.viewSavedRule();
  check('“查看规则”进入规则工作区', state.route === 'contract');
}

/* ==== 原样保存（不改参数） ==== */
{
  const { state, set, controller } = setup();
  const draftId = state.assistant.draft.draft_id;
  const { recs } = editContract(state);
  const flow = createRuleSaveFlow({ getContracts: () => state.contracts, set, saveRules: async () => {} });
  await flow.saveVersions([...state.contracts.versions, ...recs], { extra: { modal: null }, simReset: simReset(state) });
  controller.syncFromState();
  check('原样保存：关联保留、成功后同样收起',
    recs[0].assistant_draft_id === draftId
    && String(recs[0].fields.threshold_pct) === '10'
    && state.assistant.draft === null
    && state.assistant.savedNotice?.hash === recs[0].hash,
    JSON.stringify(state.assistant));
}

/* ==== 取消 / 校验失败 / 保存失败：保留草案 ==== */
{
  const { state, set, controller } = setup();
  const draftId = state.assistant.draft.draft_id;
  state.contracts.draft.fields = { ...state.contracts.draft.fields, threshold_pct: '9' };
  state.contracts.draft.scope = { kind: 'symbol', symbol: '600519' };
  controller.syncFromState();
  check('取消编辑/校验未通过：草案、关联与用户修改都保留',
    state.assistant.draft?.draft_id === draftId
    && state.assistant.pendingDraftId === draftId
    && state.assistant.savedNotice === null
    && String(state.contracts.draft.fields.threshold_pct) === '9'
    && state.contracts.draft.scope.symbol === '600519'
    && state.contracts.versions.length === 0,
    JSON.stringify({ assistant: state.assistant, draft: state.contracts.draft }));

  const { recs } = editContract(state, {
    fields: { threshold_pct: '12' },
    scope: { kind: 'symbol', symbol: '600519' },
  });
  const failedFlow = createRuleSaveFlow({
    getContracts: () => state.contracts,
    set,
    saveRules: async () => { throw new Error('offline'); },
  });
  const versionsToSave = [...state.contracts.versions, ...recs];
  const first = await failedFlow.saveVersions(versionsToSave, { extra: { modal: null }, simReset: simReset(state) });
  controller.syncFromState();
  check('保存失败/校验中断：明确失败状态，本地版本、草案和用户修改都保留',
    first.ok === false
    && state.contracts.versions.length === 0
    && state.contracts.saveState?.status === RULE_SAVE_STATE.FAILED
    && state.contracts.saveState?.message === RULE_SAVE_FAILED_TEXT
    && state.contracts.modal !== null
    && String(state.contracts.draft?.fields?.threshold_pct) === '12'
    && state.contracts.draft?.scope?.symbol === '600519'
    && state.assistant.draft?.draft_id === draftId,
    JSON.stringify({ saveState: state.contracts.saveState, draft: state.contracts.draft, assistant: state.assistant.draft }));

  let retried = null;
  const retryFlow = createRuleSaveFlow({
    getContracts: () => state.contracts,
    set,
    saveRules: async ({ versions }) => { retried = versions; },
  });
  await retryFlow.saveVersions(versionsToSave, { extra: { modal: null }, simReset: simReset(state) });
  const savedRecords = state.contracts.versions.filter((rec) => rec.assistant_draft_id === draftId);
  const savedVersions = state.contracts.versions.filter((rec) => Number.isFinite(rec.v)).map((rec) => rec.v);
  check('失败重试：发送同一版本列表，不重复创建规则版本',
    JSON.stringify(retried) === JSON.stringify(versionsToSave)
    && savedRecords.length === 1
    && new Set(savedVersions).size === savedVersions.length,
    JSON.stringify({ retried, versions: state.contracts.versions }));

  controller.syncFromState();
  check('失败重试成功后才收起草案',
    state.assistant.draft === null && state.assistant.savedNotice?.text === '规则已保存并启用',
    JSON.stringify(state.assistant));
}

/* ==== 无关规则保存：不清除当前草案 ==== */
{
  const { state, set, controller } = setup();
  const draftId = state.assistant.draft.draft_id;
  const other = adapter.previewContract({ template_id: 'no_buy_back_within', fields: { days: '3' }, scope: { kind: 'all' } });
  const otherRecs = adapter.contractSaveRecords(state.contracts.versions, { parsed: other, note: '' });
  const flow = createRuleSaveFlow({ getContracts: () => state.contracts, set, saveRules: async () => {} });
  await flow.saveVersions([...state.contracts.versions, ...otherRecs], { extra: {}, simReset: simReset(state) });
  controller.syncFromState();
  check('保存无关规则：当前报告证据草案与关联保留',
    state.contracts.versions.length === otherRecs.length
    && state.assistant.draft?.draft_id === draftId
    && state.assistant.pendingDraftId === draftId
    && state.assistant.savedNotice === null,
    JSON.stringify({ draft: state.assistant.draft?.draft_id, versions: state.contracts.versions.length }));
}

/* ==== 保存期间生成新草案：旧结果不清新草案 ==== */
{
  const { state, set, controller, ctx } = setup();
  const oldDraftId = state.assistant.draft.draft_id;
  const { recs } = editContract(state);
  let resolveSave;
  const flow = createRuleSaveFlow({
    getContracts: () => state.contracts,
    set,
    saveRules: () => new Promise((resolve) => { resolveSave = resolve; }),
  });
  const pending = flow.saveVersions([...state.contracts.versions, ...recs], { extra: { modal: null }, simReset: simReset(state) });
  openRuleCandidateInAssistant(ctx, { ...CANDIDATE, candidate_id: 'new_candidate' });
  const newDraftId = state.assistant.draft.draft_id;
  check('保存期间出现新草案：新草案有独立关联，旧保存关联仍保留',
    newDraftId !== oldDraftId && state.assistant.pendingDraftId === oldDraftId,
    JSON.stringify({ oldDraftId, newDraftId, pending: state.assistant.pendingDraftId }));
  resolveSave();
  await pending;
  controller.syncFromState();
  check('旧保存结果返回：不清除新的未保存草案',
    state.assistant.draft?.draft_id === newDraftId
    && state.assistant.savedNotice === null
    && state.assistant.draft.candidate_id === 'new_candidate'
    && state.assistant.messages.some((m) => m.text.includes('当前新草案保持不变')),
    JSON.stringify(state.assistant));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
