// 问答模型解读阶段 · 服务端固定约束与校验。
// 只接受问题、意图、已展示事实/证据与允许值清单；不接受原始账单、成交明细、账户、图片或 URL。
// 模型文本必须只使用允许数字/日期/代码/计数；不通过则整段丢弃，不回传候选文本。
export const QA_NARRATIVE_STAGE = 'qa_narrative';
export const QA_NARRATIVE_MAX_ANSWER_CHARS = 320;
export const QA_NARRATIVE_MIN_ANSWER_CHARS = 40;
export const QA_NARRATIVE_INTENTS = Object.freeze([
  'worst_trade', 'best_trade', 'pattern_explain', 'profile',
  'how_to_change', 'what_if', 'meta_calc', 'meta_trust',
]);

export const QA_NARRATIVE_CODES = Object.freeze({
  REQUEST_INVALID: 'E_QA_NARRATIVE_REQUEST_INVALID',
  RESPONSE: 'E_QA_NARRATIVE_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['question', 'intent', 'facts', 'evidence', 'allowed']);
const FACT_KEYS = new Set(['label', 'value']);
const EVIDENCE_KEYS = new Set(['label', 'detail']);
const ALLOWED_KEYS = new Set(['numbers', 'counts', 'dates', 'symbols', 'displays']);
const MAX_FACTS = 12;
const MAX_EVIDENCE = 12;
const MAX_NUMBERS = 40;
const MAX_COUNTS = 20;
const MAX_DATES = 20;
const MAX_SYMBOLS = 20;
const MAX_DISPLAYS = 40;
const MAX_QUESTION = 200;
const MAX_LABEL = 80;
const MAX_FACT_VALUE = 200;
const MAX_EVIDENCE_DETAIL = 320;
const MAX_DISPLAY = 64;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SYMBOL_RE = /^\d{6}$/u;
const COUNT_RE = /^\d+(?:\.\d+)?(?:笔|次|条|类|份|个|天|日|行|股|手|元)$/u;
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

const MONEY_SOURCE = '[+-]?¥[+-]?\\d[\\d,]*(?:\\.\\d+)?';
const MONEY_RE = new RegExp(MONEY_SOURCE, 'g');
const PCT_RE = /[+-]?\d+(?:\.\d+)?\s*%/g;
const PP_RE = /[+-]?\d+(?:\.\d+)?\s*pp/gi;
const UNIT_RE = /([+-]?\d[\d,]*(?:\.\d+)?)\s*(元|股|手|份)/g;
const COUNT_TOKEN_RE = /(\d[\d,]*(?:\.\d+)?)\s*(笔|次|条|类|份|个|天|日|行)/g;
const SOURCE_DATE_RE = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g;
const SOURCE_DATE_ONE_RE = /^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/u;
const CHINESE_COUNT_RE = /[一二三四五六七八九十百千万两]+(?:笔|次|条|类|份|个|天|日|行|股|手|元)/u;
const MARKDOWN_RE = /```|(?:^|\n)\s*(?:[-*+]\s|#{1,6}\s)|\]\(|https?:\/\/|www\./iu;
const FILE_RE = /\.(?:csv|xlsx?|pdf|json|mjs|js|txt)\b/iu;
const ADVICE_RE = /(?:建议|推荐|应该|可以|不妨|最好)\s*(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)/u;
const ADVICE_SUFFIX_RE = /(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)建议/u;
const PREDICTION_RE = /(?:预测|预计)(?:后市|未来|涨跌|股价|走势)|(?:会涨|会跌|必涨|必跌|目标价|稳赚|保证收益|保证盈利)/u;
const PERSONA_RE = /(?:人格|性格|你总是|你从不)/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string'
  && value.trim().length > 0
  && [...value.trim()].length <= max
  && !CONTROL_RE.test(value);

const CANON_MAP = Object.freeze((() => {
  const map = { '％': '%', '＋': '+', '－': '-', '−': '-', '￥': '¥', '．': '.', '，': ',' };
  for (let digit = 0; digit < 10; digit += 1) map[String.fromCharCode(0xff10 + digit)] = String(digit);
  return map;
})());
const CANON_RE = /[％＋－−￥．，０-９]/g;

function canon(text) {
  return String(text).replace(CANON_RE, (ch) => CANON_MAP[ch]);
}

function compact(text) {
  return canon(text).replace(/\s+/g, '');
}

function numericKey(raw) {
  let value = String(raw).replace(/[,，\s]/g, '');
  value = canon(value);
  if (value.startsWith('+')) value = value.slice(1);
  return value;
}

function displayKey(raw) {
  return compact(raw).toLowerCase();
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  return { ok: false, code: QA_NARRATIVE_CODES.REQUEST_INVALID, message };
}

function uniqueList(values, { max, validate, normalize = (value) => value.trim() }) {
  if (!Array.isArray(values) || values.length > max) return null;
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || !validate(value)) return null;
    const item = normalize(value);
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeDateMatch(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sourceFactsText(request) {
  const parts = [request.question];
  for (const fact of request.facts) parts.push(fact.label, fact.value);
  for (const item of request.evidence) parts.push(item.label, item.detail);
  return parts.join('\n');
}

function sourceHasNumber(sourceCanon, number) {
  if (!number) return false;
  const re = new RegExp(`(?<![\\d.])${escapeRe(number)}(?![\\d.])`, 'u');
  return re.test(sourceCanon);
}

function sourceHasCount(sourceCompact, count) {
  const match = count.match(/^(\d+(?:\.\d+)?)([^\d]+)$/u);
  if (!match) return false;
  const re = new RegExp(`(?<![\\d.])${escapeRe(match[1])}${escapeRe(match[2])}`, 'u');
  return re.test(sourceCompact);
}

function sourceHasDisplay(sourceCompact, display) {
  return sourceCompact.includes(display);
}

function sourceHasDate(sourceCanon, date) {
  const re = new RegExp(SOURCE_DATE_RE.source, 'g');
  let match;
  while ((match = re.exec(sourceCanon)) !== null) {
    if (normalizeDateMatch(match) === date) return true;
  }
  return false;
}

function sourceHasSymbol(sourceCanon, symbol) {
  const re = new RegExp(`(?<!\\d)${escapeRe(symbol)}(?!\\d)`, 'u');
  return re.test(sourceCanon);
}

function validateAllowedAgainstSource(request) {
  const source = sourceFactsText(request);
  const sourceCanon = canon(source);
  const sourceCompact = sourceCanon.replace(/\s+/g, '');
  // 数字清单去掉了千分位逗号，源文本也去逗号后再比对，避免 ¥1,200.00 被误判为不存在。
  const sourceNumeric = sourceCanon.replace(/[,，\s]/g, '');
  const { allowed } = request;
  if (allowed.numbers.some((value) => !sourceHasNumber(sourceNumeric, value))) {
    return fail('allowed.numbers 包含事实中不存在的数字');
  }
  if (allowed.counts.some((value) => !sourceHasCount(sourceCompact, value))) {
    return fail('allowed.counts 包含事实中不存在的计数');
  }
  if (allowed.dates.some((value) => !sourceHasDate(sourceCanon, value))) {
    return fail('allowed.dates 包含事实中不存在的日期');
  }
  if (allowed.symbols.some((value) => !sourceHasSymbol(sourceCanon, value))) {
    return fail('allowed.symbols 包含事实中不存在的代码');
  }
  if (allowed.displays.some((value) => !sourceHasDisplay(sourceCompact, value))) {
    return fail('allowed.displays 包含事实中不存在的展示值');
  }
  return { ok: true };
}

export function normalizeQaNarrativeRequest(body) {
  if (!isObject(body)) return fail('请求体必须为对象');
  if (Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) return fail('请求包含不允许字段');
  if (!isText(body.question, MAX_QUESTION)) return fail('question 非法');
  if (!QA_NARRATIVE_INTENTS.includes(body.intent)) return fail('intent 不在允许范围');
  if (!Array.isArray(body.facts) || body.facts.length === 0 || body.facts.length > MAX_FACTS) {
    return fail('facts 必须为非空数组且不超过上限');
  }
  const facts = [];
  for (const item of body.facts) {
    if (!isObject(item)) return fail('facts 项必须为对象');
    if (Object.keys(item).some((key) => !FACT_KEYS.has(key))) return fail('facts 项包含不允许字段');
    if (!isText(item.label, MAX_LABEL) || !isText(item.value, MAX_FACT_VALUE)) return fail('facts 项文本非法');
    facts.push({ label: item.label.trim(), value: item.value.trim() });
  }
  if (!Array.isArray(body.evidence) || body.evidence.length > MAX_EVIDENCE) return fail('evidence 必须为数组');
  const evidence = [];
  for (const item of body.evidence) {
    if (!isObject(item)) return fail('evidence 项必须为对象');
    if (Object.keys(item).some((key) => !EVIDENCE_KEYS.has(key))) return fail('evidence 项包含不允许字段');
    if (!isText(item.label, MAX_LABEL) || !isText(item.detail, MAX_EVIDENCE_DETAIL)) return fail('evidence 项文本非法');
    evidence.push({ label: item.label.trim(), detail: item.detail.trim() });
  }
  if (!isObject(body.allowed)) return fail('allowed 必须为对象');
  if (Object.keys(body.allowed).some((key) => !ALLOWED_KEYS.has(key))) return fail('allowed 包含不允许字段');

  const numbers = uniqueList(body.allowed.numbers, {
    max: MAX_NUMBERS,
    validate: (value) => NUMBER_RE.test(numericKey(value)) && numericKey(value).length <= 32,
    normalize: numericKey,
  });
  const counts = uniqueList(body.allowed.counts, {
    max: MAX_COUNTS,
    validate: (value) => COUNT_RE.test(compact(value)) && compact(value).length <= 32,
    normalize: compact,
  });
  const dates = uniqueList(body.allowed.dates, {
    max: MAX_DATES,
    validate: (value) => DATE_RE.test(value),
    normalize: (value) => value.trim(),
  });
  const symbols = uniqueList(body.allowed.symbols, {
    max: MAX_SYMBOLS,
    validate: (value) => SYMBOL_RE.test(value),
    normalize: (value) => value.trim(),
  });
  const displays = uniqueList(body.allowed.displays, {
    max: MAX_DISPLAYS,
    validate: (value) => {
      const item = displayKey(value);
      return item.length > 0 && item.length <= MAX_DISPLAY && /\d/u.test(item);
    },
    normalize: displayKey,
  });
  if (!numbers || !counts || !dates || !symbols || !displays) return fail('allowed 数组非法');

  const request = {
    question: body.question.trim(),
    intent: body.intent,
    facts,
    evidence,
    allowed: { numbers, counts, dates, symbols, displays },
  };
  const sourced = validateAllowedAgainstSource(request);
  if (!sourced.ok) return sourced;
  return { ok: true, request };
}

function replaceAll(text, pattern, onMatch) {
  let failed = null;
  const next = text.replace(pattern, (...args) => {
    if (failed) return ' ';
    const result = onMatch(args[0]);
    if (result !== true) {
      failed = result || '包含未提供的数字';
      return ' ';
    }
    return ' ';
  });
  return failed ? { ok: false, message: failed } : { ok: true, text: next };
}

function validateNarrativeNumbers(text, allowed) {
  const countSet = new Set(allowed.counts);
  const dateSet = new Set(allowed.dates);
  const symbolSet = new Set(allowed.symbols);
  const displaySet = new Set(allowed.displays);

  let residue = text;

  // 金额/百分比/百分点先剥离：避免金额里的 6 位数字被误判成股票代码。
  const money = replaceAll(residue, MONEY_RE, (raw) => (
    displaySet.has(displayKey(raw)) ? true : '解读包含未提供的金额'
  ));
  if (!money.ok) return money;
  residue = money.text;

  const pct = replaceAll(residue, PCT_RE, (raw) => (
    displaySet.has(displayKey(raw)) ? true : '解读包含未提供的百分比'
  ));
  if (!pct.ok) return pct;
  residue = pct.text;

  const pp = replaceAll(residue, PP_RE, (raw) => (
    displaySet.has(displayKey(raw)) ? true : '解读包含未提供的百分点'
  ));
  if (!pp.ok) return pp;
  residue = pp.text;

  const units = replaceAll(residue, UNIT_RE, (raw) => {
    const match = String(raw).match(/^([+-]?\d[\d,]*(?:\.\d+)?)\s*(元|股|手|份)$/u);
    const key = match ? `${numericKey(match[1])}${match[2]}` : '';
    return countSet.has(key) ? true : '解读包含未提供的数量';
  });
  if (!units.ok) return units;
  residue = units.text;

  const counts = replaceAll(residue, COUNT_TOKEN_RE, (raw) => {
    const match = String(raw).match(/^(\d[\d,]*(?:\.\d+)?)\s*(笔|次|条|类|份|个|天|日|行)$/u);
    const key = match ? `${numericKey(match[1])}${match[2]}` : '';
    return countSet.has(key) ? true : '解读包含未提供的计数';
  });
  if (!counts.ok) return counts;
  residue = counts.text;

  const dates = replaceAll(residue, new RegExp(SOURCE_DATE_RE.source, 'g'), (raw) => {
    const match = raw.match(SOURCE_DATE_ONE_RE);
    const date = match ? normalizeDateMatch(match) : null;
    return date && dateSet.has(date) ? true : '解读包含未提供的日期';
  });
  if (!dates.ok) return dates;
  residue = dates.text;

  const symbols = replaceAll(residue, /(?<!\d)\d{6}(?!\d)/g, (raw) => (
    symbolSet.has(raw) ? true : '解读包含未提供的股票代码'
  ));
  if (!symbols.ok) return symbols;
  residue = symbols.text;

  if (CHINESE_COUNT_RE.test(residue)) return { ok: false, message: '解读使用中文数字计数' };
  if (/\d/u.test(residue)) return { ok: false, message: '解读包含未在事实中提供的数字' };
  return { ok: true, checked: text.length };
}

function responseFailure(field, message, extra = {}) {
  return {
    ok: false,
    code: QA_NARRATIVE_CODES.RESPONSE,
    field,
    message,
    ...extra,
  };
}

function responseMeta(rawText) {
  return {
    response_type: typeof rawText,
    raw_length: typeof rawText === 'string' ? [...rawText].length : null,
  };
}

export function validateQaNarrativeResponse(rawText, request) {
  if (typeof rawText !== 'string') {
    return responseFailure('response', '响应不是字符串', responseMeta(rawText));
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return responseFailure('json', '响应不是合法 JSON', responseMeta(rawText));
  }
  if (!isObject(parsed)) {
    return responseFailure('response', '响应必须为对象', responseMeta(rawText));
  }
  if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'answer_text')) {
    return responseFailure('response.keys', '响应字段不符合约定', responseMeta(rawText));
  }
  if (typeof parsed.answer_text !== 'string') {
    return responseFailure('answer_text', 'answer_text 必须为字符串', responseMeta(rawText));
  }
  const text = parsed.answer_text.trim();
  const length = [...text].length;
  const meta = { ...responseMeta(rawText), answer_text_length: length };
  if (length < QA_NARRATIVE_MIN_ANSWER_CHARS || length > QA_NARRATIVE_MAX_ANSWER_CHARS) {
    return responseFailure('answer_text.length', 'answer_text 长度不符合约定', meta);
  }
  if (CONTROL_RE.test(text)) {
    return responseFailure('answer_text.control', 'answer_text 包含换行或控制字符', meta);
  }
  if (MARKDOWN_RE.test(text)) {
    return responseFailure('answer_text.markdown', 'answer_text 包含 Markdown 或链接', meta);
  }
  if (FILE_RE.test(text)) {
    return responseFailure('answer_text.file', 'answer_text 包含文件名', meta);
  }
  if (ADVICE_RE.test(text) || ADVICE_SUFFIX_RE.test(text) || PREDICTION_RE.test(text) || PERSONA_RE.test(text)) {
    return responseFailure('answer_text.prohibited', 'answer_text 包含建议、预测或人格化表述', meta);
  }
  if (!isObject(request) || !isObject(request.allowed)) {
    return responseFailure('request.allowed', '缺少允许值清单', meta);
  }
  const checked = validateNarrativeNumbers(text, request.allowed);
  if (!checked.ok) {
    return responseFailure('answer_text.numbers', checked.message, meta);
  }
  return { ok: true, answer_text: text, checked: checked.checked };
}

// rewrite-v2 复用同一套允许值与数字校验。
function pushUnique(list, value, max) {
  if (!value || list.includes(value) || list.length >= max) return;
  list.push(value);
}

function collectAllowed(parts) {
  const source = parts.join('\n');
  const sourceCanon = canon(source);
  const allowed = { numbers: [], counts: [], dates: [], symbols: [], displays: [] };

  for (const match of sourceCanon.matchAll(SOURCE_DATE_RE)) {
    const date = normalizeDateMatch(match);
    if (date) pushUnique(allowed.dates, date, MAX_DATES);
  }
  for (const match of sourceCanon.matchAll(MONEY_RE)) {
    pushUnique(allowed.displays, displayKey(match[0]), MAX_DISPLAYS);
    pushUnique(allowed.numbers, numericKey(match[0].replace(/^[+-]?¥/u, '')), MAX_NUMBERS);
  }
  for (const match of sourceCanon.matchAll(PCT_RE)) {
    pushUnique(allowed.displays, displayKey(match[0]), MAX_DISPLAYS);
    pushUnique(allowed.numbers, numericKey(match[0].replace(/%/u, '')), MAX_NUMBERS);
  }
  for (const match of sourceCanon.matchAll(PP_RE)) {
    pushUnique(allowed.displays, displayKey(match[0]), MAX_DISPLAYS);
    pushUnique(allowed.numbers, numericKey(match[0].replace(/pp/iu, '')), MAX_NUMBERS);
  }
  for (const match of sourceCanon.matchAll(UNIT_RE)) {
    pushUnique(allowed.counts, `${numericKey(match[1])}${match[2]}`, MAX_COUNTS);
    pushUnique(allowed.numbers, numericKey(match[1]), MAX_NUMBERS);
  }
  for (const match of sourceCanon.matchAll(COUNT_TOKEN_RE)) {
    pushUnique(allowed.counts, `${numericKey(match[1])}${match[2]}`, MAX_COUNTS);
    pushUnique(allowed.numbers, numericKey(match[1]), MAX_NUMBERS);
  }

  // 先剥离日期/金额/百分比/计数，再把剩余数字与 6 位代码纳入允许值。
  let residue = sourceCanon;
  const stripPatterns = [SOURCE_DATE_RE, MONEY_RE, PCT_RE, PP_RE, UNIT_RE, COUNT_TOKEN_RE];
  for (const pattern of stripPatterns) {
    residue = residue.replace(pattern, ' ');
  }
  for (const match of residue.matchAll(/(?<!\d)\d{6}(?!\d)/g)) {
    pushUnique(allowed.symbols, match[0], MAX_SYMBOLS);
  }
  residue = residue.replace(/(?<!\d)\d{6}(?!\d)/g, ' ');
  for (const match of residue.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?/g)) {
    pushUnique(allowed.numbers, numericKey(match[0]), MAX_NUMBERS);
  }
  return allowed;
}

export function collectAllowedValues(parts) {
  return collectAllowed(Array.isArray(parts) ? parts : []);
}

export function validateTextNumbers(text, allowed) {
  return validateNarrativeNumbers(text, allowed);
}
