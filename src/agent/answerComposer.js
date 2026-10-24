// 回答合成：把已算好的本地事实草稿拆成结论句与 claim，绑定证据 id。
// 边界：文字与数字都来自已有本地回答；不重算、不改写金额，也不调用模型。
export const COMPOSE_VERSION = 'compose-1';

export const COMPOSED_INTENTS = Object.freeze([
  'loss_overview', 'worst_trade', 'best_trade', 'pattern_explain', 'similar_context',
]);

const SENTENCE_RE = /[^。；]+[。；]?/gu;

export function splitSentences(text) {
  return String(text ?? '')
    .match(SENTENCE_RE)
    ?.map((item) => item.trim())
    .filter(Boolean)
    ?? [];
}

function numbersOf(text) {
  return new Set((String(text ?? '').match(/[+-]?\d[\d,]*(?:\.\d+)?/gu) ?? [])
    .map((item) => item.replace(/,/gu, '')));
}

function sentenceCoversFact(sentence, value) {
  if (sentence.includes(String(value))) return true;
  const wanted = numbersOf(value);
  if (wanted.size === 0) return false;
  const present = numbersOf(sentence);
  return [...wanted].every((item) => present.has(item));
}

function coversRecord(sentence, record) {
  return record?.trade_date && record?.symbol
    && sentence.includes(String(record.trade_date))
    && sentence.includes(String(record.symbol));
}

export function buildClaims({ text, facts = [], evidence = null } = {}) {
  const evidenceFacts = Array.isArray(evidence?.facts) ? evidence.facts : [];
  const evidenceRecords = Array.isArray(evidence?.records) ? evidence.records : [];
  return splitSentences(text).map((sentence, index) => {
    const ids = new Set();
    for (const record of evidenceRecords) {
      if (record?.id && coversRecord(sentence, record)) ids.add(record.id);
    }
    for (const fact of evidenceFacts) {
      if (fact?.value == null) continue;
      if (sentenceCoversFact(sentence, fact.value)) ids.add(fact.id);
    }
    for (const fact of facts) {
      if (fact?.value == null) continue;
      if (!sentenceCoversFact(sentence, fact.value)) continue;
      const match = evidenceFacts.find((item) => item.value === fact.value
        || (numbersOf(fact.value).size > 0 && sentenceCoversFact(sentence, item.value)));
      if (match) ids.add(match.id);
    }
    return {
      id: `Q${index + 1}`,
      text: sentence,
      evidence_ids: [...ids],
    };
  });
}

export function composeLocalAnswer({
  intent, local, evidence = null, gate = null,
} = {}) {
  const text = String(local?.text ?? '');
  const facts = Array.isArray(local?.facts) ? local.facts : [];
  const localEvidence = Array.isArray(local?.evidence) ? local.evidence : [];
  const claims = buildClaims({ text, facts, evidence });
  return {
    version: COMPOSE_VERSION,
    intent,
    status: 'local',
    text,
    facts,
    evidence: localEvidence,
    claims,
    evidence_bundle: evidence,
    boundaries: gate?.demo === true
      ? ['示例数据，不是真实账户', '事后对照，不预测涨跌']
      : ['只使用当前账单已核对并发布的数字', '事后对照，不预测涨跌'],
  };
}
