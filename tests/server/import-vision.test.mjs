#!/usr/bin/env node
/**
 * 视觉识别服务端测试（fake transport；不联网、不调用真实模型）。
 * 覆盖图片列表/大小/MIME/请求体限制、flow_id/request_id 透传、响应结构校验、
 * Qwen3-VL 多模态请求形状（多图、Base64、无文件名）。
 * 运行：node tests/server/import-vision.test.mjs
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  IMPORT_VISION_CODES,
  IMPORT_VISION_STAGE,
  normalizeImportVisionRequest,
  validateImportVisionResponse,
} from '../../server/site-functions/importVision.mjs';
import {
  DASHSCOPE_MULTIMODAL_ENDPOINT,
  DASHSCOPE_VISION_MODEL,
  createDashScopeTransport,
} from '../../server/site-functions/dashscope.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const IMAGE = { mime: 'image/jpeg', data_base64: 'AAAA' };
const VALID = JSON.stringify({
  trades: [{
    date: '2024-09-24', symbol: '600519', side: '买入', price: '100.00', quantity: '100',
    fee: null, tax: null, confidence: 0.9, issues: [],
  }],
  unresolved: [],
});

function fakeTransport(response = VALID) {
  const calls = [];
  return {
    calls,
    async vision(request) {
      calls.push(request);
      return { rawText: typeof response === 'function' ? response(request) : response };
    },
  };
}

async function invoke(handler, body, { method = 'POST' } = {}) {
  const response = await handler(new Request('https://timingmirror.example/functions/v1/app/api/llm/import-vision', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, text, json };
}

/* —— 请求校验 —— */
{
  const ok = normalizeImportVisionRequest({
    images: [IMAGE, { mime: 'image/png', data_base64: 'BBBB' }],
    stage: IMPORT_VISION_STAGE,
    source_kind: 'pdf_scan',
    flow_id: 'import-flow-x-001',
    request_id: 'import-req-x-1',
  });
  check('请求：多图通过，flow_id/request_id 透传且不进入图像字段', ok.ok === true
    && ok.request.images.length === 2 && ok.request.flow_id === 'import-flow-x-001'
    && ok.request.request_id === 'import-req-x-1'
    && Object.keys(ok.request.images[0]).sort().join(',') === 'data_base64,mime', JSON.stringify(ok));
  const tooMany = normalizeImportVisionRequest({
    images: Array.from({ length: 9 }, () => IMAGE), stage: IMPORT_VISION_STAGE, source_kind: 'image',
  });
  check('请求：超过 8 张拒绝', tooMany.ok === false && tooMany.code === IMPORT_VISION_CODES.REQUEST_INVALID);
  const badMime = normalizeImportVisionRequest({ images: [{ mime: 'image/webp', data_base64: 'AAAA' }], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('请求：只接受 JPEG/PNG', badMime.ok === false && badMime.code === IMPORT_VISION_CODES.REQUEST_INVALID);
  const extra = normalizeImportVisionRequest({ images: [{ ...IMAGE, file_name: 'scan.pdf' }], stage: IMPORT_VISION_STAGE, source_kind: 'pdf_scan' });
  check('请求：文件名/URL 等额外字段拒绝', extra.ok === false && extra.code === IMPORT_VISION_CODES.REQUEST_INVALID);
  const badId = normalizeImportVisionRequest({ images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image', flow_id: '<script>' });
  check('请求：flow_id 格式校验', badId.ok === false && badId.code === IMPORT_VISION_CODES.REQUEST_INVALID);
}

/* —— 响应校验复用统一草稿 schema —— */
{
  const ok = validateImportVisionResponse(VALID);
  check('响应：统一 {trades,unresolved} schema', ok.ok === true && ok.value.trades.length === 1);
  const bad = validateImportVisionResponse(JSON.stringify({ trades: 'x', unresolved: [] }));
  check('响应：结构错误拒绝', bad.ok === false && bad.code === 'E_IMPORT_RECOVER_RESPONSE_INVALID');
}

/* —— Handler 路由与图片请求体上限 —— */
{
  const transport = fakeTransport();
  const handler = createHandler({ transport, maxBodyBytes: 64, maxVisionBodyBytes: 200000 });
  const ok = await invoke(handler, {
    images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image',
    flow_id: 'flow-1', request_id: 'req-1',
  });
  check('Handler：合法视觉请求 200 且返回归一化 rawText', ok.status === 200
    && ok.json && JSON.parse(ok.json.rawText).trades.length === 1, ok.text);
  check('Handler：transport 收到图片/来源/审计 ID，不含文件名', transport.calls.length === 1
    && Object.keys(transport.calls[0]).sort().join(',') === 'flow_id,images,request_id,source_kind,stage'
    && transport.calls[0].flow_id === 'flow-1' && transport.calls[0].request_id === 'req-1'
    && !JSON.stringify(transport.calls[0]).includes('file_name'), JSON.stringify(transport.calls[0]));

  const largeImage = 'A'.repeat(70000);
  const large = await invoke(handler, { images: [{ mime: 'image/jpeg', data_base64: largeImage }], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('Handler：视觉路由允许超过文字 64KB 的图片请求体', large.status === 200, large.text);

  const tooLarge = await invoke(handler, { images: [{ mime: 'image/jpeg', data_base64: 'A'.repeat(210000) }], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('Handler：超过视觉请求体上限 413', tooLarge.status === 413
    && tooLarge.json.code === SITE_FUNCTION_CODES.BODY_TOO_LARGE, tooLarge.text);

  const bad = createHandler({ transport: fakeTransport('not-json') });
  const invalid = await invoke(bad, { images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('Handler：上游非法响应 502', invalid.status === 502
    && invalid.json.code === SITE_FUNCTION_CODES.IMPORT_VISION_RESPONSE, invalid.text);

  const missing = createHandler({ transport: {} });
  const unavailable = await invoke(missing, { images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('Handler：transport 无 vision → 503', unavailable.status === 503
    && unavailable.json.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED, unavailable.text);

  const get = await invoke(handler, null, { method: 'GET' });
  check('Handler：GET 405', get.status === 405 && get.json.code === SITE_FUNCTION_CODES.METHOD);
}

/* —— Qwen3-VL 多模态请求形状 —— */
{
  const calls = [];
  const transport = createDashScopeTransport({
    apiKey: 'test-key-not-real',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ output: { choices: [{ message: { content: [{ text: `\`\`\`json\n${VALID}\n\`\`\`` }] } }] } }) };
    },
  });
  const result = await transport.vision({
    images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }, { mime: 'image/png', data_base64: 'BBBB' }],
    source_kind: 'pdf_scan',
  });
  const body = calls[0].body;
  check('DashScope vision：多模态端点/qwen3-vl/多图 Base64', calls[0].url === DASHSCOPE_MULTIMODAL_ENDPOINT
    && body.model === DASHSCOPE_VISION_MODEL
    && body.input.messages[1].content.filter((part) => part.image).length === 2
    && body.input.messages[1].content[0].image === 'data:image/jpeg;base64,AAAA'
    && body.input.messages[1].content[1].image === 'data:image/png;base64,BBBB', JSON.stringify(body).slice(0, 400));
  check('DashScope vision：不含文件名，代码块被剥离为 JSON', result.rawText === VALID
    && !JSON.stringify(body).includes('file_name') && !JSON.stringify(body).includes('scan.pdf'));
  check('DashScope vision：系统提示明确忽略余额/合计且不猜默认值', body.input.messages[0].content.includes('余额')
    && body.input.messages[0].content.includes('合计') && body.input.messages[0].content.includes('不猜测'));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
