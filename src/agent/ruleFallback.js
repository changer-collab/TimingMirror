// 规则模拟未命中兜底（次要范围；接口候选，未冻结）
// 后端确定性规则是唯一权威：只有没有任何锁定规则 triggered 时，才把完整情景与规则状态交给
// scenario-judgment 接口，让 AI 解释“为什么未匹配”；AI 不能声称命中、不能创建/修改/保存规则。
// 边界：不直接调用模型/网络（transport 注入）；不读取凭证；不改变 contractRuleSet / simulateContracts。
export const SCENARIO_JUDGMENT_STAGE = 'scenario_judgment';

export const RULE_FALLBACK_CODES = Object.freeze({
  RULE_HIT: 'W_RULE_FALLBACK_RULE_HIT',
  NO_JUDGEABLE_SCENARIO: 'W_RULE_FALLBACK_NO_JUDGEABLE_SCENARIO',
  REQUEST_INVALID: 'E_RULE_FALLBACK_REQUEST_INVALID',
  TIMEOUT: 'W_RULE_FALLBACK_TIMEOUT',
  UNAVAILABLE: 'W_RULE_FALLBACK_UNAVAILABLE',
  RESPONSE_INVALID: 'E_RULE_FALLBACK_RESPONSE_INVALID',
  BINDING_MISMATCH: 'W_RULE_FALLBACK_BINDING_MISMATCH',
});

const MAX_ANSWER_CHARS = 1000;
const UNSAFE_RE = /(https?:\/\/|www\.|\.csv\b|\.xlsx?\b|\.pdf\b|成交明细|原始账单|账户|银行卡|身份证|手机号|建议买入|建议卖出|买入建议|卖出建议|预测|荐股|会涨|会跌)/i;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isSymbol = (v) => typeof v === 'string' && /^\d{6}$/.test(v);
const isTraceId = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(v);
const isHash = (v) => typeof v === 'string' && /^[a-f0-9]{8,128}$/i.test(v);

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function ruleSetHash(hashes = []) {
  return fnv1a32([...hashes].filter(Boolean).sort().join('|'));
}

function resultForRule(simulation, hash) {
  return (Array.isArray(simulation?.results) ? simulation.results : [])
    .find((r) => r && r.rule && r.rule.hash === hash) ?? null;
}

/**
 * 判断是否应该请求 AI：
 * - 任一规则 triggered → 不调用（规则命中优先）；
 * - 没有可用的标的/日期 → 不调用（数据不足，不猜测）；
 * - 没有锁定规则但情景有效 → 允许调用（AI 解释没有可匹配规则）。
 */
export function pickScenarioForJudgment({ simulation, currentRules = [] } = {}) {
  if (!simulation || !simulation.summary || !Array.isArray(simulation.results)) {
    return failure(RULE_FALLBACK_CODES.NO_JUDGEABLE_SCENARIO, '模拟结果缺失或格式不完整：不调用 AI');
  }
  if (Number(simulation.summary.triggered) > 0) {
    return failure(RULE_FALLBACK_CODES.RULE_HIT, '已有锁定规则命中：以规则判定为准，不调用 AI');
  }
  const context = simulation.results.find((r) => r && (isSymbol(r.symbol) || isDate(r.requested_date)))
    ?? simulation;
  const symbol = context.symbol ?? simulation.symbol;
  const requested = context.requested_date ?? simulation.requested_date;
  if (!isSymbol(symbol) || !isDate(requested)) {
    return failure(RULE_FALLBACK_CODES.NO_JUDGEABLE_SCENARIO, '模拟情景缺少标的或申报日期：不调用 AI');
  }
  const effective = context.change?.effective_date
    ?? context.date_mapping?.effective_date
    ?? context.effective_date
    ?? null;
  const changePct = Number.isFinite(context.change?.change_pct) ? context.change.change_pct : null;
  return {
    ok: true,
    scenario: {
      symbol,
      requested_date: requested,
      effective_date: isDate(effective) ? effective : null,
      action: simulation.scenario_action === 'sell' ? 'sell' : 'buy',
      change_pct: changePct,
    },
    currentRules: Array.isArray(currentRules) ? currentRules : [],
  };
}

export function buildScenarioJudgmentRequest({ simulation, currentRules = [], runId, requestId = null } = {}) {
  if (typeof runId !== 'string' || runId.trim() === '') {
    return failure(RULE_FALLBACK_CODES.REQUEST_INVALID, '缺少模拟运行标识');
  }
  const picked = pickScenarioForJudgment({ simulation, currentRules });
  if (!picked.ok) return picked;
  const hashes = picked.currentRules.map((r) => r.hash);
  const rules = picked.currentRules.map((rule) => {
    const result = resultForRule(simulation, rule.hash);
    return {
      template_id: rule.template_id,
      fields: Object.fromEntries(Object.entries(rule.fields ?? {}).map(([k, v]) => [k, Number(v)])),
      scope: rule.scope?.kind === 'symbol' ? { kind: 'symbol', symbol: rule.scope.symbol } : { kind: 'all' },
      version: Number(rule.v),
      hash: rule.hash,
      verdict: result?.display_verdict ?? 'not_evaluated',
      code: result?.code ? String(result.code).slice(0, 80) : null,
    };
  });
  const flowId = `fallback-${runId}`.slice(0, 120);
  const request = {
    stage: SCENARIO_JUDGMENT_STAGE,
    flow_id: flowId,
    request_id: (requestId ?? `${flowId}-1`).slice(0, 120),
    scenario_id: `scenario-${runId}`.slice(0, 120),
    rule_set_hash: ruleSetHash(hashes),
    scenario: { ...picked.scenario, rules },
  };
  const requestRulesOk = rules.every((r) => isHash(r.hash) && Number.isInteger(r.version) && r.version >= 1
    && typeof r.template_id === 'string' && r.fields && Object.values(r.fields).every((v) => Number.isFinite(v)));
  if (!requestRulesOk || !isTraceId(request.flow_id) || !isTraceId(request.request_id)
    || !isTraceId(request.scenario_id) || !isHash(request.rule_set_hash)) {
    return failure(RULE_FALLBACK_CODES.REQUEST_INVALID, '情景判断请求字段未通过本地检查');
  }
  return {
    ok: true,
    request,
    expected: {
      flow_id: request.flow_id,
      request_id: request.request_id,
      scenario_id: request.scenario_id,
      rule_set_hash: request.rule_set_hash,
    },
  };
}

export function validateScenarioJudgmentResponse(rawText, expected) {
  if (typeof rawText !== 'string') {
    return failure(RULE_FALLBACK_CODES.RESPONSE_INVALID, '情景判断响应不是字符串');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return failure(RULE_FALLBACK_CODES.RESPONSE_INVALID, '情景判断响应不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((k) => !['judgment', 'answer_text', 'binding'].includes(k))) {
    return failure(RULE_FALLBACK_CODES.RESPONSE_INVALID, '情景判断响应字段非法');
  }
  if (parsed.judgment !== 'no_match') {
    return failure(RULE_FALLBACK_CODES.RESPONSE_INVALID, 'AI 不得声称规则命中；规则命中以本地判定为准');
  }
  if (typeof parsed.answer_text !== 'string' || parsed.answer_text.trim() === ''
    || parsed.answer_text.length > MAX_ANSWER_CHARS) {
    return failure(RULE_FALLBACK_CODES.RESPONSE_INVALID, '情景判断正文为空或过长');
  }
  if (UNSAFE_RE.test(parsed.answer_text)) {
    return failure(RULE_FALLBACK_CODES.RESPONSE_INVALID, '情景判断包含越界内容，已丢弃');
  }
  const binding = parsed.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || binding.flow_id !== expected.flow_id
    || binding.request_id !== expected.request_id
    || binding.scenario_id !== expected.scenario_id
    || binding.rule_set_hash !== expected.rule_set_hash) {
    return failure(RULE_FALLBACK_CODES.BINDING_MISMATCH, '情景判断绑定与当前请求不一致，已丢弃');
  }
  return { ok: true, judgment: 'no_match', answer_text: parsed.answer_text.trim(), binding };
}

function invokeWithTimeout(fn, request, timeoutMs) {
  let timer = null;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(failure(RULE_FALLBACK_CODES.TIMEOUT, 'AI 情景判断超时')), timeoutMs);
  });
  const call = Promise.resolve()
    .then(() => fn(request))
    .then((response) => ({ ok: true, response }))
    .catch(() => failure(RULE_FALLBACK_CODES.UNAVAILABLE, 'AI 情景判断服务不可用'));
  return Promise.race([call, timed]).finally(() => clearTimeout(timer));
}

export function createRuleFallback({ transport, timeoutMs = 8000 } = {}) {
  async function judgeScenario({ simulation, currentRules = [], runId, requestId = null } = {}) {
    const built = buildScenarioJudgmentRequest({ simulation, currentRules, runId, requestId });
    if (!built.ok) return built;
    if (!transport || typeof transport.scenarioJudgment !== 'function') {
      return failure(RULE_FALLBACK_CODES.UNAVAILABLE, '情景判断接口未配置');
    }
    const call = await invokeWithTimeout(transport.scenarioJudgment, built.request, timeoutMs);
    if (!call.ok) return call;
    const rawText = call.response && typeof call.response.rawText === 'string' ? call.response.rawText : null;
    const checked = validateScenarioJudgmentResponse(rawText, built.expected);
    if (!checked.ok) return checked;
    return {
      ok: true,
      judgment: checked.judgment,
      answer_text: checked.answer_text,
      binding: checked.binding,
    };
  }
  return Object.freeze({ judgeScenario });
}
