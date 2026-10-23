#!/usr/bin/env node
/**
 * 全局助手页面帮助 —— 离线单测（fake state/deps；不调用真实模型或行情）
 *
 * 覆盖：只做页面说明/操作/隐私/可见状态；无账单芯片、无在线复述、无画像；
 *       问答页无助手输入；未知问题只给交接；帮助消息不写入复盘账本。
 * 运行：node tests/agent/qa-assistant.test.mjs
 */
import { defaultAssistant, defaultChat } from '../../src/state.js';
import {
  pageHelpInfo,
  sendHelpText,
  visibleHelpMessages,
} from '../../src/ui/qaAssistant.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BILL = {
  status: 'confirmed',
  sourceType: 'local',
  blocked: false,
  contextId: 'help-bill-1',
  trades: [{ trade_id: 'T1', side: 'buy' }],
};
const BUNDLE = {
  status: 'ok',
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

function makeState(route = 'report', bill = BILL) {
  return {
    route,
    bill,
    report: { symbol: 'pool' },
    chat: defaultChat(bill?.contextId ?? null),
    assistant: defaultAssistant(),
  };
}

function makeCtx(state, deps = {}) {
  const ctx = {
    state,
    qaDeps: {
      getReportBundle: () => BUNDLE,
      loadReportBundle: async () => { throw new Error('助手不应加载报告'); },
      askQuestion: async () => { throw new Error('助手不应调用问答'); },
      extractProfileFacts: async () => { throw new Error('助手不应抽取画像'); },
      saveProfileFacts: async () => { throw new Error('助手不应保存画像'); },
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

/* ==== 页面帮助信息 ==== */
{
  const state = makeState('report');
  const info = pageHelpInfo(state, makeCtx(state).qaDeps);
  check('报告页：没有账单芯片，只有帮助主题', Array.isArray(info.topics) && info.topics.length > 0
    && info.topics.every((item) => item.answer && !item.chip), JSON.stringify(info.topics));
  check('报告页：显示当前可见四事实，使用同一份已缓存报告', info.status?.lines.some((line) => line.includes('+3.7%'))
    && info.status?.lines.some((line) => line.includes('¥100.00'))
    && info.canHandoff === true && info.showInput === true, JSON.stringify(info.status));
  check('报告页：不出现内部接口名、trace、请求计数', !JSON.stringify(info).match(/trace|evidence_ref|L2|intent_code|request_id/i), JSON.stringify(info));

  const chat = makeState('chat');
  const chatInfo = pageHelpInfo(chat, makeCtx(chat).qaDeps);
  check('问答页：助手不显示输入框，只给页面帮助/FAQ', chatInfo.showInput === false
    && chatInfo.topics.some((item) => item.id === 'chat-profile')
    && chatInfo.canHandoff === false, JSON.stringify(chatInfo));

  const single = makeState('report');
  single.report = { symbol: '600519' };
  const singleBundle = {
    ...BUNDLE,
    review: {
      ...BUNDLE.review,
      published_facts: [
        ...BUNDLE.review.published_facts,
        { scope: '600519', key: 'actualRet', display: '-7.3%' },
        { scope: '600519', key: 'ghostRet', display: '-8.1%' },
      ],
    },
  };
  const singleCtx = makeCtx(single);
  singleCtx.qaDeps.getReportBundle = () => singleBundle;
  const singleInfo = pageHelpInfo(single, singleCtx.qaDeps);
  check('报告页单标的：显示当前标的已发布数字，并说明是单标的视图', singleInfo.status?.lines.some((line) => line.includes('-7.3%'))
    && singleInfo.status?.lines.some((line) => line.includes('单标的视图')), JSON.stringify(singleInfo.status));

  const partialBundle = {
    ...singleBundle,
    review: { ...singleBundle.review, portfolio_published: false },
  };
  const partialCtx = makeCtx(single);
  partialCtx.qaDeps.getReportBundle = () => partialBundle;
  const partialInfo = pageHelpInfo(single, partialCtx.qaDeps);
  check('报告页单标的·部分发布：只解释该标的已发布数字，不生成组合结论、不提供深问交接',
    partialInfo.status?.lines.some((line) => line.includes('-7.3%'))
    && partialInfo.status?.lines.some((line) => line.includes('组合结果尚未发布'))
    && !(partialInfo.status?.actions ?? []).some((action) => action.handoffQuestion)
    && partialInfo.canHandoff === false && partialInfo.reportBlocked === true,
    JSON.stringify({ status: partialInfo.status, canHandoff: partialInfo.canHandoff, reportBlocked: partialInfo.reportBlocked }));

  const importState = makeState('import', { ...BILL, status: 'loaded', contextId: 'help-bill-1' });
  const importInfo = pageHelpInfo(importState, makeCtx(importState).qaDeps);
  check('导入页：帮助说明与待确认状态，不展示账单芯片', importInfo.topics.some((item) => item.id === 'import-privacy')
    && importInfo.status?.lines.join('|').includes('尚未确认')
    && importInfo.topics.every((item) => !item.chip), JSON.stringify(importInfo));
}

/* ==== 未知问题：只给交接，不发送、不画像 ==== */
{
  const state = makeState('report');
  const ctx = makeCtx(state);
  let loads = 0;
  let asks = 0;
  let extracts = 0;
  ctx.qaDeps.loadReportBundle = async () => { loads += 1; return BUNDLE; };
  ctx.qaDeps.askQuestion = async () => { asks += 1; return null; };
  ctx.qaDeps.extractProfileFacts = async () => { extracts += 1; return null; };
  sendHelpText(ctx, '我最错的一笔是哪个？');
  const last = state.assistant.qaMessages.at(-1);
  check('未知深度问题：本地说明 + 交接，不加载/不调用问答/不画像', loads === 0 && asks === 0 && extracts === 0
    && last?.kind === 'help' && last.handoff?.question === '我最错的一笔是哪个？'
    && last.billContextId === 'help-bill-1', JSON.stringify({ loads, asks, extracts, last }));
  check('交接不写入复盘账本', state.chat.messages.length === 0, JSON.stringify(state.chat));

  sendHelpText(ctx, '这个页面怎么用？');
  const pageLast = state.assistant.qaMessages.at(-1);
  check('页面帮助未知问题：本地说明，不交接、不发送', pageLast?.kind === 'help'
    && !pageLast.handoff && pageLast.text.includes('页面帮助问题')
    && loads === 0 && asks === 0 && extracts === 0,
  JSON.stringify({ last: pageLast, loads, asks, extracts }));
}

/* ==== 页面 FAQ 命中：本地回答 ==== */
{
  const state = makeState('import', { ...BILL, status: 'loaded' });
  const ctx = makeCtx(state);
  let asks = 0;
  ctx.qaDeps.askQuestion = async () => { asks += 1; return null; };
  sendHelpText(ctx, '原始 CSV 会上传吗？');
  const last = state.assistant.qaMessages.at(-1);
  check('FAQ：本地回答、零问答调用', asks === 0 && last?.kind === 'help'
    && last.text.includes('不会') && !last.handoff, JSON.stringify(last));
  check('FAQ 消息按账单上下文可见', visibleHelpMessages(state).length === 2
    && visibleHelpMessages({ ...state, bill: { ...state.bill, contextId: 'other' } }).length === 0,
    JSON.stringify(visibleHelpMessages(state)));
}

/* ==== 未确认账单：未知问题给导入引导，不给交接 ==== */
{
  const state = makeState('import', { ...BILL, status: 'none', contextId: null, trades: [] });
  const ctx = makeCtx(state);
  sendHelpText(ctx, '帮我看看明天哪只会涨？');
  const last = state.assistant.qaMessages.at(-1);
  check('未确认账单：不交接，提示先导入确认', last?.kind === 'help'
    && !last.handoff && last.link?.href === '#/import', JSON.stringify(last));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
