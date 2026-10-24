#!/usr/bin/env node
/**
 * P2 · 单轮编排 —— 离线单测（注入桩；零网络）
 *
 * 覆盖：Trace 耗时覆盖、同阶段合并、总耗时、范围外跳过意图、
 *       回答状态映射、事实计数、模型调用标记。
 * 运行：node tests/agent/orchestrator.test.mjs（或 npm run check）
 */
import { createTrace, createOrchestrator, TRACE_STAGES } from '../../src/agent/orchestrator.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

/* ==== ① Trace 基础 ==== */
{
  let t = 0;
  const trace = createTrace({ now: () => t });
  t = 10;
  trace.push('scope', 'running', '判断问题范围');
  t = 30;
  const done = trace.push('scope', 'done', '判断问题范围', { detail: '账单问题' });
  check('同阶段合并：running 等待与完成耗时相加', done.ms === 30, JSON.stringify(done));
  const step = trace.push('tool', 'done', '计算', { tool: 'x', ms: 7 });
  check('耗时覆盖：工具步骤使用真实耗时', step.ms === 7, JSON.stringify(step));
  check('同阶段合并：running 原位替换', trace.events()[0].stage === 'scope' && trace.events()[0].status === 'done');
  t = 45;
  trace.push('intent', 'skipped', '无需识别账单意图');
  check('总耗时：从创建到当前的非负整数', trace.totalMs() === 45, trace.totalMs());
  check('阶段白名单：11 个阶段固定', TRACE_STAGES.length === 11 && TRACE_STAGES.includes('verify') && TRACE_STAGES.includes('degraded'));
  let threw = false;
  try { trace.push('bogus', 'done', 'x'); } catch { threw = true; }
  check('未知阶段：直接报错', threw);
}

/* ==== ② 编排：范围 / 意图 / 计划 / 生成 ==== */
function build({ scopeKind = 'bill', decision = null, envelope = null, verify = null } = {}) {
  const calls = { decide: 0, answer: 0, verify: 0 };
  const intentPolicy = {
    async decide() {
      calls.decide += 1;
      return decision ?? { intent: 'worst_trade', model_called: false, decided_by: 'local', route: { layer: 'L1' } };
    },
  };
  const answer = async ({ scope, trace }) => {
    calls.answer += 1;
    if (scope.kind === 'bill') trace.push('context', 'done', '已读取已发布报告');
    return envelope ?? { status: 'local', facts: [{ label: '差额', value: '¥100.00' }], text: '合成回答', source: 'local' };
  };
  const orchestrator = createOrchestrator({
    routeScope: () => ({ kind: scopeKind }),
    intentPolicy,
    answer,
    verify: verify ? (args) => { calls.verify += 1; return verify(args); } : null,
    now: () => 0,
  });
  return { orchestrator, calls };
}

{
  const { orchestrator, calls } = build();
  const out = await orchestrator.runTurn({ question: '我最错的一笔是哪个？', bill: { contextId: 'b1' }, source: 'chip' });
  const stages = out.trace.map((e) => e.stage);
  check('账单问题：范围→意图→计划→上下文→生成→完成', stages.join(',') === 'scope,intent,plan,context,compose,done', stages.join(','));
  check('账单问题：意图判断与回答各调用一次', calls.decide === 1 && calls.answer === 1, JSON.stringify(calls));
  check('完成事件：写明事实条数', out.trace.at(-1).detail === '1 条事实', out.trace.at(-1).detail);
  check('回答：原样返回信封', out.envelope.text === '合成回答' && out.envelope.facts.length === 1);
}

{
  const { orchestrator, calls } = build({ scopeKind: 'refusal' });
  const out = await orchestrator.runTurn({ question: '明天买什么？', bill: { contextId: 'b1' }, source: 'typed' });
  check('范围外：不判断账单意图、不调用意图策略', calls.decide === 0, JSON.stringify(calls));
  check('范围外：意图阶段标为跳过', out.trace.some((e) => e.stage === 'intent' && e.status === 'skipped'));
  check('范围外：完成事件写明未读取账单数字', out.trace.at(-1).detail === '未读取账单数字', out.trace.at(-1).detail);
}

{
  const { orchestrator } = build({ envelope: { status: 'error', facts: [], text: '未生成', source: 'local' } });
  const out = await orchestrator.runTurn({ question: '组合表现？', bill: { contextId: 'b1' }, source: 'typed' });
  const compose = out.trace.find((e) => e.stage === 'compose');
  check('错误回答：生成阶段标记 failed', compose.status === 'failed' && compose.detail === '本次未生成回答', JSON.stringify(compose));
  check('错误回答：完成事件为 0 条事实', out.trace.at(-1).detail === '0 条事实', out.trace.at(-1).detail);
}

{
  const { orchestrator } = build({
    decision: { intent: 'pattern_explain', model_called: true, decided_by: 'model', route: { layer: 'L2' } },
  });
  const out = await orchestrator.runTurn({ question: '我是不是总在同一个地方栽跟头？', bill: { contextId: 'b1' }, source: 'typed' });
  const intentEvent = out.trace.find((e) => e.stage === 'intent');
  check('自由输入：意图标注为模型分析', intentEvent.label === '模型分析意图' && intentEvent.detail === '已识别', JSON.stringify(intentEvent));
  check('计划阶段：写明按意图生成', out.trace.find((e) => e.stage === 'plan').detail === '按意图生成本地回答');
}

/* ==== ③ 发布前复核：通过 / 不发布 ==== */
{
  const seen = [];
  const { orchestrator, calls } = build({
    verify: ({ envelope, scope, bill, question }) => {
      seen.push({ envelope, scope, bill, question });
      return { ok: true, status: 'pass', envelope };
    },
  });
  const out = await orchestrator.runTurn({ question: '我最错的一笔是哪个？', bill: { contextId: 'b1' }, source: 'typed' });
  check('复核通过：用同一信封调用一次', calls.verify === 1 && seen.length === 1
    && seen[0].envelope.text === '合成回答' && seen[0].bill.contextId === 'b1'
    && seen[0].question === '我最错的一笔是哪个？', JSON.stringify(seen[0]?.envelope));
  const verifyEvent = out.trace.find((e) => e.stage === 'verify');
  check('复核通过：Trace 在生成前标注一致', verifyEvent.status === 'done'
    && verifyEvent.label === '发布前复核' && verifyEvent.detail === '数字与证据一致', JSON.stringify(verifyEvent));
  const stages = out.trace.map((e) => e.stage);
  check('复核通过：复核位于改写/生成与完成之间', stages.join(',')
    === 'scope,intent,plan,context,verify,compose,done', stages.join(','));
}

{
  const withheld = {
    status: 'withheld', facts: [], evidence: [], claims: [], text: '这次回答没有通过发布前复核，不展示具体数字。',
    notice: '数字复核未通过，本次不发布具体结果', rewrite: null, narrative_policy: 'none',
  };
  const { orchestrator } = build({
    verify: () => ({ ok: false, status: 'withheld', reasons: ['numbers_sourced:LOCAL_TEXT_NUMBERS'], envelope: withheld }),
  });
  const out = await orchestrator.runTurn({ question: '我最错的一笔是哪个？', bill: { contextId: 'b1' }, source: 'typed' });
  const verifyEvent = out.trace.find((e) => e.stage === 'verify');
  check('复核失败：Trace 标注未通过', verifyEvent.status === 'failed' && verifyEvent.detail === '数字或证据未通过', JSON.stringify(verifyEvent));
  check('复核失败：降级事件说明不发布', out.trace.some((e) => e.stage === 'degraded' && e.label === '本次不发布具体数字'));
  check('复核失败：改用不发布信封', out.envelope.status === 'withheld' && out.envelope.facts.length === 0);
  check('复核失败：Trace 不出现内部原因码', !JSON.stringify(out.trace).includes('LOCAL_TEXT_NUMBERS')
    && !/E_[A-Z0-9_]+/u.test(JSON.stringify(out.trace)), JSON.stringify(out.trace));
  const compose = out.trace.find((e) => e.stage === 'compose');
  check('复核失败：生成阶段写明未发布数字', compose.detail === '发布前复核未通过，未发布数字', compose.detail);
  check('复核失败：完成事件为 0 条事实', out.trace.at(-1).detail === '0 条事实', out.trace.at(-1).detail);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
