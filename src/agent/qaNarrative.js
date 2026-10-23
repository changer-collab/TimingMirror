// 问答模型解读层（浏览器端）：本地答案的补充解释，不参与事实计算。
// 只发送问题、意图、已展示 facts/evidence 与允许值清单；不发送本地答案原文。
// 模型文本必须通过本地二次校验；任何失败都不返回文本。
export const QA_NARRATIVE_CODES = Object.freeze({
  UNAVAILABLE: 'E_QA_NARRATIVE_UNAVAILABLE',
  REQUEST: 'E_QA_NARRATIVE_REQUEST',
  RESPONSE: 'E_QA_NARRATIVE_RESPONSE',
  CHECK: 'E_QA_NARRATIVE_CHECK',
  TRANSPORT: 'E_QA_NARRATIVE_TRANSPORT',
});

export const QA_NARRATIVE_INTENTS = Object.freeze([
  'worst_trade', 'best_trade', 'pattern_explain', 'profile',
  'how_to_change', 'what_if', 'meta_calc', 'meta_trust',
]);

const MAX_ANSWER_CHARS = 320;
const MIN_ANSWER_CHARS = 40;
const MAX_FACTS = 12;
const MAX_EVIDENCE = 12;
const MAX_NUMBERS = 40;
const MAX_COUNTS = 20;
const MAX_DATES = 20;
const MAX_SYMBOLS = 20;
const MAX_DISPLAYS = 40;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const SOURCE_DATE_RE = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/g;
const SOURCE_DATE_ONE_RE = /^(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?$/u;
const MONEY_RE = /[+-]?¥[+-]?\d[\d,]*(?:\.\d+)?/g;
const PCT_RE = /[+-]?\d+(?:\.\d+)?\s*%/g;
const PP_RE = /[+-]?\d+(?:\.\d+)?\s*pp/gi;
const UNIT_RE = /([+-]?\d[\d,]*(?:\.\d+)?)\s*(元|股|手|份)/g;
const COUNT_TOKEN_RE = /(\d[\d,]*(?:\.\d+)?)\s*(笔|次|条|类|份|个|天|日|行)/g;
const CHINESE_COUNT_RE = /[一二三四五六七八九十百千万两]+(?:笔|次|条|类|份|个|天|日|行|股|手|元)/u;
const MARKDOWN_RE = /```|(?:^|\n)\s*(?:[-*+]\s|#{1,6}\s)|\]\(|https?:\/\/|www\./iu;
const FILE_RE = /\.(?:csv|xlsx?|pdf|json|mjs|js|txt)\b/iu;
const ADVICE_RE = /(?:建议|推荐|应该|可以|不妨|最好)\s*(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)/u;
const ADVICE_SUFFIX_RE = /(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)建议/u;
const PREDICTION_RE = /(?:预测|预计)(?:后市|未来|涨跌|股价|走势)|(?:会涨|会跌|必涨|必跌|目标价|稳赚|保证收益|保证盈利)/u;
const PERSONA_RE = /(?:人格|性格|你总是|你从不)/u;

const CANON_MAP = Object.freeze((() => {
  const map = { '％': '%', '＋': '+', '－': '-', '−': '-', '￥': '¥', '．': '.', '，': ',' };
  for (let digit = 0; digit < 10; digit += 1) map[String.fromCharCode(0xff10 + digit)] = String(digit);
  return map;
})());
const CANON_RE = /[％＋－−￥．，０-９]/g;

const FAILURE_TEXT = Object.freeze({
  [QA_NARRATIVE_CODES.UNAVAILABLE]: 'AI 解读接口不可用',
  [QA_NARRATIVE_CODES.REQUEST]: '这次回答没有可发送的解读事实',
  [QA_NARRATIVE_CODES.RESPONSE]: 'AI 解读返回格式不符合约定',
  [QA_NARRATIVE_CODES.CHECK]: 'AI 解读未通过数字校验',
  [QA_NARRATIVE_CODES.TRANSPORT]: '在线解读服务暂时不可用',
});

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

function normalizeDateMatch(match) {
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function pushUnique(list, value, max) {
  if (!value || list.includes(value) || list.length >= max) return;
  list.push(value);
}

function collectAllowed(parts) {
  const source = parts.join('\n');
  const sourceCanon = canon(source);
  const allowed = { numbers: [], counts: [], dates: [], symbols: [], displays: [] };

  for (const match of sourceCanon.matchAll(new RegExp(SOURCE_DATE_RE.source, 'g'))) {
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
  const stripPatterns = [
    new RegExp(SOURCE_DATE_RE.source, 'g'),
    MONEY_RE, PCT_RE, PP_RE, UNIT_RE, COUNT_TOKEN_RE,
  ];
  for (const pattern of stripPatterns) residue = residue.replace(pattern, ' ');
  for (const match of residue.matchAll(/(?<!\d)\d{6}(?!\d)/g)) {
    pushUnique(allowed.symbols, match[0], MAX_SYMBOLS);
  }
  residue = residue.replace(/(?<!\d)\d{6}(?!\d)/g, ' ');
  for (const match of residue.matchAll(/[+-]?\d[\d,]*(?:\.\d+)?/g)) {
    pushUnique(allowed.numbers, numericKey(match[0]), MAX_NUMBERS);
  }
  return allowed;
}

export function buildNarrativeRequest({ question = '', intent = '', facts = [], evidence = [] } = {}) {
  const cleanFacts = (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact.label === 'string' && typeof fact.value === 'string')
    .slice(0, MAX_FACTS)
    .map((fact) => ({ label: fact.label.slice(0, 80), value: fact.value.slice(0, 200) }));
  const cleanEvidence = (Array.isArray(evidence) ? evidence : [])
    .filter((item) => item && typeof item.label === 'string' && typeof item.detail === 'string')
    .slice(0, MAX_EVIDENCE)
    .map((item) => ({ label: item.label.slice(0, 80), detail: item.detail.slice(0, 320) }));
  const normalizedQuestion = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!normalizedQuestion) {
    return { ok: false, code: QA_NARRATIVE_CODES.REQUEST, message: '问题为空' };
  }
  if (!QA_NARRATIVE_INTENTS.includes(intent)) {
    return { ok: false, code: QA_NARRATIVE_CODES.REQUEST, message: '该回答不提供 AI 解读' };
  }
  if (!cleanFacts.length) {
    return { ok: false, code: QA_NARRATIVE_CODES.REQUEST, message: '没有可解释的事实' };
  }
  const allowed = collectAllowed([
    normalizedQuestion,
    ...cleanFacts.flatMap((fact) => [fact.label, fact.value]),
    ...cleanEvidence.flatMap((item) => [item.label, item.detail]),
  ]);
  return {
    ok: true,
    request: {
      question: normalizedQuestion,
      intent,
      facts: cleanFacts,
      evidence: cleanEvidence,
      allowed,
    },
  };
}

function validateNumbers(text, allowed) {
  const countSet = new Set(allowed.counts);
  const dateSet = new Set(allowed.dates);
  const symbolSet = new Set(allowed.symbols);
  const displaySet = new Set(allowed.displays);
  let residue = text;
  let failed = null;
  const replaceAll = (pattern, onMatch) => {
    residue = residue.replace(pattern, (raw) => {
      if (failed) return ' ';
      if (onMatch(raw) !== true) failed = '解读包含未提供的数字、日期、代码或计数';
      return ' ';
    });
  };
  replaceAll(MONEY_RE, (raw) => displaySet.has(displayKey(raw)));
  replaceAll(PCT_RE, (raw) => displaySet.has(displayKey(raw)));
  replaceAll(PP_RE, (raw) => displaySet.has(displayKey(raw)));
  replaceAll(UNIT_RE, (raw) => {
    const match = raw.match(/^([+-]?\d[\d,]*(?:\.\d+)?)\s*(元|股|手|份)$/u);
    return Boolean(match) && countSet.has(`${numericKey(match[1])}${match[2]}`);
  });
  replaceAll(COUNT_TOKEN_RE, (raw) => {
    const match = raw.match(/^(\d[\d,]*(?:\.\d+)?)\s*(笔|次|条|类|份|个|天|日|行)$/u);
    return Boolean(match) && countSet.has(`${numericKey(match[1])}${match[2]}`);
  });
  replaceAll(new RegExp(SOURCE_DATE_RE.source, 'g'), (raw) => {
    const match = raw.match(SOURCE_DATE_ONE_RE);
    const date = match ? normalizeDateMatch(match) : null;
    return Boolean(date) && dateSet.has(date);
  });
  replaceAll(/(?<!\d)\d{6}(?!\d)/g, (raw) => symbolSet.has(raw));
  if (failed) return { ok: false, message: failed };
  if (CHINESE_COUNT_RE.test(residue)) return { ok: false, message: '解读使用中文数字计数' };
  if (/\d/u.test(residue)) return { ok: false, message: '解读包含未在事实中提供的数字' };
  return { ok: true, checked: text.length };
}

export function checkNarrativeText(text, allowed) {
  if (typeof text !== 'string') return { ok: false, message: '解读不是字符串' };
  const value = text.trim();
  const length = [...value].length;
  if (length < MIN_ANSWER_CHARS || length > MAX_ANSWER_CHARS) {
    return { ok: false, message: '解读长度不符合约定' };
  }
  if (CONTROL_RE.test(value)) return { ok: false, message: '解读包含换行或控制字符' };
  if (MARKDOWN_RE.test(value)) return { ok: false, message: '解读包含 Markdown 或链接' };
  if (FILE_RE.test(value)) return { ok: false, message: '解读包含文件名' };
  if (ADVICE_RE.test(value) || ADVICE_SUFFIX_RE.test(value) || PREDICTION_RE.test(value) || PERSONA_RE.test(value)) {
    return { ok: false, message: '解读包含建议、预测或人格化表述' };
  }
  if (!allowed || typeof allowed !== 'object') return { ok: false, message: '缺少允许值清单' };
  return validateNumbers(value, allowed);
}

function failure(code, message) {
  return { ok: false, code, message: message ?? FAILURE_TEXT[code] ?? 'AI 解读未完成' };
}

function parseAnswerText(result) {
  const rawText = result?.rawText;
  if (typeof rawText !== 'string') return null;
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Object.keys(parsed).length !== 1 || typeof parsed.answer_text !== 'string') return null;
    return parsed.answer_text;
  } catch {
    return null;
  }
}

export function qaNarrativeFailureText(code) {
  return FAILURE_TEXT[code] ?? 'AI 解读未完成';
}

export function createQaNarrative({ transport = null } = {}) {
  async function ask({ question, intent, facts, evidence } = {}) {
    if (typeof transport?.qaNarrative !== 'function') return failure(QA_NARRATIVE_CODES.UNAVAILABLE);
    const built = buildNarrativeRequest({ question, intent, facts, evidence });
    if (!built.ok) return failure(built.code, built.message);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      try {
        result = await transport.qaNarrative(built.request);
      } catch (error) {
        return failure(QA_NARRATIVE_CODES.TRANSPORT, error?.message ? '在线解读服务暂时不可用' : undefined);
      }
      const text = parseAnswerText(result);
      if (text === null) {
        lastError = failure(QA_NARRATIVE_CODES.RESPONSE);
        continue;
      }
      const checked = checkNarrativeText(text, built.request.allowed);
      if (!checked.ok) {
        lastError = failure(QA_NARRATIVE_CODES.CHECK);
        continue;
      }
      return {
        ok: true,
        text: text.trim(),
        number_check: { checked: checked.checked, matched_count: checked.checked, failed_count: 0 },
      };
    }
    return lastError ?? failure(QA_NARRATIVE_CODES.RESPONSE);
  }

  return Object.freeze({ ask });
}
