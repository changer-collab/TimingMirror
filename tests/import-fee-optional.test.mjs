#!/usr/bin/env node
/**
 * 导入费用/税费可选字段回归（纯函数；不联网、不调用模型）。
 * 覆盖：视觉响应缺失/null/空串/全空格通过；成交额/清算额不进入 fee/tax；
 *       非空非法金额仍在草稿层失败；日期/标的/方向/价格/数量缺失仍阻断。
 * 运行：node tests/import-fee-optional.test.mjs
 */
import {
  buildAiDraft,
  draftRowSeverity,
  draftRowStatusText,
  draftToNormalized,
  refreshRowStatus,
} from '../src/engine/importDraft.js';
import { validateRecoveryResponse } from '../src/agent/importRecovery.js';
import { validateImportVisionResponse } from '../server/site-functions/importVision.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TRADE = Object.freeze({
  date: '2024-09-24',
  symbol: '600519',
  side: '买入',
  price: '100.00',
  quantity: '100',
  confidence: 0.9,
  issues: [],
});

const responseFor = (trade) => JSON.stringify({ trades: [trade], unresolved: [] });
const draftFor = (trade) => buildAiDraft({
  aiTrades: [trade],
  unresolved: [],
  localDraft: null,
  sourceFile: 'vision.png',
  duplicatePolicy: 'warn',
});

/* —— 视觉响应：可选 fee/tax —— */
{
  const missing = validateImportVisionResponse(responseFor(TRADE));
  check('响应：fee/tax 缺失通过并归一化为 null', missing.ok === true
    && missing.value.trades[0].fee === null && missing.value.trades[0].tax === null,
  JSON.stringify(missing));

  const nulls = validateImportVisionResponse(responseFor({ ...TRADE, fee: null, tax: null }));
  check('响应：fee/tax 为 null 通过', nulls.ok === true
    && nulls.value.trades[0].fee === null && nulls.value.trades[0].tax === null,
  JSON.stringify(nulls));

  const blanks = validateImportVisionResponse(responseFor({ ...TRADE, fee: '', tax: '   ' }));
  check('响应：fee/tax 为空串或全空格通过并规范为 null', blanks.ok === true
    && blanks.value.trades[0].fee === null && blanks.value.trades[0].tax === null,
  JSON.stringify(blanks));

  const amounts = validateImportVisionResponse(responseFor({
    ...TRADE,
    amount: '123456.78',
    settlement_amount: '123460.00',
  }));
  check('响应：成交额/清算额保留原字段，不写进 fee/tax', amounts.ok === true
    && amounts.value.trades[0].fee === null && amounts.value.trades[0].tax === null
    && amounts.value.trades[0].amount === '123456.78'
    && amounts.value.trades[0].settlement_amount === '123460.00', JSON.stringify(amounts.value?.trades?.[0]));

  const badType = validateImportVisionResponse(responseFor({ ...TRADE, fee: { value: 1 } }));
  check('响应：非空非法类型的 fee 仍拒绝', badType.ok === false
    && badType.code === 'E_IMPORT_RECOVER_RESPONSE_INVALID', JSON.stringify(badType.diagnostics));

  const clientMissing = validateRecoveryResponse(responseFor(TRADE), { allowColumnMapping: true });
  check('客户端响应：fee/tax 缺失通过', clientMissing.ok === true
    && clientMissing.trades[0].fee === null && clientMissing.trades[0].tax === null,
  JSON.stringify(clientMissing));

  const clientBlanks = validateRecoveryResponse(responseFor({ ...TRADE, fee: ' ', tax: '' }), { allowColumnMapping: true });
  check('客户端响应：空串/全空格通过并规范为 null', clientBlanks.ok === true
    && clientBlanks.trades[0].fee === null && clientBlanks.trades[0].tax === null,
  JSON.stringify(clientBlanks));

  const clientAmounts = validateRecoveryResponse(responseFor({
    ...TRADE,
    amount: '123456.78',
    settlement_amount: '123460.00',
  }), { allowColumnMapping: true });
  check('客户端响应：成交额/清算额不写进 fee/tax', clientAmounts.ok === true
    && clientAmounts.trades[0].fee === null && clientAmounts.trades[0].tax === null,
  JSON.stringify(clientAmounts.trades?.[0]));
}

/* —— 草稿：空费用不阻断、非空非法仍失败 —— */
{
  const missing = draftFor(TRADE);
  const row = missing.rows[0];
  check('草稿：fee/tax 缺失为可导入，不显示需修正', row.status === 'valid'
    && draftRowStatusText(row) === '可导入' && draftRowSeverity(row) === 'success'
    && row.warnings.some((w) => w.code === 'W_FEE_MISSING_AS_ZERO')
    && row.warnings.some((w) => w.code === 'W_TAX_MISSING_AS_ZERO'),
  JSON.stringify({ status: row.status, text: draftRowStatusText(row), warnings: row.warnings }));

  const normalized = draftToNormalized(missing, 'vision.png');
  check('草稿：空费用最终按 0 入账并标记缺失', normalized.ok === true
    && normalized.normalized.trades[0].fee === 0
    && normalized.normalized.trades[0].tax === 0
    && normalized.normalized.trades[0].fee_missing === true
    && normalized.normalized.trades[0].tax_missing === true,
  JSON.stringify(normalized.normalized?.trades?.[0]));

  const blanks = draftFor({ ...TRADE, fee: '   ', tax: ' \t ' });
  check('草稿：全空格费用规范为空且仍可导入', blanks.rows[0].status === 'valid'
    && blanks.rows[0].fields.fee === '' && blanks.rows[0].fields.tax === '',
  JSON.stringify(blanks.rows[0]));

  const refreshed = refreshRowStatus({
    ...blanks.rows[0],
    fields: { ...blanks.rows[0].fields, fee: '  ', tax: ' ' },
  }, 'vision.png');
  check('草稿：编辑后全空格费用仍规范为空', refreshed.fields.fee === ''
    && refreshed.fields.tax === '' && refreshed.status === 'valid', JSON.stringify(refreshed));

  const nonNumeric = draftFor({ ...TRADE, fee: 'abc' });
  check('草稿：非空非法费用标记需修正', nonNumeric.rows[0].status === 'invalid'
    && draftRowStatusText(nonNumeric.rows[0]) === '需修正'
    && nonNumeric.rows[0].issues.some((text) => text.includes('费用')),
  JSON.stringify(nonNumeric.rows[0]));

  const precision = draftFor({ ...TRADE, tax: '1.234' });
  check('草稿：费用超精度标记需修正', precision.rows[0].status === 'invalid'
    && precision.rows[0].issues.some((text) => text.includes('2 位小数')),
  JSON.stringify(precision.rows[0]));

  const amountsOnly = draftFor({
    ...TRADE,
    amount: '123456.78',
    settlement_amount: '123460.00',
  });
  check('草稿：成交额/清算额保留在展示字段，不成为 fee/tax',
    amountsOnly.rows[0].fields.fee === '' && amountsOnly.rows[0].fields.tax === ''
    && amountsOnly.rows[0].fields.amount === '123456.78'
    && amountsOnly.rows[0].fields.settlementAmount === '123460.00'
    && amountsOnly.rows[0].status === 'valid', JSON.stringify(amountsOnly.rows[0]));
}

/* —— 核心字段仍然阻断 —— */
for (const [key, label] of [
  ['date', '日期'],
  ['symbol', '标的'],
  ['side', '方向'],
  ['price', '价格'],
  ['quantity', '数量'],
]) {
  const incomplete = draftFor({ ...TRADE, [key]: '' });
  const row = incomplete.rows[0];
  const normalized = draftToNormalized(incomplete, 'vision.png');
  check(`核心字段：缺少${label}仍阻断`, row.status === 'needs_review'
    && row.issues.length > 0
    && normalized.ok === false && normalized.normalized.blocked === true,
  JSON.stringify({ status: row.status, issues: row.issues, ok: normalized.ok }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
