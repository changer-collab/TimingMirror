// 新前端的真实能力桥：共享业务状态、路由映射、助手挂载与既有视图适配。
import { state as shared, notify } from '../../src/state.js';
import { getRuleAssistantClient, renderAssistantPanel } from '../../src/ui/assistantPanel.js';
import { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } from '../../src/agent/httpTransport.js';
import { createImportRecovery } from '../../src/agent/importRecovery.js';
import { createChatOnline } from '../../src/agent/chatOnline.js';
import { renderContract } from '../../src/ui/views/contractView.js';
import { renderRealImport } from './realImport.js';
import { getRealReportBundle, loadRealReport } from './realReport.js';
import { ruleStateOf, loadProfile } from './profileStore.js';
import { openRuleCandidate } from './ruleCandidates.js';

const MOBILE_BREAKPOINT = 1280;
const OLD_CSS = '/src/ui/styles.css';

// 规则视图运行在 shadow root 中。样式文本先缓存，再同步写入每个 shadow root，
// 避免首次挂载（以及页面重建宿主）时闪现未排版内容。
let oldCssText = null;
let oldCssPromise = null;

function loadOldCss() {
  if (oldCssText) return Promise.resolve(oldCssText);
  if (oldCssPromise) return oldCssPromise;
  if (typeof fetch !== 'function' || typeof document === 'undefined') {
    oldCssPromise = Promise.resolve(null);
    return oldCssPromise;
  }
  oldCssPromise = fetch(OLD_CSS, { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`stylesheet ${res.status}`))))
    .then((text) => { oldCssText = text; return text; })
    .catch(() => null);
  return oldCssPromise;
}

const SHADOW_STYLE = `
:host {
  display: block;
  --bg: var(--sheet);
  --panel: var(--sheet);
  --panel2: var(--sheet-2);
  --cream: var(--ink);
  --dim: var(--gray);
  --amber: var(--loss);
  --amber-ink: var(--loss);
  --amber-tint: var(--loss-soft);
  --red: var(--loss);
  --red-ink: var(--loss);
  --red-tint: var(--loss-soft);
  --green-ink: #2f6b33;
  --mono: var(--font-mono);
  --ink-strong: var(--ink);
  --hairline: var(--line);
  --hairline-soft: var(--line-soft);
  --red-drag: var(--loss);
  --blue-accent: var(--ink);
  --accent: var(--ink);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.75;
  color: var(--ink);
}
* { box-sizing: border-box; }
.view { padding: 0; max-width: none; margin: 0; }
.stack { max-width: none; }
.card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--sheet);
  box-shadow: var(--shadow-paper);
}
.btn {
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  background: var(--sheet);
  color: var(--ink);
  border: 1px solid var(--line);
}
.btn.primary {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--sheet);
}
.btn.primary:hover { background: var(--dark-2); }
.input {
  background: var(--sheet);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
}
.section-title { font-family: var(--font-serif); }
.banner { border-radius: var(--radius-sm); background: var(--sheet); }
.im-prep, .im-recovery { border-radius: var(--radius); }
`;

let onChangeCallback = null;
let recoveryClient = null;
let qaOnlineClient = null;
let currentRoute = 'home';
let demoSelected = false;
let realRulesRequested = false;
let pendingKeys = new Set();
let scheduled = false;
const shadowHosts = new WeakMap();

function getRecoveryClient() {
  if (!recoveryClient) {
    recoveryClient = createImportRecovery({
      transport: createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS }),
    });
  }
  return recoveryClient;
}

function mergePatch(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && shared[key] && typeof shared[key] === 'object' && !Array.isArray(shared[key])) {
      shared[key] = { ...shared[key], ...value };
    } else {
      shared[key] = value;
    }
  }
}

function scheduleChange(keys) {
  for (const key of keys) pendingKeys.add(key);
  if (!onChangeCallback || scheduled) return;
  scheduled = true;
  Promise.resolve().then(() => {
    scheduled = false;
    const changed = [...pendingKeys];
    pendingKeys = new Set();
    onChangeCallback(changed);
  });
}

export function set(patch) {
  mergePatch(patch);
  notify();
  scheduleChange(Object.keys(patch));
}

export function go(route) {
  const target = route === 'contract' ? 'rules' : route;
  if (route === 'contract') realRulesRequested = true;
  const next = `#/${target}`;
  if (location.hash === next) {
    scheduleChange(['route']);
  } else {
    location.hash = next;
  }
}

function scrollToSimulation() {
  const host = document.getElementById('tm-real-rules');
  const node = host?.shadowRoot?.querySelector?.('[data-role="sim-section"]');
  if (node && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function getQaOnlineClient() {
  if (!qaOnlineClient) qaOnlineClient = createChatOnline();
  return qaOnlineClient;
}

const ctx = {
  state: shared,
  set,
  go,
  importRecovery: getRecoveryClient(),
  ruleAssistantClient: getRuleAssistantClient(),
  assistantTitle: 'AI 助手',
  assistantSubtitle: '当前页面与已发布报告',
  assistantShowFactLink: true,
  globalAssistant: true,
  qaDeps: {
    getReportBundle: (bill) => getRealReportBundle(bill),
    loadReportBundle: (bill) => loadRealReport(bill),
    askOnline: ({ question, review }) => getQaOnlineClient().ask({ question, review }),
    ruleStateOf,
    loadProfile,
    openRuleCandidate,
  },
  scrollToSimulation,
  setRuleModal,
};

export function initBridge({ onChange } = {}) {
  onChangeCallback = typeof onChange === 'function' ? onChange : null;
  loadOldCss();
  const wide = typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
    ? window.innerWidth >= MOBILE_BREAKPOINT
    : true;
  shared.assistant.open = wide;
  shared.assistant.mobileView = false;
  return { state: shared, ctx };
}

export function getShared() { return shared; }
export function getCtx() { return ctx; }

export function setRoute(route) {
  currentRoute = route;
  shared.route = route === 'rules' ? 'contract' : route;
  if (route !== 'rules') setRuleModal(null);
}

export function hasRealState() {
  const bill = shared.bill ?? {};
  return (bill.contextId && bill.status !== 'none')
    || (shared.importRecovery && shared.importRecovery.status !== 'idle');
}

export function isRealBill() {
  return shared.bill?.status === 'confirmed' && shared.bill?.sourceType === 'local';
}

export function isRealRules() {
  return realRulesRequested
    || !!shared.assistant?.draft
    || (Array.isArray(shared.contracts?.versions) && shared.contracts.versions.length > 0)
    || hasRealState();
}

export function getMode(route) {
  if (route === 'import') return 'real';
  if (route === 'rules' && isRealRules()) return 'real';
  if (isRealBill()) return 'real';
  if (hasRealState()) return 'real';
  if (demoSelected) return 'demo';
  return 'empty';
}

export function enterDemo() {
  if (hasRealState()) return false;
  demoSelected = true;
  scheduleChange(['mode']);
  return true;
}

export function leaveDemo() {
  demoSelected = false;
  scheduleChange(['mode']);
}

export function isDemoSelected() { return demoSelected; }

export function openRealRules() {
  realRulesRequested = true;
  go('contract');
}

function ensureShadow(host) {
  if (shadowHosts.has(host)) return shadowHosts.get(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SHADOW_STYLE;
  shadow.append(style);
  const root = document.createElement('div');
  root.className = 'tm-shadow-root';
  shadow.append(root);
  const entry = { shadow, root, host, styleEl: style, stylesReady: false, pendingPaint: null };
  const paintPending = () => {
    const paint = entry.pendingPaint;
    entry.pendingPaint = null;
    if (paint) paint();
  };
  if (oldCssText) {
    style.textContent = oldCssText + SHADOW_STYLE;
    entry.stylesReady = true;
  } else {
    loadOldCss().then((text) => {
      if (text) {
        style.textContent = text + SHADOW_STYLE;
      } else {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = OLD_CSS;
        link.addEventListener('load', () => { entry.stylesReady = true; paintPending(); }, { once: true });
        link.addEventListener('error', () => { entry.stylesReady = true; paintPending(); }, { once: true });
        shadow.insertBefore(link, style);
        return;
      }
      entry.stylesReady = true;
      paintPending();
    });
  }
  shadowHosts.set(host, entry);
  return entry;
}

function renderInShadow(host, renderer, after) {
  const entry = ensureShadow(host);
  const paint = () => {
    if (!entry.stylesReady || !entry.host.isConnected) return;
    host.removeAttribute('aria-busy');
    entry.root.replaceChildren();
    renderer(entry.root, ctx);
    if (typeof after === 'function') after(entry.root);
  };
  if (entry.stylesReady) {
    paint();
    return;
  }
  entry.pendingPaint = paint;
  if (!entry.root.children.length) {
    host.setAttribute('aria-busy', 'true');
    const loading = document.createElement('div');
    loading.setAttribute('style', 'padding: 28px 4px; color: #5b6468; font: 14px/1.75 system-ui, -apple-system, "Noto Sans SC", sans-serif;');
    loading.textContent = '正在载入规则工作区…';
    entry.root.replaceChildren(loading);
  }
}

let ruleModalEntry = null;

export function setRuleModal(node) {
  if (!node && !ruleModalEntry) return;
  if (!ruleModalEntry) {
    const host = document.createElement('div');
    host.id = 'tm-rule-modal';
    host.className = 'tm-rule-modal-host';
    host.hidden = true;
    document.body.append(host);
    ruleModalEntry = ensureShadow(host);
  }
  const entry = ruleModalEntry;
  const apply = () => {
    if (entry.pendingModal !== node) return;
    entry.root.replaceChildren(...(node ? [node] : []));
    entry.host.hidden = !node;
  };
  entry.pendingModal = node ?? null;
  if (!node) {
    entry.root.replaceChildren();
    entry.host.hidden = true;
    return;
  }
  if (entry.stylesReady) apply();
  else entry.pendingPaint = apply;
}

export function mountImportView(host) {
  if (!host) return;
  renderRealImport(host, ctx);
}

export function mountContractView(host) {
  if (!host) return;
  renderInShadow(host, renderContract);
}

export function renderAssistant() {
  const root = document.getElementById('tm-assistant-root');
  if (!root) return;
  renderAssistantPanel(root, ctx);
  applyAssistantShell();
}

export function bindAssistantToggle() {
  const button = document.getElementById('assistant-toggle');
  if (!button) return;
  button.addEventListener('click', toggleAssistant);
  updateAssistantButton();
}

function mobileLayout() {
  return typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
    ? window.innerWidth < MOBILE_BREAKPOINT
    : false;
}

export function toggleAssistant() {
  if (mobileLayout()) {
    shared.assistant.mobileView = shared.assistant.mobileView !== true;
    shared.assistant.open = true;
  } else {
    shared.assistant.open = shared.assistant.open !== true;
  }
  renderAssistant();
}

function updateAssistantButton() {
  const button = document.getElementById('assistant-toggle');
  if (!button) return;
  const mobile = mobileLayout();
  const open = mobile ? shared.assistant.mobileView === true : shared.assistant.open === true;
  button.textContent = mobile ? 'AI 助手' : (open ? '收起助手' : '打开 AI 助手');
  button.setAttribute('aria-expanded', String(open));
  button.hidden = mobile && open;
}

export function applyAssistantShell() {
  const mobile = mobileLayout();
  const open = mobile ? shared.assistant.mobileView === true : shared.assistant.open === true;
  const shell = document.getElementById('tm-shell');
  const aside = document.getElementById('tm-assistant');
  if (shell) {
    shell.classList.toggle('assistant-open', !mobile && open);
    shell.classList.toggle('assistant-mobile-open', mobile && open);
  }
  if (aside) aside.hidden = !open;
  if (document.body) {
    document.body.classList.toggle('tm-assistant-mobile-active', mobile && open);
  }
  updateAssistantButton();
}

export function onViewportChange() {
  if (!mobileLayout()) {
    shared.assistant.mobileView = false;
  }
  applyAssistantShell();
  renderAssistant();
}
