// 规则候选 → 既有契约弹窗：只做字段预填，保存仍由用户在规则页确认。
import { contractTemplates } from '../../src/demo/adapter.js';
import { recordCandidateEvent } from './profileStore.js';

export function openRuleCandidate(ctx, candidate) {
  if (!ctx || !candidate || candidate.status !== 'available') return false;
  const template = contractTemplates().find((t) => t.template_id === candidate.template_id);
  if (!template) return false;
  const fields = {};
  for (const f of template.fields) {
    const value = candidate.fields?.[f.key];
    fields[f.key] = String(value === undefined ? f.default : value);
  }
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
  ctx.go('rules');
  return true;
}
