#!/usr/bin/env node
/**
 * 客户端 HTTP transport 集成测试（真实 127.0.0.1 回环；fake transport；不访问外网）
 *
 * 链路：onlineBoundary → httpTransport → 本地代理 HTTP 路由 → fake transport。
 * 覆盖：intent/restate 成功、默认禁用 503、非法响应、取消请求、
 *       HTTP 请求体白名单、请求头无 Key、冻结快照隔离。
 * 边界：不调用百炼、不读取凭证；通过不代表百炼已接通或 M0-C3/C4 完成。
 */
import http from 'node:http';
import { createProxyServer } from '../../server/fc-proxy/proxyServer.mjs';
import {
  createHttpTransport,
  DEFAULT_PROXY_BASE_URL,
  HTTP_TRANSPORT_CODES,
  SAME_ORIGIN_BASE,
  SITE_FUNCTION_PATHS,
  normalizeProxyBaseUrl,
} from '../../src/agent/httpTransport.js';
import { createOnlineBoundary, ONLINE_BOUNDARY_CODES } from '../../src/agent/onlineBoundary.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '组合整体表现如何？';
const ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';
const INTENT_RAW = '{"intent":"loss_overview","slots":{},"confidence":1}';
const RESTATE_RAW = JSON.stringify({ answer_text: ANSWER });
const F6 = new Set(['value', 'unit', 'display', 'formula_ref', 'source_ref']);
const FACTS = [
  { value: 0.075, unit: '%', display: '+7.5%', formula_ref: 'CALC_RET_V1', source_ref: 'src-aaaa1111' },
  { value: 0.15, unit: '%', display: '+15.0%', formula_ref: 'CALC_RET_V1', source_ref: 'src-bbbb2222' },
  { value: 0.075, unit: 'pp', display: '+7.5pp', formula_ref: 'CALC_DRAG_PP_V1', source_ref: 'src-cccc3333' },
  { value: 150, unit: '元', display: '¥150.00', formula_ref: 'CALC_DRAG_MONEY_V1', source_ref: 'src-dddd4444' },
];

function createFakeTransport({ intent, restate } = {}) {
  const calls = [];
  return {
    calls,
    async intent(request) {
      calls.push({ stage: 'intent', request });
      return intent ? intent(request) : { rawText: INTENT_RAW };
    },
    async restate(request) {
      calls.push({ stage: 'restate', request });
      return restate ? restate(request) : { rawText: RESTATE_RAW };
    },
  };
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

/* 原生 http.request 的 fetch 兼容适配器：测试真实 HTTP，但避免全局 fetch keep-alive 清理问题。 */
function nodeFetch(url, { method = 'POST', headers = {}, body = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: false,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          async json() { return JSON.parse(text); },
          async text() { return text; },
        });
      });
    });
    const onAbort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      req.destroy(error);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', (error) => {
      if (signal && signal.aborted) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        reject(aborted);
        return;
      }
      reject(error);
    });
    if (body !== null) req.write(body);
    req.end();
  });
}

function createRecordingFetch(fetchImpl = nodeFetch) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
  };
}

/* ==== 默认地址与配置边界 ==== */
check('默认代理地址为 127.0.0.1:5181', DEFAULT_PROXY_BASE_URL === 'http://127.0.0.1:5181');
try {
  normalizeProxyBaseUrl('http://example.com:5181');
  check('外部 baseUrl 被拒绝', false, '未抛错');
} catch {
  check('外部 baseUrl 被拒绝', true);
}

/* ==== 站点同源路径 ==== */
{
  const calls = [];
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ rawText: '{"answer_text":"ok"}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await siteTransport.restate({ question: QUESTION, facts: FACTS });
  const body = JSON.parse(calls[0].options.body);
  check('站点 transport：同源平台路径', calls[0].url === SITE_FUNCTION_PATHS.restate
    && calls[0].url === '/functions/v1/app/api/llm/restate');
  check('站点 transport：body 仅 question + facts', Object.keys(body).join(',') === 'question,facts');
  check('站点 transport：无 Authorization/API Key 头', !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('站点 transport：返回 rawText', result.rawText === '{"answer_text":"ok"}');
}

/* ==== intent/restate 成功 + 实际 HTTP 请求白名单 ==== */
{
  const proxyTransport = createFakeTransport();
  await withServer({ transport: proxyTransport, config: { allowedOrigins: ['http://127.0.0.1:5180'] } }, async ({ port, address }) => {
    check('集成代理仅监听 127.0.0.1', address === '127.0.0.1', address);
    const recording = createRecordingFetch(nodeFetch);
    const httpTransport = createHttpTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: recording.fetchImpl,
    });
    const boundary = createOnlineBoundary({ transport: httpTransport, timeoutMs: 3000 });

    const intentResult = await boundary.classifyIntent({ question: QUESTION });
    check('集成 intent：onlineBoundary 成功', intentResult.ok && intentResult.data.intentJson.intent === 'loss_overview', JSON.stringify(intentResult));
    const intentHttp = recording.calls.find((c) => c.url.endsWith('/api/llm/intent'));
    const intentBody = JSON.parse(intentHttp.options.body);
    check('HTTP intent：POST 固定路径', intentHttp.options.method === 'POST'
      && intentHttp.url === `http://127.0.0.1:${port}/api/llm/intent`, intentHttp.url);
    check('HTTP intent：body 仅 question', Object.keys(intentBody).join(',') === 'question' && intentBody.question === QUESTION);
    check('HTTP intent：signal 不进入 JSON', !intentHttp.options.body.includes('signal'));
    check('HTTP intent：无 Authorization/API Key 头', !Object.keys(intentHttp.options.headers).some((h) => /authorization|api[-_]?key/i.test(h))
      && intentHttp.options.headers['Content-Type'] === 'application/json');
    const proxyIntent = proxyTransport.calls.find((c) => c.stage === 'intent');
    check('代理 fake intent：仅收到 question', proxyIntent && Object.keys(proxyIntent.request).join(',') === 'question');

    const restateResult = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('集成 restate：onlineBoundary 成功且数字检查 4/4', restateResult.ok
      && restateResult.data.draft === ANSWER && restateResult.data.number_check.checked === 4, JSON.stringify(restateResult));
    const restateHttp = recording.calls.find((c) => c.url.endsWith('/api/llm/restate'));
    const restateBody = JSON.parse(restateHttp.options.body);
    check('HTTP restate：POST 固定路径', restateHttp.options.method === 'POST'
      && restateHttp.url === `http://127.0.0.1:${port}/api/llm/restate`, restateHttp.url);
    check('HTTP restate：body 仅 question + facts', Object.keys(restateBody).join(',') === 'question,facts');
    check('HTTP restate：facts 仅 F-6 字段', restateBody.facts.every((f) => Object.keys(f).every((k) => F6.has(k))));
    check('HTTP restate：无 key/fact_ref/scope', restateBody.facts.every((f) => !('key' in f) && !('fact_ref' in f) && !('scope' in f)));
    check('HTTP restate：signal 不进入 JSON', !restateHttp.options.body.includes('signal'));
    check('HTTP 请求全部指向本机回环', recording.calls.every((c) => c.url.startsWith(`http://127.0.0.1:${port}/`)));
    const proxyRestate = proxyTransport.calls.find((c) => c.stage === 'restate');
    check('代理 fake restate：仅收到 question + facts 且 unit 为短单位', proxyRestate
      && Object.keys(proxyRestate.request).join(',') === 'question,facts'
      && proxyRestate.request.facts.every((f) => ['%', 'pp', '元'].includes(f.unit))
      && proxyRestate.request.facts.every((f) => !('key' in f) && !('fact_ref' in f) && !('scope' in f)));
  });
}

/* ==== 默认禁用 503：错误不含服务端正文/问题 ==== */
{
  await withServer({ transport: null, config: { allowedOrigins: ['http://127.0.0.1:5180'] } }, async ({ port }) => {
    const httpTransport = createHttpTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchImpl: nodeFetch,
    });
    const boundary = createOnlineBoundary({ transport: httpTransport, timeoutMs: 3000 });
    const result = await boundary.classifyIntent({ question: QUESTION });
    check('默认禁用：onlineBoundary 返回 E_HTTP_STATUS', result.ok === false && result.code === HTTP_TRANSPORT_CODES.STATUS, JSON.stringify(result));
    let clientError = null;
    try {
      await httpTransport.intent({ question: QUESTION });
    } catch (error) {
      clientError = error;
    }
    check('默认禁用：客户端错误不包含服务端正文/问题', clientError
      && clientError.code === HTTP_TRANSPORT_CODES.STATUS
      && !clientError.message.includes('模型 transport')
      && !clientError.message.includes(QUESTION), clientError && clientError.message);
  });
}

/* ==== 非法响应 ==== */
{
  const base = 'http://127.0.0.1:5181';
  const invalidJson = createHttpTransport({
    baseUrl: base,
    fetchImpl: async () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let e1 = null;
  try { await invalidJson.intent({ question: QUESTION }); } catch (error) { e1 = error; }
  check('客户端非法 JSON：E_HTTP_JSON 且不回显正文', e1 && e1.code === HTTP_TRANSPORT_CODES.JSON
    && !e1.message.includes('not-json'), e1 && e1.message);

  const invalidShape = createHttpTransport({
    baseUrl: base,
    fetchImpl: async () => new Response(JSON.stringify({ foo: 'bar' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let e2 = null;
  try { await invalidShape.restate({ question: QUESTION, facts: FACTS }); } catch (error) { e2 = error; }
  check('客户端非法响应形状：E_HTTP_RESPONSE', e2 && e2.code === HTTP_TRANSPORT_CODES.RESPONSE, e2 && e2.message);

  const statusError = createHttpTransport({
    baseUrl: base,
    fetchImpl: async () => new Response('server-secret-body', { status: 503 }),
  });
  let e3 = null;
  try { await statusError.intent({ question: QUESTION }); } catch (error) { e3 = error; }
  check('客户端非成功状态：E_HTTP_STATUS 且不读取服务端正文', e3 && e3.code === HTTP_TRANSPORT_CODES.STATUS
    && !e3.message.includes('server-secret-body'), e3 && e3.message);
}

/* ==== 取消请求 ==== */
{
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:5181', fetchImpl });
  const controller = new AbortController();
  const pending = transport.intent({ question: QUESTION, signal: controller.signal });
  controller.abort();
  let error = null;
  try { await pending; } catch (e) { error = e; }
  check('取消请求：E_HTTP_ABORTED 且不回显问题', error && error.code === HTTP_TRANSPORT_CODES.ABORTED
    && !error.message.includes(QUESTION), error && error.message);
}

/* ==== HTTP 链路中的冻结快照隔离 ==== */
{
  const mutatingTransport = createFakeTransport({
    restate: (request) => {
      request.facts[0].display = '+99.9%';
      request.facts[0].value = 0.999;
      return { rawText: JSON.stringify({ answer_text: '组合实际收益 +99.9%。' }) };
    },
  });
  await withServer({ transport: mutatingTransport, config: { allowedOrigins: ['http://127.0.0.1:5180'] } }, async ({ port }) => {
    const httpTransport = createHttpTransport({ baseUrl: `http://127.0.0.1:${port}`, fetchImpl: nodeFetch });
    const boundary = createOnlineBoundary({ transport: httpTransport, timeoutMs: 3000 });
    const result = await boundary.restate({ question: QUESTION, facts: FACTS });
    check('HTTP 快照隔离：服务端改写事实不能影响本地数字检查', result.ok === false
      && result.code === ONLINE_BOUNDARY_CODES.NUMBERS_FAILED
      && result.data && !('draft' in result.data)
      && result.data.number_check.failed_count === 1, JSON.stringify(result));
    check('HTTP 快照隔离：不回显 99.9 草稿', !JSON.stringify(result).includes('99.9'));
  });
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
