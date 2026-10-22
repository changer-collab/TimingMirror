#!/usr/bin/env node
/**
 * 报告页行为分析编排单元测试。
 * 覆盖：站点响应强校验（三态/证据/候选/危险文本）、AI 观察证据、兜底、缓存与重试、请求脱敏。
 */
import { loadReportScenarioBill, loadUserBillReport } from '../src/demo/adapter.js';
import {
  BEHAVIOR_ANALYSIS_PROTOCOL,
  BEHAVIOR_ANALYSIS_URL,
  behaviorAnalysisKey,
  clearBehaviorAnalysisCache,
  requestBehaviorAnalysis,
  sanitizeAnalysis,
} from '../prototype/user-frontend/behaviorAnalysis.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

async function loadScenario(id) {
  const bill = await loadReportScenarioBill(id, { contextId: `client-${id}` });
  const bundle = await loadUserBillReport(bill);
  const localPattern = bundle.insights.behavior.data.patterns[0];
  const facts = bundle.behaviorFacts;
  return { bill, bundle, localPattern, facts };
}

function tradingOf(events) {
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
  const buyCount = events.filter((event) => event.side === 'buy').length;
  return {
    scope: { trade_count: events.length, buy_count: buyCount, sell_count: events.length - buyCount },
    trading: {
      sell_after_buy_count: sellAfterBuy,
      sell_rebuy_within_2d_count: sellRebuy,
      max_trades_per_day: maxTradesPerDay,
      span_days: events.length ? events[events.length - 1].day_offset - events[0].day_offset : 0,
    },
  };
}

function evidenceIndexes(facts) {
  return facts.buy_windows.filter((item) => item.evaluated && item.rise_pct >= 10).map((item) => item.event_index);
}

function aiPayload({ facts, localPattern, comment = '只描述当前账单。', observations = [], candidates = undefined, evidence = undefined }) {
  const base = tradingOf(facts.events);
  return {
    protocol: BEHAVIOR_ANALYSIS_PROTOCOL,
    source: 'ai',
    fallback_reason: null,
    scope: base.scope,
    patterns: [{
      pattern_id: localPattern.pattern_id,
      status: localPattern.status,
      sample_n: localPattern.sample_n,
      evaluated_n: localPattern.evaluated_n,
      evidence_event_indexes: evidence ?? evidenceIndexes(facts),
      comment,
    }],
    observations,
    rule_candidates: candidates !== undefined
      ? candidates
      : (localPattern.status === '成立' ? [{ candidate_id: 'rc:no_buy_on_surge:chase_high_buy', template_id: 'no_buy_on_surge' }] : []),
    trading: base.trading,
  };
}

const chase = await loadScenario('chase');
const sellRebuy = await loadScenario('sell_rebuy');
const overtrading = await loadScenario('overtrading');
const lowSample = await loadScenario('low_sample');

{
  const ai = aiPayload({ facts: chase.facts, localPattern: chase.localPattern });
  const clean = sanitizeAnalysis(ai, { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：事实一致时保留评论与候选', clean?.source === 'ai'
    && clean.pattern.comment === '只描述当前账单。'
    && clean.rule_candidates.length === 1
    && clean.scope.trade_count === chase.facts.events.length, JSON.stringify(clean));

  const mismatch = sanitizeAnalysis({ ...ai, patterns: [{ ...ai.patterns[0], sample_n: 3 }] }, { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：样本数被改写 → 整条作废', mismatch === null, JSON.stringify(mismatch));

  const statusMismatch = sanitizeAnalysis({ ...ai, patterns: [{ ...ai.patterns[0], status: '不成立' }] }, { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：三态被改写 → 整条作废', statusMismatch === null, JSON.stringify(statusMismatch));

  const unsafeCode = sanitizeAnalysis(aiPayload({ facts: chase.facts, localPattern: chase.localPattern, comment: '你在 900001 上追高。' }), { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：含标的代码 → 整条作废', unsafeCode === null, JSON.stringify(unsafeCode));

  const advice = sanitizeAnalysis(aiPayload({ facts: chase.facts, localPattern: chase.localPattern, comment: '建议买入并持有。' }), { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：含买卖建议 → 整条作废', advice === null, JSON.stringify(advice));

  const wrongEvidence = sanitizeAnalysis(aiPayload({ facts: chase.facts, localPattern: chase.localPattern, evidence: [0] }), { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：证据笔数不一致 → 整条作废', wrongEvidence === null, JSON.stringify(wrongEvidence));

  const noCandidate = sanitizeAnalysis(aiPayload({ facts: chase.facts, localPattern: chase.localPattern, candidates: [] }), { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 结果：成立但缺候选 → 整条作废', noCandidate === null, JSON.stringify(noCandidate));

  const extraCandidate = sanitizeAnalysis(aiPayload({ facts: lowSample.facts, localPattern: lowSample.localPattern, candidates: [{ candidate_id: 'rc:no_buy_on_surge:chase_high_buy', template_id: 'no_buy_on_surge' }] }), { facts: lowSample.facts, localPattern: lowSample.localPattern });
  check('AI 结果：证据不足却给候选 → 整条作废', extraCandidate === null, JSON.stringify(extraCandidate));

  const fallback = sanitizeAnalysis({
    ...ai,
    source: 'backend_rules',
    fallback_reason: 'model_timeout',
    patterns: [{ ...ai.patterns[0], comment: null }],
    observations: [],
  }, { facts: chase.facts, localPattern: chase.localPattern });
  check('兜底结果：保留确定性事实、无观察', fallback?.source === 'backend_rules'
    && fallback.fallback_reason === 'model_timeout'
    && fallback.observations.length === 0
    && fallback.pattern.comment === '', JSON.stringify(fallback));

  const fallbackObservation = sanitizeAnalysis({
    ...ai,
    source: 'backend_rules',
    observations: [{ observation_id: 'overtrading', text: '往返次数较多。', evidence_event_indexes: [0, 1] }],
  }, { facts: chase.facts, localPattern: chase.localPattern });
  check('兜底结果：不允许携带 AI 观察', fallbackObservation === null, JSON.stringify(fallbackObservation));
}

{
  const base = tradingOf(sellRebuy.facts.events);
  const valid = sanitizeAnalysis(aiPayload({
    facts: sellRebuy.facts,
    localPattern: sellRebuy.localPattern,
    observations: [{ observation_id: 'sell_rebuy_within_2d', text: '卖出后两个交易日内又买回同一标的。', evidence_event_indexes: [1, 2] }],
  }), { facts: sellRebuy.facts, localPattern: sellRebuy.localPattern });
  check('AI 观察：卖后追回有真实成交对 → 保留', valid?.observations.length === 1
    && valid.observations[0].evidence_event_indexes.join(',') === '1,2', JSON.stringify(valid));
  check('AI 观察：服务端交易统计与本地一致', base.trading.sell_rebuy_within_2d_count === 1, JSON.stringify(base.trading));

  const wrongPair = sanitizeAnalysis(aiPayload({
    facts: sellRebuy.facts,
    localPattern: sellRebuy.localPattern,
    observations: [{ observation_id: 'sell_rebuy_within_2d', text: '卖出后两个交易日内又买回同一标的。', evidence_event_indexes: [0, 2] }],
  }), { facts: sellRebuy.facts, localPattern: sellRebuy.localPattern });
  check('AI 观察：证据不是卖后买入对 → 整条作废', wrongPair === null, JSON.stringify(wrongPair));

  const over = sanitizeAnalysis(aiPayload({
    facts: overtrading.facts,
    localPattern: overtrading.localPattern,
    observations: [{ observation_id: 'overtrading', text: '往返次数较多，但暂无可执行模板。', evidence_event_indexes: [0, 1, 2, 3, 4, 5, 6, 7] }],
  }), { facts: overtrading.facts, localPattern: overtrading.localPattern });
  check('AI 观察：频繁交易达到次数门槛 → 保留', over?.observations.length === 1, JSON.stringify(over));

  const overWrong = sanitizeAnalysis(aiPayload({
    facts: chase.facts,
    localPattern: chase.localPattern,
    observations: [{ observation_id: 'overtrading', text: '往返次数较多，但暂无可执行模板。', evidence_event_indexes: [0, 1, 2, 3] }],
  }), { facts: chase.facts, localPattern: chase.localPattern });
  check('AI 观察：次数不足却声称频繁 → 整条作废', overWrong === null, JSON.stringify(overWrong));
}

{
  clearBehaviorAnalysisCache();
  const ai = aiPayload({ facts: chase.facts, localPattern: chase.localPattern });
  let calls = 0;
  let captured = null;
  const fetchImpl = async (url, options) => {
    calls += 1;
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, async json() { return { ok: true, analysis: ai }; } };
  };
  const key = behaviorAnalysisKey({ bill: chase.bill, bundle: chase.bundle });
  const first = await requestBehaviorAnalysis({ key, facts: chase.facts, localPattern: chase.localPattern, fetchImpl });
  const second = await requestBehaviorAnalysis({ key, facts: chase.facts, localPattern: chase.localPattern, fetchImpl });
  check('请求：成功结果按报告缓存', first.ok && second.ok && calls === 1, JSON.stringify({ calls }));
  check('请求：使用行为分析端点与 JSON', captured.url === BEHAVIOR_ANALYSIS_URL
    && captured.body.protocol === 'behavior-facts-v1', JSON.stringify(captured?.url));
  check('请求：只发送脱敏事实', !JSON.stringify(captured.body).includes('900001')
    && !/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(captured.body))
    && JSON.stringify(Object.keys(captured.body).sort()) === JSON.stringify(['buy_windows', 'events', 'protocol']), JSON.stringify(captured.body).slice(0, 200));

  const forced = await requestBehaviorAnalysis({ key, facts: chase.facts, localPattern: chase.localPattern, force: true, fetchImpl });
  check('请求：强制重试绕过缓存', forced.ok && calls === 2, JSON.stringify({ calls }));
}

{
  clearBehaviorAnalysisCache();
  const ai = aiPayload({ facts: chase.facts, localPattern: chase.localPattern });
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return { ok: false, status: 503, async json() { return {}; } };
  };
  const key = `http-failure-${Date.now()}`;
  const first = await requestBehaviorAnalysis({ key, facts: chase.facts, localPattern: chase.localPattern, fetchImpl: failing });
  const second = await requestBehaviorAnalysis({ key, facts: chase.facts, localPattern: chase.localPattern, fetchImpl: async () => {
    calls += 1;
    return { ok: true, status: 200, async json() { return { ok: true, analysis: ai }; } };
  } });
  check('请求：HTTP 失败不缓存，下次可恢复', first.ok === false && first.reason === 'http_503' && second.ok && calls === 2, JSON.stringify({ first, calls }));

  const invalidJson = await requestBehaviorAnalysis({ key: 'invalid-json', facts: chase.facts, localPattern: chase.localPattern, fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('bad'); } }) });
  check('请求：响应不是 JSON → invalid_json', invalidJson.ok === false && invalidJson.reason === 'invalid_json', JSON.stringify(invalidJson));

  const mismatched = await requestBehaviorAnalysis({ key: 'mismatch', facts: chase.facts, localPattern: chase.localPattern, fetchImpl: async () => ({ ok: true, status: 200, async json() { return { ok: true, analysis: { ...ai, patterns: [{ ...ai.patterns[0], sample_n: 9 }] } }; } }) });
  check('请求：响应事实不一致 → schema_mismatch', mismatched.ok === false && mismatched.reason === 'schema_mismatch', JSON.stringify(mismatched));

  const unavailable = await requestBehaviorAnalysis({ key: 'no-facts', facts: null, localPattern: chase.localPattern });
  check('请求：缺少事实 → facts_unavailable', unavailable.ok === false && unavailable.reason === 'facts_unavailable', JSON.stringify(unavailable));
}

{
  clearBehaviorAnalysisCache();
  const timeout = await requestBehaviorAnalysis({
    key: 'timeout', facts: chase.facts, localPattern: chase.localPattern, timeoutMs: 15,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  check('请求：超时 → timeout', timeout.ok === false && timeout.reason === 'timeout', JSON.stringify(timeout));
}

{
  const a = behaviorAnalysisKey({ bill: { contextId: 'a' }, bundle: { review: { meta: { verify_id: 'v1' } }, valuation: { effective_date: '2025-01-02' } } });
  const b = behaviorAnalysisKey({ bill: { contextId: 'b' }, bundle: { review: { meta: { verify_id: 'v1' } }, valuation: { effective_date: '2025-01-02' } } });
  check('缓存键：按账单上下文隔离', a !== b && a.includes('v1') && a.includes('2025-01-02'), JSON.stringify({ a, b }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   → ${r.detail}`}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
