#!/usr/bin/env node
/**
 * 账单识别补救服务端测试（fake transport；不联网）。
 *
 * 覆盖：请求白名单/阶段/类型/长度、响应结构与类型校验、Handler 路由与错误码、
 *       DashScope 只接收提取文字（不含文件名/图片），以及未配置模型时的 503。
 * 运行：node tests/server/import-recover.test.mjs
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  IMPORT_RECOVER_CODES,
  IMPORT_RECOVER_STAGE,
  normalizeImportRecoverRequest,
  validateImportRecoverResponse,
} from '../../server/site-functions/importRecover.mjs';
import { DASHSCOPE_ENDPOINT, createDashScopeTransport } from '../../server/site-functions/dashscope.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const CONTENT = '日期,标的,方向,价格,数量\n2024-09-24,600519,买入,100.00,100';
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
    async importRecover(request) {
      calls.push(request);
      return { rawText: typeof response === 'function' ? response(request) : response };
    },
  };
}

async function invoke(handler, body, { method = 'POST' } = {}) {
  const response = await handler(new Request(
    'https://timingmirror.example/functions/v1/app/api/llm/import-recover',
    { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined },
  ));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, text, json };
}

/* —— 请求规范化 —— */
{
  const ok = normalizeImportRecoverRequest({
    content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'csv',
    flow_id: 'import-flow-x-001', request_id: 'import-req-x-1',
  });
  check('请求：合法文本通过且只保留文本/来源/审计 ID', ok.ok === true
    && Object.keys(ok.request).sort().join(',') === 'content,flow_id,request_id,source_kind,stage'
    && ok.request.source_kind === 'csv'
    && ok.request.flow_id === 'import-flow-x-001'
    && ok.request.request_id === 'import-req-x-1', JSON.stringify(ok));
  const extra = normalizeImportRecoverRequest({ content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'csv', file_name: 'a.csv' });
  check('请求：文件名/额外字段拒绝', extra.ok === false && extra.code === IMPORT_RECOVER_CODES.REQUEST_INVALID, JSON.stringify(extra));
  const badStage = normalizeImportRecoverRequest({ content: CONTENT, stage: 'other', source_kind: 'csv' });
  check('请求：阶段必须为 bill_extract', badStage.ok === false && badStage.code === IMPORT_RECOVER_CODES.REQUEST_INVALID);
  const badKind = normalizeImportRecoverRequest({ content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'image' });
  check('请求：图片不在文本识别通道', badKind.ok === false && badKind.code === IMPORT_RECOVER_CODES.REQUEST_INVALID);
  const tooLong = normalizeImportRecoverRequest({ content: 'x'.repeat(15001), stage: IMPORT_RECOVER_STAGE, source_kind: 'text' });
  check('请求：超长文本拒绝（不自动分批）', tooLong.ok === false && tooLong.code === IMPORT_RECOVER_CODES.REQUEST_INVALID);
}

/* —— 响应校验 —— */
{
  const ok = validateImportRecoverResponse(VALID);
  check('响应：合法交易通过，null 费用保持 null', ok.ok === true && ok.value.trades[0].fee === null
    && ok.value.trades[0].price === '100.00', JSON.stringify(ok));
  const unresolved = validateImportRecoverResponse(JSON.stringify({ trades: [], unresolved: [{ row: 2, reason: '日期无法确定' }] }));
  check('响应：只有待确认说明允许', unresolved.ok === true && unresolved.value.unresolved[0].reason.includes('日期'));
  const noResult = validateImportRecoverResponse(JSON.stringify({ trades: [], unresolved: [] }));
  check('响应：空结果拒绝', noResult.ok === false && noResult.code === IMPORT_RECOVER_CODES.RESPONSE);
  const extra = validateImportRecoverResponse(JSON.stringify({ trades: [{ ...JSON.parse(VALID).trades[0], total: 1 }], unresolved: [] }));
  check('响应：交易额外字段拒绝', extra.ok === false && extra.code === IMPORT_RECOVER_CODES.RESPONSE);
  const badConfidence = validateImportRecoverResponse(JSON.stringify({ trades: [{ ...JSON.parse(VALID).trades[0], confidence: 2 }], unresolved: [] }));
  check('响应：置信度越界拒绝', badConfidence.ok === false && badConfidence.code === IMPORT_RECOVER_CODES.RESPONSE);
  const badSide = validateImportRecoverResponse(JSON.stringify({ trades: [{ ...JSON.parse(VALID).trades[0], side: 'maybe' }], unresolved: [] }));
  check('响应：模糊方向不被猜测', badSide.ok === false && badSide.code === IMPORT_RECOVER_CODES.RESPONSE);
}

/* —— Handler 路由 —— */
{
  const transport = fakeTransport();
  const handler = createHandler({ transport });
  const response = await invoke(handler, {
    content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'csv',
    flow_id: 'import-flow-x-001', request_id: 'import-req-x-1',
  });
  check('Handler：合法请求 200 且返回归一化 rawText', response.status === 200
    && response.json && typeof response.json.rawText === 'string'
    && JSON.parse(response.json.rawText).trades[0].symbol === '600519', JSON.stringify(response));
  check('Handler：transport 收到文字/来源/审计 ID，不含文件名', transport.calls.length === 1
    && Object.keys(transport.calls[0]).sort().join(',') === 'content,flow_id,request_id,source_kind,stage'
    && transport.calls[0].flow_id === 'import-flow-x-001'
    && transport.calls[0].request_id === 'import-req-x-1'
    && !JSON.stringify(transport.calls[0]).includes('a.csv'), JSON.stringify(transport.calls[0]));

  const expanded = await invoke(handler, { content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'csv', file_name: 'a.csv' });
  check('Handler：额外字段 → 400 E_IMPORT_RECOVER_REQUEST_INVALID', expanded.status === 400
    && expanded.json.code === SITE_FUNCTION_CODES.IMPORT_RECOVER_REQUEST_INVALID, JSON.stringify(expanded));

  const bad = createHandler({ transport: fakeTransport('{"trades":"not-an-array"}') });
  const invalid = await invoke(bad, { content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'text' });
  check('Handler：上游非法响应 → 502 E_IMPORT_RECOVER_RESPONSE_INVALID', invalid.status === 502
    && invalid.json.code === SITE_FUNCTION_CODES.IMPORT_RECOVER_RESPONSE, JSON.stringify(invalid));

  const missing = createHandler({ transport: {} });
  const notConfigured = await invoke(missing, { content: CONTENT, stage: IMPORT_RECOVER_STAGE, source_kind: 'text' });
  check('Handler：transport 无 importRecover → 502 模型不可用', notConfigured.status === 502
    && notConfigured.json.code === SITE_FUNCTION_CODES.MODEL_UNAVAILABLE, JSON.stringify(notConfigured));

  const get = await invoke(handler, null, { method: 'GET' });
  check('Handler：GET 405', get.status === 405 && get.json.code === SITE_FUNCTION_CODES.METHOD);
}

/* —— DashScope 请求形状 —— */
{
  const calls = [];
  const transport = createDashScopeTransport({
    apiKey: 'test-key-not-real',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ output: { choices: [{ message: { content: VALID } }] } }) };
    },
  });
  const result = await transport.importRecover({ content: CONTENT, source_kind: 'csv' });
  const body = calls[0].body;
  check('DashScope：固定端点/模型/JSON/非思考', calls[0].url === DASHSCOPE_ENDPOINT
    && body.model === 'qwen-plus'
    && body.parameters.enable_thinking === false
    && body.parameters.response_format.type === 'json_object');
  check('DashScope：只发送提取文字与来源类型，不含文件名/图片', body.input.messages[1].content.includes('2024-09-24')
    && body.input.messages[1].content.includes('600519')
    && body.input.messages[1].content.includes('csv')
    && !body.input.messages[1].content.includes('fileName')
    && !body.input.messages[1].content.includes('base64')
    && result.rawText === VALID, JSON.stringify(body.input.messages[1].content.slice(0, 200)));
  check('DashScope：系统提示明确不把余额/合计当交易、不猜默认值', body.input.messages[0].content.includes('余额')
    && body.input.messages[0].content.includes('合计')
    && body.input.messages[0].content.includes('不猜测')
    && body.input.messages[0].content.includes('YYYY-MM-DD'));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
