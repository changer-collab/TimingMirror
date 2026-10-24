// 真实问答页的五个预置芯片（确定性；接口候选，未冻结）
// 复用 planner 现有意图/模板与当前账单已发布报告 bundle：
//   · 四个本地芯片只读 bundle 中已生成的指标、逐笔分解与行为发现，不发起行情或模型请求；
//   · “组合表现”仅在用户点击时由调用方加载/读取同一份报告 bundle，再走既有 chatOnline 复述接口；
//   · 规则候选复用 engine/userProfile.buildRuleCandidates；只返回候选与证据，不保存、不改写规则。
// 边界：确定性回答构造；不直接操作 DOM / localStorage / 网络 / 模型；报告加载与在线复述由调用方注入。
import { buildPlan } from './planner.js';
import { classifyOffline } from './offlineIntent.js';
import { buildRuleCandidates } from '../engine/userProfile.js';
import { fmtMoney, fmtPct } from '../engine/display.js';
import { PROFILE_FACT_KIND_LABELS } from './cloudProfileModel.js';
import {
  SIMILAR_PATTERN_HINTS, findPatternById, selectSimilarPattern, similarEvidenceOf,
} from './similarSelection.js';

export { selectSimilarPattern };

export const QA_CHIP_CODES = Object.freeze({
  UNKNOWN_CHIP: 'E_QA_UNKNOWN_CHIP',
  REPORT_NOT_READY: 'W_QA_REPORT_NOT_READY',
  REPORT_WITHHELD: 'W_QA_REPORT_WITHHELD',
  DECOMPOSITION_UNAVAILABLE: 'W_QA_DECOMPOSITION_UNAVAILABLE',
  DECOMPOSITION_BLOCKED: 'W_QA_DECOMPOSITION_BLOCKED',
  BEHAVIOR_UNAVAILABLE: 'W_QA_BEHAVIOR_UNAVAILABLE',
  ONLINE_UNAVAILABLE: 'W_QA_ONLINE_UNAVAILABLE',
  ONLINE_FAILED: 'W_QA_ONLINE_FAILED',
});

export const QA_CHIPS = Object.freeze([
  Object.freeze({ id: 'worst_trade', label: '最错一笔', question: '我最错的一笔是哪个？', intent: 'worst_trade', online: false }),
  Object.freeze({ id: 'pattern_explain', label: '为什么追高', question: '为什么说我追高？', intent: 'pattern_explain', online: false }),
  Object.freeze({ id: 'how_to_change', label: '怎么改', question: '我该怎么改？', intent: 'how_to_change', online: false }),
  Object.freeze({ id: 'profile', label: '我是谁', question: '我是谁？', intent: 'profile', online: false }),
  Object.freeze({ id: 'portfolio', label: '组合表现', question: '组合整体表现如何？', intent: 'loss_overview', online: true }),
]);

const CHIP_BY_ID = new Map(QA_CHIPS.map((c) => [c.id, c]));
const CHIP_BY_QUESTION = new Map(QA_CHIPS.map((c) => [c.question, c]));

export function findQaChip(value) {
  if (value && typeof value === 'object' && CHIP_BY_ID.has(value.id)) return CHIP_BY_ID.get(value.id);
  const key = String(value ?? '').trim();
  return CHIP_BY_ID.get(key) ?? CHIP_BY_QUESTION.get(key) ?? null;
}

export function ruleStateKeyOf(versions = []) {
  const list = Array.isArray(versions) ? versions : [];
  const parts = list.map((v) => `${v?.hash ?? ''}:${v?.status ?? ''}`);
  return parts.length ? parts.join('|') : 'none';
}

export function isBillMessageVisible(message, billContextId) {
  return Boolean(billContextId) && message?.billContextId === billContextId;
}

export function candidateStateOf(message, currentRuleStateKey) {
  const candidate = message?.kind === 'chip' && message.chipId === 'how_to_change'
    ? message.answer?.candidate ?? null
    : null;
  if (!candidate) return Object.freeze({ has: false, stale: false, candidate: null, notice: null });
  const stale = typeof message.ruleStateKey === 'string' && message.ruleStateKey !== currentRuleStateKey;
  return Object.freeze({
    has: true,
    stale,
    candidate: stale ? null : candidate,
    notice: stale ? '规则状态已变化，原候选已失效；上方账单事实仍然有效。' : null,
  });
}

function fail(code, message) {
  return { ok: false, code, message: String(message ?? '') };
}

const SAVED_FACT_LIMIT = 5;

// 系统自动记录的画像依据：单独通道展示，不并入确定性 facts，也不参与候选规则选择。
export function savedFactsView(savedFacts) {
  const rows = (Array.isArray(savedFacts) ? savedFacts : [])
    .filter((fact) => fact && typeof fact === 'object' && typeof fact.value === 'string' && fact.value.trim());
  const sorted = [...rows].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  const seen = new Set();
  const unique = [];
  for (const fact of sorted) {
    const dedupe = `${fact.kind ?? ''}\n${fact.key ?? ''}\n${fact.value.trim()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    unique.push(fact);
  }
  const facts = unique.slice(0, SAVED_FACT_LIMIT).map((fact) => {
    const kind = PROFILE_FACT_KIND_LABELS[fact.kind] ? fact.kind : 'preference';
    return {
      kind,
      label: PROFILE_FACT_KIND_LABELS[kind],
      value: fact.value.trim().slice(0, 240),
      evidence: typeof fact.evidence === 'string' && fact.evidence.trim() ? fact.evidence.trim().slice(0, 120) : null,
      source: fact.source === 'manual' ? 'manual' : 'chat',
      created_at: typeof fact.created_at === 'string' ? fact.created_at : null,
    };
  });
  return { facts, total: unique.length };
}

function savedFactsNote(total) {
  return total > 0
    ? `系统自动记录的 ${total} 条画像依据单独列在下方，可到个人中心撤销；`
    : '';
}

function planContext(bundle, bill) {
  const context = {};
  if (Array.isArray(bill?.trades)) context.trades = bill.trades;
  const report = bundle?.insights?.portfolio?.report;
  if (report) context.report = report;
  if (bundle?.closes && typeof bundle.closes === 'object') context.closes = bundle.closes;
  if (bundle?.market) context.market = bundle.market;
  return context;
}

export function buildChipPlan({ chip, bundle, bill } = {}) {
  const def = findQaChip(chip);
  if (!def) return null;
  return buildPlan({
    question: def.question,
    intentJson: classifyOffline(def.question),
    context: planContext(bundle, bill),
  });
}

function planView(plan) {
  return {
    template_id: plan?.template_id ?? null,
    plan_id: plan?.plan_id ?? null,
    plan_status: plan?.status ?? null,
    composition_reason: plan?.composition_reason ?? '',
  };
}

function localAnswer({
  chip, plan, text, facts = [], evidence = [], candidate = null, notice = null,
  savedFacts = null, savedFactTotal = 0,
}) {
  return {
    ok: true,
    kind: 'local',
    chip_id: chip.id,
    question: chip.question,
    intent: chip.intent,
    ...planView(plan),
    text: String(text ?? ''),
    facts: facts.filter(Boolean),
    evidence: evidence.filter(Boolean),
    candidate,
    notice,
    saved_facts: Array.isArray(savedFacts) ? savedFacts : [],
    saved_fact_total: Number.isFinite(savedFactTotal) ? savedFactTotal : 0,
  };
}

function behaviorData(bundle) {
  const pack = bundle?.insights?.behavior;
  if (!pack?.available || !pack.data) {
    return { ok: false, message: pack?.reason || '行为发现没有生成：不引用示例或其他账单的结论' };
  }
  const patterns = Array.isArray(pack.data.patterns) ? pack.data.patterns : [];
  return { ok: true, data: pack.data, patterns };
}

const PATTERN_HINTS = SIMILAR_PATTERN_HINTS;

function behaviorSelection(bundle, question) {
  const base = behaviorData(bundle);
  if (!base.ok) return base;
  const hint = PATTERN_HINTS.find((item) => item.test.test(String(question ?? '')));
  const established = base.patterns.filter((p) => p?.status === '成立');
  if (hint) {
    const focus = findPatternById(base.patterns, hint.pattern_id);
    if (!focus) return { ok: false, message: `行为发现清单中没有“${hint.pattern_id}”模式：不虚构其他模式` };
    return { ok: true, data: base.data, patterns: base.patterns, focus, established };
  }
  return {
    ok: true,
    data: base.data,
    patterns: base.patterns,
    focus: established.length === 1 ? established[0] : null,
    established,
  };
}

export function patternEvidenceLines(pattern, limit = 3) {
  const rows = Array.isArray(pattern?.evidence) ? pattern.evidence.slice(0, limit) : [];
  return rows.map((e) => {
    const source = e?.source?.line ? `（第 ${e.source.line} 行）` : '';
    if (Number.isFinite(e?.rise)) {
      const rise = e?.display?.rise ?? fmtPct(e.rise);
      return `${e.trade_date} ${e.symbol} 买入，窗口涨幅 ${rise}${source}`;
    }
    const gap = e?.display?.gap_days ?? (Number.isFinite(e?.gap_days) ? `${e.gap_days} 个交易日` : '—');
    if (typeof e?.side_label === 'string') {
      const prior = e.prior_side_label && e.prior_trade_date
        ? `，距${e.prior_side_label} ${e.prior_trade_date}`
        : '';
      return `${e.trade_date} ${e.symbol} ${e.side_label}${prior} ${gap}${source}`;
    }
    return `${e?.trade_date ?? '—'} ${e?.symbol ?? '—'} 卖出，距买入 ${gap}${source}`;
  });
}

function patternSummaryValue(pattern) {
  return `${pattern.status} · 命中 ${pattern.sample_n} 笔 / 已评估 ${pattern.evaluated_n} 笔`;
}

export function patternCriterion(pattern) {
  const rule = pattern?.rule ?? {};
  const comparator = rule.comparator ?? '≥';
  const threshold = rule.threshold_display ?? '—';
  const window = String(rule.window ?? '');
  if (pattern?.pattern_id === 'overtrading') return `完整往返 ${comparator} ${threshold}`;
  if (pattern?.pattern_id === 'chase_high_buy' || window.includes('涨幅')) return `${window}涨幅 ${comparator} ${threshold}`;
  return window || `交易日间隔 ${comparator} ${threshold}`;
}

export function patternFacts(pattern) {
  return [
    { label: '结论', value: `${pattern.name} · ${pattern.status}` },
    { label: '样本', value: `命中 ${pattern.sample_n} 笔 / 已评估 ${pattern.evaluated_n} 笔 / 最小样本 ${pattern.min_samples} 笔` },
    { label: '判定', value: patternCriterion(pattern) },
  ];
}

function otherPatternsText(others) {
  if (!others.length) return '';
  return `本账单同时成立：${others.map((p) => `${p.name}（命中 ${p.sample_n} 笔）`).join('、')}。`;
}

function patternTexts(pattern, others = []) {
  const evidence = patternEvidenceLines(pattern);
  const evidenceText = evidence.length ? `命中：${evidence.join('；')}。` : '没有可展示的命中成交。';
  const othersText = otherPatternsText(others);
  if (pattern.status === '成立') {
    return `行为发现“${pattern.name}”在当前账单成立：${patternCriterion(pattern)}，命中 ${pattern.sample_n} 笔（已评估 ${pattern.evaluated_n} 笔，最小样本 ${pattern.min_samples} 笔）。${evidenceText}${othersText}这是行为发现引擎按候选阈值判定的模式，不是对你当时动机的判断。`;
  }
  if (pattern.status === '不成立') {
    return `行为发现“${pattern.name}”在当前账单不成立：已评估 ${pattern.evaluated_n} 笔，命中 ${pattern.sample_n} 笔，未达到最小样本 ${pattern.min_samples} 笔。${evidenceText}${othersText}不利结论照实展示，不用其他账单补齐。`;
  }
  return `行为发现“${pattern.name}”在当前账单证据不足：可评估 ${pattern.evaluated_n} 笔，低于最小样本 ${pattern.min_samples} 笔，不下确定结论。${evidenceText}${othersText}`;
}

export function tradeSourceLabel(source) {
  return source?.file && Number.isFinite(source.line) ? `${source.file} 第 ${source.line} 行` : '源行不可定位';
}

export function shareText(item) {
  if (typeof item?.display?.share === 'string' && item.display.share !== '') return item.display.share;
  return Number.isFinite(item?.share) ? fmtPct(item.share) : '—';
}

export function moneyText(item) {
  if (typeof item?.display?.dragMoney === 'string' && item.display.dragMoney !== '') return item.display.dragMoney;
  return Number.isFinite(item?.dragMoney) ? fmtMoney(item.dragMoney) : '—';
}

export function priceText(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : '—';
}

// 逐笔差额排序（纯选择）：最错＝展示序首项；最赚＝差额最小（负得最多）；绝对值最大用于“没有正损耗”的说明。
export function rankDragItems(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { list, top: null, worst: null, best: null, allZero: false, positive: false };
  const top = list[0];
  const worst = list.reduce((a, b) => (
    Math.abs(Number(b.dragMoney) || 0) > Math.abs(Number(a.dragMoney) || 0) ? b : a
  ), list[0]);
  const best = list.reduce((a, b) => (Number(b.dragMoney) < Number(a.dragMoney) ? b : a), list[0]);
  return {
    list,
    top,
    worst,
    best,
    allZero: list.every((it) => Number(it.dragMoney) === 0),
    positive: Number(top.dragMoney) > 0,
  };
}

export function worstTradeAnswer({ chip, bundle, bill, plan }) {
  const decomposition = bundle?.insights?.portfolio?.decomposition;
  if (!decomposition) {
    return fail(QA_CHIP_CODES.DECOMPOSITION_UNAVAILABLE, '当前账单报告的逐笔损耗分解没有生成：本次不回答“最错一笔”，也不用其他数字代替。');
  }
  if (decomposition.blocked) {
    return fail(QA_CHIP_CODES.DECOMPOSITION_BLOCKED, '逐笔损耗分解未通过加总或回源校验：本次不展示“最错一笔”。');
  }
  const items = Array.isArray(decomposition.items) ? decomposition.items : [];
  if (items.length === 0) {
    return localAnswer({
      chip,
      plan,
      text: `当前账单没有卖出笔，逐笔损耗为 ${decomposition.total?.display ?? '—'}；没有可以排序的“最错一笔”。`,
      facts: [{ label: '组合损耗', value: decomposition.total?.display ?? '—' }],
      notice: '没有卖出笔时不生成逐笔归因，也不用示例交易补齐。',
    });
  }
  const rank = rankDragItems(items);
  const { top, positive, worst: largest, allZero } = rank;
  if (!positive) {
    const total = decomposition.total?.display ?? '—';
    const absDrag = Number.isFinite(largest.dragMoney) ? fmtMoney(Math.abs(largest.dragMoney)) : '—';
    if (allZero) {
      return localAnswer({
        chip,
        plan,
        text: `按当前账单报告的逐笔损耗分解，每笔卖出的差额都是 0：没有哪一笔卖出相对“买入不动”更差，也就没有“最错一笔”。组合总损耗 ${total}。这是事后对照，不评价当时的决定。`,
        facts: [{ label: '组合损耗', value: total }],
        notice: '逐笔差额为 0 时不评选“最错一笔”；逐笔分解未进入复核发布事实。',
      });
    }
    return localAnswer({
      chip,
      plan,
      text: `按当前账单报告的逐笔损耗分解，没有哪一笔卖出相对“买入不动”更差，因此没有“最错一笔”。差额绝对值最大的是 ${largest.trade_date} 卖出 ${largest.symbol} ${largest.quantity} 股：卖出价 ${priceText(largest.price)}，估值日收盘 ${priceText(largest.close)}，实际比持有到估值日多赚 ${absDrag}。组合总损耗 ${total}。这是事后对照，不评价当时的决定。`,
      facts: [
        { label: '成交（差额最大）', value: `${largest.trade_date} · 卖出 ${largest.symbol} × ${largest.quantity}` },
        { label: '优于对照', value: absDrag },
        { label: '组合损耗', value: total },
        { label: '回源', value: tradeSourceLabel(largest.source) },
      ],
      evidence: [`公式：${largest.quantity} × (${priceText(largest.close)} − ${priceText(largest.price)}) = −${absDrag}（不含费用、税费与分红）`],
      notice: '逐笔差额为负表示实际优于买入不动；没有正损耗卖出时不评选“最错一笔”。逐笔分解未进入复核发布事实。',
    });
  }
  const drag = moneyText(top);
  const share = shareText(top);
  const text = `按当前账单报告的逐笔损耗分解，代价最高的一笔是 ${top.trade_date} 卖出 ${top.symbol} ${top.quantity} 股：卖出价 ${priceText(top.price)}，估值日收盘 ${priceText(top.close)}，与买入不动相比少赚 ${drag}，占组合总损耗 ${share}。这是事后对照，不评价当时的决定；展示序不等于因果。`;
  return localAnswer({
    chip,
    plan,
    text,
    facts: [
      { label: '成交', value: `${top.trade_date} · 卖出 ${top.symbol} × ${top.quantity}` },
      { label: '差额', value: drag },
      { label: '占总损耗', value: share },
      { label: '回源', value: tradeSourceLabel(top.source) },
    ],
    evidence: [`公式：${top.quantity} × (${priceText(top.close)} − ${priceText(top.price)}) = ${drag}（不含费用、税费与分红）`],
    notice: '“代价最高”只按逐笔损耗金额排序；逐笔分解是候选补充口径，未进入复核发布事实。',
  });
}

// “最赚一笔”与“最错一笔”共用逐笔损耗分解：dragMoney = 卖出数量 × (估值日收盘 − 卖出价)，
// 负值表示卖出优于一直持有；取最小值（负得最多）即为相对赚得最多的一笔。
export function buildBestTradeAnswer({ bundle, bill, question = '我获利最高的一笔是哪个？' } = {}) {
  const chip = { id: 'best_trade', question, intent: 'best_trade' };
  const plan = buildPlan({
    question,
    intentJson: { intent: 'best_trade', slots: {}, confidence: 1 },
    context: planContext(bundle, bill),
  });
  const decomposition = bundle?.insights?.portfolio?.decomposition;
  if (!decomposition) {
    return fail(QA_CHIP_CODES.DECOMPOSITION_UNAVAILABLE, '当前账单报告的逐笔损耗分解没有生成：本次不回答“最赚一笔”，也不用其他数字代替。');
  }
  if (decomposition.blocked) {
    return fail(QA_CHIP_CODES.DECOMPOSITION_BLOCKED, '逐笔损耗分解未通过加总或回源校验：本次不展示“最赚一笔”。');
  }
  const items = Array.isArray(decomposition.items) ? decomposition.items : [];
  const total = decomposition.total?.display ?? '—';
  if (items.length === 0) {
    return localAnswer({
      chip,
      plan,
      text: `当前账单没有卖出笔，逐笔损耗为 ${total}；没有可以排序的“最赚一笔”。`,
      facts: [{ label: '组合损耗', value: total }],
      notice: '没有卖出笔时不生成逐笔归因，也不用示例交易补齐。',
    });
  }
  const best = rankDragItems(items).best;
  const drag = Number(best.dragMoney) || 0;
  const absDrag = fmtMoney(Math.abs(drag));
  if (drag === 0) {
    return localAnswer({
      chip,
      plan,
      text: `按当前账单报告的逐笔损耗分解，每笔卖出的差额都是 0：没有哪一笔卖出相对“买入不动”多赚，也就没有“最赚一笔”。组合总损耗 ${total}。这是事后对照，不评价当时的决定。`,
      facts: [{ label: '组合损耗', value: total }],
      notice: '逐笔差额为 0 时不评选“最赚一笔”；逐笔分解未进入复核发布事实。',
    });
  }
  if (drag > 0) {
    return localAnswer({
      chip,
      plan,
      text: `按当前账单报告的逐笔损耗分解，没有哪一笔卖出相对“买入不动”更赚：每笔卖出都不优于持有到估值日。最接近的一笔是 ${best.trade_date} 卖出 ${best.symbol} ${best.quantity} 股，实际比持有到估值日少赚 ${absDrag}。组合总损耗 ${total}。这是事后对照，不评价当时的决定；展示序不等于因果。`,
      facts: [
        { label: '成交（最接近）', value: `${best.trade_date} · 卖出 ${best.symbol} × ${best.quantity}` },
        { label: '落后对照', value: absDrag },
        { label: '组合损耗', value: total },
        { label: '回源', value: tradeSourceLabel(best.source) },
      ],
      evidence: [`公式：${best.quantity} × (${priceText(best.close)} − ${priceText(best.price)}) = ${absDrag}（不含费用、税费与分红）`],
      notice: '没有负损耗卖出时不评选“最赚一笔”，只如实说明最接近的一笔；逐笔分解未进入复核发布事实。',
    });
  }
  return localAnswer({
    chip,
    plan,
    text: `按当前账单报告的逐笔损耗分解，相对“买入不动”赚得最多的一笔是 ${best.trade_date} 卖出 ${best.symbol} ${best.quantity} 股：卖出价 ${priceText(best.price)}，估值日收盘 ${priceText(best.close)}，实际比持有到估值日多赚 ${absDrag}，占组合总损耗 ${shareText(best)}。组合总损耗 ${total}。这是事后对照，不评价当时的决定；展示序不等于因果。`,
    facts: [
      { label: '成交', value: `${best.trade_date} · 卖出 ${best.symbol} × ${best.quantity}` },
      { label: '优于对照', value: absDrag },
      { label: '组合损耗', value: total },
      { label: '回源', value: tradeSourceLabel(best.source) },
    ],
    evidence: [`公式：${best.quantity} × (${priceText(best.close)} − ${priceText(best.price)}) = −${absDrag}（不含费用、税费与分红）`],
    notice: '“最赚一笔”只按逐笔损耗金额升序排序（负损耗最大）；逐笔分解是候选补充口径，未进入复核发布事实。',
  });
}

function multiPatternAnswer({ chip, plan, established }) {
  const list = established.map((p) => `${p.name}（命中 ${p.sample_n} 笔 / 已评估 ${p.evaluated_n} 笔）`).join('、');
  return localAnswer({
    chip,
    plan,
    text: `这份账单里成立的重复模式有 ${established.length} 类：${list}。问题没有指明具体模式，因此并列展示全部成立的模式；可以指定其中一类再问。这是行为发现引擎按候选阈值判定的模式，不是对你当时动机的判断。`,
    facts: established.slice(0, 4).map((p) => ({ label: p.name, value: patternSummaryValue(p) })),
    evidence: established.flatMap((p) => patternEvidenceLines(p, 2)).slice(0, 4),
    notice: '问题没有指明具体模式：不默认套用“追高买入”模板；回看窗口与阈值是候选参数。',
  });
}

function noEstablishedPatternAnswer({ chip, plan, patterns }) {
  const summary = patterns.length
    ? patterns.map((p) => `${p.name}${p.status}`).join('；')
    : '行为发现清单为空';
  return localAnswer({
    chip,
    plan,
    text: `这份账单没有成立的行为模式：${summary}。没有成立模式时不生成解释，也不用示例或别的账单补齐。`,
    facts: patterns.slice(0, 4).map((p) => ({ label: p.name, value: patternSummaryValue(p) })),
    evidence: [],
    notice: '行为发现未进入复核发布事实；结论照实展示。',
  });
}

function patternAnswer({ chip, bundle, bill, plan, question }) {
  const pack = behaviorSelection(bundle, question);
  if (!pack.ok) return fail(QA_CHIP_CODES.BEHAVIOR_UNAVAILABLE, pack.message);
  const { focus, established, patterns } = pack;
  if (!focus) {
    return established.length > 1
      ? multiPatternAnswer({ chip, plan, established })
      : noEstablishedPatternAnswer({ chip, plan, patterns });
  }
  const others = established.filter((p) => p !== focus);
  const mentioned = focus.status === '成立' ? [] : others;
  const facts = patternFacts(focus);
  if (mentioned.length) {
    facts.push({ label: '其他成立', value: mentioned.map((p) => `${p.name}（命中 ${p.sample_n} 笔）`).join('、') });
  }
  return localAnswer({
    chip,
    plan,
    text: patternTexts(focus, mentioned),
    facts,
    evidence: patternEvidenceLines(focus, 6),
    notice: '回看窗口与阈值是候选参数，不是普适标准；行为发现未进入复核发布事实。',
  });
}

const SIMILAR_QUESTION = '这份账单里有没有类似的情况？';

// 相似情境只做同一账单内的重复操作对照；没有跨账单检索，也不做行情形态相似度。
export function buildSimilarContextAnswer({ bundle, bill, question = SIMILAR_QUESTION } = {}) {
  if (!bundle) return fail(QA_CHIP_CODES.REPORT_NOT_READY, '当前账单的已发布报告尚未载入：请先打开报告页；问答页不会为相似情境重复请求行情');
  if (bundle.status === 'blocked' || bundle.review?.portfolio_published !== true) {
    return fail(QA_CHIP_CODES.REPORT_WITHHELD, '当前账单组合结果未发布（可能缺价、复核未通过或行情阻断）：不生成相似情境回答');
  }
  const pack = behaviorData(bundle);
  if (!pack.ok) return fail(QA_CHIP_CODES.BEHAVIOR_UNAVAILABLE, pack.message);

  const textQuestion = String(question ?? '');
  const chip = { id: 'similar_context', question: textQuestion || SIMILAR_QUESTION, intent: 'similar_context' };
  const plan = buildChipPlan({ chip, bundle, bill });
  const { symbol, focus } = selectSimilarPattern({ patterns: pack.patterns, question: textQuestion });
  const evidence = similarEvidenceOf({ focus, symbol });

  if (!focus || !evidence.length) {
    const scopeText = symbol ? `标的 ${symbol} 在这份账单里` : '这份账单里';
    return localAnswer({
      chip,
      plan,
      text: `${scopeText}没有找到可对照的重复情境。你可以换一个已发生的操作再问，或先看行为发现里已有的证据。`,
      facts: [
        { label: '范围', value: '同一份账单' },
        ...(symbol ? [{ label: '标的', value: symbol }] : []),
      ],
      evidence: [],
      notice: '只在这份账单内比较；不做跨账单检索，也不比较行情形态；没有证据就不生成相似结论。',
    });
  }

  const lines = patternEvidenceLines({ ...focus, evidence }, 4);
  const scopeText = symbol ? `标的 ${symbol} ` : '全账单';
  const statusText = focus.status === '成立'
    ? '已达到当前候选阈值'
    : focus.status === '不成立'
      ? '未达到当前候选阈值'
      : '样本不足，暂不判定';
  const text = `只在这份账单内看，${focus.name}：${scopeText}命中 ${evidence.length} 次，${statusText}。${lines.length ? `具体是：${lines.join('；')}。` : ''}这是按交易间隔和价格窗口做的重复情境对照，不是跨账单检索，也不是行情形态相似度匹配。`;

  return localAnswer({
    chip,
    plan,
    text,
    facts: [
      { label: '情境', value: focus.name },
      { label: '范围', value: symbol ? `同一账单 · ${symbol}` : '同一份账单' },
      { label: '命中', value: `${evidence.length} 次（候选 ${focus.sample_n ?? 0} 次 / 已评估 ${focus.evaluated_n ?? 0} 次）` },
      { label: '判定', value: `${focus.status} · ${patternCriterion(focus)}` },
    ],
    evidence: lines,
    notice: '只在这份账单内比较；不做跨账单检索，也不比较行情形态；不是概率预测，不评价当时的动机。',
  });
}

function profileAnswer({ chip, bundle, bill, plan, savedFacts = [] }) {
  const saved = savedFactsView(savedFacts);
  const savedNote = savedFactsNote(saved.total);
  const base = behaviorData(bundle);
  if (!base.ok) return fail(QA_CHIP_CODES.BEHAVIOR_UNAVAILABLE, base.message);
  const patterns = base.patterns;
  const scope = base.data.scope ?? {};
  const trades = Array.isArray(bill?.trades) ? bill.trades : [];
  const tradeCount = Number.isFinite(scope.trade_count) ? scope.trade_count : trades.length;
  const buyCount = Number.isFinite(scope.buy_count) ? scope.buy_count : trades.filter((t) => t.side === 'buy').length;
  const sellCount = Number.isFinite(scope.sell_count) ? scope.sell_count : trades.filter((t) => t.side === 'sell').length;
  if (!patterns.length) {
    return localAnswer({
      chip,
      plan,
      text: `镜子不给你贴人格标签。这份账单覆盖 ${tradeCount} 笔交易（买入 ${buyCount}、卖出 ${sellCount}）；行为发现没有生成可核验的模式，因此不生成行为画像。`,
      facts: [{ label: '账单覆盖', value: `${tradeCount} 笔 / ${buyCount} 笔买入 / ${sellCount} 笔卖出` }],
      notice: `${savedNote}“我是谁”只列本账单可验证的交易行为；不用示例标签补齐。`,
      savedFacts: saved.facts,
      savedFactTotal: saved.total,
    });
  }
  const summary = patterns.map((p) => `${p.name}${p.status}（命中 ${p.sample_n} 笔 / 已评估 ${p.evaluated_n} 笔）`).join('；');
  const hitPatterns = patterns.filter((p) => p.status === '成立');
  const evidence = hitPatterns.flatMap((p) => patternEvidenceLines(p, 3)).slice(0, 6);
  const namesByStatus = (status) => {
    const list = patterns.filter((p) => p.status === status);
    return list.length ? list.map((p) => `${p.name}（${p.sample_n} 笔）`).join('、') : '无';
  };
  return localAnswer({
    chip,
    plan,
    text: `镜子不给你贴人格标签。这份账单覆盖 ${tradeCount} 笔交易（买入 ${buyCount}、卖出 ${sellCount}）。行为发现引擎检查了 ${patterns.length} 类重复模式：${summary}。${hitPatterns.length ? `成立 ${hitPatterns.length} 类。` : '当前没有成立的模式。'}完整行为画像尚未实现，不用示例标签补齐。`,
    facts: [
      { label: '账单覆盖', value: `${tradeCount} 笔 / ${buyCount} 笔买入 / ${sellCount} 笔卖出` },
      { label: '成立的模式', value: namesByStatus('成立') },
      { label: '证据不足', value: namesByStatus('证据不足') },
      { label: '不成立', value: namesByStatus('不成立') },
    ],
    evidence,
    notice: `${savedNote}行为发现仍只来自本账单，不生成性格、风险偏好等未经实现的标签。`,
    savedFacts: saved.facts,
    savedFactTotal: saved.total,
  });
}

function howToChangeAnswer({ chip, bundle, bill, plan, ruleState, profile, savedFacts = [] }) {
  const saved = savedFactsView(savedFacts);
  const savedNote = savedFactsNote(saved.total);
  const base = behaviorData(bundle);
  if (!base.ok) return fail(QA_CHIP_CODES.BEHAVIOR_UNAVAILABLE, base.message);
  let candidatePack = null;
  try {
    candidatePack = buildRuleCandidates({
      behavior: base.data,
      ruleState,
      profile,
    });
  } catch {
    return fail(QA_CHIP_CODES.BEHAVIOR_UNAVAILABLE, '规则候选生成失败：不生成候选，也不虚构模板或阈值。');
  }
  const candidates = Array.isArray(candidatePack?.candidates) ? candidatePack.candidates : [];
  const candidate = candidates.find((c) => c.status === 'available')
    ?? candidates.find((c) => c.status === 'active')
    ?? candidates.find((c) => c.status === 'dismissed')
    ?? null;
  const pattern = candidate
    ? findPatternById(base.patterns, candidate.source_pattern?.pattern_id) ?? candidate.source_pattern ?? null
    : null;
  if (!candidate || !pattern) {
    const summary = base.patterns.length
      ? `本账单的行为发现：${base.patterns.map((p) => `${p.name}${p.status}（命中 ${p.sample_n} 笔 / 已评估 ${p.evaluated_n} 笔）`).join('；')}。`
      : '本账单没有生成可核验的行为模式。';
    const uncovered = base.patterns.filter((p) => p.status === '成立'
      && !candidates.some((c) => c.source_pattern?.pattern_id === p.pattern_id));
    return localAnswer({
      chip,
      plan,
      text: `${summary}当前没有可建立的规则候选；镜子不替你定规矩，也不用示例候选补齐。`,
      facts: base.patterns.map((p) => ({ label: p.name, value: patternSummaryValue(p) })),
      evidence: base.patterns.flatMap((p) => patternEvidenceLines(p, 3)).slice(0, 6),
      notice: `${savedNote}${uncovered.length
        ? `现有规则模板未覆盖：${uncovered.map((p) => p.name).join('、')}；该模式只做行为发现，不生成规则候选。`
        : candidatePack?.notes?.[0] ?? ''}`,
      savedFacts: saved.facts,
      savedFactTotal: saved.total,
    });
  }
  const evidence = patternEvidenceLines(pattern, 6);
  const lead = `行为发现“${pattern.name}”${pattern.status}：命中 ${pattern.sample_n} 笔，已评估 ${pattern.evaluated_n} 笔。`;
  const actionable = candidate.status === 'available';
  const text = actionable
    ? `${lead}下面这条候选来自本账单证据，只做模板预填；保存前由你确认或改写。`
    : candidate.status === 'active'
      ? `${lead}已有同类规则，不重复推荐；当前没有可新建的候选。`
      : candidate.status === 'dismissed'
        ? `${lead}这条候选已被你忽略；可在规则页恢复。当前没有可新建的候选。`
        : `${lead}当前没有足够证据生成规则候选；镜子不替你定规矩，也不用示例候选补齐。`;
  return localAnswer({
    chip,
    plan,
    text,
    facts: patternFacts(pattern),
    evidence,
    candidate,
    notice: `${savedNote}${actionable
      ? '候选由本账单行为证据生成，不来自模型；打开模板不会自动保存。'
      : `当前候选状态：${candidate.status_text}；不提供一键保存。`}`,
    savedFacts: saved.facts,
    savedFactTotal: saved.total,
  });
}

export function buildLocalChipAnswer({
  chip, bundle, bill, ruleState = null, profile = null, question = null, savedFacts = [],
} = {}) {
  const def = findQaChip(chip);
  if (!def) return fail(QA_CHIP_CODES.UNKNOWN_CHIP, '未知的问答芯片：不生成回答');
  if (def.online) return fail(QA_CHIP_CODES.UNKNOWN_CHIP, '“组合表现”只在点击时调用既有在线复述接口，不使用本地芯片回答');
  if (!bundle) return fail(QA_CHIP_CODES.REPORT_NOT_READY, '当前账单的已发布报告尚未载入：请先打开报告页；问答页不会为本地芯片重复请求行情');
  if (bundle.status === 'blocked' || bundle.review?.portfolio_published !== true) {
    return fail(QA_CHIP_CODES.REPORT_WITHHELD, '当前账单组合结果未发布（可能缺价、复核未通过或行情阻断）：不生成芯片回答');
  }
  const plan = buildChipPlan({ chip: def, bundle, bill });
  if (def.id === 'worst_trade') return worstTradeAnswer({ chip: def, bundle, bill, plan });
  if (def.id === 'pattern_explain') return patternAnswer({ chip: def, bundle, bill, plan, question: question ?? def.question });
  if (def.id === 'profile') return profileAnswer({ chip: def, bundle, bill, plan, savedFacts });
  if (def.id === 'how_to_change') return howToChangeAnswer({ chip: def, bundle, bill, plan, ruleState, profile, savedFacts });
  return fail(QA_CHIP_CODES.UNKNOWN_CHIP, '该芯片没有本地回答实现');
}

export function buildLocalPortfolioAnswer({ chip = 'portfolio', bundle, bill } = {}) {
  const def = findQaChip(chip) ?? findQaChip('portfolio');
  if (!bundle) return fail(QA_CHIP_CODES.REPORT_NOT_READY, '当前账单的已发布报告尚未载入：不生成组合表现回答');
  if (bundle.status === 'blocked' || bundle.review?.portfolio_published !== true) {
    return fail(QA_CHIP_CODES.REPORT_WITHHELD, '当前账单组合结果未发布（可能缺价、复核未通过或行情阻断）：不生成组合表现回答');
  }
  const published = Array.isArray(bundle.review?.published_facts) ? bundle.review.published_facts : [];
  const byKey = new Map(published.filter((f) => f.scope === 'portfolio').map((f) => [f.key, f]));
  const required = ['actualRet', 'ghostRet', 'drag', 'dragMoney'];
  const missing = required.filter((k) => !byKey.get(k) || typeof byKey.get(k).display !== 'string');
  if (missing.length) {
    return fail(QA_CHIP_CODES.DECOMPOSITION_UNAVAILABLE, `组合四事实不齐（缺少：${missing.join('、')}）：不生成组合表现回答`);
  }
  const values = required.map((k) => byKey.get(k));
  return {
    ok: true,
    kind: 'local',
    chip_id: def.id,
    question: def.question,
    intent: def.intent,
    template_id: 'T-loss-overview',
    plan_id: null,
    plan_status: 'local',
    composition_reason: '自由输入复用已发布组合四事实；在线复述仅在回答上单独选择',
    text: `按已发布事实复述：组合实际收益 ${values[0].display}，对照收益 ${values[1].display}，择时损耗 ${values[2].display}，损耗金额 ${values[3].display}。这是对已发生交易的事后对照，不是预测。`,
    facts: [
      { label: '实际收益', value: values[0].display },
      { label: '对照收益', value: values[1].display },
      { label: '择时损耗', value: values[2].display },
      { label: '损耗金额', value: values[3].display },
    ],
    evidence: [],
    candidate: null,
    notice: '自由输入使用本地已发布事实；需要在线复述时，请在回答上单独选择。',
  };
}

export function createQaChipService({
  getBundle = () => null,
  loadBundle = null,
  askOnline = null,
  loadProfile = () => null,
} = {}) {
  async function answerOnline({ question, bill } = {}) {
    let bundle = typeof getBundle === 'function' ? getBundle(bill) : null;
    if (!bundle) {
      if (typeof loadBundle !== 'function') {
        return fail(QA_CHIP_CODES.REPORT_NOT_READY, '当前账单的已发布报告尚未载入：请先打开报告页；不会在问答页重复请求行情');
      }
      try {
        bundle = await loadBundle(bill);
      } catch (e) {
        const message = String(e && e.message ? e.message : e);
        return fail(QA_CHIP_CODES.REPORT_NOT_READY, `已发布报告加载失败：${message.slice(0, 240)}`);
      }
    }
    if (!bundle?.review) {
      return fail(QA_CHIP_CODES.REPORT_WITHHELD, '当前账单没有可复述的复核结果（不回退示例或其他账单）');
    }
    if (bundle.review.portfolio_published !== true) {
      return fail(QA_CHIP_CODES.REPORT_WITHHELD, '当前账单组合结果未发布（可能缺价或复核未通过），不能在线复述');
    }
    if (typeof askOnline !== 'function') {
      return fail(QA_CHIP_CODES.ONLINE_UNAVAILABLE, '在线复述接口不可用：未发起请求');
    }
    try {
      const result = await askOnline({ question, review: bundle.review, bundle });
      return result ?? fail(QA_CHIP_CODES.ONLINE_FAILED, '在线复述没有返回结果');
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      return fail(QA_CHIP_CODES.ONLINE_FAILED, `在线复述失败：${message.slice(0, 240)}`);
    }
  }

  return Object.freeze({
    async answer({ chip, bill, ruleState = null } = {}) {
      const def = findQaChip(chip);
      if (!def) return fail(QA_CHIP_CODES.UNKNOWN_CHIP, '未知的问答芯片：不生成回答');
      if (def.online) return answerOnline({ question: def.question, bill });
      const bundle = typeof getBundle === 'function' ? getBundle(bill) : null;
      if (!bundle) {
        return fail(QA_CHIP_CODES.REPORT_NOT_READY, '当前账单的已发布报告尚未载入：请先打开报告页；本地芯片不会触发行情或模型请求');
      }
      let profile = null;
      if (def.id === 'how_to_change' && typeof loadProfile === 'function') {
        try { profile = loadProfile(); } catch { profile = null; }
      }
      return buildLocalChipAnswer({ chip: def, bundle, bill, ruleState, profile });
    },
    answerOnline,
  });
}
