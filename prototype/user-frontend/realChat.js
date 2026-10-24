// 独立问答页「对话账本」：问题 → 意图 → 最小事实包 → 本地/在线回答 → 证据。
// 只渲染 qaAnswer 信封；回答后从用户明确陈述的长期目标/偏好/约束中被动记录画像依据，失败静默。
// 无网络/DOM 之外的副作用：发送、在线复述、画像抽取/保存与规则打开由 ctx 注入。
import {
  QA_SUGGESTIONS,
  QA_INTENT_LABELS,
  routeQuestion,
  isPageHelpQuestion,
  buildPageHelpAnswer,
} from './qaIntent.js';
import { ruleStateKeyOf } from '../../src/agent/qaChips.js';
import { shouldExtractProfileFacts } from '../../src/agent/profileSignals.js';
import { PROFILE_FACT_KIND_LABELS } from '../../src/agent/cloudProfileModel.js';
import { fmtMoney } from '../../src/engine/display.js';

const STATUS_LABELS = Object.freeze({
  local: '本机回答',
  online: '在线复述',
  clarify: '需要补充信息',
  refusal: '本次暂时无法回答',
  registration: '需要你确认',
  unavailable: '本版本暂不支持',
  error: '本次暂时无法回答',
  withheld: '本次未发布',
  pending: '正在核对',
});

const STATUS_TITLES = Object.freeze({
  local: '基于这份账单的本机回答',
  online: '在线复述，数字已在本机核对',
  clarify: '需要补充信息',
  refusal: '超出本版本可回答范围',
  registration: '需要你确认后继续',
  unavailable: '本版本暂不支持',
  error: '本次暂时无法回答',
  withheld: '发布前复核未通过，不展示具体数字',
  pending: '正在核对',
});

const FACT_KIND_LABELS = PROFILE_FACT_KIND_LABELS;

const BOUNDARY_STATES = new Set(['refusal', 'registration', 'unavailable', 'withheld']);

let seq = 0;
let draft = '';
let draftContextId = null;
let lastScrollKey = null;
let handoffNotice = null;
let clearArmed = false;
// 正在生成的运行过程按 requestId 暂存；渲染重建后可从内存恢复，不写入持久状态。
const liveTraces = new Map();
// 延迟改写可能早于消息入列表完成；先暂存补丁，消息落地后再应用。
const queuedRewrites = new Map();

const TRACE_ICONS = Object.freeze({ running: '…', done: '✓', failed: '!', skipped: '–' });

function mergeTraceEvent(events, event) {
  if (!event || typeof event !== 'object') return events;
  const list = Array.isArray(events) ? events.slice() : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.stage !== event.stage) continue;
    if (list[i].status === 'running' && event.status !== 'running') {
      list[i] = event;
      return list;
    }
    break;
  }
  list.push(event);
  return list;
}

function traceItemsHTML(events) {
  return (Array.isArray(events) ? events : []).map((event) => {
    const status = TRACE_ICONS[event.status] ? event.status : 'done';
    return `<li class="tm-qa-trace-step is-${esc(status)}">
      <span class="tm-qa-trace-icon" aria-hidden="true">${esc(TRACE_ICONS[status])}</span>
      <span class="tm-qa-trace-label">${esc(event.label)}</span>
      ${event.detail ? `<span class="tm-qa-trace-detail">${esc(event.detail)}</span>` : ''}
      ${Number.isFinite(event.ms) ? `<span class="tm-qa-trace-ms">${Math.round(event.ms)} ms</span>` : ''}
    </li>`;
  }).join('');
}

function traceHTML(events, { requestId = null, pending = false } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length && !pending) return '';
  const open = pending ? ' open' : '';
  const title = pending
    ? (list.length ? `AI 运行过程 · 进行中 · ${list.length} 步` : 'AI 运行过程 · 准备中')
    : `AI 运行过程 · ${list.length} 步`;
  const hint = pending ? '实时更新 · 回答生成后自动收起' : '默认收起 · 点击展开';
  return `<div class="tm-qa-trace-host" data-role="qa-trace-host"${requestId ? ` data-request-id="${esc(requestId)}"` : ''}>
    <details class="tm-qa-trace" data-role="qa-trace"${open}>
      <summary>
        <span data-role="qa-trace-count">${esc(title)}</span>
        <span class="tm-qa-trace-hint" data-role="qa-trace-hint">${esc(hint)}</span>
      </summary>
      <ol class="tm-qa-trace-steps" data-role="qa-trace-steps">${traceItemsHTML(list)}</ol>
    </details>
  </div>`;
}

/* 页面重渲染会替换 #tm-real-chat，闭包里拿到的旧节点会脱离文档；按 id 重新取当前节点。 */
function resolveTraceHost(host, lookup = (id) => (typeof document === 'undefined' ? null : document.getElementById(id))) {
  if (!host) return null;
  if (host.isConnected !== false) return host;
  return (host.id && typeof lookup === 'function' ? lookup(host.id) : null) ?? host;
}

function patchLiveTrace(host, requestId, events, lookup) {
  if (!host || !requestId) return;
  const root = resolveTraceHost(host, lookup);
  if (!root) return;
  const node = root.querySelector(`[data-role="qa-trace-host"][data-request-id="${requestId}"]`);
  if (!node) return;
  const count = node.querySelector('[data-role="qa-trace-count"]');
  const steps = node.querySelector('[data-role="qa-trace-steps"]');
  if (count) count.textContent = `AI 运行过程 · 进行中 · ${Array.isArray(events) ? events.length : 0} 步`;
  if (steps) {
    steps.innerHTML = traceItemsHTML(events);
    const panel = node.querySelector('[data-role="qa-trace"]');
    if (panel) panel.open = true;
  }
  const scroller = root.querySelector('[data-role="qa-scroll"]');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

// 离开问答页时重置，下一次进入重新播放一次入页滚动。
export function resetChatScroll() {
  lastScrollKey = null;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

const EXTRA_INTENT_LABELS = Object.freeze({ assertion_check: '数字核对' });

function intentLabelOf(intent) {
  return QA_INTENT_LABELS[intent] ?? EXTRA_INTENT_LABELS[intent] ?? '事实问答';
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

function autoFactsHTML(message) {
  const auto = message?.profile_auto;
  if (!auto || auto.state !== 'saved') return '';
  // 只提示“已记录”，不提供手动入口；撤销统一在个人中心。
  return `<p class="tm-qa-notice" data-role="qa-profile-auto">已自动记入画像依据 · ${esc(auto.count)} 条 · 可在<a href="#/me">个人中心</a>撤销</p>`;
}

function savedFactsHTML(answer) {
  const list = Array.isArray(answer?.saved_facts) ? answer.saved_facts.slice(0, 5) : [];
  if (!list.length) return '';
  const total = Number.isFinite(answer?.saved_fact_total) ? answer.saved_fact_total : list.length;
  const more = total > list.length
    ? `<p class="tm-qa-notice">画像依据共 ${esc(total)} 条，这里显示最近 ${list.length} 条。</p>`
    : '';
  return `<section class="tm-qa-savedfacts" data-role="qa-saved-facts">
    <div class="tm-qa-savedfacts-head"><span>画像依据（系统自动记录）</span><a href="#/me">查看 / 撤销</a></div>
    <ul class="tm-qa-profile-list is-saved">${list.map((fact) => `
      <li class="tm-qa-profile-fact">
        <span class="tm-qa-profile-kind">${esc(FACT_KIND_LABELS[fact.kind] ?? '事实')}</span>
        <strong>${esc(fact.value)}</strong>
        ${fact.evidence ? `<span class="tm-qa-profile-evidence">原文：${esc(fact.evidence)}</span>` : ''}
      </li>`).join('')}</ul>
    ${more}
    <p class="tm-qa-notice">只读展示；系统从你明确说出的长期目标、偏好和约束中自动记录，可到个人中心撤销。</p>
  </section>`;
}

function rewriteOf(message, answer) {
  return message?.rewrite ?? answer?.rewrite ?? null;
}

const REWRITE_REASON_HINTS = Object.freeze({
  timeout: 'AI 改写超时，这次先显示本地表述。可以重试。',
  response_invalid: 'AI 改写没有通过数字复核，这次先显示本地表述。可以重试。',
  rate_limited: 'AI 改写当前请求较多，这次先显示本地表述。可以重试。',
  request_invalid: '这次改写请求没有通过校验，先显示本地表述。',
  unavailable: 'AI 改写暂时不可用，这次先显示本地表述。可以重试。',
  verification_failed: '改写没有通过发布前复核，已保留本地表述。',
});

function rewriteHintOf(meta) {
  if (!meta || (meta.status !== 'local_fallback' && meta.status !== 'withheld')) return null;
  return REWRITE_REASON_HINTS[meta.reason] ?? '模型改写未采用，以下是本地表述。';
}

function rewriteNoticeHTML(message, answer) {
  if (message?.rewrite_pending || answer?.rewrite_pending) {
    return '<p class="tm-qa-rewrite-hint is-pending">正在换一种说法…</p>';
  }
  const hint = rewriteHintOf(message?.rewrite_meta ?? answer?.rewrite_meta);
  return hint ? `<p class="tm-qa-rewrite-hint" data-role="qa-rewrite-hint">${esc(hint)}</p>` : '';
}

function rewriteHTML(message, answer) {
  const rewrite = rewriteOf(message, answer);
  if (!rewrite) return '';
  if (rewrite.status === 'ok') {
    const claimCount = Array.isArray(rewrite.claim_map) ? rewrite.claim_map.length : 0;
    const terms = Array.isArray(rewrite.terms) && rewrite.terms.length
      ? `<details class="tm-qa-terms" data-role="qa-terms">
        <summary>术语 ${rewrite.terms.length} · 点击查看</summary>
        <dl class="tm-qa-evidence-list">${rewrite.terms.map((item) => `
          <div><dt>${esc(item.term)}</dt><dd>${esc(item.definition)}</dd></div>`).join('')}</dl>
      </details>`
      : '';
    const draft = answer?.text
      ? `<details class="tm-qa-draft"><summary>本地原始表述</summary><p>${esc(answer.text)}</p></details>`
      : '';
    return `<section class="tm-qa-plain" data-role="qa-plain">
      <div class="tm-qa-plain-head"><span class="tm-qa-badge is-online">白话改写</span><span>${claimCount} 条结论已绑定证据</span></div>
      <h3 class="tm-qa-plain-headline">${esc(rewrite.headline)}</h3>
      <ul class="tm-qa-plain-list">${(rewrite.plain ?? []).map((item) => `<li>${esc(item.text)}</li>`).join('')}</ul>
      ${terms}
      ${draft}
      <p class="tm-qa-notice">数字只来自上方已核对事实；改写不新增数字或结论。</p>
      ${message?.rewrite_pending ? '<p class="tm-qa-rewrite-hint is-pending">正在换一种说法…</p>' : ''}
    </section>`;
  }
  return '';
}

function answerTextHTML(answer, message) {
  const rewrite = rewriteOf(message, answer);
  if (rewrite?.status === 'ok') return rewriteHTML(message, answer);
  return `<p class="tm-qa-text">${esc(answer.text)}</p>${rewriteNoticeHTML(message, answer)}`;
}

function onlineHTML(message) {
  const online = message?.online;
  if (!online) return '';
  if (online.status === 'pending') {
    return '<p class="tm-qa-online is-pending" data-role="qa-online">正在请求在线复述…</p>';
  }
  if (online.status === 'ok') {
    const answer = online.answer ?? {};
    return `<section class="tm-qa-online" data-role="qa-online">
      <div class="tm-qa-online-head"><span class="tm-qa-badge is-online">在线复述</span><span>数字已在本机核对</span></div>
      <p class="tm-qa-text">${esc(answer.text)}</p>
      ${evidenceHTML(answer.evidence)}
      <p class="tm-qa-notice">在线只复述已发布四事实；失败时不会覆盖上面的本地答案。</p>
    </section>`;
  }
  if (online.status === 'failed') {
    return `<p class="tm-qa-online is-warn" data-role="qa-online">在线复述未完成：${esc(online.text)}。上面的本地答案仍然有效。</p>`;
  }
  return '';
}

function actionsHTML(answer, message, actionMap, currentRuleKey, question, allowOnline) {
  const actions = Array.isArray(answer.actions) ? answer.actions.slice() : [];
  const online = message?.online;
  if (allowOnline && answer.status === 'local' && answer.intent === 'loss_overview'
    && (!online || online.status === 'failed')) {
    actions.push({
      id: online ? 'online-retry' : 'online-restate',
      label: online ? '重试在线复述' : '在线复述',
      kind: 'online',
    });
  }
  const rewrite = rewriteOf(message, answer);
  const rewriteMeta = message?.rewrite_meta ?? answer?.rewrite_meta ?? null;
  if (answer.status === 'local' && (rewrite?.status === 'ok'
    || (rewriteMeta && (rewriteMeta.status === 'local_fallback' || rewriteMeta.status === 'withheld')))) {
    actions.push({
      id: 'rewrite-again',
      label: rewrite?.status === 'ok' ? '换一种说法' : '重试白话改写',
      kind: 'rewrite',
    });
  }
  const names = new Set(actions.map((a) => a.id));
  let stale = false;
  const buttons = [];
  for (const action of actions) {
    if (action.kind === 'candidate') {
      const key = message?.rule_state_key;
      if (typeof key === 'string' && key !== currentRuleKey) { stale = true; continue; }
    }
    const actionKey = `${message?.id ?? 'entry'}:${action.id}`;
    actionMap.set(actionKey, { ...action, question, messageId: message?.id ?? null });
    buttons.push(`<button type="button" class="tm-qa-action${action.kind === 'candidate' ? ' is-primary' : ''}" data-action="${esc(action.kind)}" data-action-key="${esc(actionKey)}">${esc(action.label)}</button>`);
  }
  const notes = [];
  if (actions.some((action) => action.kind === 'online')) {
    notes.push('在线复述会发送问题与所需已核对数字；不会上传原始 CSV。');
  }
  if (actions.some((action) => action.kind === 'rewrite')) {
    notes.push('换一种说法会再次把已展示事实发送给模型；不会上传原始 CSV。');
  }
  const note = notes.length ? `<p class="tm-qa-action-note">${notes.join(' ')}</p>` : '';
  const staleNote = stale && names.size
    ? '<p class="tm-qa-stale">规则状态已变化，原候选已失效；上方账单事实仍然有效。</p>'
    : '';
  if (!buttons.length) return staleNote;
  return `<div class="tm-qa-actions">${buttons.join('')}</div>${note}${staleNote}`;
}

function patchMessage(ctx, messageId, patch) {
  const chat = ctx?.state?.chat ?? {};
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const index = messages.findIndex((message) => message?.id === messageId);
  if (index < 0) return false;
  const next = messages.slice();
  next[index] = { ...next[index], ...patch };
  ctx.set({ chat: { ...chat, messages: next } });
  return true;
}

function findMessage(ctx, messageId) {
  const messages = Array.isArray(ctx?.state?.chat?.messages) ? ctx.state.chat.messages : [];
  return messages.find((message) => message?.id === messageId) ?? null;
}

function applyRewritePatch(ctx, messageId, payload) {
  const current = findMessage(ctx, messageId);
  if (!current) return false;
  if ((current.bill_context_id ?? null) !== (ctx?.state?.bill?.contextId ?? null)) return false;
  return patchMessage(ctx, messageId, {
    answer: payload.answer ?? current.answer,
    rewrite: payload.rewrite ?? null,
    rewrite_meta: payload.meta ?? null,
    rewrite_pending: false,
    rewrite_hint: null,
    ...(Array.isArray(payload.trace) ? { trace: payload.trace } : {}),
  });
}

function answerHTML(entry, actionMap, currentRuleKey, allowOnline) {
  const answer = entry.answer;
  const status = statusOf(answer);
  const intent = answer.intent ?? '';
  const facts = Array.isArray(answer.facts) ? answer.facts : [];
  const boundary = BOUNDARY_STATES.has(status) ? ' is-boundary' : '';
  return `<article class="tm-qa-entry${boundary}" data-role="qa-entry" data-intent="${esc(intent || 'none')}" data-state="${esc(status)}">
    ${entry.question ? `<header class="tm-qa-entry-head">
      <span class="tm-qa-question-label">你问</span>
      <p class="tm-qa-question">${esc(entry.question)}</p>
    </header>` : ''}
    ${traceHTML(entry.message?.trace, {})}
    <div class="tm-qa-route">
      <span class="tm-qa-intent">${esc(intentLabelOf(intent))}</span>
      <span class="tm-qa-factcount">${facts.length} 条事实</span>
      <span class="tm-qa-badge is-${esc(status)}" title="${esc(STATUS_TITLES[status] ?? '')}">${esc(badgeOf(status))}</span>
    </div>
    ${answerTextHTML(answer, entry.message)}
    ${entry.message?.rewrite_hint ? `<p class="tm-qa-rewrite-hint">${esc(entry.message.rewrite_hint)}</p>` : ''}
    ${factsHTML(facts)}
    ${savedFactsHTML(answer)}
    ${autoFactsHTML(entry.message)}
    ${evidenceHTML(answer.evidence)}
    ${actionsHTML(answer, entry.message, actionMap, currentRuleKey, entry.question, allowOnline)}
    ${onlineHTML(entry.message)}
    ${answer.notice ? `<p class="tm-qa-notice">${esc(answer.notice)}</p>` : ''}
  </article>`;
}

function pendingHTML(question, requestId = null) {
  const events = requestId ? (liveTraces.get(requestId) ?? []) : [];
  return `<article class="tm-qa-entry is-pending" data-role="qa-entry" data-intent="pending" data-state="pending" aria-busy="true">
    <header class="tm-qa-entry-head">
      <span class="tm-qa-question-label">你问</span>
      <p class="tm-qa-question">${esc(question)}</p>
    </header>
    ${traceHTML(events, { requestId, pending: true })}
    <div class="tm-qa-route">
      <span class="tm-qa-intent">正在核对</span>
      <span class="tm-qa-badge is-pending">${esc(badgeOf('pending'))}</span>
    </div>
    <p class="tm-qa-text">正在核对这份账单的报告数字…</p>
  </article>`;
}

function emptyHTML() {
  return '<p class="tm-qa-empty">还没有提问。示例问法只是入口，不是全部。</p>';
}

function clearConfirmHTML() {
  return `<div class="tm-qa-clear-confirm" data-role="qa-clear-confirm">
    <p>清空对话不会删除已自动记录的云端画像依据；仍可到个人中心撤销。</p>
    <div class="tm-qa-actions">
      <button type="button" class="btn small" data-role="qa-clear-confirm">确认清空</button>
      <button type="button" class="btn small" data-role="qa-clear-cancel">取消</button>
    </div>
  </div>`;
}

function headHTML(hasEntries, isDemo, showClearConfirm) {
  return `<header class="tm-qa-head">
    <div class="tm-qa-head-top">
      <span class="tm-qa-eyebrow">STEP 03 / ASK · 事实问答</span>
      <span class="tm-qa-head-right">${hasEntries ? '<button type="button" class="tm-qa-clear" data-role="qa-clear">清空对话</button>' : ''}<span class="tm-qa-step">04 / QA</span></span>
    </div>
    <h1>问它为什么，<br>别问它买什么。</h1>
    <p class="tm-qa-intro">任何问法都可以。答案只来自这份${isDemo ? '示例' : ''}账单报告中已核对的数字；不荐股、不预测、不替你决定。</p>
    ${showClearConfirm ? clearConfirmHTML() : ''}
  </header>`;
}

function privacyLine(question) {
  const text = questionText(question);
  if (!text) return '本地回答不上传；在线复述与 AI 解读只在你点击后发送；明确说出的长期目标、偏好或约束会自动记入画像依据。';
  if (isPageHelpQuestion(text)) return '本次：页面帮助问题，不发送；请查看 AI 助手帮助。';
  const route = routeQuestion(text);
  if (route.intent === 'loss_overview') return '本次：本机回答，不上传。需要在线复述时，请在回答上单独选择。';
  if (route.intent) return '本次：本机回答，不上传；AI 解读只在你点击后发送问题与上方事实；明确陈述会自动记入画像依据。';
  return '本次：本机未匹配；发送后会先发送问题文本理解问法，不发送账单数字；明确陈述会自动记入画像依据。';
}

function askHTML(pending, privacy, handoff) {
  return `<form class="tm-qa-ask" data-role="qa-form">
    <label class="sr-only" for="tm-qa-input">输入你的问题</label>
    ${handoff ? `<p class="tm-qa-handoff" data-role="qa-handoff">${esc(handoff)}</p>` : ''}
    <div class="tm-qa-ask-row">
      <textarea id="tm-qa-input" data-role="qa-input" rows="2" maxlength="200" placeholder="问这份账单已经发生的事，例如：我最错的一笔是哪个？" ${pending ? 'disabled' : ''}>${esc(draft)}</textarea>
      <button class="tm-qa-send" type="submit" ${pending ? 'disabled' : ''}>发送</button>
    </div>
    <p class="tm-qa-privacy" data-role="qa-send-preview">${esc(privacy)}</p>
    <p class="tm-qa-ask-meta">Enter 发送 · Shift+Enter 换行</p>
  </form>`;
}

function suggestHTML(pending) {
  return `<div class="tm-qa-suggest" data-role="qa-chips" aria-label="示例问法">${QA_SUGGESTIONS.map((item) => `
    <button type="button" class="tm-qa-chip" data-role="qa-chip" data-question="${esc(item.question)}" ${pending ? 'disabled' : ''}>${esc(item.label)}</button>`).join('')}</div>`;
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

function sideMoneyText(value) {
  return String(value ?? '—').replace(/^¥-/, '-¥');
}

function sideFactText(fact) {
  if (!fact) return '—';
  if (fact.display != null && fact.display !== '') return sideMoneyText(fact.display);
  if (Number.isFinite(fact.value)) return sideMoneyText(fmtMoney(fact.value));
  return '—';
}

function sideHTML(state, ctx) {
  const bill = state.bill ?? {};
  const isDemo = bill.demo === true;

  let reportState = { status: 'idle' };
  try { reportState = ctx.qaDeps?.getReportState?.(bill) ?? { status: 'idle' }; } catch { /* 缓存读取失败 */ }

  const bundle = reportState.status === 'ready' ? reportState.bundle : null;
  const published = bundle?.review?.portfolio_published === true;
  const portfolio = published ? (bundle.factsByScope?.portfolio ?? null) : null;

  const trades = Array.isArray(bill.trades) ? bill.trades : [];
  const tradeCount = trades.length;
  const symbolCount = tradeCount > 0 ? new Set(trades.map((t) => t.symbol).filter(Boolean)).size : 0;

  let bodyHTML;
  if (portfolio) {
    const asOfDate = bundle.asOfDate || '—';
    const actualRet = sideFactText(portfolio.actualRet);
    const ghostRet = sideFactText(portfolio.ghostRet);
    const dragMoney = sideFactText(portfolio.dragMoney);
    const dragVal = portfolio.dragMoney?.value;
    const dragLoss = Number.isFinite(dragVal) && dragVal > 0;
    bodyHTML = `<dl class="tm-qa-side-list">
      <div><dt>初始本金</dt><dd>暂无</dd></div>
      <div><dt>估值日</dt><dd>${esc(asOfDate)}</dd></div>
      <div><dt>实际收益</dt><dd>${esc(actualRet)}</dd></div>
      <div><dt>对照收益</dt><dd>${esc(ghostRet)}</dd></div>
      <div><dt>差额</dt><dd${dragLoss ? ' class="tm-qa-side-loss"' : ''}>${esc(dragMoney)}</dd></div>
      <div><dt>交易 / 标的</dt><dd>${tradeCount > 0 ? `${tradeCount} 笔 / ${symbolCount} 个` : '—'}</dd></div>
    </dl>`;
  } else {
    let statusText = '报告未读取';
    if (reportState.status === 'loading') statusText = '报告加载中…';
    else if (reportState.status === 'error') statusText = '报告加载失败';
    else if (bundle) {
      if (bundle.status === 'error') statusText = '计算出错';
      else if (bundle.status === 'blocked') statusText = '计算被阻断';
      else if (!bundle.review) statusText = '报告未复核';
      else statusText = '组合未发布';
    }
    bodyHTML = `<div class="tm-qa-side-status">
      <p class="tm-qa-side-status-text">${esc(statusText)}</p>
    </div>`;
  }

  return `<aside class="tm-qa-side" aria-label="事实清单">
    <div class="tm-qa-side-head"><span>FACT SHEET / 事实清单</span><span class="tm-qa-side-tag">${isDemo ? '示例' : '已确认'}</span></div>
    ${bodyHTML}
    <div class="tm-qa-side-note">
      <strong>它不会：</strong>
      <ul><li>预测涨跌</li><li>推荐具体标的</li><li>替你下单或定规则</li></ul>
    </div>
    <a class="tm-qa-side-link" href="#/report">回到完整报告 <span class="arrow">→</span></a>
  </aside>`;
}

export function renderRealChat(host, ctx) {
  if (!host) return;
  const { state, set } = ctx;
  const contextId = state.bill?.contextId ?? null;
  if (draftContextId !== contextId) {
    const lostHandoff = handoffNotice === '已从助手带入问题，请确认后发送。' && !!draft.trim();
    draft = '';
    draftContextId = contextId;
    handoffNotice = lostHandoff ? '账单已变化，之前从助手带入的问题已丢弃，请重新提问。' : null;
    clearArmed = false;
  }
  const incoming = typeof ctx.takeQaHandoff === 'function' ? ctx.takeQaHandoff(contextId) : null;
  if (incoming?.dropped) {
    handoffNotice = '账单已变化，之前从助手带入的问题已丢弃，请重新提问。';
  } else if (incoming?.question) {
    draft = incoming.question;
    handoffNotice = '已从助手带入问题，请确认后发送。';
  }

  const allMessages = Array.isArray(state.chat.messages) ? state.chat.messages : [];
  const messages = allMessages.filter((m) => m && (m.bill_context_id ?? null) === contextId);
  const pending = state.chat.pending === true && (state.chat.contextId ?? contextId) === contextId;
  const versions = Array.isArray(state.contracts?.versions) ? state.contracts.versions : [];
  const currentRuleKey = ruleStateKeyOf(versions);
  const entries = pairEntries(messages);
  const actionMap = new Map();
  const lastQuestion = [...messages].reverse().find((m) => m.role === 'user')?.text ?? '';
  const isDemo = state.bill?.demo === true;
  const confirmed = state.bill?.status === 'confirmed' && state.bill?.sourceType === 'local' && !state.bill?.blocked;
  const allowOnline = confirmed && !isDemo;

  const logHTML = entries.length || pending
    ? `${entries.map((entry) => (entry.answer
      ? answerHTML(entry, actionMap, currentRuleKey, allowOnline)
      : pendingHTML(entry.question, state.chat.requestId))).join('')}${pending && !entries.some((e) => !e.answer) ? pendingHTML(lastQuestion, state.chat.requestId) : ''}`
    : emptyHTML();

  host.innerHTML = `<div class="tm-qa-page">
    <div class="container">
      <div class="tm-qa-layout">
        <div class="tm-qa-main">
          <div class="tm-qa-scroll" data-role="qa-scroll">
            ${headHTML(entries.length > 0 || pending, isDemo, clearArmed)}
            <div class="tm-qa-log" data-role="qa-ledger" aria-live="polite">${logHTML}</div>
          </div>
          <div class="tm-qa-dock" data-role="qa-dock" aria-label="提问区">
            ${suggestHTML(pending)}
            ${askHTML(pending, privacyLine(draft), handoffNotice)}
          </div>
        </div>
        ${sideHTML(state, ctx)}
      </div>
    </div>
  </div>`;

  const form = host.querySelector('[data-role="qa-form"]');
  const input = host.querySelector('[data-role="qa-input"]');
  const scroller = host.querySelector('[data-role="qa-scroll"]');
  const preview = host.querySelector('[data-role="qa-send-preview"]');
  const logKey = `${contextId ?? 'none'}:${messages.length}:${pending ? 'pending' : 'idle'}`;
  const firstRender = lastScrollKey === null;
  if (scroller && lastScrollKey !== logKey) {
    requestAnimationFrame(() => {
      const top = Number.isFinite(scroller.scrollHeight) ? scroller.scrollHeight : 0;
      if (firstRender && typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top, behavior: 'smooth' });
      } else {
        scroller.scrollTop = top;
      }
    });
  }
  lastScrollKey = logKey;

  function updatePreview(value) {
    if (preview) preview.textContent = privacyLine(value);
  }

  async function send(raw, source = 'typed') {
    const question = questionText(raw);
    if (!question || state.chat.pending) return;
    draft = '';
    handoffNotice = null;
    clearArmed = false;
    const messageContextId = state.bill?.contextId ?? null;
    const requestId = `qa-${++seq}`;
    const isCurrent = () => state.chat.requestId === requestId && (state.bill?.contextId ?? null) === messageContextId;
    const userMessage = {
      id: `${requestId}-q`, role: 'user', kind: 'qa-user',
      text: question, bill_context_id: messageContextId,
    };

    if (isPageHelpQuestion(question)) {
      const help = buildPageHelpAnswer();
      setMessages([
        ...state.chat.messages,
        userMessage,
        {
          id: requestId, role: 'assistant', kind: 'qa', text: help.text,
          answer: { ...help, bill_context_id: messageContextId },
          bill_context_id: messageContextId, rule_state_key: currentRuleKey,
        },
      ], messageContextId);
      return;
    }

    liveTraces.set(requestId, []);
    set({
      chat: {
        ...state.chat,
        contextId: messageContextId,
        requestId,
        pending: true,
        messages: [...state.chat.messages, userMessage],
      },
    });

    let answer = null;
    let trace = [];
    try {
      if (typeof ctx.qaDeps?.askQuestion !== 'function') {
        answer = failureAnswer({ question, contextId: messageContextId });
      } else {
        let ruleState = null;
        try { ruleState = ctx.qaDeps.ruleStateOf?.(versions) ?? null; } catch { ruleState = null; }
        const payload = await ctx.qaDeps.askQuestion({
          question,
          bill: state.bill,
          ruleState,
          versions,
          source,
          deferRewrite: true,
          onRewrite: (payload) => {
            if (!findMessage(ctx, requestId)) {
              queuedRewrites.set(requestId, payload);
              return;
            }
            applyRewritePatch(ctx, requestId, payload);
          },
          onStage: (event) => {
            if (!isCurrent()) return;
            const events = mergeTraceEvent(liveTraces.get(requestId) ?? [], event);
            liveTraces.set(requestId, events);
            patchLiveTrace(host, requestId, events);
          },
        });
        answer = payload?.envelope ?? payload ?? null;
        trace = Array.isArray(payload?.trace) ? payload.trace : [];
      }
    } catch {
      if (!isCurrent()) { liveTraces.delete(requestId); return; }
      answer = failureAnswer({ question, contextId: messageContextId });
    }
    if (!isCurrent()) { liveTraces.delete(requestId); return; }
    liveTraces.delete(requestId);
    const assistantMessage = {
      id: requestId, role: 'assistant', kind: 'qa',
      text: answer?.text ?? '',
      answer,
      trace,
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
    const queued = queuedRewrites.get(requestId);
    if (queued) {
      queuedRewrites.delete(requestId);
      applyRewritePatch(ctx, requestId, queued);
    }
    void autoExtractProfileFacts(question, requestId, messageContextId, answer);
  }

  // 回答后异步被动抽取：只记录明确陈述，失败静默；不阻塞回答，也不提供手动入口。
  async function autoExtractProfileFacts(question, messageId, messageContextId, answer) {
    if (!answer || answer.status === 'error') return;
    if (!shouldExtractProfileFacts(question)) return;
    const bill = state.bill;
    const usable = bill && bill.contextId === messageContextId
      && bill.status === 'confirmed' && bill.sourceType === 'local' && !bill.blocked && bill.demo !== true;
    if (!usable) return;
    if (typeof ctx.qaDeps?.extractProfileFacts !== 'function' || typeof ctx.qaDeps?.saveProfileFacts !== 'function') return;

    let extracted = null;
    try {
      extracted = await ctx.qaDeps.extractProfileFacts({ message: question, contextId: messageContextId });
    } catch {
      return;
    }
    if (!extracted?.ok || !Array.isArray(extracted.facts) || !extracted.facts.length) return;
    if (state.bill?.contextId !== messageContextId) return;

    let saved = null;
    try {
      saved = await ctx.qaDeps.saveProfileFacts({ facts: extracted.facts, contextId: messageContextId });
    } catch {
      return;
    }
    if (!saved?.ok || state.bill?.contextId !== messageContextId) return;
    const payload = saved.result ?? {};
    const added = Array.isArray(payload.added) ? payload.added : [];
    const duplicates = Array.isArray(payload.duplicates) ? payload.duplicates : [];
    if (added.length) {
      ctx.cloudDeps?.appendCachedCloudFacts?.(added);
      ctx.cloudDeps?.invalidateCloudProfile?.();
      patchMessage(ctx, messageId, {
        profile_auto: {
          state: 'saved',
          count: added.length,
          ids: added.map((item) => item?.id).filter((id) => typeof id === 'string'),
        },
      });
    } else if (duplicates.length) {
      patchMessage(ctx, messageId, { profile_auto: { state: 'duplicate' } });
    }
  }

  function setMessages(messages, messageContextId = contextId) {
    set({
      chat: {
        ...state.chat,
        contextId: messageContextId,
        pending: false,
        requestId: null,
        messages,
      },
    });
  }

  async function runOnline(question, messageId) {
    const message = findMessage(ctx, messageId);
    if (!message || !question || message.online?.status === 'pending') return;
    if ((message.bill_context_id ?? null) !== (state.bill?.contextId ?? null)) return;
    const requestId = `online-${++seq}`;
    patchMessage(ctx, messageId, { online: { status: 'pending', requestId } });
    let result = null;
    try {
      const ruleState = ctx.qaDeps?.ruleStateOf?.(versions) ?? null;
      result = typeof ctx.qaDeps?.askQuestion === 'function'
        ? await ctx.qaDeps.askQuestion({
          question, bill: state.bill, ruleState, versions, preferOnline: true,
          reuseIntent: message.answer?.intent ?? null,
          reuseRoute: message.answer?.route ?? null,
        })
        : null;
    } catch {
      result = null;
    }
    if ((state.bill?.contextId ?? null) !== (message.bill_context_id ?? null)) return;
    const latest = findMessage(ctx, messageId);
    if (!latest || latest.online?.requestId !== requestId) return;
    const envelope = result?.envelope ?? result;
    if (envelope?.status === 'online') {
      patchMessage(ctx, messageId, { online: { status: 'ok', answer: envelope } });
      return;
    }
    const text = envelope?.notice ? String(envelope.notice) : '在线服务当前不可用，请稍后重试。';
    patchMessage(ctx, messageId, { online: { status: 'failed', text } });
  }

  async function runRewrite(question, messageId) {
    const message = findMessage(ctx, messageId);
    if (!message || !question || message.rewrite_pending) return;
    if ((message.bill_context_id ?? null) !== (state.bill?.contextId ?? null)) return;
    const current = rewriteOf(message, message.answer);
    const currentMeta = message.rewrite_meta ?? message.answer?.rewrite_meta ?? null;
    const retryable = current && (current.status === 'ok'
      || currentMeta?.status === 'local_fallback' || currentMeta?.status === 'withheld');
    if (!retryable) return;
    if (typeof ctx.qaDeps?.rewriteAnswer !== 'function') {
      patchMessage(ctx, messageId, { rewrite_hint: '当前环境不支持白话改写。' });
      return;
    }
    patchMessage(ctx, messageId, { rewrite_pending: true, rewrite_hint: null });
    let result = null;
    try {
      result = await ctx.qaDeps.rewriteAnswer({
        question,
        answer: message.answer,
        bill: state.bill,
        force: true,
      });
    } catch {
      result = null;
    }
    if ((state.bill?.contextId ?? null) !== (message.bill_context_id ?? null)) return;
    const latest = findMessage(ctx, messageId);
    if (!latest || !latest.rewrite_pending) return;
    if (result?.rewrite) {
      patchMessage(ctx, messageId, {
        answer: { ...latest.answer, rewrite: result.rewrite, rewrite_meta: result.rewrite_meta ?? null, rewrite_pending: false },
        rewrite: result.rewrite,
        rewrite_meta: result.rewrite_meta ?? null,
        rewrite_pending: false,
        rewrite_hint: null,
      });
      return;
    }
    patchMessage(ctx, messageId, {
      rewrite: current,
      rewrite_pending: false,
      rewrite_hint: '模型改写未完成，已保留上一条表述。',
    });
  }

  function clearConversation() {
    draft = '';
    handoffNotice = null;
    clearArmed = false;
    lastScrollKey = null;
    set({
      chat: {
        ...state.chat,
        messages: [],
        pending: false,
        requestId: null,
        contextId,
      },
    });
  }

  if (form && input) {
    input.addEventListener('input', () => {
      draft = input.value;
      updatePreview(input.value);
    });
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
      send(chip.getAttribute('data-question') || '', 'chip');
      return;
    }
    const clear = e.target.closest('[data-role="qa-clear"]');
    if (clear && host.contains(clear)) {
      clearArmed = true;
      set({ chat: { ...state.chat } });
      return;
    }
    const clearConfirm = e.target.closest('[data-role="qa-clear-confirm"]');
    if (clearConfirm && host.contains(clearConfirm)) {
      clearConversation();
      return;
    }
    const clearCancel = e.target.closest('[data-role="qa-clear-cancel"]');
    if (clearCancel && host.contains(clearCancel)) {
      clearArmed = false;
      set({ chat: { ...state.chat } });
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
    if (action.kind === 'online') {
      void runOnline(action.question, action.messageId);
      return;
    }
    if (action.kind === 'rewrite') {
      void runRewrite(action.question, action.messageId);
      return;
    }
    if (action.kind === 'assistant-help') {
      ctx.openAssistantHelp?.();
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

export { mergeTraceEvent, traceHTML, resolveTraceHost, patchLiveTrace };
