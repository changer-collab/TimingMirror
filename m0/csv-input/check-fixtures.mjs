#!/usr/bin/env node
/**
 * M0 · CSV 输入候选接口 —— 合成样例校验脚本（离线校验工具）v3
 *
 * 定位：
 *  - 验证 fixtures 下样例与 *.expected.json 一致；
 *  - 覆盖已确认规则的针对性检查：Q4（超精度报错不舍入）、Q5（未知列）、Q6（整列缺失）、
 *    Q7/Q8（乱序/同日稳定排序、前导零）、O1（错误汇总+整批阻断）、O2（BOM/CRLF）、
 *    O3（超卖/逐标的隔离/期末持仓）、A/A′ 回归；
 *  - 对手算预期做算术复核（PRD:137-146 纯公式；费用/税费不计入——Q1）。
 * 边界：
 *  - 非产品解析器、非产品计算引擎；产品实现见 M1-C2 / M1-C3；
 *  - 脚本内部容差（金额 ≤0.005 元、收益率相对 1e-9）≠ 正式复核接口容差（尚未冻结）。
 * 运行：node m0/csv-input/check-fixtures.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) }); };
const nearRate = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const nearMoney = (a, b) => Math.abs(a - b) <= 0.005; // 1 分
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const fmt = {
  money: (v) => '¥' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  ret: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`,
  pp: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`,
};

const EXPECTED_HEADER = ['日期', '标的', '方向', '价格', '数量', '费用', '税费'];
const REQUIRED_COLUMNS = ['日期', '标的', '方向', '价格', '数量'];
const KNOWN_COLUMNS = new Set(EXPECTED_HEADER);
const MONEY_KEYS = ['buyCost', 'heldShares', 'actualValue', 'ghostValue', 'dragMoney'];
const RATE_KEYS = ['actualRet', 'ghostRet', 'drag'];
const PORTFOLIO_KEYS = ['buyCost', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'];

function parseCsvFile(relPath) {
  const text = readFileSync(join(FX, relPath), 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return {
    name: relPath,
    header: lines[0].split(',').map((s) => s.trim()),
    rows: lines.slice(1).map((raw, i) => ({ line: i + 2, cells: raw.split(',').map((s) => s.trim()) })),
  };
}

const isNumeric = (s) => /^-?\d+(\.\d+)?$/.test(s);
const trimTrailingFractionZeros = (s) => String(s).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const overPrecision = (s) => /\.\d{3,}$/.test(trimTrailingFractionZeros(s));

/* O3：按日期升序、同日原始行号稳定排序后，逐标的累计校验 */
function quantityCheck(trades) {
  const errs = [];
  const sorted = [...trades].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.source.line - b.source.line);
  const acc = {};
  for (const t of sorted) {
    const a = (acc[t.symbol] ??= { buy: 0, sell: 0 });
    if (t.side === 'buy') a.buy += t.quantity; else a.sell += t.quantity;
    if (a.sell > a.buy) errs.push({ line: t.source.line, code: 'E_QTY_EXCEEDS', message: `任一时点累计卖出超过累计买入（标的 ${t.symbol}；v1 不支持缺少期初持仓的截断账单）` });
  }
  return errs;
}

function normalize(parsed) {
  const validTrades = []; const warnings = []; const errors = [];
  const idx = {};
  parsed.header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });

  const missingRequired = REQUIRED_COLUMNS.filter((h) => !(h in idx));
  if (missingRequired.length) {
    errors.push({ line: 1, code: 'E_HEADER_MISSING', message: `缺少必需列：${missingRequired.join('、')}` });
    return { trades: [], warnings, errors, blocked: true };
  }
  const feeColAbsent = !('费用' in idx);
  const taxColAbsent = !('税费' in idx);
  if (feeColAbsent) warnings.push({ line: 1, column: '费用', code: 'W_FEE_COLUMN_MISSING', message: '费用列缺失：全部记录按 0 计（产品层需标注，F-4；Q6）' });
  if (taxColAbsent) warnings.push({ line: 1, column: '税费', code: 'W_TAX_COLUMN_MISSING', message: '税费列缺失：全部记录按 0 计（产品层需标注，F-4；Q6）' });
  parsed.header.forEach((h) => {
    if (!KNOWN_COLUMNS.has(h)) warnings.push({ line: 1, column: h, code: 'W_UNKNOWN_COLUMN', message: `未知列已忽略：${h}（Q5）` });
  });

  parsed.rows.forEach(({ line, cells }, rowIdx) => {
    const get = (h) => (h in idx ? (cells[idx[h]] ?? '') : '');
    const d = get('日期'); const s = get('标的'); const sideRaw = get('方向');
    const pRaw = get('价格'); const qRaw = get('数量');
    const feeRaw = feeColAbsent ? '' : get('费用');
    const taxRaw = taxColAbsent ? '' : get('税费');
    const errs = [];

    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errs.push(['E_DATE_FORMAT', `日期：${d}`]);
    if (!/^\d{6}$/.test(s)) errs.push(['E_SYMBOL_FORMAT', `标的（须 6 位数字代码）：${s}`]);
    const side = sideRaw === '买入' ? 'buy' : sideRaw === '卖出' ? 'sell' : null;
    if (!side) errs.push(['E_SIDE_VALUE', `方向：${sideRaw}`]);
    if (!isNumeric(pRaw) || Number(pRaw) <= 0) errs.push(['E_PRICE_VALUE', `价格：${pRaw}`]);
    else if (overPrecision(pRaw)) errs.push(['E_PRICE_PRECISION', `价格超 2 位有效小数（尾随零不计，不自动舍入，需修正后重新导入）：${pRaw}`]);
    if (!/^\d+$/.test(qRaw) || Number(qRaw) <= 0) errs.push(['E_QTY_INTEGER', `数量：${qRaw}`]);
    for (const [field, raw] of [['费用', feeRaw], ['税费', taxRaw]]) {
      if (raw === '') continue;
      if (!isNumeric(raw) || Number(raw) < 0) errs.push(['E_MONEY_VALUE', `${field}：${raw}`]);
      else if (overPrecision(raw)) errs.push(['E_MONEY_PRECISION', `${field}超 2 位有效小数（尾随零不计，不自动舍入，需修正后重新导入）：${raw}`]);
    }

    if (errs.length) { errs.forEach(([code, message]) => errors.push({ line, code, message })); return; }

    const feeMissing = feeColAbsent || feeRaw === '';
    const taxMissing = taxColAbsent || taxRaw === '';
    if (!feeColAbsent && feeRaw === '') warnings.push({ line, code: 'W_FEE_MISSING_AS_ZERO', message: '费用缺失，按 0 计（产品层需标注，F-4）' });
    if (!taxColAbsent && taxRaw === '') warnings.push({ line, code: 'W_TAX_MISSING_AS_ZERO', message: '税费缺失，按 0 计（产品层需标注，F-4）' });

    validTrades.push({
      trade_id: `T${String(rowIdx + 1).padStart(3, '0')}`,
      trade_date: d, symbol: s, side,
      price: Number(pRaw), quantity: Number(qRaw),
      fee: feeMissing ? 0 : Number(feeRaw),
      tax: taxMissing ? 0 : Number(taxRaw),
      fee_missing: feeMissing, tax_missing: taxMissing,
      source: { file: parsed.name, line },
    });
  });

  quantityCheck(validTrades).forEach((e) => errors.push(e)); // O3：与格式错误汇总（O1 不首错即停）
  const blocked = errors.length > 0;
  return { trades: blocked ? [] : validTrades, warnings, errors, blocked }; // O1：整批阻断，无部分结果
}

function sortedView(trades) {
  return [...trades].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.source.line - b.source.line);
}

function indicators(trades, asof) {
  const by = {};
  for (const t of trades) (by[t.symbol] ??= []).push(t);
  const per = {};
  for (const [sym, list] of Object.entries(by)) {
    let buyCost = 0; let bought = 0; let sold = 0; let proceeds = 0;
    for (const t of list) {
      if (t.side === 'buy') { buyCost += t.price * t.quantity; bought += t.quantity; }
      else { proceeds += t.price * t.quantity; sold += t.quantity; }
    }
    const held = bought - sold; const px = asof[sym];
    const actualValue = proceeds + held * px; const ghostValue = bought * px;
    per[sym] = {
      buyCost, heldShares: held, actualValue, ghostValue,
      actualRet: actualValue / buyCost - 1, ghostRet: ghostValue / buyCost - 1,
      dragMoney: ghostValue - actualValue, drag: (ghostValue - actualValue) / buyCost,
    };
  }
  const t = Object.values(per).reduce((a, v) => ({
    buyCost: a.buyCost + v.buyCost, actualValue: a.actualValue + v.actualValue, ghostValue: a.ghostValue + v.ghostValue,
  }), { buyCost: 0, actualValue: 0, ghostValue: 0 });
  const portfolio = {
    ...t,
    actualRet: t.actualValue / t.buyCost - 1, ghostRet: t.ghostValue / t.buyCost - 1,
    dragMoney: t.ghostValue - t.actualValue, drag: (t.ghostValue - t.actualValue) / t.buyCost,
  };
  return { per_stock: per, portfolio };
}

const PICK = (ind, path) => {
  const [a, b] = path.split('.');
  return a === 'portfolio' ? ind.portfolio[b] : ind.per_stock[a][b];
};

/* ---- A) 逐文件校验：demo-bill / demo-bill-aprime ---- */
for (const [file, expFile] of [
  ['demo-bill.csv', 'demo-bill.expected.json'],
  ['demo-bill-aprime.csv', 'demo-bill-aprime.expected.json'],
]) {
  const exp = JSON.parse(readFileSync(join(FX, expFile), 'utf8'));
  const parsed = parseCsvFile(file);
  check(`${file}: 表头精确匹配候选格式`, eqArr(parsed.header, EXPECTED_HEADER), parsed.header.join('|'));

  const got = normalize(parsed);
  const asof = exp.assumptions.asof_prices;
  const ind = indicators(got.trades, asof);
  const eStd = exp.standardized;

  check(`${file}: blocked 与预期一致（false）`, got.blocked === eStd.blocked && got.blocked === false, JSON.stringify({ got: got.blocked, exp: eStd.blocked }));
  check(`${file}: 交易条数 ${eStd.trades.length}`, got.trades.length === eStd.trades.length, `${got.trades.length} vs ${eStd.trades.length}`);
  eStd.trades.forEach((e, i) => {
    const g = got.trades[i];
    const keys = ['trade_id', 'trade_date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax', 'fee_missing', 'tax_missing'];
    const bad = keys.filter((k) => e[k] !== g[k]);
    check(`${file}: ${e.trade_id} 字段一致`, bad.length === 0, `差异字段 [${bad.join(',')}]；got=${JSON.stringify(g)}`);
    check(`${file}: ${e.trade_id} source 一致`, e.source.file === g.source.file && e.source.line === g.source.line, JSON.stringify(g.source));
  });
  check(`${file}: warnings 一致`, eqArr(got.warnings, eStd.warnings), JSON.stringify(got.warnings));
  check(`${file}: errors 为空`, got.errors.length === 0 && eStd.errors.length === 0, JSON.stringify(got.errors));

  for (const sym of Object.keys(exp.expected_indicators.per_stock)) {
    const e = exp.expected_indicators.per_stock[sym]; const g = ind.per_stock[sym];
    for (const k of [...MONEY_KEYS, ...RATE_KEYS]) {
      const near = MONEY_KEYS.includes(k) ? nearMoney : nearRate;
      check(`${file}: ${sym}.${k} = ${e[k]}`, near(g[k], e[k]), `got ${g[k]}`);
    }
    check(`${file}: ${sym} 展示串一致`, e.display.actualRet === fmt.ret(g.actualRet) && e.display.ghostRet === fmt.ret(g.ghostRet)
      && e.display.dragMoney === fmt.money(g.dragMoney) && e.display.drag === fmt.pp(g.drag),
      `${fmt.ret(g.actualRet)} / ${fmt.ret(g.ghostRet)} / ${fmt.money(g.dragMoney)} / ${fmt.pp(g.drag)}`);
  }
  const eP = exp.expected_indicators.portfolio; const gP = ind.portfolio;
  for (const k of PORTFOLIO_KEYS) {
    const near = MONEY_KEYS.includes(k) ? nearMoney : nearRate;
    check(`${file}: portfolio.${k} = ${eP[k]}`, near(gP[k], eP[k]), `got ${gP[k]}`);
  }
  check(`${file}: portfolio 展示串一致`, eP.display.actualRet === fmt.ret(gP.actualRet) && eP.display.ghostRet === fmt.ret(gP.ghostRet)
    && eP.display.dragMoney === fmt.money(gP.dragMoney) && eP.display.drag === fmt.pp(gP.drag),
    `${fmt.ret(gP.actualRet)} / ${fmt.ret(gP.ghostRet)} / ${fmt.money(gP.dragMoney)} / ${fmt.pp(gP.drag)}`);
}

/* ---- B) A / A′ 回归：仅改一笔卖出价格，受影响/不变指标 ---- */
{
  const a = parseCsvFile('demo-bill.csv'); const b = parseCsvFile('demo-bill-aprime.csv');
  check('A/A′: 行数一致', a.rows.length === b.rows.length, `${a.rows.length} vs ${b.rows.length}`);
  const diffIdx = [];
  a.rows.forEach((r, i) => { if (r.cells.join('\u0001') !== b.rows[i].cells.join('\u0001')) diffIdx.push(i); });
  check('A/A′: 仅第 5 行不同', diffIdx.length === 1 && a.rows[diffIdx[0]].line === 5, JSON.stringify(diffIdx.map((i) => a.rows[i].line)));
  if (diffIdx.length === 1) {
    const ca = a.rows[diffIdx[0]].cells; const cb = b.rows[diffIdx[0]].cells;
    const cells = ca.map((v, i) => (v === cb[i] ? -1 : i)).filter((x) => x >= 0);
    check('A/A′: 仅“价格”单元格变化 110.00→115.00', cells.length === 1 && cells[0] === 3 && ca[3] === '110.00' && cb[3] === '115.00', JSON.stringify(cells));
  }

  const expAprime = JSON.parse(readFileSync(join(FX, 'demo-bill-aprime.expected.json'), 'utf8'));
  const indA = indicators(normalize(a).trades, expAprime.assumptions.asof_prices);
  const indB = indicators(normalize(b).trades, expAprime.assumptions.asof_prices);
  const delta = expAprime.delta_vs_demo_bill;
  for (const item of delta.affected) {
    const from = PICK(indA, item.path); const to = PICK(indB, item.path);
    check(`Δ ${item.path}: ${item.from} → ${item.to}（受影响）`, nearMoney(from, item.from) && nearMoney(to, item.to), `实际 ${from} → ${to}`);
  }
  for (const path of delta.unchanged) {
    const x = PICK(indA, path); const y = PICK(indB, path);
    check(`Δ ${path} 保持不变`, Math.abs(x - y) <= 0.005, `${x} vs ${y}`);
  }
}

/* ---- C) 已确认规则的针对性检查（fixtures/checks/） ---- */
{
  // Q4 + O1：超精度直接报错、不自动舍入、整批阻断
  const p = normalize(parseCsvFile('checks/over-precision.csv'));
  const pCodes = p.errors.map((e) => `${e.line}:${e.code}`);
  check('Q4 超精度：报 3 个错误且码型/行号正确', eqArr(pCodes, ['2:E_PRICE_PRECISION', '3:E_MONEY_PRECISION', '4:E_MONEY_PRECISION']), JSON.stringify(pCodes));
  check('O1 整批阻断：超精度样例无部分结果（trades 为空）', p.blocked === true && p.trades.length === 0, JSON.stringify({ blocked: p.blocked, n: p.trades.length }));
  const pMsgs = p.errors.map((e) => e.message).join('|');
  check('Q4 不自动舍入：错误信息保留原始串 96.123/5.005/1.234', pMsgs.includes('96.123') && pMsgs.includes('5.005') && pMsgs.includes('1.234'), pMsgs);

  // Q5：未知列忽略并列出列名
  const u = normalize(parseCsvFile('checks/unknown-columns.csv'));
  const unk = u.warnings.filter((w) => w.code === 'W_UNKNOWN_COLUMN').map((w) => w.column);
  check('Q5 未知列：警告列出被忽略列名 [备注, 来源]', eqArr(unk, ['备注', '来源']), JSON.stringify(unk));
  check('Q5 未知列：已知列按表头映射解析（2 条，字段正确）', u.trades.length === 2 && u.trades[0].price === 96 && u.trades[1].side === 'sell', JSON.stringify(u.trades));

  // Q6：费用/税费整列缺失 → 全 0 + 逐条标记 + 全局警告
  const m = normalize(parseCsvFile('checks/missing-fee-column.csv'));
  const mCodes = m.warnings.map((w) => w.code);
  check('Q6 整列缺失：全局警告（费用、税费各一条）', eqArr(mCodes, ['W_FEE_COLUMN_MISSING', 'W_TAX_COLUMN_MISSING']), JSON.stringify(mCodes));
  check('Q6 整列缺失：无逐条 W_*_MISSING_AS_ZERO（仅保留布尔标记）', !mCodes.includes('W_FEE_MISSING_AS_ZERO') && !mCodes.includes('W_TAX_MISSING_AS_ZERO'), JSON.stringify(mCodes));
  check('Q6 整列缺失：全 0 且 fee_missing/tax_missing=true（全部行）', m.trades.length === 2 && m.trades.every((t) => t.fee === 0 && t.tax === 0 && t.fee_missing === true && t.tax_missing === true), JSON.stringify(m.trades));

  // Q7 + Q8：乱序/同日稳定排序、source 与 trade_id 保持、前导零
  const o = parseCsvFile('checks/out-of-order.csv');
  const on = normalize(o);
  check('Q8 前导零：标的按字符串保留 001234', typeof on.trades[1].symbol === 'string' && on.trades[1].symbol === '001234', JSON.stringify(on.trades.map((t) => t.symbol)));
  check('Q7 原始顺序：trade_id/source 按文件行序（T001…T004 / line 2…5）',
    eqArr(on.trades.map((t) => t.trade_id), ['T001', 'T002', 'T003', 'T004']) && eqArr(on.trades.map((t) => t.source.line), [2, 3, 4, 5]),
    JSON.stringify(on.trades.map((t) => [t.trade_id, t.source.line])));
  const sorted = sortedView(on.trades);
  check('Q7 排序：按日期升序、同日按原始行号稳定',
    eqArr(sorted.map((t) => `${t.trade_date}#${t.trade_id}`), ['2024-09-24#T002', '2024-09-24#T003', '2024-09-25#T004', '2024-10-08#T001']),
    JSON.stringify(sorted.map((t) => `${t.trade_date}#${t.trade_id}`)));
  check('Q7 排序不改写 source/trade_id（保持原始引用与行号）',
    sorted.every((t) => t === on.trades.find((x) => x.trade_id === t.trade_id)) && eqArr(sorted.map((t) => t.source.line), [3, 4, 5, 2]),
    JSON.stringify(sorted.map((t) => t.source.line)));
  const asofOO = { '001234': 55, '000000': 100 };
  const i1 = indicators(on.trades, asofOO); const i2 = indicators(sorted, asofOO);
  const same = PORTFOLIO_KEYS.every((k) =>
    (MONEY_KEYS.includes(k) ? nearMoney : nearRate)(i1.portfolio[k], i2.portfolio[k]));
  check('Q7 计算与行序无关（文件序 vs 排序视图结果一致）', same, JSON.stringify([i1.portfolio, i2.portfolio]));

  // O1：错误汇总（多类错误全部列出，不首错即停）+ 整批阻断
  const agg = normalize(parseCsvFile('checks/error-aggregation.csv'));
  const aggCodes = agg.errors.map((e) => `${e.line}:${e.code}`);
  check('O1 错误汇总：3 类错误全部列出（日期/方向/价格）', eqArr(aggCodes, ['2:E_DATE_FORMAT', '3:E_SIDE_VALUE', '4:E_PRICE_VALUE']), JSON.stringify(aggCodes));
  check('O1 整批阻断：合法行也不产出（无部分结果）', agg.blocked === true && agg.trades.length === 0, JSON.stringify({ blocked: agg.blocked, n: agg.trades.length }));

  // O3：超卖 → E_QTY_EXCEEDS 整批阻断
  const ov = normalize(parseCsvFile('checks/oversell.csv'));
  const ovCodes = ov.errors.map((e) => `${e.line}:${e.code}`);
  check('O3 超卖：任一时点累计卖出>累计买入 → E_QTY_EXCEEDS（行号=触发卖出行）', eqArr(ovCodes, ['3:E_QTY_EXCEEDS']), JSON.stringify(ovCodes));
  check('O3 超卖：整批阻断', ov.blocked === true && ov.trades.length === 0, JSON.stringify({ blocked: ov.blocked, n: ov.trades.length }));

  // O3：跨标的隔离（池化合并实现会漏检，逐标的必须命中）
  const cs = normalize(parseCsvFile('checks/cross-symbol.csv'));
  const csCodes = cs.errors.map((e) => `${e.line}:${e.code}`);
  check('O3 跨标的隔离：仅 001234 超卖命中（池化实现会漏检）', eqArr(csCodes, ['4:E_QTY_EXCEEDS']), JSON.stringify(csCodes));

  // 期末未卖持仓：允许（Q3 确认口径）
  const ep = normalize(parseCsvFile('checks/end-position.csv'));
  check('期末持仓：允许期末未卖持仓（无错误、不阻断、3 条交易）', ep.errors.length === 0 && ep.blocked === false && ep.trades.length === 3, JSON.stringify({ errors: ep.errors, blocked: ep.blocked, n: ep.trades.length }));

  // O2：BOM + CRLF 解析（夹具由 demo-bill 内容转换生成）
  const bom = normalize(parseCsvFile('checks/bom-crlf.csv'));
  check('O2 BOM/CRLF：表头解析无未知列（BOM 已剥离）', bom.warnings.filter((w) => w.code === 'W_UNKNOWN_COLUMN').length === 0, JSON.stringify(bom.warnings));
  check('O2 BOM/CRLF：5 条交易、T004 费用缺失标记与来源正确', bom.trades.length === 5 && bom.trades[3].fee_missing === true && bom.trades[3].source.line === 5 && bom.trades[3].source.file === 'checks/bom-crlf.csv', JSON.stringify(bom.trades.map((t) => [t.trade_id, t.fee_missing])));
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
