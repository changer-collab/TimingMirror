#!/usr/bin/env node
/**
 * 画像事实回流（问答页）—— 离线单测（合成数据；不联网）
 *
 * 覆盖：云端事实归一化 → saved_facts 映射、去重、排序、截断与总数；
 *       缓存冷时只按需读取画像且不触发账单列表；空/失败输入不产生事实。
 * 运行：node tests/agent/cloud-profile-facts.test.mjs（或 npm run check）
 */
import {
  PROFILE_FACT_KIND_LABELS,
  normalizeCloudFacts,
} from '../../src/agent/cloudProfileModel.js';
import { savedFactsView } from '../../src/agent/qaChips.js';
import {
  appendCachedCloudFacts,
  getCachedCloudFacts,
  invalidateCloudProfile,
  loadCloudFacts,
} from '../../prototype/user-frontend/cloudProfile.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const uuid = (n) => `0000000${n}-1111-4111-8111-11111111111${n}`;
const fact = (n, overrides = {}) => ({
  id: uuid(n),
  kind: 'preference',
  key: `key_${n}`,
  value: `希望减少第 ${n} 类短线交易`,
  evidence: `我希望减少第 ${n} 类短线交易`,
  source: 'chat',
  created_at: `2026-10-${String(10 + n).padStart(2, '0')}T08:00:00.000Z`,
  ...overrides,
});

/* ==== ① 云端事实归一化 ==== */
{
  const payload = {
    facts: [
      fact(1, { kind: 'goal', source: 'manual' }),
      { ...fact(2), id: 'not-a-uuid' },
      fact(3, { kind: 'unknown_kind' }),
      fact(4, { value: '   ' }),
    ],
  };
  const rows = normalizeCloudFacts(payload);
  check('归一化：只保留合法 id/kind/非空 value', rows.length === 1
    && rows[0].kind === 'goal' && rows[0].source === 'manual', JSON.stringify(rows));
  check('归一化：空 payload 返回空数组', normalizeCloudFacts(null).length === 0
    && normalizeCloudFacts({ facts: 'nope' }).length === 0);
}

/* ==== ② saved_facts 视图：映射、排序、去重、截断 ==== */
{
  check('标签：五种画像事实 kind 均有中文标签', Object.keys(PROFILE_FACT_KIND_LABELS).length === 5
    && PROFILE_FACT_KIND_LABELS.goal === '目标' && PROFILE_FACT_KIND_LABELS.risk_tolerance === '风险承受');

  const rows = [
    fact(1, { kind: 'goal', key: 'long_term', value: '希望做长线', created_at: '2026-10-10T08:00:00.000Z' }),
    fact(2, { kind: 'constraint', value: '不碰次新股', created_at: '2026-10-12T08:00:00.000Z' }),
    fact(3, { kind: 'habit', value: '容易追高', created_at: '2026-10-11T08:00:00.000Z' }),
    fact(4, { kind: 'preference', value: '偏好低波动', created_at: '2026-10-13T08:00:00.000Z' }),
    fact(5, { kind: 'risk_tolerance', value: '能承受两成回撤', created_at: '2026-10-14T08:00:00.000Z' }),
    fact(6, { kind: 'goal', key: 'long_term', value: '希望做长线', created_at: '2026-10-09T08:00:00.000Z' }),
    fact(7, { kind: 'preference', value: '偏好红利股', created_at: '2026-10-08T08:00:00.000Z' }),
  ];
  const snapshot = JSON.stringify(rows);
  const view = savedFactsView(rows);
  check('视图：按时间倒序取最近 5 条，总数保留', view.facts.length === 5 && view.total === 6,
    JSON.stringify(view));
  check('视图：首条为最新事实', view.facts[0].value === '能承受两成回撤', view.facts[0]?.value);
  check('视图：kind/key/value 去重后保留较新一条', view.facts.filter((f) => f.value === '希望做长线').length === 1
    && view.facts.find((f) => f.value === '希望做长线')?.evidence.includes('第 1 类'), JSON.stringify(view.facts));
  check('视图：映射中文标签并保留原话', view.facts[0].label === '风险承受'
    && view.facts[0].evidence.includes('第 5 类'), JSON.stringify(view.facts[0]));
  check('视图：不修改输入数组', JSON.stringify(rows) === snapshot);

  const empty = savedFactsView(null);
  check('视图：空输入不产生事实', empty.facts.length === 0 && empty.total === 0, JSON.stringify(empty));
}

/* ==== ③ 缓存冷时按需读取画像，不触发账单列表 ==== */
{
  invalidateCloudProfile();
  check('缓存：冷缓存返回 null', getCachedCloudFacts() === null);
  appendCachedCloudFacts([fact(1)]);
  check('缓存：冷缓存追加为无操作', getCachedCloudFacts() === null);

  const calls = { profile: 0, bills: 0 };
  const ctx = {
    cloudDeps: {
      async getProfile() {
        calls.profile += 1;
        return { facts: [fact(1, { kind: 'goal' }), fact(2)] };
      },
      async listBills() {
        calls.bills += 1;
        return { bills: [] };
      },
    },
  };
  const loaded = await loadCloudFacts(ctx);
  check('按需读取：只调用画像接口，不拉账单列表', loaded.length === 2
    && calls.profile === 1 && calls.bills === 0, JSON.stringify({ loaded, calls }));
  check('按需读取：结果可直接进入 saved_facts 视图', savedFactsView(loaded).facts.length === 2);

  const failing = {
    cloudDeps: { async getProfile() { throw new Error('cloud unavailable'); } },
  };
  let failed = null;
  try { await loadCloudFacts(failing); } catch (error) { failed = error; }
  check('按需读取：失败时抛错交由调用方降级', failed instanceof Error, failed && failed.message);
  check('按需读取：没有 cloudDeps 时返回空数组', (await loadCloudFacts({})).length === 0);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
