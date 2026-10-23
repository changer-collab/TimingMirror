// 全局 AI 助手 · 当前页面帮助（用户端；接口候选，未冻结）
// 只做页面说明、操作步骤、隐私说明和当前可见状态/数字的解释；
// 不做账单问答、不调用在线复述、不做画像记录，也不加载报告或行情。
import { el } from './components.js';
import { isPageHelpQuestion } from '../agent/pageHelp.js';

const PAGE_LABEL = Object.freeze({ home: '首页', import: '导入', report: '报告', chat: '问答', contract: '规则' });
const BILL_LABEL = Object.freeze({
  none: '未选择',
  loaded: '待确认',
  invalid: '需修正',
  error: '读取失败',
  confirmed: '已确认',
});
const FACT_LABELS = Object.freeze({
  buyCost: '买入成本',
  sellProceeds: '卖出所得',
  actualValue: '期末实际价值',
  ghostValue: '一直持有价值',
  actualRet: '实际收益',
  ghostRet: '对照收益',
  dragMoney: '择时差额',
  drag: '择时差',
});

let seq = 0;

function nextId() {
  return `help-${++seq}`;
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

function topic(id, label, question, answer, handoffQuestion = null) {
  return Object.freeze({ id, label, question, answer, handoffQuestion });
}

const HELP = Object.freeze({
  home: Object.freeze([
    topic('home-start', '怎么开始？', '怎么开始？',
      '先在「导入」页选择账单文件或粘贴文字，核对交易并确认。报告生成后，问答页才能围绕这份账单做完整复盘。'),
    topic('home-assistant', '这个助手能做什么？', '这个助手能做什么？',
      '我只说明当前页面的操作、隐私和可见状态。组合表现、最错一笔、反事实和规则复盘请去问答页继续。'),
    topic('home-privacy', '数据安全吗？', '数据安全吗？',
      '原始 CSV 只在本机读取，不上传。这里的页面帮助和本地回答不发送；问答页本地未匹配的问法会先发送问题文本理解问法；在线复述会发送问题和所需已核对数字；画像记录只在你主动选择并确认后发送该陈述。'),
  ]),
  import: Object.freeze([
    topic('import-formats', '支持哪些文件？', '支持哪些文件？',
      '支持 CSV、TSV、Excel、文本型 PDF、截图/扫描 PDF，也可以直接粘贴账单文字。常规解析在本机完成。'),
    topic('import-privacy', '原始 CSV 会上传吗？', '原始 CSV 会上传吗？',
      '不会。原始文件只在本机读取；只有你主动使用 AI 识别时，提取出的文字或所选截图才会发送给模型整理交易明细。这里的页面帮助不发送。'),
    topic('import-confirm', '确认前要核对什么？', '确认前要核对什么？',
      '核对日期、标的、方向、价格、数量、费用与税费。缺失值会标注；确认前不会进入报告，也不会用示例数字补齐。'),
    topic('import-error', '读取或校验失败怎么办？', '读取或校验失败怎么办？',
      '按导入页的提示修正格式或重新识别；系统不会回退到示例报告或示例问答，也不会用其他数据补上。'),
  ]),
  report: Object.freeze([
    topic('report-meaning', '这些数字是什么意思？', '这些数字是什么意思？',
      '组合四项是实际收益、对照收益（买入不动）、择时损耗和损耗金额。它们是对已发生交易的事后对照，不是预测，也不评价当时的决定。',
      '解释当前组合的实际收益、对照收益和择时损耗'),
    topic('report-trust', '这些数字可信吗？', '这些数字可信吗？',
      '这里只解释当前页可见的已发布数字；缺价、未发布或未纳入的数字不会用替代数据补齐。完整核对请打开报告页的“数字与来源”，或在问答页继续。',
      '这些数可信吗？'),
    topic('report-withheld', '为什么没有结果？', '为什么没有结果？',
      '组合结果未发布时，报告页会说明是缺价、复核未通过还是行情阻断。这里不会用一个替代数字补上。'),
    topic('report-source', '数据从哪里来？', '数据从哪里来？',
      '报告使用你确认的本地账单，以及服务端从 Tushare 获取的最新已收盘日线（非实时）；合成回归场景会明确标注。'),
  ]),
  chat: Object.freeze([
    topic('chat-how', '问答页怎么用？', '问答页怎么用？',
      '问答页只有一个输入框。先给本地确定性回答和证据；需要在线复述时，在组合回答上单独点击。完整复盘就在这里继续问。'),
    topic('chat-profile', '画像怎么记录？', '画像怎么记录？',
      '在问答页的回答下选择“记入画像”，先确认发送该陈述，再查看候选事实和原文证据，确认后才保存。保存后可撤销，个人中心可删除。'),
    topic('chat-privacy', '会发送什么？', '会发送什么？',
      '本地回答不发送；本地未匹配的问法会发送问题文本理解问法；在线复述发送问题和所需已核对数字；画像提取只在你主动选择并确认后发送该陈述。原始 CSV 不上传。'),
    topic('chat-evidence', '证据在哪里看？', '证据在哪里看？',
      '回答里的“证据”可以展开公式和回源；更完整的数字与来源在报告页。'),
  ]),
  contract: Object.freeze([
    topic('rule-save', '规则怎么保存？', '规则怎么保存？',
      '规则工作区里新增、修改、停用和版本记录都由你确认；保存后才会生效，不会自动交易。'),
    topic('rule-test', '规则怎么测试？', '规则怎么测试？',
      '操作复盘会按当前规则逐笔对照账单；具体判定以你保存的规则为准，不由 AI 改写。',
      '我的规则守得住吗？'),
    topic('rule-privacy', '规则保存在哪里？', '规则保存在哪里？',
      '规则保存在当前浏览器；云端只保存账单统计、报告快照和你主动记录的画像事实，不保存原始 CSV 或文件名。'),
  ]),
});

function routeHelpKey(route) {
  return HELP[route] ? route : 'home';
}

function pageIntro(state) {
  if (state.route === 'import') return '我说明导入格式、确认前检查和数据边界；不会读取或上传原始 CSV。';
  if (state.route === 'report') return '我说明当前页可见数字的含义、来源和状态；完整证据与追问请去报告细节或问答页。';
  if (state.route === 'chat') return '问答页的完整问答在下方输入区；这里只说明本页操作、画像记录和隐私。';
  if (state.route === 'contract') return '我说明规则保存与测试的入口；具体判定以你保存的规则为准。';
  return '我说明当前页面的操作、隐私和可见状态；账单的完整复盘请在导入并确认后去问答页。';
}

function pageContext(state, deps) {
  const bill = state.bill ?? {};
  const confirmed = isConfirmedLocal(bill);
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  const published = bundle?.review?.portfolio_published === true;
  const report = bundle ? (published ? '已发布' : '未发布') : '尚未载入';
  const asOf = bundle?.asOfDate ?? bundle?.valuation?.effective_date ?? bill.supportScope?.asOfDate ?? null;
  const billLabel = bill.demo === true
    ? '示例账单'
    : confirmed ? '已确认本地账单' : (BILL_LABEL[bill.status] ?? '未选择');
  return `当前页：${PAGE_LABEL[state.route] ?? '首页'} · 账单：${billLabel} · 报告：${report}${asOf ? ` · 行情截止：${asOf}` : ''}`;
}

function publishedPortfolioValues(bundle) {
  const facts = Array.isArray(bundle?.review?.published_facts) ? bundle.review.published_facts : [];
  const byKey = new Map(facts.filter((f) => f?.scope === 'portfolio').map((f) => [f.key, f]));
  const keys = ['actualRet', 'ghostRet', 'drag', 'dragMoney'];
  const values = {};
  for (const key of keys) {
    const fact = byKey.get(key);
    if (fact && typeof fact.display === 'string') values[key] = fact.display;
  }
  return values;
}

function importStatus(state) {
  const bill = state.bill ?? {};
  if (bill.status === 'none') {
    return {
      title: '导入账单',
      lines: ['还没有选择账单。可以导入 CSV、TSV、Excel、文本型 PDF、截图，或直接粘贴文字。'],
      actions: [{ href: '#/import', label: '去导入账单' }],
    };
  }
  if (bill.status === 'invalid' || bill.status === 'error') {
    return {
      title: '账单状态',
      lines: ['账单读取或校验未通过；请按导入页提示修正。助手不会用示例或替代数字补齐。'],
      actions: [{ href: '#/import', label: '去修正账单' }],
    };
  }
  if (bill.status === 'loaded') {
    return {
      title: '账单状态',
      lines: ['账单已载入，尚未确认；确认后才会生成报告。'],
      actions: [{ href: '#/import', label: '核对并确认' }],
    };
  }
  if (isConfirmedLocal(bill)) {
    return {
      title: '账单状态',
      lines: ['账单已确认；可以打开报告页查看已发布结果，或去问答页继续复盘。'],
      actions: [
        { href: '#/report', label: '打开报告页' },
        ...(isConfirmedLocal(bill) ? [{ handoffQuestion: '这份账单的组合表现如何？', label: '去问答页继续' }] : []),
      ],
    };
  }
  if (bill.demo === true) {
    return {
      title: '账单状态',
      lines: ['当前是示例账单；示例结果不写入画像，也不参与在线复述。'],
      actions: [{ href: '#/import', label: '导入自己的账单' }],
    };
  }
  return null;
}

function reportStatus(state, deps) {
  const bill = state.bill ?? {};
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  if (!bundle) {
    return {
      title: '当前报告',
      lines: ['报告还没有载入到当前页；打开报告页查看后，我可以说明可见数字的含义。'],
      actions: [{ href: '#/report', label: '打开报告页' }],
    };
  }
  const published = bundle.review?.portfolio_published === true;
  const scope = state.report?.symbol || 'pool';
  if (scope !== 'pool') {
    const facts = Array.isArray(bundle.review?.published_facts) ? bundle.review.published_facts : [];
    const symbolFacts = facts.filter((fact) => fact?.scope === scope).slice(0, 4);
    if (symbolFacts.length) {
      const lines = symbolFacts.map((fact) => `${FACT_LABELS[fact.key] ?? '数字'} ${fact.display ?? '—'}`);
      lines.push('当前页是单标的视图；完整公式与来源在报告页。');
      if (!published) lines.push('组合结果尚未发布；这里只解释该标的已发布数字，不生成组合结论。');
      const actions = [{ href: '#/report', label: '在报告页看证据' }];
      if (published) actions.push({ handoffQuestion: '这些数字是怎么算出来的？', label: '去问答页继续' });
      return { title: '当前报告', lines, actions };
    }
    if (!published) {
      return {
        title: '当前报告',
        lines: ['当前报告的组合结果未发布；报告页会说明是缺价、复核未通过还是行情阻断。这里不会用替代数字补齐。'],
        actions: [{ href: '#/report', label: '查看原因' }],
      };
    }
    return {
      title: '当前报告',
      lines: ['当前标的的已发布数字在报告页；这里不会用其他标的或示例数字补齐。'],
      actions: [{ href: '#/report', label: '查看原因' }],
    };
  }
  if (!published) {
    return {
      title: '当前报告',
      lines: ['当前报告的组合结果未发布；报告页会说明是缺价、复核未通过还是行情阻断。这里不会用替代数字补齐。'],
      actions: [{ href: '#/report', label: '查看原因' }],
    };
  }
  const values = publishedPortfolioValues(bundle);
  const complete = ['actualRet', 'ghostRet', 'drag', 'dragMoney'].every((key) => typeof values[key] === 'string');
  const lines = complete
    ? [
      `实际收益 ${values.actualRet} · 对照收益 ${values.ghostRet}`,
      `择时损耗 ${values.drag} · 损耗金额 ${values.dragMoney}`,
      '这些是已发生交易的事后对照，不是预测。',
    ]
    : ['组合结果已发布，但当前页没有完整的四项数字；报告页会展示完整内容，这里不做缺项替代。'];
  return {
    title: '当前报告',
    lines,
    actions: [
      { href: '#/report', label: '在报告页看证据' },
      { handoffQuestion: '解释当前组合的实际收益、对照收益和择时损耗', label: '去问答页继续' },
    ],
  };
}

function contractStatus() {
  return {
    title: '规则与复盘',
    lines: ['规则保存在当前浏览器；保存、停用和版本记录都由你确认。规则只做提醒，不会自动交易。'],
    actions: [
      { href: '#/me', label: '打开规则工作区' },
      { href: '#/scenario', label: '打开操作复盘' },
      { handoffQuestion: '我的规则守得住吗？', label: '去问答页继续' },
    ],
  };
}

function pageStatus(state, deps) {
  if (state.route === 'import') return importStatus(state);
  if (state.route === 'report') return reportStatus(state, deps);
  if (state.route === 'contract') return contractStatus();
  return null;
}

export function pageHelpInfo(state, deps = {}) {
  const key = routeHelpKey(state.route);
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(state.bill) : null;
  const reportBlocked = state.route === 'report' && !!bundle && bundle.review?.portfolio_published !== true;
  const canHandoff = isConfirmedLocal(state.bill) && state.route !== 'chat' && !reportBlocked;
  return {
    intro: pageIntro(state),
    context: pageContext(state, deps),
    topics: HELP[key],
    status: pageStatus(state, deps),
    canHandoff,
    reportBlocked,
    showInput: state.route !== 'chat',
  };
}

function allTopics() {
  return Object.values(HELP).flat();
}

function findTopic(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  return allTopics().find((item) => normalizeText(item.question) === normalized || normalizeText(item.label) === normalized) ?? null;
}

export function visibleHelpMessages(state) {
  const contextId = billContextId(state);
  return (Array.isArray(state.assistant?.qaMessages) ? state.assistant.qaMessages : [])
    .filter((message) => (message?.kind === 'help' || message?.kind === 'help-user')
      && (message.billContextId === null || message.billContextId === undefined || message.billContextId === contextId));
}

function appendHelp(ctx, text, assistant) {
  const state = ctx.state;
  const contextId = billContextId(state);
  const messages = [
    ...(Array.isArray(state.assistant.qaMessages) ? state.assistant.qaMessages : []),
    { id: nextId(), role: 'user', kind: 'help-user', text, billContextId: contextId },
    { id: nextId(), role: 'assistant', kind: 'help', tag: '页面帮助', billContextId: contextId, ...assistant },
  ];
  ctx.set({ assistant: { ...state.assistant, qaMessages: messages, qaInput: '' } });
}

export function sendHelpText(ctx, raw) {
  const state = ctx.state;
  const text = normalizeText(raw);
  if (!text) return;
  const info = pageHelpInfo(state, ctx.qaDeps ?? {});
  const matched = findTopic(text);
  if (matched) {
    appendHelp(ctx, text, {
      text: matched.answer,
      handoff: matched.handoffQuestion && info.canHandoff ? { question: matched.handoffQuestion } : null,
    });
    return;
  }
  if (isPageHelpQuestion(text)) {
    appendHelp(ctx, text, {
      text: '这是页面帮助问题。可以先看下面的帮助主题；这里只说明当前页面的操作、隐私和可见状态。',
    });
    return;
  }
  if (info.canHandoff) {
    appendHelp(ctx, text, {
      text: '我这边只能说明当前页面的操作、隐私和可见状态。你可以先看下面的帮助主题；如果这是账单分析问题，可以在问答页继续。',
      handoff: { question: text },
    });
    return;
  }
  if (info.reportBlocked) {
    appendHelp(ctx, text, {
      text: '我这边只能说明当前页面的操作、隐私和可见状态。你可以先看下面的帮助主题；当前报告结果尚未发布，完整复盘请先在报告页查看原因。',
      link: { href: '#/report', label: '打开报告页' },
    });
    return;
  }
  appendHelp(ctx, text, {
    text: '我这边只能说明当前页面的操作、隐私和可见状态。你可以先看下面的帮助主题；需要完整复盘的话，请先导入并确认账单。',
    link: { href: '#/import', label: '去导入账单' },
  });
}

function handoffButton(question, label, ctx) {
  return el('button', {
    class: 'btn small',
    type: 'button',
    'data-role': 'assistant-handoff',
    onclick: () => {
      if (typeof ctx.handoffToQa === 'function') ctx.handoffToQa({ question });
    },
  }, [label]);
}

function statusNode(status, ctx, info) {
  if (!status) return null;
  const box = el('div', { class: 'qa-status-card' }, [
    el('div', { class: 'qa-status-title' }, [status.title]),
    ...status.lines.map((line) => el('p', { class: 'qa-status-line' }, [line])),
  ]);
  const actions = [];
  for (const action of Array.isArray(status.actions) ? status.actions : []) {
    if (action.handoffQuestion && info.canHandoff) {
      actions.push(handoffButton(action.handoffQuestion, action.label, ctx));
    } else if (action.href) {
      actions.push(el('a', { class: 'btn small', href: action.href }, [action.label]));
    }
  }
  if (actions.length) box.append(el('div', { class: 'row qa-actions' }, actions));
  return box;
}

function topicsNode(topics, ctx, info) {
  const box = el('div', { class: 'qa-help-topics' });
  for (const item of topics) {
    const details = el('details', { class: 'qa-help-topic' }, [
      el('summary', {}, [item.label]),
      el('p', { class: 'qa-help-answer' }, [item.answer]),
    ]);
    if (item.handoffQuestion && info.canHandoff) {
      details.append(el('div', { class: 'row qa-actions' }, [handoffButton(item.handoffQuestion, '去问答页继续', ctx)]));
    }
    box.append(details);
  }
  return box;
}

function helpMessageNode(message, ctx, info) {
  const box = el('div', { class: 'assistant-msg assistant qa-msg' }, [
    el('div', { class: 'qa-msg-text' }, [message.text]),
  ]);
  if (message.link) {
    box.append(el('div', { class: 'qa-link-row' }, [
      el('a', { class: 'qa-link', href: message.link.href }, [message.link.label]),
    ]));
  }
  if (message.handoff && info.canHandoff) {
    box.append(el('div', { class: 'row qa-actions' }, [
      handoffButton(message.handoff.question, '去问答页继续', ctx),
    ]));
  }
  if (message.tag) box.append(el('div', { class: 'qa-tag' }, [message.tag]));
  return box;
}

function messagesNode(messages, ctx, info) {
  const box = el('div', { class: 'assistant-messages qa-messages', role: 'log', 'aria-live': 'polite' });
  for (const message of messages) {
    if (message.kind === 'help-user') {
      box.append(el('div', { class: 'assistant-msg user qa-msg' }, [message.text]));
    } else {
      box.append(helpMessageNode(message, ctx, info));
    }
  }
  return box;
}

function helpForm(ctx, info) {
  const form = el('form', { class: 'qa-form' });
  const input = el('textarea', {
    class: 'input qa-input assistant-help-input',
    rows: '2',
    maxlength: '200',
    placeholder: '问当前页面的操作或说明…',
    'data-role': 'assistant-help-input',
  });
  input.value = ctx.state.assistant.qaInput ?? '';
  input.addEventListener('input', () => { ctx.state.assistant.qaInput = input.value; });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
    }
  });
  form.append(input, el('button', { class: 'btn primary small', type: 'submit' }, ['查看说明']));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    sendHelpText(ctx, input.value);
  });
  if (!info.canHandoff) {
    form.append(el('p', { class: 'qa-fine' }, [
      info.reportBlocked
        ? '当前报告结果未发布；需要完整复盘时，请先在报告页查看原因。'
        : '需要完整复盘时，请先导入并确认账单。',
    ]));
  }
  return form;
}

export function renderQaAssistant(ctx) {
  const state = ctx.state;
  const deps = ctx.qaDeps ?? {};
  const info = pageHelpInfo(state, deps);
  const root = el('section', { class: 'qa-assistant', 'aria-label': 'AI 页面帮助' });
  root.append(el('div', { class: 'qa-page' }, [
    el('p', { class: 'qa-page-intro' }, [info.intro]),
    el('p', { class: 'qa-context' }, [info.context]),
  ]));
  const status = statusNode(info.status, ctx, info);
  if (status) root.append(status);
  root.append(topicsNode(info.topics, ctx, info));
  if (info.showInput) {
    root.append(messagesNode(visibleHelpMessages(state), ctx, info));
    root.append(helpForm(ctx, info));
    root.append(el('p', { class: 'qa-fine' }, [
      '页面帮助在本机回答，不发送；账单分析请去问答页。原始 CSV 不上传。',
    ]));
  } else {
    root.append(el('p', { class: 'qa-fine' }, [
      '这里只说明本页操作与隐私；完整问答请在下方输入区继续。',
    ]));
  }
  return root;
}
