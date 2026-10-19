#!/usr/bin/env node
/**
 * 本地代理骨架定向测试（真实 127.0.0.1 HTTP 回环；fake transport；不访问外网）
 *
 * 覆盖：health、默认禁用、fake 成功、非法 JSON、未知字段、非法事实、
 *       请求体过大、Content-Type、CORS allowlist 与错误脱敏。
 * 边界：不调用百炼、不读取凭证、不创建 .env；通过不代表 M0-C3/C4 或真实在线链路完成。
 */
import http from 'node:http';
import {
  createProxyServer,
  createProxyConfig,
  DASHSCOPE_API_KEY_ENV,
  PROXY_CODES,
} from '../../server/fc-proxy/proxyServer.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const ORIGIN = 'http://127.0.0.1:5180';
const DENIED_ORIGIN = 'http://127.0.0.1:9999';
const QUESTION = '组合整体表现如何？';
const F6 = new Set(['value', 'unit', 'display', 'formula_ref', 'source_ref']);
const SHORT_FACTS = [
  { value: 0.075, unit: '%', display: '+7.5%', formula_ref: 'CALC_RET_V1', source_ref: 'src-aaaa1111' },
  { value: 0.15, unit: '%', display: '+15.0%', formula_ref: 'CALC_RET_V1', source_ref: 'src-bbbb2222' },
  { value: 0.075, unit: 'pp', display: '+7.5pp', formula_ref: 'CALC_DRAG_PP_V1', source_ref: 'src-cccc3333' },
  { value: 150, unit: '元', display: '¥150.00', formula_ref: 'CALC_DRAG_MONEY_V1', source_ref: 'src-dddd4444' },
];
const EXPORT_STYLE_FACTS = [
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
      return restate ? restate(request) : { rawText: '{"answer_text":"ok"}' };
    },
  };
}

function request({ port, path, method = 'POST', headers = {}, body = null, origin }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin !== undefined) h.Origin = origin;
    if (body !== null) {
      if (h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 响应由断言处理 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function withServer(options, fn) {
  const server = createProxyServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    return await fn({ port: address.port, address: address.address });
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/* ==== health、默认禁用、fake 成功 ==== */
{
  const transport = createFakeTransport();
  await withServer({ transport, config: { allowedOrigins: [ORIGIN] } }, async ({ port, address }) => {
    check('HTTP 服务仅监听 127.0.0.1', address === '127.0.0.1', address);

    const health = await request({ port, path: '/health', method: 'GET' });
    check('health：200 且只表示代理存活', health.status === 200
      && health.json && health.json.ok === true && health.json.service === 'fc-proxy'
      && health.json.status === 'alive' && Object.keys(health.json).sort().join(',') === 'ok,service,status', health.text);

    const intent = await request({
      port, path: '/api/llm/intent', body: JSON.stringify({ question: QUESTION }), origin: ORIGIN,
    });
    check('fake intent：200 且响应仅 rawText', intent.status === 200 && intent.json
      && typeof intent.json.rawText === 'string' && Object.keys(intent.json).join(',') === 'rawText', intent.text);
    const intentCall = transport.calls.find((c) => c.stage === 'intent');
    check('intent transport：仅 question', intentCall && Object.keys(intentCall.request).join(',') === 'question');
    check('CORS：允许 origin 精确回显且不使用通配符',
      intent.headers['access-control-allow-origin'] === ORIGIN && intent.headers['access-control-allow-origin'] !== '*');

    const restate = await request({
      port,
      path: '/api/llm/restate',
      body: JSON.stringify({ question: QUESTION, facts: EXPORT_STYLE_FACTS }),
      origin: ORIGIN,
    });
    check('fake restate：200 且响应仅 rawText', restate.status === 200 && restate.json
      && typeof restate.json.rawText === 'string' && Object.keys(restate.json).join(',') === 'rawText', restate.text);
    const restateCall = transport.calls.find((c) => c.stage === 'restate');
    check('restate transport：请求仅 question + facts', restateCall
      && Object.keys(restateCall.request).join(',') === 'question,facts');
    check('restate facts：仅 F-6 字段且描述性 unit 已投影为短单位', restateCall
      && restateCall.request.facts.every((fact) => Object.keys(fact).every((key) => F6.has(key)))
      && restateCall.request.facts.every((fact) => ['%', 'pp', '元'].includes(fact.unit))
      && restateCall.request.facts.every((fact) => !('key' in fact) && !('fact_ref' in fact) && !('scope' in fact)));

    const noOrigin = await request({ port, path: '/api/llm/intent', body: JSON.stringify({ question: QUESTION }) });
    check('无 Origin：允许且不下发 CORS 通配符', noOrigin.status === 200
      && noOrigin.headers['access-control-allow-origin'] === undefined);
  });
}

/* ==== 默认禁用与 API Key 配置入口（合成配置） ==== */
{
  const config = createProxyConfig({ apiKey: 'synthetic-key-marker', allowedOrigins: [ORIGIN] });
  check('API Key 配置入口：变量名为 DASHSCOPE_API_KEY，合成配置可注入',
    DASHSCOPE_API_KEY_ENV === 'DASHSCOPE_API_KEY' && config.apiKey === 'synthetic-key-marker');
  await withServer({ transport: null, config }, async ({ port }) => {
    const health = await request({ port, path: '/health', method: 'GET' });
    check('默认禁用：health 仍为 200', health.status === 200 && health.json.ok === true);
    const disabled = await request({
      port, path: '/api/llm/intent', body: JSON.stringify({ question: QUESTION }), origin: ORIGIN,
    });
    check('默认禁用：503 E_PROXY_MODEL_DISABLED', disabled.status === 503
      && disabled.json && disabled.json.code === PROXY_CODES.MODEL_DISABLED, disabled.text);
    check('默认禁用：响应不含合成 Key/内部配置',
      !disabled.text.includes('synthetic-key-marker') && !disabled.text.includes('apiKey') && !disabled.text.includes('DASHSCOPE'));
  });
}

/* ==== 非法 JSON、未知字段、非法事实、Content-Type、体积、CORS ==== */
{
  const transport = createFakeTransport();
  await withServer({ transport, config: { allowedOrigins: [ORIGIN], maxBodyBytes: 4096 } }, async ({ port }) => {
    const before = transport.calls.length;

    const invalidJson = await request({ port, path: '/api/llm/intent', body: '{bad-json', origin: ORIGIN });
    check('非法 JSON：400 E_PROXY_JSON_INVALID', invalidJson.status === 400
      && invalidJson.json.code === PROXY_CODES.JSON_INVALID, invalidJson.text);

    for (const field of ['review', 'prepared', 'plan', 'provenance']) {
      const body = JSON.stringify({ question: QUESTION, [field]: { marker: field } });
      const r = await request({ port, path: '/api/llm/intent', body, origin: ORIGIN });
      check(`未知顶层字段 ${field}：400 且不转发`, r.status === 400 && r.json.code === PROXY_CODES.UNKNOWN_FIELD, r.text);
    }
    for (const field of ['key', 'fact_ref', 'scope']) {
      const body = JSON.stringify({ question: QUESTION, facts: [{ ...SHORT_FACTS[0], [field]: 'marker' }] });
      const r = await request({ port, path: '/api/llm/restate', body, origin: ORIGIN });
      check(`未知事实字段 ${field}：400 且不转发`, r.status === 400 && r.json.code === PROXY_CODES.UNKNOWN_FIELD, r.text);
    }

    const badUnit = await request({
      port,
      path: '/api/llm/restate',
      body: JSON.stringify({ question: QUESTION, facts: [{ ...SHORT_FACTS[0], unit: 'account-123456' }] }),
      origin: ORIGIN,
    });
    check('非法事实 unit：400 且不转发', badUnit.status === 400
      && badUnit.json.code === PROXY_CODES.REQUEST_INVALID, badUnit.text);

    const noFormula = { ...SHORT_FACTS[0] };
    delete noFormula.formula_ref;
    const missingFormula = await request({
      port,
      path: '/api/llm/restate',
      body: JSON.stringify({ question: QUESTION, facts: [noFormula] }),
      origin: ORIGIN,
    });
    check('缺失 formula_ref：400 且不转发', missingFormula.status === 400
      && missingFormula.json.code === PROXY_CODES.REQUEST_INVALID, missingFormula.text);

    const badType = await request({
      port, path: '/api/llm/intent', body: JSON.stringify({ question: QUESTION }), origin: ORIGIN,
      headers: { 'Content-Type': 'text/plain' },
    });
    check('Content-Type 非 JSON：415 且不转发', badType.status === 415
      && badType.json.code === PROXY_CODES.CONTENT_TYPE, badType.text);

    const tooLarge = await request({
      port, path: '/api/llm/intent', body: JSON.stringify({ question: 'x'.repeat(5000) }), origin: ORIGIN,
    });
    check('请求体过大：413 且不转发', tooLarge.status === 413
      && tooLarge.json.code === PROXY_CODES.BODY_TOO_LARGE, tooLarge.text);

    const preflight = await request({
      port,
      path: '/api/llm/intent',
      method: 'OPTIONS',
      origin: ORIGIN,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    check('CORS preflight：允许 origin，204 且精确回显', preflight.status === 204
      && preflight.headers['access-control-allow-origin'] === ORIGIN
      && String(preflight.headers['access-control-allow-methods']).includes('POST')
      && preflight.headers['access-control-allow-origin'] !== '*');

    const denied = await request({
      port, path: '/api/llm/intent', body: JSON.stringify({ question: QUESTION }), origin: DENIED_ORIGIN,
    });
    check('CORS：非 allowlist origin 403 且不转发', denied.status === 403
      && denied.json.code === PROXY_CODES.CORS_DENIED && denied.headers['access-control-allow-origin'] === undefined, denied.text);

    check('所有非法请求均未调用 fake transport', transport.calls.length === before, `calls=${transport.calls.length}`);
  });
}

/* ==== 错误脱敏：transport 异常/非法响应 ==== */
{
  const transport = createFakeTransport({
    intent: () => { throw new Error('provider-secret-marker /stack'); },
    restate: () => ({ body: 'not-raw-text' }),
  });
  await withServer({ transport, config: { allowedOrigins: [ORIGIN] } }, async ({ port }) => {
    const failed = await request({ port, path: '/api/llm/intent', body: JSON.stringify({ question: QUESTION }), origin: ORIGIN });
    check('transport 异常：502 E_PROXY_MODEL_UNAVAILABLE 且脱敏', failed.status === 502
      && failed.json.code === PROXY_CODES.MODEL_UNAVAILABLE
      && !failed.text.includes('provider-secret-marker') && !failed.text.includes('/stack'), failed.text);

    const malformed = await request({
      port, path: '/api/llm/restate', body: JSON.stringify({ question: QUESTION, facts: SHORT_FACTS }), origin: ORIGIN,
    });
    check('transport 非法响应：502 E_PROXY_MODEL_RESPONSE_INVALID 且不转发正文', malformed.status === 502
      && malformed.json.code === PROXY_CODES.MODEL_RESPONSE_INVALID
      && !malformed.text.includes('not-raw-text'), malformed.text);
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
