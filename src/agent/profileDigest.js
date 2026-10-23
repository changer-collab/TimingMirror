// 画像摘要 digest：只放确定性统计与用户明确陈述的事实，供 AI 解读使用。
// 构建顺序与 server/site-functions/profileSummary.mjs 的规范化输出保持一致，
// 两边对同一 digest 计算的 SHA-256 必须相同，才能判断云端缓存是否过期。
export const PROFILE_DIGEST_VERSION = 1;

export const PROFILE_DIGEST_LIMITS = Object.freeze({
  maxTags: 8,
  maxPatterns: 5,
  maxFacts: 20,
  maxLimits: 5,
});

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values, max) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const item = text(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

export function buildProfileDigest({ profile = null, facts = [] } = {}) {
  const latest = profile?.latest ?? null;
  if (!latest || typeof latest.profile_key !== 'string' || !/^[0-9a-f]{8}$/u.test(latest.profile_key)) {
    return null;
  }
  const history = Array.isArray(profile?.history) ? profile.history : [];
  const bill = latest.bill ?? {};
  const outcome = latest.outcome ?? null;
  const pgr = latest.pgr ?? null;
  const patterns = Array.isArray(latest.behavior?.patterns) ? latest.behavior.patterns : [];
  const tags = Array.isArray(latest.tags) ? latest.tags.map((tag) => tag?.label) : [];
  const outcomeMissing = !outcome || finiteOrNull(outcome.actual_ret) === null;
  const tradeCount = finiteOrNull(bill.trade_count) ?? 0;
  const limits = [];
  if (history.length < 3) limits.push('账单样本少于 3 份');
  if (tradeCount < 20) limits.push('交易样本少于 20 笔');
  if (outcomeMissing) limits.push('尚未发布组合结果');
  if (!pgr) limits.push('PGR/PLR 不可用');
  const factRows = [];
  const seenFacts = new Set();
  for (const item of Array.isArray(facts) ? facts : []) {
    const kind = text(item?.kind);
    const key = text(item?.key);
    const value = text(item?.value);
    if (!kind || !key || !value) continue;
    const dedupe = `${kind}\n${key}\n${value}`;
    if (seenFacts.has(dedupe)) continue;
    seenFacts.add(dedupe);
    factRows.push({ kind, key, value });
    if (factRows.length >= PROFILE_DIGEST_LIMITS.maxFacts) break;
  }
  return {
    profile_key: latest.profile_key,
    bills: {
      count: history.length,
      date_from: typeof bill.first_date === 'string' ? bill.first_date : null,
      date_to: typeof bill.last_date === 'string' ? bill.last_date : null,
    },
    metrics: {
      actual_return: finiteOrNull(outcome?.actual_ret),
      benchmark_return: finiteOrNull(outcome?.ghost_ret),
      drag_pp: finiteOrNull(outcome?.drag),
      drag_amount: finiteOrNull(outcome?.drag_money),
      trade_count: tradeCount,
      win_rate: null,
      pgr: finiteOrNull(pgr?.pgr),
      plr: finiteOrNull(pgr?.plr),
    },
    behavior: {
      tags: uniqueStrings(tags, PROFILE_DIGEST_LIMITS.maxTags),
      patterns: uniqueStrings(patterns.filter((pattern) => pattern?.status === '成立').map((pattern) => pattern?.name), PROFILE_DIGEST_LIMITS.maxPatterns),
    },
    rules: {
      total: finiteOrNull(latest.rules?.version_count) ?? 0,
      kept: finiteOrNull(latest.rules?.active_count) ?? 0,
      warned: 0,
    },
    facts: factRows,
    limits: uniqueStrings(limits, PROFILE_DIGEST_LIMITS.maxLimits),
  };
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function profileDigestHash(digest) {
  if (!digest || typeof digest !== 'object') return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(digest));
  return hex(await subtle.digest('SHA-256', bytes));
}

export function profileSummaryIsFresh(cached, digestHash) {
  return Boolean(cached && digestHash && cached.summary_source_hash === digestHash && cached.summary);
}
