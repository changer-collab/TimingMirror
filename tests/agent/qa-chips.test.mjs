#!/usr/bin/env node
/**
 * 真实问答五芯片 —— 离线单测（合成夹具；不调用真实模型/行情/网络）
 *
 * 覆盖：五个芯片与 planner 模板映射；最错一笔/追高/画像的本地事实文本；
 *       怎么改的规则候选、理由、证据与既有模板预填；账单变化隐藏旧回答；
 *       规则变化只使候选失效、不改写账单事实；本地芯片零 model/market 请求；
 *       组合表现只走既有在线复述接口。
 * 运行：node tests/agent/qa-chips.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { computeIndicators } from '../../src/engine/indicators.js';
import { buildDragDecomposition } from '../../src/engine/decompose.js';
import { buildPatternList } from '../../src/engine/behavior.js';
import {
  QA_CHIPS,
  buildChipPlan,
  buildLocalChipAnswer,
  createQaChipService,
  candidateStateOf,
  isBillMessageVisible,
  ruleStateKeyOf,
  QA_CHIP_CODES,
} from '../../src/agent/qaChips.js';
import { classifyOffline } from '../../src/agent/offlineIntent.js';
import { openRuleCandidate } from '../../prototype/user-frontend/ruleCandidates.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity, line) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  source: { file: 'qa-mini.csv', line },
});
const TRADES = [
  mk('T001', '2024-09-24', '000000', 'buy', 10, 100, 2),
  mk('T002', '2024-09-27', '000000', 'sell', 11, 100, 3),
  mk('B101', '2024-09-25', '888888', 'buy', 100, 10, 4),
  mk('B102', '2024-09-30', '888888', 'sell', 105, 10, 5),
];
const CLOSES = { '000000': 12, '888888': 110 };
const BILL = { status: 'confirmed', sourceType: 'local', contextId: 'bill-qa-1', fileName: 'qa-mini.csv', trades: TRADES };

const DAYS = ['2024-09-16', '2024-09-17', '2024-09-18', '2024-09-19', '2024-09-20', '2024-09-23', '2024-09-24', '2024-09-25', '2024-09-26', '2024-09-27', '2024-09-30', '2024-10-11'];
const PRICES = {
  '000000': { '2024-09-16': 8, '2024-09-17': 8, '2024-09-18': 8, '2024-09-19': 8, '2024-09-20': 8, '2024-09-23': 10, '2024-09-24': 10, '2024-09-25': 10, '2024-09-26': 10, '2024-09-27': 11, '2024-09-30': 11, '2024-10-11': 12 },
  '888888': { '2024-09-16': 80, '2024-09-17': 90, '2024-09-18': 90, '2024-09-19': 90, '2024-09-20': 90, '2024-09-23': 95, '2024-09-24': 100, '2024-09-25': 100, '2024-09-26': 100, '2024-09-27': 100, '2024-09-30': 105, '2024-10-11': 110 },
};
const FAKE_MARKET = {
  tradingDays: DAYS,
  resolveValuation(date) { return { blocked: false, requested_date: date, effective_date: date }; },
  getClose(symbol, date) { return PRICES[symbol]?.[date] ?? null; },
};

const REVIEW = runReview({ trades: TRADES, closes: CLOSES, valuation: VAL });
const REPORT = computeIndicators({ trades: TRADES, closes: CLOSES });
const DECOMPOSITION = buildDragDecomposition({ report: REPORT, trades: TRADES });
const BEHAVIOR = buildPatternList({ trades: TRADES, market: FAKE_MARKET });

function makeBundle(overrides = {}) {
  return {
    sourceType: 'local',
    fileName: 'qa-mini.csv',
    status: 'ok',
    blocked: false,
    review: REVIEW,
    closes: CLOSES,
    market: FAKE_MARKET,
    factsByScope: {},
    provenance: REVIEW.provenance,
    valuation: VAL,
    asOfDate: VAL.effective_date,
    marketSource: { id: 'fake-fixture', label: '合成测试行情（非真实）' },
    insights: {
      portfolio: { available: true, reason: '', report: REPORT, decomposition: DECOMPOSITION, waterfall: null, counterfactuals: [], counterfactual_errors: [] },
      behavior: { available: true, reason: '', data: BEHAVIOR },
      stock_self: { available: false, reason: '测试不覆盖' },
      pgr: { available: false, reason: '测试不覆盖' },
      review_summary: null,
    },
    ...overrides,
  };
}

const BUNDLE = makeBundle();
const answerFor = (chipId, extra = {}) => buildLocalChipAnswer({
  chip: chipId,
  bundle: BUNDLE,
  bill: BILL,
  ruleState: { active_templates: [], active_count: 0, version_count: 0 },
  ...extra,
});

/* ==== ① 五个芯片与 planner 模板 ==== */
{
  check('芯片：恰为五个，顺序/意图/在线标记确定', QA_CHIPS.length === 5
    && QA_CHIPS.map((c) => c.id).join(',') === 'worst_trade,pattern_explain,how_to_change,profile,portfolio'
    && QA_CHIPS.map((c) => c.intent).join(',') === 'worst_trade,pattern_explain,how_to_change,profile,loss_overview'
    && QA_CHIPS.filter((c) => c.online).length === 1
    && QA_CHIPS.find((c) => c.online).id === 'portfolio', JSON.stringify(QA_CHIPS));
  check('离线意图桩：五个芯片均映射 F-8 意图', QA_CHIPS.every((c) => classifyOffline(c.question).intent === c.intent));
  const templates = {
    worst_trade: 'T-worst-trade',
    pattern_explain: 'T-pattern-explain',
    how_to_change: 'T-how-to-change',
    profile: 'T-profile',
    portfolio: 'T-loss-overview',
  };
  for (const chip of QA_CHIPS) {
    const plan = buildChipPlan({ chip, bundle: BUNDLE, bill: BILL });
    check(`planner：${chip.id} 使用 ${templates[chip.id]} 且 ready`, plan
      && plan.template_id === templates[chip.id] && plan.status === 'ready' && /^plan-[0-9a-f]{16}$/.test(plan.plan_id), JSON.stringify(plan));
  }
}

/* ==== ② 最错一笔：逐笔分解首项 + 回源 ==== */
{
  const a = answerFor('worst_trade');
  check('最错一笔：取逐笔损耗首位（T002 / 000000 / ¥100.00 / +66.7%）', a.ok
    && a.template_id === 'T-worst-trade'
    && a.text.includes('2024-09-27') && a.text.includes('000000')
    && a.text.includes('¥100.00') && a.text.includes('+66.7%'), JSON.stringify(a));
  check('最错一笔：展示成交与回源行，不出现演示数字 6,440', a.facts.some((f) => f.label === '回源' && f.value === 'qa-mini.csv 第 3 行')
    && !JSON.stringify(a).includes('6,440') && !JSON.stringify(a).includes('¥6,440.00'), JSON.stringify(a.facts));
  check('最错一笔：明确事后对照、展示序不等于因果', a.text.includes('事后对照')
    && a.text.includes('展示序不等于因果') && a.notice.includes('候选补充口径'), a.text);

  const negativeBundle = makeBundle({
    insights: {
      ...BUNDLE.insights,
      portfolio: {
        ...BUNDLE.insights.portfolio,
        decomposition: {
          blocked: false,
          total: { value: -500, display: '¥-500.00' },
          items: [
            { trade_id: 'N1', trade_date: '2024-09-27', symbol: '000000', quantity: 100, price: 12.1, close: 12, dragMoney: -10, display: { dragMoney: '¥-10.00', share: '+2.0%' }, source: { file: 'qa-mini.csv', line: 3 } },
            { trade_id: 'N2', trade_date: '2024-09-30', symbol: '888888', quantity: 10, price: 159, close: 110, dragMoney: -490, display: { dragMoney: '¥-490.00', share: '+98.0%' }, source: { file: 'qa-mini.csv', line: 5 } },
          ],
        },
      },
    },
  });
  const negative = buildLocalChipAnswer({ chip: 'worst_trade', bundle: negativeBundle, bill: BILL });
  check('最错一笔：全部差额为负时不虚构“最错”，按绝对值展示且不用双负号', negative.ok
    && negative.text.includes('没有哪一笔卖出相对“买入不动”更差')
    && negative.text.includes('没有“最错一笔”')
    && negative.text.includes('¥490.00')
    && !negative.text.includes('¥-490.00')
    && negative.facts.some((f) => f.label === '优于对照' && f.value === '¥490.00'), JSON.stringify(negative));
}

/* ==== ③ 为什么追高：三态照实 + 证据 ==== */
{
  const a = answerFor('pattern_explain');
  check('为什么追高：行为发现成立、样本 2/2、模板 T-pattern-explain', a.ok
    && a.template_id === 'T-pattern-explain'
    && a.text.includes('成立') && a.text.includes('命中 2 笔') && a.text.includes('已评估 2 笔'), JSON.stringify(a));
  check('为什么追高：命中成交窗口涨幅 +25.0% / +11.1% 均来自行为发现', a.text.includes('+25.0%')
    && a.text.includes('+11.1%') && a.evidence.length === 2, JSON.stringify(a.evidence));
  const weak = makeBundle({
    insights: {
      ...BUNDLE.insights,
      behavior: {
        available: true,
        reason: '',
        data: { ...BEHAVIOR, patterns: [{ ...BEHAVIOR.patterns[0], status: '证据不足', sample_n: 0, evidence: [], evaluated_n: 1 }] },
      },
    },
  });
  const weakAnswer = buildLocalChipAnswer({ chip: 'pattern_explain', bundle: weak, bill: BILL });
  check('为什么追高：证据不足时不下确定结论', weakAnswer.ok && weakAnswer.text.includes('证据不足')
    && weakAnswer.text.includes('不下确定结论'), JSON.stringify(weakAnswer));
}

/* ==== ③b 行为解释：按问题与实际成立模式选择，不固定追高 ==== */
{
  const patternBundle = (patterns) => makeBundle({
    insights: {
      ...BUNDLE.insights,
      behavior: { available: true, reason: '', data: { ...BEHAVIOR, patterns } },
    },
  });
  const REBUY_EVIDENCE = [
    { trade_id: 'R2', trade_date: '2024-09-25', symbol: '333333', side: 'buy', side_label: '买入', prior_trade_id: 'R1', prior_trade_date: '2024-09-23', prior_side_label: '卖出', gap_days: 2, display: { gap_days: '2 个交易日' }, source: { file: 'qa-mini.csv', line: 3 } },
    { trade_id: 'R4', trade_date: '2024-09-27', symbol: '333333', side: 'buy', side_label: '买入', prior_trade_id: 'R3', prior_trade_date: '2024-09-25', prior_side_label: '卖出', gap_days: 2, display: { gap_days: '2 个交易日' }, source: { file: 'qa-mini.csv', line: 5 } },
  ];
  const rebuyPattern = { ...BEHAVIOR.patterns[1], status: '成立', sample_n: 2, evaluated_n: 2, evidence: REBUY_EVIDENCE };
  const overPattern = {
    ...BEHAVIOR.patterns[3], status: '成立', sample_n: 4, evaluated_n: 4,
    evidence: [{ trade_id: 'O8', trade_date: '2024-09-25', symbol: '444444', side: 'sell', gap_days: 2, display: { gap_days: '2 个交易日' }, source: { file: 'qa-mini.csv', line: 9 } }],
  };
  const quiet = (index) => ({ ...BEHAVIOR.patterns[index], status: '证据不足', sample_n: 0, evaluated_n: 0, evidence: [] });

  const ambiguous = buildLocalChipAnswer({
    chip: 'pattern_explain', bundle: BUNDLE, bill: BILL,
    question: '我是不是总在同一个地方栽跟头？',
  });
  check('行为解释：问题未指明模式时并列全部成立模式，不默认追高', ambiguous.ok
    && ambiguous.text.includes('成立的重复模式有 2 类')
    && ambiguous.text.includes('追高买入') && ambiguous.text.includes('买入后三日内卖出')
    && ambiguous.facts.length === 2
    && ambiguous.notice.includes('不默认套用“追高买入”模板'), JSON.stringify(ambiguous));

  const rebuyBundle = patternBundle([quiet(0), rebuyPattern, quiet(2), quiet(3)]);
  const rebuy = buildLocalChipAnswer({
    chip: 'pattern_explain', bundle: rebuyBundle, bill: BILL,
    question: '为什么我卖出后很快又买回？',
  });
  check('行为解释：问题指向“卖出后买回”时回答该模式，不写涨幅', rebuy.ok
    && rebuy.text.includes('卖出后 2 个交易日内买回')
    && rebuy.text.includes('距卖出')
    && !rebuy.text.includes('涨幅')
    && rebuy.evidence.length === 2, JSON.stringify(rebuy));

  const overBundle = patternBundle([quiet(0), quiet(1), quiet(2), overPattern]);
  const over = buildLocalChipAnswer({
    chip: 'pattern_explain', bundle: overBundle, bill: BILL,
    question: '我是不是交易太频繁了？',
  });
  check('行为解释：频繁交易问题使用“完整往返”，不套涨幅', over.ok
    && over.text.includes('交易频率偏高') && over.text.includes('完整往返 ≥ 4 次往返')
    && !over.text.includes('涨幅'), JSON.stringify(over));

  const chaseNotBundle = patternBundle([
    { ...BEHAVIOR.patterns[0], status: '不成立', sample_n: 0, evaluated_n: 2, evidence: [] },
    rebuyPattern, quiet(2), quiet(3),
  ]);
  const chaseNot = buildLocalChipAnswer({
    chip: 'pattern_explain', bundle: chaseNotBundle, bill: BILL,
    question: '为什么说我追高？',
  });
  check('行为解释：点名模式不成立时照实说未达重复数，并列出其他成立模式', chaseNot.ok
    && chaseNot.text.includes('追高买入”在当前账单不成立')
    && chaseNot.text.includes('未达到最小样本 2 笔')
    && !chaseNot.text.includes('低于最小样本')
    && chaseNot.text.includes('本账单同时成立：卖出后两日内买回')
    && chaseNot.facts.length === 4, JSON.stringify(chaseNot));

  const noneBundle = patternBundle(BEHAVIOR.patterns.map((p) => ({ ...p, status: '证据不足', sample_n: 0, evaluated_n: 0, evidence: [] })));
  const none = buildLocalChipAnswer({
    chip: 'pattern_explain', bundle: noneBundle, bill: BILL,
    question: '我有什么重复毛病？',
  });
  check('行为解释：没有成立模式时不硬选一个', none.ok
    && none.text.includes('没有成立的行为模式')
    && none.facts.length === 4 && none.evidence.length === 0
    && !none.text.includes('行为发现“追高买入”在当前账单成立'), JSON.stringify(none));
}

/* ==== ④ 我是谁：只列本账单可验证行为，不虚构标签 ==== */
{
  const a = answerFor('profile');
  check('我是谁：账单覆盖 4 笔 / 2 买入 / 2 卖出 + 行为发现结论', a.ok && a.template_id === 'T-profile'
    && a.text.includes('4 笔交易') && a.text.includes('买入 2') && a.text.includes('卖出 2')
    && a.text.includes('追高买入') && a.text.includes('成立'), JSON.stringify(a));
  check('我是谁：列出全部已实现模式而非只报追高', a.text.includes('卖出后两日内买回')
    && a.text.includes('买入后三日内卖出') && a.text.includes('交易频率偏高')
    && !a.text.includes('只实现了')
    && a.facts.length === 4
    && a.facts.find((f) => f.label === '成立的模式')?.value.includes('追高买入')
    && a.facts.find((f) => f.label === '成立的模式')?.value.includes('买入后三日内卖出'), JSON.stringify({ text: a.text, facts: a.facts }));
  check('我是谁：不生成性格/风险偏好等未实现标签', !/(保守型|激进型|稳健型|风险偏好[:：]|性格[:：])/.test(a.text), a.text);
}

/* ==== ⑤ 怎么改：复用规则候选，展示理由/证据；保存仍由用户确认 ==== */
{
  const a = answerFor('how_to_change');
  const c = a.candidate;
  check('怎么改：返回既有模板候选（no_buy_on_surge / 阈值 10）', a.ok && a.template_id === 'T-how-to-change'
    && c && c.template_id === 'no_buy_on_surge' && String(c.fields.threshold_pct) === '10'
    && c.status === 'available', JSON.stringify(c));
  check('怎么改：理由含样本数，证据可回成交', c.reason.includes('命中 2 笔')
    && c.evidence.length === 2
    && c.evidence.every((e) => e.trade_id && e.line), JSON.stringify(c));
  check('怎么改：明确模板口径差异、候选不自动保存', c.caveat.includes('不是同一口径')
    && a.notice.includes('不会自动保存'), JSON.stringify({ caveat: c.caveat, notice: a.notice }));

  const state = { contracts: { versions: [], modal: null, draft: null }, route: 'chat' };
  const ctx = {
    state,
    set(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && state[k] && typeof state[k] === 'object' && !Array.isArray(state[k])) {
          state[k] = { ...state[k], ...v };
        } else {
          state[k] = v;
        }
      }
    },
    go(route) { state.route = route; },
  };
  const opened = openRuleCandidate(ctx, c);
  check('候选预填：打开既有规则编辑入口，字段/阈值预填且未保存', opened === true
    && state.route === 'contract'
    && state.contracts.modal?.mode === 'add'
    && state.contracts.draft?.template_id === 'no_buy_on_surge'
    && String(state.contracts.draft?.fields?.threshold_pct) === '10'
    && state.contracts.versions.length === 0, JSON.stringify({ state: { route: state.route, contracts: state.contracts } }));

  const active = buildLocalChipAnswer({
    chip: 'how_to_change', bundle: BUNDLE, bill: BILL,
    ruleState: { active_templates: ['no_buy_on_surge'], active_count: 1, version_count: 1 },
  });
  check('怎么改：追高规则已生效时，改推其他可建立规则的模式', active.ok
    && active.candidate.status === 'available'
    && active.candidate.source_pattern.pattern_id === 'quick_flip'
    && active.text.includes('买入后三日内卖出'), JSON.stringify({ candidate: active.candidate, text: active.text }));

  const rebuyMarket = {
    tradingDays: DAYS,
    resolveValuation(date) { return { blocked: false, requested_date: date, effective_date: date }; },
    getClose(symbol, date) { return symbol === '333333' ? 10 : (PRICES[symbol]?.[date] ?? null); },
  };
  const rebuyTrades = [
    mk('R1', '2024-09-23', '333333', 'buy', 10, 100, 2),
    mk('R2', '2024-09-25', '333333', 'sell', 10, 100, 3),
    mk('R3', '2024-09-26', '333333', 'buy', 10, 100, 4),
    mk('R4', '2024-09-27', '333333', 'sell', 10, 100, 5),
    mk('R5', '2024-09-30', '333333', 'buy', 10, 100, 6),
  ];
  const rebuyBundle = makeBundle({
    insights: {
      ...BUNDLE.insights,
      behavior: { available: true, reason: '', data: buildPatternList({ trades: rebuyTrades, market: rebuyMarket }) },
    },
  });
  const rebuy = buildLocalChipAnswer({
    chip: 'how_to_change', bundle: rebuyBundle, bill: BILL,
    ruleState: { active_templates: [], active_count: 0, version_count: 0 },
  });
  check('怎么改：追高不成立时，选择“卖出后两日内买回”的可用候选', rebuy.ok
    && rebuy.candidate?.status === 'available'
    && rebuy.candidate?.template_id === 'no_buy_back_within'
    && rebuy.candidate?.source_pattern?.pattern_id === 'sell_rebuy_within_2d'
    && rebuy.text.includes('卖出后两日内买回')
    && rebuy.evidence.some((line) => line.includes('距卖出')), JSON.stringify({ candidate: rebuy.candidate, text: rebuy.text, evidence: rebuy.evidence }));

  const baseCandidate = c;
  const quickFlipCandidate = active.candidate;
  const dismissed = buildLocalChipAnswer({
    chip: 'how_to_change', bundle: BUNDLE, bill: BILL,
    ruleState: { active_templates: [], active_count: 0, version_count: 0 },
    profile: {
      rule_events: {
        [baseCandidate.candidate_id]: { status: 'dismissed', at: '2026-10-21T00:00:00.000Z' },
        [quickFlipCandidate.candidate_id]: { status: 'dismissed', at: '2026-10-21T00:00:00.000Z' },
      },
    },
  });
  check('怎么改：没有可用候选时，已忽略的候选照实标注且不提供保存', dismissed.ok
    && dismissed.candidate.status === 'dismissed'
    && dismissed.candidate.source_pattern.pattern_id === 'chase_high_buy'
    && dismissed.text.includes('已被你忽略')
    && dismissed.text.includes('当前没有可新建的候选'), JSON.stringify({ candidate: dismissed.candidate, text: dismissed.text }));

  const flatMarket = {
    tradingDays: DAYS,
    resolveValuation(date) { return { blocked: false, requested_date: date, effective_date: date }; },
    getClose() { return 10; },
  };
  const overtradingTrades = [
    mk('O1', '2024-09-16', 'AAA001', 'buy', 10, 100, 2),
    mk('O2', '2024-09-20', 'AAA001', 'sell', 10, 100, 3),
    mk('O3', '2024-09-17', 'BBB002', 'buy', 10, 100, 4),
    mk('O4', '2024-09-23', 'BBB002', 'sell', 10, 100, 5),
    mk('O5', '2024-09-18', 'CCC003', 'buy', 10, 100, 6),
    mk('O6', '2024-09-24', 'CCC003', 'sell', 10, 100, 7),
    mk('O7', '2024-09-19', 'DDD004', 'buy', 10, 100, 8),
    mk('O8', '2024-09-25', 'DDD004', 'sell', 10, 100, 9),
  ];
  const overtradingBundle = makeBundle({
    insights: {
      ...BUNDLE.insights,
      behavior: { available: true, reason: '', data: buildPatternList({ trades: overtradingTrades, market: flatMarket }) },
    },
  });
  const overtrading = buildLocalChipAnswer({
    chip: 'how_to_change', bundle: overtradingBundle, bill: BILL,
    ruleState: { active_templates: [], active_count: 0, version_count: 0 },
  });
  check('怎么改：无模板覆盖的模式也照实列出（交易频率偏高成立），不硬推追高', overtrading.ok
    && overtrading.candidate === null
    && overtrading.text.includes('交易频率偏高成立')
    && overtrading.text.includes('当前没有可建立的规则候选')
    && overtrading.notice.includes('交易频率偏高')
    && !overtrading.text.includes('行为发现“追高买入”'), JSON.stringify({ text: overtrading.text, notice: overtrading.notice }));
}

/* ==== ⑥ 账单变化隐藏旧回答；规则变化只使候选失效 ==== */
{
  check('账单上下文：旧账单消息在新账单下隐藏', isBillMessageVisible({ billContextId: 'bill-qa-1' }, 'bill-qa-1') === true
    && isBillMessageVisible({ billContextId: 'bill-qa-1' }, 'bill-qa-2') === false
    && isBillMessageVisible({ billContextId: 'bill-qa-1' }, null) === false);
  const a = answerFor('how_to_change');
  const keyBefore = ruleStateKeyOf([]);
  const keyAfter = ruleStateKeyOf([{ hash: 'h-new', status: '已确认' }]);
  const message = { kind: 'chip', chipId: 'how_to_change', ruleStateKey: keyBefore, answer: a };
  const before = candidateStateOf(message, keyBefore);
  const after = candidateStateOf(message, keyAfter);
  check('规则变化：候选失效但账单事实文本保持原样', before.has && before.stale === false && before.candidate === a.candidate
    && after.has && after.stale === true && after.candidate === null
    && after.notice.includes('仍然有效') && message.answer.text === a.text, JSON.stringify({ before, after }));
  check('规则键：版本哈希/状态变化会生成新键', keyBefore === 'none' && keyAfter !== keyBefore
    && ruleStateKeyOf([{ hash: 'h-new', status: '已暂停' }]) !== keyAfter);
  const worst = { kind: 'chip', chipId: 'worst_trade', ruleStateKey: keyBefore, answer: answerFor('worst_trade') };
  check('规则变化：不影响“最错一笔”等账单事实芯片', candidateStateOf(worst, keyAfter).has === false
    && worst.answer.text.includes('2024-09-27'));
}

/* ==== ⑦ 本地芯片零 model/market；组合表现才走既有复述 ==== */
{
  let gets = 0;
  let loads = 0;
  let asks = 0;
  let cached = BUNDLE;
  let lastQuestion = null;
  const service = createQaChipService({
    getBundle() { gets += 1; return cached; },
    async loadBundle() { loads += 1; return BUNDLE; },
    async askOnline({ question }) {
      asks += 1;
      lastQuestion = question;
      return { ok: true, text: '组合复述（测试）', number_check: { checked: 4, matched_count: 4, failed_count: 0 } };
    },
    loadProfile: () => null,
  });
  check('零自动请求：创建服务不读取报告、不调用模型', gets === 0 && loads === 0 && asks === 0);

  const worst = await service.answer({ chip: 'worst_trade', bill: BILL });
  check('本地芯片：只读缓存 bundle，零行情/零模型', worst.ok && gets === 1 && loads === 0 && asks === 0, JSON.stringify({ worst, gets, loads, asks }));
  const how = await service.answer({ chip: 'how_to_change', bill: BILL });
  check('本地芯片（怎么改）：仍为零行情/零模型', how.ok && gets === 2 && loads === 0 && asks === 0, JSON.stringify({ gets, loads, asks }));

  cached = null;
  const missing = await service.answer({ chip: 'profile', bill: BILL });
  check('报告未载入：本地芯片提示先打开报告，不自动取行情', missing.ok === false
    && missing.code === QA_CHIP_CODES.REPORT_NOT_READY && loads === 0 && asks === 0, JSON.stringify(missing));

  const online = await service.answer({ chip: 'portfolio', bill: BILL });
  check('组合表现：点击后加载同一报告 bundle 并调用既有复述接口', online.ok === true
    && loads === 1 && asks === 1 && lastQuestion === '组合整体表现如何？', JSON.stringify({ online, loads, asks, lastQuestion }));

  cached = BUNDLE;
  const onlineCached = await service.answer({ chip: 'portfolio', bill: BILL });
  check('组合表现：已有 bundle 时不重复请求行情，只调用复述', onlineCached.ok === true
    && loads === 1 && asks === 2, JSON.stringify({ loads, asks }));

  const withheldBundle = makeBundle({ review: { ...REVIEW, portfolio_published: false } });
  cached = withheldBundle;
  const asksBefore = asks;
  const withheld = await service.answer({ chip: 'portfolio', bill: BILL });
  check('组合未发布：不调用复述接口', withheld.ok === false && withheld.code === QA_CHIP_CODES.REPORT_WITHHELD
    && asks === asksBefore, JSON.stringify(withheld));

  const failing = createQaChipService({
    getBundle: () => null,
    loadBundle: async () => { throw new Error('合成加载失败'); },
    askOnline: async () => { asks += 100; return { ok: true }; },
  });
  const failed = await failing.answer({ chip: 'portfolio', bill: BILL });
  check('报告加载失败：返回本地错误，不调用复述', failed.ok === false && failed.code === QA_CHIP_CODES.REPORT_NOT_READY
    && asks === asksBefore, JSON.stringify(failed));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
