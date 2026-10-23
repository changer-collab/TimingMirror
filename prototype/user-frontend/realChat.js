// 独立问答页「对话账本」：问题 → 意图 → 最小事实包 → 本地/在线回答 → 证据。
// 只渲染 qaAnswer 信封；普通提问不触发画像，用户主动选择后才按“授权发送 → 候选确认 → 保存”执行。
// 无网络/DOM 之外的副作用：发送、在线复述、画像抽取/保存与规则打开由 ctx 注入。
import {
  QA_SUGGESTIONS,
  QA_INTENT_LABELS,
  routeQuestion,
  isPageHelpQuestion,
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
  pending: '正在核对',
});

const FACT_KIND_LABELS = PROFILE_FACT_KIND_LABELS;

const BOUNDARY_STATES = new Set(['refusal', 'registration', 'unavailable']);

let seq = 0;
let draft = '';
let draftContextId = null;
let lastScrollKey = null;
let handoffNotice = null;
let clearArmed = false;

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

function profileFactsHTML(facts, saved) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return '';
  const shown = list.slice(0, 3);
  const rest = list.slice(3);
  const row = (fact) => `
    <li class="tm-qa-profile-fact">
      <span class="tm-qa-profile-kind">${esc(FACT_KIND_LABELS[fact.kind] ?? '事实')}</span>
      <strong>${esc(fact.value)}</strong>
      ${fact.evidence ? `<span class="tm-qa-profile-evidence">原文：${esc(fact.evidence)}</span>` : ''}
    </li>`;
  const more = rest.length
    ? `<details class="tm-qa-profile-more"><summary>还有 ${rest.length} 条</summary><ul>${rest.map(row).join('')}</ul></details>`
    : '';
  return `<ul class="tm-qa-profile-list${saved ? ' is-saved' : ''}" data-role="qa-profile-facts">${shown.map(row).join('')}</ul>${more}`;
}

function profileFactHTML(message) {
  const fact = message?.profile_fact;
  if (!fact) return '';
  const messageId = esc(message.id ?? '');
  const actions = (...items) => `<div class="tm-qa-actions">${items.join('')}</div>`;
  if (fact.state === 'confirm') {
    return `<div class="tm-qa-profilefact" data-role="qa-profilefact">
      <p class="tm-qa-profilefact-head">记入画像前确认</p>
      <blockquote class="tm-qa-profile-quote">${esc(fact.message)}</blockquote>
      <p class="tm-qa-profilefact-note">将把你选择的这句话发送给模型，用于提取可保存的画像事实；不会上传原始 CSV 或成交明细。保存时会关联当前账单。</p>
      ${actions(
        `<button type="button" class="btn primary small" data-fact-action="extract" data-message-id="${messageId}">继续并提取</button>`,
        `<button type="button" class="btn small" data-fact-action="cancel" data-message-id="${messageId}">取消</button>`,
      )}
    </div>`;
  }
  if (fact.state === 'extracting') {
    return '<p class="tm-qa-profilefact is-muted" data-role="qa-profilefact">正在提取候选事实…</p>';
  }
  if (fact.state === 'candidates') {
    return `<div class="tm-qa-profilefact" data-role="qa-profilefact">
      <p class="tm-qa-profilefact-head">候选事实 · 请确认后保存</p>
      ${profileFactsHTML(fact.facts, false)}
      ${actions(
        `<button type="button" class="btn primary small" data-fact-action="save" data-message-id="${messageId}">保存到画像</button>`,
        `<button type="button" class="btn small" data-fact-action="cancel" data-message-id="${messageId}">取消</button>`,
      )}
    </div>`;
  }
  if (fact.state === 'empty') {
    return `<div class="tm-qa-profilefact" data-role="qa-profilefact">
      <p class="tm-qa-profilefact is-muted">没有找到可长期保存的画像信息。你可以换个说法再试。</p>
      ${actions(`<button type="button" class="btn small" data-fact-action="cancel" data-message-id="${messageId}">关闭</button>`)}
    </div>`;
  }
  if (fact.state === 'saving') {
    return '<p class="tm-qa-profilefact is-muted" data-role="qa-profilefact">正在保存到画像…</p>';
  }
  if (fact.state === 'saved') {
    const duplicates = fact.duplicates ? ` · 另有 ${esc(fact.duplicates)} 条已存在` : '';
    const stale = fact.summary_stale
      ? '<p class="tm-qa-profilefact-note is-warn">画像已更新；<a href="#/me">个人中心</a>的旧解读需要重新生成。</p>'
      : '';
    return `<div class="tm-qa-profilefact" data-role="qa-profilefact">
      <div class="tm-qa-profilefact-head">
        <span>已记入画像 · ${esc(fact.facts?.length ?? 0)} 条${duplicates}</span>
        <button type="button" class="tm-qa-profile-undo" data-fact-action="undo" data-message-id="${messageId}">撤销</button>
      </div>
      ${profileFactsHTML(fact.facts, true)}
      <p class="tm-qa-profilefact-note">来自你的陈述；可到 <a href="#/me">个人中心</a> 查看和删除。</p>
      ${stale}
    </div>`;
  }
  if (fact.state === 'duplicate') {
    return `<p class="tm-qa-profilefact is-muted" data-role="qa-profilefact">这条陈述已在画像中，未重复记录。可到 <a href="#/me">个人中心</a> 查看。</p>`;
  }
  if (fact.state === 'extract-failed' || fact.state === 'save-failed') {
    const text = fact.state === 'save-failed'
      ? '未能保存到云端画像；问答回答不受影响。'
      : '这次没有提取成功，可以稍后重试。';
    const retry = fact.state === 'save-failed' ? 'retry-save' : 'retry-extract';
    return `<div class="tm-qa-profilefact" data-role="qa-profilefact">
      <p class="tm-qa-profilefact is-warn">${text}</p>
      ${actions(
        `<button type="button" class="btn small" data-fact-action="${retry}" data-message-id="${messageId}">重试</button>`,
        `<button type="button" class="btn small" data-fact-action="cancel" data-message-id="${messageId}">取消</button>`,
      )}
    </div>`;
  }
  if (fact.state === 'undoing') return '<p class="tm-qa-profilefact is-muted" data-role="qa-profilefact">正在撤销画像记录…</p>';
  if (fact.state === 'undone') return '<p class="tm-qa-profilefact is-muted" data-role="qa-profilefact">已撤销这次的画像记录。</p>';
  if (fact.state === 'undo-failed') {
    return `<div class="tm-qa-profilefact" data-role="qa-profilefact">
      <p class="tm-qa-profilefact is-warn">撤销失败，可稍后重试，或到个人中心删除。</p>
      ${actions(`<button type="button" class="btn small" data-fact-action="undo" data-message-id="${messageId}">重试撤销</button>`)}
    </div>`;
  }
  return '';
}

function profileActionHTML(message, question, allowProfile) {
  if (!allowProfile || message?.profile_fact) return '';
  return `<div class="tm-qa-profile-actions" data-role="qa-profile-actions">
    <button type="button" class="btn small" data-fact-action="record" data-message-id="${esc(message?.id ?? '')}" data-question="${esc(question)}">记入画像</button>
    <span class="tm-qa-profile-hint">仅在你主动选择并确认后发送</span>
  </div>`;
}

function savedFactsHTML(answer) {
  const list = Array.isArray(answer?.saved_facts) ? answer.saved_facts.slice(0, 5) : [];
  if (!list.length) return '';
  const total = Number.isFinite(answer?.saved_fact_total) ? answer.saved_fact_total : list.length;
  const more = total > list.length
    ? `<p class="tm-qa-notice">画像中共 ${esc(total)} 条，这里显示最近 ${list.length} 条。</p>`
    : '';
  return `<section class="tm-qa-savedfacts" data-role="qa-saved-facts">
    <div class="tm-qa-savedfacts-head"><span>你主动记入的画像事实</span><a href="#/me">查看 / 删除</a></div>
    <ul class="tm-qa-profile-list is-saved">${list.map((fact) => `
      <li class="tm-qa-profile-fact">
        <span class="tm-qa-profile-kind">${esc(FACT_KIND_LABELS[fact.kind] ?? '事实')}</span>
        <strong>${esc(fact.value)}</strong>
        ${fact.evidence ? `<span class="tm-qa-profile-evidence">原文：${esc(fact.evidence)}</span>` : ''}
      </li>`).join('')}</ul>
    ${more}
    <p class="tm-qa-notice">只读展示；补充或删除请到个人中心。</p>
  </section>`;
}

function narrativeHTML(message, question) {
  const narrative = message?.narrative;
  if (!narrative) return '';
  if (narrative.status === 'pending') {
    return '<p class="tm-qa-narrative is-pending" data-role="qa-narrative">正在生成 AI 解读…</p>';
  }
  if (narrative.status === 'ok') {
    const checked = narrative.number_check && Number.isFinite(narrative.number_check.checked)
      ? `已核对 ${narrative.number_check.checked} 处数字`
      : '数字已在本机复核';
    return `<section class="tm-qa-narrative" data-role="qa-narrative">
      <div class="tm-qa-narrative-head"><span class="tm-qa-badge is-online">AI 解读</span><span>${esc(checked)}</span></div>
      <p class="tm-qa-text">${esc(narrative.text)}</p>
      <p class="tm-qa-notice">只解释上方已核对事实；未通过数字校验时不会显示。</p>
    </section>`;
  }
  if (narrative.status === 'failed') {
    const retry = narrative.retryable === false
      ? ''
      : `<div class="tm-qa-actions"><button type="button" class="btn small" data-role="qa-narrative-retry" data-message-id="${esc(message.id ?? '')}" data-question="${esc(question)}">重试 AI 解读</button></div>`;
    return `<div class="tm-qa-narrative is-warn" data-role="qa-narrative">
      <p>AI 解读未完成：${esc(narrative.text || '在线解读服务暂时不可用，请稍后重试。')}。上面的本地答案仍然有效。</p>
      ${retry}
    </div>`;
  }
  return '';
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
  if (allowOnline && answer.status === 'local' && answer.narrative_policy === 'manual' && !message?.narrative) {
    actions.push({ id: 'ai-narrative', label: 'AI 解读', kind: 'narrative' });
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
  if (actions.some((action) => action.kind === 'narrative')) {
    notes.push('AI 解读会发送问题与上方已展示事实；不会上传原始 CSV。');
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

function answerHTML(entry, actionMap, currentRuleKey, allowOnline, allowProfile) {
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
    <div class="tm-qa-route">
      <span class="tm-qa-intent">${esc(intentLabelOf(intent))}</span>
      <span class="tm-qa-factcount">${facts.length} 条事实</span>
      <span class="tm-qa-badge is-${esc(status)}" title="${esc(STATUS_TITLES[status] ?? '')}">${esc(badgeOf(status))}</span>
    </div>
    <p class="tm-qa-text">${esc(answer.text)}</p>
    ${factsHTML(facts)}
    ${savedFactsHTML(answer)}
    ${evidenceHTML(answer.evidence)}
    ${actionsHTML(answer, entry.message, actionMap, currentRuleKey, entry.question, allowOnline)}
    ${onlineHTML(entry.message)}
    ${narrativeHTML(entry.message, entry.question)}
    ${profileActionHTML(entry.message, entry.question, allowProfile)}
    ${profileFactHTML(entry.message)}
    ${answer.notice ? `<p class="tm-qa-notice">${esc(answer.notice)}</p>` : ''}
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
    <p>清空对话不会删除已保存的云端画像事实；你仍可到个人中心查看和删除。</p>
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
  if (!text) return '本地回答不上传；在线复述、AI 解读和画像记录只在你主动选择后发送。';
  if (isPageHelpQuestion(text)) return '本次：页面帮助问题，不发送；请查看 AI 助手帮助。';
  const route = routeQuestion(text);
  if (route.intent === 'loss_overview') return '本次：本机回答，不上传。需要在线复述时，请在回答上单独选择。';
  if (route.intent) return '本次：本机回答，不上传；AI 解读只在你点击后发送问题与上方事实。';
  return '本次：本机未匹配；发送后会先发送问题文本理解问法，不发送账单数字。';
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

function pageHelpAnswer() {
  return {
    status: 'local',
    intent: null,
    route: { layer: 'L3', confidence: null },
    source: 'template',
    text: '这是页面操作或隐私问题。请在「AI 助手」的帮助说明中查看；问答页不会把这类问题发送到在线服务。',
    facts: [],
    evidence: [],
    actions: [{ id: 'assistant-help', label: '查看助手帮助', kind: 'assistant-help' }],
    trace: { template_id: null, plan_id: null, fact_count: 0, number_check: null, elapsed_ms: 0, intent_code: 'page_help', layer_label: '页面帮助' },
    candidate: null,
    notice: null,
    diagnostics: [],
    bill_context_id: null,
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
  const allowProfileBase = confirmed && !isDemo;

  const logHTML = entries.length || pending
    ? `${entries.map((entry) => (entry.answer
      ? answerHTML(entry, actionMap, currentRuleKey, allowOnline, allowProfileBase && shouldExtractProfileFacts(entry.question))
      : pendingHTML(entry.question))).join('')}${pending && !entries.some((e) => !e.answer) ? pendingHTML(lastQuestion) : ''}`
    : emptyHTML();

  host.innerHTML = `<div class="tm-qa-page">
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
  </div>`;

  const form = host.querySelector('[data-role="qa-form"]');
  const input = host.querySelector('[data-role="qa-input"]');
  const scroller = host.querySelector('[data-role="qa-scroll"]');
  const preview = host.querySelector('[data-role="qa-send-preview"]');
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

  function updatePreview(value) {
    if (preview) preview.textContent = privacyLine(value);
  }

  async function send(raw) {
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
      const help = pageHelpAnswer();
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
        answer = await ctx.qaDeps.askQuestion({ question, bill: state.bill, ruleState, versions });
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

  function startProfileRecord(messageId, question) {
    const message = findMessage(ctx, messageId);
    if (!message || !message.bill_context_id || message.bill_context_id !== state.bill?.contextId) return;
    patchMessage(ctx, messageId, {
      profile_fact: { state: 'confirm', message: question, facts: [] },
    });
  }

  async function extractProfile(messageId) {
    const current = findMessage(ctx, messageId);
    const fact = current?.profile_fact;
    if (!current || !fact || fact.state === 'extracting' || fact.state === 'saving') return;
    if (!fact.message || current.bill_context_id !== state.bill?.contextId) return;
    const requestId = `profile-${++seq}`;
    patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'extracting', requestId } });
    let result = null;
    try {
      result = typeof ctx.qaDeps?.extractProfileFacts === 'function'
        ? await ctx.qaDeps.extractProfileFacts({ message: fact.message, contextId: current.bill_context_id })
        : null;
    } catch {
      result = null;
    }
    if (state.bill?.contextId !== current.bill_context_id) return;
    const latest = findMessage(ctx, messageId)?.profile_fact;
    if (!latest || latest.requestId !== requestId) return;
    if (result?.ok && Array.isArray(result.facts) && result.facts.length) {
      patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'candidates', requestId: null, facts: result.facts } });
      return;
    }
    if (result?.ok) {
      patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'empty', requestId: null, facts: [] } });
      return;
    }
    patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'extract-failed', requestId: null, facts: [] } });
  }

  async function saveProfile(messageId) {
    const current = findMessage(ctx, messageId);
    const fact = current?.profile_fact;
    if (!current || !fact || fact.state !== 'candidates' || !Array.isArray(fact.facts) || !fact.facts.length) return;
    if (current.bill_context_id !== state.bill?.contextId) return;
    const requestId = `profile-save-${++seq}`;
    patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'saving', requestId } });
    let result = null;
    try {
      result = typeof ctx.qaDeps?.saveProfileFacts === 'function'
        ? await ctx.qaDeps.saveProfileFacts({ facts: fact.facts, contextId: current.bill_context_id })
        : null;
    } catch {
      result = null;
    }
    if (state.bill?.contextId !== current.bill_context_id) return;
    const latest = findMessage(ctx, messageId)?.profile_fact;
    if (!latest || latest.requestId !== requestId) return;
    if (!result?.ok) {
      patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'save-failed', requestId: null } });
      return;
    }
    const payload = result.result ?? {};
    const added = Array.isArray(payload.added) ? payload.added : [];
    const duplicates = Array.isArray(payload.duplicates) ? payload.duplicates : [];
    if (added.length) {
      ctx.cloudDeps?.appendCachedCloudFacts?.(added);
      patchMessage(ctx, messageId, {
        profile_fact: {
          state: 'saved',
          message: fact.message,
          facts: added,
          ids: added.map((item) => item?.id).filter((id) => typeof id === 'string'),
          duplicates: duplicates.length,
          summary_stale: true,
          requestId: null,
        },
      });
      return;
    }
    ctx.cloudDeps?.invalidateCloudProfile?.();
    patchMessage(ctx, messageId, {
      profile_fact: { ...fact, state: duplicates.length ? 'duplicate' : 'empty', requestId: null, facts: [] },
    });
  }

  function cancelProfile(messageId) {
    const current = findMessage(ctx, messageId);
    if (!current?.profile_fact) return;
    patchMessage(ctx, messageId, { profile_fact: null });
  }

  async function undoProfileFacts(messageId) {
    const message = findMessage(ctx, messageId);
    const fact = message?.profile_fact;
    const ids = Array.isArray(fact?.ids) ? fact.ids : [];
    if (!message || !ids.length || typeof ctx.cloudDeps?.deleteFact !== 'function') return;
    patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'undoing' } });
    try {
      for (const id of ids) {
        try {
          await ctx.cloudDeps.deleteFact({ id });
        } catch (error) {
          if ((error?.upstreamCode ?? error?.code) !== 'not_found') throw error;
        }
      }
      patchMessage(ctx, messageId, { profile_fact: { state: 'undone', ids: [] } });
      ctx.cloudDeps.invalidateCloudProfile?.();
    } catch {
      patchMessage(ctx, messageId, { profile_fact: { ...fact, state: 'undo-failed' } });
    }
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
        })
        : null;
    } catch {
      result = null;
    }
    if ((state.bill?.contextId ?? null) !== (message.bill_context_id ?? null)) return;
    const latest = findMessage(ctx, messageId);
    if (!latest || latest.online?.requestId !== requestId) return;
    if (result?.status === 'online') {
      patchMessage(ctx, messageId, { online: { status: 'ok', answer: result } });
      return;
    }
    const text = result?.notice ? String(result.notice) : '在线服务当前不可用，请稍后重试。';
    patchMessage(ctx, messageId, { online: { status: 'failed', text } });
  }

  async function runNarrative(question, messageId) {
    const message = findMessage(ctx, messageId);
    if (!message || !question || message.narrative?.status === 'pending') return;
    if ((message.bill_context_id ?? null) !== (state.bill?.contextId ?? null)) return;
    if (typeof ctx.qaDeps?.narrateAnswer !== 'function') {
      patchMessage(ctx, messageId, {
        narrative: { status: 'failed', text: '当前环境不支持 AI 解读。', retryable: false },
      });
      return;
    }
    const requestId = `narrative-${++seq}`;
    patchMessage(ctx, messageId, { narrative: { status: 'pending', requestId } });
    let result = null;
    try {
      result = await ctx.qaDeps.narrateAnswer({
        question,
        answer: message.answer,
        bill: state.bill,
      });
    } catch {
      result = null;
    }
    if ((state.bill?.contextId ?? null) !== (message.bill_context_id ?? null)) return;
    const latest = findMessage(ctx, messageId);
    if (!latest || latest.narrative?.requestId !== requestId) return;
    if (result?.ok && result.text) {
      patchMessage(ctx, messageId, {
        narrative: { status: 'ok', text: result.text, number_check: result.number_check ?? null },
      });
      return;
    }
    const code = result?.code ?? 'E_QA_NARRATIVE_UNAVAILABLE';
    const retryable = code !== 'E_QA_NARRATIVE_NOT_ALLOWED'
      && code !== 'E_QA_NARRATIVE_STALE'
      && code !== 'E_QA_NARRATIVE_NO_FACTS';
    patchMessage(ctx, messageId, {
      narrative: {
        status: 'failed',
        text: result?.message || '在线解读服务暂时不可用，请稍后重试。',
        retryable,
      },
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
      send(chip.getAttribute('data-question') || '');
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
    const factButton = e.target.closest('[data-fact-action]');
    if (factButton && host.contains(factButton)) {
      const action = factButton.getAttribute('data-fact-action');
      const messageId = factButton.getAttribute('data-message-id');
      if (action === 'undo') void undoProfileFacts(messageId);
      else if (action === 'record') startProfileRecord(messageId, factButton.getAttribute('data-question') || '');
      else if (action === 'extract' || action === 'retry-extract') void extractProfile(messageId);
      else if (action === 'save' || action === 'retry-save') void saveProfile(messageId);
      else if (action === 'cancel') cancelProfile(messageId);
      return;
    }
    const narrativeRetry = e.target.closest('[data-role="qa-narrative-retry"]');
    if (narrativeRetry && host.contains(narrativeRetry)) {
      void runNarrative(
        narrativeRetry.getAttribute('data-question') || '',
        narrativeRetry.getAttribute('data-message-id'),
      );
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
    if (action.kind === 'narrative') {
      void runNarrative(action.question, action.messageId);
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
