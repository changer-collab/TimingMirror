// M2-C6 · 一次问答的四类消息关联与 JSONL 导出（纯函数；接口候选，未冻结）
// 基线仅写“一次问答四条消息 + 复核不通过回流重算”，未枚举消息名；此处采用最小候选映射：
//   1) question        问题与范围（只导出 question_hash，不导出问题原文）
//   2) plan            计划（plan_id/模板/工具/状态；在线复述路径无 planner 时如实标 not_used）
//   3) tool_execution  工具/本地事实准备/草稿/数字检查（按实际发生的步骤，不补造）
//   4) review_result   复核摘要 + 重算回流 + 最终回答状态
// 边界：不调用模型/网络；不读取凭据；不导出原始成交行、文件名、账户信息或问题原文。
//       真实运行只记录实际传入的 dialogue/online 结果；离线样例以 sample_kind=offline_sample 标记。
import { hashQuestion } from './planner.js';

export const TRACE_AUDIT_VERSION = 'candidate-1';

export const TRACE_AUDIT_CODES = Object.freeze({
  INPUT_INVALID: 'E_TRACE_INPUT_INVALID',
  EXPORT_INVALID: 'E_TRACE_EXPORT_INVALID',
});

export const TRACE_MESSAGE_TYPES = Object.freeze(['question', 'plan', 'tool_execution', 'review_result']);
export const IMPORT_TRACE_MESSAGE_TYPES = Object.freeze(['import_source', 'model_call', 'validation', 'draft', 'flow_end']);
const IMPORT_FORBIDDEN_KEYS = new Set([
  'content', 'text', 'rawText', 'raw_text', 'data', 'data_base64', 'base64',
  'image', 'images', 'url', 'file', 'file_name', 'fileName', 'ocr_text', 'prompt',
]);

const TOOL_STEPS = new Set(['prepare_facts', 'draft', 'number_check']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function invalid(code, message) {
  return { ok: false, code, errors: [message] };
}

function planMessage(plan) {
  if (!isObject(plan)) {
    return {
      type: 'plan',
      status: 'not_used',
      plan_id: null,
      reason: 'online_restate_path_no_planner',
      executed: false,
      steps: [],
    };
  }
  return {
    type: 'plan',
    status: plan.status ?? null,
    plan_id: plan.plan_id ?? null,
    question_hash: plan.question_hash ?? null,
    intent: plan.intent ?? null,
    confidence: plan.confidence ?? null,
    template_id: plan.template_id ?? null,
    composition_reason: plan.composition_reason ?? '',
    fallback_used: plan.fallback_used === true,
    executed: false,
    steps: Array.isArray(plan.steps)
      ? plan.steps.map((s) => ({
        tool: s.tool,
        status: s.status,
        params_keys: Array.isArray(s.params_keys) ? [...s.params_keys] : [],
        missing: Array.isArray(s.missing) ? [...s.missing] : [],
      }))
      : [],
    pending_params: Array.isArray(plan.pending_params) ? plan.pending_params.map((p) => ({ ...p })) : [],
  };
}

function toolMessage(dialogue, online) {
  if (dialogue) {
    const steps = Array.isArray(dialogue.trace)
      ? dialogue.trace.filter((t) => TOOL_STEPS.has(t.step)).map((t) => ({
        step: t.step,
        status: t.status,
        ...(t.code ? { code: t.code } : {}),
        ...(t.checked !== undefined ? { checked: t.checked } : {}),
        ...(t.source ? { source: t.source } : {}),
      }))
      : [];
    return { type: 'tool_execution', source: 'offline_dialogue', steps };
  }
  return {
    type: 'tool_execution',
    source: 'online_restate',
    steps: [{
      step: online.stage ?? 'restate',
      status: online.ok === true ? 'ok' : 'withheld',
      ...(online.code ? { code: online.code } : {}),
    }],
  };
}

function reviewMessage(review) {
  if (!isObject(review)) {
    return { available: false, reason: 'review_not_provided', recompute_log: [] };
  }
  const verify = isObject(review.verify) ? review.verify : null;
  const summary = verify && isObject(verify.summary) ? verify.summary : null;
  return {
    available: true,
    status: review.status ?? null,
    verify_id: isObject(review.meta) ? (review.meta.verify_id ?? null) : null,
    portfolio_published: review.portfolio_published === true,
    published_count: Array.isArray(review.published_facts) ? review.published_facts.length : 0,
    blocked_count: Array.isArray(review.blocked_facts) ? review.blocked_facts.length : 0,
    degraded_codes: Array.isArray(review.degraded)
      ? [...new Set(review.degraded.map((d) => d && d.code).filter(Boolean))]
      : [],
    verify_summary: summary ? {
      n_facts: summary.n_facts ?? null,
      pass: summary.pass ?? null,
      fail: summary.fail ?? null,
      identities_fail: summary.identities_fail ?? null,
      provenance_complete: verify.provenance_complete === true,
      dangling_refs: Array.isArray(verify.dangling_refs) ? verify.dangling_refs.length : 0,
    } : null,
    recompute_attempts: isObject(review.meta) && Number.isFinite(review.meta.recompute_attempts)
      ? review.meta.recompute_attempts
      : 0,
    recompute_log: Array.isArray(review.recompute_log)
      ? review.recompute_log.map((r) => ({
        recompute_id: r.recompute_id ?? null,
        attempt: r.attempt ?? null,
        path_used: r.path_used ?? null,
        result: r.result ?? null,
        final_status: r.final_status ?? null,
        code: r.code ?? null,
      }))
      : [],
  };
}

function verificationMessage(dialogue, online) {
  if (dialogue) {
    return {
      source: 'offline_dialogue',
      status: dialogue.answer_status ?? null,
      fallback_reason: dialogue.fallback_reason ?? null,
      numbers_checked: Number.isFinite(dialogue.numbers_checked) ? dialogue.numbers_checked : 0,
      verification_scope: dialogue.verification_scope ?? null,
    };
  }
  return {
    source: 'online_restate',
    status: online.ok === true ? 'numbers_passed' : 'withheld',
    code: online.code ?? null,
    number_check: isObject(online.number_check) ? {
      checked: online.number_check.checked ?? 0,
      matched_count: online.number_check.matched_count ?? 0,
      failed_count: online.number_check.failed_count ?? 0,
      failed_codes: Array.isArray(online.number_check.failed_codes) ? [...online.number_check.failed_codes] : [],
    } : null,
  };
}

/**
 * 将一次问答的离线对话结果或在线复述结果关联为四类消息。
 * @param {object} input
 * @param {string} input.question 用户问题（仅用于哈希，不进入消息/导出）
 * @param {object|null} [input.dialogue] runOfflineDialogue 的实际输出
 * @param {object|null} [input.online] createChatOnline().ask 的实际输出
 * @param {object|null} [input.review] runReview 的实际输出（用于复核/重算摘要）
 * @param {string|null} [input.requestId] 请求标识；缺省取 dialogue.request_id 或按哈希派生
 * @param {string|null} [input.intent] 在线路径的意图（离线路径取 dialogue.intent）
 * @param {string|null} [input.scope] 在线路径的作用域（离线路径取 dialogue.scope）
 * @param {string|null} [input.llmMode] 实际运行模式；缺省取 dialogue.llm_mode 或 unknown
 * @param {boolean} [input.sample] true＝离线/合成样例；false＝实际运行
 */
export function buildChatTrace({
  question,
  dialogue = null,
  online = null,
  review = null,
  requestId = null,
  intent = null,
  scope = null,
  llmMode = null,
  sample = false,
} = {}) {
  if (typeof question !== 'string' || question.trim() === '') {
    return invalid(TRACE_AUDIT_CODES.INPUT_INVALID, 'question 必须为非空字符串');
  }
  if ((dialogue === null) === (online === null)) {
    return invalid(TRACE_AUDIT_CODES.INPUT_INVALID, 'dialogue 与 online 必须恰有一个');
  }
  const questionHash = hashQuestion(question);
  const rid = typeof requestId === 'string' && requestId !== ''
    ? requestId
    : (dialogue && typeof dialogue.request_id === 'string' && dialogue.request_id !== ''
      ? dialogue.request_id
      : `trace-${questionHash.slice(0, 8)}`);
  const traceId = `trace-${hashQuestion(`${rid}|${questionHash}`).slice(0, 12)}`;
  const mode = dialogue ? 'offline_dialogue' : 'online_restate_path';
  const onlineOutbound = online !== null && online.stage === 'restate';
  const messages = [
    {
      type: 'question',
      request_id: rid,
      question_hash: questionHash,
      intent: dialogue ? (dialogue.intent ?? null) : intent,
      scope: dialogue ? (dialogue.scope ?? null) : scope,
      mode,
      outbound: onlineOutbound,
      gate: dialogue ? 'offline_intent_scope_gate' : 'local_scope_gate',
    },
    planMessage(dialogue ? dialogue.plan : null),
    toolMessage(dialogue, online),
    {
      type: 'review_result',
      review: reviewMessage(review),
      verification: verificationMessage(dialogue, online),
      final: {
        text: dialogue ? (dialogue.text ?? null) : (online ? (online.text ?? null) : null),
        llm_mode: llmMode ?? (dialogue ? (dialogue.llm_mode ?? 'unknown') : 'unknown'),
        source: dialogue ? (dialogue.source ?? 'offline_stub') : 'online_transport',
      },
    },
  ];
  return {
    ok: true,
    trace_version: TRACE_AUDIT_VERSION,
    trace_id: traceId,
    sample_kind: sample ? 'offline_sample' : 'runtime',
    llm_mode: llmMode ?? (dialogue ? (dialogue.llm_mode ?? 'unknown') : 'unknown'),
    messages,
    meta: {
      question_hash: questionHash,
      message_count: messages.length,
      has_plan: dialogue ? dialogue.plan !== null : false,
      has_review: isObject(review),
      recompute_records: isObject(review) && Array.isArray(review.recompute_log) ? review.recompute_log.length : 0,
    },
  };
}

function findForbiddenTraceKey(value, path = '') {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findForbiddenTraceKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (IMPORT_FORBIDDEN_KEYS.has(key)) return `${path ? `${path}.` : ''}${key}`;
    const found = findForbiddenTraceKey(child, `${path ? `${path}.` : ''}${key}`);
    if (found) return found;
  }
  return null;
}

/* 导入识别 trace：四类消息 + 可选 flow_end；与问答四类分开，不改变问答 JSONL 语义。
   flow_id/request_ids 贯通；llm_mode 保持原含义，模态用 modality 独立字段。
   导出前拒绝正文、图片、文件名、URL 等敏感字段。 */
export function exportImportTraceJsonl(trace) {
  if (!isObject(trace) || trace.ok !== true || typeof trace.flow_id !== 'string'
    || typeof trace.trace_id !== 'string' || !Array.isArray(trace.messages)
    || !(trace.messages.length === 4 || trace.messages.length === 5)
    || trace.messages.slice(0, 4).some((m, i) => !isObject(m) || m.type !== IMPORT_TRACE_MESSAGE_TYPES[i])
    || (trace.messages.length === 5 && trace.messages[4].type !== 'flow_end')
    || trace.messages.some((m) => m.flow_id !== trace.flow_id)) {
    return invalid(TRACE_AUDIT_CODES.EXPORT_INVALID, '导入 trace 非法或消息类型不匹配；不导出');
  }
  const forbidden = findForbiddenTraceKey(trace.messages);
  if (forbidden) return invalid(TRACE_AUDIT_CODES.EXPORT_INVALID, `导入 trace 含不允许字段：${forbidden}`);
  const lines = trace.messages.map((m, i) => {
    const { type, ...body } = m;
    return JSON.stringify({
      trace_version: trace.trace_version,
      trace_id: trace.trace_id,
      sample_kind: trace.sample_kind,
      llm_mode: trace.llm_mode,
      modality: trace.modality,
      flow_id: trace.flow_id,
      request_ids: Array.isArray(trace.request_ids) ? trace.request_ids : [],
      message_index: i + 1,
      message_type: type,
      ...body,
    });
  });
  return { ok: true, jsonl: lines.join('\n'), line_count: lines.length };
}

/** 导出为 JSONL：每条消息一行，稳定键序；仅接受四类消息的 trace。 */
export function exportTraceJsonl(trace) {
  if (!isObject(trace) || trace.ok !== true || !Array.isArray(trace.messages)
    || trace.messages.length !== TRACE_MESSAGE_TYPES.length
    || trace.messages.some((m, i) => !isObject(m) || m.type !== TRACE_MESSAGE_TYPES[i])) {
    return invalid(TRACE_AUDIT_CODES.EXPORT_INVALID, 'trace 非法或不是四类消息；不导出');
  }
  const lines = trace.messages.map((m, i) => {
    const { type, ...body } = m;
    return JSON.stringify({
      trace_version: trace.trace_version,
      trace_id: trace.trace_id,
      sample_kind: trace.sample_kind,
      llm_mode: trace.llm_mode,
      message_index: i + 1,
      message_type: type,
      ...body,
    });
  });
  return { ok: true, jsonl: lines.join('\n'), line_count: lines.length };
}
