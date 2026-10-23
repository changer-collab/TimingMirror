#!/usr/bin/env node
/**
 * 客户端画像 digest 测试（纯模块；不联网）
 *
 * 覆盖：字段映射、确定性顺序、事实去重、限制项，以及与 service 端规范化
 * SHA-256 的一致性（缓存键必须两端相同）。
 */
import {
  PROFILE_DIGEST_LIMITS,
  buildProfileDigest,
  profileDigestHash,
  profileSummaryIsFresh,
} from '../../src/agent/profileDigest.js';
import {
  normalizeProfileSummaryRequest,
  profileDigestHash as serverDigestHash,
} from '../../server/site-functions/profileSummary.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const PROFILE = Object.freeze({
  version: 1,
  observations: 5,
  history: [
    { at: '2026-07-01T00:00:00.000Z' },
    { at: '2026-08-01T00:00:00.000Z' },
    { at: '2026-09-01T00:00:00.000Z' },
  ],
  latest: {
    version: 1,
    profile_key: 'abcd1234',
    bill: {
      trade_count: 24,
      symbol_count: 6,
      first_date: '2026-01-05',
      last_date: '2026-09-30',
      span_days: 268,
    },
    outcome: { actual_ret: 0.0412, ghost_ret: 0.0731, drag: -0.0319, drag_money: -1590 },
    pgr: { pgr: 0.6123, plr: 0.4802 },
    behavior: {
      patterns: [
        { pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 3 },
        { pattern_id: 'quick_flip', name: '快进快出', status: '证据不足', sample_n: 0 },
      ],
    },
    tags: [
      { tag_id: 'chase_high_buy', label: '追高买入' },
      { tag_id: 'chase_high_buy', label: '追高买入' },
    ],
    rules: { active_count: 2, version_count: 5 },
  },
});

const FACTS = [
  { id: 'f1', kind: 'goal', key: 'holding_horizon', value: '希望减少短线交易' },
  { id: 'f2', kind: 'goal', key: 'holding_horizon', value: '希望减少短线交易' },
  { id: 'f3', kind: 'constraint', key: 'max_position', value: '仓位不超过五成' },
];

const digest = buildProfileDigest({ profile: PROFILE, facts: FACTS });

check('digest：无画像时返回 null', buildProfileDigest() === null);
check('digest：profile_key 非法时返回 null', buildProfileDigest({ profile: { latest: { profile_key: 'XYZ' } } }) === null);
check('digest：账单数取历史长度', digest?.bills.count === 3, JSON.stringify(digest?.bills));
check('digest：账单日期来自 latest.bill', digest?.bills.date_from === '2026-01-05'
  && digest?.bills.date_to === '2026-09-30');
check('digest：指标映射与空值', digest?.metrics.actual_return === 0.0412
  && digest.metrics.benchmark_return === 0.0731
  && digest.metrics.drag_pp === -0.0319
  && digest.metrics.drag_amount === -1590
  && digest.metrics.trade_count === 24
  && digest.metrics.win_rate === null
  && digest.metrics.pgr === 0.6123
  && digest.metrics.plr === 0.4802, JSON.stringify(digest?.metrics));
check('digest：标签去重、模式只取成立', digest?.behavior.tags.length === 1
  && digest.behavior.tags[0] === '追高买入'
  && digest.behavior.patterns.join(',') === '追高买入', JSON.stringify(digest?.behavior));
check('digest：规则计数', digest?.rules.total === 5 && digest.rules.kept === 2 && digest.rules.warned === 0);
check('digest：事实去重且只保留 kind/key/value', digest?.facts.length === 2
  && JSON.stringify(digest.facts[0]) === JSON.stringify({ kind: 'goal', key: 'holding_horizon', value: '希望减少短线交易' }), JSON.stringify(digest?.facts));
check('digest：样本充足时不写限制项', digest?.limits.length === 0, JSON.stringify(digest?.limits));

const lowProfile = {
  latest: {
    profile_key: 'abcd1234',
    bill: { trade_count: 4, first_date: '2026-09-01', last_date: '2026-09-30' },
    outcome: null,
    pgr: null,
    behavior: { patterns: [] },
    tags: [],
    rules: { active_count: 0, version_count: 0 },
  },
  history: [{ at: '2026-09-01T00:00:00.000Z' }],
};
const lowDigest = buildProfileDigest({ profile: lowProfile, facts: [] });
check('digest：低样本写入限制项', lowDigest?.limits.join('|') === '账单样本少于 3 份|交易样本少于 20 笔|尚未发布组合结果|PGR/PLR 不可用', JSON.stringify(lowDigest?.limits));
check('digest：事实数量受限', buildProfileDigest({
  profile: PROFILE,
  facts: Array.from({ length: 25 }, (_, index) => ({ kind: 'goal', key: `k${index}`, value: `v${index}` })),
}).facts.length === PROFILE_DIGEST_LIMITS.maxFacts);

/* 与 service 端规范化后的哈希必须一致 */
{
  const normalized = normalizeProfileSummaryRequest({ digest: lowDigest });
  check('digest：service 端接受客户端结构', normalized.ok, JSON.stringify(normalized));
  const clientHash = await profileDigestHash(normalized.digest);
  const serviceHash = await serverDigestHash(normalized.digest);
  check('digest：客户端与服务端哈希一致', /^[0-9a-f]{64}$/u.test(clientHash) && clientHash === serviceHash, `${clientHash} vs ${serviceHash}`);

  const mainNormalized = normalizeProfileSummaryRequest({ digest });
  check('digest：主画像结构也被服务端接受', mainNormalized.ok, JSON.stringify(mainNormalized));
  check('digest：主画像两端哈希一致', await profileDigestHash(mainNormalized.digest) === await serverDigestHash(mainNormalized.digest));
}

check('fresh：哈希与摘要同时匹配才算新鲜', profileSummaryIsFresh({ summary_source_hash: 'a'.repeat(64), summary: { headline: 'x' } }, 'a'.repeat(64)) === true
  && profileSummaryIsFresh({ summary_source_hash: 'b'.repeat(64), summary: { headline: 'x' } }, 'a'.repeat(64)) === false
  && profileSummaryIsFresh({ summary_source_hash: 'a'.repeat(64), summary: null }, 'a'.repeat(64)) === false
  && profileSummaryIsFresh(null, 'a'.repeat(64)) === false);
check('hash：非法输入返回 null', await profileDigestHash(null) === null);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
