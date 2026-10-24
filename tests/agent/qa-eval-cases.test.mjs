// 题库自检：只验证结构、覆盖和边界，不验证模型回答。
// 运行：node tests/agent/qa-eval-cases.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QA_EVAL_VERSION,
  QA_EVAL_GROUPS,
  QA_EVAL_FIXTURES,
  QA_EVAL_INJECTIONS,
  QA_EVAL_BUDGETS,
  QA_EVAL_CASES,
  QA_EVAL_ONLINE_CASES,
} from './qa-eval-cases.mjs';
import { INTENTS } from '../../src/agent/planner.js';
import { SCOPE_KINDS, routeScope } from '../../src/agent/scopeRouter.js';

const EXPECTED_GROUP_COUNTS = Object.freeze({
  route: 23, phrasing: 8, data: 10, failure: 8, adversarial: 12, multi_turn: 6, quality: 14,
});
const ALLOWED_KINDS = Object.freeze(['factual', 'refusal', 'clarify', 'withheld', 'setup', 'status', 'help', 'small_talk']);
const ALLOWED_SOURCES = Object.freeze(['typed', 'chip']);
const ALLOWED_SEVERITIES = Object.freeze(['P0', 'P1', 'P2']);
const ALLOWED_FACT_KEYS = Object.freeze(['actualRet', 'ghostRet', 'drag', 'dragMoney']);
const BUDGET_KEYS = Object.freeze(['max_chars', 'max_numbers', 'max_items', 'max_jargon', 'max_boundary_phrases']);
const ZERO_NUMBER_BUDGETS = Object.freeze(['refusal', 'clarify', 'withheld', 'help', 'smalltalk']);

const caseIds = new Set();
for (const item of QA_EVAL_CASES) caseIds.add(item.id);

test('版本与总数固定', () => {
  assert.equal(QA_EVAL_VERSION, 'qa-eval-1');
  assert.equal(QA_EVAL_CASES.length, 81);
});

test('七组分组数量固定且与用例一致', () => {
  assert.deepEqual(QA_EVAL_GROUPS.map((group) => group.id), Object.keys(EXPECTED_GROUP_COUNTS));
  const counts = {};
  for (const item of QA_EVAL_CASES) counts[item.group] = (counts[item.group] ?? 0) + 1;
  assert.deepEqual(counts, EXPECTED_GROUP_COUNTS);
});

test('用例 ID 唯一且非空', () => {
  assert.equal(caseIds.size, QA_EVAL_CASES.length);
  for (const item of QA_EVAL_CASES) {
    assert.equal(typeof item.id, 'string');
    assert.match(item.id, /^[a-z0-9]+(?:-[a-z0-9]+)+$/);
  }
});

test('覆盖全部 14 类意图与 6 类范围', () => {
  const intents = new Set(QA_EVAL_CASES.map((item) => item.expected.intent).filter(Boolean));
  assert.deepEqual([...intents].sort(), [...INTENTS].sort());
  assert.equal(intents.size, 14);
  const scopes = new Set(QA_EVAL_CASES.map((item) => item.expected.scope));
  assert.deepEqual([...scopes].sort(), [...SCOPE_KINDS].sort());
  assert.equal(scopes.size, 6);
});

test('每条用例的期望范围与 routeScope 一致', () => {
  for (const item of QA_EVAL_CASES) {
    const actual = routeScope({ question: item.question, bill: null, billCount: 1 }).kind;
    assert.equal(actual, item.expected.scope, `${item.id} 的范围期望与路由不一致`);
  }
});

test('意图、答案类型、来源、级别均在允许集合内', () => {
  for (const item of QA_EVAL_CASES) {
    if (item.expected.intent !== null) assert.ok(INTENTS.includes(item.expected.intent), item.id);
    for (const kind of item.expected.answer_kind_any) assert.ok(ALLOWED_KINDS.includes(kind), `${item.id} 类型 ${kind}`);
    assert.ok(ALLOWED_SOURCES.includes(item.source), item.id);
    assert.ok(ALLOWED_SEVERITIES.includes(item.severity), item.id);
    if (item.expected.intent) {
      assert.ok(item.expected.acceptable_intents.includes(item.expected.intent), `${item.id} 可接受意图须包含主意图`);
      for (const intent of item.expected.acceptable_intents) {
        assert.ok(INTENTS.includes(intent), `${item.id} 可接受意图 ${intent}`);
      }
    }
  }
});

test('答案类型必须包含默认类型', () => {
  for (const item of QA_EVAL_CASES) {
    assert.ok(item.expected.answer_kind_any.includes(item.expected.answer_kind), item.id);
  }
});

test('事实键、分组与最少覆盖数自洽', () => {
  for (const item of QA_EVAL_CASES) {
    for (const key of item.expected.fact_keys) assert.ok(ALLOWED_FACT_KEYS.includes(key), `${item.id} 事实键 ${key}`);
    const groups = item.expected.must_include_groups;
    assert.ok(Array.isArray(groups), item.id);
    for (const group of groups) {
      assert.ok(Array.isArray(group) && group.length > 0, `${item.id} 分组不能为空`);
      for (const keyword of group) assert.equal(typeof keyword, 'string');
    }
    if (groups.length === 0) assert.equal(item.expected.min_groups, 0, `${item.id} 无分组时 min_groups 应为 0`);
    else {
      assert.ok(Number.isInteger(item.expected.min_groups), item.id);
      assert.ok(item.expected.min_groups >= 1 && item.expected.min_groups <= groups.length, `${item.id} min_groups 越界`);
    }
    for (const keyword of item.expected.must_include_any) assert.equal(typeof keyword, 'string');
    for (const keyword of item.expected.must_include_all) assert.equal(typeof keyword, 'string');
    for (const pattern of item.expected.must_not_match) assert.ok(typeof pattern === 'string' || pattern instanceof RegExp, item.id);
  }
});

test('fixture 与注入值均在词表内', () => {
  for (const item of QA_EVAL_CASES) {
    assert.ok(QA_EVAL_FIXTURES.includes(item.fixture), `${item.id} fixture ${item.fixture}`);
    if (item.inject !== null) assert.ok(QA_EVAL_INJECTIONS.includes(item.inject), `${item.id} inject ${item.inject}`);
  }
});

test('预算引用合法，且拒答/澄清/阻断不出现数字', () => {
  for (const [name, budget] of Object.entries(QA_EVAL_BUDGETS)) {
    for (const key of Object.keys(budget)) assert.ok(BUDGET_KEYS.includes(key), `${name} 未知预算键 ${key}`);
    for (const key of BUDGET_KEYS) {
      assert.ok(Number.isFinite(budget[key]) && budget[key] >= 0, `${name}.${key}`);
    }
    assert.ok(budget.max_chars > 0, name);
    if (ZERO_NUMBER_BUDGETS.includes(name)) assert.equal(budget.max_numbers, 0, `${name} 不应允许数字`);
  }
  for (const item of QA_EVAL_CASES) {
    assert.ok(Number.isFinite(item.budget.max_chars) && item.budget.max_chars > 0, item.id);
    assert.ok(Number.isFinite(item.budget.max_numbers) && item.budget.max_numbers >= 0, item.id);
    for (const key of Object.keys(item.budget)) assert.ok(BUDGET_KEYS.includes(key), `${item.id} 预算键 ${key}`);
    const nonNumericOnly = item.expected.answer_kind_any.length === 1
      && ['refusal', 'clarify', 'withheld', 'help', 'small_talk'].includes(item.expected.answer_kind_any[0]);
    if (nonNumericOnly) assert.equal(item.budget.max_numbers, 0, `${item.id} 非数字回答必须 0 数字预算`);
  }
});

test('多轮用例至少两轮且每轮有问题', () => {
  for (const item of QA_EVAL_CASES.filter((entry) => entry.group === 'multi_turn')) {
    assert.ok(item.turns.length >= 2, `${item.id} 轮次不足`);
    for (const turn of item.turns) {
      assert.equal(typeof turn.question, 'string');
      assert.ok(turn.question.trim() !== '', `${item.id} 存在空轮次`);
    }
  }
});

test('在线用例正好 14 条且全部属于 quality 组', () => {
  assert.equal(QA_EVAL_ONLINE_CASES.length, 14);
  assert.deepEqual(QA_EVAL_ONLINE_CASES.map((item) => item.id).sort(), QA_EVAL_CASES
    .filter((item) => item.group === 'quality')
    .map((item) => item.id)
    .sort());
  for (const item of QA_EVAL_ONLINE_CASES) assert.equal(item.online, true, item.id);
});

test('题库只声明属性，不包含标准答案原文', () => {
  const forbiddenFields = ['answer', 'expected_answer', 'golden', 'golden_answer', 'reference_answer', 'standard_answer', 'ideal_answer'];
  for (const item of QA_EVAL_CASES) {
    for (const field of forbiddenFields) assert.equal(Object.hasOwn(item, field), false, `${item.id} 不应包含 ${field}`);
    for (const field of ['must_include_any', 'must_include_all']) {
      for (const value of item.expected[field]) assert.ok(value.length <= 40, `${item.id} 关键词过长，疑似标准答案`);
    }
  }
});

test('题库不含密钥、账号、联系方式或本地路径', () => {
  const raw = JSON.stringify(QA_EVAL_CASES.map(({ id, question, note, turns }) => ({ id, question, note, turns })));
  assert.doesNotMatch(raw, /sk-[A-Za-z0-9]{16,}/u);
  assert.doesNotMatch(raw, /AKIA[0-9A-Z]{16}/u);
  assert.doesNotMatch(raw, /1[3-9]\d{9}/u);
  assert.doesNotMatch(raw, /[\w.+-]+@[\w-]+\.[a-z]{2,}/iu);
  assert.doesNotMatch(raw, /[A-Za-z]:\\\\/u);
});

test('问题长度受控且非多轮用例自带问题', () => {
  for (const item of QA_EVAL_CASES) {
    assert.equal(typeof item.question, 'string');
    assert.ok(item.question.length <= 300, `${item.id} 问题过长`);
    if (item.group !== 'phrasing') assert.ok(item.question.trim() !== '' || item.id === 'phrasing-empty-01', item.id);
  }
});

test('核心路径保留 P0 用例', () => {
  for (const group of ['route', 'data', 'failure', 'adversarial', 'quality']) {
    assert.ok(QA_EVAL_CASES.some((item) => item.group === group && item.severity === 'P0'), `${group} 缺少 P0`);
  }
});

test('每条用例都带说明或可验证断言', () => {
  for (const item of QA_EVAL_CASES) {
    const hasAssertion = item.expected.must_include_any.length > 0
      || item.expected.must_include_all.length > 0
      || item.expected.must_include_groups.length > 0
      || item.expected.must_not_match.length > 0
      || item.expected.fact_keys.length > 0;
    assert.ok(hasAssertion, `${item.id} 没有可验证断言`);
  }
});
