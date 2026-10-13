#!/usr/bin/env node
/**
 * M2-C5 区间界关系证明/证伪（B）—— 测试记录（配合 docs/yinchen/m2c5-bound-relations.md 报告）
 *
 * 定位：在 S1/S2/S4（可定义部分）与 V1/V2（变体）上数值检验界关系：
 *   T1 R1(i) = 逐笔损耗 d_i（与实现 replaceSell 交叉一致）；
 *   T2 条件界关系（批次内逐笔损耗 ≥ 0 → 0 ≤ R1 ≤ R2a ≤ R2b ≤ R4，剩余 L 反向；端点 actual+R=ghost）；
 *   T3/T4 证伪：去掉符号条件，R1 ≤ R2、标的级 ≤ 组合级 均不普遍成立（反例断言不等号方向）；
 *   V2 假设依赖：两个再投资假设臂下 V2 与 V1 的差符号翻转 → V1–V2 无条件区间不可证；
 *   S3（C1 未定义）与 S4 语义二义性：留待负责人，不入无条件区间。
 * 边界：本文件为证明/证伪的**测试记录**（M2-C5 交付物之一），不实现产品侧批量替换（S2 语义未冻结）；
 *       反例/臂均用合成构造，数字为整数友好手算值。
 * 运行：node tests/bound-relations.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeIndicators } from '../src/engine/indicators.js';
import { replaceSell } from '../src/engine/counterfactual.js';
import { createMarketCache } from '../src/engine/marketCache.js';
import { parseCsvText, normalizeRows } from '../src/engine/csvNormalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const readText = (rel) => readFileSync(join(REPO, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const mk = (trade_id, trade_date, symbol, side, price, quantity, line) => ({
  trade_id, trade_date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  source: { file: 'bound-relations-synthetic.csv', line },
});
const linesOf = (report, sym) => (report.per_stock[sym].drag_lines ?? []).map((l) => l.dragMoney);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/* ---- T1：R1(i) = 逐笔损耗 d_i（case-2 手算 + 与 replaceSell 实现交叉一致） ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const sym = fx.inputs.symbol;
  const trades = fx.inputs.trades.map((t, i) => ({ ...t, symbol: sym, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'm0/calc-baseline/fixtures/case-2-single-replace.json', line: 2 + i } }));
  const closes = { [sym]: fx.expected.close_unadj };
  const report = computeIndicators({ trades, closes });
  const lines = report.per_stock[sym].drag_lines;
  check('T1：R1(i) = d_i（case-2：T003=200、T004=75；Σd = 275 = 总损耗）', lines.length === 2 && near(lines.find((l) => l.trade_id === 'T003').dragMoney, 200) && near(lines.find((l) => l.trade_id === 'T004').dragMoney, 75) && near(sum(linesOf(report, sym)), report.per_stock[sym].dragMoney), JSON.stringify(lines));

  const cache = createMarketCache({
    tradingDays: fx.inputs.calendar,
    range: { start: fx.inputs.calendar[0], end: fx.inputs.calendar[fx.inputs.calendar.length - 1] },
    symbols: { [sym]: { bars: fx.inputs.bars } },
  });
  const closeOf = (d) => cache.getClose(sym, d);
  const effectiveDate = cache.resolveValuation(fx.inputs.requested_date).effective_date;
  const rep = replaceSell({ symbol: sym, trades, tradeId: 'T003', effectiveDate, closeOf, tradingDays: cache.tradingDays });
  check('T1：形式化与实现一致（replaceSell 补救额 = 该行 d_i = 200；不引入假设价格）', near(rep.replace.recoveredMoney, 200) && near(rep.replace.recoveredMoney, lines.find((l) => l.trade_id === 'T003').dragMoney), JSON.stringify({ r: rep.replace.recoveredMoney }));
}

/* ---- T2：条件界关系（批次内逐笔损耗 ≥ 0） ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const sym = fx.inputs.symbol;
  const trades = fx.inputs.trades.map((t, i) => ({ ...t, symbol: sym, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'fx', line: 2 + i } }));
  const closes = { [sym]: fx.expected.close_unadj };
  const report = computeIndicators({ trades, closes });
  const lines = report.per_stock[sym].drag_lines;
  const D = report.per_stock[sym].dragMoney;
  const R1 = lines.find((l) => l.trade_id === 'T003').dragMoney;
  const R2b = sum(lines.map((l) => l.dragMoney));
  const R4 = report.portfolio.dragMoney; // 单标的：R2b = R4
  check('T2：case-2 全部 d ≥ 0 → 0 ≤ R1(200) ≤ R2b(275) = R4（链式界关系）', lines.every((l) => l.dragMoney >= 0) && 0 <= R1 && R1 <= R2b && near(R2b, R4), JSON.stringify({ R1, R2b, R4 }));
  check('T2：剩余损耗反向（D=275 ≥ L1=75 ≥ L2b=0）', near(D - R1, 75) && near(D - R2b, 0) && D >= D - R1 && D - R1 >= D - R2b, JSON.stringify({ D, L1: D - R1, L2: D - R2b }));
  check('T2：端点恒等——actual + R2b = ghost（2,325 + 275 = 2,600）', near(report.per_stock[sym].actualValue + R2b, report.per_stock[sym].ghostValue), '');

  // 同日批次（S2a 候选语义）：同标的同日两笔卖出，d=+100 与 +150 → R2a = 250 ≥ R1
  const sameDay = [
    mk('T001', '2024-09-02', '000000', 'buy', 10, 200, 2),
    mk('T002', '2024-09-03', '000000', 'sell', 11, 100, 3),
    mk('T003', '2024-09-03', '000000', 'sell', 10.5, 100, 4),
  ];
  const r2 = computeIndicators({ trades: sameDay, closes: { '000000': 12 } });
  const l2 = r2.per_stock['000000'].drag_lines;
  const R2a = sum(l2.filter((l) => l.trade_date === '2024-09-03').map((l) => l.dragMoney));
  check('T2：同日批次候选语义（S2a）——R2a = 100 + 150 = 250 ≥ 任一同日单笔 R1', near(sum(l2.map((l) => l.dragMoney)), 250) && near(R2a, 250) && R2a >= 100, JSON.stringify(l2.map((l) => l.dragMoney)));

  const normA = normalizeRows(parseCsvText(readText('m0/csv-input/fixtures/demo-bill.csv')), 'demo-bill.csv').trades;
  const repA = computeIndicators({ trades: normA, closes: { '000000': 125.0, '888888': 1560.0 } });
  const allLines = [...linesOf(repA, '000000'), ...linesOf(repA, '888888')];
  check('T2：多标的（demo-bill）全部 d ≥ 0 → R2b(000000)=3000 ≤ R4=3900（组合级含另一标的 +900）', allLines.every((d) => d >= 0) && near(repA.per_stock['000000'].dragMoney, 3000) && near(repA.portfolio.dragMoney, 3900) && repA.per_stock['000000'].dragMoney <= repA.portfolio.dragMoney, JSON.stringify(allLines));
}

/* ---- T3：证伪——批次内负损耗时 R1 ≤ R2 不成立（反例） ---- */
{
  const trades = [
    mk('T001', '2024-09-02', '000000', 'buy', 10, 200, 2),
    mk('T002', '2024-09-03', '000000', 'sell', 9, 100, 3), // d = 100×(11−9) = +200
    mk('T003', '2024-09-04', '000000', 'sell', 16, 100, 4), // d = 100×(11−16) = −500
  ];
  const report = computeIndicators({ trades, closes: { '000000': 11 } });
  const lines = report.per_stock['000000'].drag_lines;
  const R1 = lines.find((l) => l.trade_id === 'T002').dragMoney;
  const R2b = sum(lines.map((l) => l.dragMoney));
  const D = report.per_stock['000000'].dragMoney;
  check('T3 反例：d₂=+200、d₃=−500 → R2b = −300 < R1 = +200（“R1 ≤ R2 无条件成立”被证伪）', near(R1, 200) && near(R2b, -300) && (R1 <= R2b) === false, JSON.stringify({ R1, R2b }));
  check('T3 反例：剩余损耗 L 序同样翻转（L1 = D−R1 = −500、L2b = D−R2b = 0，0 ≤ L1 不成立）', near(D - R1, -500) && near(D - R2b, 0) && ((D - R2b) <= (D - R1)) === false, JSON.stringify({ D, L1: D - R1, L2: D - R2b }));
  check('T3 结论：负损耗笔为真实可出现情形（F-2 双向归因；counterfactual 负补救边界已另有断言）→ 无条件区间不可证', true, '');
}

/* ---- T4：证伪——标的级 ≤ 组合级不普遍成立（跨标的反例） ---- */
{
  const trades = [
    mk('T001', '2024-09-02', '000000', 'buy', 9, 100, 2),
    mk('T002', '2024-09-03', '000000', 'sell', 9, 100, 3), // A：d = 100×(11−9) = +200（d 只取决于卖出价）
    mk('T003', '2024-09-02', '888888', 'buy', 16, 100, 4),
    mk('T004', '2024-09-03', '888888', 'sell', 16, 100, 5), // B：d = 100×(11−16) = −500
  ];
  const report = computeIndicators({ trades, closes: { '000000': 11, '888888': 11 } });
  const RA = report.per_stock['000000'].dragMoney;
  const R4 = report.portfolio.dragMoney;
  check('T4 反例：R2b(A)=+200 > R4=−300（“标的级 ≤ 组合级”无条件不成立）', near(RA, 200) && near(R4, -300) && (RA <= R4) === false, JSON.stringify({ RA, R4 }));
  check('T4 一致性：R4 = Σ 标的 D（恒等式②层级化）', near(R4, report.per_stock['000000'].dragMoney + report.per_stock['888888'].dragMoney), '');
}

/* ---- V1/V2：假设依赖 → V1–V2 无条件界关系不可证（两臂差号翻转） ---- */
{
  // 实际路径：买 200@10（成本 2,000）；卖 100@12（得 1,200）；close = 11
  // V1（F-4 主口径：卖出资金不再投资、不计息）：actual = 1,200 + 100×11 = 2,300；ghost = 2,200；drag_V1 = −100
  const actualV1 = 1200 + 100 * 11;
  const ghost = 200 * 11;
  check('V1 基准（F-4）：actual=2300 / ghost=2200 / drag=−100（现金闲置不产生对照差之外的值）', near(actualV1, 2300) && near(ghost, 2200) && near(ghost - actualV1, -100), '');

  // V2 臂 A（假设：卖出当日同价 12 回购 100 股）→ 回到买入不动：value = 200×11 = 2,200 → drag_A = 0
  const armA = (100 + 1200 / 12) * 11;
  check('V2 臂 A（同日同价回购）：value=2200 → drag=0（与 V1 差 +100）', near(armA, 2200) && near(ghost - armA, 0) && (ghost - armA) - (ghost - actualV1) > 0, '');

  // V2 臂 B（假设：再投资价 10、得 120 股）→ value = (100+120)×11 = 2,420 → drag_B = −220（与 V1 差 −120）
  const armB = (100 + 1200 / 10) * 11;
  check('V2 臂 B（再投资价 10、得 120 股）：value=2420 → drag=−220（与 V1 差 −120）', near(armB, 2420) && near(ghost - armB, -220) && (ghost - armB) - (ghost - actualV1) < 0, '');
  check('V2 结论：两臂给出相反的（V2−V1）符号 → 再投资价/时点未定义（F-4 仅固定 V1），V1–V2 无条件界关系不可证；臂为演示算例、非产品实现', true, '');
}

/* ---- S3/S4：不可判定与语义二义性（留待负责人，不入无条件区间） ---- */
{
  const fx = load('m0/calc-baseline/fixtures/case-2-single-replace.json');
  const sym = fx.inputs.symbol;
  const trades = fx.inputs.trades.map((t, i) => ({ ...t, symbol: sym, fee: 0, tax: 0, fee_missing: false, tax_missing: false, source: { file: 'fx', line: 2 + i } }));
  const cache = createMarketCache({
    tradingDays: fx.inputs.calendar,
    range: { start: fx.inputs.calendar[0], end: fx.inputs.calendar[fx.inputs.calendar.length - 1] },
    symbols: { [sym]: { bars: fx.inputs.bars } },
  });
  const closeOf = (d) => cache.getClose(sym, d);
  const effectiveDate = cache.resolveValuation(fx.inputs.requested_date).effective_date;
  check('S3（C1 未定义）：买入侧替换抛错（需假设执行价）→ 排除于任何区间之外', throws(() => replaceSell({ symbol: sym, trades, tradeId: 'T001', effectiveDate, closeOf, tradingDays: cache.tradingDays })), '');

  const report = computeIndicators({ trades, closes: { [sym]: fx.expected.close_unadj } });
  const R4 = report.portfolio.dragMoney;
  check('S4 解读A（全组合卖出替换）：剩余 L4 = D − R4 = 0（端点恒等；候选解读，待负责人）', near(report.portfolio.dragMoney - R4, 0), '');
  check('S4 解读B（组合级买入不动的基准，不替换）：L = D = 275（= 现行 portfolio.dragMoney；语义二义性标注）', near(R4, 275), JSON.stringify({ R4 }));
}

/* ---- 汇总 ---- */
let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
