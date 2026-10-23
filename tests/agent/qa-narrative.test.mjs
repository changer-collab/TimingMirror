#!/usr/bin/env node
/**
 * 问答模型解读层（浏览器端）—— 离线单测（fake transport；不联网、不调用真实模型）
 *
 * 覆盖：请求只含问题/意图/已展示事实/允许值；不发送本地答案原文；
 *       数字/日期/代码/计数/建议/预测/Markdown 校验；两次尝试；失败不带文本。
 * 运行：node tests/agent/qa-narrative.test.mjs（或 npm run check）
 */
import {
  QA_NARRATIVE_CODES,
  buildNarrativeRequest,
  checkNarrativeText,
  createQaNarrative,
  qaNarrativeFailureText,
} from '../../src/agent/qaNarrative.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const QUESTION = '我最错的一笔是哪个？';
const FACTS = [
  { label: '差额', value: '¥1,200.00' },
  { label: '成交', value: '2024-09-27 · 卖出 000000 × 100 股' },
];
const EVIDENCE = [{ label: '公式', detail: '¥1,300.00 − ¥100.00 = ¥1,200.00' }];
const VALID_TEXT = '这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及对其他交易的判断。';
const VALID_RAW = JSON.stringify({ answer_text: VALID_TEXT });

function build(args = {}) {
  return buildNarrativeRequest({
    question: QUESTION,
    intent: 'worst_trade',
    facts: FACTS,
    evidence: EVIDENCE,
    ...args,
  });
}

/* ==== ① 请求构造：不回传答案原文，允许值覆盖已展示文本 ==== */
{
  const built = build();
  check('请求：构造成功且只含五个字段', built.ok === true
    && Object.keys(built.request).join(',') === 'question,intent,facts,evidence,allowed', JSON.stringify(built));
  check('请求：不包含本地答案正文', !('text' in built.request)
    && !('answer' in built.request)
    && !JSON.stringify(built.request).includes('这笔交易的差额是'), JSON.stringify(built.request));
  check('请求：允许值覆盖金额/日期/代码/数量', built.ok
    && built.request.allowed.displays.includes('¥1,200.00')
    && built.request.allowed.numbers.includes('1200.00')
    && built.request.allowed.dates.includes('2024-09-27')
    && built.request.allowed.symbols.includes('000000')
    && built.request.allowed.counts.includes('100股'), JSON.stringify(built.request.allowed));

  const emptyQuestion = build({ question: '   ' });
  check('请求：空问题拒绝', emptyQuestion.ok === false && emptyQuestion.code === QA_NARRATIVE_CODES.REQUEST);
  const badIntent = build({ intent: 'loss_overview' });
  check('请求：非解读意图拒绝', badIntent.ok === false && badIntent.code === QA_NARRATIVE_CODES.REQUEST);
  const noFacts = build({ facts: [] });
  check('请求：无事实拒绝', noFacts.ok === false && noFacts.code === QA_NARRATIVE_CODES.REQUEST);
}

/* ==== ② 文本校验：允许值内外 ==== */
{
  const { allowed } = build().request;
  check('校验：只使用已提供数字的正文通过', checkNarrativeText(VALID_TEXT, allowed).ok === true);
  const withDate = '在 2024-09-27 卖出 000000 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果。';
  check('校验：已提供日期与代码通过', checkNarrativeText(withDate, allowed).ok === true);

  const newMoney = '这笔交易的差额是 ¥9,999.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及对其他交易的判断。';
  check('校验：新金额拒绝', checkNarrativeText(newMoney, allowed).ok === false);

  const newDate = '在 2024-09-28 卖出 000000 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果。';
  check('校验：新日期拒绝', checkNarrativeText(newDate, allowed).ok === false);

  const newSymbol = '600519 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及其他交易。';
  check('校验：未提供的代码拒绝', checkNarrativeText(newSymbol, allowed).ok === false);

  const advice = '建议卖出这只股票，这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；只说明这次操作的结果。';
  check('校验：买卖建议拒绝', checkNarrativeText(advice, allowed).ok === false);

  const prediction = '预计后市会涨，这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；只说明这次操作的结果。';
  check('校验：预测措辞拒绝', checkNarrativeText(prediction, allowed).ok === false);

  const markdown = '# 这笔交易的差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及其他交易。';
  check('校验：Markdown 拒绝', checkNarrativeText(markdown, allowed).ok === false);

  const chineseCount = '这笔交易共一笔，差额是 ¥1,200.00，来自卖出前后的价差对照；它只说明这次操作的结果，不涉及其他交易。';
  check('校验：中文数字计数拒绝', checkNarrativeText(chineseCount, allowed).ok === false);

  check('校验：过短拒绝', checkNarrativeText('差额是 ¥1,200.00。', allowed).ok === false);
  check('校验：超长拒绝', checkNarrativeText('差额是 ¥1,200.00，'.repeat(30), allowed).ok === false);
  check('校验：缺少允许值清单拒绝', checkNarrativeText(VALID_TEXT, null).ok === false);
}

/* ==== ③ 客户端：尝试次数、失败不带文本 ==== */
{
  const unavailable = createQaNarrative({ transport: null });
  const noTransport = await unavailable.ask({ question: QUESTION, intent: 'worst_trade', facts: FACTS, evidence: EVIDENCE });
  check('客户端：未配置 transport → UNAVAILABLE', noTransport.ok === false && noTransport.code === QA_NARRATIVE_CODES.UNAVAILABLE);

  const calls = [];
  const single = createQaNarrative({
    transport: {
      async qaNarrative(request) {
        calls.push(request);
        return { rawText: VALID_RAW };
      },
    },
  });
  const answered = await single.ask({ question: QUESTION, intent: 'worst_trade', facts: FACTS, evidence: EVIDENCE });
  check('客户端：单次点击只请求一次并成功', answered.ok === true
    && answered.text === VALID_TEXT && calls.length === 1, JSON.stringify({ answered, calls: calls.length }));
  check('客户端：发送体不含答案原文，且带允许值', calls.length === 1
    && Object.keys(calls[0]).join(',') === 'question,intent,facts,evidence,allowed'
    && !JSON.stringify(calls[0]).includes('这笔交易的差额是')
    && calls[0].allowed.displays.includes('¥1,200.00'), JSON.stringify(calls[0]));
  check('客户端：成功后返回数字校验计数', answered.number_check && answered.number_check.checked === [...VALID_TEXT].length, JSON.stringify(answered.number_check));

  const flakyCalls = [];
  const flaky = createQaNarrative({
    transport: {
      async qaNarrative() {
        flakyCalls.push(1);
        return flakyCalls.length === 1 ? { rawText: '{}' } : { rawText: VALID_RAW };
      },
    },
  });
  const notRecovered = await flaky.ask({ question: QUESTION, intent: 'worst_trade', facts: FACTS, evidence: EVIDENCE });
  check('客户端：格式失败后不自动重试', notRecovered.ok === false
    && notRecovered.code === QA_NARRATIVE_CODES.RESPONSE && flakyCalls.length === 1, JSON.stringify({ notRecovered, calls: flakyCalls.length }));

  const invalidCalls = [];
  const invalid = createQaNarrative({
    transport: {
      async qaNarrative() {
        invalidCalls.push(1);
        return { rawText: JSON.stringify({ answer_text: '这笔交易的差额是 ¥9,999.00，来自卖出前后的价差对照；它只说明这次操作的结果。' }) };
      },
    },
  });
  const rejected = await invalid.ask({ question: QUESTION, intent: 'worst_trade', facts: FACTS, evidence: EVIDENCE });
  check('客户端：校验失败只请求一次 → CHECK 且不返回文本', rejected.ok === false
    && rejected.code === QA_NARRATIVE_CODES.CHECK
    && !('text' in rejected)
    && !JSON.stringify(rejected).includes('¥9,999.00')
    && invalidCalls.length === 1, JSON.stringify(rejected));

  const garbageCalls = [];
  const garbage = createQaNarrative({
    transport: { async qaNarrative() { garbageCalls.push(1); return { rawText: 'not-json' }; } },
  });
  const garbageResult = await garbage.ask({ question: QUESTION, intent: 'worst_trade', facts: FACTS, evidence: EVIDENCE });
  check('客户端：格式非法只请求一次 → RESPONSE 且不返回文本', garbageResult.ok === false
    && garbageResult.code === QA_NARRATIVE_CODES.RESPONSE && !('text' in garbageResult)
    && garbageCalls.length === 1, JSON.stringify({ garbageResult, calls: garbageCalls.length }));

  const throwingCalls = [];
  const throwing = createQaNarrative({
    transport: { async qaNarrative() { throwingCalls.push(1); throw new Error('offline'); } },
  });
  const thrown = await throwing.ask({ question: QUESTION, intent: 'worst_trade', facts: FACTS, evidence: EVIDENCE });
  check('客户端：网络/上游 5xx 失败 → TRANSPORT，只尝试一次且不返回文本', thrown.ok === false
    && thrown.code === QA_NARRATIVE_CODES.TRANSPORT
    && !('text' in thrown) && throwingCalls.length === 1, JSON.stringify({ thrown, throwingCalls: throwingCalls.length }));

  check('失败文案：映射稳定', qaNarrativeFailureText(QA_NARRATIVE_CODES.CHECK).includes('数字校验')
    && qaNarrativeFailureText('E_UNKNOWN').includes('未完成'));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
