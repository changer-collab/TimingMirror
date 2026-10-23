#!/usr/bin/env node
/**
 * 本地开发 fake 模型经真实 import-recover handler 的测试。
 * 不启动真实模型；scripts/serve.mjs 使用同一 handler 与 fake。
 * 运行：node tests/server/local-dev-import.test.mjs
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import { createLocalFakeImportModel } from '../../scripts/local-fake-import-model.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BASE = 'https://timingmirror.example/functions/v1/app/api/llm/import-recover';
const VISION_BASE = 'https://timingmirror.example/functions/v1/app/api/llm/import-vision';
const INTENT_BASE = 'https://timingmirror.example/functions/v1/app/api/llm/intent';
const VALID_CONTENT = '日期,标的,方向,价格,数量\n2024-09-24,600519,买入,100.00,100';

async function invoke(handler, { content = VALID_CONTENT, stage = 'bill_extract', source_kind = 'csv', method = 'POST' } = {}) {
  const response = await handler(new Request(BASE, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify({ content, stage, source_kind }) : undefined,
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, text, json };
}

async function invokeIntent(handler, question) {
  const response = await handler(new Request(INTENT_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, text, json };
}

async function invokeVision(handler, { images = [{ mime: 'image/jpeg', data_base64: 'AAAA' }], source_kind = 'pdf_scan' } = {}) {
  const response = await handler(new Request(VISION_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images, stage: 'bill_extract_vision', source_kind, flow_id: 'flow-local-1', request_id: 'req-local-1' }),
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: response.status, text, json };
}

{
  const handler = createHandler({ transport: createLocalFakeImportModel() });
  const ok = await invoke(handler);
  const raw = ok.json && typeof ok.json.rawText === 'string' ? JSON.parse(ok.json.rawText) : null;
  check('dev-fake：正常内容经 handler 返回 200 和结构化草案', ok.status === 200
    && raw?.trades?.length === 2 && raw.trades[0].symbol === '600519', ok.text);

  const invalid = await invoke(handler, { content: `${VALID_CONTENT}\n[FAKE_INVALID_RESPONSE]` });
  check('dev-fake：非法上游响应由服务端结构校验拦截为 502', invalid.status === 502
    && invalid.json.code === SITE_FUNCTION_CODES.IMPORT_RECOVER_RESPONSE, invalid.text);

  const upstream = await invoke(handler, { content: `${VALID_CONTENT}\n[FAKE_UPSTREAM_ERROR]` });
  check('dev-fake：上游异常脱敏为 502 E_MODEL_UNAVAILABLE', upstream.status === 502
    && upstream.json.code === SITE_FUNCTION_CODES.MODEL_UNAVAILABLE, upstream.text);

  const unresolved = await invoke(handler, { content: `${VALID_CONTENT}\n[FAKE_UNRESOLVED]` });
  const unresolvedRaw = unresolved.json && typeof unresolved.json.rawText === 'string' ? JSON.parse(unresolved.json.rawText) : null;
  check('dev-fake：可返回待确认说明（200）', unresolved.status === 200
    && unresolvedRaw?.trades?.length === 0 && unresolvedRaw.unresolved.length === 1, unresolved.text);

  const badRequest = await invoke(handler, { content: VALID_CONTENT, source_kind: 'image' });
  check('dev-fake：文字路由不接受图片类型', badRequest.status === 400
    && badRequest.json.code === SITE_FUNCTION_CODES.IMPORT_RECOVER_REQUEST_INVALID, badRequest.text);

  const vision = await invokeVision(handler, {
    images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }, { mime: 'image/jpeg', data_base64: 'BBBB' }],
    source_kind: 'pdf_scan',
  });
  const visionRaw = vision.json && typeof vision.json.rawText === 'string' ? JSON.parse(vision.json.rawText) : null;
  check('dev-fake：多图经视觉路由返回 200，按图片数生成草稿', vision.status === 200
    && visionRaw?.trades?.length === 2 && visionRaw.trades[0].symbol === '600519', vision.text);

  const get = await invoke(handler, { method: 'GET' });
  check('dev-fake：GET 405', get.status === 405 && get.json.code === SITE_FUNCTION_CODES.METHOD, get.text);
}

/* ==== 本地意图 fake：走真实 handler 的 L2 与 schema 分支 ==== */
{
  const handler = createHandler({ transport: createLocalFakeImportModel() });
  const cases = [
    ['我的提醒最近触发过几次', 'contract_status'],
    ['给我加一条买入前的提醒规则', 'contract_setup'],
    ['如果那天我没有卖出 000001，会差多少', 'what_if'],
    ['大盘下周会往上还是往下', 'out_of_scope'],
  ];
  for (const [question, expected] of cases) {
    const result = await invokeIntent(handler, question);
    const raw = result.json && typeof result.json.rawText === 'string' ? JSON.parse(result.json.rawText) : null;
    check(`dev-fake intent：${question} → ${expected}`, result.status === 200
      && raw?.intent === expected && raw.confidence === 0.9, result.text);
  }
  const low = await invokeIntent(handler, '帮我看看这个账户 [FAKE_INTENT_LOW]');
  const lowRaw = low.json && typeof low.json.rawText === 'string' ? JSON.parse(low.json.rawText) : null;
  check('dev-fake intent：低置信度标记返回 0.2', low.status === 200 && lowRaw?.confidence === 0.2, low.text);

  const invalid = await invokeIntent(handler, '[FAKE_INTENT_INVALID]');
  check('dev-fake intent：非法回包由服务端 schema 拦截为 502', invalid.status === 502
    && invalid.json.code === SITE_FUNCTION_CODES.MODEL_RESPONSE, invalid.text);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
