// M1-C7 · 复核与重算编排（纯编排；接口候选，未冻结——依据 implementation-baseline 附A.2/A.3）
// 链路：computeIndicators（主实现）→ buildVerifyReport（独立复核）→ 必要重算（备用实现/数据重载，≤2 次；仅采纳严格改进）
//       → buildProvenanceReport（追溯）→ 发布状态（published / degraded / blocked）。
// 边界：只调用现有 src/engine/* 导出（不实现/不修改公式）；无 DOM / localStorage / 网络；不接百炼；
//       输出确定性（ts 字段仅由调用方注入 now，默认 null）。
// 发布门槛（候选）：fact 复核通过（A.2）＋ provenance 无悬空（A.4）＋ 作用域无恒等式破坏（A.2）
//       ＋ 缺价标的及其组合结论扣发（B4：不按剩余标的重算冒充完整组合）。
import { computeIndicators } from '../engine/indicators.js';
import { buildVerifyReport } from '../engine/verify.js';
import { buildProvenanceReport } from '../engine/provenance.js';

export const REVIEW_CODES = Object.freeze({
  INPUT_INVALID: 'E_REVIEW_INPUT_INVALID',
  PRICE_MISSING: 'E_PRICE_MISSING',
  COMPUTE_FAILED: 'E_REVIEW_COMPUTE_FAILED',
  VERIFY_FAILED: 'E_REVIEW_VERIFY_FAILED',
  PROVENANCE_FAILED: 'E_REVIEW_PROVENANCE_FAILED',
  RECOMPUTE_TOOL_ERROR: 'E_REVIEW_RECOMPUTE_TOOL_ERROR',
  RECOMPUTE_NO_ALTERNATIVE: 'E_REVIEW_RECOMPUTE_NO_ALTERNATIVE',
  IDENTITY_BREAK: 'E_VERIFY_IDENTITY_BREAK',
  PORTFOLIO_WITHHELD: 'E_REVIEW_PORTFOLIO_WITHHELD',
  PROVENANCE_BLOCKED: 'E_REVIEW_PROVENANCE_BLOCKED',
});

export const MAX_RECOMPUTE_ATTEMPTS = 2;
const REL_TOL = 1e-9; // 候选值（与 verify 同）；正式复核容差未冻结（M0）

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

function problemCount(verify) {
  return verify.summary.fail + verify.summary.identities_fail;
}

function scopeOfFact(factId) {
  const i = String(factId).indexOf('.');
  return i > 0 ? factId.slice(0, i) : 'portfolio';
}

function displayOf(report, scope, key) {
  const entry = scope === 'portfolio' ? report.portfolio : report.per_stock[scope];
  return entry && entry.display && entry.display[key] !== undefined ? entry.display[key] : null;
}

/**
 * 复核与重算编排（A.3）。纯函数式编排：除注入的 recompute 回调外不产生副作用。
 * @param {object} input
 * @param {Array} input.trades 标准化交易（含 source 才能通过回源检查）
 * @param {object} input.closes 估值日不复权 close（缺价/非正数 → 该标的及其组合结论不发布）
 * @param {object|null} [input.valuation] 估值日解析结果（透传 provenance，可空）
 * @param {Function|null} [input.recompute] 备用实现/数据重载回调：({attempt, failed_facts, verify}) => {trades?, closes?, path_used?}|null
 * @param {string|null} [input.now] 日志时间戳（调用方注入；默认 null，保证确定性）
 */
export function runReview({ trades, closes, valuation = null, recompute = null, now = null } = {}) {
  const degraded = [];
  const recomputeLog = [];
  const out = {
    status: 'blocked',
    verify: null,
    provenance: null,
    published_facts: [],
    blocked_facts: [],
    recompute_log: recomputeLog,
    degraded,
    blocked_symbols: [],
    portfolio_published: false,
    meta: { verify_id: null, recompute_attempts: 0, rel_tol: REL_TOL },
  };

  /* —— 预检：输入与缺价（不计算、不发布） —— */
  if (!Array.isArray(trades) || trades.length === 0) {
    degraded.push({ code: REVIEW_CODES.INPUT_INVALID, message: 'trades 为空或非数组：不计算、不发布' });
    return out;
  }
  if (closes === null || typeof closes !== 'object') {
    degraded.push({ code: REVIEW_CODES.INPUT_INVALID, message: 'closes 缺失或非对象：不计算、不发布' });
    return out;
  }
  const symbols = [...new Set(trades.map((t) => t.symbol))];
  const missing = symbols.filter((s) => typeof closes[s] !== 'number' || !Number.isFinite(closes[s]) || closes[s] <= 0);
  const unblocked = symbols.filter((s) => !missing.includes(s));
  for (const s of missing) {
    const message = `标的 ${s} 在估值日 close 缺失或非正数：该标的结果不发布；组合结果同样不发布（未回退其他日期，B4）`;
    out.blocked_symbols.push({ symbol: s, code: REVIEW_CODES.PRICE_MISSING, message });
    degraded.push({ code: REVIEW_CODES.PRICE_MISSING, scope: s, message });
  }
  if (unblocked.length === 0) {
    degraded.push({ code: REVIEW_CODES.PRICE_MISSING, message: '全部标的缺价：不计算、不发布' });
    return out;
  }
  const useTrades = missing.length > 0 ? trades.filter((t) => unblocked.includes(t.symbol)) : trades;

  /* —— 主实现 ＋ 独立复核 —— */
  let cur;
  try {
    cur = { trades: useTrades, closes, report: computeIndicators({ trades: useTrades, closes }), verify: null, problems: 0 };
  } catch (e) {
    degraded.push({ code: REVIEW_CODES.COMPUTE_FAILED, message: `主实现计算失败：${String((e && e.message) || e)}` });
    return out;
  }
  try {
    cur.verify = buildVerifyReport({ report: cur.report, trades: useTrades, closes });
  } catch (e) {
    degraded.push({ code: REVIEW_CODES.VERIFY_FAILED, message: `独立复核失败：${String((e && e.message) || e)}` });
    return out;
  }
  cur.problems = problemCount(cur.verify);

  /* —— 必要重算回流（≤2 次；仅采纳严格改进；异常/无备用 → 记录降级，不崩溃） —— */
  let attemptsRun = 0;
  if (cur.problems > 0 && typeof recompute === 'function') {
    for (let attempt = 1; attempt <= MAX_RECOMPUTE_ATTEMPTS; attempt++) {
      const trigger = { failed_facts: cur.verify.summary.fail, identities_fail: cur.verify.summary.identities_fail, verify_id: cur.verify.verify_id };
      const record = (path_used, result, final_status, error = null) => {
        recomputeLog.push({
          recompute_id: `R-${fnv1a64(`${trigger.verify_id}|${attempt}`).slice(0, 8)}`,
          trigger,
          attempt,
          path_used,
          result,
          final_status,
          error,
          ts: now,
          ms: null,
        });
      };
      let alt = null;
      try {
        alt = recompute({ attempt, failed_facts: cur.verify.facts.filter((f) => f.verdict === 'fail').map((f) => f.fact_id), verify: cur.verify });
      } catch (e) {
        attemptsRun = attempt;
        degraded.push({ code: REVIEW_CODES.RECOMPUTE_TOOL_ERROR, attempt, message: `重算回调异常（第 ${attempt} 次）：${String((e && e.message) || e)}` });
        record('none', 'error', 'aborted', String((e && e.message) || e));
        continue;
      }
      if (alt === null || alt === undefined || typeof alt !== 'object') {
        degraded.push({ code: REVIEW_CODES.RECOMPUTE_NO_ALTERNATIVE, message: '无备用实现/数据重载可用：停止重算' });
        record('none', 'no_alternative', 'aborted');
        break;
      }
      attemptsRun = attempt;
      const nextTrades = Array.isArray(alt.trades) && alt.trades.length > 0 ? alt.trades : cur.trades;
      const nextCloses = alt.closes !== null && typeof alt.closes === 'object' ? alt.closes : cur.closes;
      const pathUsed = typeof alt.path_used === 'string' ? alt.path_used : 'callback';
      let nextReport;
      let nextVerify;
      try {
        nextReport = computeIndicators({ trades: nextTrades, closes: nextCloses });
        nextVerify = buildVerifyReport({ report: nextReport, trades: nextTrades, closes: nextCloses });
      } catch (e) {
        degraded.push({ code: REVIEW_CODES.COMPUTE_FAILED, attempt, message: `重算（第 ${attempt} 次）失败：${String((e && e.message) || e)}` });
        record(pathUsed, 'error', 'aborted', String((e && e.message) || e));
        continue;
      }
      const nextProblems = problemCount(nextVerify);
      if (nextProblems < cur.problems) {
        cur = { trades: nextTrades, closes: nextCloses, report: nextReport, verify: nextVerify, problems: nextProblems };
        record(pathUsed, nextProblems === 0 ? 'pass' : 'improved', 'adopted');
        if (nextProblems === 0) break;
      } else {
        record(pathUsed, 'no_improvement', 'not_adopted');
      }
    }
  } else if (cur.problems > 0) {
    degraded.push({ code: REVIEW_CODES.RECOMPUTE_NO_ALTERNATIVE, message: '复核未通过且未提供重算回调：停止重算' });
    recomputeLog.push({
      recompute_id: `R-${fnv1a64(`${cur.verify.verify_id}|0`).slice(0, 8)}`,
      trigger: { failed_facts: cur.verify.summary.fail, identities_fail: cur.verify.summary.identities_fail, verify_id: cur.verify.verify_id },
      attempt: 0,
      path_used: 'none',
      result: 'no_alternative',
      final_status: 'aborted',
      error: null,
      ts: now,
      ms: null,
    });
  }
  out.meta.recompute_attempts = attemptsRun;
  out.verify = cur.verify;
  out.meta.verify_id = cur.verify.verify_id;

  /* —— provenance（追溯）：生成失败则整体不发布（追溯是发布前提） —— */
  let provenance;
  try {
    provenance = buildProvenanceReport({ report: cur.report, trades: cur.trades, closes: cur.closes, valuation });
  } catch (e) {
    degraded.push({ code: REVIEW_CODES.PROVENANCE_FAILED, message: `计算路径生成失败：${String((e && e.message) || e)}` });
    out.blocked_facts = cur.verify.facts.map((f) => ({
      fact_id: f.fact_id,
      scope: scopeOfFact(f.fact_id),
      key: f.key,
      final_status: 'blocked',
      reason_codes: [REVIEW_CODES.PROVENANCE_FAILED],
      reason_summary: null,
    }));
    return out;
  }
  out.provenance = provenance;

  /* —— 发布判定 —— */
  const provByFact = new Map(provenance.items.map((i) => [i.fact_id, i]));
  const badIdentityScopes = new Set(cur.verify.identity_checks.filter((i) => i.verdict === 'fail').map((i) => i.scope));
  for (const i of cur.verify.identity_checks) {
    if (i.verdict === 'fail') {
      degraded.push({ code: REVIEW_CODES.IDENTITY_BREAK, scope: i.scope, message: `${i.identity_id}「${i.name}」破坏（scope=${i.scope}）：该作用域结论不发布（A.2）` });
    }
  }

  for (const f of cur.verify.facts) {
    const scope = scopeOfFact(f.fact_id);
    const reasons = [];
    let finalStatus = null;
    if (f.verdict !== 'pass') {
      reasons.push(...f.reasons.map((r) => r.code));
      finalStatus = attemptsRun > 0 ? 'insufficient_evidence' : 'blocked';
    }
    if (scope === 'portfolio' && missing.length > 0) {
      reasons.push(REVIEW_CODES.PORTFOLIO_WITHHELD);
      finalStatus = finalStatus || 'blocked';
    }
    if (badIdentityScopes.has(scope)) {
      reasons.push(REVIEW_CODES.IDENTITY_BREAK);
      finalStatus = finalStatus || 'blocked';
    }
    const provItem = provByFact.get(f.fact_id);
    if (!finalStatus && (!provItem || provItem.blocked)) {
      reasons.push(REVIEW_CODES.PROVENANCE_BLOCKED);
      finalStatus = 'blocked';
    }
    if (finalStatus) {
      out.blocked_facts.push({
        fact_id: f.fact_id,
        scope,
        key: f.key,
        final_status: finalStatus,
        reason_codes: [...new Set(reasons)],
        reason_summary: f.reasons.length > 0 ? f.reasons[0].message : null,
      });
    } else {
      out.published_facts.push({
        fact_id: f.fact_id,
        scope,
        key: f.key,
        value: f.value,
        formula_id: f.formula_id,
        display: displayOf(cur.report, scope, f.key),
        provenance_fact_id: provItem.fact_id,
      });
    }
  }

  out.portfolio_published = missing.length === 0
    && cur.verify.facts.some((f) => scopeOfFact(f.fact_id) === 'portfolio')
    && !out.blocked_facts.some((b) => b.scope === 'portfolio');
  out.status = out.published_facts.length === 0
    ? 'blocked'
    : (out.blocked_facts.length === 0 ? 'published' : 'degraded');
  return out;
}
