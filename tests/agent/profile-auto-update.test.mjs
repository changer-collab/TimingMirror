#!/usr/bin/env node
/**
 * 报告后画像自动解读测试（纯模块；不联网）
 *
 * 覆盖：首次 + 每 2 份报告触发、同报告去重、缓存新鲜跳过、
 * 模板/模型/保存失败不写云端、只发送 digest、按账号隔离本地状态。
 */
import { buildProfileDigest, profileDigestHash } from '../../src/agent/profileDigest.js';
import {
  autoProfileSummaryState,
  maybeAutoUpdateProfileSummary,
  resetAutoProfileSummaryState,
} from '../../prototype/user-frontend/profileAutoUpdate.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

globalThis.localStorage = new MemoryStorage();

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const SUMMARY = Object.freeze({
  schema_version: 1,
  headline: '交易有记录，先看样本',
  summary: '账单与行为记录已接入，继续观察。',
  strengths: [],
  blind_spots: [],
  next_actions: [],
  confidence: 'medium',
  data_limits: [],
});

const PROFILE_ID = '2026-01-01T00:00:00.000Z';
const PROFILE_ID_B = '2026-02-01T00:00:00.000Z';

function profile({ tradeCount = 24, history = 3, profileKey = 'abcd1234', createdAt = PROFILE_ID } = {}) {
  return {
    version: 1,
    created_at: createdAt,
    observations: history,
    history: Array.from({ length: history }, (_, index) => ({ at: `2026-0${index + 1}-01T00:00:00.000Z` })),
    latest: {
      version: 1,
      profile_key: profileKey,
      bill: {
        trade_count: tradeCount,
        first_date: '2025-01-02',
        last_date: '2025-06-30',
      },
      outcome: { actual_ret: 0.0412, ghost_ret: 0.0731, drag: -0.0319, drag_money: -1590 },
      pgr: { pgr: 0.8, plr: 0.5 },
      behavior: { patterns: [] },
      tags: [],
      rules: { active_count: 2, version_count: 5 },
    },
  };
}

function bill(contextId = 'bill-1') {
  return {
    contextId,
    trades: [
      { trade_date: '2025-01-02' },
      { trade_date: '2025-03-31' },
      { trade_date: '2025-06-30' },
    ],
  };
}

const BUNDLE = Object.freeze({
  valuation: { effective_date: '2025-06-30' },
  review: { meta: { verify_id: 'V-abcdef12' } },
});

async function cachedFor(profileValue) {
  const digest = buildProfileDigest({ profile: profileValue, facts: [] });
  return { summary: SUMMARY, hash: await profileDigestHash(digest) };
}

function aiResponse() {
  return {
    ok: true,
    source: 'ai',
    source_hash: 'a'.repeat(64),
    fallback_reason: null,
    summary: SUMMARY,
  };
}

function makeCtx({ cached = null, response = aiResponse(), failModel = false, failSave = false } = {}) {
  const counts = { requests: 0, saves: 0, invalidations: 0 };
  const requestArgs = [];
  const ctx = {
    cloudDeps: {
      async getProfile() {
        return {
          ok: true,
          facts: [],
          summary: cached?.summary ?? null,
          summary_source_hash: cached?.hash ?? null,
        };
      },
      async requestProfileSummary(args) {
        counts.requests += 1;
        requestArgs.push(args);
        if (failModel) throw new Error('model down');
        return response;
      },
      async saveProfileSummary() {
        counts.saves += 1;
        if (failSave) throw new Error('save down');
        return { ok: true, source_hash: 'b'.repeat(64) };
      },
      invalidateCloudProfile() {
        counts.invalidations += 1;
      },
    },
  };
  return { ctx, counts, requestArgs };
}

/* ==== 首次 + 每 2 份 ==== */
{
  resetAutoProfileSummaryState();
  const firstProfile = profile({ tradeCount: 24, history: 3 });
  const first = makeCtx();
  const firstResult = await maybeAutoUpdateProfileSummary({
    ctx: first.ctx, profile: firstProfile, bill: bill('bill-1'), bundle: BUNDLE,
  });
  check('首次报告：调用一次并保存', firstResult.ok && firstResult.saved === true
    && first.counts.requests === 1 && first.counts.saves === 1
    && first.counts.invalidations === 1, JSON.stringify(firstResult));
  check('首次报告：请求只含 digest', first.requestArgs.length === 1
    && Object.keys(first.requestArgs[0]).join(',') === 'digest'
    && !!first.requestArgs[0].digest, JSON.stringify(first.requestArgs[0]));
  check('首次报告：状态为已保存', autoProfileSummaryState(PROFILE_ID)?.last_status === 'saved');

  const repeat = await maybeAutoUpdateProfileSummary({
    ctx: first.ctx, profile: firstProfile, bill: bill('bill-1-reimported'), bundle: BUNDLE,
  });
  check('同一报告重复导入（会话 id 不同）：不重复调用', repeat.ok && repeat.skipped === 'seen'
    && first.counts.requests === 1, JSON.stringify(repeat));

  const cached = await cachedFor(firstProfile);
  const second = makeCtx({ cached });
  const secondResult = await maybeAutoUpdateProfileSummary({
    ctx: second.ctx,
    profile: profile({ tradeCount: 25, history: 4, profileKey: 'bbbb2222' }),
    bill: bill('bill-2'),
    bundle: BUNDLE,
  });
  check('第 2 份报告：换账单指纹但同画像，摘要过期也未到间隔，不调用', secondResult.ok
    && secondResult.skipped === 'waiting' && second.counts.requests === 0, JSON.stringify(secondResult));

  const third = makeCtx({ cached });
  const thirdResult = await maybeAutoUpdateProfileSummary({
    ctx: third.ctx,
    profile: profile({ tradeCount: 26, history: 5, profileKey: 'cccc3333' }),
    bill: bill('bill-3'),
    bundle: BUNDLE,
  });
  check('第 3 份报告：达到间隔，再次调用并保存', thirdResult.ok && thirdResult.saved === true
    && third.counts.requests === 1 && third.counts.saves === 1, JSON.stringify(thirdResult));
}

/* ==== 缓存新鲜 / 失败分支 ==== */
{
  resetAutoProfileSummaryState();
  const freshProfile = profile();
  const cached = await cachedFor(freshProfile);
  const fresh = makeCtx({ cached });
  const freshResult = await maybeAutoUpdateProfileSummary({
    ctx: fresh.ctx, profile: freshProfile, bill: bill('bill-1'), bundle: BUNDLE,
  });
  check('缓存新鲜：不调用模型', freshResult.ok && freshResult.skipped === 'fresh'
    && fresh.counts.requests === 0, JSON.stringify(freshResult));

  resetAutoProfileSummaryState();
  const template = makeCtx({ response: { ...aiResponse(), source: 'template', fallback_reason: 'model_timeout' } });
  const templateResult = await maybeAutoUpdateProfileSummary({
    ctx: template.ctx, profile: profile(), bill: bill('bill-1'), bundle: BUNDLE,
  });
  check('模板兜底：不保存、不冒充 AI', templateResult.ok === false && templateResult.reason === 'fallback'
    && template.counts.requests === 1 && template.counts.saves === 0
    && autoProfileSummaryState(PROFILE_ID)?.last_status === 'template', JSON.stringify(templateResult));

  resetAutoProfileSummaryState();
  const modelDown = makeCtx({ failModel: true });
  const modelDownResult = await maybeAutoUpdateProfileSummary({
    ctx: modelDown.ctx, profile: profile(), bill: bill('bill-1'), bundle: BUNDLE,
  });
  check('模型异常：不抛出、不保存', modelDownResult.ok === false && modelDownResult.reason === 'model-unavailable'
    && modelDown.counts.saves === 0, JSON.stringify(modelDownResult));

  resetAutoProfileSummaryState();
  const saveDown = makeCtx({ failSave: true });
  const saveDownResult = await maybeAutoUpdateProfileSummary({
    ctx: saveDown.ctx, profile: profile(), bill: bill('bill-1'), bundle: BUNDLE,
  });
  check('保存失败：报告不受影响', saveDownResult.ok === false && saveDownResult.reason === 'save-failed'
    && saveDown.counts.saves === 1 && saveDown.counts.invalidations === 0, JSON.stringify(saveDownResult));
}

/* ==== 画像身份隔离与缺依赖 ==== */
{
  resetAutoProfileSummaryState();
  const userA = makeCtx();
  await maybeAutoUpdateProfileSummary({
    ctx: userA.ctx, profile: profile({ createdAt: PROFILE_ID }), bill: bill('bill-1'), bundle: BUNDLE,
  });
  const userB = makeCtx();
  const userBResult = await maybeAutoUpdateProfileSummary({
    ctx: userB.ctx, profile: profile({ profileKey: '12345678', createdAt: PROFILE_ID_B }), bill: bill('bill-1'), bundle: BUNDLE,
  });
  check('画像身份切换：本地频率状态不串号', userBResult.saved === true
    && userB.counts.requests === 1 && autoProfileSummaryState(PROFILE_ID_B)?.last_status === 'saved',
  JSON.stringify(userBResult));

  const noDeps = await maybeAutoUpdateProfileSummary({ ctx: {}, profile: profile() });
  const noProfile = await maybeAutoUpdateProfileSummary({ ctx: userA.ctx, profile: { latest: null } });
  check('缺少依赖或画像：安静跳过', noDeps.reason === 'deps-unavailable'
    && noProfile.reason === 'profile-unavailable', JSON.stringify({ noDeps, noProfile }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
