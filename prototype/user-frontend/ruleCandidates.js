// 规则候选 → 既有契约弹窗或助手草案：只做字段预填，保存仍由用户确认。
import { contractTemplates, previewContract } from '../../src/demo/adapter.js';
import { recordCandidateEvent } from './profileStore.js';

// 报告证据草案没有 AI flow；用本地 draft_id 从载入、编辑到保存结果返回保持同一关联。
let candidateDraftSeq = 0;
const nextCandidateDraftId = () => `candidate-draft-${++candidateDraftSeq}`;

function candidateFields(candidate, template) {
  const fields = {};
  for (const f of template.fields) {
    const value = candidate.fields?.[f.key];
    fields[f.key] = String(value === undefined ? f.default : value);
  }
  return fields;
}

export function openRuleCandidate(ctx, candidate) {
  if (!ctx || !candidate || candidate.status !== 'available') return false;
  const template = contractTemplates().find((t) => t.template_id === candidate.template_id);
  if (!template) return false;
  const fields = candidateFields(candidate, template);
  recordCandidateEvent(candidate.candidate_id, 'opened');
  ctx.set({
    contracts: {
      modal: { mode: 'add', targetHash: null },
      draft: {
        template_id: candidate.template_id,
        fields,
        note: '',
        scope: { kind: 'all', symbol: '' },
      },
      nl: null,
      restorePending: null,
    },
  });
  ctx.go('contract');
  return true;
}

// 报告 CTA：不在报告页弹规则窗，而是打开常驻助手并带入证据；仍由用户进入规则页保存。
export function openRuleCandidateInAssistant(ctx, candidate) {
  if (!ctx?.set || !candidate || candidate.status !== 'available') return false;
  const state = ctx.state;
  if (!state?.assistant) return false;
  const template = contractTemplates().find((t) => t.template_id === candidate.template_id);
  if (!template) return false;
  const fields = candidateFields(candidate, template);
  const parsed = previewContract({ template_id: candidate.template_id, fields, scope: { kind: 'all' } });
  const supported = parsed?.supported !== false;
  const draftId = nextCandidateDraftId();
  const draft = {
    origin: 'behavior_candidate',
    draft_id: draftId,
    template_id: candidate.template_id,
    fields,
    text: supported ? parsed.text : candidate.text,
    hash: supported ? parsed.hash : null,
    flow_id: null,
    candidate_id: candidate.candidate_id,
    source_pattern: candidate.source_pattern ?? null,
    basis: candidate.basis ?? '',
    reason: candidate.reason ?? '',
    caveat: candidate.caveat ?? '',
    evidence: Array.isArray(candidate.evidence) ? candidate.evidence.slice(0, 6) : [],
  };
  recordCandidateEvent(candidate.candidate_id, 'opened');
  ctx.set({
    assistant: {
      ...state.assistant,
      open: true,
      mobileView: ctx.isOverlayLayout?.() === true,
      pending: false,
      requestId: null,
      flowId: null,
      draftId,
      // 保存中的旧草案关联要保留，旧结果返回时才能提示且不误清新草案。
      pendingDraftId: state.assistant.pendingDraftId ?? null,
      savedNotice: null,
      stage: 'draft',
      draft,
      plan: null,
      trace: null,
      explanation: '',
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
      modelCalls: 0,
      outbound: false,
      resultExplanation: null,
      resultExplanationAttempt: null,
      resultExplanationPending: false,
      resultExplanationRequestId: null,
      resultExplanationKey: null,
      resultExplanationNotice: null,
      messages: [
        ...(Array.isArray(state.assistant.messages) ? state.assistant.messages : []),
        { role: 'assistant', kind: 'draft', text: '已从报告行为证据载入规则草案；未调用 AI，保存前请核对模板与阈值。' },
      ],
    },
  });
  ctx.focusAssistant?.();
  return true;
}
