// 服务端确定性兜底：只复述引擎事实与规范化候选，不补 AI 观察，不推断新模板。
import {
  BEHAVIOR_ANALYSIS_PROTOCOL,
  canonicalRuleCandidates,
  publicPattern,
} from './behaviorAnalysis.mjs';

export function buildBehaviorFallback(facts, fallbackReason = 'model_unavailable') {
  return {
    protocol: BEHAVIOR_ANALYSIS_PROTOCOL,
    source: 'backend_rules',
    fallback_reason: fallbackReason,
    scope: facts.scope,
    patterns: [{ ...publicPattern(facts), comment: null }],
    observations: [],
    rule_candidates: canonicalRuleCandidates(facts),
    trading: facts.trading,
  };
}
