// 账单导入补救（客户端编排；接口候选，未冻结）
// 链路：用户点击 → 本地内容检查 → 文本识别请求 → 本地结构与字段校验 → 可编辑草稿。
// Flow 生命周期：首个真实模型请求才创建 flow；同一 flow 最多 2 次计入预算的模型响应；
//       网络失败、客户端超时、5xx 和请求体过大退回本次计数，允许用户重试；
//       重新上传、切页、助手开合、草稿清空与刷新都不结束/重建 flow；只有本地账单正式确认后
//       才通过 completeFlow 收口，下一次请求才创建新 flow。一个标签页同时只有一个活动 flow。
// 服务端是无状态的：只校验单次请求形状与响应结构，不接收/不计数 flow_id/request_id；
//       flow_id、request_id、预算计数与 trace 由本模块维护（与现有规则助手相同）。
// 边界：不读取凭证；不发送原始文件/文件名；不自动分批调用。
// 超时口径：Qoder Sites 未公开函数 wall-clock 上限；日志仅验证约 15.05s 成功。
//       视觉服务端 best-effort 设为 20s、客户端 25s，不假设 30s 或 60s 可用；
//       若部署后出现无业务 code 的网关级 504，不能继续盲目增加 timeout。
import { hashQuestion } from './planner.js';
import { exportImportTraceJsonl } from './traceAudit.js';
import {
  IMPORT_VISION_STAGE,
  IMPORT_VISION_CODES,
  validateVisionInput,
} from './importVision.js';
import { validateColumnMapping } from '../engine/importColumnMapping.js';

export const IMPORT_RECOVERY_STAGE = 'bill_extract';
export const IMPORT_RECOVERY_MAX_MODEL_CALLS = 2;
export const IMPORT_RECOVERY_TIMEOUT_MS = 8000;
export const IMPORT_VISION_TIMEOUT_MS = 25000;
export const IMPORT_RECOVERY_MAX_CONTENT_CHARS = 15000;
export const IMPORT_RECOVERY_MAX_TRADES = 500;
export const IMPORT_RECOVERY_SESSION_KEY = 'tm.importRecovery.session';

export const IMPORT_RECOVERY_SOURCE_KINDS = Object.freeze(['csv', 'tsv', 'xlsx', 'pdf', 'text']);

export const IMPORT_RECOVERY_CODES = Object.freeze({
  INPUT_INVALID: 'E_IMPORT_RECOVERY_INPUT_INVALID',
  LOCAL_BLOCKED: 'W_IMPORT_RECOVERY_LOCAL_BLOCKED',
  SOURCE_UNSUPPORTED: 'W_IMPORT_RECOVERY_SOURCE_UNSUPPORTED',
  MODEL_TIMEOUT: 'W_IMPORT_RECOVERY_MODEL_TIMEOUT',
  MODEL_TIMEOUT_SERVER: 'W_IMPORT_RECOVERY_MODEL_TIMEOUT_SERVER',
  MODEL_UNAVAILABLE: 'W_IMPORT_RECOVERY_MODEL_UNAVAILABLE',
  MODEL_NOT_CONFIGURED: 'W_IMPORT_RECOVERY_MODEL_NOT_CONFIGURED',
  MODEL_RATE_LIMITED: 'W_IMPORT_RECOVERY_MODEL_RATE_LIMITED',
  MODEL_RESPONSE: 'E_IMPORT_RECOVERY_MODEL_RESPONSE',
  REQUEST_TOO_LARGE: 'W_IMPORT_RECOVERY_REQUEST_TOO_LARGE',
  REQUEST_INVALID: 'W_IMPORT_RECOVERY_REQUEST_INVALID',
  BUDGET_EXHAUSTED: 'W_IMPORT_RECOVERY_BUDGET_EXHAUSTED',
  EMPTY_RESULT: 'W_IMPORT_RECOVERY_EMPTY_RESULT',
});

const SITE_FAILURE_CODES = Object.freeze({
  BODY_TOO_LARGE: 'E_FUNCTION_BODY_TOO_LARGE',
  BODY_INVALID: 'E_FUNCTION_BODY_INVALID',
  REQUEST_INVALID: 'E_FUNCTION_REQUEST_INVALID',
  UNKNOWN_FIELD: 'E_FUNCTION_UNKNOWN_FIELD',
  JSON_INVALID: 'E_FUNCTION_JSON_INVALID',
  CONTENT_TYPE: 'E_FUNCTION_CONTENT_TYPE',
  MODEL_NOT_CONFIGURED: 'E_MODEL_NOT_CONFIGURED',
  MODEL_AUTH_FAILED: 'E_MODEL_AUTH_FAILED',
  MODEL_FORBIDDEN: 'E_MODEL_FORBIDDEN',
  MODEL_RATE_LIMITED: 'E_MODEL_RATE_LIMITED',
  MODEL_UNAVAILABLE: 'E_MODEL_UNAVAILABLE',
  MODEL_TIMEOUT: 'E_MODEL_TIMEOUT',
  MODEL_RESPONSE: 'E_MODEL_RESPONSE_INVALID',
  IMPORT_RECOVER_REQUEST_INVALID: 'E_IMPORT_RECOVER_REQUEST_INVALID',
  IMPORT_RECOVER_RESPONSE: 'E_IMPORT_RECOVER_RESPONSE_INVALID',
  IMPORT_VISION_REQUEST_INVALID: 'E_IMPORT_VISION_REQUEST_INVALID',
  IMPORT_VISION_RESPONSE: 'E_IMPORT_VISION_RESPONSE_INVALID',
});

const LOCAL_BLOCKED_PATTERNS = Object.freeze([
  /(身份证|银行卡|手机号|住址|邮箱|密码|验证码|账户号|资金账号|股东账号|api[_ -]?key|apikey|token|凭据|credential|authorization|bearer)/i,
]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = 200) => typeof v === 'string' && v.length <= max;
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/* 把一次失败映射成用户可理解、可重试的类别；技术失败由调用方退回预算。 */
export function classifyRequestFailure(call = {}) {
  const status = Number.isInteger(call.upstream_status) ? call.upstream_status : null;
  const upstream = typeof call.upstream_code === 'string' ? call.upstream_code : '';
  if (call.code === IMPORT_RECOVERY_CODES.MODEL_TIMEOUT) {
    return {
      status: 'timeout',
      code: IMPORT_RECOVERY_CODES.MODEL_TIMEOUT,
      message: 'AI 识别超时（本机等待上限）；未生成草稿，可重试或手动修改',
      retryable: true,
    };
  }
  if (status === 413 || upstream === SITE_FAILURE_CODES.BODY_TOO_LARGE || upstream === SITE_FAILURE_CODES.BODY_INVALID) {
    return {
      status: 'too_large',
      code: IMPORT_RECOVERY_CODES.REQUEST_TOO_LARGE,
      message: '图片请求体过大；请删除部分图片或降低清晰度后重试',
      retryable: true,
    };
  }
  if (status === 504 || upstream === SITE_FAILURE_CODES.MODEL_TIMEOUT) {
    return {
      status: 'timeout',
      code: IMPORT_RECOVERY_CODES.MODEL_TIMEOUT_SERVER,
      message: 'AI 识别服务端超时；未生成草稿，可重试或手动修改',
      retryable: true,
    };
  }
  if (status === 429 || upstream === SITE_FAILURE_CODES.MODEL_RATE_LIMITED) {
    return {
      status: 'unavailable',
      code: IMPORT_RECOVERY_CODES.MODEL_RATE_LIMITED,
      message: 'AI 识别请求过于频繁；未生成草稿，请稍后重试或手动修改',
      retryable: true,
    };
  }
  if (upstream === SITE_FAILURE_CODES.IMPORT_VISION_RESPONSE
    || upstream === SITE_FAILURE_CODES.IMPORT_RECOVER_RESPONSE
    || upstream === SITE_FAILURE_CODES.MODEL_RESPONSE) {
    return {
      status: 'clarify',
      code: IMPORT_RECOVERY_CODES.MODEL_RESPONSE,
      message: 'AI 返回的内容未通过结构校验；未生成草稿，可重试或手动修改',
      retryable: true,
    };
  }
  if (status === 400
    || upstream === SITE_FAILURE_CODES.IMPORT_VISION_REQUEST_INVALID
    || upstream === SITE_FAILURE_CODES.IMPORT_RECOVER_REQUEST_INVALID
    || upstream === SITE_FAILURE_CODES.REQUEST_INVALID
    || upstream === SITE_FAILURE_CODES.UNKNOWN_FIELD
    || upstream === SITE_FAILURE_CODES.JSON_INVALID
    || upstream === SITE_FAILURE_CODES.CONTENT_TYPE) {
    return {
      status: 'invalid',
      code: IMPORT_RECOVERY_CODES.REQUEST_INVALID,
      message: '识别请求未通过服务端校验；请调整图片或重新选择后重试',
      retryable: true,
    };
  }
  if (upstream === SITE_FAILURE_CODES.MODEL_NOT_CONFIGURED) {
    return {
      status: 'unavailable',
      code: IMPORT_RECOVERY_CODES.MODEL_NOT_CONFIGURED,
      message: 'AI 识别服务尚未配置模型；未生成草稿，请手动修改或联系管理员',
      retryable: false,
    };
  }
  if (upstream === SITE_FAILURE_CODES.MODEL_AUTH_FAILED || upstream === SITE_FAILURE_CODES.MODEL_FORBIDDEN) {
    return {
      status: 'unavailable',
      code: IMPORT_RECOVERY_CODES.MODEL_UNAVAILABLE,
      message: 'AI 识别服务鉴权失败；未生成草稿，请联系管理员或手动修改',
      retryable: false,
    };
  }
  if (upstream === SITE_FAILURE_CODES.MODEL_UNAVAILABLE) {
    return {
      status: 'unavailable',
      code: IMPORT_RECOVERY_CODES.MODEL_UNAVAILABLE,
      message: 'AI 识别当前不可用；未生成草稿，可重试或手动修改',
      retryable: true,
    };
  }
  return {
    status: 'unavailable',
    code: IMPORT_RECOVERY_CODES.MODEL_UNAVAILABLE,
    message: 'AI 识别当前不可用；未生成草稿，可重试或手动修改',
    retryable: true,
  };
}

function localGate({ content, sourceKind }) {
  if (!IMPORT_RECOVERY_SOURCE_KINDS.includes(sourceKind)) {
    return failure(IMPORT_RECOVERY_CODES.SOURCE_UNSUPPORTED, '当前输入类型没有可用的文本识别通道');
  }
  if (typeof content !== 'string' || content.trim() === '') {
    return failure(IMPORT_RECOVERY_CODES.INPUT_INVALID, '没有可识别的文字内容');
  }
  if (content.length > IMPORT_RECOVERY_MAX_CONTENT_CHARS) {
    return failure(
      IMPORT_RECOVERY_CODES.INPUT_INVALID,
      `识别文字过长（上限 ${IMPORT_RECOVERY_MAX_CONTENT_CHARS} 字符）；请只保留需要核对的交易片段，或继续手动修改草稿`,
    );
  }
  if (LOCAL_BLOCKED_PATTERNS.some((re) => re.test(content))) {
    return failure(
      IMPORT_RECOVERY_CODES.LOCAL_BLOCKED,
      '内容里包含身份证、银行卡、联系方式或凭据等敏感信息；为保护隐私，没有发送模型请求。请先删除这些内容',
    );
  }
  return { ok: true };
}

function toText(value, max = 32) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

function normalizePageRange(raw) {
  if (Array.isArray(raw) && raw.length === 2) {
    const [start, end] = raw.map((n) => Number(n));
    if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) return { start, end };
    return null;
  }
  if (isObject(raw)) {
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start) return { start, end };
  }
  return null;
}

function normalizeSide(value) {
  if (value === null || value === undefined || value === '') return null;
  const side = String(value).trim().toLowerCase();
  if (['买入', '买', 'buy', 'b'].includes(side)) return '买入';
  if (['卖出', '卖', 'sell', 's'].includes(side)) return '卖出';
  return undefined;
}

export function validateRecoveryResponse(rawText, { allowColumnMapping = false } = {}) {
  const responseKeys = allowColumnMapping ? ['trades', 'unresolved', 'column_mapping'] : ['trades', 'unresolved'];
  if (typeof rawText !== 'string') return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, '识别响应不是字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, '识别响应不是合法 JSON');
  }
  if (!isObject(parsed)) return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, '识别响应必须为对象');
  const extra = Object.keys(parsed).filter((key) => !responseKeys.includes(key));
  if (extra.length) return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `识别响应包含不允许字段：${extra.join(',')}`);
  if (!Array.isArray(parsed.trades) || parsed.trades.length > IMPORT_RECOVERY_MAX_TRADES) {
    return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, '识别响应 trades 必须为数组且不超过上限');
  }
  if (parsed.unresolved !== undefined && !Array.isArray(parsed.unresolved)) {
    return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, '识别响应 unresolved 必须为数组');
  }
  const baseTradeKeys = ['date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax', 'confidence', 'issues'];
  const allowedTradeKeys = new Set(allowColumnMapping
    ? [...baseTradeKeys, 'name', 'amount', 'settlement_amount']
    : baseTradeKeys);
  const trades = [];
  for (let i = 0; i < parsed.trades.length; i++) {
    const raw = parsed.trades[i];
    if (!isObject(raw)) return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `trades[${i}] 必须为对象`);
    const extraKeys = Object.keys(raw).filter((key) => !allowedTradeKeys.has(key));
    if (extraKeys.length) return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `trades[${i}] 包含不允许字段：${extraKeys.join(',')}`);
    const date = raw.date === null || raw.date === undefined ? null : (isText(raw.date, 32) ? raw.date.trim() : undefined);
    const symbol = raw.symbol === null || raw.symbol === undefined ? null : (isText(raw.symbol, 16) ? raw.symbol.trim() : undefined);
    const name = raw.name === null || raw.name === undefined ? null : (isText(raw.name, 32) ? raw.name.trim() : undefined);
    const side = normalizeSide(raw.side);
    const price = toText(raw.price);
    const quantity = toText(raw.quantity);
    const amount = toText(raw.amount);
    const settlementAmount = toText(raw.settlement_amount);
    const fee = toText(raw.fee);
    const tax = toText(raw.tax);
    if ([date, symbol, name, side, price, quantity, amount, settlementAmount, fee, tax].some((v) => v === undefined)) {
      return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `trades[${i}] 字段类型或长度非法`);
    }
    const confidence = raw.confidence === undefined ? 0 : raw.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `trades[${i}].confidence 必须为 [0,1]`);
    }
    const issues = raw.issues === undefined ? [] : raw.issues;
    if (!Array.isArray(issues) || issues.length > 5 || issues.some((issue) => !isText(issue, 200) || issue.trim() === '')) {
      return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `trades[${i}].issues 必须为最多 5 条短文本`);
    }
    trades.push({
      date: date === null ? null : date,
      symbol,
      name,
      side,
      price,
      quantity,
      amount,
      settlement_amount: settlementAmount,
      fee,
      tax,
      confidence,
      issues: issues.map((issue) => issue.trim()),
    });
  }
  const unresolved = [];
  for (let i = 0; i < (parsed.unresolved ?? []).length; i++) {
    const raw = parsed.unresolved[i];
    if (!isObject(raw)) return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `unresolved[${i}] 必须为对象`);
    const extraKeys = Object.keys(raw).filter((key) => !['row', 'reason'].includes(key));
    if (extraKeys.length) return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `unresolved[${i}] 包含不允许字段`);
    if (!isText(raw.reason, 300) || raw.reason.trim() === '') {
      return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `unresolved[${i}].reason 必须为非空短文本`);
    }
    if (raw.row !== undefined && raw.row !== null && (!Number.isInteger(raw.row) || raw.row < 0)) {
      return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `unresolved[${i}].row 必须为非负整数或 null`);
    }
    unresolved.push({ row: raw.row ?? null, reason: raw.reason.trim() });
  }
  let columnMapping = [];
  if (allowColumnMapping && parsed.column_mapping !== undefined) {
    const checked = validateColumnMapping(parsed.column_mapping);
    if (!checked.ok) {
      return failure(IMPORT_RECOVERY_CODES.MODEL_RESPONSE, `原图列名映射未通过校验：${checked.reason}`);
    }
    columnMapping = checked.value;
  }
  if (trades.length === 0 && unresolved.length === 0) {
    return failure(IMPORT_RECOVERY_CODES.EMPTY_RESULT, 'AI 没有识别到可用的交易明细');
  }
  return { ok: true, trades, unresolved, columnMapping };
}

function invokeWithTimeout(fn, request, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const started = Date.now();
    let timer;
    const timeout = new Promise((resolveTimeout) => {
      timer = setTimeout(() => {
        controller.abort();
        resolveTimeout({
          ok: false,
          code: IMPORT_RECOVERY_CODES.MODEL_TIMEOUT,
          latencyMs: Date.now() - started,
        });
      }, timeoutMs);
    });
    const call = Promise.resolve()
      .then(() => fn({ ...request, signal: controller.signal }))
      .then((response) => ({ ok: true, response, latencyMs: Date.now() - started }))
      .catch((error) => ({
        ok: false,
        code: controller.signal.aborted || (error && (error.name === 'AbortError' || error.code === 'E_MODEL_TIMEOUT'))
          ? IMPORT_RECOVERY_CODES.MODEL_TIMEOUT
          : IMPORT_RECOVERY_CODES.MODEL_UNAVAILABLE,
        upstream_code: error && typeof error.upstreamCode === 'string' ? error.upstreamCode : null,
        upstream_status: error && Number.isInteger(error.status) ? error.status : null,
        latencyMs: Date.now() - started,
      }));
    Promise.race([call, timeout])
      .then((result) => resolve(result))
      .finally(() => { if (timer !== undefined) clearTimeout(timer); });
  });
}

function traceFor(flow) {
  const common = {
    flow_id: flow.flow_id,
    modality: flow.modality ?? 'text',
    source_kind: flow.source_kind,
    image_count: flow.image_count ?? 0,
    page_count: flow.page_count ?? 0,
    page_range: flow.page_range ?? null,
    input_bytes: flow.input_bytes ?? 0,
  };
  return {
    ok: true,
    trace_version: 'candidate-1',
    trace_id: `trace-${flow.flow_id}`,
    flow_id: flow.flow_id,
    sample_kind: 'runtime',
    llm_mode: 'unknown',
    modality: flow.modality ?? 'text',
    request_ids: flow.requests.map((r) => r.request_id),
    messages: [
      {
        type: 'import_source',
        ...common,
        content_hash: flow.content_hash,
        gate: flow.gate,
        outbound: flow.outbound,
        request_ids: flow.requests.map((r) => r.request_id),
        model_calls: flow.model_calls,
        budget_max: flow.budget_max,
      },
      {
        type: 'model_call',
        flow_id: flow.flow_id,
        modality: flow.modality ?? 'text',
        calls: flow.requests.map((r) => ({ ...r })),
      },
      {
        type: 'validation',
        flow_id: flow.flow_id,
        status: flow.status,
        code: flow.code,
        trade_count: flow.draft ? flow.draft.trades.length : 0,
        unresolved_count: flow.draft ? flow.draft.unresolved.length : 0,
      },
      {
        type: 'draft',
        flow_id: flow.flow_id,
        status: flow.status,
        trade_count: flow.draft ? flow.draft.trades.length : 0,
        unresolved_count: flow.draft ? flow.draft.unresolved.length : 0,
      },
      ...(flow.status === 'completed' ? [{
        type: 'flow_end',
        ...common,
        status: 'completed',
        reason: flow.completion_reason ?? null,
        bill_context_id: flow.bill_context_id ?? null,
        request_ids: flow.requests.map((r) => r.request_id),
        model_calls: flow.model_calls,
        budget_max: flow.budget_max,
        ended_at: flow.ended_at,
      }] : []),
    ],
  };
}

export function createImportRecovery({
  transport,
  timeoutMs = IMPORT_RECOVERY_TIMEOUT_MS,
  visionTimeoutMs = IMPORT_VISION_TIMEOUT_MS,
  maxModelCalls = IMPORT_RECOVERY_MAX_MODEL_CALLS,
  now = () => Date.now(),
  storage = (typeof sessionStorage !== 'undefined' ? sessionStorage : null),
} = {}) {
  if (!transport || typeof transport.importRecover !== 'function') {
    throw new TypeError('transport 必须提供 importRecover()');
  }
  if (!Number.isInteger(maxModelCalls) || maxModelCalls <= 0) throw new TypeError('maxModelCalls 必须为正整数');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正数');
  if (!Number.isFinite(visionTimeoutMs) || visionTimeoutMs <= 0) throw new TypeError('visionTimeoutMs 必须为正数');

  const sessionTag = Math.random().toString(36).slice(2, 8) || 'local';
  let seq = 0;
  let inFlight = false;
  let activeFlow = null;
  let lastCompleted = null;

  function nextFlowId() {
    return `import-flow-${sessionTag}-${String(++seq).padStart(3, '0')}`;
  }

  function makeFlow({ flowId = null, status = 'idle', modelCalls = 0, requests = [], createdAt = now(), stored = {} } = {}) {
    return {
      flow_id: flowId ?? nextFlowId(),
      status,
      code: null,
      message: '',
      gate: 'not_run',
      source_kind: typeof stored.source_kind === 'string' ? stored.source_kind : null,
      content_hash: null,
      modality: stored.modality === 'vision' ? 'vision' : (stored.modality === 'text' ? 'text' : null),
      image_count: Number.isFinite(stored.image_count) ? stored.image_count : 0,
      page_count: Number.isFinite(stored.page_count) ? stored.page_count : 0,
      page_range: normalizePageRange(stored.page_range),
      input_bytes: Number.isFinite(stored.input_bytes) ? stored.input_bytes : 0,
      outbound: false,
      model_calls: Math.min(Math.max(modelCalls, 0), maxModelCalls),
      budget_max: maxModelCalls,
      requests: requests.filter((r) => r && typeof r.request_id === 'string').slice(-10),
      draft: null,
      created_at: Number.isFinite(createdAt) ? createdAt : now(),
      ended_at: null,
      completion_reason: null,
      bill_context_id: null,
    };
  }

  function readStoredFlow() {
    try {
      const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(IMPORT_RECOVERY_SESSION_KEY) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed.flow_id !== 'string' || !Number.isInteger(parsed.model_calls)
        || parsed.model_calls < 0 || !Array.isArray(parsed.requests)) {
        return null;
      }
      return makeFlow({
        flowId: parsed.flow_id,
        status: 'restored',
        modelCalls: parsed.model_calls,
        requests: parsed.requests,
        createdAt: parsed.created_at,
        stored: parsed,
      });
    } catch {
      return null;
    }
  }

  activeFlow = readStoredFlow();

  function persist() {
    if (!storage) return;
    try {
      if (!activeFlow) {
        if (typeof storage.removeItem === 'function') storage.removeItem(IMPORT_RECOVERY_SESSION_KEY);
        else if (typeof storage.setItem === 'function') storage.setItem(IMPORT_RECOVERY_SESSION_KEY, '');
        return;
      }
      storage.setItem(IMPORT_RECOVERY_SESSION_KEY, JSON.stringify({
        flow_id: activeFlow.flow_id,
        model_calls: activeFlow.model_calls,
        budget_max: activeFlow.budget_max,
        requests: activeFlow.requests.slice(-10),
        created_at: activeFlow.created_at,
        source_kind: activeFlow.source_kind,
        modality: activeFlow.modality,
        image_count: activeFlow.image_count,
        page_count: activeFlow.page_count,
        page_range: activeFlow.page_range,
        input_bytes: activeFlow.input_bytes,
      }));
    } catch { /* 会话存储不可用时只保留内存计数 */ }
  }

  function resultFor(flow, status, code, message, extra = {}) {
    return {
      ok: status === 'draft',
      status,
      code,
      message,
      model_calls: flow ? flow.model_calls : 0,
      budget_max: maxModelCalls,
      remaining: flow ? Math.max(0, flow.budget_max - flow.model_calls) : maxModelCalls,
      outbound: flow ? flow.outbound : false,
      flow: flow ? clone(flow) : null,
      trace: flow ? traceFor(flow) : null,
      ...extra,
    };
  }

  function finish(flow, status, code, message, extra = {}) {
    inFlight = false;
    flow.status = status;
    flow.code = code;
    flow.message = message;
    flow.ended_at = flow.ended_at ?? now();
    if (flow === activeFlow) persist();
    return resultFor(flow, status, code, message, extra);
  }

  function completeFlow({ reason = 'bill_confirmed', billContextId = null } = {}) {
    if (!activeFlow) return { ok: true, completed: false, flow: null, trace: null };
    const flow = activeFlow;
    flow.status = 'completed';
    flow.code = null;
    flow.message = '本次导入流程已结束';
    flow.ended_at = now();
    flow.completion_reason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim().slice(0, 64) : 'unknown';
    flow.bill_context_id = typeof billContextId === 'string' && billContextId.trim() !== '' ? billContextId.trim().slice(0, 64) : null;
    lastCompleted = clone(flow);
    lastCompleted.trace = traceFor(flow);
    activeFlow = null;
    persist();
    return { ok: true, completed: true, flow: clone(flow), trace: traceFor(flow) };
  }

  async function runModelRequest({ sourceKind, modality, requestId, transportFn, request, contentHash, traceMeta = {} }) {
    if (inFlight) {
      return resultFor(activeFlow, 'busy', IMPORT_RECOVERY_CODES.INPUT_INVALID,
        '上一次识别还在进行中，请等它结束或稍后重试');
    }
    if (activeFlow && activeFlow.model_calls >= activeFlow.budget_max) {
      return finish(activeFlow, 'budget_exhausted', IMPORT_RECOVERY_CODES.BUDGET_EXHAUSTED,
        '本次导入任务的模型请求次数已用完；可以继续手动修改草稿或使用常规解析，不会再调用模型');
    }
    if (!activeFlow) {
      activeFlow = makeFlow({ status: 'active' });
      persist();
    }
    const flow = activeFlow;
    flow.source_kind = sourceKind;
    flow.modality = modality;
    flow.content_hash = contentHash;
    flow.gate = 'local_accepted';
    flow.image_count = Number.isFinite(traceMeta.imageCount) ? traceMeta.imageCount : 0;
    flow.page_count = Number.isFinite(traceMeta.pageCount) ? traceMeta.pageCount : 0;
    flow.page_range = normalizePageRange(traceMeta.pageRange);
    flow.input_bytes = Number.isFinite(traceMeta.inputBytes) ? traceMeta.inputBytes : 0;
    flow.ended_at = null;
    inFlight = true;
    persist();
    const requestTimeoutMs = modality === 'vision' ? visionTimeoutMs : timeoutMs;
    for (let attempt = 1; flow.model_calls < flow.budget_max; attempt++) {
      const rid = (attempt === 1 && typeof requestId === 'string' && requestId !== '')
        ? requestId
        : `import-req-${flow.flow_id}-${flow.requests.length + 1}`;
      flow.outbound = true;
      persist();
      const call = await invokeWithTimeout(transportFn, {
        ...request,
        flow_id: flow.flow_id,
        request_id: rid,
      }, requestTimeoutMs);
      // 只有拿到 2xx 响应才计入预算；网络失败、超时、5xx、413 不消耗，允许用户重试。
      const counted = call.ok === true;
      if (counted) flow.model_calls = Math.min(flow.budget_max, flow.model_calls + 1);
      const record = {
        request_id: rid,
        attempt,
        stage: modality === 'vision' ? IMPORT_VISION_STAGE : IMPORT_RECOVERY_STAGE,
        modality,
        image_count: flow.image_count,
        page_count: flow.page_count,
        input_bytes: flow.input_bytes,
        timeout_ms: requestTimeoutMs,
        latency_ms: call.latencyMs ?? null,
        status: call.ok ? 'ok' : 'failed',
        code: call.ok ? null : call.code,
        upstream_code: call.ok ? null : (call.upstream_code ?? null),
        upstream_status: call.ok ? null : (call.upstream_status ?? null),
        counted,
      };
      flow.requests.push(record);
      persist();
      if (!call.ok) {
        const failure = classifyRequestFailure(call);
        return finish(flow, failure.status, failure.code, failure.message, {
          upstream: { code: call.upstream_code ?? null, status: call.upstream_status ?? null },
          retryable: failure.retryable,
        });
      }
      const checked = validateRecoveryResponse(call.response && call.response.rawText, {
        allowColumnMapping: modality === 'vision',
      });
      if (!checked.ok) {
        if (flow.model_calls < flow.budget_max) continue;
        return finish(flow, 'clarify', checked.code,
          `AI 返回的内容未通过结构校验；本次识别次数已用完（${flow.model_calls}/${flow.budget_max}），可结束本次识别后重新开始或手动修改`,
          { retryable: false });
      }
      flow.draft = {
        trades: checked.trades,
        unresolved: checked.unresolved,
        columnMapping: checked.columnMapping ?? [],
      };
      return finish(flow, 'draft', null, `AI 已整理出 ${checked.trades.length} 条交易草稿；尚未导入，请逐行核对`,
        { draft: clone(flow.draft) });
    }
    return finish(flow, 'budget_exhausted', IMPORT_RECOVERY_CODES.BUDGET_EXHAUSTED,
      `本次导入任务的模型请求次数已用完（${flow.model_calls}/${flow.budget_max}）；可以结束本次识别后重新开始，或继续手动修改草稿`);
  }

  async function requestRecovery({ content = '', sourceKind = 'text', requestId = null } = {}) {
    if (inFlight) {
      return resultFor(activeFlow, 'busy', IMPORT_RECOVERY_CODES.INPUT_INVALID,
        '上一次识别还在进行中，请等它结束或稍后重试');
    }
    const gate = localGate({ content, sourceKind });
    if (!gate.ok) {
      // 本地预检失败不创建 flow、不消耗预算。
      return resultFor(activeFlow, gate.code === IMPORT_RECOVERY_CODES.INPUT_INVALID ? 'invalid' : 'unsupported',
        gate.code, gate.message);
    }
    return runModelRequest({
      sourceKind,
      modality: 'text',
      requestId,
      transportFn: transport.importRecover,
      request: {
        content: String(content),
        stage: IMPORT_RECOVERY_STAGE,
        source_kind: sourceKind,
      },
      contentHash: hashQuestion(String(content ?? '')),
      traceMeta: {
        imageCount: 0,
        pageCount: 0,
        pageRange: null,
        inputBytes: new TextEncoder().encode(String(content ?? '')).length,
      },
    });
  }

  async function requestVision({ images, sourceKind = 'image', pageCount = 0, pageRange = null, requestId = null } = {}) {
    if (inFlight) {
      return resultFor(activeFlow, 'busy', IMPORT_RECOVERY_CODES.INPUT_INVALID,
        '上一次识别还在进行中，请等它结束或稍后重试');
    }
    if (typeof transport.importVision !== 'function') {
      return resultFor(activeFlow, 'unsupported', IMPORT_RECOVERY_CODES.SOURCE_UNSUPPORTED,
        '当前服务尚未接通图片识别；请使用文字或手动修改草稿');
    }
    const checked = validateVisionInput({ images, sourceKind });
    if (!checked.ok) {
      return resultFor(activeFlow, 'invalid', checked.code, checked.message);
    }
    return runModelRequest({
      sourceKind,
      modality: 'vision',
      requestId,
      transportFn: transport.importVision,
      request: {
        images: checked.images.map(({ mime, data_base64 }) => ({ mime, data_base64 })),
        stage: IMPORT_VISION_STAGE,
        source_kind: sourceKind,
      },
      contentHash: hashQuestion(JSON.stringify({
        sourceKind,
        images: checked.images.map((image) => [image.mime, image.bytes, image.pageNumber, image.segmentIndex ?? null, image.sourceY ?? null]),
        pageRange: normalizePageRange(pageRange),
      })),
      traceMeta: {
        imageCount: checked.images.length,
        pageCount: Number.isInteger(pageCount) ? pageCount : 0,
        pageRange: normalizePageRange(pageRange),
        inputBytes: checked.totalBytes,
      },
    });
  }

  function getFlow() {
    return activeFlow ? clone(activeFlow) : null;
  }

  function getSession() {
    return {
      flow_id: activeFlow ? activeFlow.flow_id : null,
      status: activeFlow ? activeFlow.status : 'none',
      model_calls: activeFlow ? activeFlow.model_calls : 0,
      budget_max: maxModelCalls,
      remaining: activeFlow ? Math.max(0, activeFlow.budget_max - activeFlow.model_calls) : maxModelCalls,
      outbound: activeFlow ? activeFlow.outbound : false,
      request_ids: activeFlow ? activeFlow.requests.map((r) => r.request_id) : [],
    };
  }

  function getTrace() {
    return activeFlow ? traceFor(activeFlow) : (lastCompleted?.trace ?? null);
  }

  function exportTrace() {
    const trace = getTrace();
    if (!trace) return failure(IMPORT_RECOVERY_CODES.INPUT_INVALID, '没有可导出的识别 trace');
    return exportImportTraceJsonl(trace);
  }

  return Object.freeze({ requestRecovery, requestVision, completeFlow, getFlow, getSession, getTrace, exportTrace });
}
