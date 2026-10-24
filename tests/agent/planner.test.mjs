#!/usr/bin/env node
/**
 * M1-C6 · planner 与工具注册表 —— 离线单测（合成数据；零依赖）
 *
 * 覆盖：离线意图桩（4 芯片映射 / 其余越界）、工具注册表（12 项离线可用 / 未接入不注册）、
 *       plan 构建（就绪 / 需澄清 / 不支持 / 兜底）、越界零工具调用、非法意图 JSON 重试 1 次→兜底、
 *       参数校验、工具异常中止与降级记录、确定性（plan_id/输出稳定）、与真实引擎的最小联调。
 * 边界：非产品页面接线；通过仅证明 planner 语义与单测一致，不证明对话链路端到端验收通过。
 * 运行：node tests/agent/planner.test.mjs（或 npm run check）
 */
import {
  buildPlan, runPlan, validateIntentJson, toLogLine, hashQuestion, INTENTS, PLAN_TEMPLATES,
} from '../../src/agent/planner.js';
import { classifyOffline, OFFLINE_CHIP_INTENTS } from '../../src/agent/offlineIntent.js';
import {
  listTools, getTool, validateToolParams, TOOL_REGISTRY, UNAVAILABLE_CAPABILITIES,
} from '../../src/agent/toolRegistry.js';
import { computeIndicators } from '../../src/engine/indicators.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/* —— 合成上下文（占位代码；与引擎单测同风格的极小样例） —— */
const TRADES = [
  { trade_id: 'T001', trade_date: '2024-09-24', symbol: '000000', side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'mini.csv', line: 2 } },
  { trade_id: 'T002', trade_date: '2024-09-27', symbol: '000000', side: 'sell', price: 11, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'mini.csv', line: 3 } },
];
const CLOSES = { '000000': 12 };
const REPORT = computeIndicators({ trades: TRADES, closes: CLOSES });

/* ==== 1. 离线意图桩 ==== */
{
  check('意图桩：4 个预置芯片映射 F-8 既定意图', OFFLINE_CHIP_INTENTS['我最错的一笔是哪个？'] === 'worst_trade'
    && OFFLINE_CHIP_INTENTS['为什么说我追高？'] === 'pattern_explain'
    && OFFLINE_CHIP_INTENTS['我该怎么改？'] === 'how_to_change'
    && OFFLINE_CHIP_INTENTS['我是谁？'] === 'profile');
  const r1 = classifyOffline('我最错的一笔是哪个？');
  check('意图桩：worst_trade 输出形状（slots/confidence/source）', r1.intent === 'worst_trade' && typeof r1.slots === 'object' && r1.confidence === 1 && r1.source === 'offline_stub', JSON.stringify(r1));
  const r2 = classifyOffline('  为什么说我追高？  ');
  check('意图桩：输入首尾空白可容忍', r2.intent === 'pattern_explain', JSON.stringify(r2));
  const r3 = classifyOffline('随便问问大盘怎么样');
  check('意图桩：未匹配 → out_of_scope（不猜测）', r3.intent === 'out_of_scope' && typeof r3.reason === 'string', JSON.stringify(r3));
  const r4 = classifyOffline('');
  check('意图桩：空问题 → out_of_scope', r4.intent === 'out_of_scope', JSON.stringify(r4));
}

/* ==== 2. 工具注册表 ==== */
{
  const tools = listTools();
  check('注册表：登记 22 项离线可用工具', tools.length === 22 && tools.every((t) => t.status === 'offline_available'), JSON.stringify(tools.map((t) => t.id)));
  check('注册表：每项都有稳定 version', tools.every((t) => typeof t.version === 'string' && t.version.length > 0), JSON.stringify(tools.map((t) => [t.id, t.version])));
  check('注册表：含核心引擎工具（indicators/decompose/verify/provenance/replaceSell）',
    ['indicators.compute', 'decompose.drag', 'verify.report', 'provenance.report', 'counterfactual.replaceSell'].every((id) => getTool(id) !== null));
  check('注册表：补首批迁移工具（相似情境/排序/归因/规则/画像/路径区间）',
    ['behavior.similarSameBill', 'decompose.tradeRank', 'behavior.operationAttribution', 'rule.current', 'rule.ledger', 'rule.candidates', 'profile.signals', 'counterfactual.pathRange'].every((id) => getTool(id) !== null));
  check('注册表：行为清单描述含 4 类模式', /追高买入/.test(getTool('behavior.patternList').description)
    && /买回/.test(getTool('behavior.patternList').description)
    && /三日内卖出/.test(getTool('behavior.patternList').description)
    && /交易频率/.test(getTool('behavior.patternList').description));
  check('注册表：required 为数组（无参工具可为空）', tools.every((t) => Array.isArray(t.params.required))
    && tools.filter((t) => t.id !== 'profile.signals').every((t) => t.params.required.length > 0));
  check('注册表：未接入能力不注册（bailian.classify 不可调用）', getTool('bailian.classify') === null);
  check('未接入能力：清理过时条目，只保留实时行情', UNAVAILABLE_CAPABILITIES.length === 1
    && UNAVAILABLE_CAPABILITIES[0].id === 'market.realtime'
    && !UNAVAILABLE_CAPABILITIES.some((c) => c.id === 'bailian.online_intent' || c.id === 'page.chat_wiring'), JSON.stringify(UNAVAILABLE_CAPABILITIES));
  const vt = validateToolParams(getTool('indicators.compute'), { trades: TRADES });
  check('参数校验：缺 closes → ok=false 且 missing 列出', vt.ok === false && vt.missing.includes('closes'), JSON.stringify(vt));
  const vt2 = validateToolParams(getTool('indicators.compute'), { trades: TRADES, closes: CLOSES });
  check('参数校验：齐全 → ok=true', vt2.ok === true && vt2.missing.length === 0);
}

/* ==== 3. plan 构建（就绪 / 需澄清 / 不支持 / 兜底） ==== */
{
  const p1 = buildPlan({ question: '我最错的一笔是哪个？', intentJson: classifyOffline('我最错的一笔是哪个？'), context: { report: REPORT, trades: TRADES } });
  check('planner：worst_trade 就绪（T-worst-trade / decompose.drag）', p1.status === 'ready' && p1.template_id === 'T-worst-trade' && p1.steps.length === 1 && p1.steps[0].tool === 'decompose.drag', JSON.stringify({ s: p1.status, t: p1.template_id }));
  check('planner：步骤参数自上下文解析（report/trades）', p1.steps[0].params.report === REPORT && p1.steps[0].params.trades === TRADES && p1.steps[0].status === 'ready');
  check('planner：plan_id 为确定性哈希（plan- + 16 位十六进制）', /^plan-[0-9a-f]{16}$/.test(p1.plan_id), p1.plan_id);

  const p2 = buildPlan({ question: '整体表现如何？', intentJson: { intent: 'loss_overview', slots: {}, confidence: 0.8 }, context: { trades: TRADES, closes: CLOSES, report: REPORT } });
  check('planner：loss_overview 双步就绪', p2.status === 'ready' && p2.steps.length === 2 && p2.steps[0].tool === 'indicators.compute' && p2.steps[1].tool === 'decompose.drag', JSON.stringify(p2.steps.map((s) => s.tool)));

  const p3 = buildPlan({ question: '我最错的一笔是哪个？', intentJson: classifyOffline('我最错的一笔是哪个？'), context: {} });
  check('planner：缺上下文 → needs_context（澄清，不猜测）', p3.status === 'needs_context' && p3.fallback_used === false, JSON.stringify(p3.status));
  check('planner：pending_params 列出缺失键', p3.pending_params.length === 1 && p3.pending_params[0].tool === 'decompose.drag'
    && JSON.stringify(p3.pending_params[0].missing) === JSON.stringify(['report', 'trades']), JSON.stringify(p3.pending_params));

  const p4 = buildPlan({ question: '随便问问', intentJson: classifyOffline('随便问问'), context: {} });
  check('planner：out_of_scope → 兜底零工具调用', p4.status === 'fallback' && p4.fallback_used === true && p4.steps.length === 0, JSON.stringify(p4));

  const MARKET = { resolveValuation() {}, getClose() {} };
  const p5 = buildPlan({ question: '上次类似的情况？', intentJson: { intent: 'similar_context', slots: {}, confidence: 0.9 }, context: { trades: TRADES, market: MARKET, question: '上次类似的情况？' } });
  check('planner：similar_context → 同账单相似匹配（非兜底）', p5.status === 'ready' && p5.steps.length === 1 && p5.steps[0].tool === 'behavior.similarSameBill' && p5.fallback_used === false, JSON.stringify(p5.status));
  check('planner：similar_context 口径限定同一账单', p5.composition_reason.includes('同一账单') && p5.composition_reason.includes('不做跨账单'), p5.composition_reason);
  const p5b = buildPlan({ question: '上次类似的情况？', intentJson: { intent: 'similar_context', slots: {}, confidence: 0.9 }, context: {} });
  check('planner：similar_context 缺行情 → needs_context 列缺失参数', p5b.status === 'needs_context' && p5b.fallback_used === false
    && p5b.pending_params.some((p) => p.tool === 'behavior.similarSameBill' && p.missing.includes('market')), JSON.stringify(p5b.pending_params));

  const p5c = buildPlan({
    question: '我在其他账单里有没有类似的操作？',
    intentJson: { intent: 'cross_bill', slots: {}, confidence: 0.9 },
    context: { historyIndex: { rows: [] }, patterns: [{ id: 'chase_high_buy', name: '追高买入', hits: 3 }] },
  });
  check('planner：cross_bill → 本人历史账单索引（非兜底）', p5c.status === 'ready'
    && p5c.steps.length === 1 && p5c.steps[0].tool === 'history.crossBillIndex'
    && p5c.steps[0].params.patterns.length === 1, JSON.stringify(p5c.steps));
  check('planner：cross_bill 口径限定本人已保存账单', p5c.composition_reason.includes('本人已保存账单')
    && p5c.composition_reason.includes('只报次数'), p5c.composition_reason);
  const p5d = buildPlan({
    question: '我在其他账单里有没有类似的操作？',
    intentJson: { intent: 'cross_bill', slots: {}, confidence: 0.9 },
    context: {},
  });
  check('planner：cross_bill 缺索引 → needs_context', p5d.status === 'needs_context'
    && p5d.pending_params.some((p) => p.tool === 'history.crossBillIndex' && p.missing.includes('historyIndex')),
    JSON.stringify(p5d.pending_params));

  const p6 = buildPlan({ question: '立个规则', intentJson: { intent: 'contract_setup', slots: {}, confidence: 0.9 }, context: { template_id: 'no_buy_on_surge', fields: {} } });
  check('planner：contract_setup → contract.parse', p6.status === 'ready' && p6.steps[0].tool === 'contract.parse');
}

/* ==== 4. 越界零工具调用（runPlan 实测） ==== */
{
  const p = buildPlan({ question: '介绍一下你自己', intentJson: classifyOffline('介绍一下你自己') });
  const run = runPlan({ plan: p });
  check('越界：runPlan 执行 0 次工具、无降级记录', run.executed === 0 && run.results.length === 0 && run.degraded.length === 0 && run.aborted === false, JSON.stringify(run));
  const unknownPlan = { plan_id: 'p-x', steps: [{ tool: 'bailian.classify', params: {}, params_keys: [] }] };
  const run2 = runPlan({ plan: unknownPlan });
  check('未接入能力不可调用：未知工具 → E_TOOL_UNKNOWN 并中止', run2.executed === 0 && run2.aborted === true && run2.degraded[0].code === 'E_TOOL_UNKNOWN', JSON.stringify(run2.degraded));
}

/* ==== 5. 非法意图 JSON：重试 1 次 → 兜底 ==== */
{
  const bad = { intent: 'not_an_intent', slots: {}, confidence: 0.5 };
  const p1 = buildPlan({ question: '问题', intentJson: bad });
  check('非法 JSON（无重试）→ 兜底零调用', p1.status === 'fallback' && p1.fallback_used === true && p1.steps.length === 0, JSON.stringify(p1.reasons));
  check('非法 JSON（无重试）：原因注明非法原因', p1.reasons.length > 0 && p1.reasons[0].includes('intent 非法'), JSON.stringify(p1.reasons));

  const good = { intent: 'meta_calc', slots: {}, confidence: 0.7 };
  const p2 = buildPlan({ question: '这个数字怎么算的', intentJson: bad, retryIntentJson: good, context: { report: REPORT, trades: TRADES, closes: CLOSES, valuation: {} } });
  check('非法 JSON + 有效重试 → 使用重试结果', p2.intent === 'meta_calc' && p2.status === 'ready' && p2.steps[0].tool === 'provenance.report', JSON.stringify({ i: p2.intent, s: p2.status }));

  const p3 = buildPlan({ question: '问题', intentJson: bad, retryIntentJson: bad });
  check('重试仍非法 → 兜底并注明已重试 1 次', p3.status === 'fallback' && p3.reasons.some((r) => r.includes('已重试 1 次')), JSON.stringify(p3.reasons));

  const p4 = buildPlan({ question: '问题', intentJson: { intent: 'worst_trade', slots: {}, confidence: 2 } });
  check('confidence 越界 → 兜底', p4.status === 'fallback' && p4.reasons.some((r) => r.includes('confidence')), JSON.stringify(p4.reasons));

  const p5 = buildPlan({ question: '问题', intentJson: null });
  check('意图 JSON 非对象 → 兜底', p5.status === 'fallback' && p5.reasons.length > 0);

  const p6 = buildPlan({ question: '  ', intentJson: classifyOffline('') });
  check('空问题 → 兜底零调用', p6.status === 'fallback' && p6.fallback_used === true && p6.steps.length === 0);
}

/* ==== 6. 参数校验与执行降级 ==== */
{
  const p = buildPlan({ question: '我最错的一笔是哪个？', intentJson: classifyOffline('我最错的一笔是哪个？'), context: {} });
  const run = runPlan({ plan: p });
  check('缺参 plan 直接执行 → E_PARAM_INVALID 并中止（不吞错）', run.executed === 0 && run.aborted === true && run.degraded[0].code === 'E_PARAM_INVALID'
    && run.degraded[0].missing.includes('report'), JSON.stringify(run.degraded));

  const fakeRegistry = new Map([
    ['fake.ok', { id: 'fake.ok', params: { required: ['x'], optional: [] }, invoke: ({ x }) => ({ got: x }) }],
    ['fake.boom', { id: 'fake.boom', params: { required: [], optional: [] }, invoke: () => { throw new Error('合成失败'); } }],
  ]);
  const failPlan = { plan_id: 'p-fail', steps: [
    { tool: 'fake.boom', params: {}, params_keys: [] },
    { tool: 'fake.ok', params: { x: 1 }, params_keys: ['x'] },
  ] };
  const rf = runPlan({ plan: failPlan, registry: fakeRegistry });
  check('工具异常 → 中止该步并降级记录（E_TOOL_FAILED）', rf.executed === 0 && rf.aborted === true && rf.degraded[0].code === 'E_TOOL_FAILED' && rf.degraded[0].message.includes('合成失败'), JSON.stringify(rf.degraded));
  check('中止后不再执行后续步骤（E_STEP_SKIPPED）', rf.degraded.length === 2 && rf.degraded[1].code === 'E_STEP_SKIPPED', JSON.stringify(rf.degraded));
  const okPlan = { plan_id: 'p-ok', steps: [{ tool: 'fake.ok', params: { x: 42 }, params_keys: ['x'] }] };
  const ro = runPlan({ plan: okPlan, registry: fakeRegistry });
  check('正常路径：执行 1 次并返回输出', ro.executed === 1 && ro.aborted === false && ro.results[0].output.got === 42, JSON.stringify(ro));
}

/* ==== 7. 与真实引擎联调（极小合成样例；不锚定夹具期望） ==== */
{
  const p = buildPlan({ question: '我最错的一笔是哪个？', intentJson: classifyOffline('我最错的一笔是哪个？'), context: { report: REPORT, trades: TRADES } });
  const run = runPlan({ plan: p });
  check('联调：decompose 执行成功（executed=1，无降级）', run.executed === 1 && run.degraded.length === 0, JSON.stringify(run.degraded));
  const decomp = run.results[0] && run.results[0].output;
  check('联调：分解总量 = 100（手算：100×(12−11)）', decomp && near(decomp.total.value, 100), decomp && decomp.total.value);
  check('联调：逐笔项为 T002（卖出笔）', decomp && decomp.items.length === 1 && decomp.items[0].trade_id === 'T002', JSON.stringify(decomp && decomp.items));

  const p2 = buildPlan({ question: '可信么', intentJson: { intent: 'meta_trust', slots: {}, confidence: 0.9 }, context: { report: REPORT, trades: TRADES, closes: CLOSES } });
  const run2 = runPlan({ plan: p2 });
  // 单标的小样例：9 项标的 fact + 8 项组合 fact = 17；全部通过（fail=0、恒等式 0 失败）
  check('联调：verify 执行成功且全过（17/17，fail=0）', run2.executed === 1 && run2.results[0].output.summary.n_facts === 17
    && run2.results[0].output.summary.fail === 0 && run2.results[0].output.summary.identities_fail === 0, JSON.stringify(run2.results[0] && run2.results[0].output.summary));

  const p3 = buildPlan({ question: '流程', intentJson: { intent: 'loss_overview', slots: {}, confidence: 0.9 }, context: { trades: TRADES, closes: CLOSES, report: REPORT } });
  const run3 = runPlan({ plan: p3 });
  check('联调：双步计划顺序执行（indicators → decompose）', run3.executed === 2 && run3.results[0].tool === 'indicators.compute' && run3.results[1].tool === 'decompose.drag', JSON.stringify(run3.results.map((r) => r.tool)));
  check('联调：双步输出一致（dragMoney=100 两侧）', near(run3.results[0].output.per_stock['000000'].dragMoney, 100) && near(run3.results[1].output.total.value, 100));
}

/* ==== 8. 确定性与日志 ==== */
{
  const args = { question: '我最错的一笔是哪个？', intentJson: classifyOffline('我最错的一笔是哪个？'), context: { report: REPORT, trades: TRADES } };
  const a = buildPlan(args);
  const b = buildPlan(args);
  check('确定性：同输入两次构建输出完全一致', JSON.stringify(a) === JSON.stringify(b));
  const c = buildPlan({ ...args, question: '换个问题' });
  check('确定性：问题不同 → plan_id 不同', a.plan_id !== c.plan_id);
  check('确定性：hashQuestion 稳定（同题同值）', hashQuestion('abc') === hashQuestion('abc') && hashQuestion('abc') !== hashQuestion('abd'));
  check('意图全集：14 类且每类均有模板', INTENTS.length === 14 && INTENTS.every((i) => PLAN_TEMPLATES[i] !== undefined));

  const line = toLogLine(a, { ts: 'T0' });
  check('日志：含附A.1 关键字段', line.ts === 'T0' && line.plan_id === a.plan_id && line.intent === 'worst_trade' && line.template === 'T-worst-trade'
    && Array.isArray(line.steps) && line.fallback_used === false && line.outcome === 'ready', JSON.stringify(line));
  check('日志：steps 含 params_digest（16 位十六进制）与状态', /^[0-9a-f]{16}$/.test(line.steps[0].params_digest) && line.steps[0].status === 'ready' && line.steps[0].ms === null);
  const line2 = toLogLine(a, {});
  check('日志：未提供 ts 时为 null（确定性）', line2.ts === null && JSON.stringify(toLogLine(a, {})) === JSON.stringify(line2));
  const v = validateIntentJson({ intent: 'worst_trade', slots: {}, confidence: 1 });
  check('意图 JSON 校验：合法 → ok', v.ok === true && v.errors.length === 0);
  const v2 = validateIntentJson({ intent: 'worst_trade', confidence: 1 });
  check('意图 JSON 校验：缺 slots → 报错', v2.ok === false && v2.errors.some((e) => e.includes('slots')), JSON.stringify(v2.errors));
}

/* ==== 9. 跨步骤参数、依赖与可选步骤 ==== */
{
  const fakeRegistry = new Map([
    ['fake.seed', { id: 'fake.seed', params: { required: ['x'], optional: [] }, invoke: ({ x }) => ({ doubled: x * 2, nested: { value: 7 } }) }],
    ['fake.use', { id: 'fake.use', params: { required: ['y'], optional: [] }, invoke: ({ y }) => ({ got: y }) }],
    ['fake.boom', { id: 'fake.boom', params: { required: [], optional: [] }, invoke: () => { throw new Error('合成失败'); } }],
  ]);
  const refPlan = { plan_id: 'p-ref', steps: [
    { id: 'S1', tool: 'fake.seed', params: { x: 21 }, params_keys: ['x'], depends_on: [] },
    { id: 'S2', tool: 'fake.use', params: { y: '$S1.nested.value' }, params_keys: ['y'], depends_on: ['S1'] },
  ] };
  const rr = runPlan({ plan: refPlan, registry: fakeRegistry });
  check('跨步骤参数：$S1.field.path 取到上游输出', rr.executed === 2 && rr.results[1].output.got === 7, JSON.stringify(rr.results));
  check('跨步骤参数：结果带步骤 id 与耗时', rr.results[1].step_id === 'S2' && Number.isInteger(rr.results[1].ms), JSON.stringify(rr.results[1]));

  const optionalPlan = { plan_id: 'p-opt', steps: [
    { id: 'S1', tool: 'fake.boom', params: {}, params_keys: [], optional: true },
    { id: 'S2', tool: 'fake.seed', params: { x: 1 }, params_keys: ['x'], depends_on: [] },
  ] };
  const ro = runPlan({ plan: optionalPlan, registry: fakeRegistry });
  check('可选步骤失败：记录降级但继续出结果', ro.executed === 1 && ro.aborted === false
    && ro.degraded.length === 1 && ro.degraded[0].code === 'E_TOOL_FAILED'
    && ro.results[0].step_id === 'S2', JSON.stringify(ro));
  check('可选步骤失败：降级记录带耗时', Number.isInteger(ro.degraded[0].ms), JSON.stringify(ro.degraded[0]));

  const depPlan = { plan_id: 'p-dep', steps: [
    { id: 'S1', tool: 'fake.boom', params: {}, params_keys: [], optional: true },
    { id: 'S2', tool: 'fake.use', params: { y: 1 }, params_keys: ['y'], depends_on: ['S1'] },
  ] };
  const rd = runPlan({ plan: depPlan, registry: fakeRegistry });
  check('依赖失败：跳过该步并中止后续', rd.executed === 0 && rd.aborted === true
    && rd.degraded.map((d) => d.code).join(',') === 'E_TOOL_FAILED,E_STEP_DEPENDENCY'
    && rd.degraded[1].missing.includes('S1'), JSON.stringify(rd.degraded));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
