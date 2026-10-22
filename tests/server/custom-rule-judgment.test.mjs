#!/usr/bin/env node
/**
 * 自定义规则情境判定服务端路由测试（本地 fake transport；不联网、不调用真实模型/行情）。
 * 运行：node tests/server/custom-rule-judgment.test.mjs
 */
import { createHandler } from '../../server/site-functions/handler.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const URL = 'http://localhost/functions/v1/app/api/llm/custom-rule-judgment';

const requestBody = (overrides = {}) => ({
  stage: 'custom_rule_judgment',
  flow_id: 'custom-run-test-1',
  request_id: 'custom-run-test-1-1',
  judgment_id: 'custom-run-test-1-abcd1234ef56',
  rule: {
    schema: 'custom-v1',
    rule_id: 'nl-abc123',
    hash: '47a10ba4d26648cf',
    version: 2,
    text: '买入前核对自己的交易计划',
    action: 'buy',
    scope: { kind: 'all' },
  },
  scenario: {
    symbol: '000000',
    requested_date: '2024-10-09',
    action: 'buy',
    effective_date: '2024-10-09',
    change_pct: 0.042,
    market_label: 'Tushare 动态日线',
  },
  data: {
    buys: ['2024-09-27', '2024-10-08'],
    sells: ['2024-09-26'],
    trading_days: ['2024-10-08', '2024-10-09'],
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

const judgeTransport = (verdict = 'triggered', reason = '按规则原文与给定数据，该情境应提醒。', used = ['change_pct']) => ({
  async customRuleJudgment(req) {
    return { rawText: JSON.stringify({ verdict, reason, used_data: used }) };
  },
});

/* —— 有效请求：模型收到规则身份与最小数据；响应附加完整 binding —— */
{
  let received = null;
  const transport = {
    async customRuleJudgment(req) {
      received = req;
      return { rawText: JSON.stringify({ verdict: 'triggered', reason: '按规则原文与给定数据，该情境应提醒。', used_data: ['change_pct', 'calendar'] }) };
    },
  };
  const out = await post(requestBody(), transport);
  const raw = out.payload?.rawText ? JSON.parse(out.payload.rawText) : null;
  check('有效请求：200，模型收到规则原文、动作、范围与最小情境数据', out.status === 200
    && received?.stage === 'custom_rule_judgment'
    && received.rule.text === '买入前核对自己的交易计划'
    && received.rule.action === 'buy'
    && received.rule.scope.kind === 'all'
    && received.rule.version === 2
    && received.scenario.change_pct === 0.042
    && received.data.buys.length === 2
    && received.data.trading_days.length === 2
    && !JSON.stringify(received).includes('price') && !JSON.stringify(received).includes('amount') && !JSON.stringify(received).includes('trade_id')
    && !JSON.stringify(received).includes('fileName'), JSON.stringify(received));
  check('有效请求：响应含 verdict/reason/used_data 与 binding（运行 + 规则身份 + 情境）', !!raw
    && raw.verdict === 'triggered'
    && raw.used_data.join(',') === 'change_pct,calendar'
    && raw.binding?.flow_id === 'custom-run-test-1'
    && raw.binding?.request_id === 'custom-run-test-1-1'
    && raw.binding?.judgment_id === 'custom-run-test-1-abcd1234ef56'
    && raw.binding?.rule_id === 'nl-abc123'
    && raw.binding?.rule_hash === '47a10ba4d26648cf'
    && raw.binding?.rule_version === 2
    && raw.binding?.rule_action === 'buy'
    && raw.binding?.scenario_symbol === '000000'
    && raw.binding?.scenario_requested_date === '2024-10-09'
    && raw.binding?.scenario_action === 'buy', JSON.stringify(raw));
}

/* —— unable 也是合法判定（数据不足的保守结论） —— */
{
  const out = await post(requestBody(), judgeTransport('unable', '规则需要持仓数据，本次未提供。', []));
  check('unable：200 并原样回传（客户端显示“无法判断”）', out.status === 200
    && JSON.parse(out.payload.rawText).verdict === 'unable', JSON.stringify(out.payload));
}

/* —— 非法请求：400 且不调用模型 —— */
{
  let calls = 0;
  const transport = { async customRuleJudgment() { calls += 1; return { rawText: '{}' }; } };
  const cases = [
    ['未知字段', requestBody({ extra: 1 })],
    ['stage 错误', requestBody({ stage: 'scenario_judgment' })],
    ['规则文本超长', requestBody({ rule: { ...requestBody().rule, text: '长'.repeat(201) } })],
    ['规则动作用 both', requestBody({ rule: { ...requestBody().rule, action: 'both' } })],
    ['范围缺 symbol', requestBody({ rule: { ...requestBody().rule, scope: { kind: 'symbol' } } })],
    ['scope 带非法代码', requestBody({ rule: { ...requestBody().rule, scope: { kind: 'symbol', symbol: '60051' } } })],
    ['version 非法', requestBody({ rule: { ...requestBody().rule, version: 0 } })],
    ['hash 非法', requestBody({ rule: { ...requestBody().rule, hash: 'XYZ' } })],
    ['symbol 非法', requestBody({ scenario: { ...requestBody().scenario, symbol: '00000' } })],
    ['日期非法', requestBody({ scenario: { ...requestBody().scenario, requested_date: '2024/10/09' } })],
    ['change_pct 非数字', requestBody({ scenario: { ...requestBody().scenario, change_pct: '4%' } })],
    ['data 混入交易金额', { ...requestBody(), data: { ...requestBody().data, amount: 100 } }],
    ['buys 含非法日期', requestBody({ data: { ...requestBody().data, buys: ['昨天'] } })],
    ['trading_days 超上限', requestBody({ data: { ...requestBody().data, trading_days: Array.from({ length: 501 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')}`) } })],
    ['judgment_id 缺失', (() => { const b = requestBody(); delete b.judgment_id; return b; })()],
  ];
  for (const [name, body] of cases) {
    const out = await post(body, transport);
    check(`非法请求：${name} → 400 不调用模型`, out.status === 400 && calls === 0
      && out.payload?.code === 'E_CUSTOM_RULE_JUDGMENT_REQUEST_INVALID', JSON.stringify(out.payload));
  }
}

/* —— 模型响应非法：502 且不回传 —— */
{
  const cases = [
    ['verdict 非法', JSON.stringify({ verdict: 'no_match', reason: 'x', used_data: [] })],
    ['声称命中但不给依据', JSON.stringify({ verdict: 'triggered', reason: '', used_data: [] })],
    ['reason 越界内容（荐股）', JSON.stringify({ verdict: 'triggered', reason: '这是荐股建议', used_data: [] })],
    ['reason 含 URL', JSON.stringify({ verdict: 'unable', reason: '见 https://example.com', used_data: [] })],
    ['used_data 非法值', JSON.stringify({ verdict: 'unable', reason: '缺少数据', used_data: ['holdings'] })],
    ['used_data 重复', JSON.stringify({ verdict: 'unable', reason: '缺少数据', used_data: ['buys', 'buys'] })],
    ['多余字段', JSON.stringify({ verdict: 'unable', reason: '缺少数据', used_data: [], advice: '卖出' })],
    ['非 JSON', 'unable'],
  ];
  for (const [name, rawText] of cases) {
    const out = await post(requestBody(), { async customRuleJudgment() { return { rawText }; } });
    check(`模型响应非法：${name} → 502`, out.status === 502
      && out.payload?.code === 'E_CUSTOM_RULE_JUDGMENT_RESPONSE_INVALID', JSON.stringify(out.payload));
  }
}

/* —— 模型未配置 / 不可用 / 超时：映射 5xx —— */
{
  const notConfigured = await post(requestBody(), judgeTransport(), createHandler({ transport: null }));
  check('模型未配置：503 E_MODEL_NOT_CONFIGURED', notConfigured.status === 503
    && notConfigured.payload?.code === 'E_MODEL_NOT_CONFIGURED', JSON.stringify(notConfigured.payload));
  const unavailable = await post(requestBody(), { async customRuleJudgment() { throw new Error('boom'); } });
  check('模型异常：502 E_MODEL_UNAVAILABLE', unavailable.status === 502
    && unavailable.payload?.code === 'E_MODEL_UNAVAILABLE', JSON.stringify(unavailable.payload));
  const timeout = await post(requestBody(), {
    async customRuleJudgment() {
      const e = new Error('timeout'); e.code = 'E_MODEL_TIMEOUT'; throw e;
    },
  });
  check('模型超时：504 E_MODEL_TIMEOUT', timeout.status === 504
    && timeout.payload?.code === 'E_MODEL_TIMEOUT', JSON.stringify(timeout.payload));
}

/* —— 方法 / 内容类型 —— */
{
  const handler = createHandler({ transport: judgeTransport() });
  const wrongMethod = await handler(new Request(URL, { method: 'GET' }));
  check('GET：405', wrongMethod.status === 405, String(wrongMethod.status));
  const wrongType = await handler(new Request(URL, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
  }));
  check('非 JSON：415', wrongType.status === 415, String(wrongType.status));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`);
console.log(`custom-rule-judgment: ${results.length - failed.length}/${results.length}`);
if (failed.length) process.exit(1);
