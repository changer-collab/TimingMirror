#!/usr/bin/env node
/**
 * Qoder Sites Function 本地测试（Node Web Request/Response；fake transport；不联网）
 *
 * 路由按平台形态使用 /functions/v1/app/api/llm/intent 与 /restate。
 * 覆盖成功、缺失 transport、非法 JSON/字段/事实、体积、错误脱敏和超时；
 * 并验证 DashScope transport 的端点/模型/参数/超时，不调用真实模型。
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
  marketSymbolToTsCode,
} from '../../server/site-functions/market.mjs';
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
  const calendar = ['2025-01-02', '2025-01-03', '2025-01-06'];
  const closes = {
    '600519.SH': [
      ['20250102', 1500], ['20250103', 1510], ['20250106', 1520],
    ],
    '000001.SZ': [
      ['20250102', 10.5], ['20250103', 10.6], ['20250106', 10.7],
    ],
  };
  const factors = {
    '600519.SH': [['20250102', 2.0], ['20250103', 2.1], ['20250106', 2.1]],
    '000001.SZ': [['20250102', 1.0], ['20250103', 1.0], ['20250106', 1.0]],
  };
  const upstreamCalls = [];
  const fakeFetch = async (url, options) => {
    const sent = JSON.parse(options.body);
    upstreamCalls.push({ url, sent, headers: options.headers });
    let payload;
    if (sent.api_name === 'trade_cal') {
      payload = { code: 0, data: { fields: ['cal_date'], items: calendar.map((d) => [d.replace(/-/g, '')]) } };
    } else if (sent.api_name === 'daily') {
      payload = {
        code: 0,
        data: {
          fields: ['ts_code', 'trade_date', 'close'],
          items: (closes[sent.params.ts_code] ?? []).map(([d, c]) => [sent.params.ts_code, d, c]),
        },
      };
    } else if (sent.api_name === 'adj_factor') {
      payload = {
        code: 0,
        data: {
          fields: ['ts_code', 'trade_date', 'adj_factor'],
          items: (factors[sent.params.ts_code] ?? []).map(([d, f]) => [sent.params.ts_code, d, f]),
        },
      };
    } else {
      payload = { code: 1, msg: 'unexpected api' };
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const transport = createTushareMarketTransport({
    token: TOKEN,
    fetchImpl: fakeFetch,
    timeoutMs: 1000,
    ttlMs: 60000,
    now: () => new Date('2026-10-19T01:30:00.000Z'),
  });
  const doc = await transport.snapshot({ symbols: ['600519', '000001'], start: '2024-12-20', end: '2025-01-06' });

  check('Tushare：artifact/manifest 为 dynamic-v1', doc.artifact === DYNAMIC_CACHE_ARTIFACT
    && doc.manifest_version === 'dynamic-v1' && doc.source.provider === 'tushare');
  check('Tushare：asOfDate/最新交易日取实际最新 bar，范围收窄', doc.asOfDate === '2025-01-06'
    && doc.snapshot.latest_trade_date === '2025-01-06' && doc.manifest.date_range.end === '2025-01-06');
  check('Tushare：交易日历来自 trade_cal（SSE/is_open=1）', doc.calendar.trading_days.join(',') === calendar.join(',')
    && upstreamCalls.some((c) => c.sent.api_name === 'trade_cal' && c.sent.params.exchange === 'SSE' && c.sent.params.is_open === '1'));
  check('Tushare：ts_code 映射（沪/深）', marketSymbolToTsCode('600519') === '600519.SH'
    && marketSymbolToTsCode('000001') === '000001.SZ' && marketSymbolToTsCode('300750') === '300750.SZ'
    && marketSymbolToTsCode('830799') === '830799.BJ');
  check('Tushare：每标的调用 daily + adj_factor', ['600519.SH', '000001.SZ'].every((code) =>
    upstreamCalls.some((c) => c.sent.api_name === 'daily' && c.sent.params.ts_code === code)
    && upstreamCalls.some((c) => c.sent.api_name === 'adj_factor' && c.sent.params.ts_code === code)));
  check('Tushare：bar 仅含 date/close（不返回成交量）', doc.symbols['600519'].bars.length === 3
    && Object.keys(doc.symbols['600519'].bars[0]).sort().join(',') === 'close,date'
    && doc.symbols['600519'].bars[2].close === 1520);
  check('Tushare：前复权 close = close × adj_factor / 最新 adj_factor', doc.symbols['600519'].bars_fwdadj[0].close === 1428.5714
    && doc.symbols['600519'].bars_fwdadj[2].close === 1520);
  check('Tushare：checksum 为 64 位十六进制，snapshot_id 带日期与摘要', /^[0-9a-f]{64}$/.test(doc.checksum)
    && doc.snapshot.snapshot_id.startsWith('tushare-20250106-') && doc.snapshot.snapshot_id.endsWith(doc.checksum.slice(0, 8)));
  check('Tushare：fetched_at 来自注入时钟', doc.fetched_at === '2026-10-19T01:30:00.000Z' && doc.snapshot.fetch_time === doc.fetched_at);
  check('Tushare：响应不含 token', !JSON.stringify(doc).includes(TOKEN) && upstreamCalls.every((c) => c.sent.token === TOKEN));

  const callsBefore = upstreamCalls.length;
  const cached = await transport.snapshot({ symbols: ['000001', '600519'], start: '2024-12-20', end: '2025-01-06' });
  check('Tushare：相同范围（标的顺序不同）命中短 TTL 缓存、不重复请求上游', cached === doc
    && upstreamCalls.length === callsBefore, `calls=${upstreamCalls.length - callsBefore}`);

  let invalidError = null;
  try { await transport.snapshot({ symbols: ['60051'], start: '2024-12-20', end: '2025-01-06' }); } catch (e) { invalidError = e; }
  check('Tushare：非法标的 → E_MARKET_REQUEST_INVALID', invalidError && invalidError.code === MARKET_TRANSPORT_CODES.REQUEST_INVALID);

  const emptyCal = createTushareMarketTransport({
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { fields: ['cal_date'], items: [] } }), { status: 200 }),
  });
  let noDataError = null;
  try { await emptyCal.snapshot({ symbols: ['600519'], start: '2024-12-20', end: '2025-01-06' }); } catch (e) { noDataError = e; }
  check('Tushare：空交易日历 → E_MARKET_NO_DATA', noDataError && noDataError.code === MARKET_TRANSPORT_CODES.NO_DATA);

  const upstreamFail = createTushareMarketTransport({
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ code: 500, msg: 'provider-secret-marker' }), { status: 200 }),
  });
  let upstreamError = null;
  try { await upstreamFail.snapshot({ symbols: ['600519'], start: '2024-12-20', end: '2025-01-06' }); } catch (e) { upstreamError = e; }
  check('Tushare：上游 code≠0 → E_MARKET_UNAVAILABLE 且不转发上游文本', upstreamError
    && upstreamError.code === MARKET_TRANSPORT_CODES.UPSTREAM && !upstreamError.message.includes('provider-secret-marker'));

  const timeoutTransport = createTushareMarketTransport({
    token: TOKEN,
    timeoutMs: 10,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  let timeoutError = null;
  try { await timeoutTransport.snapshot({ symbols: ['600519'], start: '2024-12-20', end: '2025-01-06' }); } catch (e) { timeoutError = e; }
  check('Tushare：超时 → E_MARKET_TIMEOUT', timeoutError && timeoutError.code === MARKET_TRANSPORT_CODES.TIMEOUT);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
