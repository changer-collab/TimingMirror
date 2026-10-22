#!/usr/bin/env node
/**
 * 在线意图评测集 —— 离线校验（不联网）
 *
 * 覆盖：用例 ID/问题唯一、12 类各至少两条、主判定与可接受集合法、
 *       每条都绕过 L1（否则在线准确率没有意义）、槽位标注合法。
 * 运行：node tests/agent/intent-eval.test.mjs（或 npm run check）
 */
import { INTENTS } from '../../src/agent/planner.js';
import { routeQuestion, QA_QUESTION_MAX } from '../../prototype/user-frontend/qaIntent.js';
import { INTENT_EVAL_CASES } from './intent-eval-cases.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const cases = INTENT_EVAL_CASES;
const ids = cases.map((c) => c.id);
const questions = cases.map((c) => c.question);
const unique = (list) => new Set(list).size === list.length;

check('用例：共 25 条，ID 与问题不重复', cases.length === 25 && unique(ids) && unique(questions), `${cases.length}`);
check('用例：expected 都在 12 类内', cases.every((c) => INTENTS.includes(c.expected)),
  JSON.stringify(cases.filter((c) => !INTENTS.includes(c.expected)).map((c) => c.id)));
check('用例：acceptable 合法且包含 expected', cases.every((c) => {
  const acceptable = c.acceptable ?? [c.expected];
  return Array.isArray(acceptable) && acceptable.includes(c.expected) && acceptable.every((i) => INTENTS.includes(i));
}), JSON.stringify(cases.filter((c) => {
  const acceptable = c.acceptable ?? [c.expected];
  return !Array.isArray(acceptable) || !acceptable.includes(c.expected) || !acceptable.every((i) => INTENTS.includes(i));
}).map((c) => c.id)));

const counts = new Map(INTENTS.map((intent) => [intent, 0]));
for (const item of cases) counts.set(item.expected, (counts.get(item.expected) ?? 0) + 1);
check('用例：12 类各至少 2 条', [...counts.values()].every((count) => count >= 2),
  JSON.stringify(Object.fromEntries(counts)));

const l1Hits = cases.filter((c) => routeQuestion(c.question).intent !== null);
check('用例：全部绕过 L1，才会真正请求 L2', l1Hits.length === 0,
  JSON.stringify(l1Hits.map((c) => ({ id: c.id, route: routeQuestion(c.question) }))));

check('用例：问题长度在 1-200 字内', cases.every((c) => typeof c.question === 'string'
  && c.question.trim().length > 0 && c.question.length <= QA_QUESTION_MAX),
  JSON.stringify(cases.filter((c) => typeof c.question !== 'string' || c.question.length === 0 || c.question.length > QA_QUESTION_MAX).map((c) => c.id)));

const slotCases = cases.filter((c) => c.slots);
check('槽位用例：只标注 symbol/trade_date，格式合法', slotCases.length === 1
  && Object.keys(slotCases[0].slots).sort().join(',') === 'symbol,trade_date'
  && /^\d{6}$/u.test(slotCases[0].slots.symbol)
  && /^\d{4}-\d{2}-\d{2}$/u.test(slotCases[0].slots.trade_date), JSON.stringify(slotCases));

const scriptPath = fileURLToPath(new URL('../../scripts/eval-intent.mjs', import.meta.url));
const snippet = spawnSync(process.execPath, [scriptPath, '--snippet'], { encoding: 'utf8' });
check('评测脚本：--snippet 输出含全部用例、站内端点与汇总协议', snippet.status === 0
  && cases.every((c) => snippet.stdout.includes(c.question))
  && snippet.stdout.includes('/functions/v1/app/api/llm/intent')
  && snippet.stdout.includes('intent-eval-v1'), snippet.stderr || snippet.stdout.slice(0, 200));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
