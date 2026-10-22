// 用户画像与规则候选（非 Agent）—— 只从已复核结果、行为发现、规则使用记录中派生；
// 不调用 LLM、不生成新数字、不评价用户，只记录事实与证据。
// 连续画像：每次打开真实报告记一次观察；跨账单保留历史观察（本地存储，见前端 profileStore）。
// 规则候选：由行为发现的证据映射到既有契约模板，须经用户确认或改写后才立约。
import { fmtMoney, fmtPct, fmtPP } from './display.js';
import { CONTRACT_TEMPLATES } from './contractMatch.js';

export const PROFILE_VERSION = 1;
export const RULE_CANDIDATE_VERSION = 'candidate-2';
export const CHASE_CANDIDATE_ID = 'rc:no_buy_on_surge:chase_high_buy';

const BEHAVIOR_ANALYSIS_SOURCES = Object.freeze(['ai', 'backend_rules']);
const PROFILE_OBSERVATION_IDS = Object.freeze(['sell_rebuy_within_2d', 'overtrading']);
const PROFILE_OBSERVATION_LABELS = Object.freeze({
  sell_rebuy_within_2d: '卖出后两日内买回',
  overtrading: '交易频率偏高',
});
const BEHAVIOR_TAG_IDS = Object.freeze([
  'chase_high_buy',
  'sell_rebuy_within_2d',
  'quick_flip',
  'overtrading',
]);
const BEHAVIOR_TAG_LABELS = Object.freeze({
  chase_high_buy: '追高买入',
  sell_rebuy_within_2d: '卖出后回补',
  quick_flip: '快进快出',
  overtrading: '交易频率偏高',
});

export function stableHash(input) {
  let h = 0x811c9dc5;
  const str = String(input);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function tradeSummary(trades) {
  const list = Array.isArray(trades) ? trades : [];
  const dates = list.map((t) => t.trade_date).filter((d) => typeof d === 'string').sort();
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;
  let spanDays = null;
  if (first && last) {
    const a = Date.parse(`${first}T00:00:00Z`);
    const b = Date.parse(`${last}T00:00:00Z`);
    if (Number.isFinite(a) && Number.isFinite(b)) spanDays = Math.round((b - a) / 86400000);
  }
  const symbols = [...new Set(list.map((t) => t.symbol).filter(Boolean))].sort();
  return {
    trade_count: list.length,
    buy_count: list.filter((t) => t.side === 'buy').length,
    sell_count: list.filter((t) => t.side === 'sell').length,
    symbol_count: symbols.length,
    first_date: first,
    last_date: last,
    span_days: spanDays,
    profile_key: stableHash(`${symbols.join(',')}|${first ?? ''}|${last ?? ''}|${list.length}`),
  };
}

function behaviorSummary(behavior) {
  if (!behavior || !Array.isArray(behavior.patterns)) return null;
  return {
    config_version: behavior.config_version ?? null,
    scope: behavior.scope ?? null,
    patterns: behavior.patterns.map((p) => ({
      pattern_id: p.pattern_id,
      name: p.name,
      status: p.status,
      sample_n: p.sample_n,
      evaluated_n: p.evaluated_n,
      min_samples: p.min_samples,
      buy_count: p.buy_count,
      rule: p.rule ?? null,
      unevaluated_n: Array.isArray(p.unevaluated) ? p.unevaluated.length : 0,
    })),
  };
}

function outcomeSummary(report) {
  const p = report?.portfolio;
  if (!p) return null;
  return {
    buy_cost: p.buyCost,
    actual_value: p.actualValue,
    ghost_value: p.ghostValue,
    actual_ret: p.actualRet,
    ghost_ret: p.ghostRet,
    drag: p.drag,
    drag_money: p.dragMoney,
    display: {
      buy_cost: p.display?.buyCost ?? fmtMoney(p.buyCost),
      actual_ret: p.display?.actualRet ?? '—',
      ghost_ret: p.display?.ghostRet ?? '—',
      drag: p.display?.drag ?? fmtPP(p.drag),
      drag_money: p.display?.dragMoney ?? fmtMoney(p.dragMoney),
    },
  };
}

function stockSelfSummary(stockSelf) {
  if (!stockSelf) return null;
  return {
    status: stockSelf.status,
    ret: stockSelf.ret,
    display: { ret: stockSelf.display?.ret ?? '—' },
    coverage: stockSelf.coverage ?? null,
  };
}

function pgrSummary(pgr) {
  if (!pgr || pgr.status === 'blocked') return null;
  return {
    status: pgr.status,
    pgr: pgr.pgr,
    plr: pgr.plr,
    de: pgr.de,
    display: pgr.display,
    counts: pgr.counts,
  };
}

function reviewSummary(review) {
  if (!review) return null;
  return {
    status: review.status,
    portfolio_published: review.portfolio_published === true,
    published_count: Array.isArray(review.published_facts) ? review.published_facts.length : 0,
    blocked_count: Array.isArray(review.blocked_facts) ? review.blocked_facts.length : 0,
    degraded_count: Array.isArray(review.degraded) ? review.degraded.length : 0,
    verify_id: review.meta?.verify_id ?? null,
  };
}

// 画像标签只用确定性结果派生：模式成立才成标签；处置倾向按 DE 的 5 个百分点阈值（与报告结论一致）。
export function buildBehaviorTags({ behavior = null, pgr = null } = {}) {
  const tags = [];
  const patterns = Array.isArray(behavior?.patterns) ? behavior.patterns : [];
  for (const id of BEHAVIOR_TAG_IDS) {
    const pattern = patterns.find((p) => p.pattern_id === id) ?? null;
    if (!pattern || pattern.status !== '成立' || !(pattern.sample_n > 0)) continue;
    tags.push({
      tag_id: id,
      label: BEHAVIOR_TAG_LABELS[id],
      kind: 'behavior',
      evidence: `命中 ${pattern.sample_n} 笔 / 已评估 ${pattern.evaluated_n} 笔`,
    });
  }
  const de = pgr?.de;
  if (Number.isFinite(de)) {
    if (de >= 0.05) {
      tags.push({ tag_id: 'disposition_gain', label: '盈利时更愿卖出', kind: 'disposition', evidence: `DE ${pgr.display?.de ?? '—'}` });
    } else if (de <= -0.05) {
      tags.push({ tag_id: 'disposition_loss', label: '亏损时更愿卖出', kind: 'disposition', evidence: `DE ${pgr.display?.de ?? '—'}` });
    }
  }
  return tags;
}

// 只保留结构化字段：AI 评论、观察原话、成交与资产均不进入画像。
export function behaviorAnalysisSummary(analysis) {
  if (!analysis || !BEHAVIOR_ANALYSIS_SOURCES.includes(analysis.source)) return null;
  const pattern = analysis.pattern;
  if (!pattern || typeof pattern.pattern_id !== 'string') return null;
  const seen = new Set();
  const observations = [];
  for (const item of Array.isArray(analysis.observations) ? analysis.observations : []) {
    const id = item?.observation_id;
    if (!PROFILE_OBSERVATION_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    observations.push({
      observation_id: id,
      evidence_count: Array.isArray(item.evidence_event_indexes) ? item.evidence_event_indexes.length : 0,
    });
  }
  return {
    source: analysis.source,
    fallback_reason: analysis.source === 'backend_rules' && typeof analysis.fallback_reason === 'string'
      ? analysis.fallback_reason
      : null,
    pattern: {
      pattern_id: pattern.pattern_id,
      status: typeof pattern.status === 'string' ? pattern.status : null,
      sample_n: Number.isFinite(pattern.sample_n) ? pattern.sample_n : null,
      evaluated_n: Number.isFinite(pattern.evaluated_n) ? pattern.evaluated_n : null,
      evidence_count: Array.isArray(pattern.evidence_event_indexes) ? pattern.evidence_event_indexes.length : 0,
    },
    observations,
    rule_candidate_ids: Array.isArray(analysis.rule_candidates)
      ? analysis.rule_candidates.map((candidate) => candidate?.candidate_id).filter((id) => typeof id === 'string')
      : [],
  };
}

function behaviorAnalysisRow(summary) {
  if (!summary) return null;
  const count = summary.observations.length;
  const value = summary.source === 'ai'
    ? (count ? `AI 补充 ${count} 项观察` : 'AI 未补充观察')
    : '规则引擎兜底';
  const note = summary.source === 'ai'
    ? (count
      ? `${summary.observations.map((o) => PROFILE_OBSERVATION_LABELS[o.observation_id]).join('、')}；只存结构化结果`
      : '模型未补充观察；模式仍以本地证据为准')
    : '模型不可用时的本地兜底；不计入观察次数';
  return {
    key: 'behavior_analysis',
    label: '行为洞察',
    value,
    note,
  };
}

function ruleSummary(ruleState) {
  const state = ruleState && typeof ruleState === 'object' ? ruleState : {};
  const activeTemplates = Array.isArray(state.active_templates) ? state.active_templates : [];
  return {
    active_count: Number.isFinite(state.active_count) ? state.active_count : activeTemplates.length,
    version_count: Number.isFinite(state.version_count) ? state.version_count : 0,
    active_templates: activeTemplates,
  };
}

function dimensionRows(snapshot) {
  const b = snapshot.bill;
  const o = snapshot.outcome;
  const patterns = snapshot.behavior?.patterns ?? [];
  const activePatterns = patterns.filter((p) => p.status === '成立' && p.sample_n > 0);
  const rules = snapshot.rules;
  const pgr = snapshot.pgr;
  const rows = [
    {
      key: 'activity',
      label: '交易样貌',
      value: `${b.trade_count} 笔成交 / ${b.symbol_count} 只标的`,
      note: b.first_date ? `${b.first_date} → ${b.last_date}，跨度 ${b.span_days ?? '—'} 天` : '当前账单没有可比日期',
    },
    {
      key: 'outcome',
      label: '结果差距',
      value: o ? `${o.display.drag_money} / ${o.display.drag}` : '组合结果未发布',
      note: o ? `实际 ${o.display.actual_ret}，买入不动 ${o.display.ghost_ret}` : '复核阻断时不生成画像结论',
    },
    {
      key: 'behavior',
      label: '行为证据',
      value: activePatterns.length
        ? `${activePatterns.length} 个重复模式`
        : patterns.length ? '未形成重复模式' : '行为发现未运行',
      note: activePatterns.length
        ? activePatterns.map((p) => `${p.name} n=${p.sample_n}`).join('；')
        : patterns.length ? `已检查 ${patterns.length} 条候选模式，均未达到最小重复数` : '没有可评估的行为证据',
    },
  ];
  const analysisRow = behaviorAnalysisRow(snapshot.behavior_analysis);
  if (analysisRow) rows.push(analysisRow);
  rows.push(
    {
      key: 'disposition',
      label: '卖出倾向',
      value: pgr ? `PGR ${pgr.display.pgr} / PLR ${pgr.display.plr}` : 'PGR/PLR 不可用',
      note: pgr ? `处置效应 DE ${pgr.display.de}（候选口径，非金额加权）` : '卖出与持仓样本不足或行情受阻',
    },
    {
      key: 'rules',
      label: '规则使用',
      value: `当前 ${rules.active_count} 条 / 版本 ${rules.version_count} 条`,
      note: '规则由你确认或改写后生效；画像只记录，不替你定规矩',
    },
  );
  return rows;
}

export function buildProfileSnapshot({
  report = null,
  behavior = null,
  stockSelf = null,
  pgr = null,
  review = null,
  trades = [],
  ruleState = null,
  behaviorAnalysis = null,
  at = new Date().toISOString(),
} = {}) {
  const bill = tradeSummary(trades);
  const behaviorOut = behaviorSummary(behavior);
  const pgrOut = pgrSummary(pgr);
  const snapshot = {
    version: PROFILE_VERSION,
    at,
    profile_key: bill.profile_key,
    bill,
    outcome: outcomeSummary(report),
    behavior: behaviorOut,
    behavior_analysis: behaviorAnalysisSummary(behaviorAnalysis),
    stock_self: stockSelfSummary(stockSelf),
    pgr: pgrOut,
    review: reviewSummary(review),
    rules: ruleSummary(ruleState),
    tags: buildBehaviorTags({ behavior, pgr: pgrOut }),
  };
  snapshot.dimensions = dimensionRows(snapshot);
  return snapshot;
}

export function emptyProfile() {
  return {
    version: PROFILE_VERSION,
    created_at: null,
    updated_at: null,
    observations: 0,
    report_views: 0,
    latest: null,
    history: [],
    trend: null,
    rule_events: {},
  };
}

function signedMoney(v) {
  return `${v >= 0 ? '+' : '-'}${fmtMoney(Math.abs(v))}`;
}

function behaviorHitCount(snapshot) {
  const patterns = snapshot?.behavior?.patterns ?? [];
  if (!patterns.length) return null;
  return patterns.filter((p) => p.status === '成立').reduce((sum, p) => sum + (p.sample_n ?? 0), 0);
}

function trendOf(previous, current) {
  if (!previous || !current) return null;
  const prev = previous.latest;
  if (!prev) return null;
  const prevDrag = prev.outcome?.drag_money;
  const curDrag = current.outcome?.drag_money;
  const dragDelta = Number.isFinite(prevDrag) && Number.isFinite(curDrag) ? curDrag - prevDrag : null;
  const prevBehaviorN = behaviorHitCount(prev);
  const curBehaviorN = behaviorHitCount(current);
  return {
    drag_money_delta: dragDelta,
    drag_money_delta_display: dragDelta === null ? '—' : signedMoney(dragDelta),
    drag_direction: dragDelta === null ? null : (dragDelta > 0 ? 'up' : dragDelta < 0 ? 'down' : 'flat'),
    trade_count_delta: current.bill.trade_count - prev.bill.trade_count,
    behavior_n_delta: Number.isFinite(prevBehaviorN) && Number.isFinite(curBehaviorN) ? curBehaviorN - prevBehaviorN : null,
    rule_count_delta: current.rules.active_count - prev.rules.active_count,
  };
}

export function mergeProfile(previous, snapshot, { at = snapshot?.at ?? new Date().toISOString() } = {}) {
  if (!snapshot) throw new TypeError('mergeProfile：snapshot 缺失');
  const base = previous && previous.version === PROFILE_VERSION ? previous : emptyProfile();
  const historyEntry = {
    at,
    profile_key: snapshot.profile_key,
    trade_count: snapshot.bill.trade_count,
    drag: snapshot.outcome?.drag ?? null,
    drag_money: snapshot.outcome?.drag_money ?? null,
    actual_ret: snapshot.outcome?.actual_ret ?? null,
    ghost_ret: snapshot.outcome?.ghost_ret ?? null,
    display: {
      drag: snapshot.outcome?.display?.drag ?? '—',
      drag_money: snapshot.outcome?.display?.drag_money ?? '—',
      actual_ret: snapshot.outcome?.display?.actual_ret ?? '—',
      ghost_ret: snapshot.outcome?.display?.ghost_ret ?? '—',
    },
    behavior_n: behaviorHitCount(snapshot),
    behavior_active_patterns: (snapshot.behavior?.patterns ?? []).filter((p) => p.status === '成立').map((p) => p.pattern_id),
    tag_ids: (snapshot.tags ?? []).map((t) => t.tag_id),
    rule_count: snapshot.rules.active_count,
  };
  const history = [...(Array.isArray(base.history) ? base.history : []), historyEntry].slice(-12);
  const observations = (Number.isFinite(base.observations) ? base.observations : 0) + 1;
  return {
    version: PROFILE_VERSION,
    created_at: base.created_at ?? at,
    updated_at: at,
    observations,
    report_views: observations,
    latest: snapshot,
    history,
    trend: trendOf(base, snapshot),
    rule_events: base.rule_events && typeof base.rule_events === 'object' ? base.rule_events : {},
  };
}

// 规则使用是画像维度之一：保存/停用规则后同步该维度，不新增报告观察次数。
export function withRuleState(profile, ruleState, { at = new Date().toISOString() } = {}) {
  const base = profile && profile.version === PROFILE_VERSION ? profile : emptyProfile();
  if (!base.latest) return base;
  const rules = ruleSummary(ruleState);
  const prev = base.latest.rules ?? {};
  const same = prev.active_count === rules.active_count
    && prev.version_count === rules.version_count
    && JSON.stringify(prev.active_templates ?? []) === JSON.stringify(rules.active_templates);
  if (same) return base;
  const latest = {
    ...base.latest,
    rules,
    dimensions: (base.latest.dimensions ?? []).map((d) => (d.key === 'rules'
      ? { ...d, value: `当前 ${rules.active_count} 条 / 版本 ${rules.version_count} 条` }
      : d)),
  };
  return { ...base, updated_at: at, latest };
}

// 行为分析只同步结构化结果：不新增报告观察次数，也不保存 AI 原话。
export function withBehaviorAnalysis(profile, analysis, { key = null, at = new Date().toISOString() } = {}) {
  const base = profile && profile.version === PROFILE_VERSION ? profile : emptyProfile();
  if (!base.latest) return base;
  if (key && base.latest.profile_key !== key) return base;
  const summary = behaviorAnalysisSummary(analysis);
  if (!summary) return base;
  if (base.latest.behavior_analysis
    && JSON.stringify(base.latest.behavior_analysis) === JSON.stringify(summary)) return base;
  const row = behaviorAnalysisRow(summary);
  const dimensions = [...(base.latest.dimensions ?? [])];
  const index = dimensions.findIndex((d) => d.key === row.key);
  if (index >= 0) dimensions[index] = row;
  else {
    const behaviorIndex = dimensions.findIndex((d) => d.key === 'behavior');
    dimensions.splice(behaviorIndex >= 0 ? behaviorIndex + 1 : dimensions.length, 0, row);
  }
  return {
    ...base,
    updated_at: at,
    latest: { ...base.latest, behavior_analysis: summary, dimensions },
  };
}

export function withCandidateEvent(profile, candidateId, status, { at = new Date().toISOString() } = {}) {
  const base = profile && profile.version === PROFILE_VERSION ? profile : emptyProfile();
  if (!candidateId || !['opened', 'dismissed', 'restored'].includes(status)) return base;
  const events = base.rule_events && typeof base.rule_events === 'object' ? base.rule_events : {};
  const prev = events[candidateId] ?? {};
  return {
    ...base,
    updated_at: at,
    rule_events: {
      ...events,
      [candidateId]: { ...prev, status, at },
    },
  };
}

function evidenceLine(e) {
  if (Number.isFinite(e.rise)) {
    const rise = e.display?.rise ?? fmtPct(e.rise);
    return `${e.trade_date} ${e.symbol} 买入，窗口涨幅 ${rise}`;
  }
  if (Number.isFinite(e.gap_days)) {
    const side = e.side_label ?? (Array.isArray(e.buy_trade_ids) ? '卖出' : '成交');
    const prior = e.prior_side_label && e.prior_trade_date
      ? `距${e.prior_side_label} ${e.prior_trade_date}`
      : (Array.isArray(e.buy_trade_ids) && e.buy_trade_ids.length ? `对应买入 ${e.buy_trade_ids.join('、')}` : '');
    return `${e.trade_date} ${e.symbol} ${side}${prior ? `，${prior} ${e.gap_days} 个交易日` : ''}`;
  }
  return `${e.trade_date} ${e.symbol} 成交`;
}

const CANDIDATE_SPECS = Object.freeze([
  {
    candidate_id: CHASE_CANDIDATE_ID,
    pattern_id: 'chase_high_buy',
    template_id: 'no_buy_on_surge',
    basis: (pattern) => `本账单中有 ${pattern.sample_n} 笔买入发生在“${pattern.rule?.window ?? '回看窗口'}涨幅 ≥ ${pattern.rule?.threshold_display ?? '—'}”的情境（已评估 ${pattern.evaluated_n} 笔，最小样本 ${pattern.min_samples}）。`,
    caveat: '模板判定的是“申报当天涨幅”，与行为发现的回看窗口不是同一口径；阈值和文本都可以由你改写。系统只给候选，不替你定规矩。',
  },
  {
    candidate_id: 'rc:no_buy_back_within:sell_rebuy_within_2d',
    pattern_id: 'sell_rebuy_within_2d',
    template_id: 'no_buy_back_within',
    basis: (pattern) => `本账单中有 ${pattern.sample_n} 笔买入发生在“${pattern.rule?.window ?? '卖出后窗口'}”的情境（已评估 ${pattern.evaluated_n} 笔，最小样本 ${pattern.min_samples}）。`,
    caveat: '模板按“最近一次卖出”的交易日距离判定；窗口天数可以由你改写。系统只给候选，不替你定规矩。',
  },
  {
    candidate_id: 'rc:sell_within_after_buy:quick_flip',
    pattern_id: 'quick_flip',
    template_id: 'sell_within_after_buy',
    basis: (pattern) => `本账单中有 ${pattern.sample_n} 笔卖出发生在“${pattern.rule?.window ?? '买入后窗口'}”的情境（已评估 ${pattern.evaluated_n} 笔，最小样本 ${pattern.min_samples}）。`,
    caveat: '该模板只提醒、不阻止交易；账单没有成交时刻，同日买卖不计入窗口。系统只给候选，不替你定规矩。',
  },
]);

function candidateFieldsOf(spec, pattern) {
  if (spec.template_id === 'no_buy_on_surge') {
    const threshold = Math.max(1, Math.round((pattern.rule?.threshold ?? 0.1) * 100));
    return { threshold_pct: String(threshold) };
  }
  const fallback = CONTRACT_TEMPLATES[spec.template_id]?.fields?.days?.default ?? 3;
  return { days: String(pattern.rule?.threshold ?? fallback) };
}

function candidateText(template, fields) {
  return template.text_template.replace(/\{(\w+)\}/g, (_, k) => String(fields[k] ?? ''));
}

export function buildRuleCandidates({ behavior = null, ruleState = null, profile = null } = {}) {
  const patterns = Array.isArray(behavior?.patterns) ? behavior.patterns : [];
  const rules = ruleSummary(ruleState);
  if (!patterns.length) {
    return {
      version: RULE_CANDIDATE_VERSION,
      candidates: [],
      notes: ['行为发现未运行或没有可用模式：不生成规则候选，也不虚构模式名与阈值。'],
    };
  }

  const candidates = [];
  for (const spec of CANDIDATE_SPECS) {
    const pattern = patterns.find((p) => p.pattern_id === spec.pattern_id) ?? null;
    const template = CONTRACT_TEMPLATES[spec.template_id];
    if (!pattern || !template) continue;

    const event = profile?.rule_events?.[spec.candidate_id] ?? null;
    const isActive = rules.active_templates.includes(template.template_id);
    let status = 'not_recommended';
    if (isActive) status = 'active';
    else if (event?.status === 'dismissed') status = 'dismissed';
    else if (pattern.status === '成立') status = 'available';

    const reason = status === 'active'
      ? `当前已有一条“${template.name}”规则，不重复推荐。`
      : status === 'dismissed'
        ? '你已忽略这条候选；可在画像记录中恢复。'
        : status === 'available'
          ? `行为发现“${pattern.name}”成立：命中 ${pattern.sample_n} 笔，已评估 ${pattern.evaluated_n} 笔。`
          : pattern.status === '证据不足'
            ? `行为发现“${pattern.name}”证据不足（已评估 ${pattern.evaluated_n} 笔 < 最小样本 ${pattern.min_samples}），不生成候选。`
            : `行为发现“${pattern.name}”不成立（命中 ${pattern.sample_n} 笔 < 最小样本 ${pattern.min_samples}），不生成候选。`;

    const fields = candidateFieldsOf(spec, pattern);
    candidates.push({
      candidate_id: spec.candidate_id,
      version: RULE_CANDIDATE_VERSION,
      status,
      status_text: {
        available: '可建立规则',
        active: '已有同类规则',
        dismissed: '已忽略',
        not_recommended: '不推荐',
      }[status],
      template_id: template.template_id,
      template_name: template.name,
      text: candidateText(template, fields),
      fields,
      threshold: Number(Object.values(fields)[0]),
      source_pattern: {
        pattern_id: pattern.pattern_id,
        name: pattern.name,
        status: pattern.status,
        sample_n: pattern.sample_n,
        evaluated_n: pattern.evaluated_n,
        min_samples: pattern.min_samples,
        rule: pattern.rule,
      },
      basis: spec.basis(pattern),
      evidence: Array.isArray(pattern.evidence) ? pattern.evidence.slice(0, 6).map((e) => ({
        trade_id: e.trade_id,
        trade_date: e.trade_date,
        symbol: e.symbol,
        rise: e.rise,
        gap_days: e.gap_days,
        display: e.display,
        line: evidenceLine(e),
      })) : [],
      caveat: spec.caveat,
      reason,
      event: event ? { status: event.status, at: event.at } : null,
    });
  }
  return {
    version: RULE_CANDIDATE_VERSION,
    candidates,
    notes: [
      '候选只来自当前账单的行为发现证据，不来自 LLM，也不来自其他用户。',
      '规则须由用户确认或改写后保存；候选本身不会自动生效。',
    ],
  };
}
