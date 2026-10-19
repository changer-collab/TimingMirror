// M1-C10 在线接入准备 · 代理边界与可注入 transport（本地实现；接口候选，未冻结）
// 职责：构建最小出站请求 → 调用注入的 transport → 解析/校验响应 → 复用本地数字检查。
// 不实现：真实百炼 HTTP、云函数部署、浏览器 UI、凭证读取或 chatView 接线。
//
// transport 接口（由调用方注入）：
//   intent({ question, signal }) -> Promise<{ rawText: string }>
//   restate({ question, facts, signal }) -> Promise<{ rawText: string }>
// transport 只能看到已投影的请求；不得读取 review / prepared / plan / provenance。
// timeoutMs 是可配置的单次 transport 调用超时；默认 8000 ms 只是配置默认值，
// 不表示“端到端 8 秒”产品口径已冻结。
import { validateIntentJson } from './planner.js';
import { checkNumbers, isSupportedDisplay } from './numberCheck.js';

// F-6 已确认出站事实字段；key / fact_ref / scope 不在本白名单内，需另行确认。
export const CONFIRMED_FACT_FIELDS = Object.freeze([
  'value', 'unit', 'display', 'formula_ref', 'source_ref',
]);

export const SUPPORTED_FACT_UNITS = Object.freeze(['%', 'pp', '元', '股', '手', '份']);
// 在线出站 unit：由 formula_ref 明确决定；只覆盖当前最小组合四事实。
const FORMULA_UNIT_MAP = Object.freeze({
  CALC_RET_V1: '%',
  CALC_DRAG_PP_V1: 'pp',
  CALC_DRAG_MONEY_V1: '元',
});
// factExport 目前直接透传的 provenance 描述性 unit；只做显式在线投影，不改本地输出。
const DESCRIPTIVE_UNIT_MAP = Object.freeze({
  '无量纲（展示 %，1 位小数）': '%',
  'pp（展示 1 位小数）': 'pp',
  '元（展示 2 位小数＋千分位）': '元',
});
// 现有公式 ID 形式：CALC_ + 大写字母/数字/下划线。
const FORMULA_REF_RE = /^CALC_[A-Z0-9_]+$/;
const MAX_FORMULA_REF_LENGTH = 64;
// 现有 factExport 的匿名句柄格式：src- + 8 位小写十六进制。
const ANONYMOUS_SOURCE_REF_RE = /^src-[0-9a-f]{8}$/;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export const ONLINE_BOUNDARY_CODES = Object.freeze({
  QUESTION_INVALID: 'E_QUESTION_INVALID',
  QUESTION_BLOCKED: 'E_QUESTION_BLOCKED',
  QUESTION_POLICY_FAILED: 'E_QUESTION_POLICY_FAILED',
  REQUEST_INVALID: 'E_REQUEST_INVALID',
  FACT_INVALID: 'E_FACT_INVALID',
  FACT_FIELD_INVALID: 'E_FACT_FIELD_INVALID',
  FACTS_EMPTY: 'E_FACTS_EMPTY',
  TRANSPORT_TIMEOUT: 'E_TRANSPORT_TIMEOUT',
  TRANSPORT_NETWORK: 'E_TRANSPORT_NETWORK',
  TRANSPORT_FAILURE: 'E_TRANSPORT_FAILURE',
  TRANSPORT_RESPONSE: 'E_TRANSPORT_RESPONSE',
  INTENT_JSON: 'E_INTENT_JSON',
  INTENT_SCHEMA: 'E_INTENT_SCHEMA',
  RESTATE_JSON: 'E_RESTATE_JSON',
  RESTATE_SCHEMA: 'E_RESTATE_SCHEMA',
  RESTATE_EMPTY: 'E_RESTATE_EMPTY',
  NUMBERS_FAILED: 'W_ANSWER_NUMBERS_FAILED',
});

export class TransportError extends Error {
  constructor(code, message = '') {
    super(message || code);
    this.name = 'TransportError';
    this.code = code;
  }
}

function fail(code, message) {
  return { ok: false, code, errors: [message] };
}

/* 可替换的问题文本边界：默认放行；策略由调用方注入，不在本模块固化正则规则。 */
export function applyQuestionPolicy(question, policy = null) {
  if (typeof question !== 'string' || question.trim() === '') {
    return { allow: false, question: null, code: ONLINE_BOUNDARY_CODES.QUESTION_INVALID };
  }
  if (policy === null || policy === undefined) {
    return { allow: true, question, code: null };
  }
  if (typeof policy !== 'function') {
    return { allow: false, question: null, code: ONLINE_BOUNDARY_CODES.QUESTION_POLICY_FAILED };
  }
  let decision;
  try {
    decision = policy(question);
  } catch {
    return { allow: false, question: null, code: ONLINE_BOUNDARY_CODES.QUESTION_POLICY_FAILED };
  }
  if (decision === null || typeof decision !== 'object' || typeof decision.allow !== 'boolean') {
    return { allow: false, question: null, code: ONLINE_BOUNDARY_CODES.QUESTION_POLICY_FAILED };
  }
  if (!decision.allow) {
    return {
      allow: false,
      question: null,
      code: typeof decision.code === 'string' && decision.code !== ''
        ? decision.code
        : ONLINE_BOUNDARY_CODES.QUESTION_BLOCKED,
    };
  }
  const next = decision.question === undefined ? question : decision.question;
  if (typeof next !== 'string' || next.trim() === '') {
    return { allow: false, question: null, code: ONLINE_BOUNDARY_CODES.QUESTION_INVALID };
  }
  return { allow: true, question: next, code: null };
}

function selectConfirmedFields(fact) {
  const out = {};
  for (const key of CONFIRMED_FACT_FIELDS) {
    if (hasOwn(fact, key)) out[key] = fact[key];
  }
  return out;
}

/* 基础内容校验：value/display/formula_ref/source_ref；unit 的内容由调用方按场景解析。 */
function validateFactBase(fact, i) {
  if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
    return fail(ONLINE_BOUNDARY_CODES.FACT_INVALID, '每个 fact 必须为对象');
  }
  if (!hasOwn(fact, 'value') || !Number.isFinite(fact.value)) {
    return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].value 必须为有限数值`);
  }
  if (hasOwn(fact, 'display')) {
    const v = fact.display;
    if (!(v === null || isSupportedDisplay(v))) {
      return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].display 必须为现有数字展示格式或 null`);
    }
  }
  if (hasOwn(fact, 'formula_ref')) {
    const v = fact.formula_ref;
    if (!(v === null || (typeof v === 'string' && v.length <= MAX_FORMULA_REF_LENGTH
      && v === v.trim() && FORMULA_REF_RE.test(v)))) {
      return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].formula_ref 必须为 CALC_ 公式 ID 或 null`);
    }
  }
  if (hasOwn(fact, 'source_ref')) {
    const v = fact.source_ref;
    if (!(v === null || (typeof v === 'string' && v === v.trim() && ANONYMOUS_SOURCE_REF_RE.test(v)))) {
      return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].source_ref 必须为 null 或 src-8hex 匿名句柄`);
    }
  }
  return { ok: true };
}

/* 显式在线 unit 解析：formula_ref 决定短单位；描述性 unit 只做映射，短单位保持兼容。 */
function resolveOnlineUnit(fact, i) {
  const formulaRef = hasOwn(fact, 'formula_ref') ? fact.formula_ref : null;
  if (formulaRef === null) {
    return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].formula_ref 缺失，无法确定短单位`);
  }
  const formulaUnit = Object.prototype.hasOwnProperty.call(FORMULA_UNIT_MAP, formulaRef)
    ? FORMULA_UNIT_MAP[formulaRef]
    : null;
  if (formulaUnit === null) {
    return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].formula_ref 无法映射为短单位`);
  }
  let sourceUnit = null;
  if (hasOwn(fact, 'unit')) {
    const raw = fact.unit;
    if (raw !== null) {
      if (typeof raw === 'string' && SUPPORTED_FACT_UNITS.includes(raw)) {
        sourceUnit = raw;
      } else if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(DESCRIPTIVE_UNIT_MAP, raw)) {
        sourceUnit = DESCRIPTIVE_UNIT_MAP[raw];
      } else {
        return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].unit 无法映射为短单位`);
      }
    }
  }
  if (sourceUnit !== null && sourceUnit !== formulaUnit) {
    return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].unit 与 formula_ref 映射不一致`);
  }
  return { ok: true, unit: formulaUnit };
}

/* 显式在线事实投影：不修改输入；丢弃非 F-6 字段；unit 规范化为短单位。 */
export function projectOnlineFacts(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return fail(ONLINE_BOUNDARY_CODES.FACTS_EMPTY, 'facts 必须为非空数组');
  }
  const dropped = new Set();
  const projected = [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const base = validateFactBase(fact, i);
    if (!base.ok) return base;
    const unit = resolveOnlineUnit(fact, i);
    if (!unit.ok) return unit;
    const out = selectConfirmedFields(fact);
    out.unit = unit.unit;
    projected.push(out);
    for (const key of Object.keys(fact)) {
      if (!CONFIRMED_FACT_FIELDS.includes(key)) dropped.add(key);
    }
  }
  return {
    ok: true,
    facts: projected,
    dropped_fields: [...dropped].sort(),
    errors: [],
  };
}

/* 调用①意图分类：请求体只允许 question。 */
export function buildIntentRequest({ question } = {}) {
  if (typeof question !== 'string' || question.trim() === '') {
    return fail(ONLINE_BOUNDARY_CODES.QUESTION_INVALID, 'question 必须为非空字符串');
  }
  return { ok: true, request: { question }, errors: [] };
}

/* 调用②事实复述：请求体只允许 question + F-6 已确认事实字段；其余字段丢弃并记录键名。 */
export function buildRestateRequest({ question, facts } = {}) {
  const base = buildIntentRequest({ question });
  if (!base.ok) return base;
  if (!Array.isArray(facts) || facts.length === 0) {
    return fail(ONLINE_BOUNDARY_CODES.FACTS_EMPTY, 'facts 必须为非空数组');
  }
  const dropped = new Set();
  const projected = [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const checked = validateFactBase(fact, i);
    if (!checked.ok) return checked;
    if (hasOwn(fact, 'unit')) {
      const v = fact.unit;
      if (!(v === null || (typeof v === 'string' && SUPPORTED_FACT_UNITS.includes(v)))) {
        return fail(ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID, `facts[${i}].unit 必须为 %、pp、元、股、手、份 或 null`);
      }
    }
    projected.push(selectConfirmedFields(fact));
    for (const key of Object.keys(fact)) {
      if (!CONFIRMED_FACT_FIELDS.includes(key)) dropped.add(key);
    }
  }
  return {
    ok: true,
    request: { question: base.request.question, facts: projected },
    dropped_fields: [...dropped].sort(),
    errors: [],
  };
}

function resultMeta(timeoutMs, latencyMs) {
  return { transport: 'injected', latency_ms: latencyMs, timeout_ms: timeoutMs };
}

function failure(stage, code, { errors = [], data = null, latencyMs = null, timeoutMs } = {}) {
  return { ok: false, stage, code, data, errors, meta: resultMeta(timeoutMs, latencyMs) };
}

function success(stage, data, latencyMs, timeoutMs) {
  return { ok: true, stage, code: null, data, errors: [], meta: resultMeta(timeoutMs, latencyMs) };
}

function normalizeTimeout(timeoutMs) {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs 必须为正数');
  }
  return timeoutMs;
}

function extractRawText(response) {
  if (response === null || typeof response !== 'object' || typeof response.rawText !== 'string') {
    return { ok: false, code: ONLINE_BOUNDARY_CODES.TRANSPORT_RESPONSE };
  }
  return { ok: true, rawText: response.rawText };
}

/* 本地数字校验快照：与出站对象完全分离，深拷贝后冻结；值已在上方验证为原始类型。 */
function createLocalFactSnapshot(facts) {
  return Object.freeze(facts.map((fact) => Object.freeze({ ...fact })));
}

async function invokeTransport(fn, request, { timeoutMs, now }) {
  const controller = new AbortController();
  const started = now();
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => fn({ ...request, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new TransportError(ONLINE_BOUNDARY_CODES.TRANSPORT_TIMEOUT));
        }, timeoutMs);
      }),
    ]);
    return { ok: true, response, latencyMs: now() - started };
  } catch (e) {
    const code = e instanceof TransportError && typeof e.code === 'string'
      ? e.code
      : ONLINE_BOUNDARY_CODES.TRANSPORT_FAILURE;
    return { ok: false, code, latencyMs: now() - started };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createOnlineBoundary({
  transport,
  timeoutMs = 8000,
  now = () => Date.now(),
  questionPolicy = null,
} = {}) {
  if (transport === null || typeof transport !== 'object'
    || typeof transport.intent !== 'function' || typeof transport.restate !== 'function') {
    throw new TypeError('transport 必须提供 intent() 与 restate()');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');
  const timeout = normalizeTimeout(timeoutMs);

  async function classifyIntent({ question } = {}) {
    const gate = applyQuestionPolicy(question, questionPolicy);
    if (!gate.allow) {
      return failure('question_policy', gate.code, { timeoutMs: timeout });
    }
    const built = buildIntentRequest({ question: gate.question });
    if (!built.ok) {
      return failure('request', built.code, { errors: built.errors, timeoutMs: timeout });
    }
    const call = await invokeTransport(transport.intent, built.request, { timeoutMs: timeout, now });
    if (!call.ok) return failure('intent', call.code, { latencyMs: call.latencyMs, timeoutMs: timeout });
    const raw = extractRawText(call.response);
    if (!raw.ok) return failure('intent', raw.code, { latencyMs: call.latencyMs, timeoutMs: timeout });
    let parsed;
    try {
      parsed = JSON.parse(raw.rawText);
    } catch {
      return failure('intent', ONLINE_BOUNDARY_CODES.INTENT_JSON, { latencyMs: call.latencyMs, timeoutMs: timeout });
    }
    const valid = validateIntentJson(parsed);
    if (!valid.ok) {
      return failure('intent', ONLINE_BOUNDARY_CODES.INTENT_SCHEMA, {
        errors: valid.errors,
        latencyMs: call.latencyMs,
        timeoutMs: timeout,
      });
    }
    return success('intent', { intentJson: parsed }, call.latencyMs, timeout);
  }

  async function restate({ question, facts } = {}) {
    const gate = applyQuestionPolicy(question, questionPolicy);
    if (!gate.allow) {
      return failure('question_policy', gate.code, { timeoutMs: timeout });
    }
    const projected = projectOnlineFacts(facts);
    if (!projected.ok) {
      return failure('request', projected.code, { errors: projected.errors, timeoutMs: timeout });
    }
    const built = buildRestateRequest({ question: gate.question, facts: projected.facts });
    if (!built.ok) {
      return failure('request', built.code, { errors: built.errors, timeoutMs: timeout });
    }
    // transport 只拿到独立出站副本；数字检查始终使用调用前冻结的本地快照。
    const localFacts = createLocalFactSnapshot(built.request.facts);
    const outboundRequest = {
      question: built.request.question,
      facts: built.request.facts.map((fact) => ({ ...fact })),
    };
    const call = await invokeTransport(transport.restate, outboundRequest, { timeoutMs: timeout, now });
    if (!call.ok) return failure('restate', call.code, { latencyMs: call.latencyMs, timeoutMs: timeout });
    const raw = extractRawText(call.response);
    if (!raw.ok) return failure('restate', raw.code, { latencyMs: call.latencyMs, timeoutMs: timeout });
    let parsed;
    try {
      parsed = JSON.parse(raw.rawText);
    } catch {
      return failure('restate', ONLINE_BOUNDARY_CODES.RESTATE_JSON, { latencyMs: call.latencyMs, timeoutMs: timeout });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.answer_text !== 'string') {
      return failure('restate', ONLINE_BOUNDARY_CODES.RESTATE_SCHEMA, { latencyMs: call.latencyMs, timeoutMs: timeout });
    }
    const answerText = parsed.answer_text.trim();
    if (answerText === '') {
      return failure('restate', ONLINE_BOUNDARY_CODES.RESTATE_EMPTY, { latencyMs: call.latencyMs, timeoutMs: timeout });
    }
    const num = checkNumbers(answerText, { status: 'ok', facts: localFacts });
    const numberCheck = {
      ok: num.ok,
      checked: num.checked,
      matched_count: num.matched.length,
      failed_count: num.failed.length,
      failed_codes: [...new Set(num.failed.map((f) => f.code))],
    };
    if (!num.ok) {
      return failure('restate', ONLINE_BOUNDARY_CODES.NUMBERS_FAILED, {
        data: { number_check: numberCheck },
        latencyMs: call.latencyMs,
        timeoutMs: timeout,
      });
    }
    return success('restate', { draft: answerText, number_check: numberCheck }, call.latencyMs, timeout);
  }

  return Object.freeze({ classifyIntent, restate });
}
