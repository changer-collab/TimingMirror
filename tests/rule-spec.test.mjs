#!/usr/bin/env node
import { parseContract } from '../src/engine/contractMatch.js';
import {
  parseRuleSpec, normalizeScope, scopeApplies, describeScopeChange, notApplicableMessage, scopeLabel,
  actionApplies, notApplicableActionMessage, actionLabel,
  RULE_SCHEMA_V1, RULE_SCHEMA_V2, RULE_SPEC_CODES, RULE_CAPABILITIES,
} from '../src/engine/ruleSpec.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const sym = (s) => ({ kind: 'symbol', symbol: s });

/* ==== 全部股票：与 parseContract 完全一致（v1 文本 / 哈希 / 规范化对象不变） ==== */
for (const [template_id, fields] of [['no_buy_on_surge', { threshold_pct: '5' }], ['no_buy_on_surge', { threshold_pct: '2.5' }], ['no_buy_back_within', { days: '3' }]]) {
  const v1 = parseContract({ template_id, fields });
  const a = parseRuleSpec({ template_id, fields });
  const b = parseRuleSpec({ template_id, fields, scope: { kind: 'all' } });
  const c = parseRuleSpec({ template_id, fields, scope: null });
  check(`全部股票（${template_id} ${JSON.stringify(fields)}）：与 parseContract 同哈希 / 同文本 / 同规范化对象，记录格式 contract-v1`,
    [a, b, c].every((x) => x.supported && x.hash === v1.hash && x.text === v1.text && JSON.stringify(x.canonical) === JSON.stringify(v1.canonical)
      && x.schema === RULE_SCHEMA_V1 && x.scope.kind === 'all' && x.scope_text === '全部股票' && x.base_hash === v1.hash),
    JSON.stringify([a.hash, v1.hash]));
}
check('全部股票：参数非法时原样返回引擎错误（不改写错误码与说明）', (() => {
  const v1 = parseContract({ template_id: 'no_buy_back_within', fields: { days: '2.5' } });
  const a = parseRuleSpec({ template_id: 'no_buy_back_within', fields: { days: '2.5' } });
  return !a.supported && a.code === v1.code && a.message === v1.message;
})());

/* ==== 单个代码：contract-v2，文本前缀与独立哈希；同内容同哈希 ==== */
{
  const base = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' } });
  const a = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' }, scope: sym('600519') });
  const a2 = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 }, scope: { symbol: '600519', kind: 'symbol' } });
  const other = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' }, scope: sym('300750') });
  check('单代码：contract-v2，文本“仅限 600519：”+ 原规则文本，范围文本“仅 600519”', a.supported && a.schema === RULE_SCHEMA_V2 && a.text === `仅限 600519：${base.text}`
    && a.base_text === base.text && a.scope_text === '仅 600519' && a.scope.symbol === '600519', JSON.stringify(a).slice(0, 200));
  check('单代码：哈希与 v1 不同，规范化对象含 v1 规范化对象与范围；同内容（字段顺序 / 数字或字符串参数）得同哈希；不同代码哈希不同',
    a.hash !== base.hash && /^[0-9a-f]{16}$/.test(a.hash) && a.canonical.schema === 'contract-canonical-2' && JSON.stringify(a.canonical.base) === JSON.stringify(base.canonical)
    && a2.hash === a.hash && other.hash !== a.hash && a.base_hash === base.hash);
  check('单代码：判定语义不变（条件 / 阈值 / 提醒与 v1 相同）', JSON.stringify(a.condition) === JSON.stringify(base.condition)
    && JSON.stringify(a.threshold) === JSON.stringify(base.threshold) && a.reminder === base.reminder && a.kind === base.kind);
  const lead = parseRuleSpec({ template_id: 'no_buy_back_within', fields: { days: '3' }, scope: sym('000001') });
  check('单代码：前导零按文本保留（000001）', lead.supported && lead.scope.symbol === '000001' && lead.text.startsWith('仅限 000001：'));
}

/* ==== 范围校验：不猜测、不纠正 ==== */
{
  const bad = [
    [sym(600519), '数字类型（会丢失前导零）'],
    [sym('60051'), '5 位'],
    [sym('6005190'), '7 位'],
    [sym(' 600519'), '含空白'],
    [sym('60051a'), '含字母'],
    [sym('６００５１９'), '全角数字'],
    [{ kind: 'symbol' }, '缺代码'],
    [{ kind: 'all', symbol: '600519' }, '全部股票却带代码'],
    [{ kind: 'board', symbol: '创业板' }, '未知范围类型'],
    [{ kind: 'symbol', symbol: '600519', name: '贵州茅台' }, '未知字段'],
    ['600519', '非对象'],
    [[sym('600519')], '数组'],
  ];
  for (const [scope, why] of bad) {
    const r = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '5' }, scope });
    check(`范围校验：${why} → E_RULE_SCOPE_INVALID，不生成规则`, !r.supported && r.code === RULE_SPEC_CODES.SCOPE_INVALID && r.field === 'scope', JSON.stringify(r));
  }
  check('normalizeScope：缺省 / null → 全部股票；{kind:all, symbol:""} 允许', normalizeScope(undefined).scope.kind === 'all' && normalizeScope(null).ok && normalizeScope({ kind: 'all', symbol: '' }).ok);
}

for (const spec of [null, [], '规则', { template_id: 'no_buy_on_surge', fields: null }, { template_id: 'no_buy_on_surge', action: 'sell' }, { template_id: 'no_buy_on_surge', conditions: [] },
  { template_id: 'no_buy_on_surge', fields: {}, scope: sym('600519') }, JSON.parse('{"template_id":"no_buy_on_surge","fields":{"__proto__":1}}'), { template_id: '__proto__' }]) {
  check(`结构边界：${JSON.stringify(spec)} → 拒绝而非抛错或静默忽略`, !parseRuleSpec(spec).supported);
}

/* ==== 范围判定与范围变化 ==== */
check('scopeApplies：全部股票对任何标的适用；单代码只对同一代码适用（字符串比较）', scopeApplies({ kind: 'all' }, '300750') && scopeApplies(null, 'x')
  && scopeApplies(sym('600519'), '600519') && !scopeApplies(sym('600519'), '300750') && !scopeApplies(sym('000001'), '1'));
check('不适用说明：写明规则代码与本次标的，且未读取行情或交易、不计为命中或未命中', notApplicableMessage(sym('600519'), '300750').includes('仅限 600519')
  && notApplicableMessage(sym('600519'), '300750').includes('300750') && notApplicableMessage(sym('600519'), '300750').includes('未读取行情或交易记录'));
{
  const narrow = describeScopeChange({ kind: 'all' }, sym('600519'), '涨幅超阈值不买入');
  const widen = describeScopeChange(sym('600519'), { kind: 'all' });
  const sw = describeScopeChange(sym('600519'), sym('300750'));
  const same = describeScopeChange(sym('600519'), sym('600519'));
  check('范围变化：全部 → 单代码 = 缩小，须确认，并提示其他股票将不再有此类提醒', narrow.kind === 'narrow' && narrow.requires_ack
    && narrow.message.includes('除 600519 外的其他股票将不再有「涨幅超阈值不买入」类提醒') && narrow.from === '全部股票' && narrow.to === '仅 600519', JSON.stringify(narrow));
  check('范围变化：单代码 → 全部 = 扩大，须确认；单代码 → 另一代码 = 切换，须确认并提示原代码不再提醒', widen.kind === 'widen' && widen.requires_ack
    && sw.kind === 'switch' && sw.requires_ack && sw.message.includes('600519 将不再有'));
  check('范围变化：相同范围不需确认；没有当前规则时返回 null', same.kind === 'same' && !same.requires_ack && describeScopeChange(null, sym('600519')) === null
    && describeScopeChange({ kind: 'all' }, { kind: 'all' }).requires_ack === false);
}

/* ==== 能力登记：只登记已实现能力；时间口径如实 ==== */
check('能力登记：条件为三类已实现模板，范围只有全部股票 / 单个代码，动作含申报买入与申报卖出',
  JSON.stringify(Object.keys(RULE_CAPABILITIES.conditions)) === JSON.stringify(['no_buy_on_surge', 'no_buy_back_within', 'sell_within_after_buy'])
  && JSON.stringify(Object.keys(RULE_CAPABILITIES.scopes)) === JSON.stringify(['all', 'symbol'])
  && RULE_CAPABILITIES.action.id === 'buy' && RULE_CAPABILITIES.actions.buy.id === 'buy' && RULE_CAPABILITIES.actions.sell.id === 'sell'
  && RULE_CAPABILITIES.conditions.no_buy_on_surge.action === 'buy' && RULE_CAPABILITIES.conditions.no_buy_back_within.action === 'buy'
  && RULE_CAPABILITIES.conditions.sell_within_after_buy.action === 'sell');
check('时间口径：涨幅规则写明收盘后历史复盘、不是盘中实时提醒；不追回规则写明只有成交日期、同日先卖后买不计、不读取价格；买入后卖出规则写明同日买入不计、无买入记录时数据不足',
  RULE_CAPABILITIES.conditions.no_buy_on_surge.timing.includes('收盘后历史复盘') && RULE_CAPABILITIES.conditions.no_buy_on_surge.timing.includes('不是盘中实时提醒')
  && RULE_CAPABILITIES.conditions.no_buy_back_within.timing.includes('没有成交时刻') && RULE_CAPABILITIES.conditions.no_buy_back_within.timing.includes('同一天先卖后买不计')
  && RULE_CAPABILITIES.conditions.no_buy_back_within.timing.includes('不读取价格')
  && RULE_CAPABILITIES.conditions.sell_within_after_buy.timing.includes('同日买入不计') && RULE_CAPABILITIES.conditions.sell_within_after_buy.timing.includes('数据不足')
  && RULE_CAPABILITIES.conditions.sell_within_after_buy.timing.includes('不读取价格'));
check('解析结果携带时间口径与所需数据', parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '5' }, scope: sym('600519') }).timing.includes('收盘后')
  && scopeLabel(sym('600519')) === '仅 600519' && scopeLabel({ kind: 'all' }) === '全部股票');

/* ==== 买入后卖出：全股票 v1 与限定代码 v2；动作/哈希与旧规则无关 ==== */
{
  const base = parseContract({ template_id: 'sell_within_after_buy', fields: { days: '3' } });
  const a = parseRuleSpec({ template_id: 'sell_within_after_buy', fields: { days: '3' } });
  const a2 = parseRuleSpec({ template_id: 'sell_within_after_buy', fields: { days: 3 }, scope: { kind: 'all' } });
  const scoped = parseRuleSpec({ template_id: 'sell_within_after_buy', fields: { days: '3' }, scope: sym('600519') });
  check('买入后卖出·全部股票：与 parseContract 同哈希 / 文本 / 规范化对象，记录格式 contract-v1，动作=卖出',
    a.supported && a.schema === RULE_SCHEMA_V1 && a.hash === base.hash && a.text === base.text && JSON.stringify(a.canonical) === JSON.stringify(base.canonical)
    && a2.hash === a.hash && a.action === 'sell' && a.base_hash === base.hash, JSON.stringify(a).slice(0, 200));
  check('买入后卖出·单代码：contract-v2，文本前缀与独立哈希，动作仍为卖出', scoped.supported && scoped.schema === RULE_SCHEMA_V2
    && scoped.hash !== a.hash && scoped.text === `仅限 600519：${base.text}` && scoped.scope_text === '仅 600519' && scoped.action === 'sell'
    && scoped.canonical.schema === 'contract-canonical-2', JSON.stringify(scoped).slice(0, 200));
  check('动作判定：申报买入规则不适用于卖出情境，申报卖出规则不适用于买入情境；说明写明不读取行情或交易',
    !actionApplies('buy', 'sell') && actionApplies('sell', 'sell') && actionApplies('buy', 'buy') && !actionApplies('sell', 'buy')
    && notApplicableActionMessage('sell', 'buy').includes('本次测试是申报买入情境') && notApplicableActionMessage('sell', 'buy').includes('未读取行情或交易记录')
    && actionLabel('sell') === '申报卖出');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
