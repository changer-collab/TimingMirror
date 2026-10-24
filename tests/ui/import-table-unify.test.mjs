#!/usr/bin/env node
/**
 * 导入结果表格统一渲染回归（无浏览器、无模型）。
 * 直接调用线上入口 renderRealImport，检查图片草稿与文件确认表的表头、可编辑/只读边界、
 * 费用税费空值与金额补充展示。
 * 运行：node tests/ui/import-table-unify.test.mjs
 */
import { renderRealImport } from '../../prototype/user-frontend/realImport.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const HEADER = '<th class="tm-col-line">行</th><th>日期</th><th>标的</th><th>方向</th><th class="num">价格</th><th class="num">数量</th><th class="num">费用</th><th class="num">税费</th><th class="tm-col-status">状态</th><th class="tm-col-action">操作</th>';

function fakeHost() {
  return {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

const mapping = [
  { source_label: '成交日期', source_subfield: null, target_field: 'date', confidence: 'high' },
  { source_label: '交收日期', source_subfield: null, target_field: 'settlement_date', confidence: 'medium' },
  { source_label: '名称/代码', source_subfield: '代码', target_field: 'symbol', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '成交价', target_field: 'price', confidence: 'high' },
  { source_label: '成交价/量', source_subfield: '量', target_field: 'quantity', confidence: 'high' },
  { source_label: '成交/清算额', source_subfield: '成交额', target_field: 'amount', confidence: 'medium' },
  { source_label: '成交/清算额', source_subfield: '清算额', target_field: 'settlement_amount', confidence: 'medium' },
];

const draftRow = {
  id: 'draft-1',
  source: 'ai',
  line: 2,
  fields: {
    date: '2024-09-24',
    symbol: '600519',
    name: '贵州茅台',
    side: '买入',
    price: '100.00',
    quantity: '100',
    amount: '10,000.00',
    settlementAmount: '10,005.00',
    fee: '',
    tax: '',
  },
  include: true,
  duplicateOf: null,
  trade: null,
  status: 'valid',
  issues: [],
  warnings: [],
  confidence: 0.9,
};

const visionRecovery = {
  status: 'draft',
  sourceKind: 'image',
  fileName: '截图识别',
  fileSize: 0,
  content: '',
  pending: false,
  modelCalls: 0,
  budgetMax: 2,
  budgetExhausted: false,
  draft: { rows: [draftRow], unresolved: [], columnMapping: mapping },
  unresolved: [],
  notice: null,
  error: null,
  validationErrors: [],
  vision: { kind: 'image', images: [], status: 'ready', totalBytes: 0, payloadBytes: 0, notice: '' },
};

{
  const host = fakeHost();
  renderRealImport(host, { state: { bill: { status: 'none', contextId: 'ctx-vision' }, importRecovery: visionRecovery }, set() {}, go() {} });
  const html = host.innerHTML;

  check('图片草稿：使用统一 10 列表头', html.includes(HEADER), html.slice(0, 600));
  check('图片草稿：使用统一表格样式类', /<table class="ledger tm-import-table tm-draft-table">/.test(html));
  check('图片草稿：保留可编辑字段、方向下拉和删除按钮',
    ['date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax'].every((field) => html.includes(`data-field="${field}"`))
    && /<select class="tm-cell-input" data-row="draft-1" data-field="side">/.test(html)
    && /data-action="remove-row"/.test(html));
  check('图片草稿：费用税费为空且未匹配时不显示需修正',
    /data-field="fee" value=""[^>]*placeholder="未匹配"/.test(html)
    && /data-field="tax" value=""[^>]*placeholder="未匹配"/.test(html)
    && html.includes('可导入') && !html.includes('需修正'));
  check('图片草稿：交收日期来源提示保留', /title="原图使用交收日期，不代表成交日期；请逐行核对"/.test(html)
    && html.includes('原图列名映射') && html.includes('交收日期'));
  check('图片草稿：成交额/清算额只在补充信息展示',
    html.includes('原图金额补充') && html.includes('成交额 <b>10,000.00</b>')
    && html.includes('清算额 <b>10,005.00</b>')
    && !/data-field="fee" value="10,000.00"/.test(html)
    && !/data-field="tax" value="10,005.00"/.test(html)
    && /成交额、清算额只按原图展示，不写入费用或税费/.test(html));
  check('图片草稿：费用税费可留空说明可见', html.includes('费用、税费可留空'));
  check('图片草稿：仍提供手动新增成交行', /data-action="add-row"/.test(html) && html.includes('＋ 添加成交行'));
}

const trade = {
  trade_date: '2024-09-24',
  symbol: '600519',
  side: 'buy',
  price: 100,
  quantity: 100,
  fee: 5,
  tax: 1,
  source: { line: 2 },
};

{
  const host = fakeHost();
  const bill = {
    status: 'confirmed',
    contextId: 'ctx-file',
    fileName: 'bill.csv',
    fileSize: 128,
    demo: false,
    trades: [trade],
  };
  renderRealImport(host, {
    state: { bill, importRecovery: { ...visionRecovery, draft: null, status: 'accepted', vision: { kind: null, images: [], status: 'idle' } } },
    set() {},
    go() {},
  });
  const html = host.innerHTML;

  check('文件确认表：使用同一 10 列表头', html.includes(HEADER), html.slice(0, 600));
  check('文件确认表：使用统一表格样式类', /<table class="ledger tm-import-table">/.test(html));
  check('文件确认表：保持只读，无输入框/删除按钮', !/<input[^>]*class="tm-cell-input"/.test(html)
    && !/data-action="remove-row"/.test(html) && html.includes('只读'));
  check('文件确认表：显示已确认状态和金额', html.includes('已确认')
    && html.includes('5.00') && html.includes('1.00'));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
