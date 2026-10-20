#!/usr/bin/env node
/**
 * 规则 intent 阶段服务端测试（Node Web Request/Response；fake transport；不联网）
 *
 * 覆盖：
 *   · 服务端固定 intent/template/tool 集合；客户端 allowed_* 只能收窄；
 *   · 服务端模板副本与 src/engine/contractMatch.js 的已批准模板一致；
 *   · 请求字段/上下文白名单；未知项/扩大范围/非法响应拒绝；
 *   · DashScope ruleIntent 的端点、模型、JSON/非思考参数与最小用户消息。
 * 运行：node tests/server/rule-intent.test.mjs
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  RULE_INTENT_CODES,
  RULE_INTENT_TEMPLATES,
  RULE_INTENT_STAGE,
  normalizeRuleIntentRequest,
  validateRuleIntentResponse,
} from '../../server/site-functions/ruleIntent.mjs';
import { DASHSCOPE_ENDPOINT, createDashScopeTransport } from '../../server/site-functions/dashscope.mjs';
import { CONTRACT_TEMPLATES } from '../../src/engine/contractMatch.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '当天涨幅超过 5% 的票我绝不买入。';
const VALID = JSON.stringify({
  intent: 'contract_setup',
  confidence: 0.92,
  template_id: 'no_buy_on_surge',
  fields: { threshold_pct: 5 },
  clarify: null,
  unsupported: null,
});

function createFakeTransport(response = VALID) {
  const calls = [];
  return {
    calls,
    async ruleIntent(request) {
      calls.push(request);
      return { rawText: typeof response === 'function' ? response(request) : response };
    },
  };
}

async function invoke(handler, body) {
  const response = await handler(new Request(
    'https://timingmirror.example/functions/v1/app/api/llm/rule-intent',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 断言处理 */ }
  return { status: response.status, text, json };
}

/* —— 服务端模板与已批准模板一致 —— */
{
  const ids = Object.keys(RULE_INTENT_TEMPLATES);
  check('模板：服务端恰有两个已批准模板', ids.length === 2
    && ids.includes('no_buy_on_surge') && ids.includes('no_buy_back_within'), JSON.stringify(ids));
  check('模板：字段/下限/整数约束与 src/engine/contractMatch.js 一致',
    ids.every((id) => {
      const server = RULE_INTENT_TEMPLATES[id];
      const client = CONTRACT_TEMPLATES[id];
      const keys = Object.keys(server.fields);
      return client && keys.length === Object.keys(client.fields).length
        && keys.every((k) => client.fields[k] && client.fields[k].min === server.fields[k].min
          && client.fields[k].integer === server.fields[k].integer);
    }));
}

/* —— 请求规范化：固定集合 + 客户端只能收窄 —— */
{
  const full = normalizeRuleIntentRequest({
    question: QUESTION,
    stage: RULE_INTENT_STAGE,
    allowed_templates: ['no_buy_on_surge'],
    allowed_tools: ['contract.parse'],
    allowed_intents: ['contract_setup'],
    context_summary: { object_type: 'rule', symbol: '600519', as_of_date: '2025-12-31', data_snapshot_id: 'bill-1' },
  });
  check('规范化：合法请求通过，且服务端只保留客户端收窄后的模板', full.ok === true
    && full.request.allowed_templates.length === 1
    && full.request.allowed_templates[0].template_id === 'no_buy_on_surge'
    && full.request.allowed_tools.join(',') === 'contract.parse', JSON.stringify(full));

  const omitted = normalizeRuleIntentRequest({ question: QUESTION, stage: RULE_INTENT_STAGE });
  check('规范化：客户端省略 allowed_* 时使用服务端固定集合', omitted.ok === true
    && omitted.request.allowed_templates.length === 2
    && omitted.request.allowed_tools.join(',') === 'contract.parse,contract.match'
    && omitted.request.allowed_intents.join(',') === 'contract_setup');

  const expanded = normalizeRuleIntentRequest({
    question: QUESTION, stage: RULE_INTENT_STAGE, allowed_templates: ['no_buy_on_surge', 'new_rule'],
  });
  check('收窄：客户端请求未知模板 → E_RULE_INTENT_SCOPE', expanded.ok === false
    && expanded.code === RULE_INTENT_CODES.SCOPE, JSON.stringify(expanded));

  const extra = normalizeRuleIntentRequest({ question: QUESTION, stage: RULE_INTENT_STAGE, raw_csv: 'a,b' });
  check('白名单：请求未知顶层字段 → E_RULE_INTENT_REQUEST_INVALID', extra.ok === false
    && extra.code === RULE_INTENT_CODES.REQUEST_INVALID);

  const badContext = normalizeRuleIntentRequest({
    question: QUESTION, stage: RULE_INTENT_STAGE, context_summary: { trades: [] },
  });
  check('白名单：上下文携带原始成交 → 拒绝', badContext.ok === false
    && badContext.code === RULE_INTENT_CODES.REQUEST_INVALID);

  const badStage = normalizeRuleIntentRequest({ question: QUESTION, stage: 'explain_result' });
  check('阶段固定：非 draft_rule → 拒绝', badStage.ok === false
    && badStage.code === RULE_INTENT_CODES.REQUEST_INVALID);
}

/* —— 响应校验 —— */
{
  const ok = validateRuleIntentResponse(VALID, ['no_buy_on_surge', 'no_buy_back_within']);
  check('响应：合法草案通过并归一化 fields 数值', ok.ok === true && ok.kind === 'draft'
    && ok.value.template_id === 'no_buy_on_surge' && ok.value.fields.threshold_pct === 5);

  const missingField = validateRuleIntentResponse(JSON.stringify({
    intent: 'contract_setup', confidence: 0.9, template_id: 'no_buy_on_surge', fields: {}, clarify: null, unsupported: null,
  }), ['no_buy_on_surge']);
  check('响应：缺字段不套默认值 → 拒绝', missingField.ok === false
    && missingField.code === RULE_INTENT_CODES.RESPONSE);

  const badField = validateRuleIntentResponse(JSON.stringify({
    intent: 'contract_setup', confidence: 0.9, template_id: 'no_buy_back_within', fields: { days: 0 }, clarify: null, unsupported: null,
  }), ['no_buy_back_within']);
  check('响应：字段低于下限 → 拒绝', badField.ok === false
    && badField.code === RULE_INTENT_CODES.RESPONSE);

  const clarify = validateRuleIntentResponse(JSON.stringify({
    intent: 'contract_setup', confidence: 0.4, template_id: null, fields: {}, clarify: '请说明阈值', unsupported: null,
  }), ['no_buy_on_surge']);
  check('响应：clarify 通过并保留原句', clarify.ok === true && clarify.kind === 'clarify'
    && clarify.value.clarify === '请说明阈值');

  const extra = validateRuleIntentResponse(JSON.stringify({
    intent: 'contract_setup', confidence: 0.9, template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 }, clarify: null, unsupported: null, tool: 'rm',
  }), ['no_buy_on_surge']);
  check('响应：额外字段 → 拒绝', extra.ok === false && extra.code === RULE_INTENT_CODES.RESPONSE);
}

/* —— Handler 路由 —— */
{
  const transport = createFakeTransport();
  const handler = createHandler({ transport });
  const response = await invoke(handler, {
    question: QUESTION,
    stage: RULE_INTENT_STAGE,
    allowed_templates: ['no_buy_on_surge'],
    allowed_tools: ['contract.parse'],
  });
  check('Handler：合法规则 intent 返回 200 + 归一化 rawText', response.status === 200
    && response.json && typeof response.json.rawText === 'string'
    && JSON.parse(response.json.rawText).template_id === 'no_buy_on_surge', JSON.stringify(response));
  check('Handler：transport 只收到服务端固定字段', transport.calls.length === 1
    && Object.keys(transport.calls[0]).sort().join(',') === 'allowed_intents,allowed_templates,allowed_tools,context_summary,question,stage'
    && transport.calls[0].stage === 'draft_rule'
    && transport.calls[0].allowed_templates.length === 1, JSON.stringify(transport.calls[0]));

  const expanded = await invoke(handler, {
    question: QUESTION, stage: RULE_INTENT_STAGE, allowed_templates: ['new_rule'],
  });
  check('Handler：客户端扩大模板范围 → 400 E_RULE_INTENT_SCOPE', expanded.status === 400
    && expanded.json.code === RULE_INTENT_CODES.SCOPE, JSON.stringify(expanded));

  const badResponse = createHandler({ transport: createFakeTransport('{"intent":"contract_setup"}') });
  const invalid = await invoke(badResponse, { question: QUESTION, stage: RULE_INTENT_STAGE });
  check('Handler：上游非法响应 → 502 E_RULE_INTENT_RESPONSE_INVALID', invalid.status === 502
    && invalid.json.code === SITE_FUNCTION_CODES.RULE_INTENT_RESPONSE, JSON.stringify(invalid));

  const noMethod = createHandler({ transport: {} });
  const missing = await invoke(noMethod, { question: QUESTION, stage: RULE_INTENT_STAGE });
  check('Handler：transport 无 ruleIntent → 503 模型未启用', missing.status === 503
    && missing.json.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED, JSON.stringify(missing));
}

/* —— DashScope ruleIntent 请求形状 —— */
{
  const calls = [];
  const transport = createDashScopeTransport({
    apiKey: 'test-key-not-real',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ output: { choices: [{ message: { content: VALID } }] } }),
      };
    },
  });
  const result = await transport.ruleIntent({
    question: QUESTION,
    allowed_templates: [{ template_id: 'no_buy_on_surge', fields: { threshold_pct: { min: 0, integer: false } } }],
    context_summary: { object_type: 'rule' },
  });
  const body = calls[0].body;
  check('DashScope：固定端点/模型/JSON/非思考', calls[0].url === DASHSCOPE_ENDPOINT
    && body.model === 'qwen-plus'
    && body.parameters.enable_thinking === false
    && body.parameters.response_format.type === 'json_object');
  check('DashScope：用户消息只含问题/允许模板/上下文摘要', body.input.messages[1].content.includes(QUESTION)
    && body.input.messages[1].content.includes('allowed_templates')
    && !body.input.messages[1].content.includes('trades')
    && result.rawText === VALID);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
