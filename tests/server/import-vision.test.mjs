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
  ModelTransportError,
  createDashScopeTransport,
} from '../../server/site-functions/dashscope.mjs';
import {
  IMPORT_RECOVER_STAGE,
  validateImportRecoverResponse,
} from '../../server/site-functions/importRecover.mjs';

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

async function invokePath(handler, path, body, { method = 'POST' } = {}) {
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, text, json };
}

async function invoke(handler, body, options) {
  return invokePath(handler, '/api/llm/import-vision', body, options);
}

async function invokeRecover(handler, body) {
  return invokePath(handler, '/api/llm/import-recover', body);
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

/* —— 可选 column_mapping：旧响应兼容、固定字段/枚举、泄漏边界 —— */
{
  const base = JSON.parse(VALID);
  const mapping = [
    { source_label: '名称/代码', source_subfield: '代码', target_field: 'symbol', confidence: 'high' },
    { source_label: '标志/交收日期', source_subfield: '标志', target_field: 'direction', confidence: 'high' },
    { source_label: '标志/交收日期', source_subfield: '交收日期', target_field: 'settlement_date', confidence: 'high' },
    { source_label: '成交价/量', source_subfield: '成交价', target_field: 'price', confidence: 'high' },
    { source_label: '成交价/量', source_subfield: '量', target_field: 'quantity', confidence: 'high' },
    { source_label: '成交/清算额', source_subfield: null, target_field: 'settlement_amount', confidence: 'medium' },
  ];
  const withMapping = JSON.stringify({ ...base, column_mapping: mapping });
  const ok = validateImportVisionResponse(withMapping);
  check('映射：合法 column_mapping 通过且固定字段归一化', ok.ok === true
    && ok.value.column_mapping.length === mapping.length
    && Object.keys(ok.value.column_mapping[0]).sort().join(',') === 'confidence,source_label,source_subfield,target_field'
    && ok.value.column_mapping[5].source_subfield === null, JSON.stringify(ok.value?.column_mapping));

  const missing = validateImportVisionResponse(VALID);
  check('映射：缺少 column_mapping 的旧响应仍然通过', missing.ok === true
    && !('column_mapping' in missing.value), JSON.stringify(missing.value));

  const textWithMapping = validateImportRecoverResponse(withMapping);
  check('映射：文字通道仍拒绝 column_mapping（不放宽旧契约）', textWithMapping.ok === false
    && textWithMapping.diagnostics?.validation_reason === 'response_unexpected_key', JSON.stringify(textWithMapping));

  const invalid = (value) => validateImportVisionResponse(JSON.stringify({ ...base, column_mapping: value }));
  const extra = invalid([{ ...mapping[0], note: '原图截图' }]);
  check('映射：映射项额外字段拒绝', extra.ok === false
    && extra.diagnostics?.validation_reason === 'column_mapping_unexpected_key'
    && extra.diagnostics?.field === 'column_mapping[0]', JSON.stringify(extra.diagnostics));
  const unknownTarget = invalid([{ ...mapping[0], target_field: 'note' }]);
  check('映射：未知 target_field 拒绝', unknownTarget.ok === false
    && unknownTarget.diagnostics?.validation_reason === 'column_mapping_target_invalid', JSON.stringify(unknownTarget.diagnostics));
  const badConfidence = invalid([{ ...mapping[0], confidence: 'certain' }]);
  check('映射：非法 confidence 拒绝', badConfidence.ok === false
    && badConfidence.diagnostics?.validation_reason === 'column_mapping_confidence_invalid', JSON.stringify(badConfidence.diagnostics));
  const notArray = invalid('成交价');
  check('映射：非数组拒绝', notArray.ok === false
    && notArray.diagnostics?.validation_reason === 'column_mapping_not_array', JSON.stringify(notArray.diagnostics));

  const leakCases = [
    ['图片 Base64', { ...mapping[0], source_label: 'data:image/jpeg;base64,AAAA' }],
    ['CSV 行', { ...mapping[0], source_label: '日期,标的,方向' }],
    ['账户信息', { ...mapping[0], source_label: '资金账号 88888888' }],
    ['模型原文', { ...mapping[0], source_label: '{"trades":[]}' }],
    ['子字段泄漏', { ...mapping[0], source_subfield: '账户 123456' }],
  ];
  for (const [name, entry] of leakCases) {
    const out = invalid([entry]);
    check(`映射：${name} 不通过`, out.ok === false
      && /^column_mapping_(source_label|source_subfield)_invalid$/.test(out.diagnostics?.validation_reason ?? ''), JSON.stringify(out.diagnostics));
  }

  const rowString = validateImportVisionResponse(JSON.stringify({
    trades: [], unresolved: [{ row: '2', reason: '日期无法确定' }],
  }));
  check('映射：unresolved[].row 纯数字字符串归一化为数字', rowString.ok === true
    && rowString.value.unresolved[0].row === 2, JSON.stringify(rowString.value?.unresolved));
  const rowNull = validateImportVisionResponse(JSON.stringify({
    trades: [], unresolved: [{ row: null, reason: '日期无法确定' }],
  }));
  check('映射：unresolved[].row=null 仍合法', rowNull.ok === true);

  const handler = createHandler({ transport: fakeTransport(withMapping) });
  const passed = await invoke(handler, { images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  const passedBody = passed.json ? JSON.parse(passed.json.rawText) : null;
  check('映射：Handler 200 且原样保留 column_mapping', passed.status === 200
    && passedBody?.column_mapping?.length === mapping.length
    && passedBody.column_mapping[1].target_field === 'direction', passed.text);

  const leakingHandler = createHandler({
    transport: fakeTransport(JSON.stringify({
      ...base,
      column_mapping: [{ ...mapping[0], source_label: '资金账号 123456' }],
    })),
  });
  const leaking = await invoke(leakingHandler, { images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('映射：502 诊断不回传非法列名原文', leaking.status === 502
    && leaking.json?.validation_reason === 'column_mapping_source_label_invalid'
    && !leaking.text.includes('123456'), leaking.text);
}

/* —— 502 脱敏诊断：失败子类与边界 —— */
{
  const trade = JSON.parse(VALID).trades[0];
  const diagnose = (raw) => invoke(createHandler({ transport: fakeTransport(raw) }), {
    images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image',
  });
  const cases = [
    ['非法 JSON', 'not-json', 'invalid_json', 'json'],
    ['顶层不是对象', '[]', 'response_not_object', 'response'],
    ['缺少 trades', JSON.stringify({ unresolved: [] }), 'missing_trades', 'trades'],
    ['trades 类型错误', JSON.stringify({ trades: 'x', unresolved: [] }), 'trades_not_array', 'trades'],
    ['unresolved 类型错误', JSON.stringify({ trades: [], unresolved: 'x' }), 'unresolved_not_array', 'unresolved'],
    ['交易项不是对象', JSON.stringify({ trades: [1], unresolved: [] }), 'trade_not_object', 'trades[]'],
    ['交易项额外字段', JSON.stringify({ trades: [{ ...trade, total: 1 }], unresolved: [] }), 'trade_unexpected_key', 'trades[].keys'],
    ['交易字段类型错误', JSON.stringify({ trades: [{ ...trade, price: { secret: 'CANDIDATE-9999' } }], unresolved: [] }), 'trade_field_invalid', 'trades[].price'],
    ['交易置信度错误', JSON.stringify({ trades: [{ ...trade, confidence: 2 }], unresolved: [] }), 'trade_confidence_invalid', 'trades[].confidence'],
    ['交易 issues 错误', JSON.stringify({ trades: [{ ...trade, issues: 'x' }], unresolved: [] }), 'trade_issues_invalid', 'trades[].issues'],
    ['unresolved 项不是对象', JSON.stringify({ trades: [], unresolved: [1] }), 'unresolved_not_object', 'unresolved[]'],
    ['unresolved 额外字段', JSON.stringify({ trades: [], unresolved: [{ row: 1, reason: '待确认', extra: 1 }] }), 'unresolved_unexpected_key', 'unresolved[].keys'],
    ['unresolved 缺少说明', JSON.stringify({ trades: [], unresolved: [{ row: 1 }] }), 'unresolved_reason_invalid', 'unresolved[].reason'],
    ['空结果', JSON.stringify({ trades: [], unresolved: [] }), 'empty_result', 'result'],
    ['顶层额外字段', JSON.stringify({ trades: [trade], unresolved: [], reasoning: 'CANDIDATE-9999' }), 'response_unexpected_key', 'response.keys'],
  ];
  const outputs = {};
  for (const [name, raw, reason, field] of cases) {
    const out = await diagnose(raw);
    outputs[reason] = out;
    check(`诊断：${name} → 502 ${reason}`, out.status === 502
      && out.json?.code === SITE_FUNCTION_CODES.IMPORT_VISION_RESPONSE
      && out.json?.validation_reason === reason
      && out.json?.field === field
      && out.json?.response_type === 'string'
      && out.json?.raw_length === [...raw].length
      && !out.text.includes('CANDIDATE-9999')
      && !out.text.includes('not-json')
      && !out.text.includes('待确认'), JSON.stringify(out.json));
  }
  check('诊断：非法 JSON 不带 parsed_keys/计数', outputs.invalid_json.json
    && !('parsed_keys' in outputs.invalid_json.json)
    && !('trades_count' in outputs.invalid_json.json)
    && !('unresolved_count' in outputs.invalid_json.json), JSON.stringify(outputs.invalid_json.json));
  check('诊断：缺少 trades 只回传白名单键与 unresolved 计数', outputs.missing_trades.json?.parsed_keys?.join(',') === 'unresolved'
    && outputs.missing_trades.json?.unresolved_count === 0
    && !('trades_count' in (outputs.missing_trades.json ?? {})), JSON.stringify(outputs.missing_trades.json));
  check('诊断：额外顶层字段不回传字段名', outputs.response_unexpected_key.json?.parsed_keys?.join(',') === 'trades,unresolved'
    && !('reasoning' in (outputs.response_unexpected_key.json ?? {})), JSON.stringify(outputs.response_unexpected_key.json));
  check('诊断：交易/待确认计数仅整数', outputs.trade_unexpected_key.json?.trades_count === 1
    && outputs.trade_unexpected_key.json?.unresolved_count === 0
    && outputs.empty_result.json?.trades_count === 0
    && outputs.empty_result.json?.unresolved_count === 0,
  JSON.stringify([outputs.trade_unexpected_key.json, outputs.empty_result.json]));

  const validOut = await diagnose(VALID);
  check('诊断：合法响应仍 200 且不带校验诊断', validOut.status === 200
    && !('validation_reason' in (validOut.json ?? {}))
    && !('field' in (validOut.json ?? {})), validOut.text);

  const missingUnresolved = await diagnose(JSON.stringify({ trades: [trade] }));
  check('边界：缺少 unresolved 按现有契约归一化为空（本次不收紧）', missingUnresolved.status === 200, missingUnresolved.text);
  const sparseTrade = await diagnose(JSON.stringify({ trades: [{}], unresolved: [] }));
  check('边界：交易可空字段缺失归一化为 null（本次不收紧）', sparseTrade.status === 200, sparseTrade.text);

  const timeoutOut = await invoke(createHandler({
    transport: { async vision() { throw new ModelTransportError('E_MODEL_TIMEOUT', { timeout_ms: 20000, elapsed_ms: 20001, phase: 'response_headers' }); } },
  }), { images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('错误码：超时保持 504 E_MODEL_TIMEOUT，不混入校验诊断', timeoutOut.status === 504
    && timeoutOut.json?.code === SITE_FUNCTION_CODES.MODEL_TIMEOUT
    && !('validation_reason' in (timeoutOut.json ?? {})), timeoutOut.text);

  const transportOut = await invoke(createHandler({
    transport: { async vision() { throw new ModelTransportError('E_MODEL_RESPONSE_INVALID'); } },
  }), { images: [IMAGE], stage: IMPORT_VISION_STAGE, source_kind: 'image' });
  check('错误码：transport 解析失败保持 502 E_MODEL_RESPONSE_INVALID', transportOut.status === 502
    && transportOut.json?.code === SITE_FUNCTION_CODES.MODEL_RESPONSE
    && !('validation_reason' in (transportOut.json ?? {})), transportOut.text);

  const recoverOut = await invokeRecover(createHandler({
    transport: { async importRecover() { return { rawText: 'not-json' }; } },
  }), { content: '合成文本', stage: IMPORT_RECOVER_STAGE, source_kind: 'text' });
  check('诊断：仅 import-vision 放行，import-recover 不带校验诊断', recoverOut.status === 502
    && recoverOut.json?.code === SITE_FUNCTION_CODES.IMPORT_RECOVER_RESPONSE
    && !('validation_reason' in (recoverOut.json ?? {}))
    && !('field' in (recoverOut.json ?? {})), recoverOut.text);
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
  check('Handler：transport 无 vision → 502 模型不可用', unavailable.status === 502
    && unavailable.json.code === SITE_FUNCTION_CODES.MODEL_UNAVAILABLE, unavailable.text);

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
  const prompt = body.input.messages[0].content;
  check('DashScope vision：交割单提示覆盖日期/代码拆分/价格量拆分/金额/非交易记录',
    ['成交日期', '交收日期', '名称/代码', '成交价/量', '成交额', '清算额', '负金额', '证券转银行', '银证转账', 'unresolved']
      .every((keyword) => prompt.includes(keyword)), prompt);
  check('DashScope vision：提示词要求可选 column_mapping、交收日期标记且费用不伪装',
    ['column_mapping', 'settlement_date', 'settlement_amount', '绝不把成交额或清算额映射成 fee']
      .every((keyword) => prompt.includes(keyword)), prompt);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
