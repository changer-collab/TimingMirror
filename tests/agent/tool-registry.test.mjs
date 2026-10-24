#!/usr/bin/env node
/**
 * P2 · 工具注册表与统一 ToolResult —— 离线单测（合成夹具；零网络）
 *
 * 覆盖：注册表完整性（22 项 / 稳定 version / 未接入能力如实登记）、
 *       统一 ToolResult 形状、核心工具的 facts/records/formulas 投影、
 *       逐笔排序模式、路径区间、行为相似情境、规则与画像工具。
 * 运行：node tests/agent/tool-registry.test.mjs（或 npm run check）
 */
import {
  listTools, getTool, validateToolParams, toolResult,
  TOOL_REGISTRY, TOOL_RESULT_VERSION, UNAVAILABLE_CAPABILITIES,
} from '../../src/agent/toolRegistry.js';
import { computeIndicators } from '../../src/engine/indicators.js';
import { buildDragDecomposition } from '../../src/engine/decompose.js';
import { previewContract, contractSaveRecords } from '../../src/demo/adapter.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TRADES = [
  { trade_id: 'T001', trade_date: '2024-09-24', symbol: '000000', side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'mini.csv', line: 2 } },
  { trade_id: 'T002', trade_date: '2024-09-27', symbol: '000000', side: 'sell', price: 11, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'mini.csv', line: 3 } },
];
const CLOSES = { '000000': 12 };
const REPORT = computeIndicators({ trades: TRADES, closes: CLOSES });
const DECOMPOSITION = buildDragDecomposition({ report: REPORT, trades: TRADES });

const DAYS = ['2024-09-16', '2024-09-17', '2024-09-18', '2024-09-19', '2024-09-20', '2024-09-23', '2024-09-24', '2024-09-25', '2024-09-26', '2024-09-27', '2024-09-30'];
const PRICES = { '000000': { '2024-09-16': 8, '2024-09-17': 8, '2024-09-18': 8, '2024-09-19': 8, '2024-09-20': 8, '2024-09-23': 10, '2024-09-24': 10, '2024-09-25': 10, '2024-09-26': 10, '2024-09-27': 11, '2024-09-30': 11 } };
const MARKET = {
  tradingDays: DAYS,
  resolveValuation(date) { return { blocked: false, requested_date: date, effective_date: date }; },
  getClose(symbol, date) { return PRICES[symbol]?.[date] ?? null; },
};

const run = (id, params) => {
  const tool = getTool(id);
  const output = tool.invoke(params);
  return { output, result: tool.toResult ? tool.toResult({ output, params }) : null };
};

/* ==== ① 注册表完整性 ==== */
{
  const tools = listTools();
  check('注册表：22 项且 id 唯一', tools.length === 22 && new Set(tools.map((t) => t.id)).size === 22,
    `${tools.length}/${new Set(tools.map((t) => t.id)).size}`);
  check('注册表：每项有非空稳定 version 且离线可用', tools.every((t) => typeof t.version === 'string' && t.version.length > 0 && t.status === 'offline_available'),
    JSON.stringify(tools.filter((t) => !t.version)));
  check('注册表：P2 新增工具全部登记', ['behavior.similarSameBill', 'behavior.operationAttribution', 'counterfactual.pathRange', 'decompose.tradeRank', 'rule.current', 'rule.ledger', 'rule.candidates', 'profile.signals'].every((id) => getTool(id) !== null));
  check('注册表：行为清单描述为 4 类模式', getTool('behavior.patternList').description.includes('追高买入')
    && getTool('behavior.patternList').description.includes('卖出后两日内买回')
    && getTool('behavior.patternList').description.includes('买入后三日内卖出')
    && getTool('behavior.patternList').description.includes('交易频率偏高'));
  check('未接入能力：只登记实时/分钟级行情', UNAVAILABLE_CAPABILITIES.length === 1
    && UNAVAILABLE_CAPABILITIES[0].id === 'market.realtime', JSON.stringify(UNAVAILABLE_CAPABILITIES));
  check('未接入能力：不进入可调用注册表', getTool('market.realtime') === null);
  const vt = validateToolParams(getTool('profile.signals'), {});
  check('参数校验：无必填的工具可直接调用', vt.ok === true && vt.missing.length === 0, JSON.stringify(vt));
}

/* ==== ② 统一 ToolResult 形状 ==== */
{
  const r = toolResult({ tool: 'x', facts: [{ label: 'a', value: 1 }, null], records: null });
  check('ToolResult：版本与默认值', r.result_version === TOOL_RESULT_VERSION
    && r.tool === 'x' && r.version === 'v1' && r.ok === true
    && r.facts.length === 1 && Array.isArray(r.records) && r.records.length === 0
    && r.coverage === null, JSON.stringify(r));
  check('ToolResult：ok 显式 false 保留', toolResult({ tool: 'x', ok: false }).ok === false);
  check('ToolResult：未知工具不可调用', getTool('not.a.tool') === null && TOOL_REGISTRY.has('not.a.tool') === false);
}

/* ==== ③ 组合指标与逐笔分解投影 ==== */
{
  const { result } = run('indicators.compute', { trades: TRADES, closes: CLOSES });
  check('指标工具：四事实＋逐标记录＋两条公式', result.ok === true && result.tool === 'indicators.compute'
    && result.facts.map((f) => f.key).join(',') === 'actualRet,ghostRet,drag,dragMoney'
    && result.records.length === 1 && result.records[0].symbol === '000000'
    && result.formulas.length === 2, JSON.stringify(result));
  check('指标工具：假设与边界如实标注', result.assumptions.includes('未计入费用、税费与分红')
    && result.boundaries.some((b) => b.includes('不复权')), JSON.stringify(result));

  const { result: drag } = run('decompose.drag', { report: REPORT, trades: TRADES });
  check('分解工具：合计＋逐笔记录＋公式', drag.ok === true
    && drag.facts.some((f) => f.key === 'total') && drag.facts.some((f) => f.key === 'items' && f.value === '1 笔')
    && drag.records.length === 1 && drag.records[0].dragMoney === 100
    && drag.formulas[0].text.includes('卖出数量'), JSON.stringify(drag));
  check('分解工具：来源引用逐笔日期与标的', drag.source_refs.length === 1
    && drag.source_refs[0].symbol === '000000' && drag.source_refs[0].trade_date === '2024-09-27', JSON.stringify(drag.source_refs));
}

/* ==== ④ 逐笔排序三模式 ==== */
{
  const worst = run('decompose.tradeRank', { report: REPORT, trades: TRADES, mode: 'worst' }).output;
  const best = run('decompose.tradeRank', { report: REPORT, trades: TRADES, mode: 'best' }).output;
  const maxAbs = run('decompose.tradeRank', { report: REPORT, trades: TRADES, mode: 'maxAbs' }).output;
  check('排序工具：worst/best/maxAbs 都返回首项与条目', worst.top?.trade_id === 'T002'
    && best.top?.trade_id === 'T002' && maxAbs.top?.trade_id === 'T002', JSON.stringify({ worst: worst.top?.trade_id, best: best.top?.trade_id }));
  const { result } = run('decompose.tradeRank', { report: REPORT, trades: TRADES, mode: 'worst' });
  check('排序工具：事实写明排首位与差额', result.facts.some((f) => f.key === 'top' && f.value.includes('2024-09-27'))
    && result.facts.some((f) => f.key === 'dragMoney' && f.value === '¥100.00'), JSON.stringify(result.facts));
}

/* ==== ⑤ 路径区间：不足两点如实缺省 ==== */
{
  const short = run('counterfactual.pathRange', { counterfactual: { series: { points: [{ date: '2024-09-30', gap: 10 }] } } }).result;
  check('路径区间：可用点不足 2 天 → ok=false 并说明缺省', short.ok === false
    && short.missing[0].includes('可用交易日不足') && short.facts.length === 0, JSON.stringify(short));
  const full = run('counterfactual.pathRange', {
    counterfactual: { trade_date: '2024-09-27', series: { points: [
      { date: '2024-09-27', gap: 50 }, { date: '2024-09-30', gap: 120 }, { date: '2024-10-08', gap: 30 },
    ] } },
  }).result;
  check('路径区间：报低位/高位但不报概率', full.ok === true
    && full.facts.some((f) => f.key === 'low' && f.value === 30)
    && full.facts.some((f) => f.key === 'high' && f.value === 120)
    && full.boundaries.some((b) => b.includes('不是概率预测')), JSON.stringify(full));
}

/* ==== ⑥ 行为清单与同账单相似情境 ==== */
{
  const { output, result } = run('behavior.patternList', { trades: TRADES, market: MARKET });
  check('行为工具：输出 4 类模式与三态计数', output.patterns.length === 4
    && output.patterns.every((p) => typeof p.status === 'string' && Number.isFinite(p.sample_n))
    && result.facts.length === 4, JSON.stringify(output.patterns.map((p) => p.pattern_id)));

  const similar = run('behavior.similarSameBill', { trades: TRADES, market: MARKET, question: '为什么说我追高？' });
  check('相似情境：按问题点名的模式选中追高', similar.output.focus?.pattern_id === 'chase_high_buy'
    && similar.output.evidence.length > 0
    && similar.result.facts.some((f) => f.key === 'pattern' && f.value === '追高买入'), JSON.stringify(similar.result.facts));
  check('相似情境：边界写明不跨账单、不比行情形态', similar.result.boundaries.some((b) => b.includes('不做跨账单'))
    && similar.result.boundaries.some((b) => b.includes('行情形态')), JSON.stringify(similar.result.boundaries));
  check('相似情境：记录只留日期/标的/方向', similar.result.records.every((r) => Object.keys(r).join(',') === 'id,trade_date,symbol,side,source_ref')
    || similar.result.records.every((r) => !('price' in r) && !('quantity' in r)), JSON.stringify(similar.result.records));

  const single = run('behavior.similarSameBill', {
    trades: [{ trade_id: 'X1', trade_date: '2024-09-24', symbol: '000000', side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'mini.csv', line: 2 } }],
    market: MARKET, question: '历史上类似的情况？',
  }).result;
  check('相似情境：只有一笔时不冒充成立', single.facts.some((f) => f.key === 'status' && f.value === '证据不足')
    && !single.facts.some((f) => f.value === '成立'), JSON.stringify(single.facts));
}

/* ==== ⑦ 规则与画像工具 ==== */
{
  const parsed = previewContract({ template_id: 'sell_within_after_buy', fields: { days: '3' } });
  const versions = contractSaveRecords([], { parsed, note: null });
  const current = run('rule.current', { versions }).result;
  check('规则工具：当前生效 1 条并提供模板记录', current.facts.some((f) => f.key === 'active_count' && f.value === '1 条')
    && current.records.length === 1 && current.boundaries.some((b) => b.includes('不下单')), JSON.stringify(current));

  const ledger = run('rule.ledger', { rules: [{ template_id: 'sell_within_after_buy', fields: { days: 3 } }], trades: TRADES }).result;
  check('守约账本：复核笔数与命中笔数都是数字', ledger.facts.some((f) => f.key === 'reviewed')
    && ledger.facts.some((f) => f.key === 'triggered') && ledger.boundaries.some((b) => b.includes('不是实时监控')), JSON.stringify(ledger));

  const signals = run('profile.signals', { behavior: run('behavior.patternList', { trades: TRADES, market: MARKET }).output }).result;
  check('画像信号：只由行为证据派生且不生成人格标签', signals.ok === true
    && signals.boundaries.some((b) => b.includes('不生成性格')), JSON.stringify(signals));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
