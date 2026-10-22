// 右侧常驻助手（首版规则闭环 UI；接口候选，未冻结）
// 页面：报告/规则/导入显示；分析问答页保留原入口，不再复制一个聊天系统。
// 规则描述入口只在规则工作区；侧栏保留问答、草案与结果状态，不重复规则输入。
import { el, chip } from './components.js';
import { createRuleAssistant } from '../agent/ruleAssistant.js';
import { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } from '../agent/httpTransport.js';
import { contractRuleSet, contractTemplates } from '../demo/adapter.js';
import { renderQaAssistant } from './qaAssistant.js';

const CANDIDATE_ORIGIN = 'behavior_candidate';

let defaultClient = null;
let controller = null;

function getDefaultClient() {
  if (!defaultClient) {
    const transport = createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS });
    defaultClient = createRuleAssistant({ transport });
  }
  return defaultClient;
}

export function getRuleAssistantClient() {
  return getDefaultClient();
}

export function assistantDefaultOpen(width = 1440) {
  return Number.isFinite(width) ? width > 1024 : true;
}

export function buildAssistantContext(state) {
  const bill = state.bill ?? {};
  const versions = Array.isArray(state.contracts?.versions) ? state.contracts.versions : [];
  return {
    object_type: 'rule',
    ...(state.report && state.report.symbol && state.report.symbol !== 'pool' ? { symbol: state.report.symbol } : {}),
    ...(bill.supportScope?.asOfDate ? { as_of_date: bill.supportScope.asOfDate } : {}),
    ...(versions.length > 0 ? { confirmed_rule_versions: versions.map((v) => v.hash).filter(Boolean).slice(-5) } : {}),
    ...(bill.contextId ? { data_snapshot_id: bill.contextId } : {}),
  };
}

function contextKey(state) {
  const versions = Array.isArray(state.contracts?.versions) ? state.contracts.versions : [];
  return JSON.stringify({
    bill: state.bill?.contextId ?? null,
    route: state.route,
    symbol: state.report?.symbol ?? null,
    versions: versions.map((v) => v.hash).filter(Boolean).slice(-3),
  });
}

function dataContextKey(state) {
  return JSON.stringify({
    bill: state.bill?.contextId ?? null,
    symbol: state.report?.symbol ?? null,
  });
}

function currentRuleForTemplate(state, templateId) {
  const ruleSet = contractRuleSet(Array.isArray(state.contracts?.versions) ? state.contracts.versions : []);
  return ruleSet.slots.find((s) => s.template_id === templateId)?.current ?? null;
}

function ruleIdentity(rule) {
  if (!rule || typeof rule.hash !== 'string' || typeof rule.template_id !== 'string' || !rule.fields) return null;
  return {
    template_id: rule.template_id,
    fields: { ...rule.fields },
    hash: rule.hash,
    v: Number.isFinite(rule.v) ? rule.v : (Number.isFinite(rule.version) ? rule.version : null),
    schema: typeof rule.schema === 'string' ? rule.schema : null,
    scope: rule.scope && rule.scope.kind === 'symbol'
      ? { kind: 'symbol', symbol: rule.scope.symbol }
      : { kind: 'all' },
  };
}

function scopeDraftOf(rule) {
  return rule && rule.scope && rule.scope.kind === 'symbol'
    ? { kind: 'symbol', symbol: rule.scope.symbol }
    : { kind: 'all', symbol: '' };
}

function explanationReset(extra = {}) {
  return {
    resultExplanation: null,
    resultExplanationAttempt: null,
    resultExplanationPending: false,
    resultExplanationRequestId: null,
    resultExplanationKey: null,
    resultExplanationNotice: null,
    ...extra,
  };
}

function marketNoticeFromState(state) {
  const raw = state.contracts?.simContext?.error;
  const message = typeof raw === 'string' ? raw.trim() : (raw && typeof raw.message === 'string' ? raw.message.trim() : '');
  if (!message) return null;
  const code = message.match(/E_[A-Z0-9_]+/)?.[0] ?? 'E_MARKET_UNAVAILABLE';
  return { code, message };
}

function sameNotice(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const AUTO_BILL_NOTICE_PREFIX = '账单已确认导入：';

function isAutoBillNotice(message) {
  return message?.kind === 'notice'
    && typeof message.text === 'string'
    && message.text.startsWith(AUTO_BILL_NOTICE_PREFIX);
}

function scrollToSimulation() {
  if (typeof document === 'undefined') return;
  setTimeout(() => {
    const node = document.querySelector?.('[data-role="sim-section"]');
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 0);
}

export function createAssistantController({ client, state, set, go, scrollSimulation = scrollToSimulation }) {
  let seq = 0;
  let explainSeq = 0;
  const nextRequestId = () => `assistant-req-${++seq}`;
  const nextExplainRequestId = () => `assistant-explain-${++explainSeq}`;

  function patch(extra) {
    const next = { ...state.assistant, ...extra };
    if (JSON.stringify(next) === JSON.stringify(state.assistant)) return;
    set({ assistant: next });
  }

  function toggleOpen(open = !state.assistant.open) {
    patch({ open });
  }

  function closeMobile() {
    patch({ mobileView: false });
  }

  function discardDraft() {
    if (state.assistant.pending || !state.assistant.draft || state.assistant.semanticConfirmation) return;
    patch({
      draft: null,
      flowId: null,
      requestId: null,
      stage: 'idle',
      plan: null,
      trace: null,
      explanation: '',
      pending: false,
      input: '',
      lastQuestion: null,
      lastAttempt: null,
      error: null,
      staleNotice: null,
      semanticConfirmation: null,
      currentRule: null,
      ruleDrift: null,
      simulation: null,
      simulationAttempt: null,
      currentSimulationResultId: null,
      currentSimulationStatus: null,
      consistency: null,
      consistencyAttempt: null,
      pendingConfirmationFlowId: null,
      ruleStateKey: null,
      simulationKey: null,
      contextKey: null,
      dataContextKey: null,
      versionsBaselineCount: null,
      versionsBaselineHashes: [],
      messages: [...state.assistant.messages, {
        role: 'assistant',
        kind: 'notice',
        text: '草案已丢弃；没有保存或修改任何规则。',
      }],
      ...explanationReset(),
    });
  }

  function retryLast() {
    const q = state.assistant.lastQuestion
      || [...(state.assistant.messages ?? [])].reverse().find((m) => m.role === 'user')?.text
      || '';
    if (!q || state.assistant.pending) return;
    return submit(q, { retry: true });
  }

  function openManualTemplate() {
    const templates = contractTemplates();
    const draft = state.assistant.draft;
    const tpl = templates.find((t) => t.template_id === draft?.template_id) ?? templates[0];
    if (!tpl) return;
    const fields = Object.fromEntries(tpl.fields.map((f) => [
      f.key,
      String(draft?.fields?.[f.key] ?? f.default),
    ]));
    set({
      contracts: {
        modal: { mode: 'add', targetHash: null },
        draft: {
          template_id: tpl.template_id,
          fields,
          note: '',
          scope: scopeDraftOf(draft),
        },
        nl: null,
      },
      assistant: {
        ...state.assistant,
        mobileView: false,
        error: null,
      },
    });
    go('contract');
  }

  async function submit(question = state.assistant.input, { retry = false } = {}) {
    const q = String(question ?? '').trim();
    if (!q || state.assistant.pending) return;
    const context = contextKey(state);
    const requestId = nextRequestId();
    const previousMeta = {
      contextKey: state.assistant.contextKey,
      dataContextKey: state.assistant.dataContextKey,
      versionsBaselineCount: state.assistant.versionsBaselineCount,
      versionsBaselineHashes: [...(state.assistant.versionsBaselineHashes ?? [])],
    };
    patch({
      pending: true,
      requestId,
      contextKey: context,
      dataContextKey: dataContextKey(state),
      versionsBaselineCount: state.contracts.versions.length,
      versionsBaselineHashes: state.contracts.versions.map((v) => v.hash).filter(Boolean),
      input: '',
      lastQuestion: q,
      error: null,
      staleNotice: null,
      lastAttempt: null,
      messages: retry
        ? [...state.assistant.messages]
        : [...state.assistant.messages, { role: 'user', text: q }],
    });
    let result;
    try {
      result = await client.startFlow({
        question: q,
        contextSummary: buildAssistantContext(state),
        requestId,
      });
    } catch {
      if (state.assistant.requestId !== requestId) return;
      patch({
        ...previousMeta,
        pending: false,
        requestId: null,
        input: q,
        error: { code: 'E_ASSISTANT_UNEXPECTED', message: '助手链路出现未预期错误' },
        lastAttempt: { status: 'failed', code: 'E_ASSISTANT_UNEXPECTED', message: '助手链路出现未预期错误' },
      });
      return;
    }
    if (state.assistant.requestId !== requestId || contextKey(state) !== context) {
      if (state.assistant.requestId === requestId) {
        patch({ ...previousMeta, pending: false, requestId: null, staleNotice: '上下文已变化，旧回复已丢弃（审计记录保留）' });
      }
      return;
    }
    const flow = result.flow;
    const messages = [...state.assistant.messages];
    if (result.ok && flow.draft) {
      messages.push({
        role: 'assistant',
        kind: 'draft',
        text: 'AI 已生成规则建议；保存后才会生效。',
      });
      patch({
        pending: false,
        requestId: null,
        flowId: flow.flow_id,
        stage: flow.status,
        draft: flow.draft,
        plan: flow.plan,
        trace: flow.trace,
        explanation: flow.explanation,
        modelCalls: flow.model_calls,
        budgetMax: flow.budget_max,
        outbound: flow.outbound,
        semanticConfirmation: null,
        currentRule: null,
        ruleDrift: null,
        simulation: null,
        simulationAttempt: null,
        currentSimulationResultId: null,
        currentSimulationStatus: null,
        consistency: null,
        consistencyAttempt: null,
        ruleStateKey: null,
        simulationKey: null,
        pendingConfirmationFlowId: null,
        lastAttempt: null,
        error: null,
        ...explanationReset(),
        messages,
      });
      return;
    }
    messages.push({
      role: 'assistant',
      kind: 'notice',
      text: result.message || '本次没有生成规则建议。',
    });
    patch({
      ...previousMeta,
      pending: false,
      requestId: null,
      input: q,
      error: result.ok ? null : { code: result.code, message: result.message },
      lastAttempt: {
        status: flow.status ?? 'failed',
        code: result.code ?? null,
        message: result.message ?? '本次没有生成规则建议。',
        flowId: flow.flow_id ?? null,
        modelCalls: flow.model_calls ?? 0,
        budgetMax: flow.budget_max ?? 0,
        outbound: flow.outbound === true,
        trace: flow.trace ?? null,
      },
      messages,
    });
  }

  function confirmInContract() {
    const draft = state.assistant.draft;
    if (!draft) return patch({ error: { code: 'E_ASSISTANT_NO_DRAFT', message: '当前没有可确认的规则草案' } });
    set({
      contracts: {
        modal: { mode: 'add', targetHash: null, assistantFlowId: draft.flow_id },
        draft: {
          template_id: draft.template_id,
          fields: Object.fromEntries(Object.entries(draft.fields).map(([k, v]) => [k, String(v)])),
          note: draft.origin === CANDIDATE_ORIGIN
            ? '来自报告行为证据；可修改后确认'
            : '来自 AI 规则理解草案；可在规则页修改后确认',
          scope: scopeDraftOf(draft),
          assistantFlowId: draft.flow_id,
        },
      },
      assistant: {
        ...state.assistant,
        mobileView: false,
        pendingConfirmationFlowId: draft.flow_id,
        versionsBaselineCount: state.contracts.versions.length,
        versionsBaselineHashes: state.contracts.versions.map((v) => v.hash).filter(Boolean),
        dataContextKey: dataContextKey(state),
        error: null,
      },
    });
    go('contract');
  }

  function goSimulation() {
    if (!state.assistant.semanticConfirmation?.saved_rule) {
      patch({ error: { code: 'E_ASSISTANT_NO_SAVED_RULE', message: '尚未保存规则；请先前往编辑规则并保存' } });
      return;
    }
    if (state.assistant.mobileView) patch({ mobileView: false });
    go('scenario');
    const schedule = typeof requestAnimationFrame === 'function'
      ? (fn) => requestAnimationFrame(() => requestAnimationFrame(fn))
      : (fn) => setTimeout(fn, 0);
    schedule(scrollSimulation);
  }

  function returnToRuleEdit() {
    const semantic = state.assistant.semanticConfirmation;
    const templateId = semantic?.saved_rule?.template_id ?? state.assistant.draft?.template_id ?? null;
    const current = templateId ? currentRuleForTemplate(state, templateId) : null;
    const base = current
      ? ruleIdentity(current)
      : (state.assistant.currentRule ?? semantic?.saved_rule ?? state.assistant.draft);
    if (!base) {
      patch({ error: { code: 'E_ASSISTANT_NO_RULE', message: '当前没有可调整的规则' } });
      return;
    }
    set({
      contracts: {
        modal: current
          ? { mode: 'edit', targetHash: current.hash }
          : { mode: 'add', targetHash: null },
        draft: {
          template_id: base.template_id,
          fields: Object.fromEntries(Object.entries(base.fields ?? {}).map(([k, v]) => [k, String(v)])),
          note: current
            ? (current.latest_note ?? '')
            : '当前无同类型生效规则；取消不会修改已有记录，保存后会重新启用。',
          scope: scopeDraftOf(base),
        },
      },
      assistant: {
        ...state.assistant,
        mobileView: false,
        pendingConfirmationFlowId: null,
        error: null,
      },
    });
    go('contract');
  }

  function syncFromState() {
    if (state.assistant.pending) return;
    const notice = marketNoticeFromState(state);
    const noticePatch = sameNotice(notice, state.assistant.marketNotice) ? {} : { marketNotice: notice };
    const flowId = state.assistant.flowId;
    const draft = state.assistant.draft;
    if (!flowId || !draft) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    if (state.assistant.dataContextKey && state.assistant.dataContextKey !== dataContextKey(state)) {
      patch({ ...noticePatch, staleNotice: '数据上下文已变化，旧确认/模拟结果不会关联到当前任务（审计记录保留）' });
      return;
    }

    const currentCount = Array.isArray(state.contracts.versions) ? state.contracts.versions.length : 0;
    const baselineCount = Number.isInteger(state.assistant.versionsBaselineCount)
      ? state.assistant.versionsBaselineCount
      : currentCount;
    const added = currentCount > baselineCount ? state.contracts.versions.slice(baselineCount) : [];
    const latestSaved = added.find((v) => v
      && (v.schema === 'contract-v1' || v.schema === 'contract-v2')
      && v.assistant_flow_id === flowId
      && typeof v.hash === 'string' && typeof v.template_id === 'string');
    if (latestSaved && state.assistant.pendingConfirmationFlowId === flowId
      && latestSaved.hash !== state.assistant.semanticConfirmation?.saved_rule?.hash) {
      const result = client.recordSemanticConfirmation({ flowId, savedRule: latestSaved });
      if (!result.ok) {
        patch({ ...noticePatch, error: { code: result.code, message: result.message } });
        return;
      }
      const savedHash = result.flow.semantic_confirmation?.saved_rule?.hash ?? latestSaved.hash;
      const savedCurrent = currentRuleForTemplate(state, latestSaved.template_id);
      patch({
        ...noticePatch,
        stage: result.flow.status,
        semanticConfirmation: result.flow.semantic_confirmation,
        currentRule: result.flow.current_rule,
        ruleDrift: result.flow.rule_drift,
        explanation: result.flow.explanation,
        trace: result.flow.trace,
        pendingConfirmationFlowId: null,
        versionsBaselineCount: currentCount,
        versionsBaselineHashes: state.contracts.versions.map((v) => v.hash).filter(Boolean),
        ruleStateKey: `${savedHash}|${savedCurrent ? savedCurrent.hash : 'removed'}`,
        simulation: null,
        simulationAttempt: null,
        currentSimulationResultId: null,
        currentSimulationStatus: null,
        simulationKey: null,
        consistency: null,
        consistencyAttempt: null,
        error: null,
        ...explanationReset(),
      });
      return;
    }

    const semantic = state.assistant.semanticConfirmation;
    if (!semantic) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }

    let activeFlow = typeof client.getFlow === 'function' ? client.getFlow(flowId) : null;
    let effectiveRule = activeFlow?.current_rule ?? state.assistant.currentRule ?? semantic.saved_rule;
    if (typeof client.recordRuleState === 'function') {
      const current = currentRuleForTemplate(state, semantic.saved_rule.template_id);
      const ruleStateKey = `${semantic.saved_rule.hash}|${current ? current.hash : 'removed'}`;
      if (state.assistant.ruleStateKey !== ruleStateKey) {
        const changed = client.recordRuleState({ flowId, currentRule: current ? ruleIdentity(current) : null });
        if (!changed.ok) {
          patch({ ...noticePatch, error: { code: changed.code, message: changed.message } });
          return;
        }
        activeFlow = changed.flow;
        effectiveRule = changed.flow.current_rule ?? changed.flow.semantic_confirmation?.saved_rule ?? null;
        patch({
          ...noticePatch,
          stage: changed.flow.status,
          currentRule: changed.flow.current_rule,
          ruleDrift: changed.flow.rule_drift,
          simulation: changed.flow.simulation,
          simulationAttempt: changed.flow.simulationAttempt,
          currentSimulationResultId: changed.flow.latest_simulation_result_id ?? null,
          currentSimulationStatus: changed.flow.latest_simulation_status ?? null,
          consistency: changed.flow.consistency,
          consistencyAttempt: changed.flow.consistencyAttempt,
          explanation: changed.flow.explanation,
          trace: changed.flow.trace,
          ruleStateKey,
          simulationKey: null,
          error: null,
          ...explanationReset(),
        });
      }
    }

    if (state.bill?.status !== 'confirmed' || state.bill?.sourceType !== 'local') {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const sim = state.contracts.sim?.result;
    if (!sim || !Array.isArray(sim.results) || !effectiveRule) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const matching = sim.results.filter((r) => r && r.rule && r.rule.hash === effectiveRule.hash);
    const symbol = state.contracts.sim.symbol ?? sim.symbol;
    const date = state.contracts.sim.date ?? sim.requested_date;
    const context = {
      symbol: symbol || null,
      date: date || null,
      market_source_id: sim.marketSourceId ?? null,
      data_snapshot_id: state.bill?.contextId ?? null,
    };
    if (matching.length === 0) {
      const attemptKey = JSON.stringify({
        hash: effectiveRule.hash,
        rule_state: state.assistant.ruleStateKey ?? null,
        status: 'not_matched',
        symbol: context.symbol,
        date: context.date,
      });
      if (state.assistant.simulationKey !== attemptKey) {
        patch({
          ...noticePatch,
          simulationAttempt: {
            status: 'not_executed',
            ok: false,
            rule_hash: effectiveRule.hash,
            rule_scope: effectiveRule.scope ?? { kind: 'all' },
            context,
            summary: null,
            error: { code: 'E_SIMULATION_RULE_NOT_FOUND', message: '模拟结果不包含当前规则；本次未执行' },
          },
          explanation: '本次模拟结果不包含当前规则；未接收为本次结果。',
          currentSimulationResultId: null,
          currentSimulationStatus: 'failed',
          simulationKey: attemptKey,
          error: null,
          ...explanationReset(),
        });
      } else if (Object.keys(noticePatch).length) {
        patch(noticePatch);
      }
      return;
    }
    if (!symbol || !date) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const outcomeKey = matching.map((r) => [
      r.ok === true ? '1' : '0',
      r.display_verdict ?? r.verdict ?? 'error',
      r.code ?? '',
      r.effective_date ?? r.date_mapping?.effective_date ?? '',
    ].join(':')).join('|');
    const simKey = JSON.stringify({
      hash: effectiveRule.hash,
      rule_state: state.assistant.ruleStateKey ?? null,
      symbol,
      date,
      source: context.market_source_id,
      snapshot: context.data_snapshot_id,
      run: state.contracts.sim?.runId ?? null,
      outcome: outcomeKey,
    });
    if (state.assistant.simulationKey === simKey) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const recorded = client.recordSimulation({
      flowId,
      simulation: { ...sim, results: matching },
      source: 'rule_page',
      context,
    });
    if (!recorded.ok) {
      patch({
        ...noticePatch,
        error: { code: recorded.code, message: recorded.message },
        simulationAttempt: {
          status: 'not_executed',
          ok: false,
          rule_hash: effectiveRule.hash,
          rule_scope: effectiveRule.scope ?? { kind: 'all' },
          context,
          summary: null,
          error: { code: recorded.code, message: recorded.message },
        },
        currentSimulationResultId: recorded.flow?.latest_simulation_result_id ?? null,
        currentSimulationStatus: recorded.flow?.latest_simulation_status ?? 'failed',
        simulationKey: simKey,
        ...explanationReset(),
      });
      return;
    }
    if (recorded.status === 'simulation_failed') {
      patch({
        ...noticePatch,
        stage: recorded.flow.status,
        currentRule: recorded.flow.current_rule,
        ruleDrift: recorded.flow.rule_drift,
        simulation: recorded.flow.simulation,
        simulationAttempt: recorded.flow.simulationAttempt,
        currentSimulationResultId: recorded.flow.latest_simulation_result_id ?? null,
        currentSimulationStatus: recorded.flow.latest_simulation_status ?? 'failed',
        explanation: recorded.flow.explanation,
        consistency: recorded.flow.consistency,
        consistencyAttempt: recorded.flow.consistencyAttempt,
        trace: client.getTrace ? client.getTrace(flowId) : recorded.flow.trace,
        simulationKey: simKey,
        error: null,
        ...explanationReset(),
      });
      return;
    }
    const executionRule = {
      template_id: effectiveRule.template_id,
      fields: effectiveRule.fields,
      hash: effectiveRule.hash,
      v: effectiveRule.version ?? effectiveRule.v ?? null,
      scope: effectiveRule.scope ?? { kind: 'all' },
    };
    const consistency = client.checkConsistency({ flowId, executionRule });
    const status = consistency.consistency?.status;
    const message = status === 'not_confirmed'
      ? '尚未记录用户确认的规则'
      : status === 'not_executed'
        ? '尚未执行历史模拟'
        : '当前生效规则与实际执行参数不一致，已阻断';
    patch({
      ...noticePatch,
      stage: recorded.flow.status,
      currentRule: recorded.flow.current_rule,
      ruleDrift: recorded.flow.rule_drift,
      simulation: recorded.flow.simulation,
      simulationAttempt: null,
      currentSimulationResultId: recorded.flow.latest_simulation_result_id ?? recorded.flow.simulation?.result_id ?? null,
      currentSimulationStatus: recorded.flow.latest_simulation_status ?? 'completed',
      explanation: recorded.flow.explanation,
      consistency: consistency.consistency,
      consistencyAttempt: recorded.flow.consistencyAttempt ?? null,
      trace: client.getTrace ? client.getTrace(flowId) : recorded.flow.trace,
      simulationKey: simKey,
      error: consistency.ok ? null : { code: consistency.code, message },
      ...explanationReset(),
    });
  }

  function explanationEligibility() {
    if (!state.assistant.flowId) {
      return { ok: false, code: 'E_ASSISTANT_NO_FLOW', message: '当前没有规则任务', remaining: 0 };
    }
    if (state.assistant.marketNotice) {
      return { ok: false, code: 'E_ASSISTANT_MARKET_NOTICE', message: '行情暂不可用，不能解释本次结果', remaining: 0 };
    }
    if (typeof client.getExplanationEligibility !== 'function') {
      return { ok: false, code: 'E_ASSISTANT_EXPLANATION_UNAVAILABLE', message: '结果解释未配置', remaining: 0 };
    }
    return client.getExplanationEligibility(state.assistant.flowId);
  }

  async function explainResult() {
    if (state.assistant.resultExplanationPending) return;
    const flowId = state.assistant.flowId;
    if (!flowId) return;
    const eligibility = explanationEligibility();
    if (!eligibility.ok) {
      patch({
        error: null,
        resultExplanationNotice: eligibility.message ?? '当前不能解释本次结果',
      });
      return;
    }
    const requestId = nextExplainRequestId();
    const route = state.route;
    const dataKey = dataContextKey(state);
    const simulationKey = state.assistant.simulationKey;
    const resultId = state.assistant.currentSimulationResultId;
    const identity = ruleIdentity(state.assistant.currentRule ?? state.assistant.semanticConfirmation?.saved_rule);
    if (!identity || !resultId) return;
    patch({
      error: null,
      resultExplanation: null,
      resultExplanationAttempt: null,
      resultExplanationKey: null,
      resultExplanationPending: true,
      resultExplanationRequestId: requestId,
      resultExplanationNotice: null,
    });
    let result;
    try {
      result = await client.explainSimulationResult({ flowId, requestId });
    } catch {
      if (state.assistant.resultExplanationRequestId !== requestId) return;
      patch({
        resultExplanationPending: false,
        resultExplanationRequestId: null,
        resultExplanationAttempt: { status: 'failed', code: 'E_ASSISTANT_EXPLANATION_UNEXPECTED', message: '解释链路出现未预期错误' },
        resultExplanationNotice: '解释链路出现未预期错误；仅保留本地摘要',
      });
      return;
    }
    if (state.assistant.resultExplanationRequestId !== requestId) return;
    const flowState = result.flow ?? null;
    const basePatch = flowState ? {
      modelCalls: flowState.model_calls,
      budgetMax: flowState.budget_max,
      trace: flowState.trace,
      outbound: flowState.outbound,
    } : {};
    if (state.assistant.flowId !== flowId
      || state.route !== route
      || dataContextKey(state) !== dataKey
      || state.assistant.currentSimulationResultId !== resultId
      || state.assistant.simulationKey !== simulationKey) {
      patch({
        ...basePatch,
        resultExplanationPending: false,
        resultExplanationRequestId: null,
        resultExplanationNotice: '页面、规则或结果已变化，旧解释已丢弃',
      });
      return;
    }
    const currentIdentity = ruleIdentity(state.assistant.currentRule ?? state.assistant.semanticConfirmation?.saved_rule);
    if (!currentIdentity || currentIdentity.hash !== identity.hash
      || currentIdentity.v !== identity.v
      || JSON.stringify(currentIdentity.scope) !== JSON.stringify(identity.scope)) {
      patch({
        ...basePatch,
        resultExplanationPending: false,
        resultExplanationRequestId: null,
        resultExplanationNotice: '规则版本已变化，旧解释已丢弃',
      });
      return;
    }
    if (!result.ok) {
      patch({
        ...basePatch,
        resultExplanationPending: false,
        resultExplanationRequestId: null,
        resultExplanationAttempt: flowState?.result_explanation_attempt ?? {
          status: 'failed',
          code: result.code,
          message: result.message,
        },
        resultExplanationNotice: result.message ?? '解释未完成；仅保留本地摘要',
        error: null,
      });
      return;
    }
    const binding = result.explanation?.binding;
    if (!binding
      || binding.flow_id !== flowId
      || binding.request_id !== requestId
      || binding.rule_hash !== identity.hash
      || binding.rule_version !== identity.v
      || binding.simulation_result_id !== resultId
      || JSON.stringify(binding.scope) !== JSON.stringify(identity.scope)) {
      patch({
        ...basePatch,
        resultExplanationPending: false,
        resultExplanationRequestId: null,
        resultExplanationNotice: '解释绑定与当前规则/结果不一致，已丢弃',
      });
      return;
    }
    patch({
      ...basePatch,
      resultExplanation: result.explanation,
      resultExplanationAttempt: null,
      resultExplanationPending: false,
      resultExplanationRequestId: null,
      resultExplanationKey: `${flowId}|${identity.hash}|${identity.v}|${resultId}`,
      resultExplanationNotice: null,
      error: null,
    });
  }

  return Object.freeze({
    submit,
    toggleOpen,
    closeMobile,
    discardDraft,
    retryLast,
    openManualTemplate,
    confirmInContract,
    goSimulation,
    returnToRuleEdit,
    syncFromState,
    explanationEligibility,
    explainResult,
  });
}

function textOf(value) {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

const ROUTE_LABEL = Object.freeze({ home: '首页', import: '导入', report: '报告', chat: '分析问答', contract: '交易规则' });
const BILL_LABEL = Object.freeze({
  confirmed: '已确认',
  loaded: '待确认',
  invalid: '需修正',
  error: '读取失败',
  none: '未选择',
});

function contextLine(state) {
  const bill = state.bill ?? {};
  const asOf = bill.supportScope?.asOfDate ?? bill.marketSource?.asOfDate ?? null;
  const symbol = state.report?.symbol === 'pool' ? '组合' : textOf(state.report?.symbol);
  const billLabel = bill.status === 'confirmed' && bill.sourceType === 'local'
    ? '已确认本地账单'
    : BILL_LABEL[bill.status] ?? '未选择';
  return `当前页：${ROUTE_LABEL[state.route] ?? '导入'} · 账单：${billLabel} · 报告范围：${symbol}${asOf ? ` · 估值日：${asOf}` : ''}`;
}

function nextActionButtons(controller, state) {
  const semantic = state.assistant.semanticConfirmation;
  const sim = state.assistant.simulation;
  const simStale = sim?.stale === true;
  const marketNotice = state.assistant.marketNotice;
  const buttons = [];
  if (!semantic) {
    if (state.assistant.draft) {
      buttons.push(el('button', {
        class: 'btn primary small', 'data-role': 'assistant-next-edit',
        onclick: () => controller.confirmInContract(),
      }, ['前往编辑规则']));
      buttons.push(el('button', {
        class: 'btn small', 'data-role': 'assistant-discard',
        onclick: () => controller.discardDraft(),
      }, ['丢弃草案']));
    }
  } else {
    if (!marketNotice) {
      buttons.push(el('button', {
        class: 'btn primary small', 'data-role': 'assistant-next-sim',
        onclick: () => controller.goSimulation(),
      }, [sim && !simStale ? '再次前往历史模拟' : '前往历史模拟']));
    }
    buttons.push(el('button', {
      class: 'btn small', 'data-role': 'assistant-next-adjust',
      onclick: () => controller.returnToRuleEdit(),
    }, ['返回调整规则']));
  }
  return buttons.length ? el('div', { class: 'row assistant-actions' }, buttons) : null;
}

function detectionText(consistency) {
  if (!consistency) return null;
  if (consistency.status === 'mismatch') {
    return '一致性阻断：执行规则与保存规则的模板、字段或范围不一致。';
  }
  if (consistency.status !== 'consistent') return '一致性核对未完成。';
  return consistency.semantic_confirmation_covers_rule === false
    ? '一致性核对：执行规则对应当前生效规则；原语义确认不覆盖这次修改。'
    : '一致性核对：执行规则与当前保存规则一致。';
}

function simulationContextText(simulation) {
  const context = simulation?.context ?? {};
  const effective = Array.isArray(simulation?.results)
    ? simulation.results.find((r) => r.effective_date)?.effective_date ?? null
    : null;
  const base = `${textOf(context.symbol)} · ${textOf(context.date)}`;
  return effective && effective !== context.date ? `${base}（实际使用交易日 ${effective}）` : base;
}

function simulationCounts(simulation) {
  const s = simulation?.summary ?? {};
  return `触发 ${s.triggered ?? 0} · 未触发 ${s.not_triggered ?? 0} · 不适用 ${s.not_applicable ?? 0} · 数据不足 ${s.missing_data ?? 0} · 无法判定 ${s.error ?? 0}`;
}

function simulationDetailNodes(simulation) {
  const results = Array.isArray(simulation?.results) ? simulation.results : [];
  return results
    .filter((r) => r && (r.code || r.message || r.display_verdict || r.verdict))
    .map((r) => el('div', { class: 'muted small' }, [
      [
        r.display_verdict ?? r.verdict ?? (r.ok ? 'completed' : 'error'),
        r.code ? `（${r.code}）` : '',
        r.message ? ` · ${r.message}` : '',
      ].join(''),
    ]));
}

function explanationMatches(state) {
  const explanation = state.assistant.resultExplanation;
  const simulation = state.assistant.simulation;
  const rule = ruleIdentity(state.assistant.currentRule ?? state.assistant.semanticConfirmation?.saved_rule);
  if (!explanation || !simulation || !rule || !explanation.binding) return false;
  return explanation.binding.flow_id === state.assistant.flowId
    && explanation.binding.rule_hash === rule.hash
    && explanation.binding.rule_version === rule.v
    && explanation.binding.simulation_result_id === simulation.result_id
    && JSON.stringify(explanation.binding.scope) === JSON.stringify(rule.scope);
}

function explanationBlock(controller, state, simulation, attempt) {
  if (!simulation && !attempt && !state.assistant.resultExplanation) return null;
  const eligibility = controller.explanationEligibility();
  const blockedByMarket = !!state.assistant.marketNotice;
  const canExplain = eligibility.ok && !blockedByMarket;
  const pending = state.assistant.resultExplanationPending;
  const valid = explanationMatches(state);
  const remaining = eligibility.remaining ?? Math.max(0, (state.assistant.budgetMax ?? 2) - (state.assistant.modelCalls ?? 0));
  const buttonText = pending
    ? '解释生成中…'
    : canExplain
      ? `让 AI 解释本次结果（剩余 ${remaining} 次）`
      : 'AI 解释不可用';
  const nodes = [
    el('div', { class: 'assistant-draft-head' }, ['AI 结果解释（可选）']),
    el('div', { class: 'muted small' }, [
      '只有本次模拟执行成功且为命中/未命中时可用；不适用、数据不足、失败或无真实行情时只保留本地摘要。',
    ]),
  ];
  if (!valid) {
    nodes.push(el('div', { class: 'row assistant-actions' }, [
      el('button', {
        class: 'btn small', 'data-role': 'assistant-explain',
        disabled: (!canExplain || pending) ? '' : null,
        onclick: () => controller.explainResult(),
      }, [buttonText]),
    ]));
    if (!canExplain && !pending) {
      nodes.push(el('div', { class: 'muted small' }, [
        blockedByMarket ? '行情暂不可用，不能解释本次结果' : (eligibility.message ?? '当前不能解释本次结果'),
      ]));
    }
  } else {
    nodes.push(el('div', { class: 'assistant-confirmed' }, [
      el('div', { class: 'muted small' }, ['AI 解释（模型）· 仅限本次规则与模拟事实']),
      el('div', { class: 'assistant-explanation' }, [state.assistant.resultExplanation.answer_text]),
      el('div', { class: 'muted small' }, ['不改变语义确认或一致性；不是独立复核。']),
    ]));
  }
  if (state.assistant.resultExplanationAttempt) {
    const failed = state.assistant.resultExplanationAttempt;
    nodes.push(el('div', { class: 'assistant-check bad' }, [
      failed.status === 'stale' ? '旧 AI 解释已失效' : 'AI 解释未生成',
      failed.code ? `（${failed.code}）` : '',
      failed.message ? ` · ${failed.message}` : '',
      el('div', { class: 'muted small' }, ['本地摘要仍然有效；未生成模型解释。']),
    ]));
  }
  if (state.assistant.resultExplanationNotice) {
    nodes.push(el('div', { class: 'assistant-check' }, [state.assistant.resultExplanationNotice]));
  }
  return el('div', { class: 'assistant-draft' }, nodes);
}

function draftCard(controller, state) {
  const draft = state.assistant.draft;
  if (!draft) return null;
  const fromCandidate = draft.origin === CANDIDATE_ORIGIN;
  const evidence = Array.isArray(draft.evidence) ? draft.evidence.slice(0, 6) : [];
  const semantic = state.assistant.semanticConfirmation;
  const finalRule = semantic?.saved_rule ?? null;
  const currentRule = state.assistant.currentRule;
  const drift = state.assistant.ruleDrift;
  const sim = state.assistant.simulation;
  const attempt = state.assistant.simulationAttempt;
  const simStale = sim?.stale === true;
  const consistency = state.assistant.consistency;
  const removed = drift?.status === 'removed';
  const attemptFailed = attempt?.status === 'failed';
  const attemptNotRun = attempt?.status === 'not_executed';
  const simChip = attemptFailed
    ? chip('本次模拟：失败', 'warn')
    : attemptNotRun
      ? chip('本次模拟：未执行', 'warn')
      : simStale
        ? chip('模拟：需要重新执行', 'warn')
        : sim
          ? chip('模拟：执行完成', 'ok')
          : chip('模拟：未执行', 'mode');
  const statusChips = [
    chip(semantic ? (drift ? `此前保存：v${textOf(finalRule?.version)}` : `已保存：v${textOf(finalRule?.version)}`) : '尚未保存', semantic ? 'ok' : 'mode'),
    fromCandidate && !semantic ? chip('来源：报告行为证据', 'mode') : null,
    drift && currentRule ? chip(`当前生效：v${textOf(currentRule.version)}`, 'warn') : null,
    simChip,
  ];
  const card = el('div', {
    class: 'assistant-draft',
    'data-role': 'assistant-draft-card',
    tabindex: '-1',
  }, [
    el('div', { class: 'assistant-draft-head' }, [
      removed ? '规则已停用' : drift ? '规则已更新' : semantic ? '你保存的规则' : fromCandidate ? '来自报告证据的建议（尚未保存）' : 'AI 建议（尚未保存）',
    ]),
    el('div', { class: 'assistant-status' }, statusChips),
    semantic ? el('div', { class: 'assistant-confirmed' }, [
      el('div', { class: 'muted small' }, [drift ? '此前保存的规则' : '当前生效规则']),
      el('div', { class: 'assistant-rule-text' }, [finalRule.text]),
      el('div', { class: 'muted small' }, [
        `v${textOf(finalRule.version)} · ${semantic.draft_modified ? '你在 AI 建议基础上修改后保存' : '直接保存了 AI 建议'}`,
      ]),
    ]) : el('div', { class: 'assistant-confirmed' }, [
      el('div', { class: 'assistant-rule-text' }, [draft.text]),
      el('div', { class: 'muted small' }, [
        fromCandidate
          ? '来自本账单的行为证据，未调用 AI；可在下一步修改模板字段与备注。'
          : '这只是建议，保存后才会生效。',
      ]),
      el('div', { class: 'muted small' }, ['草案会保留在助手中；关闭或切页不会保存。']),
    ]),
    fromCandidate && !semantic && draft.basis ? el('div', { class: 'muted small' }, [draft.basis]) : null,
    fromCandidate && !semantic && evidence.length ? el('details', { class: 'assistant-tech' }, [
      el('summary', {}, [`查看证据（${evidence.length} 笔）`]),
      el('div', { class: 'assistant-tech-body' }, evidence.map((e) => el('div', { class: 'assistant-tech-line' }, [
        [e.trade_date, e.symbol, e.display?.rise ?? e.rise ?? '', e.line].filter(Boolean).join(' · '),
      ]))),
    ]) : null,
    drift ? el('div', { class: 'assistant-drift' }, [
      el('div', { class: 'assistant-draft-head' }, [removed ? '当前规则已停用' : '当前生效规则已变化']),
      currentRule
        ? el('div', { class: 'assistant-rule-text' }, [currentRule.text])
        : el('div', { class: 'muted small' }, ['当前没有生效规则。']),
      el('div', { class: 'muted small' }, [
        currentRule ? `v${textOf(currentRule.version)} · ` : '',
        '此前保存的记录不覆盖这次修改；旧模拟结果不能作为当前规则的验证。',
      ]),
    ]) : null,
    simStale ? el('div', { class: 'assistant-check bad' }, [
      '此前模拟结果已失效：它对应的是旧规则，当前规则需要重新模拟。',
      sim ? el('div', { class: 'muted small' }, [`此前结果：${simulationContextText(sim)} · ${simulationCounts(sim)}`]) : null,
    ]) : attemptFailed || attemptNotRun ? el('div', { class: 'assistant-sim' }, [
      el('div', { class: 'assistant-check bad' }, [
        attemptFailed ? '本次模拟执行失败' : '本次模拟未执行',
        attempt.error?.code ? `（${attempt.error.code}）` : '',
        attempt.error?.message ? ` · ${attempt.error.message}` : '',
        attempt.context?.date ? el('div', { class: 'muted small' }, [`本次对象：${simulationContextText(attempt)}`]) : null,
        attempt.summary ? el('div', { class: 'muted small' }, [simulationCounts(attempt)]) : null,
        ...simulationDetailNodes(attempt),
      ]),
      sim ? el('div', { class: 'assistant-check ok' }, [
        el('div', { class: 'muted small' }, [`上次有效结果：${simulationContextText(sim)}`]),
        el('div', {}, [simulationCounts(sim)]),
        ...simulationDetailNodes(sim),
        el('div', { class: 'muted small' }, ['仅对应其原上下文，不能冒充本次结果。']),
      ]) : null,
    ]) : sim ? el('div', { class: 'assistant-sim' }, [
      el('div', { class: 'muted small' }, [`本次模拟：${simulationContextText(sim)}`]),
      el('div', {}, [simulationCounts(sim)]),
      el('div', { class: 'muted small' }, [`对应规则 v${textOf(sim.rule_version)} · 执行完成`]),
      ...simulationDetailNodes(sim),
      sim.semantic_confirmation_covers_rule === false
        ? el('div', { class: 'muted small' }, ['这次模拟对应当前生效规则；此前保存的记录不覆盖这次修改。'])
        : null,
    ]) : el('div', { class: 'muted small' }, [
      state.assistant.marketNotice
        ? '行情暂不可用，暂时不能生成模拟结果；你仍可以查看或修改规则。'
        : state.bill?.status === 'confirmed' && state.bill?.sourceType === 'local'
          ? '尚未模拟；到规则页点击测试后，助手会自动接收结果，不会自动发起。'
          : '历史模拟需要先确认本地账单。',
    ]),
    attemptFailed || attemptNotRun
      ? el('div', { class: 'assistant-check' }, [
        detectionText(consistency)
          ? `历史一致性（仅对应上次结果）：${detectionText(consistency)}`
          : '本次一致性未运行：本次模拟未执行成功。',
        el('div', { class: 'muted small' }, ['一致性只核对规则/输入，不代表模拟成功或独立复核。']),
      ])
      : consistency && !simStale ? el('div', { class: `assistant-check ${consistency.status === 'mismatch' ? 'bad' : 'ok'}` }, [
        detectionText(consistency),
        el('div', { class: 'muted small' }, ['一致性只核对规则/输入，不代表模拟成功，也不是独立复核。']),
      ]) : null,
    explanationBlock(controller, state, sim, attempt),
    nextActionButtons(controller, state),
    semantic ? el('details', { class: 'assistant-tech' }, [
      el('summary', {}, ['查看 AI 原始建议']),
      el('div', { class: 'assistant-explanation' }, [draft.text]),
    ]) : null,
    state.assistant.explanation ? el('details', { class: 'assistant-tech' }, [
      el('summary', {}, ['查看说明']),
      el('div', { class: 'assistant-explanation' }, [state.assistant.explanation]),
    ]) : null,
  ]);
  return card;
}

function techLine(label, value) {
  return el('div', { class: 'assistant-tech-line' }, [`${label}：${textOf(value)}`]);
}

function technicalDetails(state) {
  const a = state.assistant;
  const trace = a.trace;
  const saved = a.semanticConfirmation?.saved_rule ?? null;
  const current = a.currentRule;
  const plan = a.plan;
  const sim = a.simulation;
  const attempt = a.simulationAttempt;
  const consistency = a.consistency;
  const last = a.lastAttempt;
  if (!a.flowId && !a.draft && !last) return null;
  const requestIds = trace?.messages?.[0]?.request_ids ?? [];
  const lines = [
    techLine('任务编号', a.flowId ?? '未生成'),
    techLine('请求编号', requestIds.join('、') || a.requestId || '无'),
    techLine('模型请求', `${a.modelCalls ?? 0}/${a.budgetMax ?? 2}`),
    techLine('是否出站', a.outbound ? '是' : '否'),
    techLine('计划', plan ? `${plan.plan_id} · ${plan.status}` : '未生成'),
    techLine('草案来源', a.draft?.origin === CANDIDATE_ORIGIN ? '报告行为证据（确定性）' : (a.draft ? 'AI 规则理解' : '—')),
    techLine('草案哈希', a.draft?.hash ?? '—'),
    techLine('保存规则哈希', saved ? `${saved.hash}（v${saved.version ?? '—'}）` : '—'),
    techLine('当前规则哈希', current ? `${current.hash}（v${current.version ?? '—'}）` : '—'),
    techLine('模拟执行规则', sim?.rule_hash ? `${sim.rule_hash}（v${sim.rule_version ?? '—'}）` : '—'),
    techLine('模拟状态', sim ? `${sim.status ?? 'completed'}${sim.stale ? '（已失效）' : ''}` : '未执行'),
    techLine('本次模拟尝试', attempt ? `${attempt.status}${attempt.error?.code ? ` · ${attempt.error.code}` : ''}` : '无'),
    techLine('模拟失效', sim?.stale ? `是（${sim.stale_reason ?? '规则变化'}）` : '否'),
    techLine('核对状态', consistency
      ? `${consistency.status} · ${consistency.binding ?? '无绑定'} · 覆盖=${consistency.semantic_confirmation_covers_rule} · 独立复核=${consistency.independent_review}`
      : '未运行'),
    techLine('结果解释', a.resultExplanation
      ? `ok · ${a.resultExplanation.binding?.simulation_result_id ?? '—'}`
      : (a.resultExplanationAttempt
        ? `${a.resultExplanationAttempt.status} · ${a.resultExplanationAttempt.code ?? '—'}`
        : '未生成')),
    techLine('结果解释绑定', a.resultExplanation?.binding
      ? `${a.resultExplanation.binding.rule_hash} · v${a.resultExplanation.binding.rule_version} · ${a.resultExplanation.binding.simulation_result_id}`
      : '—'),
    techLine('上次请求', last
      ? `${last.status ?? '—'} · ${last.code ?? '—'} · ${last.modelCalls ?? 0}/${last.budgetMax ?? 2}`
      : '无'),
    techLine('trace', trace ? trace.messages.map((m) => m.type).join(' → ') : '未生成'),
  ];
  if (a.error?.code) lines.push(techLine('错误码', a.error.code));
  if (a.marketNotice) lines.push(techLine('行情错误', `${a.marketNotice.code} · ${a.marketNotice.message}`));
  return el('details', { class: 'assistant-tech' }, [
    el('summary', {}, ['开发调试（技术信息）']),
    el('div', { class: 'assistant-tech-body' }, lines),
  ]);
}

let syncScheduled = false;
function scheduleAssistantSync() {
  if (syncScheduled || !controller) return;
  syncScheduled = true;
  Promise.resolve().then(() => {
    syncScheduled = false;
    controller.syncFromState();
  });
}

export function renderAssistantPanel(root, ctx) {
  const { state } = ctx;
  if (!root) return;
  if (!controller) {
    controller = createAssistantController({
      client: getDefaultClient(),
      state,
      set: ctx.set,
      go: ctx.go,
      scrollSimulation: ctx.scrollToSimulation,
    });
  }
  scheduleAssistantSync();
  root.className = 'assistant-panel';
  const card = el('div', {
    class: 'assistant-card',
    'aria-busy': state.assistant.pending ? 'true' : 'false',
  });
  card.append(el('div', { class: 'assistant-head' }, [
    el('div', {}, [
      el('strong', { id: 'assistant-panel-title' }, [ctx.assistantTitle ?? 'AI 规则助手']),
      el('div', { class: 'assistant-subtitle' }, [ctx.assistantSubtitle ?? '把规则说清楚；保存和模拟仍由你确认']),
    ]),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn small assistant-back', onclick: () => controller.closeMobile() }, ['← 返回业务页面']),
      el('button', { class: 'assistant-close', 'aria-label': '收起助手', onclick: () => controller.toggleOpen(false) }, ['×']),
    ]),
  ]));
  if (ctx.globalAssistant) card.append(renderQaAssistant(ctx));
  if (!ctx.globalAssistant) {
    card.append(el('div', { class: 'assistant-context' }, [contextLine(state)]));
    card.append(el('div', { class: 'assistant-local-status' }, [
      '规则操作在交易规则页；这里会保留当前任务和结果。',
    ]));
  }
  if (state.assistant.marketNotice) {
    card.append(el('div', { class: 'assistant-market' }, [
      el('div', { class: 'assistant-draft-head' }, ['行情暂不可用']),
      el('div', {}, ['现在无法生成有效的模拟结果。你可以继续查看或修改规则；系统不会用静态或合成行情替代。']),
      el('details', { class: 'assistant-tech' }, [
        el('summary', {}, ['技术详情（行情错误）']),
        el('div', { class: 'assistant-tech-body' }, [
          techLine('错误码', state.assistant.marketNotice.code),
          techLine('原始信息', state.assistant.marketNotice.message),
        ]),
      ]),
      !state.assistant.draft ? el('div', { class: 'row assistant-actions' }, [
        el('button', {
          class: 'btn small', 'data-role': 'assistant-market-rules',
          onclick: () => {
            if (state.assistant.mobileView) ctx.set({ assistant: { ...state.assistant, mobileView: false } });
            ctx.go('contract');
          },
        }, ['查看/新增规则']),
      ]) : null,
    ]));
  }

  if (!ctx.globalAssistant && state.route !== 'contract') {
    const note = state.assistant.draft
      ? '草案已保留在助手中；切页或关闭助手不会保存，也不会丢失。'
      : state.route === 'report'
        ? '当前是报告页；规则任务仍保留在这里。'
        : state.route === 'chat'
          ? '当前是事实问答；规则任务仍保留在这里。'
          : state.route === 'home'
            ? '首页不发起请求；可以继续导入账单或描述规则。'
            : '导入页只显示当前任务；规则建议不要求已有账单。';
    card.append(el('div', { class: 'assistant-hint' }, [note]));
  }

  if (state.assistant.staleNotice) card.append(el('div', { class: 'assistant-drift' }, [state.assistant.staleNotice]));
  if (state.assistant.error) {
    const last = state.assistant.lastAttempt;
    const canRetry = !!state.assistant.lastQuestion
      || (state.assistant.messages ?? []).some((m) => m.role === 'user');
    card.append(el('div', { class: 'assistant-error', role: 'alert' }, [
      el('div', {}, [state.assistant.error.message ?? '操作未完成，请稍后重试。']),
      last?.code ? el('div', { class: 'muted small' }, [`${last.status ?? 'failed'} · ${last.code}`]) : null,
      last ? el('div', { class: 'row assistant-actions' }, [
        el('button', {
          class: 'btn small', 'data-role': 'assistant-retry',
          disabled: state.assistant.pending || !canRetry ? 'disabled' : null,
          onclick: () => controller.retryLast(),
        }, ['重试']),
        el('button', {
          class: 'btn small', 'data-role': 'assistant-manual',
          onclick: () => controller.openManualTemplate(),
        }, ['改用手动模板']),
      ]) : null,
    ]));
  }

  if (state.assistant.pending) {
    card.append(el('div', { class: 'assistant-gen', role: 'status', 'aria-live': 'polite' }, [
      '正在请求规则理解，不会自动保存。',
    ]));
  }

  const messages = el('div', {
    class: 'assistant-messages',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': '助手消息',
  });
  for (const m of state.assistant.messages ?? []) {
    if (isAutoBillNotice(m)) continue;
    messages.append(el('div', { class: `assistant-msg ${m.role === 'user' ? 'user' : 'assistant'}` }, [m.text]));
  }
  if (messages.children.length) card.append(messages);

  const draft = draftCard(controller, state);
  if (draft) card.append(draft);

  const tech = technicalDetails(state);
  if (tech) card.append(tech);
  root.replaceChildren(card);
}
