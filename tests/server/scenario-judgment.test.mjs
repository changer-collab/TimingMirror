#!/usr/bin/env node
/**
 * 情景判断实际服务端路由测试（本地 fake transport；不联网、不调用真实模型/行情）。
 * 运行：node tests/server/scenario-judgment.test.mjs
 */
import { createHandler } from '../../server/site-functions/handler.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const URL = 'http://localhost/functions/v1/app/api/llm/scenario-judgment';

function ruleSetHash(hashes = []) {
  const str = [...hashes].filter(Boolean).sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const rule = {
  template_id: 'no_buy_on_surge',
  fields: { threshold_pct: 5 },
  scope: { kind: 'all' },
  version: 1,
  hash: '47a10ba4d26648cf',
  verdict: 'not_triggered',
  code: null,
};
const requestBody = (overrides = {}) => ({
  stage: 'scenario_judgment',
  flow_id: 'fallback-run-test-1',
  request_id: 'fallback-run-test-1-1',
  scenario_id: 'scenario-run-test-1',
  rule_set_hash: ruleSetHash([rule.hash]),
  scenario: {
    symbol: '300750',
    requested_date: '2025-05-13',
    effective_date: '2025-05-13',
    action: 'buy',
    change_pct: 0.0069,
    rules: [{ ...rule }],
  },
  ...overrides,
});

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

/* —— 有效请求：模型只返回 judgment/answer_text，服务端附加 binding —— */
{
  let received = null;
  const transport = {
    async scenarioJudgment(req) {
      received = req;
      return { rawText: JSON.stringify({ judgment: 'no_match', answer_text: '本次情景没有匹配任何已锁定规则；规则结果仍以本地判定为准。' }) };
    },
  };
  const out = await post(requestBody(), transport);
  const raw = out.payload?.rawText ? JSON.parse(out.payload.rawText) : null;
  check('有效请求：200，模型收到完整情景与规则状态', out.status === 200
    && received?.stage === 'scenario_judgment'
    && received.scenario.symbol === '300750'
    && received.scenario.rules.length === 1
    && received.scenario.rules[0].verdict === 'not_triggered'
    && !JSON.stringify(received).includes('trade_id')
    && !JSON.stringify(received).includes('fileName'), JSON.stringify({ out, received }));
  check('有效请求：响应含 judgment/answer_text/binding', !!raw
    && raw.judgment === 'no_match'
    && typeof raw.answer_text === 'string'
    && raw.binding?.flow_id === 'fallback-run-test-1'
    && raw.binding?.request_id === 'fallback-run-test-1-1'
    && raw.binding?.scenario_id === 'scenario-run-test-1'
    && raw.binding?.rule_set_hash === ruleSetHash([rule.hash]), JSON.stringify(raw));
}

/* —— 没有锁定规则：仍请求 AI（不是跳过） —— */
{
  let calls = 0;
  const transport = { async scenarioJudgment() { calls += 1; return { rawText: JSON.stringify({ judgment: 'no_match', answer_text: '当前没有可匹配的已锁定规则。' }) }; } };
  const body = requestBody();
  body.scenario.rules = [];
  body.rule_set_hash = ruleSetHash([]);
  const out = await post(body, transport);
  check('无锁定规则：仍请求 AI 并返回 200', out.status === 200 && calls === 1, JSON.stringify(out));
}

/* —— 规则命中 / 非法请求：拒绝且不调用模型 —— */
{
  let calls = 0;
  const transport = { async scenarioJudgment() { calls += 1; return { rawText: JSON.stringify({ judgment: 'no_match', answer_text: 'x' }) }; } };
  const triggered = requestBody();
  triggered.scenario.rules[0].verdict = 'triggered';
  const out1 = await post(triggered, transport);
  check('规则命中：400 且不调用模型（规则优先）', out1.status === 400 && calls === 0, JSON.stringify(out1));

  const unknown = requestBody({ extra: true });
  const out2 = await post(unknown, transport);
  check('未知字段：400 且不调用模型', out2.status === 400 && calls === 0, JSON.stringify(out2));

  const badSymbol = requestBody();
  badSymbol.scenario.symbol = 'ABC';
  const out3 = await post(badSymbol, transport);
  check('非法标的：400 且不调用模型', out3.status === 400 && calls === 0, JSON.stringify(out3));
}

/* —— 模型响应非法：502，不转发正文 —— */
{
  const cases = [
    ['AI 声称命中', JSON.stringify({ judgment: 'matched', answer_text: '命中规则' })],
    ['缺 answer_text', JSON.stringify({ judgment: 'no_match' })],
    ['额外字段', JSON.stringify({ judgment: 'no_match', answer_text: '未匹配', extra: true })],
    ['建议/预测内容', JSON.stringify({ judgment: 'no_match', answer_text: '建议买入，明天会涨。' })],
    ['非法 JSON', 'not-json'],
  ];
  for (const [label, rawText] of cases) {
    const transport = { async scenarioJudgment() { return { rawText }; } };
    const out = await post(requestBody(), transport);
    check(`模型响应非法（${label}）：502 且不转发`, out.status === 502 && !JSON.stringify(out.payload).includes('明天'), JSON.stringify(out));
  }
}

/* —— 未配置 transport：503 且不泄露正文 —— */
{
  const out = await post(requestBody(), null);
  check('未配置模型：503 E_MODEL_NOT_CONFIGURED', out.status === 503 && out.payload?.code === 'E_MODEL_NOT_CONFIGURED', JSON.stringify(out));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
