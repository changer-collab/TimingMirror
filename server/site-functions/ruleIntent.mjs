// 规则 intent 阶段（M2 后首版助手）· 服务端固定约束与校验。
// 服务端只允许两个已批准规则模板；客户端 allowed_* 只能收窄，不能扩大。
// 不读取环境、不记录 question/context 原文、不返回上游原始错误。
export const RULE_INTENT_STAGE = 'draft_rule';

export const RULE_INTENT_CODES = Object.freeze({
  REQUEST_INVALID: 'E_RULE_INTENT_REQUEST_INVALID',
  SCOPE: 'E_RULE_INTENT_SCOPE',
  RESPONSE: 'E_RULE_INTENT_RESPONSE_INVALID',
});

export const RULE_INTENT_ALLOWED_INTENTS = Object.freeze(['contract_setup']);
export const RULE_INTENT_ALLOWED_TOOLS = Object.freeze(['contract.parse', 'contract.match']);

// 与 src/engine/contractMatch.js 的已批准模板保持一致；服务端副本避免运行时跨目录导入。
export const RULE_INTENT_TEMPLATES = Object.freeze({
  no_buy_on_surge: Object.freeze({
    template_id: 'no_buy_on_surge',
    name: '涨幅超阈值不买入',
    fields: Object.freeze({
      threshold_pct: Object.freeze({ min: 0, integer: false }),
    }),
  }),
  no_buy_back_within: Object.freeze({
    template_id: 'no_buy_back_within',
    name: '卖出后 N 个交易日内不追回',
    fields: Object.freeze({
      days: Object.freeze({ min: 1, integer: true }),
    }),
  }),
});

const REQUEST_KEYS = new Set(['question', 'stage', 'allowed_intents', 'allowed_templates', 'allowed_tools', 'context_summary']);
const CONTEXT_KEYS = new Set(['object_type', 'symbol', 'as_of_date', 'confirmed_rule_versions', 'data_snapshot_id']);
const RESPONSE_KEYS = new Set(['intent', 'confidence', 'slots', 'template_id', 'fields', 'clarify', 'unsupported']);
const OBJECT_TYPES = new Set(['rule', 'report', 'bill']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isSymbol = (v) => typeof v === 'string' && /^\d{6}$/.test(v);
const isShortString = (v, max = 64) => typeof v === 'string' && v.length > 0 && v.length <= max;

function fail(code, message) {
  return { ok: false, code, errors: [message] };
}

function readStringArray(value, serverSet, name) {
  if (value === undefined) return { ok: true, value: [...serverSet] };
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    return fail(RULE_INTENT_CODES.REQUEST_INVALID, `${name} 必须为字符串数组`);
  }
  if (value.some((x) => !serverSet.includes(x))) {
    return fail(RULE_INTENT_CODES.SCOPE, `${name} 只能请求服务端允许范围的子集`);
  }
  return { ok: true, value: [...new Set(value)] };
}

function normalizeContext(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isObject(raw)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'context_summary 必须为对象');
  for (const key of Object.keys(raw)) {
    if (!CONTEXT_KEYS.has(key)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, `context_summary 不允许字段：${key}`);
  }
  const out = {};
  if (raw.object_type !== undefined && raw.object_type !== null) {
    if (!OBJECT_TYPES.has(raw.object_type)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'object_type 非法');
    out.object_type = raw.object_type;
  }
  if (raw.symbol !== undefined && raw.symbol !== null) {
    if (!isSymbol(raw.symbol)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'symbol 必须为六位数字代码或 null');
    out.symbol = raw.symbol;
  }
  if (raw.as_of_date !== undefined && raw.as_of_date !== null) {
    if (!isDate(raw.as_of_date)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'as_of_date 必须为 YYYY-MM-DD 或 null');
    out.as_of_date = raw.as_of_date;
  }
  if (raw.confirmed_rule_versions !== undefined && raw.confirmed_rule_versions !== null) {
    if (!Array.isArray(raw.confirmed_rule_versions)
      || raw.confirmed_rule_versions.length > 20
      || raw.confirmed_rule_versions.some((x) => !isShortString(x, 64))) {
      return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'confirmed_rule_versions 仅允许最多 20 个版本号/哈希');
    }
    out.confirmed_rule_versions = [...raw.confirmed_rule_versions];
  }
  if (raw.data_snapshot_id !== undefined && raw.data_snapshot_id !== null) {
    if (!isShortString(raw.data_snapshot_id, 64)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'data_snapshot_id 非法');
    out.data_snapshot_id = raw.data_snapshot_id;
  }
  return { ok: true, value: out };
}

export function normalizeRuleIntentRequest(body) {
  if (!isObject(body)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, '请求体必须为对象');
  for (const key of Object.keys(body)) {
    if (!REQUEST_KEYS.has(key)) return fail(RULE_INTENT_CODES.REQUEST_INVALID, `不允许字段：${key}`);
  }
  if (typeof body.question !== 'string' || body.question.trim() === '' || body.question.length > 1000) {
    return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'question 必须为非空字符串且不超过 1000 字符');
  }
  if (body.stage !== RULE_INTENT_STAGE) return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'stage 必须为 draft_rule');

  const intents = readStringArray(body.allowed_intents, RULE_INTENT_ALLOWED_INTENTS, 'allowed_intents');
  if (!intents.ok) return intents;
  const tools = readStringArray(body.allowed_tools, RULE_INTENT_ALLOWED_TOOLS, 'allowed_tools');
  if (!tools.ok) return tools;

  let templateIds = Object.keys(RULE_INTENT_TEMPLATES);
  if (body.allowed_templates !== undefined) {
    if (!Array.isArray(body.allowed_templates) || body.allowed_templates.some((x) => typeof x !== 'string')) {
      return fail(RULE_INTENT_CODES.REQUEST_INVALID, 'allowed_templates 必须为字符串数组');
    }
    if (body.allowed_templates.some((x) => !Object.prototype.hasOwnProperty.call(RULE_INTENT_TEMPLATES, x))) {
      return fail(RULE_INTENT_CODES.SCOPE, 'allowed_templates 只能请求服务端允许范围的子集');
    }
    templateIds = [...new Set(body.allowed_templates)];
  }
  const context = normalizeContext(body.context_summary);
  if (!context.ok) return context;

  return {
    ok: true,
    request: {
      question: body.question,
      stage: RULE_INTENT_STAGE,
      allowed_intents: intents.value,
      allowed_tools: tools.value,
      allowed_templates: templateIds.map((id) => ({
        template_id: id,
        name: RULE_INTENT_TEMPLATES[id].name,
        fields: Object.fromEntries(Object.entries(RULE_INTENT_TEMPLATES[id].fields).map(([k, v]) => [k, { ...v }])),
      })),
      context_summary: context.value,
    },
  };
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function validateRuleIntentResponse(rawText, allowedTemplateIds) {
  if (typeof rawText !== 'string') return fail(RULE_INTENT_CODES.RESPONSE, '响应正文必须为字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail(RULE_INTENT_CODES.RESPONSE, '响应不是合法 JSON');
  }
  if (!isObject(parsed)) return fail(RULE_INTENT_CODES.RESPONSE, '响应必须为对象');
  for (const key of Object.keys(parsed)) {
    if (!RESPONSE_KEYS.has(key)) return fail(RULE_INTENT_CODES.RESPONSE, `响应不允许字段：${key}`);
  }
  if (parsed.intent !== 'contract_setup') return fail(RULE_INTENT_CODES.RESPONSE, 'intent 必须为 contract_setup');
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)
    || parsed.confidence < 0 || parsed.confidence > 1) {
    return fail(RULE_INTENT_CODES.RESPONSE, 'confidence 必须为 [0,1] 数值');
  }
  const clarify = typeof parsed.clarify === 'string' && parsed.clarify.trim() !== '' ? parsed.clarify.trim() : null;
  const unsupported = typeof parsed.unsupported === 'string' && parsed.unsupported.trim() !== '' ? parsed.unsupported.trim() : null;
  if (clarify !== null && unsupported !== null) return fail(RULE_INTENT_CODES.RESPONSE, 'clarify 与 unsupported 不能同时存在');
  if (clarify !== null || unsupported !== null) {
    return { ok: true, kind: clarify !== null ? 'clarify' : 'unsupported', value: { intent: 'contract_setup', confidence: parsed.confidence, clarify, unsupported } };
  }
  if (typeof parsed.template_id !== 'string' || !allowedTemplateIds.includes(parsed.template_id)) {
    return fail(RULE_INTENT_CODES.RESPONSE, 'template_id 不在服务端允许范围');
  }
  const template = RULE_INTENT_TEMPLATES[parsed.template_id];
  if (!isObject(parsed.fields)) return fail(RULE_INTENT_CODES.RESPONSE, 'fields 必须为对象');
  const expected = Object.keys(template.fields);
  const actual = Object.keys(parsed.fields);
  if (actual.length !== expected.length || expected.some((k) => !actual.includes(k))) {
    return fail(RULE_INTENT_CODES.RESPONSE, 'fields 必须恰好包含模板字段，不套默认值');
  }
  const fields = {};
  for (const key of expected) {
    const spec = template.fields[key];
    const value = toNumber(parsed.fields[key]);
    if (value === null) return fail(RULE_INTENT_CODES.RESPONSE, `字段 ${key} 必须为数字`);
    if (value < spec.min || (spec.integer && !Number.isInteger(value))) {
      return fail(RULE_INTENT_CODES.RESPONSE, `字段 ${key} 取值非法`);
    }
    fields[key] = value;
  }
  return {
    ok: true,
    kind: 'draft',
    value: {
      intent: 'contract_setup',
      confidence: parsed.confidence,
      template_id: parsed.template_id,
      fields,
      clarify: null,
      unsupported: null,
    },
  };
}
