#!/usr/bin/env node
/**
 * 导入草稿“校验并用于导入”按钮运行时回归（无浏览器、无模型）。
 * 直接渲染线上入口并触发真实 click handler，覆盖成功、失败定位、未选行、
 * unresolved 不阻断、行详情展开。
 * 运行：node tests/ui/import-validate-cta.test.mjs
 */
import { renderRealImport } from '../../prototype/user-frontend/realImport.js';

globalThis.requestAnimationFrame = (fn) => fn();

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function actionButtons(html) {
  return [...html.matchAll(/<button\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const action = tag.match(/data-action="([^"]+)"/)?.[1];
    if (!action) return null;
    const attrs = {};
    for (const attr of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) attrs[`data-${attr[1]}`] = attr[2];
    return {
      __action: action,
      __attrs: attrs,
      __handlers: {},
      getAttribute(name) { return attrs[name] ?? null; },
      addEventListener(type, fn) { this.__handlers[type] = fn; },
    };
  }).filter(Boolean);
}

function makeHost() {
  const buttons = new Map();
  const host = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector !== '[data-action]') return [];
      buttons.clear();
      const found = actionButtons(host.innerHTML);
      found.forEach((button) => buttons.set(button.__action, button));
      return found;
    },
    __buttons: buttons,
  };
  return host;
}

function row(overrides = {}) {
  return {
    id: 'draft-1',
    source: 'ai',
    line: 2,
    include: true,
    duplicateOf: null,
    detailOpen: false,
    fields: {
      date: '2024-09-24',
      symbol: '600519',
      name: '贵州茅台',
      side: '买入',
      price: '100.00',
      quantity: '100',
      amount: '',
      settlementAmount: '',
      fee: '',
      tax: '',
    },
    trade: null,
    status: 'valid',
    issues: [],
    warnings: [],
    confidence: 0.9,
    ...overrides,
  };
}

function recovery(rows, extra = {}) {
  return {
    status: 'draft',
    sourceKind: 'image',
    fileName: '交割单截图',
    fileSize: 0,
    content: '',
    pending: false,
    modelCalls: 0,
    budgetMax: 2,
    budgetExhausted: false,
    draft: { rows, unresolved: [], columnMapping: [] },
    unresolved: [],
    notice: null,
    error: null,
    validationErrors: [],
    validationState: null,
    vision: { kind: 'image', images: [], status: 'ready', totalBytes: 0, payloadBytes: 0, notice: '' },
    ...extra,
  };
}

function mount(rec) {
  const state = { bill: { status: 'none', contextId: 'ctx-test' }, importRecovery: rec };
  const host = makeHost();
  const ctx = {
    state,
    set(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)
          && state[key] && typeof state[key] === 'object' && !Array.isArray(state[key])) {
          state[key] = { ...state[key], ...value };
        } else {
          state[key] = value;
        }
      }
      renderRealImport(host, ctx);
    },
    go() {},
  };
  renderRealImport(host, ctx);
  return { host, ctx, state };
}

function validateButton(host) {
  const button = host.__buttons.get('validate');
  check('校验按钮：渲染后存在真实 click handler', !!button && typeof button.__handlers.click === 'function');
  return button;
}

/* —— 成功：状态变化 + 进入既有确认流程 —— */
{
  const { host, state } = mount(recovery([row()]));
  const button = validateButton(host);
  button.__handlers.click();
  await flush();
  check('校验成功：进入 accepted 并加载本地账单', state.importRecovery.status === 'accepted'
    && state.bill.status === 'loaded', JSON.stringify({ rec: state.importRecovery.status, bill: state.bill.status }));
  check('校验成功：显示“已通过校验，可用于导入”', state.importRecovery.validationState?.status === 'success'
    && state.importRecovery.validationState.message === '已通过校验，可用于导入'
    && host.innerHTML.includes('已通过校验，可用于导入'));
  check('校验成功：沿用既有确认按钮，不新增接口', /data-action="confirm"/.test(host.innerHTML)
    && host.innerHTML.includes('确认并生成报告'));
}

/* —— 失败：错误摘要 + 定位第一条错误 —— */
{
  const bad = row({ id: 'draft-bad', line: 2, symbol: '123' });
  bad.fields.symbol = '123';
  const good = row({ id: 'draft-good', line: 3 });
  const { host, state } = mount(recovery([bad, good]));
  const button = validateButton(host);
  button.__handlers.click();
  await flush();
  check('校验失败：显示“请先修正以下字段”且账单未加载', state.importRecovery.validationState?.status === 'error'
    && state.importRecovery.validationState.message === '请先修正以下字段'
    && state.bill.status === 'none'
    && host.innerHTML.split('请先修正以下字段').length - 1 === 1);
  check('校验失败：摘要列出真实 invalid 原因', /第 2 行 · 标的（须 6 位数字代码）：123/.test(host.innerHTML)
    && host.innerHTML.includes('需修正') && host.innerHTML.includes('标的需为 6 位数字代码'));
  check('校验失败：定位第一条错误行且只标记一行', state.importRecovery.validationState.focusRowId === 'draft-bad'
    && host.innerHTML.split('data-validation-focus="true"').length - 1 === 1
    && /data-row-id="draft-bad"[^>]*data-validation-focus="true"/.test(host.innerHTML));
}

/* —— 未选择交易 —— */
{
  const excluded = row({ id: 'draft-excluded', include: false });
  const { host, state } = mount(recovery([excluded]));
  const button = validateButton(host);
  button.__handlers.click();
  await flush();
  check('未选择交易：显示“请至少选择一条交易”', state.importRecovery.validationState?.status === 'error'
    && state.importRecovery.validationState.message === '请至少选择一条交易'
    && host.innerHTML.split('请至少选择一条交易').length - 1 === 1
    && state.bill.status === 'none');
}

/* —— unresolved 不阻断合法交易，摘要与说明各一次 —— */
{
  const rec = recovery([row()], {
    draft: {
      rows: [row()],
      unresolved: [{ row: 3, reason: '银行转证券，非买入或卖出交易' }],
      columnMapping: [],
    },
    unresolved: [{ row: 3, reason: '银行转证券，非买入或卖出交易' }],
  });
  const { host, state } = mount(rec);
  const html = host.innerHTML;
  check('unresolved：顶部摘要只出现一次', html.split('已识别 1 条交易，另有 1 条待处理').length - 1 === 1);
  check('unresolved：全局提示只出现一次', html.split('有 1 条记录未进入交易草稿，请查看下方说明').length - 1 === 1);
  check('unresolved：明细使用简洁格式', html.includes('记录 3：银行转证券，非买入或卖出交易'));
  check('unresolved：底部统一说明存在且只出现一次',
    html.split('未确定记录不会自动导入，请根据原图手动处理。').length - 1 === 1);
  const button = validateButton(host);
  button.__handlers.click();
  await flush();
  check('unresolved：合法交易仍可校验成功', state.importRecovery.status === 'accepted'
    && state.bill.status === 'loaded', JSON.stringify({ rec: state.importRecovery.status, bill: state.bill.status }));
}

/* —— 提示分层：摘要/交收日期/费用为空各只出现一次 —— */
{
  const review = row({
    id: 'draft-notice',
    status: 'needs_review',
    issues: ['使用交收日期'],
  });
  const rec = recovery([review], {
    draft: {
      rows: [review],
      unresolved: [],
      columnMapping: [{ source_label: '交收日期', source_subfield: null, target_field: 'settlement_date', confidence: 'high' }],
    },
  });
  const { host } = mount(rec);
  const html = host.innerHTML;
  check('提示分层：顶部摘要只出现一次', html.split('已识别 1 条交易').length - 1 === 1);
  check('提示分层：交收日期提示只在全局出现一次',
    html.split('当前日期来自交收日期，请确认后再导入').length - 1 === 1
    && !html.includes('title="原图使用交收日期')
    && !html.includes('使用交收日期'));
  check('提示分层：费用为空提示只在全局出现一次',
    html.split('费用、税费为空时保留为空，可在确认前补填').length - 1 === 1);
  check('提示分层：待确认行仍保留简短标签和展开入口', html.includes('待确认')
    && /data-action="toggle-row-detail"/.test(html));
}

/* —— 行详情：默认收起，点击后展开 —— */
{
  const review = row({
    id: 'draft-review',
    status: 'needs_review',
    fields: { ...row().fields, side: '' },
    issues: ['方向只能是买入或卖出'],
  });
  const { host } = mount(recovery([review]));
  check('行详情：待确认行默认只显示短标签', host.innerHTML.includes('待确认')
    && !host.innerHTML.includes('方向只能是买入或卖出')
    && /data-action="toggle-row-detail"/.test(host.innerHTML));
  const toggle = host.__buttons.get('toggle-row-detail');
  check('行详情：存在真实展开按钮', !!toggle && typeof toggle.__handlers.click === 'function');
  toggle.__handlers.click();
  await flush();
  check('行详情：展开后显示具体原因', host.innerHTML.includes('方向只能是买入或卖出')
    && host.innerHTML.includes('收起'));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
