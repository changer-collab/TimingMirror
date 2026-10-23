// 对话画像信号阶段 · 服务端固定约束与校验。
// 只记录用户在本条消息中明确陈述的长期信息；证据必须是原文连续片段，杜绝模型改写或推断。
export const PROFILE_FACT_STAGE = 'profile_fact';
export const PROFILE_FACT_MAX_MESSAGE_CHARS = 1200;
export const PROFILE_FACT_MAX_ITEMS = 3;

export const PROFILE_FACT_CODES = Object.freeze({
  REQUEST_INVALID: 'E_PROFILE_FACT_REQUEST_INVALID',
  RESPONSE: 'E_PROFILE_FACT_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['message']);
const FACT_KEYS = Object.freeze(['kind', 'key', 'value', 'evidence']);
const FACT_KINDS = new Set(['goal', 'preference', 'constraint', 'habit', 'risk_tolerance']);
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const SENSITIVE_RE = /(\b\d{11,19}\b|身份证|银行卡|手机号|密码|验证码)/u;
const URL_RE = /(https?:\/\/|www\.)/iu;
const FINANCE_RE = /(投资|交易|股票|基金|仓位|回撤|风险|收益|亏损|止损|止盈|持有|买入|卖出|理财|资金|纪律|长期|短期|目标|计划)/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const charLength = (value) => [...value].length;
const textBytes = (value) => new TextEncoder().encode(value).byteLength;

function fail(code, message) {
  return { ok: false, code, message };
}

function trimmedText(value, maxChars) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || CONTROL_RE.test(text) || charLength(text) > maxChars) return null;
  return text;
}

export function normalizeProfileFactRequest(body) {
  if (!isObject(body) || Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    return fail(PROFILE_FACT_CODES.REQUEST_INVALID, '请求字段非法');
  }
  const message = trimmedText(body.message, PROFILE_FACT_MAX_MESSAGE_CHARS);
  if (!message || textBytes(message) > PROFILE_FACT_MAX_MESSAGE_CHARS * 4) {
    return fail(PROFILE_FACT_CODES.REQUEST_INVALID, 'message 非法');
  }
  return { ok: true, message };
}

export function validateProfileFactResponse(rawText, message) {
  if (typeof rawText !== 'string') return fail(PROFILE_FACT_CODES.RESPONSE, '画像响应必须为字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail(PROFILE_FACT_CODES.RESPONSE, '画像响应不是合法 JSON');
  }
  if (!isObject(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.facts)) {
    return fail(PROFILE_FACT_CODES.RESPONSE, '画像响应字段非法');
  }
  if (parsed.facts.length > PROFILE_FACT_MAX_ITEMS) {
    return fail(PROFILE_FACT_CODES.RESPONSE, '画像事实数量超限');
  }
  const seen = new Set();
  const facts = [];
  for (const [index, item] of parsed.facts.entries()) {
    if (!isObject(item) || Object.keys(item).length !== FACT_KEYS.length
        || FACT_KEYS.some((key) => !Object.hasOwn(item, key))) {
      return fail(PROFILE_FACT_CODES.RESPONSE, `facts[${index}] 字段非法`);
    }
    if (!FACT_KINDS.has(item.kind) || typeof item.key !== 'string' || !SLUG_RE.test(item.key)) {
      return fail(PROFILE_FACT_CODES.RESPONSE, `facts[${index}] 类型或键非法`);
    }
    const value = trimmedText(item.value, 240);
    if (!value || textBytes(value) > 240) {
      return fail(PROFILE_FACT_CODES.RESPONSE, `facts[${index}].value 非法`);
    }
    const evidence = trimmedText(item.evidence, 120);
    if (!evidence || !message.includes(evidence)) {
      return fail(PROFILE_FACT_CODES.RESPONSE, `facts[${index}].evidence 不是原文片段`);
    }
    if (SENSITIVE_RE.test(value) || SENSITIVE_RE.test(evidence) || URL_RE.test(value)) {
      return fail(PROFILE_FACT_CODES.RESPONSE, `facts[${index}] 包含敏感信息`);
    }
    if (!FINANCE_RE.test(evidence)) {
      return fail(PROFILE_FACT_CODES.RESPONSE, `facts[${index}] 与投资画像无关`);
    }
    const dedupe = `${item.kind}\n${item.key}\n${value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    facts.push({ kind: item.kind, key: item.key, value, evidence });
  }
  return { ok: true, facts };
}
