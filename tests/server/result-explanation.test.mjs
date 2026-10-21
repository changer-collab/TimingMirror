#!/usr/bin/env node
/**
 * 结果解释实际服务端路由测试（本地 fake transport；不联网、不调用真实模型/行情）。
 * 运行：node tests/server/result-explanation.test.mjs
 */
import { createHandler } from '../../server/site-functions/handler.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const URL = 'http://localhost/functions/v1/app/api/llm/result-explanation';

const rule = {
  template_id: 'no_buy_on_surge',
  fields: { threshold_pct: 5 },
  scope: { kind: 'symbol', symbol: '600519' },
  version: 2,
  hash: 'd6bd79e96d3ee43e',
};
const simulation = {
  result_id: 'sim-flow-001-900f63-001-abcd1234',
  status: 'completed',
  symbol: '600519',
  requested_date: '2024-10-01',
  effective_date: '2024-09-30',
  summary: { triggered: 1, not_triggered: 0, not_applicable: 0, missing_data: 0, error: 0 },
  results: [{
    verdict: 'triggered',
    display_verdict: 'triggered',
    code: null,
    message: '命中：当日涨幅超过 5%',
    requested_date: '2024-10-01',
    effective_date: '2024-09-30',
  }],
};
const requestBody = () => ({
  stage: 'result_explanation',
  flow_id: 'flow-001-900f63',
  request_id: 'assistant-explain-1',
  rule: JSON.parse(JSON.stringify(rule)),
  simulation: JSON.parse(JSON.stringify(simulation)),
});

function validAnswer(body = requestBody()) {
  const s = body.simulation;
  const outcome = s.results.every((r) => r.verdict === 'triggered') ? '命中' : '未命中';
  const effective = s.effective_date && s.effective_date !== s.requested_date
    ? `（实际使用交易日 ${s.effective_date}）`
    : '';
  return `本次模拟执行完成：${s.symbol} 在 ${s.requested_date}${effective}${outcome}；`
    + `触发 ${s.summary.triggered} 条、未触发 ${s.summary.not_triggered} 条、`
    + `不适用 ${s.summary.not_applicable} 条、数据不足 ${s.summary.missing_data} 条、错误 ${s.summary.error} 条。`;
}

async function post(body, transport, handler = createHandler({ transport })) {
  const response = await handler(new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
}

/* —— 正常请求：严格校验、模型只返回 answer_text，服务端回显 binding —— */
{
  let calls = 0;
  const transport = {
    async resultExplanation(req) {
      calls += 1;
      check('服务端：模型只收到规则与模拟事实，不含 flow/request 外的原始数据',
        req.stage === 'result_explanation'
        && req.rule.template_id === 'no_buy_on_surge'
        && req.simulation.result_id === simulation.result_id
        && !JSON.stringify(req).includes('fileName')
        && !JSON.stringify(req).includes('trades'));
      return { rawText: JSON.stringify({ answer_text: validAnswer() }) };
    },
  };
  const out = await post(requestBody(), transport);
  const raw = out.payload?.rawText ? JSON.parse(out.payload.rawText) : null;
  check('服务端：成功响应 200，binding 由服务端回显',
    out.status === 200 && calls === 1
    && raw?.answer_text.includes('命中')
    && raw?.binding.flow_id === 'flow-001-900f63'
    && raw?.binding.request_id === 'assistant-explain-1'
    && raw?.binding.rule_hash === rule.hash
    && raw?.binding.rule_version === 2
    && raw?.binding.scope.symbol === '600519'
    && raw?.binding.simulation_result_id === simulation.result_id,
  JSON.stringify({ out, raw }));
}

/* —— 原始账单/未知字段：拒绝且零出站 —— */
{
  let calls = 0;
  const transport = { async resultExplanation() { calls += 1; return { rawText: JSON.stringify({ answer_text: 'x' }) }; } };
  for (const [name, mutate] of [
    ['原始账单字段', (b) => { b.fileName = 'real.csv'; }],
    ['成交行字段', (b) => { b.trades = [{ symbol: '600519' }]; }],
    ['模拟不明字段', (b) => { b.simulation.rawRows = ['x']; }],
    ['规则不明字段', (b) => { b.rule.note = 'x'; }],
  ]) {
    const body = requestBody();
    mutate(body);
    const out = await post(body, transport);
    check(`服务端：${name}被拒绝且零模型调用`, out.status === 400 && calls === 0, JSON.stringify(out));
  }
}

/* —— 非成功模拟：拒绝且零出站 —— */
{
  let calls = 0;
  const transport = { async resultExplanation() { calls += 1; return { rawText: JSON.stringify({ answer_text: 'x' }) }; } };
  const failed = requestBody();
  failed.simulation.status = 'failed';
  const failedOut = await post(failed, transport);
  const na = requestBody();
  na.simulation.results[0].verdict = 'not_applicable';
  na.simulation.results[0].display_verdict = 'not_applicable';
  na.simulation.summary = { triggered: 0, not_triggered: 0, not_applicable: 1, missing_data: 0, error: 0 };
  const naOut = await post(na, transport);
  check('服务端：失败/不适用模拟 400 且零模型调用',
    failedOut.status === 400 && naOut.status === 400 && calls === 0,
    JSON.stringify({ failedOut, naOut, calls }));
}

/* —— 响应非法/越界：502，单次请求只调用一次 —— */
{
  let calls = 0;
  const transport = { async resultExplanation() { calls += 1; return { rawText: JSON.stringify({ answer_text: '组合总收益预测', extra: 1 }) }; } };
  const out = await post(requestBody(), transport);
  check('服务端：越界/额外字段解释响应 502',
    out.status === 502 && calls === 1, JSON.stringify({ out, calls }));
}

/* —— 错误数字/日期/判定/收益结论：拒绝且只调用一次 —— */
{
  const cases = [
    ['新增收益率', () => '本次模拟执行完成：600519 在 2024-10-01 命中，收益率为 12%。触发 1 条、未触发 0 条、不适用 0 条、数据不足 0 条、错误 0 条。'],
    ['错误交易日', () => '本次模拟执行完成：600519 在 2024-10-02 命中；触发 1 条、未触发 0 条、不适用 0 条、数据不足 0 条、错误 0 条。'],
    ['颠倒命中结论', () => '本次模拟执行完成：600519 在 2024-10-01 未命中；触发 1 条、未触发 0 条、不适用 0 条、数据不足 0 条、错误 0 条。'],
    ['无依据收益结论', () => '本次模拟执行完成：600519 在 2024-10-01 命中，总收益为 100 元。触发 1 条、未触发 0 条、不适用 0 条、数据不足 0 条、错误 0 条。'],
    ['错误逐项计数', () => '本次模拟执行完成：600519 在 2024-10-01 命中；触发 2 条、未触发 0 条、不适用 0 条、数据不足 0 条、错误 0 条。'],
  ];
  for (const [name, answer] of cases) {
    let calls = 0;
    const transport = { async resultExplanation() { calls += 1; return { rawText: JSON.stringify({ answer_text: answer() }) }; } };
    const out = await post(requestBody(), transport);
    check(`服务端：${name}被拒绝且只调用一次`, out.status === 502 && calls === 1, JSON.stringify({ out, calls }));
  }
}

/* —— 服务端无硬预算：单个请求合法即执行，预算由客户端共享 —— */
{
  let calls = 0;
  const transport = { async resultExplanation() { calls += 1; return { rawText: JSON.stringify({ answer_text: validAnswer() }) }; } };
  const handler = createHandler({ transport });
  const first = await post(requestBody(), transport, handler);
  const secondBody = requestBody();
  secondBody.request_id = 'assistant-explain-2';
  const second = await post(secondBody, transport, handler);
  check('服务端：无状态、无硬预算，两次合法请求各调用一次',
    first.status === 200 && second.status === 200 && calls === 2,
    JSON.stringify({ first, second, calls }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
