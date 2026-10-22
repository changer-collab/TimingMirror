// 报告页行为分析编排：发送脱敏事实 → 校验站点返回 → 缓存成功结果。
// 边界：不信任 AI 文本；服务端返回的模式三态/样本数/证据必须与本地行为发现一致，否则整条结果作废。
// AI 只补充短评论与观察项；规则候选始终使用本地已复核的候选，不在前端凭 AI 文本生成规则。
export const BEHAVIOR_ANALYSIS_URL = '/functions/v1/app/api/llm/behavior-analysis';
export const BEHAVIOR_ANALYSIS_PROTOCOL = 'behavior-analysis-v1';

export const BEHAVIOR_ANALYSIS_SOURCES = Object.freeze(['ai', 'backend_rules']);
export const BEHAVIOR_OBSERVATION_IDS = Object.freeze(['sell_rebuy_within_2d', 'overtrading']);
export const BEHAVIOR_CANDIDATE = Object.freeze({
  candidate_id: 'rc:no_buy_on_surge:chase_high_buy',
  template_id: 'no_buy_on_surge',
});

export const BEHAVIOR_OBSERVATION_LABELS = Object.freeze({
  sell_rebuy_within_2d: '卖出后两个交易日内又买回',
  overtrading: '交易频率偏高',
});

export const BEHAVIOR_FALLBACK_LABELS = Object.freeze({
  model_not_configured: '模型未配置',
  model_unavailable: '模型暂不可用',
  model_timeout: '模型超时',
  model_response_invalid: '模型返回无效',
  ai_invalid_json: '模型返回不是合法 JSON',
  ai_schema_invalid: '模型返回格式不符合约定',
  ai_fact_mismatch: '模型结果与本地事实不一致',
  ai_unsafe_content: '模型内容未通过安全检查',
  ai_candidate_mismatch: '模型规则候选不一致',
});

export function behaviorFallbackText(reason) {
  return BEHAVIOR_FALLBACK_LABELS[reason] ?? '模型未返回可用结果';
}

const MAX_TEXT = 80;
const cache = new Map();

const isIndex = (value) => Number.isInteger(value) && value >= 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeText(text) {
  return typeof text === 'string'
    && text.length > 0
    && text.length <= MAX_TEXT
    && !/\d{6}/.test(text)
    && !/(建议|推荐)(买入|卖出|加仓|减仓)/.test(text)
    && !/(必涨|必跌|稳赚|保证收益|包赚)/.test(text)
    && !/https?:\/\//i.test(text)
    && !/[\r\n]/.test(text);
}

function validIndexes(raw, eventCount, { min = 0 } = {}) {
  if (!Array.isArray(raw) || raw.length < min || raw.some((value) => !isIndex(value) || value >= eventCount)) return null;
  const unique = [...new Set(raw)].sort((a, b) => a - b);
  return unique.length === raw.length ? unique : null;
}

function sanitizePattern(raw, localPattern, facts) {
  if (!isObject(raw)) return null;
  if (raw.pattern_id !== localPattern.pattern_id) return null;
  if (raw.status !== localPattern.status
    || raw.sample_n !== localPattern.sample_n
    || raw.evaluated_n !== localPattern.evaluated_n) return null;
  const evidence = validIndexes(raw.evidence_event_indexes, facts.events.length);
  if (!evidence || evidence.length !== (localPattern.evidence?.length ?? 0)) return null;
  if (evidence.some((index) => facts.events[index]?.side !== 'buy')) return null;
  const comment = raw.comment === null || raw.comment === undefined
    ? ''
    : (typeof raw.comment === 'string' ? raw.comment.trim() : null);
  if (comment === null || (comment !== '' && !safeText(comment))) return null;
  return {
    pattern_id: raw.pattern_id,
    status: raw.status,
    sample_n: raw.sample_n,
    evaluated_n: raw.evaluated_n,
    evidence_event_indexes: evidence,
    comment,
  };
}

function sanitizeObservations(raw, facts, trading) {
  if (!Array.isArray(raw) || raw.length > BEHAVIOR_OBSERVATION_IDS.length) return null;
  const seen = new Set();
  const observations = [];
  for (const item of raw) {
    if (!isObject(item) || !BEHAVIOR_OBSERVATION_IDS.includes(item.observation_id)) return null;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!safeText(text)) return null;
    const evidence = validIndexes(item.evidence_event_indexes, facts.events.length, { min: 2 });
    if (!evidence) return null;
    if (item.observation_id === 'sell_rebuy_within_2d') {
      if (trading.sell_rebuy_within_2d_count < 1 || !hasSellRebuyPair(facts.events, evidence)) return null;
    }
    if (item.observation_id === 'overtrading' && trading.sell_after_buy_count < 4) return null;
    if (seen.has(item.observation_id)) return null;
    seen.add(item.observation_id);
    observations.push({ observation_id: item.observation_id, text, evidence_event_indexes: evidence });
  }
  return observations;
}

function hasSellRebuyPair(events, indexes) {
  for (let i = 0; i < indexes.length; i += 1) {
    const sell = events[indexes[i]];
    if (!sell || sell.side !== 'sell') continue;
    for (let j = i + 1; j < indexes.length; j += 1) {
      const buy = events[indexes[j]];
      if (!buy || buy.side !== 'buy' || buy.asset_key !== sell.asset_key) continue;
      const gap = buy.day_offset - sell.day_offset;
      if (gap > 0 && gap <= 2) return true;
    }
  }
  return false;
}

function sanitizeCandidates(raw, localPattern) {
  const expected = localPattern.status === '成立' ? [BEHAVIOR_CANDIDATE] : [];
  if (!Array.isArray(raw) || raw.length !== expected.length) return null;
  const candidates = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = raw[index];
    if (!isObject(item)
      || item.candidate_id !== expected[index].candidate_id
      || item.template_id !== expected[index].template_id) return null;
    candidates.push({ candidate_id: item.candidate_id, template_id: item.template_id });
  }
  return candidates;
}

function sanitizeTrading(raw, facts) {
  if (!isObject(raw)) return null;
  const keys = ['sell_after_buy_count', 'sell_rebuy_within_2d_count', 'max_trades_per_day', 'span_days'];
  if (keys.some((key) => !isIndex(raw[key]))) return null;
  return Object.fromEntries(keys.map((key) => [key, raw[key]]));
}

/** 站点返回 → 可渲染结构；任何与本地确定性事实不一致的内容都丢弃整条结果。 */
export function sanitizeAnalysis(raw, { facts, localPattern } = {}) {
  if (!isObject(raw) || raw.protocol !== BEHAVIOR_ANALYSIS_PROTOCOL) return null;
  if (!BEHAVIOR_ANALYSIS_SOURCES.includes(raw.source)) return null;
  if (!facts?.events || !localPattern) return null;
  if (raw.source === 'backend_rules' && raw.observations?.length) return null;
  const buyCount = facts.events.filter((event) => event.side === 'buy').length;
  if (!isObject(raw.scope)
    || raw.scope.trade_count !== facts.events.length
    || raw.scope.buy_count !== buyCount
    || raw.scope.sell_count !== facts.events.length - buyCount) return null;
  if (!Array.isArray(raw.patterns) || raw.patterns.length !== 1) return null;
  const pattern = sanitizePattern(raw.patterns[0], localPattern, facts);
  if (!pattern) return null;
  const trading = sanitizeTrading(raw.trading, facts);
  if (!trading) return null;
  const observations = sanitizeObservations(raw.observations, facts, trading);
  if (!observations) return null;
  const ruleCandidates = sanitizeCandidates(raw.rule_candidates, localPattern);
  if (!ruleCandidates) return null;
  return {
    source: raw.source,
    fallback_reason: typeof raw.fallback_reason === 'string' ? raw.fallback_reason : null,
    scope: { ...raw.scope },
    pattern,
    observations,
    rule_candidates: ruleCandidates,
    trading,
  };
}

export function behaviorAnalysisKey({ bill, bundle } = {}) {
  const context = bill?.contextId || bundle?.fileName || 'anonymous';
  return [
    context,
    bundle?.review?.meta?.verify_id ?? '',
    bundle?.valuation?.effective_date ?? '',
  ].join('|');
}

function failure(reason) {
  return { ok: false, analysis: null, reason };
}

async function runRequest({ facts, localPattern, fetchImpl, timeoutMs }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(BEHAVIOR_ANALYSIS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(facts),
      signal: controller?.signal,
    });
    if (!response?.ok) return failure(`http_${response?.status ?? 'unknown'}`);
    let body;
    try {
      body = await response.json();
    } catch {
      return failure('invalid_json');
    }
    if (!body?.ok || !body.analysis) return failure('invalid_response');
    const analysis = sanitizeAnalysis(body.analysis, { facts, localPattern });
    return analysis ? { ok: true, analysis, reason: null } : failure('schema_mismatch');
  } catch (error) {
    return failure(error?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 每个报告只成功缓存一次；失败不缓存，重新渲染时可再试。 */
export function requestBehaviorAnalysis({
  key, facts, localPattern, force = false, timeoutMs = 9000, fetchImpl = undefined,
} = {}) {
  if (!key || !facts || !localPattern) return Promise.resolve(failure('facts_unavailable'));
  const cached = cache.get(key);
  if (!force && cached) return cached.promise;
  const entry = { promise: null };
  entry.promise = runRequest({ facts, localPattern, fetchImpl, timeoutMs }).then((result) => {
    if (!result.ok && cache.get(key) === entry) cache.delete(key);
    return result;
  });
  cache.set(key, entry);
  return entry.promise;
}

export function clearBehaviorAnalysisCache() {
  cache.clear();
}
