// rewrite-v2（浏览器端）：把本地事实草稿交给模型讲人话。
// 只发送已展示事实、草稿、claims 与允许值；响应必须逐句绑定 claim，数字/单位/实体/术语全部本地复核。
import { collectAllowedValues, validateTextNumbers } from './qaNarrative.js';
import {
  HEADLINE_MAX_CHARS,
  HEADLINE_MIN_CHARS,
  PLAIN_ITEM_MAX_CHARS,
  PLAIN_ITEM_MIN_CHARS,
  PLAIN_MAX_ITEMS,
  PLAIN_TOTAL_MAX_CHARS,
  PLAIN_TOTAL_MIN_CHARS,
  charLength,
} from './plainLanguage.js';

export const QA_REWRITE_STAGE = 'qa_rewrite';
export const QA_REWRITE_VERSION = 'rewrite-v2';

export const QA_REWRITE_LIMITS = Object.freeze({
  headline_min_chars: HEADLINE_MIN_CHARS,
  headline_max_chars: HEADLINE_MAX_CHARS,
  plain_items: PLAIN_MAX_ITEMS,
  plain_item_min_chars: PLAIN_ITEM_MIN_CHARS,
  plain_item_max_chars: PLAIN_ITEM_MAX_CHARS,
  plain_total_min_chars: PLAIN_TOTAL_MIN_CHARS,
  plain_total_max_chars: PLAIN_TOTAL_MAX_CHARS,
  max_facts: 12,
  max_evidence: 12,
  max_claims: 12,
  max_glossary: 8,
  max_question_chars: 200,
});

export const QA_REWRITE_CODES = Object.freeze({
  UNAVAILABLE: 'E_QA_REWRITE_UNAVAILABLE',
  REQUEST: 'E_QA_REWRITE_REQUEST',
  RESPONSE: 'E_QA_REWRITE_RESPONSE',
  CHECK: 'E_QA_REWRITE_CHECK',
  TRANSPORT: 'E_QA_REWRITE_TRANSPORT',
});

const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const MARKDOWN_RE = /```|(?:^|\n)\s*(?:[-*+]\s|#{1,6}\s)|\]\(|https?:\/\/|www\./iu;
const FILE_RE = /\.(?:csv|xlsx?|pdf|json|mjs|js|txt)\b/iu;
const ADVICE_RE = /(?:建议|推荐|应该|可以|不妨|最好)\s*(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)/u;
const ADVICE_SUFFIX_RE = /(?:买入|卖出|加仓|减仓|止损|止盈|抄底|逃顶)建议/u;
const PREDICTION_RE = /(?:预测|预计)(?:后市|未来|涨跌|股价|走势)|(?:会涨|会跌|必涨|必跌|目标价|稳赚|保证收益|保证盈利)/u;
const PERSONA_RE = /(?:人格|性格|你总是|你从不)/u;
const ENTITY_SUFFIX_RE = /(?:股份有限公司|有限公司|集团|证券|银行|药业|电器)/u;

const REQUEST_KEYS = new Set([
  'question', 'intent', 'scope', 'draft', 'claims', 'facts', 'evidence', 'allowed', 'glossary', 'limits',
]);
const RESPONSE_KEYS = new Set(['headline', 'plain', 'used_terms']);
const PLAIN_KEYS = new Set(['text', 'claim_ids']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string'
  && value.trim().length > 0
  && charLength(value.trim()) <= max
  && !CONTROL_RE.test(value);

function requestFail(message) {
  return { ok: false, code: QA_REWRITE_CODES.REQUEST, message };
}

function responseFail(message, extra = {}) {
  return { ok: false, code: QA_REWRITE_CODES.RESPONSE, message, ...extra };
}

function cleanFacts(facts) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => fact && typeof fact.label === 'string' && fact.value != null
      && String(fact.label).trim() !== '' && String(fact.value).trim() !== '')
    .slice(0, QA_REWRITE_LIMITS.max_facts)
    .map((fact) => ({
      label: String(fact.label).trim().slice(0, 80),
      value: String(fact.value).trim().slice(0, 200),
    }));
}

function cleanEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : [])
    .filter((item) => item && typeof item.label === 'string' && typeof item.detail === 'string')
    .slice(0, QA_REWRITE_LIMITS.max_evidence)
    .map((item) => ({
      label: item.label.trim().slice(0, 80),
      detail: item.detail.trim().slice(0, 320),
    }));
}

function cleanClaims(claims) {
  const list = Array.isArray(claims) ? claims : [];
  if (list.length === 0 || list.length > QA_REWRITE_LIMITS.max_claims) return null;
  const out = [];
  const seen = new Set();
  for (const claim of list) {
    if (!isObject(claim)) return null;
    const id = typeof claim.id === 'string' ? claim.id.trim() : '';
    if (!/^Q\d+$/u.test(id) || seen.has(id)) return null;
    if (typeof claim.text !== 'string' || claim.text.trim() === ''
      || charLength(claim.text) > 240 || CONTROL_RE.test(claim.text)) return null;
    seen.add(id);
    out.push({
      id,
      text: claim.text.trim(),
      evidence_ids: (Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [])
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim())
        .slice(0, 8),
    });
  }
  return out;
}

function cleanGlossary(glossary) {
  return (Array.isArray(glossary) ? glossary : [])
    .filter((item) => item && typeof item.term === 'string' && typeof item.definition === 'string')
    .slice(0, QA_REWRITE_LIMITS.max_glossary)
    .map((item) => ({
      term: item.term.trim().slice(0, 20),
      definition: item.definition.trim().slice(0, 200),
    }))
    .filter((item) => item.term && item.definition);
}

function cleanDraft(draft) {
  if (!isObject(draft)) return null;
  const headline = typeof draft.headline === 'string' ? draft.headline.trim() : '';
  if (!headline || charLength(headline) > HEADLINE_MAX_CHARS || CONTROL_RE.test(headline)) return null;
  const plain = (Array.isArray(draft.plain) ? draft.plain : [])
    .filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
    .slice(0, PLAIN_MAX_ITEMS)
    .map((item) => ({ id: String(item.id ?? ''), text: item.text.trim().slice(0, PLAIN_ITEM_MAX_CHARS) }));
  if (!plain.length || plain.some((item) => CONTROL_RE.test(item.text))) return null;
  return { headline, plain };
}

export function buildRewriteRequest({
  question = '', intent = '', scope = { kind: 'bill' }, draft = null,
  claims = [], facts = [], evidence = [], glossary = [],
} = {}) {
  const normalizedQuestion = String(question ?? '').replace(/\s+/g, ' ').trim()
    .slice(0, QA_REWRITE_LIMITS.max_question_chars);
  if (!normalizedQuestion) return requestFail('问题为空');
  if (typeof intent !== 'string' || intent.trim() === '' || charLength(intent) > 40) {
    return requestFail('意图非法');
  }
  if (!isObject(scope) || typeof scope.kind !== 'string' || scope.kind.trim() === '') {
    return requestFail('范围非法');
  }
  const cleanDraftValue = cleanDraft(draft);
  if (!cleanDraftValue) return requestFail('本地草稿非法');
  const cleanClaimList = cleanClaims(claims);
  if (!cleanClaimList) return requestFail('claim 列表非法');
  const cleanFactList = cleanFacts(facts);
  if (!cleanFactList.length) return requestFail('没有可改写的已核对事实');
  const cleanEvidenceList = cleanEvidence(evidence);
  const cleanGlossaryList = cleanGlossary(glossary);

  const allowed = collectAllowedValues([
    normalizedQuestion,
    cleanDraftValue.headline,
    ...cleanDraftValue.plain.map((item) => item.text),
    ...cleanClaimList.flatMap((claim) => [claim.text]),
    ...cleanFactList.flatMap((fact) => [fact.label, fact.value]),
    ...cleanEvidenceList.flatMap((item) => [item.label, item.detail]),
    ...cleanGlossaryList.flatMap((item) => [item.term, item.definition]),
  ]);

  return {
    ok: true,
    request: {
      question: normalizedQuestion,
      intent: intent.trim(),
      scope: {
        kind: scope.kind.trim(),
        synthetic: scope.synthetic === true,
      },
      draft: cleanDraftValue,
      claims: cleanClaimList,
      facts: cleanFactList,
      evidence: cleanEvidenceList,
      allowed,
      glossary: cleanGlossaryList,
      limits: { ...QA_REWRITE_LIMITS },
    },
  };
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
  const entity = unknownEntity(text, source);
  if (entity) return '包含未提供的实体';
  return null;
}

export function validateRewriteResponse(rawText, request) {
  if (typeof rawText !== 'string') return responseFail('响应不是字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return responseFail('响应不是合法 JSON');
  }
  if (!isObject(parsed)) return responseFail('响应必须为对象');
  if (Object.keys(parsed).length !== RESPONSE_KEYS.size
    || Object.keys(parsed).some((key) => !RESPONSE_KEYS.has(key))) {
    return responseFail('响应字段不符合约定');
  }
  const allowed = request?.allowed;
  const claimIds = new Set((request?.claims ?? []).map((claim) => claim.id));
  const glossaryTerms = new Set((request?.glossary ?? []).map((item) => item.term));
  const source = [request?.question ?? '', ...(request?.facts ?? []).flatMap((fact) => [fact.label, fact.value]),
    ...(request?.evidence ?? []).flatMap((item) => [item.label, item.detail]),
    ...(request?.draft?.plain ?? []).map((item) => item.text),
    ...(request?.claims ?? []).map((claim) => claim.text)].join('\n');

  const headline = typeof parsed.headline === 'string' ? parsed.headline.trim() : '';
  const headlineLength = charLength(headline);
  if (headlineLength < HEADLINE_MIN_CHARS || headlineLength > HEADLINE_MAX_CHARS) {
    return responseFail('headline 长度不符合约定');
  }
  const headlineIssue = checkForbidden(headline, source);
  if (headlineIssue) return responseFail(`headline ${headlineIssue}`);

  if (!Array.isArray(parsed.plain) || parsed.plain.length < 1 || parsed.plain.length > PLAIN_MAX_ITEMS) {
    return responseFail('plain 条数不符合约定');
  }
  const plain = [];
  let totalChars = 0;
  for (const item of parsed.plain) {
    if (!isObject(item)) return responseFail('plain 项必须为对象');
    if (Object.keys(item).length !== PLAIN_KEYS.size || Object.keys(item).some((key) => !PLAIN_KEYS.has(key))) {
      return responseFail('plain 项字段不符合约定');
    }
    if (typeof item.text !== 'string') return responseFail('plain 文本必须为字符串');
    const text = item.text.trim();
    const length = charLength(text);
    if (length < PLAIN_ITEM_MIN_CHARS || length > PLAIN_ITEM_MAX_CHARS) {
      return responseFail('plain 单条长度不符合约定');
    }
    const issue = checkForbidden(text, source);
    if (issue) return responseFail(`plain ${issue}`);
    if (!Array.isArray(item.claim_ids) || item.claim_ids.length === 0 || item.claim_ids.length > 3) {
      return responseFail('plain 缺少 claim_ids');
    }
    const ids = [];
    for (const id of item.claim_ids) {
      if (typeof id !== 'string' || !claimIds.has(id)) return responseFail('claim_ids 不是本文 claim');
      if (!ids.includes(id)) ids.push(id);
    }
    totalChars += length;
    plain.push({ text, claim_ids: ids });
  }
  if (totalChars < PLAIN_TOTAL_MIN_CHARS || totalChars > PLAIN_TOTAL_MAX_CHARS) {
    return responseFail('plain 总长度不符合约定');
  }

  if (!Array.isArray(parsed.used_terms) || parsed.used_terms.length > QA_REWRITE_LIMITS.max_glossary) {
    return responseFail('used_terms 非法');
  }
  const usedTerms = [];
  for (const term of parsed.used_terms) {
    if (typeof term !== 'string' || !glossaryTerms.has(term)) return responseFail('used_terms 未在术语表中登记');
    if (!usedTerms.includes(term)) usedTerms.push(term);
  }
  const rewrittenText = [headline, ...plain.map((item) => item.text)].join(' ');
  for (const term of glossaryTerms) {
    if (rewrittenText.includes(term) && !usedTerms.includes(term)) {
      return responseFail('正文使用术语但未登记 used_terms');
    }
  }

  if (!allowed || typeof allowed !== 'object') return responseFail('缺少允许值清单');
  for (const text of [headline, ...plain.map((item) => item.text)]) {
    const checked = validateTextNumbers(text, allowed);
    if (!checked.ok) return responseFail(checked.message);
  }
  return { ok: true, value: { headline, plain, used_terms: usedTerms } };
}

function failure(code, message) {
  return { ok: false, code, message: message ?? 'AI 改写未完成' };
}

export function createQaRewrite({ transport = null } = {}) {
  async function rewrite(request, { signal } = {}) {
    if (typeof transport?.qaRewrite !== 'function') return failure(QA_REWRITE_CODES.UNAVAILABLE);
    let result;
    try {
      result = await transport.qaRewrite(request, { signal });
    } catch {
      return failure(signal?.aborted ? QA_REWRITE_CODES.TRANSPORT : QA_REWRITE_CODES.TRANSPORT);
    }
    if (!result || typeof result.rawText !== 'string') return failure(QA_REWRITE_CODES.RESPONSE);
    const checked = validateRewriteResponse(result.rawText, request);
    if (!checked.ok) return failure(QA_REWRITE_CODES.CHECK, checked.message);
    return { ok: true, value: checked.value };
  }

  return Object.freeze({ rewrite });
}
