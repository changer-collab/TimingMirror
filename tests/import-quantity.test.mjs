#!/usr/bin/env node
/**
 * 导入数量千分位规范化（纯函数；不联网、不调用模型）。
 * 覆盖：AI 草稿、CSV/文字草稿、手动行、最终 draftToNormalized、重复指纹；
 * 价格/日期/方向/代码规则保持原样。
 * 运行：node tests/import-quantity.test.mjs
 */
import { normalizeQuantity, normalizeRows } from '../src/engine/csvNormalize.js';
import {
  addBlankRow,
  buildAiDraft,
  buildLocalDraft,
  draftToNormalized,
  refreshRowStatus,
} from '../src/engine/importDraft.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const HEADER = ['日期', '标的', '方向', '价格', '数量', '费用', '税费'];
const row = (line, date, side, quantity, price = '10.00') => ({
  line, cells: [date, '603336', side, price, quantity, '', ''],
});

/* —— canonical 规范化 —— */
{
  const valid = [
    ['数字 1800', 1800, 1800],
    ['字符串 1800', '1800', 1800],
    ['ASCII 千分位', '1,800', 1800],
    ['全角千分位', '1，800', 1800],
    ['900', '900', 900],
    ['1,300', '1,300', 1300],
    ['多组 ASCII', '1,234,567', 1234567],
    ['多组全角', '1，234，567', 1234567],
    ['首尾空白', ' 1,800 ', 1800],
  ];
  for (const [name, input, expected] of valid) {
    check(`规范化：${name} → ${expected}`, normalizeQuantity(input) === expected, String(normalizeQuantity(input)));
  }
  const invalid = [
    ['0', 0], ['字符串 0', '0'], ['负数', -1800], ['负数字符串', '-1800'],
    ['小数', 1800.5], ['小数字符串', '1800.5'], ['非法分组', '1,80,0'],
    ['文本', 'abc'], ['空值', ''], ['null', null], ['undefined', undefined],
    ['空格分隔', '1 800'], ['货币符号', '￥1,800'], ['后缀文本', '1,800元'],
    ['混合分隔符', '1,800，000'], ['全角数字', '１，８００'],
  ];
  for (const [name, input] of invalid) {
    check(`规范化：${name} 拒绝`, normalizeQuantity(input) === null, String(normalizeQuantity(input)));
  }
}

/* —— 共享 normalizeRows / 价格隔离 —— */
{
  const out = normalizeRows({ header: HEADER, rows: [
    row(2, '2026-09-28', '买入', '1,800'),
    row(3, '2026-09-29', '买入', '1，300'),
    row(4, '2026-09-30', '买入', '900'),
  ] }, 'x.csv');
  check('CSV/文字：千分位数量通过并规范化为数字', out.blocked === false
    && out.trades.map((trade) => trade.quantity).join(',') === '1800,1300,900',
  JSON.stringify({ errors: out.errors, trades: out.trades.map((trade) => trade.quantity) }));
  check('CSV/文字：原展示字符串不进入最终值', out.trades.every((trade) => typeof trade.quantity === 'number'));

  const badGroups = normalizeRows({ header: HEADER, rows: [row(2, '2026-09-28', '买入', '1,80,0')] }, 'x.csv');
  check('CSV/文字：非法分组仍报 E_QTY_INTEGER', badGroups.blocked === true
    && badGroups.errors.some((error) => error.code === 'E_QTY_INTEGER'), JSON.stringify(badGroups.errors));

  const priceComma = normalizeRows({ header: HEADER, rows: [row(2, '2026-09-28', '买入', '1,800', '1,800')] }, 'x.csv');
  check('价格：价格中的逗号不被数量规则放行', priceComma.blocked === true
    && priceComma.errors.some((error) => error.code === 'E_PRICE_VALUE')
    && !priceComma.errors.some((error) => error.code === 'E_QTY_INTEGER'), JSON.stringify(priceComma.errors));
  const pricePrecision = normalizeRows({ header: HEADER, rows: [row(2, '2026-09-28', '买入', '1,800', '10.115')] }, 'x.csv');
  check('价格：精度规则保持 E_PRICE_PRECISION', pricePrecision.blocked === true
    && pricePrecision.errors.some((error) => error.code === 'E_PRICE_PRECISION'), JSON.stringify(pricePrecision.errors));
}

/* —— AI 视觉草稿：7 条不再误报 —— */
{
  const aiTrades = [
    { date: '2026-09-28', side: '买入', price: '10.11', quantity: '1,800' },
    { date: '2026-09-29', side: '卖出', price: '9.89', quantity: '1,800' },
    { date: '2026-09-30', side: '买入', price: '9.93', quantity: '900' },
    { date: '2026-09-30', side: '卖出', price: '9.90', quantity: '900' },
    { date: '2026-10-08', side: '买入', price: '9.95', quantity: '1,800' },
    { date: '2026-10-12', side: '买入', price: '12.25', quantity: '1,300' },
    { date: '2026-10-15', side: '卖出', price: '12.02', quantity: '1,300' },
  ].map((trade) => ({
    ...trade, symbol: '603336', fee: null, tax: null, confidence: 0.9, issues: [],
  }));
  const draft = buildAiDraft({ aiTrades, unresolved: [{ row: 6, reason: '证券转银行' }], sourceFile: '截图' });
  check('AI：7 条千分位数量均标记可导入', draft.rows.length === 7
    && draft.rows.every((item) => item.status === 'valid' && item.issues.length === 0),
  JSON.stringify(draft.rows.map((item) => ({ status: item.status, issues: item.issues }))));
  check('AI：展示值仍保留千分位', draft.rows.map((item) => item.fields.quantity).join(',')
    === '1,800,1,800,900,900,1,800,1,300,1,300',
  JSON.stringify(draft.rows.map((item) => item.fields.quantity)));
  const normalized = draftToNormalized(draft, '截图');
  check('AI：最终导入使用 canonical 数量', normalized.ok === true
    && normalized.normalized.trades.map((trade) => trade.quantity).join(',')
      === '1800,1800,900,900,1800,1300,1300',
  JSON.stringify(normalized.normalized?.trades.map((trade) => trade.quantity)));
  check('AI：unresolved 行为不变', draft.unresolved.length === 1 && draft.unresolved[0].row === 6);
}

/* —— CSV/文字草稿路径 —— */
{
  const local = buildLocalDraft({ header: HEADER, rows: [row(2, '2026-09-28', '买入', '1,800')] }, 'local.csv');
  check('CSV/文字草稿：千分位数量可导入且展示原值', local.rows[0].status === 'valid'
    && local.rows[0].fields.quantity === '1,800', JSON.stringify(local.rows[0]));
  const normalized = draftToNormalized(local, 'local.csv');
  check('CSV/文字草稿：最终数量为 1800', normalized.ok === true
    && normalized.normalized.trades[0].quantity === 1800, JSON.stringify(normalized.normalized?.trades));
}

/* —— 手动新增行复用同一逻辑 —— */
{
  const base = buildAiDraft({ aiTrades: [], unresolved: [], sourceFile: 'manual' });
  const withManual = addBlankRow(base);
  const blank = withManual.rows[0];
  const blankChecked = refreshRowStatus(blank, 'manual');
  check('手动行：空数量仍提示补齐', blankChecked.status === 'needs_review'
    && blankChecked.issues.some((issue) => issue.includes('数量')));
  const filled = refreshRowStatus({
    ...blank,
    fields: {
      ...blank.fields,
      date: '2026-10-16', symbol: '603967', side: '买入', price: '12.00', quantity: '1,800',
    },
  }, 'manual');
  check('手动行：1,800 通过校验且保留显示值', filled.status === 'valid'
    && filled.fields.quantity === '1,800', JSON.stringify({ status: filled.status, fields: filled.fields }));
  const normalized = draftToNormalized({ ...withManual, rows: [filled] }, 'manual');
  check('手动行：最终导入发送 1800', normalized.ok === true
    && normalized.normalized.trades[0].quantity === 1800, JSON.stringify(normalized.normalized?.trades));
  const bad = refreshRowStatus({ ...filled, fields: { ...filled.fields, quantity: '1,80,0' } }, 'manual');
  check('手动行：非法分组仍阻断', bad.status !== 'valid' && bad.issues.some((issue) => issue.includes('数量')));
}

/* —— 重复指纹复用 canonical 数量 —— */
{
  const draft = buildAiDraft({
    aiTrades: [
      { date: '2026-09-28', symbol: '603336', side: '买入', price: '10.00', quantity: '1,800', fee: null, tax: null, confidence: 0.9, issues: [] },
      { date: '2026-09-28', symbol: '603336', side: '买入', price: '10.00', quantity: '1800', fee: null, tax: null, confidence: 0.9, issues: [] },
    ],
    unresolved: [],
    sourceFile: 'duplicate',
    duplicatePolicy: 'warn',
  });
  check('重复：1,800 与 1800 视为同一数量', draft.rows[1].duplicateWarn === true
    && draft.rows[1].status === 'needs_review', JSON.stringify(draft.rows.map((item) => ({ status: item.status, duplicateWarn: item.duplicateWarn }))));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
