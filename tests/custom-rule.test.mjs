import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/* ==== 自定义规则参与情境测试：不经模板引擎；范围/动作筛选；只整理最小判定数据 ==== */
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const cacheFixture = JSON.parse(readFileSync(join(ROOT, 'data/market-cache.json'), 'utf8'));
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === '/functions/v1/app/api/market/snapshot') {
      const req = JSON.parse(options.body);
      const end = '2025-12-31';
      const start = req.start;
      const time = '2026-10-22T00:00:00Z';
      const pick = (bars) => (bars ?? []).filter((b) => b.date >= start && b.date <= end).map((b) => ({ date: b.date, close: b.close }));
      const market = {
        artifact: 'market-cache-dynamic', manifest_version: 'dynamic-v1', fetched_at: time,
        checksum: '0123456789abcdef'.repeat(4), asOfDate: end,
        source: { provider: 'tushare', freshness: 'latest_closed_daily' },
        manifest: { symbols: req.symbols, date_range: { start, end }, asOfDate: end },
        calendar: { trading_days: cacheFixture.calendar.trading_days.filter((d) => d >= start && d <= end) },
        symbols: Object.fromEntries(req.symbols.map((s) => [s, { bars: pick(cacheFixture.symbols[s]?.bars), bars_fwdadj: pick(cacheFixture.symbols[s]?.bars_fwdadj) }])),
        snapshot: { snapshot_id: 'offline-custom-test', fetch_time: time, latest_trade_date: end, range: { start, end }, symbols: req.symbols, provider: 'tushare' },
      };
      return { ok: true, status: 200, json: async () => ({ ok: true, market }) };
    }
    const rel = String(url).replace(/^\//, '');
    const raw = readFileSync(join(ROOT, rel), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(raw), text: async () => raw };
  };

  const { simulateContracts } = await import('../src/demo/adapter.js');
  const customRule = (rule_id, text, action, scope = { kind: 'all' }) => {
    const hash = CONTRACT_CUSTOM_HASH({ schema: 'custom-v1', kind: 'custom', text, action, scope });
    return contractSaveCustomRecords([], { rule_id, text, action, scope, understanding: text, hash });
  };
  const buyAll = customRule('sim-a', '买入前核对自己的交易计划', 'buy');
  const sellScoped = customRule('sim-b', '只针对 600519：卖出前核对持仓', 'sell', { kind: 'symbol', symbol: '600519' });
  const simVersions = [...buyAll, ...sellScoped];
  const set = contractRuleSet(simVersions);
  assert.equal(set.customCurrent.length, 2);

  const out = await simulateContracts({ versions: simVersions, symbol: '000000', date: '2024-10-10', bill: null, marketSource: 'synthetic-fixture', action: 'buy' });
  const pending = out.results.find((r) => r.rule.rule_id === 'sim-a');
  const gated = out.results.find((r) => r.rule.rule_id === 'sim-b');
  assert.ok(pending, '适用的自定义规则应有结果');
  assert.equal(pending.display_verdict, 'custom_pending');
  assert.equal(pending.verdict, 'custom_pending');
  assert.ok(pending.custom && pending.custom.status === 'pending');
  const d = pending.custom.data;
  assert.deepEqual(Object.keys(d).sort(), ['buys', 'calendar_truncated', 'change_pct', 'effective_date', 'market_label', 'requested_date', 'sells', 'symbol', 'trading_days']);
  assert.equal(d.symbol, '000000');
  assert.equal(d.requested_date, '2024-10-10');
  assert.equal(typeof d.change_pct, 'number');
  assert.ok(Array.isArray(d.buys) && d.buys.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
  assert.ok(d.trading_days.length <= 500 && d.trading_days.every((x) => x <= d.requested_date));
  assert.ok(!JSON.stringify(d).includes('price') && !JSON.stringify(d).includes('amount') && !JSON.stringify(d).includes('trade_id'));
  assert.equal(out.summary.custom_pending, 1);
  assert.equal(out.summary.error, 0, '自定义规则不得再进入模板引擎（旧问题：显示“无法判定”）');
  assert.equal(gated.display_verdict, 'not_applicable', '范围+动作不适用的自定义规则不调用判定');
  assert.equal(gated.custom, null);

  const sellOut = await simulateContracts({ versions: simVersions, symbol: '600519', date: '2024-10-10', bill: null, marketSource: 'synthetic-fixture', action: 'sell' });
  assert.equal(sellOut.results.find((r) => r.rule.rule_id === 'sim-a').display_verdict, 'not_applicable', '动作不匹配（买入提醒规则在卖出情境）→ 不适用');
  const sellPending = sellOut.results.find((r) => r.rule.rule_id === 'sim-b');
  assert.equal(sellPending.display_verdict, 'custom_pending');

  // 停用的自定义规则不参与；完整性失败的进入 needs_reconfirm
  const stopped = [...simVersions, ...contractStopRecords(simVersions, { hash: sellScoped[0].hash, rule_id: 'sim-b' })];
  const afterStop = await simulateContracts({ versions: stopped, symbol: '600519', date: '2024-10-10', bill: null, marketSource: 'synthetic-fixture', action: 'sell' });
  assert.ok(!afterStop.results.some((r) => r.rule.rule_id === 'sim-b'));
  const broken = [...simVersions, { ...buyAll[0], hash: 'deadbeefdeadbeef', text: '买入前核对自己的交易计划（被篡改）' }];
  const withBroken = await simulateContracts({ versions: broken, symbol: '000000', date: '2024-10-10', bill: null, marketSource: 'synthetic-fixture', action: 'buy' });
  assert.ok(!withBroken.results.some((r) => r.rule.hash === 'deadbeefdeadbeef'));
  assert.equal(withBroken.needs_reconfirm_n, 1);
  console.log('自定义规则情境判定（范围/动作筛选、最小数据、不经模板引擎）检查通过');
}
