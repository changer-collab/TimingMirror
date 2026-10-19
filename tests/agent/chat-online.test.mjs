#!/usr/bin/env node
/**
 * M1-C11 chatView 在线复述编排 · fake transport 定向测试（本地离线；零依赖）
 *
 * 覆盖：仅 loss_overview + portfolio 四事实；成功仅返回通过数字检查的复述；
 *       伪造数字 withheld 且不泄出候选文本；网络失败/组合未发布/输入非法兜底；
 *       出站请求仅 question + F-6 facts（四事实，不含 key/fact_ref/scope/review/provenance）。
 * 边界：不调用百炼、不发起网络请求、不读取凭证；通过不代表真实在线链路或 M0-C3/C4 完成。
 * 运行：node tests/agent/chat-online.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { createFakeTransport, jsonResponse } from './fake-online-transport.mjs';
import { TransportError, ONLINE_BOUNDARY_CODES, CONFIRMED_FACT_FIELDS } from '../../src/agent/onlineBoundary.js';
import { ANSWER_FACTS_CODES } from '../../src/agent/answerFacts.js';
import {
  createChatOnline,
  chatFailureText,
  numberCheckDetail,
  CHAT_ONLINE_CODES,
  CHAT_ONLINE_FALLBACK_TEXT,
} from '../../src/agent/chatOnline.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '组合整体表现如何？';
const ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';
const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  source: { file: 'mini.csv', line: 2 },
});
const FULL_TRADES = () => [
  mk('T001', '2024-09-24', '000000', 'buy', 10, 100),
  mk('T002', '2024-09-27', '000000', 'sell', 11, 100),
  mk('B101', '2024-09-25', '888888', 'buy', 100, 10),
  mk('B102', '2024-09-30', '888888', 'sell', 105, 10),
];
const buildFull = () => runReview({ trades: FULL_TRADES(), closes: { '000000': 12, '888888': 110 }, valuation: VAL });
const buildDegraded = () => runReview({ trades: FULL_TRADES(), closes: { '000000': 12 }, valuation: VAL });

/* ==== 成功：四事实 + 数字检查通过 ==== */
{
  const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: ANSWER }) });
  const chat = createChatOnline({ transport, timeoutMs: 3000 });
  const result = await chat.ask({ question: QUESTION, review: buildFull() });
  check('成功：返回复述且数字检查 4/4', result.ok === true && result.text === ANSWER
    && result.number_check.checked === 4 && result.number_check.matched_count === 4
    && result.number_check.failed_count === 0, JSON.stringify(result));
  check('成功：仅调用一次 restate、不调用 intent', transport.calls.length === 1 && transport.calls[0].stage === 'restate',
    JSON.stringify(transport.calls.map((c) => c.stage)));
  const request = transport.calls[0].request;
  check('出站：body 仅 question + facts', Object.keys(request).join(',') === 'question,facts' && request.question === QUESTION);
  check('出站：恰为组合四事实', request.facts.length === 4
    && request.facts.every((f) => Object.keys(f).every((k) => CONFIRMED_FACT_FIELDS.includes(k)))
    && request.facts.every((f) => !('key' in f) && !('fact_ref' in f) && !('scope' in f)), JSON.stringify(request.facts));
  check('出站：unit 为短单位且公式可映射', request.facts.map((f) => f.unit).sort().join(',') === '%,%,pp,元'.split(',').sort().join(',')
    && request.facts.every((f) => typeof f.formula_ref === 'string' && f.formula_ref.startsWith('CALC_')), JSON.stringify(request.facts));
  check('出站：不含 review/provenance/成交行/文件名', !JSON.stringify(request).includes('mini.csv')
    && !JSON.stringify(request).includes('T001') && !JSON.stringify(request).includes('provenance'));
}

/* ==== 失败：伪造数字 → withheld，不泄出候选 ==== */
{
  const forged = '组合实际收益 +99.9%，损耗金额 ¥999.00。';
  const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: forged }) });
  const chat = createChatOnline({ transport, timeoutMs: 3000 });
  const result = await chat.ask({ question: QUESTION, review: buildFull() });
  check('数字失败：返回 W_ANSWER_NUMBERS_FAILED 且无 text 字段', result.ok === false
    && result.code === ONLINE_BOUNDARY_CODES.NUMBERS_FAILED && !('text' in result), JSON.stringify(result));
  check('数字失败：只记录计数与错误码', result.number_check.checked === 2 && result.number_check.failed_count === 2
    && result.number_check.failed_codes.includes('E_NUMCHECK_NOT_IN_FACTS'), JSON.stringify(result.number_check));
  check('数字失败：不泄出候选回答与伪造数字', !JSON.stringify(result).includes('99.9')
    && !JSON.stringify(result).includes('999') && !JSON.stringify(result).includes(forged), JSON.stringify(result));
}

/* ==== 失败：网络/超时/响应异常 ==== */
{
  const network = createChatOnline({
    transport: createFakeTransport({ restate: () => { throw new TransportError('E_TRANSPORT_NETWORK'); } }),
    timeoutMs: 3000,
  });
  const r1 = await network.ask({ question: QUESTION, review: buildFull() });
  check('网络失败：E_TRANSPORT_NETWORK 且无 text', r1.ok === false && r1.code === ONLINE_BOUNDARY_CODES.TRANSPORT_NETWORK && !('text' in r1));

  const badJson = createChatOnline({
    transport: createFakeTransport({ restate: () => ({ rawText: 'not-json' }) }),
    timeoutMs: 3000,
  });
  const r2 = await badJson.ask({ question: QUESTION, review: buildFull() });
  check('响应非法：E_RESTATE_JSON 且无 text', r2.ok === false && r2.code === ONLINE_BOUNDARY_CODES.RESTATE_JSON && !('text' in r2));
}

/* ==== 失败：组合未发布 / review 非法：不发起 transport ==== */
{
  const transport = createFakeTransport();
  const chat = createChatOnline({ transport, timeoutMs: 3000 });
  const degraded = await chat.ask({ question: QUESTION, review: buildDegraded() });
  check('组合未发布：W_ANSWER_PORTFOLIO_WITHHELD 且不调用 transport', degraded.ok === false
    && degraded.code === ANSWER_FACTS_CODES.PORTFOLIO_WITHHELD && transport.calls.length === 0, JSON.stringify(degraded));
  const missing = await chat.ask({ question: QUESTION, review: null });
  check('review 非法：E_CHAT_REVIEW_INVALID 且不调用 transport', missing.ok === false
    && missing.code === CHAT_ONLINE_CODES.REVIEW_INVALID && transport.calls.length === 0);
  const emptyQuestion = await chat.ask({ question: '  ', review: buildFull() });
  check('问题为空：E_QUESTION_INVALID 兜底，不调用 transport', emptyQuestion.ok === false
    && emptyQuestion.code === ONLINE_BOUNDARY_CODES.QUESTION_INVALID && transport.calls.length === 0);
}

/* ==== 兜底文案与计数展示 ==== */
{
  check('固定兜底文案不含数字', !/[0-9０-９]/.test(CHAT_ONLINE_FALLBACK_TEXT), CHAT_ONLINE_FALLBACK_TEXT);
  check('失败原因映射：数字失败与 HTTP 未就绪均有明确说明',
    chatFailureText(ONLINE_BOUNDARY_CODES.NUMBERS_FAILED).includes('数字')
    && chatFailureText('E_HTTP_STATUS').includes('函数未发布'), chatFailureText('E_HTTP_STATUS'));
  check('计数展示只含核对/匹配/未通过计数', numberCheckDetail({ checked: 4, matched_count: 4, failed_count: 0 }) === '已核对 4 个可识别数字（匹配 4，未通过 0）');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
