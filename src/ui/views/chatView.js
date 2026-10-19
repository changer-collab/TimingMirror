// 分析问答：组合四事实在线复述（站点同源边界；百炼未真实调用）
// 仅接入 loss_overview + portfolio 四事实路径；回答通过本地数字检查后才展示，失败显示固定兜底。
// 页面只调 adapter 取 review；事实投影、在线边界与数字检查由 src/agent/chatOnline.js 编排。
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';
import {
  createChatOnline,
  chatFailureText,
  numberCheckDetail,
  CHAT_ONLINE_FALLBACK_TEXT,
  CHAT_ONLINE_CODES,
} from '../../agent/chatOnline.js';

const PROMPTS = ['组合整体表现如何？'];

let client = null;
let requestSeq = 0;
function onlineClient() {
  if (!client) client = createChatOnline();
  return client;
}

function nextRequestId() {
  requestSeq += 1;
  return `chat-req-${requestSeq}`;
}

const contextKey = (id) => (id === null || id === undefined ? null : id);

function inBillContext(state) {
  return contextKey(state.chat.contextId) === contextKey(state.bill.contextId);
}

function successMessage(result) {
  return {
    role: 'assistant',
    text: result.text,
    tag: '本地数字校验通过',
    tone: 'ok',
    detail: `${numberCheckDetail(result.number_check)}；仅表示可识别数字子集检查通过，不代表事实含义正确。`,
  };
}

// 失败时保留可执行下一步；具体错误码只放进消息内折叠详情
function nextStepText(code) {
  const c = String(code || '');
  if (c === 'W_CHAT_BILL_NOT_CONFIRMED' || c === 'W_CHAT_REVIEW_UNAVAILABLE') {
    return '请先在导入页确认本地账单，并在报告页确认组合结果已发布。';
  }
  if (c.includes('NUMBERS_FAILED')) return '请换一种问法，或到「报告 · 证据」页核对已发布数字后重试。';
  if (c.includes('HTTP') || c.includes('TRANSPORT') || c.includes('MODEL')) return '请稍后重试；若持续失败，说明在线服务当前不可用。';
  return '可在「报告 · 证据」页核对已复核结论后重试。';
}

const EXTRA_FAILURE_TEXT = Object.freeze({
  W_CHAT_BILL_NOT_CONFIRMED: '当前没有已确认的本地账单，无法在线复述',
  W_CHAT_REVIEW_UNAVAILABLE: '账单复核结果不可用，无法在线复述',
});

function failureReasonText(code) {
  if (EXTRA_FAILURE_TEXT[code]) return EXTRA_FAILURE_TEXT[code];
  const text = chatFailureText(code);
  return String(code) && text.includes(String(code)) ? '在线复述未通过' : text;
}

function fallbackMessage(code, detail = '') {
  return {
    role: 'assistant',
    text: CHAT_ONLINE_FALLBACK_TEXT,
    tag: '在线复述已兜底',
    tone: 'warn',
    reason: failureReasonText(code),
    next: nextStepText(code),
    detail: [`原因：${chatFailureText(code)}（${String(code)}）`, detail].filter(Boolean).join('；'),
  };
}

function sourceLine(bill) {
  if (bill.status === 'confirmed' && bill.sourceType === 'local') {
    return `数据来源：已确认本地账单 · ${bill.fileName || '（未知文件）'}（本机读取）。`;
  }
  return '数据来源：当前没有已确认的本地账单（演示账单未经复核）；在线复述不可用，发送后会显示兜底原因。';
}

export function renderChat(root, ctx) {
  const { state, set } = ctx;
  const wrap = el('div', { class: 'stack' });
  const inContext = inBillContext(state);
  const messages = inContext ? state.chat.messages : [];
  const pending = inContext && state.chat.pending === true;

  wrap.append(el('div', { class: 'section-title ch-title' }, ['分析问答']));
  wrap.append(el('div', { class: 'banner chat-banner' }, [
    el('strong', {}, ['当前仅支持组合整体表现。']),
    '可复述实际收益、对照收益、择时损耗和损耗金额。在线复述尚未完成真实服务验证；回答会经过本地数字校验，但校验通过不代表事实含义已核实。失败时只显示固定兜底，不展示模型原文或候选数字。',
  ]));
  wrap.append(el('details', { class: 'chat-tech' }, [
    el('summary', {}, ['技术说明']),
    el('div', { class: 'muted small' }, [
      '内部范围：loss_overview · portfolio。失败时返回的错误码与数字核对明细，只在消息内技术详情中展示。',
    ]),
  ]));
  wrap.append(el('div', { class: 'muted small' }, [sourceLine(state.bill)]));
  wrap.append(el('div', { class: 'muted small' }, [
    '发送边界：原始 CSV 不上传；系统仅从账单中选取最小化的已确认事实。你输入的问题文本也会发送，请勿在问题中粘贴账户信息或成交明细。',
  ]));

  const msgs = el('div', { class: 'chat' });
  if (!messages.length) {
    msgs.append(el('div', { class: 'msg assistant' }, ['这里只复述已复核的组合整体结果：实际收益、对照收益、择时损耗和损耗金额。请先在导入页确认本地账单，再到报告页确认组合结果已发布。']));
  }
  for (const m of messages) {
    const box = el('div', { class: `msg ${m.role === 'user' ? 'user' : 'assistant'}`.trim() }, [
      el('div', { class: 'msg-text' }, [m.text]),
      m.reason ? el('div', { class: 'msg-reason' }, [`原因：${m.reason}`]) : null,
      m.next ? el('div', { class: 'msg-next' }, [`下一步：${m.next}`]) : null,
      m.detail ? el('details', { class: 'msg-tech' }, [
        el('summary', {}, ['技术详情（错误码与数字核对）']),
        el('div', { class: 'muted small' }, [m.detail]),
      ]) : null,
      m.tag ? el('span', { class: `chip ${m.tone === 'ok' ? 'ok' : 'warn'}`.trim() }, [m.tag]) : null,
    ]);
    msgs.append(box);
  }
  if (pending) {
    msgs.append(el('div', { class: 'msg assistant' }, [
      el('div', { class: 'msg-text' }, ['正在请求在线复述并做本地数字校验…']),
    ]));
  }
  wrap.append(msgs);

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || !inBillContext(state) || state.chat.pending) return;
    const contextId = contextKey(state.bill.contextId);
    const requestId = nextRequestId();
    const isCurrent = () => contextKey(state.bill.contextId) === contextId
      && contextKey(state.chat.contextId) === contextId
      && state.chat.requestId === requestId;
    set({
      chat: {
        contextId,
        requestId,
        draft: '',
        pending: true,
        messages: [...state.chat.messages, { role: 'user', text: q }],
      },
    });
    let reply;
    try {
      const source = await demo.loadChatReview(state.bill);
      if (!isCurrent()) return;
      if (!source.ok) {
        reply = fallbackMessage(source.code, source.message);
      } else {
        const result = await onlineClient().ask({ question: q, review: source.review });
        if (!isCurrent()) return;
        reply = result.ok
          ? successMessage(result)
          : fallbackMessage(result.code, numberCheckDetail(result.number_check));
      }
    } catch {
      if (!isCurrent()) return;
      reply = fallbackMessage(CHAT_ONLINE_CODES.UNEXPECTED);
    }
    if (!isCurrent()) return;
    set({ chat: { pending: false, requestId: null, messages: [...state.chat.messages, reply] } });
  }

  const chips = el('div', { class: 'row' });
  for (const q of PROMPTS) {
    chips.append(el('button', {
      class: 'btn small',
      disabled: pending ? 'disabled' : null,
      onclick: () => send(q),
    }, [q]));
  }
  wrap.append(chips);

  const row = el('div', { class: 'row' });
  const input = el('input', {
    class: 'input',
    placeholder: '输入关于组合整体表现的问题（当前仅支持这一范围）',
    value: state.chat.draft,
    disabled: pending ? 'disabled' : null,
  });
  input.addEventListener('input', () => { state.chat.draft = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(input.value); });
  row.append(input, el('button', {
    class: 'btn primary',
    disabled: pending ? 'disabled' : null,
    onclick: () => send(input.value),
  }, ['发送']));
  wrap.append(row);

  root.append(wrap);
}
