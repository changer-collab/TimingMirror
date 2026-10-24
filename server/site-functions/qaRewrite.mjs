// rewrite-v2 服务端校验：请求投影 + 响应硬校验。
// 只接受已展示事实/草稿/claims/允许值；不记录模型原文，不回传模型正文。
import { collectAllowedValues, validateTextNumbers } from './qaNarrative.mjs';

export const QA_REWRITE_STAGE = 'qa_rewrite';
export const QA_REWRITE_PROTOCOL = 'rewrite-v2';

export const QA_REWRITE_CODES = Object.freeze({
  REQUEST_INVALID: 'E_QA_REWRITE_REQUEST_INVALID',
  RESPONSE: 'E_QA_REWRITE_RESPONSE_INVALID',
});

const HEADLINE_MIN = 8;
const HEADLINE_MAX = 45;
const PLAIN_MAX_ITEMS = 3;
const PLAIN_ITEM_MIN = 10;
const PLAIN_ITEM_MAX = 100;
const PLAIN_TOTAL_MIN = 40;
const PLAIN_TOTAL_MAX = 300;
const MAX_FACTS = 12;
const MAX_EVIDENCE = 12;
const MAX_CLAIMS = 12;
const MAX_GLOSSARY = 8;
const MAX_QUESTION = 200;
const MAX_NUMBERS = 40;
const MAX_COUNTS = 20;
const MAX_DATES = 20;
const MAX_SYMBOLS = 20;
const MAX_DISPLAYS = 40;

const REQUEST_KEYS = new Set([
  'question', 'intent', 'scope', 'draft', 'claims', 'facts', 'evidence', 'allowed', 'glossary', 'limits',
]);
const ALLOWED_KEYS = new Set(['numbers', 'counts', 'dates', 'symbols', 'displays']);
const LIMIT_KEYS = new Set([
  'headline_min_chars', 'headline_max_chars', 'plain_items', 'plain_item_min_chars',
  'plain_item_max_chars', 'plain_total_min_chars', 'plain_total_max_chars',
  'max_facts', 'max_evidence', 'max_claims', 'max_glossary', 'max_question_chars',
]);
const RESPONSE_KEYS = new Set(['headline', 'plain', 'used_terms']);
const PLAIN_KEYS = new Set(['text', 'claim_ids']);

const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const MARKDOWN_RE = /```|(?:^|\n)\s*(?:[-*+]\s|#{1,6}\s)|\]\(|https?:\/\/|www\./iu;
const FILE_RE = /\.(?:csv|xlsx?|pdf|json|mjs|js|txt)\b/iu;
const ADVICE_RE = /(?:建议|推荐|应该|可以|不妨|最好)\s*(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)/u;
const ADVICE_SUFFIX_RE = /(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)建议/u;
const PREDICTION_RE = /(?:预测|预计)(?:后市|未来|涨跌|股价|走势)|(?:会涨|会跌|必涨|必跌|目标价|稳赚|保证收益|保证盈利)/u;
const PERSONA_RE = /(?:人格|性格|你总是|你从不)/u;
const ENTITY_SUFFIX_RE = /(?:股份有限公司|有限公司|集团|证券|银行|药业|电器)/u;
const CLAIM_ID_RE = /^Q\d+$/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string'
  && value.trim().length > 0
  && [...value.trim()].length <= max
  && !CONTROL_RE.test(value);

function fail(message) {
  return { ok: false, code: QA_REWRITE_CODES.REQUEST_INVALID, message };
}

function responseFailure(field, message) {
  return { ok: false, code: QA_REWRITE_CODES.RESPONSE, field, message };
}

function uniqueStrings(values, { max, validate }) {
  if (!Array.isArray(values) || values.length > max) return null;
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || !validate(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function normalizeAllowed(raw, recomputed) {
  if (!isObject(raw)) return fail('allowed 必须为对象');
  if (Object.keys(raw).some((key) => !ALLOWED_KEYS.has(key))) return fail('allowed 包含不允许字段');
  const limits = {
    numbers: MAX_NUMBERS, counts: MAX_COUNTS, dates: MAX_DATES, symbols: MAX_SYMBOLS, displays: MAX_DISPLAYS,
  };
  const out = {};
  for (const key of ALLOWED_KEYS) {
    const list = uniqueStrings(raw[key], {
      max: limits[key],
      validate: (value) => value.length > 0 && [...value].length <= 64 && !CONTROL_RE.test(value),
    });
    if (!list) return fail(`allowed.${key} 非法`);
    const serverSet = new Set(recomputed[key] ?? []);
    if (list.some((value) => !serverSet.has(value))) return fail(`allowed.${key} 超出请求事实范围`);
    out[key] = list;
  }
  return { ok: true, allowed: out };
}

function cleanClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0 || claims.length > MAX_CLAIMS) return null;
  const out = [];
  const seen = new Set();
  for (const claim of claims) {
    if (!isObject(claim)) return null;
    if (Object.keys(claim).some((key) => !['id', 'text', 'evidence_ids'].includes(key))) return null;
    if (typeof claim.id !== 'string' || !CLAIM_ID_RE.test(claim.id) || seen.has(claim.id)) return null;
    if (!isText(claim.text, 240)) return null;
    if (!Array.isArray(claim.evidence_ids) || claim.evidence_ids.length > 8) return null;
    const evidenceIds = uniqueStrings(claim.evidence_ids, {
      max: 8,
      validate: (value) => value.length > 0 && [...value].length <= 32,
    });
    if (!evidenceIds) return null;
    seen.add(claim.id);
    out.push({ id: claim.id, text: claim.text.trim(), evidence_ids: evidenceIds });
  }
  return out;
}

function cleanDraft(draft) {
  if (!isObject(draft)) return null;
  if (!isText(draft.headline, HEADLINE_MAX)) return null;
  if (!Array.isArray(draft.plain) || draft.plain.length === 0 || draft.plain.length > PLAIN_MAX_ITEMS) return null;
  const plain = [];
  for (const item of draft.plain) {
    if (!isObject(item) || !isText(item.text, PLAIN_ITEM_MAX)) return null;
    plain.push({ id: String(item.id ?? '').slice(0, 8), text: item.text.trim() });
  }
  return { headline: draft.headline.trim(), plain };
}

function cleanFacts(facts) {
  if (!Array.isArray(facts) || facts.length === 0 || facts.length > MAX_FACTS) return null;
  const out = [];
  for (const fact of facts) {
    if (!isObject(fact) || !isText(fact.label, 80) || !isText(fact.value, 200)) return null;
    out.push({ label: fact.label.trim(), value: fact.value.trim() });
  }
  return out;
}

function cleanEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) return null;
  const out = [];
  for (const item of evidence) {
    if (!isObject(item) || !isText(item.label, 80) || !isText(item.detail, 320)) return null;
    out.push({ label: item.label.trim(), detail: item.detail.trim() });
  }
  return out;
}

function cleanGlossary(glossary) {
  if (!Array.isArray(glossary) || glossary.length > MAX_GLOSSARY) return null;
  const out = [];
  for (const item of glossary) {
    if (!isObject(item) || !isText(item.term, 20) || !isText(item.definition, 200)) return null;
    out.push({ term: item.term.trim(), definition: item.definition.trim() });
  }
  return out;
}

export function normalizeQaRewriteRequest(body) {
  if (!isObject(body)) return fail('请求体必须为对象');
  if (Object.keys(body).some((key) => !REQUEST_KEYS.has(key))) return fail('请求包含不允许字段');
  if (!isText(body.question, MAX_QUESTION)) return fail('question 非法');
  if (!isText(body.intent, 40)) return fail('intent 非法');
  if (!isObject(body.scope) || !isText(body.scope.kind, 24)) return fail('scope 非法');
  if (body.scope.synthetic !== undefined && typeof body.scope.synthetic !== 'boolean') return fail('scope.synthetic 非法');
  if (body.limits !== undefined) {
    if (!isObject(body.limits)) return fail('limits 非法');
    if (Object.keys(body.limits).some((key) => !LIMIT_KEYS.has(key))) return fail('limits 包含不允许字段');
  }
  const draft = cleanDraft(body.draft);
  if (!draft) return fail('draft 非法');
  const claims = cleanClaims(body.claims);
  if (!claims) return fail('claims 非法');
  const facts = cleanFacts(body.facts);
  if (!facts) return fail('facts 非法');
  const evidence = cleanEvidence(body.evidence);
  if (!evidence) return fail('evidence 非法');
  const glossary = cleanGlossary(body.glossary);
  if (!glossary) return fail('glossary 非法');

  const question = body.question.trim();
  const request = {
    question,
    intent: body.intent.trim(),
    scope: { kind: body.scope.kind.trim(), synthetic: body.scope.synthetic === true },
    draft,
    claims,
    facts,
    evidence,
    glossary,
  };
  // 允许值以服务端从已展示内容重算的集合为准；客户端清单只能更窄，不能更宽。
  const recomputed = collectAllowedValues([
    question,
    draft.headline,
    ...draft.plain.map((item) => item.text),
    ...claims.map((claim) => claim.text),
    ...facts.flatMap((fact) => [fact.label, fact.value]),
    ...evidence.flatMap((item) => [item.label, item.detail]),
    ...glossary.flatMap((item) => [item.term, item.definition]),
  ]);
  const checkedAllowed = normalizeAllowed(body.allowed, recomputed);
  if (!checkedAllowed.ok) return checkedAllowed;
  request.allowed = recomputed;
  return { ok: true, request };
}

function unknownEntity(text, source) {
  for (const clause of String(text).split(/[，。；、\s]+/u)) {
    if (!ENTITY_SUFFIX_RE.test(clause)) continue;
    if (!source.includes(clause)) return clause;
  }
  return null;
}

function checkForbidden(text, source) {
  if (CONTROL_RE.test(text)) return '包含换行或控制字符';
  if (MARKDOWN_RE.test(text)) return '包含 Markdown 或链接';
  if (FILE_RE.test(text)) return '包含文件名';
  if (ADVICE_RE.test(text) || ADVICE_SUFFIX_RE.test(text) || PREDICTION_RE.test(text) || PERSONA_RE.test(text)) {
    return '包含建议、预测或人格化表述';
  }
  if (unknownEntity(text, source)) return '包含未提供的实体';
  return null;
}

export function validateQaRewriteResponse(rawText, request) {
  if (typeof rawText !== 'string') return responseFailure('response', '响应不是字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return responseFailure('json', '响应不是合法 JSON');
  }
  if (!isObject(parsed)) return responseFailure('response', '响应必须为对象');
  if (Object.keys(parsed).length !== RESPONSE_KEYS.size
    || Object.keys(parsed).some((key) => !RESPONSE_KEYS.has(key))) {
    return responseFailure('response.keys', '响应字段不符合约定');
  }
  if (!isObject(request) || !isObject(request.allowed)) {
    return responseFailure('request.allowed', '缺少允许值清单');
  }
  const claimIds = new Set((request.claims ?? []).map((claim) => claim.id));
  const glossaryTerms = new Set((request.glossary ?? []).map((item) => item.term));
  const source = [
    request.question,
    ...(request.facts ?? []).flatMap((fact) => [fact.label, fact.value]),
    ...(request.evidence ?? []).flatMap((item) => [item.label, item.detail]),
    ...(request.draft?.plain ?? []).map((item) => item.text),
    ...(request.claims ?? []).map((claim) => claim.text),
  ].join('\n');

  const headline = typeof parsed.headline === 'string' ? parsed.headline.trim() : '';
  const headlineLength = [...headline].length;
  if (headlineLength < HEADLINE_MIN || headlineLength > HEADLINE_MAX) {
    return responseFailure('headline.length', 'headline 长度不符合约定');
  }
  const headlineIssue = checkForbidden(headline, source);
  if (headlineIssue) return responseFailure('headline', `headline ${headlineIssue}`);

  if (!Array.isArray(parsed.plain) || parsed.plain.length === 0 || parsed.plain.length > PLAIN_MAX_ITEMS) {
    return responseFailure('plain.length', 'plain 条数不符合约定');
  }
  const plain = [];
  let total = 0;
  for (const item of parsed.plain) {
    if (!isObject(item)) return responseFailure('plain.item', 'plain 项必须为对象');
    if (Object.keys(item).length !== PLAIN_KEYS.size || Object.keys(item).some((key) => !PLAIN_KEYS.has(key))) {
      return responseFailure('plain.keys', 'plain 项字段不符合约定');
    }
    if (typeof item.text !== 'string') return responseFailure('plain.text', 'plain 文本必须为字符串');
    const text = item.text.trim();
    const length = [...text].length;
    if (length < PLAIN_ITEM_MIN || length > PLAIN_ITEM_MAX) {
      return responseFailure('plain.text.length', 'plain 单条长度不符合约定');
    }
    const issue = checkForbidden(text, source);
    if (issue) return responseFailure('plain.text', `plain ${issue}`);
    if (!Array.isArray(item.claim_ids) || item.claim_ids.length === 0 || item.claim_ids.length > 3) {
      return responseFailure('plain.claim_ids', 'plain 缺少 claim_ids');
    }
    const ids = [];
    for (const id of item.claim_ids) {
      if (typeof id !== 'string' || !claimIds.has(id)) {
        return responseFailure('plain.claim_ids', 'claim_ids 不是本文 claim');
      }
      if (!ids.includes(id)) ids.push(id);
    }
    total += length;
    plain.push({ text, claim_ids: ids });
  }
  if (total < PLAIN_TOTAL_MIN || total > PLAIN_TOTAL_MAX) {
    return responseFailure('plain.total', 'plain 总长度不符合约定');
  }

  if (!Array.isArray(parsed.used_terms) || parsed.used_terms.length > MAX_GLOSSARY) {
    return responseFailure('used_terms', 'used_terms 非法');
  }
  const usedTerms = [];
  for (const term of parsed.used_terms) {
    if (typeof term !== 'string' || !glossaryTerms.has(term)) {
      return responseFailure('used_terms', 'used_terms 未在术语表中登记');
    }
    if (!usedTerms.includes(term)) usedTerms.push(term);
  }
  const rewritten = [headline, ...plain.map((item) => item.text)].join(' ');
  for (const term of glossaryTerms) {
    if (rewritten.includes(term) && !usedTerms.includes(term)) {
      return responseFailure('used_terms', '正文使用术语但未登记 used_terms');
    }
  }

  for (const text of [headline, ...plain.map((item) => item.text)]) {
    const checked = validateTextNumbers(text, request.allowed);
    if (!checked.ok) return responseFailure('text.numbers', checked.message);
  }
  return { ok: true, value: { headline, plain, used_terms: usedTerms } };
}
