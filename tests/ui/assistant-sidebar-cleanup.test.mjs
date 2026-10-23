#!/usr/bin/env node
/**
 * 助手侧栏清理回归（本地 DOM 桩；不联网、不调用模型/行情）
 *
 * 覆盖：所有页面移除“前往交易规则/前往事实问答”和自动账单确认提示；
 *       规则页不再渲染规则描述输入与“让 AI 理解”；
 *       问答输入、发送、消息与隐私提示保留；面板固定高度/底部留白与消息区承接空白的结构不变。
 * 运行：node tests/ui/assistant-sidebar-cleanup.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

class FakeNode {}
function createTextNode(text) {
  const node = Object.create(FakeNode.prototype);
  node.__text = String(text);
  node.parentNode = null;
  return node;
}
function makeEl(tag) {
  const node = Object.create(FakeNode.prototype);
  node.tagName = String(tag).toUpperCase();
  node.children = [];
  node.attrs = {};
  node.listeners = {};
  node.value = '';
  node.disabled = false;
  node.parentNode = null;
  node.setAttribute = function setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'value') this.value = String(value);
    if (key === 'disabled') this.disabled = true;
  };
  node.getAttribute = function getAttribute(key) { return this.attrs[key]; };
  node.removeAttribute = function removeAttribute(key) { delete this.attrs[key]; };
  node.addEventListener = function addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); };
  node.append = function append(...children) {
    for (const child of children) {
      if (child == null) continue;
      if (typeof child === 'object') child.parentNode = this;
      this.children.push(child);
    }
  };
  node.replaceChildren = function replaceChildren(...children) {
    this.children = children.filter((child) => child != null);
    for (const child of this.children) if (child && typeof child === 'object') child.parentNode = this;
  };
  node.focus = function focus() {};
  node.scrollIntoView = function scrollIntoView() {};
  node.requestSubmit = function requestSubmit() {
    for (const fn of this.listeners.submit ?? []) fn({ preventDefault() {} });
  };
  Object.defineProperty(node, 'className', {
    get() { return this.attrs.class ?? ''; },
    set(value) { this.attrs.class = String(value); },
  });
  return node;
}

globalThis.Node = FakeNode;
globalThis.document = { createElement: makeEl, createTextNode };
globalThis.fetch = async () => { throw new Error('offline-test'); };

const { defaultAssistant, defaultBill, defaultContracts } = await import('../../src/state.js');
const { renderAssistantPanel } = await import('../../src/ui/assistantPanel.js');
const { finalizeConfirmedBill } = await import('../../src/agent/importFinalize.js');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const CSS = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');
function cssBlock(selector) {
  const start = CSS.indexOf(selector);
  if (start < 0) return '';
  return CSS.slice(start, CSS.indexOf('}', start));
}

function allText(node) {
  if (!node) return '';
  if (node.__text !== undefined) return node.__text;
  return (node.children ?? []).map(allText).join(' ');
}
function nodesByClass(node, className) {
  const out = [];
  const walk = (current) => {
    if (!current || current.__text !== undefined) return;
    if (String(current.attrs?.class ?? '').split(/\s+/).includes(className)) out.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return out;
}
function nodesByTag(node, tag) {
  const out = [];
  const walk = (current) => {
    if (!current || current.__text !== undefined) return;
    if (current.tagName === String(tag).toUpperCase()) out.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return out;
}
function childClasses(node) {
  return (node.children ?? [])
    .filter((child) => child && child.__text === undefined)
    .map((child) => String(child.attrs?.class ?? ''));
}

const BILL = {
  ...defaultBill(),
  status: 'confirmed',
  sourceType: 'local',
  blocked: false,
  fileName: 'demo-bill-local (1).csv',
  trades: [{ trade_id: 'T1' }],
  contextId: 'bill-cleanup-1',
};
const AUTO_NOTICE = '账单已确认导入：demo-bill-local (1).csv（8 笔，本机解析）。可以继续描述交易规则。';

const state = {
  route: 'home',
  bill: BILL,
  report: { symbol: 'pool' },
  contracts: { ...defaultContracts(), versions: [] },
  assistant: {
    ...defaultAssistant(),
    messages: [{ role: 'assistant', kind: 'notice', text: AUTO_NOTICE }],
  },
};
const ctx = {
  state,
  assistantTitle: 'AI 助手',
  assistantSubtitle: '当前页面与已发布报告',
  globalAssistant: true,
  qaDeps: { getReportBundle: () => null },
  set(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'assistant' && value && typeof value === 'object' && !Array.isArray(value)) {
        state.assistant = { ...state.assistant, ...value };
      } else {
        state[key] = value;
      }
    }
  },
  go(route) { state.route = route; },
};
const root = makeEl('div');

function render(route) {
  state.route = route;
  renderAssistantPanel(root, ctx);
  return root.children[0];
}

const ROUTES = ['home', 'import', 'report', 'chat', 'contract'];
for (const route of ROUTES) {
  const card = render(route);
  const text = allText(card);
  const classes = childClasses(card);
  check(`侧栏·${route}：不显示两个快捷按钮与自动账单确认提示`,
    !text.includes('前往交易规则')
    && !text.includes('前往事实问答')
    && !text.includes('账单已确认导入')
    && !nodesByClass(card, 'assistant-msg').some((node) => allText(node).includes(AUTO_NOTICE))
    && classes.filter((name) => name === 'assistant-messages').length === 0,
    text.slice(0, 320));
  check(`侧栏·${route}：保留问答输入、发送与隐私提示`,
    nodesByTag(card, 'textarea').length === 1
    && nodesByClass(card, 'qa-input').length === 1
    && nodesByClass(card, 'qa-form').length === 1
    && nodesByClass(card, 'qa-form')[0].children.some((node) => allText(node).includes('发送'))
    && text.includes('原始账单不上传'),
    text.slice(0, 320));
  check(`侧栏·${route}：不渲染规则描述模块`,
    !text.includes('描述你想设的规则')
    && !text.includes('描述你想要的规则')
    && !text.includes('让 AI 理解')
    && !text.includes('Enter 发送，Shift+Enter 换行')
    && nodesByClass(card, 'assistant-input-field').length === 0
    && !nodesByTag(card, 'textarea').some((node) => node.attrs?.id === 'assistant-rule-input'),
    text.slice(0, 320));
}

/* —— 规则描述模块在规则页（画像与规则 / 操作复盘的共享路由）彻底移除 —— */
{
  const card = render('contract');
  check('规则页：侧栏不再有规则描述输入与提交按钮',
    !nodesByTag(card, 'button').some((node) => allText(node).includes('让 AI 理解'))
    && nodesByTag(card, 'textarea').length === 1
    && nodesByTag(card, 'textarea')[0].attrs.class === 'input qa-input',
    allText(card).slice(0, 320));
}

/* —— 问答消息保留；自动确认提示即使已在状态中也不再显示 —— */
{
  state.assistant = {
    ...state.assistant,
    messages: [{ role: 'assistant', kind: 'notice', text: AUTO_NOTICE }],
    qaMessages: [
      { id: 'u1', role: 'user', text: '这笔卖出的原因是什么？', billContextId: null },
      { id: 'a1', role: 'assistant', kind: 'notice', text: '这是已有的普通回答。', billContextId: null },
    ],
  };
  const card = render('home');
  const text = allText(card);
  check('对话：已有用户消息与普通回答保留，自动确认提示不显示',
    text.includes('这笔卖出的原因是什么？')
    && text.includes('这是已有的普通回答。')
    && !text.includes('账单已确认导入'),
    text.slice(0, 400));
}

/* —— 发送仍可用：提交问答输入后生成用户消息与本地回答 —— */
{
  state.bill = defaultBill();
  state.assistant = { ...state.assistant, qaMessages: [], qaInput: '' };
  const card = render('home');
  const form = nodesByClass(card, 'qa-form')[0];
  const input = nodesByClass(card, 'qa-input')[0];
  input.value = '怎么开始？';
  for (const fn of form.listeners.submit ?? []) fn({ preventDefault() {} });
  await Promise.resolve();
  check('发送：普通问答输入仍提交并生成用户消息与回答',
    state.assistant.qaMessages.length === 2
    && state.assistant.qaMessages[0].role === 'user'
    && state.assistant.qaMessages[0].text === '怎么开始？'
    && state.assistant.qaMessages[1].role === 'assistant'
    && String(state.assistant.qaMessages[1].text).includes('导入'),
    JSON.stringify(state.assistant.qaMessages));
  const after = render('home');
  check('发送后：用户消息与回答重新渲染可见',
    allText(after).includes('怎么开始？')
    && allText(after).includes(String(state.assistant.qaMessages[1].text)),
    allText(after).slice(0, 400));
}

/* —— 导入确认不再生成助手提示，但账单确认与收口保留 —— */
{
  const confirmState = {
    bill: {
      ...defaultBill(),
      status: 'loaded',
      sourceType: 'local',
      blocked: false,
      errors: [],
      fileName: 'local.csv',
      trades: [{ trade_id: 'T1' }],
      contextId: 'bill-confirm-1',
      importMethod: 'local',
    },
    importRecovery: { pending: false },
    assistant: defaultAssistant(),
  };
  const mergedSet = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'bill') confirmState.bill = { ...confirmState.bill, ...value };
      else if (key === 'assistant') confirmState.assistant = { ...confirmState.assistant, ...value };
      else confirmState[key] = value;
    }
  };
  let route = null;
  const result = finalizeConfirmedBill({
    state: confirmState,
    set: mergedSet,
    go: (next) => { route = next; },
    client: { completeFlow: () => ({ trace: { messages: [{ type: 'flow_end', reason: 'bill_confirmed' }] } }) },
  });
  check('导入：确认状态/报告跳转/flow 收口保留，助手不再生成确认提示',
    result.ok === true
    && confirmState.bill.status === 'confirmed'
    && route === 'report'
    && confirmState.assistant.messages.length === 0
    && confirmState.importRecovery.trace?.messages?.[0]?.reason === 'bill_confirmed',
    JSON.stringify({ result, bill: confirmState.bill.status, route, messages: confirmState.assistant.messages }));
}

/* —— 布局结构：固定面板与底部留白不变，消息区承接被移除内容的空白 —— */
{
  state.assistant = { ...state.assistant, messages: [{ role: 'assistant', kind: 'notice', text: AUTO_NOTICE }], qaMessages: [] };
  const card = render('contract');
  const classes = childClasses(card);
  const qa = nodesByClass(card, 'qa-assistant')[0];
  const qaChildren = childClasses(qa);
  const messagesIndex = qaChildren.findIndex((name) => name.includes('qa-messages'));
  const formIndex = qaChildren.findIndex((name) => name === 'qa-form');
  check('布局：侧栏仅剩标题与问答区，被移除内容后无尾部占位按钮',
    classes.length === 2 && classes[0] === 'assistant-head' && classes[1] === 'qa-assistant',
    JSON.stringify(classes));
  check('布局：问答区顺序为页面说明/芯片/消息/输入/隐私，消息区在输入之上',
    qaChildren[0] === 'qa-page'
    && qaChildren[1] === 'qa-chips'
    && messagesIndex > 1
    && formIndex > messagesIndex
    && qaChildren.at(-1) === 'qa-fine',
    JSON.stringify(qaChildren));

  const panel = cssBlock('.tm-assistant .assistant-panel {');
  const qaRule = cssBlock('.tm-assistant .qa-assistant {');
  const messagesRule = cssBlock('.tm-assistant .assistant-messages {');
  const qaMessagesRule = cssBlock('.tm-assistant .qa-messages {');
  check('布局：面板高度链路、底部 80px 安全区与内部裁剪保持',
    /display:\s*flex/.test(panel)
    && /flex:\s*1 1 auto/.test(panel)
    && /height:\s*100%/.test(panel)
    && /min-height:\s*0/.test(panel)
    && /overflow:\s*hidden/.test(panel)
    && /padding:\s*20px 18px 80px/.test(panel));
  check('布局：问答区与消息区 flex 撑满剩余高度，空出的空间由对话区承接',
    /flex:\s*1 1 auto/.test(qaRule)
    && /min-height:\s*0/.test(qaRule)
    && /flex:\s*1 1 auto/.test(messagesRule)
    && /min-height:\s*0/.test(messagesRule)
    && /overflow-y:\s*auto/.test(messagesRule)
    && /flex:\s*1 1 auto/.test(qaMessagesRule));
  const mobileAt = CSS.indexOf('@media (max-width: 679.98px)');
  const mobileFixed = CSS.indexOf('.tm-assistant {', mobileAt);
  const mobileRule = mobileFixed >= 0 ? CSS.slice(mobileFixed, CSS.indexOf('}', mobileFixed)) : '';
  check('布局：窄屏全屏固定方式与高度未改变',
    mobileAt >= 0
    && /position:\s*fixed/.test(mobileRule)
    && /inset:\s*0/.test(mobileRule)
    && /height:\s*100dvh/.test(mobileRule)
    && /max-height:\s*100dvh/.test(mobileRule));
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : '   → ' + result.detail}`);
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
