// 全局 AI 助手 · 说明视图 / 对话视图（用户端；接口候选，未冻结）
// 说明视图只做页面说明、操作入口和本地帮助提示；对话视图承载完整助手对话。
// 页面帮助和帮助提示不调用模型、行情或云端写入。
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

const HELP_CHIP_COUNT = 3;
const PORTFOLIO_KEYS = Object.freeze(['actualRet', 'ghostRet', 'drag', 'dragMoney']);
const VISIBLE_KINDS = Object.freeze(['help', 'help-user', 'ai']);
const REPORT_AI_TAG = 'AI 解读';
const REPORT_AI_PENDING_TEXT = '正在生成 AI 解读…';
const REPORT_AI_FAILURE_TEXT = 'AI 解读暂时不可用，本地页面说明仍然有效。';

let seq = 0;

function nextId() {
  return `help-${++seq}`;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function sanitizeAiText(value) {
  let text = String(value ?? '');
  text = text.replace(/[（(][^（）()]*CALC_[A-Z0-9_]+[^（）()]*[）)]/gu, '');
  text = text.replace(/CALC_[A-Z0-9_]+/gu, '');
  text = text.replace(/\bE_[A-Z0-9_]+\b/gu, '');
  text = text.replace(/\bsrc-[0-9a-f]{8}\b/gu, '');
  text = text.replace(/\b(?:formula_ref|fact_ref|request_id|trace_id|flow_id)\b/gu, '');
  text = text.replace(/[ \t]{2,}/gu, ' ').replace(/\s+([，。；：、])/gu, '$1');
  return text.trim();
}

function isConfirmedLocal(bill) {
  return !!bill && bill.status === 'confirmed' && bill.sourceType === 'local' && !bill.blocked
    && Array.isArray(bill.trades) && bill.trades.length > 0;
}

// 报告页 AI 解读只针对已确认且非示例的用户账单；contextId 用于把解读绑定到当前账单。
function isExplainableBill(bill) {
  return isConfirmedLocal(bill) && bill.demo !== true && bill.source !== 'demo'
    && typeof bill.contextId === 'string' && bill.contextId !== '';
}

function isDemoReport(bill, bundle) {
  return bill?.demo === true || bill?.source === 'demo' || bundle?.demo === true;
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
  if (state.route === 'chat') return '完整问答请在下方输入区继续；这里只说明本页操作、画像记录和隐私。';
  if (state.route === 'contract') return '我说明规则保存与测试的入口；具体判定以你保存的规则为准。';
  return '我说明当前页面的操作、隐私和可见状态；账单的完整复盘请在导入并确认后去问答页。';
}

function billLabelOf(bill) {
  return bill?.demo === true
    ? '示例账单'
    : isConfirmedLocal(bill) ? '已确认本地账单' : (BILL_LABEL[bill?.status] ?? '未选择');
}

function pageContext(state, deps) {
  const bill = state.bill ?? {};
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  const published = bundle?.review?.portfolio_published === true;
  const report = bundle ? (published ? '已发布' : '未发布') : '尚未载入';
  const asOf = bundle?.asOfDate ?? bundle?.valuation?.effective_date ?? bill.supportScope?.asOfDate ?? null;
  return `当前页：${PAGE_LABEL[state.route] ?? '首页'} · 账单：${billLabelOf(bill)} · 报告：${report}${asOf ? ` · 行情截止：${asOf}` : ''}`;
}

function compactContext(state, deps) {
  const bill = state.bill ?? {};
  const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  const report = bundle ? (bundle.review?.portfolio_published === true ? '已发布' : '未发布') : '尚未载入';
  return `当前页：${PAGE_LABEL[state.route] ?? '首页'} · 账单：${billLabelOf(bill)} · 报告：${report}`;
}

function publishedPortfolioValues(bundle) {
  const facts = Array.isArray(bundle?.review?.published_facts) ? bundle.review.published_facts : [];
  const byKey = new Map(facts.filter((f) => f?.scope === 'portfolio').map((f) => [f.key, f]));
  const values = {};
  for (const key of PORTFOLIO_KEYS) {
    const fact = byKey.get(key);
    if (fact && typeof fact.display === 'string') values[key] = fact.display;
  }
  return values;
}

function hasCompletePortfolio(bundle) {
  const values = publishedPortfolioValues(bundle);
  return PORTFOLIO_KEYS.every((key) => typeof values[key] === 'string');
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
  const complete = PORTFOLIO_KEYS.every((key) => typeof values[key] === 'string');
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

function primaryAction(state, deps) {
  if (state.route === 'home') {
    return {
      id: 'home-start',
      kind: 'link',
      label: '开始流程',
      href: '#/import',
      note: '先导入并确认账单；页面帮助不发送，原始 CSV 不上传。',
    };
  }
  if (state.route === 'import') {
    const rec = state.importRecovery ?? {};
    const images = Array.isArray(rec.vision?.images) ? rec.vision.images.length : 0;
    const visionReady = images > 0 && rec.vision?.status === 'ready';
    const textReady = !visionReady && String(rec.content ?? '').trim() !== '' && rec.status === 'needs_ai';
    if (!visionReady && !textReady) return null;
    const pending = rec.pending === true;
    const exhausted = rec.budgetExhausted === true;
    const wired = typeof deps?.runImportAi === 'function';
    return {
      id: visionReady ? 'import-vision' : 'import-text',
      kind: visionReady ? 'import-vision' : 'import-text',
      label: pending ? '识别进行中…' : exhausted ? 'AI 识别次数已用完' : visionReady ? '让 AI 识别图片/PDF' : '让 AI 整理账单文字',
      note: visionReady
        ? `会发送所选 ${images} 张压缩图片或 PDF 页面，不发送原始文件；不会自动确认账单。`
        : '会发送提取出的账单文字，不发送原始文件；不会自动确认账单。',
      disabled: pending || exhausted || !wired,
    };
  }
  if (state.route === 'report') {
    const bill = state.bill ?? {};
    const bundle = typeof deps?.getReportBundle === 'function' ? deps.getReportBundle(state.bill) : null;
    const scope = state.report?.symbol || 'pool';
    if (scope !== 'pool') {
      return {
        id: 'report-scope',
        kind: 'link',
        label: '查看报告页',
        href: '#/report',
        note: '当前是单标的视图；AI 解释只针对组合已发布数字，请先在报告页切回组合。',
      };
    }
    // 示例场景/示例账单不提供真实账单的 AI 解读入口。
    if (isDemoReport(bill, bundle)) return null;
    if (!isExplainableBill(bill) || !bundle) {
      return {
        id: 'report-open',
        kind: 'link',
        label: '打开报告页',
        href: '#/report',
        note: '报告载入后可解释当前页面已发布的数字。',
      };
    }
    if (bundle.review?.portfolio_published !== true || !hasCompletePortfolio(bundle)) {
      return {
        id: 'report-reason',
        kind: 'link',
        label: '查看报告原因',
        href: '#/report',
        note: '当前没有可解释的完整已发布组合数字；报告页会说明原因。',
      };
    }
    const pending = state.assistant?.qaAiPending === true;
    return {
      id: 'report-ai',
      kind: 'report-ai',
      label: pending ? REPORT_AI_PENDING_TEXT : '让 AI 解释当前数字',
      note: '将发送当前页面已发布的数字和你的问题，不发送原始账单文件。',
      disabled: pending || typeof deps?.explainReport !== 'function',
    };
  }
  if (state.route === 'contract') {
    if (state.assistant?.marketNotice) {
      return {
        id: 'review-open',
        kind: 'link',
        label: '查看操作复盘',
        href: '#/scenario',
        note: '行情暂不可用，暂时不能解释复盘结果。',
      };
    }
    if (state.assistant?.simulation || state.assistant?.resultExplanation) {
      return {
        id: 'review-ai',
        kind: 'review-ai',
        label: '让 AI 解释复盘结果',
        note: '只发送本次复盘已核对的规则与结果摘要，不发送原始账单文件。',
        disabled: state.assistant?.qaAiPending === true || typeof deps?.explainReviewResult !== 'function',
      };
    }
    return {
      id: 'review-open',
      kind: 'link',
      label: '去操作复盘',
      href: '#/scenario',
      note: '生成复盘结果后，可在这里让 AI 解释本次结果。',
    };
  }
  if (state.route === 'chat') {
    return {
      id: 'chat-focus',
      kind: 'focus-qa',
      label: '定位到问答输入区',
      note: '完整问答请使用下方输入框。',
    };
  }
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
    compactContext: compactContext(state, deps),
    topics: HELP[key],
    status: pageStatus(state, deps),
    primary: primaryAction(state, deps),
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
    .filter((message) => VISIBLE_KINDS.includes(message?.kind)
      && (message.route === null || message.route === undefined || message.route === state.route)
      && (message.billContextId === null || message.billContextId === undefined || message.billContextId === contextId));
}

function setAssistant(ctx, extra) {
  ctx.set({ assistant: { ...ctx.state.assistant, ...extra } });
}

function setView(ctx, view) {
  if (ctx.state.assistant?.view === view) return;
  setAssistant(ctx, { view });
}

function appendHelp(ctx, text, assistant) {
  const state = ctx.state;
  const contextId = billContextId(state);
  const messages = [
    ...(Array.isArray(state.assistant.qaMessages) ? state.assistant.qaMessages : []),
    { id: nextId(), role: 'user', kind: 'help-user', text, billContextId: contextId },
    { id: nextId(), role: 'assistant', kind: 'help', tag: '页面帮助', billContextId: contextId, ...assistant },
  ];
  setAssistant(ctx, { qaMessages: messages, qaInput: '', view: 'conversation' });
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

function aiMessageNode(message, ctx) {
  const status = message.status === 'pending' ? 'pending' : message.status === 'failed' ? 'failed' : 'ok';
  const box = el('div', {
    class: `assistant-msg assistant qa-msg qa-ai-msg is-${status}`,
    'data-role': 'assistant-ai-msg',
    'data-status': status,
    'aria-busy': status === 'pending' ? 'true' : 'false',
  }, [
    el('div', { class: 'qa-msg-text' }, [sanitizeAiText(message.text)]),
  ]);
  if (message.tag) box.append(el('div', { class: 'qa-tag' }, [message.tag]));
  if (status === 'failed') {
    box.append(el('div', { class: 'row qa-actions' }, [
      message.retryKind === 'report-ai'
        ? el('button', {
          class: 'btn small',
          type: 'button',
          'data-role': 'assistant-report-ai-retry',
          'aria-label': '重试 AI 解读',
          disabled: ctx.state.assistant?.qaAiPending === true ? '' : null,
          onclick: () => runReportExplain(ctx),
        }, ['重试 AI 解读'])
        : el('button', {
          class: 'btn small',
          type: 'button',
          'data-role': 'assistant-collapse',
          'aria-label': '收起对话并查看页面说明',
          onclick: () => setView(ctx, 'explain'),
        }, ['查看页面说明']),
    ]));
  }
  return box;
}

function messagesNode(messages, ctx, info) {
  const box = el('div', {
    class: 'assistant-messages qa-messages',
    role: 'log',
    'aria-live': 'polite',
    'data-role': 'assistant-thread',
  });
  if (!messages.length) {
    box.append(el('p', { class: 'qa-empty' }, ['还没有对话。可以点上面的帮助提示，或直接提问当前页面。']));
    return box;
  }
  for (const message of messages) {
    if (message.kind === 'help-user') {
      box.append(el('div', { class: 'assistant-msg user qa-msg' }, [message.text]));
    } else if (message.kind === 'ai') {
      box.append(aiMessageNode(message, ctx));
    } else {
      box.append(helpMessageNode(message, ctx, info));
    }
  }
  return box;
}

function scrollMessagesToEnd() {
  const run = () => {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
    const node = document.querySelector('[data-role="assistant-thread"]');
    if (node) node.scrollTop = node.scrollHeight;
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function helpForm(ctx, info) {
  const form = el('form', { class: 'qa-form', 'aria-label': '页面帮助提问' });
  const input = el('textarea', {
    class: 'input qa-input assistant-help-input',
    rows: '2',
    maxlength: '200',
    placeholder: '问当前页面的操作或说明…',
    'data-role': 'assistant-help-input',
    'aria-label': '页面帮助问题',
  });
  input.value = ctx.state.assistant.qaInput ?? '';
  const submit = el('button', {
    class: 'btn primary small',
    type: 'submit',
    'data-role': 'assistant-help-send',
    'aria-label': '发送页面帮助问题',
  }, ['发送']);
  const syncDisabled = () => {
    const empty = !String(input.value ?? '').trim();
    submit.disabled = empty;
    submit.setAttribute('aria-disabled', String(empty));
  };
  syncDisabled();
  input.addEventListener('input', () => {
    ctx.state.assistant.qaInput = input.value;
    syncDisabled();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!String(input.value ?? '').trim()) {
        syncDisabled();
        return;
      }
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
    }
  });
  form.append(input);
  form.append(el('div', { class: 'row qa-form-row' }, [submit]));
  form.append(el('p', { class: 'qa-send-hint' }, ['回答会显示在上方对话中，不会跳转页面。']));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = String(input.value ?? '').trim();
    if (!text) {
      syncDisabled();
      return;
    }
    sendHelpText(ctx, text);
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

function topicChipsNode(topics, ctx) {
  const box = el('div', { class: 'qa-chips qa-topic-chips', 'aria-label': '常见页面帮助' });
  for (const item of topics.slice(0, HELP_CHIP_COUNT)) {
    box.append(el('button', {
      class: 'qa-chip',
      type: 'button',
      'data-role': 'assistant-topic',
      'aria-label': `查看帮助：${item.label}`,
      onclick: () => sendHelpText(ctx, item.question),
    }, [item.label]));
  }
  return box;
}

function lastAnswerSummary(state) {
  const messages = visibleHelpMessages(state);
  const last = [...messages].reverse().find((message) => message.role === 'assistant'
    && typeof message.text === 'string' && message.text.trim() !== '');
  if (!last) return null;
  const text = last.text.replace(/\s+/g, ' ').trim();
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

function importFailureText(code) {
  if (code === 'E_IMPORT_AI_BUDGET') return '本次 AI 识别次数已用完；本地解析结果仍然可用，可手动补全。';
  if (code === 'E_IMPORT_AI_NO_SOURCE') return '当前没有可识别的截图、PDF 页面或账单文字。';
  return 'AI 识别未完成；本地解析结果仍然可用，可在导入页手动补全或稍后重试。';
}

function pushAiTurn(ctx, userText, pendingText, tag, extra = {}) {
  const contextId = billContextId(ctx.state);
  const id = nextId();
  const { route = null, ...aiExtra } = extra;
  const routeField = route ? { route } : {};
  const messages = [
    ...(Array.isArray(ctx.state.assistant.qaMessages) ? ctx.state.assistant.qaMessages : []),
    {
      id: nextId(), role: 'user', kind: 'help-user', text: userText, billContextId: contextId, ...routeField,
    },
    {
      id, role: 'assistant', kind: 'ai', tag, status: 'pending', text: pendingText, billContextId: contextId, ...routeField, ...aiExtra,
    },
  ];
  setAssistant(ctx, { qaMessages: messages, qaInput: '', view: 'conversation', qaAiPending: true });
  return id;
}

function finishAiTurn(ctx, id, { ok, text, ...extra }) {
  const cleaned = sanitizeAiText(text) || (ok ? 'AI 已返回结果。' : 'AI 未完成；本地说明仍然有效。');
  const messages = (Array.isArray(ctx.state.assistant.qaMessages) ? ctx.state.assistant.qaMessages : [])
    .map((message) => (message.id === id ? { ...message, ...extra, status: ok ? 'ok' : 'failed', text: cleaned } : message));
  setAssistant(ctx, { qaMessages: messages, qaAiPending: false });
}

function reportAiTurnId(state) {
  const contextId = billContextId(state);
  if (!contextId) return null;
  const messages = Array.isArray(state.assistant?.qaMessages) ? state.assistant.qaMessages : [];
  return [...messages].reverse()
    .find((message) => message?.kind === 'ai' && message.retryKind === 'report-ai'
      && message.billContextId === contextId)?.id ?? null;
}

async function runReportExplain(ctx) {
  const deps = ctx.qaDeps ?? {};
  if (ctx.state.assistant?.qaAiPending || typeof deps.explainReport !== 'function') return;
  const bill = ctx.state.bill;
  const bundle = typeof deps.getReportBundle === 'function' ? deps.getReportBundle(bill) : null;
  if (isDemoReport(bill, bundle) || !isExplainableBill(bill) || !bundle
    || bundle.review?.portfolio_published !== true || !hasCompletePortfolio(bundle)) return;
  // 同一账单只保留一段 AI 解读：重试或再次点击都复用原 turn，不追加相同用户消息。
  const existingId = reportAiTurnId(ctx.state);
  let id;
  if (existingId) {
    id = existingId;
    setAssistant(ctx, {
      view: 'conversation',
      qaAiPending: true,
      qaMessages: (Array.isArray(ctx.state.assistant.qaMessages) ? ctx.state.assistant.qaMessages : [])
        .map((message) => (message.id === id
          ? { ...message, status: 'pending', text: REPORT_AI_PENDING_TEXT }
          : message)),
    });
  } else {
    id = pushAiTurn(ctx, '让 AI 解释当前数字', REPORT_AI_PENDING_TEXT, REPORT_AI_TAG, {
      route: 'report',
      retryKind: 'report-ai',
    });
  }
  let result;
  try {
    result = await deps.explainReport({
      question: '解释当前页面已发布的组合数字及其含义',
      bundle,
      bill,
    });
  } catch {
    result = { ok: false };
  }
  if (result?.ok && typeof result.text === 'string' && result.text.trim()) {
    finishAiTurn(ctx, id, { ok: true, text: result.text.trim() });
  } else {
    finishAiTurn(ctx, id, {
      ok: false,
      text: REPORT_AI_FAILURE_TEXT,
      tag: REPORT_AI_TAG,
      route: 'report',
      retryKind: 'report-ai',
    });
  }
}

async function runImportAi(ctx, action) {
  const deps = ctx.qaDeps ?? {};
  if (ctx.state.assistant?.qaAiPending || typeof deps.runImportAi !== 'function') return;
  const vision = action.kind === 'import-vision';
  const id = pushAiTurn(
    ctx,
    action.label,
    vision ? '正在发送所选图片/PDF 页面并整理交易草稿…' : '正在发送提取出的文字并整理交易草稿…',
    'AI 识别',
  );
  let result;
  try {
    result = await deps.runImportAi({ bill: ctx.state.bill });
  } catch {
    result = { ok: false, code: 'E_IMPORT_AI_UNEXPECTED' };
  }
  if (result?.ok) {
    const count = Number.isFinite(result.draftCount) ? result.draftCount : 0;
    finishAiTurn(ctx, id, {
      ok: true,
      text: count > 0
        ? `AI 已生成可编辑草稿（${count} 条交易）。请在导入页逐条核对；尚未确认账单，也不会生成报告。`
        : 'AI 没有整理出新的交易。可在导入页手动补全；尚未确认账单，也不会生成报告。',
    });
    return;
  }
  finishAiTurn(ctx, id, { ok: false, text: importFailureText(result?.code) });
}

async function runReviewExplain(ctx) {
  const deps = ctx.qaDeps ?? {};
  if (ctx.state.assistant?.qaAiPending || typeof deps.explainReviewResult !== 'function') return;
  const id = pushAiTurn(ctx, '让 AI 解释复盘结果', '正在请 AI 解释本次复盘结果…', 'AI 解释');
  let result;
  try {
    result = await deps.explainReviewResult({});
  } catch {
    result = { ok: false };
  }
  if (result?.ok && typeof result.text === 'string' && result.text.trim()) {
    finishAiTurn(ctx, id, { ok: true, text: result.text.trim() });
  } else {
    finishAiTurn(ctx, id, {
      ok: false,
      text: 'AI 解释未完成；本地复盘摘要仍然有效。可稍后重试，或查看页面说明。',
    });
  }
}

function runPrimaryAction(ctx, action) {
  if (!action || action.disabled) return;
  if (action.kind === 'link') {
    const route = String(action.href ?? '').replace(/^#\//, '');
    if (route && typeof ctx.go === 'function') ctx.go(route);
    return;
  }
  if (action.kind === 'focus-qa') {
    if (typeof ctx.qaDeps?.focusQaInput === 'function') ctx.qaDeps.focusQaInput();
    return;
  }
  if (action.kind === 'report-ai') { runReportExplain(ctx); return; }
  if (action.kind === 'import-vision' || action.kind === 'import-text') { runImportAi(ctx, action); return; }
  if (action.kind === 'review-ai') runReviewExplain(ctx);
}

function primaryNode(action, ctx) {
  if (!action) return null;
  const box = el('div', { class: 'qa-primary', 'data-role': 'assistant-primary-area' });
  if (action.note) box.append(el('p', { class: 'qa-primary-note' }, [action.note]));
  box.append(el('div', { class: 'row qa-actions' }, [
    el('button', {
      class: 'btn primary small',
      type: 'button',
      'data-role': 'assistant-primary',
      'data-action': action.id,
      'aria-label': action.label,
      disabled: action.disabled ? '' : null,
      onclick: () => runPrimaryAction(ctx, action),
    }, [action.label]),
  ]));
  return box;
}

function explainView(ctx, info) {
  const state = ctx.state;
  const root = el('div', { class: 'qa-explain', 'data-role': 'assistant-explain' });
  root.append(el('div', { class: 'qa-page' }, [
    el('p', { class: 'qa-context' }, [info.context]),
    el('p', { class: 'qa-page-intro' }, [info.intro]),
  ]));
  const primary = primaryNode(info.primary, ctx);
  if (primary) root.append(primary);
  root.append(topicChipsNode(info.topics, ctx));
  root.append(el('div', { class: 'row qa-actions qa-expand-row' }, [
    el('button', {
      class: 'btn small',
      type: 'button',
      'data-role': 'assistant-expand',
      'aria-label': '展开对话',
      onclick: () => setView(ctx, 'conversation'),
    }, ['展开对话']),
  ]));
  const summary = lastAnswerSummary(state);
  if (summary) root.append(el('p', { class: 'qa-last-answer' }, [`上次回答：${summary}`]));
  root.append(el('p', { class: 'qa-fine' }, [
    '页面帮助在本机回答，不发送；账单分析请去问答页。原始 CSV 不上传。',
  ]));
  return root;
}

function conversationView(ctx, info) {
  const state = ctx.state;
  const root = el('div', { class: 'qa-conversation', 'data-role': 'assistant-conversation' });
  root.append(el('div', { class: 'qa-conv-bar' }, [
    el('p', { class: 'qa-context qa-context-line' }, [info.compactContext]),
    el('button', {
      class: 'btn small',
      type: 'button',
      'data-role': 'assistant-collapse',
      'aria-label': '收起对话',
      onclick: () => setView(ctx, 'explain'),
    }, ['收起对话']),
  ]));
  root.append(messagesNode(visibleHelpMessages(state), ctx, info));
  if (info.showInput) {
    root.append(helpForm(ctx, info));
    root.append(el('p', { class: 'qa-fine' }, [
      '页面帮助在本机回答，不发送；账单分析请去问答页。原始 CSV 不上传。',
    ]));
  } else {
    root.append(el('div', { class: 'qa-chat-dock' }, [
      el('p', { class: 'qa-fine' }, ['完整问答请使用下方输入框。']),
      el('div', { class: 'row qa-actions' }, [
        el('button', {
          class: 'btn small',
          type: 'button',
          'data-role': 'assistant-focus-qa',
          'aria-label': '定位到问答输入区',
          onclick: () => {
            if (typeof ctx.qaDeps?.focusQaInput === 'function') ctx.qaDeps.focusQaInput();
          },
        }, ['定位到问答输入区']),
      ]),
    ]));
  }
  return root;
}

export function renderQaAssistant(ctx) {
  const state = ctx.state;
  const deps = ctx.qaDeps ?? {};
  const info = pageHelpInfo(state, deps);
  const view = state.assistant?.view === 'conversation' ? 'conversation' : 'explain';
  const root = el('section', {
    class: 'qa-assistant',
    'aria-label': 'AI 助手',
    'data-view': view,
  });
  root.append(view === 'conversation' ? conversationView(ctx, info) : explainView(ctx, info));
  if (view === 'conversation') scrollMessagesToEnd();
  return root;
}
