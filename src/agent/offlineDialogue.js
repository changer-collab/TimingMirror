// 主线 C · 离线对话消费契约适配器（纯本地、同步；接口候选，未冻结）
// 链路：intent/scope 门 → planner.buildPlan（仅生成计划，不执行工具）→ answerFacts.prepareAnswerFacts
//       → 回答草稿生成（调用方草稿或离线模板）→ checkPreparedAnswer（内部复用 numberCheck）→ 结果/降级。
// 语义：
//   · 仅支持 intent='loss_overview' + scope='portfolio'；其余组合 → 固定无数字降级文本；
//   · number_check 只在草稿生成后调用；任一上游失败 → 同一固定降级文本，不回显候选答案数字；
//   · numbers_passed 仅表示可识别数字子集检查通过，不表示事实含义正确、不表示在线发布或在线链路完成；
//   · 计划仅用于契约留痕，不执行工具（不重算）；plan.status 可为 needs_context，如实保留、不篡改；
//   · 输出含 request_id / intent / scope / plan / answer_status / verification_scope / numbers_checked /
//     fallback_reason / trace / text / llm_mode / source；trace 无时间戳、延迟、代理记录或原始交易。
// 边界：不联网、不调用百炼/代理/外部 API，不读取凭证、token 或环境秘密；无 DOM / localStorage / 定时器；
//       prepared 快照仅本地使用；不改变任何能力 ready 状态；不修改 chatView 交互。
import { buildPlan } from './planner.js';
import { prepareAnswerFacts, checkPreparedAnswer } from './answerFacts.js';

export const OFFLINE_DIALOGUE_CODES = Object.freeze({
  INPUT_INVALID: 'E_DIALOGUE_INPUT_INVALID',
  COMBO_UNSUPPORTED: 'W_DIALOGUE_COMBO_UNSUPPORTED',
  PLAN_FALLBACK: 'W_DIALOGUE_PLAN_FALLBACK',
  PLAN_UNSUPPORTED: 'W_DIALOGUE_PLAN_UNSUPPORTED',
  FALLBACK: 'W_DIALOGUE_FALLBACK',
});

export const OFFLINE_DIALOGUE_FALLBACK_TEXT = '该问题当前无法基于已复核事实回答，已停止输出；离线模式不展示未经校验的数字。';

export const OFFLINE_DIALOGUE_LLM_MODE = 'offline_fallback';
export const OFFLINE_DIALOGUE_SOURCE = 'offline_stub';

const SUPPORTED_INTENT = 'loss_overview';
const SUPPORTED_SCOPE = 'portfolio';

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/* 计划留痕视图：剔除工具参数值（可能含原始交易），只保留结构/状态/缺失键 */
function planView(plan) {
  return {
    plan_id: plan.plan_id,
    question_hash: plan.question_hash,
    intent: plan.intent,
    confidence: plan.confidence,
    template_id: plan.template_id,
    composition_reason: plan.composition_reason,
    status: plan.status,
    fallback_used: plan.fallback_used,
    steps: plan.steps.map((s) => ({
      tool: s.tool,
      status: s.status,
      params_keys: [...(s.params_keys ?? [])],
      missing: [...(s.missing ?? [])],
    })),
    pending_params: [...(plan.pending_params ?? [])],
    reasons: [...plan.reasons],
  };
}

/* 离线模板草稿：只复述已发布事实的 display，不引入任何新数字 */
function buildOfflineDraft(prepared) {
  const byKey = new Map(prepared.facts.map((f) => [f.key, f]));
  const parts = [];
  const add = (label, key) => {
    const display = byKey.get(key)?.display;
    if (typeof display === 'string' && display !== '') parts.push(`${label} ${display}`);
  };
  add('组合实际收益', 'actualRet');
  add('对照收益', 'ghostRet');
  add('择时损耗', 'drag');
  add('损耗金额', 'dragMoney');
  const body = parts.length > 0 ? parts.join('，') : '暂无可用展示值';
  return `按已发布事实复述：${body}。离线模板仅复述已发布事实，不解释原因、不预测收益。`;
}

/**
 * 离线对话消费契约（候选接口）。
 * @param {object} input
 * @param {string} input.question 用户问题（用于 planner 与 request_id；不进入输出原文）
 * @param {string} input.intent 意图（仅支持 'loss_overview'）
 * @param {string} input.scope 作用域（仅支持 'portfolio'）
 * @param {object} input.review runReview（M1-C7）的实际输出
 * @param {string|null} [input.answerDraft] 调用方候选草稿（如未来在线模型输出）；null＝使用离线模板
 * @param {string|null} [input.requestId] 本地请求标识；缺省按输入确定性派生
 * @param {number} [input.confidence] 意图置信度（透传 planner 校验）
 * @returns {object} 契约结果（见文件头输出字段）
 */
export function runOfflineDialogue({
  question,
  intent = null,
  scope = null,
  review,
  answerDraft = null,
  requestId = null,
  confidence = 1,
} = {}) {
  const trace = [];
  const rid = typeof requestId === 'string' && requestId !== ''
    ? requestId
    : `req-${fnv1a64(`${typeof question === 'string' ? question : ''}|${String(intent ?? '')}|${String(scope ?? '')}`).slice(0, 8)}`;

  const result = ({
    plan = null,
    answer_status,
    verification_scope = null,
    numbers_checked = 0,
    fallback_reason = null,
    text,
    note = null,
  }) => ({
    request_id: rid,
    intent,
    scope,
    plan,
    answer_status,
    verification_scope,
    numbers_checked,
    fallback_reason,
    text,
    llm_mode: OFFLINE_DIALOGUE_LLM_MODE,
    source: OFFLINE_DIALOGUE_SOURCE,
    ...(note !== null ? { note } : {}),
    trace,
  });

  const withheld = (code, { plan = null, numbersChecked = 0 } = {}) => {
    trace.push({ step: 'fallback', status: 'withheld', code });
    return result({
      plan,
      answer_status: 'withheld',
      numbers_checked: numbersChecked,
      fallback_reason: code,
      text: OFFLINE_DIALOGUE_FALLBACK_TEXT,
    });
  };

  /* —— 输入门：问题须为字符串；草稿仅允许 null 或非空字符串 —— */
  if (typeof question !== 'string' || (answerDraft !== null && (typeof answerDraft !== 'string' || answerDraft.trim() === ''))) {
    trace.push({ step: 'input', status: 'rejected', code: OFFLINE_DIALOGUE_CODES.INPUT_INVALID });
    return withheld(OFFLINE_DIALOGUE_CODES.INPUT_INVALID);
  }
  trace.push({ step: 'input', status: 'ok' });

  /* —— 唯一支持组合：其余意图/作用域不进入规划与事实链 —— */
  if (intent !== SUPPORTED_INTENT || scope !== SUPPORTED_SCOPE) {
    trace.push({ step: 'intent_scope_gate', status: 'rejected', code: OFFLINE_DIALOGUE_CODES.COMBO_UNSUPPORTED });
    return withheld(OFFLINE_DIALOGUE_CODES.COMBO_UNSUPPORTED);
  }
  trace.push({ step: 'intent_scope_gate', status: 'accepted' });

  /* —— 计划：只生成、不执行（不重算）；needs_context 如实保留且不阻断事实快照链 —— */
  const plan = buildPlan({ question, intentJson: { intent, slots: {}, confidence } });
  const planOut = planView(plan);
  trace.push({ step: 'plan', status: plan.status, executed: false });
  if (plan.status === 'fallback') return withheld(OFFLINE_DIALOGUE_CODES.PLAN_FALLBACK, { plan: planOut });
  if (plan.status === 'unsupported') return withheld(OFFLINE_DIALOGUE_CODES.PLAN_UNSUPPORTED, { plan: planOut });

  /* —— 事实快照（复用 answerFacts；不重新导出、不重算） —— */
  const prepared = prepareAnswerFacts({ review, intent, scope });
  trace.push({
    step: 'prepare_facts',
    status: prepared.status,
    ...(prepared.status === 'prepared' ? {} : { code: prepared.diagnostics[0].code }),
  });
  if (prepared.status !== 'prepared') {
    return withheld(prepared.diagnostics[0].code || OFFLINE_DIALOGUE_CODES.FALLBACK, { plan: planOut });
  }

  /* —— 草稿生成（在 numberCheck 之前；失败时草稿不进入结果） —— */
  const draftSource = answerDraft === null ? 'offline_template' : 'caller';
  const draft = answerDraft === null ? buildOfflineDraft(prepared) : answerDraft;
  trace.push({ step: 'draft', status: 'generated', source: draftSource });

  /* —— 数字检查（只在草稿生成后调用；复用 answerFacts → numberCheck） —— */
  const checked = checkPreparedAnswer({ prepared, answerText: draft });
  trace.push({
    step: 'number_check',
    status: checked.status === 'numbers_passed' ? 'passed' : 'withheld',
    checked: checked.check_record.checked,
    ...(checked.status === 'numbers_passed' ? {} : { code: checked.diagnostics[0].code }),
  });
  if (checked.status !== 'numbers_passed') {
    return withheld(checked.diagnostics[0].code || OFFLINE_DIALOGUE_CODES.FALLBACK, {
      plan: planOut,
      numbersChecked: checked.check_record.checked,
    });
  }

  return result({
    plan: planOut,
    answer_status: 'numbers_passed',
    verification_scope: checked.verification_scope,
    numbers_checked: checked.check_record.checked,
    text: draft,
    note: checked.note,
  });
}
