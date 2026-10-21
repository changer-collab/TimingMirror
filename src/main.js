// 应用引导：能力状态条、页签导航、分析流程与数据状态提示、哈希路由、视图挂载
import { state, subscribe, notify, saveContractsDemo, loadContractsDemo } from './state.js';
import { el, clear, chip } from './ui/components.js';
import * as adapter from './demo/adapter.js';
import { renderImport } from './ui/views/importView.js';
import { renderReport } from './ui/views/reportView.js';
import { renderChat } from './ui/views/chatView.js';
import { renderContract } from './ui/views/contractView.js';
import { renderAssistantPanel, assistantDefaultOpen } from './ui/assistantPanel.js';

const NAV = [
  { id: 'import', label: '导入 · 确认', hash: '#/import' },
  { id: 'report', label: '报告 · 证据', hash: '#/report' },
  { id: 'chat', label: '分析问答', hash: '#/chat' },
  { id: 'contract', label: '交易规则', hash: '#/contract' },
];

const FLOW = [
  { n: 1, label: '导入账单', hash: '#/import' },
  { n: 2, label: '核对交易', hash: '#/import' },
  { n: 3, label: '查看报告', hash: '#/report' },
  { n: 4, label: '查看证据 / 设置规则', hash: '#/contract' },
];

const GLOSSARY = [
  ['估值日', '计算期末持仓价值时使用的收盘价日期。所选日期不是交易日时按口径使用最近的交易日，并同时显示请求日期与实际使用日期；当天缺价时相应结果不发布，不会改用其他日期。'],
  ['择时损耗', '对照收益（买入后持有不动）减去实际收益。正值表示买卖时机让结果比“持有不动”差，负值表示实际操作更好。'],
  ['反事实', '假设某一笔卖出没有发生、其余交易不变时的结果，用来看这一笔卖出的影响；它不是对未来的预测。'],
  ['阻断', '数据不完整或无法核对时（如账单校验未通过、估值日缺价、复核未通过），对应结论不发布，也不用替代数字或其他日期补上。'],
  ['证据', '每个数字的公式编号、用到的成交（含账单文件行号）和计算步骤，可在报告页“查看证据与计算路径”中逐项核对。'],
];

const VIEWS = { import: renderImport, report: renderReport, chat: renderChat, contract: renderContract };

function set(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && state[k] && typeof state[k] === 'object' && !Array.isArray(state[k])) {
      state[k] = { ...state[k], ...v };
    } else {
      state[k] = v;
    }
  }
  notify();
}

function go(id) {
  const target = `#/${id}`;
  if (location.hash === target) { state.route = id; renderShell(); renderView(); }
  else location.hash = target;
}

function isMobileLayout() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 1024px)').matches
    : false;
}

function toggleAssistant() {
  if (isMobileLayout()) {
    set({ assistant: { ...state.assistant, mobileView: !state.assistant.mobileView, open: true } });
  } else {
    set({ assistant: { ...state.assistant, open: !state.assistant.open } });
  }
}

const ctx = { state, set, go, adapter };

function routeFromHash() {
  const id = (location.hash || '#/import').replace(/^#\//, '');
  return VIEWS[id] ? id : 'import';
}

function flowStep(route, bill) {
  if (route === 'import') return ['loaded', 'invalid', 'confirmed'].includes(bill.status) ? 2 : 1;
  if (route === 'report') return 3;
  if (route === 'contract') return 4;
  return 0;
}

// 三种数据状态只由账单状态决定；报告页内的缺价 / 复核阻断由报告摘要单独说明
function dataState(bill) {
  if (bill.status === 'invalid' || bill.status === 'error') {
    return { kind: 'blocked', label: '阻断 · 本地账单不能分析', text: '账单读取失败或校验未通过，不能用于分析；请在导入页查看原因并修正。报告与规则测试仍使用示例账单，不读取该文件。' };
  }
  if (bill.status === 'confirmed' && bill.sourceType === 'local') {
    return { kind: 'user', label: '已确认本地账单 + Tushare 动态行情', text: `正在分析：${bill.fileName}（仅本机处理，未上传）；服务端只接收标的代码与日期范围，取最新已收盘日线（非实时）；取数失败或超出支持范围时阻断，不回退静态缓存或合成行情。` };
  }
  if (bill.status === 'loaded' && bill.sourceType === 'local') {
    return { kind: 'demo', label: '待确认本地账单', text: `本地账单 ${bill.fileName} 尚未确认，还没有用于分析；报告与规则测试当前使用示例账单。` };
  }
  return { kind: 'demo', label: '示例交易 + Tushare 动态行情', text: '当前使用示例交易与 Tushare 最新已收盘日线（服务端获取，非实时）；可在报告页切换到合成回归场景。' };
}

// 能力文案只做展示替换；ready 状态原样取自 adapter，不在此提升
function capabilityLabel(c) {
  return String(c.label || '').replace('fake 验证', '模拟验证');
}

function capabilityDetails() {
  const list = el('div', { class: 'cap-list' });
  for (const c of Object.values(adapter.CAPABILITY)) {
    list.append(el('div', { class: 'cap-item' }, [
      el('span', { class: `chip ${c.ready ? 'ok' : 'mode'}`.trim() }, [c.ready ? '已就绪' : '待验收']),
      el('span', {}, [capabilityLabel(c)]),
    ]));
  }
  list.append(el('div', { class: 'muted small' }, ['能力状态为开发口径；候选口径与模拟验证不代表正式可用。']));
  return el('details', { class: 'cap-details' }, [el('summary', {}, ['查看能力状态']), list]);
}

function shellHost() {
  let host = document.getElementById('flow');
  if (!host) {
    host = el('div', { id: 'flow', class: 'flow-host' });
    document.getElementById('nav').after(host);
  }
  return host;
}

function renderShell() {
  const chips = document.getElementById('capability-chips');
  clear(chips);
  const local = state.bill.status === 'confirmed' && state.bill.sourceType === 'local';
  const syntheticScene = state.report && (state.report.scenario === 'A' || state.report.scenario === 'Aprime');
  chips.append(
    local ? chip('Tushare 动态行情 · 最新已收盘日线（非实时）', 'ok') : chip(syntheticScene ? '合成回归场景' : '示例交易 + Tushare 动态行情', syntheticScene ? 'mode' : 'ok'),
    capabilityDetails(),
  );

  const toggle = document.getElementById('assistant-toggle');
  if (toggle) {
    const mobile = isMobileLayout();
    toggle.textContent = mobile
      ? (state.assistant.mobileView ? '返回业务页面' : 'AI 助手')
      : (state.assistant.open ? '收起助手' : '打开 AI 助手');
    toggle.setAttribute('aria-expanded', String(mobile ? state.assistant.mobileView : state.assistant.open));
    toggle.onclick = toggleAssistant;
  }
  const appBody = document.getElementById('app-body');
  if (appBody) {
    appBody.className = 'app-body'
      + (state.assistant.open ? ' assistant-open' : '')
      + (state.assistant.mobileView ? ' assistant-mobile-open' : '');
  }
  if (typeof document !== 'undefined' && document.body && document.body.classList) {
    document.body.classList.toggle('assistant-mobile-active', state.assistant.mobileView === true);
  }

  const nav = document.getElementById('nav');
  clear(nav);
  for (const n of NAV) nav.append(el('a', { href: n.hash, class: `tab ${state.route === n.id ? 'active' : ''}`.trim() }, [n.label]));

  const host = shellHost();
  clear(host);
  const step = flowStep(state.route, state.bill);
  const flow = el('ol', { class: 'flow' });
  FLOW.forEach((f, i) => {
    if (i) flow.append(el('li', { class: 'flow-arrow', 'aria-hidden': 'true' }, ['→']));
    flow.append(el('li', { class: `flow-step${f.n === step ? ' current' : ''}`, 'aria-current': f.n === step ? 'step' : null }, [
      el('a', { href: f.hash }, [`${f.n} ${f.label}`]),
      f.n === step ? el('span', { class: 'flow-now' }, ['当前']) : null,
    ]));
  });
  const ds = dataState(state.bill);
  host.append(el('div', { class: 'flow-bar' }, [
    flow,
    el('div', { class: `data-state ${ds.kind}` }, [el('strong', {}, [`数据状态：${ds.label}`]), el('span', {}, [ds.text])]),
    el('details', { class: 'glossary' }, [
      el('summary', {}, ['了解口径']),
      el('dl', {}, GLOSSARY.flatMap(([k, v]) => [el('dt', {}, [k]), el('dd', {}, [v])])),
    ]),
  ]));

  const footer = document.getElementById('footer-labels');
  clear(footer);
  footer.append(el('div', {}, [`${local
    ? '本地账单与示例均使用服务端从 Tushare 获取的最新已收盘日线（非实时），取数失败时阻断、不回落静态缓存；金额使用不复权价格、前复权仅用于走势展示'
    : '行情由服务端从 Tushare 获取最新已收盘日线（非实时）；合成回归场景会明确标注'}；口径：费用、税费仅记录、未计入公式，分红未计入（v1）；结果不构成投资建议。`]));
}

function renderView() {
  const root = document.getElementById('view');
  clear(root);
  root.className = 'view' + (state.route === 'report' ? ' view-report' : '');
  VIEWS[state.route](root, ctx);
  const assistantRoot = document.getElementById('assistant');
  if (assistantRoot) renderAssistantPanel(assistantRoot, ctx);
}

state.contracts.versions = loadContractsDemo();
state.route = routeFromHash();
const initialWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1440;
state.assistant.open = assistantDefaultOpen(initialWidth);
window.addEventListener('hashchange', () => {
  state.route = routeFromHash();
  if (state.assistant.mobileView) state.assistant.mobileView = false;
  renderShell();
  renderView();
});
subscribe(() => { renderShell(); renderView(); });
renderShell();
renderView();
