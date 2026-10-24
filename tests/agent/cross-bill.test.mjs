#!/usr/bin/env node
/**
 * P3 · 跨账单同类操作检索 —— 离线单测（合成夹具；零网络）
 *
 * 覆盖：模式交集/标的/持有桶匹配、次数与覆盖、无匹配口径、排除原因、
 *       示例组标注、只报次数不报金额/行情形态/概率、工具结果到本地草稿。
 * 运行：node tests/agent/cross-bill.test.mjs（或 npm run check）
 */
import {
  CROSS_BILL_VERSION, matchCrossBill, criteriaText, buildCrossBillAnswer, localAnswerFromResults,
} from '../../src/agent/crossBillAnswer.js';
import { buildHistoryIndex, refOf } from '../../src/agent/historyIndex.js';
import { DEMO_HISTORY_INDEX } from '../../src/demo/demoHistory.js';
import { getTool } from '../../src/agent/toolRegistry.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const pattern = (id, name, hits) => ({ id, name, hits });

const ENTRIES = [
  {
    ref: refOf('b1'),
    effective_date: '2026-09-30',
    snapshot: {
      version: 2,
      review: { portfolio_published: true },
      profile: { latest: { review: { portfolio_published: true }, bill: { trade_count: 6 }, behavior: { patterns: [
        { pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 3 },
        { pattern_id: 'quick_flip', name: '买入后三日内卖出', status: '不成立', sample_n: 1 },
      ] } } },
      report: {},
      report_available: true,
    },
    trades: [
      { trade_date: '2026-09-01', symbol: '600519', side: 'buy' },
      { trade_date: '2026-09-02', symbol: '600519', side: 'sell' },
    ],
  },
  {
    ref: refOf('b2'),
    effective_date: '2026-08-31',
    snapshot: {
      version: 2,
      review: { portfolio_published: true },
      profile: { latest: { review: { portfolio_published: true }, bill: { trade_count: 4 }, behavior: { patterns: [
        { pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 2 },
      ] } } },
      report: {},
      report_available: true,
    },
    trades: [
      { trade_date: '2026-08-03', symbol: '000001', side: 'buy' },
      { trade_date: '2026-08-20', symbol: '000001', side: 'sell' },
    ],
  },
  {
    ref: refOf('b3'),
    effective_date: '2026-07-31',
    snapshot: {
      version: 2,
      review: { portfolio_published: true },
      profile: { latest: { review: { portfolio_published: true }, bill: { trade_count: 3 }, behavior: { patterns: [
        { pattern_id: 'quick_flip', name: '买入后三日内卖出', status: '成立', sample_n: 2 },
      ] } } },
      report: {},
      report_available: true,
    },
    trades: [
      { trade_date: '2026-07-06', symbol: '300750', side: 'buy' },
      { trade_date: '2026-07-08', symbol: '300750', side: 'sell' },
    ],
  },
  {
    ref: refOf('draft'),
    effective_date: '2026-10-15',
    snapshot: { version: 1, review: { portfolio_published: false } },
    trades: [],
  },
];

const INDEX = buildHistoryIndex({ entries: ENTRIES });

/* ==== ① 按模式交集匹配 ==== */
{
  const match = matchCrossBill({
    index: INDEX,
    patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 2 }],
  });
  check('匹配：版本与本人范围', match.version === CROSS_BILL_VERSION
    && match.ok === true && match.scope === 'user_saved' && match.synthetic === false, JSON.stringify(match));
  check('匹配：只保留交集模式，按次数累加', match.counts.bills_total === 3
    && match.counts.bills_matched === 2 && match.counts.occurrences === 5
    && match.matched[0].patterns.length === 1 && match.matched[0].patterns[0].id === 'chase_high_buy',
    JSON.stringify(match.counts));
  check('匹配：覆盖扫描与排除原因', match.counts.bills_scanned === 4 && match.counts.bills_excluded === 1
    && match.excluded[0].reason === 'unpublished' && match.excluded[0].count === 1, JSON.stringify(match.excluded));
  check('匹配：边界写明不跨用户/不比形态/不给概率', match.boundaries.some((b) => b.includes('不跨用户'))
    && match.boundaries.some((b) => b.includes('不比较行情形态'))
    && match.boundaries.some((b) => b.includes('不给概率')), JSON.stringify(match.boundaries));
  check('匹配：结果不含金额与成交字段', !JSON.stringify(match.matched).match(/price|quantity|amount|¥/u),
    JSON.stringify(match.matched));
}

/* ==== ② 标的与持有桶过滤 ==== */
{
  const bySymbol = matchCrossBill({ index: INDEX, patterns: [{ pattern_id: 'chase_high_buy', status: '成立', sample_n: 2 }], symbol: '000001' });
  check('过滤：标的同时命中模式与代码', bySymbol.counts.bills_matched === 1
    && bySymbol.matched[0].effective_date === '2026-08-31', JSON.stringify(bySymbol.matched));
  const byBucket = matchCrossBill({ index: INDEX, patterns: [{ pattern_id: 'chase_high_buy', status: '成立', sample_n: 2 }], holdingBucket: '11-30' });
  check('过滤：持有 11–30 天命中 8 月账单', byBucket.counts.bills_matched === 1
    && byBucket.counts.occurrences === 2, JSON.stringify(byBucket.counts));
  const symbolOnly = matchCrossBill({ index: INDEX, symbol: '300750' });
  check('过滤：只按标的时次数为空而不是 0', symbolOnly.counts.bills_matched === 1
    && symbolOnly.counts.occurrences === null, JSON.stringify(symbolOnly.counts));
}

/* ==== ③ 无匹配口径 ==== */
{
  const missing = matchCrossBill({ index: INDEX });
  check('缺省：没有模式/标的/持有桶时不检索', missing.ok === true
    && missing.missing.length === 1 && missing.matched.length === 0, JSON.stringify(missing));
  const draft = buildCrossBillAnswer({ match: missing, question: '跨账单？' });
  check('缺省：草稿照实说明不比较', draft.ok === true && draft.facts.length === 1
    && draft.facts[0].label === '范围' && draft.text.includes('不做跨账单比较'), JSON.stringify(draft));
}

/* ==== ④ 本地草稿：只报次数与覆盖 ==== */
{
  const match = matchCrossBill({ index: INDEX, patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 2 }] });
  const draft = buildCrossBillAnswer({ match, question: '我在其他账单里有没有类似的操作？' });
  check('草稿：范围/匹配/次数/未纳入/口径五条事实', draft.ok === true
    && draft.facts.map((f) => f.label).join(',') === '范围,匹配账单,同类操作,未纳入,匹配口径', JSON.stringify(draft.facts));
  check('草稿：文字写明份数与次数且不出现金额', draft.text.includes('2 份') && draft.text.includes('合计 5 次')
    && !draft.text.match(/¥|\d+\.\d{2}|行情形态相似|概率是/u), draft.text);
  check('草稿：证据只列日期/笔数/模式', draft.evidence.length === 2
    && draft.evidence.every((item) => !item.detail.match(/¥|成交价|买入价/u)), JSON.stringify(draft.evidence));
  check('草稿：不冒充跨用户或实时', !draft.text.includes('其他用户') && !draft.text.includes('实时'), draft.text);

  const zero = buildCrossBillAnswer({
    match: matchCrossBill({ index: buildHistoryIndex({ entries: [] }), patterns: [{ pattern_id: 'chase_high_buy', status: '成立', sample_n: 2 }] }),
  });
  check('草稿：零命中如实说明', zero.text.includes('没有找到') && zero.facts.some((f) => f.label === '匹配账单' && f.value === '0 份'), zero.text);
}

/* ==== ⑤ 示例组 ==== */
{
  const match = matchCrossBill({
    index: DEMO_HISTORY_INDEX,
    patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 3 }],
  });
  check('示例：标记 synthetic 且范围独立', match.synthetic === true && match.scope === 'demo_group'
    && match.counts.bills_matched === 2, JSON.stringify(match.counts));
  const draft = buildCrossBillAnswer({ match });
  check('示例：明示示例组、不冒充云端', draft.notice.includes('示例账单组')
    && draft.text.includes('示例账单组') && !draft.notice.includes('云端'), draft.notice);
  check('示例：示例组索引只含 4 份已发布账单', DEMO_HISTORY_INDEX.rows.length === 4
    && DEMO_HISTORY_INDEX.excluded[0].reason === 'unpublished', JSON.stringify(DEMO_HISTORY_INDEX.coverage));
}

/* ==== ⑥ 工具结果 → 草稿 ==== */
{
  const tool = getTool('history.crossBillIndex');
  const output = tool.invoke({
    historyIndex: INDEX,
    patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 2 }],
  });
  const result = tool.toResult({ output });
  check('工具：事实含总数/匹配/次数/排除/口径', result.ok === true
    && ['bills_total', 'bills_matched', 'occurrences', 'bills_excluded', 'criteria'].every((key) => result.facts.some((f) => f.key === key)),
    JSON.stringify(result.facts));
  check('工具：记录只含日期、笔数、模式与次数', result.records.every((row) => Object.keys(row).sort().join(',') === 'effective_date,occurrences,patterns,trade_count'),
    JSON.stringify(result.records));
  const local = localAnswerFromResults({ results: [{ ...result, output }], question: '跨账单？' });
  check('草稿：从工具结果生成', local.ok === true && local.intent === 'cross_bill'
    && local.template_id === 'T-cross-bill' && local.facts.some((f) => f.label === '匹配账单'), JSON.stringify(local));
  const failedLocal = localAnswerFromResults({ results: [{ tool: 'history.crossBillIndex', ok: false }] });
  check('草稿：工具失败返回不可用而不是补答', failedLocal.ok === false && failedLocal.code === 'E_CROSS_BILL_UNAVAILABLE', JSON.stringify(failedLocal));

  const list = getTool('history.similarAcrossBills');
  const listResult = list.toResult({
    output: list.invoke({
      historyIndex: INDEX,
      patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 2 }],
    }),
  });
  check('工具：逐账单列出出现次数', listResult.facts[0].value === '2 份'
    && listResult.facts.slice(1).every((f) => f.value.endsWith(' 次')), JSON.stringify(listResult.facts));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
