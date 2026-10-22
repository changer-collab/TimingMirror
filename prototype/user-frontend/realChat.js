// 独立问答页「对话账本」：问题 → 意图 → 最小事实包 → 本地/在线回答 → 证据。
// 只渲染 qaAnswer 信封；数字只来自当前账单已发布报告，在线失败回退本地事实。
// 无网络/DOM 之外的副作用：发送与规则打开由 ctx.qaDeps 注入。
import { QA_SUGGESTIONS, normalizeQuestion, QA_INTENT_LABELS, QA_LAYER_LABELS } from './qaIntent.js';
import { ruleStateKeyOf } from '../../src/agent/qaChips.js';

const STATUS_LABELS = Object.freeze({
  local: '已校验',
  online: '在线复述 · 已校验',
  clarify: '待澄清',
  refusal: '边界拦截',
  registration: '登记式应答',
  unavailable: '未接入',
  error: '未回答',
  pending: '处理中',
});

const STATUS_TITLES = Object.freeze({
  local: '本地已复核事实',
  online: '在线复述，数字已本地校验',
  clarify: '需要补充指代',
  refusal: '边界拦截',
  registration: '不替你决定',
  unavailable: '未给出结论',
  error: '未回答',
  pending: '正在核对',
});

const BOUNDARY_STATES = new Set(['refusal', 'registration', 'unavailable']);

let seq = 0;
let draft = '';
let draftContextId = null;
let lastScrollKey = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function intentLabelOf(intent) {
  return QA_INTENT_LABELS[intent] ?? '事实问答';
}

function statusOf(answer) {
  return answer?.status ?? 'error';
}

function badgeOf(status) {
  return STATUS_LABELS[status] ?? '未回答';
}

function questionText(raw) {
  return String(raw ?? '').replace(/\u3000/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 200);
}

function pairEntries(messages) {
  const entries = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      const next = messages[i + 1];
      if (next?.role === 'assistant' && next.answer) {
        entries.push({ id: next.id ?? message.id, question: message.text, answer: next.answer, message: next });
        i += 1;
      } else {
        entries.push({ id: message.id, question: message.text, answer: null, message: null });
      }
    } else if (message?.role === 'assistant' && message.answer) {
      entries.push({ id: message.id, question: '', answer: message.answer, message });
    }
  }
  return entries;
}

function factsHTML(facts) {
  const list = Array.isArray(facts) ? facts.slice(0, 4) : [];
  if (!list.length) return '';
  return `<div class="tm-qa-facts" data-role="qa-facts">${list.map((fact) => `
    <div class="tm-qa-fact${fact.tone === 'loss' ? ' is-loss' : fact.tone === 'ok' ? ' is-ok' : ''}">
      <span>${esc(fact.label)}</span>
      <strong>${esc(fact.value)}</strong>
    </div>`).join('')}</div>`;
}

function evidenceHTML(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return '';
  const first = list[0]?.label ?? '公式与回源';
  return `<details class="tm-qa-evidence" data-role="qa-evidence">
    <summary>证据 ${list.length} · ${esc(first)}</summary>
    <dl class="tm-qa-evidence-list">${list.map((item) => `
      <div><dt>${esc(item.label)}</dt><dd>${esc(item.detail)}</dd></div>`).join('')}</dl>
  </details>`;
}

function actionsHTML(answer, message, actionMap, currentRuleKey) {
  const actions = Array.isArray(answer.actions) ? answer.actions : [];
  const names = new Set(actions.map((a) => a.id));
  let stale = false;
  const buttons = [];
  for (const action of actions) {
    if (action.kind === 'candidate') {
      const key = message?.rule_state_key;
      if (typeof key === 'string' && key !== currentRuleKey) { stale = true; continue; }
    }
    const actionKey = `${message?.id ?? 'entry'}:${action.id}`;
    actionMap.set(actionKey, action);
    buttons.push(`<button type="button" class="tm-qa-action${action.kind === 'candidate' ? ' is-primary' : ''}" data-action="${esc(action.kind)}" data-action-key="${esc(actionKey)}">${esc(action.label)}</button>`);
  }
  const staleNote = stale && names.size
    ? '<p class="tm-qa-stale">规则状态已变化，原候选已失效；上方账单事实仍然有效。</p>'
    : '';
  if (!buttons.length) return staleNote;
  return `<div class="tm-qa-actions">${buttons.join('')}</div>${staleNote}`;
}

function traceHTML(answer) {
  const trace = answer.trace ?? {};
  const rows = [];
  if (trace.intent_code) rows.push(['意图', trace.intent_code]);
  if (trace.layer_label) rows.push(['路由', trace.layer_label]);
  if (Number.isFinite(trace.elapsed_ms)) rows.push(['耗时', `${trace.elapsed_ms} ms（实测）`]);
  if (answer.route?.layer === 'L2' && Number.isFinite(answer.route?.confidence)) {
    rows.push(['意图置信度', answer.route.confidence.toFixed(2)]);
  }
  if (trace.template_id) rows.push(['模板', trace.template_id]);
  if (trace.plan_id) rows.push(['计划', trace.plan_id]);
  if (trace.number_check) rows.push(['数字校验', trace.number_check]);
  if (!rows.length) return '';
  return `<details class="tm-qa-trace">
    <summary>如何得出</summary>
    <dl class="tm-qa-trace-list">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
  </details>`;
}

function diagnosticsHTML(answer) {
  const diagnostics = Array.isArray(answer.diagnostics) ? answer.diagnostics : [];
  if (answer.status !== 'error' || !diagnostics.length) return '';
  return `<details class="tm-qa-error-detail">
    <summary>技术详情（错误码）</summary>
    <dl>${diagnostics.map((d) => `<div><dt>${esc(d.code)}</dt><dd>${esc(d.message)}</dd></div>`).join('')}</dl>
  </details>`;
}

function answerHTML(entry, actionMap, currentRuleKey) {
  const answer = entry.answer;
  const status = statusOf(answer);
  const intent = answer.intent ?? '';
  const facts = Array.isArray(answer.facts) ? answer.facts : [];
  const routeLayer = answer.route?.layer ?? 'L3';
  const layerLabel = QA_LAYER_LABELS[routeLayer] ?? QA_LAYER_LABELS.L3;
  const boundary = BOUNDARY_STATES.has(status) ? ' is-boundary' : '';
  return `<article class="tm-qa-entry${boundary}" data-role="qa-entry" data-intent="${esc(intent || 'none')}" data-state="${esc(status)}">
    ${entry.question ? `<header class="tm-qa-entry-head">
      <span class="tm-qa-question-label">你问</span>
      <p class="tm-qa-question">${esc(entry.question)}</p>
    </header>` : ''}
    <div class="tm-qa-route">
      <span class="tm-qa-intent">${esc(intentLabelOf(intent))}</span>
      <span class="tm-qa-layer">${esc(layerLabel)}</span>
      <span class="tm-qa-factcount">${facts.length} 条事实</span>
      <span class="tm-qa-badge is-${esc(status)}" title="${esc(STATUS_TITLES[status] ?? '')}">${esc(badgeOf(status))}</span>
    </div>
    <p class="tm-qa-text">${esc(answer.text)}</p>
    ${factsHTML(facts)}
    ${evidenceHTML(answer.evidence)}
    ${actionsHTML(answer, entry.message, actionMap, currentRuleKey)}
    ${answer.notice ? `<p class="tm-qa-notice">${esc(answer.notice)}</p>` : ''}
    ${traceHTML(answer)}
    ${diagnosticsHTML(answer)}
  </article>`;
}

function pendingHTML(question) {
  return `<article class="tm-qa-entry is-pending" data-role="qa-entry" data-intent="pending" data-state="pending" aria-busy="true">
    <header class="tm-qa-entry-head">
      <span class="tm-qa-question-label">你问</span>
      <p class="tm-qa-question">${esc(question)}</p>
    </header>
    <div class="tm-qa-route">
      <span class="tm-qa-intent">正在核对</span>
      <span class="tm-qa-layer">本地</span>
      <span class="tm-qa-badge is-pending">${esc(badgeOf('pending'))}</span>
    </div>
    <p class="tm-qa-text">正在核对这份账单的已复核事实…</p>
  </article>`;
}

function emptyHTML() {
  return '<p class="tm-qa-empty">还没有提问。示例问法只是入口，不是全部。</p>';
}

function headHTML(hasEntries, isDemo) {
  return `<header class="tm-qa-head">
    <div class="tm-qa-head-top">
      <span class="tm-qa-eyebrow">STEP 03 / ASK · 事实问答</span>
      <span class="tm-qa-head-right">${hasEntries ? '<button type="button" class="tm-qa-clear" data-role="qa-clear">清空对话</button>' : ''}<span class="tm-qa-step">04 / QA</span></span>
    </div>
    <h1>问它为什么，<br>别问它买什么。</h1>
    <p class="tm-qa-intro">任何问法都可以。答案只来自这份${isDemo ? '示例' : ''}账单的已复核事实；不荐股、不预测、不替你决定。</p>
  </header>`;
}

function askHTML(pending) {
  return `<form class="tm-qa-ask" data-role="qa-form">
    <label class="sr-only" for="tm-qa-input">输入你的问题</label>
    <div class="tm-qa-ask-row">
      <textarea id="tm-qa-input" data-role="qa-input" rows="2" maxlength="200" placeholder="问这份账单已经发生的事，例如：我最错的一笔是哪个？" ${pending ? 'disabled' : ''}>${esc(draft)}</textarea>
      <button class="tm-qa-send" type="submit" ${pending ? 'disabled' : ''}>发送</button>
    </div>
    <p class="tm-qa-ask-meta">Enter 发送 · Shift+Enter 换行 · 原始 CSV 仅本机</p>
  </form>`;
}

function suggestHTML(pending) {
  return `<div class="tm-qa-suggest" data-role="qa-chips" aria-label="示例问法">${QA_SUGGESTIONS.map((item) => `
    <button type="button" class="tm-qa-chip${item.online ? ' is-online' : ''}" data-role="qa-chip" data-question="${esc(item.question)}" data-online="${item.online ? 'true' : 'false'}" ${pending ? 'disabled' : ''}>${esc(item.label)}</button>`).join('')}</div>`;
}

function failureAnswer({ question, contextId }) {
  return {
    status: 'error',
    intent: null,
    route: { layer: 'L3', confidence: null },
    source: 'local',
    text: '页面链路出现未预期错误，本次没有回答。可以重试；数字与结论都不改变。',
    facts: [],
    evidence: [],
    actions: [{ id: 'qa-retry', label: '重试', kind: 'ask', question }],
    trace: { template_id: null, plan_id: null, fact_count: 0, number_check: null, elapsed_ms: 0, intent_code: 'error', layer_label: '边界' },
    candidate: null,
    notice: null,
    diagnostics: [{ code: 'E_QA_UI_UNEXPECTED', message: '问答页面出现未预期错误' }],
    bill_context_id: contextId,
  };
}

export function renderRealChat(host, ctx) {
  if (!host) return;
  const { state, set } = ctx;
  const contextId = state.bill?.contextId ?? null;
  if (draftContextId !== contextId) { draft = ''; draftContextId = contextId; }
  const allMessages = Array.isArray(state.chat.messages) ? state.chat.messages : [];
  const messages = allMessages.filter((m) => m && (m.bill_context_id ?? null) === contextId);
  const pending = state.chat.pending === true && (state.chat.contextId ?? contextId) === contextId;
  const versions = Array.isArray(state.contracts?.versions) ? state.contracts.versions : [];
  const currentRuleKey = ruleStateKeyOf(versions);
  const entries = pairEntries(messages);
  const actionMap = new Map();
  const lastQuestion = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';
  const isDemo = state.bill?.demo === true;

  const logHTML = entries.length || pending
    ? `${entries.map((entry) => (entry.answer
      ? answerHTML(entry, actionMap, currentRuleKey)
      : pendingHTML(entry.question))).join('')}${pending && !entries.some((e) => !e.answer) ? pendingHTML(lastQuestion) : ''}`
    : emptyHTML();

  host.innerHTML = `<div class="tm-qa-page">
    <div class="tm-qa-inner">
      <div class="tm-qa-scroll" data-role="qa-scroll">
        ${headHTML(entries.length > 0 || pending, isDemo)}
        <div class="tm-qa-log" data-role="qa-ledger" aria-live="polite">${logHTML}</div>
      </div>
      <div class="tm-qa-dock" data-role="qa-dock" aria-label="提问区">
        ${suggestHTML(pending)}
        ${askHTML(pending)}
      </div>
    </div>
  </div>`;

  const form = host.querySelector('[data-role="qa-form"]');
  const input = host.querySelector('[data-role="qa-input"]');
  const scroller = host.querySelector('[data-role="qa-scroll"]');
  const logKey = `${contextId ?? 'none'}:${messages.length}:${pending ? 'pending' : 'idle'}`;
  if (scroller && lastScrollKey !== null && lastScrollKey !== logKey) {
    requestAnimationFrame(() => {
      const top = Number.isFinite(scroller.scrollHeight) ? scroller.scrollHeight : 0;
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top, behavior: 'smooth' });
      } else {
        scroller.scrollTop = top;
      }
    });
  }
  lastScrollKey = logKey;

  async function send(raw, { preferOnline = false } = {}) {
    const question = questionText(raw);
    if (!question || state.chat.pending) return;
    draft = '';
    const bill = state.bill;
    const requestId = `qa-${++seq}`;
    const messageContextId = bill?.contextId ?? null;
    const isCurrent = () => state.chat.requestId === requestId && (state.bill?.contextId ?? null) === messageContextId;
    const userMessage = {
      id: `${requestId}-q`, role: 'user', kind: 'qa-user',
      text: question, bill_context_id: messageContextId,
    };
    set({
      chat: {
        ...state.chat,
        contextId: messageContextId,
        requestId,
        pending: true,
        messages: [...state.chat.messages, userMessage],
      },
    });

    let answer;
    try {
      if (typeof ctx.qaDeps?.askQuestion !== 'function') {
        answer = failureAnswer({ question, contextId: messageContextId });
      } else {
        let ruleState = null;
        try { ruleState = ctx.qaDeps.ruleStateOf?.(versions) ?? null; } catch { ruleState = null; }
        answer = await ctx.qaDeps.askQuestion({ question, bill, ruleState, versions, preferOnline });
      }
    } catch {
      if (!isCurrent()) return;
      answer = failureAnswer({ question, contextId: messageContextId });
    }
    if (!isCurrent()) return;
    const assistantMessage = {
      id: requestId, role: 'assistant', kind: 'qa',
      text: answer?.text ?? '',
      answer,
      bill_context_id: messageContextId,
      rule_state_key: currentRuleKey,
    };
    set({
      chat: {
        ...state.chat,
        pending: false,
        requestId: null,
        messages: [...state.chat.messages, assistantMessage],
      },
    });
  }

  if (form && input) {
    input.addEventListener('input', () => { draft = input.value; });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  host.onclick = (e) => {
    const chip = e.target.closest('[data-role="qa-chip"]');
    if (chip && host.contains(chip)) {
      send(chip.getAttribute('data-question') || '', { preferOnline: chip.getAttribute('data-online') === 'true' });
      return;
    }
    const clear = e.target.closest('[data-role="qa-clear"]');
    if (clear && host.contains(clear)) {
      draft = '';
      lastScrollKey = null;
      set({ chat: { ...state.chat, messages: [], pending: false, requestId: null, contextId } });
      return;
    }
    const button = e.target.closest('[data-action]');
    if (!button || !host.contains(button)) return;
    const action = actionMap.get(button.getAttribute('data-action-key'));
    if (!action) return;
    if (action.kind === 'ask' && action.question) {
      send(action.question);
      return;
    }
    if (action.kind === 'candidate' && action.candidate) {
      ctx.qaDeps.openRuleCandidate(ctx, action.candidate);
      return;
    }
    if (action.kind === 'simulation') {
      ctx.go('me');
      setTimeout(() => { try { ctx.scrollToSimulation?.(); } catch { /* 规则页尚未挂载时忽略 */ } }, 140);
      return;
    }
    if (action.kind === 'navigate' && action.href) {
      ctx.go(String(action.href).replace(/^#\//, ''));
    }
  };
}
