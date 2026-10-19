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
function onlineClient() {
  if (!client) client = createChatOnline();
  return client;
}

function successMessage(result) {
  return {
    role: 'assistant',
    text: result.text,
    tag: '在线复述 · 本地数字校验通过',
    tone: 'ok',
    detail: `${numberCheckDetail(result.number_check)}；仅表示可识别数字子集检查通过，不代表事实含义正确。`,
  };
}

function fallbackMessage(code, detail = '') {
  return {
    role: 'assistant',
    text: CHAT_ONLINE_FALLBACK_TEXT,
    tag: '在线复述未通过 · 已兜底',
    tone: 'warn',
    detail: [`原因：${chatFailureText(code)}（${String(code)}）`, detail].filter(Boolean).join('；'),
  };
}

function sourceLine(bill) {
  if (bill.status === 'confirmed' && bill.sourceType === 'local') {
    return `数据来源：已确认本地账单 · ${bill.fileName || '（未知文件）'}（原文件未上传；复述只发送组合四事实的已确认字段）。`;
  }
  return '数据来源：当前没有已确认的本地账单（演示账单未经复核）；在线复述不可用，发送后会显示固定兜底原因。';
}

export function renderChat(root, ctx) {
  const { state, set } = ctx;
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { class: 'section-title ch-title' }, ['分析问答（组合四事实复述）']));
  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['当前仅接入「组合整体表现」的在线复述（loss_overview · portfolio 四事实）。']),
    '回答只有通过本地可识别数字校验后才展示；失败时显示固定兜底，不展示模型原文或候选数字。本轮为 fake 链路验证：未真实调用百炼；站点函数未发布/未激活时请求会失败并走兜底。',
  ]));
  wrap.append(el('div', { class: 'muted small' }, [sourceLine(state.bill)]));

  const msgs = el('div', { class: 'chat' });
  if (!state.chat.messages.length) {
    msgs.append(el('div', { class: 'msg assistant' }, ['这里只复述已复核的组合四事实（实际收益、对照收益、择时损耗、损耗金额）。请先在导入页确认本地账单，再到报告页完成复核；之后可以问「组合整体表现如何？」。']));
  }
  for (const m of state.chat.messages) {
    msgs.append(el('div', { class: `msg ${m.role === 'user' ? 'user' : 'assistant'}`.trim() }, [
      el('div', { class: 'msg-text' }, [m.text]),
      m.detail ? el('div', { class: 'muted small' }, [m.detail]) : null,
      m.tag ? el('span', { class: `chip ${m.tone === 'ok' ? 'ok' : 'warn'}`.trim() }, [m.tag]) : null,
    ]));
  }
  if (state.chat.pending) {
    msgs.append(el('div', { class: 'msg assistant' }, [
      el('div', { class: 'msg-text' }, ['正在请求在线复述并做本地数字校验…']),
      el('span', { class: 'chip' }, ['处理中']),
    ]));
  }
  wrap.append(msgs);

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || state.chat.pending) return;
    set({
      chat: {
        draft: '',
        pending: true,
        messages: [...state.chat.messages, { role: 'user', text: q }],
      },
    });
    let reply;
    try {
      const source = await demo.loadChatReview(state.bill);
      if (!source.ok) {
        reply = fallbackMessage(source.code, source.message);
      } else {
        const result = await onlineClient().ask({ question: q, review: source.review });
        reply = result.ok
          ? successMessage(result)
          : fallbackMessage(result.code, numberCheckDetail(result.number_check));
      }
    } catch {
      reply = fallbackMessage(CHAT_ONLINE_CODES.UNEXPECTED);
    }
    set({ chat: { pending: false, messages: [...state.chat.messages, reply] } });
  }

  const chips = el('div', { class: 'row' });
  for (const q of PROMPTS) {
    chips.append(el('button', {
      class: 'btn small',
      disabled: state.chat.pending ? 'disabled' : null,
      onclick: () => send(q),
    }, [q]));
  }
  wrap.append(chips);

  const row = el('div', { class: 'row' });
  const input = el('input', {
    class: 'input',
    placeholder: '输入关于组合整体表现的问题（仅支持 loss_overview · portfolio）',
    value: state.chat.draft,
    disabled: state.chat.pending ? 'disabled' : null,
  });
  input.addEventListener('input', () => { state.chat.draft = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(input.value); });
  row.append(input, el('button', {
    class: 'btn primary',
    disabled: state.chat.pending ? 'disabled' : null,
    onclick: () => send(input.value),
  }, ['发送']));
  wrap.append(row);

  root.append(wrap);
}
