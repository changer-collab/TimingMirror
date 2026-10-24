// 云端账单/事实/摘要的前端归一化（纯函数）：只保留页面会用到的字段，拒绝非法结构。
import { historyEntryOf } from '../engine/userProfile.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROFILE_KEY_RE = /^[0-9a-f]{8}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const MODES = new Set(['summary', 'full']);
const FACT_KINDS = new Set(['goal', 'preference', 'constraint', 'habit', 'risk_tolerance']);
const SUMMARY_CONFIDENCE = new Set(['high', 'medium', 'low']);

export const PROFILE_FACT_KIND_LABELS = Object.freeze({
  goal: '目标',
  preference: '偏好',
  constraint: '约束',
  habit: '习惯',
  risk_tolerance: '风险承受',
});

export const SUMMARY_FALLBACK_LABELS = Object.freeze({
  model_not_configured: '服务端尚未配置模型。',
  model_unavailable: '模型服务暂时不可用。',
  model_timeout: '模型响应超时。',
  model_response_invalid: '模型返回内容未通过校验。',
});

// 只保留脱敏的失败类型，用于把笼统的“不可用”拆成可行动的原因。
export const SUMMARY_FALLBACK_DETAIL_LABELS = Object.freeze({
  upstream_auth: '服务端模型凭据未通过校验，请联系维护者。',
  upstream_forbidden: '当前模型没有访问权限，请联系维护者。',
  upstream_rate_limited: '模型请求被限流，已自动重试一次。',
  upstream_request: '模型请求被拒绝，可能是模型名或参数配置问题。',
  upstream_unavailable: '模型服务临时不可用，已自动重试一次。',
  upstream_timeout: '模型响应超时。',
  upstream_response: '模型返回内容格式异常。',
  upstream_unknown: '模型服务暂时不可用。',
});

export function summaryFallbackText(reason, detail = null) {
  const specific = typeof detail === 'string' ? SUMMARY_FALLBACK_DETAIL_LABELS[detail] : null;
  if (specific) return specific;
  return SUMMARY_FALLBACK_LABELS[reason] ?? '模型暂时不可用。';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateText(value) {
  const date = text(value, 10);
  return DATE_RE.test(date) ? date : null;
}

function metadataView(value) {
  const source = isObject(value) ? value : {};
  return {
    trades_count: finite(source.trades_count),
    warnings_count: finite(source.warnings_count),
    date_from: dateText(source.date_from),
    date_to: dateText(source.date_to),
    symbol_count: finite(source.symbol_count),
  };
}

function snapshotView(value) {
  if (!isObject(value)) return null;
  const source = value.version === 2 && isObject(value.profile?.latest) ? value.profile.latest : value;
  if (typeof value.profile_key !== 'string' || !PROFILE_KEY_RE.test(value.profile_key)) return null;
  if (!isObject(value.bill) || !Number.isInteger(value.bill.trade_count)) return null;
  if (value.review?.portfolio_published !== true) return null;
  if (value.version === 2 && source.profile_key !== value.profile_key) return null;
  return {
    version: Number.isInteger(source.version) ? source.version : 1,
    at: text(source.at, 64) || null,
    profile_key: value.profile_key,
    report_key: text(value.report_key, 160) || null,
    bill: {
      trade_count: value.bill.trade_count,
      first_date: dateText(source.bill?.first_date),
      last_date: dateText(source.bill?.last_date),
    },
    outcome: isObject(source.outcome) ? {
      actual_ret: finite(source.outcome.actual_ret),
      ghost_ret: finite(source.outcome.ghost_ret),
      drag: finite(source.outcome.drag),
      drag_money: finite(source.outcome.drag_money),
      display: isObject(source.outcome.display) ? {
        actual_ret: text(source.outcome.display.actual_ret, 32) || '—',
        ghost_ret: text(source.outcome.display.ghost_ret, 32) || '—',
        drag: text(source.outcome.display.drag, 32) || '—',
        drag_money: text(source.outcome.display.drag_money, 32) || '—',
      } : null,
    } : null,
    review: { portfolio_published: true },
    pgr: isObject(source.pgr) ? { pgr: finite(source.pgr.pgr), plr: finite(source.pgr.plr) } : null,
    rules: isObject(source.rules) ? {
      version_count: finite(source.rules.version_count) ?? 0,
      active_count: finite(source.rules.active_count) ?? 0,
    } : null,
    behavior: isObject(source.behavior) ? {
      patterns: Array.isArray(source.behavior.patterns)
        ? source.behavior.patterns.filter(isObject).map((pattern) => ({
          pattern_id: text(pattern.pattern_id, 64),
          name: text(pattern.name, 60),
          status: text(pattern.status, 16),
          sample_n: finite(pattern.sample_n),
        })).filter((pattern) => pattern.name)
        : [],
    } : null,
    dimensions: Array.isArray(source.dimensions)
      ? source.dimensions.filter(isObject).map((row) => ({
        key: text(row.key, 32),
        label: text(row.label, 32),
        value: text(row.value, 120),
        note: text(row.note, 200),
      })).filter((row) => row.key && row.label)
      : [],
    tags: Array.isArray(source.tags)
      ? source.tags.filter(isObject).map((tag) => ({
        tag_id: text(tag.tag_id, 64),
        label: text(tag.label, 40),
        evidence: text(tag.evidence, 120),
      })).filter((tag) => tag.tag_id && tag.label)
      : [],
  };
}

export function normalizeCloudBills(payload) {
  const rows = Array.isArray(payload?.bills) ? payload.bills : [];
  return rows
    .filter((row) => isObject(row) && typeof row.id === 'string' && UUID_RE.test(row.id))
    .map((row) => ({
      id: row.id,
      imported_at: text(row.imported_at, 64) || null,
      effective_date: dateText(row.effective_date),
      payload_mode: MODES.has(row.payload_mode) ? row.payload_mode : 'summary',
      has_payload: row.has_payload === true,
      metadata: metadataView(row.metadata),
      snapshot: snapshotView(row.snapshot),
      snapshot_at: text(row.snapshot_at, 64) || null,
    }))
    .sort((a, b) => String(b.imported_at ?? '').localeCompare(String(a.imported_at ?? '')));
}

export function normalizeCloudFacts(payload) {
  const rows = Array.isArray(payload?.facts) ? payload.facts : [];
  return rows
    .filter((row) => isObject(row) && typeof row.id === 'string' && UUID_RE.test(row.id))
    .filter((row) => FACT_KINDS.has(row.kind) && text(row.value))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      key: text(row.key, 64) || null,
      value: text(row.value, 240),
      evidence: text(row.evidence, 120) || null,
      source: row.source === 'manual' ? 'manual' : 'chat',
      created_at: text(row.created_at, 64) || null,
    }));
}

// 本机没有画像时，用云端已发布报告快照重建只读画像；历史按快照时间从旧到新。
export function cloudProfileFromBills(bills) {
  const rows = (Array.isArray(bills) ? bills : [])
    .filter((bill) => bill?.snapshot && bill.snapshot.review?.portfolio_published === true)
    .sort((a, b) => String(b.snapshot.at ?? b.imported_at ?? '').localeCompare(String(a.snapshot.at ?? a.imported_at ?? '')));
  if (!rows.length) return null;
  const latest = rows[0].snapshot;
  const history = [...rows].reverse().map((row) => historyEntryOf(row.snapshot, {
    at: row.snapshot.at ?? row.imported_at,
    reportKey: row.snapshot.report_key ?? null,
  }));
  return {
    version: 1,
    created_at: history[0]?.at ?? null,
    updated_at: latest.at ?? null,
    observations: rows.length,
    report_views: rows.length,
    latest,
    history,
    trend: null,
    rule_events: {},
  };
}

function boundedList(value, max, length) {
  return Array.isArray(value)
    ? value.map((item) => text(item, length)).filter(Boolean).slice(0, max)
    : [];
}

export function validSummaryValue(value) {
  if (!isObject(value)) return null;
  const headline = text(value.headline, 24);
  const summary = text(value.summary, 240);
  if (!headline || !summary) return null;
  return {
    schema_version: Number.isInteger(value.schema_version) ? value.schema_version : 1,
    headline,
    summary,
    keywords: boundedList(value.keywords, 6, 12),
    strengths: boundedList(value.strengths, 3, 60),
    blind_spots: boundedList(value.blind_spots, 3, 60),
    next_actions: boundedList(value.next_actions, 3, 60),
    confidence: SUMMARY_CONFIDENCE.has(value.confidence) ? value.confidence : 'low',
    data_limits: boundedList(value.data_limits, 3, 80),
  };
}

export function summaryResponseView(payload) {
  if (!isObject(payload) || payload.ok !== true) return null;
  const summary = validSummaryValue(payload.summary);
  if (!summary) return null;
  return {
    source: payload.source === 'ai' ? 'ai' : 'template',
    source_hash: typeof payload.source_hash === 'string' && /^[0-9a-f]{64}$/u.test(payload.source_hash)
      ? payload.source_hash
      : null,
    fallback_reason: text(payload.fallback_reason, 120) || null,
    fallback_detail: text(payload.fallback_detail, 40) || null,
    summary,
  };
}
