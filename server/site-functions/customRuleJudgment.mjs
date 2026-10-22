export const CUSTOM_RULE_JUDGMENT_STAGE = 'custom_rule_judgment';
export const CUSTOM_RULE_JUDGMENT_MAX_REASON_CHARS = 600;
export const CUSTOM_RULE_JUDGMENT_MAX_TEXT_CHARS = 200;
export const CUSTOM_RULE_JUDGMENT_MAX_TRADE_DATES = 200;
export const CUSTOM_RULE_JUDGMENT_MAX_CALENDAR_DAYS = 500;
export const CUSTOM_RULE_JUDGMENT_USED_DATA = Object.freeze(['change_pct', 'buys', 'sells', 'calendar']);
export const CUSTOM_RULE_JUDGMENT_VERDICTS = Object.freeze(['triggered', 'not_triggered', 'unable']);

export const CUSTOM_RULE_JUDGMENT_CODES = Object.freeze({
  REQUEST_INVALID: 'E_CUSTOM_RULE_JUDGMENT_REQUEST_INVALID',
  RESPONSE: 'E_CUSTOM_RULE_JUDGMENT_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['stage', 'flow_id', 'request_id', 'judgment_id', 'rule', 'scenario', 'data']);
const RULE_KEYS = new Set(['schema', 'rule_id', 'hash', 'version', 'text', 'action', 'scope']);
const SCENARIO_KEYS = new Set(['symbol', 'requested_date', 'action', 'effective_date', 'change_pct', 'market_label']);
const DATA_KEYS = new Set(['buys', 'sells', 'trading_days']);
const SCOPE_KEYS = new Set(['kind', 'symbol']);
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const HASH_RE = /^[a-f0-9]{8,128}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSAFE_RE = /(https?:\/\/|www\.|\.csv\b|\.xlsx?\b|\.pdf\b|成交明细|原始账单|账户|银行卡|身份证|手机号|建议买入|建议卖出|买入建议|卖出建议|预测|荐股|会涨|会跌)/i;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
const isSymbol = (v) => typeof v === 'string' && /^\d{6}$/.test(v);
const isDateList = (v, max) => Array.isArray(v) && v.length <= max && v.every((d) => isDate(d));

function fail(code, message) {
  return { ok: false, code, message };
}

function normalizeScope(raw) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !SCOPE_KEYS.has(key))
    || !['all', 'symbol'].includes(raw.kind)) {
    return null;
  }
  if (raw.kind === 'all') {
    if (raw.symbol !== undefined && raw.symbol !== null && raw.symbol !== '') return null;
    return { kind: 'all' };
  }
  if (!isSymbol(raw.symbol)) return null;
  return { kind: 'symbol', symbol: raw.symbol };
}

export function normalizeCustomRuleJudgmentRequest(body) {
  if (!isObject(body) || Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '请求体字段非法');
  }
  if (body.stage !== CUSTOM_RULE_JUDGMENT_STAGE) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'stage 必须为 custom_rule_judgment');
  }
  for (const key of ['flow_id', 'request_id', 'judgment_id']) {
    if (!isText(body[key], 120) || !TRACE_ID_RE.test(body[key])) {
      return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, `${key} 格式非法`);
    }
  }
  const raw = body.rule;
  if (!isObject(raw) || Object.keys(raw).some((key) => !RULE_KEYS.has(key))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule 字段非法');
  }
  if (raw.schema !== 'custom-v1') {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.schema 必须为 custom-v1');
  }
  if (raw.rule_id !== null && raw.rule_id !== undefined && (!isText(raw.rule_id, 120) || !TRACE_ID_RE.test(raw.rule_id))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.rule_id 格式非法');
  }
  if (typeof raw.hash !== 'string' || !HASH_RE.test(raw.hash)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.hash 格式非法');
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.version 非法');
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!isText(text, CUSTOM_RULE_JUDGMENT_MAX_TEXT_CHARS)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.text 为空或过长');
  }
  if (!['buy', 'sell'].includes(raw.action)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.action 非法');
  }
  const scope = normalizeScope(raw.scope);
  if (!scope) return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'rule.scope 非法');
  const scenario = body.scenario;
  if (!isObject(scenario) || Object.keys(scenario).some((key) => !SCENARIO_KEYS.has(key))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario 字段非法');
  }
  if (!isSymbol(scenario.symbol)) return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.symbol 非法');
  if (!isDate(scenario.requested_date)) return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.requested_date 非法');
  if (!['buy', 'sell'].includes(scenario.action)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.action 非法');
  }
  if (scenario.effective_date !== null && scenario.effective_date !== undefined && !isDate(scenario.effective_date)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.effective_date 非法');
  }
  if (scenario.change_pct !== null && scenario.change_pct !== undefined
    && (typeof scenario.change_pct !== 'number' || !Number.isFinite(scenario.change_pct))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.change_pct 非法');
  }
  if (scenario.market_label !== null && scenario.market_label !== undefined
    && (typeof scenario.market_label !== 'string' || scenario.market_label.length > 60)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.market_label 非法');
  }
  const data = body.data;
  if (!isObject(data) || Object.keys(data).some((key) => !DATA_KEYS.has(key))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'data 字段非法');
  }
  if (!isDateList(data.buys, CUSTOM_RULE_JUDGMENT_MAX_TRADE_DATES)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'data.buys 非法');
  }
  if (!isDateList(data.sells, CUSTOM_RULE_JUDGMENT_MAX_TRADE_DATES)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'data.sells 非法');
  }
  if (!isDateList(data.trading_days, CUSTOM_RULE_JUDGMENT_MAX_CALENDAR_DAYS)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, 'data.trading_days 非法');
  }
  return {
    ok: true,
    request: {
      stage: CUSTOM_RULE_JUDGMENT_STAGE,
      flow_id: body.flow_id,
      request_id: body.request_id,
      judgment_id: body.judgment_id,
      rule: {
        schema: 'custom-v1',
        rule_id: raw.rule_id ?? null,
        hash: raw.hash,
        version: raw.version,
        text,
        action: raw.action,
        scope,
      },
      scenario: {
        symbol: scenario.symbol,
        requested_date: scenario.requested_date,
        action: scenario.action,
        effective_date: scenario.effective_date ?? null,
        change_pct: scenario.change_pct ?? null,
        market_label: scenario.market_label ?? null,
      },
      data: { buys: [...data.buys], sells: [...data.sells], trading_days: [...data.trading_days] },
    },
  };
}

export function validateCustomRuleJudgmentResponse(rawText) {
  if (typeof rawText !== 'string') return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, '判定响应不是字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, '判定响应不是合法 JSON');
  }
  if (!isObject(parsed) || Object.keys(parsed).some((key) => !['verdict', 'reason', 'used_data'].includes(key))) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, '判定响应字段非法');
  }
  if (!CUSTOM_RULE_JUDGMENT_VERDICTS.includes(parsed.verdict)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, 'verdict 只允许 triggered / not_triggered / unable');
  }
  if (!isText(parsed.reason, CUSTOM_RULE_JUDGMENT_MAX_REASON_CHARS)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, '判定依据为空或过长');
  }
  if (UNSAFE_RE.test(parsed.reason)) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, '判定依据包含越界内容');
  }
  if (!Array.isArray(parsed.used_data)
    || parsed.used_data.some((u) => !CUSTOM_RULE_JUDGMENT_USED_DATA.includes(u))
    || new Set(parsed.used_data).size !== parsed.used_data.length) {
    return fail(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE, 'used_data 非法');
  }
  return {
    ok: true,
    verdict: parsed.verdict,
    reason: parsed.reason.trim(),
    used_data: [...parsed.used_data],
  };
}
