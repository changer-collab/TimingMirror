#!/usr/bin/env node
/**
 * DeepSeek transport 专项测试（fake fetch；不联网、不调用真实模型）。
 *
 * 覆盖 OpenAI 兼容文本/图片请求形状、JSON 输出、错误映射、
 * provider 选择、PDF 边界与现有 handler 校验。
 * 运行：node tests/server/deepseek.test.mjs
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  DEEPSEEK_CHAT_ENDPOINT,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_ERROR_CODES,
  createDeepSeekTransport,
} from '../../server/site-functions/deepseek.mjs';
import { createModelTransport } from '../../server/site-functions/provider.mjs';
import { ModelTransportError } from '../../server/site-functions/dashscope.mjs';
import {
  IMPORT_VISION_CODES,
  IMPORT_VISION_STAGE,
  normalizeImportVisionRequest,
} from '../../server/site-functions/importVision.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const QUESTION = '组合整体表现如何？';
const VALID_INTENT = JSON.stringify({ intent: 'loss_overview', slots: {}, confidence: 0.9 });
const VALID_CUSTOM = JSON.stringify({ verdict: 'triggered', reason: '合成测试命中', used_data: ['change_pct'] });

function reply(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function fakeFetch(handler) {
  const calls = [];
  return {
    calls,
    async fetchImpl(url, init) {
      const call = { url, init, body: JSON.parse(init.body) };
      calls.push(call);
      return handler(call, calls.length);
    },
  };
}

async function expectTransportError(promise, code) {
  try {
    await promise;
    return { ok: false, actual: null };
  } catch (error) {
    return { ok: error instanceof ModelTransportError && error.code === code, actual: error?.code ?? String(error) };
  }
}

async function invoke(handler, path, body) {
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 断言会处理 */ }
  return { status: response.status, text, json };
}

/* ==== 文本请求形状 ==== */
{
  const fake = fakeFetch(() => reply(200, { choices: [{ message: { content: VALID_INTENT } }] }));
  const transport = createDeepSeekTransport({
    apiKey: 'synthetic-deepseek-key',
    model: 'deepseek-flash',
    timeoutMs: 1000,
    fetchImpl: fake.fetchImpl,
  });
  const out = await transport.intent({ question: QUESTION });
  const call = fake.calls[0];
  check('文本：URL 为 DeepSeek chat/completions', call.url === DEEPSEEK_CHAT_ENDPOINT, call.url);
  check('文本：Authorization 使用 Bearer，Key 只进入请求头', call.init.headers.Authorization === 'Bearer synthetic-deepseek-key'
    && !call.init.body.includes('synthetic-deepseek-key'), call.init.body);
  check('文本：model 与 system/user messages 正确', call.body.model === 'deepseek-flash'
    && call.body.messages.length === 2
    && call.body.messages[0].role === 'system'
    && call.body.messages[1].role === 'user'
    && call.body.messages[1].content === QUESTION, JSON.stringify(call.body).slice(0, 400));
  check('文本：response_format=json_object 且读取 content', call.body.response_format?.type === 'json_object'
    && out.rawText === VALID_INTENT, JSON.stringify({ body: call.body, out }).slice(0, 400));
}

/* ==== 代码块/内容提取 ==== */
{
  const fake = fakeFetch(() => reply(200, { choices: [{ message: { content: `\`\`\`json\n${VALID_INTENT}\n\`\`\`` } }] }));
  const transport = createDeepSeekTransport({ apiKey: 'test-key', fetchImpl: fake.fetchImpl });
  const out = await transport.intent({ question: QUESTION });
  check('文本：JSON 代码块被剥离为 rawText', out.rawText === VALID_INTENT, out.rawText);
}

/* ==== 图片请求形状 ==== */
{
  const fake = fakeFetch(() => reply(200, { choices: [{ message: { content: '{"trades":[],"unresolved":[]}' } }] }));
  const transport = createDeepSeekTransport({ apiKey: 'test-key', model: 'deepseek-flash', fetchImpl: fake.fetchImpl });
  const out = await transport.vision({
    images: [
      { mime: 'image/jpeg', data_base64: 'AAAA' },
      { mime: 'image/png', data_base64: 'BBBB' },
    ],
    source_kind: 'pdf_scan',
  });
  const call = fake.calls[0];
  const system = call.body.messages[0];
  const user = call.body.messages[1];
  const imageBlocks = user.content.filter((part) => part.type === 'image_url');
  check('图片：仍走同一 Chat Completions 端点并读取 content', call.url === DEEPSEEK_CHAT_ENDPOINT
    && out.rawText === '{"trades":[],"unresolved":[]}', call.url);
  check('图片：user 消息包含 text + image_url，且图片只在 user 消息', system.role === 'system'
    && typeof system.content === 'string'
    && !JSON.stringify(system.content).includes('image_url')
    && user.role === 'user'
    && Array.isArray(user.content)
    && user.content[0].type === 'text'
    && imageBlocks.length === 2, JSON.stringify(call.body).slice(0, 500));
  check('图片：data URL、MIME 与 detail=auto 正确', imageBlocks[0].image_url.url === 'data:image/jpeg;base64,AAAA'
    && imageBlocks[1].image_url.url === 'data:image/png;base64,BBBB'
    && imageBlocks[0].image_url.detail === 'auto', JSON.stringify(imageBlocks));
  check('图片：请求不包含文件名或原始路径', !JSON.stringify(call.body).includes('file_name')
    && !JSON.stringify(call.body).includes('scan.pdf'), JSON.stringify(call.body).slice(0, 400));
  check('图片：response_format=json_object', call.body.response_format?.type === 'json_object');
}

/* ==== GIF / WebP 由浏览器先转 JPEG；transport 本身仍接受 image/* ==== */
{
  const fake = fakeFetch(() => reply(200, { choices: [{ message: { content: '{"trades":[],"unresolved":[]}' } }] }));
  const transport = createDeepSeekTransport({ apiKey: 'test-key', fetchImpl: fake.fetchImpl });
  await transport.vision({
    images: [
      { mime: 'image/gif', data_base64: 'R0lGOD' },
      { mime: 'image/webp', data_base64: 'UklGR' },
    ],
  });
  const blocks = fake.calls[0].body.messages[1].content.filter((part) => part.type === 'image_url');
  check('图片：GIF/WebP 可构造 image_url（前端通常已转 JPEG）', blocks[0].image_url.url === 'data:image/gif;base64,R0lGOD'
    && blocks[1].image_url.url === 'data:image/webp;base64,UklGR', JSON.stringify(blocks));
}

/* ==== 图片 MIME 与 PDF 边界 ==== */
{
  const transport = createDeepSeekTransport({ apiKey: 'test-key', fetchImpl: async () => reply(200, {}) });
  let pdfError = null;
  try {
    await transport.vision({ images: [{ mime: 'application/pdf', data_base64: 'JVBERi0=' }] });
  } catch (error) {
    pdfError = error;
  }
  check('PDF：DeepSeek transport 拒绝非 image/* MIME', pdfError instanceof TypeError,
    pdfError?.name ?? 'no-error');
  const pdfRequest = normalizeImportVisionRequest({
    images: [{ mime: 'application/pdf', data_base64: 'JVBERi0=' }],
    stage: IMPORT_VISION_STAGE,
    source_kind: 'pdf_scan',
  });
  check('PDF：服务端请求模型拒绝原始 PDF，只接受已渲染图片',
    !pdfRequest.ok && pdfRequest.code === IMPORT_VISION_CODES.REQUEST_INVALID,
    JSON.stringify(pdfRequest));
}

/* ==== choices / message / content 缺失败 ==== */
{
  const cases = [
    ['缺少 choices', {}],
    ['choices 为空', { choices: [] }],
    ['缺少 message', { choices: [{}] }],
    ['content 为空', { choices: [{ message: { content: '' } }] }],
    ['content 非字符串', { choices: [{ message: { content: 42 } }] }],
    ['只有 reasoning_content', { choices: [{ message: { reasoning_content: '内部推理' } }] }],
  ];
  for (const [name, payload] of cases) {
    const transport = createDeepSeekTransport({
      apiKey: 'test-key',
      fetchImpl: async () => reply(200, payload),
    });
    const result = await expectTransportError(transport.intent({ question: QUESTION }), DEEPSEEK_ERROR_CODES.RESPONSE);
    check(`响应：${name} → E_MODEL_RESPONSE_INVALID`, result.ok, result.actual);
  }
}

/* ==== 401 / 403 / 429 / 5xx ==== */
{
  const cases = [
    [401, DEEPSEEK_ERROR_CODES.AUTH_FAILED],
    [403, DEEPSEEK_ERROR_CODES.FORBIDDEN],
    [429, DEEPSEEK_ERROR_CODES.RATE_LIMITED],
    [500, DEEPSEEK_ERROR_CODES.UNAVAILABLE],
    [503, DEEPSEEK_ERROR_CODES.UNAVAILABLE],
  ];
  for (const [status, code] of cases) {
    const transport = createDeepSeekTransport({
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: 'provider body must not leak' }) }),
    });
    const result = await expectTransportError(transport.intent({ question: QUESTION }), code);
    check(`上游 ${status} → ${code}`, result.ok, result.actual);
  }
}

/* ==== Handler 错误映射与业务校验 ==== */
{
  const cases = [
    [401, 502, SITE_FUNCTION_CODES.MODEL_AUTH_FAILED],
    [403, 502, SITE_FUNCTION_CODES.MODEL_FORBIDDEN],
    [429, 429, SITE_FUNCTION_CODES.MODEL_RATE_LIMITED],
    [500, 502, SITE_FUNCTION_CODES.MODEL_UNAVAILABLE],
  ];
  for (const [upstream, status, code] of cases) {
    const transport = createDeepSeekTransport({
      apiKey: 'test-key',
      fetchImpl: async () => ({ ok: false, status: upstream, json: async () => ({ error: 'must-not-leak' }) }),
    });
    const handler = createHandler({ transport });
    const out = await invoke(handler, '/api/llm/intent', { question: QUESTION });
    check(`Handler：上游 ${upstream} → ${status} ${code}`, out.status === status && out.json?.code === code, out.text);
  }

  const invalidJson = createDeepSeekTransport({
    apiKey: 'test-key',
    fetchImpl: async () => reply(200, { choices: [{ message: { content: 'not-json' } }] }),
  });
  const handler = createHandler({ transport: invalidJson });
  const bad = await invoke(handler, '/api/llm/custom-rule-judgment', {
    stage: 'custom_rule_judgment',
    flow_id: 'flow-ds-test',
    request_id: 'req-ds-test',
    judgment_id: 'judg-ds-test',
    rule: {
      schema: 'custom-v1', rule_id: 'rule-ds-test', hash: 'deadbeef', version: 1,
      text: '单日涨幅超过 3% 时不买入', action: 'buy', scope: { kind: 'symbol', symbol: '600519' },
    },
    scenario: {
      symbol: '600519', requested_date: '2025-12-31', action: 'buy',
      effective_date: null, change_pct: 4.2, market_label: '合成行情',
    },
    data: { buys: [], sells: [], trading_days: ['2025-12-31'] },
  });
  check('Handler：非法 JSON 仍由业务校验拒绝', bad.status === 502
    && bad.json?.code === SITE_FUNCTION_CODES.CUSTOM_RULE_JUDGMENT_RESPONSE, bad.text);

  const validTransport = createDeepSeekTransport({
    apiKey: 'test-key',
    fetchImpl: async () => reply(200, { choices: [{ message: { content: VALID_CUSTOM } }] }),
  });
  const validHandler = createHandler({ transport: validTransport });
  const good = await invoke(validHandler, '/api/llm/custom-rule-judgment', {
    stage: 'custom_rule_judgment',
    flow_id: 'flow-ds-good',
    request_id: 'req-ds-good',
    judgment_id: 'judg-ds-good',
    rule: {
      schema: 'custom-v1', rule_id: 'rule-ds-good', hash: 'deadbeef', version: 1,
      text: '单日涨幅超过 3% 时不买入', action: 'buy', scope: { kind: 'symbol', symbol: '600519' },
    },
    scenario: {
      symbol: '600519', requested_date: '2025-12-31', action: 'buy',
      effective_date: null, change_pct: 4.2, market_label: '合成行情',
    },
    data: { buys: [], sells: [], trading_days: ['2025-12-31'] },
  });
  const binding = good.json?.rawText ? JSON.parse(good.json.rawText).binding : null;
  check('Handler：DeepSeek 合法响应仍写入既有 binding', good.status === 200
    && binding?.flow_id === 'flow-ds-good' && binding?.judgment_id === 'judg-ds-good'
    && binding?.rule_hash === 'deadbeef' && binding?.scenario_symbol === '600519', good.text);
}

/* ==== Provider 选择：无 Key 不发请求、默认模型 ==== */
{
  let networkCalls = 0;
  const noKey = createModelTransport({
    deepseekApiKey: '',
    fetchImpl: async () => { networkCalls += 1; throw new Error('must not call'); },
  });
  check('Provider：无 DEEPSEEK_API_KEY 返回 null', noKey === null);
  const handler = createHandler({ transport: noKey });
  const out = await invoke(handler, '/api/llm/intent', { question: QUESTION });
  check('Provider：无 Key 返回 503 且不发起网络请求', out.status === 503
    && out.json?.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED && networkCalls === 0, out.text);

  const fake = fakeFetch(() => reply(200, { choices: [{ message: { content: VALID_INTENT } }] }));
  const defaulted = createModelTransport({
    deepseekApiKey: 'test-key',
    deepseekModel: '',
    fetchImpl: fake.fetchImpl,
  });
  await defaulted.intent({ question: QUESTION });
  check('Provider：DEEPSEEK_MODEL 缺省时使用 deepseek-flash', fake.calls[0].body.model === DEEPSEEK_DEFAULT_MODEL,
    fake.calls[0].body.model);

  const fakeCustom = fakeFetch(() => reply(200, { choices: [{ message: { content: VALID_INTENT } }] }));
  const custom = createModelTransport({
    deepseekApiKey: 'test-key',
    deepseekModel: 'custom-deepseek-model',
    fetchImpl: fakeCustom.fetchImpl,
  });
  await custom.intent({ question: QUESTION });
  check('Provider：DEEPSEEK_MODEL 可覆盖模型', fakeCustom.calls[0].body.model === 'custom-deepseek-model',
    fakeCustom.calls[0].body.model);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
