#!/usr/bin/env node
/**
 * 报告页 AI 解读入口与状态回归（本地 DOM 桩；不联网、不调用模型/行情）
 *
 * 覆盖：示例/未确认账单没有入口；已确认非示例账单有入口；
 *       一次点击只请求一次、进行中禁用、统一失败文案、失败不自动重试、
 *       只有用户点“重试 AI 解读”才再次请求、成功只保留一段 AI 解读；
 *       出站请求仍只有问题与 F-6 事实，不含本地答案、原始 CSV、文件名或图片。
 * 运行：node tests/ui/report-ai-explain.test.mjs
 */
import { defaultAssistant, defaultBill, defaultContracts } from '../../src/state.js';

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
  Object.defineProperty(node, 'className', {
    get() { return this.attrs.class ?? ''; },
    set(value) { this.attrs.class = String(value); },
  });
  return node;
}

globalThis.Node = FakeNode;
globalThis.document = { createElement: makeEl, createTextNode };
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.fetch = async () => { throw new Error('offline-test'); };

const { renderAssistantPanel } = await import('../../src/ui/assistantPanel.js');
const { pageHelpInfo, visibleHelpMessages } = await import('../../src/ui/qaAssistant.js');
const { runReview } = await import('../../src/agent/reviewPipeline.js');
const { createChatOnline } = await import('../../src/agent/chatOnline.js');
const { createFakeTransport, jsonResponse } = await import('../agent/fake-online-transport.mjs');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

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
function clickNode(node) {
  for (const fn of node?.listeners?.click ?? []) fn({ preventDefault() {} });
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const BUNDLE = {
  asOfDate: '2026-10-24',
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

function billOf(overrides = {}) {
  return {
    ...defaultBill(),
    status: 'confirmed',
    sourceType: 'local',
    blocked: false,
    fileName: 'user-bill.csv',
    trades: [{ trade_id: 'T1' }],
    contextId: 'report-ai-1',
    ...overrides,
  };
}

const state = {
  route: 'report',
  bill: billOf(),
  report: { symbol: 'pool' },
  contracts: defaultContracts(),
  chat: { messages: [] },
  assistant: defaultAssistant(),
};
const ctx = {
  state,
  assistantTitle: 'AI 助手',
  assistantSubtitle: '当前页面帮助 · 按需使用 AI',
  globalAssistant: true,
  qaDeps: { getReportBundle: () => BUNDLE },
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
function resetAssistant() {
  state.assistant = { ...defaultAssistant(), view: 'explain', qaMessages: [], qaAiPending: false };
}
function primaryOf(card) {
  return nodesByTag(card, 'button').find((node) => allText(node).includes('让 AI 解释当前数字')
    || allText(node).includes('正在生成 AI 解读'));
}
function retryOf(card) {
  return nodesByTag(card, 'button').find((node) => allText(node).includes('重试 AI 解读'));
}

/* ==== 入口规则 ==== */
{
  state.report = { symbol: 'pool' };
  state.bill = billOf({ demo: true, demoScenarioId: 'chase', contextId: 'demo-report-ai' });
  resetAssistant();
  const demoCard = render('report');
  check('示例账单：没有 AI 解读入口', !primaryOf(demoCard)
    && !allText(demoCard).includes('让 AI 解释当前数字'), allText(demoCard).slice(0, 320));

  state.bill = billOf({ status: 'loaded' });
  resetAssistant();
  const loadedCard = render('report');
  check('未确认账单：没有 AI 解读入口', !primaryOf(loadedCard)
    && !allText(loadedCard).includes('让 AI 解释当前数字'), allText(loadedCard).slice(0, 320));

  state.bill = billOf({ blocked: true });
  resetAssistant();
  const blockedCard = render('report');
  check('阻断账单：没有 AI 解读入口', !primaryOf(blockedCard), allText(blockedCard).slice(0, 320));

  state.bill = billOf();
  resetAssistant();
  const userCard = render('report');
  const userPrimary = primaryOf(userCard);
  check('已确认非示例账单：显示 AI 解读入口与发送范围',
    !!userPrimary
    && allText(userCard).includes('将发送当前页面已发布的数字和你的问题，不发送原始账单文件。'),
    allText(userCard).slice(0, 360));
}

/* ==== 一次点击：一次请求、进行中禁用、成功单段 ==== */
{
  state.bill = billOf();
  resetAssistant();
  let resolveAsk;
  let explainCalls = 0;
  let lastArgs = null;
  ctx.qaDeps.getReportBundle = () => BUNDLE;
  ctx.qaDeps.explainReport = (args) => {
    explainCalls += 1;
    lastArgs = args;
    return new Promise((resolve) => { resolveAsk = resolve; });
  };

  const card = render('report');
  clickNode(primaryOf(card));
  await flush();

  check('点击一次只产生一次 AI 解读请求', explainCalls === 1, String(explainCalls));
  const conversation = render('report');
  const pendingMsg = nodesByClass(conversation, 'qa-ai-msg')[0];
  check('请求进行中：显示加载状态且对话标记为 pending',
    state.assistant.view === 'conversation'
    && state.assistant.qaAiPending === true
    && pendingMsg?.attrs?.['data-status'] === 'pending'
    && allText(pendingMsg).includes('正在生成 AI 解读…'),
    JSON.stringify({ pending: state.assistant.qaAiPending, text: allText(pendingMsg) }));

  state.assistant.view = 'explain';
  const pendingCard = render('report');
  const pendingPrimary = primaryOf(pendingCard);
  check('请求进行中：入口按钮显示加载文案并禁用',
    pendingPrimary?.disabled === true
    && allText(pendingPrimary).includes('正在生成 AI 解读…'),
    JSON.stringify({ disabled: pendingPrimary?.disabled, text: allText(pendingPrimary) }));
  clickNode(pendingPrimary);
  await flush();
  check('请求进行中再次点击不会发起第二个请求', explainCalls === 1, String(explainCalls));

  resolveAsk({ ok: true, text: '这段卖出让你少赚 ¥100.00，实际收益 +3.7%，一直持有 +8.1%。' });
  state.assistant.view = 'conversation';
  await flush();
  const successCard = render('report');
  const last = state.assistant.qaMessages.at(-1);
  check('成功：只保留一段 AI 解读并标记为成功',
    explainCalls === 1
    && state.assistant.qaAiPending === false
    && state.assistant.qaMessages.length === 2
    && last?.status === 'ok'
    && last?.tag === 'AI 解读'
    && state.assistant.qaMessages.filter((m) => m.kind === 'ai' && m.retryKind === 'report-ai').length === 1
    && nodesByClass(successCard, 'qa-ai-msg').length === 1
    && !allText(successCard).includes('查看页面说明'),
    JSON.stringify({ messages: state.assistant.qaMessages, calls: explainCalls }));
  check('成功：只发送问题、当前账单与已发布报告，不发送原始文件',
    lastArgs?.question === '解释当前页面已发布的组合数字及其含义'
    && lastArgs?.bundle === BUNDLE
    && lastArgs?.bill === state.bill
    && !Object.keys(lastArgs ?? {}).some((key) => /csv|file|image|raw/i.test(key)),
    JSON.stringify(Object.keys(lastArgs ?? {})));

  state.route = 'chat';
  const chatCard = render('chat');
  check('AI 解读不混入其他页面', !allText(chatCard).includes('这段卖出让你少赚'), allText(chatCard).slice(0, 320));

  state.route = 'report';
  const otherBill = billOf({ contextId: 'report-ai-2' });
  state.bill = otherBill;
  const otherCard = render('report');
  check('AI 解读不混入其他账单', !allText(otherCard).includes('这段卖出让你少赚'), allText(otherCard).slice(0, 320));
}

/* ==== 失败状态：统一文案、无错误码、无自动重试 ==== */
const FAILURE_TEXT = 'AI 解读暂时不可用，本地页面说明仍然有效。';
{
  const failures = [
    ['502 网关错误', { ok: false, code: 'E_HTTP_STATUS', status: 502 }],
    ['504 超时', { ok: false, code: 'E_TRANSPORT_TIMEOUT', status: 504 }],
    ['鉴权失败', { ok: false, code: 'E_AUTH_REQUIRED', status: 401 }],
    ['响应校验失败', { ok: false, code: 'E_QA_NARRATIVE_CHECK' }],
  ];
  const texts = [];
  let retryButtons = 0;
  let leaked = false;
  for (const [label, result] of failures) {
    state.bill = billOf();
    resetAssistant();
    let calls = 0;
    ctx.qaDeps.explainReport = async () => { calls += 1; return result; };
    const card = render('report');
    clickNode(primaryOf(card));
    await flush();
    const conv = render('report');
    const last = state.assistant.qaMessages.at(-1);
    texts.push(last?.text);
    if (retryOf(conv)) retryButtons += 1;
    const text = allText(conv);
    if (/E_HTTP_STATUS|E_TRANSPORT_TIMEOUT|E_AUTH_REQUIRED|E_QA_NARRATIVE_CHECK|502|504|401|request_id|trace/.test(text)) leaked = true;
    await flush();
    if (calls !== 1) leaked = true;
  }
  check('502/504/鉴权/响应校验失败：统一用户友好失败状态',
    texts.every((text) => text === FAILURE_TEXT) && !leaked,
    JSON.stringify({ texts, leaked }));
  check('失败状态只提供“重试 AI 解读”，不再提供“查看页面说明”',
    retryButtons === failures.length,
    String(retryButtons));
}

{
  state.bill = billOf();
  resetAssistant();
  let calls = 0;
  ctx.qaDeps.explainReport = async () => { calls += 1; throw new Error('E_HTTP_STATUS 502'); };
  const before = JSON.stringify(pageHelpInfo(state, ctx.qaDeps).status?.lines ?? []);
  const card = render('report');
  clickNode(primaryOf(card));
  await flush();
  await flush();
  const conv = render('report');
  const text = allText(conv);
  const after = JSON.stringify(pageHelpInfo(state, ctx.qaDeps).status?.lines ?? []);
  check('请求抛错：仍显示统一失败状态，且本地页面说明不变',
    calls === 1
    && text.includes(FAILURE_TEXT)
    && before === after
    && state.chat.messages.length === 0
    && !/E_HTTP_STATUS|502|Error/.test(text),
    JSON.stringify({ calls, text: text.slice(0, 360) }));
}

/* ==== 主动重试：只由用户再次点击触发，不重复用户消息 ==== */
{
  state.bill = billOf();
  resetAssistant();
  let calls = 0;
  ctx.qaDeps.explainReport = async () => {
    calls += 1;
    return calls === 1
      ? { ok: false, code: 'E_HTTP_STATUS' }
      : { ok: true, text: '重试成功：择时差额 ¥100.00，实际收益 +3.7%。' };
  };
  const card = render('report');
  clickNode(primaryOf(card));
  await flush();
  check('失败后不会自动重试', calls === 1, String(calls));

  const failedCard = render('report');
  const retry = retryOf(failedCard);
  check('失败后只显示一次用户消息与一段 AI 解读',
    state.assistant.qaMessages.filter((m) => m.role === 'user').length === 1
    && state.assistant.qaMessages.filter((m) => m.kind === 'ai').length === 1,
    JSON.stringify(state.assistant.qaMessages));

  clickNode(retry);
  await flush();
  const successCard = render('report');
  const last = state.assistant.qaMessages.at(-1);
  check('用户主动重试：再次请求并复用同一段 AI 解读',
    calls === 2
    && state.assistant.qaMessages.filter((m) => m.role === 'user').length === 1
    && state.assistant.qaMessages.filter((m) => m.kind === 'ai').length === 1
    && last?.status === 'ok'
    && nodesByClass(successCard, 'qa-ai-msg').length === 1
    && allText(successCard).includes('重试成功'),
    JSON.stringify({ calls, messages: state.assistant.qaMessages }));
}

/* ==== 出站隐私：只发送问题与已核对事实 ==== */
{
  const ANSWER = '组合实际收益 +7.5%，对照收益 +15.0%，择时损耗 +7.5pp，损耗金额 ¥150.00。';
  const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
  const mk = (id, date, symbol, side, price, quantity) => ({
    trade_id: id, trade_date: date, symbol, side, price, quantity,
    fee: 0, tax: 0, fee_missing: false, tax_missing: false,
    source: { file: 'mini.csv', line: 2 },
  });
  const review = runReview({
    trades: [
      mk('T001', '2024-09-24', '000000', 'buy', 10, 100),
      mk('T002', '2024-09-27', '000000', 'sell', 11, 100),
      mk('B101', '2024-09-25', '888888', 'buy', 100, 10),
      mk('B102', '2024-09-30', '888888', 'sell', 105, 10),
    ],
    closes: { '000000': 12, '888888': 110 },
    valuation: VAL,
  });
  const transport = createFakeTransport({ restate: () => jsonResponse({ answer_text: ANSWER }) });
  const chat = createChatOnline({ transport, timeoutMs: 3000 });
  const result = await chat.ask({
    question: '解释当前页面已发布的组合数字及其含义',
    review,
  });
  const body = transport.calls[0]?.request ?? {};
  const serialized = JSON.stringify(body);
  check('出站：只包含问题和已核对事实', result.ok === true
    && Object.keys(body).join(',') === 'question,facts'
    && body.facts.length === 4,
  serialized.slice(0, 360));
  check('出站：不含本地答案、原始 CSV、文件名、图片或成交行',
    !serialized.includes('mini.csv')
    && !serialized.includes('日期,标的')
    && !serialized.includes('data_base64')
    && !serialized.includes('answer_text')
    && !serialized.includes('T001')
    && !serialized.includes('按同一笔本金和同一段行情'),
    serialized.slice(0, 360));
  check('出站：仍经过既有数字校验', result.number_check?.checked === 4
    && result.number_check?.failed_count === 0,
  JSON.stringify(result.number_check));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
