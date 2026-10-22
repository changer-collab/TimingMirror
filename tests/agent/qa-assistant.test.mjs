#!/usr/bin/env node
/**
 * 全局助手问答编排 —— 离线单测（fake bundle/transport；不调用真实模型或行情）
 *
 * 覆盖：页面 FAQ 本地回答；五个芯片在报告/规则页出现；本地芯片零 model/market；
 *       组合表现仅在点击时调用既有复述；自由文本在报告页走既有复述、在导入/首页不出站；
 *       账单变化隐藏旧账单回答；报告加载只在用户操作时发生且复用缓存。
 * 运行：node tests/agent/qa-assistant.test.mjs
 */
import { defaultAssistant } from '../../src/state.js';
import { QA_CHIPS } from '../../src/agent/qaChips.js';
import {
  pageInfo,
  sendChip,
  sendText,
  visibleMessages,
} from '../../src/ui/qaAssistant.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BILL = {
  status: 'confirmed',
  sourceType: 'local',
  blocked: false,
  contextId: 'qa-bill-1',
  fileName: 'qa-fake.csv',
  trades: [{ trade_id: 'E003', trade_date: '2025-06-10', symbol: '300750', side: 'sell', price: 210, quantity: 200, fee: 0, tax: 0, source: { file: 'qa-fake.csv', line: 4 } }],
};
const PUBLISHED = [
  { scope: 'portfolio', key: 'actualRet', display: '+3.7%' },
  { scope: 'portfolio', key: 'ghostRet', display: '+81.4%' },
  { scope: 'portfolio', key: 'drag', display: '+77.7pp' },
  { scope: 'portfolio', key: 'dragMoney', display: '¥31,452.00' },
];
const BUNDLE = {
  status: 'ok',
  review: { portfolio_published: true, published_facts: PUBLISHED },
  insights: {
    portfolio: {
      report: {},
      decomposition: {
        blocked: false,
        total: { display: '¥31,452.00' },
        items: [{
          trade_id: 'E003', trade_date: '2025-06-10', symbol: '300750', quantity: 200, price: 210, close: 367.26,
          dragMoney: 31452, display: { dragMoney: '¥31,452.00', share: '+100.0%' },
          source: { file: 'qa-fake.csv', line: 4 },
        }],
      },
    },
    behavior: { available: false, reason: '测试不覆盖' },
    stock_self: { available: false, reason: '测试不覆盖' },
    pgr: { available: false, reason: '测试不覆盖' },
  },
};

function makeState(route = 'report', bill = BILL) {
  return { route, bill, contracts: { versions: [] }, assistant: defaultAssistant() };
}

function makeCtx(state, deps = {}) {
  const ctx = {
    state,
    qaDeps: {
      getReportBundle: () => BUNDLE,
      loadReportBundle: async () => BUNDLE,
      askOnline: async () => ({ ok: true, text: '在线复述（测试）', number_check: { checked: 4, matched_count: 4, failed_count: 0 } }),
      ruleStateOf: () => ({ active_templates: [], active_count: 0, version_count: 0 }),
      loadProfile: () => null,
      openRuleCandidate: () => true,
      ...deps,
    },
    set(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'assistant' && value && typeof value === 'object') {
          state.assistant = { ...state.assistant, ...value };
        } else {
          state[key] = value;
        }
      }
    },
    go(route) { state.route = route; },
  };
  return ctx;
}

function chipEntry(state, ctx, id) {
  return pageInfo(state, ctx.qaDeps).chips.find((entry) => entry.chip?.id === id);
}

/* ==== 页面入口 ==== */
{
  const report = makeState('report');
  const reportCtx = makeCtx(report);
  const reportInfo = pageInfo(report, reportCtx.qaDeps);
  check('报告页：五个芯片齐全且顺序确定', reportInfo.chips.filter((c) => c.chip).map((c) => c.chip.id).join(',') === QA_CHIPS.map((c) => c.id).join(','), JSON.stringify(reportInfo.chips.map((c) => c.label)));
  check('报告页：页面简介与当前账单上下文可见', reportInfo.intro.includes('报告页') && reportInfo.context.includes('qa-fake.csv') && reportInfo.context.includes('报告：已发布'), JSON.stringify(reportInfo));

  const contract = makeState('contract');
  const contractInfo = pageInfo(contract, makeCtx(contract).qaDeps);
  check('规则页：五个芯片 + 规则命中/N-AI 兜底说明入口', contractInfo.chips.filter((c) => c.chip).length === 5
    && contractInfo.chips.some((c) => c.faq?.id === 'rule-hit') && contractInfo.chips.some((c) => c.faq?.id === 'rule-ai'), JSON.stringify(contractInfo.chips.map((c) => c.label)));

  const chat = makeState('chat');
  const chatInfo = pageInfo(chat, makeCtx(chat).qaDeps);
  check('独立问答页保留：五个芯片 + 页面 FAQ 可用', chatInfo.chips.filter((c) => c.chip).length === 5
    && chatInfo.chips.some((c) => c.faq?.id === 'chat-privacy')
    && chatInfo.intro.includes('事实问答页'), JSON.stringify(chatInfo.chips.map((c) => c.label)));

  const importState = makeState('import', { ...BILL, status: 'none', contextId: null });
  const importInfo = pageInfo(importState, makeCtx(importState).qaDeps);
  check('导入页：只展示页面相关常见问题，不展示账单五芯片', importInfo.chips.every((c) => c.faq) && importInfo.chips.some((c) => c.faq.id === 'import-privacy'), JSON.stringify(importInfo.chips.map((c) => c.label)));

  const home = makeState('home', { ...BILL, status: 'none', contextId: null });
  const homeInfo = pageInfo(home, makeCtx(home).qaDeps);
  check('首页：展示开始/对照/隐私说明', homeInfo.chips.map((c) => c.faq.id).join(',') === 'home-start,home-benchmark,home-privacy');
}

/* ==== 本地芯片零请求 ==== */
{
  const state = makeState('report');
  let loads = 0;
  let asks = 0;
  const ctx = makeCtx(state, {
    loadReportBundle: async () => { loads += 1; return BUNDLE; },
    askOnline: async () => { asks += 1; return { ok: true, text: 'x', number_check: {} }; },
  });
  const entry = chipEntry(state, ctx, 'worst_trade');
  await sendChip(ctx, entry);
  const last = state.assistant.qaMessages[state.assistant.qaMessages.length - 1];
  check('本地芯片：有缓存时不加载报告、不请求模型', loads === 0 && asks === 0
    && last?.kind === 'chip' && last.answer?.text.includes('2025-06-10'), JSON.stringify({ loads, asks, last }));
  check('本地芯片：消息绑定账单 contextId 与规则键', last.billContextId === 'qa-bill-1' && typeof last.ruleStateKey === 'string', JSON.stringify(last));

  const cold = makeState('report');
  let coldLoads = 0;
  let coldAsks = 0;
  const coldCtx = makeCtx(cold, {
    getReportBundle: () => null,
    loadReportBundle: async () => { coldLoads += 1; return BUNDLE; },
    askOnline: async () => { coldAsks += 1; return { ok: true, text: 'x', number_check: {} }; },
  });
  await sendChip(coldCtx, chipEntry(cold, coldCtx, 'worst_trade'));
  const coldLast = cold.assistant.qaMessages.at(-1);
  check('本地芯片·冷缓存：只给页面引导，不加载报告/行情、不请求模型', coldLoads === 0 && coldAsks === 0
    && coldLast?.detail?.includes('W_QA_REPORT_NOT_CACHED') && coldLast.text.includes('不会启动报告或行情加载'), JSON.stringify({ coldLoads, coldAsks, coldLast }));
}

/* ==== 组合表现仅点击时在线 ==== */
{
  const state = makeState('report');
  let loads = 0;
  let asks = 0;
  const ctx = makeCtx(state, {
    loadReportBundle: async () => { loads += 1; return BUNDLE; },
    askOnline: async ({ question }) => {
      asks += 1;
      return { ok: true, text: `在线：${question}`, number_check: { checked: 4, matched_count: 4, failed_count: 0 } };
    },
  });
  const entry = chipEntry(state, ctx, 'portfolio');
  await sendChip(ctx, entry, { source: 'click' });
  const last = state.assistant.qaMessages[state.assistant.qaMessages.length - 1];
  check('组合表现点击：有缓存时只调用一次在线复述，不加载报告', asks === 1 && loads === 0
    && last?.kind === 'online' && last.online === true, JSON.stringify({ loads, asks, last }));
  check('组合表现点击：在线回答绑定当前账单 contextId', last?.billContextId === 'qa-bill-1', JSON.stringify(last));

  const noCacheState = makeState('report');
  let noCacheLoads = 0;
  let noCacheAsks = 0;
  const noCacheCtx = makeCtx(noCacheState, {
    getReportBundle: () => null,
    loadReportBundle: async () => { noCacheLoads += 1; return BUNDLE; },
    askOnline: async () => { noCacheAsks += 1; return { ok: true, text: '在线', number_check: { checked: 4, matched_count: 4, failed_count: 0 } }; },
  });
  await sendChip(noCacheCtx, chipEntry(noCacheState, noCacheCtx, 'portfolio'), { source: 'click' });
  check('组合表现点击：无缓存时只加载一次同一报告，再调用一次复述', noCacheLoads === 1 && noCacheAsks === 1, JSON.stringify({ noCacheLoads, noCacheAsks }));
}

/* ==== 页面 FAQ / 自由文本 ==== */
{
  const state = makeState('import', { ...BILL, status: 'none', contextId: null });
  let loads = 0;
  let asks = 0;
  const ctx = makeCtx(state, {
    loadReportBundle: async () => { loads += 1; return BUNDLE; },
    askOnline: async () => { asks += 1; return { ok: true, text: 'x', number_check: {} }; },
  });
  await sendText(ctx, '原始 CSV 会上传吗？');
  const last = state.assistant.qaMessages[state.assistant.qaMessages.length - 1];
  check('导入页 FAQ：本机回答，零行情/零模型', loads === 0 && asks === 0 && last?.kind === 'notice' && last.text.includes('不会'), JSON.stringify({ loads, asks, last }));
  await sendText(ctx, '帮我看看明天哪只会涨？');
  check('导入页自由文本：不出站，提示先确认账单/打开报告', loads === 0 && asks === 0
    && state.assistant.qaMessages[state.assistant.qaMessages.length - 1].text.includes('已确认'), JSON.stringify(state.assistant.qaMessages.at(-1)));
}

{
  const state = makeState('report');
  let loads = 0;
  let asks = 0;
  const ctx = makeCtx(state, {
    loadReportBundle: async () => { loads += 1; return BUNDLE; },
    askOnline: async () => { asks += 1; return { ok: true, text: '在线复述（测试）', number_check: { checked: 4, matched_count: 4, failed_count: 0 } }; },
  });
  await sendText(ctx, '这些数字怎么来的？');
  check('报告页自由文本：复用既有在线复述，不额外加载行情', loads === 0 && asks === 1
    && state.assistant.qaMessages.at(-1)?.kind === 'online', JSON.stringify({ loads, asks, last: state.assistant.qaMessages.at(-1) }));

  const cold = makeState('report');
  let coldLoads = 0;
  let coldAsks = 0;
  const coldCtx = makeCtx(cold, {
    getReportBundle: () => null,
    loadReportBundle: async () => { coldLoads += 1; return BUNDLE; },
    askOnline: async () => { coldAsks += 1; return { ok: true, text: 'x', number_check: {} }; },
  });
  await sendText(coldCtx, '这些数字怎么来的？');
  check('报告页自由文本·冷缓存：只给页面引导，不加载报告/行情、不请求模型', coldLoads === 0 && coldAsks === 0
    && cold.assistant.qaMessages.at(-1)?.detail?.includes('W_QA_REPORT_NOT_CACHED'), JSON.stringify(cold.assistant.qaMessages.at(-1)));

  const advice = makeState('report');
  let adviceAsks = 0;
  const adviceCtx = makeCtx(advice, { askOnline: async () => { adviceAsks += 1; return { ok: true, text: 'x', number_check: {} }; } });
  await sendText(adviceCtx, '明天买什么？');
  check('报告页越界自由文本：本地拒绝，不请求模型', adviceAsks === 0
    && advice.assistant.qaMessages.at(-1)?.detail === 'W_QA_ADVICE_BLOCKED', JSON.stringify(advice.assistant.qaMessages.at(-1)));

  const rulePage = makeState('contract');
  let ruleAsks = 0;
  const ruleCtx = makeCtx(rulePage, { askOnline: async () => { ruleAsks += 1; return { ok: true, text: 'x', number_check: {} }; } });
  await sendText(ruleCtx, '我的规则会命中吗？');
  check('规则页自由文本：本地引导使用规则输入/芯片，不误发复述', ruleAsks === 0
    && rulePage.assistant.qaMessages.at(-1)?.detail === 'W_QA_RULE_PAGE', JSON.stringify(rulePage.assistant.qaMessages.at(-1)));

  const chatPage = makeState('chat');
  let chatAsks = 0;
  const chatCtx = makeCtx(chatPage, { askOnline: async () => { chatAsks += 1; return { ok: true, text: '在线复述（测试）', number_check: { checked: 4, matched_count: 4, failed_count: 0 } }; } });
  await sendText(chatCtx, '这些数字怎么来的？');
  check('独立问答页自由文本：沿用既有复述接口，不额外加载行情', chatAsks === 1
    && chatPage.assistant.qaMessages.at(-1)?.kind === 'online', JSON.stringify(chatPage.assistant.qaMessages.at(-1)));
}

/* ==== 组合文本入口：本地事实，不冒充在线 ==== */
{
  const state = makeState('report');
  let asks = 0;
  const ctx = makeCtx(state, { askOnline: async () => { asks += 1; return { ok: true, text: 'x', number_check: {} }; } });
  await sendText(ctx, '组合整体表现如何？');
  const last = state.assistant.qaMessages.at(-1);
  check('自由文本“组合表现”：使用已发布四事实本地回答，不请求复述', asks === 0
    && last?.kind === 'chip' && last.answer?.text.includes('+3.7%') && last.answer?.text.includes('¥31,452.00'), JSON.stringify({ asks, last }));
}

/* ==== 账单变化隐藏旧回答 ==== */
{
  const state = makeState('report');
  state.assistant.qaMessages = [
    { id: 'old', role: 'assistant', text: '旧账单回答', billContextId: 'qa-bill-1' },
    { id: 'page', role: 'assistant', text: '页面说明', billContextId: null },
  ];
  check('同账单：账单回答与页面说明均可见', visibleMessages(state).map((m) => m.id).join(',') === 'old,page');
  state.bill = { ...state.bill, contextId: 'qa-bill-2' };
  check('账单变化：旧账单回答隐藏，页面说明保留', visibleMessages(state).map((m) => m.id).join(',') === 'page');
  state.assistant.qaMessages.push({ id: 'new', role: 'assistant', text: '新账单回答', billContextId: 'qa-bill-2' });
  check('新账单：新回答可见', visibleMessages(state).map((m) => m.id).join(',') === 'page,new');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
