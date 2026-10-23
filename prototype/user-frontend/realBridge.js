// 新前端的真实能力桥：共享业务状态、路由映射、助手挂载与既有视图适配。
import { state as shared, notify, loadContractsDemo } from '../../src/state.js';
import { getRuleAssistantClient, renderAssistantPanel } from '../../src/ui/assistantPanel.js';
import { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } from '../../src/agent/httpTransport.js';
import { createImportRecovery } from '../../src/agent/importRecovery.js';
import { createChatOnline } from '../../src/agent/chatOnline.js';
import { createOnlineBoundary } from '../../src/agent/onlineBoundary.js';
import { createDataClient } from '../../src/agent/dataClient.js';
import { createProfileFactRecorder } from '../../src/agent/profileSignals.js';
import { renderContract } from '../../src/ui/views/contractView.js';
import { renderRealImport } from './realImport.js';
import { getRealReportBundle, getRealReportState, loadRealReport } from './realReport.js';
import { ruleStateOf, loadProfile } from './profileStore.js';
import { openRuleCandidate } from './ruleCandidates.js';
import { createQaAnswerService } from './qaAnswer.js';
import { syncBill, syncSnapshotWithBill } from './cloudSync.js';
import { invalidateCloudProfile } from './cloudProfile.js';

const MOBILE_BREAKPOINT = 680;
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
let qaAnswerClient = null;
let qaIntentBoundary = null;
let dataClient = null;
let profileFactTransport = null;
let profileFactRecorder = null;
let currentRoute = 'home';
let lastMobileLayout = null;
let demoSelected = false;
let realRulesRequested = false;
let rulesRestored = false;
let pendingKeys = new Set();
let scheduled = false;
let shellBound = false;
let overlayWasOpen = false;
let assistantReturnFocus = null;
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
  const target = route === 'contract' || route === 'rules' ? 'me' : route;
  const next = `#/${target}`;
  if (location.hash === next) {
    scheduleChange(['route']);
  } else {
    location.hash = next;
  }
}

function scrollToSimulation() {
  const host = document.getElementById('tm-real-scenario') ?? document.getElementById('tm-real-rules');
  const node = host?.shadowRoot?.querySelector?.('[data-role="sim-section"]');
  if (node && typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function getQaOnlineClient() {
  if (!qaOnlineClient) qaOnlineClient = createChatOnline();
  return qaOnlineClient;
}

function getQaIntentBoundary() {
  if (!qaIntentBoundary) {
    qaIntentBoundary = createOnlineBoundary({
      transport: createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS }),
      timeoutMs: 5000,
    });
  }
  return qaIntentBoundary;
}

function getQaAnswerClient() {
  if (!qaAnswerClient) {
    qaAnswerClient = createQaAnswerService({
      getBundle: (bill) => getRealReportBundle(bill),
      loadBundle: (bill) => loadRealReport(bill),
      askOnline: ({ question, review }) => getQaOnlineClient().ask({ question, review }),
      loadProfile,
      classifyIntent: ({ question }) => getQaIntentBoundary().classifyIntent({ question }),
    });
  }
  return qaAnswerClient;
}

function getDataClient() {
  if (!dataClient) dataClient = createDataClient();
  return dataClient;
}

function getProfileFactTransport() {
  if (!profileFactTransport) {
    profileFactTransport = createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS });
  }
  return profileFactTransport;
}

function getProfileFactRecorder() {
  if (!profileFactRecorder) {
    profileFactRecorder = createProfileFactRecorder({
      transport: getProfileFactTransport(),
      saveFacts: ({ facts, signal }) => getDataClient().saveFacts({ facts, signal }),
    });
  }
  return profileFactRecorder;
}

const ctx = {
  state: shared,
  set,
  go,
  allowDemoSimulation: false,
  importRecovery: getRecoveryClient(),
  ruleAssistantClient: getRuleAssistantClient(),
  assistantTitle: 'AI 助手',
  assistantSubtitle: '当前页面与已发布报告',
  globalAssistant: true,
  qaDeps: {
    getReportBundle: (bill) => getRealReportBundle(bill),
    getReportState: (bill) => getRealReportState(bill),
    loadReportBundle: (bill) => loadRealReport(bill),
    askOnline: ({ question, review }) => getQaOnlineClient().ask({ question, review }),
    askQuestion: (args) => getQaAnswerClient().ask(args),
    recordProfileFacts: (args) => getProfileFactRecorder()?.record(args),
    ruleStateOf,
    loadProfile,
    openRuleCandidate,
  },
  cloudDeps: {
    syncBill: ({ bill, includeTrades }) => syncBill({
      bill,
      includeTrades,
      saveBill: (args) => getDataClient().saveBill(args),
    }),
    syncSnapshot: ({ bill, snapshot }) => syncSnapshotWithBill({
      bill,
      snapshot,
      saveBill: (args) => getDataClient().saveBill(args),
      saveSnapshot: (args) => getDataClient().saveSnapshot(args),
    }),
    listBills: (args) => getDataClient().listBills(args),
    getProfile: (args) => getDataClient().getProfile(args),
    deleteBill: (args) => getDataClient().deleteBill(args),
    deleteFact: (args) => getDataClient().deleteFact(args),
    saveProfileSummary: (args) => getDataClient().saveProfileSummary(args),
    requestProfileSummary: ({ digest, signal } = {}) => getProfileFactTransport().profileSummary({ digest, signal }),
    invalidateCloudProfile,
  },
  scrollToSimulation,
  isOverlayLayout: mobileLayout,
  focusAssistant,
  setRuleModal,
};

export function initBridge({ onChange } = {}) {
  onChangeCallback = typeof onChange === 'function' ? onChange : null;
  if (!rulesRestored) {
    shared.contracts.versions = loadContractsDemo();
    rulesRestored = true;
  }
  loadOldCss();
  lastMobileLayout = mobileLayout();
  shared.assistant.open = !lastMobileLayout;
  shared.assistant.mobileView = false;
  bindAssistantShell();
  return { state: shared, ctx };
}

export function getShared() { return shared; }
export function getCtx() { return ctx; }

export function setRoute(route) {
  currentRoute = route;
  shared.route = route === 'me' || route === 'scenario' ? 'contract' : route;
  if (route !== 'me') setRuleModal(null);
}

export function hasRealState() {
  const bill = shared.bill ?? {};
  return (bill.contextId && bill.status !== 'none')
    || (shared.importRecovery && shared.importRecovery.status !== 'idle');
}

export function isRealBill() {
  return shared.bill?.status === 'confirmed' && shared.bill?.sourceType === 'local';
}

export function getMode(route) {
  if (route === 'import') return 'real';
  if (route === 'me' || route === 'rules') return 'real';
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

export function mountScenarioView(host) {
  if (!host) return;
  renderInShadow(host, (root, ctx) => renderContract(root, ctx, { section: 'scenario' }));
}

export function renderAssistant() {
  const root = document.getElementById('tm-assistant-root');
  if (root) renderAssistantPanel(root, ctx);
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

function overlayOpen() {
  return mobileLayout() && shared.assistant.mobileView === true;
}

export function toggleAssistant() {
  if (mobileLayout()) {
    shared.assistant.mobileView = shared.assistant.mobileView !== true;
    shared.assistant.open = shared.assistant.mobileView;
  } else {
    shared.assistant.open = shared.assistant.open !== true;
    shared.assistant.mobileView = false;
  }
  renderAssistant();
}

export function closeAssistant() {
  if (mobileLayout()) {
    shared.assistant.mobileView = false;
  } else {
    shared.assistant.open = false;
  }
  renderAssistant();
}

function assistantFocusables(aside) {
  if (!aside) return [];
  return Array.from(aside.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )).filter((node) => node.getClientRects().length > 0);
}

export function focusAssistant() {
  if (typeof document === 'undefined') return;
  const run = () => {
    const aside = document.getElementById('tm-assistant');
    if (!aside || aside.hidden) return;
    const draft = aside.querySelector('[data-role="assistant-draft-card"]');
    const target = draft
      || (overlayOpen() ? aside : aside.querySelector('textarea, button:not([disabled]), [href], input, select'))
      || aside;
    target.focus?.({ preventScroll: true });
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(run));
  } else {
    setTimeout(run, 0);
  }
}

function onAssistantKeydown(event) {
  if (!overlayOpen()) return;
  const modal = document.getElementById('modal-root');
  if (modal && modal.hidden === false) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeAssistant();
    return;
  }
  if (event.key !== 'Tab') return;
  const aside = document.getElementById('tm-assistant');
  const focusables = assistantFocusables(aside);
  if (!focusables.length) {
    event.preventDefault();
    aside?.focus?.();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!aside?.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === aside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function bindAssistantShell() {
  if (shellBound || typeof document === 'undefined') return;
  shellBound = true;
  const scrim = document.getElementById('tm-assistant-scrim');
  if (scrim) scrim.addEventListener('click', closeAssistant);
  document.addEventListener('keydown', onAssistantKeydown);
}

function updateAssistantButton() {
  const button = document.getElementById('assistant-toggle');
  if (!button) return;
  const mobile = mobileLayout();
  const open = mobile ? shared.assistant.mobileView === true : shared.assistant.open === true;
  const hasDraft = !!shared.assistant.draft && !shared.assistant.semanticConfirmation;
  const label = mobile ? 'AI 助手' : (open ? '收起助手' : '打开 AI 助手');
  button.textContent = label;
  button.classList.toggle('has-draft', hasDraft);
  button.setAttribute('aria-expanded', String(open));
  button.setAttribute('aria-label', hasDraft ? `${label}，有未保存的规则草案` : label);
  button.hidden = mobile && open;
}

export function applyAssistantShell() {
  const mobile = mobileLayout();
  const open = mobile ? shared.assistant.mobileView === true : shared.assistant.open === true;
  const shell = document.getElementById('tm-shell');
  const aside = document.getElementById('tm-assistant');
  const scrim = document.getElementById('tm-assistant-scrim');
  const main = document.getElementById('tm-main');
  const overlay = mobile && open;
  const opening = overlay && !overlayWasOpen;
  const closing = !overlay && overlayWasOpen;
  if (opening) {
    assistantReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  if (shell) {
    shell.classList.toggle('assistant-open', !mobile && open);
    shell.classList.toggle('assistant-mobile-open', mobile && open);
  }
  if (aside) {
    aside.hidden = !open;
    aside.setAttribute('aria-labelledby', 'assistant-panel-title');
    if (mobile) {
      aside.setAttribute('role', 'dialog');
      aside.setAttribute('aria-modal', 'true');
    } else {
      aside.setAttribute('role', 'region');
      aside.removeAttribute('aria-modal');
    }
  }
  if (scrim) scrim.hidden = !overlay;
  if (main) {
    if (overlay) main.setAttribute('inert', '');
    else main.removeAttribute('inert');
  }
  if (document.body) {
    document.body.classList.toggle('tm-assistant-mobile-active', overlay);
  }
  updateAssistantButton();
  if (opening) {
    overlayWasOpen = true;
    focusAssistant();
  } else if (closing) {
    overlayWasOpen = false;
    const findRuleModal = () => document.getElementById('tm-rule-modal')?.shadowRoot
      ?.querySelector?.('[data-role="rule-modal"]');
    const focusRuleModal = () => {
      const modal = findRuleModal();
      if (!modal) return;
      const root = modal.getRootNode?.();
      if (root?.activeElement && modal.contains(root.activeElement)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement
        && !modal.contains(active)) return;
      modal.focus?.({ preventScroll: true });
    };
    const ruleModal = findRuleModal();
    if (ruleModal) {
      focusRuleModal();
      [0, 100, 300].forEach((delay) => setTimeout(focusRuleModal, delay));
    } else {
      const target = assistantReturnFocus?.isConnected
        ? assistantReturnFocus
        : document.getElementById('assistant-toggle');
      target?.focus?.({ preventScroll: true });
    }
    assistantReturnFocus = null;
  }
}

export function onViewportChange() {
  const mobile = mobileLayout();
  let crossed = false;
  if (lastMobileLayout === null) lastMobileLayout = mobile;
  if (mobile !== lastMobileLayout) {
    if (mobile) {
      shared.assistant.mobileView = shared.assistant.open === true;
    } else {
      shared.assistant.open = shared.assistant.mobileView === true;
      shared.assistant.mobileView = false;
    }
    lastMobileLayout = mobile;
    crossed = true;
  } else if (!mobile) {
    shared.assistant.mobileView = false;
  }
  // 跨断点需要重建面板结构；同一断点内只更新外壳，避免调整窗口时丢失焦点。
  if (crossed) renderAssistant();
  else applyAssistantShell();
}
