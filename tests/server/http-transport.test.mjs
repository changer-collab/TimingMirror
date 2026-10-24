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
  check('站点 transport：携带同源登录会话（credentials=same-origin）', calls[0].options.credentials === 'same-origin', calls[0].options.credentials);
  check('站点 transport：无 Authorization/API Key 头', !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('站点 transport：返回 rawText', result.rawText === '{"answer_text":"ok"}');
}

/* ==== 站点 ruleIntent：阶段请求形状 ==== */
{
  const calls = [];
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ rawText: '{"intent":"contract_setup"}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await siteTransport.ruleIntent({
    question: '当天涨幅超过 5% 的票我绝不买入。',
    stage: 'draft_rule',
    allowed_intents: ['contract_setup'],
    allowed_templates: [{ template_id: 'no_buy_on_surge', fields: { threshold_pct: { min: 0, integer: false } } }],
    allowed_tools: ['contract.parse'],
    context_summary: { object_type: 'rule' },
  });
  const body = JSON.parse(calls[0].options.body);
  check('站点 ruleIntent：固定同源路径', calls[0].url === SITE_FUNCTION_PATHS.ruleIntent
    && calls[0].url === '/functions/v1/app/api/llm/rule-intent');
  check('站点 ruleIntent：body 仅阶段字段', Object.keys(body).join(',') === 'question,stage,allowed_intents,allowed_templates,allowed_tools,context_summary');
  check('站点 ruleIntent：同源会话且无认证头', calls[0].options.credentials === 'same-origin'
    && !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('站点 ruleIntent：返回 rawText', result.rawText === '{"intent":"contract_setup"}');
}

/* ==== 站点 importRecover：只发送提取文字与来源类型 ==== */
{
  const calls = [];
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ rawText: '{"trades":[],"unresolved":[]}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await siteTransport.importRecover({
    content: '日期,标的\n2024-09-24,600519',
    stage: 'bill_extract',
    source_kind: 'csv',
    flow_id: 'import-flow-x-001',
    request_id: 'import-req-x-1',
  });
  const body = JSON.parse(calls[0].options.body);
  check('站点 importRecover：固定同源路径', calls[0].url === SITE_FUNCTION_PATHS.importRecover
    && calls[0].url === '/functions/v1/app/api/llm/import-recover');
  check('站点 importRecover：body 含文字/来源与 audit ID', Object.keys(body).sort().join(',') === 'content,flow_id,request_id,source_kind,stage'
    && body.flow_id === 'import-flow-x-001' && body.request_id === 'import-req-x-1');
  check('站点 importRecover：同源会话且无认证头', calls[0].options.credentials === 'same-origin'
    && !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('站点 importRecover：返回 rawText', result.rawText === '{"trades":[],"unresolved":[]}');
}

/* ==== 站点 importRecover：错误码透传（只进调试，不改主文案） ==== */
{
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'E_IMPORT_RECOVER_RESPONSE_INVALID',
      message: '账单识别响应未通过服务端校验',
    }), { status: 502, headers: { 'Content-Type': 'application/json' } }),
  });
  let caught = null;
  try {
    await siteTransport.importRecover({ content: 'x', stage: 'bill_extract', source_kind: 'text' });
  } catch (error) {
    caught = error;
  }
  check('站点 importRecover：非 2xx 保留状态码与服务端错误码', !!caught
    && caught.code === HTTP_TRANSPORT_CODES.STATUS
    && caught.status === 502
    && caught.upstreamCode === 'E_IMPORT_RECOVER_RESPONSE_INVALID', JSON.stringify({ code: caught?.code, status: caught?.status, upstreamCode: caught?.upstreamCode }));
}

/* ==== 站点 importVision：多图只发送 mime/Base64 与 audit ID ==== */
{
  const calls = [];
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ rawText: '{"trades":[],"unresolved":[]}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await siteTransport.importVision({
    images: [{ mime: 'image/jpeg', data_base64: 'AAAA', bytes: 3, width: 10 }],
    stage: 'bill_extract_vision',
    source_kind: 'pdf_scan',
    flow_id: 'import-flow-x-001',
    request_id: 'import-req-x-2',
  });
  const body = JSON.parse(calls[0].options.body);
  check('站点 importVision：固定同源路径', calls[0].url === SITE_FUNCTION_PATHS.importVision
    && calls[0].url === '/functions/v1/app/api/llm/import-vision');
  check('站点 importVision：只发送 mime/Base64，不带宽度/文件名', Object.keys(body).sort().join(',') === 'flow_id,images,request_id,source_kind,stage'
    && Object.keys(body.images[0]).sort().join(',') === 'data_base64,mime'
    && body.flow_id === 'import-flow-x-001' && body.request_id === 'import-req-x-2');
}

/* ==== 站点 profileSummary/profileFact：结构化 JSON 响应 ==== */
{
  const calls = [];
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const payload = url.endsWith('/profile-summary')
        ? { ok: true, source: 'template', source_hash: 'a'.repeat(64), summary: { schema_version: 1 }, fallback_reason: 'model_not_configured' }
        : { ok: true, facts: [{ kind: 'goal', key: 'holding_horizon', value: '希望减少短线交易', evidence: '我希望减少短线交易' }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const summary = await siteTransport.profileSummary({ digest: { profile_key: 'abcd1234' } });
  check('站点 profileSummary：固定同源路径 + 只发送 digest', calls[0].url === '/functions/v1/app/api/llm/profile-summary'
    && Object.keys(JSON.parse(calls[0].options.body)).join(',') === 'digest'
    && summary.source === 'template'
    && summary.source_hash === 'a'.repeat(64)
    && summary.fallback_reason === 'model_not_configured', JSON.stringify(summary));
  const facts = await siteTransport.profileFact({ message: '我希望减少短线交易' });
  check('站点 profileFact：固定同源路径 + 只发送 message', calls[1].url === '/functions/v1/app/api/llm/profile-fact'
    && Object.keys(JSON.parse(calls[1].options.body)).join(',') === 'message'
    && facts.facts?.length === 1
    && facts.facts[0].evidence === '我希望减少短线交易', JSON.stringify(facts));

  const rawOnly = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, facts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let rawError = null;
  try { await rawOnly.restate({ question: QUESTION, facts: FACTS }); } catch (error) { rawError = error; }
  check('站点 restate：结构化响应仍要求 rawText', rawError && rawError.code === HTTP_TRANSPORT_CODES.RESPONSE, rawError && rawError.message);

  const noPaths = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let configError = null;
  try { await noPaths.profileSummary({ digest: {} }); } catch (error) { configError = error; }
  check('profileSummary：未配置路径时 E_HTTP_CONFIG', configError && configError.code === HTTP_TRANSPORT_CODES.CONFIG, configError && configError.message);
}

/* ==== 站点 qaNarrative：固定路径与请求白名单 ==== */
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
  const body = {
    question: QUESTION,
    intent: 'worst_trade',
    facts: [{ label: '差额', value: '¥1,200.00' }],
    evidence: [],
    allowed: { numbers: ['1200.00'], counts: [], dates: [], symbols: [], displays: ['¥1,200.00'] },
  };
  const result = await siteTransport.qaNarrative(body);
  const sent = JSON.parse(calls[0].options.body);
  check('站点 qaNarrative：固定同源路径', calls[0].url === SITE_FUNCTION_PATHS.qaNarrative
    && calls[0].url === '/functions/v1/app/api/llm/qa-narrative', calls[0].url);
  check('站点 qaNarrative：只发送五个字段且无答案原文', Object.keys(sent).join(',') === 'question,intent,facts,evidence,allowed'
    && !('text' in sent) && !('answer' in sent), JSON.stringify(sent));
  check('站点 qaNarrative：同源会话 + 无 Key 头', calls[0].options.credentials === 'same-origin'
    && !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('站点 qaNarrative：返回 rawText', result.rawText === '{"answer_text":"ok"}', JSON.stringify(result));

  const noPath = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: { intent: '/i', restate: '/r' },
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let configError = null;
  try { await noPath.qaNarrative(body); } catch (error) { configError = error; }
  check('qaNarrative：未配置路径时 E_HTTP_CONFIG', configError && configError.code === HTTP_TRANSPORT_CODES.CONFIG, configError && configError.message);
}

/* ==== 站点 qaRewrite：固定路径与十字段白名单 ==== */
{
  const calls = [];
  const siteTransport = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ rawText: '{"headline":"最错的交易差额 -¥1,200.00","plain":[],"used_terms":[]}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const body = {
    question: QUESTION,
    intent: 'worst_trade',
    scope: { kind: 'bill', synthetic: false },
    draft: { headline: '最错的交易差额 -¥1,200.00', plain: [{ id: 'P1', text: '差额是 -¥1,200.00。' }] },
    claims: [{ id: 'Q1', text: '差额是 -¥1,200.00。', evidence_ids: [] }],
    facts: [{ label: '差额', value: '-¥1,200.00' }],
    evidence: [],
    allowed: { numbers: ['1200.00'], counts: [], dates: [], symbols: [], displays: ['-¥1,200.00'] },
    glossary: [],
    limits: { headline_max_chars: 45 },
  };
  const result = await siteTransport.qaRewrite(body);
  const sent = JSON.parse(calls[0].options.body);
  check('站点 qaRewrite：固定同源路径', calls[0].url === SITE_FUNCTION_PATHS.qaRewrite
    && calls[0].url === '/functions/v1/app/api/llm/qa-rewrite', calls[0].url);
  check('站点 qaRewrite：只发送十个字段且无答案原文', Object.keys(sent).join(',')
    === 'question,intent,scope,draft,claims,facts,evidence,allowed,glossary,limits'
    && !('text' in sent) && !('answer' in sent), JSON.stringify(sent));
  check('站点 qaRewrite：同源会话 + 无 Key 头', calls[0].options.credentials === 'same-origin'
    && !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('站点 qaRewrite：返回 rawText', result.rawText.startsWith('{"headline"'), JSON.stringify(result));

  const noPath = createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: { intent: '/i', restate: '/r' },
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let configError = null;
  try { await noPath.qaRewrite(body); } catch (error) { configError = error; }
  check('qaRewrite：未配置路径时 E_HTTP_CONFIG', configError && configError.code === HTTP_TRANSPORT_CODES.CONFIG, configError && configError.message);
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
    check('HTTP intent：本地代理不带凭证（credentials=omit）', intentHttp.options.credentials === 'omit', intentHttp.options.credentials);
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
    check('HTTP restate：本地代理不带凭证（credentials=omit）', restateHttp.options.credentials === 'omit', restateHttp.options.credentials);
    check('HTTP restate：无 Authorization/API Key 头', !Object.keys(restateHttp.options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
    check('本地代理 intent/restate：均不带凭证或认证头', [intentHttp, restateHttp].every((c) => c.options.credentials === 'omit'
      && !Object.keys(c.options.headers).some((h) => /authorization|api[-_]?key/i.test(h))));
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
