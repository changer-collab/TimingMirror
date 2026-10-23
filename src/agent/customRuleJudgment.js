// 自定义规则情境判定客户端（次要范围；接口候选，未冻结）
// 与 ruleFallback（scenario-judgment，只解释模板规则未命中）相互独立：这里逐条把用户确认过的
// 自定义规则与本次情境的最小数据交给 /api/llm/custom-rule-judgment；服务端校验请求与响应并回传
// binding，客户端只有 binding 与当前运行、规则身份完全一致时才采用结果。
// 失败（超时/不可用/响应无效/绑定不一致）一律按“无法判断”处理，绝不当作“未命中”。
// 边界：不直接调用模型/网络（transport 注入）；不读取凭证；不改变 contractRuleSet / simulateContracts。
export const CUSTOM_RULE_JUDGMENT_STAGE = 'custom_rule_judgment';

export const CUSTOM_RULE_JUDGMENT_CODES = Object.freeze({
  REQUEST_INVALID: 'E_CUSTOM_RULE_JUDGMENT_REQUEST_INVALID',
  TIMEOUT: 'W_CUSTOM_RULE_JUDGMENT_TIMEOUT',
  UNAVAILABLE: 'W_CUSTOM_RULE_JUDGMENT_UNAVAILABLE',
  RESPONSE_INVALID: 'E_CUSTOM_RULE_JUDGMENT_RESPONSE_INVALID',
  BINDING_MISMATCH: 'W_CUSTOM_RULE_JUDGMENT_BINDING_MISMATCH',
});

export const CUSTOM_RULE_JUDGMENT_USED_DATA = Object.freeze(['change_pct', 'buys', 'sells', 'calendar']);
const MAX_REASON_CHARS = 600;
const UNSAFE_RE = /(https?:\/\/|www\.|\.csv\b|\.xlsx?\b|\.pdf\b|成交明细|原始账单|账户|银行卡|身份证|手机号|建议买入|建议卖出|买入建议|卖出建议|预测|荐股|会涨|会跌)/i;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isSymbol = (v) => typeof v === 'string' && /^\d{6}$/.test(v);
const isTraceId = (v) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(v);
const isHash = (v) => typeof v === 'string' && /^[a-f0-9]{8,128}$/i.test(v);
const isDateList = (v, max) => Array.isArray(v) && v.length <= max && v.every((d) => isDate(d));

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// 从模拟结果条目构造判定请求：只包含规则身份（哈希/版本/原文/动作/范围）与最小情境数据。
export function buildCustomRuleJudgmentRequest({ entry, runId, requestId = null } = {}) {
  const rule = entry?.rule;
  const data = entry?.custom?.data;
  if (!rule || !data) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '模拟结果缺少自定义规则或情境数据：不发起判定');
  }
  const ruleId = rule.rule_id ?? null;
  if (!isHash(rule.hash) || !Number.isInteger(rule.v) || rule.v < 1
    || (ruleId !== null && !isTraceId(ruleId))
    || typeof rule.text !== 'string' || rule.text.trim() === '' || [...rule.text].length > 200
    || !['buy', 'sell', 'both'].includes(rule.action)) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '自定义规则身份字段未通过本地检查');
  }
  const scope = rule.scope?.kind === 'symbol'
    ? { kind: 'symbol', symbol: rule.scope.symbol }
    : { kind: 'all' };
  if (scope.kind === 'symbol' && !isSymbol(scope.symbol)) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '自定义规则适用范围未通过本地检查');
  }
  if (!isSymbol(data.symbol) || !isDate(data.requested_date)
    || (data.effective_date !== null && data.effective_date !== undefined && !isDate(data.effective_date))
    || (data.change_pct !== null && data.change_pct !== undefined && !Number.isFinite(data.change_pct))
    || !isDateList(data.buys ?? [], 200) || !isDateList(data.sells ?? [], 200)
    || !isDateList(data.trading_days ?? [], 500)) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '情境数据字段未通过本地检查');
  }
  if (typeof runId !== 'string' || runId.trim() === '') {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '缺少模拟运行标识');
  }
  const flowId = `custom-${runId}`.slice(0, 120);
  const judgmentId = `custom-${runId}-${String(rule.hash).slice(0, 12)}`.slice(0, 120);
  const request = {
    stage: CUSTOM_RULE_JUDGMENT_STAGE,
    flow_id: flowId,
    request_id: (requestId ?? `${flowId}-1`).slice(0, 120),
    judgment_id: judgmentId,
    rule: {
      schema: 'custom-v1',
      rule_id: ruleId,
      hash: rule.hash,
      version: rule.v,
      text: rule.text,
      action: rule.action,
      scope,
    },
    scenario: {
      symbol: data.symbol,
      requested_date: data.requested_date,
      action: entry.scenario_action === 'sell' ? 'sell' : 'buy',
      effective_date: data.effective_date ?? null,
      change_pct: Number.isFinite(data.change_pct) ? data.change_pct : null,
      market_label: typeof data.market_label === 'string' ? data.market_label.slice(0, 60) : null,
    },
    data: {
      buys: [...(data.buys ?? [])],
      sells: [...(data.sells ?? [])],
      trading_days: [...(data.trading_days ?? [])],
    },
  };
  if (!isTraceId(request.flow_id) || !isTraceId(request.request_id) || !isTraceId(request.judgment_id)) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, '判定请求标识未通过本地检查');
  }
  return {
    ok: true,
    request,
    expected: {
      flow_id: request.flow_id,
      request_id: request.request_id,
      judgment_id: request.judgment_id,
      rule_id: request.rule.rule_id,
      rule_hash: request.rule.hash,
      rule_version: request.rule.version,
      rule_action: request.rule.action,
      scenario_symbol: request.scenario.symbol,
      scenario_requested_date: request.scenario.requested_date,
      scenario_action: request.scenario.action,
    },
  };
}

export function validateCustomRuleJudgmentResult(rawText, expected) {
  if (typeof rawText !== 'string') {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定响应不是字符串');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定响应不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((k) => !['verdict', 'reason', 'used_data', 'binding'].includes(k))) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定响应字段非法');
  }
  if (!['triggered', 'not_triggered', 'unable'].includes(parsed.verdict)) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定 verdict 非法');
  }
  if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '' || parsed.reason.length > MAX_REASON_CHARS) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定依据为空或过长');
  }
  if (UNSAFE_RE.test(parsed.reason)) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定依据包含越界内容，已丢弃');
  }
  if (!Array.isArray(parsed.used_data)
    || parsed.used_data.some((u) => !CUSTOM_RULE_JUDGMENT_USED_DATA.includes(u))
    || new Set(parsed.used_data).size !== parsed.used_data.length) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, '自定义规则判定 used_data 非法');
  }
  const binding = parsed.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(expected).some((k) => binding[k] !== expected[k])) {
    return failure(CUSTOM_RULE_JUDGMENT_CODES.BINDING_MISMATCH, '自定义规则判定绑定与当前请求或规则不一致，已丢弃');
  }
  return {
    ok: true,
    verdict: parsed.verdict,
    reason: parsed.reason.trim(),
    used_data: [...parsed.used_data],
    binding,
  };
}

function invokeWithTimeout(fn, request, timeoutMs) {
  let timer = null;
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(failure(CUSTOM_RULE_JUDGMENT_CODES.TIMEOUT, '自定义规则判定超时')), timeoutMs);
  });
  const call = Promise.resolve()
    .then(() => fn(request))
    .then((response) => ({ ok: true, response }))
    .catch((error) => {
      const upstream = error && typeof error === 'object' ? error : null;
      const code = upstream && typeof upstream.upstreamCode === 'string' ? upstream.upstreamCode : CUSTOM_RULE_JUDGMENT_CODES.UNAVAILABLE;
      const message = upstream && typeof upstream.upstreamMessage === 'string' && upstream.upstreamMessage
        ? upstream.upstreamMessage
        : '自定义规则判定服务不可用';
      return failure(code, message);
    });
  return Promise.race([call, timed]).finally(() => clearTimeout(timer));
}

export function createCustomRuleJudgment({ transport, timeoutMs = 8000 } = {}) {
  async function judgeRule({ entry, runId, requestId = null } = {}) {
    const built = buildCustomRuleJudgmentRequest({ entry, runId, requestId });
    if (!built.ok) return built;
    if (!transport || typeof transport.customRuleJudgment !== 'function') {
      return failure(CUSTOM_RULE_JUDGMENT_CODES.UNAVAILABLE, '自定义规则判定接口未配置');
    }
    const call = await invokeWithTimeout(transport.customRuleJudgment, built.request, timeoutMs);
    if (!call.ok) return call;
    const rawText = call.response && typeof call.response.rawText === 'string' ? call.response.rawText : null;
    const checked = validateCustomRuleJudgmentResult(rawText, built.expected);
    if (!checked.ok) return checked;
    return { ok: true, verdict: checked.verdict, reason: checked.reason, used_data: checked.used_data, binding: checked.binding };
  }
  return Object.freeze({ judgeRule });
}
