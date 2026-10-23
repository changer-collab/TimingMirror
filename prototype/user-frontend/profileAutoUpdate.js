// 报告发布后的画像自动解读：首次 + 每新增 2 份报告调用一次模型。
// 只发送 digest；模板兜底不写云端，避免把兜底文案冒充 AI 解读。
import {
  buildProfileDigest, profileDigestHash, profileSummaryIsFresh,
} from '../../src/agent/profileDigest.js';
import {
  summaryResponseView, validSummaryValue,
} from '../../src/agent/cloudProfileModel.js';

const AUTO_STATE_KEY = 'tm.profile.autoSummary.v1';
const AUTO_STATE_VERSION = 2;
const AUTO_REPORT_STEP = 2;
const MAX_SEEN_REPORTS = 24;

let memoryState = null;
let inFlight = null;

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readState() {
  const store = storage();
  if (store) {
    try {
      const parsed = JSON.parse(store.getItem(AUTO_STATE_KEY) || 'null');
      if (parsed && parsed.version === AUTO_STATE_VERSION) return parsed;
    } catch { /* 本地状态损坏时从空状态开始 */ }
  }
  return memoryState;
}

function writeState(state) {
  memoryState = state;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(AUTO_STATE_KEY, JSON.stringify(state));
  } catch { /* 本地状态保存失败不阻断自动更新 */ }
}

function emptyState(profileId) {
  return {
    version: AUTO_STATE_VERSION,
    profile_id: profileId,
    seen: [],
    seen_count: 0,
    last_auto_count: 0,
    last_auto_at: null,
    last_status: null,
    last_hash: null,
  };
}

// profile_key 由每份账单的标的/区间/笔数派生，逐份变化；频率状态要跟随本机画像本身。
function profileIdentity(profile) {
  const createdAt = profile?.created_at;
  return typeof createdAt === 'string' && createdAt !== '' ? createdAt : null;
}

function stateFor(profileId) {
  const current = readState();
  return current?.profile_id === profileId && current.version === AUTO_STATE_VERSION
    ? { ...emptyState(profileId), ...current, seen: Array.isArray(current.seen) ? current.seen : [] }
    : emptyState(profileId);
}

function reportKey({ profileKey, bill, bundle }) {
  const trades = Array.isArray(bill?.trades) ? bill.trades : [];
  const firstDate = trades[0]?.trade_date ?? '';
  const lastDate = trades[trades.length - 1]?.trade_date ?? '';
  return [
    profileKey,
    bundle?.valuation?.effective_date ?? '',
    bundle?.review?.meta?.verify_id ?? '',
    trades.length,
    firstDate,
    lastDate,
  ].join('|');
}

function invalidate(ctx) {
  try {
    ctx?.cloudDeps?.invalidateCloudProfile?.();
  } catch { /* 缓存失效失败不影响已保存结果 */ }
}

export async function maybeAutoUpdateProfileSummary({ ctx, profile, bill, bundle } = {}) {
  const deps = ctx?.cloudDeps;
  if (!deps || typeof deps.getProfile !== 'function'
    || typeof deps.requestProfileSummary !== 'function'
    || typeof deps.saveProfileSummary !== 'function') {
    return { ok: false, reason: 'deps-unavailable' };
  }
  const profileId = profileIdentity(profile);
  if (!profileId) return { ok: false, reason: 'profile-unavailable' };
  if (inFlight) return { ok: false, reason: 'busy' };

  const state = stateFor(profileId);
  const key = reportKey({ profileKey: profile.latest?.profile_key ?? '', bill, bundle });
  if (state.seen.includes(key)) return { ok: true, skipped: 'seen' };
  state.seen = [...state.seen, key].slice(-MAX_SEEN_REPORTS);
  state.seen_count += 1;
  writeState(state);

  let payload;
  try {
    payload = await deps.getProfile();
  } catch {
    state.last_status = 'cloud-unavailable';
    writeState(state);
    return { ok: false, reason: 'cloud-unavailable' };
  }

  const digest = buildProfileDigest({
    profile,
    facts: Array.isArray(payload?.facts) ? payload.facts : [],
  });
  const hash = digest ? await profileDigestHash(digest) : null;
  if (!digest || !hash) {
    state.last_status = 'digest-unavailable';
    writeState(state);
    return { ok: false, reason: 'digest-unavailable' };
  }

  const cachedSummary = validSummaryValue(payload?.summary);
  const cachedHash = typeof payload?.summary_source_hash === 'string' ? payload.summary_source_hash : null;
  const fresh = profileSummaryIsFresh(
    cachedSummary && cachedHash ? { summary: cachedSummary, summary_source_hash: cachedHash } : null,
    hash,
  );
  if (fresh) {
    state.last_auto_count = state.seen_count;
    state.last_status = 'fresh';
    state.last_hash = hash;
    writeState(state);
    return { ok: true, skipped: 'fresh' };
  }

  const due = state.last_auto_count === 0 || state.seen_count - state.last_auto_count >= AUTO_REPORT_STEP;
  if (!due) {
    state.last_status = 'waiting';
    writeState(state);
    return { ok: true, skipped: 'waiting' };
  }

  state.last_auto_count = state.seen_count;
  state.last_auto_at = new Date().toISOString();
  state.last_status = 'pending';
  state.last_hash = hash;
  writeState(state);

  inFlight = (async () => {
    try {
      const response = await deps.requestProfileSummary({ digest });
      const view = summaryResponseView(response);
      if (!view || view.source !== 'ai' || !validSummaryValue(view.summary)) {
        state.last_status = 'template';
        state.last_hash = hash;
        writeState(state);
        return { ok: false, reason: 'fallback', source: view?.source ?? null };
      }
      try {
        const saved = await deps.saveProfileSummary({ digest, summary: view.summary });
        state.last_status = 'saved';
        state.last_hash = saved?.source_hash ?? view.source_hash ?? hash;
        writeState(state);
        invalidate(ctx);
        return { ok: true, saved: true, source: 'ai' };
      } catch {
        state.last_status = 'save-failed';
        writeState(state);
        return { ok: false, reason: 'save-failed' };
      }
    } catch {
      state.last_status = 'model-unavailable';
      writeState(state);
      return { ok: false, reason: 'model-unavailable' };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function autoProfileSummaryState(profileId) {
  if (typeof profileId !== 'string') return null;
  const state = readState();
  return state?.profile_id === profileId ? { ...state, seen: [...state.seen] } : null;
}

export function resetAutoProfileSummaryState() {
  memoryState = null;
  const store = storage();
  if (!store) return;
  try { store.removeItem(AUTO_STATE_KEY); } catch { /* 清理失败不影响页面 */ }
}
