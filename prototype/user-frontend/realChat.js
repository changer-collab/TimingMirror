// 真实账单事实问答：复用既有 chatOnline/restate 与本地数字校验；不使用原型硬编码事实。
import * as demo from '../../src/demo/adapter.js';
import {
  createChatOnline,
  chatFailureText,
  numberCheckDetail,
  CHAT_ONLINE_FALLBACK_TEXT,
} from '../../src/agent/chatOnline.js';
import { isSupportedChatQuestion } from '../../src/agent/chatScope.js';

const PROMPT = '组合整体表现如何？';
let client = null;
let seq = 0;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function onlineClient() {
  if (!client) client = createChatOnline();
  return client;
}

function sourceLine(bill) {
  return bill?.status === 'confirmed' && bill?.sourceType === 'local'
    ? `数据来源：已确认本地账单 · ${bill.fileName || '（未知文件）'}（本机读取）。`
    : '当前没有已确认的本地账单。';
}

function messageHTML(message) {
  if (message.role === 'user') {
    return `<div class="msg msg-user"><span class="msg-avatar" aria-hidden="true">你</span><div class="msg-body"><div class="msg-meta"><strong>你</strong></div><div class="bubble user"><p>${esc(message.text)}</p></div></div></div>`;
  }
  return `<div class="msg msg-bot"><span class="msg-avatar" aria-hidden="true">镜</span><div class="msg-body"><div class="msg-meta"><strong>镜子</strong><span class="sample-tag tiny">${message.online ? '在线复述' : '本地边界'}</span></div><div class="bubble bot"><p>${esc(message.text)}</p>${message.detail ? `<details class="fine"><summary>技术详情（错误码与数字核对）</summary><p>${esc(message.detail)}</p></details>` : ''}${message.tag ? `<span class="status-tag ${message.tone === 'ok' ? 'ok' : ''}">${esc(message.tag)}</span>` : ''}</div></div></div>`;
}

function failureMessage(code, detail = '') {
  return {
    role: 'assistant',
    text: CHAT_ONLINE_FALLBACK_TEXT,
    tag: '在线复述已兜底',
    tone: 'warn',
    detail: [`原因：${chatFailureText(code)}（${String(code)}）`, detail].filter(Boolean).join('；'),
  };
}

function localGateMessage(text) {
  return {
    role: 'assistant',
    text: '当前仅支持“组合整体表现”的四项结果（实际收益、对照收益、择时损耗、损耗金额）。本次问题未发送。',
    tag: '本地范围拦截',
    tone: 'warn',
    detail: 'W_CHAT_SCOPE_LOCAL',
  };
}

function factsPanel(state) {
  const bill = state.bill ?? {};
  const versions = Array.isArray(state.contracts?.versions) ? state.contracts.versions.length : 0;
  return `<aside class="facts-panel" aria-labelledby="real-facts-title">
    <div class="facts-head"><span id="real-facts-title">REAL BILL / 事实来源</span><span class="sample-tag tiny">真实账单</span></div>
    <dl class="facts">
      <div><dt>账单</dt><dd>${esc(bill.fileName || '已确认本地账单')}</dd></div>
      <div><dt>范围</dt><dd>组合整体 · 四项结果</dd></div>
      <div><dt>规则版本</dt><dd>${versions}</dd></div>
      <div><dt>在线复述</dt><dd>点击问题时才请求</dd></div>
    </dl>
    <div class="facts-note">
      <strong>边界：</strong>
      <ul><li>只复述已复核事实</li><li>数字在本机再校验</li><li>不预测、不荐股、不替你决定</li></ul>
    </div>
    <p class="fine">${esc(sourceLine(bill))} 原始 CSV 不上传；问题文本会发送。</p>
  </aside>`;
}

export function renderRealChat(host, ctx) {
  if (!host) return;
  const { state, set } = ctx;
  const messages = Array.isArray(state.chat.messages) ? state.chat.messages : [];
  const pending = state.chat.pending === true;
  const log = messages.map(messageHTML).join('') + (pending
    ? '<div class="msg msg-bot"><span class="msg-avatar" aria-hidden="true">镜</span><div class="msg-body"><div class="bubble bot"><div class="chat-typing" aria-label="正在请求复述"><i></i><i></i><i></i></div></div></div></div>'
    : '');
  host.innerHTML = `<div class="container page-body">
    <div class="chat-layout">
      <section class="panel chat-panel" aria-labelledby="real-chat-title">
        <div class="chat-head"><div class="chat-identity"><span class="mirror-avatar" aria-hidden="true">镜</span><div><strong id="real-chat-title">择时镜子 · 事实问答</strong><span>ONLY FACTS / 只复述当前账单事实</span></div></div><div class="chat-tools"><span class="sample-tag">已确认账单</span><button class="chat-clear" id="real-clear-chat" type="button">清空对话</button></div></div>
        <div class="chat-log" id="real-chat-log" aria-live="polite">
          <div class="msg msg-bot"><span class="msg-avatar" aria-hidden="true">镜</span><div class="msg-body"><div class="msg-meta"><strong>镜子</strong><span>WELCOME</span></div><div class="bubble bot"><p>我已连接到当前已确认账单。这里只复述组合整体的四项已复核结果。</p><p>支持的问题：实际收益、对照收益、择时损耗、损耗金额。</p></div></div></div>
          ${log}
        </div>
        <div class="chat-suggest" aria-label="可以问的问题"><button type="button" data-real-question="${esc(PROMPT)}" class="is-online" ${pending ? 'disabled' : ''}>${esc(PROMPT)}</button></div>
        <form class="composer" id="real-chat-form">
          <label class="sr-only" for="real-chat-input">输入你的问题</label>
          <textarea id="real-chat-input" rows="1" maxlength="120" placeholder="问一个关于组合整体表现的问题…" ${pending ? 'disabled' : ''}></textarea>
          <button class="btn btn-primary" type="submit" ${pending ? 'disabled' : ''}>发送 <span class="arrow">→</span></button>
        </form>
        <p class="fine">只有你发送支持的问题时才请求站点复述；不支持的问答在本地拦截。回答中的数字会再经本机校验，失败即回退固定说明。</p>
      </section>
      ${factsPanel(state)}
    </div>
  </div>`;

  const form = host.querySelector('#real-chat-form');
  const input = host.querySelector('#real-chat-input');
  const prompt = host.querySelector('[data-real-question]');
  const clear = host.querySelector('#real-clear-chat');
  const logEl = host.querySelector('#real-chat-log');
  if (logEl) requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });

  async function send(raw) {
    const question = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!question || state.chat.pending) return;
    const contextId = state.bill.contextId ?? null;
    const requestId = `real-chat-${++seq}`;
    const isCurrent = () => state.chat.requestId === requestId && state.bill.contextId === contextId;
    if (!isSupportedChatQuestion(question)) {
      set({
        chat: {
          ...state.chat,
          contextId,
          messages: [...state.chat.messages, { role: 'user', text: question }, localGateMessage(question)],
          pending: false,
          requestId: null,
        },
      });
      return;
    }
    set({
      chat: {
        ...state.chat,
        contextId,
        requestId,
        pending: true,
        messages: [...state.chat.messages, { role: 'user', text: question }],
      },
    });
    let reply;
    try {
      const source = await demo.loadChatReview(state.bill);
      if (!isCurrent()) return;
      if (!source.ok) {
        reply = failureMessage(source.code, source.message);
      } else {
        const result = await onlineClient().ask({ question, review: source.review });
        if (!isCurrent()) return;
        reply = result.ok
          ? {
            role: 'assistant',
            text: result.text,
            tag: '本地数字校验通过',
            tone: 'ok',
            online: true,
            detail: `${numberCheckDetail(result.number_check)}；仅表示可识别数字子集检查通过，不代表事实含义正确。`,
          }
          : failureMessage(result.code, numberCheckDetail(result.number_check));
      }
    } catch {
      if (!isCurrent()) return;
      reply = failureMessage('E_CHAT_UNEXPECTED');
    }
    if (!isCurrent()) return;
    set({
      chat: {
        ...state.chat,
        pending: false,
        requestId: null,
        messages: [...state.chat.messages, reply],
      },
    });
  }

  if (form && input) {
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
  }
  if (prompt) prompt.addEventListener('click', () => send(PROMPT));
  if (clear) {
    clear.addEventListener('click', () => {
      set({ chat: { ...state.chat, messages: [], pending: false, requestId: null, contextId: null } });
    });
  }
}
