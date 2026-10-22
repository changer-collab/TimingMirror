#!/usr/bin/env node
/**
 * Qoder Sites Function 本地测试（Node Web Request/Response；fake transport；不联网）
 *
 * 路由按平台形态使用 /functions/v1/app/api/llm/intent 与 /restate。
 * 覆盖成功、缺失 transport、非法 JSON/字段/事实、体积、错误脱敏和超时；
 * 并验证 DashScope / Tushare transport 的端点、字段、分页、重试与超时，不调用真实网络。
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  DASHSCOPE_ENDPOINT,
  createDashScopeTransport,
} from '../../server/site-functions/dashscope.mjs';
import {
  DYNAMIC_CACHE_ARTIFACT,
  MARKET_TRANSPORT_CODES,
  MarketTransportError,
  createTushareMarketTransport,
} from '../../server/site-functions/market.mjs';
import { assessDynamicCacheDoc, createMarketCache } from '../../src/engine/marketCache.js';
import { projectOnlineFacts } from '../../src/agent/onlineBoundary.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '组合整体表现如何？';
const ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';
const FACTS = [
  { value: 0.075, unit: '无量纲（展示 %，1 位小数）', display: '+7.5%', formula_ref: 'CALC_RET_V1', source_ref: 'src-aaaa1111' },
  { value: 0.15, unit: '无量纲（展示 %，1 位小数）', display: '+15.0%', formula_ref: 'CALC_RET_V1', source_ref: 'src-bbbb2222' },
  { value: 0.075, unit: 'pp（展示 1 位小数）', display: '+7.5pp', formula_ref: 'CALC_DRAG_PP_V1', source_ref: 'src-cccc3333' },
  { value: 150, unit: '元（展示 2 位小数＋千分位）', display: '¥150.00', formula_ref: 'CALC_DRAG_MONEY_V1', source_ref: 'src-dddd4444' },
];

function createFakeTransport({ intent, restate } = {}) {
  const calls = [];
  return {
    calls,
    async intent(request) {
      calls.push({ stage: 'intent', request });
      return intent ? intent(request) : { rawText: '{"intent":"loss_overview","slots":{},"confidence":1}' };
    },
    async restate(request) {
      calls.push({ stage: 'restate', request });
      return restate ? restate(request) : { rawText: JSON.stringify({ answer_text: ANSWER }) };
    },
  };
}

async function invoke(handler, path, { method = 'POST', body, bodyStream, headers = {} } = {}) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (bodyStream !== undefined) {
    init.body = bodyStream;
    init.duplex = 'half';
  } else if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, init));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 由断言处理 */ }
  return { status: response.status, headers: response.headers, text, json };
}

function streamOfChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/* ==== 路由与成功路径 ==== */
{
  const transport = createFakeTransport();
  const handler = createHandler({ transport, maxBodyBytes: 4096 });

  const intent = await invoke(handler, '/api/llm/intent', { body: { question: QUESTION } });
  check('站点 intent：200 且仅 rawText', intent.status === 200 && intent.json
    && typeof intent.json.rawText === 'string' && Object.keys(intent.json).join(',') === 'rawText', intent.text);
  const intentCall = transport.calls.find((c) => c.stage === 'intent');
  check('站点 intent：fake 仅收到 question', intentCall && Object.keys(intentCall.request).join(',') === 'question');

  const restate = await invoke(handler, '/api/llm/restate', { body: { question: QUESTION, facts: FACTS } });
  check('站点 restate：200 且仅 rawText', restate.status === 200 && restate.json
    && typeof restate.json.rawText === 'string' && Object.keys(restate.json).join(',') === 'rawText', restate.text);
  const restateCall = transport.calls.find((c) => c.stage === 'restate');
  const local = projectOnlineFacts(FACTS);
  check('站点 restate：fake facts 仅 F-6 且与本地投影一致', restateCall
    && restateCall.request.facts.every((f) => Object.keys(f).every((k) => ['value', 'unit', 'display', 'formula_ref', 'source_ref'].includes(k)))
    && JSON.stringify(restateCall.request.facts) === JSON.stringify(local.facts), JSON.stringify(restateCall && restateCall.request.facts));
  check('站点 restate：facts 不含 key/fact_ref/scope', restateCall
    && restateCall.request.facts.every((f) => !('key' in f) && !('fact_ref' in f) && !('scope' in f)));

  const unknown = await invoke(handler, '/unknown', { body: { question: QUESTION } });
  check('站点路由：未知路径 404', unknown.status === 404 && unknown.json.code === SITE_FUNCTION_CODES.NOT_FOUND);
  const get = await invoke(handler, '/api/llm/intent', { method: 'GET', body: undefined });
  check('站点路由：GET 405', get.status === 405 && get.json.code === SITE_FUNCTION_CODES.METHOD);
}

/* ==== 默认未配置模型 ==== */
{
  const handler = createHandler({ transport: null });
  const r = await invoke(handler, '/api/llm/intent', { body: { question: QUESTION } });
  check('站点未配置 Key：503 E_MODEL_NOT_CONFIGURED', r.status === 503
    && r.json.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED, r.text);
}

/* ==== 请求校验与错误脱敏 ==== */
{
  const transport = createFakeTransport();
  const handler = createHandler({ transport, maxBodyBytes: 512 });
  const before = transport.calls.length;

  const invalidJson = await invoke(handler, '/api/llm/intent', { body: '{bad-json' });
  check('站点非法 JSON：400', invalidJson.status === 400 && invalidJson.json.code === SITE_FUNCTION_CODES.JSON, invalidJson.text);

  const unknownTop = await invoke(handler, '/api/llm/intent', { body: { question: QUESTION, review: { marker: 'x' } } });
  check('站点未知顶层字段：400', unknownTop.status === 400 && unknownTop.json.code === SITE_FUNCTION_CODES.UNKNOWN_FIELD, unknownTop.text);

  const unknownFact = await invoke(handler, '/api/llm/restate', {
    body: { question: QUESTION, facts: [{ ...FACTS[0], key: 'actualRet' }] },
  });
  check('站点未知事实字段：400', unknownFact.status === 400 && unknownFact.json.code === SITE_FUNCTION_CODES.UNKNOWN_FIELD, unknownFact.text);

  const badUnit = await invoke(handler, '/api/llm/restate', {
    body: { question: QUESTION, facts: [{ ...FACTS[0], unit: 'account-123456' }] },
  });
  check('站点非法 unit：400 且不回显原值', badUnit.status === 400
    && badUnit.json.code === SITE_FUNCTION_CODES.REQUEST_INVALID
    && !badUnit.text.includes('account-123456'), badUnit.text);

  const noFormula = { ...FACTS[0] };
  delete noFormula.formula_ref;
  const missingFormula = await invoke(handler, '/api/llm/restate', { body: { question: QUESTION, facts: [noFormula] } });
  check('站点缺失 formula_ref：400', missingFormula.status === 400
    && missingFormula.json.code === SITE_FUNCTION_CODES.REQUEST_INVALID, missingFormula.text);

  const tooLarge = await invoke(handler, '/api/llm/intent', { body: { question: 'x'.repeat(1000) } });
  check('站点请求体过大：413', tooLarge.status === 413
    && tooLarge.json.code === SITE_FUNCTION_CODES.BODY_TOO_LARGE, tooLarge.text);

  const badType = await invoke(handler, '/api/llm/intent', {
    body: { question: QUESTION }, headers: { 'Content-Type': 'text/plain' },
  });
  check('站点 Content-Type 非 JSON：415', badType.status === 415
    && badType.json.code === SITE_FUNCTION_CODES.CONTENT_TYPE, badType.text);

  check('站点非法请求均未调用 fake transport', transport.calls.length === before, `calls=${transport.calls.length}`);
}

/* ==== 按 UTF-8 字节限流（无 Content-Length / 分块 / 合法中文） ==== */
{
  const transport = createFakeTransport();
  const handler = createHandler({ transport, maxBodyBytes: 100 });
  const chineseBody = JSON.stringify({ question: '组合'.repeat(20) });
  check('测试前提：中文请求字符数不超限但 UTF-8 字节超限',
    chineseBody.length <= 100 && new TextEncoder().encode(chineseBody).byteLength > 100,
    JSON.stringify({ chars: chineseBody.length, bytes: new TextEncoder().encode(chineseBody).byteLength }));

  const noLength = await invoke(handler, '/api/llm/intent', { bodyStream: streamOfChunks([chineseBody]) });
  check('无 Content-Length 中文超限：413', noLength.status === 413
    && noLength.json.code === SITE_FUNCTION_CODES.BODY_TOO_LARGE, noLength.text);

  const chunked = await invoke(handler, '/api/llm/intent', {
    bodyStream: streamOfChunks(['{"question":"', '组合'.repeat(20), '"}']),
  });
  check('分块超限：413', chunked.status === 413
    && chunked.json.code === SITE_FUNCTION_CODES.BODY_TOO_LARGE, chunked.text);
  check('超限请求不得调用 transport', transport.calls.length === 0, `calls=${transport.calls.length}`);

  const legalHandler = createHandler({ transport, maxBodyBytes: 256 });
  const legal = await invoke(legalHandler, '/api/llm/intent', {
    bodyStream: streamOfChunks([JSON.stringify({ question: '组合整体表现如何？' })]),
  });
  check('合法中文请求：200 且 transport 收到 question', legal.status === 200
    && transport.calls.length === 1
    && transport.calls[0].request.question === '组合整体表现如何？', legal.text);
}

/* ==== 上游错误与超时脱敏 ==== */
{
  const handler = createHandler({
    transport: {
      async intent() { throw new Error('provider-secret-marker'); },
      async restate() { return { body: 'not-raw-text' }; },
    },
  });
  const failed = await invoke(handler, '/api/llm/intent', { body: { question: QUESTION } });
  check('站点上游异常：502 且脱敏', failed.status === 502
    && failed.json.code === SITE_FUNCTION_CODES.MODEL_UNAVAILABLE
    && !failed.text.includes('provider-secret-marker'), failed.text);
  const malformed = await invoke(handler, '/api/llm/restate', { body: { question: QUESTION, facts: FACTS } });
  check('站点上游响应非法：502 且不转发正文', malformed.status === 502
    && malformed.json.code === SITE_FUNCTION_CODES.MODEL_RESPONSE
    && !malformed.text.includes('not-raw-text'), malformed.text);

  const timeoutHandler = createHandler({
    transport: {
      async intent() { const e = new Error('timeout'); e.code = SITE_FUNCTION_CODES.MODEL_TIMEOUT; throw e; },
      async restate() { return { rawText: '{}' }; },
    },
  });
  const timedOut = await invoke(timeoutHandler, '/api/llm/intent', { body: { question: QUESTION } });
  check('站点上游超时：504', timedOut.status === 504 && timedOut.json.code === SITE_FUNCTION_CODES.MODEL_TIMEOUT, timedOut.text);
}

/* ==== DashScope transport 契约（fake fetch，不联网） ==== */
{
  const calls = [];
  const transport = createDashScopeTransport({
    apiKey: 'synthetic-key-marker',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        output: { choices: [{ message: { content: '{"intent":"loss_overview","slots":{},"confidence":1}' } }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await transport.intent({ question: QUESTION });
  const sent = JSON.parse(calls[0].options.body);
  check('DashScope transport：固定北京端点', calls[0].url === DASHSCOPE_ENDPOINT);
  check('DashScope transport：模型/JSON/非思考参数', sent.model === 'qwen-plus'
    && sent.parameters.enable_thinking === false
    && sent.parameters.response_format?.type === 'json_object');
  check('DashScope transport：Authorization 仅服务端持有', String(calls[0].options.headers.Authorization).startsWith('Bearer '));
  check('DashScope transport：返回 rawText', result.rawText.includes('loss_overview'));

  const timeoutTransport = createDashScopeTransport({
    apiKey: 'synthetic-key-marker',
    timeoutMs: 10,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  let timeoutError = null;
  try { await timeoutTransport.intent({ question: QUESTION }); } catch (error) { timeoutError = error; }
  check('DashScope transport：超时映射 E_MODEL_TIMEOUT', timeoutError && timeoutError.code === 'E_MODEL_TIMEOUT', timeoutError && timeoutError.code);

  const encoder = new TextEncoder();
  const delayedBodyTransport = createDashScopeTransport({
    apiKey: 'synthetic-key-marker',
    timeoutMs: 20,
    fetchImpl: async (url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"output":'));
        signal.addEventListener('abort', () => {
          try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* 已关闭 */ }
        }, { once: true });
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let delayedError = null;
  try { await delayedBodyTransport.intent({ question: QUESTION }); } catch (error) { delayedError = error; }
  check('DashScope transport：响应头先返回、正文延迟 → E_MODEL_TIMEOUT',
    delayedError && delayedError.code === 'E_MODEL_TIMEOUT', delayedError && delayedError.code);
}

/* ==== 规则识别路由：只接受 { text }，不转发其他字段；未配置/缺方法/超长均明确失败 ==== */
{
  const RULE_TEXT = '当天涨幅超过5%的股票我不买';
  const calls = [];
  const transport = {
    ...createFakeTransport(),
    async rule(request) { calls.push(request); return { rawText: '{"status":"unclear"}' }; },
  };
  const handler = createHandler({ transport, maxBodyBytes: 4096 });
  const ok = await invoke(handler, '/api/llm/rule', { body: { text: RULE_TEXT } });
  check('规则识别路由：200 且仅返回 rawText 与协议版本', ok.status === 200 && Object.keys(ok.json ?? {}).join(',') === 'rawText,protocol'
    && ok.json.protocol === 'rule-intent-v2', ok.text);
  check('规则识别路由：transport 只收到 { text } 原文', calls.length === 1 && Object.keys(calls[0]).join(',') === 'text' && calls[0].text === RULE_TEXT, JSON.stringify(calls));

  const extra = await invoke(handler, '/api/llm/rule', { body: { text: RULE_TEXT, trades: [{ price: 1 }] } });
  const empty = await invoke(handler, '/api/llm/rule', { body: { text: '   ' } });
  const notString = await invoke(handler, '/api/llm/rule', { body: { text: 5 } });
  const tooLong = await invoke(handler, '/api/llm/rule', { body: { text: '涨'.repeat(201) } });
  const atLimit = await invoke(handler, '/api/llm/rule', { body: { text: '涨'.repeat(200) } });
  check('规则识别路由：附带交易等字段 → 400 E_FUNCTION_UNKNOWN_FIELD，不调用模型', extra.status === 400 && extra.json.code === SITE_FUNCTION_CODES.UNKNOWN_FIELD, extra.text);
  check('规则识别路由：空文本 / 非字符串 / 超过 200 字 → 400 E_FUNCTION_REQUEST_INVALID；200 字可通过',
    [empty, notString, tooLong].every((r) => r.status === 400 && r.json.code === SITE_FUNCTION_CODES.REQUEST_INVALID) && atLimit.status === 200,
    JSON.stringify([empty.status, notString.status, tooLong.status, atLimit.status]));
  check('规则识别路由：被拒绝的请求均未调用模型', calls.length === 2, String(calls.length));

  const noKey = await invoke(createHandler({ transport: null }), '/api/llm/rule', { body: { text: RULE_TEXT } });
  check('规则识别路由：未配置 DASHSCOPE_API_KEY → 503 E_MODEL_NOT_CONFIGURED', noKey.status === 503 && noKey.json.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED, noKey.text);
  const legacy = await invoke(createHandler({ transport: createFakeTransport() }), '/api/llm/rule', { body: { text: RULE_TEXT } });
  check('规则识别路由：transport 缺少 rule() → 502 E_MODEL_UNAVAILABLE（脱敏）', legacy.status === 502 && legacy.json.code === SITE_FUNCTION_CODES.MODEL_UNAVAILABLE, legacy.text);
  const get = await invoke(handler, '/api/llm/rule', { method: 'GET', body: undefined });
  check('规则识别路由：GET 405', get.status === 405, String(get.status));
}

/* ==== DashScope rule()：系统提示列出三个模板与固定代码，区分提醒动作，用户消息只含规则原文 ==== */
{
  const calls = [];
  const transport = createDashScopeTransport({
    apiKey: 'synthetic-key-marker',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ output: { choices: [{ message: { content: '{"status":"unsupported"}' } }] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const text = '如果同一只股票连续亏损两次，提醒我暂停交易一天';
  const r = await transport.rule({ text });
  const sent = JSON.parse(calls[0].options.body);
  const msgs = sent.input.messages;
  check('DashScope rule()：同一端点、JSON mode、两条消息', calls[0].url === DASHSCOPE_ENDPOINT && sent.parameters.response_format?.type === 'json_object' && msgs.length === 2);
  check('DashScope rule()：系统提示含三个模板 ID 与“不得假设默认值”约束', msgs[0].role === 'system'
    && msgs[0].content.includes('no_buy_on_surge') && msgs[0].content.includes('no_buy_back_within')
    && msgs[0].content.includes('sell_within_after_buy') && msgs[0].content.includes('不得自行假设默认值'));
  check('DashScope rule()：系统提示区分申报买入 / 申报卖出模板，并要求买入后卖出明确同一只股票或单个代码', msgs[0].content.includes('提醒动作：申报买入')
    && msgs[0].content.includes('提醒动作：申报卖出') && msgs[0].content.includes('same_symbol')
    && msgs[0].content.includes('days_sell') && msgs[0].content.includes('不能把“买入”和“卖出”分开当成其他模板')
    && msgs[0].content.includes('只提醒，不阻止卖出'));
  check('DashScope rule()：用户消息只含规则原文', msgs[1].role === 'user' && msgs[1].content === text);
  check('DashScope rule()：系统提示约定 scope 字段（仅原文明确写出的单个 6 位代码），且禁止按名称推断代码', msgs[0].content.includes('"scope":{"kind":"all|symbol","symbol":null}')
    && msgs[0].content.includes('6 位数字股票代码') && msgs[0].content.includes('不得推断或补全股票代码'));
  check('DashScope rule()：返回 rawText', r.rawText === '{"status":"unsupported"}');
}

/* ==== DashScope restate：提示词强制逐字复制 display（回归：pp 被改写为 %） ==== */
{
  const calls = [];
  const transport = createDashScopeTransport({
    apiKey: 'synthetic-key-marker',
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        output: { choices: [{ message: { content: JSON.stringify({ answer_text: ANSWER }) } }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await transport.restate({ question: QUESTION, facts: FACTS });
  const sent = JSON.parse(calls[0].options.body);
  const system = sent.input.messages[0];
  const user = sent.input.messages[1];
  check('DashScope restate：提示词要求逐字复制 display 并保留符号/千分位', system.role === 'system'
    && system.content.includes('逐字符原样复制')
    && system.content.includes('pp 不得写成')
    && system.content.includes('不能写 "+2.0%"')
    && system.content.includes('不能写 "-2805 元"'), system.content);
  check('DashScope restate：使用低温度参数', sent.parameters.temperature === 0.1, JSON.stringify(sent.parameters));
  check('DashScope restate：用户消息仅 question + facts', user.role === 'user'
    && Object.keys(JSON.parse(user.content)).join(',') === 'question,facts');
  check('DashScope restate：返回 rawText', result.rawText === JSON.stringify({ answer_text: ANSWER }), result.rawText);
}

/* ==== 行情路由：成功、校验、限额、错误映射（fake market transport，不联网） ==== */
{
  const doc = { artifact: DYNAMIC_CACHE_ARTIFACT, manifest_version: 'dynamic-v1', marker: 'synthetic-market-doc' };
  const calls = [];
  const handler = createHandler({
    transport: createFakeTransport(),
    marketTransport: { async snapshot(request) { calls.push(request); return doc; } },
    maxBodyBytes: 4096,
  });

  const ok = await invoke(handler, '/api/market/snapshot', { body: { symbols: ['600519', '000001'], start: '2024-12-20', end: '2025-01-06' } });
  check('行情路由：200 且返回 dynamic 文档', ok.status === 200 && ok.json?.ok === true
    && JSON.stringify(ok.json.market) === JSON.stringify(doc) && ok.headers.get('cache-control') === 'no-store', ok.text);
  check('行情路由：transport 只收到 symbols/start/end（无成交/文件信息）', calls.length === 1
    && Object.keys(calls[0]).sort().join(',') === 'end,start,symbols'
    && JSON.stringify(calls[0].symbols) === JSON.stringify(['600519', '000001']), JSON.stringify(calls[0]));

  const missing = await invoke(createHandler({ transport: null }), '/api/market/snapshot', {
    body: { symbols: ['600519'], start: '2024-12-20', end: '2025-01-06' },
  });
  check('行情路由：未配置 token → 503 E_MARKET_NOT_CONFIGURED', missing.status === 503
    && missing.json.code === SITE_FUNCTION_CODES.MARKET_NOT_CONFIGURED, missing.text);

  const before = calls.length;
  const invalidBodies = [
    ['未知字段', { symbols: ['600519'], start: '2024-12-20', end: '2025-01-06', trades: [{ symbol: '600519' }] }],
    ['空标的', { symbols: [], start: '2024-12-20', end: '2025-01-06' }],
    ['超过 10 个标的', { symbols: Array.from({ length: 11 }, (_, i) => `60000${i % 10}`), start: '2024-12-20', end: '2025-01-06' }],
    ['重复标的', { symbols: ['600519', '600519'], start: '2024-12-20', end: '2025-01-06' }],
    ['非 6 位标的', { symbols: ['60051'], start: '2024-12-20', end: '2025-01-06' }],
    ['非法日期', { symbols: ['600519'], start: '2024/12/20', end: '2025-01-06' }],
    ['起止颠倒', { symbols: ['600519'], start: '2025-01-06', end: '2024-12-20' }],
    ['范围超限', { symbols: ['600519'], start: '2000-01-01', end: '2025-01-06' }],
  ];
  for (const [name, body] of invalidBodies) {
    const r = await invoke(handler, '/api/market/snapshot', { body });
    const expected = name === '未知字段' ? SITE_FUNCTION_CODES.UNKNOWN_FIELD : SITE_FUNCTION_CODES.MARKET_REQUEST_INVALID;
    check(`行情路由：${name} → 400`, r.status === 400 && r.json.code === expected, r.text);
  }
  check('行情路由：非法请求不调用 transport', calls.length === before, `calls=${calls.length}`);

  const codeCases = [
    [MARKET_TRANSPORT_CODES.TIMEOUT, 504],
    [MARKET_TRANSPORT_CODES.SYMBOL_UNKNOWN, 422],
    [MARKET_TRANSPORT_CODES.NO_DATA, 422],
    [MARKET_TRANSPORT_CODES.REQUEST_INVALID, 400],
    [MARKET_TRANSPORT_CODES.UPSTREAM, 502],
    ['E_UNKNOWN_MARKET_FAILURE', 502],
  ];
  for (const [code, status] of codeCases) {
    const h = createHandler({
      transport: null,
      marketTransport: { async snapshot() { throw new MarketTransportError(code); } },
    });
    const r = await invoke(h, '/api/market/snapshot', { body: { symbols: ['600519'], start: '2024-12-20', end: '2025-01-06' } });
    check(`行情路由：${code} → ${status} 且脱敏`, r.status === status
      && r.json.code === (code === 'E_UNKNOWN_MARKET_FAILURE' ? SITE_FUNCTION_CODES.MARKET_UNAVAILABLE : code)
      && !r.text.includes('token'), r.text);
  }

  const malformed = await invoke(createHandler({
    transport: null,
    marketTransport: { async snapshot() { return { artifact: 'not-dynamic' }; } },
  }), '/api/market/snapshot', { body: { symbols: ['600519'], start: '2024-12-20', end: '2025-01-06' } });
  check('行情路由：transport 返回非 dynamic 文档 → 502 E_MARKET_RESPONSE', malformed.status === 502
    && malformed.json.code === SITE_FUNCTION_CODES.MARKET_RESPONSE, malformed.text);
}

/* ==== Tushare transport 契约（fake fetch，不联网） ==== */
{
  const TOKEN = 'synthetic-tushare-token-marker';
  const START = '2024-12-20';
  const END = '2025-01-10';
  const calendar = ['2025-01-02', '2025-01-03', '2025-01-06'];
  const stockBasic = {
    L: [
      ['600519.SH', '600519'],
      ['000001.SZ', '000001'],
      ['920001.BJ', '920001'],
      ['300750.SZ', '300750'],
    ],
    P: [],
    D: [['000003.SZ', '000003']],
  };
  const closes = {
    '600519.SH': [['20250102', 1500], ['20250103', 1510], ['20250106', 1520]],
    '000001.SZ': [['20250102', 10.5], ['20250103', 10.6], ['20250106', 10.7]],
    '920001.BJ': [['20250102', 20], ['20250103', 20.5], ['20250106', 21]],
    '300750.SZ': [['20250102', 200], ['20250106', 210]],
    '000003.SZ': [['20250102', 5], ['20250103', 5.1], ['20250106', 5.2]],
  };
  const factors = {
    '600519.SH': [['20250102', 2], ['20250103', 4], ['20250106', 4]],
    '000001.SZ': [['20250102', 1], ['20250103', 1], ['20250106', 1]],
    '920001.BJ': [['20250102', 1], ['20250103', 1], ['20250106', 1]],
    '300750.SZ': [['20250102', 1], ['20250106', 1]],
    '000003.SZ': [['20250102', 1], ['20250103', 1], ['20250106', 1]],
  };
  const indexCloses = [['20250102', 3900], ['20250103', 3930], ['20250106', 3960]];

  function createFakeUpstream({ failAt = () => null, calendarData = calendar, stockBasicData = stockBasic, indexData = indexCloses } = {}) {
    const calls = [];
    const exchangeSuffix = { SSE: '.SH', SZSE: '.SZ', BSE: '.BJ' };
    const fetchImpl = async (url, options) => {
      const sent = JSON.parse(options.body);
      calls.push({ url, sent, headers: options.headers });
      const failure = failAt({ sent, callNumber: calls.length });
      if (failure) {
        if (failure.error) throw failure.error;
        return new Response(failure.body === undefined ? '' : JSON.stringify(failure.body), {
          status: failure.status ?? 200,
          headers: failure.body === undefined ? {} : { 'Content-Type': 'application/json' },
        });
      }
      let fields;
      let rows;
      if (sent.api_name === 'stock_basic') {
        fields = ['ts_code', 'symbol', 'list_status'];
        rows = (stockBasicData[sent.params.list_status] ?? [])
          .filter(([tsCode]) => !sent.params.exchange || tsCode.endsWith(exchangeSuffix[sent.params.exchange]))
          .map(([tsCode, symbol]) => [tsCode, symbol, sent.params.list_status]);
      } else if (sent.api_name === 'trade_cal') {
        fields = ['cal_date'];
        const start = sent.params.start_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
        const end = sent.params.end_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
        rows = calendarData.filter((d) => d >= start && d <= end).map((d) => [d.replace(/-/g, '')]);
      } else if (sent.api_name === 'daily') {
        fields = ['ts_code', 'trade_date', 'close'];
        rows = (closes[sent.params.ts_code] ?? []).map(([d, c]) => [sent.params.ts_code, d, c]);
      } else if (sent.api_name === 'adj_factor') {
        fields = ['ts_code', 'trade_date', 'adj_factor'];
        rows = (factors[sent.params.ts_code] ?? []).map(([d, f]) => [sent.params.ts_code, d, f]);
      } else if (sent.api_name === 'index_daily') {
        if (indexData === null) {
          return new Response(JSON.stringify({ code: 1, msg: 'index permission unavailable' }), { status: 200 });
        }
        fields = ['ts_code', 'trade_date', 'close'];
        rows = indexData.map(([d, c]) => [sent.params.ts_code, d, c]);
      } else {
        return new Response(JSON.stringify({ code: 1, msg: 'unexpected api' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { fields, items: rows },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { calls, fetchImpl };
  }

  const upstream = createFakeUpstream();
  const transport = createTushareMarketTransport({
    token: TOKEN,
    fetchImpl: upstream.fetchImpl,
    timeoutMs: 1000,
    ttlMs: 60000,
    chunkTradingDays: 2,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const symbols = ['600519', '000001', '300750', '920001'];
  const doc = await transport.snapshot({ symbols, start: START, end: END });

  check('Tushare：artifact/manifest 为 dynamic-v1', doc.artifact === DYNAMIC_CACHE_ARTIFACT
    && doc.manifest_version === 'dynamic-v1' && doc.source.provider === 'tushare');
  check('Tushare：asOfDate/最新交易日取实际最新 bar，请求范围原样留痕', doc.asOfDate === '2025-01-06'
    && doc.snapshot.latest_trade_date === '2025-01-06' && doc.manifest.date_range.end === '2025-01-06'
    && doc.snapshot.range.end === '2025-01-06' && doc.snapshot.requested_range.start === START
    && doc.snapshot.requested_range.end === END);
  check('Tushare：交易日历来自 trade_cal（SSE/is_open=1）', doc.calendar.trading_days.join(',') === calendar.join(',')
    && upstream.calls.some((c) => c.sent.api_name === 'trade_cal' && c.sent.params.exchange === 'SSE' && c.sent.params.is_open === '1'));
  check('Tushare：ts_code 来自 stock_basic（交易所 × L/P/D），北交所与退市不靠代码首位猜测',
    doc.symbols['920001'].ts_code === '920001.BJ'
    && ['L', 'P', 'D'].every((status) => upstream.calls.some((c) => c.sent.api_name === 'stock_basic'
      && c.sent.params.list_status === status))
    && ['SSE', 'SZSE', 'BSE'].every((exchange) => upstream.calls.some((c) => c.sent.api_name === 'stock_basic'
      && c.sent.params.exchange === exchange))
    && doc.snapshot.mapping_source.includes('stock_basic'), JSON.stringify(doc.symbols['920001']));
  check('Tushare：daily/adj_factor 按交易日分段请求（不依赖未文档化的 offset 分页）',
    ['daily', 'adj_factor'].every((api) => upstream.calls.some((c) => c.sent.api_name === api
      && c.sent.params.start_date === '20250102' && c.sent.params.end_date === '20250103'))
    && ['daily', 'adj_factor'].every((api) => upstream.calls.some((c) => c.sent.api_name === api
      && c.sent.params.start_date === '20250106' && c.sent.params.end_date === '20250106'))
    && upstream.calls.every((c) => !('offset' in c.sent.params) && !('limit' in c.sent.params))
    && doc.source.segmentation.includes('按交易日分段'), JSON.stringify(doc.source.segmentation));
  check('Tushare：每标的调用 daily + adj_factor', symbols.every((symbol) => {
    const tsCode = doc.symbols[symbol].ts_code;
    return upstream.calls.some((c) => c.sent.api_name === 'daily' && c.sent.params.ts_code === tsCode)
      && upstream.calls.some((c) => c.sent.api_name === 'adj_factor' && c.sent.params.ts_code === tsCode);
  }));
  check('Tushare：bar 仅含 date/close（不返回成交量）', doc.symbols['600519'].bars.length === 3
    && Object.keys(doc.symbols['600519'].bars[0]).sort().join(',') === 'close,date'
    && doc.symbols['600519'].bars[2].close === 1520);
  check('Tushare：沪深300 第三线来自 index_daily（同交易日历、只含 date/close）', doc.benchmark?.available === true
    && doc.benchmark.ts_code === '000300.SH' && doc.benchmark.name === '沪深300'
    && doc.benchmark.bars.length === 3 && doc.benchmark.bars[0].close === 3900
    && Object.keys(doc.benchmark.bars[0]).sort().join(',') === 'close,date'
    && doc.benchmark.base_date === '2025-01-02', JSON.stringify(doc.benchmark));
  check('Tushare：基准请求指定 000300.SH 并按交易日分段', upstream.calls.some((c) => c.sent.api_name === 'index_daily'
    && c.sent.params.ts_code === '000300.SH' && c.sent.params.start_date === '20250102' && c.sent.params.end_date === '20250103')
    && upstream.calls.some((c) => c.sent.api_name === 'index_daily'
      && c.sent.params.start_date === '20250106' && c.sent.params.end_date === '20250106')
    && doc.source.apis.includes('index_daily'), JSON.stringify(upstream.calls.filter((c) => c.sent.api_name === 'index_daily').map((c) => c.sent.params)));
  check('Tushare：除权边界——不复权原样用于估值，前复权按固定基准日折算',
    doc.symbols['600519'].bars.map((b) => b.close).join(',') === '1500,1510,1520'
    && doc.symbols['600519'].bars_fwdadj.map((b) => b.close).join(',') === '750,1510,1520'
    && doc.symbols['600519'].adj_factor_base.date === '2025-01-06'
    && doc.symbols['600519'].adj_factor_base.factor === 4
    && doc.snapshot.adjustment_basis.includes('不复权估值'), JSON.stringify(doc.symbols['600519']));
  check('Tushare：停牌日无 daily 记录 → 不补价、不把个股停牌当全市场休市',
    doc.calendar.trading_days.join(',') === calendar.join(',')
    && doc.symbols['300750'].bars.map((b) => b.date).join(',') === '2025-01-02,2025-01-06'
    && doc.symbols['300750'].bars_fwdadj.map((b) => b.date).join(',') === '2025-01-02,2025-01-06');
  {
    const gate = assessDynamicCacheDoc(doc);
    const cache = createMarketCache({ tradingDays: doc.calendar.trading_days, range: doc.manifest.date_range, symbols: doc.symbols });
    const valuation = cache.resolveValuation('2025-01-03');
    const prices = cache.resolvePrices(['600519', '300750'], valuation.effective_date);
    check('Tushare：停牌缺价沿用现有组合阻断（不按剩余标的重算）', gate.usable === true
      && valuation.effective_date === '2025-01-03'
      && prices.per_symbol['600519'].close === 1510
      && prices.per_symbol['300750'].blocked === true
      && prices.per_symbol['300750'].no_fallback_used === true
      && prices.portfolio.blocked === true, JSON.stringify(prices));
  }
  check('Tushare：checksum 为 64 位十六进制，snapshot_id 带日期与摘要', /^[0-9a-f]{64}$/.test(doc.checksum)
    && doc.snapshot.snapshot_id.startsWith('tushare-20250106-') && doc.snapshot.snapshot_id.endsWith(doc.checksum.slice(0, 8)));
  check('Tushare：fetched_at 来自注入时钟', doc.fetched_at === '2026-10-19T01:30:00.000Z' && doc.snapshot.fetch_time === doc.fetched_at);
  check('Tushare：响应不含 token', !JSON.stringify(doc).includes(TOKEN) && upstream.calls.every((c) => c.sent.token === TOKEN));

  {
    const noIndexUpstream = createFakeUpstream({ indexData: null });
    const noIndexTransport = createTushareMarketTransport({
      token: TOKEN,
      fetchImpl: noIndexUpstream.fetchImpl,
      timeoutMs: 1000,
      ttlMs: 60000,
      retryDelayMs: 0,
      sleepImpl: async () => {},
      now: () => new Date('2026-10-19T01:30:00.000Z'),
    });
    const noIndex = await noIndexTransport.snapshot({ symbols: ['600519'], start: START, end: END });
    check('Tushare：基准不可用不阻断个股快照，明确标记 available:false', noIndex.symbols['600519'].bars.length === 3
      && noIndex.benchmark?.available === false && noIndex.benchmark.reason === MARKET_TRANSPORT_CODES.UPSTREAM
      && !('bars' in noIndex.benchmark), JSON.stringify(noIndex.benchmark));
  }

  const stockBasicCalls = () => upstream.calls.filter((c) => c.sent.api_name === 'stock_basic').length;
  const beforeBasic = stockBasicCalls();
  await transport.snapshot({ symbols: ['600519'], start: START, end: '2025-01-03' });
  check('Tushare：stock_basic 映射短 TTL 缓存，跨快照不重复拉取', stockBasicCalls() === beforeBasic,
    `before=${beforeBasic} after=${stockBasicCalls()}`);

  const callsBefore = upstream.calls.length;
  const cached = await transport.snapshot({ symbols: [...symbols].reverse(), start: START, end: END });
  check('Tushare：相同范围（标的顺序不同）命中短 TTL 缓存、不重复请求上游', cached === doc
    && upstream.calls.length === callsBefore, `calls=${upstream.calls.length - callsBefore}`);

  const delisted = await transport.snapshot({ symbols: ['000003'], start: START, end: END });
  check('Tushare：退市标的经 stock_basic(D) 映射后仍可取历史日线', delisted.symbols['000003'].ts_code === '000003.SZ'
    && delisted.symbols['000003'].bars.length === 3 && delisted.asOfDate === '2025-01-06', JSON.stringify(delisted.symbols['000003']));

  let unknownError = null;
  try { await transport.snapshot({ symbols: ['999999'], start: START, end: END }); } catch (e) { unknownError = e; }
  check('Tushare：stock_basic 中不存在 → E_MARKET_SYMBOL_UNKNOWN（不猜交易所）',
    unknownError && unknownError.code === MARKET_TRANSPORT_CODES.SYMBOL_UNKNOWN, unknownError && unknownError.code);

  let invalidError = null;
  try { await transport.snapshot({ symbols: ['60051'], start: START, end: END }); } catch (e) { invalidError = e; }
  check('Tushare：非法标的 → E_MARKET_REQUEST_INVALID', invalidError && invalidError.code === MARKET_TRANSPORT_CODES.REQUEST_INVALID);

  const retryUpstream = createFakeUpstream({ failAt: ({ callNumber }) => (callNumber === 1 ? { status: 503 } : null) });
  const retryTransport = createTushareMarketTransport({
    token: TOKEN,
    fetchImpl: retryUpstream.fetchImpl,
    timeoutMs: 1000,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const retried = await retryTransport.snapshot({ symbols: ['600519'], start: START, end: END });
  check('Tushare：HTTP 5xx 退避重试后成功（只重试一次）', retried.asOfDate === '2025-01-06'
    && retryUpstream.calls[0].sent.api_name === 'stock_basic'
    && retryUpstream.calls[1].sent.api_name === 'stock_basic'
    && retryUpstream.calls.filter((c) => c.sent.api_name === 'stock_basic').length === 10,
  JSON.stringify(retryUpstream.calls.slice(0, 3).map((c) => c.sent.api_name)));

  const businessFail = createFakeUpstream({ failAt: () => ({ body: { code: 500, msg: 'provider-secret-marker' } }) });
  const businessTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: businessFail.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
  });
  let upstreamError = null;
  try { await businessTransport.snapshot({ symbols: ['600519'], start: START, end: END }); } catch (e) { upstreamError = e; }
  check('Tushare：业务错误 code≠0 不重试 → E_MARKET_UNAVAILABLE 且不转发上游文本', upstreamError
    && upstreamError.code === MARKET_TRANSPORT_CODES.UPSTREAM && !upstreamError.message.includes('provider-secret-marker')
    && businessFail.calls.length === 1, `calls=${businessFail.calls.length}`);

  const pageFailUpstream = createFakeUpstream();
  const pageFailTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: pageFailUpstream.fetchImpl, timeoutMs: 1000, rowLimit: 1,
    retryDelayMs: 0, sleepImpl: async () => {},
  });
  let pageError = null;
  try { await pageFailTransport.snapshot({ symbols: ['600519'], start: START, end: END }); } catch (e) { pageError = e; }
  check('Tushare：单次响应达到行数上限 → E_MARKET_RESPONSE_INVALID，不返回截断快照', pageError
    && pageError.code === MARKET_TRANSPORT_CODES.RESPONSE && pageFailUpstream.calls.length === 1);

  const emptyCalUpstream = createFakeUpstream({ calendarData: [] });
  const emptyCalTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: emptyCalUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
  });
  let noDataError = null;
  try { await emptyCalTransport.snapshot({ symbols: ['600519'], start: START, end: END }); } catch (e) { noDataError = e; }
  check('Tushare：空交易日历 → E_MARKET_NO_DATA', noDataError && noDataError.code === MARKET_TRANSPORT_CODES.NO_DATA);

  // Tushare 对无记录查询可能返回 data:null（如北交所没有某 list_status 的股票），合法空结果不能判成响应损坏。
  const nullDataUpstream = createFakeUpstream({
    failAt: ({ sent }) => (sent.api_name === 'stock_basic' && sent.params.exchange === 'BSE'
      ? { body: { code: 0, data: null } }
      : null),
  });
  const nullDataTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: nullDataUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const nullDataDoc = await nullDataTransport.snapshot({ symbols: ['600519'], start: START, end: END });
  check('Tushare：stock_basic 返回 data:null → 视为空集合，仍可构建快照', nullDataDoc.asOfDate === '2025-01-06'
    && nullDataDoc.symbols['600519'].bars.length === 3
    && nullDataUpstream.calls.some((c) => c.sent.api_name === 'stock_basic' && c.sent.params.exchange === 'BSE'),
  JSON.stringify({ asOfDate: nullDataDoc.asOfDate }));

  // items:null 同样是合法空结果（例如某标的在区间内没有复权因子记录）。
  const nullItemsUpstream = createFakeUpstream({
    failAt: ({ sent }) => (sent.api_name === 'adj_factor' && sent.params.ts_code === '600519.SH'
      ? { body: { code: 0, data: { fields: ['ts_code', 'trade_date', 'adj_factor'], items: null } } }
      : null),
  });
  const nullItemsTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: nullItemsUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const nullItemsDoc = await nullItemsTransport.snapshot({ symbols: ['600519'], start: START, end: END });
  check('Tushare：items:null → 视为空集合，不复权价仍可用、前复权序列为空', nullItemsDoc.symbols['600519'].bars.length === 3
    && nullItemsDoc.symbols['600519'].bars_fwdadj.length === 0
    && nullItemsDoc.symbols['600519'].adj_factor_base === null, JSON.stringify(nullItemsDoc.symbols['600519']));

  // 真实 stock_basic 的 SSE/D 含 7 位 symbol 记录；无关异常行不应阻断整批快照。
  const oddStockBasicUpstream = createFakeUpstream({
    stockBasicData: {
      L: [...stockBasic.L, ['6005191.SH', '6005191']],
      P: [],
      D: [['000003.SZ', '000003'], ['0000031.SZ', '0000031']],
    },
  });
  const oddStockBasicTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: oddStockBasicUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const oddStockBasicDoc = await oddStockBasicTransport.snapshot({ symbols: ['600519', '000003'], start: START, end: END });
  check('Tushare：无关的 7 位 stock_basic 异常行被跳过，请求标的仍构建快照',
    oddStockBasicDoc.symbols['600519'].ts_code === '600519.SH'
    && oddStockBasicDoc.symbols['000003'].ts_code === '000003.SZ'
    && oddStockBasicDoc.asOfDate === '2025-01-06',
    JSON.stringify({ symbols: oddStockBasicDoc.symbols, asOfDate: oddStockBasicDoc.asOfDate }));

  const targetOddUpstream = createFakeUpstream({
    stockBasicData: { L: [['600519.SH', '600519'], ['0000011.SZ', '0000011']], P: [], D: [] },
  });
  const targetOddTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: targetOddUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
  });
  let targetOddError = null;
  try { await targetOddTransport.snapshot({ symbols: ['000001'], start: START, end: END }); } catch (e) { targetOddError = e; }
  check('Tushare：请求标的仅存在于异常 stock_basic 行 → E_MARKET_SYMBOL_UNKNOWN，不误判格式错误',
    targetOddError && targetOddError.code === MARKET_TRANSPORT_CODES.SYMBOL_UNKNOWN,
    targetOddError && targetOddError.code);

  const allOddUpstream = createFakeUpstream({
    stockBasicData: { L: [['6005191.SH', '6005191']], P: [], D: [] },
  });
  const allOddTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: allOddUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
  });
  let allOddError = null;
  try { await allOddTransport.snapshot({ symbols: ['600519'], start: START, end: END }); } catch (e) { allOddError = e; }
  check('Tushare：stock_basic 全部行无效 → 仍为 E_MARKET_RESPONSE_INVALID（不伪装成空映射）',
    allOddError && allOddError.code === MARKET_TRANSPORT_CODES.RESPONSE, allOddError && allOddError.code);

  // 交易日历含当日、但 daily 尚未入库（Tushare 15:00–16:00 才更新）：应取最近已收盘 bar，不报格式错误。
  const pendingTodayUpstream = createFakeUpstream({ calendarData: [...calendar, '2025-01-07'] });
  const pendingTodayTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: pendingTodayUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const pendingTodayDoc = await pendingTodayTransport.snapshot({ symbols: ['600519'], start: START, end: '2025-01-07' });
  check('Tushare：交易日历含当日而 daily 未入库 → asOfDate 取最近已收盘 bar，请求范围原样留痕',
    pendingTodayDoc.asOfDate === '2025-01-06'
    && pendingTodayDoc.calendar.trading_days.join(',') === calendar.join(',')
    && pendingTodayDoc.snapshot.requested_range.end === '2025-01-07'
    && pendingTodayDoc.manifest.date_range.end === '2025-01-06',
    JSON.stringify({ asOfDate: pendingTodayDoc.asOfDate, calendar: pendingTodayDoc.calendar, requested: pendingTodayDoc.snapshot.requested_range }));

  const malformedDataUpstream = createFakeUpstream({
    failAt: ({ sent }) => (sent.api_name === 'stock_basic'
      ? { body: { code: 0, data: { items: [['600519.SH', '600519', 'L']] } } }
      : null),
  });
  const malformedDataTransport = createTushareMarketTransport({
    token: TOKEN, fetchImpl: malformedDataUpstream.fetchImpl, timeoutMs: 1000, retryDelayMs: 0, sleepImpl: async () => {},
  });
  let malformedDataError = null;
  try { await malformedDataTransport.snapshot({ symbols: ['600519'], start: START, end: END }); } catch (e) { malformedDataError = e; }
  check('Tushare：非空结果缺少 fields → 仍判 E_MARKET_RESPONSE_INVALID（不把损坏响应当空结果）',
    malformedDataError && malformedDataError.code === MARKET_TRANSPORT_CODES.RESPONSE, malformedDataError && malformedDataError.code);

  const timeoutTransport = createTushareMarketTransport({
    token: TOKEN,
    timeoutMs: 10,
    maxAttempts: 1,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  let timeoutError = null;
  try { await timeoutTransport.snapshot({ symbols: ['600519'], start: START, end: END }); } catch (e) { timeoutError = e; }
  check('Tushare：超时 → E_MARKET_TIMEOUT', timeoutError && timeoutError.code === MARKET_TRANSPORT_CODES.TIMEOUT);

  const replayUpstream = createFakeUpstream();
  const replayTransport = createTushareMarketTransport({
    token: TOKEN,
    fetchImpl: replayUpstream.fetchImpl,
    timeoutMs: 1000,
    chunkTradingDays: 2,
    retryDelayMs: 0,
    sleepImpl: async () => {},
    now: () => new Date('2026-10-20T02:00:00.000Z'),
  });
  const replay = await replayTransport.snapshot({ symbols, start: START, end: END });
  check('Tushare：相同输入可复算——checksum/snapshot_id 相同，抓取时间不同', replay.checksum === doc.checksum
    && replay.snapshot.snapshot_id === doc.snapshot.snapshot_id
    && replay.fetched_at !== doc.fetched_at
    && JSON.stringify(replay.symbols) === JSON.stringify(doc.symbols));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
