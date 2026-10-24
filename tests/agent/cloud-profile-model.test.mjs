#!/usr/bin/env node
/**
 * 云端画像模型测试（纯函数；不联网）
 *
 * 覆盖：账单/事实结构过滤、云端快照只读画像、摘要响应校验。
 */
import {
  cloudProfileFromBills,
  normalizeCloudBills,
  normalizeCloudFacts,
  summaryFallbackText,
  summaryResponseView,
  validSummaryValue,
} from '../../src/agent/cloudProfileModel.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BILL_ID = '11111111-1111-4111-8111-111111111111';
const FACT_ID = '22222222-2222-4222-8222-222222222222';

function snapshot(overrides = {}) {
  return {
    version: 1,
    at: '2026-10-22T08:00:00.000Z',
    profile_key: 'abcdef01',
    bill: { trade_count: 24, first_date: '2024-03-01', last_date: '2024-10-09' },
    outcome: {
      actual_ret: 0.0412,
      ghost_ret: 0.0731,
      drag: -0.0319,
      drag_money: -3190,
      display: { actual_ret: '+4.12%', ghost_ret: '+7.31%', drag: '-3.19pp', drag_money: '-¥3,190' },
    },
    review: { portfolio_published: true },
    dimensions: [{ key: 'behavior', label: '行为', value: '追高 3 笔', note: '样本 5' }],
    tags: [{ tag_id: 'chase_high_buy', label: '追高买入', evidence: '命中 3 笔 / 已评估 5 笔' }],
    ...overrides,
  };
}

/* ==== 账单归一化 ==== */
{
  const payload = {
    ok: true,
    bills: [
      {
        id: BILL_ID,
        imported_at: '2026-10-22T08:00:00.000Z',
        effective_date: '2024-10-09',
        payload_mode: 'summary',
        has_payload: false,
        metadata: { trades_count: 24, warnings_count: 0, date_from: '2024-03-01', date_to: '2024-10-09', symbol_count: 2 },
        snapshot: snapshot(),
        snapshot_at: '2026-10-22T08:01:00.000Z',
        extra: 'ignored',
      },
      { id: 'not-a-uuid', imported_at: '2026-10-21T08:00:00.000Z' },
      { id: '33333333-3333-4333-8333-333333333333', imported_at: '2026-10-23T08:00:00.000Z', payload_mode: 'bogus', metadata: { trades_count: 'x' } },
    ],
  };
  const bills = normalizeCloudBills(payload);
  check('账单：过滤非法 id 并保留两份', bills.length === 2, JSON.stringify(bills));
  check('账单：按导入时间倒序', bills[0].imported_at > bills[1].imported_at, bills.map((b) => b.imported_at).join(','));
  check('账单：只保留白名单字段', !('extra' in bills[0])
    && Object.keys(bills[0]).join(',') === 'id,imported_at,effective_date,payload_mode,has_payload,metadata,snapshot,snapshot_at', Object.keys(bills[0]).join(','));
  check('账单：非法模式回退 summary、非法统计写 null',
    bills.find((b) => b.id === '33333333-3333-4333-8333-333333333333').payload_mode === 'summary'
    && bills.find((b) => b.id === '33333333-3333-4333-8333-333333333333').metadata.trades_count === null);
  const withSnapshot = bills.find((b) => b.id === BILL_ID);
  check('账单：快照只保留页面字段与已发布状态',
    withSnapshot.snapshot?.review.portfolio_published === true
    && withSnapshot.snapshot?.outcome?.display?.drag_money === '-¥3,190'
    && withSnapshot.snapshot?.tags?.[0]?.label === '追高买入', JSON.stringify(withSnapshot.snapshot));
  check('账单：非对象输入返回空数组', normalizeCloudBills(null).length === 0 && normalizeCloudBills({ bills: 'x' }).length === 0);
}

/* ==== 事实归一化 ==== */
{
  const facts = normalizeCloudFacts({
    ok: true,
    facts: [
      { id: FACT_ID, kind: 'constraint', key: 'max_position', value: '仓位控制在五成以内', evidence: '把仓位控制在五成以内', source: 'chat', created_at: '2026-10-22T08:00:00.000Z' },
      { id: 'bad', kind: 'constraint', value: 'x' },
      { id: '44444444-4444-4444-8444-444444444444', kind: 'unknown', value: 'x' },
      { id: '55555555-5555-4555-8555-555555555555', kind: 'habit', value: '   ' },
    ],
  });
  check('事实：过滤非法 id / 类型 / 空值', facts.length === 1 && facts[0].id === FACT_ID, JSON.stringify(facts));
  check('事实：保留原话证据与来源', facts[0].evidence === '把仓位控制在五成以内' && facts[0].source === 'chat');
}

/* ==== 云端快照画像 ==== */
{
  const bills = normalizeCloudBills({
    ok: true,
    bills: [
      { id: BILL_ID, imported_at: '2026-10-22T08:00:00.000Z', payload_mode: 'summary', metadata: { trades_count: 24 }, snapshot: snapshot() },
      { id: '66666666-6666-4666-8666-666666666666', imported_at: '2026-10-23T08:00:00.000Z', payload_mode: 'summary', metadata: { trades_count: 10 } },
    ],
  });
  const profile = cloudProfileFromBills(bills);
  check('云端画像：只有带已发布快照的账单进入历史', profile && profile.observations === 1, JSON.stringify(profile && profile.observations));
  check('云端画像：最新快照字段可用于摘要', profile.latest.profile_key === 'abcdef01'
    && profile.latest.bill.trade_count === 24 && profile.history.length === 1);
  check('云端画像：没有快照返回 null',
    cloudProfileFromBills([{ id: BILL_ID, snapshot: snapshot({ review: { portfolio_published: false } }) }]) === null);

  const v2 = {
    version: 2,
    at: '2026-10-23T08:00:00.000Z',
    profile_key: 'abcdef01',
    bill: { trade_count: 10 },
    review: { portfolio_published: true },
    profile: { latest: snapshot({ bill: { trade_count: 10 } }) },
    report: { status: 'ok', fileName: 'x.csv' },
    report_available: true,
  };
  const v2bills = normalizeCloudBills({
    ok: true,
    bills: [{ id: BILL_ID, imported_at: '2026-10-23T08:00:00.000Z', payload_mode: 'full', metadata: { trades_count: 10 }, snapshot: v2 }],
  });
  check('云端画像：v2 快照解包到画像 latest',
    v2bills[0].snapshot?.bill?.trade_count === 10
    && v2bills[0].snapshot?.outcome?.display?.drag_money === '-¥3,190'
    && v2bills[0].snapshot?.tags?.[0]?.label === '追高买入', JSON.stringify(v2bills[0].snapshot));
  const mismatch = JSON.parse(JSON.stringify(v2));
  mismatch.profile.latest.profile_key = 'ffffffff';
  check('云端画像：v2 画像键不一致时丢弃',
    normalizeCloudBills({ ok: true, bills: [{ id: BILL_ID, snapshot: mismatch }] })[0].snapshot === null);
}

/* ==== 摘要校验 ==== */
{
  const value = validSummaryValue({
    schema_version: 1,
    headline: '追高是主要损耗来源',
    summary: '最近 24 笔成交里，追高买入集中在两次行情高点。',
    keywords: ['追高买入', '止损偏慢', '交易频率高', '这个关键词明显超过十二个字'],
    strengths: ['亏损时愿意止损', '', '仓位集中'],
    blind_spots: ['卖出后上涨的情况没有记录'],
    next_actions: ['下次买入前写下理由'],
    confidence: 'medium',
    data_limits: ['交易样本少于 20 笔'],
    extra: 'ignored',
  });
  check('摘要：保留规定的九个字段', value && Object.keys(value).join(',') === 'schema_version,headline,summary,keywords,strengths,blind_spots,next_actions,confidence,data_limits', Object.keys(value).join(','));
  check('摘要：关键词最多 6 个、每个最多 12 字', value.keywords.length === 4
    && value.keywords[0] === '追高买入'
    && value.keywords.every((word) => [...word].length <= 12), JSON.stringify(value.keywords));
  check('摘要：列表去空并截断', value.strengths.length === 2 && value.strengths[1] === '仓位集中');
  check('摘要：非规定置信度降为 low', validSummaryValue({ headline: 'x', summary: 'y', confidence: 'certain' }).confidence === 'low');
  check('摘要：缺少标题或正文返回 null',
    validSummaryValue({ headline: '', summary: 'y' }) === null
    && validSummaryValue({ headline: 'x' }) === null
    && validSummaryValue(null) === null);

  const response = summaryResponseView({
    ok: true,
    source: 'ai',
    source_hash: 'a'.repeat(64),
    fallback_reason: null,
    fallback_detail: null,
    summary: value,
  });
  check('摘要响应：保留来源与哈希', response && response.source === 'ai' && response.source_hash === 'a'.repeat(64), JSON.stringify(response));
  check('摘要响应：保留失败详情（有界）', summaryResponseView({
    ok: true,
    source: 'template',
    fallback_reason: 'model_unavailable',
    fallback_detail: 'upstream_request',
    summary: value,
  })?.fallback_detail === 'upstream_request');
  check('摘要响应：超长失败详情截断', summaryResponseView({
    ok: true,
    source: 'template',
    fallback_reason: 'model_unavailable',
    fallback_detail: 'x'.repeat(200),
    summary: value,
  })?.fallback_detail.length === 40);
  check('摘要响应：非法来源降为模板', summaryResponseView({ ok: true, source: 'gpt', summary: value }).source === 'template');
  check('摘要响应：ok=false 或摘要非法返回 null',
    summaryResponseView({ ok: false, source: 'ai', summary: value }) === null
    && summaryResponseView({ ok: true, source: 'ai', summary: { headline: 'x' } }) === null);

  check('摘要回退：已知原因映射为中文', summaryFallbackText('model_timeout') === '模型响应超时。'
    && summaryFallbackText('model_response_invalid') === '模型返回内容未通过校验。');
  check('摘要回退：失败详情优先给出具体说明',
    summaryFallbackText('model_unavailable', 'upstream_auth') === '服务端模型凭据未通过校验，请联系维护者。'
    && summaryFallbackText('model_unavailable', 'upstream_forbidden') === '当前模型没有访问权限，请联系维护者。'
    && summaryFallbackText('model_unavailable', 'upstream_rate_limited') === '模型请求被限流，已自动重试一次。'
    && summaryFallbackText('model_unavailable', 'upstream_request') === '模型请求被拒绝，可能是模型名或参数配置问题。'
    && summaryFallbackText('model_unavailable', 'upstream_unavailable') === '模型服务临时不可用，已自动重试一次。'
    && summaryFallbackText('model_unavailable', 'upstream_timeout') === '模型响应超时。'
    && summaryFallbackText('model_unavailable', 'upstream_response') === '模型返回内容格式异常。');
  check('摘要回退：未知详情回退到原因文案',
    summaryFallbackText('model_unavailable', 'not_a_detail') === summaryFallbackText('model_unavailable'));
  check('摘要回退：未知原因使用通用文案', summaryFallbackText('something_else') === '模型暂时不可用。'
    && summaryFallbackText(null) === '模型暂时不可用。');
  check('摘要回退：页面不出现原始错误码', !/model_|upstream_/u.test(
    `${summaryFallbackText('model_timeout')}${summaryFallbackText('model_response_invalid')}${summaryFallbackText('x')}`
    + `${summaryFallbackText('model_unavailable', 'upstream_auth')}${summaryFallbackText('model_unavailable', 'upstream_request')}`,
  ));
  check('摘要回退：未知详情不显示原始代码', !/upstream_|model_/u.test(summaryFallbackText('model_unavailable', 'upstream_bogus')));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
