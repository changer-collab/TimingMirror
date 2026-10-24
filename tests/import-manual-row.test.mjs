#!/usr/bin/env node
/**
 * 导入草稿手动新增成交行（纯函数；不联网、不调用模型）。
 * 覆盖：新增/多行/删除、手动状态与颜色语义、空行阻断、补齐后与 AI 行一起导入、
 * 重新识别不继承旧手动行、映射与 unresolved 不受影响。
 * 运行：node tests/import-manual-row.test.mjs
 */
import {
  addBlankRow,
  removeRow,
  refreshRowStatus,
  draftToNormalized,
  draftSummary,
  draftRowStatusText,
  draftRowSeverity,
  buildAiDraft,
} from '../src/engine/importDraft.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const MAPPING = [
  { source_label: '名称/代码', source_subfield: '代码', target_field: 'symbol', confidence: 'high' },
  { source_label: '标志/交收日期', source_subfield: '标志', target_field: 'direction', confidence: 'high' },
  { source_label: '标志/交收日期', source_subfield: '交收日期', target_field: 'settlement_date', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '成交价', target_field: 'price', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '量', target_field: 'quantity', confidence: 'high' },
  { source_label: '成交/清算额', source_subfield: '成交', target_field: 'amount', confidence: 'high' },
  { source_label: '成交/清算额', source_subfield: '清算', target_field: 'settlement_amount', confidence: 'high' },
];
const AI_TRADES = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-09-${String(index + 1).padStart(2, '0')}`,
  symbol: '603336', side: '买入', price: '10.00', quantity: '100',
  fee: null, tax: null, confidence: 0.9, issues: [],
}));
const BASE_DRAFT = buildAiDraft({
  aiTrades: AI_TRADES,
  unresolved: [{ row: 6, reason: '证券转银行记录' }],
  columnMapping: MAPPING,
  sourceFile: '交割单截图',
  duplicatePolicy: 'warn',
  nonTradePolicy: 'unresolved',
});

/* —— 新增、多行与删除 —— */
{
  const one = addBlankRow(BASE_DRAFT);
  const manual = one.rows[7];
  check('新增：AI 7 行之外增加 1 条手动行', BASE_DRAFT.rows.length === 7 && one.rows.length === 8
    && manual.source === 'manual' && manual.include !== false, JSON.stringify({ base: BASE_DRAFT.rows.length, next: one.rows.length }));
  check('新增：状态为手动新增待确认，颜色语义为 warning',
    draftRowStatusText(manual) === '手动新增 · 待确认' && draftRowSeverity(manual) === 'warning');
  check('新增：必要字段为空，金额字段不伪造', manual.fields.date === '' && manual.fields.symbol === ''
    && manual.fields.side === '' && manual.fields.price === '' && manual.fields.quantity === ''
    && manual.fields.amount === '' && manual.fields.settlementAmount === ''
    && manual.fields.fee === '' && manual.fields.tax === '', JSON.stringify(manual.fields));
  check('新增：映射与 unresolved 原样保留', one.columnMapping.length === MAPPING.length
    && one.unresolved.length === 1 && one.unresolved[0].row === 6, JSON.stringify({ mapping: one.columnMapping.length, unresolved: one.unresolved }));
  check('新增：不修改原草稿行数组', BASE_DRAFT.rows.length === 7 && one.rows[0] === BASE_DRAFT.rows[0]);

  const two = addBlankRow(one);
  check('多行：可连续新增且 ID 不重复', two.rows.length === 9
    && two.rows[7].id !== two.rows[8].id
    && two.rows[7].source === 'manual' && two.rows[8].source === 'manual',
  JSON.stringify({ length: two.rows.length, ids: [two.rows[7].id, two.rows[8].id] }));
  const summary = draftSummary(two);
  check('多行：新增行不增加可导入数量', summary.valid === 7 && summary.needs_review === 2
    && summary.included === 9, JSON.stringify(summary));

  const removed = removeRow(two, two.rows[7].id);
  check('删除：只移除指定手动行，AI 行和其他手动行保留', removed.rows.length === 8
    && removed.rows.filter((row) => row.source === 'manual').length === 1
    && removed.rows.filter((row) => row.source === 'ai').length === 7
    && removed.rows.some((row) => row.id === two.rows[8].id), JSON.stringify(removed.rows.map((row) => row.source)));
  check('状态：非手动待确认仍然显示原状态', draftRowStatusText({ status: 'needs_review', source: 'ai' }) === '待确认');
}

/* —— 空行阻断，不静默丢弃 —— */
{
  const withManual = addBlankRow(BASE_DRAFT);
  const refreshed = {
    ...withManual,
    rows: withManual.rows.map((row) => (row.source === 'manual' ? refreshRowStatus(row, '交割单截图') : row)),
  };
  const emptyOut = draftToNormalized(refreshed, '交割单截图');
  const manual = refreshed.rows.find((row) => row.source === 'manual');
  check('空行：不能直接通过最终校验', emptyOut.ok === false
    && emptyOut.code === 'E_DATE_FORMAT' && emptyOut.normalized?.trades.length === 0,
  JSON.stringify({ code: emptyOut.code, trades: emptyOut.normalized?.trades.length }));
  check('空行：仍有明确字段错误且不丢弃手动行', emptyOut.included.some((row) => row.source === 'manual')
    && manual.status === 'needs_review'
    && manual.issues.some((issue) => issue.includes('日期'))
    && manual.issues.some((issue) => issue.includes('标的'))
    && manual.issues.some((issue) => issue.includes('方向'))
    && manual.issues.some((issue) => issue.includes('价格'))
    && manual.issues.some((issue) => issue.includes('数量')), JSON.stringify(manual.issues));
}

/* —— 补齐后与 AI 行一起进入导入 —— */
{
  const withManual = addBlankRow(BASE_DRAFT);
  const source = withManual.rows.find((row) => row.source === 'manual');
  const filled = refreshRowStatus({
    ...source,
    fields: {
      ...source.fields,
      date: '2026-10-16', symbol: '603967', side: '买入', price: '12.00', quantity: '100',
      amount: '1,200.00', settlementAmount: '-1,198.80',
    },
  }, '交割单截图');
  const filledDraft = { ...withManual, rows: withManual.rows.map((row) => (row.id === filled.id ? filled : row)) };
  const out = draftToNormalized(filledDraft, '交割单截图');
  check('补齐：手动行变为可导入且来源仍为 manual', filled.status === 'valid'
    && filled.source === 'manual' && draftRowStatusText(filled) === '可导入'
    && filled.fields.amount === '1,200.00' && filled.fields.settlementAmount === '-1,198.80',
  JSON.stringify({ status: filled.status, source: filled.source, fields: filled.fields }));
  check('补齐：AI 7 行 + 手动 1 行一起通过最终校验', out.ok === true
    && out.normalized.trades.length === 8
    && out.included.filter((row) => row.source === 'manual').length === 1
    && out.included.filter((row) => row.source === 'ai').length === 7,
  JSON.stringify({ ok: out.ok, trades: out.normalized?.trades.length, included: out.included.map((row) => row.source) }));
}

/* —— 重新识别 / 旧草稿清理 —— */
{
  const withManual = addBlankRow(BASE_DRAFT);
  const reRecognized = buildAiDraft({
    aiTrades: AI_TRADES,
    unresolved: [],
    localDraft: null,
    columnMapping: MAPPING,
  });
  check('重新识别：只从新的识别结果生成草稿，不继承旧手动行', withManual.rows.length === 8
    && reRecognized.rows.length === 7
    && !reRecognized.rows.some((row) => row.source === 'manual'),
  JSON.stringify({ old: withManual.rows.length, next: reRecognized.rows.length }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
