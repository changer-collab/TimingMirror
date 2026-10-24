// 跨账单同类操作检索：只在本人已保存账单里按模式/标的/持有天数桶匹配。
// 边界：只报匹配账单数与发生次数；不比较行情形态、不报概率、不展示其他账单的金额或成交。
import {
  HOLDING_BUCKETS, HISTORY_EXCLUDED_REASONS, establishedPatternsOf,
} from './historyIndex.js';

export const CROSS_BILL_VERSION = 'cross-bill-1';

const SYMBOL_RE = /^\d{6}$/u;

const BOUNDARIES = Object.freeze([
  '只检索你自己保存且已发布报告的账单；不跨用户',
  '只统计同类操作次数；不比较行情形态，也不给概率',
  '不展示其他账单的金额或成交明细',
]);

function summarizeExcluded(excluded) {
  const counts = new Map();
  for (const item of Array.isArray(excluded) ? excluded : []) {
    const reason = item?.reason;
    if (!reason || reason === 'current_bill') continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, count]) => ({
    reason,
    label: HISTORY_EXCLUDED_REASONS[reason] ?? '未纳入',
    count,
  }));
}

export function criteriaText(criteria = {}) {
  const parts = [];
  const patterns = Array.isArray(criteria.patterns) ? criteria.patterns : [];
  if (patterns.length) parts.push(`模式：${patterns.map((p) => p.name ?? p.id).join('、')}`);
  if (criteria.symbol) parts.push(`标的 ${criteria.symbol}`);
  if (criteria.holding_bucket) {
    const bucket = HOLDING_BUCKETS.find((item) => item.id === criteria.holding_bucket);
    if (bucket) parts.push(`持有 ${bucket.label}`);
  }
  return parts.join(' · ') || '未指定';
}

/**
 * @param {object} p
 * @param {object|null} p.index 历史索引（仅本人已保存账单）
 * @param {Array} [p.patterns] 当前账单成立的模式
 * @param {string|null} [p.symbol] 可选标的过滤
 * @param {string|null} [p.holdingBucket] 可选持有天数桶过滤
 */
export function matchCrossBill({ index = null, patterns = [], symbol = null, holdingBucket = null } = {}) {
  const rows = Array.isArray(index?.rows) ? index.rows : [];
  const criteriaPatterns = establishedPatternsOf(patterns);
  const criteriaIds = criteriaPatterns.map((pattern) => pattern.id);
  const symbolOk = typeof symbol === 'string' && SYMBOL_RE.test(symbol) ? symbol : null;
  const bucket = HOLDING_BUCKETS.some((item) => item.id === holdingBucket) ? holdingBucket : null;
  const missing = [];
  if (!criteriaIds.length && !symbolOk && !bucket) {
    missing.push('当前账单没有可用于匹配的重复模式');
  }

  const matched = missing.length ? [] : rows
    .filter((row) => {
      if (symbolOk && !(Array.isArray(row.symbols) ? row.symbols : []).includes(symbolOk)) return false;
      if (bucket && !(Array.isArray(row.holding_buckets) ? row.holding_buckets : []).some((item) => item.id === bucket)) return false;
      if (criteriaIds.length) return (Array.isArray(row.patterns) ? row.patterns : []).some((p) => criteriaIds.includes(p.id));
      return true;
    })
    .map((row) => {
      const common = (Array.isArray(row.patterns) ? row.patterns : [])
        .filter((p) => criteriaIds.includes(p.id))
        .map(({ id, name, hits }) => ({ id, name, hits }));
      return {
        ref: row.ref,
        effective_date: row.effective_date ?? null,
        trade_count: Number.isFinite(row.trade_count) ? row.trade_count : 0,
        patterns: common,
        occurrences: criteriaIds.length ? common.reduce((sum, p) => sum + (p.hits ?? 0), 0) : null,
      };
    });

  const occurrences = criteriaIds.length
    ? matched.reduce((sum, row) => sum + (row.occurrences ?? 0), 0)
    : null;

  return {
    version: CROSS_BILL_VERSION,
    ok: true,
    synthetic: index?.synthetic === true,
    scope: index?.scope === 'demo_group' ? 'demo_group' : 'user_saved',
    criteria: {
      patterns: criteriaPatterns.map(({ id, name }) => ({ id, name })),
      symbol: symbolOk,
      holding_bucket: bucket,
    },
    matched,
    counts: {
      bills_total: index?.coverage?.bills_included ?? rows.length,
      bills_scanned: index?.coverage?.bills_scanned ?? rows.length,
      bills_matched: matched.length,
      occurrences,
      bills_excluded: index?.coverage?.bills_excluded ?? 0,
    },
    excluded: summarizeExcluded(index?.excluded),
    missing,
    boundaries: [...BOUNDARIES],
  };
}

function excludedText(excluded) {
  const total = excluded.reduce((sum, item) => sum + item.count, 0);
  if (!total) return '';
  const labels = excluded.map((item) => `${item.label} ${item.count} 份`).join('、');
  return `另有 ${total} 份未纳入（${labels}）。`;
}

/* 本地事实草稿：只写次数、覆盖与排除原因；金额与行情形态都不出现。 */
export function buildCrossBillAnswer({ match = null, question = '' } = {}) {
  if (!match || match.ok !== true) {
    return { ok: false, code: 'E_CROSS_BILL_UNAVAILABLE', message: '跨账单索引不可用：这次不生成比较结论，也不用单账单结果代替。' };
  }
  const synthetic = match.synthetic === true;
  const counts = match.counts ?? {};
  const total = Number.isFinite(counts.bills_total) ? counts.bills_total : 0;
  const matchedBills = Number.isFinite(counts.bills_matched) ? counts.bills_matched : 0;
  const excluded = Array.isArray(match.excluded) ? match.excluded : [];
  const excludedTotal = excluded.reduce((sum, item) => sum + item.count, 0);
  const criteria = criteriaText(match.criteria);
  const scopeText = synthetic ? '示例账单组' : '你本人已保存';
  const base = {
    ok: true,
    kind: 'local',
    chip_id: 'cross_bill',
    question: String(question ?? ''),
    intent: 'cross_bill',
    template_id: 'T-cross-bill',
    plan_id: null,
    plan_status: 'local',
    composition_reason: '只统计本人已保存账单的同类操作次数',
  };

  if (match.missing?.length) {
    return {
      ...base,
      text: '跨账单对照需要先有一个在这份账单里成立的重复模式。当前账单还没有达到最小样本的重复模式，所以这次不做跨账单比较，也不猜测哪份账单相似。',
      facts: [{ label: '范围', value: `${scopeText}账单 · ${total} 份` }],
      evidence: [],
      notice: '没有匹配口径时不检索账单；结论照实说明。',
    };
  }

  const facts = [
    { label: '范围', value: `${scopeText}账单（不含当前账单）· ${total} 份` },
    { label: '匹配账单', value: `${matchedBills} 份` },
    ...(Number.isFinite(counts.occurrences) ? [{ label: '同类操作', value: `${counts.occurrences} 次` }] : []),
    { label: '未纳入', value: `${excludedTotal} 份`, tone: excludedTotal ? 'loss' : 'ok' },
    { label: '匹配口径', value: criteria },
  ];
  const evidence = (Array.isArray(match.matched) ? match.matched : []).slice(0, 5).map((row) => ({
    label: `${row.effective_date ?? '日期未知'} 的账单`,
    detail: `${row.trade_count} 笔 · ${row.patterns.map((p) => `${p.name} ${p.hits} 次`).join('、') || '无同类模式'}`,
  }));

  if (matchedBills === 0) {
    return {
      ...base,
      text: `在${scopeText}的 ${total} 份账单（不含当前账单）里，没有找到${criteria}的记录。${excludedText(excluded)}这次只查${synthetic ? '示例账单组' : '你自己保存且已发布报告的账单'}，不用其他来源补齐。`,
      facts,
      evidence,
      notice: synthetic ? '示例账单组，不是你的真实账户；只统计同类操作次数。' : BOUNDARIES[0],
    };
  }

  const occurrenceText = Number.isFinite(counts.occurrences) ? `，合计 ${counts.occurrences} 次` : '';
  return {
    ...base,
    text: `在${scopeText}的 ${total} 份账单（不含当前账单）里，有 ${matchedBills} 份也出现过${criteria}${occurrenceText}。${excludedText(excluded)}这次只统计同类操作次数，不比较行情形态，也不给概率，也不展示其他账单的金额。`,
    facts,
    evidence,
    notice: synthetic
      ? '示例账单组，不是你的真实账户；只统计同类操作次数，不比较行情形态。'
      : '只统计你自己保存且已发布报告的账单；不跨用户，不比较行情形态，也不给概率。',
  };
}

/* 工具结果 → 本地草稿；工具失败时返回不可用，由编排层如实降级。 */
export function localAnswerFromResults({ results = [], question = '' } = {}) {
  const step = (Array.isArray(results) ? results : []).find((item) => item?.ok === true && item.tool === 'history.crossBillIndex');
  if (!step?.output) {
    return { ok: false, code: 'E_CROSS_BILL_UNAVAILABLE', message: '跨账单索引没有返回可用结果：这次不生成比较结论。' };
  }
  return buildCrossBillAnswer({ match: step.output, question });
}
