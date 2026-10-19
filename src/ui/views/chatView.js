// 分析问答（离线演示）：输入、提示词、离线降级回复（百炼未接入；不基于账单生成结论）
import { el } from '../components.js';
import * as demo from '../../demo/adapter.js';

const PROMPTS = ['哪一笔最值得复核？', '为什么说我追高？', '我该怎么改？', '我是谁？'];

export function renderChat(root, ctx) {
  const { state, set } = ctx;
  const wrap = el('div', { class: 'stack' });

  wrap.append(el('div', { class: 'section-title ch-title' }, ['分析问答（离线演示）']));
  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['当前仅演示界面交互，不基于你的账单生成结论。']),
    '百炼未接入（离线降级模式）：无法执行意图分类与事实复述；以下回答为离线占位，不引用事实 JSON。需要查看结论请到「报告 · 证据」页。',
  ]));

  const msgs = el('div', { class: 'chat' });
  if (!state.chat.messages.length) {
    msgs.append(el('div', { class: 'msg assistant' }, ['你好，这里是分析问答的离线演示。模型接入后，回答会基于报告的事实 JSON 复述；现在可以先试试下面的提问方式，或到「报告 · 证据」页查看演示数据。']));
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
  for (const q of PROMPTS) {
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
