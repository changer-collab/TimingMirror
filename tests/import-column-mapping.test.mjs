#!/usr/bin/env node
/**
 * 原图列名映射与状态语义（纯函数；不联网、不调用模型）。
 * 覆盖：合法/缺失映射、非法字段/枚举/置信度/泄漏、复合列展示、未匹配、草稿保留与 severity。
 * 运行：node tests/import-column-mapping.test.mjs
 */
import {
  IMPORT_COLUMN_TARGET_FIELDS,
  IMPORT_COLUMN_CONFIDENCES,
  validateColumnMapping,
  columnMappingRows,
} from '../src/engine/importColumnMapping.js';
import {
  COLUMN_MAPPING_TARGET_FIELDS as SERVER_TARGET_FIELDS,
  COLUMN_MAPPING_CONFIDENCES as SERVER_CONFIDENCES,
} from '../server/site-functions/importRecover.mjs';
import { buildAiDraft, draftRowSeverity } from '../src/engine/importDraft.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const MAPPING = [
  { source_label: '名称/代码', source_subfield: '代码', target_field: 'symbol', confidence: 'high' },
  { source_label: '标志/交收日期', source_subfield: '标志', target_field: 'direction', confidence: 'high' },
  { source_label: '标志/交收日期', source_subfield: '交收日期', target_field: 'settlement_date', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '成交价', target_field: 'price', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '量', target_field: 'quantity', confidence: 'high' },
  { source_label: '成交/清算额', source_subfield: null, target_field: 'settlement_amount', confidence: 'medium' },
  { source_label: '手续费', source_subfield: null, target_field: 'fee', confidence: 'high' },
];
const NO_FEE_MAPPING = MAPPING.filter((entry) => entry.target_field !== 'fee');
const TRADE = {
  date: '2026-09-28', symbol: '603336', side: '卖出', price: '10.11', quantity: '1800',
  fee: null, tax: null, confidence: 0.9, issues: [],
};

/* —— 枚举与校验 —— */
{
  check('枚举：客户端与服务端 target_field 完全一致',
    IMPORT_COLUMN_TARGET_FIELDS.join(',') === SERVER_TARGET_FIELDS.join(','), IMPORT_COLUMN_TARGET_FIELDS.join(','));
  check('枚举：客户端与服务端 confidence 完全一致',
    IMPORT_COLUMN_CONFIDENCES.join(',') === SERVER_CONFIDENCES.join(','), IMPORT_COLUMN_CONFIDENCES.join(','));

  const ok = validateColumnMapping(MAPPING);
  check('校验：合法映射通过并只保留固定字段', ok.ok === true && ok.value.length === MAPPING.length
    && Object.keys(ok.value[0]).sort().join(',') === 'confidence,source_label,source_subfield,target_field'
    && ok.value[5].source_subfield === null, JSON.stringify(ok));

  const empty = validateColumnMapping([]);
  check('校验：空数组合法（由调用方按缺失展示）', empty.ok === true && empty.value.length === 0);

  const extra = validateColumnMapping([{ ...MAPPING[0], note: '原图截图' }]);
  check('校验：映射项额外字段拒绝', extra.ok === false && extra.reason === 'unexpected_key', JSON.stringify(extra));

  const unknownTarget = validateColumnMapping([{ ...MAPPING[0], target_field: 'note' }]);
  check('校验：未知 target_field 拒绝', unknownTarget.ok === false && unknownTarget.reason === 'target_invalid', JSON.stringify(unknownTarget));

  const badConfidence = validateColumnMapping([{ ...MAPPING[0], confidence: 'certain' }]);
  check('校验：非法 confidence 拒绝', badConfidence.ok === false && badConfidence.reason === 'confidence_invalid', JSON.stringify(badConfidence));

  const missingLabel = validateColumnMapping([{ ...MAPPING[0], source_label: '' }]);
  check('校验：空原图列名拒绝', missingLabel.ok === false && missingLabel.reason === 'source_label_invalid', JSON.stringify(missingLabel));
}

/* —— 泄漏边界：列名不能变成图片/CSV/账户/模型原文通道 —— */
{
  const base = { source_label: '成交价', source_subfield: null, target_field: 'price', confidence: 'high' };
  const cases = [
    ['图片 Base64', { ...base, source_label: 'data:image/jpeg;base64,AAAA' }],
    ['长 Base64', { ...base, source_label: 'A'.repeat(64) }],
    ['CSV 行', { ...base, source_label: '日期,标的,方向,价格' }],
    ['账户信息', { ...base, source_label: '资金账号 88888888' }],
    ['模型原文', { ...base, source_label: '{"trades":[]}' }],
    ['子字段泄漏', { ...base, source_subfield: '备注：账户 123456' }],
    ['URL/路径', { ...base, source_label: 'https://example.com/a.csv' }],
  ];
  for (const [name, entry] of cases) {
    const checked = validateColumnMapping([entry]);
    check(`泄漏：${name} 被拒绝`, checked.ok === false, JSON.stringify(checked));
  }
}

/* —— 复合列展示与未匹配 —— */
{
  const view = columnMappingRows(MAPPING);
  const group = (label) => view.groups.find((item) => item.source_label === label);
  check('展示：名称/代码 → 标的', group('名称/代码')?.target_display === '标的'
    && group('名称/代码')?.source_display === '名称/代码 · 代码', JSON.stringify(group('名称/代码')));
  check('展示：标志/交收日期 → 方向 / 交收日期', group('标志/交收日期')?.target_display === '方向 / 交收日期',
    JSON.stringify(group('标志/交收日期')));
  check('展示：成交价/量 → 价格 / 数量', group('成交价/量')?.target_display === '价格 / 数量',
    JSON.stringify(group('成交价/量')));
  check('展示：成交/清算额 → 清算额', group('成交/清算额')?.target_display === '清算额',
    JSON.stringify(group('成交/清算额')));
  check('展示：交收日期被识别为日期来源', view.hasSettlementDate === true);
  const dateField = view.fields.find((field) => field.key === 'date');
  const feeField = view.fields.find((field) => field.key === 'fee');
  const taxField = view.fields.find((field) => field.key === 'tax');
  check('展示：日期显示原图复合列与子字段', dateField?.matched === true
    && dateField?.source_display === '标志/交收日期 · 交收日期', JSON.stringify(dateField));
  check('展示：有独立费用列时费用匹配', feeField?.matched === true && feeField?.source_display === '手续费',
    JSON.stringify(feeField));
  check('展示：没有独立税费列时显示未匹配', taxField?.matched === false && taxField?.source_display === '未匹配',
    JSON.stringify(taxField));

  const noFee = columnMappingRows(NO_FEE_MAPPING);
  check('展示：费用和税费都无独立列时均显示未匹配',
    noFee.fields.find((field) => field.key === 'fee')?.source_display === '未匹配'
    && noFee.fields.find((field) => field.key === 'tax')?.source_display === '未匹配',
    JSON.stringify(noFee.fields));

  const missing = columnMappingRows([]);
  check('展示：缺少映射时只标记 hasMapping=false，不伪造列名',
    missing.hasMapping === false && missing.groups.length === 0
    && missing.fields.every((field) => field.source_display === '未匹配'), JSON.stringify(missing));
}

/* —— 映射缺失不阻断草稿 —— */
{
  const withMapping = buildAiDraft({ aiTrades: [TRADE], unresolved: [], columnMapping: MAPPING });
  const withoutMapping = buildAiDraft({ aiTrades: [TRADE], unresolved: [] });
  check('草稿：有映射时保留映射且不丢交易行', withMapping.rows.length === 1
    && withMapping.rows[0].include !== false
    && withMapping.columnMapping.length === MAPPING.length, JSON.stringify(withMapping.columnMapping));
  check('草稿：缺少映射时仍生成同一交易行', withoutMapping.rows.length === 1
    && withoutMapping.rows[0].fields.symbol === '603336'
    && withoutMapping.columnMapping.length === 0, JSON.stringify(withoutMapping.rows));
  check('草稿：未确定记录不受映射影响', buildAiDraft({
    aiTrades: [],
    unresolved: [{ row: 2, reason: '日期无法确定' }],
    columnMapping: MAPPING,
  }).unresolved.length === 1);
}

/* —— 行状态 severity —— */
{
  check('severity：可导入为 success', draftRowSeverity({ status: 'valid' }) === 'success');
  check('severity：待确认为 warning', draftRowSeverity({ status: 'needs_review' }) === 'warning');
  check('severity：疑似重复为 warning', draftRowSeverity({ status: 'duplicate' }) === 'warning');
  check('severity：需修正为 error', draftRowSeverity({ status: 'invalid' }) === 'error');
  check('severity：未知状态不伪装成错误', draftRowSeverity({ status: 'other' }) === 'info');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
