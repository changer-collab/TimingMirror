#!/usr/bin/env node
/**
 * 收益瀑布（src/engine/waterfall.js）单元测试。
 * 覆盖：恒等式 buyCost + ghostGain − dragMoney = actualValue、正/负损耗标签、展示串来自引擎。
 */
import { computeIndicators } from '../src/engine/indicators.js';
import { buildReturnWaterfall } from '../src/engine/waterfall.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-9;

{
  const trades = [
    { trade_id: 'T1', trade_date: '2024-09-24', symbol: '000000', side: 'buy', price: 10, quantity: 100, source: { file: 'x.csv', line: 2 } },
    { trade_id: 'T2', trade_date: '2024-09-25', symbol: '000000', side: 'sell', price: 12, quantity: 50, source: { file: 'x.csv', line: 3 } },
  ];
  const report = computeIndicators({ trades, closes: { '000000': 11 } });
  const w = buildReturnWaterfall({ report });
  check('恒等式：本金 + 买入不动收益 − 损耗 = 实际价值', w.checks.identity_ok === true && near(report.portfolio.buyCost + (report.portfolio.ghostValue - report.portfolio.buyCost) - report.portfolio.dragMoney, report.portfolio.actualValue), JSON.stringify(w.checks));
  check('四行结构：本金/买入不动收益/择时损耗/实际到手', JSON.stringify(w.items.map((i) => i.key)) === JSON.stringify(['cost', 'ghost_gain', 'drag', 'actual']), JSON.stringify(w.items.map((i) => i.key)));
  check('负损耗：标签为“择时改善”，颜色为 gain', w.items[2].label === '择时改善' && w.items[2].kind === 'gain' && near(w.items[2].amount, 50), JSON.stringify(w.items[2]));
  check('展示串来自引擎：金额带 ¥、比例带 pp/%', w.items.every((i) => i.display.amount.startsWith('¥')) && w.items[1].display.ratio.endsWith('pp') && w.items[0].display.ratio === '100%', JSON.stringify(w.items.map((i) => i.display)));
  check('边界声明：买入不动收益 ≠ 标的自身涨幅', w.notes.some((n) => n.includes('标的自身涨幅')), JSON.stringify(w.notes));
}

{
  const trades = [
    { trade_id: 'T1', trade_date: '2024-09-24', symbol: '000000', side: 'buy', price: 10, quantity: 100 },
    { trade_id: 'T2', trade_date: '2024-09-25', symbol: '000000', side: 'sell', price: 8, quantity: 100 },
  ];
  const report = computeIndicators({ trades, closes: { '000000': 11 } });
  const w = buildReturnWaterfall({ report });
  check('正损耗：标签为“择时损耗”，颜色为 loss', w.items[2].label === '择时损耗' && w.items[2].kind === 'loss' && w.items[2].amount < 0, JSON.stringify(w.items[2]));
  check('正损耗：恒等式仍成立', w.checks.identity_ok === true, '');
}

{
  let threw = false;
  try { buildReturnWaterfall({ report: { portfolio: {} } }); } catch { threw = true; }
  check('入参：缺组合指标 → 抛错', threw, '');
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
