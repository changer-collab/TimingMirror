// 发布前复核：每条带事实的回答都要过 V1–V9，任一硬校验失败就整条不发布数字。
// 纯函数；只读已生成的回答、证据包与账单状态，不重算业务流程，也不调用模型。
import { collectAllowedValues, validateTextNumbers } from './qaNarrative.js';
import { termsInText } from './glossary.js';
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

export const VERIFIER_VERSION = 'verify-1';

export const VERIFY_CHECKS = Object.freeze({
  V1: 'publish_gate',
  V2: 'numbers_sourced',
  V3: 'claims_bound',
  V4: 'recompute',
  V5: 'boundaries',
  V6: 'synthetic_source',
  V7: 'terms_explained',
  V8: 'rewrite_fallback',
  V9: 'fields',
});

const PROHIBITED = Object.freeze([
  [/其他用户|别人的账单|他人的账单/u, 'CROSS_USER'],
  [/实时行情|实时数据|盘中/u, 'REALTIME'],
  [/概率|胜率|大概率|可能性/u, 'PROBABILITY'],
  [/形态相似|走势相似/u, 'MARKET_SHAPE'],
  [/63\s*[%％][^。]{0,24}22\s*[%％][^。]{0,24}15\s*[%％]/u, 'SPLIT_63_22_15'],
  [/63\s*[·/、]\s*22\s*[·/、]\s*15/u, 'SPLIT_63_22_15'],
]);
const CHINESE_COUNT_RE = /[一二三四五六七八九十百千万两]+(?:笔|次|条|类|份|个|天|日|行|股|手|元)/u;
// 本地草稿里的「第 N 行」是回源引用，不是数字结论；校验前先剥离。
const ROW_REF_RE = /第\s*\d+\s*行/gu;
// 「第一条/两个角度」这类序数、量词是行文，不是数据计数；比较数字前先剥离。
const ORDINAL_RE = /第[一二三四五六七八九十百千万两]+(?:条|笔|次|类|个|点|部分)/gu;
const IDIOM_COUNT_RE = /[一二三四五六七八九十两](?:条|点|些|部分|个角度|个方面)/gu;
const DATE_TOKEN_RE = /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?/gu;
const SYMBOL_TOKEN_RE = /(?<!\d)\d{6}(?!\d)/gu;
const NUM_TOKEN_RE = /[+-]?\d[\d,]*(?:\.\d+)?/gu;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const ERROR_CODE_RE = /\bE_[A-Z0-9_]+\b/u;
const FORMULA_RE = /^([+-]?\d+(?:\.\d+)?)\s*([+\-*/×÷])\s*([+-]?\d+(?:\.\d+)?)\s*=\s*([+-]?\d+(?:\.\d+)?)$/u;
const TOLERANCE = 0.011;

const isText = (value) => typeof value === 'string';

function pass(id) {
  return { id, ok: true, status: 'pass' };
}

function skip(id, reason = 'not_applicable') {
  return { id, ok: true, status: 'skipped', reason };
}

function fail(id, reason) {
  return { id, ok: false, status: 'fail', reason };
}

function modelTexts(envelope) {
  const rewrite = envelope?.rewrite;
  if (rewrite?.status !== 'ok') return [];
  return [rewrite.headline, ...(Array.isArray(rewrite.plain) ? rewrite.plain.map((item) => item.text) : [])]
    .filter(isText);
}

const SKIP_SCALAR_KEYS = new Set([
  'id', 'source_ref', 'formula_id', 'trade_id', 'candidate_id', 'contextId', 'context_id',
]);

function scalarTexts(value, depth = 0, out = []) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) scalarTexts(item, depth + 1, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SKIP_SCALAR_KEYS.has(key)) continue;
      scalarTexts(item, depth + 1, out);
    }
  }
  return out;
}

function allowedOf(envelope) {
  const facts = Array.isArray(envelope?.facts) ? envelope.facts : [];
  const evidence = Array.isArray(envelope?.evidence) ? envelope.evidence : [];
  const bundle = envelope?.evidence_bundle ?? null;
  const formulas = Array.isArray(bundle?.formulas) ? bundle.formulas : [];
  const saved = Array.isArray(envelope?.saved_facts) ? envelope.saved_facts : [];
  return collectAllowedValues([
    ...facts.flatMap((fact) => [String(fact.label ?? ''), String(fact.value ?? '')]),
    ...evidence.flatMap((item) => [String(item.label ?? ''), String(item.detail ?? '')]),
    ...formulas.map((item) => String(item.text ?? '')),
    ...saved.flatMap((fact) => [String(fact.label ?? ''), String(fact.value ?? '')]),
  ]);
}

// 本地模板里的数字可以来自记录/候选/覆盖等已展示证据；模型改写仍只按请求白名单复核。
function allowedLocalOf(envelope) {
  const bundle = envelope?.evidence_bundle ?? null;
  return collectAllowedValues([
    ...allowedParts(envelope),
    ...scalarTexts(bundle?.records),
    ...scalarTexts(bundle?.assumptions),
    ...scalarTexts(bundle?.boundaries),
    ...scalarTexts(bundle?.coverage),
    ...scalarTexts(bundle?.excluded),
    ...scalarTexts(bundle?.missing),
    ...scalarTexts(envelope?.candidate),
  ]);
}

function allowedParts(envelope) {
  const facts = Array.isArray(envelope?.facts) ? envelope.facts : [];
  const evidence = Array.isArray(envelope?.evidence) ? envelope.evidence : [];
  const formulas = Array.isArray(envelope?.evidence_bundle?.formulas) ? envelope.evidence_bundle.formulas : [];
  const saved = Array.isArray(envelope?.saved_facts) ? envelope.saved_facts : [];
  return [
    ...facts.flatMap((fact) => [String(fact.label ?? ''), String(fact.value ?? '')]),
    ...evidence.flatMap((item) => [String(item.label ?? ''), String(item.detail ?? '')]),
    ...formulas.map((item) => String(item.text ?? '')),
    ...saved.flatMap((fact) => [String(fact.label ?? ''), String(fact.value ?? '')]),
  ];
}

function numberKey(raw) {
  const text = String(raw ?? '')
    .replace(/[,，]/gu, '')
    .replace(/^\+/u, '')
    .replace(/[−－–]/gu, '-');
  // 11 / 11.00 视为同一个数值；只影响小数写法，不改变量级。
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return String(Number(text));
  return text;
}

function numbersIn(text) {
  return new Set((String(text ?? '').match(NUM_TOKEN_RE) ?? []).map(numberKey));
}

function normalizeDateToken(raw) {
  const parts = String(raw ?? '').match(/\d+/gu);
  if (!parts || parts.length < 3) return null;
  return `${parts[0]}-${String(Number(parts[1])).padStart(2, '0')}-${String(Number(parts[2])).padStart(2, '0')}`;
}

// 本地草稿由确定性模板生成：按「数值落在允许集合」复核，单位/计数只作同一数值的写法差异。
function validateLocalNumbers(text, allowed) {
  const dateSet = new Set(allowed?.dates ?? []);
  const symbolSet = new Set(allowed?.symbols ?? []);
  const numberSet = new Set((allowed?.numbers ?? []).map(numberKey));
  for (const item of [...(allowed?.counts ?? []), ...(allowed?.displays ?? [])]) {
    const match = String(item ?? '').match(NUM_TOKEN_RE);
    if (match) numberSet.add(numberKey(match[0]));
  }
  let residue = String(text).replace(new RegExp(ROW_REF_RE.source, 'gu'), ' ');
  let dateOk = true;
  residue = residue.replace(new RegExp(DATE_TOKEN_RE.source, 'gu'), (raw) => {
    const date = normalizeDateToken(raw);
    if (!date || !dateSet.has(date)) dateOk = false;
    return ' ';
  });
  if (!dateOk) return { ok: false };
  let symbolOk = true;
  residue = residue.replace(new RegExp(SYMBOL_TOKEN_RE.source, 'gu'), (raw) => {
    if (!symbolSet.has(raw)) symbolOk = false;
    return ' ';
  });
  if (!symbolOk) return { ok: false };
  for (const token of residue.match(NUM_TOKEN_RE) ?? []) {
    if (!numberSet.has(numberKey(token))) return { ok: false };
  }
  return { ok: true };
}

function checkNumbers(envelope) {
  const localText = String(envelope?.text ?? '').replace(new RegExp(CHINESE_COUNT_RE.source, 'gu'), '');
  if (localText.trim() && !validateLocalNumbers(localText, allowedLocalOf(envelope)).ok) {
    return { ok: false, reason: 'LOCAL_TEXT_NUMBERS' };
  }
  const allowed = allowedOf(envelope);
  for (const text of modelTexts(envelope)) {
    const prose = String(text)
      .replace(new RegExp(ORDINAL_RE.source, 'gu'), ' ')
      .replace(new RegExp(IDIOM_COUNT_RE.source, 'gu'), ' ');
    const checked = validateTextNumbers(prose, allowed);
    if (!checked.ok) return { ok: false, reason: 'MODEL_TEXT_NUMBERS' };
  }
  return { ok: true };
}

function numericTokens(text) {
  return NUM_TOKEN_RE.test(String(text ?? ''));
}

function coversFact(text, facts) {
  const present = numbersIn(text);
  if (present.size === 0) return false;
  return facts.some((fact) => {
    const wanted = numbersIn(fact?.value);
    return wanted.size > 0 && [...wanted].every((item) => present.has(item));
  });
}

function coversRecord(text, records) {
  return records.some((record) => record?.trade_date && record?.symbol
    && String(text).includes(String(record.trade_date))
    && String(text).includes(String(record.symbol)));
}

function bundleIds(bundle) {
  const ids = new Set();
  for (const fact of bundle?.facts ?? []) if (fact?.id) ids.add(String(fact.id));
  for (const record of bundle?.records ?? []) if (record?.id) ids.add(String(record.id));
  return ids;
}

function checkClaims(envelope) {
  const claims = Array.isArray(envelope?.claims) ? envelope.claims : [];
  if (claims.length === 0) return { ok: false, reason: 'CLAIMS_MISSING' };
  const bundle = envelope?.evidence_bundle ?? null;
  const bundleFacts = Array.isArray(bundle?.facts) ? bundle.facts : [];
  const bundleRecords = Array.isArray(bundle?.records) ? bundle.records : [];
  const validIds = bundleIds(bundle);
  const ids = new Set();
  for (const claim of claims) {
    if (!claim || !/^Q\d+$/u.test(String(claim.id ?? '')) || ids.has(claim.id)) {
      return { ok: false, reason: 'CLAIM_ID_INVALID' };
    }
    ids.add(claim.id);
    if (!isText(claim.text) || claim.text.trim() === '') return { ok: false, reason: 'CLAIM_TEXT_MISSING' };
    const evidenceIds = Array.isArray(claim.evidence_ids) ? claim.evidence_ids.filter(Boolean) : [];
    for (const id of evidenceIds) {
      if (validIds.size > 0 && !validIds.has(String(id))) return { ok: false, reason: 'CLAIM_UNKNOWN_RECORD' };
    }
    if (evidenceIds.length === 0 && numericTokens(claim.text)
      && (coversFact(claim.text, bundleFacts) || coversRecord(claim.text, bundleRecords))) {
      return { ok: false, reason: 'CLAIM_WITHOUT_RECORD' };
    }
  }
  const rewrite = envelope?.rewrite;
  if (rewrite?.status !== 'ok') return { ok: true };
  const plainIds = new Set((rewrite.plain ?? []).map((item) => item.id));
  const map = new Map();
  for (const entry of Array.isArray(rewrite.claim_map) ? rewrite.claim_map : []) {
    if (!entry || !ids.has(entry.claim_id)) return { ok: false, reason: 'CLAIM_MAP_UNKNOWN' };
    if (!Array.isArray(entry.plain_ids) || entry.plain_ids.length === 0) {
      return { ok: false, reason: 'CLAIM_MAP_EMPTY' };
    }
    map.set(entry.claim_id, new Set(entry.plain_ids));
  }
  for (const item of rewrite.plain ?? []) {
    const cited = Array.isArray(item.claim_ids) ? item.claim_ids : [];
    if (cited.length === 0) return { ok: false, reason: 'PLAIN_WITHOUT_CLAIM' };
    for (const id of cited) {
      if (!ids.has(id)) return { ok: false, reason: 'PLAIN_UNKNOWN_CLAIM' };
      if (!map.has(id) || !map.get(id).has(item.id) || !plainIds.has(item.id)) {
        return { ok: false, reason: 'CLAIM_MAP_MISMATCH' };
      }
    }
  }
  return { ok: true };
}

function canonicalFormula(text) {
  return String(text ?? '')
    .replace(/[¥￥,\s]/gu, '')
    .replace(/[−－–]/gu, '-')
    .replace(/[×xX]/gu, '*')
    .replace(/÷/gu, '/');
}

function computeFormula(text) {
  const match = canonicalFormula(text).match(FORMULA_RE);
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[3]);
  const stated = Number(match[4]);
  let value;
  switch (match[2]) {
    case '+': value = left + right; break;
    case '-': value = left - right; break;
    case '*': value = left * right; break;
    case '/': value = right === 0 ? null : left / right; break;
    default: value = null;
  }
  if (value == null || !Number.isFinite(value)) return { checked: false };
  return { checked: true, ok: Math.abs(value - stated) <= TOLERANCE };
}

function checkRecompute(envelope) {
  const formulas = Array.isArray(envelope?.evidence_bundle?.formulas) ? envelope.evidence_bundle.formulas : [];
  for (const formula of formulas) {
    const result = computeFormula(formula?.text);
    if (result?.checked && !result.ok) return { ok: false, reason: 'FORMULA_MISMATCH' };
  }
  return { ok: true };
}

function violates(text, pattern) {
  const value = String(text ?? '');
  for (const match of value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
    const prefix = value.slice(Math.max(0, match.index - 8), match.index);
    if (/[不未没非无勿]/u.test(prefix)) continue;
    return true;
  }
  return false;
}

function checkBoundaries(envelope) {
  const texts = [String(envelope?.text ?? ''), ...modelTexts(envelope)];
  for (const text of texts) {
    for (const [pattern, reason] of PROHIBITED) {
      if (violates(text, pattern)) return { ok: false, reason };
    }
  }
  return { ok: true };
}

function checkSynthetic(envelope, bill) {
  const demo = bill?.demo === true;
  const texts = [String(envelope?.text ?? ''), ...modelTexts(envelope)].join('\n');
  if (demo) {
    if (/云端账单|云端数据|实时行情|实时数据|盘中/u.test(texts)) return { ok: false, reason: 'DEMO_AS_CLOUD' };
    return { ok: true };
  }
  if (/示例数据|示例账单|演示数据/u.test(texts)) return { ok: false, reason: 'CLOUD_AS_DEMO' };
  return { ok: true };
}

function checkTerms(envelope) {
  const rewrite = envelope?.rewrite;
  const texts = modelTexts(envelope);
  if (texts.length === 0) return { ok: true };
  const explained = new Set((Array.isArray(rewrite?.terms) ? rewrite.terms : []).map((item) => item?.term));
  for (const text of texts) {
    for (const term of termsInText(text)) {
      if (!explained.has(term)) return { ok: false, reason: 'TERM_NOT_EXPLAINED' };
    }
  }
  return { ok: true };
}

function checkFallback(envelope) {
  const rewrite = envelope?.rewrite;
  const meta = envelope?.rewrite_meta;
  if (rewrite?.status === 'ok') return { ok: true };
  if (!rewrite) return { ok: false, reason: 'REWRITE_MISSING' };
  if (rewrite.source !== 'local') return { ok: false, reason: 'FALLBACK_NOT_LOCAL' };
  if (meta?.status !== 'local_fallback') return { ok: false, reason: 'FALLBACK_META_MISSING' };
  if ((rewrite.plain ?? []).some((item) => Array.isArray(item.claim_ids) && item.claim_ids.length > 0)) {
    return { ok: false, reason: 'FALLBACK_HAS_CLAIMS' };
  }
  return { ok: true };
}

function checkFields(envelope) {
  if (!isText(envelope?.text)) return { ok: false, reason: 'TEXT_MISSING' };
  const visible = [envelope.text, ...modelTexts(envelope)];
  for (const text of visible) {
    if (UUID_RE.test(text) || ERROR_CODE_RE.test(text)) return { ok: false, reason: 'INTERNAL_ID_VISIBLE' };
  }
  const rewrite = envelope?.rewrite;
  if (rewrite?.status !== 'ok') return { ok: true };
  const headlineLength = charLength(rewrite.headline);
  if (headlineLength < HEADLINE_MIN_CHARS || headlineLength > HEADLINE_MAX_CHARS) {
    return { ok: false, reason: 'HEADLINE_LENGTH' };
  }
  if (!Array.isArray(rewrite.plain) || rewrite.plain.length < 1 || rewrite.plain.length > PLAIN_MAX_ITEMS) {
    return { ok: false, reason: 'PLAIN_COUNT' };
  }
  let total = 0;
  for (const item of rewrite.plain) {
    const length = charLength(item?.text);
    if (length < PLAIN_ITEM_MIN_CHARS || length > PLAIN_ITEM_MAX_CHARS) return { ok: false, reason: 'PLAIN_LENGTH' };
    total += length;
  }
  if (total < PLAIN_TOTAL_MIN_CHARS || total > PLAIN_TOTAL_MAX_CHARS) {
    return { ok: false, reason: 'PLAIN_TOTAL' };
  }
  if (!Array.isArray(rewrite.terms)) return { ok: false, reason: 'TERMS_MISSING' };
  return { ok: true };
}

export function withholdEnvelope(envelope, reasons = []) {
  const actions = Array.isArray(envelope?.actions) ? envelope.actions.slice(0, 2) : [];
  return {
    ...envelope,
    status: 'withheld',
    text: '这次回答没有通过发布前复核，因此不展示具体数字。你可以重试，或打开报告页逐项核对证据。',
    facts: [],
    evidence: [],
    claims: [],
    narrative_policy: 'none',
    rewrite: null,
    rewrite_meta: { status: 'withheld', model_called: false, cached: false, reason: 'verification_failed' },
    actions,
    notice: '数字复核未通过，本次不发布具体结果',
    verification: { status: 'withheld', failed_checks: reasons.slice(0, 9) },
  };
}

export function verifyAnswer({ envelope = null, scope = { kind: 'bill' }, bill = null } = {}) {
  if (!envelope || envelope.status !== 'local') {
    return { ok: true, status: 'skipped', checks: [], reasons: [], envelope };
  }
  if (scope?.kind !== 'bill' && scope?.kind !== 'demo_group') {
    return { ok: true, status: 'skipped', checks: [], reasons: [], envelope };
  }
  const facts = Array.isArray(envelope.facts) ? envelope.facts : [];
  const auto = envelope.narrative_policy === 'auto';
  const checks = [];

  // V1 发布门槛：示例账单放行；其余必须来自已确认账单，且至少一条事实。
  const gated = (bill?.demo === true || bill?.status === 'confirmed') && facts.length > 0;
  checks.push(gated ? pass(VERIFY_CHECKS.V1) : fail(VERIFY_CHECKS.V1, bill?.demo === true || bill?.status === 'confirmed' ? 'NO_FACTS' : 'BILL_NOT_PUBLISHED'));

  const numbers = checkNumbers(envelope);
  checks.push(numbers.ok ? pass(VERIFY_CHECKS.V2) : fail(VERIFY_CHECKS.V2, numbers.reason));

  const recompute = checkRecompute(envelope);
  checks.push(recompute.ok ? pass(VERIFY_CHECKS.V4) : fail(VERIFY_CHECKS.V4, recompute.reason));

  const boundaries = checkBoundaries(envelope);
  checks.push(boundaries.ok ? pass(VERIFY_CHECKS.V5) : fail(VERIFY_CHECKS.V5, boundaries.reason));

  const synthetic = checkSynthetic(envelope, bill);
  checks.push(synthetic.ok ? pass(VERIFY_CHECKS.V6) : fail(VERIFY_CHECKS.V6, synthetic.reason));

  const terms = checkTerms(envelope);
  checks.push(terms.ok ? pass(VERIFY_CHECKS.V7) : fail(VERIFY_CHECKS.V7, terms.reason));

  const fields = checkFields(envelope);
  checks.push(fields.ok ? pass(VERIFY_CHECKS.V9) : fail(VERIFY_CHECKS.V9, fields.reason));

  if (auto) {
    const claims = checkClaims(envelope);
    checks.push(claims.ok ? pass(VERIFY_CHECKS.V3) : fail(VERIFY_CHECKS.V3, claims.reason));
    const fallback = checkFallback(envelope);
    checks.push(fallback.ok ? pass(VERIFY_CHECKS.V8) : fail(VERIFY_CHECKS.V8, fallback.reason));
  } else {
    checks.push(skip(VERIFY_CHECKS.V3));
    checks.push(skip(VERIFY_CHECKS.V8));
  }

  // 固定按 V1–V9 编号输出，便于测试与 Trace 对照。
  const order = Object.values(VERIFY_CHECKS);
  checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  const reasons = checks.filter((item) => item.ok === false).map((item) => `${item.id}:${item.reason}`);
  if (reasons.length === 0) return { ok: true, status: 'pass', checks, reasons, envelope };
  return {
    ok: false,
    status: 'withheld',
    checks,
    reasons,
    envelope: withholdEnvelope(envelope, reasons),
  };
}
