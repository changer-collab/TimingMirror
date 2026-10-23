#!/usr/bin/env node
/**
 * AI 画像解读 / 对话事实 服务端测试（fake transport + 内存数据库；不联网）
 *
 * 覆盖：
 *   · 画像 digest 白名单、规范化顺序与 SHA-256 缓存键；
 *   · AI 解读字段/字数/数字来源校验、置信度上限、确定性兜底；
 *   · 对话事实证据必须为原文片段，敏感信息/URL/非投资内容拒绝；
 *   · Handler 路由、降级与错误码；
 *   · /api/profile/summary 缓存写入与跨用户隔离。
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import { DATA_CODES } from '../../server/site-functions/dataApi.mjs';
import {
  PROFILE_SUMMARY_CODES,
  buildProfileSummaryFallback,
  normalizeProfileSummaryRequest,
  profileDigestHash,
  validateProfileSummaryValue,
} from '../../server/site-functions/profileSummary.mjs';
import {
  PROFILE_FACT_CODES,
  normalizeProfileFactRequest,
  validateProfileFactResponse,
} from '../../server/site-functions/profileFact.mjs';
import { createDevUserContext, createMemorySupabase } from '../../scripts/dev-memory-supabase.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const DIGEST = Object.freeze({
  profile_key: 'abcd1234',
  bills: { count: 3, date_from: '2026-01-05', date_to: '2026-09-30' },
  metrics: {
    actual_return: 0.0412,
    benchmark_return: 0.0731,
    drag_pp: -0.0319,
    drag_amount: -1590,
    trade_count: 24,
    win_rate: null,
    pgr: 0.6123,
    plr: 0.4802,
  },
  behavior: { tags: ['追高买入'], patterns: ['追高买入'] },
  rules: { total: 5, kept: 2, warned: 0 },
  facts: [{ kind: 'goal', key: 'holding_horizon', value: '希望减少短线交易' }],
  limits: [],
});

const VALID_SUMMARY = Object.freeze({
  schema_version: 1,
  headline: '交易频率偏高，择时略有拖累',
  summary: '3 份账单共 24 笔交易，实际收益 +4.1%，对照收益 +7.3%，择时差异 -3.2%。',
  strengths: ['交易记录完整可复核'],
  blind_spots: ['短线交易次数偏多'],
  next_actions: ['核对每笔交易的入场理由'],
  confidence: 'high',
  data_limits: ['PGR/PLR 为候选口径'],
});

const USER_A = 'user-a';
const USER_B = 'user-b';

async function invokeModel(handler, path, body, method = 'POST') {
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 由断言处理 */ }
  return { status: response.status, json };
}

async function invokeData(handler, path, { method = 'GET', body, userId = USER_A, supabase } = {}) {
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-qoder-user-context': createDevUserContext({ userId }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { supabase });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 由断言处理 */ }
  return { status: response.status, json };
}

/* ==== digest 规范化 ==== */
{
  const normalized = normalizeProfileSummaryRequest({ digest: DIGEST });
  check('digest：合法输入通过且字段顺序固定', normalized.ok
    && JSON.stringify(normalized.digest) === JSON.stringify(DIGEST), JSON.stringify(normalized));

  const minimal = normalizeProfileSummaryRequest({ digest: { profile_key: 'abcd1234', bills: { count: 0 } } });
  check('digest：缺省字段补齐为空/零', minimal.ok
    && minimal.digest.metrics.actual_return === null
    && minimal.digest.behavior.tags.length === 0
    && minimal.digest.rules.total === 0
    && minimal.digest.facts.length === 0
    && minimal.digest.limits.length === 0
    && minimal.digest.bills.date_from === null, JSON.stringify(minimal));

  const cases = [
    ['额外字段', { digest: { ...DIGEST, raw_csv: 'a' } }],
    ['profile_key 非法', { digest: { ...DIGEST, profile_key: 'ZZZ' } }],
    ['日期倒序', { digest: { ...DIGEST, bills: { count: 3, date_from: '2026-09-30', date_to: '2026-01-05' } } }],
    ['win_rate 越界', { digest: { ...DIGEST, metrics: { ...DIGEST.metrics, win_rate: 1.5 } } }],
    ['facts 类型未知', { digest: { ...DIGEST, facts: [{ kind: 'unknown', key: 'x', value: 'y' }] } }],
    ['limits 过多', { digest: { ...DIGEST, limits: ['1', '2', '3', '4', '5', '6'] } }],
    ['请求额外字段', { digest: DIGEST, user_id: 'other' }],
  ];
  for (const [name, body] of cases) {
    const result = normalizeProfileSummaryRequest(body);
    check(`digest：拒绝${name}`, !result.ok && result.code === PROFILE_SUMMARY_CODES.REQUEST_INVALID, JSON.stringify(result));
  }

  const hashA = await profileDigestHash(normalized.digest);
  const hashB = await profileDigestHash(minimal.digest);
  check('digest：SHA-256 稳定且区分内容', /^[0-9a-f]{64}$/u.test(hashA) && /^[0-9a-f]{64}$/u.test(hashB) && hashA !== hashB);
}

/* ==== 解读校验与兜底 ==== */
{
  const good = validateProfileSummaryValue(VALID_SUMMARY, DIGEST);
  check('解读：合法输出通过（数字均来自 digest）', good.ok
    && good.value.confidence === 'high', JSON.stringify(good));

  const warn = validateProfileSummaryValue({ ...VALID_SUMMARY, summary: '实际收益 +9.9%，明显更高。' }, DIGEST);
  check('解读：拒绝 digest 之外的数字', !warn.ok && warn.code === PROFILE_SUMMARY_CODES.RESPONSE, JSON.stringify(warn));

  const date = validateProfileSummaryValue({ ...VALID_SUMMARY, summary: '2026-03-01 之后收益转负。' }, DIGEST);
  check('解读：拒绝未提供的日期', !date.ok, JSON.stringify(date));

  const advice = validateProfileSummaryValue({ ...VALID_SUMMARY, next_actions: ['建议买入宽基指数'] }, DIGEST);
  check('解读：拒绝投资建议', !advice.ok, JSON.stringify(advice));

  const unsafe = validateProfileSummaryValue({ ...VALID_SUMMARY, summary: '详见 https://example.com/report。' }, DIGEST);
  check('解读：拒绝 URL', !unsafe.ok, JSON.stringify(unsafe));

  const extra = validateProfileSummaryValue({ ...VALID_SUMMARY, extra: 'x' }, DIGEST);
  check('解读：拒绝额外字段', !extra.ok, JSON.stringify(extra));

  const longHeadline = validateProfileSummaryValue({ ...VALID_SUMMARY, headline: '超'.repeat(25) }, DIGEST);
  check('解读：headline 超长拒绝', !longHeadline.ok, JSON.stringify(longHeadline));

  const cappedDigest = {
    ...DIGEST,
    bills: { count: 1, date_from: '2026-01-05', date_to: '2026-09-30' },
    metrics: { ...DIGEST.metrics, trade_count: 4 },
  };
  const capped = validateProfileSummaryValue({
    ...VALID_SUMMARY,
    summary: '1 份账单共 4 笔交易，实际收益 +4.1%，对照收益 +7.3%，择时差异 -3.2%。',
  }, cappedDigest);
  check('解读：置信度按样本封顶（1 份账单 → medium）', capped.ok && capped.value.confidence === 'medium', JSON.stringify(capped));

  const fallback = buildProfileSummaryFallback(DIGEST);
  const fallbackChecked = validateProfileSummaryValue(fallback, DIGEST);
  check('兜底：确定性文案通过同一套校验', fallbackChecked.ok, JSON.stringify(fallbackChecked));

  const lowDigest = {
    profile_key: 'abcd1234',
    bills: { count: 0, date_from: null, date_to: null },
    metrics: { actual_return: null, benchmark_return: null, drag_pp: null, drag_amount: null, trade_count: 0, win_rate: null, pgr: null, plr: null },
    behavior: { tags: [], patterns: [] },
    rules: { total: 0, kept: 0, warned: 0 },
    facts: [],
    limits: [],
  };
  const lowFallback = buildProfileSummaryFallback(lowDigest);
  const lowChecked = validateProfileSummaryValue(lowFallback, lowDigest);
  check('兜底：零样本文案也通过（不引入额外数字）', lowChecked.ok
    && lowFallback.confidence === 'low', JSON.stringify(lowChecked));
}

/* ==== Handler：画像解读 ==== */
{
  const expectedHash = await profileDigestHash(DIGEST);
  const noTransport = createHandler({ transport: null });
  const fallback = await invokeModel(noTransport, '/api/llm/profile-summary', { digest: DIGEST });
  check('Handler 解读：无模型 → 200 template + 兜底', fallback.status === 200
    && fallback.json?.source === 'template'
    && fallback.json?.fallback_reason === 'model_not_configured'
    && fallback.json?.source_hash === expectedHash
    && fallback.json.summary.schema_version === 1, JSON.stringify(fallback.json));

  const calls = [];
  const good = createHandler({
    transport: {
      async profileSummary(request) {
        calls.push(request);
        return { rawText: JSON.stringify(VALID_SUMMARY) };
      },
    },
  });
  const ai = await invokeModel(good, '/api/llm/profile-summary', { digest: DIGEST });
  check('Handler 解读：AI 合法 → 200 source=ai', ai.status === 200
    && ai.json?.source === 'ai'
    && ai.json.summary.headline === VALID_SUMMARY.headline
    && ai.json.source_hash === expectedHash, JSON.stringify(ai.json));
  check('Handler 解读：transport 只收到 digest', calls.length === 1
    && Object.keys(calls[0]).join(',') === 'digest'
    && JSON.stringify(calls[0].digest) === JSON.stringify(DIGEST), JSON.stringify(calls[0]));

  const invalidNumber = createHandler({
    transport: { async profileSummary() { return { rawText: JSON.stringify({ ...VALID_SUMMARY, summary: '实际收益 +9.9%。' }) }; } },
  });
  const invalidNumberResponse = await invokeModel(invalidNumber, '/api/llm/profile-summary', { digest: DIGEST });
  check('Handler 解读：越界数字 → 200 template + model_response_invalid', invalidNumberResponse.status === 200
    && invalidNumberResponse.json?.source === 'template'
    && invalidNumberResponse.json?.fallback_reason === 'model_response_invalid', JSON.stringify(invalidNumberResponse.json));

  const timeout = createHandler({
    transport: {
      async profileSummary() {
        const error = new Error('timeout');
        error.code = SITE_FUNCTION_CODES.MODEL_TIMEOUT;
        throw error;
      },
    },
  });
  const timeoutResponse = await invokeModel(timeout, '/api/llm/profile-summary', { digest: DIGEST });
  check('Handler 解读：超时 → 200 template + model_timeout', timeoutResponse.status === 200
    && timeoutResponse.json?.fallback_reason === 'model_timeout', JSON.stringify(timeoutResponse.json));

  const badRequest = await invokeModel(noTransport, '/api/llm/profile-summary', { digest: { ...DIGEST, extra: 1 } });
  check('Handler 解读：非法请求 → 400', badRequest.status === 400
    && badRequest.json?.code === SITE_FUNCTION_CODES.PROFILE_SUMMARY_REQUEST_INVALID, JSON.stringify(badRequest));

  const wrongMethod = await invokeModel(noTransport, '/api/llm/profile-summary', undefined, 'GET');
  check('Handler 解读：GET → 405', wrongMethod.status === 405, JSON.stringify(wrongMethod));
}

/* ==== 对话事实：请求与响应校验 ==== */
const FACT_MESSAGE = '我希望把仓位控制在五成以内，也不做短线交易。';
const FACT_ITEM = Object.freeze({
  kind: 'constraint',
  key: 'max_position',
  value: '仓位控制在五成以内',
  evidence: '把仓位控制在五成以内',
});

{
  const request = normalizeProfileFactRequest({ message: FACT_MESSAGE });
  check('事实：合法请求通过', request.ok && request.message === FACT_MESSAGE, JSON.stringify(request));
  check('事实：拒绝额外字段', !normalizeProfileFactRequest({ message: FACT_MESSAGE, user_id: 'x' }).ok);
  check('事实：拒绝空消息', !normalizeProfileFactRequest({ message: '   ' }).ok);
  check('事实：拒绝超长消息', !normalizeProfileFactRequest({ message: '我'.repeat(1201) }).ok);

  const valid = validateProfileFactResponse(JSON.stringify({ facts: [FACT_ITEM] }), FACT_MESSAGE);
  check('事实：合法响应通过', valid.ok && valid.facts.length === 1
    && valid.facts[0].evidence === FACT_ITEM.evidence, JSON.stringify(valid));

  const dup = validateProfileFactResponse(JSON.stringify({ facts: [FACT_ITEM, { ...FACT_ITEM }] }), FACT_MESSAGE);
  check('事实：重复事实去重', dup.ok && dup.facts.length === 1, JSON.stringify(dup));

  const notSubstring = validateProfileFactResponse(
    JSON.stringify({ facts: [{ ...FACT_ITEM, evidence: '仓位控制在三成以内' }] }), FACT_MESSAGE,
  );
  check('事实：证据必须是原文片段', !notSubstring.ok && notSubstring.code === PROFILE_FACT_CODES.RESPONSE, JSON.stringify(notSubstring));

  const nonFinance = validateProfileFactResponse(
    JSON.stringify({ facts: [{ ...FACT_ITEM, evidence: '我希望把节奏放慢一点' }] }), '我希望把节奏放慢一点。',
  );
  check('事实：证据与投资无关时拒绝', !nonFinance.ok, JSON.stringify(nonFinance));

  const sensitiveMessage = '我的手机号是 13800138000，请注意仓位风险。';
  const sensitive = validateProfileFactResponse(
    JSON.stringify({ facts: [{ ...FACT_ITEM, evidence: '我的手机号是 13800138000' }] }), sensitiveMessage,
  );
  check('事实：拒绝敏感信息', !sensitive.ok, JSON.stringify(sensitive));

  const url = validateProfileFactResponse(
    JSON.stringify({ facts: [{ ...FACT_ITEM, value: '参见 https://example.com', evidence: '把仓位控制在五成以内' }] }), FACT_MESSAGE,
  );
  check('事实：拒绝 URL', !url.ok, JSON.stringify(url));

  const tooMany = validateProfileFactResponse(
    JSON.stringify({ facts: [FACT_ITEM, { ...FACT_ITEM, key: 'b' }, { ...FACT_ITEM, key: 'c' }, { ...FACT_ITEM, key: 'd' }] }), FACT_MESSAGE,
  );
  check('事实：最多 3 条', !tooMany.ok, JSON.stringify(tooMany));

  const extraField = validateProfileFactResponse(
    JSON.stringify({ facts: [{ ...FACT_ITEM, confidence: 90 }] }), FACT_MESSAGE,
  );
  check('事实：拒绝额外字段', !extraField.ok, JSON.stringify(extraField));
}

/* ==== Handler：对话事实 ==== */
{
  const calls = [];
  const good = createHandler({
    transport: {
      async profileFact(request) {
        calls.push(request);
        return { rawText: JSON.stringify({ facts: [FACT_ITEM] }) };
      },
    },
  });
  const response = await invokeModel(good, '/api/llm/profile-fact', { message: FACT_MESSAGE });
  check('Handler 事实：AI 合法 → 200 facts', response.status === 200
    && response.json?.facts?.length === 1
    && response.json.facts[0].kind === 'constraint', JSON.stringify(response.json));
  check('Handler 事实：transport 只收到 message', calls.length === 1
    && Object.keys(calls[0]).join(',') === 'message', JSON.stringify(calls[0]));

  const missingModel = createHandler({ transport: null });
  const noModel = await invokeModel(missingModel, '/api/llm/profile-fact', { message: FACT_MESSAGE });
  check('Handler 事实：无模型 → 503', noModel.status === 503
    && noModel.json?.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED, JSON.stringify(noModel));

  const badResponse = createHandler({
    transport: { async profileFact() { return { rawText: '{"facts":[{"kind":"goal","key":"x","value":"仓位一成","evidence":"没有这句"}]}' }; } },
  });
  const invalid = await invokeModel(badResponse, '/api/llm/profile-fact', { message: FACT_MESSAGE });
  check('Handler 事实：非法证据 → 502', invalid.status === 502
    && invalid.json?.code === SITE_FUNCTION_CODES.PROFILE_FACT_RESPONSE, JSON.stringify(invalid));

  const badRequest = await invokeModel(missingModel, '/api/llm/profile-fact', { message: '' });
  check('Handler 事实：空消息 → 400', badRequest.status === 400
    && badRequest.json?.code === SITE_FUNCTION_CODES.PROFILE_FACT_REQUEST_INVALID, JSON.stringify(badRequest));
}

/* ==== /api/profile/summary 缓存 ==== */
{
  const supabase = createMemorySupabase();
  const handler = createHandler({ transport: null });
  const hash = await profileDigestHash(DIGEST);

  const saved = await invokeData(handler, '/api/profile/summary', {
    method: 'POST', body: { digest: DIGEST, summary: VALID_SUMMARY }, supabase,
  });
  check('缓存：首次写入 200 + source_hash', saved.status === 200
    && saved.json?.ok === true
    && saved.json.source_hash === hash
    && saved.json.summary_version === 1, JSON.stringify(saved.json));
  check('缓存：profiles 只有一行', supabase.rows('profiles').length === 1
    && supabase.rows('profiles')[0].summary_json.headline === VALID_SUMMARY.headline);

  const read = await invokeData(handler, '/api/profile', { supabase });
  check('缓存：GET /api/profile 返回摘要与哈希', read.status === 200
    && read.json?.summary?.headline === VALID_SUMMARY.headline
    && read.json.summary_source_hash === hash
    && read.json.summary_version === 1, JSON.stringify(read.json));

  const second = { ...VALID_SUMMARY, headline: '样本仍少，先稳住节奏' };
  const updated = await invokeData(handler, '/api/profile/summary', {
    method: 'POST', body: { digest: DIGEST, summary: second }, supabase,
  });
  const readAfter = await invokeData(handler, '/api/profile', { supabase });
  check('缓存：再次写入为更新而非新增', updated.status === 200
    && supabase.rows('profiles').length === 1
    && readAfter.json?.summary?.headline === second.headline, JSON.stringify(readAfter.json));

  const otherUser = await invokeData(handler, '/api/profile', { userId: USER_B, supabase });
  check('缓存：跨用户不可见', otherUser.status === 200
    && otherUser.json?.summary === null
    && otherUser.json.summary_source_hash === null, JSON.stringify(otherUser.json));

  const invalidSummary = await invokeData(handler, '/api/profile/summary', {
    method: 'POST', body: { digest: DIGEST, summary: { ...VALID_SUMMARY, summary: '实际收益 +9.9%。' } }, supabase,
  });
  check('缓存：非法摘要拒绝写入', invalidSummary.status === 400
    && invalidSummary.json?.error === DATA_CODES.REQUEST_INVALID
    && supabase.rows('profiles')[0].summary_json.headline === second.headline, JSON.stringify(invalidSummary.json));

  const invalidDigest = await invokeData(handler, '/api/profile/summary', {
    method: 'POST', body: { digest: { ...DIGEST, raw: 'x' }, summary: VALID_SUMMARY }, supabase,
  });
  check('缓存：非法 digest 拒绝写入', invalidDigest.status === 400
    && invalidDigest.json?.error === DATA_CODES.REQUEST_INVALID, JSON.stringify(invalidDigest.json));

  const wrongMethod = await invokeData(handler, '/api/profile/summary', { supabase });
  check('缓存：GET 方法 405', wrongMethod.status === 405, JSON.stringify(wrongMethod));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
