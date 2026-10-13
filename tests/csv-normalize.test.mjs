#!/usr/bin/env node
/**
 * M1-C2 CSV 标准化纯函数（src/engine/csvNormalize.js）—— 产品侧单元测试 v1
 *
 * 定位：移植 m0/csv-input 129 项候选校验中属格式纯函数的部分——A/A′ 两文件字段级断言、
 *       9 个针对性夹具（Q4/Q5/Q6/Q7/Q8/O1/O2/O3）、A/A′ 经「解析→标准化→引擎」的 R1 联测；
 *       另补 E_EMPTY / E_HEADER_MISSING（schema v3 已列，m0 脚本未实现）。
 * 边界：UI 接入（Papa Parse）与断网流程（R5）属页面侧联测，不在本测试。
 * 运行：node tests/csv-normalize.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsvText, normalizeRows, CSV_HEADER } from '../src/engine/csvNormalize.js';
import { computeIndicators, sortTrades } from '../src/engine/indicators.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIX = join(REPO, 'm0/csv-input/fixtures');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const readCsv = (rel) => readFileSync(join(FIX, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- A/A′：字段级断言（对照 *.expected.json 的 standardized） ---- */
const normCache = {};
for (const [file, expFile] of [
  ['demo-bill.csv', 'demo-bill.expected.json'],
  ['demo-bill-aprime.csv', 'demo-bill-aprime.expected.json'],
]) {
  const exp = load(`m0/csv-input/fixtures/${expFile}`);
  const parsed = parseCsvText(readCsv(file));
  check(`${file}: 表头精确匹配候选格式（${CSV_HEADER.join('/')}）`, eqArr(parsed.header, CSV_HEADER), parsed.header.join('|'));

  const got = normalizeRows(parsed, file);
  normCache[file] = got;
  const eStd = exp.standardized;
  check(`${file}: blocked=false（合规账单）`, got.blocked === false && eStd.blocked === false, JSON.stringify({ got: got.blocked }));
  check(`${file}: schema_version = candidate-3；source_file 正确`, got.schema_version === 'candidate-3' && got.source_file === file, `${got.schema_version}/${got.source_file}`);
  check(`${file}: 交易条数 ${eStd.trades.length}（按原始文件顺序）`, got.trades.length === eStd.trades.length, `${got.trades.length} vs ${eStd.trades.length}`);
  eStd.trades.forEach((e, i) => {
    const g = got.trades[i];
    const keys = ['trade_id', 'trade_date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax', 'fee_missing', 'tax_missing'];
    const bad = keys.filter((k) => e[k] !== g?.[k]);
    check(`${file}: ${e.trade_id} 字段一致（含前导零/缺失标记）`, bad.length === 0, `差异字段 [${bad.join(',')}]；got=${JSON.stringify(g)}`);
    check(`${file}: ${e.trade_id} source 一致（file/line 不改写）`, e.source.file === g?.source.file && e.source.line === g?.source.line, JSON.stringify(g?.source));
  });
  check(`${file}: warnings 与夹具一致`, eqArr(got.warnings, eStd.warnings), JSON.stringify(got.warnings));
  check(`${file}: errors 为空`, got.errors.length === 0, JSON.stringify(got.errors));
}

/* ---- A/A′ 联测：解析→标准化→引擎（R1 受影响指标按预期变化） ---- */
{
  const expA = load('m0/csv-input/fixtures/demo-bill.expected.json');
  const expAp = load('m0/csv-input/fixtures/demo-bill-aprime.expected.json');
  const closes = expA.assumptions.asof_prices;
  const runA = computeIndicators({ trades: normCache['demo-bill.csv'].trades, closes });
  const runAp = computeIndicators({ trades: normCache['demo-bill-aprime.csv'].trades, closes });
  const eP = expA.expected_indicators.portfolio;
  check('联测：A 标准化→引擎 portfolio 7 项与夹具一致（+4.9%/+16.0%/+11.1pp/¥3,900.00）', ['buyCost', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'].every((k) => near(runA.portfolio[k], eP[k])), runA.portfolio.actualRet);

  const PICK = (run, path) => { const [a, b] = path.split('.'); return a === 'portfolio' ? run.portfolio[b] : run.per_stock[a][b]; };
  const delta = expAp.delta_vs_demo_bill;
  const badAffected = delta.affected.filter((x) => !near(PICK(runA, x.path), x.from) || !near(PICK(runAp, x.path), x.to));
  check(`联测：R1 受影响指标 ${delta.affected.length} 项按预期变化（仅改一笔卖出价）`, badAffected.length === 0, JSON.stringify(badAffected.map((x) => x.path)));
  const drifted = delta.unchanged.filter((p) => !near(PICK(runA, p), PICK(runAp, p)));
  check(`联测：R1 不受影响指标 ${delta.unchanged.length} 项保持不变`, drifted.length === 0, JSON.stringify(drifted));
}

/* ---- 针对性夹具（checks/）：Q4/Q5/Q6/O1/O2/O3 ---- */
{
  const run = (rel) => normalizeRows(parseCsvText(readCsv(`checks/${rel}`)), `checks/${rel}`);

  // Q4 + O1：超精度直接报错、不自动舍入、整批阻断
  const p = run('over-precision.csv');
  const pCodes = p.errors.map((e) => `${e.line}:${e.code}`);
  check('Q4 超精度：报 3 个错误且码型/行号正确', eqArr(pCodes, ['2:E_PRICE_PRECISION', '3:E_MONEY_PRECISION', '4:E_MONEY_PRECISION']), JSON.stringify(pCodes));
  check('O1 整批阻断：超精度样例无部分结果（trades 为空）', p.blocked === true && p.trades.length === 0, JSON.stringify({ blocked: p.blocked, n: p.trades.length }));
  const pMsgs = p.errors.map((e) => e.message).join('|');
  check('Q4 不自动舍入：错误信息保留原始串 96.123/5.005/1.234', pMsgs.includes('96.123') && pMsgs.includes('5.005') && pMsgs.includes('1.234'), pMsgs);

  // Q5：未知列忽略并列出列名
  const u = run('unknown-columns.csv');
  const unk = u.warnings.filter((w) => w.code === 'W_UNKNOWN_COLUMN').map((w) => w.column);
  check('Q5 未知列：警告列出被忽略列名 [备注, 来源]', eqArr(unk, ['备注', '来源']), JSON.stringify(unk));
  check('Q5 未知列：已知列按表头映射解析（2 条，字段正确）', u.trades.length === 2 && u.trades[0].price === 96 && u.trades[1].side === 'sell', JSON.stringify(u.trades.length));

  // Q6：费用/税费整列缺失 → 全 0 + 逐条标记 + 全局警告
  const m = run('missing-fee-column.csv');
  const mCodes = m.warnings.map((w) => w.code);
  check('Q6 整列缺失：全局警告（费用、税费各一条）', eqArr(mCodes, ['W_FEE_COLUMN_MISSING', 'W_TAX_COLUMN_MISSING']), JSON.stringify(mCodes));
  check('Q6 整列缺失：无逐条 W_*_MISSING_AS_ZERO（仅保留布尔标记）', !mCodes.includes('W_FEE_MISSING_AS_ZERO') && !mCodes.includes('W_TAX_MISSING_AS_ZERO'), JSON.stringify(mCodes));
  check('Q6 整列缺失：全 0 且 fee_missing/tax_missing=true（全部行）', m.trades.length === 2 && m.trades.every((t) => t.fee === 0 && t.tax === 0 && t.fee_missing === true && t.tax_missing === true), JSON.stringify(m.trades.length));

  // Q7 + Q8：乱序/同日稳定排序、source 与 trade_id 保持、前导零
  const o = run('out-of-order.csv');
  check('Q8 前导零：标的按字符串保留 001234', typeof o.trades[1].symbol === 'string' && o.trades[1].symbol === '001234', JSON.stringify(o.trades.map((t) => t.symbol)));
  check('Q7 原始顺序：trade_id/source 按文件行序（T001…T004 / line 2…5）',
    eqArr(o.trades.map((t) => t.trade_id), ['T001', 'T002', 'T003', 'T004']) && eqArr(o.trades.map((t) => t.source.line), [2, 3, 4, 5]),
    JSON.stringify(o.trades.map((t) => [t.trade_id, t.source.line])));
  const sorted = sortTrades(o.trades);
  check('Q7 排序：按日期升序、同日按原始行号稳定',
    eqArr(sorted.map((t) => `${t.trade_date}#${t.trade_id}`), ['2024-09-24#T002', '2024-09-24#T003', '2024-09-25#T004', '2024-10-08#T001']),
    JSON.stringify(sorted.map((t) => `${t.trade_date}#${t.trade_id}`)));
  check('Q7 排序不改写 source/trade_id（保持原始引用与行号）',
    sorted.every((t) => t === o.trades.find((x) => x.trade_id === t.trade_id)) && eqArr(sorted.map((t) => t.source.line), [3, 4, 5, 2]),
    JSON.stringify(sorted.map((t) => t.source.line)));
  const asofOO = { '001234': 55, '000000': 100 };
  const i1 = computeIndicators({ trades: o.trades, closes: asofOO }).portfolio;
  const i2 = computeIndicators({ trades: [...o.trades].reverse(), closes: asofOO }).portfolio;
  check('Q7 计算与行序无关（文件序 vs 反序结果一致）', ['buyCost', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'].every((k) => near(i1[k], i2[k])), JSON.stringify(i1.actualRet));

  // O1：错误汇总（多类错误全部列出，不首错即停）+ 整批阻断
  const agg = run('error-aggregation.csv');
  const aggCodes = agg.errors.map((e) => `${e.line}:${e.code}`);
  check('O1 错误汇总：3 类错误全部列出（日期/方向/价格）', eqArr(aggCodes, ['2:E_DATE_FORMAT', '3:E_SIDE_VALUE', '4:E_PRICE_VALUE']), JSON.stringify(aggCodes));
  check('O1 整批阻断：聚合样例无部分结果', agg.blocked === true && agg.trades.length === 0, JSON.stringify({ blocked: agg.blocked, n: agg.trades.length }));

  // O3：超卖 → E_QTY_EXCEEDS 整批阻断
  const ov = run('oversell.csv');
  check('O3 超卖：任一时点累计卖出>累计买入 → E_QTY_EXCEEDS（行号=触发卖出行）', eqArr(ov.errors.map((e) => `${e.line}:${e.code}`), ['3:E_QTY_EXCEEDS']), JSON.stringify(ov.errors));
  check('O3 超卖：整批阻断', ov.blocked === true && ov.trades.length === 0, JSON.stringify({ blocked: ov.blocked }));

  // O3：跨标的隔离（池化合并实现会漏检，逐标的必须命中）
  const cs = run('cross-symbol.csv');
  check('O3 跨标的隔离：仅 001234 超卖命中（池化实现会漏检）', eqArr(cs.errors.map((e) => `${e.line}:${e.code}`), ['4:E_QTY_EXCEEDS']), JSON.stringify(cs.errors));

  // 期末未卖持仓：允许（Q3 确认口径）
  const ep = run('end-position.csv');
  check('期末持仓：允许期末未卖持仓（无错误、不阻断、3 条交易）', ep.errors.length === 0 && ep.blocked === false && ep.trades.length === 3, JSON.stringify({ errors: ep.errors.length, n: ep.trades.length }));

  // O2：BOM + CRLF 解析
  const bom = run('bom-crlf.csv');
  check('O2 BOM/CRLF：表头解析无未知列（BOM 已剥离）', bom.warnings.filter((w) => w.code === 'W_UNKNOWN_COLUMN').length === 0, JSON.stringify(bom.warnings));
  check('O2 BOM/CRLF：5 条交易、T004 费用缺失标记与来源正确', bom.trades.length === 5 && bom.trades[3].fee_missing === true && bom.trades[3].source.line === 5 && bom.trades[3].source.file === 'checks/bom-crlf.csv', JSON.stringify(bom.trades.map((t) => [t.trade_id, t.fee_missing])));
}

/* ---- 补齐项：E_EMPTY / E_HEADER_MISSING（schema v3 已列） ---- */
{
  const empty = normalizeRows(parseCsvText(''), 'empty.csv');
  check('E_EMPTY：空文件 → blocked + E_EMPTY', empty.blocked === true && empty.trades.length === 0 && empty.errors.length === 1 && empty.errors[0].code === 'E_EMPTY', JSON.stringify(empty.errors));
  const headerOnly = normalizeRows(parseCsvText(CSV_HEADER.join(',') + '\n'), 'header-only.csv');
  check('E_EMPTY：仅表头 → blocked + E_EMPTY', headerOnly.blocked === true && headerOnly.errors[0]?.code === 'E_EMPTY', JSON.stringify(headerOnly.errors));

  const noDate = normalizeRows(parseCsvText('标的,方向,价格,数量\n000000,买入,10.00,100\n'), 'no-date.csv');
  check('E_HEADER_MISSING：缺少必需列 → 列出缺失列且不上数', noDate.blocked === true && noDate.trades.length === 0 && noDate.errors[0]?.code === 'E_HEADER_MISSING' && noDate.errors[0].message.includes('日期'), JSON.stringify(noDate.errors));
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
