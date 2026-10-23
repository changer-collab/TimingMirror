#!/usr/bin/env node
/**
 * qa-narrative 站点阶段 —— 离线单测（fake transport；不联网、不调用真实模型）
 *
 * 覆盖：请求白名单与数组上限、允许值必须来自已展示事实；
 *       响应 40–320 字、单段、数字/日期/代码/计数校验、建议与 Markdown 拒绝；
 *       handler 200/400/502/503，失败不回传候选文本。
 * 运行：node tests/server/qa-narrative.test.mjs（或 npm run check）
 */
import { createHandler, SITE_FUNCTION_CODES } from '../../server/site-functions/handler.mjs';
import {
  QA_NARRATIVE_CODES,
  normalizeQaNarrativeRequest,
  validateQaNarrativeResponse,
} from '../../server/site-functions/qaNarrative.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const VALID_TEXT = '这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及对其他交易的判断。';
const VALID_RAW = JSON.stringify({ answer_text: VALID_TEXT });

function requestBody(overrides = {}) {
  return {
    question: '我最错的一笔是哪个？',
    intent: 'worst_trade',
    facts: [
      { label: '差额', value: '¥1,200.00' },
      { label: '成交', value: '2024-09-27 · 卖出 000000 × 100 股' },
    ],
    evidence: [{ label: '公式', detail: '¥1,300.00 − ¥100.00 = ¥1,200.00' }],
    allowed: {
      numbers: ['1200.00', '1300.00', '100.00', '100'],
      counts: ['100股'],
      dates: ['2024-09-27'],
      symbols: ['000000'],
      displays: ['¥1,200.00', '¥1,300.00', '¥100.00'],
    },
    ...overrides,
  };
}

async function invoke(handler, path, body) {
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 由断言处理 */ }
  return { status: response.status, text, json };
}

/* ==== ① 请求校验 ==== */
{
  const normalized = normalizeQaNarrativeRequest(requestBody());
  check('请求：合法请求通过并归一化', normalized.ok === true
    && Object.keys(normalized.request).join(',') === 'question,intent,facts,evidence,allowed'
    && normalized.request.allowed.numbers.includes('1200.00'), JSON.stringify(normalized));

  check('请求：额外字段拒绝', normalizeQaNarrativeRequest(requestBody({ extra: 1 })).ok === false);
  check('请求：意图不在范围拒绝', normalizeQaNarrativeRequest(requestBody({ intent: 'loss_overview' })).ok === false);
  check('请求：facts 为空拒绝', normalizeQaNarrativeRequest(requestBody({ facts: [] })).ok === false);
  const tooManyFacts = Array.from({ length: 13 }, () => ({ label: '差额', value: '¥1,200.00' }));
  check('请求：facts 超上限拒绝', normalizeQaNarrativeRequest(requestBody({ facts: tooManyFacts })).ok === false);
  const badFactKey = [{ label: '差额', value: '¥1,200.00', extra: true }];
  check('请求：facts 项额外字段拒绝', normalizeQaNarrativeRequest(requestBody({ facts: badFactKey })).ok === false);

  const tooManyNumbers = { ...requestBody().allowed, numbers: Array.from({ length: 41 }, () => '1200.00') };
  check('请求：allowed 数组超上限拒绝', normalizeQaNarrativeRequest(requestBody({ allowed: tooManyNumbers })).ok === false);
  const badDate = { ...requestBody().allowed, dates: ['2024/09/27'] };
  check('请求：日期格式非法拒绝', normalizeQaNarrativeRequest(requestBody({ allowed: badDate })).ok === false);
  const badSymbol = { ...requestBody().allowed, symbols: ['00000'] };
  check('请求：代码格式非法拒绝', normalizeQaNarrativeRequest(requestBody({ allowed: badSymbol })).ok === false);
  const unsourced = { ...requestBody().allowed, numbers: ['9999.00'] };
  check('请求：允许值必须来自已展示事实', normalizeQaNarrativeRequest(requestBody({ allowed: unsourced })).ok === false);
  const unsourcedDisplay = { ...requestBody().allowed, displays: ['¥9,999.00'] };
  check('请求：展示值必须来自已展示事实', normalizeQaNarrativeRequest(requestBody({ allowed: unsourcedDisplay })).ok === false);
}

/* ==== ② 响应校验 ==== */
{
  const request = normalizeQaNarrativeRequest(requestBody()).request;
  const valid = validateQaNarrativeResponse(VALID_RAW, request);
  check('响应：合法文本通过并给出校验计数', valid.ok === true
    && valid.answer_text === VALID_TEXT && valid.checked === [...VALID_TEXT].length, JSON.stringify(valid));

  const withDate = JSON.stringify({
    answer_text: '在 2024-09-27 卖出 000000 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果。',
  });
  check('响应：已提供日期与代码通过', validateQaNarrativeResponse(withDate, request).ok === true);

  const cases = [
    ['额外字段', JSON.stringify({ answer_text: VALID_TEXT, extra: 1 })],
    ['非 JSON', 'not-json'],
    ['过短', JSON.stringify({ answer_text: '差额是 ¥1,200.00。' })],
    ['含换行', JSON.stringify({ answer_text: `${VALID_TEXT}\n第二段` })],
    ['Markdown', JSON.stringify({ answer_text: `# ${VALID_TEXT}` })],
    ['新金额', JSON.stringify({ answer_text: '这笔交易的差额是 ¥9,999.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及其他交易。' })],
    ['新日期', JSON.stringify({ answer_text: '在 2024-09-28 卖出 000000 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果。' })],
    ['新代码', JSON.stringify({ answer_text: '600519 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及其他交易。' })],
    ['新计数', JSON.stringify({ answer_text: '这笔交易的差额是 ¥1,200.00，共有 7 个同类交易；它只说明这次操作的结果，不涉及对其他交易的判断。' })],
    ['中文计数', JSON.stringify({ answer_text: '这笔交易共一笔，差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及其他交易。' })],
    ['买卖建议', JSON.stringify({ answer_text: '建议卖出这只股票，这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；只说明这次操作的结果。' })],
    ['预测措辞', JSON.stringify({ answer_text: '预计后市会涨，这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；只说明这次操作的结果。' })],
  ];
  for (const [name, raw] of cases) {
    check(`响应：${name}拒绝`, validateQaNarrativeResponse(raw, request).ok === false);
  }
}

/* ==== ③ handler 路由与错误码 ==== */
{
  const calls = [];
  const transport = {
    async qaNarrative(request) {
      calls.push(request);
      return { rawText: VALID_RAW };
    },
  };
  const handler = createHandler({ transport });
  const ok = await invoke(handler, '/api/llm/qa-narrative', requestBody());
  const wrapped = ok.json?.rawText ? JSON.parse(ok.json.rawText) : null;
  check('handler：200 且仅返回 answer_text', ok.status === 200
    && Object.keys(ok.json).join(',') === 'rawText'
    && wrapped && Object.keys(wrapped).join(',') === 'answer_text'
    && wrapped.answer_text === VALID_TEXT, ok.text);
  check('handler：transport 只收到五个字段', calls.length === 1
    && Object.keys(calls[0]).join(',') === 'question,intent,facts,evidence,allowed'
    && !JSON.stringify(calls[0]).includes('这笔交易的差额是'), JSON.stringify(calls[0]));

  const badCalls = [];
  const badHandler = createHandler({
    transport: {
      async qaNarrative() { badCalls.push(1); return { rawText: VALID_RAW }; },
    },
  });
  const extra = await invoke(badHandler, '/api/llm/qa-narrative', requestBody({ extra: 1 }));
  check('handler：非法请求 400 且不调用模型', extra.status === 400
    && extra.json?.code === SITE_FUNCTION_CODES.QA_NARRATIVE_REQUEST_INVALID
    && badCalls.length === 0, extra.text);

  const unsourced = await invoke(badHandler, '/api/llm/qa-narrative', requestBody({
    allowed: { ...requestBody().allowed, numbers: ['9999.00'] },
  }));
  check('handler：允许值不在事实中 400 且不调用模型', unsourced.status === 400
    && unsourced.json?.code === SITE_FUNCTION_CODES.QA_NARRATIVE_REQUEST_INVALID
    && badCalls.length === 0, unsourced.text);

  const leaking = await invoke(createHandler({
    transport: {
      async qaNarrative() {
        return { rawText: JSON.stringify({ answer_text: '候选文本：这笔交易的差额是 ¥9,999.00，来自卖出前后的价差对照；它只说明这次操作的结果。' }) };
      },
    },
  }), '/api/llm/qa-narrative', requestBody());
  check('handler：响应校验失败 502 且不泄露候选文本', leaking.status === 502
    && leaking.json?.code === SITE_FUNCTION_CODES.QA_NARRATIVE_RESPONSE
    && !leaking.text.includes('9,999.00')
    && !leaking.text.includes('候选文本'), leaking.text);

  const noMethod = await invoke(createHandler({ transport: { intent: async () => ({ rawText: '{}' }) } }),
    '/api/llm/qa-narrative', requestBody());
  check('handler：transport 缺方法 → 502', noMethod.status === 502
    && noMethod.json?.code === SITE_FUNCTION_CODES.MODEL_UNAVAILABLE, noMethod.text);

  const noKey = await invoke(createHandler({ transport: null }), '/api/llm/qa-narrative', requestBody());
  check('handler：未配置模型 → 503', noKey.status === 503
    && noKey.json?.code === SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED, noKey.text);

  check('错误码常量稳定', QA_NARRATIVE_CODES.REQUEST_INVALID === 'E_QA_NARRATIVE_REQUEST_INVALID'
    && QA_NARRATIVE_CODES.RESPONSE === 'E_QA_NARRATIVE_RESPONSE_INVALID');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
