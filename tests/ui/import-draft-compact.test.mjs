#!/usr/bin/env node
/**
 * 图片识别草稿页信息层级与重新导入回归（无浏览器、无模型）。
 * 覆盖：顶部单条摘要、提示只出现一次、折叠区域、校验反馈分层、重新导入纯状态。
 * 运行：node tests/ui/import-draft-compact.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  renderRealImport,
  buildReimportRecovery,
  reimportRequiresConfirm,
  cancelReimport,
} from '../../prototype/user-frontend/realImport.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const live = readFileSync(join(ROOT, 'prototype/user-frontend/realImport.js'), 'utf8');
const css = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function fakeHost() {
  return { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
}

const mapping = [
  { source_label: '交收日期', source_subfield: null, target_field: 'settlement_date', confidence: 'medium' },
  { source_label: '名称/代码', source_subfield: '代码', target_field: 'symbol', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '成交价', target_field: 'price', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '量', target_field: 'quantity', confidence: 'high' },
];

const rows = Array.from({ length: 6 }, (_, index) => ({
  id: `draft-${index + 1}`,
  source: 'ai',
  line: index + 2,
  fields: {
    date: `2024-09-${String(24 + index).padStart(2, '0')}`,
    symbol: '600519',
    name: '贵州茅台',
    side: index % 2 === 0 ? '买入' : '卖出',
    price: '100.00',
    quantity: '100',
    amount: `1${index},000.00`,
    settlementAmount: `1${index},005.00`,
    fee: '',
    tax: '',
  },
  include: true,
  duplicateOf: null,
  trade: null,
  status: 'valid',
  issues: [],
  warnings: [],
}));

const unresolved = [
  { row: 3, reason: '银行转证券，非买入或卖出交易' },
  { row: 5, reason: '银行转证券，非买入或卖出交易' },
];

function visionRecovery(extra = {}) {
  return {
    status: 'draft',
    sourceKind: 'image',
    fileName: '截图识别',
    fileSize: 0,
    content: '',
    pending: false,
    modelCalls: 2,
    budgetMax: 2,
    budgetExhausted: true,
    draft: { rows, unresolved, columnMapping: mapping },
    unresolved,
    notice: 'AI 返回 6 条交易草稿，另有 2 条未确定记录',
    error: null,
    validationErrors: [],
    validationFeedback: null,
    draftDirty: false,
    reimportConfirm: false,
    vision: { kind: 'image', images: [], status: 'ready', totalBytes: 0, payloadBytes: 0, notice: '' },
    ...extra,
  };
}

function render(recovery, bill = { status: 'none', contextId: 'ctx-draft' }) {
  const host = fakeHost();
  renderRealImport(host, { state: { bill, importRecovery: recovery }, set() {}, go() {} });
  return host.innerHTML;
}

/* —— 信息层级 —— */
{
  const html = render(visionRecovery());
  check('顶部只保留一条摘要', html.includes('已识别 6 条交易 · 可导入 6 条 · 2 条待处理')
    && !html.includes('已整理 6 行草稿') && !html.includes('已选 6 行 · 可导入 6 行'),
  html.slice(0, 700));
  check('识别次数改为次要信息', html.includes('本次识别已用 2/2 次')
    && !html.includes('AI 返回 6 条交易草稿') && !html.includes('剩余 0 次'));
  check('交收日期提示只出现一次且为紧凑 warning',
    html.split('日期来自交收日期，请确认').length === 2
    && !html.includes('title="原图使用交收日期，不代表成交日期；请逐行核对"'));
  check('费用/税费提示只出现一次', html.split('未识别到费用/税费，可在确认前补填').length === 2
    && !/data-field="fee" value=""[^>]*placeholder="未匹配"/.test(html)
    && !/data-field="tax" value=""[^>]*placeholder="未匹配"/.test(html));
  check('识别详情默认折叠并显示摘要', /<details class="tm-vision-details">/.test(html)
    && !/<details class="tm-vision-details" open/.test(html)
    && html.includes('列名映射 4 项 · 金额补充 6 行')
    && html.includes('原图列名映射') && html.includes('原图金额补充'));
  check('未确定记录默认折叠且保留各自原因', /<details class="tm-unresolved-details">/.test(html)
    && !/<details class="tm-unresolved-details" open/.test(html)
    && html.includes('2 条记录未进入交易草稿')
    && html.includes('记录 3：银行转证券，非买入或卖出交易')
    && html.includes('记录 5：银行转证券，非买入或卖出交易'));
  check('底部未确定说明只出现一次', html.split('未确定记录不会自动导入，请根据原图手动处理。').length === 2);
  check('没有行级错误时不出现需要修正摘要', !html.includes('需要修正') && !html.includes('草稿里还有需要修正的行'));
  check('表格保留统一表头与编辑/删除/新增/勾选/重新导入',
    /<table class="ledger tm-import-table tm-draft-table">/.test(html)
    && ['行', '日期', '标的', '方向', '价格', '数量', '费用', '税费', '状态', '操作'].every((label) => html.includes(`>${label}<`))
    && /data-field="side"/.test(html) && /data-action="remove-row"/.test(html)
    && /data-action="add-row"/.test(html) && /data-include/.test(html)
    && /data-action="reimport"/.test(html) && /data-action="validate"/.test(html));
}

/* —— 校验反馈分层 —— */
{
  const html = render(visionRecovery({
    validationFeedback: {
      kind: 'ledger_error',
      rowErrors: [],
      ledgerErrors: [{ line: 6, code: 'E_QTY_EXCEEDS' }],
      rowErrorCount: 0,
      ledgerMessage: '账本校验未通过：第 6 行卖出数量超过当前持仓，可能缺少期初持仓。',
      ledgerAdvice: '请补录期初持仓、调整卖出数量，或取消勾选该行后再校验。',
    },
  }));
  check('账本级：只显示独立持仓提示', html.includes('账本校验未通过：第 6 行卖出数量超过当前持仓，可能缺少期初持仓。')
    && html.includes('请补录期初持仓') && !html.includes('需要修正') && !html.includes('草稿里还有需要修正的行'));
}

{
  const html = render(visionRecovery({
    validationFeedback: {
      kind: 'row_error',
      rowErrors: [{ line: 2, code: 'E_DATE_FORMAT', message: '日期需写成 2024-09-25 这样的年-月-日' }],
      ledgerErrors: [],
      rowErrorCount: 1,
      ledgerMessage: '',
      ledgerAdvice: '',
    },
  }));
  check('行级：显示有 1 行需要修正并列出原因', html.includes('有 1 行需要修正')
    && html.includes('第 2 行 · 日期需写成 2024-09-25 这样的年-月-日')
    && !html.includes('账本校验未通过'));
}

{
  const html = render(visionRecovery({
    validationFeedback: { kind: 'empty', message: '请至少选择一条交易', rowErrors: [], ledgerErrors: [], rowErrorCount: 0 },
  }));
  check('未选择：页面显示请至少选择一条交易', html.includes('请至少选择一条交易'));
}

{
  const trade = {
    trade_date: '2024-09-24', symbol: '600519', side: 'buy', price: 100, quantity: 100,
    fee: 0, tax: 0, fee_missing: true, tax_missing: true, source: { line: 2 },
  };
  const html = render(visionRecovery({
    status: 'accepted',
    draftDirty: false,
    validationFeedback: { kind: 'ok', message: '已通过校验，可用于导入' },
  }), {
    status: 'loaded', contextId: 'ctx-loaded', fileName: '截图识别', fileSize: 0, trades: [trade],
  });
  check('校验成功：显示可用于导入并进入确认流程', html.includes('已通过校验，可用于导入')
    && html.includes('确认并生成报告'));
}

/* —— 重新导入确认 —— */
{
  const html = render(visionRecovery({ draftDirty: true, reimportConfirm: true }));
  check('重新导入：有未保存修改时出现确认提示', html.includes('重新导入会清除当前识别结果和手动修改，是否继续？')
    && /data-action="reimport-cancel"/.test(html) && /data-action="reimport-continue"/.test(html)
    && html.includes('取消') && html.includes('继续重新导入'));
}

/* —— 重新导入纯状态 —— */
{
  const source = visionRecovery({
    draftDirty: true,
    reimportConfirm: true,
    content: 'old content',
    validationErrors: [{ line: 6, code: 'E_QTY_EXCEEDS' }],
    error: { code: 'E_DRAFT_INVALID', message: '旧提示' },
    localDraft: { rows: [rows[0]] },
  });
  source.vision.images = [{ data_base64: 'AAAA', mime: 'image/jpeg' }];
  const next = buildReimportRecovery(source, { model_calls: 2, budget_max: 2, flow_id: 'flow-1' });
  check('重新导入：清空图片、草稿、手动行、unresolved、映射、错误和提示',
    next.draft === null && next.localDraft === null && next.unresolved.length === 0
    && next.vision.images.length === 0 && next.validationErrors.length === 0
    && next.validationFeedback === null && next.error === null && next.notice === null
    && next.reimportConfirm === false && next.draftDirty === false
    && next.fileName === '' && next.content === '');
  check('重新导入：保留已用识别次数与预算', next.modelCalls === 2 && next.budgetMax === 2
    && next.budgetExhausted === true && next.flowId === 'flow-1');
  check('重新导入：脏草稿需要确认，干净草稿不需要', reimportRequiresConfirm(source) === true
    && reimportRequiresConfirm(visionRecovery()) === false);
  const cancelled = cancelReimport(source);
  check('取消确认：草稿与修改标记保持不变，只收起确认', cancelled.draft === source.draft
    && cancelled.draftDirty === true && cancelled.reimportConfirm === false);
}

/* —— 重新导入实现边界 —— */
{
  const start = live.indexOf('function performReimport');
  const end = live.indexOf('function requestReimport', start);
  const block = live.slice(start, end);
  check('重新导入：不触发模型请求、不重置预算、不刷新页面', start >= 0
    && !/requestVision|requestRecovery|completeFlow|location\.reload|modelCalls\s*=/.test(block)
    && /buildReimportRecovery/.test(block) && /scrollToUpload/.test(block));
  check('重新导入：复用既有重置入口而非第二套清理', /function performReimport/.test(live)
    && /function requestReimport/.test(live) && !/function restartImport/.test(live));
}

/* —— 样式与移动端 —— */
{
  check('样式：折叠区与紧凑提示有独立样式', /\.tm-vision-details[,\s]/.test(css)
    && /\.tm-unresolved-details[,\s]/.test(css)
    && /\.tm-inline-warning\s*\{/.test(css)
    && /\.tm-draft-summary\s*\{/.test(css));
  check('样式：移动端折叠摘要换行且表格仍可横向滚动', /@media \(max-width: 820px\)[\s\S]*?\.tm-vision-details > summary,[\s\S]*?flex-direction: column/.test(css)
    && /\.tm-import-table-wrap\s*\{[\s\S]*?overscroll-behavior-x:\s*contain/.test(css));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
