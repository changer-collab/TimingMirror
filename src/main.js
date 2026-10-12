// 应用引导：能力状态条、页签导航、哈希路由、视图挂载
import { state, subscribe, notify, saveContractsDemo, loadContractsDemo } from './state.js';
import { el, clear, chip } from './ui/components.js';
import * as adapter from './demo/adapter.js';
import { renderImport } from './ui/views/importView.js';
import { renderReport } from './ui/views/reportView.js';
import { renderChat } from './ui/views/chatView.js';
import { renderContract } from './ui/views/contractView.js';

const NAV = [
  { id: 'import', label: '导入 · 确认', hash: '#/import' },
  { id: 'report', label: '报告 · 证据', hash: '#/report' },
  { id: 'chat', label: '对话', hash: '#/chat' },
  { id: 'contract', label: '契约', hash: '#/contract' },
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

const ctx = { state, set, go, adapter };

function routeFromHash() {
  const id = (location.hash || '#/import').replace(/^#\//, '');
  return VIEWS[id] ? id : 'import';
}

function renderShell() {
  const chips = document.getElementById('capability-chips');
  clear(chips);
  chips.append(chip('演示数据模式', 'mode'));
  for (const c of Object.values(adapter.CAPABILITY)) chips.append(chip(c.label, c.ready ? 'ok' : 'warn'));

  const nav = document.getElementById('nav');
  clear(nav);
  for (const n of NAV) nav.append(el('a', { href: n.hash, class: `tab ${state.route === n.id ? 'active' : ''}`.trim() }, [n.label]));

  const footer = document.getElementById('footer-labels');
  clear(footer);
  footer.append(el('div', {}, ['演示数据 · 非真实账户交易结果，不构成投资建议；决定权在你。']));
  footer.append(el('div', {}, ['口径：未计入费用、税费；分红未计入（v1）。']));
}

function renderView() {
  const root = document.getElementById('view');
  clear(root);
  root.className = 'view' + (state.route === 'report' ? ' view-report' : '');
  VIEWS[state.route](root, ctx);
}

state.contracts.versions = loadContractsDemo();
state.route = routeFromHash();
window.addEventListener('hashchange', () => { state.route = routeFromHash(); renderShell(); renderView(); });
subscribe(() => { renderShell(); renderView(); });
renderShell();
renderView();
