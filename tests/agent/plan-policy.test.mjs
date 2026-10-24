#!/usr/bin/env node
/**
 * P2 · 计划策略 —— 离线单测（合成数据；零网络）
 *
 * 覆盖：仅账单范围生成工具计划、未定义意图/未注册工具拒绝、
 *       报告缺失与未发布门槛、步骤装饰（id/depends_on/optional/reason/fallbacks）、确定性。
 * 运行：node tests/agent/plan-policy.test.mjs（或 npm run check）
 */
import { planForTurn, PLAN_POLICY_VERSION } from '../../src/agent/planPolicy.js';
import { TOOL_REGISTRY } from '../../src/agent/toolRegistry.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TRADES = [
  { trade_id: 'T001', trade_date: '2024-09-24', symbol: '000000', side: 'buy', price: 10, quantity: 100 },
  { trade_id: 'T002', trade_date: '2024-09-27', symbol: '000000', side: 'sell', price: 11, quantity: 100 },
];
const MARKET = { tradingDays: ['2024-09-24', '2024-09-25', '2024-09-26', '2024-09-27'], getClose: () => 10, resolveValuation: () => ({ blocked: false }) };
const CONTEXT = { trades: TRADES, market: MARKET, report: { per_stock: {} }, closes: { '000000': 12 } };

/* ==== ① 范围与意图门槛 ==== */
{
  const out = planForTurn({ question: '明天买什么？', intent: 'loss_overview', scope: { kind: 'refusal' }, context: CONTEXT });
  check('范围外：不生成工具计划', out.status === 'scope' && out.steps.length === 0 && out.scope_kind === 'refusal', JSON.stringify(out));

  const unknown = planForTurn({ question: '随便', intent: 'not_an_intent', context: CONTEXT });
  check('未定义意图：拒绝且零步骤', unknown.status === 'rejected'
    && unknown.steps.length === 0 && unknown.reasons[0].includes('未定义的意图'), JSON.stringify(unknown));
}

/* ==== ② 未注册工具直接拒绝 ==== */
{
  const out = planForTurn({
    question: '为什么说我追高？', intent: 'pattern_explain', context: CONTEXT,
    registry: new Map([['indicators.compute', TOOL_REGISTRY.get('indicators.compute')]]),
  });
  check('未注册工具：拒绝并写明工具名', out.status === 'rejected'
    && out.reasons[0].includes('behavior.patternList'), JSON.stringify(out.reasons));
}

/* ==== ③ 发布门槛 ==== */
{
  const missing = planForTurn({ question: '组合收益如何？', intent: 'loss_overview', context: CONTEXT, availability: { bundle: false } });
  check('报告缺失：needs_context 且不生成步骤', missing.status === 'needs_context'
    && missing.pending_params[0].reason === 'report_bundle_missing', JSON.stringify(missing));

  const blocked = planForTurn({ question: '组合收益如何？', intent: 'loss_overview', context: CONTEXT, availability: { bundle: true, published: false } });
  check('组合未发布：blocked 并保留原因', blocked.status === 'blocked'
    && blocked.blocked_reason.includes('未发布') && blocked.reasons.some((r) => r.includes('不生成事实回答')), JSON.stringify(blocked));
}

/* ==== ④ 步骤装饰 ==== */
{
  const out = planForTurn({ question: '我的组合收益怎么样？', intent: 'loss_overview', context: CONTEXT, availability: { bundle: true, published: true } });
  check('双步计划：就绪且顺序正确', out.status === 'ready'
    && out.steps.map((s) => s.tool).join(',') === 'indicators.compute,decompose.drag', JSON.stringify(out.steps.map((s) => s.tool)));
  check('步骤装饰：稳定 id 与 depends_on 链', out.steps[0].id === 'S1' && out.steps[0].depends_on.length === 0
    && out.steps[1].id === 'S2' && out.steps[1].depends_on.join(',') === 'S1', JSON.stringify(out.steps.map((s) => ({ id: s.id, d: s.depends_on }))));
  check('步骤装饰：reason/fallbacks/optional 齐备', out.steps.every((s) => typeof s.reason === 'string' && s.reason.length > 0
    && Array.isArray(s.fallbacks) && s.fallbacks.length > 0 && typeof s.optional === 'boolean'), JSON.stringify(out.steps));
  check('计划标记：policy_version 写入', out.policy_version === PLAN_POLICY_VERSION);
}

/* ==== ⑤ 确定性 ==== */
{
  const args = { question: '历史上类似的情况？', intent: 'similar_context', context: CONTEXT };
  const a = planForTurn(args);
  const b = planForTurn(args);
  check('确定性：同输入两次计划完全一致', JSON.stringify(a) === JSON.stringify(b));
  check('相似情境：工具为同账单匹配', a.status === 'ready' && a.steps[0].tool === 'behavior.similarSameBill', JSON.stringify(a.steps.map((s) => s.tool)));
  const c = planForTurn({ ...args, question: '换个问题' });
  check('确定性：问题不同则 plan_id 不同', a.plan_id !== c.plan_id, `${a.plan_id} / ${c.plan_id}`);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
