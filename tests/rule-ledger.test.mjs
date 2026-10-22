#!/usr/bin/env node
/**
 * 守约账本（src/engine/ruleLedger.js）：假设当前规则在账单期间已生效，逐笔复核；
 * 守约类命中记违反、提醒类命中记已提醒；缺行情/缺成交时刻记数据不足，不猜测。
 * 运行：node tests/rule-ledger.test.mjs
 */
import { parseRuleSpec } from '../src/engine/ruleSpec.js';
import { buildRuleLedger } from '../src/engine/ruleLedger.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const DAYS = ['2024-08-01', '2024-08-02', '2024-08-05', '2024-08-06', '2024-08-07', '2024-08-08', '2024-08-09'];
const CLOSES = { AAA: [100, 110, 108, 110, 112, 115, 120] };
const market = {
  tradingDays: DAYS,
  range: { start: DAYS[0], end: DAYS[DAYS.length - 1] },
  resolveValuation: (date) => {
    if (DAYS.includes(date)) return { blocked: false, effective_date: date };
    const prior = DAYS.filter((d) => d < date).pop();
    return prior ? { blocked: false, effective_date: prior } : { blocked: true, code: 'E_DATE_OUT_OF_RANGE' };
  },
  getClose: (symbol, date) => {
    const i = DAYS.indexOf(date);
    return CLOSES[symbol] && i >= 0 ? CLOSES[symbol][i] : null;
  },
};

const trade = (id, date, symbol, side) => ({ trade_id: id, trade_date: date, symbol, side, price: 10, quantity: 100 });
const trades = [
  trade('B1', '2024-08-02', 'AAA', 'buy'),
  trade('B2', '2024-08-06', 'AAA', 'buy'),
  trade('B3', '2024-08-02', 'BBB', 'buy'),
  trade('S1', '2024-08-05', 'AAA', 'sell'),
  trade('S2', '2024-08-08', 'AAA', 'sell'),
  trade('S3', '2024-08-07', 'CCC', 'sell'),
];

const spec = (template_id, fields, scope) => parseRuleSpec({ template_id, fields, scope });
const asRule = (parsed, v = 1) => ({
  ...parsed, v, hash: parsed.hash, parsed,
  scope: parsed.scope, scope_text: parsed.scope_text,
  template_id: parsed.template_id, template_name: parsed.template_name,
  text: parsed.text, action: parsed.action,
});
const rule = (out, template_id) => out.rules.find((r) => r.template_id === template_id);

/* ---- 守约类：涨幅规则命中仍买入 → 违反；未命中 → 守约；缺价 → 数据不足 ---- */
{
  const out = buildRuleLedger({ rules: [asRule(spec('no_buy_on_surge', { threshold_pct: '5' }))], trades, market });
  const r = rule(out, 'no_buy_on_surge');
  check('涨幅规则：复核 3 笔买入，1 违反 / 1 守约 / 1 数据不足', r.reviewed_n === 3 && r.violated_n === 1 && r.compliant_n === 1 && r.missing_n === 1, JSON.stringify(r));
  check('涨幅规则：08-02 +10% 命中记违反，08-06 +1.85% 守约', r.events.find((e) => e.trade_id === 'B1')?.outcome === 'violated'
    && r.events.find((e) => e.trade_id === 'B2')?.outcome === 'compliant', JSON.stringify(r.events));
  check('涨幅规则：BBB 缺价记数据不足并保留错误码', r.events.find((e) => e.trade_id === 'B3')?.outcome === 'missing'
    && r.events.find((e) => e.trade_id === 'B3')?.code === 'E_CHANGE_PCT_MISSING', JSON.stringify(r.missing_codes));
  check('涨幅规则：enforcement=prohibit，统计文案说明违反', r.enforcement === 'prohibit' && r.status_text.includes('记违反') && r.hit_note.includes('账本记为违反'), r.status_text);
  check('汇总：违反/守约/数据不足与明细一致', out.summary.reviewed_n === 3 && out.summary.violated_n === 1 && out.summary.compliant_n === 1 && out.summary.missing_n === 1, JSON.stringify(out.summary));
}

/* ---- 守约类：卖出后 N 日内追回 → 违反；无卖出记录 → 守约 ---- */
{
  const out = buildRuleLedger({ rules: [asRule(spec('no_buy_back_within', { days: '2' }))], trades, market });
  const r = rule(out, 'no_buy_back_within');
  check('不追回：B2 距 08-05 卖出 1 个交易日 → 违反', r.violated_n === 1 && r.events.find((e) => e.trade_id === 'B2')?.outcome === 'violated', JSON.stringify(r.events));
  check('不追回：B1/B3 无更早卖出 → 守约（不是数据不足）', r.compliant_n === 2 && r.missing_n === 0, JSON.stringify(r));
}

/* ---- 提醒类：买入后窗口内卖出 → 已提醒，不计违反；找不到买入 → 数据不足 ---- */
{
  const out = buildRuleLedger({ rules: [asRule(spec('sell_within_after_buy', { days: '2' }))], trades, market });
  const r = rule(out, 'sell_within_after_buy');
  check('提醒规则：S1/S2 命中记已提醒，违反恒为 0', r.warned_n === 2 && r.violated_n === 0 && r.triggered_n === 2, JSON.stringify({ w: r.warned_n, v: r.violated_n }));
  check('提醒规则：CCC 无买入记录 → 数据不足（不伪造未命中）', r.missing_n === 1 && r.events.find((e) => e.trade_id === 'S3')?.code === 'E_BUY_HISTORY_UNCONFIRMED', JSON.stringify(r.missing_codes));
  check('提醒规则：enforcement=remind 且文案不计违反', r.enforcement === 'remind' && r.enforcement_label === '提醒规则' && r.hit_note.includes('不表示违反承诺'), r.hit_note);
}

/* ---- 范围：单个代码只复核该标的；适用范围文案沿用规则引擎 ---- */
{
  const out = buildRuleLedger({ rules: [asRule(spec('no_buy_on_surge', { threshold_pct: '5' }, { kind: 'symbol', symbol: '000001' }))], trades, market });
  const r = rule(out, 'no_buy_on_surge');
  check('范围：限定 000001 后账单中无该标的，0 复核且不猜测', r.reviewed_n === 0 && r.missing_n === 0 && r.scope_text === '仅 000001', JSON.stringify({ n: r.reviewed_n, m: r.missing_n, s: r.scope_text }));
}

/* ---- 多规则汇总、事件上限、空规则、无行情 ---- */
{
  const rules = [
    asRule(spec('no_buy_on_surge', { threshold_pct: '5' })),
    asRule(spec('no_buy_back_within', { days: '2' })),
    asRule(spec('sell_within_after_buy', { days: '2' })),
  ];
  const out = buildRuleLedger({ rules, trades, market, max_events: 3 });
  check('多规则：汇总 9 笔复核，2 违反 / 2 已提醒 / 3 守约 / 2 数据不足', out.summary.reviewed_n === 9
    && out.summary.violated_n === 2 && out.summary.warned_n === 2 && out.summary.compliant_n === 3 && out.summary.missing_n === 2, JSON.stringify(out.summary));
  check('事件：按日期倒序且受 max_events 限制', out.events.length === 3 && out.events[0].at >= out.events[1].at && out.events[1].at >= out.events[2].at, JSON.stringify(out.events.map((e) => e.at)));
  check('账本口径：声明历史复盘、不猜测、只复核当前规则', out.notes.length === 4 && out.notes[0].includes('历史复盘') && out.notes[1].includes('数据不足') && out.notes[3].includes('当前生效规则'), JSON.stringify(out.notes));
  const empty = buildRuleLedger({ rules: [], trades, market });
  check('无当前规则：空账本、不报错', empty.rules.length === 0 && empty.summary.reviewed_n === 0 && empty.events.length === 0, JSON.stringify(empty.summary));
  const noMarket = buildRuleLedger({ rules, trades, market: null });
  check('无行情：涨幅与窗口规则全部记数据不足，不抛错', noMarket.summary.missing_n === 9 && noMarket.summary.violated_n === 0, JSON.stringify(noMarket.summary));
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
if (fail > 0) process.exitCode = 1;
