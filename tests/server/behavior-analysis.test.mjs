#!/usr/bin/env node
/**
 * 行为分析服务端测试（Node Web Request/Response；fake transport；不联网）
 *
 * 覆盖：
 *   · 脱敏事实请求白名单与确定性重算；
 *   · AI 输出不得改写三态/样本/证据/候选，越权或危险文本一律降级；
 *   · AI 不可用、超时、非法 JSON 时返回 backend_rules，不伪造观察；
 *   · Handler 路由与响应格式 behavior-analysis-v1。
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  BEHAVIOR_ANALYSIS_PROTOCOL,
  BEHAVIOR_CANDIDATE,
  buildBehaviorFacts,
  normalizeBehaviorFactsRequest,
  validateBehaviorAiResponse,
  buildAiBehaviorAnalysis,
} from '../../server/site-functions/behaviorAnalysis.mjs';
import { buildBehaviorFallback } from '../../server/site-functions/behaviorFallback.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const CHASE = Object.freeze({
  protocol: 'behavior-facts-v1',
  events: [
    { side: 'buy', asset_key: 'A1', day_offset: 0 },
    { side: 'buy', asset_key: 'A1', day_offset: 2 },
    { side: 'buy', asset_key: 'A2', day_offset: 15 },
    { side: 'sell', asset_key: 'A1', day_offset: 18 },
    { side: 'sell', asset_key: 'A1', day_offset: 30 },
    { side: 'sell', asset_key: 'A2', day_offset: 50 },
  ],
  buy_windows: [
    { event_index: 0, rise_pct: 12.3, evaluated: true },
    { event_index: 1, rise_pct: 12.0, evaluated: true },
    { event_index: 2, rise_pct: 3.0, evaluated: true },
  ],
});

const SELL_REBUY = Object.freeze({
  protocol: 'behavior-facts-v1',
  events: [
    { side: 'buy', asset_key: 'A1', day_offset: 0 },
    { side: 'sell', asset_key: 'A1', day_offset: 20 },
    { side: 'buy', asset_key: 'A1', day_offset: 22 },
    { side: 'sell', asset_key: 'A1', day_offset: 40 },
  ],
  buy_windows: [
    { event_index: 0, rise_pct: 2.0, evaluated: true },
    { event_index: 2, rise_pct: 6.0, evaluated: true },
  ],
});

const OVERTRADING = Object.freeze({
  protocol: 'behavior-facts-v1',
  events: [
    { side: 'buy', asset_key: 'A1', day_offset: 0 },
    { side: 'sell', asset_key: 'A1', day_offset: 5 },
    { side: 'buy', asset_key: 'A1', day_offset: 10 },
    { side: 'sell', asset_key: 'A1', day_offset: 15 },
    { side: 'buy', asset_key: 'A1', day_offset: 20 },
    { side: 'sell', asset_key: 'A1', day_offset: 25 },
    { side: 'buy', asset_key: 'A1', day_offset: 30 },
    { side: 'sell', asset_key: 'A1', day_offset: 35 },
  ],
  buy_windows: [
    { event_index: 0, rise_pct: 1.0, evaluated: true },
    { event_index: 2, rise_pct: 0.5, evaluated: true },
    { event_index: 4, rise_pct: 0.5, evaluated: true },
    { event_index: 6, rise_pct: 0.3, evaluated: true },
  ],
});

const LOW_SAMPLE = Object.freeze({
  protocol: 'behavior-facts-v1',
  events: [
    { side: 'buy', asset_key: 'A1', day_offset: 0 },
    { side: 'sell', asset_key: 'A1', day_offset: 18 },
  ],
  buy_windows: [{ event_index: 0, rise_pct: 12.0, evaluated: true }],
});

function factsOf(body) {
  const normalized = normalizeBehaviorFactsRequest(body);
  if (!normalized.ok) throw new Error(`fixture 非法：${normalized.errors?.join(';')}`);
  return buildBehaviorFacts(normalized.request);
}

function aiPayload(facts, { comment = '', observations = [] } = {}) {
  const pattern = facts.pattern;
  return JSON.stringify({
    patterns: [{
      pattern_id: pattern.pattern_id,
      status: pattern.status,
      sample_n: pattern.sample_n,
      evaluated_n: pattern.evaluated_n,
      evidence_event_indexes: [...pattern.evidence_event_indexes],
      comment,
    }],
    observations,
    rule_candidates: pattern.status === '成立'
      ? [{ candidate_id: BEHAVIOR_CANDIDATE.candidate_id, template_id: BEHAVIOR_CANDIDATE.template_id }]
      : [],
  });
}

async function invoke(handler, body) {
  const response = await handler(new Request(
    'https://timingmirror.example/functions/v1/app/api/llm/behavior-analysis',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 断言处理 */ }
  return { status: response.status, text, json };
}

/* —— 请求白名单与确定性重算 —— */
{
  const chase = factsOf(CHASE);
  check('事实：chase 三态/样本与引擎一致', chase.pattern.status === '成立'
    && chase.pattern.sample_n === 2 && chase.pattern.evaluated_n === 3
    && chase.pattern.evidence_event_indexes.join(',') === '0,1', JSON.stringify(chase.pattern));
  check('事实：卖出后有买入计数与卖后追回计数', chase.trading.sell_after_buy_count === 3
    && chase.trading.sell_rebuy_within_2d_count === 0, JSON.stringify(chase.trading));

  const rebuy = factsOf(SELL_REBUY);
  check('事实：卖后 2 个交易日内追回可被服务端识别', rebuy.trading.sell_rebuy_within_2d_count === 1
    && rebuy.pattern.status === '不成立' && rebuy.pattern.evaluated_n === 2, JSON.stringify({ trading: rebuy.trading, pattern: rebuy.pattern }));

  const over = factsOf(OVERTRADING);
  check('事实：频繁往返计数达到 AI 可观察门槛', over.trading.sell_after_buy_count === 4
    && over.pattern.status === '不成立' && over.pattern.evaluated_n === 4, JSON.stringify({ trading: over.trading, pattern: over.pattern }));

  const low = factsOf(LOW_SAMPLE);
  check('事实：单次命中判证据不足', low.pattern.status === '证据不足'
    && low.pattern.sample_n === 1 && low.pattern.evaluated_n === 1, JSON.stringify(low.pattern));

  const extra = normalizeBehaviorFactsRequest({ ...CHASE, raw_csv: 'date,symbol' });
  check('请求：携带原始 CSV 字段 → 拒绝', extra.ok === false && extra.code === 'E_BEHAVIOR_REQUEST_INVALID');
  const symbol = normalizeBehaviorFactsRequest({
    ...CHASE,
    events: [{ side: 'buy', asset_key: '600519', day_offset: 0 }],
    buy_windows: [{ event_index: 0, rise_pct: 12, evaluated: true }],
  });
  check('请求：asset_key 为真实代码 → 拒绝', symbol.ok === false);
  const missingWindow = normalizeBehaviorFactsRequest({ ...CHASE, buy_windows: CHASE.buy_windows.slice(0, 2) });
  check('请求：buy_windows 未覆盖全部买入 → 拒绝', missingWindow.ok === false);
  const unordered = normalizeBehaviorFactsRequest({
    ...CHASE,
    events: [
      { side: 'buy', asset_key: 'A1', day_offset: 5 },
      { side: 'buy', asset_key: 'A1', day_offset: 2 },
    ],
    buy_windows: [
      { event_index: 0, rise_pct: 1, evaluated: true },
      { event_index: 1, rise_pct: 1, evaluated: true },
    ],
  });
  check('请求：时间线倒序 → 拒绝', unordered.ok === false);
  const wrongProtocol = normalizeBehaviorFactsRequest({ ...CHASE, protocol: 'v2' });
  check('请求：协议版本不符 → 拒绝', wrongProtocol.ok === false);
}

/* —— AI 输出强校验 —— */
{
  const chase = factsOf(CHASE);
  const valid = validateBehaviorAiResponse(aiPayload(chase, { comment: '两次在短期上涨后买入。' }), chase);
  check('AI：合法响应通过并保留短评论', valid.ok === true && valid.value.comment === '两次在短期上涨后买入。'
    && valid.value.observations.length === 0, JSON.stringify(valid));

  const statusMismatch = validateBehaviorAiResponse(JSON.stringify({
    ...JSON.parse(aiPayload(chase)),
    patterns: [{ ...JSON.parse(aiPayload(chase)).patterns[0], status: '证据不足' }],
  }), chase);
  check('AI：改写三态 → ai_fact_mismatch', statusMismatch.ok === false && statusMismatch.reason === 'ai_fact_mismatch');

  const evidenceMismatch = validateBehaviorAiResponse(JSON.stringify({
    ...JSON.parse(aiPayload(chase)),
    patterns: [{ ...JSON.parse(aiPayload(chase)).patterns[0], evidence_event_indexes: [0] }],
  }), chase);
  check('AI：少报证据索引 → ai_fact_mismatch', evidenceMismatch.ok === false && evidenceMismatch.reason === 'ai_fact_mismatch');

  const unsafe = validateBehaviorAiResponse(aiPayload(chase, { comment: '建议买入，必涨。' }), chase);
  check('AI：评论含买卖指令/收益承诺 → ai_unsafe_content', unsafe.ok === false && unsafe.reason === 'ai_unsafe_content');

  const extraField = JSON.parse(aiPayload(chase));
  extraField.patterns[0].confidence = 0.9;
  const extra = validateBehaviorAiResponse(JSON.stringify(extraField), chase);
  check('AI：输出额外字段 → ai_schema_invalid', extra.ok === false && extra.reason === 'ai_schema_invalid');

  const badCandidate = JSON.parse(aiPayload(chase));
  badCandidate.rule_candidates = [{ candidate_id: 'rc:no_buy_back_within:chase_high_buy', template_id: 'no_buy_back_within' }];
  const candidate = validateBehaviorAiResponse(JSON.stringify(badCandidate), chase);
  check('AI：推荐白名单外候选 → ai_candidate_mismatch', candidate.ok === false && candidate.reason === 'ai_candidate_mismatch');

  const rebuy = factsOf(SELL_REBUY);
  const rebuyAi = JSON.parse(aiPayload(rebuy, {
    comment: '卖出后又追回。',
    observations: [{ observation_id: 'sell_rebuy_within_2d', text: '卖出后两个交易日内又买回同一标的。', evidence_event_indexes: [1, 2] }],
  }));
  const rebuyChecked = validateBehaviorAiResponse(JSON.stringify(rebuyAi), rebuy);
  check('AI：卖后追回观察有事件证据 → 通过', rebuyChecked.ok === true
    && rebuyChecked.value.observations[0].observation_id === 'sell_rebuy_within_2d', JSON.stringify(rebuyChecked));

  const rebuyOnChase = JSON.parse(aiPayload(chase));
  rebuyOnChase.observations = [{ observation_id: 'sell_rebuy_within_2d', text: '卖出后又买回。', evidence_event_indexes: [3, 4] }];
  const noRebuy = validateBehaviorAiResponse(JSON.stringify(rebuyOnChase), chase);
  check('AI：无卖后追回事实却输出观察 → ai_fact_mismatch', noRebuy.ok === false && noRebuy.reason === 'ai_fact_mismatch');

  const over = factsOf(OVERTRADING);
  const overAi = JSON.parse(aiPayload(over, {
    comment: '交易往返次数较多。',
    observations: [{ observation_id: 'overtrading', text: '四次往返，节奏偏密。', evidence_event_indexes: [0, 1, 2, 3, 4, 5, 6, 7] }],
  }));
  const overChecked = validateBehaviorAiResponse(JSON.stringify(overAi), over);
  check('AI：频繁交易观察达到门槛 → 通过', overChecked.ok === true
    && overChecked.value.observations[0].observation_id === 'overtrading');

  const overOnChase = JSON.parse(aiPayload(chase));
  overOnChase.observations = [{ observation_id: 'overtrading', text: '交易偏频繁。', evidence_event_indexes: [0, 1] }];
  const notOver = validateBehaviorAiResponse(JSON.stringify(overOnChase), chase);
  check('AI：未达频繁交易门槛却输出观察 → ai_fact_mismatch', notOver.ok === false && notOver.reason === 'ai_fact_mismatch');
}

/* —— 确定性兜底 —— */
{
  const chase = factsOf(CHASE);
  const fallback = buildBehaviorFallback(chase, 'model_not_configured');
  check('兜底：返回 backend_rules 且不补 AI 观察', fallback.protocol === BEHAVIOR_ANALYSIS_PROTOCOL
    && fallback.source === 'backend_rules' && fallback.fallback_reason === 'model_not_configured'
    && fallback.observations.length === 0 && fallback.patterns[0].comment === null, JSON.stringify(fallback));
  check('兜底：成立时给出规范化候选', fallback.rule_candidates.length === 1
    && fallback.rule_candidates[0].candidate_id === BEHAVIOR_CANDIDATE.candidate_id
    && fallback.rule_candidates[0].fields.threshold_pct === '10', JSON.stringify(fallback.rule_candidates));

  const low = buildBehaviorFallback(factsOf(LOW_SAMPLE), 'model_timeout');
  check('兜底：证据不足不生成候选', low.rule_candidates.length === 0
    && low.patterns[0].status === '证据不足' && low.source === 'backend_rules', JSON.stringify(low));
}

/* —— Handler —— */
{
  const calls = [];
  const chase = factsOf(CHASE);
  const transport = {
    async behaviorAnalysis(request) {
      calls.push(request);
      return { rawText: aiPayload(chase, { comment: '两次在短期上涨后买入。' }) };
    },
  };
  const handler = createHandler({ transport });
  const response = await invoke(handler, CHASE);
  check('Handler：AI 成功 → 200 + source=ai + 协议版本', response.status === 200
    && response.json?.analysis?.source === 'ai'
    && response.json.analysis.protocol === BEHAVIOR_ANALYSIS_PROTOCOL
    && response.json.analysis.rule_candidates.length === 1, JSON.stringify(response.json));
  check('Handler：transport 只收到脱敏 facts 信封', calls.length === 1
    && Object.keys(calls[0]).join(',') === 'facts'
    && Object.keys(calls[0].facts).sort().join(',') === 'buy_windows,events,pattern,protocol,scope,trading'
    && !JSON.stringify(calls[0]).includes('600519')
    && !JSON.stringify(calls[0]).includes('price'), JSON.stringify(calls[0]));

  const noTransport = createHandler({ transport: null });
  const fallback = await invoke(noTransport, CHASE);
  check('Handler：无模型配置 → 200 backend_rules + 候选', fallback.status === 200
    && fallback.json?.analysis?.source === 'backend_rules'
    && fallback.json.analysis.fallback_reason === 'model_not_configured'
    && fallback.json.analysis.rule_candidates.length === 1, JSON.stringify(fallback.json));

  const timeout = createHandler({
    transport: {
      async behaviorAnalysis() {
        const error = new Error('timeout');
        error.code = SITE_FUNCTION_CODES.MODEL_TIMEOUT;
        throw error;
      },
    },
  });
  const timedOut = await invoke(timeout, CHASE);
  check('Handler：AI 超时 → 200 backend_rules + model_timeout', timedOut.status === 200
    && timedOut.json?.analysis?.fallback_reason === 'model_timeout', JSON.stringify(timedOut.json));

  const invalid = createHandler({ transport: { async behaviorAnalysis() { return { rawText: 'not json' }; } } });
  const invalidResponse = await invoke(invalid, CHASE);
  check('Handler：AI 非法 JSON → 200 backend_rules + ai_invalid_json', invalidResponse.status === 200
    && invalidResponse.json?.analysis?.fallback_reason === 'ai_invalid_json', JSON.stringify(invalidResponse.json));

  const unsafe = createHandler({
    transport: { async behaviorAnalysis() { return { rawText: aiPayload(chase, { comment: '建议买入，必涨。' }) }; } },
  });
  const unsafeResponse = await invoke(unsafe, CHASE);
  check('Handler：AI 危险文本 → 200 backend_rules + ai_unsafe_content', unsafeResponse.status === 200
    && unsafeResponse.json?.analysis?.fallback_reason === 'ai_unsafe_content'
    && unsafeResponse.json.analysis.observations.length === 0, JSON.stringify(unsafeResponse.json));

  const malformed = await invoke(createHandler({ transport: null }), { ...CHASE, raw_csv: 'a,b' });
  check('Handler：请求越权 → 400 E_BEHAVIOR_REQUEST_INVALID', malformed.status === 400
    && malformed.json?.code === SITE_FUNCTION_CODES.BEHAVIOR_REQUEST_INVALID, JSON.stringify(malformed));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   → ${r.detail}`}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
