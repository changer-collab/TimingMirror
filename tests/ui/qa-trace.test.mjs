#!/usr/bin/env node
/**
 * 真实运行过程（Trace）—— 离线单测（合成编排；不联网）
 *
 * 覆盖：事件顺序与耗时、running→done 合并、回落事件、范围外跳过意图、
 *       回答上方的折叠面板、增量合并、内部 ID 不进入用户可见字段。
 * 运行：node tests/ui/qa-trace.test.mjs（或 npm run check）
 */
import { readFileSync } from 'node:fs';
import { createTrace, createOrchestrator } from '../../src/agent/orchestrator.js';
import { createIntentPolicy } from '../../src/agent/intentPolicy.js';
import { routeScope } from '../../src/agent/scopeRouter.js';
import { createQaAnswerService } from '../../prototype/user-frontend/qaAnswer.js';
import { mergeTraceEvent, traceHTML } from '../../prototype/user-frontend/realChat.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BILL = { status: 'confirmed', sourceType: 'local', contextId: 'bill-trace-1' };
const LOCAL_WORST = { intent: 'worst_trade', slots: {}, layer: 'L1', source: 'L1', confidence: 1, matchedBy: 'rule' };

/* ==== ① Trace 基础：耗时、合并与字段白名单 ==== */
{
  let t = 0;
  const seen = [];
  const trace = createTrace({ now: () => t, onStage: (event) => seen.push(event) });
  t = 10;
  trace.push('scope', 'running', '判断问题范围');
  t = 25;
  trace.push('scope', 'done', '判断问题范围', { detail: '账单问题', plan_id: 'plan-x', template_id: 'T-x' });
  const events = trace.events();
  check('合并：同阶段 running 被完成事件原位替换', events.length === 1
    && events[0].status === 'done' && events[0].detail === '账单问题', JSON.stringify(events));
  check('耗时：从开始到完成累计，非负整数', events[0].ms === 25 && Number.isInteger(events[0].ms), JSON.stringify(events[0]));
  check('实时：onStage 依次收到 running 与完成事件', seen.length === 2
    && seen[0].status === 'running' && seen[1].status === 'done', JSON.stringify(seen));
  check('白名单：计划/模板 ID 不进入事件', !('plan_id' in events[0]) && !('template_id' in events[0]), JSON.stringify(events[0]));
  check('事件副本：外部修改不影响已返回列表', (() => {
    const copy = trace.events();
    copy[0].label = '被改';
    return trace.events()[0].label === '判断问题范围';
  })());
  let threw = false;
  try { trace.push('unknown', 'done', 'x'); } catch { threw = true; }
  check('阶段白名单：未知阶段直接报错', threw);
}

/* ==== ② 编排顺序：芯片零模型、自由输入模型优先、回落有记录 ==== */
async function runOrchestrator({ question, source, classifyIntent, local = () => LOCAL_WORST, facts = 2 }) {
  const intentCalls = [];
  const policy = createIntentPolicy({
    classifyLocal: local,
    classifyIntent: classifyIntent
      ? async (args) => { intentCalls.push(args.question); return classifyIntent(args); }
      : null,
  });
  const answer = async ({ trace, scope }) => {
    if (scope.kind === 'bill') trace.push('context', 'done', '已读取已发布报告');
    return { status: scope.kind === 'refusal' ? 'refusal' : 'local', facts: Array(facts).fill({ label: 'x', value: '1' }), text: '合成回答', source: 'local' };
  };
  const orchestrator = createOrchestrator({ routeScope, intentPolicy: policy, answer, now: () => 0 });
  const out = await orchestrator.runTurn({ question, bill: BILL, source });
  return { ...out, intentCalls };
}

{
  const chip = await runOrchestrator({ question: '我最错的一笔是哪个？', source: 'chip' });
  const stages = chip.trace.map((e) => e.stage);
  const intentEvent = chip.trace.find((e) => e.stage === 'intent');
  check('芯片：顺序为范围→意图→计划→上下文→生成→完成', stages.join(',') === 'scope,intent,plan,context,compose,done', stages.join(','));
  check('芯片：标注“未调用模型”且分类器零调用', intentEvent.label === '本地规则匹配'
    && intentEvent.detail === '未调用模型' && chip.intentCalls.length === 0, JSON.stringify({ intentEvent, calls: chip.intentCalls }));
  check('完成：写明事实条数', chip.trace.at(-1).detail === '2 条事实', JSON.stringify(chip.trace.at(-1)));
}

{
  const typed = await runOrchestrator({
    question: '我最错的一笔是哪个？',
    source: 'typed',
    classifyIntent: async () => ({ ok: true, intentJson: { intent: 'worst_trade', slots: {}, confidence: 0.9 } }),
  });
  const intentEvent = typed.trace.find((e) => e.stage === 'intent');
  check('自由输入：先请求模型，命中后标为“模型分析意图”', typed.intentCalls.length === 1
    && intentEvent.label === '模型分析意图' && intentEvent.detail === '已识别', JSON.stringify({ intentEvent, calls: typed.intentCalls }));
  check('自由输入：没有回落事件', !typed.trace.some((e) => e.stage === 'degraded'), JSON.stringify(typed.trace));
}

{
  const fallback = await runOrchestrator({
    question: '我最错的一笔是哪个？',
    source: 'typed',
    classifyIntent: async () => ({ ok: false, code: 'E_INTENT_DOWN' }),
  });
  const degraded = fallback.trace.find((e) => e.stage === 'degraded');
  check('回落：留下“模型接口不可用”事件并继续本地回答', !!degraded
    && degraded.label.includes('模型接口不可用') && degraded.status === 'done'
    && fallback.envelope.status === 'local', JSON.stringify(fallback.trace));
  check('回落：仍使用本地意图，不改变回答', fallback.envelope.facts.length === 2);
}

{
  const refusal = await runOrchestrator({ question: '明天买什么？', source: 'typed' });
  const intentEvent = refusal.trace.find((e) => e.stage === 'intent');
  check('范围外：跳过意图，不调用分类器', intentEvent.status === 'skipped'
    && refusal.intentCalls.length === 0, JSON.stringify({ intentEvent, calls: refusal.intentCalls }));
  check('范围外：完成事件写明未读取账单数字', refusal.trace.at(-1).detail === '未读取账单数字', JSON.stringify(refusal.trace.at(-1)));
}

{
  const reusePolicy = {
    decide: async () => ({
      ok: true, intent: 'loss_overview', slots: {}, confidence: 0.9, source: 'typed',
      decided_by: 'reuse', model_called: false, local_check: 'reuse', model_intent: null,
      latency_ms: 0, ambiguous: false,
      route: { intent: 'loss_overview', slots: {}, layer: 'L1', source: 'L1', confidence: 0.9, matchedBy: 'reuse' },
    }),
  };
  const orchestrator = createOrchestrator({
    routeScope,
    intentPolicy: reusePolicy,
    answer: async ({ trace }) => {
      trace.push('context', 'done', '已读取已发布报告');
      return { status: 'online', facts: [{}, {}, {}, {}], text: '合成复述', source: 'online' };
    },
    now: () => 0,
  });
  const out = await orchestrator.runTurn({ question: '我的组合收益怎么样？', bill: BILL });
  const intentEvent = out.trace.find((e) => e.stage === 'intent');
  check('复用意图：在线复述等后续动作不重新判断意图', intentEvent.label === '沿用已有意图'
    && intentEvent.detail === '未重新判断' && out.envelope.status === 'online', JSON.stringify(intentEvent));
}

/* ==== ③ 服务端信封：Trace 与回答一起返回，且不含内部 ID ==== */
{
  const service = createQaAnswerService({ getBundle: () => null, loadBundle: null });
  const out = await service.ask({ question: '明天买什么？', bill: BILL });
  check('返回形状：{trace, envelope}', Array.isArray(out.trace) && out.envelope?.status === 'refusal', JSON.stringify(out.envelope));
  check('拒答：Trace 无上下文/工具步骤', !out.trace.some((e) => e.stage === 'context' || e.stage === 'tool'), JSON.stringify(out.trace));
  check('Trace 无内部 ID/模板/错误码', !/plan-|T-|E_QA_|bill-|template_id|intent_code/.test(JSON.stringify(out.trace)), JSON.stringify(out.trace));

  const noBundle = await service.ask({ question: '我最错的一笔是哪个？', bill: BILL });
  check('报告未载入：Trace 记录上下文失败', noBundle.envelope.status === 'error'
    && noBundle.trace.some((e) => e.stage === 'context' && e.status === 'failed'), JSON.stringify(noBundle.trace));
}

/* ==== ④ 折叠面板：回答上方、默认收起、增量更新 ==== */
{
  const events = [
    { stage: 'scope', status: 'done', label: '判断问题范围', detail: '账单问题', ms: 12 },
    { stage: 'intent', status: 'done', label: '模型分析意图', detail: '已识别', ms: 480 },
  ];
  const html = traceHTML(events, {});
  check('渲染：标题显示步数、提示默认收起', html.includes('AI 运行过程 · 2 步')
    && html.includes('默认收起 · 点击展开'), html);
  check('渲染：使用 details 且默认不展开', /<details class="tm-qa-trace"[^>]*>/.test(html)
    && !/<details class="tm-qa-trace"[^>]*\bopen\b/.test(html), html);
  check('渲染：步骤含标签、详情与耗时', html.includes('判断问题范围') && html.includes('账单问题')
    && html.includes('480 ms') && html.includes('✓'), html);
  check('渲染：空事件且非等待 → 不渲染', traceHTML([], {}) === '', traceHTML([], {}));
  check('渲染：等待中显示准备中', traceHTML([], { pending: true, requestId: 'r1' }).includes('准备中')
    && traceHTML([], { pending: true, requestId: 'r1' }).includes('data-request-id="r1"'));
  const pendingHTML = traceHTML(events, { pending: true, requestId: 'r2' });
  check('渲染：等待中默认展开并实时更新', /<details class="tm-qa-trace"[^>]*\bopen\b/.test(pendingHTML)
    && pendingHTML.includes('进行中 · 2 步') && pendingHTML.includes('实时更新'), pendingHTML);
  check('渲染：回答落列后自动收起', !/<details class="tm-qa-trace"[^>]*\bopen\b/.test(html)
    && html.includes('默认收起 · 点击展开'), html);
  const escaped = traceHTML([{ stage: 'scope', status: 'done', label: '<b>注入</b>', ms: 0 }], {});
  check('渲染：标签转义，不注入 HTML', escaped.includes('&lt;b&gt;注入&lt;/b&gt;') && !escaped.includes('<b>注入</b>'), escaped);
  const hidden = traceHTML([{ stage: 'scope', status: 'done', label: '判断问题范围', plan_id: 'plan-x', template_id: 'T-x', intent_code: 'worst_trade' }], {});
  check('渲染：内部字段不进入用户可见内容', !/plan-x|T-x|worst_trade/.test(hidden), hidden);
}

{
  const running = [{ stage: 'intent', status: 'running', label: '模型分析意图', ms: 10 }];
  const merged = mergeTraceEvent(running, { stage: 'intent', status: 'done', label: '模型分析意图', detail: '已识别', ms: 20 });
  check('增量：同阶段运行中事件被替换，不重复两行', merged.length === 1
    && merged[0].status === 'done' && merged[0].detail === '已识别', JSON.stringify(merged));
  const appended = mergeTraceEvent(merged, { stage: 'plan', status: 'done', label: '确定回答步骤', ms: 5 });
  check('增量：新阶段追加到末尾', appended.length === 2 && appended[1].stage === 'plan', JSON.stringify(appended));
  check('增量：未传入事件时不破坏原列表', mergeTraceEvent(merged, null).length === 1);
}

{
  const source = readFileSync(new URL('../../prototype/user-frontend/realChat.js', import.meta.url), 'utf8');
  const answerBlock = source.slice(source.indexOf('function answerHTML'), source.indexOf('function pendingHTML'));
  const pendingBlock = source.slice(source.indexOf('function pendingHTML'), source.indexOf('function emptyHTML'));
  check('位置：回答面板的 Trace 在意图/徽标行之上', answerBlock.includes('traceHTML(')
    && answerBlock.indexOf('traceHTML(') < answerBlock.indexOf('tm-qa-route'), answerBlock.slice(0, 400));
  check('位置：等待面板同样在回答内容之上', pendingBlock.includes('traceHTML(')
    && pendingBlock.indexOf('traceHTML(') < pendingBlock.indexOf('tm-qa-route'), pendingBlock.slice(0, 400));
  check('withheld：徽标显示本次未发布并说明不展示数字', /withheld: '本次未发布'/.test(source)
    && /withheld: '发布前复核未通过，不展示具体数字'/.test(source), '缺少 withheld 状态文案');
  check('withheld：归入边界状态，不当作普通事实回答', /BOUNDARY_STATES = new Set\(\[[^\]]*'withheld'/su.test(source),
    source.slice(source.indexOf('BOUNDARY_STATES'), source.indexOf('BOUNDARY_STATES') + 120));
  check('withheld：Trace 面板位于回答正文之上', answerBlock.indexOf('traceHTML(') < answerBlock.indexOf('answerTextHTML('),
    answerBlock.slice(0, 400));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
