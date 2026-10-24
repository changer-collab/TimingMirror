// 用户视角问答评分卡（qa-scorecard-1；候选，未冻结）。
//
// 只评“用户问的问题 + 最终渲染回答”：
//   1) 准确性硬门槛：数字/日期/代码回得到允许集合，内容命中问题焦点，不越合规边界；
//   2) 易读性七维 0/1/2：直答、简洁、白话、数字克制、结构、无空话、可行动。
// 不评模型内部推理，不要求固定答案原文；同一个好回答可以有很多写法。
//
// 边界：纯函数；不联网、不读账单、不调用模型；不记录原始交易或凭证。
// 运行自检：node tests/agent/qa-scorecard.test.mjs

import { charLength } from '../../src/agent/plainLanguage.js';
import { termsInText } from '../../src/agent/glossary.js';

export const QA_SCORECARD_VERSION = 'qa-scorecard-1';
export const QA_SCORE_MAX_TOTAL = 14;
export const QA_SCORE_PASS_TOTAL = 11;

export const QA_SCORE_DIMENSIONS = Object.freeze([
  Object.freeze({ id: 'direct', label: '直答' }),
  Object.freeze({ id: 'concise', label: '简洁' }),
  Object.freeze({ id: 'plain', label: '白话' }),
  Object.freeze({ id: 'numbers', label: '数字克制' }),
  Object.freeze({ id: 'structure', label: '结构' }),
  Object.freeze({ id: 'meaningful', label: '无空话' }),
  Object.freeze({ id: 'action', label: '可行动' }),
]);

const DIMENSION_IDS = Object.freeze(QA_SCORE_DIMENSIONS.map((item) => item.id));

const REF_RE = /第\s*\d+\s*[笔条行]/gu;
const DATE_RE = /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/gu;
const SYMBOL_RE = /(?<!\d)\d{6}(?!\d)/gu;
const MONEY_RE = /([+-]?)¥\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(万|亿)?/gu;
const YUAN_RE = /([+-]?\d[\d,]*(?:\.\d+)?)\s*(万|亿)?\s*元/gu;
const SCALE_RE = /([+-]?\d[\d,]*(?:\.\d+)?)\s*(万|亿)/gu;
const PCT_RE = /([+-]?\d[\d,]*(?:\.\d+)?)\s*(%|％|pp)/giu;
const COUNT_RE = /([+-]?\d[\d,]*(?:\.\d+)?)\s*(笔|次|条|类|份|个|天|日|行|股|手|年|月|日)/gu;
const NUM_RE = /[+-]?\d[\d,]*(?:\.\d+)?/gu;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const ERROR_CODE_RE = /\bE_[A-Z0-9_]+\b/u;

const PROFESSIONAL_TERMS = Object.freeze([
  '择时损耗', '对照收益', '实际收益', '反事实', '估值日', '阻断', '证据',
  '最大回撤', '回撤', '夏普比率', '年化收益率', '年化', '波动率', '换手率',
  '仓位', '基准', '阿尔法', '贝塔', '胜率', '盈亏比', '归因', '均线', '市盈率', '市净率',
]);

const GLOBAL_FORBIDDEN = Object.freeze([
  Object.freeze([/荐股|推荐.*(?:股票|标的|基金)/u, 'RECOMMEND']),
  Object.freeze([/(?:建议|推荐|应该|可以|不妨|最好)\s*(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)/u, 'TRADE_ADVICE']),
  Object.freeze([/(?:预测|预计)(?:后市|未来|涨跌|股价|走势)|(?:会涨|会跌|必涨|必跌|目标价|稳赚|保证收益|保证盈利)/u, 'PREDICTION']),
  Object.freeze([/其他用户|别人的账单|他人的账单/u, 'CROSS_USER']),
  Object.freeze([/实时行情|实时数据|盘中/u, 'REALTIME']),
  Object.freeze([/人格|性格|你总是|你从不/u, 'PERSONA']),
  Object.freeze([UUID_RE, 'INTERNAL_ID']),
  Object.freeze([ERROR_CODE_RE, 'ERROR_CODE']),
  Object.freeze([/\.(?:csv|xlsx?|pdf|json|mjs|js|txt)\b/iu, 'FILE_NAME']),
  Object.freeze([/\bsk-[A-Za-z0-9]{16,}\b/u, 'SECRET']),
]);

const FILLER_PATTERNS = Object.freeze([
  /你问的是|关于你(?:问|提出)的|根据你(?:提供|上传)的/u,
  /首先|其次|总的来说|综上所述/u,
  /希望(?:对你)?有帮助|仅供(?:你)?参考|投资有风险|入市需谨慎/u,
  /作为一个?AI|作为AI/u,
  /不难看出|显而易见|大家都知道/u,
]);

const PROCESS_RE = /我(?:先|正在|刚刚|已经)(?:查|看|读|分析|计算|检索)|接下来我(?:会|来)/u;
const BOUNDARY_RE = /不预测|不构成(?:投资)?建议|事后对照|只使用当前账单|示例数据|演示数据/u;
const ACTION_RE = /请|可以|打开|查看|补充|上传|核对|重试|确认|到报告|在报告|报告页/u;
const GENERIC_ACTION_RE = /注意|留意|小心|多/u;

function canonicalNumber(raw, unit = null) {
  const text = String(raw ?? '').replace(/[,，\s]/gu, '').replace(/^\+/u, '');
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const scale = unit === '亿' ? 1e8 : unit === '万' ? 1e4 : 1;
  return String(Number((value * scale).toFixed(6)));
}

function combineSign(sign, number) {
  const text = String(number ?? '').replace(/[,，\s]/gu, '').replace(/^\+/u, '');
  if (text.startsWith('-')) return text;
  return `${sign === '-' ? '-' : ''}${text}`;
}

function normalizeDate(raw) {
  const parts = String(raw ?? '').match(/\d+/gu);
  if (!parts || parts.length < 3) return null;
  return `${parts[0]}-${String(Number(parts[1])).padStart(2, '0')}-${String(Number(parts[2])).padStart(2, '0')}`;
}

export function renderedAnswerText(answer) {
  if (typeof answer === 'string') return answer;
  if (!answer || typeof answer !== 'object') return '';
  if (answer.rewrite?.status === 'ok') {
    return [
      answer.rewrite.headline,
      ...(answer.rewrite.plain ?? []).map((item) => item?.text),
      ...(answer.rewrite.boundaries ?? []),
    ].filter((item) => typeof item === 'string' && item.trim()).join(' ');
  }
  if (typeof answer.text === 'string') return answer.text;
  return [
    answer.headline,
    ...(answer.plain ?? []).map((item) => item?.text ?? item),
    ...(answer.boundaries ?? []),
  ].filter((item) => typeof item === 'string' && item.trim()).join(' ');
}

function answerParts(answer) {
  if (typeof answer === 'string') {
    return { headline: '', plain: [], boundaries: [], terms: [], text: answer };
  }
  if (!answer || typeof answer !== 'object') {
    return { headline: '', plain: [], boundaries: [], terms: [], text: '' };
  }
  if (answer.rewrite?.status === 'ok') {
    const plain = Array.isArray(answer.rewrite.plain) ? answer.rewrite.plain : [];
    return {
      headline: String(answer.rewrite.headline ?? ''),
      plain: plain.map((item) => ({ text: String(item?.text ?? '') })),
      boundaries: (answer.rewrite.boundaries ?? []).map((item) => String(item ?? '')).filter(Boolean),
      terms: (answer.rewrite.terms ?? []).map((item) => String(item?.term ?? item ?? '')).filter(Boolean),
      text: renderedAnswerText(answer),
    };
  }
  const headline = String(answer.headline ?? '');
  const plain = (Array.isArray(answer.plain) ? answer.plain : [])
    .map((item) => ({ text: String(item?.text ?? item ?? '') }))
    .filter((item) => item.text.trim());
  const boundaries = (Array.isArray(answer.boundaries) ? answer.boundaries : [])
    .map((item) => String(item ?? '')).filter(Boolean);
  return {
    headline,
    plain,
    boundaries,
    terms: (Array.isArray(answer.terms) ? answer.terms : [])
      .map((item) => String(item?.term ?? item ?? '')).filter(Boolean),
    text: renderedAnswerText(answer),
  };
}

export function extractNumberFacts(text) {
  let residue = String(text ?? '');
  const dates = [];
  const symbols = [];
  const numbers = [];

  residue = residue.replace(REF_RE, ' ');
  residue = residue.replace(DATE_RE, (raw) => {
    const date = normalizeDate(raw);
    if (date) dates.push(date);
    return ' ';
  });
  residue = residue.replace(SYMBOL_RE, (raw) => {
    symbols.push(raw);
    return ' ';
  });
  const add = (kind, raw, unit = null) => {
    const key = canonicalNumber(raw, unit);
    if (key != null) numbers.push(Object.freeze({ kind, raw: String(raw), unit, key }));
  };
  residue = residue.replace(MONEY_RE, (raw, sign, number, unit) => {
    add('money', combineSign(sign, number), unit ?? null);
    return ' ';
  });
  residue = residue.replace(YUAN_RE, (raw, number, unit) => {
    add('money', number, unit ?? null);
    return ' ';
  });
  residue = residue.replace(PCT_RE, (raw, number, unit) => {
    add('pct', number);
    return ' ';
  });
  residue = residue.replace(COUNT_RE, (raw, number) => {
    add('count', number);
    return ' ';
  });
  residue = residue.replace(SCALE_RE, (raw, number, unit) => {
    add('money', number, unit);
    return ' ';
  });
  for (const match of residue.matchAll(NUM_RE)) add('bare', match[0]);

  return Object.freeze({
    numbers: Object.freeze(numbers),
    dates: Object.freeze([...new Set(dates)]),
    symbols: Object.freeze([...new Set(symbols)]),
  });
}

function allowedNumberKeys(allowed) {
  const keys = new Set();
  for (const list of [allowed?.numbers, allowed?.counts, allowed?.displays]) {
    for (const item of Array.isArray(list) ? list : []) {
      const text = String(item ?? '');
      for (const match of text.matchAll(/([+-]?)¥?\s*([+-]?\d[\d,]*(?:\.\d+)?)\s*(万|亿)?/gu)) {
        const key = canonicalNumber(combineSign(match[1], match[2]), match[3]);
        if (key != null) keys.add(key);
      }
    }
  }
  return keys;
}

function normalizeQuestion(text) {
  return String(text ?? '').replace(/[\s，。！？、；：,.!?;:]/gu, '').toLowerCase();
}

function bigrams(text) {
  const chars = [...normalizeQuestion(text)];
  const out = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) out.add(chars[index] + chars[index + 1]);
  return out;
}

function overlapRatio(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hit = 0;
  for (const item of left) if (right.has(item)) hit += 1;
  return hit / Math.min(left.size, right.size);
}

function sentencesOf(text) {
  return String(text ?? '')
    .split(/[。！？!?；;\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function focusKeywords(expected) {
  const kind = expected?.answer_kind;
  const explicit = [
    ...(expected?.must_include_any ?? []),
    ...(expected?.must_include_groups ?? []).flatMap((group) => group),
  ];
  if (kind === 'refusal' || kind === 'withheld') {
    return [...new Set([...explicit, '不能', '无法', '不提供', '不发布', '只'])];
  }
  if (kind === 'clarify') {
    return [...new Set([...explicit, '请', '需要', '补充', '哪一笔', '日期', '代码', '具体'])];
  }
  if (kind === 'help') return [...new Set([...explicit, '帮助', '页面', '助手', '可以'])];
  if (kind === 'small_talk') return [...new Set([...explicit, '你好', '可以', '帮'])];
  return [...new Set(explicit)];
}

function jargonOf(text) {
  const value = String(text ?? '');
  return [...new Set([
    ...PROFESSIONAL_TERMS.filter((term) => value.includes(term)),
    ...termsInText(value),
  ])];
}

function rawMatches(text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return re.test(String(text ?? ''));
}

function violation(text, pattern) {
  const value = String(text ?? '');
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of value.matchAll(re)) {
    const prefix = value.slice(Math.max(0, match.index - 8), match.index);
    if (/[不未没非无勿]/u.test(prefix)) continue;
    return true;
  }
  return false;
}

function asPattern(item) {
  if (item instanceof RegExp) return item;
  return new RegExp(String(item), 'giu');
}

function countPattern(text, pattern) {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return [...String(text ?? '').matchAll(re)].length;
}

function dimension(score, reasons) {
  return Object.freeze({
    score: Math.max(0, Math.min(2, Math.round(score))),
    reasons: Object.freeze(reasons.filter(Boolean)),
  });
}

export function scoreReadability({
  question = '', answer = '', expected = {}, budget = {}, explainedTerms = [],
} = {}) {
  const parts = answerParts(answer);
  const structuredBody = [parts.headline, ...parts.plain.map((item) => item.text)].filter(Boolean).join(' ');
  const body = structuredBody !== '' ? structuredBody : parts.text;
  const boundaries = parts.boundaries;
  const full = [body, ...boundaries].filter(Boolean).join(' ');
  const sentences = sentencesOf(body || full);
  const firstSentence = sentences[0] ?? '';
  const lengths = sentences.map((item) => charLength(item));
  const avgSentence = lengths.length ? lengths.reduce((sum, item) => sum + item, 0) / lengths.length : 0;
  const maxSentence = lengths.length ? Math.max(...lengths) : 0;
  const facts = extractNumberFacts(full);
  const numberCount = facts.numbers.length;
  const bareCount = facts.numbers.filter((item) => item.kind === 'bare').length;
  const scaleUsed = facts.numbers.some((item) => item.kind === 'money' && (item.unit === '万' || item.unit === '亿'));
  const questionHasScale = /万|亿/u.test(String(question));
  const pctWithPoint = /百分点/u.test(full) && facts.numbers.some((item) => item.kind === 'pct');
  const normalizedQuestion = normalizeQuestion(question);
  const normalizedFirst = normalizeQuestion(firstSentence);
  const restates = normalizedQuestion.length >= 4 && normalizedFirst.includes(normalizedQuestion);
  const duplicateSentences = new Set(sentences.map((item) => normalizeQuestion(item))).size < sentences.length;
  const explained = new Set([
    ...(Array.isArray(explainedTerms) ? explainedTerms : []),
    ...parts.terms,
  ].filter(Boolean));
  const jargon = jargonOf(body).filter((term) => !String(question).includes(term) && !explained.has(term));
  const fillerHits = FILLER_PATTERNS.reduce((sum, pattern) => sum + (rawMatches(body, pattern) ? 1 : 0), 0);
  const processNarration = rawMatches(body, PROCESS_RE);
  const boundaryInBody = (String(body).match(BOUNDARY_RE) ?? []).length;
  const boundaryHits = (boundaries.length ? 1 : 0) + boundaryInBody;
  const causalHits = (String(body).match(/说明你|证明你/gu) ?? []).length;
  const connectors = (String(body).match(/并且|同时|另外|以及|而且|但是/gu) ?? []).length;
  const markdown = /```|(?:^|\n)\s*(?:[-*+]\s|#{1,6}\s)|\]\(|https?:\/\/|www\./iu.test(full);
  const maxChars = Number(budget.max_chars ?? 180);
  const maxNumbers = Number(budget.max_numbers ?? 3);
  const maxItems = Number(budget.max_items ?? 2);
  const maxJargon = Number(budget.max_jargon ?? 1);
  const maxBoundary = Number(budget.max_boundary_phrases ?? 1);
  const kind = expected.answer_kind ?? 'factual';
  const intent = expected.intent ?? null;
  const nonNumeric = ['refusal', 'clarify', 'withheld', 'help', 'small_talk'].includes(kind);

  /* —— 直答 —— */
  const focus = focusKeywords(expected);
  const focusInFirst = focus.some((item) => firstSentence.includes(item));
  const headlineFocus = Boolean(parts.headline)
    && (focus.some((item) => parts.headline.includes(item)) || extractNumberFacts(parts.headline).numbers.length > 0);
  const directFirst = headlineFocus ? parts.headline : firstSentence;
  const directFocus = focus.some((item) => directFirst.includes(item));
  const directNumber = extractNumberFacts(directFirst).numbers.length > 0;
  const directDecisive = /[是为差亏赚有无未不没]|¥|\d/u.test(directFirst);
  let directScore;
  if (nonNumeric) {
    directScore = directFocus ? 2 : (focus.some((item) => full.includes(item)) ? 1 : 0);
  } else if (directFocus && (directNumber || directDecisive)) {
    directScore = 2;
  } else if (directFocus || directNumber) {
    directScore = 1;
  } else {
    directScore = 0;
  }
  if (/以下|如下|几点|总结/u.test(directFirst) && !directFocus) directScore = Math.min(directScore, 0);
  const directReasons = directScore === 2 ? [] : [directScore === 1 ? '首句没有同时给出主题和结论' : '首句没有回答问题'];

  /* —— 简洁 —— */
  const chars = charLength(full);
  let conciseScore = chars > maxChars ? 0 : chars > maxChars * 0.8 ? 1 : 2;
  if (restates) conciseScore -= 1;
  if (duplicateSentences) conciseScore -= 1;
  if (!nonNumeric && chars > 0 && chars < 10) conciseScore = Math.min(conciseScore, 1);
  const conciseReasons = [];
  if (chars > maxChars) conciseReasons.push(`超过 ${maxChars} 字预算（实际 ${chars} 字）`);
  else if (chars > maxChars * 0.8) conciseReasons.push('接近字数上限，仍可再压缩');
  if (restates) conciseReasons.push('复述了问题');
  if (duplicateSentences) conciseReasons.push('有重复句子');

  /* —— 白话 —— */
  let plainScore = 2;
  const plainReasons = [];
  if (jargon.length > maxJargon) {
    plainScore = 0;
    plainReasons.push(`未解释术语过多：${jargon.slice(0, 4).join('、')}`);
  } else if (jargon.length > 0) {
    plainScore = 1;
    plainReasons.push(`未解释术语：${jargon.join('、')}`);
  }
  if (avgSentence > 55 || maxSentence > 80) plainScore = 0;
  else if (avgSentence > 40 || maxSentence > 60) plainScore = Math.min(plainScore, 1);
  if (avgSentence > 40) plainReasons.push(`句子偏长：平均 ${Math.round(avgSentence)} 字`);
  if (maxSentence > 60) plainReasons.push(`最长一句 ${maxSentence} 字`);
  if (markdown) {
    plainScore = 0;
    plainReasons.push('包含 Markdown 或链接');
  }

  /* —— 数字克制 —— */
  let numbersScore = 2;
  const numberReasons = [];
  if (numberCount > maxNumbers) {
    numbersScore = 0;
    numberReasons.push(`数字过多：${numberCount} 个，预算 ${maxNumbers} 个`);
  } else if (maxNumbers === 0 && numberCount > 0) {
    numbersScore = 0;
    numberReasons.push('该问题不应出现数字');
  }
  let formatIssues = bareCount > 0 ? 1 : 0;
  if (pctWithPoint) formatIssues += 1;
  if (scaleUsed && !questionHasScale) formatIssues += 1;
  if (formatIssues >= 2) numbersScore = 0;
  else if (formatIssues === 1) numbersScore = Math.min(numbersScore, 1);
  if (bareCount > 0) numberReasons.push('有数字没有单位');
  if (pctWithPoint) numberReasons.push('百分点与百分号混用');
  if (scaleUsed && !questionHasScale) numberReasons.push('使用了万/亿，需要用户自行换算');
  if (!nonNumeric && maxNumbers > 0 && numberCount === 0) {
    numberReasons.push('没有任何可核对数字');
  }

  /* —— 结构 —— */
  // 纯文本回答没有段落信息；短回答里的两三句不该按“段落过多”扣分。
  const items = parts.plain.length > 0 ? parts.plain.length : (chars > 120 ? sentences.length : 1);
  let structureScore = items === 0 ? 0 : 2;
  const structureReasons = [];
  if (items > maxItems) {
    structureScore = 0;
    structureReasons.push(`段落过多：${items} 段，预算 ${maxItems} 段`);
  } else if (items === maxItems + 1) {
    structureScore = Math.min(structureScore, 1);
    structureReasons.push('段落略多');
  }
  if (maxSentence > 100) {
    structureScore = Math.min(structureScore, 1);
    structureReasons.push('单段过长');
  }
  if (items === 1 && chars > 150) {
    structureScore = Math.min(structureScore, 1);
    structureReasons.push('结论和证据挤在一段');
  }
  if (connectors > 2) {
    structureScore = Math.min(structureScore, 1);
    structureReasons.push('一段里并列了太多意思');
  }

  /* —— 无空话 —— */
  let meaningfulScore = 2;
  const meaningfulReasons = [];
  if (processNarration) {
    meaningfulScore = 0;
    meaningfulReasons.push('包含过程叙述');
  }
  if (fillerHits >= 2) {
    meaningfulScore = 0;
    meaningfulReasons.push('套话或铺垫过多');
  } else if (fillerHits === 1) {
    meaningfulScore = Math.min(meaningfulScore, 1);
    meaningfulReasons.push('有一处套话或铺垫');
  }
  if (boundaryHits > maxBoundary + 1) meaningfulScore = 0;
  else if (boundaryHits > maxBoundary) meaningfulScore = Math.min(meaningfulScore, 1);
  if (boundaryHits > maxBoundary) meaningfulReasons.push('边界说明重复');
  if (causalHits >= 2) {
    meaningfulScore = 0;
    meaningfulReasons.push('反复做无证据的归因');
  } else if (causalHits === 1) {
    meaningfulScore = Math.min(meaningfulScore, 1);
    meaningfulReasons.push('有无证据的归因');
  }

  /* —— 可行动 —— */
  const actionRequired = ['clarify', 'withheld', 'refusal', 'setup', 'help'].includes(kind)
    || ['how_to_change', 'contract_setup', 'meta_trust'].includes(intent);
  let actionScore = 2;
  const actionReasons = [];
  if (actionRequired) {
    if (rawMatches(full, ACTION_RE)) actionScore = 2;
    else if (rawMatches(full, GENERIC_ACTION_RE)) {
      actionScore = 1;
      actionReasons.push('只给了泛泛提醒');
    } else {
      actionScore = 0;
      actionReasons.push('没有告诉用户下一步怎么办');
    }
  } else if (!/[。！？!?]$/u.test(full.trim()) && numberCount > 0) {
    actionScore = 1;
    actionReasons.push('结尾没有收束');
  }

  const dimensions = Object.freeze({
    direct: dimension(directScore, directReasons),
    concise: dimension(conciseScore, conciseReasons),
    plain: dimension(plainScore, plainReasons),
    numbers: dimension(numbersScore, numberReasons),
    structure: dimension(structureScore, structureReasons),
    meaningful: dimension(meaningfulScore, meaningfulReasons),
    action: dimension(actionScore, actionReasons),
  });
  const total = DIMENSION_IDS.reduce((sum, id) => sum + dimensions[id].score, 0);
  const pass = total >= QA_SCORE_PASS_TOTAL && DIMENSION_IDS.every((id) => dimensions[id].score >= 1);

  return Object.freeze({
    total,
    max: QA_SCORE_MAX_TOTAL,
    pass,
    dimensions,
    metrics: Object.freeze({
      chars,
      sentence_count: sentences.length,
      avg_sentence_chars: Math.round(avgSentence * 10) / 10,
      max_sentence_chars: maxSentence,
      number_count: numberCount,
      bare_number_count: bareCount,
      jargon: Object.freeze(jargon),
      restates_question: restates,
      filler_hits: fillerHits,
      boundary_hits: boundaryHits,
    }),
  });
}

function mentionCheck(text, expected) {
  const failures = [];
  for (const item of expected.must_include_all ?? []) {
    if (!text.includes(item)) failures.push(`缺少必要内容：${item}`);
  }
  const any = expected.must_include_any ?? [];
  if (any.length > 0 && !any.some((item) => text.includes(item))) {
    failures.push(`未命中问题焦点：${any.join(' / ')}`);
  }
  const groups = expected.must_include_groups ?? [];
  const minGroups = Number.isInteger(expected.min_groups) ? expected.min_groups : groups.length;
  if (groups.length > 0) {
    const hitGroups = groups.filter((group) => group.some((item) => text.includes(item))).length;
    if (hitGroups < minGroups) failures.push(`内容覆盖不足：命中 ${hitGroups}/${groups.length} 组，至少 ${minGroups} 组`);
  }
  return failures;
}

export function checkAccuracy({
  question = '', answer = '', expected = {}, budget = {}, allowed = null, claims = null,
} = {}) {
  const text = renderedAnswerText(answer);
  const checks = [];
  const failures = [];
  const unverified = [];
  const facts = extractNumberFacts(text);
  const maxNumbers = Number(budget.max_numbers ?? 3);

  if (maxNumbers === 0 && facts.numbers.length > 0) {
    failures.push(`该问题不应出现数字（实际 ${facts.numbers.length} 个）`);
  }

  if (allowed == null) {
    if (facts.numbers.length > 0) unverified.push('未提供允许数字集合，数字准确性无法自动核对');
  } else {
    const allowedKeys = allowedNumberKeys(allowed);
    const answerKeys = new Set(facts.numbers.map((item) => item.key));
    const extra = [...answerKeys].filter((key) => !allowedKeys.has(key));
    if (extra.length > 0) failures.push(`出现未提供的数字：${extra.slice(0, 6).join('、')}`);
    const allowedDates = new Set((allowed.dates ?? []).map(normalizeDate).filter(Boolean));
    const badDates = facts.dates.filter((item) => !allowedDates.has(item));
    if (badDates.length > 0) failures.push(`出现未提供的日期：${badDates.slice(0, 4).join('、')}`);
    const allowedSymbols = new Set((allowed.symbols ?? []).map(String));
    const badSymbols = facts.symbols.filter((item) => !allowedSymbols.has(item));
    if (badSymbols.length > 0) failures.push(`出现未提供的代码：${badSymbols.slice(0, 4).join('、')}`);
    checks.push({ id: 'numbers_sourced', ok: extra.length === 0 && badDates.length === 0 && badSymbols.length === 0 });
  }

  const mentions = mentionCheck(text, expected);
  failures.push(...mentions);
  checks.push({ id: 'question_focus', ok: mentions.length === 0 });

  for (const [pattern, code] of GLOBAL_FORBIDDEN) {
    if (violation(text, pattern)) failures.push(`越界表述：${code}`);
  }
  for (const item of expected.must_not_match ?? []) {
    if (violation(text, asPattern(item))) failures.push(`出现禁止内容：${String(item)}`);
  }
  checks.push({ id: 'boundaries', ok: !failures.some((item) => item.startsWith('越界') || item.startsWith('出现禁止')) });

  if (expected.demo === true) {
    if (!/示例|演示/u.test(text)) failures.push('示例账单未标注示例');
    if (/云端账单|云端数据/u.test(text)) failures.push('示例账单被说成云端');
  } else if (expected.demo === false) {
    if (/示例数据|示例账单|演示数据/u.test(text)) failures.push('云端账单被说成示例');
  }
  checks.push({ id: 'synthetic_source', ok: !failures.some((item) => item.includes('示例') || item.includes('云端')) });

  if (expected.requires_evidence === true) {
    if (!Array.isArray(claims) || claims.length === 0) {
      unverified.push('未提供 claims/证据绑定，准确性无法完整核对');
    } else {
      const numericClaims = claims.filter((claim) => extractNumberFacts(claim?.text).numbers.length > 0);
      if (numericClaims.length === 0 && facts.numbers.length > 0) {
        failures.push('数字结论没有对应 claim');
      }
      for (const claim of numericClaims) {
        if (!Array.isArray(claim.evidence_ids) || claim.evidence_ids.filter(Boolean).length === 0) {
          failures.push('数字 claim 没有绑定证据');
          break;
        }
      }
    }
    checks.push({ id: 'evidence_bound', ok: !failures.some((item) => item.includes('claim')) });
  }

  let status = 'pass';
  if (failures.length > 0) status = 'fail';
  else if (unverified.length > 0) status = 'unverified';

  return Object.freeze({
    status,
    ok: status === 'pass',
    failures: Object.freeze(failures),
    unverified: Object.freeze(unverified),
    checks: Object.freeze(checks),
    metrics: Object.freeze({
      numbers: facts.numbers.length,
      dates: facts.dates.length,
      symbols: facts.symbols.length,
    }),
  });
}

export function scoreCase({
  caseDef, answer, allowed = null, claims = null, explainedTerms = [], actualKind = null,
} = {}) {
  if (!caseDef || typeof caseDef !== 'object') throw new TypeError('caseDef 必须为对象');
  const expected = caseDef.expected ?? {};
  const kinds = expected.answer_kind_any ?? [expected.answer_kind ?? 'factual'];
  const kind = actualKind ?? expected.answer_kind ?? 'factual';
  const readability = scoreReadability({
    question: caseDef.question,
    answer,
    expected: { ...expected, answer_kind: kind },
    budget: caseDef.budget ?? {},
    explainedTerms,
  });
  const accuracy = checkAccuracy({
    question: caseDef.question,
    answer,
    expected,
    budget: caseDef.budget ?? {},
    allowed,
    claims,
  });
  const kindOk = kinds.includes(kind);
  const verdict = !kindOk || accuracy.status === 'fail' || !readability.pass
    ? 'fail'
    : accuracy.status === 'unverified' ? 'review' : 'pass';
  return Object.freeze({
    id: caseDef.id,
    question: caseDef.question,
    verdict,
    kind,
    kind_ok: kindOk,
    accuracy,
    readability,
    text: renderedAnswerText(answer),
    summary: Object.freeze([
      ...(kindOk ? [] : [`回答类型不符：${kind}`]),
      ...accuracy.failures,
      ...accuracy.unverified,
      ...(readability.pass ? [] : DIMENSION_IDS
        .filter((id) => readability.dimensions[id].score < 2)
        .flatMap((id) => readability.dimensions[id].reasons.map((reason) => `${id}: ${reason}`))),
    ]),
  });
}
