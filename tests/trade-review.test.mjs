#!/usr/bin/env node
/**
 * 操作复盘（src/engine/tradeReview.js）：按 trade_id 聚合账本事件，区分
 * 违反 / 符合 / 无法确认 / 无此情境；画像只挂已成立模式；汇总按唯一操作计数。
 * 运行：node tests/trade-review.test.mjs
 */
import { parseRuleSpec } from '../src/engine/ruleSpec.js';
import { buildRuleLedger } from '../src/engine/ruleLedger.js';
import { buildPatternList } from '../src/engine/behavior.js';
import { buildTradeReview } from '../src/engine/tradeReview.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const DAYS = [
  '2025-02-13', '2025-02-14', '2025-02-17', '2025-02-18', '2025-02-19',
  '2025-02-20', '2025-02-21', '2025-02-24', '2025-02-25', '2025-02-26',
  '2025-02-27', '2025-02-28', '2025-03-10', '2025-03-11', '2025-03-12',
];
const CLOSES = {
  300750: {
    '2025-02-13': 269.00, '2025-02-14': 269.60, '2025-02-17': 269.40, '2025-02-18': 270.10,
    '2025-02-19': 269.80, '2025-02-20': 270.20, '2025-02-21': 269.90, '2025-02-24': 271.50,
    '2025-02-25': 269.50, '2025-02-26': 268.62, '2025-02-27': 268.90, '2025-02-28': 269.20,
    '2025-03-10': 256.50, '2025-03-11': 256.50, '2025-03-12': 254.50,
  },
};
const market = {
  tradingDays: DAYS,
  range: { start: DAYS[0], end: DAYS[DAYS.length - 1] },
  resolveValuation: (date) => {
    if (DAYS.includes(date)) return { blocked: false, effective_date: date };
    const prior = DAYS.filter((d) => d < date).pop();
    return prior ? { blocked: false, effective_date: prior } : { blocked: true, code: 'E_DATE_OUT_OF_RANGE' };
  },
  getClose: (symbol, date) => CLOSES[symbol]?.[date] ?? null,
};

const trade = (id, date, side, price, quantity) => ({ trade_id: id, trade_date: date, symbol: '300750', side, price, quantity });
const trades = [
  trade('B1', '2025-02-17', 'buy', 269.40, 200),
  trade('S1', '2025-02-24', 'sell', 271.50, 200),
  trade('B2', '2025-02-26', 'buy', 268.62, 100),
  trade('S2', '2025-03-10', 'sell', 256.50, 100),
  trade('B3', '2025-03-12', 'buy', 254.50, 100),
];

const asRule = (parsed, v = 1) => ({
  ...parsed, v, hash: parsed.hash, parsed,
  scope: parsed.scope, scope_text: parsed.scope_text,
  template_id: parsed.template_id, template_name: parsed.template_name,
  text: parsed.text, action: parsed.action,
});
const spec = (template_id, fields) => parseRuleSpec({ template_id, fields });
const rules = [
  asRule(spec('no_buy_on_surge', { threshold_pct: '10' })),
  asRule(spec('no_buy_back_within', { days: '2' })),
  asRule(spec('sell_within_after_buy', { days: '2' })),
];
const ledger = buildRuleLedger({ rules, trades, market });
const patterns = buildPatternList({ trades, market });
const review = buildTradeReview({ trades, ledger, patterns, market });
const op = (id) => review.operations.find((o) => o.trade_id === id);
const rule = (id) => review.rules.find((r) => r.template_id === id);

/* ---- 汇总：按唯一操作计数，不按规则事件计数 ---- */
check('汇总：5 笔操作，2 违背 / 1 符合 / 2 无法确认',
  review.summary.trades_n === 5 && review.summary.violated_n === 2
  && review.summary.compliant_n === 1 && review.summary.missing_n === 2,
  JSON.stringify(review.summary));
check('汇总：规则事件数（8）不等于操作数（5）',
  review.rules.reduce((n, r) => n + r.applies_n, 0) === 8 && review.summary.trades_n === 5,
  JSON.stringify(review.rules.map((r) => [r.template_id, r.applies_n])));
check('排序：操作按成交日期升序', review.operations.map((o) => o.trade_id).join(',') === 'B1,S1,B2,S2,B3',
  review.operations.map((o) => o.trade_id).join(','));

/* ---- 无前置卖出：无此情境，不是符合 ---- */
const b1 = op('B1');
const b1Back = b1.events.find((e) => e.template_id === 'no_buy_back_within');
check('无此情境：B1 的不追回事件改判 not_applicable，码 E_NO_PRIOR_SELL',
  b1Back?.outcome === 'not_applicable' && b1Back.code === 'E_NO_PRIOR_SELL', JSON.stringify(b1Back));
check('无此情境：文案明确“不计为符合”，且不把操作整体算成违规',
  b1Back?.message.includes('不计为符合') && b1.outcome === 'compliant', JSON.stringify({ msg: b1Back?.message, outcome: b1.outcome }));
check('规则统计：不追回 3 笔复核 = 2 违反 + 1 无此情境',
  rule('no_buy_back_within').applies_n === 3 && rule('no_buy_back_within').violated_n === 2
  && rule('no_buy_back_within').not_applicable_n === 1, JSON.stringify(rule('no_buy_back_within')));

/* ---- 卖出后 2 日回补：违反 + 画像习惯 ---- */
const b2 = op('B2');
const b2Back = b2.events.find((e) => e.template_id === 'no_buy_back_within');
check('违反：B2 卖出后 2 个交易日回补，操作结论 violated',
  b2.outcome === 'violated' && b2Back?.outcome === 'violated' && b2Back.fact?.distance_trading_days === 2,
  JSON.stringify({ outcome: b2.outcome, fact: b2Back?.fact }));
check('画像：B2 挂到已成立的“卖出后两日内买回”，样本 n=2',
  b2.habits.length === 1 && b2.habits[0].pattern_id === 'sell_rebuy_within_2d'
  && b2.habits[0].sample_n === 2 && b2.habits[0].prior_trade_id === 'S1', JSON.stringify(b2.habits));
check('画像：B3 同样挂到回补习惯，画像只描述不改变规则结论',
  op('B3').habits[0]?.pattern_id === 'sell_rebuy_within_2d' && op('B3').outcome === 'violated',
  JSON.stringify(op('B3').habits));

/* ---- 无法确认：提醒规则缺买入完整性依据 ---- */
check('无法确认：S1/S2 的提醒规则事件为 missing，操作结论 missing',
  op('S1').outcome === 'missing' && op('S2').outcome === 'missing'
  && op('S1').events.every((e) => e.template_id !== 'sell_within_after_buy' || e.outcome === 'missing'),
  JSON.stringify([op('S1').events, op('S2').events]));
check('规则统计：提醒规则 2 笔复核均无法确认，违反恒为 0',
  rule('sell_within_after_buy').applies_n === 2 && rule('sell_within_after_buy').missing_n === 2
  && rule('sell_within_after_buy').violated_n === 0, JSON.stringify(rule('sell_within_after_buy')));
check('画像：未成立的快进快出模式不挂到单笔卖出',
  op('S1').habits.length === 0 && op('S2').habits.length === 0, JSON.stringify([op('S1').habits, op('S2').habits]));

/* ---- 涨幅规则：全部符合 ---- */
check('涨幅规则：3 笔买入均符合，阈值 10% 未触发',
  rule('no_buy_on_surge').applies_n === 3 && rule('no_buy_on_surge').compliant_n === 3
  && rule('no_buy_on_surge').violated_n === 0, JSON.stringify(rule('no_buy_on_surge')));

/* ---- 缺行情 / 无规则：不猜测 ---- */
{
  const noMarketLedger = buildRuleLedger({ rules, trades, market: null });
  const noMarket = buildTradeReview({ trades, ledger: noMarketLedger, patterns: null, market: null });
  check('无行情：全部操作无法确认，不把缺数据算成符合',
    noMarket.summary.missing_n === 5 && noMarket.summary.compliant_n === 0
    && noMarket.summary.violated_n === 0, JSON.stringify(noMarket.summary));
  check('无画像输入：习惯为空，操作仍完整', noMarket.habits.length === 0 && noMarket.operations.length === 5,
    JSON.stringify({ habits: noMarket.habits.length, ops: noMarket.operations.length }));
}

{
  const plain = buildTradeReview({ trades, ledger: buildRuleLedger({ rules: [], trades, market }), patterns: null, market });
  check('无生效规则：每笔操作标为未参与复核，不伪造符合',
    plain.summary.no_rule_n === 5 && plain.summary.compliant_n === 0 && plain.rules.length === 0,
    JSON.stringify(plain.summary));
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
if (fail > 0) process.exitCode = 1;
