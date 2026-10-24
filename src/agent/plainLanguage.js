// 白话三层：把本地事实草稿整理成 headline / plain / terms / boundaries。
// 边界：只重排已有句子与允许事实，不新增数字、不调用模型；模型改写失败时直接使用这里的结果。
import { splitSentences } from './answerComposer.js';
import { glossaryEntry, termsInText } from './glossary.js';

export const PLAIN_VERSION = 'plain-1';
export const HEADLINE_MIN_CHARS = 8;
export const HEADLINE_MAX_CHARS = 45;
export const PLAIN_ITEM_MIN_CHARS = 10;
export const PLAIN_ITEM_MAX_CHARS = 100;
export const PLAIN_TOTAL_MIN_CHARS = 40;
export const PLAIN_TOTAL_MAX_CHARS = 300;
export const PLAIN_MAX_ITEMS = 3;

const INTENT_TITLES = Object.freeze({
  loss_overview: '这份账单的择时结果',
  worst_trade: '最错的一笔',
  best_trade: '最顺的一笔',
  pattern_explain: '行为模式说明',
  similar_context: '同账单相似情境',
  cross_bill: '跨账单同类操作',
  what_if: '单笔反事实对照',
  meta_calc: '这些数字怎么算',
  meta_trust: '这些数字可信吗',
  profile: '操作画像',
  how_to_change: '可以怎么改',
  contract_status: '规则守约复盘',
});

const DEFAULT_BOUNDARIES = Object.freeze(['只使用当前账单已核对并发布的数字', '事后对照，不预测涨跌']);
const DEMO_BOUNDARIES = Object.freeze(['示例数据，不是真实账户', '事后对照，不预测涨跌']);

export function charLength(text) {
  return [...String(text ?? '')].length;
}

export function clipChars(text, max) {
  const value = String(text ?? '').trim();
  if (charLength(value) <= max) return value;
  return [...value].slice(0, max).join('').trim();
}

function fitsHeadline(text) {
  const length = charLength(text);
  return length >= HEADLINE_MIN_CHARS && length <= HEADLINE_MAX_CHARS;
}

export function fitHeadline(intent, detail = '') {
  const base = INTENT_TITLES[intent] ?? '本账单事实回答';
  const extra = String(detail ?? '').trim();
  let text = extra ? `${base}：${extra}` : base;
  text = clipChars(text, HEADLINE_MAX_CHARS);
  if (charLength(text) < HEADLINE_MIN_CHARS) text = clipChars(`${text} · 本账单`, HEADLINE_MAX_CHARS);
  if (charLength(text) < HEADLINE_MIN_CHARS) text = clipChars(`${text} · 已核对事实`, HEADLINE_MAX_CHARS);
  return text;
}

function plainItemsOf(text, facts) {
  const sentences = splitSentences(text)
    .map((sentence) => clipChars(sentence, PLAIN_ITEM_MAX_CHARS))
    .filter(Boolean)
    .slice(0, PLAIN_MAX_ITEMS);
  if (sentences.length) return sentences;

  const firstFact = Array.isArray(facts) ? facts.find((fact) => fact?.label && fact?.value != null) : null;
  if (firstFact) {
    return [clipChars(`${firstFact.label}：${firstFact.value}。`, PLAIN_ITEM_MAX_CHARS)];
  }
  return [];
}

export function buildPlainDraft({
  intent = null, text = '', facts = [], boundaries = [], demo = false,
} = {}) {
  const cleanFacts = (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact.label === 'string')
    .map((fact) => ({ label: fact.label, value: String(fact.value ?? '') }));
  const firstFact = cleanFacts.find((fact) => fact.value.trim() !== '');
  const headline = fitHeadline(intent, firstFact ? `${firstFact.label} ${firstFact.value}` : '');
  const sentences = plainItemsOf(text, cleanFacts);
  const plain = sentences.map((sentence, index) => ({ id: `P${index + 1}`, text: sentence }));
  const joined = [headline, ...sentences].join(' ');
  const terms = termsInText(joined)
    .map((term) => glossaryEntry(term))
    .filter(Boolean)
    .map((entry) => ({ term: entry.term, definition: entry.definition }));
  const totalChars = sentences.reduce((sum, sentence) => sum + charLength(sentence), 0);
  const cleanBoundaries = (Array.isArray(boundaries) ? boundaries : [])
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim());
  return {
    version: PLAIN_VERSION,
    headline: fitsHeadline(headline) ? headline : fitHeadline(intent),
    plain,
    terms,
    boundaries: cleanBoundaries.length
      ? cleanBoundaries
      : (demo ? [...DEMO_BOUNDARIES] : [...DEFAULT_BOUNDARIES]),
    meets_limits: sentences.length >= 1
      && totalChars >= PLAIN_TOTAL_MIN_CHARS
      && totalChars <= PLAIN_TOTAL_MAX_CHARS
      && sentences.every((sentence) => charLength(sentence) >= PLAIN_ITEM_MIN_CHARS),
  };
}
