// 结果解释阶段 · 服务端固定约束与校验。
// 只接受当前规则与一次成功模拟的结构化事实；不接受 CSV、成交行、账户、图片或 URL。
// 服务端无状态、无 flow 预算；两次预算由客户端共享计数，服务端只校验单次请求与响应。
export const RESULT_EXPLANATION_STAGE = 'result_explanation';
export const RESULT_EXPLANATION_MAX_ANSWER_CHARS = 1000;
export const RESULT_EXPLANATION_TEMPLATES = Object.freeze([
  'no_buy_on_surge',
  'no_buy_back_within',
  'sell_within_after_buy',
]);

export const RESULT_EXPLANATION_CODES = Object.freeze({
  REQUEST_INVALID: 'E_RESULT_EXPLANATION_REQUEST_INVALID',
  RESPONSE: 'E_RESULT_EXPLANATION_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['stage', 'flow_id', 'request_id', 'rule', 'simulation']);
const RULE_KEYS = new Set(['template_id', 'fields', 'scope', 'version', 'hash']);
const SIMULATION_KEYS = new Set(['result_id', 'status', 'symbol', 'requested_date', 'effective_date', 'summary', 'results']);
const RESULT_KEYS = new Set(['verdict', 'display_verdict', 'code', 'message', 'requested_date', 'effective_date']);
const SUMMARY_KEYS = Object.freeze(['triggered', 'not_triggered', 'not_applicable', 'missing_data', 'error']);
const OUTCOMES = new Set(['triggered', 'not_triggered']);
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const HASH_RE = /^[a-f0-9]{8,128}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNSAFE_RE = /(https?:\/\/|www\.|\.csv\b|\.xlsx?\b|\.pdf\b|成交明细|原始账单|账户|银行卡|身份证|手机号|组合|总收益|买入建议|卖出建议|预测|荐股)/i;
const FORBIDDEN_CONCLUSION_RE = /(收益|回报|盈利|亏损|赚|赔|组合|总资产|总收益|累计收益|年化|净值|仓位|目标价|建议买入|建议卖出|荐股|预测|涨跌)/i;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v);
const COUNT_RE = /(未触发|未命中|不适用|数据不足|无法判定|触发|命中|错误)\s*(\d+)\s*条/g;

function toAsciiDigits(value) {
  return String(value)
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/．/g, '.');
}

function normalizeDate(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function validateDates(text, simulation) {
  const requested = simulation.requested_date;
  const effective = simulation.effective_date;
  const allowed = new Set([requested, effective].filter(Boolean));
  const dateRe = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g;
  let out = text;
  let match;
  while ((match = dateRe.exec(text)) !== null) {
    const date = normalizeDate(match);
    if (!date || !allowed.has(date)) {
      return { ok: false, message: `解释包含未提供的交易日：${match[0]}` };
    }
    const prefix = text.slice(Math.max(0, match.index - 18), match.index);
    if (/(请求日|请求日期|申报日|申报日期)/.test(prefix) && date !== requested) {
      return { ok: false, message: '解释中的请求日期与实际请求日期不一致' };
    }
    if (/(实际使用交易日|实际交易日|使用交易日|生效交易日|实际日期)/.test(prefix)) {
      if (!effective || date !== effective) {
        return { ok: false, message: '解释中的实际交易日与返回的实际交易日不一致' };
      }
    }
    out = out.replace(match[0], ' ');
  }
  return { ok: true, text: out };
}

function validateCounts(text, simulation) {
  const summary = simulation.summary;
  const map = {
    触发: 'triggered',
    命中: 'triggered',
    未触发: 'not_triggered',
    未命中: 'not_triggered',
    不适用: 'not_applicable',
    数据不足: 'missing_data',
    无法判定: 'error',
    错误: 'error',
  };
  let out = text;
  let match;
  const re = new RegExp(COUNT_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    const key = map[match[1]];
    const value = Number(match[2]);
    if (summary[key] !== value) {
      return { ok: false, message: `解释中的“${match[1]} ${value} 条”与模拟汇总不一致` };
    }
    out = out.replace(match[0], ' ');
  }
  return { ok: true, text: out };
}

function validateVerdict(text, simulation) {
  const verdicts = [...new Set(simulation.results.map((r) => r.verdict))];
  if (verdicts.length !== 1) {
    return { ok: false, message: '逐项命中结论不一致，暂不支持解释' };
  }
  const negative = /未命中|未触发|没有命中|没有触发|不会触发|不触发/.test(text);
  const positive = /命中|触发/.test(text.replace(/未命中|未触发|没有命中|没有触发|不会触发|不触发/g, ' '));
  if (verdicts[0] === 'triggered' && (!positive || negative)) {
    return { ok: false, message: '解释的命中结论与模拟结果不一致' };
  }
  if (verdicts[0] === 'not_triggered' && (!negative || positive)) {
    return { ok: false, message: '解释的未命中结论与模拟结果不一致' };
  }
  return { ok: true };
}

function validateNumbers(text, request) {
  const { rule, simulation } = request;
  let out = text.split(simulation.symbol).join(' ');
  const percentRe = /([+-]?\d+(?:\.\d+)?)\s*%/g;
  let match;
  while ((match = percentRe.exec(out)) !== null) {
    if (rule.template_id !== 'no_buy_on_surge' || Number(match[1]) !== rule.fields.threshold_pct) {
      return { ok: false, message: '解释包含未提供的百分比数字' };
    }
    out = out.replace(match[0], ' ');
  }
  const windowRe = /(\d+)\s*(?:个)?(?:交易日|天|日)/g;
  while ((match = windowRe.exec(out)) !== null) {
    if (!Object.hasOwn(rule.fields, 'days') || Number(match[1]) !== rule.fields.days) {
      return { ok: false, message: '解释包含未提供的交易日窗口数字' };
    }
    out = out.replace(match[0], ' ');
  }
  const versionRe = /(?:v|版本)\s*(\d+)/gi;
  while ((match = versionRe.exec(out)) !== null) {
    if (Number(match[1]) !== rule.version) {
      return { ok: false, message: '解释包含未提供的规则版本数字' };
    }
    out = out.replace(match[0], ' ');
  }
  const bareRe = /[+-]?\d+(?:\.\d+)?/g;
  if (bareRe.test(out)) {
    return { ok: false, message: '解释包含未提供的数字或未标注单位的数字' };
  }
  return { ok: true };
}

function validateExplanationFacts(answerText, request) {
  const text = toAsciiDigits(answerText);
  if (FORBIDDEN_CONCLUSION_RE.test(text)) {
    return { ok: false, message: '解释包含收益、组合或建议类越界结论' };
  }
  const counts = validateCounts(text, request.simulation);
  if (!counts.ok) return counts;
  const verdict = validateVerdict(counts.text, request.simulation);
  if (!verdict.ok) return verdict;
  const dates = validateDates(counts.text, request.simulation);
  if (!dates.ok) return dates;
  return validateNumbers(dates.text, request);
}

function fail(code, message) {
  return { ok: false, code, message };
}

function normalizeRule(raw) {
  if (!isObject(raw)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'rule 必须为对象');
  if (Object.keys(raw).some((key) => !RULE_KEYS.has(key))) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'rule 包含不允许字段');
  }
  if (!RESULT_EXPLANATION_TEMPLATES.includes(raw.template_id)) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'template_id 不在允许范围');
  }
  if (!isObject(raw.fields)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'fields 必须为对象');
  const expected = raw.template_id === 'no_buy_on_surge' ? ['threshold_pct'] : ['days'];
  if (Object.keys(raw.fields).length !== expected.length || expected.some((key) => !Object.hasOwn(raw.fields, key))) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'fields 与模板不匹配');
  }
  for (const key of expected) {
    const value = raw.fields[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `fields.${key} 必须为数字`);
    }
    if (key === 'threshold_pct' && value < 0) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'threshold_pct 非法');
    if (key === 'days' && (!Number.isInteger(value) || value < 1)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'days 非法');
  }
  if (!isObject(raw.scope)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'scope 必须为对象');
  if (Object.keys(raw.scope).some((key) => !['kind', 'symbol'].includes(key))) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'scope 包含不允许字段');
  }
  if (raw.scope.kind === 'all') {
    if (raw.scope.symbol !== undefined && raw.scope.symbol !== null && raw.scope.symbol !== '') {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, '全部股票不能带 symbol');
    }
  } else if (raw.scope.kind === 'symbol') {
    if (typeof raw.scope.symbol !== 'string' || !/^\d{6}$/.test(raw.scope.symbol)) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'scope.symbol 必须为 6 位代码');
    }
  } else {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'scope.kind 非法');
  }
  if (!Number.isInteger(raw.version) || raw.version < 1) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'rule.version 必须为正整数');
  }
  if (typeof raw.hash !== 'string' || !HASH_RE.test(raw.hash)) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'rule.hash 非法');
  }
  return {
    ok: true,
    rule: {
      template_id: raw.template_id,
      fields: { ...raw.fields },
      scope: raw.scope.kind === 'symbol'
        ? { kind: 'symbol', symbol: raw.scope.symbol }
        : { kind: 'all' },
      version: raw.version,
      hash: raw.hash,
    },
  };
}

function normalizeSimulation(raw) {
  if (!isObject(raw)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'simulation 必须为对象');
  if (Object.keys(raw).some((key) => !SIMULATION_KEYS.has(key))) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'simulation 包含不允许字段');
  }
  if (!isText(raw.result_id, 120) || !TRACE_ID_RE.test(raw.result_id)) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'result_id 非法');
  }
  if (raw.status !== 'completed') {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, '仅允许解释执行完成的模拟');
  }
  if (typeof raw.symbol !== 'string' || !/^\d{6}$/.test(raw.symbol)) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'symbol 非法');
  }
  if (!isDate(raw.requested_date)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'requested_date 非法');
  if (raw.effective_date !== null && !isDate(raw.effective_date)) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'effective_date 非法');
  }
  if (!isObject(raw.summary)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'summary 必须为对象');
  if (Object.keys(raw.summary).length !== SUMMARY_KEYS.length
    || SUMMARY_KEYS.some((key) => !Number.isInteger(raw.summary[key]) || raw.summary[key] < 0)) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'summary 必须包含五个非负整数');
  }
  if (!Array.isArray(raw.results) || raw.results.length < 1 || raw.results.length > 10) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'results 数量非法');
  }
  const results = [];
  for (const [index, item] of raw.results.entries()) {
    if (!isObject(item) || Object.keys(item).some((key) => !RESULT_KEYS.has(key))) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `results[${index}] 字段非法`);
    }
    if (!OUTCOMES.has(item.verdict) || !OUTCOMES.has(item.display_verdict)) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `results[${index}] 只允许命中或未命中`);
    }
    if (item.code !== null && item.code !== undefined && !isText(item.code, 80)) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `results[${index}].code 非法`);
    }
    if (typeof item.message !== 'string' || item.message.length > 500) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `results[${index}].message 非法`);
    }
    if (!isDate(item.requested_date)) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `results[${index}].requested_date 非法`);
    }
    if (item.effective_date !== null && item.effective_date !== undefined && !isDate(item.effective_date)) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `results[${index}].effective_date 非法`);
    }
    results.push({
      verdict: item.verdict,
      display_verdict: item.display_verdict,
      code: item.code ?? null,
      message: item.message,
      requested_date: item.requested_date,
      effective_date: item.effective_date ?? null,
    });
  }
  const counted = SUMMARY_KEYS.reduce((sum, key) => sum + raw.summary[key], 0);
  if (counted !== results.length) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'summary 与 results 数量不一致');
  }
  return {
    ok: true,
    simulation: {
      result_id: raw.result_id,
      status: 'completed',
      symbol: raw.symbol,
      requested_date: raw.requested_date,
      effective_date: raw.effective_date ?? null,
      summary: Object.fromEntries(SUMMARY_KEYS.map((key) => [key, raw.summary[key]])),
      results,
    },
  };
}

export function normalizeResultExplanationRequest(body) {
  if (!isObject(body)) return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, '请求体必须为对象');
  if (Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, '请求包含不允许字段');
  }
  if (body.stage !== RESULT_EXPLANATION_STAGE) {
    return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, 'stage 必须为 result_explanation');
  }
  for (const key of ['flow_id', 'request_id']) {
    if (!isText(body[key], 120) || !TRACE_ID_RE.test(body[key])) {
      return fail(RESULT_EXPLANATION_CODES.REQUEST_INVALID, `${key} 格式非法`);
    }
  }
  const rule = normalizeRule(body.rule);
  if (!rule.ok) return rule;
  const simulation = normalizeSimulation(body.simulation);
  if (!simulation.ok) return simulation;
  return {
    ok: true,
    request: {
      stage: RESULT_EXPLANATION_STAGE,
      flow_id: body.flow_id,
      request_id: body.request_id,
      rule: rule.rule,
      simulation: simulation.simulation,
    },
  };
}

export function validateResultExplanationResponse(rawText, request) {
  if (typeof rawText !== 'string') {
    return fail(RESULT_EXPLANATION_CODES.RESPONSE, '解释响应必须为字符串');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail(RESULT_EXPLANATION_CODES.RESPONSE, '解释响应不是合法 JSON');
  }
  if (!isObject(parsed) || Object.keys(parsed).some((key) => key !== 'answer_text')) {
    return fail(RESULT_EXPLANATION_CODES.RESPONSE, '解释响应字段非法');
  }
  if (!isText(parsed.answer_text, RESULT_EXPLANATION_MAX_ANSWER_CHARS)) {
    return fail(RESULT_EXPLANATION_CODES.RESPONSE, '解释正文为空或过长');
  }
  if (UNSAFE_RE.test(parsed.answer_text)) {
    return fail(RESULT_EXPLANATION_CODES.RESPONSE, '解释包含越界内容');
  }
  const facts = validateExplanationFacts(parsed.answer_text, request);
  if (!facts.ok) return fail(RESULT_EXPLANATION_CODES.RESPONSE, facts.message);
  return { ok: true, answer_text: parsed.answer_text.trim() };
}
