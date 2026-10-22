// 模拟情景未命中锁定规则 · AI 判断协议（候选，未冻结）
// 后端规则判定是唯一权威：请求只允许包含未触发的锁定规则；响应不得声称规则命中或改写规则。
// 只解释“为什么没有匹配任何已锁定规则”，服务端附加 binding 供客户端校验。
export const SCENARIO_JUDGMENT_STAGE = 'scenario_judgment';
export const SCENARIO_JUDGMENT_MAX_ANSWER_CHARS = 1000;
export const SCENARIO_JUDGMENT_TEMPLATES = Object.freeze([
  'no_buy_on_surge',
  'no_buy_back_within',
  'sell_within_after_buy',
]);

export const SCENARIO_JUDGMENT_CODES = Object.freeze({
  REQUEST_INVALID: 'E_SCENARIO_JUDGMENT_REQUEST_INVALID',
  RESPONSE: 'E_SCENARIO_JUDGMENT_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['stage', 'flow_id', 'request_id', 'scenario_id', 'rule_set_hash', 'scenario']);
const SCENARIO_KEYS = new Set(['symbol', 'requested_date', 'effective_date', 'action', 'change_pct', 'rules']);
const RULE_KEYS = new Set(['template_id', 'fields', 'scope', 'version', 'hash', 'verdict', 'code']);
const VERDICTS = new Set(['not_triggered', 'not_applicable', 'missing_data', 'error', 'not_evaluated']);
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const HASH_RE = /^[a-f0-9]{8,128}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSAFE_RE = /(https?:\/\/|www\.|\.csv\b|\.xlsx?\b|\.pdf\b|成交明细|原始账单|账户|银行卡|身份证|手机号|建议买入|建议卖出|买入建议|卖出建议|预测|荐股|会涨|会跌)/i;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
const isSymbol = (v) => typeof v === 'string' && /^\d{6}$/.test(v);

function fail(code, message) {
  return { ok: false, code, message };
}

function ruleSetHash(hashes = []) {
  const str = [...hashes].filter(Boolean).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function normalizeRule(raw, index) {
  if (!isObject(raw) || Object.keys(raw).some((key) => !RULE_KEYS.has(key))) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}] 字段非法`);
  }
  if (!SCENARIO_JUDGMENT_TEMPLATES.includes(raw.template_id)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].template_id 不在允许范围`);
  }
  if (!isObject(raw.fields)) return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].fields 非法`);
  const expectedField = raw.template_id === 'no_buy_on_surge' ? 'threshold_pct' : 'days';
  const keys = Object.keys(raw.fields);
  if (keys.length !== 1 || keys[0] !== expectedField) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].fields 与模板不匹配`);
  }
  const value = raw.fields[keys[0]];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].fields 必须为非负数字`);
  }
  if (keys[0] === 'days' && (!Number.isInteger(value) || value < 1)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].fields.days 非法`);
  }
  if (!isObject(raw.scope)) return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].scope 非法`);
  if (Object.keys(raw.scope).some((key) => !['kind', 'symbol'].includes(key))
    || !['all', 'symbol'].includes(raw.scope.kind)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].scope 字段非法`);
  }
  if (raw.scope.kind === 'all' && raw.scope.symbol !== undefined && raw.scope.symbol !== null && raw.scope.symbol !== '') {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].scope 全部股票不能带 symbol`);
  }
  const scope = raw.scope.kind === 'symbol'
    ? { kind: 'symbol', symbol: raw.scope.symbol }
    : { kind: 'all' };
  if (scope.kind === 'symbol' && !isSymbol(scope.symbol)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].scope.symbol 非法`);
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].version 非法`);
  }
  if (typeof raw.hash !== 'string' || !HASH_RE.test(raw.hash)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].hash 非法`);
  }
  if (!VERDICTS.has(raw.verdict)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].verdict 只允许未触发/不适用/数据不足/无法判定`);
  }
  if (raw.code !== null && raw.code !== undefined && !isText(raw.code, 80)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `rules[${index}].code 非法`);
  }
  return {
    ok: true,
    rule: {
      template_id: raw.template_id,
      fields: { [keys[0]]: value },
      scope,
      version: raw.version,
      hash: raw.hash,
      verdict: raw.verdict,
      code: raw.code ?? null,
    },
  };
}

export function normalizeScenarioJudgmentRequest(body) {
  if (!isObject(body) || Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, '请求体字段非法');
  }
  if (body.stage !== SCENARIO_JUDGMENT_STAGE) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'stage 必须为 scenario_judgment');
  }
  for (const key of ['flow_id', 'request_id', 'scenario_id']) {
    if (!isText(body[key], 120) || !TRACE_ID_RE.test(body[key])) {
      return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, `${key} 格式非法`);
    }
  }
  if (typeof body.rule_set_hash !== 'string' || !HASH_RE.test(body.rule_set_hash)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'rule_set_hash 格式非法');
  }
  const scenario = body.scenario;
  if (!isObject(scenario) || Object.keys(scenario).some((key) => !SCENARIO_KEYS.has(key))) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario 字段非法');
  }
  if (!isSymbol(scenario.symbol)) return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.symbol 非法');
  if (!isDate(scenario.requested_date)) return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.requested_date 非法');
  if (scenario.effective_date !== null && scenario.effective_date !== undefined && !isDate(scenario.effective_date)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.effective_date 非法');
  }
  if (!['buy', 'sell'].includes(scenario.action)) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.action 非法');
  }
  if (scenario.change_pct !== null && scenario.change_pct !== undefined
    && (typeof scenario.change_pct !== 'number' || !Number.isFinite(scenario.change_pct))) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.change_pct 非法');
  }
  if (!Array.isArray(scenario.rules) || scenario.rules.length > 10) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'scenario.rules 数量非法');
  }
  const rules = [];
  for (const [index, raw] of scenario.rules.entries()) {
    const checked = normalizeRule(raw, index);
    if (!checked.ok) return checked;
    rules.push(checked.rule);
  }
  if (ruleSetHash(rules.map((r) => r.hash)) !== body.rule_set_hash) {
    return fail(SCENARIO_JUDGMENT_CODES.REQUEST_INVALID, 'rule_set_hash 与规则集合不一致');
  }
  return {
    ok: true,
    request: {
      stage: SCENARIO_JUDGMENT_STAGE,
      flow_id: body.flow_id,
      request_id: body.request_id,
      scenario_id: body.scenario_id,
      rule_set_hash: body.rule_set_hash,
      scenario: {
        symbol: scenario.symbol,
        requested_date: scenario.requested_date,
        effective_date: scenario.effective_date ?? null,
        action: scenario.action,
        change_pct: scenario.change_pct ?? null,
        rules,
      },
    },
  };
}

export function validateScenarioJudgmentResponse(rawText) {
  if (typeof rawText !== 'string') return fail(SCENARIO_JUDGMENT_CODES.RESPONSE, '判断响应不是字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail(SCENARIO_JUDGMENT_CODES.RESPONSE, '判断响应不是合法 JSON');
  }
  if (!isObject(parsed) || Object.keys(parsed).some((key) => !['judgment', 'answer_text'].includes(key))) {
    return fail(SCENARIO_JUDGMENT_CODES.RESPONSE, '判断响应字段非法');
  }
  if (parsed.judgment !== 'no_match') {
    return fail(SCENARIO_JUDGMENT_CODES.RESPONSE, '判断只能为 no_match：已有规则命中必须由本地规则决定');
  }
  if (!isText(parsed.answer_text, SCENARIO_JUDGMENT_MAX_ANSWER_CHARS)) {
    return fail(SCENARIO_JUDGMENT_CODES.RESPONSE, '判断正文为空或过长');
  }
  if (UNSAFE_RE.test(parsed.answer_text)) {
    return fail(SCENARIO_JUDGMENT_CODES.RESPONSE, '判断包含越界内容');
  }
  return { ok: true, judgment: 'no_match', answer_text: parsed.answer_text.trim() };
}
