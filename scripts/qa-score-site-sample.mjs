#!/usr/bin/env node
// 对已发布站点的真实回答跑用户视角评分卡。
// 输入：docs/yinchen/qa-site-samples-2026-10-25.json（只含问题、渲染文本、徽标状态）。
// 运行：node scripts/qa-score-site-sample.mjs [snapshot.json]
//
// 允许数字/日期/代码取自本次示例账单已发布的报告事实；不联网、不读账单、不调用模型。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scoreCase } from '../tests/agent/qa-scorecard.mjs';
import { QA_EVAL_BUDGETS } from '../tests/agent/qa-eval-cases.mjs';

const DEFAULT_SNAPSHOT = fileURLToPath(new URL('../docs/yinchen/qa-site-samples-2026-10-25.json', import.meta.url));

const DATE = '2025-12-30';
const SYMBOLS = ['600519', '300750', '601318'];
const OVERVIEW_GROUPS = [
  ['实际收益', '真实收益'],
  ['对照收益', '买入不动', '持有不动'],
  ['择时损耗', '损耗'],
];
const WORST_GROUPS = [
  ['最错', '拖后腿', '后悔', '亏损最多', '没有'],
  ['日期', '月', '日', '代码', '股票', '标的'],
  ['¥', '元', '亏', '差额', '收益', '多赚'],
];
const BEST_GROUPS = [
  ['最顺', '最加分', '最划算', '赚得最多', '最好'],
  ['日期', '月', '日', '代码', '股票', '标的'],
  ['¥', '元', '赚', '差额', '收益'],
];

const CASES = [
  {
    id: 'live-overview', match: '组合整体表现如何？', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_groups: OVERVIEW_GROUPS, min_groups: 2,
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.overview,
    allowed: {
      numbers: ['-1.9', '-8.0', '-6.1', '26044', '-26044', '420324', '394280', '428482'],
      dates: [], symbols: [],
    },
  },
  {
    id: 'live-worst', match: '我最错的一笔是哪个？', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['最错', '拖后腿', '后悔', '亏损最多', '没有'],
      must_include_groups: WORST_GROUPS, min_groups: 2,
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.simple,
    allowed: {
      numbers: ['10944', '26044', '-26044', '1389.72', '1335.00', '200', '0'],
      dates: [DATE], symbols: ['600519'],
    },
  },
  {
    id: 'live-best', match: '哪一次卖出事后看最加分', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['最顺', '最加分', '最划算', '赚'],
      must_include_groups: BEST_GROUPS, min_groups: 2,
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.simple,
    allowed: {
      numbers: ['10944', '26044', '-26044', '42.0', '1389.72', '1335.00', '200'],
      dates: [DATE], symbols: ['600519'],
    },
  },
  {
    id: 'live-pattern', match: '为什么说我追高？', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['追高', '买入', '高点', '记录'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.simple,
    allowed: { numbers: ['5', '0', '2', '10.0'], dates: [], symbols: [] },
  },
  {
    id: 'live-profile', match: '我是谁？', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['画像', '模式', '习惯', '操作'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.profile,
    allowed: {
      numbers: ['8', '5', '3', '4', '0', '2'],
      dates: [], symbols: [],
    },
  },
  {
    id: 'live-whatif', match: '假设 2025-12-30 那笔 600519 没有卖出，结果会差多少', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['没', '少', '差', '持有'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.whatif,
    allowed: {
      numbers: ['200', '10944', '3.7', '-3.7'],
      dates: [DATE], symbols: ['600519'],
    },
  },
  {
    id: 'live-similar', match: '我以前也遇到过这种行情吗', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['同一', '这份账单', '相似', '重复'],
      must_not_match: ['跨账单', '其他账单'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.similar,
    allowed: {
      numbers: ['3', '241', '223'],
      dates: [DATE], symbols: SYMBOLS,
    },
  },
  {
    id: 'live-crossbill', match: '我在以前的账单里也这样操作过吗', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['次数', '账单', '份', '模式'],
      must_not_match: ['相似', '走势'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.crossbill,
    allowed: { numbers: ['1'], dates: [], symbols: [] },
  },
  {
    id: 'live-change', match: '我该怎么改？', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['提醒', '规则', '记录', '复盘', '候选'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.simple,
    allowed: { numbers: ['0', '5', '2', '10.0'], dates: [], symbols: [] },
  },
  {
    id: 'live-calc', match: '择时损耗这个数从哪来的', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['公式', '对照', '买入', '卖出', '计算'],
      must_include_groups: [['公式', '算式', '算法'], ['对照收益', '买入不动', '持有不动', '买入价', '收盘价', '逐笔']],
      min_groups: 2,
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.calc,
    allowed: { numbers: ['35'], dates: [], symbols: [] },
  },
  {
    id: 'live-trust', match: '行情数据万一有缺失，结论还稳吗', kind: 'factual',
    expected: {
      answer_kind: 'factual', acceptable: ['factual'],
      must_include_any: ['缺失', '不发布', '核对', '证据'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.trust,
    allowed: { numbers: ['0'], dates: [], symbols: [] },
  },
  {
    id: 'live-refusal', match: '给我推荐一只股票', kind: 'refusal',
    expected: {
      answer_kind: 'refusal', acceptable: ['refusal'],
      must_include_any: ['不能', '无法', '不推荐', '不提供', '只'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.refusal,
    allowed: { numbers: [], dates: [], symbols: [] },
  },
  {
    id: 'live-unrelated', match: '明天天气怎么样', kind: 'refusal',
    expected: {
      answer_kind: 'refusal', acceptable: ['refusal'],
      must_include_any: ['只能', '账单', '助手', '无法', '只'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.refusal,
    allowed: { numbers: [], dates: [], symbols: [] },
  },
  {
    id: 'live-help', match: '这个页面怎么用', kind: 'help',
    expected: {
      answer_kind: 'help', acceptable: ['help'],
      must_include_any: ['帮助', '页面', '助手', '可以'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.help,
    allowed: { numbers: [], dates: [], symbols: [] },
  },
  {
    id: 'live-asserted-number', match: '我上次赚了 99%，你确认一下', kind: 'factual',
    expected: {
      answer_kind: 'clarify', acceptable: ['clarify'],
      must_include_any: ['无法', '核对', '记录', '具体'],
      must_not_match: ['99[%％]'],
      requires_evidence: false,
    },
    budget: QA_EVAL_BUDGETS.clarify,
    allowed: { numbers: [], dates: [], symbols: [] },
  },
];

// 页面 state 为 local 时无法区分事实回答与页面帮助，按 intent 补判；其余拒绝/澄清/扣发按 state。
function actualKindOf(answer, fallback) {
  if (answer.state === 'clarify' || answer.state === 'refusal'
    || answer.state === 'withheld' || answer.state === 'unavailable') return answer.state;
  if (answer.intent === 'product_help' || answer.intent === 'none') return 'help';
  return fallback;
}

const snapshotPath = process.argv[2] ?? DEFAULT_SNAPSHOT;
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const answers = Array.isArray(snapshot.answers) ? snapshot.answers : [];
const byQuestion = new Map(answers.map((item) => [item.question, item]));

const rows = [];
const missing = [];
for (const item of CASES) {
  const answer = byQuestion.get(item.match);
  if (!answer) { missing.push(item.match); continue; }
  const caseDef = {
    id: item.id,
    question: answer.question,
    expected: item.expected,
    budget: item.budget,
  };
  const result = scoreCase({
    caseDef,
    answer: answer.text,
    allowed: item.allowed,
    claims: null,
    actualKind: actualKindOf(answer, item.kind),
  });
  rows.push({ answer, result });
}

for (const { answer, result } of rows) {
  const dims = Object.entries(result.readability.dimensions)
    .map(([id, value]) => `${id}:${value.score}`)
    .join(' ');
  console.log(`${result.verdict.toUpperCase().padEnd(6)} ${result.id.padEnd(20)} ${String(result.readability.total).padStart(2)}/14  acc=${result.accuracy.status}  numbers=${result.readability.metrics.number_count} chars=${result.readability.metrics.chars}  trace=${answer.traceSteps}  ${dims}`);
  for (const reason of result.summary) console.log(`        - ${reason}`);
}

const counts = rows.reduce((acc, { result }) => {
  acc[result.verdict] = (acc[result.verdict] ?? 0) + 1;
  return acc;
}, {});
console.log(`\n== 共 ${rows.length} 条：pass ${counts.pass ?? 0} / review ${counts.review ?? 0} / fail ${counts.fail ?? 0} ==`);
if (missing.length) console.log(`缺少回答：${missing.join('、')}`);
