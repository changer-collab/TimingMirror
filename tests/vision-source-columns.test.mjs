#!/usr/bin/env node
/**
 * 视觉草稿原图列对齐（纯函数；不联网、不调用模型）。
 * 覆盖：动态列标题、成交额/清算额透传与展示、不进入 fee/tax、旧响应兼容、
 * CSV/文字草稿不变、unresolved row 归一化不回归。
 * 运行：node tests/vision-source-columns.test.mjs
 */
import { validateImportVisionResponse } from '../server/site-functions/importVision.mjs';
import { validateImportRecoverResponse } from '../server/site-functions/importRecover.mjs';
import { validateRecoveryResponse } from '../src/agent/importRecovery.js';
import { columnMappingRows, visionDraftColumns } from '../src/engine/importColumnMapping.js';
import { buildAiDraft, buildLocalDraft, draftToNormalized } from '../src/engine/importDraft.js';

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
const TRADE_BUY = {
  date: '2026-09-29', symbol: '603336', name: '示例股份', side: '买入', price: '9.89', quantity: '1800',
  amount: '17,820.00', settlement_amount: '-17,816.16', fee: null, tax: null, confidence: 0.9, issues: [],
};
const TRADE_SELL = {
  date: '2026-09-30', symbol: '603336', name: '示例股份', side: '卖出', price: '10.11', quantity: '1800',
  amount: '18,198.00', settlement_amount: '18,174.43', fee: null, tax: null, confidence: 0.9, issues: [],
};
const withTrades = (trades, mapping = MAPPING, unresolved = []) => JSON.stringify({
  trades, unresolved, column_mapping: mapping,
});

/* —— 动态列标题 —— */
{
  const columns = visionDraftColumns(MAPPING);
  check('列：键顺序为日期/标的/方向/价格/数量/成交额/清算额',
    columns.map((column) => column.key).join(',') === 'date,symbol,side,price,quantity,amount,settlementAmount',
    JSON.stringify(columns.map((column) => column.key)));
  check('列：标题与原图列一致', columns.map((column) => column.label).join(',')
    === '交收日期,标的/代码,方向,成交价,数量,成交额,清算额', JSON.stringify(columns.map((column) => column.label)));
  check('列：交收日期标记为 settlement', columns.find((column) => column.key === 'date')?.settlement === true);
  check('列：标的列可显示名称辅助值', columns.find((column) => column.key === 'symbol')?.nameAux === true);
  check('列：成交额/清算额为只读展示列', columns.find((column) => column.key === 'amount')?.editable === false
    && columns.find((column) => column.key === 'settlementAmount')?.editable === false);
  check('列：无独立费用列时不生成费用/税费列',
    !columns.some((column) => column.key === 'fee' || column.key === 'tax'),
    JSON.stringify(columns.map((column) => column.key)));

  const oldMapping = MAPPING.filter((entry) => !['amount', 'settlement_amount'].includes(entry.target_field));
  const oldColumns = visionDraftColumns(oldMapping);
  check('旧响应：无成交额/清算额时不生成对应列', oldColumns.map((column) => column.key).join(',')
    === 'date,symbol,side,price,quantity', JSON.stringify(oldColumns.map((column) => column.key)));
  check('旧响应：交收日期/标的/成交价/数量标题仍正确',
    oldColumns.map((column) => column.label).join(',') === '交收日期,标的/代码,方向,成交价,数量');
  check('缺少映射：不生成动态列，回退现有固定表格', visionDraftColumns([]).length === 0);

  const mappingWithFees = MAPPING.concat([
    { source_label: '手续费', source_subfield: null, target_field: 'fee', confidence: 'high' },
    { source_label: '印花税', source_subfield: null, target_field: 'tax', confidence: 'high' },
  ]);
  const feeColumns = visionDraftColumns(mappingWithFees);
  check('有独立费用列时才显示费用/税费', feeColumns.slice(-2).map((column) => column.label).join(',') === '费用,税费');
}

/* —— 成交额/清算额透传 —— */
{
  const raw = withTrades([TRADE_BUY, TRADE_SELL]);
  const server = validateImportVisionResponse(raw);
  check('服务端：成交额/清算额保留原始文本与符号', server.ok === true
    && server.value.trades[0].amount === '17,820.00'
    && server.value.trades[0].settlement_amount === '-17,816.16'
    && server.value.trades[1].settlement_amount === '18,174.43', JSON.stringify(server.value?.trades));
  check('服务端：名称作为标的辅助字段透传', server.ok === true && server.value.trades[0].name === '示例股份');
  check('服务端：费用/税费仍为 null，未被金额填充', server.ok === true
    && server.value.trades[0].fee === null && server.value.trades[0].tax === null);

  const client = validateRecoveryResponse(raw, { allowColumnMapping: true });
  check('客户端：成交额/清算额透传', client.ok === true
    && client.trades[0].amount === '17,820.00'
    && client.trades[0].settlement_amount === '-17,816.16', JSON.stringify(client.trades));

  const oldRaw = withTrades([{
    date: '2026-09-29', symbol: '603336', side: '买入', price: '9.89', quantity: '1800',
    fee: null, tax: null, confidence: 0.9, issues: [],
  }]);
  const oldServer = validateImportVisionResponse(oldRaw);
  const oldClient = validateRecoveryResponse(oldRaw, { allowColumnMapping: true });
  check('兼容：缺少可选 amount/settlement_amount/name 不导致 502', oldServer.ok === true
    && oldClient.ok === true
    && oldServer.value.trades[0].amount === null
    && oldServer.value.trades[0].settlement_amount === null
    && oldServer.value.trades[0].name === null, JSON.stringify(oldServer.value?.trades));
}

/* —— 草稿：金额列与 fee/tax 隔离 —— */
{
  const raw = withTrades([TRADE_BUY, TRADE_SELL]);
  const validated = validateImportVisionResponse(raw);
  const draft = buildAiDraft({
    aiTrades: validated.value.trades,
    unresolved: validated.value.unresolved,
    columnMapping: validated.value.column_mapping,
    sourceFile: '交割单截图',
    duplicatePolicy: 'warn',
    nonTradePolicy: 'unresolved',
  });
  check('草稿：两行可编辑交易保留金额与名称', draft.rows.length === 2
    && draft.rows[0].fields.amount === '17,820.00'
    && draft.rows[0].fields.settlementAmount === '-17,816.16'
    && draft.rows[0].fields.name === '示例股份', JSON.stringify(draft.rows.map((row) => row.fields)));
  check('草稿：成交额/清算额没有写入 fee/tax', draft.rows.every((row) => row.fields.fee === ''
    && row.fields.tax === ''
    && !String(row.fields.fee).includes('18,198')
    && !String(row.fields.tax).includes('17,816')), JSON.stringify(draft.rows.map((row) => ({ fee: row.fields.fee, tax: row.fields.tax }))));
  const normalized = draftToNormalized(draft, '交割单截图');
  check('账本：新增展示字段不改变最终规范化结果', normalized.ok === true
    && normalized.normalized.trades.length === 2, JSON.stringify(normalized.normalized?.trades));
}

/* —— 旧响应、CSV/文字与 row 归一化 —— */
{
  const oldMapping = MAPPING.filter((entry) => !['amount', 'settlement_amount'].includes(entry.target_field));
  const oldTrade = {
    date: '2026-09-29', symbol: '603336', side: '买入', price: '9.89', quantity: '1800',
    fee: null, tax: null, confidence: 0.9, issues: [],
  };
  const oldRaw = withTrades([oldTrade], oldMapping, [{ row: '6', reason: '方向无法确定' }]);
  const old = validateImportVisionResponse(oldRaw);
  check('旧响应：仍通过且 row 归一化不回归', old.ok === true
    && old.value.unresolved[0].row === 6
    && visionDraftColumns(old.value.column_mapping).length === 5, JSON.stringify(old.value?.unresolved));

  const oldTradeNewMapping = validateImportVisionResponse(withTrades([oldTrade]));
  const oldDraft = buildAiDraft({
    aiTrades: oldTradeNewMapping.value.trades,
    unresolved: oldTradeNewMapping.value.unresolved,
    columnMapping: oldTradeNewMapping.value.column_mapping,
  });
  check('旧交易字段 + 新映射：不导致 502，金额列保留为空值', oldTradeNewMapping.ok === true
    && visionDraftColumns(oldTradeNewMapping.value.column_mapping).length === 7
    && oldDraft.rows[0].fields.amount === ''
    && oldDraft.rows[0].fields.settlementAmount === '', JSON.stringify(oldDraft.rows[0]?.fields));

  const local = buildLocalDraft({
    header: ['日期', '标的', '方向', '价格', '数量'],
    rows: [{ line: 2, cells: ['2026-09-29', '603336', '买入', '9.89', '1800'] }],
  }, 'local.csv');
  check('CSV/文字：本地草稿仍只有规范字段，不出现金额展示字段', local.rows.length === 1
    && local.rows[0].fields.amount === undefined
    && local.rows[0].fields.settlementAmount === undefined
    && local.rows[0].fields.fee === '' && local.rows[0].fields.tax === '');

  const textBody = JSON.stringify({ trades: [{ ...oldTrade, amount: '1.00' }], unresolved: [] });
  const textServer = validateImportRecoverResponse(textBody);
  const textClient = validateRecoveryResponse(textBody);
  check('CSV/文字：文字通道仍拒绝视觉展示字段', textServer.ok === false
    && textServer.diagnostics?.validation_reason === 'trade_unexpected_key'
    && textClient.ok === false, JSON.stringify(textServer.diagnostics));

  const mappingRows = columnMappingRows(MAPPING);
  check('映射区域：成交/清算额仍按复合列展示', mappingRows.groups
    .find((group) => group.source_label === '成交/清算额')?.target_display === '成交额 / 清算额',
  JSON.stringify(mappingRows.groups.map((group) => group.target_display)));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
