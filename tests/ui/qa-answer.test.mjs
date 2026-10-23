#!/usr/bin/env node
/**
 * 独立问答页回答编排 —— 离线单测（合成夹具；不调用真实模型/行情/网络）
 *
 * 覆盖：九类可回答意图、登记/未接入/拒绝/澄清、在线复述与失败回退、
 *       最小事实包、证据脱敏（不含文件名/成交行）、拒绝类不加载报告不调模型。
 * 运行：node tests/ui/qa-answer.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { computeIndicators } from '../../src/engine/indicators.js';
import { buildDragDecomposition } from '../../src/engine/decompose.js';
import { buildPatternList } from '../../src/engine/behavior.js';
import { previewContract, contractSaveRecords } from '../../src/demo/adapter.js';
import { createQaAnswerService } from '../../prototype/user-frontend/qaAnswer.js';

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

const COUNTERFACTUALS = [
  { symbol: '000000', trade_id: 'T002', trade_date: '2024-09-27', quantity: 100, price: 11, replace: { recoveredMoney: 100, recoveredPP: 0.1, cfValue: 1200, actualValue: 1100 } },
  { symbol: '888888', trade_id: 'B102', trade_date: '2024-09-30', quantity: 10, price: 105, replace: { recoveredMoney: 50, recoveredPP: 0.05, cfValue: 1100, actualValue: 1050 } },
];

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
      portfolio: {
        available: true, reason: '', report: REPORT, decomposition: DECOMPOSITION,
        waterfall: null, counterfactuals: COUNTERFACTUALS, counterfactual_errors: [],
      },
      behavior: { available: true, reason: '', data: BEHAVIOR },
      stock_self: { available: false, reason: '测试不覆盖' },
      pgr: { available: false, reason: '测试不覆盖' },
      review_summary: null,
    },
    ...overrides,
  };
}

const BUNDLE = makeBundle();

function makeService({
  bundle = BUNDLE, askOnline = null, askNarrative = null,
  getSavedFacts = null, loadSavedFacts = null,
  classifyIntent = null, loadBundle = null, loadProfile = null,
} = {}) {
  const calls = { gets: 0, loads: 0, asks: 0, profiles: 0, classify: 0, narrative: 0, savedReads: 0, savedLoads: 0 };
  const service = createQaAnswerService({
    getBundle() { calls.gets += 1; return bundle; },
    loadBundle: loadBundle ?? (async () => { calls.loads += 1; return bundle; }),
    askOnline: async (args) => {
      calls.asks += 1;
      if (!askOnline) return { ok: false, code: 'W_QA_ONLINE_UNAVAILABLE' };
      return askOnline(args);
    },
    askNarrative: async (args) => {
      calls.narrative += 1;
      if (!askNarrative) return { ok: false, code: 'E_QA_NARRATIVE_UNAVAILABLE' };
      return askNarrative(args);
    },
    getSavedFacts: getSavedFacts
      ? () => { calls.savedReads += 1; return getSavedFacts(); }
      : null,
    loadSavedFacts: loadSavedFacts
      ? async () => { calls.savedLoads += 1; return loadSavedFacts(); }
      : null,
    loadProfile: () => { calls.profiles += 1; return loadProfile ? loadProfile() : null; },
    classifyIntent: classifyIntent
      ? async (args) => { calls.classify += 1; return classifyIntent(args); }
      : null,
  });
  return { service, calls };
}

/* ==== ① 本地芯片：事实包、证据与零在线 ==== */
{
  const { service, calls } = makeService();
  const worst = await service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  check('最错一笔：local / intent 正确 / 4 条事实', worst.status === 'local'
    && worst.intent === 'worst_trade' && worst.route.layer === 'L1'
    && worst.source === 'local' && worst.facts.length === 4, JSON.stringify(worst));
  check('最错一笔：事实来自逐笔分解，证据为公式', worst.facts.some((f) => f.label === '差额' && f.value === '¥100.00')
    && worst.evidence.some((e) => e.label === '公式' && e.detail.includes('×')), JSON.stringify({ facts: worst.facts, evidence: worst.evidence }));
  check('最错一笔：不触发在线复述', calls.asks === 0 && worst.trace.number_check === null, JSON.stringify(calls));
  check('最错一笔：账单上下文写入信封', worst.bill_context_id === 'bill-qa-1', worst.bill_context_id);

  const best = await service.ask({ question: '我获利最高的一笔是哪个？', bill: BILL });
  check('最赚一笔：local / intent 正确 / 4 条事实 / 证据为公式', best.status === 'local'
    && best.intent === 'best_trade' && best.route.layer === 'L1'
    && best.facts.length === 4 && best.evidence.some((e) => e.label === '公式')
    && best.facts.some((f) => f.label === '组合损耗'), JSON.stringify(best));
  check('最赚一笔：不触发在线复述', calls.asks === 0 && best.trace.number_check === null, JSON.stringify(calls));
  check('最赚一笔：明确这是事后对照而非因果', best.text.includes('事后对照') && best.text.includes('不等于因果'), best.text);

  const pattern = await service.ask({ question: '为什么说我追高？', bill: BILL });
  check('为什么追高：local / 3 条事实 / 证据可回源', pattern.status === 'local'
    && pattern.intent === 'pattern_explain' && pattern.facts.length === 3
    && pattern.evidence.length === 2, JSON.stringify(pattern));
  check('为什么追高：文本不称对当时动机的判断', pattern.text.includes('不是对你当时动机的判断'), pattern.text);

  const profile = await service.ask({ question: '我是谁？', bill: BILL });
  check('我是谁：local / 账单覆盖 + 模式状态事实 / 不生成人格标签', profile.status === 'local'
    && profile.intent === 'profile' && profile.facts.length === 4
    && profile.facts.some((f) => f.label === '成立的模式' && f.value.includes('追高买入'))
    && profile.facts.some((f) => f.label === '不成立')
    && !profile.text.includes('只实现了')
    && !/(保守型|激进型|稳健型)/.test(profile.text), JSON.stringify(profile));

  const how = await service.ask({ question: '我该怎么改？', bill: BILL });
  check('怎么改：local / 返回候选动作但不自动保存', how.status === 'local'
    && how.actions.some((a) => a.kind === 'candidate')
    && how.notice.includes('不会自动保存'), JSON.stringify({ actions: how.actions, notice: how.notice }));
  check('怎么改：读取画像用于候选去重', calls.profiles >= 1, JSON.stringify(calls));
}

/* ==== ② 组合表现：自由输入本地、精确芯片在线、失败回退本地 ==== */
{
  const { service, calls } = makeService();
  const free = await service.ask({ question: '我的组合收益怎么样？', bill: BILL });
  check('自由组合问法：local / 四事实 / 不调用在线', free.status === 'local'
    && free.intent === 'loss_overview' && free.facts.length === 4
    && free.facts.map((f) => f.label).join(',') === '实际收益,对照收益,择时损耗,损耗金额'
    && calls.asks === 0, JSON.stringify({ free, calls }));

  const onlineService = makeService({
    askOnline: async () => ({
      ok: true,
      text: '组合复述（测试）：实际收益 +10.0%，对照收益 +20.0%，择时损耗 -10.0pp，损耗金额 ¥1,100.00。',
      number_check: { checked: 4, matched_count: 4, failed_count: 0 },
    }),
  });
  const online = await onlineService.service.ask({ question: '组合整体表现如何？', bill: BILL, preferOnline: true });
  check('组合芯片：在线成功 → online / 文本来自复述 / 四事实保留', online.status === 'online'
    && online.source === 'online' && online.intent === 'loss_overview'
    && online.text.startsWith('组合复述（测试）') && online.facts.length === 4, JSON.stringify(online));
  check('组合芯片：数字校验计数写入证据与 trace', online.evidence.some((e) => e.label === '数字校验' && e.detail.includes('已核对 4 个'))
    && online.trace.number_check.includes('匹配 4'), JSON.stringify({ evidence: online.evidence, trace: online.trace }));

  const failService = makeService({
    askOnline: async () => ({
      ok: false, code: 'W_QA_ONLINE_FAILED',
      text: '候选文本：组合实际收益 99.9%', number_check: { checked: 4, matched_count: 2, failed_count: 2 },
    }),
  });
  const fallback = await failService.service.ask({ question: '组合整体表现如何？', bill: BILL, preferOnline: true });
  check('在线失败：回退 local + 四事实 + notice', fallback.status === 'local'
    && fallback.facts.length === 4 && fallback.notice.includes('已改为本地已发布事实'), JSON.stringify(fallback));
  check('在线失败：诊断码保留、候选文本与失败数字不出现', fallback.diagnostics.some((d) => d.code === 'W_QA_ONLINE_FAILED')
    && !JSON.stringify(fallback).includes('99.9') && !JSON.stringify(fallback).includes('候选文本'), JSON.stringify(fallback));
  check('在线失败：数字校验计数只作说明', fallback.trace.number_check.includes('已核对 4 个')
    && fallback.trace.number_check.includes('未通过 2'), JSON.stringify(fallback.trace));

  const demoService = makeService({ askOnline: async () => { throw new Error('示例账单不应调用在线'); } });
  const demo = await demoService.service.ask({
    question: '组合整体表现如何？', bill: { ...BILL, demo: true }, preferOnline: true,
  });
  check('示例账单：不发起在线复述，明示原因', demo.status === 'local'
    && demoService.calls.asks === 0
    && demo.notice.includes('示例账单不参与在线复述'), JSON.stringify({ demo, calls: demoService.calls }));
}

/* ==== ③ 怎么算的 / 可信吗：索引与复核状态，不泄露文件名与成交行 ==== */
{
  const { service } = makeService();
  const calc = await service.ask({ question: '这些数字是怎么算出来的？', bill: BILL });
  check('怎么算的：local / 可用数字与未纳入数量，不显示公式/重算内部计数', calc.status === 'local'
    && calc.intent === 'meta_calc'
    && calc.facts.some((f) => f.label === '可用数字')
    && !calc.facts.some((f) => ['可回源事实', '公式', '复核状态', '重算次数'].includes(f.label)), JSON.stringify(calc.facts));
  check('怎么算的：证据展示用户可读公式，不含文件名/成交行/内部公式标识', calc.evidence.length > 0
    && calc.evidence.every((e) => e.detail.startsWith('公式：'))
    && !JSON.stringify(calc.evidence).includes('qa-mini.csv')
    && !/第 \d+ 行/.test(JSON.stringify(calc.evidence))
    && !/CALC_|formula_id/.test(JSON.stringify(calc.evidence)), JSON.stringify(calc.evidence));

  const degradedReview = {
    ...REVIEW,
    status: 'degraded',
    degraded: [{ code: 'W_PRICE_MISSING', scope: '888888', message: '合成缺价：该作用域降级' }],
    blocked_facts: [{ fact_id: '999999.drag', scope: '999999', key: 'drag' }],
    blocked_symbols: [{ symbol: '999999', code: 'W_PRICE_MISSING' }],
  };
  const trustService = makeService({ bundle: makeBundle({ review: degradedReview }) });
  const trust = await trustService.service.ask({ question: '这些数可信吗？', bill: BILL });
  check('可信吗：local / 组合结果与缺口计数，不显示内部复核状态', trust.status === 'local'
    && trust.intent === 'meta_trust'
    && trust.facts.some((f) => f.label === '组合结果' && f.value === '已发布')
    && trust.facts.some((f) => f.label === '未纳入回答' && f.value === '1 条')
    && trust.facts.some((f) => f.label === '数据提示/缺价' && f.value === '1 条 / 1 个')
    && !trust.facts.some((f) => ['复核状态', '扣发事实'].includes(f.label)), JSON.stringify(trust.facts));
  check('可信吗：证据列数据提示消息，最多 4 条且不显示原因码', trust.evidence.length === 1
    && trust.evidence[0].label === '数据提示'
    && trust.evidence[0].detail.includes('合成缺价')
    && !JSON.stringify(trust.evidence).includes('W_PRICE_MISSING'), JSON.stringify(trust.evidence));

  const heldService = makeService({ bundle: makeBundle({ review: { ...REVIEW, portfolio_published: false } }) });
  const held = await heldService.service.ask({ question: '这些数可信吗？', bill: BILL });
  check('组合未发布：error / 0 条事实 / 不复述', held.status === 'error'
    && held.facts.length === 0
    && held.diagnostics.some((d) => d.code === 'E_QA_REPORT_WITHHELD')
    && heldService.calls.asks === 0, JSON.stringify(held));
}

/* ==== ④ 反事实：指代不清澄清、日期命中、无结果如实说明 ==== */
{
  const { service } = makeService();
  const vague = await service.ask({ question: '如果那笔卖出没发生，会怎样？', bill: BILL });
  check('如果没卖（那笔）：clarify + 前 3 笔可选动作', vague.status === 'clarify'
    && vague.intent === 'what_if'
    && vague.actions.filter((a) => a.kind === 'ask').length === 2
    && vague.notice.includes('不会猜测指代'), JSON.stringify(vague));

  const dated = await service.ask({ question: '如果 2024-09-30 那笔卖出没发生，会怎样？', bill: BILL });
  check('如果没卖（指定日期）：命中对应反事实', dated.status === 'local'
    && dated.text.includes('2024-09-30') && dated.text.includes('888888')
    && dated.text.includes('¥50.00') && dated.facts.some((f) => f.label === '差额' && f.value === '+¥50.00'), JSON.stringify(dated));
  check('如果没卖：口径写明只替换这一笔', dated.evidence.some((e) => e.label === '口径' && e.detail.includes('只替换这一笔'))
    && dated.notice.includes('买入侧替换与多笔替换未实现'), JSON.stringify({ evidence: dated.evidence, notice: dated.notice }));

  const noneService = makeService({
    bundle: makeBundle({
      insights: {
        ...BUNDLE.insights,
        portfolio: { ...BUNDLE.insights.portfolio, counterfactuals: [] },
      },
    }),
  });
  const none = await noneService.service.ask({ question: '如果那笔卖出没发生，会怎样？', bill: BILL });
  check('如果没卖（无结果）：unavailable，不假设不存在的结果', none.status === 'unavailable'
    && none.text.includes('不假设一个不存在的结果'), JSON.stringify(none));

  const miss = await service.ask({ question: '如果 2024-10-09 那笔卖出没发生，会怎样？', bill: BILL });
  check('如果没卖（日期无匹配）：clarify + 可选成交', miss.status === 'clarify'
    && miss.text.includes('2024-10-09') && miss.actions.some((a) => a.kind === 'ask'), JSON.stringify(miss));
}

/* ==== ⑤ 规则状态：只读缓存 bundle，不额外加载；无规则如实说 ==== */
{
  let loads = 0;
  const parsed = previewContract({ template_id: 'sell_within_after_buy', fields: { days: '3' } });
  const versions = contractSaveRecords([], { parsed, note: null });
  const { service } = makeService({ loadBundle: async () => { loads += 1; return BUNDLE; } });
  const ledger = await service.ask({ question: '我的规则守得住吗？', bill: BILL, versions });
  check('规则状态：local / 生效 1 条 / 复核 2 笔', ledger.status === 'local'
    && ledger.intent === 'contract_status'
    && ledger.facts.some((f) => f.label === '生效规则' && f.value === '1 条')
    && ledger.facts.some((f) => f.label === '复核记录' && f.value === '2 笔'), JSON.stringify(ledger));
  check('规则状态：命中与数据不足照实展示（提醒类命中不计违反）', ledger.facts.some((f) => f.label === '命中' && f.value === '2 笔')
    && ledger.facts.some((f) => f.label === '数据不足' && f.value === '0 笔')
    && ledger.text.includes('已提醒 2'), JSON.stringify({ facts: ledger.facts, text: ledger.text }));
  check('规则状态：不额外加载报告（只用缓存 bundle）', loads === 0, `loads=${loads}`);

  const empty = await service.ask({ question: '我的规则守得住吗？', bill: BILL, versions: [] });
  check('规则状态（无规则）：如实说当前没有生效规则', empty.status === 'local'
    && empty.text.includes('当前没有生效规则')
    && empty.actions.some((a) => a.href === '#/me'), JSON.stringify(empty));
}

/* ==== ⑥ 登记 / 未接入 / 拒绝 / 澄清：不加载报告、不调模型 ==== */
{
  const { service, calls } = makeService({ classifyIntent: async () => ({ ok: true, intentJson: { intent: 'loss_overview', confidence: 0.9 } }) });
  const setup = await service.ask({ question: '帮我定个止损。', bill: BILL });
  check('规则登记：registration + 去规则工作区', setup.status === 'registration'
    && setup.intent === 'contract_setup'
    && setup.actions.some((a) => a.href === '#/me')
    && setup.facts.length === 0, JSON.stringify(setup));

  const similar = await service.ask({ question: '历史上类似的情况？', bill: BILL });
  check('相似情境：unavailable + 替代问法', similar.status === 'unavailable'
    && similar.intent === 'similar_context'
    && similar.actions.some((a) => a.kind === 'ask'), JSON.stringify(similar));

  const refusal = await service.ask({ question: '明天买什么？', bill: BILL });
  check('越界问题：refusal / 0 事实 / 替代问法', refusal.status === 'refusal'
    && refusal.facts.length === 0
    && refusal.actions.length === 3, JSON.stringify(refusal));
  check('登记/未接入/拒绝：不加载报告、不调用在线与分类器', calls.loads === 0 && calls.asks === 0 && calls.classify === 0, JSON.stringify(calls));

  const plain = makeService();
  const clarify = await plain.service.ask({ question: '帮我看看', bill: BILL });
  check('无法判断（无 L2）：clarify / 不读取账单', clarify.status === 'clarify'
    && clarify.actions.length === 3 && plain.calls.loads === 0, JSON.stringify({ clarify, calls: plain.calls }));
  check('澄清文案：不声称未调用模型，只说明未读取账单', clarify.text.includes('没有读取账单')
    && !clarify.text.includes('不调用模型'), clarify.text);
}

/* ==== ⑦ 在线意图 L2 与错误边界 ==== */
{
  const { service } = makeService({
    classifyIntent: async () => ({ ok: true, intentJson: { intent: 'loss_overview', confidence: 0.88 } }),
  });
  const l2 = await service.ask({ question: '帮我看看这个账户', bill: BILL });
  check('L2 命中：intent 来自在线意图，层显示“在线意图”', l2.status === 'local'
    && l2.intent === 'loss_overview' && l2.route.layer === 'L2'
    && l2.trace.layer_label === '在线意图' && l2.trace.intent_code === 'loss_overview', JSON.stringify(l2));

  const patternService = makeService({
    classifyIntent: async () => ({
      ok: true,
      intentJson: { intent: 'pattern_explain', slots: { pattern: 'chase_high_buy' }, confidence: 0.78 },
    }),
  });
  const l2Pattern = await patternService.service.ask({ question: '我是不是总在同一个地方栽跟头？', bill: BILL });
  check('L2 行为解释：模糊问题并列本账单成立模式，不默认追高', l2Pattern.status === 'local'
    && l2Pattern.intent === 'pattern_explain' && l2Pattern.route.layer === 'L2'
    && l2Pattern.text.includes('成立的重复模式有 2 类')
    && l2Pattern.text.includes('追高买入') && l2Pattern.text.includes('买入后三日内卖出')
    && l2Pattern.facts.length === 2, JSON.stringify(l2Pattern));

  const empty = await service.ask({ question: '   ', bill: BILL });
  check('空问题：error / E_QA_EMPTY / 不发任何内容', empty.status === 'error'
    && empty.diagnostics.some((d) => d.code === 'E_QA_EMPTY')
    && empty.text.includes('没有发送任何内容'), JSON.stringify(empty));

  const failService = makeService({ loadBundle: async () => { throw new Error('合成加载失败'); }, bundle: null });
  const loadFail = await failService.service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  check('报告加载失败：error / 诊断码 / 可重试', loadFail.status === 'error'
    && loadFail.diagnostics.some((d) => d.code === 'E_QA_BUNDLE_LOAD_FAILED')
    && loadFail.actions.some((a) => a.id === 'qa-retry'), JSON.stringify(loadFail));

  const cachedless = createQaAnswerService({ getBundle: () => null, loadBundle: null });
  const noBundle = await cachedless.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  check('报告未载入：error / 不重复请求行情', noBundle.status === 'error'
    && noBundle.diagnostics.some((d) => d.code === 'E_QA_BUNDLE_UNAVAILABLE'), JSON.stringify(noBundle));
}

/* ==== ⑧ AI 解读层：手动策略、守卫与失败不带文本 ==== */
{
  const { service, calls } = makeService();
  const worst = await service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  const portfolio = await service.ask({ question: '组合整体表现如何？', bill: BILL });
  const refusal = await service.ask({ question: '明天买什么？', bill: BILL });
  check('解读策略：本地可解释意图为 manual', worst.narrative_policy === 'manual', worst.narrative_policy);
  check('解读策略：组合表现与拒绝类为 none', portfolio.narrative_policy === 'none'
    && refusal.narrative_policy === 'none', JSON.stringify({ p: portfolio.narrative_policy, r: refusal.narrative_policy }));
  check('解读策略：策略不改变本地答案事实', worst.facts.length === 4 && worst.source === 'local');

  const sent = [];
  const narrativeService = makeService({
    askNarrative: async (args) => {
      sent.push(args);
      return { ok: true, text: '合成解读正文', number_check: { checked: 5, matched_count: 5, failed_count: 0 } };
    },
  });
  const answer = await narrativeService.service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  const narrated = await narrativeService.service.narrate({ question: '我最错的一笔是哪个？', answer, bill: BILL });
  check('解读：成功路径返回文本与数字校验计数', narrated.ok === true
    && narrated.text === '合成解读正文' && narrated.number_check?.checked === 5, JSON.stringify(narrated));
  check('解读：只发送问题/意图/事实/证据，不发送本地答案正文', sent.length === 1
    && Object.keys(sent[0]).join(',') === 'question,intent,facts,evidence'
    && !('text' in sent[0]) && !('answer' in sent[0])
    && sent[0].facts.length === 4 && sent[0].intent === 'worst_trade', JSON.stringify(sent[0]));

  const noPolicy = await narrativeService.service.narrate({ question: '组合整体表现如何？', answer: portfolio, bill: BILL });
  check('解读：narrative_policy=none 时短路且不调用模型', noPolicy.ok === false
    && noPolicy.code === 'E_QA_NARRATIVE_NOT_ALLOWED' && narrativeService.calls.narrative === 1, JSON.stringify(noPolicy));

  const demoAnswer = await narrativeService.service.ask({ question: '我最错的一笔是哪个？', bill: { ...BILL, demo: true } });
  const demoNarrate = await narrativeService.service.narrate({ question: '我最错的一笔是哪个？', answer: demoAnswer, bill: { ...BILL, demo: true } });
  check('解读：示例账单策略为 none 且不发起请求', demoAnswer.narrative_policy === 'none'
    && demoNarrate.code === 'E_QA_NARRATIVE_NOT_ALLOWED'
    && narrativeService.calls.narrative === 1, JSON.stringify({ demoAnswer, demoNarrate }));

  const noFactAnswer = { status: 'local', intent: 'worst_trade', narrative_policy: 'manual', facts: [], evidence: [], bill_context_id: 'bill-qa-1' };
  const noFacts = await narrativeService.service.narrate({ question: '我最错的一笔是哪个？', answer: noFactAnswer, bill: BILL });
  check('解读：无事实时短路', noFacts.code === 'E_QA_NARRATIVE_NO_FACTS' && narrativeService.calls.narrative === 1, JSON.stringify(noFacts));

  const staleAnswer = { ...answer, bill_context_id: 'bill-other' };
  const stale = await narrativeService.service.narrate({ question: '我最错的一笔是哪个？', answer: staleAnswer, bill: BILL });
  check('解读：账单已变化时短路', stale.code === 'E_QA_NARRATIVE_STALE' && narrativeService.calls.narrative === 1, JSON.stringify(stale));

  const failing = makeService({ askNarrative: async () => { throw new Error('offline'); } });
  const failingAnswer = await failing.service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  const failure = await failing.service.narrate({ question: '我最错的一笔是哪个？', answer: failingAnswer, bill: BILL });
  check('解读：在线异常 → UNAVAILABLE 且不返回文本', failure.ok === false
    && failure.code === 'E_QA_NARRATIVE_UNAVAILABLE' && !('text' in failure), JSON.stringify(failure));

  const plain = makeService();
  const plainAnswer = await plain.service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  const unavailable = await plain.service.narrate({ question: '我最错的一笔是哪个？', answer: plainAnswer, bill: BILL });
  check('解读：未注入 online 客户端 → UNAVAILABLE', unavailable.code === 'E_QA_NARRATIVE_UNAVAILABLE', JSON.stringify(unavailable));
  check('解读：策略与守卫不触发在线复述', calls.asks === 0 && plain.calls.asks === 0, JSON.stringify(plain.calls));
}

/* ==== ⑨ 画像事实回流：独立通道、缓存冷加载与失败降级 ==== */
{
  const savedRows = [
    { kind: 'goal', key: 'holding_horizon', value: '希望做长线', evidence: '我希望做长线', source: 'manual', created_at: '2026-10-20T08:00:00.000Z' },
    { kind: 'constraint', key: 'avoid_new', value: '不碰次新股', evidence: '我不碰次新股', source: 'chat', created_at: '2026-10-21T08:00:00.000Z' },
  ];
  const { service, calls } = makeService({ getSavedFacts: () => savedRows });
  const profile = await service.ask({ question: '我是谁？', bill: BILL });
  check('画像回流：profile 携带 saved_facts 独立通道', profile.saved_facts.length === 2
    && profile.saved_fact_total === 2 && profile.trace.saved_fact_count === 2, JSON.stringify({ saved: profile.saved_facts, trace: profile.trace }));
  check('画像回流：不并入确定性 facts，不改变事实条数', profile.facts.length === 4
    && !profile.facts.some((f) => f.value.includes('长线')), JSON.stringify(profile.facts));
  check('画像回流：notice 说明单独展示', profile.notice.includes('单独列在下方'), profile.notice);

  const how = await service.ask({ question: '我该怎么改？', bill: BILL });
  const baseline = await makeService().service.ask({ question: '我该怎么改？', bill: BILL });
  check('画像回流：怎么改同样展示事实但候选不受影响', how.saved_facts.length === 2
    && JSON.stringify(how.candidate) === JSON.stringify(baseline.candidate)
    && JSON.stringify(how.facts) === JSON.stringify(baseline.facts), JSON.stringify({ how: how.candidate, baseline: baseline.candidate }));

  const worst = await service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  check('画像回流：只在 profile/怎么改读取画像', worst.saved_facts.length === 0
    && calls.savedReads === 2, JSON.stringify(calls));

  const cold = makeService({ getSavedFacts: () => [], loadSavedFacts: () => savedRows });
  const coldProfile = await cold.service.ask({ question: '我是谁？', bill: BILL });
  check('画像回流：缓存冷时按需加载一次', coldProfile.saved_facts.length === 2
    && cold.calls.savedReads === 1 && cold.calls.savedLoads === 1, JSON.stringify(cold.calls));

  const failing = makeService({ getSavedFacts: () => { throw new Error('cloud down'); } });
  const degraded = await failing.service.ask({ question: '我是谁？', bill: BILL });
  check('画像回流：云端失败只降级提示，不阻断回答', degraded.status === 'local'
    && degraded.saved_facts.length === 0
    && degraded.notice.includes('云端画像暂不可用'), JSON.stringify({ status: degraded.status, notice: degraded.notice }));

  const demo = makeService({ getSavedFacts: () => savedRows });
  const demoProfile = await demo.service.ask({ question: '我是谁？', bill: { ...BILL, demo: true } });
  check('画像回流：示例账单不读取云端事实', demoProfile.saved_facts.length === 0
    && demo.calls.savedReads === 0, JSON.stringify(demo.calls));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
