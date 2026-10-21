// 右侧常驻助手（首版规则闭环 UI；接口候选，未冻结）
// 页面：报告/规则/导入显示；分析问答页保留原入口，不再复制一个聊天系统。
// 首版 AI 动作只在规则页：用户主动点击“让 AI 理解”才发起规则 intent；
// 草案送入现有规则页弹窗，由用户确认/保存；历史模拟复用规则页触发。
import { el, chip } from './components.js';
import { createRuleAssistant } from '../agent/ruleAssistant.js';
import { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } from '../agent/httpTransport.js';
import { contractRuleSet } from '../demo/adapter.js';

let defaultClient = null;
let controller = null;

function getDefaultClient() {
  if (!defaultClient) {
    const transport = createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS });
    defaultClient = createRuleAssistant({ transport });
  }
  return defaultClient;
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

function scrollToSimulation() {
  if (typeof document === 'undefined') return;
  setTimeout(() => {
    const node = document.querySelector?.('[data-role="sim-section"]');
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 0);
}

export function createAssistantController({ client, state, set, go, scrollSimulation = scrollToSimulation }) {
  let seq = 0;
  const nextRequestId = () => `assistant-req-${++seq}`;

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

  async function submit(question = state.assistant.input) {
    const q = String(question ?? '').trim();
    if (!q || state.assistant.pending) return;
    const context = contextKey(state);
    const requestId = nextRequestId();
    patch({
      pending: true,
      requestId,
      contextKey: context,
      dataContextKey: dataContextKey(state),
      versionsBaselineCount: state.contracts.versions.length,
      versionsBaselineHashes: state.contracts.versions.map((v) => v.hash).filter(Boolean),
      semanticConfirmation: null,
      currentRule: null,
      ruleDrift: null,
      simulation: null,
      consistency: null,
      ruleStateKey: null,
      simulationKey: null,
      pendingConfirmationFlowId: null,
      input: '',
      error: null,
      staleNotice: null,
      messages: [...state.assistant.messages, { role: 'user', text: q }],
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
      patch({ pending: false, requestId: null, error: { code: 'E_ASSISTANT_UNEXPECTED', message: '助手链路出现未预期错误' } });
      return;
    }
    if (state.assistant.requestId !== requestId || contextKey(state) !== context) {
      if (state.assistant.requestId === requestId) {
        patch({ pending: false, requestId: null, staleNotice: '上下文已变化，旧回复已丢弃（审计记录保留）' });
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
    } else {
      messages.push({
        role: 'assistant',
        kind: 'notice',
        text: result.message || '本次没有生成规则建议。',
      });
    }
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
      error: result.ok ? null : { code: result.code, message: result.message },
      messages,
    });
  }

  function confirmInContract() {
    const draft = state.assistant.draft;
    if (!draft) return patch({ error: { code: 'E_ASSISTANT_NO_DRAFT', message: '当前没有可确认的规则草案' } });
    set({
      contracts: {
        modal: { mode: 'add', targetHash: null },
        draft: {
          template_id: draft.template_id,
          fields: Object.fromEntries(Object.entries(draft.fields).map(([k, v]) => [k, String(v)])),
          note: '来自 AI 规则理解草案；可在规则页修改后确认',
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
    go('contract');
    scrollSimulation();
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
        },
      },
      assistant: { ...state.assistant, mobileView: false, error: null },
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
    const latestSaved = added.find((v) => v && v.schema === 'contract-v1'
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
        simulationKey: null,
        consistency: null,
        error: null,
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
          consistency: changed.flow.consistency,
          explanation: changed.flow.explanation,
          trace: changed.flow.trace,
          ruleStateKey,
          error: null,
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
    if (matching.length === 0) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const symbol = state.contracts.sim.symbol ?? sim.symbol;
    const date = state.contracts.sim.date ?? sim.requested_date;
    if (!symbol || !date) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const summary = { triggered: 0, not_triggered: 0, missing_data: 0, error: 0 };
    for (const r of matching) summary[r.ok ? r.verdict : 'error'] += 1;
    const context = {
      symbol,
      date,
      market_source_id: sim.marketSourceId ?? null,
      data_snapshot_id: state.bill?.contextId ?? null,
    };
    const simKey = JSON.stringify({
      hash: effectiveRule.hash,
      rule_state: state.assistant.ruleStateKey ?? null,
      symbol,
      date,
      source: context.market_source_id,
      snapshot: context.data_snapshot_id,
      summary,
    });
    if (state.assistant.simulationKey === simKey) {
      if (Object.keys(noticePatch).length) patch(noticePatch);
      return;
    }
    const filtered = { ok: sim.ok, symbol, requested_date: date, marketSourceId: sim.marketSourceId ?? null, summary, results: matching };
    const recorded = client.recordSimulation({ flowId, simulation: filtered, source: 'rule_page', context });
    if (!recorded.ok) {
      patch({ ...noticePatch, error: { code: recorded.code, message: recorded.message } });
      return;
    }
    const executionRule = {
      template_id: effectiveRule.template_id,
      fields: effectiveRule.fields,
      hash: effectiveRule.hash,
      v: effectiveRule.version ?? effectiveRule.v ?? null,
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
      explanation: recorded.flow.explanation,
      consistency: consistency.consistency,
      trace: client.getTrace ? client.getTrace(flowId) : recorded.flow.trace,
      simulationKey: simKey,
      error: consistency.ok ? null : { code: consistency.code, message },
    });
  }

  return Object.freeze({
    submit,
    toggleOpen,
    closeMobile,
    confirmInContract,
    goSimulation,
    returnToRuleEdit,
    syncFromState,
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
    return '模拟使用的规则与你保存的规则不一致，结果已阻断。';
  }
  if (consistency.status !== 'consistent') return '核对尚未完成。';
  return consistency.semantic_confirmation_covers_rule === false
    ? '已核对：模拟对应当前生效规则；此前保存的规则不覆盖这次修改。'
    : '已核对：模拟使用的就是你当前保存的规则。';
}

function draftCard(controller, state) {
  const draft = state.assistant.draft;
  if (!draft) return null;
  const semantic = state.assistant.semanticConfirmation;
  const finalRule = semantic?.saved_rule ?? null;
  const currentRule = state.assistant.currentRule;
  const drift = state.assistant.ruleDrift;
  const sim = state.assistant.simulation;
  const simStale = sim?.stale === true;
  const consistency = state.assistant.consistency;
  const removed = drift?.status === 'removed';
  const statusChips = [
    chip(semantic ? (drift ? `此前保存：v${textOf(finalRule?.version)}` : `已保存：v${textOf(finalRule?.version)}`) : '尚未保存', semantic ? 'ok' : 'mode'),
    drift && currentRule ? chip(`当前生效：v${textOf(currentRule.version)}`, 'warn') : null,
    chip(sim ? (simStale ? '模拟：需要重新执行' : '模拟：已获得') : '模拟：未执行', sim && !simStale ? 'ok' : (simStale ? 'warn' : 'mode')),
  ];
  const card = el('div', { class: 'assistant-draft' }, [
    el('div', { class: 'assistant-draft-head' }, [
      removed ? '规则已停用' : drift ? '规则已更新' : semantic ? '你保存的规则' : 'AI 建议（尚未保存）',
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
      el('div', { class: 'muted small' }, ['这只是建议，保存后才会生效。']),
    ]),
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
    ]) : sim ? el('div', { class: 'assistant-sim' }, [
      el('div', { class: 'muted small' }, [`${textOf(sim.context?.symbol)} · ${textOf(sim.context?.date)}`]),
      el('div', {}, [`触发 ${sim.summary.triggered} · 未触发 ${sim.summary.not_triggered} · 数据不足 ${sim.summary.missing_data} · 错误 ${sim.summary.error}`]),
      el('div', { class: 'muted small' }, [`对应当前规则 v${textOf(sim.rule_version)}`]),
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
    consistency && !simStale ? el('div', { class: `assistant-check ${consistency.status === 'mismatch' ? 'bad' : 'ok'}` }, [
      detectionText(consistency),
      el('div', { class: 'muted small' }, ['未做独立复核。']),
    ]) : null,
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
  const consistency = a.consistency;
  if (!a.flowId && !a.draft) return null;
  const requestIds = trace?.messages?.[0]?.request_ids ?? [];
  const lines = [
    techLine('任务编号', a.flowId ?? '未生成'),
    techLine('请求编号', requestIds.join('、') || a.requestId || '无'),
    techLine('模型请求', `${a.modelCalls ?? 0}/${a.budgetMax ?? 2}`),
    techLine('是否出站', a.outbound ? '是' : '否'),
    techLine('计划', plan ? `${plan.plan_id} · ${plan.status}` : '未生成'),
    techLine('草案哈希', a.draft?.hash ?? '—'),
    techLine('保存规则哈希', saved ? `${saved.hash}（v${saved.version ?? '—'}）` : '—'),
    techLine('当前规则哈希', current ? `${current.hash}（v${current.version ?? '—'}）` : '—'),
    techLine('模拟执行规则', sim?.rule_hash ? `${sim.rule_hash}（v${sim.rule_version ?? '—'}）` : '—'),
    techLine('模拟失效', sim?.stale ? `是（${sim.stale_reason ?? '规则变化'}）` : '否'),
    techLine('核对状态', consistency
      ? `${consistency.status} · ${consistency.binding ?? '无绑定'} · 覆盖=${consistency.semantic_confirmation_covers_rule} · 独立复核=${consistency.independent_review}`
      : '未运行'),
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
  const goBusiness = (route) => {
    if (state.assistant.mobileView) ctx.set({ assistant: { ...state.assistant, mobileView: false } });
    ctx.go(route);
  };
  root.className = 'assistant-panel';
  const card = el('div', { class: 'assistant-card' });
  card.append(el('div', { class: 'assistant-head' }, [
    el('div', {}, [
      el('strong', {}, [ctx.assistantTitle ?? 'AI 规则助手']),
      el('div', { class: 'assistant-subtitle' }, [ctx.assistantSubtitle ?? '把规则说清楚；保存和模拟仍由你确认']),
    ]),
    el('div', { class: 'row' }, [
      el('button', { class: 'btn small assistant-back', onclick: () => controller.closeMobile() }, ['← 返回业务页面']),
      el('button', { class: 'assistant-close', 'aria-label': '收起助手', onclick: () => controller.toggleOpen(false) }, ['×']),
    ]),
  ]));
  card.append(el('div', { class: 'assistant-context' }, [contextLine(state)]));
  card.append(el('div', { class: 'assistant-local-status' }, [
    state.route === 'contract'
      ? '在下方描述规则；保存、模拟和调整都在交易规则页完成。'
      : '规则操作在交易规则页；这里会保留当前任务和结果。',
  ]));
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
          onclick: () => goBusiness('contract'),
        }, ['查看/新增规则']),
      ]) : null,
    ]));
  }

  if (state.route === 'contract') {
    const input = el('input', {
      class: 'input assistant-input',
      placeholder: '例如：当天涨幅超过 5% 的票我绝不买入',
      value: state.assistant.input,
      disabled: state.assistant.pending ? 'disabled' : null,
    });
    input.addEventListener('input', (e) => { state.assistant.input = e.target.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') controller.submit(input.value); });
    card.append(el('div', { class: 'assistant-input-row' }, [
      input,
      el('button', {
        class: 'btn primary small',
        disabled: state.assistant.pending ? 'disabled' : null,
        onclick: () => controller.submit(input.value),
      }, [state.assistant.pending ? '理解中…' : '让 AI 理解']),
    ]));
    card.append(el('div', { class: 'assistant-hint' }, ['只支持两种规则；点击后才会发送问题与最小上下文。']));
    if (ctx.assistantShowFactLink) {
      card.append(el('button', { class: 'btn small', onclick: () => goBusiness('chat') }, ['前往事实问答']));
    }
  } else {
    const note = state.route === 'report'
      ? '当前是报告页；规则任务仍保留在这里。'
      : state.route === 'chat'
        ? '当前是事实问答；规则任务仍保留在这里。'
        : state.route === 'home'
          ? '首页不发起请求；可以继续导入账单或描述规则。'
          : '导入页只显示当前任务；规则建议不要求已有账单。';
    card.append(el('div', { class: 'assistant-hint' }, [note]));
    if (!state.assistant.draft) {
      card.append(el('button', { class: 'btn small', onclick: () => goBusiness('contract') }, ['前往交易规则']));
    }
    if (ctx.assistantShowFactLink && state.route !== 'chat') {
      card.append(el('button', { class: 'btn small', onclick: () => goBusiness('chat') }, ['前往事实问答']));
    }
  }

  if (state.assistant.staleNotice) card.append(el('div', { class: 'assistant-drift' }, [state.assistant.staleNotice]));
  if (state.assistant.error) card.append(el('div', { class: 'assistant-error' }, [
    state.assistant.error.message ?? '操作未完成，请稍后重试。',
  ]));

  const messages = el('div', { class: 'assistant-messages' });
  for (const m of state.assistant.messages ?? []) {
    messages.append(el('div', { class: `assistant-msg ${m.role === 'user' ? 'user' : 'assistant'}` }, [m.text]));
  }
  if (state.assistant.pending) messages.append(el('div', { class: 'assistant-msg assistant' }, ['正在请求规则理解……']));
  if (messages.children.length) card.append(messages);

  const draft = draftCard(controller, state);
  if (draft) card.append(draft);

  const tech = technicalDetails(state);
  if (tech) card.append(tech);
  root.replaceChildren(card);
}
