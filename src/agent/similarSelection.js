// 同账单相似情境的纯选择：按问题点名的模式/标的匹配，其次取样本最多的成立模式。
// 边界：只读行为清单；不做跨账单检索、不做行情形态相似度、不计算概率。
export const SIMILAR_PATTERN_HINTS = Object.freeze([
  { pattern_id: 'sell_rebuy_within_2d', test: /(买回|又买|接回|卖[了出].{0,12}买)/u },
  { pattern_id: 'quick_flip', test: /(快进快出|拿不住|拿不久|拿不牢|短线|刚买.{0,8}卖|买[了入].{0,8}(就|很快|马上|立刻).{0,4}卖|一买就卖)/u },
  { pattern_id: 'overtrading', test: /(频繁|交易.{0,4}多|买卖.{0,4}多|来回|进出|手痒|管不住手|操作.{0,4}多)/u },
  { pattern_id: 'chase_high_buy', test: /(追高|追涨|买在.{0,4}高|高点买|高位买|追着买)/u },
]);

export function findPatternById(patterns, patternId) {
  return (Array.isArray(patterns) ? patterns : []).find((p) => p?.pattern_id === patternId) ?? null;
}

export function selectSimilarPattern({ patterns = [], question = '' } = {}) {
  const textQuestion = String(question ?? '');
  const symbolMatch = textQuestion.match(/(?:^|[^\d])(\d{6})(?!\d)/u);
  const symbol = symbolMatch ? symbolMatch[1] : null;
  const hint = SIMILAR_PATTERN_HINTS.find((item) => item.test.test(textQuestion)) ?? null;
  const list = Array.isArray(patterns) ? patterns : [];
  const withEvidence = list.filter((p) => Array.isArray(p.evidence) && p.evidence.length > 0);
  const established = withEvidence.filter((p) => p?.status === '成立');
  const focus = (hint ? findPatternById(list, hint.pattern_id) : null)
    ?? [...established].sort((a, b) => (b.sample_n ?? 0) - (a.sample_n ?? 0))[0]
    ?? [...withEvidence].sort((a, b) => (b.sample_n ?? 0) - (a.sample_n ?? 0))[0]
    ?? null;
  return { symbol, hint, withEvidence, established, focus };
}

export function similarEvidenceOf({ focus, symbol = null } = {}) {
  const all = Array.isArray(focus?.evidence) ? focus.evidence : [];
  return symbol ? all.filter((e) => e?.symbol === symbol) : all;
}
