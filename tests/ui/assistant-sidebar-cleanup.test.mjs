#!/usr/bin/env node
/**
 * 助手侧栏清理回归（本地 DOM 桩；不联网、不调用模型/行情）
 *
 * 覆盖：所有页面移除“前往交易规则/前往事实问答”和自动账单确认提示；
 *       规则页不再渲染规则描述输入与“让 AI 理解”；
 *       助手只保留页面帮助：问答页没有第二个输入框，其他页只保留一个帮助输入；
 *       面板固定高度/底部留白与消息区承接空白的结构不变。
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
  assistantSubtitle: '当前页面的说明与操作',
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
  check(`侧栏·${route}：不显示两个快捷按钮与自动账单确认提示`,
    !text.includes('前往交易规则')
    && !text.includes('前往事实问答')
    && !text.includes('账单已确认导入')
    && !nodesByClass(card, 'assistant-msg').some((node) => allText(node).includes(AUTO_NOTICE)),
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

function clickNode(node) {
  for (const fn of node?.listeners?.click ?? []) fn({ preventDefault() {} });
}

for (const route of ['home', 'import', 'report', 'contract']) {
  const card = render(route);
  const text = allText(card);
  check(`侧栏·${route}：默认说明视图不显示输入框，保留 3 个本地帮助提示与展开对话`,
    nodesByClass(card, 'qa-explain').length === 1
    && nodesByClass(card, 'qa-conversation').length === 0
    && nodesByTag(card, 'textarea').length === 0
    && nodesByClass(card, 'qa-chip').length === 3
    && nodesByTag(card, 'button').some((node) => allText(node).includes('展开对话'))
    && text.includes('页面帮助在本机回答，不发送')
    && text.includes('账单分析请去问答页'),
    text.slice(0, 360));
}

{
  const card = render('home');
  const expand = nodesByTag(card, 'button').find((node) => allText(node).includes('展开对话'));
  clickNode(expand);
  const conversation = render('home');
  const text = allText(conversation);
  check('展开对话：进入对话视图，出现唯一页面帮助输入、发送按钮与不跳转说明',
    state.assistant.view === 'conversation'
    && nodesByClass(conversation, 'qa-conversation').length === 1
    && nodesByTag(conversation, 'textarea').length === 1
    && nodesByClass(conversation, 'assistant-help-input').length === 1
    && nodesByClass(conversation, 'qa-form').length === 1
    && nodesByClass(conversation, 'qa-form')[0].children.some((node) => allText(node).includes('发送'))
    && text.includes('回答会显示在上方对话中，不会跳转页面。')
    && nodesByTag(conversation, 'button').some((node) => allText(node).includes('收起对话')),
    text.slice(0, 420));
}

{
  state.assistant = { ...state.assistant, view: 'explain' };
  const card = render('chat');
  const text = allText(card);
  check('侧栏·chat：默认说明视图不显示第二个输入框，提供定位按钮',
    nodesByTag(card, 'textarea').length === 0
    && nodesByClass(card, 'qa-form').length === 0
    && text.includes('完整问答请使用下方输入框')
    && text.includes('定位到问答输入区')
    && text.includes('这里只说明本页操作、画像记录和隐私'),
    text.slice(0, 360));

  state.assistant = { ...state.assistant, view: 'conversation' };
  const conversation = render('chat');
  check('侧栏·chat：对话视图仍不显示第二个输入框',
    nodesByTag(conversation, 'textarea').length === 0
    && nodesByClass(conversation, 'qa-form').length === 0
    && nodesByTag(conversation, 'button').some((node) => allText(node).includes('定位到问答输入区')),
    allText(conversation).slice(0, 360));
  state.assistant = { ...state.assistant, view: 'explain' };
}

/* —— 规则描述模块在规则页（画像与规则 / 操作复盘的共享路由）彻底移除 —— */
{
  const card = render('contract');
  check('规则页：侧栏不再有规则描述输入与提交按钮',
    !nodesByTag(card, 'button').some((node) => allText(node).includes('让 AI 理解'))
    && nodesByTag(card, 'textarea').length === 0
    && nodesByClass(card, 'assistant-help-input').length === 0
    && !nodesByTag(card, 'textarea').some((node) => node.attrs?.id === 'assistant-rule-input'),
    allText(card).slice(0, 320));
}

/* —— 问答消息保留；自动确认提示即使已在状态中也不再显示 —— */
{
  state.assistant = {
    ...state.assistant,
    view: 'conversation',
    messages: [{ role: 'assistant', kind: 'notice', text: AUTO_NOTICE }],
    qaMessages: [
      { id: 'u1', role: 'user', kind: 'help-user', text: '这个页面怎么用？', billContextId: null },
      { id: 'a1', role: 'assistant', kind: 'help', text: '这是已有的页面帮助回答。', billContextId: null },
    ],
  };
  const card = render('home');
  const text = allText(card);
  check('对话：已有帮助消息保留，自动确认提示不显示',
    text.includes('这个页面怎么用？')
    && text.includes('这是已有的页面帮助回答。')
    && !text.includes('账单已确认导入'),
    text.slice(0, 400));

  const collapse = nodesByTag(card, 'button').find((node) => allText(node).includes('收起对话'));
  clickNode(collapse);
  const collapsed = render('home');
  check('收起对话：消息不清空，说明视图显示最后回答摘要',
    state.assistant.view === 'explain'
    && state.assistant.qaMessages.length === 2
    && allText(collapsed).includes('上次回答：')
    && allText(collapsed).includes('这是已有的页面帮助回答。'),
    allText(collapsed).slice(0, 400));
}

/* —— 发送仍可用：提交问答输入后生成用户消息与本地回答 —— */
{
  state.bill = defaultBill();
  state.assistant = { ...state.assistant, view: 'explain', qaMessages: [], qaInput: '' };
  const explain = render('home');
  const chip = nodesByClass(explain, 'qa-chip')[0];
  clickNode(chip);
  check('本地帮助提示：生成用户消息与本地回答，并自动进入对话视图',
    state.assistant.view === 'conversation'
    && state.assistant.qaMessages.length === 2
    && state.assistant.qaMessages[0].role === 'user'
    && state.assistant.qaMessages[0].kind === 'help-user'
    && state.assistant.qaMessages[1].role === 'assistant'
    && state.assistant.qaMessages[1].kind === 'help',
    JSON.stringify(state.assistant.qaMessages));

  state.assistant = { ...state.assistant, view: 'conversation', qaMessages: [], qaInput: '' };
  const card = render('home');
  const form = nodesByClass(card, 'qa-form')[0];
  const input = nodesByClass(card, 'assistant-help-input')[0];
  const send = nodesByTag(card, 'button').find((node) => allText(node) === '发送');
  check('空输入：发送按钮禁用且提交不生成消息',
    send?.disabled === true && state.assistant.qaMessages.length === 0,
    String(send?.disabled));
  for (const fn of form.listeners.submit ?? []) fn({ preventDefault() {} });
  check('空输入提交后仍无消息', state.assistant.qaMessages.length === 0, JSON.stringify(state.assistant.qaMessages));

  input.value = '怎么开始？';
  for (const fn of input.listeners.input ?? []) fn({ target: { value: '怎么开始？' } });
  check('输入后发送按钮可用', send?.disabled === false);
  for (const fn of form.listeners.submit ?? []) fn({ preventDefault() {} });
  await Promise.resolve();
  check('发送：页面帮助输入仍提交并生成帮助消息与本地回答',
    state.assistant.qaMessages.length === 2
    && state.assistant.qaMessages[0].role === 'user'
    && state.assistant.qaMessages[0].kind === 'help-user'
    && state.assistant.qaMessages[0].text === '怎么开始？'
    && state.assistant.qaMessages[1].role === 'assistant'
    && state.assistant.qaMessages[1].kind === 'help'
    && String(state.assistant.qaMessages[1].text).includes('导入')
    && state.assistant.qaInput === '',
    JSON.stringify(state.assistant.qaMessages));
  const after = render('home');
  check('发送后：用户消息与回答重新渲染可见',
    allText(after).includes('怎么开始？')
    && allText(after).includes(String(state.assistant.qaMessages[1].text)),
    allText(after).slice(0, 400));

  const input2 = nodesByClass(after, 'assistant-help-input')[0];
  input2.value = '数据安全吗？';
  for (const fn of input2.listeners.input ?? []) fn({ target: { value: '数据安全吗？' } });
  for (const fn of input2.listeners.keydown ?? []) {
    fn({ key: 'Enter', shiftKey: false, preventDefault() {} });
  }
  await Promise.resolve();
  check('Enter 发送：生成用户消息与本地回答，不跳转页面',
    state.assistant.qaMessages.length === 4
    && state.assistant.qaMessages[2].text === '数据安全吗？'
    && state.assistant.qaMessages[3].kind === 'help'
    && state.route === 'home',
    JSON.stringify({ route: state.route, messages: state.assistant.qaMessages.slice(-2) }));
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
  const conversation = nodesByClass(card, 'qa-conversation')[0];
  const convChildren = conversation ? childClasses(conversation) : [];
  const barIndex = convChildren.indexOf('qa-conv-bar');
  const messagesIndex = convChildren.findIndex((name) => name.includes('qa-messages'));
  const formIndex = convChildren.indexOf('qa-form');
  check('布局：侧栏仅剩标题与页面帮助区，被移除内容后无尾部占位按钮',
    classes.length === 2 && classes[0] === 'assistant-head' && classes[1] === 'qa-assistant',
    JSON.stringify(classes));
  check('布局：对话视图为顶部状态栏/消息区/底部输入/隐私说明，消息区在输入之上',
    qaChildren.length === 1 && qaChildren[0] === 'qa-conversation'
    && barIndex === 0
    && messagesIndex > barIndex
    && formIndex > messagesIndex
    && convChildren.at(-1) === 'qa-fine',
    JSON.stringify({ qaChildren, convChildren }));

  const panel = cssBlock('.tm-assistant .assistant-panel {');
  const qaRule = cssBlock('.tm-assistant .qa-assistant {');
  const messagesRule = cssBlock('.tm-assistant .assistant-messages {');
  const qaMessagesRule = cssBlock('.tm-assistant .qa-messages {');
  const convRule = cssBlock('.tm-assistant .qa-conversation {');
  check('布局：面板高度链路、底部 80px 安全区与内部裁剪保持',
    /display:\s*flex/.test(panel)
    && /flex:\s*1 1 auto/.test(panel)
    && /height:\s*100%/.test(panel)
    && /min-height:\s*0/.test(panel)
    && /overflow:\s*hidden/.test(panel)
    && /padding:\s*20px 18px 80px/.test(panel));
  check('布局：对话容器 flex 撑满剩余高度，仅消息区独立纵向滚动',
    /flex:\s*1 1 auto/.test(qaRule)
    && /min-height:\s*0/.test(qaRule)
    && /overflow:\s*hidden/.test(convRule)
    && /flex:\s*1 1 auto/.test(messagesRule)
    && /min-height:\s*0/.test(messagesRule)
    && /overflow-y:\s*auto/.test(messagesRule)
    && /overflow-x:\s*hidden/.test(qaMessagesRule));
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

/* —— 说明视图的主要 AI 操作：只在主动点击后调用，结果显示在对话中 —— */
{
  const BUNDLE = {
    asOfDate: '2026-10-22',
    review: {
      portfolio_published: true,
      published_facts: [
        { scope: 'portfolio', key: 'actualRet', display: '+3.7%' },
        { scope: 'portfolio', key: 'ghostRet', display: '+8.1%' },
        { scope: 'portfolio', key: 'drag', display: '+4.4pp' },
        { scope: 'portfolio', key: 'dragMoney', display: '¥100.00' },
      ],
    },
  };
  const calls = [];
  ctx.qaDeps.getReportBundle = () => BUNDLE;
  ctx.qaDeps.explainReport = async (args) => {
    calls.push(args);
    return { ok: true, text: 'AI 解释了已发布的四项组合数字（收益类计算 CALC_RET_V1）。' };
  };
  state.bill = {
    ...defaultBill(),
    status: 'confirmed',
    sourceType: 'local',
    blocked: false,
    fileName: 'report-ai.csv',
    trades: [{ trade_id: 'T1' }],
    contextId: 'report-ai-1',
  };
  state.route = 'report';
  state.report = { symbol: 'pool' };
  state.assistant = { ...defaultAssistant(), view: 'explain', qaMessages: [] };

  const explain = render('report');
  const primary = nodesByTag(explain, 'button').find((node) => allText(node).includes('让 AI 解释当前数字'));
  check('报告页：主动点击前不调用模型，并显示发送范围说明',
    calls.length === 0
    && !!primary
    && allText(explain).includes('将发送当前页面已发布的数字和你的问题，不发送原始账单文件。'),
    allText(explain).slice(0, 360));

  clickNode(primary);
  await Promise.resolve();
  await Promise.resolve();
  const conversation = render('report');
  const last = state.assistant.qaMessages.at(-1);
  check('报告页：点击后进入对话视图，结果标注 AI 解读并清理内部公式 ID',
    calls.length === 1
    && state.assistant.view === 'conversation'
    && state.assistant.qaMessages.length === 2
    && last?.kind === 'ai'
    && last?.tag === 'AI 解读'
    && last?.status === 'ok'
    && last.text.includes('AI 解释了已发布的四项组合数字')
    && !/CALC_/.test(last.text)
    && !allText(conversation).match(/CALC_|trace|request_id|E_[A-Z_]+/),
    JSON.stringify({ calls: calls.length, messages: state.assistant.qaMessages }));

  ctx.qaDeps.explainReport = async () => ({ ok: false, code: 'E_MODEL_NOT_CONFIGURED' });
  state.assistant = { ...defaultAssistant(), view: 'explain', qaMessages: [] };
  const failedCard = render('report');
  const failedPrimary = nodesByTag(failedCard, 'button').find((node) => allText(node).includes('让 AI 解释当前数字'));
  clickNode(failedPrimary);
  await Promise.resolve();
  await Promise.resolve();
  const failedConversation = render('report');
  const failedLast = state.assistant.qaMessages.at(-1);
  check('报告页：AI 失败时显示统一失败状态与重试入口，不显示内部错误码',
    failedLast?.status === 'failed'
    && failedLast.text === 'AI 解读暂时不可用，本地页面说明仍然有效。'
    && nodesByTag(failedConversation, 'button').some((node) => allText(node).includes('重试 AI 解读'))
    && !nodesByTag(failedConversation, 'button').some((node) => allText(node).includes('查看页面说明'))
    && !allText(failedConversation).match(/E_MODEL_NOT_CONFIGURED|trace|request_id/),
    JSON.stringify(failedLast));
}

{
  const calls = [];
  ctx.qaDeps.runImportAi = async (args) => {
    calls.push(args);
    return { ok: true, kind: 'vision', draftCount: 2 };
  };
  state.bill = { ...defaultBill(), status: 'loaded', sourceType: 'local', fileName: 'shot.png' };
  state.route = 'import';
  state.importRecovery = {
    ...ctx.state.importRecovery,
    pending: false,
    budgetExhausted: false,
    status: 'vision_ready',
    content: '',
    vision: {
      kind: 'image',
      status: 'ready',
      images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }, { mime: 'image/jpeg', data_base64: 'BBBB' }],
    },
  };
  state.chat = { messages: [] };
  state.assistant = { ...defaultAssistant(), view: 'explain', qaMessages: [] };

  const explain = render('import');
  const primary = nodesByTag(explain, 'button').find((node) => allText(node).includes('让 AI 识别图片/PDF'));
  check('导入页：有截图时显示识别入口与发送范围说明',
    calls.length === 0
    && !!primary
    && allText(explain).includes('不发送原始文件')
    && allText(explain).includes('不会自动确认账单'),
    allText(explain).slice(0, 360));

  clickNode(primary);
  await Promise.resolve();
  await Promise.resolve();
  const last = state.assistant.qaMessages.at(-1);
  check('导入页：点击后只生成可编辑草稿提示，不自动确认账单、不写入问答账本',
    calls.length === 1
    && state.assistant.view === 'conversation'
    && last?.kind === 'ai'
    && last?.status === 'ok'
    && last.text.includes('可编辑草稿（2 条交易）')
    && last.text.includes('尚未确认账单')
    && state.bill.status === 'loaded'
    && state.chat.messages.length === 0,
    JSON.stringify({ last, bill: state.bill.status, chat: state.chat.messages.length }));

  ctx.qaDeps.runImportAi = async () => ({ ok: false, code: 'E_MODEL_NOT_CONFIGURED' });
  state.assistant = { ...defaultAssistant(), view: 'explain', qaMessages: [] };
  const failedCard = render('import');
  const failedPrimary = nodesByTag(failedCard, 'button').find((node) => allText(node).includes('让 AI 识别图片/PDF'));
  clickNode(failedPrimary);
  await Promise.resolve();
  await Promise.resolve();
  const failedLast = state.assistant.qaMessages.at(-1);
  check('导入页：视觉模型不可用时显示明确失败，不伪造成功、不显示错误码',
    failedLast?.status === 'failed'
    && failedLast.text.includes('AI 识别未完成')
    && !failedLast.text.match(/E_MODEL_NOT_CONFIGURED|trace|request_id/),
    JSON.stringify(failedLast));
}

{
  let reviewCalls = 0;
  ctx.qaDeps.explainReviewResult = async () => {
    reviewCalls += 1;
    return { ok: true, text: 'AI 解释了本次复盘结果。' };
  };
  const REVIEW = { summary: { trades_n: 1 }, operations: [] };

  state.route = 'contract';
  state.contractPage = 'me';
  state.contracts = { ...defaultContracts(), versions: [], simContext: { review: REVIEW } };
  state.assistant = {
    ...defaultAssistant(),
    view: 'explain',
    qaMessages: [],
    simulation: { result_id: 'sim-1' },
  };
  const meCard = render('contract');
  check('个人中心：助手只提供前往历史复盘，不显示复盘 AI 解释或申报前自检',
    reviewCalls === 0
    && nodesByTag(meCard, 'button').some((node) => allText(node).includes('前往历史复盘'))
    && !nodesByTag(meCard, 'button').some((node) => allText(node).includes('让 AI 解释复盘结果'))
    && !allText(meCard).match(/申报前自检|SELF CHECK|假如买入|假如卖出/),
    allText(meCard).slice(0, 360));

  state.contractPage = 'scenario';
  state.contracts = { ...defaultContracts(), versions: [], simContext: null };
  state.assistant = { ...defaultAssistant(), view: 'explain', qaMessages: [], simulation: { result_id: 'sim-1' } };
  const loadingCard = render('contract');
  check('复盘页：复盘结果加载完成前只提供打开规则管理',
    reviewCalls === 0
    && nodesByTag(loadingCard, 'button').some((node) => allText(node).includes('打开规则管理'))
    && !nodesByTag(loadingCard, 'button').some((node) => allText(node).includes('让 AI 解释复盘结果')),
    allText(loadingCard).slice(0, 360));

  state.contracts = { ...defaultContracts(), versions: [], simContext: { review: REVIEW } };
  const card = render('contract');
  const primary = nodesByTag(card, 'button').find((node) => allText(node).includes('让 AI 解释复盘结果'));
  check('复盘页：复盘结果加载完成且已有复核摘要时显示 AI 解释入口与发送范围说明',
    reviewCalls === 0
    && !!primary
    && allText(card).includes('只发送本次复盘已核对的规则与结果摘要'),
    allText(card).slice(0, 360));
  clickNode(primary);
  await Promise.resolve();
  await Promise.resolve();
  const last = state.assistant.qaMessages.at(-1);
  check('复盘页：点击后结果进入对话并标注 AI 解释',
    reviewCalls === 1
    && state.assistant.view === 'conversation'
    && last?.kind === 'ai'
    && last?.tag === 'AI 解释'
    && last?.status === 'ok'
    && last.text.includes('AI 解释了本次复盘结果。'),
    JSON.stringify({ reviewCalls, last }));
}

{
  let focused = 0;
  ctx.qaDeps.focusQaInput = () => { focused += 1; };
  state.route = 'chat';
  state.assistant = { ...defaultAssistant(), view: 'explain' };
  const card = render('chat');
  const focus = nodesByTag(card, 'button').find((node) => allText(node).includes('定位到问答输入区'));
  clickNode(focus);
  check('问答页：定位按钮只调用主问答输入区，不新增第二个输入框',
    focused === 1
    && nodesByTag(card, 'textarea').length === 0
    && nodesByClass(card, 'qa-form').length === 0
    && state.route === 'chat',
    JSON.stringify({ focused, route: state.route }));
}

{
  state.route = 'home';
  state.assistant = defaultAssistant();
  check('助手状态：默认进入说明视图，视图模式不写入云端结构',
    state.assistant.view === 'explain'
    && state.assistant.qaMessages.length === 0
    && !('cloud' in state.assistant),
    JSON.stringify({ view: state.assistant.view }));
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : '   → ' + result.detail}`);
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
