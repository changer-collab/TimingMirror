#!/usr/bin/env node
/**
 * 标的自身涨幅候选口径（src/engine/stockSelf.js）单元测试。
 * 覆盖：首次买入日收盘 → 估值日收盘、买入成本加权、部分缺价不发布组合值、确定性。
 */
import { computeStockSelf, STOCK_SELF_FORMULA } from '../src/engine/stockSelf.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12;

const calendar = ['2024-01-02', '2024-02-01', '2024-12-31'];
const closes = {
  AAA: { '2024-01-02': 10, '2024-02-01': 12, '2024-12-31': 15 },
  BBB: { '2024-01-02': 20, '2024-02-01': 18, '2024-12-31': 10 },
};
const closeOf = (symbol, date) => closes[symbol]?.[date] ?? null;
const resolveDate = (date) => (calendar.includes(date) ? { blocked: false, effective_date: date } : { blocked: true, code: 'E_NOT_IN_CALENDAR' });

const trades = [
  { trade_id: 'A1', trade_date: '2024-01-02', symbol: 'AAA', side: 'buy', price: 10, quantity: 100 },
  { trade_id: 'A2', trade_date: '2024-02-01', symbol: 'AAA', side: 'buy', price: 12, quantity: 100 },
  { trade_id: 'A3', trade_date: '2024-02-01', symbol: 'AAA', side: 'sell', price: 13, quantity: 50 },
  { trade_id: 'B1', trade_date: '2024-01-02', symbol: 'BBB', side: 'buy', price: 20, quantity: 50 },
];

{
  const r = computeStockSelf({ trades, closeOf, resolveDate, valuationDate: '2024-12-31' });
  check('组合：完整覆盖时 status=complete', r.status === 'complete' && r.coverage.complete === true, JSON.stringify(r.coverage));
  const aaa = r.per_symbol.find((x) => x.symbol === 'AAA');
  const bbb = r.per_symbol.find((x) => x.symbol === 'BBB');
  check('AAA：首次买入日收盘 10 → 估值日 15 = +50.0%', near(aaa.ret, 0.5) && aaa.display.ret === '+50.0%', JSON.stringify(aaa));
  check('BBB：首次买入日收盘 20 → 估值日 10 = −50.0%', near(bbb.ret, -0.5) && bbb.display.ret === '-50.0%', JSON.stringify(bbb));
  const weighted = (2200 * 0.5 + 1000 * -0.5) / 3200;
  check('组合：按买入成本加权（不是等权）', near(r.ret, weighted) && r.display.ret === '+18.8%', JSON.stringify({ ret: r.ret, display: r.display }));
  check('口径声明：候选补充口径、未进入复核发布', r.formula.formula_id === STOCK_SELF_FORMULA.formula_id && r.formula.status.includes('候选') && r.formula.notes.some((n) => n.includes('不等于“买入不动”')), JSON.stringify(r.formula));
  check('确定性：同输入两次一致', JSON.stringify(r) === JSON.stringify(computeStockSelf({ trades, closeOf, resolveDate, valuationDate: '2024-12-31' })), '');
}

{
  const partial = computeStockSelf({
    trades: [...trades, { trade_id: 'C1', trade_date: '2024-01-02', symbol: 'CCC', side: 'buy', price: 8, quantity: 100 }],
    closeOf,
    resolveDate,
    valuationDate: '2024-12-31',
  });
  check('部分缺价：status=partial，组合值不发布（ret=null）', partial.status === 'partial' && partial.ret === null && partial.display.ret === '—', JSON.stringify({ status: partial.status, ret: partial.ret }));
  check('部分缺价：仍保留可用标的与覆盖率', partial.per_symbol.find((x) => x.symbol === 'AAA').available === true && near(partial.coverage.covered_buy_cost / partial.coverage.total_buy_cost, 3200 / 4000), JSON.stringify(partial.coverage));
  check('部分缺价：原因可回源到标的', partial.reasons.some((s) => s.includes('CCC') && s.includes('缺价')), JSON.stringify(partial.reasons));
}

{
  const missingFirst = computeStockSelf({ trades: [{ ...trades[0], trade_date: '2023-12-31' }], closeOf, resolveDate, valuationDate: '2024-12-31' });
  check('首次买入日不可解析：不静默改期，标的不可用', missingFirst.status === 'partial' && missingFirst.per_symbol[0].reason.includes('无可解析估值日'), JSON.stringify(missingFirst));
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
