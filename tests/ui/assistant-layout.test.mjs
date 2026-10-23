#!/usr/bin/env node
/**
 * 右侧助手布局回归（本地 DOM 桩；不启动浏览器、不调用模型/行情）
 *
 * 覆盖：680 断点、桌面侧栏开合、跨断点状态切换、移动端全屏仅在 <680 生效。
 * 运行：node tests/ui/assistant-layout.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function makeClassList() {
  const set = new Set();
  return {
    toggle(name, force) {
      const next = force === undefined ? !set.has(name) : !!force;
      if (next) set.add(name);
      else set.delete(name);
      return next;
    },
    contains: (name) => set.has(name),
  };
}

function makeButton() {
  return {
    textContent: '',
    hidden: false,
    attrs: {},
    classList: makeClassList(),
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    removeAttribute(k) { delete this.attrs[k]; },
  };
}

const shell = { classList: makeClassList() };
const aside = {
  hidden: true,
  attrs: {},
  setAttribute(k, v) { this.attrs[k] = String(v); },
  getAttribute(k) { return this.attrs[k]; },
  removeAttribute(k) { delete this.attrs[k]; },
  querySelector() { return null; },
  contains() { return false; },
  focus() {},
};
const button = makeButton();
const body = { classList: makeClassList() };
const byId = {
  'tm-shell': shell,
  'tm-assistant': aside,
  'assistant-toggle': button,
};

globalThis.window = { innerWidth: 1440 };
globalThis.HTMLElement = class {};
globalThis.location = { hash: '' };
globalThis.document = {
  getElementById: (id) => byId[id] ?? null,
  addEventListener() {},
  body,
  activeElement: null,
  createElement: () => ({ style: {}, textContent: '', append() {} }),
  head: { append() {} },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('offline-test'); };

const {
  initBridge, toggleAssistant, applyAssistantShell, onViewportChange, getShared,
  handoffToQa, takeQaHandoff,
} = await import('../../prototype/user-frontend/realBridge.js');

function setWidth(width) {
  globalThis.window.innerWidth = width;
  onViewportChange();
}

function state() {
  const s = getShared();
  return { open: s.assistant.open === true, mobileView: s.assistant.mobileView === true };
}

function shellState() {
  return {
    assistantOpen: shell.classList.contains('assistant-open'),
    mobileOpen: shell.classList.contains('assistant-mobile-open'),
    bodyMobile: body.classList.contains('tm-assistant-mobile-active'),
    asideHidden: aside.hidden,
    buttonText: button.textContent,
    buttonHidden: button.hidden,
  };
}

/* —— 断点常量与 CSS 规则位置 —— */
{
  const bridge = readFileSync(join(ROOT, 'prototype/user-frontend/realBridge.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');
  const mobileBlockAt = css.indexOf('@media (max-width: 679.98px)');
  const fixedAt = css.indexOf('.tm-assistant {', mobileBlockAt);
  const fixedEnd = css.indexOf('}', fixedAt);
  const fixedRule = fixedAt >= 0 ? css.slice(fixedAt, fixedEnd) : '';
  const desktopAt = css.indexOf('.tm-assistant {');
  const desktopRule = desktopAt >= 0 ? css.slice(desktopAt, css.indexOf('}', desktopAt)) : '';
  const panelAt = css.indexOf('.tm-assistant .assistant-panel {');
  const panelRule = panelAt >= 0 ? css.slice(panelAt, css.indexOf('}', panelAt)) : '';
  const messagesAt = css.indexOf('.tm-assistant .assistant-messages {');
  const messagesRule = messagesAt >= 0 ? css.slice(messagesAt, css.indexOf('}', messagesAt)) : '';
  const qaAt = css.indexOf('.tm-assistant .qa-assistant {');
  const qaRule = qaAt >= 0 ? css.slice(qaAt, css.indexOf('}', qaAt)) : '';
  const qaFocusAt = css.indexOf('.tm-assistant .qa-input:focus');
  const qaFocusRule = qaFocusAt >= 0 ? css.slice(qaFocusAt, css.indexOf('}', qaFocusAt)) : '';
  let qaFocusDepth = 0;
  for (let i = 0; i < qaFocusAt; i += 1) {
    if (css[i] === '{') qaFocusDepth += 1;
    else if (css[i] === '}') qaFocusDepth -= 1;
  }
  check('断点：JS 与 CSS 统一为 680（CSS 679.98 对齐严格小于）',
    /MOBILE_BREAKPOINT = 680/.test(bridge)
    && mobileBlockAt >= 0
    && !/@media \(max-width: 1279px\)/.test(css));
  check('侧栏：桌面宽度限制在 320–360px',
    /grid-template-columns:\s*minmax\(0, 1fr\) clamp\(320px, 25vw, 360px\)/.test(css));
  check('全屏：position: fixed / inset: 0 只出现在移动断点规则内',
    fixedAt > mobileBlockAt
    && /position:\s*fixed/.test(fixedRule)
    && /inset:\s*0/.test(fixedRule));
  check('桌面助手：固定视口高度、隐藏外层滚动',
    /height:\s*calc\(100dvh - var\(--topbar-h\)\)/.test(desktopRule)
    && /max-height:\s*calc\(100dvh - var\(--topbar-h\)\)/.test(desktopRule)
    && /overflow:\s*hidden/.test(desktopRule)
    && /display:\s*flex/.test(desktopRule));
  check('助手面板：flex 高度链路、内部裁剪并预留水印安全区',
    /display:\s*flex/.test(panelRule)
    && /flex:\s*1 1 auto/.test(panelRule)
    && /min-height:\s*0/.test(panelRule)
    && /overflow:\s*hidden/.test(panelRule)
    && /padding:\s*20px 18px 80px/.test(panelRule));
  check('消息区：占据剩余高度并独立滚动',
    /flex:\s*1 1 auto/.test(messagesRule)
    && /min-height:\s*0/.test(messagesRule)
    && /overflow-y:\s*auto/.test(messagesRule)
    && /overscroll-behavior:\s*contain/.test(messagesRule));
  check('问答容器：flex 子项可收缩且不撑破面板',
    /display:\s*flex/.test(qaRule)
    && /flex:\s*1 1 auto/.test(qaRule)
    && /min-height:\s*0/.test(qaRule)
    && /overflow:\s*hidden/.test(qaRule));
  check('移动全屏：高度使用 100dvh 且不产生外层滚动',
    /height:\s*100dvh/.test(fixedRule)
    && /max-height:\s*100dvh/.test(fixedRule)
    && /overflow:\s*hidden/.test(fixedRule));
  check('输入框焦点：focus/focus-visible 使用内嵌焦点环',
    qaFocusAt > 0
    && qaFocusDepth === 0
    && /\.tm-assistant \.qa-input:focus,/.test(qaFocusRule)
    && /\.tm-assistant \.qa-input:focus-visible/.test(qaFocusRule)
    && /outline:\s*2px solid var\(--ink\)/.test(qaFocusRule)
    && /outline-offset:\s*-2px/.test(qaFocusRule)
    && !/outline:\s*none/.test(qaFocusRule));
  check('输入框焦点：不改变尺寸/内边距并保留圆角',
    /border-radius:\s*var\(--radius-sm\)/.test(qaFocusRule)
    && !/(?:^|[;{])\s*(?:width|height|min-width|min-height|max-width|max-height|padding|margin|border-width|font-size|line-height|transform)\s*:/.test(qaFocusRule));
  check('侧栏左边界：桌面保留分隔线，移动全屏单独去除',
    /border-left:\s*1px solid var\(--line\)/.test(desktopRule)
    && /border-left:\s*0/.test(fixedRule));
}

/* —— 桌面开合与跨断点 —— */
{
  initBridge({});
  applyAssistantShell();
  check('1440：初始化默认打开右侧侧栏',
    state().open === true && state().mobileView === false
    && shellState().assistantOpen === true && shellState().asideHidden === false
    && shellState().buttonText === '收起助手');

  toggleAssistant();
  check('1440：收起后主区恢复全宽，按钮切为“打开 AI 助手”',
    state().open === false && shellState().assistantOpen === false
    && shellState().asideHidden === true && shellState().buttonText === '打开 AI 助手');

  toggleAssistant();
  check('1440：可再次展开', state().open === true && shellState().assistantOpen === true && shellState().asideHidden === false);

  setWidth(1280);
  check('1280：保持右侧侧栏', state().mobileView === false && shellState().assistantOpen === true && shellState().asideHidden === false);

  setWidth(1200);
  check('1200：保持右侧侧栏，不进入移动全屏',
    state().mobileView === false && shellState().assistantOpen === true
    && shellState().mobileOpen === false && shellState().bodyMobile === false);

  setWidth(1024);
  check('1024：保持右侧侧栏', shellState().assistantOpen === true && shellState().mobileOpen === false && shellState().asideHidden === false);

  setWidth(680);
  check('680：断点边界仍为桌面侧栏（严格小于 680 才移动）',
    state().mobileView === false && state().open === true
    && shellState().assistantOpen === true && shellState().mobileOpen === false);
}

/* —— 手机全屏与恢复桌面 —— */
{
  setWidth(679);
  check('679：进入移动全屏，侧栏状态延续为可见',
    state().mobileView === true && shellState().mobileOpen === true
    && shellState().assistantOpen === false && shellState().bodyMobile === true
    && shellState().asideHidden === false && shellState().buttonHidden === true);

  toggleAssistant();
  check('679：关闭全屏后顶部导航恢复（body 不再隐藏外壳）',
    state().mobileView === false && shellState().mobileOpen === false
    && shellState().bodyMobile === false && shellState().asideHidden === true);

  toggleAssistant();
  setWidth(1200);
  check('手机→1200：不继续全屏，恢复右侧侧栏',
    state().mobileView === false && state().open === true
    && shellState().assistantOpen === true && shellState().mobileOpen === false
    && shellState().bodyMobile === false && shellState().asideHidden === false);

  toggleAssistant();
  setWidth(390);
  check('1200 关闭→390：移动端保持关闭，不自动弹全屏',
    state().mobileView === false && shellState().asideHidden === true && shellState().bodyMobile === false);

  toggleAssistant();
  setWidth(1440);
  check('390 打开→1440：不继续全屏，恢复右侧侧栏',
    state().mobileView === false && state().open === true
    && shellState().assistantOpen === true && shellState().mobileOpen === false
    && shellState().bodyMobile === false && shellState().asideHidden === false);
}

/* —— 移动端初始与按钮状态 —— */
{
  globalThis.window.innerWidth = 390;
  initBridge({});
  applyAssistantShell();
  check('390：初始保持业务页面，不自动全屏',
    state().open === false && state().mobileView === false
    && shellState().mobileOpen === false && shellState().bodyMobile === false
    && shellState().asideHidden === true && shellState().buttonText === 'AI 助手');

  toggleAssistant();
  check('390：点击“AI 助手”进入独立全屏',
    state().mobileView === true && shellState().mobileOpen === true
    && shellState().bodyMobile === true && shellState().asideHidden === false
    && shellState().buttonHidden === true);
}

/* —— 助手到问答页交接：只预填，不自动发送；账单变化丢弃 —— */
{
  const shared = getShared();
  shared.bill = { ...shared.bill, contextId: 'handoff-bill-1' };
  handoffToQa({ question: '我最错的一笔是哪个？' });
  const same = takeQaHandoff('handoff-bill-1');
  check('交接：同账单带回问题，不自动发送',
    same?.question === '我最错的一笔是哪个？'
    && shared.chat.messages.length === 0
    && takeQaHandoff('handoff-bill-1') === null,
    JSON.stringify({ same, chat: shared.chat }));

  handoffToQa({ question: '组合整体表现如何？' });
  const dropped = takeQaHandoff('handoff-bill-2');
  check('交接：账单变化时丢弃并标记',
    dropped?.dropped === true && dropped?.question === '组合整体表现如何？',
    JSON.stringify(dropped));

  setWidth(390);
  shared.assistant.mobileView = true;
  shared.assistant.open = true;
  handoffToQa({ question: '这笔交易的证据怎么看？' });
  const mobileHandoff = takeQaHandoff('handoff-bill-1');
  check('交接：移动端点击后关闭助手，仍带回问题',
    shared.assistant.mobileView === false
    && mobileHandoff?.question === '这笔交易的证据怎么看？',
    JSON.stringify({ assistant: { mobileView: shared.assistant.mobileView }, mobileHandoff }));
  setWidth(1440);
}

if (originalFetch !== undefined) globalThis.fetch = originalFetch;

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
