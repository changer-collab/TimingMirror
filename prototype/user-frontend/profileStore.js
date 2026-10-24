// 用户画像（非 Agent）：只保存派生统计与候选事件，不保存成交明细、文件名或 CSV。
// 画像不落本机存储：启动时从云端快照重建，本会话内的新观察只留在内存并随报告快照上云。
import { contractRuleSet } from '../../src/demo/adapter.js';
import {
  PROFILE_VERSION, emptyProfile, buildProfileSnapshot, mergeProfile, withCandidateEvent, withRuleState,
  withBehaviorAnalysis,
} from '../../src/engine/userProfile.js';

let currentProfile = emptyProfile();
const observed = new Set();

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
  return currentProfile;
}

// 云端恢复后作为本会话的画像基线；reportKeys 用于跳过已记录过的报告。
export function setProfileBase(profile, { reportKeys = [] } = {}) {
  currentProfile = profile && profile.version === PROFILE_VERSION ? profile : emptyProfile();
  observed.clear();
  for (const key of Array.isArray(reportKeys) ? reportKeys : []) {
    if (typeof key === 'string' && key) observed.add(key);
  }
  return currentProfile;
}

export function saveProfile(profile) {
  currentProfile = profile && profile.version === PROFILE_VERSION ? profile : emptyProfile();
  return true;
}

export function clearProfile() {
  observed.clear();
  currentProfile = emptyProfile();
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

// 同一份报告在重启后仍视为同一次观察：键必须能由云端快照里的 report_key 复现。
export function reportObservationKey({ bundle = null, bill = null } = {}) {
  const trades = Array.isArray(bill?.trades) ? bill.trades : [];
  return [
    bundle?.review?.meta?.verify_id ?? '',
    bundle?.valuation?.effective_date ?? '',
    trades.length,
  ].join('|');
}

export function recordReportObservation({
  bundle, bill, ruleState = null, at = new Date().toISOString(), reportKey = null,
} = {}) {
  const snapshot = buildObservationSnapshot({ bundle, bill, ruleState, at });
  if (bundle?.review?.portfolio_published !== true) {
    return { profile: loadProfile(), snapshot, recorded: false, key: null, reason: '组合结果未发布：本次不记入画像' };
  }
  const key = [snapshot.profile_key, reportKey ?? reportObservationKey({ bundle, bill })].join('|');
  if (observed.has(key)) {
    return { profile: loadProfile(), snapshot, recorded: false, key, reason: '本次会话已记录同一报告' };
  }
  const profile = mergeProfile(loadProfile(), snapshot, { at, reportKey: key });
  saveProfile(profile);
  observed.add(key);
  return { profile, snapshot, recorded: true, key, reason: '' };
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
