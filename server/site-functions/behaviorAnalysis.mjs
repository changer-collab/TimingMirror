// 行为分析协议：脱敏事实输入 → AI 观察 → 服务端强校验 → 结构化结果。
// 事实（三态/样本数/证据索引/候选模板）由服务端重算，AI 不得改写；AI 只补充短评论与可观察项。
export const BEHAVIOR_FACTS_PROTOCOL = 'behavior-facts-v1';
export const BEHAVIOR_ANALYSIS_PROTOCOL = 'behavior-analysis-v1';

export const BEHAVIOR_CODES = Object.freeze({
  REQUEST_INVALID: 'E_BEHAVIOR_REQUEST_INVALID',
  RESPONSE_INVALID: 'E_BEHAVIOR_RESPONSE_INVALID',
});

export const BEHAVIOR_PATTERN = Object.freeze({
  pattern_id: 'chase_high_buy',
  name: '追高买入',
  lookback_days: 5,
  rise_threshold_pct: 10,
  min_samples: 2,
});

export const BEHAVIOR_OBSERVATION_IDS = Object.freeze(['sell_rebuy_within_2d', 'overtrading']);
export const BEHAVIOR_CANDIDATE = Object.freeze({
  candidate_id: 'rc:no_buy_on_surge:chase_high_buy',
  template_id: 'no_buy_on_surge',
  pattern_id: 'chase_high_buy',
});

const REQUEST_KEYS = new Set(['protocol', 'events', 'buy_windows']);
const EVENT_KEYS = new Set(['side', 'asset_key', 'day_offset']);
const WINDOW_KEYS = new Set(['event_index', 'rise_pct', 'evaluated']);
const AI_KEYS = new Set(['patterns', 'observations', 'rule_candidates']);
const AI_PATTERN_KEYS = new Set(['pattern_id', 'status', 'sample_n', 'evaluated_n', 'evidence_event_indexes', 'comment']);
const AI_OBSERVATION_KEYS = new Set(['observation_id', 'text', 'evidence_event_indexes']);
const AI_CANDIDATE_KEYS = new Set(['candidate_id', 'template_id']);
const MAX_EVENTS = 500;
const MAX_TEXT = 80;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOnlyKeys = (v, allowed) => isObject(v) && Object.keys(v).every((key) => allowed.has(key));
const isIndex = (v) => Number.isInteger(v) && v >= 0;
const fail = (code, message) => ({ ok: false, code, errors: [message] });
const round2 = (v) => Math.round(v * 100) / 100;

function unsafeText(text) {
  return /\d{6}/.test(text)
    || /(建议|推荐)(买入|卖出|加仓|减仓)/.test(text)
    || /(必涨|必跌|稳赚|保证收益|包赚)/.test(text)
    || /https?:\/\//i.test(text)
    || /[\r\n]/.test(text);
}

function normalizeEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS) {
    return fail(BEHAVIOR_CODES.REQUEST_INVALID, `events 必须为 1-${MAX_EVENTS} 项数组`);
  }
  const events = [];
  let previousDay = -1;
  for (const item of raw) {
    if (!hasOnlyKeys(item, EVENT_KEYS)) return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'events 含不允许字段');
    if (item.side !== 'buy' && item.side !== 'sell') return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'side 必须为 buy/sell');
    if (typeof item.asset_key !== 'string' || !/^[A-Z]\d{0,3}$/.test(item.asset_key)) {
      return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'asset_key 必须为脱敏代号');
    }
    if (!Number.isInteger(item.day_offset) || item.day_offset < 0 || item.day_offset > 3650 || item.day_offset < previousDay) {
      return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'day_offset 必须为非递减整数');
    }
    previousDay = item.day_offset;
    events.push({ side: item.side, asset_key: item.asset_key, day_offset: item.day_offset });
  }
  if (!events.some((event) => event.side === 'buy')) {
    return fail(BEHAVIOR_CODES.REQUEST_INVALID, '至少需要一笔买入');
  }
  return { ok: true, events };
}

function normalizeBuyWindows(raw, events) {
  const buyIndexes = events.map((event, index) => (event.side === 'buy' ? index : -1)).filter((index) => index >= 0);
  if (!Array.isArray(raw) || raw.length !== buyIndexes.length) {
    return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'buy_windows 必须覆盖全部买入');
  }
  const seen = new Set();
  const windows = [];
  for (const item of raw) {
    if (!hasOnlyKeys(item, WINDOW_KEYS)) return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'buy_windows 含不允许字段');
    if (!isIndex(item.event_index) || !buyIndexes.includes(item.event_index) || seen.has(item.event_index)) {
      return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'buy_windows.event_index 必须唯一指向买入');
    }
    if (typeof item.evaluated !== 'boolean') return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'evaluated 必须为布尔值');
    if (item.evaluated) {
      if (!Number.isFinite(item.rise_pct) || item.rise_pct < -100 || item.rise_pct > 1000) {
        return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'rise_pct 必须为有限数值');
      }
    } else if (item.rise_pct !== null) {
      return fail(BEHAVIOR_CODES.REQUEST_INVALID, '未评估窗口的 rise_pct 必须为 null');
    }
    seen.add(item.event_index);
    windows.push({ event_index: item.event_index, rise_pct: item.rise_pct, evaluated: item.evaluated });
  }
  windows.sort((a, b) => a.event_index - b.event_index);
  return { ok: true, windows };
}

export function normalizeBehaviorFactsRequest(body) {
  if (!isObject(body)) return fail(BEHAVIOR_CODES.REQUEST_INVALID, '请求体必须为对象');
  if (!hasOnlyKeys(body, REQUEST_KEYS)) return fail(BEHAVIOR_CODES.REQUEST_INVALID, '请求含不允许字段');
  if (body.protocol !== BEHAVIOR_FACTS_PROTOCOL) return fail(BEHAVIOR_CODES.REQUEST_INVALID, 'protocol 必须为 behavior-facts-v1');
  const events = normalizeEvents(body.events);
  if (!events.ok) return events;
  const windows = normalizeBuyWindows(body.buy_windows, events.events);
  if (!windows.ok) return windows;
  return { ok: true, request: { protocol: BEHAVIOR_FACTS_PROTOCOL, events: events.events, buy_windows: windows.windows } };
}

function computeTrading(events) {
  const openBuys = new Map();
  const lastSell = new Map();
  const perDay = new Map();
  let sellAfterBuy = 0;
  let sellRebuy = 0;
  let maxTradesPerDay = 0;
  for (const event of events) {
    perDay.set(event.day_offset, (perDay.get(event.day_offset) ?? 0) + 1);
    maxTradesPerDay = Math.max(maxTradesPerDay, perDay.get(event.day_offset));
    if (event.side === 'buy') {
      const sell = lastSell.get(event.asset_key);
      if (sell && event.day_offset > sell.day_offset && event.day_offset - sell.day_offset <= 2) sellRebuy += 1;
      openBuys.set(event.asset_key, (openBuys.get(event.asset_key) ?? 0) + 1);
    } else {
      if ((openBuys.get(event.asset_key) ?? 0) > 0) {
        sellAfterBuy += 1;
        openBuys.set(event.asset_key, openBuys.get(event.asset_key) - 1);
      }
      lastSell.set(event.asset_key, event);
    }
  }
  return {
    sell_after_buy_count: sellAfterBuy,
    sell_rebuy_within_2d_count: sellRebuy,
    max_trades_per_day: maxTradesPerDay,
    span_days: events.length ? events[events.length - 1].day_offset - events[0].day_offset : 0,
  };
}

export function buildBehaviorFacts(request) {
  const { events, buy_windows: windows } = request;
  const windowByIndex = new Map(windows.map((window) => [window.event_index, window]));
  const evidence = [];
  const evaluatedOthers = [];
  const unevaluated = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].side !== 'buy') continue;
    const window = windowByIndex.get(index);
    if (!window || !window.evaluated) { unevaluated.push(index); continue; }
    if (window.rise_pct >= BEHAVIOR_PATTERN.rise_threshold_pct) evidence.push(index);
    else evaluatedOthers.push(index);
  }
  const sample_n = evidence.length;
  const evaluated_n = evidence.length + evaluatedOthers.length;
  const status = sample_n >= BEHAVIOR_PATTERN.min_samples
    ? '成立'
    : evaluated_n >= BEHAVIOR_PATTERN.min_samples ? '不成立' : '证据不足';
  const buyCount = events.filter((event) => event.side === 'buy').length;
  return {
    scope: { trade_count: events.length, buy_count: buyCount, sell_count: events.length - buyCount },
    pattern: {
      pattern_id: BEHAVIOR_PATTERN.pattern_id,
      name: BEHAVIOR_PATTERN.name,
      status,
      sample_n,
      evaluated_n,
      min_samples: BEHAVIOR_PATTERN.min_samples,
      buy_count: buyCount,
      rule: {
        window: `买入日前 ${BEHAVIOR_PATTERN.lookback_days} 个交易日`,
        lookback_days: BEHAVIOR_PATTERN.lookback_days,
        threshold_pct: BEHAVIOR_PATTERN.rise_threshold_pct,
        threshold_display: `${BEHAVIOR_PATTERN.rise_threshold_pct.toFixed(1)}%`,
      },
      evidence_event_indexes: evidence,
      evaluated_other_event_indexes: evaluatedOthers,
      unevaluated_event_indexes: unevaluated,
    },
    events,
    buy_windows: windows,
    trading: computeTrading(events),
  };
}

export function behaviorFactsForAi(facts) {
  return {
    protocol: BEHAVIOR_FACTS_PROTOCOL,
    scope: facts.scope,
    pattern: facts.pattern,
    events: facts.events,
    buy_windows: facts.buy_windows,
    trading: facts.trading,
  };
}

export function canonicalRuleCandidates(facts) {
  if (facts.pattern.status !== '成立') return [];
  return [{
    candidate_id: BEHAVIOR_CANDIDATE.candidate_id,
    template_id: BEHAVIOR_CANDIDATE.template_id,
    pattern_id: BEHAVIOR_CANDIDATE.pattern_id,
    fields: { threshold_pct: String(facts.pattern.rule.threshold_pct) },
    threshold_pct: facts.pattern.rule.threshold_pct,
    reason: `行为发现“${facts.pattern.name}”成立：命中 ${facts.pattern.sample_n} 笔，已评估 ${facts.pattern.evaluated_n} 笔。`,
  }];
}

function sameIndexes(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function normalizedIndexes(raw, length, { min = 0 } = {}) {
  if (!Array.isArray(raw) || raw.length < min || raw.some((value) => !isIndex(value) || value >= length)) return null;
  const unique = [...new Set(raw)].sort((a, b) => a - b);
  return unique.length === raw.length ? unique : null;
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

function validateObservation(item, facts) {
  if (!hasOnlyKeys(item, AI_OBSERVATION_KEYS)) return { ok: false, reason: 'ai_schema_invalid' };
  if (!BEHAVIOR_OBSERVATION_IDS.includes(item.observation_id)) return { ok: false, reason: 'ai_schema_invalid' };
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text || text.length > MAX_TEXT) return { ok: false, reason: 'ai_schema_invalid' };
  if (unsafeText(text)) return { ok: false, reason: 'ai_unsafe_content' };
  const indexes = normalizedIndexes(item.evidence_event_indexes, facts.events.length, { min: 2 });
  if (!indexes) return { ok: false, reason: 'ai_fact_mismatch' };
  if (item.observation_id === 'sell_rebuy_within_2d') {
    if (facts.trading.sell_rebuy_within_2d_count < 1 || !hasSellRebuyPair(facts.events, indexes)) {
      return { ok: false, reason: 'ai_fact_mismatch' };
    }
  }
  if (item.observation_id === 'overtrading') {
    if (facts.trading.sell_after_buy_count < 4) return { ok: false, reason: 'ai_fact_mismatch' };
  }
  return { ok: true, value: { observation_id: item.observation_id, text, evidence_event_indexes: indexes } };
}

export function validateBehaviorAiResponse(rawText, facts) {
  if (typeof rawText !== 'string') return { ok: false, reason: 'ai_invalid_json' };
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'ai_invalid_json' };
  }
  if (!hasOnlyKeys(parsed, AI_KEYS)) return { ok: false, reason: 'ai_schema_invalid' };
  if (!Array.isArray(parsed.patterns) || parsed.patterns.length !== 1) return { ok: false, reason: 'ai_schema_invalid' };
  const pattern = parsed.patterns[0];
  if (!hasOnlyKeys(pattern, AI_PATTERN_KEYS)) return { ok: false, reason: 'ai_schema_invalid' };
  if (pattern.pattern_id !== facts.pattern.pattern_id
    || pattern.status !== facts.pattern.status
    || pattern.sample_n !== facts.pattern.sample_n
    || pattern.evaluated_n !== facts.pattern.evaluated_n
    || !sameIndexes(normalizedIndexes(pattern.evidence_event_indexes, facts.events.length), facts.pattern.evidence_event_indexes)) {
    return { ok: false, reason: 'ai_fact_mismatch' };
  }
  const comment = pattern.comment === null ? '' : (typeof pattern.comment === 'string' ? pattern.comment.trim() : null);
  if (comment === null || comment.length > MAX_TEXT) return { ok: false, reason: 'ai_schema_invalid' };
  if (unsafeText(comment)) return { ok: false, reason: 'ai_unsafe_content' };

  if (!Array.isArray(parsed.observations) || parsed.observations.length > BEHAVIOR_OBSERVATION_IDS.length) {
    return { ok: false, reason: 'ai_schema_invalid' };
  }
  const observations = [];
  const seen = new Set();
  for (const item of parsed.observations) {
    const checked = validateObservation(item, facts);
    if (!checked.ok) return checked;
    if (seen.has(checked.value.observation_id)) return { ok: false, reason: 'ai_schema_invalid' };
    seen.add(checked.value.observation_id);
    observations.push(checked.value);
  }

  const canonical = canonicalRuleCandidates(facts);
  if (!Array.isArray(parsed.rule_candidates) || parsed.rule_candidates.length !== canonical.length) {
    return { ok: false, reason: 'ai_candidate_mismatch' };
  }
  for (let i = 0; i < canonical.length; i += 1) {
    const item = parsed.rule_candidates[i];
    if (!hasOnlyKeys(item, AI_CANDIDATE_KEYS)
      || item.candidate_id !== canonical[i].candidate_id
      || item.template_id !== canonical[i].template_id) {
      return { ok: false, reason: 'ai_candidate_mismatch' };
    }
  }
  return { ok: true, value: { comment, observations } };
}

function publicPattern(facts) {
  const pattern = facts.pattern;
  return {
    pattern_id: pattern.pattern_id,
    name: pattern.name,
    status: pattern.status,
    sample_n: pattern.sample_n,
    evaluated_n: pattern.evaluated_n,
    min_samples: pattern.min_samples,
    buy_count: pattern.buy_count,
    rule: pattern.rule,
    evidence_event_indexes: [...pattern.evidence_event_indexes],
    evaluated_other_event_indexes: [...pattern.evaluated_other_event_indexes],
    unevaluated_event_indexes: [...pattern.unevaluated_event_indexes],
  };
}

export function buildAiBehaviorAnalysis(value, facts) {
  return {
    protocol: BEHAVIOR_ANALYSIS_PROTOCOL,
    source: 'ai',
    fallback_reason: null,
    scope: facts.scope,
    patterns: [{ ...publicPattern(facts), comment: value.comment }],
    observations: value.observations,
    rule_candidates: canonicalRuleCandidates(facts),
    trading: facts.trading,
  };
}

export { publicPattern };
