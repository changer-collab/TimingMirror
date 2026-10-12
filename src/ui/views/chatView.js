// 对话：输入、芯片、离线降级回复（百炼未接入）
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';

export function renderChat(root, ctx) {
  const { state, set } = ctx;
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['百炼未接入（离线降级模式）']),
    '无法执行意图分类与事实复述；以下回答为离线占位，不引用事实 JSON（计算引擎未接入）。',
  ]));

  const msgs = el('div', { class: 'chat' });
  if (!state.chat.messages.length) {
    msgs.append(el('div', { class: 'msg assistant' }, ['你好，我是镜子（开发骨架 · 离线模式）。计算与模型接入后，我会基于你的事实 JSON 回答问题；当前可以先到「报告 · 证据」页看演示数据。']));
  }
  for (const m of state.chat.messages) {
    msgs.append(el('div', { class: `msg ${m.role === 'user' ? 'user' : 'assistant'}`.trim() }, [
      el('div', { class: 'msg-text' }, [m.text]),
      m.tag ? el('span', { class: 'chip warn' }, [m.tag]) : null,
    ]));
  }
  wrap.append(msgs);

  function send(text) {
    const q = String(text || '').trim();
    if (!q) return;
    const reply = demo.offlineChatReply(q);
    set({
      chat: {
        draft: '',
        messages: [
          ...state.chat.messages,
          { role: 'user', text: q },
          { role: 'assistant', text: reply.text, tag: '离线模式（百炼未接入）' },
        ],
      },
    });
  }

  const chips = el('div', { class: 'row' });
  for (const q of ['我最错的一笔是哪个？', '为什么说我追高？', '我该怎么改？', '我是谁？']) {
    chips.append(el('button', { class: 'btn small', onclick: () => send(q) }, [q]));
  }
  wrap.append(chips);

  const row = el('div', { class: 'row' });
  const input = el('input', { class: 'input', placeholder: '输入你的问题（演示：离线回复）', value: state.chat.draft });
  input.addEventListener('input', () => { state.chat.draft = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(input.value); });
  row.append(input, el('button', { class: 'btn primary', onclick: () => send(input.value) }, ['发送']));
  wrap.append(row);

  root.append(wrap);
}
