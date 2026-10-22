#!/usr/bin/env node
/**
 * 买入后 N 个交易日内卖出提醒：引擎边界、动作不适用、账单完整性、适配层与旧规则回归。
 * 本地离线（fake fetch / 签收缓存 / 合成夹具）；不联网、不写文件、不提交。
 * 运行：node tests/rule-buy-sell.test.mjs（或 npm run check）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseContract, matchContract, CONTRACT_CODES } from '../src/engine/contractMatch.js';
import { parseRuleSpec, RULE_SCHEMA_V1, RULE_SCHEMA_V2, RULE_SPEC_CODES, actionApplies, actionLabel } from '../src/engine/ruleSpec.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const rel = String(url).replace(/^\//, '');
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(raw), text: async () => raw };
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const A = await import('../src/demo/adapter.js');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const sym = (s) => ({ kind: 'symbol', symbol: s });
const save = (versions, parsed, opts = {}) => [...versions, ...A.contractSaveRecords(versions, { parsed, note: null, ...opts })];
const ruleOf = (versions, hash) => A.contractRuleSet(versions).rules.find((r) => r.hash === hash);
const resultOf = (out, template_id) => out.results.find((r) => r.rule.template_id === template_id);
const buySell = (days, scope) => A.previewContract({ template_id: 'sell_within_after_buy', fields: { days: String(days) }, scope });
const surge = (pct, scope) => A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: String(pct) }, scope });
const buyback = (days, scope) => A.previewContract({ template_id: 'no_buy_back_within', fields: { days: String(days) }, scope });

/* ==== 1. 兼容：旧两类规则的文本 / 哈希 / 记录格式不变 ==== */
{
  const oldSurge = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '5' } });
  const oldBuyback = parseContract({ template_id: 'no_buy_back_within', fields: { days: '3' } });
  check('兼容：旧涨幅规则文本与哈希保持 47a10ba4d26648cf', oldSurge.hash === '47a10ba4d26648cf' && oldSurge.text === '当天涨幅超过 5% 的票，我绝不买入。', oldSurge.hash);
  check('兼容：旧不追回规则文本与哈希保持 a30810dc469c071b', oldBuyback.hash === 'a30810dc469c071b' && oldBuyback.text === '卖出后 3 个交易日内不追回同一只票。', oldBuyback.hash);
  const versions = save(save([], surge(5)), buyback(3));
  check('兼容：旧规则仍写 contract-v1、无 scope / action 字段，动作由模板登记为买入', versions.length === 2
    && versions.every((r) => r.schema === RULE_SCHEMA_V1 && !('scope' in r) && !('action' in r))
    && A.contractRuleSet(versions).current.every((r) => r.action === 'buy' && r.uses_trades === (r.template_id === 'no_buy_back_within')), JSON.stringify(versions.map((r) => r.schema)));
}

/* ==== 2. 新规则：记录、版本、范围替代、动作元数据 ==== */
{
  const base = buySell(3);
  let v = save(save([], surge(5)), base);
  check('新规则·全部股票：contract-v1、动作=卖出、uses_trades=true，与旧规则并存（3 个槽位）', v.length === 2 && v[1].schema === RULE_SCHEMA_V1
    && v[1].hash === base.hash && base.action === 'sell' && actionLabel(base.action) === '申报卖出'
    && A.contractRuleSet(v).slots.length === 3 && A.contractRuleSet(v).current.length === 2, JSON.stringify(v[1]));
  check('新规则·时间口径与提醒动作：写明历史复盘、同日买入不计、数据不足、不阻止交易', base.timing.includes('同日买入不计') && base.timing.includes('数据不足')
    && base.timing.includes('不读取价格') && base.reminder.includes('只提醒，不阻止或执行交易'), base.timing);

  const scoped = buySell(3, sym('600519'));
  const editor = A.contractEditorState(v, scoped);
  check('新规则·限定代码：范围变化缩小须确认，未确认不写记录', editor.scope_change.kind === 'narrow' && editor.scope_change.requires_ack
    && A.contractSaveRecords(v, { parsed: scoped }).length === 0, JSON.stringify(editor.scope_change));
  v = save(v, scoped, { confirmScopeChange: true });
  const slot = A.contractRuleSet(v).slots.find((s) => s.template_id === 'sell_within_after_buy');
  check('新规则·限定代码保存后：contract-v2、保留代码、动作=卖出', slot.current.hash === scoped.hash && slot.current.schema === RULE_SCHEMA_V2
    && slot.current.scope.symbol === '600519' && slot.current.action === 'sell', JSON.stringify(slot.current));
  check('旧规则记录不受新规则影响：仍为当前、哈希未变', ruleOf(v, surge(5).hash).state === 'current' && ruleOf(v, surge(5).hash).hash === '47a10ba4d26648cf');
  const stop = A.contractStopRecords(v, { hash: scoped.hash });
  v = [...v, ...stop];
  const restored = A.contractRestoreRecords(v, { hash: scoped.hash });
  check('新规则停用 / 恢复：恢复记录保留 v2 范围与卖出动作', restored.length === 1 && restored[0].schema === RULE_SCHEMA_V2
    && restored[0].scope.symbol === '600519' && ruleOf([...v, ...restored], scoped.hash).action === 'sell', JSON.stringify(restored));
}

/* ==== 3. 签收缓存情境：第 1 / N / N+1 天、同日、不同标的、无买入、缺日历、超范围 ==== */
const CSV = ['日期,标的,方向,价格,数量,费用,税费',
  '2023-05-08,600519,买入,1720,100,5,0',
  '2023-05-10,600519,卖出,1725,100,5,1',
  '2023-05-11,300750,买入,230,100,5,0'].join('\n') + '\n';
const bill = { ...(await A.loadUserBillFromText(CSV, 'buy-sell.csv')), status: 'confirmed', contextId: 'buy-sell' };
const newRule = buySell(3);
const scoped600519 = buySell(3, sym('600519'));
const allVersions = save(save(save([], newRule), surge(5)), buyback(3));
const sim = (versions, opts) => A.simulateContracts({ versions, bill, marketSource: 'signed-cache', ...opts });

{
  const d1 = await sim(allVersions, { symbol: '600519', date: '2023-05-09', action: 'sell' });
  const r1 = resultOf(d1, 'sell_within_after_buy');
  check('情境·第 1 天（05-08 买 → 05-09）→ 命中，事实含最近买入、距离 1 与当前记录依据', r1.verdict === 'triggered' && r1.match.fact.distance_trading_days === 1
    && r1.match.fact.last_buy.trade_date === '2023-05-08' && r1.match.fact.result_basis === 'imported_records' && r1.rule.action === 'sell', JSON.stringify(r1.match.fact));
  const dN = await sim(allVersions, { symbol: '600519', date: '2023-05-11', action: 'sell' });
  const rN = resultOf(dN, 'sell_within_after_buy');
  check('情境·第 N 天（第 3 个交易日）→ 命中', rN.verdict === 'triggered' && rN.match.fact.distance_trading_days === 3, JSON.stringify(rN.match.fact));
  const dN1 = await sim(allVersions, { symbol: '600519', date: '2023-05-12', action: 'sell' });
  const rN1 = resultOf(dN1, 'sell_within_after_buy');
  check('情境·第 N+1 天 → 无法确认 / 数据不足（不显示未命中），说明可能有未导出交易', rN1.verdict === 'missing_data'
    && rN1.code === CONTRACT_CODES.BUY_OUTSIDE_WINDOW_UNCONFIRMED && rN1.match.fact.distance_trading_days === 4
    && rN1.message.includes('可能存在未导出的窗口内买入') && rN1.message.includes('不显示“未命中”'), rN1.message);
  const same = await sim(allVersions, { symbol: '300750', date: '2023-05-11', action: 'sell' });
  const rSame = resultOf(same, 'sell_within_after_buy');
  check('情境·仅有同日买入 → 无法确认 / 数据不足（顺序未知，不显示未命中）', rSame.verdict === 'missing_data'
    && rSame.code === CONTRACT_CODES.SAME_DAY_BUY_UNCONFIRMED && rSame.match.fact.last_buy === null
    && rSame.match.fact.same_day_buy_count === 1 && rSame.message.includes('先后顺序无法确定'), rSame.message);
  const other = await sim(save([], scoped600519), { symbol: '300750', date: '2023-05-11', action: 'sell' });
  const rOther = other.results[0];
  check('情境·范围不适用（规则仅 600519）→ 不适用，不读取行情或交易', rOther.verdict === 'not_applicable' && rOther.code === RULE_SPEC_CODES.SCOPE_NOT_APPLICABLE
    && !rOther.change && !rOther.match && rOther.tradesSource === null && other.summary.not_applicable === 1, JSON.stringify(rOther).slice(0, 300));
  const noBuy = await sim(allVersions, { symbol: '601318', date: '2023-05-11', action: 'sell' });
  const rNoBuy = resultOf(noBuy, 'sell_within_after_buy');
  check('情境·没有买入记录 → 数据不足 / 无法确认（不误报未触发）', rNoBuy.verdict === 'missing_data' && rNoBuy.code === CONTRACT_CODES.BUY_HISTORY_UNCONFIRMED
    && rNoBuy.display_verdict === 'missing_data' && noBuy.summary.missing_data >= 1, rNoBuy.code);
  const badDate = await sim(allVersions, { symbol: '600519', date: '2023-05-13', action: 'sell' });
  check('情境·申报日不在日历（2023-05-13 周六）→ 数据不足并说明原因', resultOf(badDate, 'sell_within_after_buy').verdict === 'missing_data'
    && resultOf(badDate, 'sell_within_after_buy').code === CONTRACT_CODES.DATE_NOT_IN_CALENDAR, resultOf(badDate, 'sell_within_after_buy').code);
  const beforeRange = await sim(allVersions, { symbol: '600519', date: '2022-12-30', action: 'sell' });
  check('情境·日期超出签收缓存范围 → 数据不足，不改用其他日期', resultOf(beforeRange, 'sell_within_after_buy').verdict === 'missing_data'
    && resultOf(beforeRange, 'sell_within_after_buy').code === 'E_VALUATION_OUT_OF_RANGE', resultOf(beforeRange, 'sell_within_after_buy').code);
}

/* ==== 4. 动作不适用：买入情境不判定卖出规则，卖出情境不判定买入规则；不读取行情 / 交易 ==== */
{
  const buyScenario = await sim(allVersions, { symbol: '600519', date: '2023-05-11', action: 'buy' });
  const newInBuy = resultOf(buyScenario, 'sell_within_after_buy');
  const oldInBuy = resultOf(buyScenario, 'no_buy_on_surge');
  check('动作·卖出规则遇“假如买入” → 不适用，说明写明本次是申报买入', newInBuy.verdict === 'not_applicable'
    && newInBuy.code === RULE_SPEC_CODES.ACTION_NOT_APPLICABLE && newInBuy.message.includes('本次测试是申报买入情境') && newInBuy.tradesSource === null, newInBuy.message);
  check('动作·旧涨幅规则在买入情境仍正常判定（回归）', ['triggered', 'not_triggered', 'missing_data'].includes(oldInBuy.verdict), oldInBuy.verdict);
  const sellScenario = await sim(allVersions, { symbol: '600519', date: '2023-05-11', action: 'sell' });
  const surgeInSell = resultOf(sellScenario, 'no_buy_on_surge');
  const buybackInSell = resultOf(sellScenario, 'no_buy_back_within');
  check('动作·买入提醒规则遇“假如卖出” → 不适用；不追回规则同样只在买入情境判定',
    surgeInSell.verdict === 'not_applicable' && surgeInSell.code === RULE_SPEC_CODES.ACTION_NOT_APPLICABLE
    && buybackInSell.verdict === 'not_applicable' && buybackInSell.code === RULE_SPEC_CODES.ACTION_NOT_APPLICABLE, JSON.stringify([surgeInSell.verdict, buybackInSell.verdict]));
  check('动作判定函数：buy 与 sell 互不适用', !actionApplies('buy', 'sell') && !actionApplies('sell', 'buy') && actionApplies('buy', 'buy') && actionApplies('sell', 'sell'));

  const lazyBill = { status: 'confirmed', sourceType: 'local', contextId: 'lazy', get trades() { throw new Error('动作不匹配不应读取账单'); } };
  const before = fetchCalls.length;
  const gated = await A.simulateContracts({ versions: save([], newRule), bill: lazyBill, symbol: '600519', date: '2023-05-11', action: 'buy' });
  check('动作不匹配：不加载行情、不读取账单交易，直接返回不适用', fetchCalls.length === before && gated.results[0].verdict === 'not_applicable'
    && gated.summary.not_applicable === 1 && gated.tradesSource === null, JSON.stringify({ calls: fetchCalls.length - before, v: gated.results[0].verdict }));
  let invalid = null;
  try { await A.simulateContracts({ versions: [], symbol: '600519', date: '2023-05-11', action: 'hold' }); } catch (e) { invalid = e; }
  check('动作参数：只接受 buy / sell，未知动作明确抛错', invalid instanceof TypeError && invalid.message.includes('buy'), invalid && invalid.message);
}

/* ==== 5. 旧规则回归：默认买入情境、旧记录格式与命中结论不变 ==== */
{
  const oldVersions = save(save([], surge(3)), buyback(3));
  const out = await A.simulateContracts({ versions: oldVersions, bill, symbol: '600519', date: '2023-05-11', marketSource: 'signed-cache' });
  const oldSurge = resultOf(out, 'no_buy_on_surge');
  const oldBuyback = resultOf(out, 'no_buy_back_within');
  check('旧规则回归：不传 action 时默认“假如买入”，涨幅 / 不追回规则照旧判定', out.scenario_action === 'buy'
    && ['triggered', 'not_triggered'].includes(oldSurge.verdict) && oldBuyback.verdict === 'triggered', JSON.stringify([oldSurge.verdict, oldBuyback.verdict]));
  check('旧规则回归：rules_used 带动作，旧规则为申报买入', out.rules_used.length === 2 && out.rules_used.every((r) => r.action === 'buy' && r.action_label === '申报买入'));
  const records = save(save([], surge(3)), buyback(3));
  check('旧规则回归：保存记录仍为 contract-v1 且无 scope / action 字段', records.every((r) => r.schema === RULE_SCHEMA_V1 && !('scope' in r) && !('action' in r)));
}

/* ==== 6. 合成 / 动态示例路径：规则参与卖出情境，同日与缺日历有明确原因 ==== */
{
  const v = save([], newRule);
  const hit = await A.simulateContracts({ versions: v, bill: null, symbol: '888888', date: '2024-09-26', marketSource: 'synthetic-fixture', action: 'sell' });
  check('示例路径·卖出情境：09-25 买入 → 09-26 命中，交易来源与规则动作可见', hit.results[0].verdict === 'triggered' && hit.results[0].match.fact.distance_trading_days === 1
    && hit.results[0].scenario_action === 'sell' && hit.rules_used[0].action === 'sell', JSON.stringify(hit.results[0].match.fact));
  const buyScenario = await A.simulateContracts({ versions: v, bill: null, symbol: '888888', date: '2024-09-26', marketSource: 'synthetic-fixture', action: 'buy' });
  check('示例路径·买入情境：卖出提醒规则显示不适用', buyScenario.results[0].verdict === 'not_applicable' && buyScenario.results[0].code === RULE_SPEC_CODES.ACTION_NOT_APPLICABLE);
  const same = await A.simulateContracts({ versions: v, bill: null, symbol: '888888', date: '2024-09-25', marketSource: 'synthetic-fixture', action: 'sell' });
  check('示例路径·仅有同日买入 → 无法确认 / 数据不足，并标注同日笔数与顺序未知', same.results[0].verdict === 'missing_data'
    && same.results[0].code === CONTRACT_CODES.SAME_DAY_BUY_UNCONFIRMED && same.results[0].match.fact.same_day_buy_count === 1);
  const noCal = await A.simulateContracts({ versions: v, bill: null, symbol: '888888', date: '2024-10-01', marketSource: 'synthetic-fixture', action: 'sell' });
  check('示例路径·非交易日 / 不在日历 → 数据不足 DATE_NOT_IN_CALENDAR，不编造未命中', noCal.results[0].verdict === 'missing_data'
    && noCal.results[0].code === CONTRACT_CODES.DATE_NOT_IN_CALENDAR, noCal.results[0].code);
  const ctx = await A.contractSimContext({ bill: null, marketSource: 'synthetic-fixture' });
  check('情境上下文：同时提供卖出与买入记录（买入后卖出规则只读买入）', Array.isArray(ctx.buys) && Array.isArray(ctx.sells)
    && ctx.buys.some((b) => b.symbol === '888888' && b.trade_date === '2024-09-25'), JSON.stringify(ctx.buys));
}

/* ==== 7. 决定自述：随版本冻结、不进入哈希、不参与判定 ==== */
{
  const rec = A.contractSaveRecords([], { parsed: surge(5), note: '  我不想追高。  ' })[0];
  const rule = A.contractRuleSet([rec]).current[0];
  check('决定自述：保存时冻结文本、版本与时间，明确 frozen', rule.decision_statement?.text === '我不想追高。'
    && rule.decision_statement.v === 1 && rule.decision_statement.frozen === true && typeof rule.decision_statement.at === 'string', JSON.stringify(rule.decision_statement));
  check('决定自述：不进入哈希（同参数有/无自述哈希一致）', rec.hash === surge(5).hash && A.contractSaveRecords([], { parsed: surge(5) })[0].hash === rec.hash, rec.hash);
  const newer = A.contractSaveRecords([rec], { parsed: surge(6), note: '新的决定自述' });
  const next = A.contractRuleSet([rec, ...newer]);
  const oldRule = next.rules.find((r) => r.hash === surge(5).hash);
  const newRule = next.rules.find((r) => r.hash === surge(6).hash);
  check('决定自述：改写后旧版本自述保持原样，新版本使用新自述', oldRule.decision_statement?.text === '我不想追高。'
    && newRule.decision_statement?.text === '新的决定自述' && newRule.decision_statement.v === 2, JSON.stringify({ old: oldRule.decision_statement, new: newRule.decision_statement }));
  const stopped = A.contractStopRecords([rec, ...newer], { hash: surge(6).hash });
  const stoppedRule = A.contractRuleSet([rec, ...newer, ...stopped]).rules.find((r) => r.hash === surge(6).hash);
  check('决定自述：状态变更不丢失已冻结的自述', stoppedRule.decision_statement?.text === '新的决定自述', JSON.stringify(stoppedRule.decision_statement));
}

/* ==== 8. 完整性：新规则 v2 记录被篡改 / 换范围 → 待重新确认，不参与判定 ==== */
{
  const v2 = buySell(3, sym('600519'));
  const base = A.contractSaveRecords([], { parsed: v2 });
  const tampered = A.contractRuleSet([{ ...base[0], scope: sym('300750') }]);
  check('完整性：新规则 v2 范围被篡改 → 哈希不一致，待重新确认、不参与判定', tampered.needsReconfirm.length === 1
    && tampered.executable.length === 0 && tampered.needsReconfirm[0].integrity.code === 'E_CONTRACT_RULE_HASH_MISMATCH');
  const tamperedFields = A.contractRuleSet([{ ...base[0], fields: { days: 9 } }]);
  check('完整性：新规则参数被篡改 → 不参与判定', tamperedFields.needsReconfirm.length === 1 && tamperedFields.executable.length === 0);
}

/* ==== 9. 回退（可选）：旧版 adapter 读取新规则记录 → 原样保留、不执行 ==== */
if (process.env.ROLLBACK_ADAPTER) {
  const OLD = await import(pathToFileURL(process.env.ROLLBACK_ADAPTER).href);
  const data = save(save([], surge(5)), buySell(3));
  let old;
  try { old = OLD.contractRuleSet(JSON.parse(JSON.stringify(data))); } catch (e) { old = { error: String(e) }; }
  let oldSim;
  try { oldSim = await OLD.simulateContracts({ versions: JSON.parse(JSON.stringify(data)), symbol: '000000', date: '2024-10-09', bill: null, marketSource: 'synthetic-fixture' }); } catch (e) { oldSim = { error: String(e) }; }
  check('回退：旧版 adapter 不崩溃；新模板记录待重新确认、不执行，旧涨幅规则照常', !old.error
    && (old.executable ?? []).every((r) => r.template_id !== 'sell_within_after_buy')
    && (old.needsReconfirm ?? []).some((r) => r.template_id === 'sell_within_after_buy')
    && !oldSim.error && oldSim.rules_n === 1 && oldSim.results[0].rule.hash === surge(5).hash, JSON.stringify(old.error ?? oldSim.results?.map((r) => r.rule.hash)));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
