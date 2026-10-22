// 本地用户画像存储（非 Agent）：只保存派生统计与候选事件，不保存成交明细、文件名或 CSV。
// 画像跨账单延续：每份已发布报告记一次观察；同一会话同一报告只记一次。
import { contractRuleSet } from '../../src/demo/adapter.js';
import {
  PROFILE_VERSION, emptyProfile, buildProfileSnapshot, mergeProfile, withCandidateEvent, withRuleState,
  withBehaviorAnalysis,
} from '../../src/engine/userProfile.js';

const PROFILE_KEY = 'tm.profile.v1';
const observed = new Set();

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function ruleStateOf(versions = []) {
  const list = Array.isArray(versions) ? versions : [];
  const current = contractRuleSet(list).current;
  return {
    active_templates: current.map((r) => r.template_id),
    active_count: current.length,
    version_count: list.length,
  };
}

export function loadProfile() {
  const store = storage();
  if (!store) return emptyProfile();
  try {
    const parsed = JSON.parse(store.getItem(PROFILE_KEY) || 'null');
    if (parsed && parsed.version === PROFILE_VERSION && Number.isFinite(parsed.observations)) {
      return { ...emptyProfile(), ...parsed };
    }
  } catch { /* 本地记录损坏时按空画像处理，不影响报告 */ }
  return emptyProfile();
}

export function saveProfile(profile) {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(PROFILE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function clearProfile() {
  observed.clear();
  const store = storage();
  if (!store) return;
  try { store.removeItem(PROFILE_KEY); } catch { /* 清理失败不影响页面 */ }
}

export function buildObservationSnapshot({ bundle, bill, ruleState = null, at = new Date().toISOString() } = {}) {
  return buildProfileSnapshot({
    report: bundle?.insights?.portfolio?.report ?? null,
    behavior: bundle?.insights?.behavior?.data ?? null,
    stockSelf: bundle?.insights?.stock_self?.data ?? null,
    pgr: bundle?.insights?.pgr?.data ?? null,
    review: bundle?.review ?? null,
    trades: bill?.trades ?? [],
    ruleState,
    at,
  });
}

export function recordReportObservation({ bundle, bill, ruleState = null, at = new Date().toISOString() } = {}) {
  const snapshot = buildObservationSnapshot({ bundle, bill, ruleState, at });
  if (bundle?.review?.portfolio_published !== true) {
    return { profile: loadProfile(), snapshot, recorded: false, reason: '组合结果未发布：本次不记入画像' };
  }
  const key = [
    snapshot.profile_key,
    bundle?.valuation?.effective_date ?? '',
    bundle?.review?.meta?.verify_id ?? '',
  ].join('|');
  if (observed.has(key)) {
    return { profile: loadProfile(), snapshot, recorded: false, reason: '本次会话已记录同一报告' };
  }
  const profile = mergeProfile(loadProfile(), snapshot, { at });
  saveProfile(profile);
  observed.add(key);
  return { profile, snapshot, recorded: true, reason: '' };
}

export function recordCandidateEvent(candidateId, status, { at = new Date().toISOString() } = {}) {
  const profile = withCandidateEvent(loadProfile(), candidateId, status, { at });
  saveProfile(profile);
  return profile;
}

export function syncRuleUsage(ruleState, { at = new Date().toISOString() } = {}) {
  const before = loadProfile();
  const next = withRuleState(before, ruleState, { at });
  if (next !== before) saveProfile(next);
  return next;
}

export function syncBehaviorAnalysis(analysis, { profileKey = null, at = new Date().toISOString() } = {}) {
  const before = loadProfile();
  const next = withBehaviorAnalysis(before, analysis, { key: profileKey, at });
  if (next !== before) saveProfile(next);
  return next;
}
