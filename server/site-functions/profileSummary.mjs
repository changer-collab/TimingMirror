// 画像解读阶段 · 服务端固定约束与校验。
// 输入只有客户端的确定性画像摘要，不接收成交明细、文件名、账户或原始对话。
// 输出必须为固定 JSON；数字只能来自摘要，避免 AI 编造收益或目标。
export const PROFILE_SUMMARY_STAGE = 'profile_summary';
export const PROFILE_SUMMARY_VERSION = 1;

export const PROFILE_SUMMARY_CODES = Object.freeze({
  REQUEST_INVALID: 'E_PROFILE_SUMMARY_REQUEST_INVALID',
  RESPONSE: 'E_PROFILE_SUMMARY_RESPONSE_INVALID',
});

// 只用于诊断校验失败类型；不含模型原文，也不回传任何用户数据。
export const PROFILE_SUMMARY_DETAILS = Object.freeze({
  INVALID_JSON: 'invalid_json',
  INVALID_SHAPE: 'invalid_shape',
  INVALID_VERSION: 'invalid_version',
  INVALID_TEXT: 'invalid_text',
  UNSAFE_CONTENT: 'unsafe_content',
  INVESTMENT_ADVICE: 'investment_advice',
  UNLISTED_NUMBER: 'unlisted_number',
  UNLISTED_DATE: 'unlisted_date',
  INVALID_KEYWORDS: 'invalid_keywords',
});

const REQUEST_KEYS = new Set(['digest']);
const DIGEST_KEYS = new Set(['profile_key', 'bills', 'metrics', 'behavior', 'rules', 'facts', 'limits']);
const BILL_KEYS = new Set(['count', 'date_from', 'date_to']);
const METRIC_KEYS = Object.freeze([
  'actual_return', 'benchmark_return', 'drag_pp', 'drag_amount',
  'trade_count', 'win_rate', 'pgr', 'plr',
]);
const BEHAVIOR_KEYS = new Set(['tags', 'patterns']);
const RULE_KEYS = new Set(['total', 'kept', 'warned']);
const FACT_KEYS = new Set(['kind', 'key', 'value']);
const SUMMARY_KEYS = Object.freeze([
  'schema_version', 'headline', 'summary', 'keywords', 'strengths',
  'blind_spots', 'next_actions', 'confidence', 'data_limits',
]);
export const PROFILE_FACT_KINDS = Object.freeze(['goal', 'preference', 'constraint', 'habit', 'risk_tolerance']);
const FACT_KINDS = new Set(PROFILE_FACT_KINDS);
const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const PROFILE_KEY_RE = /^[0-9a-f]{8}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const UNSAFE_RE = /(https?:\/\/|www\.|成交明细|原始账单|账户|银行卡|身份证|手机号)/iu;
const ADVICE_RE = /(建议买入|建议卖出|买入建议|卖出建议|荐股|目标价|保证收益|稳赚|必涨|必跌)/u;
const DATE_TOKEN_RE = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/gu;
const NUMBER_RE = /[+-]?\d+(?:\.\d+)?/gu;
const CONTROL_OR_SPACE_RE = /[\u0000-\u001f\u007f]+/gu;
const FULLWIDTH_DIGIT_RE = /[\uff10-\uff19]/gu;
const NUMERIC_SYMBOL_RE = /[\uff0b\uff0d\uff0e\u2212]/gu;
const THOUSANDS_SEPARATOR_RE = /(?<=\d)[,，](?=\d{3}(?!\d))/gu;
const ITEM_TEXT_KEYS = Object.freeze(['text', 'value', 'label', 'content', 'description', 'tip', 'item']);
const CONFIDENCE_ALIASES = new Map([
  ['高', 'high'], ['较高', 'high'],
  ['中', 'medium'], ['中等', 'medium'],
  ['低', 'low'], ['偏低', 'low'],
]);
const MAX_DIGEST_BYTES = 16 * 1024;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const textBytes = (value) => new TextEncoder().encode(value).byteLength;
const charLength = (value) => [...value].length;

function fail(code, message, detail = null) {
  return { ok: false, code, message, ...(detail === null ? {} : { detail }) };
}

function boundedText(value, maxChars) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || CONTROL_RE.test(trimmed) || charLength(trimmed) > maxChars) return null;
  return trimmed;
}

// 模型输出允许换行/制表等空白，统一压成单行；其他控制字符也替换为空格。
function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_OR_SPACE_RE, ' ').replace(/\s+/gu, ' ').trim();
}

// 超长文本在标点处截断；没有标点时避开数字 token，避免截出半个数字再触发数字校验。
function fitText(value, maxChars) {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  const limit = Math.max(1, maxChars - 1);
  let cut = limit;
  const minCut = Math.floor(limit * 0.6);
  for (let index = limit - 1; index >= minCut; index--) {
    if (/[，。；、！？,.;!?]/u.test(chars[index])) {
      cut = index + 1;
      break;
    }
  }
  while (cut > 0 && /[0-9.,+\-%]/u.test(chars[cut - 1])) cut--;
  if (cut <= 0) cut = limit;
  return `${chars.slice(0, cut).join('').trimEnd()}…`;
}

function summaryObject(value) {
  if (!isObject(value)) return null;
  if (SUMMARY_KEYS.some((key) => Object.hasOwn(value, key))) return value;
  for (const nested of Object.values(value)) {
    if (isObject(nested) && SUMMARY_KEYS.some((key) => Object.hasOwn(nested, key))) return nested;
  }
  return value;
}

function normalizeSchemaVersion(value) {
  if (value === undefined || value === null) return PROFILE_SUMMARY_VERSION;
  const numeric = typeof value === 'string' ? Number(value.trim()) : value;
  return numeric === PROFILE_SUMMARY_VERSION ? PROFILE_SUMMARY_VERSION : null;
}

function normalizeConfidence(value) {
  if (typeof value !== 'string') return 'low';
  const key = value.trim().toLowerCase();
  if (CONFIDENCE_LEVELS.includes(key)) return key;
  return CONFIDENCE_ALIASES.get(key) ?? 'low';
}

function extractItemText(value) {
  if (typeof value === 'string') return value;
  if (!isObject(value)) return '';
  for (const key of ITEM_TEXT_KEYS) {
    if (typeof value[key] === 'string') return value[key];
  }
  return '';
}

function optionalNumber(value, { min = -1e9, max = 1e9, integer = false } = {}) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return { ok: false };
  if (integer && !Number.isInteger(value)) return { ok: false };
  return { ok: true, value };
}

function optionalDate(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string' || !DATE_RE.test(value)) return { ok: false };
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return { ok: false };
  return { ok: true, value };
}

function stringList(value, { maxItems, maxChars }) {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > maxItems) return { ok: false };
  const output = [];
  for (const item of value) {
    const text = boundedText(item, maxChars);
    if (!text) return { ok: false };
    output.push(text);
  }
  return { ok: true, value: output };
}

function normalizeBills(raw) {
  if (!isObject(raw)) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'bills 必须为对象');
  if (Object.keys(raw).some((key) => !BILL_KEYS.has(key))) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'bills 包含不允许字段');
  }
  if (!Number.isInteger(raw.count) || raw.count < 0 || raw.count > 100000) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'bills.count 非法');
  }
  const from = optionalDate(raw.date_from);
  const to = optionalDate(raw.date_to);
  if (!from.ok || !to.ok) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'bills 日期非法');
  if (from.value && to.value && from.value > to.value) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'bills 日期范围非法');
  }
  return { ok: true, value: { count: raw.count, date_from: from.value, date_to: to.value } };
}

function normalizeMetrics(raw) {
  if (raw === undefined) return { ok: true, value: Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) };
  if (!isObject(raw)) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'metrics 必须为对象');
  if (Object.keys(raw).some((key) => !METRIC_KEYS.includes(key))) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'metrics 包含不允许字段');
  }
  const value = {};
  for (const key of METRIC_KEYS) {
    const rules = key === 'trade_count'
      ? { min: 0, max: 100000, integer: true }
      : key === 'win_rate'
        ? { min: 0, max: 1 }
        : { min: -1e9, max: 1e9 };
    const checked = optionalNumber(raw[key], rules);
    if (!checked.ok) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, `metrics.${key} 非法`);
    value[key] = checked.value;
  }
  return { ok: true, value };
}

function normalizeBehavior(raw) {
  if (raw === undefined) return { ok: true, value: { tags: [], patterns: [] } };
  if (!isObject(raw)) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'behavior 必须为对象');
  if (Object.keys(raw).some((key) => !BEHAVIOR_KEYS.has(key))) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'behavior 包含不允许字段');
  }
  const tags = stringList(raw.tags, { maxItems: 8, maxChars: 24 });
  const patterns = stringList(raw.patterns, { maxItems: 5, maxChars: 120 });
  if (!tags.ok || !patterns.ok) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'behavior 文本非法');
  return { ok: true, value: { tags: tags.value, patterns: patterns.value } };
}

function normalizeRules(raw) {
  if (raw === undefined) return { ok: true, value: { total: 0, kept: 0, warned: 0 } };
  if (!isObject(raw)) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'rules 必须为对象');
  if (Object.keys(raw).some((key) => !RULE_KEYS.has(key))) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'rules 包含不允许字段');
  }
  const value = {};
  for (const key of ['total', 'kept', 'warned']) {
    const checked = optionalNumber(raw[key], { min: 0, max: 100000, integer: true });
    if (!checked.ok) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, `rules.${key} 非法`);
    value[key] = checked.value ?? 0;
  }
  return { ok: true, value };
}

function normalizeFacts(raw) {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw) || raw.length > 20) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'facts 数量非法');
  const seen = new Set();
  const output = [];
  for (const item of raw) {
    if (!isObject(item) || Object.keys(item).some((key) => !FACT_KEYS.has(key))) {
      return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'facts 字段非法');
    }
    if (!FACT_KINDS.has(item.kind) || typeof item.key !== 'string' || !SLUG_RE.test(item.key)) {
      return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'facts 类型或键非法');
    }
    const value = boundedText(item.value, 240);
    if (!value || textBytes(value) > 240) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'facts 内容非法');
    const dedupe = `${item.kind}\n${item.key}\n${value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    output.push({ kind: item.kind, key: item.key, value });
  }
  return { ok: true, value: output };
}

export function normalizeProfileSummaryRequest(body) {
  if (!isObject(body) || Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, '请求字段非法');
  }
  const raw = body.digest;
  if (!isObject(raw) || Object.keys(raw).some((key) => !DIGEST_KEYS.has(key))) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'digest 字段非法');
  }
  if (typeof raw.profile_key !== 'string' || !PROFILE_KEY_RE.test(raw.profile_key)) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'profile_key 非法');
  }
  const bills = normalizeBills(raw.bills);
  if (!bills.ok) return bills;
  const metrics = normalizeMetrics(raw.metrics);
  if (!metrics.ok) return metrics;
  const behavior = normalizeBehavior(raw.behavior);
  if (!behavior.ok) return behavior;
  const rules = normalizeRules(raw.rules);
  if (!rules.ok) return rules;
  const facts = normalizeFacts(raw.facts);
  if (!facts.ok) return facts;
  const limits = stringList(raw.limits, { maxItems: 5, maxChars: 120 });
  if (!limits.ok) return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'limits 非法');

  const digest = {
    profile_key: raw.profile_key,
    bills: bills.value,
    metrics: metrics.value,
    behavior: behavior.value,
    rules: rules.value,
    facts: facts.value,
    limits: limits.value,
  };
  if (textBytes(JSON.stringify(digest)) > MAX_DIGEST_BYTES) {
    return fail(PROFILE_SUMMARY_CODES.REQUEST_INVALID, 'digest 过大');
  }
  return { ok: true, digest };
}

export async function profileDigestHash(digest) {
  const bytes = new TextEncoder().encode(JSON.stringify(digest));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function confidenceCap(digest) {
  if (digest.bills.count >= 3 && (digest.metrics.trade_count ?? 0) >= 20) return 'high';
  if (digest.bills.count >= 1) return 'medium';
  return 'low';
}

function addAllowedNumber(values, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  // 模型常把比率换算成百分比并保留 1 位小数；允许 0-6 位小数的舍入版本与绝对值。
  for (const base of [value, value * 100]) {
    for (let decimals = 0; decimals <= 6; decimals++) {
      const rounded = Number(base.toFixed(decimals));
      values.add(rounded);
      values.add(-rounded);
    }
  }
  values.add(value);
  values.add(-value);
}

function allowedNumbers(digest) {
  // 0/3/20 是产品固定的计数与样本门槛，不属于用户数据。
  const values = new Set([0, 3, 20]);
  addAllowedNumber(values, digest.bills.count);
  for (const key of METRIC_KEYS) addAllowedNumber(values, digest.metrics[key]);
  addAllowedNumber(values, digest.rules.total);
  addAllowedNumber(values, digest.rules.kept);
  addAllowedNumber(values, digest.rules.warned);
  for (const text of [
    ...digest.behavior.tags, ...digest.behavior.patterns,
    ...digest.facts.map((fact) => fact.value), ...digest.limits,
    digest.bills.date_from, digest.bills.date_to,
  ]) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(NUMBER_RE)) addAllowedNumber(values, Number(match[0]));
  }
  return values;
}

function normalizeNumericText(value) {
  return value
    .replace(FULLWIDTH_DIGIT_RE, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(NUMERIC_SYMBOL_RE, (symbol) => {
      if (symbol === '\uff0e') return '.';
      if (symbol === '\uff0b') return '+';
      return '-';
    })
    .replace(THOUSANDS_SEPARATOR_RE, '');
}

function validateNumbers(value, digest) {
  const allowed = allowedNumbers(digest);
  const dates = [digest.bills.date_from, digest.bills.date_to].filter(Boolean);
  const text = normalizeNumericText(value);
  let stripped = text;
  for (const match of text.matchAll(DATE_TOKEN_RE)) {
    const month = String(Number(match[2])).padStart(2, '0');
    const day = String(Number(match[3])).padStart(2, '0');
    const date = `${match[1]}-${month}-${day}`;
    if (!dates.includes(date)) {
      return { ok: false, detail: PROFILE_SUMMARY_DETAILS.UNLISTED_DATE, message: '解读包含未提供的日期' };
    }
    stripped = stripped.replaceAll(match[0], ' ');
  }
  for (const match of stripped.matchAll(NUMBER_RE)) {
    const number = Number(match[0]);
    if (!allowed.has(number)) {
      return { ok: false, detail: PROFILE_SUMMARY_DETAILS.UNLISTED_NUMBER, message: '解读包含未提供的数字' };
    }
  }
  return { ok: true };
}

function validateText(value, maxChars, label) {
  if (typeof value !== 'string') {
    return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVALID_TEXT, message: `${label} 非法` };
  }
  const text = cleanText(value);
  if (!text) return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVALID_TEXT, message: `${label} 非法` };
  if (UNSAFE_RE.test(text)) {
    return { ok: false, detail: PROFILE_SUMMARY_DETAILS.UNSAFE_CONTENT, message: `${label} 包含越界内容` };
  }
  if (ADVICE_RE.test(text)) {
    return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVESTMENT_ADVICE, message: `${label} 包含投资建议` };
  }
  return { ok: true, value: fitText(text, maxChars) };
}

function validateItems(value, { maxItems, maxChars, label }) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  const items = Array.isArray(value) ? value : [value];
  const output = [];
  for (const item of items.slice(0, maxItems)) {
    const checked = validateText(extractItemText(item), maxChars, label);
    if (!checked.ok) {
      if (checked.detail === PROFILE_SUMMARY_DETAILS.INVALID_TEXT) continue;
      return checked;
    }
    output.push(checked.value);
  }
  return { ok: true, value: output };
}

function validateKeywords(value) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVALID_KEYWORDS, message: 'keywords 非法' };
  }
  if (!value.length) return { ok: true, value: [] };
  const output = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') {
      return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVALID_KEYWORDS, message: 'keywords 非法' };
    }
    const text = cleanText(item);
    if (!text || charLength(text) < 2 || charLength(text) > 12) {
      return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVALID_KEYWORDS, message: 'keywords 长度非法' };
    }
    if (UNSAFE_RE.test(text)) {
      return { ok: false, detail: PROFILE_SUMMARY_DETAILS.UNSAFE_CONTENT, message: 'keywords 包含越界内容' };
    }
    if (ADVICE_RE.test(text)) {
      return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVESTMENT_ADVICE, message: 'keywords 包含投资建议' };
    }
    if (seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  if (output.length < 3 || output.length > 6) {
    return { ok: false, detail: PROFILE_SUMMARY_DETAILS.INVALID_KEYWORDS, message: 'keywords 数量非法' };
  }
  return { ok: true, value: output };
}

export function validateProfileSummaryValue(value, digest) {
  const summary = summaryObject(value);
  if (!summary) return fail(PROFILE_SUMMARY_CODES.RESPONSE, '解读必须为对象', PROFILE_SUMMARY_DETAILS.INVALID_SHAPE);
  const schemaVersion = normalizeSchemaVersion(summary.schema_version);
  if (schemaVersion === null) {
    return fail(PROFILE_SUMMARY_CODES.RESPONSE, '解读版本非法', PROFILE_SUMMARY_DETAILS.INVALID_VERSION);
  }
  const summaryText = validateText(summary.summary, 240, 'summary');
  if (!summaryText.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, summaryText.message, summaryText.detail);
  const headlineSource = typeof summary.headline === 'string' && cleanText(summary.headline)
    ? summary.headline
    : summaryText.value;
  const headline = validateText(headlineSource, 24, 'headline');
  if (!headline.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, headline.message, headline.detail);
  const keywords = validateKeywords(summary.keywords);
  if (!keywords.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, keywords.message, keywords.detail);
  const strengths = validateItems(summary.strengths, { maxItems: 3, maxChars: 60, label: 'strengths' });
  if (!strengths.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, strengths.message, strengths.detail);
  const blindSpots = validateItems(summary.blind_spots, { maxItems: 3, maxChars: 60, label: 'blind_spots' });
  if (!blindSpots.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, blindSpots.message, blindSpots.detail);
  const nextActions = validateItems(summary.next_actions, { maxItems: 3, maxChars: 60, label: 'next_actions' });
  if (!nextActions.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, nextActions.message, nextActions.detail);
  const dataLimits = validateItems(summary.data_limits, { maxItems: 3, maxChars: 80, label: 'data_limits' });
  if (!dataLimits.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, dataLimits.message, dataLimits.detail);
  const confidence = normalizeConfidence(summary.confidence);
  const allText = [
    headline.value, summaryText.value, ...keywords.value,
    ...strengths.value, ...blindSpots.value, ...nextActions.value, ...dataLimits.value,
  ].join('\n');
  const numbers = validateNumbers(allText, digest);
  if (!numbers.ok) return fail(PROFILE_SUMMARY_CODES.RESPONSE, numbers.message, numbers.detail);
  const cap = confidenceCap(digest);
  const boundedConfidence = CONFIDENCE_LEVELS.indexOf(confidence) > CONFIDENCE_LEVELS.indexOf(cap) ? cap : confidence;
  return {
    ok: true,
    value: {
      schema_version: schemaVersion,
      headline: headline.value,
      summary: summaryText.value,
      keywords: keywords.value,
      strengths: strengths.value,
      blind_spots: blindSpots.value,
      next_actions: nextActions.value,
      confidence: boundedConfidence,
      data_limits: dataLimits.value,
    },
  };
}

export function validateProfileSummaryResponse(rawText, digest) {
  if (typeof rawText !== 'string') return fail(PROFILE_SUMMARY_CODES.RESPONSE, '解读响应必须为字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return fail(PROFILE_SUMMARY_CODES.RESPONSE, '解读响应不是合法 JSON', PROFILE_SUMMARY_DETAILS.INVALID_JSON);
  }
  return validateProfileSummaryValue(parsed, digest);
}

function percentText(value) {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

function safeKeyword(value) {
  const text = cleanText(String(value ?? ''));
  if (!text || charLength(text) < 2 || charLength(text) > 12 || UNSAFE_RE.test(text) || ADVICE_RE.test(text)) return '';
  return text;
}

function fallbackKeywords(digest) {
  const { metrics } = digest;
  const seeds = [
    ...digest.behavior.tags.map(safeKeyword),
    metrics.drag_pp === null ? '择时待观察'
      : metrics.drag_pp > 0.005 ? '择时拖累'
        : metrics.drag_pp < -0.005 ? '择时正贡献' : '择时影响有限',
    (metrics.trade_count ?? 0) >= 20 ? '交易样本充足' : '交易样本偏少',
    digest.bills.count >= 3 ? '跨账单观察' : '账单样本偏少',
    digest.facts.length ? '目标与约束已记录' : '',
  ];
  const output = [];
  const seen = new Set();
  for (const seed of seeds) {
    if (!seed || seen.has(seed)) continue;
    seen.add(seed);
    output.push(seed);
    if (output.length === 6) break;
  }
  for (const filler of ['画像积累中', '行为标签观察', '跨账单记录']) {
    if (output.length >= 3) break;
    if (seen.has(filler)) continue;
    seen.add(filler);
    output.push(filler);
  }
  return output.slice(0, 6);
}

export function buildProfileSummaryFallback(digest) {
  const { metrics } = digest;
  const confidence = confidenceCap(digest);
  const headline = metrics.drag_pp === null ? '先积累更多样本'
    : metrics.drag_pp > 0.005 ? '择时拖累了收益'
      : metrics.drag_pp < -0.005 ? '择时带来了正向差异'
        : '择时影响有限';
  const parts = [`基于 ${digest.bills.count} 份已确认账单、${metrics.trade_count ?? 0} 笔交易。`];
  if (metrics.actual_return !== null && metrics.benchmark_return !== null) {
    parts.push(`实际收益 ${percentText(metrics.actual_return)}，对照收益 ${percentText(metrics.benchmark_return)}。`);
  }
  if (metrics.drag_pp !== null) parts.push(`择时差异 ${percentText(metrics.drag_pp)}。`);
  if (digest.behavior.tags.length) parts.push(`已识别行为标签：${digest.behavior.tags.join('、')}。`);
  const limits = [];
  if (digest.bills.count < 3) limits.push('账单样本不足，结论仅供参考。');
  if ((metrics.trade_count ?? 0) < 20) limits.push('交易样本较少，暂不能形成稳定结论。');
  if (digest.facts.length === 0) limits.push('尚无用户明确陈述的目标或约束。');
  return {
    schema_version: PROFILE_SUMMARY_VERSION,
    headline,
    summary: parts.join(''),
    keywords: fallbackKeywords(digest),
    strengths: digest.behavior.tags.slice(0, 2),
    blind_spots: [],
    next_actions: [],
    confidence,
    data_limits: limits.slice(0, 3),
  };
}
