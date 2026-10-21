#!/usr/bin/env node
/**
 * PGR/PLR 处置效应候选口径（src/engine/pgr.js）单元测试。
 * 覆盖：移动加权平均成本、已实现/纸面盈亏计数、PGR/PLR/DE、零盈亏忽略、超卖阻断。
 */
import { computePGR, PGR_BENCHMARKS } from '../src/engine/pgr.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12;

{
  const trades = [
    { trade_id: 'B1', trade_date: '2024-01-02', symbol: 'AAA', side: 'buy', price: 10, quantity: 100 },
    { trade_id: 'S1', trade_date: '2024-01-03', symbol: 'AAA', side: 'sell', price: 12, quantity: 50 },
    { trade_id: 'B2', trade_date: '2024-01-04', symbol: 'AAA', side: 'buy', price: 20, quantity: 100 },
    { trade_id: 'S2', trade_date: '2024-01-05', symbol: 'AAA', side: 'sell', price: 15, quantity: 50 },
  ];
  const r = computePGR({ trades, closes: { AAA: 18 } });
  check('计数：已实现盈利 1 / 亏损 1，纸面盈利 1', r.ok && r.counts.realized.gain === 1 && r.counts.realized.loss === 1 && r.counts.paper.gain === 1 && r.counts.paper.loss === 0, JSON.stringify(r.counts));
  check('PGR = 1/(1+1) = 0.50', near(r.pgr, 0.5) && r.display.pgr === '0.50', JSON.stringify({ pgr: r.pgr, display: r.display }));
  check('PLR = 1/(1+0) = 1.00', near(r.plr, 1) && r.display.plr === '1.00', JSON.stringify({ plr: r.plr }));
  check('DE = PGR − PLR = −0.50', near(r.de, -0.5) && r.display.de === '-0.50', JSON.stringify({ de: r.de }));
  check('基准：中国 1.64 / 美国 1.51 且带来源', PGR_BENCHMARKS.cn.value === 1.64 && PGR_BENCHMARKS.us.value === 1.51 && r.benchmarks.cn.source.includes('2005'), JSON.stringify(r.benchmarks));
}

{
  const trades = [
    { trade_id: 'B1', trade_date: '2024-01-02', symbol: 'AAA', side: 'buy', price: 10, quantity: 100 },
    { trade_id: 'S1', trade_date: '2024-01-03', symbol: 'AAA', side: 'sell', price: 10, quantity: 50 },
  ];
  const r = computePGR({ trades, closes: { AAA: 10 } });
  check('零盈亏：不计入 gain/loss，计数为 flat', r.counts.realized.flat === 1 && r.counts.realized.gain === 0 && r.counts.realized.loss === 0 && r.counts.paper.flat === 1, JSON.stringify(r.counts));
  check('零盈亏：PGR/PLR 无分母 → null，不伪造 0 或 1', r.pgr === null && r.plr === null && r.de === null && r.display.pgr === '—', JSON.stringify(r.display));
}

{
  const trades = [
    { trade_id: 'B1', trade_date: '2024-01-02', symbol: 'AAA', side: 'buy', price: 10, quantity: 50 },
    { trade_id: 'S1', trade_date: '2024-01-03', symbol: 'AAA', side: 'sell', price: 12, quantity: 100 },
  ];
  const r = computePGR({ trades, closes: { AAA: 11 } });
  check('超卖：阻断并不发布 PGR/PLR', r.ok === false && r.status === 'blocked' && r.pgr === null && r.errors.some((e) => e.code === 'E_PGR_OVERSOLD'), JSON.stringify(r.errors));
}

{
  const trades = [{ trade_id: 'B1', trade_date: '2024-01-02', symbol: 'AAA', side: 'buy', price: 10, quantity: 100 }];
  const r = computePGR({ trades, closes: { AAA: null } });
  check('持仓缺价：纸面盈亏无法计数 → 阻断', r.ok === false && r.errors.some((e) => e.code === 'E_PGR_MISSING_CLOSE'), JSON.stringify(r.errors));
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
