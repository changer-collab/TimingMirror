// 全局 AI 助手侧栏 · 页面感知问答（用户端；接口候选，未冻结）
// 页面简介与常见问题来自当前页面；报告/规则页的五个芯片复用 qaChips 与当前账单已发布报告 bundle。
// 本地芯片不请求模型/行情；只有点击“组合表现”才走既有在线复述；自由文本在报告/规则页沿用既有复述能力。
import { el } from './components.js';
import {
  QA_CHIPS,
  buildLocalChipAnswer,
  buildLocalPortfolioAnswer,
  candidateStateOf,
  ruleStateKeyOf,
} from '../agent/qaChips.js';
import {
  CHAT_ONLINE_FALLBACK_TEXT,
  chatFailureText,
  numberCheckDetail,
} from '../agent/chatOnline.js';

const PAGE_LABEL = Object.freeze({ home: '首页', import: '导入', report: '报告', chat: '问答', contract: '规则' });

const FAQ = Object.freeze({
  home: Object.freeze([
    Object.freeze({ id: 'home-start', label: '怎么开始？', question: '怎么开始？', answer: '先在「导入」页选择 CSV、TSV、Excel、文本型 PDF、截图，或直接粘贴文字。核对交易并确认后，报告生成，我才能基于这份账单回答。' }),
    Object.freeze({ id: 'home-benchmark', label: '为什么要和买入不动比？', question: '为什么要和买入不动比？', answer: '同一笔本金、同一段行情，把实际操作和一直持有放在一起对照。差额是事后对照，不是对未来的预测，也不评价当时的决定。' }),
    Object.freeze({ id: 'home-privacy', label: '数据安全吗？', question: '数据安全吗？', answer: '原始账单在本机读取，不上传。只有你主动使用 AI 识别或在线复述时，提取文字、所选截图或问题文本才会发送；不会上传原始 CSV。' }),
  ]),
  import: Object.freeze([
    Object.freeze({ id: 'import-formats', label: '支持哪些文件？', question: '支持哪些文件？', answer: '支持 CSV、TSV、Excel、文本型 PDF、截图/扫描 PDF，也可以直接粘贴账单文字。常规解析在本机完成。' }),
    Object.freeze({ id: 'import-privacy', label: '原始 CSV 会上传吗？', question: '原始 CSV 会上传吗？', answer: '不会。原始文件只在本机读取；只有你点击 AI 识别时，提取出的文字或所选截图才会发送给模型整理交易明细。' }),
    Object.freeze({ id: 'import-confirm', label: '确认前要核对什么？', question: '确认前要核对什么？', answer: '核对日期、标的、方向、价格、数量、费用与税费。缺失值会标注；确认前不会进入报告，也不会用示例数字补齐。' }),
  ]),
  report: Object.freeze([
    Object.freeze({ id: 'report-trust', label: '这些数字可信吗？', question: '这些数字可信吗？', answer: '回答只引用当前账单已发布报告的复核事实；在线复述的数字会再经本机校验。校验通过只表示可识别数字子集通过，不代表事实含义一定正确。' }),
  ]),
  reportEmpty: Object.freeze([
    Object.freeze({ id: 'report-empty', label: '还没有报告怎么办？', question: '还没有报告怎么办？', answer: '先在「导入」页确认账单。报告生成后，五个问题只使用当前账单的已发布结果；报告未发布时不会用示例或其他账单补齐。' }),
  ]),
  chat: Object.freeze([
    Object.freeze({ id: 'chat-scope', label: '问答页支持什么？', question: '问答页支持什么？', answer: '问答页继续复述组合四项已发布事实；右侧助手也提供五个账单问题和页面常见问题，两者共用当前账单上下文。' }),
    Object.freeze({ id: 'chat-privacy', label: '问题文本会发送吗？', question: '问题文本会发送吗？', answer: '只有你点击「组合表现」或主动提交自由文本时，问题文本和最小事实集合才会发送；原始 CSV 不上传。' }),
  ]),
  contract: Object.freeze([
    Object.freeze({ id: 'rule-hit', label: '规则命中后怎么判定？', question: '规则命中后怎么判定？', answer: '以你确认并保存的当前规则为准。命中/未命中来自确定性规则判定，不由 AI 改写，也不会被 AI 判断静默覆盖。' }),
    Object.freeze({ id: 'rule-ai', label: '什么时候用 AI 兜底？', question: '什么时候用 AI 兜底？', answer: '只有模拟情景没有命中任何已锁定规则时，才会请求 AI 判断理由；已有规则命中时仍以规则为准。AI 判断不会保存、不会覆盖规则记录。' }),
    Object.freeze({ id: 'rule-save', label: 'AI 会自动保存规则吗？', question: 'AI 会自动保存规则吗？', answer: '不会。AI 只展示判断理由；新增或修改规则仍需你打开规则编辑入口、确认并保存。' }),
  ]),
});

const ADVICE_RE = /(买什么|卖什么|推荐|荐股|预测|会涨|会跌|止损|止盈|明天|自动交易|下单|买入建议|卖出建议)/i;
let seq = 0;

function nextId() {
  return `qa-${++seq}`;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function isConfirmedLocal(bill) {
  return !!bill && bill.status === 'confirmed' && bill.sourceType === 'local' && !bill.blocked
    && Array.isArray(bill.trades) && bill.trades.length > 0;
}

function billContextId(state) {
  return state.bill?.contextId ?? null;
}

function currentRuleStateKey(state) {
  return ruleStateKeyOf(Array.isArray(state.contracts?.versions) ? state.contracts.versions : []);
}

function qaPending(state) {
  return state.assistant.qaPending === true
    && (state.assistant.qaContextId ?? null) === billContextId(state);
}

export function visibleMessages(state) {
  const contextId = billContextId(state);
  return (Array.isArray(state.assistant.qaMessages) ? state.assistant.qaMessages : [])
    .filter((m) => m.billContextId === null || m.billContextId === undefined || m.billContextId === contextId);
}

function pageContext(state, deps) {
  const bill = state.bill ?? {};
  const confirmed = isConfirmedLocal(bill);
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  const published = bundle?.review?.portfolio_published === true;
  const versions = Array.isArray(state.contracts?.versions) ? state.contracts.versions.length : 0;
  const report = published ? '已发布' : (bundle ? '未发布/阻断' : '尚未载入');
  const asOf = bundle?.asOfDate ?? bill.supportScope?.asOfDate ?? null;
  return `当前页：${PAGE_LABEL[state.route] ?? '页面'} · 账单：${confirmed ? (bill.fileName || '已确认本地账单') : '未确认'} · 报告：${report}${asOf ? ` · 行情截止：${asOf}` : ''}${versions ? ` · 规则版本：${versions}` : ''}`;
}

function chipEntry(chip) {
  return { key: `chip:${chip.id}`, type: 'chip', label: chip.label, question: chip.question, chip };
}

function faqEntry(faq) {
  return { key: `faq:${faq.id}`, type: 'faq', label: faq.label, question: faq.question, faq };
}

export function pageInfo(state, deps) {
  const confirmed = isConfirmedLocal(state.bill);
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(state.bill) : null;
  const published = bundle?.review?.portfolio_published === true;
  const context = pageContext(state, deps);
  if (state.route === 'report') {
    if (!confirmed) {
      return { intro: '当前还没有可报告的真实账单。先导入并确认账单，我才能基于已发布报告回答。', context, chips: FAQ.reportEmpty.map(faqEntry) };
    }
    return {
      intro: '当前是报告页。下面五个问题只读取这份账单的已发布报告；「组合表现」会请求在线复述，其他芯片优先使用本地事实。',
      context,
      chips: [...QA_CHIPS.map(chipEntry), ...FAQ.report.map(faqEntry)],
    };
  }
  if (state.route === 'chat') {
    return {
      intro: confirmed
        ? '当前是事实问答页。右侧助手也接入这份账单的五个问题和页面 FAQ；「组合表现」会请求在线复述。'
        : '当前是事实问答页。先导入并确认账单，才能基于已发布报告回答。',
      context,
      chips: confirmed ? [...QA_CHIPS.map(chipEntry), ...FAQ.chat.map(faqEntry)] : FAQ.reportEmpty.map(faqEntry),
    };
  }
  if (state.route === 'contract') {
    return {
      intro: confirmed
        ? '当前是规则页。已有规则命中时以规则为准；只有模拟情景没有命中任何已锁定规则时，才考虑 AI 兜底判断。'
        : '当前是规则页。可以描述规则并确认保存；账单问题在导入并生成报告后可回答。',
      context,
      chips: [...(confirmed ? QA_CHIPS.map(chipEntry) : []), ...FAQ.contract.map(faqEntry)],
    };
  }
  if (state.route === 'import') {
    return {
      intro: '当前是导入页。账单在本机读取和校验；确认后生成报告，随后可以基于已发布结果提问。',
      context,
      chips: FAQ.import.map(faqEntry),
    };
  }
  return {
    intro: '当前是首页。先导入并确认一份账单，我会基于这份账单的已发布报告回答。',
    context,
    chips: FAQ.home.map(faqEntry),
  };
}

function patchQa(ctx, patch) {
  const state = ctx.state;
  ctx.set({ assistant: { ...state.assistant, ...patch } });
}

function appendLocal(ctx, userText, bot, contextId = null) {
  const state = ctx.state;
  patchQa(ctx, {
    qaMessages: [...(state.assistant.qaMessages ?? []), {
      id: nextId(), role: 'user', text: userText, billContextId: contextId,
    }, { ...bot, billContextId: contextId }],
    qaInput: '',
    qaPending: false,
    qaRequestId: null,
    qaContextId: null,
    qaNotice: null,
  });
}

function localNotice(text, tag = '页面说明', detail = null) {
  return { id: nextId(), role: 'assistant', kind: 'notice', text, tag, tone: 'ok', detail, billContextId: null };
}

function localFailure(text, code = null, link = null) {
  return {
    id: nextId(),
    role: 'assistant',
    kind: 'notice',
    text,
    tag: '本地暂不可用',
    tone: 'warn',
    detail: code ? `原因：${code}` : null,
    link,
    billContextId: null,
  };
}

function onlineFailure(result) {
  const code = result?.code ?? 'E_CHAT_UNEXPECTED';
  return {
    id: nextId(),
    role: 'assistant',
    kind: 'notice',
    text: CHAT_ONLINE_FALLBACK_TEXT,
    tag: '在线复述已兜底',
    tone: 'warn',
    detail: `原因：${chatFailureText(code)}（${String(code)}）${result?.message ? `；${result.message}` : ''}`,
    link: code === 'W_QA_REPORT_NOT_READY' || code === 'W_CHAT_REVIEW_UNAVAILABLE' ? { href: '#/report', label: '打开报告页' } : null,
  };
}

function onlineSuccess(result) {
  return {
    id: nextId(),
    role: 'assistant',
    kind: 'online',
    online: true,
    text: result.text,
    tag: '在线复述 · 本机数字校验通过',
    detail: `${numberCheckDetail(result.number_check)}；仅表示可识别数字子集检查通过，不代表事实含义正确。`,
  };
}

function chipMessage(chip, answer, state) {
  return {
    id: nextId(),
    role: 'assistant',
    kind: 'chip',
    chipId: chip.id,
    billContextId: billContextId(state),
    ruleStateKey: currentRuleStateKey(state),
    answer,
    tag: '本地事实 · 无模型请求',
    tone: 'ok',
    detail: `计划模板：${answer.template_id ?? '—'}（${answer.plan_status ?? '—'}）；只读取当前账单报告缓存，不执行模型或行情请求。`,
  };
}

function candidateNode(message, candidate, ctx) {
  const tone = candidate.status === 'available' ? 'loss' : candidate.status === 'active' ? 'ok' : 'mode';
  const box = el('div', { class: 'qa-candidate rp-candidate' }, [
    el('div', { class: 'rp-candidate-top' }, [
      el('span', { class: `rp-badge ${tone}` }, [candidate.status_text]),
      el('strong', {}, [candidate.template_name]),
    ]),
    el('p', { class: 'rp-candidate-text' }, [candidate.text]),
  ]);
  if (candidate.reason || candidate.basis || (Array.isArray(candidate.evidence) && candidate.evidence.length)) {
    const details = [];
    if (candidate.reason) details.push(el('p', { class: 'rp-note' }, [candidate.reason]));
    if (candidate.basis) details.push(el('p', { class: 'rp-note' }, [candidate.basis]));
    if (Array.isArray(candidate.evidence) && candidate.evidence.length) {
      details.push(el('ul', { class: 'rp-evidence' }, candidate.evidence.map((e) => el('li', {}, [
        el('span', { class: 'mono' }, [e.trade_id]),
        ` · ${e.line}`,
      ]))));
    }
    box.append(el('details', { class: 'qa-disclosure' }, [
      el('summary', {}, ['规则说明与依据']),
      el('div', { class: 'qa-disclosure-body' }, details),
    ]));
  }
  box.append(el('p', { class: 'rp-caveat' }, [candidate.caveat]));
  if (candidate.status === 'available') {
    box.append(el('div', { class: 'rp-actions' }, [
      el('button', {
        class: 'btn primary small',
        type: 'button',
        'data-role': 'qa-open-candidate',
        onclick: () => {
          const deps = ctx.qaDeps ?? {};
          if (typeof deps.openRuleCandidate === 'function') deps.openRuleCandidate(ctx, candidate);
        },
      }, ['打开规则模板确认']),
    ]));
  } else if (candidate.status === 'dismissed') {
    box.append(el('p', { class: 'fine' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => ctx.go('rules') }, ['到规则页恢复候选']),
    ]));
  } else if (candidate.status === 'active') {
    box.append(el('p', { class: 'fine' }, [
      el('button', { class: 'btn small', type: 'button', onclick: () => ctx.go('rules') }, ['查看当前规则']),
    ]));
  }
  return box;
}

function chipAnswerNode(message, ctx) {
  const answer = message.answer;
  const box = el('div', { class: 'qa-msg-text' }, [answer.text]);
  if (Array.isArray(answer.facts) && answer.facts.length) {
    box.append(el('dl', { class: 'qa-facts' }, answer.facts.map((f) => el('div', {}, [
      el('dt', {}, [f.label]),
      el('dd', {}, [f.value]),
    ]))));
  }
  if (Array.isArray(answer.evidence) && answer.evidence.length) {
    box.append(el('details', { class: 'qa-disclosure' }, [
      el('summary', {}, [`证据与来源（${answer.evidence.length} 条）`]),
      el('ul', { class: 'qa-evidence' }, answer.evidence.map((line) => el('li', {}, [line]))),
    ]));
  }
  const candidate = candidateStateOf(message, currentRuleStateKey(ctx.state));
  if (candidate.has) {
    if (candidate.stale) {
      box.append(el('div', { class: 'qa-stale' }, [candidate.notice]));
      box.append(el('div', { class: 'qa-actions' }, [
        el('button', { class: 'btn small', type: 'button', onclick: () => ctx.go('rules') }, ['查看当前规则']),
      ]));
    } else {
      box.append(candidateNode(message, candidate.candidate, ctx));
    }
  }
  if (answer.notice && !(candidate.has && candidate.stale)) box.append(el('p', { class: 'qa-notice' }, [answer.notice]));
  return box;
}

function messageNode(message, ctx) {
  if (message.role === 'user') {
    return el('div', { class: 'assistant-msg user qa-msg' }, [message.text]);
  }
  const box = el('div', { class: 'assistant-msg assistant qa-msg' });
  if (message.kind === 'chip' && message.answer) box.append(chipAnswerNode(message, ctx));
  else box.append(el('div', { class: 'qa-msg-text' }, [message.text]));
  if (message.link) box.append(el('div', { class: 'qa-link-row' }, [
    el('a', { class: 'qa-link', href: message.link.href }, [message.link.label]),
  ]));
  if (message.tag) box.append(el('div', { class: 'qa-tag' }, [message.tag]));
  if (message.detail) {
    box.append(el('details', { class: 'assistant-tech' }, [
      el('summary', {}, ['技术详情']),
      el('div', { class: 'assistant-tech-body' }, [message.detail]),
    ]));
  }
  return box;
}

async function ensureBundle(ctx) {
  const state = ctx.state;
  const deps = ctx.qaDeps ?? {};
  const bill = state.bill;
  if (!isConfirmedLocal(bill)) {
    return { ok: false, code: 'W_QA_BILL_NOT_CONFIRMED', message: '当前没有已确认的本地账单：请先在导入页确认账单。' };
  }
  const cached = typeof deps.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  if (cached) return { ok: true, bundle: cached };
  if (typeof deps.loadReportBundle !== 'function') {
    return { ok: false, code: 'W_QA_REPORT_NOT_READY', message: '当前页面没有接入报告加载：请先打开报告页。' };
  }
  try {
    const bundle = await deps.loadReportBundle(bill);
    if (!bundle) return { ok: false, code: 'W_QA_REPORT_NOT_READY', message: '当前账单的已发布报告尚未载入。' };
    return { ok: true, bundle };
  } catch (e) {
    return { ok: false, code: 'W_QA_REPORT_NOT_READY', message: `报告加载失败：${String(e && e.message ? e.message : e).slice(0, 200)}` };
  }
}

function isCurrentRequest(ctx, requestId, contextId) {
  return ctx.state.assistant.qaRequestId === requestId && billContextId(ctx.state) === contextId;
}

function finishRequest(ctx, requestId, contextId, bot) {
  const state = ctx.state;
  if (state.assistant.qaRequestId !== requestId || billContextId(state) !== contextId) return;
  ctx.set({
    assistant: {
      ...state.assistant,
      qaMessages: [...(state.assistant.qaMessages ?? []), { ...bot, billContextId: contextId }],
      qaPending: false,
      qaRequestId: null,
      qaContextId: null,
    },
  });
}

function findEntry(text, state, deps) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const chips = pageInfo(state, deps).chips;
  return chips.find((entry) => normalizeText(entry.question) === normalized || normalizeText(entry.label) === normalized) ?? null;
}

export async function sendChip(ctx, entry, { source = 'click', text = null } = {}) {
  const state = ctx.state;
  if (qaPending(state)) return;
  const question = normalizeText(text ?? entry.question);
  if (!question) return;
  if (entry.type === 'faq') {
    appendLocal(ctx, question, {
      ...localNotice(entry.faq.answer, '页面说明'),
      billContextId: null,
    });
    return;
  }
  const contextId = billContextId(state);
  const userMessage = { id: nextId(), role: 'user', text: question, billContextId: contextId };
  if (!isConfirmedLocal(state.bill)) {
    appendLocal(ctx, question, localFailure(
      '当前还没有已确认的本地账单。请先在导入页确认账单，报告生成后再问账单问题。',
      'W_QA_BILL_NOT_CONFIRMED',
      { href: '#/import', label: '去导入账单' },
    ));
    return;
  }
  const deps = ctx.qaDeps ?? {};
  const onlineClick = entry.chip.online && source === 'click';
  if (!onlineClick) {
    const cached = typeof deps.getReportBundle === 'function' ? deps.getReportBundle(state.bill) : null;
    if (!cached) {
      appendLocal(ctx, question, localFailure(
        '当前账单报告尚未载入：本地芯片只读取已缓存的已发布报告，不会启动报告或行情加载。请先打开报告页，再回来提问。',
        'W_QA_REPORT_NOT_CACHED',
        { href: '#/report', label: '打开报告页' },
      ), contextId);
      return;
    }
    let answer;
    if (entry.chip.online) {
      answer = buildLocalPortfolioAnswer({ chip: entry.chip, bundle: cached, bill: state.bill });
    } else {
      let ruleState = null;
      let profile = null;
      try { ruleState = typeof deps.ruleStateOf === 'function' ? deps.ruleStateOf(state.contracts?.versions) : null; } catch { ruleState = null; }
      try { profile = typeof deps.loadProfile === 'function' ? deps.loadProfile() : null; } catch { profile = null; }
      answer = buildLocalChipAnswer({ chip: entry.chip, bundle: cached, bill: state.bill, ruleState, profile });
    }
    if (!answer.ok) {
      appendLocal(ctx, question, localFailure(answer.message, answer.code, { href: '#/report', label: '打开报告页' }), contextId);
      return;
    }
    patchQa(ctx, {
      qaMessages: [...(state.assistant.qaMessages ?? []), userMessage, chipMessage(entry.chip, answer, state)],
      qaInput: '',
      qaPending: false,
      qaRequestId: null,
      qaContextId: null,
      qaNotice: null,
    });
    return;
  }
  const requestId = nextId();
  patchQa(ctx, {
    qaMessages: [...(state.assistant.qaMessages ?? []), userMessage],
    qaInput: '',
    qaPending: true,
    qaRequestId: requestId,
    qaContextId: contextId,
    qaNotice: null,
  });
  const loaded = await ensureBundle(ctx);
  if (!isCurrentRequest(ctx, requestId, contextId)) return;
  if (!loaded.ok) {
    finishRequest(ctx, requestId, contextId, localFailure(loaded.message, loaded.code, { href: '#/report', label: '打开报告页' }));
    return;
  }
  let result;
  try {
    result = typeof deps.askOnline === 'function'
      ? await deps.askOnline({ question: entry.chip.question, review: loaded.bundle.review })
      : null;
  } catch {
    result = { ok: false, code: 'E_CHAT_UNEXPECTED' };
  }
  if (!isCurrentRequest(ctx, requestId, contextId)) return;
  finishRequest(ctx, requestId, contextId, result?.ok ? onlineSuccess(result) : onlineFailure(result));
}

export async function sendText(ctx, raw) {
  const state = ctx.state;
  const deps = ctx.qaDeps ?? {};
  if (qaPending(state)) return;
  const text = normalizeText(raw);
  if (!text) return;
  const entry = findEntry(text, state, deps);
  if (entry) {
    await sendChip(ctx, entry, { source: 'text', text });
    return;
  }
  const contextId = billContextId(state);
  const userMessage = { id: nextId(), role: 'user', text, billContextId: contextId };
  if (!isConfirmedLocal(state.bill)) {
    appendLocal(ctx, text, localFailure(
      '当前还没有已确认的本地账单。你可以先问当前页面的操作问题，或去导入页确认账单后再问账单问题。',
      'W_QA_BILL_NOT_CONFIRMED',
      { href: '#/import', label: '去导入账单' },
    ));
    return;
  }
  if (state.route === 'contract') {
    appendLocal(ctx, text, localNotice(
      '当前是规则页。新增或修改规则请使用下方“让 AI 理解”输入框；账单问题请点上方芯片，或到报告页自由提问。',
      '页面提示',
      'W_QA_RULE_PAGE',
    ), contextId);
    return;
  }
  if (state.route !== 'report' && state.route !== 'chat') {
    appendLocal(ctx, text, localNotice(
      '当前页面没有可用的已发布报告上下文。请先打开报告页，或在报告/问答/规则页使用五个账单问题入口。',
      '页面提示',
      'W_QA_PAGE_CONTEXT',
    ), contextId);
    return;
  }
  if (ADVICE_RE.test(text)) {
    appendLocal(ctx, text, localNotice(
      '镜子不提供买卖建议、涨跌预测或荐股。可以问这份账单已经发生的事实、行为证据，或怎么改写自己的提醒规则。',
      '本地边界',
      'W_QA_ADVICE_BLOCKED',
    ), contextId);
    return;
  }
  const cached = typeof deps.getReportBundle === 'function' ? deps.getReportBundle(state.bill) : null;
  if (!cached) {
    appendLocal(ctx, text, localFailure(
      '当前账单报告尚未载入：自由提问只使用已缓存的已发布报告，不会启动报告或行情加载。请先打开报告页，再回来提问。',
      'W_QA_REPORT_NOT_CACHED',
      { href: '#/report', label: '打开报告页' },
    ), contextId);
    return;
  }
  const requestId = nextId();
  patchQa(ctx, {
    qaMessages: [...(state.assistant.qaMessages ?? []), userMessage],
    qaInput: '',
    qaPending: true,
    qaRequestId: requestId,
    qaContextId: contextId,
    qaNotice: null,
  });
  let result;
  try {
    result = typeof deps.askOnline === 'function'
      ? await deps.askOnline({ question: text, review: cached.review })
      : null;
  } catch {
    result = { ok: false, code: 'E_CHAT_UNEXPECTED' };
  }
  if (!isCurrentRequest(ctx, requestId, contextId)) return;
  finishRequest(ctx, requestId, contextId, result?.ok ? onlineSuccess(result) : onlineFailure(result));
}

export function renderQaAssistant(ctx) {
  const state = ctx.state;
  const deps = ctx.qaDeps ?? {};
  const info = pageInfo(state, deps);
  const root = el('section', { class: 'qa-assistant', 'aria-label': 'AI 页面问答' });
  root.append(el('div', { class: 'qa-page' }, [
    el('p', { class: 'qa-page-intro' }, [info.intro]),
    el('p', { class: 'qa-context' }, [info.context]),
  ]));
  const chips = el('div', { class: 'qa-chips' }, info.chips.map((entry) => el('button', {
    class: `qa-chip${entry.chip?.online ? ' is-online' : ''}`,
    type: 'button',
    title: entry.question,
    disabled: qaPending(state) ? 'disabled' : null,
    onclick: () => sendChip(ctx, entry),
  }, [entry.label])));
  root.append(chips);
  const messages = el('div', { class: 'assistant-messages qa-messages' }, visibleMessages(state).map((m) => messageNode(m, ctx)));
  if (qaPending(state)) {
    messages.append(el('div', { class: 'assistant-msg assistant qa-pending' }, ['正在读取当前页面信息…']));
  }
  root.append(messages);
  const form = el('form', { class: 'qa-form' });
  const input = el('textarea', {
    class: 'input qa-input',
    rows: '2',
    maxlength: '200',
    placeholder: '问当前页面或这份账单…',
    disabled: qaPending(state) ? 'disabled' : null,
  });
  input.value = state.assistant.qaInput ?? '';
  input.addEventListener('input', () => { state.assistant.qaInput = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
    }
  });
  form.append(input, el('button', {
    class: 'btn primary small',
    type: 'submit',
    disabled: qaPending(state) ? 'disabled' : null,
  }, [qaPending(state) ? '处理中…' : '发送']));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendText(ctx, input.value);
  });
  root.append(form);
  root.append(el('p', { class: 'qa-fine' }, [
    '本地问题不请求模型；只有点击「组合表现」或报告/规则页自由提问才会请求在线复述。原始账单不上传。',
  ]));
  return root;
}
