#!/usr/bin/env node
/**
 * 草稿校验反馈分类回归（纯函数；不联网、不触发模型）。
 * 覆盖：全部可导入不产生行级摘要、行级/账本级错误分开、空选择提示、warning 不升级为阻断。
 * 运行：node tests/import-draft-feedback.test.mjs
 */
import {
  draftToNormalized,
  draftValidationFeedback,
  splitDraftValidationErrors,
} from '../src/engine/importDraft.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function row(line, fields, extra = {}) {
  return {
    id: `draft-${line}`,
    source: 'ai',
    line,
    fields: {
      date: '2024-09-24',
      symbol: '600519',
      name: '',
      side: '买入',
      price: '10.00',
      quantity: '100',
      amount: '',
      settlementAmount: '',
      fee: '',
      tax: '',
      ...fields,
    },
    include: true,
    duplicateOf: null,
    trade: null,
    status: 'valid',
    issues: [],
    warnings: [],
    ...extra,
  };
}

function draftOf(rows, unresolved = []) {
  return { origin: 'ai', headerOk: true, missing: [], rows, rawRows: [], unresolved, columnMapping: [] };
}

/* —— 全部可导入：不产生“需要修正”摘要 —— */
{
  const rows = [
    row(2, { side: '买入' }),
    row(3, { date: '2024-09-25', side: '卖出' }),
  ];
  const draft = draftOf(rows);
  const checked = draftToNormalized(draft, 'vision.png');
  const feedback = draftValidationFeedback({ draft, normalized: checked.normalized, included: checked.included });
  check('全部可导入：最终校验通过', checked.ok === true, JSON.stringify(checked));
  check('全部可导入：反馈为通过且无行级/账本级错误',
    feedback.kind === 'ok' && feedback.rowErrors.length === 0 && feedback.ledgerErrors.length === 0,
    JSON.stringify(feedback));
  check('全部可导入：页面文案不含“需要修正的行”',
    !feedback.message.includes('需要修正的行') && feedback.message === '已通过校验，可用于导入',
    feedback.message);
}

/* —— 账本级错误：独立提示，不伪装成行级修正 —— */
{
  const rows = [
    row(2, { side: '买入' }),
    row(3, { date: '2024-09-25', side: '卖出' }),
    row(4, { date: '2024-09-26', side: '买入' }),
    row(5, { date: '2024-09-27', side: '卖出' }),
    row(6, { date: '2024-09-30', symbol: '603336', side: '卖出', quantity: '150' }),
  ];
  const draft = draftOf(rows);
  const checked = draftToNormalized(draft, 'vision.png');
  const feedback = draftValidationFeedback({ draft, normalized: checked.normalized, included: checked.included });
  check('账本级：所有行仍为可导入状态', rows.every((item) => item.status === 'valid'));
  check('账本级：最终校验被持仓累计阻断', checked.ok === false
    && checked.normalized.errors.every((error) => error.code === 'E_QTY_EXCEEDS'),
  JSON.stringify(checked.normalized?.errors));
  check('账本级：反馈为 ledger_error 且无行级错误',
    feedback.kind === 'ledger_error' && feedback.rowErrors.length === 0 && feedback.ledgerErrors.length === 1,
    JSON.stringify(feedback));
  check('账本级：只显示具体持仓原因',
    feedback.message === '账本校验未通过：第 6 行卖出数量超过当前持仓，可能缺少期初持仓。'
    && !feedback.message.includes('需要修正的行'), feedback.message);
  check('账本级：提供处理建议', /请补录期初持仓/.test(feedback.ledgerAdvice), feedback.ledgerAdvice);
}

/* —— 行级错误：统计需要修正的行并定位第一行 —— */
{
  const rows = [
    row(2, { side: '买入' }),
    row(3, { date: '2024-09-25', side: '卖出', symbol: 'ABC' }),
  ];
  const draft = draftOf(rows);
  const checked = draftToNormalized(draft, 'vision.png');
  const feedback = draftValidationFeedback({ draft, normalized: checked.normalized, included: checked.included });
  check('行级：反馈为 row_error 且有 1 行需要修正',
    feedback.kind === 'row_error' && feedback.rowErrorCount === 1 && feedback.message === '有 1 行需要修正',
    JSON.stringify(feedback));
  check('行级：定位第一条错误行', feedback.firstRowId === 'draft-3', feedback.firstRowId);
  check('行级：账本级错误为空', feedback.ledgerErrors.length === 0);
}

/* —— 行级与账本级同时存在：分别保留 —— */
{
  const split = splitDraftValidationErrors([
    { line: 3, code: 'E_SYMBOL_FORMAT', message: '标的错误' },
    { line: 6, code: 'E_QTY_EXCEEDS', message: '持仓不足' },
  ]);
  const feedback = draftValidationFeedback({
    draft: draftOf([row(3, { symbol: 'ABC' }), row(6, { symbol: '603336', side: '卖出', quantity: '150' })]),
    normalized: { errors: [{ line: 3, code: 'E_SYMBOL_FORMAT', message: '标的错误' }, { line: 6, code: 'E_QTY_EXCEEDS', message: '持仓不足' }] },
    included: [row(3), row(6)],
  });
  check('同时存在：分类互不覆盖', split.rowErrors.length === 1 && split.ledgerErrors.length === 1);
  check('同时存在：反馈同时携带两类错误', feedback.rowErrors.length === 1 && feedback.ledgerErrors.length === 1
    && feedback.kind === 'row_error');
}

/* —— 未选择交易 —— */
{
  const feedback = draftValidationFeedback({ draft: draftOf([]), normalized: null, included: [] });
  check('未选择：提示请至少选择一条交易', feedback.kind === 'empty' && feedback.message === '请至少选择一条交易',
    JSON.stringify(feedback));
}

/* —— warning 不升级为阻断 —— */
{
  const rows = [row(2, { fee: '', tax: '' }, {
    status: 'valid',
    warnings: [{ code: 'W_FEE_MISSING_AS_ZERO' }, { code: 'W_TAX_MISSING_AS_ZERO' }],
  })];
  const draft = draftOf(rows);
  const checked = draftToNormalized(draft, 'vision.png');
  const feedback = draftValidationFeedback({ draft, normalized: checked.normalized, included: checked.included });
  check('warning：费用/税费为空不产生阻断错误', checked.ok === true && feedback.kind === 'ok'
    && feedback.rowErrors.length === 0 && feedback.ledgerErrors.length === 0,
  JSON.stringify({ ok: checked.ok, feedback }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
