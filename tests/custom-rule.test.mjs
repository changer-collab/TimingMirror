import assert from 'node:assert/strict';
import { validateRuleJson, resolveRuleIntent } from '../src/agent/ruleIntent.js';
import { CONTRACT_CUSTOM_HASH, contractSaveCustomRecords, contractStopRecords, contractRestoreRecords, contractRuleSet } from '../src/demo/adapter.js';

const response = { status: 'custom', kind: 'custom', template_id: null, params: {}, scope: { kind: 'all', symbol: null }, action: 'both', needs: [], missing: [], understanding: '涨跌过大时提醒' };
const valid = validateRuleJson(response);
assert.equal(valid.ok, true);
const result = resolveRuleIntent(valid.value, '涨跌过大时买入或卖出都提醒');
assert.equal(result.is_custom, true);
assert.equal(result.action, 'both');

const resolveCustom = (text, scope) => {
  const checked = validateRuleJson({ ...response, scope });
  assert.equal(checked.ok, true);
  return resolveRuleIntent(checked.value, text);
};
const only = (symbol) => ({ kind: 'symbol', symbol });
assert.equal(resolveCustom('只针对 600519 买入前提醒', { kind: 'all' }).status, 'unclear');
assert.equal(resolveCustom('只针对 600519 买入前提醒', only('600036')).status, 'unclear');
assert.equal(resolveCustom('买入前提醒', only('600519')).status, 'unclear');
assert.equal(resolveCustom('只针对 600519、600036 买入前提醒', only('600519')).status, 'unsupported');
assert.equal(resolveCustom('除了 600519 买入前提醒', { kind: 'all' }).status, 'unsupported');
assert.equal(resolveCustom('只针对 600519 买入前提醒', only('600519')).scope.symbol, '600519');
assert.equal(resolveCustom('买入前提醒', { kind: 'all' }).scope.kind, 'all');

const make = (rule_id, text, action = 'both') => {
  const scope = { kind: 'all' };
  const hash = CONTRACT_CUSTOM_HASH({ schema: 'custom-v1', kind: 'custom', text, action, scope });
  return { rule_id, text, action, scope, understanding: text, hash };
};
const a = make('custom-a', '规则一');
const b = make('custom-b', '规则二');
let versions = contractSaveCustomRecords([], a);
versions.push(...contractSaveCustomRecords(versions, b));
versions.push(...contractStopRecords(versions, { hash: a.hash, rule_id: a.rule_id }));
let set = contractRuleSet(versions);
assert.equal(set.customCurrent.length, 1);
assert.equal(set.customCurrent[0].rule_id, b.rule_id);
const restored = contractRestoreRecords(versions, { hash: a.hash, rule_id: a.rule_id });
assert.equal(restored.length, 1);
assert.equal(restored[0].schema, 'custom-v1');
versions.push(...restored);
assert.deepEqual(new Set(contractRuleSet(versions).customCurrent.map((r) => r.rule_id)), new Set(['custom-a', 'custom-b']));

const a2 = make('custom-a', '规则一更新', 'sell');
versions.push(...contractSaveCustomRecords(versions, a2));
set = contractRuleSet(versions);
assert.equal(set.customCurrent.find((r) => r.rule_id === 'custom-a').text, '规则一更新');
assert.ok(set.history.some((r) => r.rule_id === 'custom-a' && r.text === '规则一'));
versions.push(...contractRestoreRecords(versions, { hash: a.hash, rule_id: a.rule_id }));
set = contractRuleSet(versions);
assert.equal(set.customCurrent.find((r) => r.rule_id === 'custom-a').text, '规则一');
assert.equal(set.customCurrent.find((r) => r.rule_id === 'custom-b').text, '规则二');

const duplicate = make('custom-c', '规则一');
versions.push(...contractSaveCustomRecords(versions, duplicate));
versions.push(...contractStopRecords(versions, { hash: duplicate.hash, rule_id: duplicate.rule_id }));
set = contractRuleSet(versions);
assert.ok(set.customCurrent.some((r) => r.rule_id === 'custom-a'));
assert.ok(!set.customCurrent.some((r) => r.rule_id === 'custom-c'));
console.log('自定义规则识别、隔离、版本和恢复检查通过');

// 用户端启动应从本地存储恢复，重复初始化不能覆盖运行时新规则。
const store = new Map([['tm.contracts.demo', JSON.stringify({ versions })]]);
globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
const bridge = await import('../prototype/user-frontend/realBridge.js');
bridge.initBridge();
assert.deepEqual(bridge.getShared().contracts.versions, versions);
assert.equal(bridge.getMode('rules'), 'real');
const runtime = [...versions, { marker: 'runtime' }];
bridge.getShared().contracts.versions = runtime;
bridge.initBridge();
assert.equal(bridge.getShared().contracts.versions, runtime);
console.log('用户端恢复已保存规则及重复初始化检查通过');
