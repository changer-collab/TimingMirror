#!/usr/bin/env node
/**
 * M1-C4 单笔反事实（src/engine/counterfactual.js）—— 产品侧单元测试 v1
 *
 * 定位：case-2 手算复算（替换 T003 → +14.8%、补救 +9.1pp、剩余 ¥75.00）、序列末日＝cfValue＝2,525.00、
 *       替换笔不引入假设价格、红缺口符号（含负补救边界）、S3 买入侧明确拒答、缺价不回落（B4）。
 * 边界：多标的补救%基数未定义（候选项，未实现）；S3 属 C1 未定，仅断言抛错。
 * 运行：node tests/counterfactual.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replaceSell } from '../src/engine/counterfactual.js';
import { createMarketCache, fromFixtures } from '../src/engine/marketCache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

/* ---- case-2：S1 单笔替换复算 + 序列（含缺价日不回落） ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const sym = fx.inputs.symbol;
  const cache = createMarketCache({
    tradingDays: fx.inputs.calendar,
    range: { start: fx.inputs.calendar[0], end: fx.inputs.calendar[fx.inputs.calendar.length - 1] },
    symbols: { [sym]: { bars: fx.inputs.bars } },
  });
  const closeOf = (d) => cache.getClose(sym, d);
  const effectiveDate = cache.resolveValuation(fx.inputs.requested_date).effective_date;
  const snapshot = JSON.stringify(fx.inputs.trades);
  const r = replaceSell({ symbol: sym, trades: fx.inputs.trades, tradeId: 'T003', effectiveDate, closeOf, tradingDays: cache.tradingDays });
  check('case-2：替换后输入交易未被修改', JSON.stringify(fx.inputs.trades) === snapshot, '');

  const exp = fx.expected.replace_T003;
  const rep = r.replace;
  check('case-2：被替换笔定位 = T003（sell 100 @ 11.00，2024-09-26）', rep.replaced.trade_id === 'T003' && rep.replaced.price === 11 && rep.replaced.quantity === 100 && rep.replaced.trade_date === '2024-09-26', JSON.stringify(rep.replaced));
  check('case-2：cf_sellProceeds = 575.00（仅取消该笔卖出金额 1,100.00）', near(rep.cf_sellProceeds, exp.cf_sellProceeds), rep.cf_sellProceeds);
  check('case-2：cf_heldShares = 150（= 50 + 100）', rep.cf_heldShares === exp.cf_heldShares, rep.cf_heldShares);
  check('case-2：cfValue = 2,525.00', near(rep.cfValue, exp.cfValue), rep.cfValue);
  check('case-2：cfRet = +14.7727…%', near(rep.cfRet, exp.cfRet), rep.cfRet);
  check('case-2：替换补救 = 200.00（= 1/11 = +9.0909pp）', near(rep.recoveredMoney, exp.recoveredMoney) && near(rep.recoveredPP, exp.recoveredPP), `${rep.recoveredMoney}/${rep.recoveredPP}`);
  check('case-2：替换后剩余损耗 = 75.00', near(rep.remainingDragMoney, exp.remainingDragMoney), rep.remainingDragMoney);
  check('case-2：display cfRet = +14.8%；recoveredPP = +9.1pp；remainingDragMoney = ¥75.00', rep.display.cfRet === exp.display.cfRet && rep.display.recoveredPP === exp.display.recoveredPP && rep.display.remainingDragMoney === exp.display.remainingDragMoney, JSON.stringify(rep.display));
  check('case-2：display cfValue = ¥2,525.00', rep.display.cfValue === '¥2,525.00', rep.display.cfValue);

  // 恒等：补救 = 被替换笔逐笔损耗；剩余 = 其余逐笔损耗；合计 = 总损耗（与 indicators 的 drag_lines 同口径）
  const lineT003 = fx.expected.per_trade_drag.find((x) => x.trade_id === 'T003');
  const lineT004 = fx.expected.per_trade_drag.find((x) => x.trade_id === 'T004');
  check('case-2：补救 = 被替换笔逐笔损耗（100×(13.00−11.00) = 200）且不引入假设价格', near(rep.recoveredMoney, lineT003.dragMoney), `${rep.recoveredMoney}/${lineT003.dragMoney}`);
  check('case-2：剩余损耗 = 其余逐笔损耗（T004 = 75）', near(rep.remainingDragMoney, lineT004.dragMoney), `${rep.remainingDragMoney}/${lineT004.dragMoney}`);
  check('case-2：补救 + 剩余 = 总损耗（200 + 75 = 275 = ghostValue − actualValue）', near(rep.recoveredMoney + rep.remainingDragMoney, rep.ghostValue - rep.actualValue), rep.recoveredMoney + rep.remainingDragMoney);

  const s = r.series;
  check('case-2：序列起点/终点 = 2024-09-24 → 2024-09-30（5 个交易日）', s.start === '2024-09-24' && s.end === '2024-09-30' && s.points.length === 5, `${s.start}→${s.end}/${s.points.length}`);
  check('case-2：缺价日（09-24、09-25 无 close）不回落——各值为 null 并记录', !s.complete && eqArr(s.missing_dates, ['2024-09-24', '2024-09-25']) && s.points[0].close === null && s.points[0].actual === null && s.points[0].cf === null, JSON.stringify(s.missing_dates));
  const p26 = s.points.find((p) => p.date === '2024-09-26');
  check('case-2：09-26 点（手算 2,260 / 2,320 / 2,320，gap = 60）', near(p26.actual, 2260) && near(p26.ghost, 2320) && near(p26.cf, 2320) && near(p26.gap, 60), JSON.stringify(p26));
  const p27 = s.points.find((p) => p.date === '2024-09-27');
  check('case-2：09-27 点（手算 2,235 / 2,240 / 2,255，gap = 20）', near(p27.actual, 2235) && near(p27.ghost, 2240) && near(p27.cf, 2255) && near(p27.gap, 20), JSON.stringify(p27));
  const last = s.points[s.points.length - 1];
  check('case-2：序列末日断言——actual = 2,325 / ghost = 2,600 / cf = 2,525（= cfValue）', near(last.actual, rep.actualValue) && near(last.ghost, rep.ghostValue) && near(last.cf, rep.cfValue) && near(last.cf, 2525), JSON.stringify(last));
  check('case-2：末日 gap = 红缺口 = 补救 200（cf − actual）', near(last.gap, rep.recoveredMoney), last.gap);

  check('case-2：替换买入笔（T001）→ 抛错（S3/C1 未定义，不猜测）', throws(() => replaceSell({ symbol: sym, trades: fx.inputs.trades, tradeId: 'T001', effectiveDate, closeOf, tradingDays: cache.tradingDays })), '');
  check('case-2：未知 trade_id → 抛错', throws(() => replaceSell({ symbol: sym, trades: fx.inputs.trades, tradeId: 'T999', effectiveDate, closeOf, tradingDays: cache.tradingDays })), '');
  check('case-2：估值日不在交易日历 → 抛错', throws(() => replaceSell({ symbol: sym, trades: fx.inputs.trades, tradeId: 'T003', effectiveDate: '2024-09-28', closeOf, tradingDays: cache.tradingDays })), '');
  check('case-2：估值日缺价 → 抛错（不回落 B4）', throws(() => replaceSell({ symbol: sym, trades: fx.inputs.trades, tradeId: 'T003', effectiveDate: '2024-10-08', closeOf, tradingDays: cache.tradingDays })), '');
}

/* ---- 链路：合成缓存 → 反事实（负补救边界：卖价高于估值日 close） ---- */
{
  const calendar = load('m0/market-cache/fixtures/mock-calendar.json');
  const bars = load('m0/market-cache/fixtures/mock-daily-bars.json');
  const cache = createMarketCache(fromFixtures(calendar, bars));
  const effectiveDate = cache.resolveValuation('2024-10-03').effective_date;
  const closeOf = (d) => cache.getClose('000000', d);
  const trades = [
    { trade_id: 'X1', trade_date: '2024-09-25', side: 'buy', price: 100, quantity: 100 },
    { trade_id: 'X2', trade_date: '2024-09-27', side: 'sell', price: 110, quantity: 50 },
  ];
  const r = replaceSell({ symbol: '000000', trades, tradeId: 'X2', effectiveDate, closeOf, tradingDays: cache.tradingDays });

  const s = r.series;
  check('链路：序列完整（09-25 → 09-30，4 个交易日，无缺价）', s.complete === true && s.points.length === 4 && s.points[0].date === '2024-09-25' && s.points[3].date === '2024-09-30', JSON.stringify(s.missing_dates));
  const first = s.points[0];
  check('链路：首日（09-25）两路径相同（替换笔尚未发生）actual = ghost = cf = 9,700', near(first.actual, 9700) && near(first.ghost, 9700) && near(first.cf, 9700) && near(first.gap, 0), JSON.stringify(first));
  const p27 = s.points.find((p) => p.date === '2024-09-27');
  check('链路：09-27 红缺口 = −500（卖价 110 高于当日 close 100，替换后更差）', near(p27.actual, 10500) && near(p27.cf, 10000) && near(p27.gap, -500), JSON.stringify(p27));
  const last = s.points[3];
  check('链路：末日 cf = ghost = 10,400（全部卖出被替换 ⇒ 等价买入不动）', near(last.cf, 10400) && near(last.ghost, 10400), `${last.cf}/${last.ghost}`);
  check('链路：负补救 recoveredMoney = −300.00；剩余损耗 = 0', near(r.replace.recoveredMoney, -300) && near(r.replace.remainingDragMoney, 0), `${r.replace.recoveredMoney}/${r.replace.remainingDragMoney}`);
  check('链路：display cfRet = +4.0%；recoveredPP = -3.0pp', r.replace.display.cfRet === '+4.0%' && r.replace.display.recoveredPP === '-3.0pp', `${r.replace.display.cfRet}/${r.replace.display.recoveredPP}`);
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
