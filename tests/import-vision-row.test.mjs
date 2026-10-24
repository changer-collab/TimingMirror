#!/usr/bin/env node
/**
 * import-vision unresolved[].row 窄范围归一化（纯函数；不联网、不调用模型）。
 * 覆盖：数字/纯数字字符串/固定中文行号格式、异常值降级为 null、7+2 草稿保留、
 * column_mapping 兼容、文本通道不放宽、非法结构错误码与前端行号展示。
 * 运行：node tests/import-vision-row.test.mjs
 */
import { validateImportVisionResponse } from '../server/site-functions/importVision.mjs';
import {
  coerceUnresolvedRow,
  validateImportRecoverResponse,
} from '../server/site-functions/importRecover.mjs';
import { buildAiDraft, unresolvedRowLabel } from '../src/engine/importDraft.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TRADE = {
  date: '2026-09-28', symbol: '603336', side: '卖出', price: '10.11', quantity: '100',
  fee: null, tax: null, confidence: 0.9, issues: [],
};
const bodyForRow = (row, extra = {}) => JSON.stringify({
  trades: [TRADE],
  unresolved: [{ row, reason: '方向未识别' }],
  ...extra,
});

/* —— 可安全转换 —— */
{
  const cases = [
    ['非负整数保持不变', 6, 6],
    ['行号 0 保持为 0', 0, 0],
    ['纯数字字符串转数字', '6', 6],
    ['前导零数字字符串转数字', '06', 6],
    ['第6行', '第6行', 6],
    ['记录6', '记录6', 6],
    ['记录 6', '记录 6', 6],
    ['字符串 0', '0', 0],
    ['首尾空白纯数字', ' 6 ', 6],
  ];
  for (const [name, input, expected] of cases) {
    const out = validateImportVisionResponse(bodyForRow(input));
    check(`row：${name}`, out.ok === true && out.value.unresolved.length === 1
      && out.value.unresolved[0].row === expected,
    JSON.stringify(out.ok ? out.value.unresolved : out.diagnostics));
  }
}

/* —— 无法安全转换：统一 null，不丢 unresolved、不整批失败 —— */
{
  const cases = [
    ['空字符串', ''],
    ['未知文本', '大概是第6行'],
    ['非固定后缀', '6行'],
    ['非固定前缀', '第6'],
    ['负数', -1],
    ['负数字符串', '-1'],
    ['小数', 1.5],
    ['小数字符串', '1.5'],
    ['对象', { row: 6 }],
    ['数组', [6]],
    ['布尔值', true],
    ['双空格记录格式', '记录  6'],
    ['超大数字字符串', '99999999999999999999'],
    ['null', null],
  ];
  for (const [name, input] of cases) {
    const out = validateImportVisionResponse(bodyForRow(input));
    check(`row：${name} 降级为 null 且保留记录`, out.ok === true
      && out.value.unresolved.length === 1
      && out.value.unresolved[0].row === null
      && out.value.unresolved[0].reason === '方向未识别',
    JSON.stringify(out.ok ? out.value.unresolved : out.diagnostics));
  }
  check('row：省略 row 仍归一化为 null', validateImportVisionResponse(JSON.stringify({
    trades: [TRADE], unresolved: [{ reason: '方向未识别' }],
  })).value.unresolved[0].row === null);
  check('row：coerceUnresolvedRow 不接受任意文本提取数字', coerceUnresolvedRow('前6后') === null
    && coerceUnresolvedRow('第 6 行') === null && coerceUnresolvedRow('记录：6') === null);
}

/* —— 线上失败形态：7 trades + 2 unresolved，row 格式异常仍返回草稿 —— */
{
  const trades = Array.from({ length: 7 }, (_, index) => ({
    ...TRADE,
    date: `2026-09-${String(20 + index).padStart(2, '0')}`,
    side: index % 2 === 0 ? '卖出' : '买入',
  }));
  const unresolved = [
    { row: '第6行', reason: '方向无法确定' },
    { row: '无法定位', reason: '可能是证券转银行' },
  ];
  const columnMapping = [
    { source_label: '名称/代码', source_subfield: '代码', target_field: 'symbol', confidence: 'high' },
    { source_label: '成交价/量', source_subfield: '成交价', target_field: 'price', confidence: 'high' },
  ];
  const out = validateImportVisionResponse(JSON.stringify({ trades, unresolved, column_mapping: columnMapping }));
  check('7+2：row 异常时响应仍通过', out.ok === true
    && out.value.trades.length === 7
    && out.value.unresolved.length === 2
    && out.value.unresolved[0].row === 6
    && out.value.unresolved[1].row === null, JSON.stringify(out.ok ? out.value.unresolved : out.diagnostics));
  check('7+2：column_mapping 仍通过且保留', out.ok === true
    && out.value.column_mapping.length === 2
    && out.value.column_mapping[0].target_field === 'symbol', JSON.stringify(out.value?.column_mapping));

  const draft = buildAiDraft({
    aiTrades: out.value.trades,
    unresolved: out.value.unresolved,
    columnMapping: out.value.column_mapping,
    sourceFile: '交割单截图',
    duplicatePolicy: 'warn',
    nonTradePolicy: 'unresolved',
  });
  check('7+2：仍生成 7 条可编辑草稿与 2 条未确定记录', draft.rows.length === 7
    && draft.rows.every((row) => row.include !== false)
    && draft.unresolved.length === 2
    && draft.unresolved[0].row === 6
    && draft.unresolved[1].row === null, JSON.stringify({
    rows: draft.rows.length,
    unresolved: draft.unresolved,
  }));
}

/* —— 范围边界：文本通道、column_mapping 与非法结构不放宽 —— */
{
  const textWithStringRow = validateImportRecoverResponse(bodyForRow('6'));
  check('范围：文字通道仍拒绝字符串 row', textWithStringRow.ok === false
    && textWithStringRow.diagnostics?.validation_reason === 'unresolved_row_invalid'
    && textWithStringRow.diagnostics?.field === 'unresolved[].row',
  JSON.stringify(textWithStringRow.diagnostics));
  const textWithNumberRow = validateImportRecoverResponse(bodyForRow(6));
  check('范围：文字通道数字 row 仍合法', textWithNumberRow.ok === true
    && textWithNumberRow.value.unresolved[0].row === 6);

  const badTrades = validateImportVisionResponse(JSON.stringify({ trades: 'x', unresolved: [] }));
  check('结构：trades 类型错误仍按原错误码失败', badTrades.ok === false
    && badTrades.code === 'E_IMPORT_RECOVER_RESPONSE_INVALID'
    && badTrades.diagnostics?.validation_reason === 'trades_not_array', JSON.stringify(badTrades.diagnostics));
  const badReason = validateImportVisionResponse(JSON.stringify({
    trades: [], unresolved: [{ row: '6', reason: '' }],
  }));
  check('结构：unresolved reason 仍严格校验', badReason.ok === false
    && badReason.diagnostics?.validation_reason === 'unresolved_reason_invalid', JSON.stringify(badReason.diagnostics));
  const badMapping = validateImportVisionResponse(JSON.stringify({
    trades: [TRADE],
    unresolved: [{ row: '6', reason: '方向未识别' }],
    column_mapping: [{ source_label: '成交价', source_subfield: null, target_field: 'note', confidence: 'high' }],
  }));
  check('结构：非法 column_mapping 仍按原错误码失败', badMapping.ok === false
    && badMapping.diagnostics?.validation_reason === 'column_mapping_target_invalid', JSON.stringify(badMapping.diagnostics));
}

/* —— 前端行号展示 —— */
{
  check('展示：数字 row 显示记录 N', unresolvedRowLabel(6) === '记录 6'
    && unresolvedRowLabel(0) === '记录 0');
  check('展示：null/异常 row 显示未标明原图行号', [null, undefined, '6', '第6行', 1.5].every(
    (value) => unresolvedRowLabel(value) === '未标明原图行号',
  ), [null, undefined, '6', '第6行', 1.5].map(unresolvedRowLabel).join('|'));
  check('展示：不会出现记录 undefined', !unresolvedRowLabel(null).includes('undefined')
    && !unresolvedRowLabel(undefined).includes('undefined'));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
