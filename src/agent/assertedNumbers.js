// 问题内断言数字：用户带着“我赚了 99%”这类数字提问时，先与本次已发布事实核对。
// 未命中的断言直接澄清，不复述错误数字；日期和股票代码只作定位，不当作收益断言。
import { collectAllowedValues, validateTextNumbers } from './qaNarrative.js';

const DATE_RE = /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/g;
const SYMBOL_RE = /(?<!\d)\d{6}(?!\d)/g;
const PCT_RE = /[+-]?\d[\d,]*(?:\.\d+)?\s*(?:个百分点|%|pp|个点)/gi;
const MONEY_RE = /[+-]?[¥￥][+-]?\d[\d,]*(?:\.\d+)?(?:\s*万)?|[+-]?\d[\d,]*(?:\.\d+)?\s*(?:万元|万|元|块)/g;
const CN_PCT_RE = /百分之\s*([零一二三四五六七八九十百点两\d.]+)/gu;
const CN_CHENG_RE = /([零一二三四五六七八九十百两]+)\s*成/gu;

const DIGITS = Object.freeze({
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
});

function chineseNumber(raw) {
  const text = String(raw).replace(/两/g, '二');
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  const [intText = '', decText = ''] = text.split('点');
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of intText) {
    if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
    } else if (ch === '十') {
      section += (number || 1) * 10;
      number = 0;
    } else if (Object.hasOwn(DIGITS, ch)) {
      number = DIGITS[ch];
    } else if (ch === '.') {
      return null;
    } else {
      return null;
    }
  }
  total += section + number;
  let value = total;
  if (decText) {
    const decimals = [...decText].map((ch) => (Object.hasOwn(DIGITS, ch) ? DIGITS[ch] : ch)).join('');
    if (!/^\d+$/u.test(decimals)) return null;
    value = Number(`${total}.${decimals}`);
  }
  return Number.isFinite(value) ? value : null;
}

function plainNumber(value) {
  return String(Number(value.toFixed(4)));
}

function moneyVariant(raw) {
  const text = String(raw).replace(/[¥￥,\s]/g, '').replace(/[元块]/g, '');
  const match = text.match(/^([+-]?)(\d+(?:\.\d+)?)(万)?$/u);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const scale = match[3] ? 10000 : 1;
  const value = sign * Number(match[2]) * scale;
  if (!Number.isFinite(value)) return null;
  return `¥${plainNumber(value)}`;
}

function pctVariant(raw) {
  const text = String(raw).replace(/\s+/g, '');
  if (/个点$/u.test(text)) return `${text.replace(/个点$/u, '')}%`;
  return text;
}

export function findAssertedNumbers(question) {
  const text = String(question ?? '');
  const residue = text.replace(DATE_RE, ' ').replace(SYMBOL_RE, ' ');
  const found = [];
  const seen = new Set();
  const push = (kind, raw, variants) => {
    const list = variants.filter(Boolean);
    if (!list.length) return;
    const key = list.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, raw, variants: list });
  };

  for (const match of residue.matchAll(CN_PCT_RE)) {
    const value = chineseNumber(match[1]);
    if (value !== null) push('pct', match[0], [`${plainNumber(value)}%`]);
    else push('pct', match[0], []);
  }
  for (const match of residue.matchAll(CN_CHENG_RE)) {
    const value = chineseNumber(match[1]);
    if (value !== null) push('pct', match[0], [`${plainNumber(value * 10)}%`]);
  }
  for (const match of residue.matchAll(PCT_RE)) {
    push('pct', match[0], [pctVariant(match[0])]);
  }
  for (const match of residue.matchAll(MONEY_RE)) {
    push('money', match[0], [moneyVariant(match[0])]);
  }
  return found;
}

const LOSS_CONTEXT_RE = /亏|少赚|下跌|跌了|回撤|负收益/u;
const CHECK_CONTEXT_RE = /上次|之前|以往|历史|曾经|已经|今年|去年|操作|赚了|亏了|赚过|亏过|收益|亏损|损耗|金额|确认|对吧|对吗|是不是/u;
// “希望仓位控制在五成以内”是计划，不是对已发生数字的断言；带计划/目标词时不核对。
const PREFERENCE_RE = /希望|想要|打算|计划|目标|控制在|不超过|以内|以下|仓位|准备|以后|今后|接下来/u;

export function shouldCheckAssertions(question) {
  const text = String(question ?? '');
  return CHECK_CONTEXT_RE.test(text) && !PREFERENCE_RE.test(text);
}

// “亏了 1.9%”通常不带负号；只在问题已说明亏损方向时补一个负号再核对，
// “赚了 1.9%”不会被补负号，方向相反仍然拦截。
function variantsWithDirection(variant, lossContext) {
  if (!lossContext || variant.startsWith('-') || variant.startsWith('¥-')) return [variant];
  if (/^\d+(?:\.\d+)?(?:%|个百分点|pp)$/u.test(variant)) return [variant, `-${variant}`];
  if (/^¥\d+(?:\.\d+)?$/u.test(variant)) return [variant, variant.replace('¥', '¥-')];
  return [variant];
}

export function checkAssertedNumbers(question, publishedParts = []) {
  if (!shouldCheckAssertions(question)) return { ok: true, asserted: [], unknown: [], skipped: true };
  const asserted = findAssertedNumbers(question);
  if (!asserted.length) return { ok: true, asserted, unknown: [] };
  const allowed = collectAllowedValues(Array.isArray(publishedParts) ? publishedParts : []);
  const lossContext = LOSS_CONTEXT_RE.test(String(question ?? ''));
  const unknown = asserted.filter((item) => !item.variants.some((variant) => (
    variantsWithDirection(variant, lossContext)
      .some((candidate) => validateTextNumbers(candidate, allowed).ok)
  )));
  return { ok: unknown.length === 0, asserted, unknown };
}
