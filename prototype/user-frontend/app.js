import * as bridge from './realBridge.js';
import { renderRealReport } from './realReport.js';
import { renderRealChat } from './realChat.js';
import { renderRealProfile } from './realProfile.js';

(() => {
  'use strict';

  const DEMO = {
    capital: 100000,
    valuationDate: '2025-10-17',
    startDate: '2024-11-06',
    actual: 12480,
    passive: 18920,
    gap: 6440,
    trades: [
      { line: 1, date: '2024-11-06', symbol: '600519', name: '贵州茅台', side: 'buy', price: 200.0, quantity: 100, fee: 5, tax: 0 },
      { line: 2, date: '2025-01-15', symbol: '600519', name: '贵州茅台', side: 'sell', price: 220.0, quantity: 100, fee: 5, tax: 10 },
      { line: 3, date: '2024-11-06', symbol: '300750', name: '宁德时代', side: 'buy', price: 150.0, quantity: 200, fee: 5, tax: 0 },
      { line: 4, date: '2025-03-14', symbol: '300750', name: '宁德时代', side: 'sell', price: 160.0, quantity: 100, fee: 5, tax: 10 },
      { line: 5, date: '2024-11-07', symbol: '601318', name: '中国平安', side: 'buy', price: 100.0, quantity: 500, fee: null, tax: null },
    ],
    series: [
      { date: '2024-11-06', actual: 100000, passive: 100000 },
      { date: '2024-12-06', actual: 103200, passive: 103200 },
      { date: '2025-01-15', actual: 106000, passive: 106000, sell: '600519' },
      { date: '2025-02-14', actual: 109500, passive: 111800 },
      { date: '2025-03-14', actual: 107600, passive: 110200, sell: '300750' },
      { date: '2025-04-15', actual: 105900, passive: 112600 },
      { date: '2025-05-15', actual: 108300, passive: 113900 },
      { date: '2025-06-16', actual: 110100, passive: 116400 },
      { date: '2025-07-15', actual: 108700, passive: 114200 },
      { date: '2025-08-15', actual: 111200, passive: 116800 },
      { date: '2025-09-15', actual: 110400, passive: 115300 },
      { date: '2025-10-17', actual: 112480, passive: 118920 },
    ],
  };

  const RULE_CANDIDATES = [
    {
      id: 'c1',
      tag: '来自示例账单',
      title: '持有少于 90 天，不在盘中临时卖出。',
      threshold: '持有天数 < 90 天',
      basis: '600519 持有 70 天后被卖出；若持有至估值日，差额为 ¥4,440（示例）。',
    },
    {
      id: 'c2',
      tag: '防守型模板',
      title: '卖出后 3 个交易日内，不追回同一标的。',
      threshold: '冷却期 = 3 个交易日',
      basis: '避免在同一次波动里卖出又追回，放大交易成本与情绪。',
    },
    {
      id: 'c3',
      tag: '来自示例账单',
      title: '单一标的仓位不超过总资产的 50%。',
      threshold: '单一标的仓位 ≤ 50%',
      basis: '601318 初始投入 ¥50,000，正好占总本金的 50%（示例）。',
    },
  ];

  const QA = [
    {
      id: 'q1',
      question: '我最错的一笔是哪个？',
      html: '<p>镜子不做“对错”评判，只把差额摆出来。</p><p>如果只看代价，最高的一笔是 <strong>2025-01-15 卖出 600519</strong>：卖出所得 <span class="mono">¥22,000</span>，而持有到估值日的对照价值是 <span class="mono">¥26,440</span>，差额 <strong>−¥4,440</strong>。</p><p>另一笔是 2025-03-14 卖出 300750 的一半，差额 <strong>−¥2,000</strong>。两笔合计 −¥6,440。</p><p>这是事后对照，不是对你当时决定的评价。</p>',
      evidence: true,
    },
    {
      id: 'q2',
      question: '为什么差额是 6,440？',
      html: '<p>因为期末对照价值是 <span class="mono">¥118,920</span>，你的实际价值是 <span class="mono">¥112,480</span>。</p><p>差额 = 对照 − 实际 = <strong>¥6,440</strong>，占对照收益 <span class="mono">¥18,920</span> 的 <strong>34.0%</strong>。</p><p>拆开看：600519 贡献 ¥4,440，300750 贡献 ¥2,000，601318 没有差额。</p>',
      evidence: true,
    },
    {
      id: 'q3',
      question: '如果那两笔不卖会怎样？',
      html: '<p>如果把 600519 的 100 股、300750 的 100 股都留到估值日，示例期末价值会是 <span class="mono">¥118,920</span>，比现在的 <span class="mono">¥112,480</span> 多 <strong>¥6,440</strong>。</p><p>这个反事实忽略了费用、税费、分红与送转，只是历史对照，不是对未来的预测。</p>',
      evidence: true,
    },
    {
      id: 'q4',
      question: '我的费用扣了多少？',
      html: '<p>这份示例账单里已记录费用 <span class="mono">¥20</span>、税费 <span class="mono">¥20</span>。</p><p>第 5 行（601318 买入）的费用与税费为空，报告按 0 展示并用橙色标注。<strong>示例报告暂未把费用税费计入收益口径</strong>，正式版会按产品口径计算并单列。</p>',
      evidence: true,
    },
  ];

  const BOUNDARY_ANSWER = {
    id: 'boundary',
    html: '<p>这个问题超出了镜子的职责。我不能预测涨跌，也不推荐具体标的。</p><p>我能做的是把已经发生的交易摊开，让你看清代价与差额。你可以试试下面几个关于这份账单的问题。</p>',
    evidence: false,
  };

  const ONLINE_QUESTION = '组合整体表现如何？';

  // 只发送这四个已核对事实；站点函数复述后，数字再在本机校验一次。
  const ONLINE_FACTS = [
    { value: 0.1248, unit: '%', display: '+12.48%', formula_ref: 'CALC_RET_V1' },
    { value: 0.1892, unit: '%', display: '+18.92%', formula_ref: 'CALC_RET_V1' },
    { value: 0.0644, unit: 'pp', display: '6.44pp', formula_ref: 'CALC_DRAG_PP_V1' },
    { value: 6440, unit: '元', display: '¥6,440.00', formula_ref: 'CALC_DRAG_MONEY_V1' },
  ];

  const LOCAL_OVERVIEW = {
    id: 'local-overview',
    html: '<p>这份示例账单的实际收益是 <span class="mono">+¥12,480</span>（+12.48%），买入不动是 <span class="mono">+¥18,920</span>（+18.92%）。</p><p>两者相差 <strong>¥6,440</strong>，相当于 <span class="mono">6.44pp</span>，占对照收益的 34.0%。这是对已发生交易的事后对照，不是预测，也不评价当时的决定。</p>',
    evidence: true,
  };

  const ONLINE_FALLBACK_NOTICE = '站点后端暂不可用，以上为本机事实回答。';

  const FALLBACK_ANSWER = {
    id: 'fallback',
    html: '<p>这个原型只准备了 4 个与示例账单有关的问题。正式版会先识别意图，再只复述事实，不自由发挥。</p><p>你可以先点下面的问题，看看每个回答的证据从哪里来。</p>',
    evidence: false,
  };

  const RULE_KEY = 'tm.user-frontend.rules.v1';
  const ROUTES = ['home', 'import', 'report', 'chat', 'rules'];
  const TITLES = {
    home: '择时镜子 TimingMirror · 把交易照见成证据',
    import: '导入账单 · 择时镜子',
    report: '报告 · 择时镜子',
    chat: '问镜子 · 择时镜子',
    rules: '规则 · 择时镜子',
  };

  const app = document.getElementById('app');
  const topbarEl = document.getElementById('topbar');
  const mobileNavEl = document.getElementById('mobile-nav');
  const footerEl = document.getElementById('site-footer');
  const toastEl = document.getElementById('toast');
  const modalRoot = document.getElementById('modal-root');

  const state = {
    route: 'home',
    bill: idleBill(),
    chat: { messages: [], pending: false, requestId: null },
    rules: loadRuleState(),
    focusEvidence: false,
  };

  let chatTimer = null;
  let chatRequestSeq = 0;
  let toastTimer = null;
  let lastChartPoints = [];
  let lastFocused = null;
  let modalKeyHandler = null;

  /* ---------- utilities ---------- */

  function idleBill() {
    return {
      status: 'idle',
      source: null,
      confirmed: false,
      fileName: '',
      fileSize: 0,
      trades: [],
      warnings: [],
      errors: [],
      error: '',
    };
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function intFmt(value) {
    return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  }

  function money(value) {
    const n = Number(value);
    return `${n < 0 ? '−' : ''}¥${intFmt(Math.abs(n))}`;
  }

  function fmtSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function currentRoute() {
    const raw = String(location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.includes(raw) ? raw : 'home';
  }

  function reduceMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function nowStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function scrollTop() {
    const html = document.documentElement;
    const previous = html.style.scrollBehavior;
    html.style.scrollBehavior = 'auto';
    const main = document.getElementById('tm-main');
    if (main) main.scrollTop = 0;
    document.body.scrollTop = 0;
    window.scrollTo(0, 0);
    html.style.scrollBehavior = previous;
  }

  function animateCounters(scope) {
    const nodes = (scope || document).querySelectorAll('[data-count]');
    nodes.forEach((node) => {
      const target = Number(node.getAttribute('data-count'));
      if (!Number.isFinite(target)) return;
      if (reduceMotion()) {
        node.textContent = intFmt(target);
        return;
      }
      const duration = 980;
      let start = null;
      node.textContent = '0';
      const tick = (ts) => {
        if (!node.isConnected) return;
        if (start === null) start = ts;
        const progress = Math.min((ts - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        node.textContent = intFmt(Math.round(target * eased));
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3400);
  }

  /* ---------- chrome ---------- */

  function brandHTML() {
    return '<a class="brand" href="#/home" aria-label="择时镜子首页">'
      + '<span class="brand-mark" aria-hidden="true"></span>'
      + '<span class="brand-name">择时镜子</span>'
      + '<span class="brand-en">TIMING<br>MIRROR</span>'
      + '</a>';
  }

  function navLink(route, label) {
    const current = state.route === route ? ' aria-current="page"' : '';
    return `<a href="#/${route}"${current}>${label}</a>`;
  }

  function renderChrome() {
    const mode = pageMode();
    const statusInfo = sessionStatusInfo();
    topbarEl.innerHTML = `<div class="topbar-inner">
      ${brandHTML()}
      <nav class="nav" aria-label="主导航">
        ${navLink('home', '首页')}
        ${navLink('import', '导入')}
        ${navLink('report', '报告')}
        ${navLink('chat', '问答')}
        ${navLink('rules', '规则')}
      </nav>
      <div class="topbar-right">
        <nav class="view-switch" aria-label="界面视图">
          <a class="view-option tm-dev-link" href="../../" title="打开开发者视图（独立页面）" data-developer-link>开发者</a>
          <span class="view-option is-active" aria-current="page">用户端</span>
        </nav>
        <button id="assistant-toggle" class="tm-assistant-toggle" type="button" aria-controls="tm-assistant" aria-expanded="false">AI 助手</button>
        <span class="proto-chip tm-mode-chip ${statusInfo.tone}">${statusInfo.text}</span>
        <a class="btn btn-primary btn-sm" href="#/import">进入账本 <span class="arrow">→</span></a>
      </div>
    </div>`;

    const mobile = [
      ['home', '首页'],
      ['import', '导入'],
      ['report', '报告'],
      ['chat', '问答'],
      ['rules', '规则'],
    ];
    mobileNavEl.innerHTML = mobile.map(([route, label]) => {
      const current = state.route === route ? ' aria-current="page"' : '';
      return `<a href="#/${route}"${current}>${label}</a>`;
    }).join('');

    const footerNote = statusInfo.tone === 'real'
      ? '已确认本地账单 · 本机处理 · 不构成投资建议'
      : statusInfo.tone === 'demo'
        ? '示例数据 · 不构成投资建议'
        : statusInfo.tone === 'pending'
          ? `${statusInfo.text} · 真实账单尚未完成 · 不构成投资建议`
          : '尚未确认账单 · 不构成投资建议';
    footerEl.innerHTML = `<div class="container">
      <div class="footer-inner">
        <div class="footer-brand">
          ${brandHTML()}
          <p>把已经发生的交易，放回同一把尺上。看见差距，回查证据，再决定下一步。</p>
        </div>
        <div class="footer-cols">
          <div class="footer-col">
            <h4>页面</h4>
            <ul>
              <li><a href="#/import">导入账单</a></li>
              <li><a href="#/report" data-demo-link data-demo-route="report">示例报告</a></li>
              <li><a href="#/chat">问镜子</a></li>
              <li><a href="#/rules">我的规则</a></li>
            </ul>
          </div>
          <div class="footer-col">
            <h4>我们的边界</h4>
            <p class="boundary-line">不荐股、不预测涨跌。</p>
            <p class="boundary-line">不承诺收益、不替你做决定。</p>
            <p class="boundary-line">原始 CSV 只在本机读取，不上传。</p>
          </div>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} TimingMirror · 用户端</span>
        <span>${footerNote}</span>
      </div>
    </div>`;
  }

  /* ---------- shared page pieces ---------- */

  function pageHead({ code, title, intro, right }) {
    return `<section class="page-head">
      <div class="container">
        <div class="page-topline">
          <span class="page-code">${code}</span>
          <div class="page-topline-right">${right || '<span class="sample-tag">原型演示</span>'}</div>
        </div>
        <div class="page-head-grid">
          <h1>${title}</h1>
          <div class="page-intro">${intro}</div>
        </div>
        <div class="page-head-rule" aria-hidden="true"></div>
      </div>
    </section>`;
  }

  function pageMode(route = state.route) {
    return bridge.getMode(route);
  }

  function sharedState() {
    return bridge.getShared();
  }

  function isConfirmedLocal() {
    const bill = sharedState().bill;
    return bill?.status === 'confirmed' && bill?.sourceType === 'local';
  }

  function importStatusText() {
    const shared = sharedState();
    const bill = shared.bill ?? {};
    const rec = shared.importRecovery ?? {};
    if (bill.status === 'confirmed') return bill.demo
      ? { text: '示例场景', tone: 'demo' }
      : { text: '已确认账单', tone: 'real' };
    if (bill.status === 'loading' || rec.pending || ['reading', 'preparing', 'rendering'].includes(rec.status)) {
      return { text: '导入中', tone: 'pending' };
    }
    if (bill.status === 'invalid' || bill.status === 'error' || rec.status === 'error' || rec.status === 'unsupported') {
      return { text: '需修正', tone: 'pending' };
    }
    if (bill.status === 'loaded' || (rec.status && rec.status !== 'idle')) return { text: '待确认', tone: 'pending' };
    return { text: '空状态', tone: 'empty' };
  }

  function sessionStatusInfo() {
    const shared = sharedState();
    if (shared.bill?.status === 'confirmed' && shared.bill?.sourceType === 'local') {
      return shared.bill.demo ? { text: '示例场景', tone: 'demo' } : { text: '已确认账单', tone: 'real' };
    }
    if (bridge.hasRealState()) return importStatusText();
    if (state.route === 'rules' && pageMode('rules') === 'real') return { text: '规则任务', tone: 'real' };
    if (bridge.isDemoSelected()) return { text: '示例模式', tone: 'demo' };
    return { text: '空状态', tone: 'empty' };
  }

  function modeChipText() {
    return sessionStatusInfo().text;
  }

  function hasSessionState() {
    const shared = sharedState();
    return bridge.hasRealState()
      || bridge.isDemoSelected()
      || (shared.assistant?.messages?.length ?? 0) > 0
      || (shared.assistant?.qaMessages?.length ?? 0) > 0
      || !!shared.assistant?.draft
      || (state.chat?.messages?.length ?? 0) > 0
      || state.bill?.status !== 'idle';
  }

  function enterDemoRoute(route) {
    if (!bridge.enterDemo()) {
      showToast('已有真实导入任务，示例视图不会覆盖当前账单。');
      return;
    }
    if (route && currentRoute() !== route) {
      location.hash = `#/${route}`;
    } else {
      render();
    }
    showToast('已进入示例模式；示例数据不会写入真实账单。');
  }

  function confirmDeveloperExit(href) {
    const leave = () => { location.href = href; };
    if (!hasSessionState()) { leave(); return; }
    showModal({
      title: '离开新前端？',
      subtitle: 'DEVELOPER VIEW / 调试入口',
      body: '<p>开发者视图是独立页面。离开后，当前助手对话、规则草案、导入草稿和真实账单状态不会跨页面保留；只有导入预算可能留在本标签页。</p><p class="fine">建议先完成当前导入或复制需要保留的内容。</p>',
      actions: [
        { label: '留在此页', className: 'btn-outline' },
        { label: '仍要离开', className: 'btn-ghost danger', onClick: leave },
      ],
    });
  }

  function emptyStatePage(route) {
    const copy = route === 'report'
      ? ['还没有可报告的真实账单。', '导入并确认账单后，这里只显示已复核的真实结果，不填充示例数字。']
      : route === 'chat'
        ? ['还没有可问答的真实账单。', '导入并确认账单后，事实问答只复述这笔账单的已复核结果。']
        : ['还没有真实账单或规则任务。', '导入账单后可使用现有规则工作区；也可以直接使用右侧 AI 助手描述规则。'];
    return `${pageHead({
      code: route === 'report' ? 'STEP 02 / REPORT' : route === 'chat' ? 'STEP 03 / ASK' : 'STEP 04 / RULES',
      title: copy[0],
      intro: `<p>${copy[1]}</p>`,
      right: '<span class="sample-tag">空状态</span>',
    })}
    <div class="container page-body">
      <section class="panel tm-empty-state">
        <p class="mono-label">NO REAL BILL / 尚未开始</p>
        <h2>先导入并确认一份账单。</h2>
        <p class="muted">真实结果、事实问答和规则任务共用同一份已确认账单；示例视图需要你主动选择。</p>
        <div class="actions">
          <a class="btn btn-primary" href="#/import">导入账单 <span class="arrow">→</span></a>
          <button class="btn btn-outline" type="button" data-demo-route="${route}">查看示例</button>
        </div>
      </section>
    </div>`;
  }

  function realPendingPage(route) {
    const shared = sharedState();
    const bill = shared.bill ?? {};
    const rec = shared.importRecovery ?? {};
    const reading = bill.status === 'loading' || ['reading', 'preparing', 'rendering'].includes(rec.status);
    const failed = bill.status === 'error' || bill.status === 'invalid' || rec.status === 'error' || rec.status === 'unsupported';
    const title = reading ? '账单还在读取或识别。' : failed ? '账单还没有通过校验。' : '账单还没有正式确认。';
    const detail = reading
      ? '完成后会在本页显示真实结果；切页不会重置导入任务。'
      : failed
        ? '请在导入页修正或重新识别；这里不会回退到示例报告或示例问答。'
        : '请先在导入页核对交易并确认；未确认前不展示示例数字。';
    const issues = [
      ...(Array.isArray(bill.errors) ? bill.errors.slice(0, 5).map((e) => e.message || e.code) : []),
      rec.error?.message,
    ].filter(Boolean);
    return `${pageHead({
      code: route === 'report' ? 'STEP 02 / REPORT' : 'STEP 03 / ASK',
      title,
      intro: `<p>${detail}</p>`,
      right: `<span class="sample-tag">${reading ? '导入中' : failed ? '需修正' : '待确认'}</span>`,
    })}
    <div class="container page-body">
      <section class="panel tm-empty-state">
        <p class="mono-label">REAL IMPORT / ${reading ? 'IN PROGRESS' : failed ? 'NEEDS FIX' : 'WAITING CONFIRM'}</p>
        <h2>${reading ? '正在处理你的本地账单。' : failed ? '当前账单不能用于真实结果。' : '确认后才进入真实结果。'}</h2>
        <p class="muted">${reading ? '读取、AI 识别或本地渲染仍在进行；完成后会使用同一份账单。' : '示例数据不会补进真实账单结果。'}</p>
        ${issues.length ? `<ul class="tm-issue-list">${issues.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        <div class="actions">
          <a class="btn btn-primary" href="#/import">返回导入页 <span class="arrow">→</span></a>
        </div>
      </section>
    </div>`;
  }

  function realReportPage() {
    if (!isConfirmedLocal()) return realPendingPage('report');
    const bill = sharedState().bill;
    if (bill.demo) {
      const scenario = bill.demoScenario ?? {};
      return `${pageHead({
        code: 'STEP 02 / EXAMPLE REPORT',
        title: scenario.headline || '示例报告',
        intro: `<div class="report-meta">
          <div class="report-account"><span>DEMO / 示例场景</span><span>${esc(scenario.title || '示例报告')}</span></div>
          <dl>
            <div><dt>数据</dt><dd>合成账单 + 示例行情</dd></div>
            <div><dt>用途</dt><dd>演示不同报告状态</dd></div>
            <div><dt>性质</dt><dd><span class="status-dot demo">示例 · 非真实</span></dd></div>
          </dl>
        </div>`,
        right: '<span class="sample-tag">示例数据</span><a class="text-link" href="#/import">换个场景</a>',
      })}
      <div id="tm-real-report"></div>`;
    }
    return `${pageHead({
      code: 'STEP 02 / REPORT',
      title: '同一把尺，<br>量出差距。',
      intro: `<div class="report-meta">
        <div class="report-account"><span>REAL BILL / 已确认本地账单</span><span>${esc(bill.fileName || '未知文件')}</span></div>
        <dl>
          <div><dt>数据来源</dt><dd>本机账单 · 未上传</dd></div>
          <div><dt>结果</dt><dd>仅展示已复核事实</dd></div>
          <div><dt>状态</dt><dd><span class="status-dot">真实账单</span></dd></div>
        </dl>
      </div>`,
      right: '<span class="sample-tag">真实账单</span><a class="text-link" href="#/import">换一份账单</a>',
    })}
    <div id="tm-real-report"></div>`;
  }

  function realChatPage() {
    if (!isConfirmedLocal()) return realPendingPage('chat');
    const bill = sharedState().bill;
    const demo = bill.demo === true;
    return `${pageHead({
      code: 'STEP 03 / ASK',
      title: '问它为什么，<br>别问它买什么。',
      intro: `<p>${demo ? '当前是示例账单，回答只复述这份示例的已复核结果。' : '只复述当前已确认账单的已复核事实。数字在本机再校验；不预测、不荐股、不替你决定。'}</p><ul class="mini-rules"><li>${demo ? '示例数据' : '真实账单'}</li><li>四项事实</li><li>失败即兜底</li></ul>`,
      right: `<span class="sample-tag">${demo ? '示例数据' : '真实账单'}</span><a class="text-link" href="#/import">${demo ? '换个场景' : '换一份账单'}</a>`,
    })}
    <div id="tm-real-chat"></div>`;
  }

  function realRulesPage() {
    return `<div class="container page-body">
      <section class="tm-workspace-head">
        <p class="mono-label">REAL RULES / 真实规则</p>
        <h1>规则工作区</h1>
        <p class="muted">画像与规则候选只从已复核账单派生；候选做模板预填，保存、模拟和版本记录仍由你确认后生效。没有账单时也可以保留右侧助手已产生的规则草案。</p>
      </section>
      <div id="tm-real-profile"></div>
      <div id="tm-real-rules"></div>
    </div>`;
  }

  /* ---------- home ---------- */

  function homePage() {
    const sharedBill = sharedState().bill;
    const realBanner = isConfirmedLocal()
      ? (sharedBill.demo
        ? `<div class="container tm-real-home-banner"><strong>当前是示例场景。</strong><span>${esc(sharedBill.demoScenario?.title || '示例报告')} · 合成账单与示例行情，仅用于演示。</span><a class="text-link" href="#/report">查看示例报告 →</a><a class="text-link" href="#/import">换个场景 →</a></div>`
        : `<div class="container tm-real-home-banner"><strong>当前有已确认的本地账单。</strong><span>${esc(sharedBill.fileName || '本地账单')} · 报告、问答和助手都使用这笔账单。</span><a class="text-link" href="#/report">查看真实报告 →</a><a class="text-link" href="#/chat">去事实问答 →</a></div>`)
      : '';
    return `${realBanner}<div class="home">
      <section class="hero">
        <div class="container hero-grid">
          <div class="hero-copy reveal">
            <div class="kicker"><span class="kicker-dot"></span>Personal trading review / 不荐股</div>
            <h1 class="hero-title"><span class="nowrap">你和“买入不动”</span>，<br><span class="hero-mark">差在哪里</span>？</h1>
            <p class="lede">看清实际收益、买入不动与择时损耗的差距。每个数字，都能回到原始成交行。</p>
            <div class="hero-actions">
              <a class="btn btn-primary btn-lg" href="#/import">导入我的账单 <span class="arrow">→</span></a>
              <a class="link-arrow" href="#/report" data-demo-link data-demo-route="report">先看示例报告 <span aria-hidden="true">↗</span></a>
            </div>
            <p class="hero-privacy"><span class="lock-dot" aria-hidden="true"></span>原始 CSV 只在本机处理，不上传。</p>
          </div>

          <aside class="hero-ledger reveal" style="--delay:120ms" aria-label="示例账本：实际收益 12,480 元，买入不动 18,920 元，差额 6,440 元">
            <span class="ledger-grain" aria-hidden="true"></span>
            <div class="ledger-head">
              <span>交易复盘 / 2024—2025<br>个人账本 · 示例数据</span>
              <span class="ledger-seal" aria-hidden="true">可<br>复查</span>
            </div>
            <div class="ledger-metrics">
              <div class="ledger-metric"><span>实际收益</span><strong>¥12,480</strong><small>+12.48%</small></div>
              <div class="ledger-metric"><span>买入不动</span><strong>¥18,920</strong><small>+18.92%</small></div>
              <div class="ledger-metric loss"><span>择时损耗</span><strong>¥6,440</strong><small>6.44pp</small></div>
            </div>
            <div class="ledger-chart" aria-hidden="true">
              <svg viewBox="0 0 340 92" fill="none">
                <path class="hero-grid-line" d="M0 22H340M0 46H340M0 70H340"/>
                <path class="hero-line ghost" d="M0 74C24 72 38 66 62 62C86 58 104 58 126 52C150 46 170 48 194 40C218 32 242 32 268 24C292 17 314 15 340 10"/>
                <path class="hero-line actual" d="M0 74C20 72 34 64 56 64C78 64 96 56 116 58C136 60 154 64 174 56C196 46 212 54 234 54C258 54 280 46 300 40C318 35 330 36 340 32"/>
                <circle class="hero-marker" cx="180" cy="55" r="3.6"/>
              </svg>
            </div>
            <div class="ledger-gap">
              <span class="ledger-gap-label">如果一直拿着，会多</span>
              <b class="ledger-gap-value"><span class="cur">¥</span><span data-count="6440">6,440</span></b>
            </div>
            <div class="ledger-foot">
              <span>每个数字，都能回到原始成交行。</span>
              <a href="#/report" data-demo-link data-demo-route="report">打开完整读数 <span aria-hidden="true">→</span></a>
            </div>
            <span class="ledger-note">决定权，始终在你。</span>
          </aside>
        </div>
        <div class="container hero-caption">
          <span>示例账单 · 5 笔交易 · 3 个标的</span>
          <span>SAMPLE / 估值日 2025-10-17</span>
        </div>
      </section>

      <div class="trust-strip">
        <div class="container trust-strip-inner">
          <div class="trust-cell"><span class="t-idx">LOCAL</span><div><strong>本地读取</strong><p>原始账单不离开浏览器</p></div></div>
          <div class="trust-cell"><span class="t-idx">TRACE</span><div><strong>可回查</strong><p>公式与成交行都能展开</p></div></div>
          <div class="trust-cell"><span class="t-idx">NO ADVICE</span><div><strong>不给建议</strong><p>不荐股、不预测涨跌</p></div></div>
          <div class="trust-cell"><span class="t-idx">YOUR CALL</span><div><strong>你来决定</strong><p>规则由你确认，系统不代劳</p></div></div>
        </div>
      </div>

      <section class="section">
        <div class="container">
          <header class="sec-head">
            <div class="sec-index">01</div>
            <div>
              <p class="eyebrow">WHY MIRROR</p>
              <h2>数字有很多，<br>你只需要一把尺。</h2>
            </div>
            <p class="sec-note">镜子不评价你的操作，也不给下一步建议。它只做一件事：把“你的操作”和“买入不动”放在同一个本金、同一段行情里对照。</p>
          </header>
          <div class="value-grid">
            <article class="value-card">
              <div class="value-top"><span>01 / COMPARE</span><b>同尺</b></div>
              <div class="value-viz" aria-hidden="true">
                <div class="viz-scale">
                  <div class="vs-row"><span class="vs-label">你的</span><span class="vs-track"><span class="vs-fill blue"></span></span></div>
                  <div class="vs-row"><span class="vs-label">不动</span><span class="vs-track"><span class="vs-fill ink"></span></span></div>
                  <div class="vs-row"><span class="vs-label">差额</span><span class="vs-track"><span class="vs-fill orange"></span></span></div>
                </div>
              </div>
              <h3>同尺对比</h3>
              <p>不是给你打分，而是给出一把尺。同一个本金、同一段行情，把两种选择的期末价值并排放。</p>
              <div class="value-foot">ACTUAL VS. BUY &amp; HOLD</div>
            </article>
            <article class="value-card">
              <div class="value-top"><span>02 / BREAK DOWN</span><b>拆解</b></div>
              <div class="value-viz" aria-hidden="true">
                <div class="viz-split">
                  <span class="s1">合计差额 <b>−¥6,440</b></span>
                  <span class="s2">600519<b>−4,440</b></span>
                  <span class="s3">300750<b>−2,000</b></span>
                  <span class="s4">601318<b>0</b></span>
                </div>
              </div>
              <h3>差额拆解</h3>
              <p>6,440 不是一个结论，是一组可以追到标的的线索。按标的拆开，看到差额落在哪一笔、哪一天。</p>
              <div class="value-foot">FROM TOTAL TO EACH SYMBOL</div>
            </article>
            <article class="value-card">
              <div class="value-top"><span>03 / TRACE BACK</span><b>证据</b></div>
              <div class="value-viz" aria-hidden="true">
                <div class="viz-ledger">
                  <div><span>02 · 2025-01-15</span><b>卖出 600519</b></div>
                  <div><span>04 · 2025-03-14</span><b>卖出 300750</b></div>
                  <div><span>05 · 2024-11-07</span><b class="miss">费用缺失</b></div>
                </div>
              </div>
              <h3>逐笔证据</h3>
              <p>每个数字都能回到成交行：公式、数据来源、估值日、缺失的费用，全都在报告里标明，不用相信黑箱。</p>
              <div class="value-foot">EVERY NUMBER HAS A SOURCE</div>
            </article>
          </div>
        </div>
      </section>

      <section class="section how">
        <div class="container how-grid">
          <div class="how-copy">
            <p class="eyebrow">HOW IT WORKS</p>
            <h2>三步，<br>把模糊变具体。</h2>
            <p>不需要连接券商账户，不需要交出原始账单。先在一个示例或自己的 CSV 上，把流程走一遍。</p>
            <a class="link-arrow" href="#/import">从第一步开始 <span aria-hidden="true">→</span></a>
          </div>
          <ol class="steps">
            <li>
              <span class="step-idx">01</span>
              <div><h3>导入</h3><p>选择 CSV，浏览器在本机读取和校验。原始文件不上传；格式不对就整批阻断。</p></div>
              <span class="step-mark" aria-hidden="true">↓</span>
            </li>
            <li>
              <span class="step-idx">02</span>
              <div><h3>核对</h3><p>逐行看日期、方向、价格、数量；缺失的费用与税费会被标出，确认后再进入分析。</p></div>
              <span class="step-mark" aria-hidden="true">↓</span>
            </li>
            <li>
              <span class="step-idx">03</span>
              <div><h3>看见</h3><p>生成同尺对比、差额拆解和逐笔证据。然后可以继续问：这笔差额从哪里来？</p></div>
              <span class="step-mark" aria-hidden="true">→</span>
            </li>
          </ol>
        </div>
      </section>

      <section class="privacy">
        <div class="container privacy-inner">
          <span class="privacy-grain" aria-hidden="true"></span>
          <div class="privacy-copy">
            <p class="eyebrow light">PRIVACY BY DEFAULT</p>
            <h2>你的账单，<br>不用离开<em>你的浏览器</em>。</h2>
            <p class="privacy-foot">LOCAL-FIRST · 原型演示</p>
          </div>
          <div class="privacy-points">
            <div><span>01</span><p>CSV 由浏览器本地读取和校验，账单内容不会上传。</p></div>
            <div><span>02</span><p>只有标的代码与日期范围会用于获取最新已收盘行情；取数失败就明确阻断，不用假数据补齐。</p></div>
            <div><span>03</span><p>规则与版本记录默认只保存在本机浏览器，你可以随时清空。</p></div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="container">
          <div class="talk-shell">
            <div class="talk-copy">
              <p class="eyebrow">ASK THE MIRROR</p>
              <h2>问它为什么，<br>别问它买什么。</h2>
              <p>它只复述这份账单里的事实：哪一笔代价最高、差额从哪里来、如果没卖会怎样。不预测涨跌，不推荐标的。</p>
              <a class="btn btn-outline" href="#/chat" data-demo-link data-demo-route="chat">看看它怎么回答 <span class="arrow">→</span></a>
            </div>
            <div class="talk-demo">
              <div class="talk-q">为什么差额是 6,440？</div>
              <div class="talk-a">
                <span class="sample-tag">示例 · 事实复述</span>
                <p>因为期末对照价值是 <strong>¥118,920</strong>，你的实际价值是 <strong>¥112,480</strong>。差额 = 对照 − 实际 = <strong>¥6,440</strong>，占对照收益的 <strong>34.0%</strong>。</p>
                <a href="#/report" data-demo-link data-demo-route="report">查看证据 →</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band">
        <div class="container cta-inner">
          <div class="cta-copy">
            <p class="eyebrow">START MEASURING / 开始照见</p>
            <h2>下一次决定之前，<br>先看清上一次。</h2>
            <div class="cta-actions">
              <a class="btn btn-primary btn-lg" href="#/import">导入我的账单 <span class="arrow">→</span></a>
              <a class="link-arrow" href="#/report" data-demo-link data-demo-route="report">先看示例报告 <span aria-hidden="true">↗</span></a>
            </div>
            <p class="cta-note">虚构示例 · 不构成投资建议 · 不荐股 · 不预测 · 决定权在你</p>
          </div>
          <div class="cta-stamp" aria-hidden="true">
            <span>DECIDE<br>WITH<br>EVIDENCE</span>
            <small>TM / 2026</small>
          </div>
        </div>
      </section>
    </div>`;
  }

  /* ---------- import ---------- */

  function billWarningsHTML(trades) {
    const missing = trades.filter((t) => t.fee === null || t.tax === null);
    if (!missing.length) return '';
    const lines = missing.map((t) => t.line).join('、');
    return `<div class="bill-warning" role="status">
      <strong>${missing.length} 行费用或税费缺失</strong>
      <span>第 ${lines} 行按 0 展示并标注。示例报告未将费用与税费计入收益，正式版会按产品口径单列。</span>
    </div>`;
  }

  function tradesTableHTML(trades) {
    const rows = trades.map((t) => `<tr class="${t.fee === null || t.tax === null ? 'is-missing' : ''}">
      <td class="line-no">${String(t.line).padStart(2, '0')}</td>
      <td>${esc(t.date)}</td>
      <td><span class="sym">${esc(t.symbol)}</span>${t.name ? `<span class="sym-name">${esc(t.name)}</span>` : ''}</td>
      <td><span class="side ${t.side === 'buy' ? 'buy' : 'sell'}">${t.side === 'buy' ? '买入' : '卖出'}</span></td>
      <td class="num">${Number(t.price).toFixed(2)}</td>
      <td class="num">${intFmt(t.quantity)}</td>
      <td class="num">${t.fee === null ? '<span class="missing">缺失（按 0）</span>' : Number(t.fee).toFixed(2)}</td>
      <td class="num">${t.tax === null ? '<span class="missing">缺失（按 0）</span>' : Number(t.tax).toFixed(2)}</td>
    </tr>`).join('');

    return `<div class="table-wrap">
      <table class="ledger">
        <caption class="sr-only">交易列表，可逐行核对日期、标的、方向、价格、数量、费用与税费。</caption>
        <thead><tr><th>行</th><th>日期</th><th>标的</th><th>方向</th><th class="num">价格</th><th class="num">数量</th><th class="num">费用</th><th class="num">税费</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function errorPanelHTML() {
    const bill = state.bill;
    if (bill.status === 'error') {
      return `<div class="error-panel" role="alert">
        <h2>没有读取成功</h2>
        <p>${esc(bill.error || '未知错误')}</p>
        <p class="fine">原始文件不会被上传。修正问题后，可以重新选择文件。</p>
      </div>`;
    }
    const shown = bill.errors.slice(0, 10);
    const rest = bill.errors.length - shown.length;
    return `<div class="error-panel" role="alert">
      <h2>不能生成报告：文件里有需要修改的地方</h2>
      <p>为保证结果可核对，只要一处不通过就整批阻断，不生成部分结果。${bill.fileName ? `当前文件：${esc(bill.fileName)}。` : ''}</p>
      <ul class="error-list">
        ${shown.map((e) => `<li>${e.line ? `第 ${e.line} 行 · ` : ''}${esc(e.message)}</li>`).join('')}
        ${rest > 0 ? `<li>另有 ${rest} 处问题未展开。</li>` : ''}
      </ul>
      <p class="fine">修改 CSV 后，重新拖入或选择文件即可；当前结果不会被用于报告。</p>
    </div>`;
  }

  function billPanelHTML() {
    const bill = state.bill;
    if (bill.status !== 'loaded') return '';
    const trades = bill.trades;
    const symbols = new Set(trades.map((t) => t.symbol)).size;
    const dates = trades.map((t) => t.date).sort();
    const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—';
    const sourceLabel = bill.source === 'demo' ? '示例账单' : '本地 CSV';
    const statusTag = bill.confirmed
      ? '<span class="status-tag ok">已确认</span>'
      : '<span class="status-tag ok">本地校验通过</span>';

    return `<section class="panel bill" id="bill" aria-labelledby="bill-title">
      <div class="bill-head">
        <div>
          <p class="mono-label">BILL / 交易核对</p>
          <h2 id="bill-title">已读取 ${trades.length} 笔交易。</h2>
        </div>
        <div class="bill-tags">${statusTag}<span class="status-tag">仅本机</span></div>
      </div>
      <div class="bill-meta">
        <span>来源 <b>${sourceLabel}</b></span>
        <span>文件 <b class="file-line">${esc(bill.fileName || '示例账单.csv')}</b></span>
        <span>期间 <b>${range}</b></span>
        <span>标的 <b>${symbols} 个</b></span>
        <span>文件大小 <b>${bill.fileSize ? fmtSize(bill.fileSize) : '内置'}</b></span>
      </div>
      ${billWarningsHTML(trades)}
      ${tradesTableHTML(trades)}
      <div class="bill-actions">
        <div class="bill-actions-note">
          <span class="plus" aria-hidden="true">＋</span>
          <p class="fine">确认只用于生成本地分析，不会上传文件，也不会执行交易。费用与税费按列展示；本原型报告数字仍为示例数据。</p>
        </div>
        <button class="btn btn-primary" id="confirm-bill" type="button">${bill.confirmed ? '前往示例报告 →' : '确认并生成报告 →'}</button>
      </div>
    </section>`;
  }

  function importPage() {
    return '<div id="tm-real-import"></div>';
  }

  /* ---------- report ---------- */

  function buildChart() {
    const W = 1000;
    const H = 340;
    const left = 64;
    const right = 956;
    const top = 30;
    const bottom = 278;
    const min = 96000;
    const max = 120000;
    const start = Date.parse(`${DEMO.series[0].date}T00:00:00Z`);
    const end = Date.parse(`${DEMO.series[DEMO.series.length - 1].date}T00:00:00Z`);

    const xOf = (date) => left + ((Date.parse(`${date}T00:00:00Z`) - start) / (end - start)) * (right - left);
    const yOf = (value) => top + ((max - value) / (max - min)) * (bottom - top);

    const points = DEMO.series.map((row) => ({
      date: row.date,
      actual: row.actual,
      passive: row.passive,
      sell: row.sell || null,
      x: xOf(row.date),
      yActual: yOf(row.actual),
      yPassive: yOf(row.passive),
    }));
    lastChartPoints = points;

    const smooth = (key) => {
      let d = `M${points[0].x.toFixed(1)},${points[0][key].toFixed(1)}`;
      for (let i = 1; i < points.length; i += 1) {
        const prev = points[i - 1];
        const cur = points[i];
        const mid = (prev.x + cur.x) / 2;
        d += ` C${mid.toFixed(1)},${prev[key].toFixed(1)} ${mid.toFixed(1)},${cur[key].toFixed(1)} ${cur.x.toFixed(1)},${cur[key].toFixed(1)}`;
      }
      return d;
    };

    const actualPath = smooth('yActual');
    const passivePath = smooth('yPassive');
    const areaPath = `${actualPath} L${points[points.length - 1].x.toFixed(1)},${bottom} L${points[0].x.toFixed(1)},${bottom} Z`;

    const yTicks = [120000, 115000, 110000, 105000, 100000];
    const yGrid = yTicks.map((v) => {
      const y = yOf(v).toFixed(1);
      return `<line class="chart-grid-line" x1="${left}" y1="${y}" x2="${right}" y2="${y}"></line>
        <text class="chart-axis-text" x="${left - 10}" y="${Number(y) + 3}" text-anchor="end">${intFmt(v)}</text>`;
    }).join('');

    const xIdx = [0, 3, 6, 9, 11];
    const xGrid = xIdx.map((i) => {
      const p = points[i];
      const textAnchor = i === 0 ? 'start' : i === 11 ? 'end' : 'middle';
      const label = p.date.slice(0, 7).replace('-', '.');
      return `<line class="chart-axis-line" x1="${p.x.toFixed(1)}" y1="${bottom}" x2="${p.x.toFixed(1)}" y2="${bottom + 5}" opacity="0.55"></line>
        <text class="chart-axis-text" x="${p.x.toFixed(1)}" y="${bottom + 20}" text-anchor="${textAnchor}">${label}</text>`;
    }).join('');

    const sellMarks = points.filter((p) => p.sell).map((p, idx) => {
      const label = idx === 0 ? '01 卖出 600519' : '02 卖出 300750';
      return `<g>
        <line class="chart-sell-line" x1="${p.x.toFixed(1)}" y1="${top}" x2="${p.x.toFixed(1)}" y2="${bottom}"></line>
        <circle class="chart-marker" cx="${p.x.toFixed(1)}" cy="${p.yActual.toFixed(1)}" r="4"></circle>
        <text class="chart-annot" x="${(p.x + 9).toFixed(1)}" y="${top + 12}">${label}</text>
        <text class="chart-annot-sub" x="${(p.x + 9).toFixed(1)}" y="${top + 24}">${p.date}</text>
      </g>`;
    }).join('');

    const last = points[points.length - 1];
    const first = points[0];

    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title chart-desc">
      <title id="chart-title">实际价值与买入不动价值的走势对照</title>
      <desc id="chart-desc">示例组合从 2024 年 11 月 6 日的 100,000 元，到 2025 年 10 月 17 日实际价值 112,480 元、买入不动价值 118,920 元。两次卖出点已标出。</desc>
      ${yGrid}
      ${xGrid}
      <path class="chart-area" d="${areaPath}"></path>
      <path class="chart-passive-line" d="${passivePath}"></path>
      <path class="chart-actual-line js-chart-line" d="${actualPath}"></path>
      ${sellMarks}
      <circle class="chart-end-dot" cx="${last.x}" cy="${last.yActual}" r="4"></circle>
      <circle class="chart-end-dot passive" cx="${last.x}" cy="${last.yPassive}" r="3.5"></circle>
      <line class="chart-axis-line" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"></line>
      <g class="chart-focus" hidden>
        <line id="chart-focus-line" class="chart-focus-line" x1="0" y1="${top}" x2="0" y2="${bottom}"></line>
        <circle id="chart-focus-actual" class="chart-focus-dot" cx="0" cy="0" r="4"></circle>
        <circle id="chart-focus-passive" class="chart-focus-dot passive" cx="0" cy="0" r="3.5"></circle>
      </g>
      <circle class="chart-marker" cx="${first.x}" cy="${first.yActual}" r="3"></circle>
    </svg>`;

    const tableRows = points.map((p) => `<tr>
      <td>${p.date}</td>
      <td class="num">${money(p.actual)}</td>
      <td class="num">${money(p.passive)}</td>
      <td class="num">${money(p.passive - p.actual)}</td>
    </tr>`).join('');

    const table = `<details class="chart-data">
      <summary>查看逐月数据</summary>
      <div class="table-wrap">
        <table class="ledger">
          <thead><tr><th>日期</th><th class="num">你的操作</th><th class="num">买入不动</th><th class="num">差额</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </details>`;

    return { svg, table };
  }

  function reportStatusLabel() {
    if (state.bill.confirmed && state.bill.source === 'local') return '已确认 · 本地账单';
    if (state.bill.confirmed && state.bill.source === 'demo') return '已确认 · 示例账单';
    if (state.bill.status === 'loaded') return '已读取 · 待确认';
    return '示例报告';
  }

  function reportPage() {
    const mode = pageMode('report');
    if (mode === 'real') return realReportPage();
    if (mode === 'empty') return emptyStatePage('report');
    const chart = buildChart();
    const localNotice = (state.bill.source === 'local' && (state.bill.confirmed || state.bill.status === 'loaded'))
      ? `<div class="notice" role="status"><div>你导入的「${esc(state.bill.fileName)}」已通过本机基础校验（${state.bill.trades.length} 笔交易）。本原型尚未接入计算引擎，<strong>报告数字仍为示例数据</strong>，这里只演示从导入、核对到报告的完整流程。</div></div>`
      : '';

    return `${pageHead({
      code: 'STEP 02 / REPORT',
      title: '同一把尺，<br>量出差距。',
      intro: `<div class="report-meta">
        <div class="report-account"><span>ACCOUNT / 示例账户</span><span>${reportStatusLabel()}</span></div>
        <dl>
          <div><dt>报告期间</dt><dd>2024-11-06 → 2025-10-17</dd></div>
          <div><dt>估值日</dt><dd>2025-10-17</dd></div>
          <div><dt>初始本金</dt><dd>¥100,000</dd></div>
          <div><dt>数据性质</dt><dd><span class="status-dot">示例 · 非实时</span></dd></div>
        </dl>
      </div>`,
      right: '<span class="sample-tag">示例数据</span><a class="text-link" href="#/import">换一份账单</a>',
    })}
    <div class="container report-body">
      ${localNotice}
      <div class="report-disclaimer">
        <span class="sample-tag">示例数据</span>
        <p>本页使用一份虚构的示例账单与示例估值价，用来演示「同尺对比」。所有数字不代表任何真实账户，也不构成投资建议或收益承诺。</p>
      </div>

      <section class="delta-card reveal" aria-labelledby="delta-title">
        <div class="delta-main">
          <p class="delta-eyebrow">SAME ¥100,000 / 同一把尺</p>
          <p class="delta-label" id="delta-title">你的操作，比「买入不动」少赚</p>
          <p class="delta-number"><span class="minus">−</span><span class="cur">¥</span><span data-count="6440">6,440</span></p>
          <p class="delta-note">相当于对照收益的 <strong>34.0%</strong>。这是事后对照，不是预测，也不评判当时的决定。</p>
        </div>
        <div class="delta-side">
          <div class="delta-stat"><span>实际收益</span><strong>+¥12,480</strong><small>+12.48%</small></div>
          <div class="delta-stat"><span>买入不动</span><strong>+¥18,920</strong><small>+18.92%</small></div>
          <div class="delta-stat"><span>择时损耗</span><strong class="orange">¥6,440</strong><small>−6.44pp</small></div>
        </div>
      </section>

      <div class="metric-grid">
        <article class="metric-card">
          <p class="m-idx">01 / ACTUAL</p>
          <p class="m-label">实际收益</p>
          <p class="m-value">+¥12,480</p>
          <p class="m-sub">+12.48%</p>
          <p class="m-desc">期末价值 ¥112,480 − 初始本金 ¥100,000</p>
        </article>
        <article class="metric-card">
          <p class="m-idx">02 / BUY &amp; HOLD</p>
          <p class="m-label">对照收益</p>
          <p class="m-value">+¥18,920</p>
          <p class="m-sub">+18.92%</p>
          <p class="m-desc">初始持仓全部持有至估值日的示例价值</p>
        </article>
        <article class="metric-card">
          <p class="m-idx">03 / TIMING GAP</p>
          <p class="m-label">择时损耗</p>
          <p class="m-value accent">¥6,440</p>
          <p class="m-sub">6.44pp · 对照 − 实际</p>
          <p class="m-desc">正值表示相对买入不动少赚，不代表每笔交易都错</p>
        </article>
        <article class="metric-card">
          <p class="m-idx">04 / UNDERLYING</p>
          <p class="m-label">标的自身涨幅</p>
          <p class="m-value">+18.92%</p>
          <p class="m-sub">买入价 → 示例估值价 · 加权</p>
          <p class="m-desc">组合内 3 个标的的加权持有涨幅</p>
        </article>
      </div>

      <section class="report-section" id="scale" aria-labelledby="scale-title">
        <div class="report-sec-head">
          <div class="rs-title"><span class="rs-idx">01</span><h2 id="scale-title">同一把尺上，差在哪里。</h2></div>
          <p>单位：元 · 不含 10 万本金</p>
        </div>
        <div class="panel scale-card">
          <div class="scale-top"><span>条形长度 = 期末增值 · 刻度 0–20,000</span><span>EST. 2025-10-17</span></div>
          <div class="scale-row">
            <div class="scale-row-label"><strong>你的操作</strong><span>ACTUAL</span></div>
            <div class="track" role="img" aria-label="你的操作期末增值 12,480 元"><span class="fill blue"></span></div>
            <div class="scale-row-value">¥12,480<small>+12.48%</small></div>
          </div>
          <div class="scale-row">
            <div class="scale-row-label"><strong>买入不动</strong><span>BUY &amp; HOLD</span></div>
            <div class="track" role="img" aria-label="买入不动期末增值 18,920 元，其中橙色段为差额 6,440 元"><span class="fill ink"></span><span class="fill orange"></span></div>
            <div class="scale-row-value">¥18,920<small>+18.92%</small></div>
          </div>
          <div class="scale-axis" aria-hidden="true">
            <div></div>
            <div class="axis-ticks"><span>0</span><span>5,000</span><span>10,000</span><span>15,000</span><span>20,000</span></div>
            <div></div>
          </div>
          <div class="scale-legend">
            <span><i class="lg-blue"></i>你的操作</span>
            <span><i class="lg-ink"></i>买入不动</span>
            <span><i class="lg-orange"></i>差额 ¥6,440（占对照收益 34.0%）</span>
          </div>
          <p class="scale-note">橙色段是买入不动与你的操作之间的差距。示例未计入费用与税费，也不含分红与送转。</p>
        </div>
      </section>

      <section class="report-section" id="chart" aria-labelledby="chart-heading">
        <div class="report-sec-head">
          <div class="rs-title"><span class="rs-idx">02</span><h2 id="chart-heading">价值怎么走，差距从哪天开始。</h2></div>
          <p>2024-11-06 → 2025-10-17</p>
        </div>
        <div class="panel chart-card">
          <div class="chart-head">
            <div class="chart-legend">
              <span><i class="line-blue"></i>你的操作</span>
              <span><i class="line-ink"></i>买入不动</span>
              <span><i class="mark-orange"></i>卖出点</span>
            </div>
            <span class="chart-range">MONTHLY / 示例组合价值</span>
          </div>
          <div class="chart-stage" id="chart-stage">
            ${chart.svg}
            <div class="chart-tip" hidden></div>
          </div>
          <div class="chart-foot">
            <span>2025-01-15 卖出 600519</span>
            <span>2025-03-14 卖出 300750</span>
            <span>2025-10-17 估值日</span>
          </div>
          ${chart.table}
        </div>
      </section>

      <section class="report-section" id="breakdown" aria-labelledby="breakdown-title">
        <div class="report-sec-head">
          <div class="rs-title"><span class="rs-idx">03</span><h2 id="breakdown-title">6,440，拆到每一只标的。</h2></div>
          <p>期末价值口径 · 示例</p>
        </div>
        <div class="breakdown-grid">
          <div class="panel breakdown-table-card">
            <div class="table-wrap">
              <table class="ledger">
                <caption class="sr-only">按标的拆解实际价值与买入不动价值的差额</caption>
                <thead><tr><th>标的</th><th class="num">本金</th><th class="num">你的操作</th><th class="num">买入不动</th><th class="num">差额</th></tr></thead>
                <tbody>
                  <tr><td><span class="sym">600519</span><span class="sym-name">贵州茅台</span></td><td class="num">20,000</td><td class="num">22,000</td><td class="num">26,440</td><td class="num">−4,440</td></tr>
                  <tr><td><span class="sym">300750</span><span class="sym-name">宁德时代</span></td><td class="num">30,000</td><td class="num">34,000</td><td class="num">36,000</td><td class="num">−2,000</td></tr>
                  <tr><td><span class="sym">601318</span><span class="sym-name">中国平安</span></td><td class="num">50,000</td><td class="num">56,480</td><td class="num">56,480</td><td class="num">0</td></tr>
                </tbody>
                <tfoot><tr><td>合计</td><td class="num">100,000</td><td class="num">112,480</td><td class="num">118,920</td><td class="num">−6,440</td></tr></tfoot>
              </table>
            </div>
            <p class="scale-note">「你的操作」按期末价值计：已卖出部分计成交所得，未卖出部分按示例估值价计；未计费用与税费。</p>
          </div>
          <aside class="sell-notes" aria-label="两次卖出说明">
            <div class="sell-note">
              <p class="sn-date">2025-01-15 · SELL</p>
              <strong>600519 × 100</strong>
              <p>卖出价 220.00，估值价 264.40。所得 ¥22,000；若持有到估值日为 ¥26,440。</p>
              <span class="sn-loss">差额 −¥4,440</span>
            </div>
            <div class="sell-note">
              <p class="sn-date">2025-03-14 · SELL</p>
              <strong>300750 × 100</strong>
              <p>卖出价 160.00，估值价 180.00。卖出所得与剩余 100 股合计 ¥34,000；持有不动为 ¥36,000。</p>
              <span class="sn-loss">差额 −¥2,000</span>
            </div>
          </aside>
        </div>
      </section>

      <section class="report-section evidence" id="evidence" aria-labelledby="evidence-title">
        <div class="evidence-head">
          <p class="eyebrow">TRACE BACK / 05</p>
          <h2 id="evidence-title">每个数字，<br>都有来处。</h2>
          <p>展开公式，核对成交行、估值价与日期。这里没有黑箱，也不需要你“相信”一个结论。</p>
          <a class="btn btn-outline" href="#/chat">带着问题去问 <span class="arrow">→</span></a>
        </div>
        <div class="evidence-list">
          <details class="evidence-item" open>
            <summary><span class="ev-idx">01</span><h3>实际收益怎么算？</h3><span class="ev-plus" aria-hidden="true">+</span></summary>
            <div class="evidence-body">
              <p>按成交所得和期末持仓的示例估值价计算：</p>
              <p class="formula">期末现金 = 22,000（卖出 600519）+ 16,000（卖出 300750）= 38,000<br>期末持仓 = 100 × 180.00（300750）+ 500 × 112.96（601318）= 74,480<br>期末价值 = 38,000 + 74,480 = 112,480<br>实际收益 = 112,480 − 100,000 = +12,480</p>
              <p>费用与税费单列，未从上述收益中扣除；这是原型演示口径。</p>
            </div>
          </details>
          <details class="evidence-item">
            <summary><span class="ev-idx">02</span><h3>买入不动的对照价值怎么来？</h3><span class="ev-plus" aria-hidden="true">+</span></summary>
            <div class="evidence-body">
              <p>假设期初的 3 个持仓全部不动，持有到估值日：</p>
              <p class="formula">100 × 264.40（600519）= 26,440<br>200 × 180.00（300750）= 36,000<br>500 × 112.96（601318）= 56,480<br>合计 = 118,920<br>对照收益 = 118,920 − 100,000 = +18,920（+18.92%）</p>
            </div>
          </details>
          <details class="evidence-item">
            <summary><span class="ev-idx">03</span><h3>6,440 和 6.44pp 分别是什么？</h3><span class="ev-plus" aria-hidden="true">+</span></summary>
            <div class="evidence-body">
              <p class="formula">差额 = 118,920 − 112,480 = 6,440<br>占对照收益 = 6,440 ÷ 18,920 = 34.0%<br>收益率差 = 18.92% − 12.48% = 6.44pp</p>
              <p>金额差看“少了多少钱”，百分点差看“收益率少了多少”。两者不是同一个单位。</p>
            </div>
          </details>
          <details class="evidence-item">
            <summary><span class="ev-idx">04</span><h3>两次卖出各留下了多少差额？</h3><span class="ev-plus" aria-hidden="true">+</span></summary>
            <div class="evidence-body">
              <p class="formula">600519：22,000 − 26,440 = −4,440<br>300750：34,000 − 36,000 = −2,000<br>601318：56,480 − 56,480 = 0<br>合计：−6,440</p>
              <p>差额不是“亏损”，而是与买入不动的事后对照。它不含费用、税费、分红与送转。</p>
            </div>
          </details>
          <details class="evidence-item">
            <summary><span class="ev-idx">05</span><h3>数据从哪里来，边界是什么？</h3><span class="ev-plus" aria-hidden="true">+</span></summary>
            <div class="evidence-body">
              <div class="evidence-kv">
                <span>交易数据</span><b>示例账单 · 5 行 · 3 个标的</b>
                <span>示例估值价</span><b>600519 ¥264.40 / 300750 ¥180.00 / 601318 ¥112.96</b>
                <span>估值日期</span><b>2025-10-17</b>
                <span>计算口径</span><b>期末价值法；费用税费单列；不含分红送转</b>
                <span>用途</span><b>产品原型演示 · 不构成投资建议</b>
              </div>
              <p style="margin-top: 12px;">正式版将用 Tushare 最新已收盘日线获取行情，并在报告中逐项标注来源；取数失败会明确阻断，不回退到合成行情。</p>
            </div>
          </details>
        </div>
      </section>

      <div class="boundary">
        <h3>这份报告没有告诉你的事</h3>
        <div class="boundary-grid">
          <div><b>没有分红与送转</b>示例未计入分红、送转、拆合股，涉及相关区间时结果可能不完整。</div>
          <div><b>费用税费单列</b>示例收益未扣除费用与税费；第 5 行缺失值按 0 展示并标注。</div>
          <div><b>不预测未来</b>这是对已发生交易的事后对照，不是对下一次买卖的建议或收益承诺。</div>
        </div>
      </div>

      <div class="report-next">
        <p><strong>看懂差额之后，</strong>可以继续追问，也可以把下一笔写成规则。</p>
        <div class="actions">
          <a class="btn btn-outline" href="#/chat">问镜子为什么 <span class="arrow">→</span></a>
          <a class="btn btn-primary" href="#/rules">写下一条规则 <span class="arrow">→</span></a>
        </div>
      </div>
    </div>`;
  }

  /* ---------- chat ---------- */

  function messageHTML(message) {
    if (message.role === 'user') {
      return `<div class="msg msg-user">
        <span class="msg-avatar" aria-hidden="true">你</span>
        <div class="msg-body">
          <div class="msg-meta"><strong>你</strong></div>
          <div class="bubble user"><p>${esc(message.text)}</p></div>
        </div>
      </div>`;
    }
    return `<div class="msg msg-bot">
      <span class="msg-avatar" aria-hidden="true">镜</span>
      <div class="msg-body">
        <div class="msg-meta"><strong>镜子</strong><span class="sample-tag tiny">${message.online ? '在线复述' : '示例'}</span></div>
        <div class="bubble bot">
          ${message.html}
          ${message.notice ? `<p class="answer-notice">${esc(message.notice)}</p>` : ''}
          <div class="answer-evidence">
            <span>${message.online ? '站点后端在线复述 · 回答中的数字已在本机核对' : message.evidence ? '事实来源：示例账单 · 5 条交易 · 估值日 2025-10-17' : '边界：不预测 · 不荐股 · 不替你决定'}</span>
            ${message.evidence ? '<button type="button" data-evidence-link>查看证据 →</button>' : ''}
          </div>
        </div>
      </div>
    </div>`;
  }

  function isOnlineQuestion(text) {
    return /(组合|整体).*(表现|如何|怎么样)/.test(text) || /在线复述/.test(text);
  }

  function textToHTML(text) {
    return String(text || '')
      .split(/\n{2,}/)
      .map((part) => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  async function askOnline(question) {
    try {
      const [{ createOnlineBoundary }, { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS }] = await Promise.all([
        import('../../src/agent/onlineBoundary.js'),
        import('../../src/agent/httpTransport.js'),
      ]);
      const boundary = createOnlineBoundary({
        transport: createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS }),
        timeoutMs: 8000,
      });
      const prompt = `${question} 已核对事实：实际收益 +12.48%，买入不动 +18.92%，收益率差 6.44pp，金额差 ¥6,440.00。请只复述这些数字与事实，不预测、不推荐、不评价。`;
      const result = await boundary.restate({ question: prompt, facts: ONLINE_FACTS });
      if (!result.ok) return { ok: false, code: result.code };
      return {
        ok: true,
        text: result.data.draft,
        checked: Number(result.data.number_check?.checked) || 0,
      };
    } catch {
      return { ok: false, code: 'E_PROTOTYPE_ONLINE' };
    }
  }

  function chatPage() {
    const mode = pageMode('chat');
    if (mode === 'real') return realChatPage();
    if (mode === 'empty') return emptyStatePage('chat');
    const messages = state.chat.messages.map(messageHTML).join('');
    const typing = state.chat.pending
      ? `<div class="msg msg-bot"><span class="msg-avatar" aria-hidden="true">镜</span><div class="msg-body"><div class="msg-meta"><strong>镜子</strong></div><div class="bubble bot"><div class="chat-typing" aria-label="正在组织事实回答"><i></i><i></i><i></i></div></div></div></div>`
      : '';
    const prompts = [...QA.map((q) => q.question), ONLINE_QUESTION];
    const chips = prompts.map((q) => {
      const online = q === ONLINE_QUESTION;
      return `<button type="button" data-question="${esc(q)}"${online ? ' class="is-online" title="调用站点后端复述，数字仍在本机核对"' : ''}${state.chat.pending ? ' disabled' : ''}>${esc(q)}</button>`;
    }).join('');

    return `${pageHead({
      code: 'STEP 03 / ASK',
      title: '问它为什么，<br>别问它买什么。',
      intro: `<p>镜子只复述这份账单里的事实，并把每个回答的来处摆出来。它不预测涨跌，不推荐标的，也不替你做决定。</p>
        <ul class="mini-rules"><li>事实复述</li><li>证据回跳</li><li>不自由发挥</li></ul>`,
      right: '<span class="sample-tag">示例数据</span>',
    })}
    <div class="container page-body">
      <div class="chat-layout">
        <section class="panel chat-panel" aria-labelledby="chat-title">
          <div class="chat-head">
            <div class="chat-identity">
              <span class="mirror-avatar" aria-hidden="true">镜</span>
              <div><strong id="chat-title">择时镜子</strong><span>ONLY FACTS / 只复述账单事实</span></div>
            </div>
            <div class="chat-tools">
              <span class="sample-tag">示例数据</span>
              <button class="chat-clear" id="clear-chat" type="button">清空对话</button>
            </div>
          </div>
          <div class="chat-log" id="chat-log" aria-live="polite">
            <div class="msg msg-bot">
              <span class="msg-avatar" aria-hidden="true">镜</span>
              <div class="msg-body">
                <div class="msg-meta"><strong>镜子</strong><span>WELCOME</span></div>
                <div class="bubble bot">
                  <p>你好，我是择时镜子。我只看这份示例账单里的事实，不预测涨跌，也不推荐买卖。</p>
                  <p>你可以问我：哪一笔的代价最高？差额是怎么算出来的？</p>
                  <p>「组合整体表现如何？」会调用站点后端复述，数字先在本机核对；后端不可用时自动回退本机事实。</p>
                </div>
              </div>
            </div>
            ${messages}
            ${typing}
          </div>
          <div class="chat-suggest" aria-label="可以问的问题">${chips}</div>
          <form class="composer" id="chat-form">
            <label class="sr-only" for="chat-input">输入你的问题</label>
            <textarea id="chat-input" rows="1" maxlength="120" placeholder="问一个关于这份账单的问题…" ${state.chat.pending ? 'disabled' : ''}></textarea>
            <button class="btn btn-primary" type="submit" ${state.chat.pending ? 'disabled' : ''}>发送 <span class="arrow">→</span></button>
          </form>
          <p class="fine chat-fine">预设回答 + 可选在线复述。在线时只发送你的问题和 4 个已核对数字，不会上传账单；回答中的数字会再经本机校验，失败即回退本机事实。不会提供买卖建议，也不会下单。</p>
        </section>

        <aside class="facts-panel" aria-labelledby="facts-title">
          <div class="facts-head"><span id="facts-title">FACT SHEET / 事实清单</span><span class="sample-tag tiny">示例</span></div>
          <dl class="facts">
            <div><dt>初始本金</dt><dd>¥100,000</dd></div>
            <div><dt>估值日</dt><dd>2025-10-17</dd></div>
            <div><dt>实际收益</dt><dd>+¥12,480</dd></div>
            <div><dt>对照收益</dt><dd>+¥18,920</dd></div>
            <div><dt>差额</dt><dd class="orange">¥6,440</dd></div>
            <div><dt>交易 / 标的</dt><dd>5 笔 / 3 个</dd></div>
          </dl>
          <div class="facts-note">
            <strong>它不会：</strong>
            <ul>
              <li>预测涨跌</li>
              <li>推荐具体标的</li>
              <li>替你下单或定规则</li>
            </ul>
          </div>
          <a class="btn btn-outline" href="#/report">回到完整报告 <span class="arrow">→</span></a>
        </aside>
      </div>
    </div>`;
  }

  function answerFor(question) {
    if (/(费用|税费|手续费|佣金)/.test(question)) return QA[3];
    if (/(如果|不卖|没卖|没有卖|会怎样)/.test(question)) return QA[2];
    if (/(差额|6440|6,440|为什么|怎么算|怎么来)/.test(question)) return QA[1];
    if (/(最错|最贵|哪笔|哪一笔|哪个|代价)/.test(question)) return QA[0];
    if (/(预测|涨|跌|推荐|买什么|卖什么|荐股|明天|会涨)/.test(question)) return BOUNDARY_ANSWER;
    return FALLBACK_ANSWER;
  }

  function askQuestion(raw) {
    if (state.chat.pending) return;
    const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const requestId = ++chatRequestSeq;
    state.chat.requestId = requestId;
    const isCurrent = () => state.chat.requestId === requestId;
    state.chat.messages.push({ role: 'user', text });
    state.chat.pending = true;
    render();

    if (isOnlineQuestion(text)) {
      askOnline(text).then((result) => {
        if (!isCurrent()) return;
        if (result.ok) {
          state.chat.messages.push({
            role: 'bot',
            html: textToHTML(result.text),
            evidence: true,
            online: true,
            notice: result.checked > 0
              ? `在线复述，已在本机核对 ${result.checked} 个数字。`
              : '在线复述，数字已在本机核对。',
          });
        } else {
          state.chat.messages.push({
            role: 'bot',
            html: LOCAL_OVERVIEW.html,
            evidence: true,
            notice: ONLINE_FALLBACK_NOTICE,
          });
        }
        state.chat.pending = false;
        state.chat.requestId = null;
        if (currentRoute() === 'chat') render();
      });
      return;
    }

    clearTimeout(chatTimer);
    chatTimer = setTimeout(() => {
      if (!isCurrent()) return;
      const answer = answerFor(text);
      state.chat.messages.push({ role: 'bot', html: answer.html, evidence: answer.evidence });
      state.chat.pending = false;
      state.chat.requestId = null;
      if (currentRoute() === 'chat') render();
    }, 680);
  }

  /* ---------- rules ---------- */

  function freshRuleState() {
    return {
      candidates: RULE_CANDIDATES.map((c) => ({ ...c, status: 'open' })),
      active: [],
      log: [],
    };
  }

  function loadRuleState() {
    const fresh = freshRuleState();
    try {
      const raw = localStorage.getItem(RULE_KEY);
      if (!raw) return fresh;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.candidates) || !Array.isArray(data.active) || !Array.isArray(data.log)) return fresh;
      const valid = new Set(['open', 'confirmed', 'rejected']);
      data.candidates.forEach((saved) => {
        const target = fresh.candidates.find((c) => c.id === saved.id);
        if (!target || !valid.has(saved.status)) return;
        target.status = saved.status;
        if (typeof saved.title === 'string') target.title = saved.title.slice(0, 60);
        if (typeof saved.threshold === 'string') target.threshold = saved.threshold.slice(0, 40);
      });
      fresh.active = data.active
        .filter((a) => a && RULE_CANDIDATES.some((c) => c.id === a.id) && typeof a.title === 'string')
        .map((a) => ({
          id: a.id,
          title: a.title.slice(0, 60),
          threshold: String(a.threshold || '').slice(0, 40),
          state: a.state === 'paused' ? 'paused' : 'active',
          version: Number.isFinite(a.version) ? a.version : 1,
          updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : nowStamp(),
        }));
      fresh.log = data.log
        .filter((l) => l && typeof l.title === 'string' && typeof l.action === 'string')
        .slice(-30)
        .map((l) => ({
          title: l.title.slice(0, 60),
          action: l.action.slice(0, 24),
          at: typeof l.at === 'string' ? l.at : nowStamp(),
          kind: ['confirm', 'edit', 'reject', 'pause'].includes(l.kind) ? l.kind : 'confirm',
        }));
      return fresh;
    } catch (err) {
      return fresh;
    }
  }

  function persistRules() {
    try {
      localStorage.setItem(RULE_KEY, JSON.stringify(state.rules));
    } catch (err) {
      showToast('浏览器拒绝了本地存储，本次操作只在当前会话生效。');
    }
  }

  function addRuleLog(title, action, kind) {
    state.rules.log.push({ title, action, at: nowStamp(), kind });
    if (state.rules.log.length > 30) state.rules.log = state.rules.log.slice(-30);
  }

  function renderRulesPage() {
    const mode = pageMode('rules');
    if (mode === 'real') return realRulesPage();
    if (mode === 'empty') return emptyStatePage('rules');
    const candidates = state.rules.candidates.filter((c) => c.status === 'open');
    const active = state.rules.active;
    const activeCount = active.filter((a) => a.state === 'active').length;
    const logs = state.rules.log.slice().reverse();

    const candidateHTML = candidates.length
      ? candidates.map((c, index) => `<article class="rule-card">
          <span class="rule-idx">${String(index + 1).padStart(2, '0')}</span>
          <div class="rule-main">
            <div class="rule-meta"><span class="rule-tag">${esc(c.tag)}</span><span class="cand-code">CANDIDATE / 待确认</span></div>
            <h3>${esc(c.title)}</h3>
            <p>${esc(c.basis)}</p>
            <div class="rule-threshold"><span>触发条件</span><code>${esc(c.threshold)}</code></div>
          </div>
          <div class="rule-actions">
            <button class="btn btn-primary" type="button" data-rule-confirm="${c.id}">确认</button>
            <button class="btn btn-outline" type="button" data-rule-edit="${c.id}">改写</button>
            <button class="btn btn-ghost" type="button" data-rule-reject="${c.id}">拒绝</button>
          </div>
        </article>`).join('')
      : `<div class="rule-empty">3 条候选规则都已处理。已生效的规则在下方，操作记录保存在本机；清空记录可以重新演示。</div>`;

    const activeHTML = active.length
      ? active.map((a) => `<div class="active-rule">
          <div class="active-rule-top">
            <h3>${esc(a.title)}</h3>
            <div class="ar-ops">
              <button class="ar-op" type="button" data-rule-toggle="${a.id}">${a.state === 'active' ? '暂停' : '启用'}</button>
            </div>
          </div>
          <div class="active-rule-meta">
            <span class="rule-state${a.state === 'paused' ? ' paused' : ''}">${a.state === 'active' ? '生效中' : '已暂停'}</span>
            <span>v${a.version}</span>
            <span>${esc(a.threshold)}</span>
            <span>${esc(a.updatedAt)}</span>
          </div>
        </div>`).join('')
      : `<div class="active-empty">还没有生效的规则。确认或改写上方候选后，会在这里出现，并写入版本记录。</div>`;

    const logHTML = logs.length
      ? `<div class="log-wrap"><table class="log-table">
          <thead><tr><th>规则</th><th>动作</th><th>时间</th></tr></thead>
          <tbody>${logs.map((l) => `<tr>
            <td class="rule-name">${esc(l.title)}</td>
            <td class="log-action ${l.kind}">${esc(l.action)}</td>
            <td>${esc(l.at)}</td>
          </tr>`).join('')}</tbody>
        </table></div>`
      : `<div class="log-empty">还没有操作记录。确认、改写、暂停或拒绝一条规则后，这里会出现版本记录。</div>`;

    return `${pageHead({
      code: 'STEP 04 / RULES',
      title: '把「下次别这样」，<br>写成一条规则。',
      intro: `<p>规则不是系统给你的指令，而是你写给下一次自己的备忘。确认、改写或拒绝，都由你决定。</p>
        <ul class="mini-rules"><li>候选由你筛选</li><li>只做提醒</li><li>不自动交易</li><li>只存本机</li></ul>`,
      right: '<span class="sample-tag">原型 · 本机存储</span>',
    })}
    <div class="container page-body">
      <div class="rules-banner">
        <span class="rb-mark" aria-hidden="true">!</span>
        <p><strong>只存在本机 · 不会自动交易。</strong> 原型把规则与版本记录保存在浏览器的 localStorage；换设备或清除浏览器数据后会消失。规则不是投资建议。</p>
      </div>

      <section class="rules-section" aria-labelledby="candidates-title">
        <div class="rules-head"><h2 id="candidates-title">候选规则</h2><span>${candidates.length} 条待处理 · 来自示例</span></div>
        <div class="rule-list">${candidateHTML}</div>
      </section>

      <div class="rules-bottom-grid">
        <section class="rules-panel" aria-labelledby="active-title">
          <div class="rules-panel-head"><b id="active-title">已生效的规则</b><span>${activeCount} 条生效 / ${active.length} 条记录</span></div>
          <div class="active-list">${activeHTML}</div>
        </section>
        <section class="rules-panel" aria-labelledby="log-title">
          <div class="rules-panel-head"><b id="log-title">版本记录</b><span>LOCAL ONLY</span></div>
          ${logHTML}
        </section>
      </div>

      <div class="rules-foot">
        <span>规则只做自我提醒，不会连接券商，也不会下单。原型最多保留最近 30 条操作记录。</span>
        <button type="button" id="reset-rules">清空本机记录</button>
      </div>
    </div>`;
  }

  function confirmRule(id) {
    const c = state.rules.candidates.find((x) => x.id === id);
    if (!c || c.status !== 'open') return;
    c.status = 'confirmed';
    state.rules.active.push({
      id: c.id,
      title: c.title,
      threshold: c.threshold,
      state: 'active',
      version: 1,
      updatedAt: nowStamp(),
    });
    addRuleLog(c.title, '确认 · v1', 'confirm');
    persistRules();
    render();
    showToast('规则已生效 · v1（仅保存在本机）');
  }

  function rejectRule(id) {
    const c = state.rules.candidates.find((x) => x.id === id);
    if (!c || c.status !== 'open') return;
    c.status = 'rejected';
    addRuleLog(c.title, '拒绝 · 未生效', 'reject');
    persistRules();
    render();
    showToast('已拒绝这条候选规则，不会生效。');
  }

  function toggleRule(id) {
    const a = state.rules.active.find((x) => x.id === id);
    if (!a) return;
    a.state = a.state === 'active' ? 'paused' : 'active';
    a.updatedAt = nowStamp();
    addRuleLog(a.title, a.state === 'active' ? '启用' : '暂停', 'pause');
    persistRules();
    render();
    showToast(a.state === 'active' ? '规则已启用（仅本机）。' : '规则已暂停，不会被提醒。');
  }

  /* ---------- modal ---------- */

  function closeModal() {
    if (!modalRoot || modalRoot.hidden) return;
    modalRoot.hidden = true;
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
    if (modalKeyHandler) {
      document.removeEventListener('keydown', modalKeyHandler);
      modalKeyHandler = null;
    }
    if (lastFocused && lastFocused.isConnected) {
      lastFocused.focus({ preventScroll: true });
    } else if (app) {
      app.focus({ preventScroll: true });
    }
    lastFocused = null;
  }

  function showModal({ title, subtitle, body, actions }) {
    closeModal();
    lastFocused = document.activeElement;
    modalRoot.hidden = false;
    modalRoot.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-head">
        <div><h2 id="modal-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
        <button class="modal-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot">
        ${actions.map((a, i) => `<button class="btn ${a.className || 'btn-outline'}" type="button" data-modal-action="${i}">${esc(a.label)}</button>`).join('')}
      </div>
    </div>`;
    document.body.style.overflow = 'hidden';

    const modal = modalRoot.querySelector('.modal');
    const closeBtn = modalRoot.querySelector('.modal-close');
    closeBtn.addEventListener('click', closeModal);

    modalRoot.querySelectorAll('[data-modal-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = actions[Number(btn.getAttribute('data-modal-action'))];
        if (!action) return;
        const result = action.onClick ? action.onClick(modal) : undefined;
        if (result !== false) closeModal();
      });
    });

    modalKeyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll('button, input, textarea, a[href]')).filter((el) => !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', modalKeyHandler);

    const firstField = modal.querySelector('input, textarea');
    (firstField || closeBtn).focus();
  }

  function openRuleEditor(id) {
    const c = state.rules.candidates.find((x) => x.id === id && x.status === 'open');
    if (!c) return;
    const body = `<p>把候选规则改成你真正会执行的说法。保存后会立即生效，并写入 v1 版本记录。</p>
      <form id="rule-edit-form" novalidate>
        <div class="field">
          <label for="rule-title-input">规则名称</label>
          <input id="rule-title-input" name="title" type="text" maxlength="60" value="${esc(c.title)}" autocomplete="off">
        </div>
        <div class="field">
          <label for="rule-threshold-input">触发条件</label>
          <input id="rule-threshold-input" name="threshold" type="text" maxlength="40" value="${esc(c.threshold)}" autocomplete="off">
          <p class="field-hint">例如：持有天数 &lt; 90 天、冷却期 = 3 个交易日。</p>
        </div>
        <p class="field-error" id="rule-edit-error" hidden></p>
      </form>`;

    showModal({
      title: '改写这条规则',
      subtitle: 'CANDIDATE / 改写后确认',
      body,
      actions: [
        { label: '取消', className: 'btn-outline' },
        {
          label: '保存并生效',
          className: 'btn-primary',
          onClick: (modal) => {
            const titleInput = modal.querySelector('#rule-title-input');
            const thresholdInput = modal.querySelector('#rule-threshold-input');
            const errorBox = modal.querySelector('#rule-edit-error');
            const title = titleInput.value.trim();
            const threshold = thresholdInput.value.trim();
            if (title.length < 4) {
              errorBox.textContent = '规则名称至少需要 4 个字，写清楚你下次要做什么。';
              errorBox.hidden = false;
              titleInput.focus();
              return false;
            }
            if (threshold.length < 2) {
              errorBox.textContent = '请写一个可执行的触发条件。';
              errorBox.hidden = false;
              thresholdInput.focus();
              return false;
            }
            c.title = title.slice(0, 60);
            c.threshold = threshold.slice(0, 40);
            c.status = 'confirmed';
            state.rules.active.push({
              id: c.id,
              title: c.title,
              threshold: c.threshold,
              state: 'active',
              version: 1,
              updatedAt: nowStamp(),
            });
            addRuleLog(c.title, '改写并确认 · v1', 'edit');
            persistRules();
            render();
            showToast('规则已改写并生效 · v1（仅保存在本机）');
            return true;
          },
        },
      ],
    });
  }

  function openResetRules() {
    showModal({
      title: '清空本机规则记录？',
      subtitle: 'LOCAL STORAGE / 不可撤销',
      body: '<p>这会删除浏览器里保存的规则、生效状态和全部版本记录，并恢复 3 条示例候选规则。此操作只影响本机，无法撤销。</p>',
      actions: [
        { label: '取消', className: 'btn-outline' },
        {
          label: '确认清空',
          className: 'btn-ghost danger',
          onClick: () => {
            state.rules = freshRuleState();
            persistRules();
            render();
            showToast('已清空本机规则记录，候选规则已恢复。');
          },
        },
      ],
    });
  }

  /* ---------- CSV import ---------- */

  function parseCsvLine(line) {
    const out = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        out.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out;
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function parseCsv(text) {
    const errors = [];
    const trades = [];
    const clean = String(text || '').replace(/^\uFEFF/, '');
    if (!clean.trim()) {
      return { trades: [], errors: [{ message: '文件是空的，请导出包含交易记录的 CSV。' }] };
    }
    const lines = clean.split(/\r?\n/);
    const header = parseCsvLine(lines[0] || '').map((s) => s.trim());
    const required = ['日期', '标的', '方向', '价格', '数量'];
    const indexPath = {};
    const missing = [];
    required.forEach((name) => {
      const idx = header.indexOf(name);
      if (idx < 0) missing.push(name);
      else indexPath[name] = idx;
    });
    if (missing.length) {
      return {
        trades: [],
        errors: [{ message: `表头缺少必需列：${missing.join('、')}。第一行需要包含这些列名。` }],
      };
    }
    const feeIdx = header.indexOf('费用');
    const taxIdx = header.indexOf('税费');
    const cash = new Map();

    for (let i = 1; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      const lineNo = i + 1;
      const cols = parseCsvLine(lines[i]);
      const cell = (name) => String(cols[indexPath[name]] ?? '').trim();
      const rowErrors = [];

      const date = cell('日期');
      if (!validDate(date)) rowErrors.push('日期需写成 YYYY-MM-DD，且是真实存在的日期。');

      const symbol = cell('标的');
      if (!/^\d{6}$/.test(symbol)) rowErrors.push('标的需为 6 位数字代码（请保留前导零）。');

      const sideText = cell('方向');
      const side = sideText === '买入' ? 'buy' : sideText === '卖出' ? 'sell' : '';
      if (!side) rowErrors.push('方向只能填“买入”或“卖出”。');

      const priceText = cell('价格');
      const price = Number(priceText);
      if (!/^\d+(\.\d{1,2})?$/.test(priceText) || !(price > 0)) {
        rowErrors.push('价格需为大于 0 的数字，最多 2 位小数。');
      }

      const qtyText = cell('数量');
      const quantity = Number(qtyText);
      if (!/^\d+$/.test(qtyText) || !(quantity > 0)) {
        rowErrors.push('数量需为正整数。');
      }

      let fee = null;
      let tax = null;
      if (feeIdx >= 0) {
        const raw = String(cols[feeIdx] ?? '').trim();
        if (raw !== '') {
          if (!/^\d+(\.\d{1,2})?$/.test(raw)) rowErrors.push('费用需为不小于 0 的数字，最多 2 位小数。');
          else fee = Number(raw);
        }
      }
      if (taxIdx >= 0) {
        const raw = String(cols[taxIdx] ?? '').trim();
        if (raw !== '') {
          if (!/^\d+(\.\d{1,2})?$/.test(raw)) rowErrors.push('税费需为不小于 0 的数字，最多 2 位小数。');
          else tax = Number(raw);
        }
      }

      if (!rowErrors.length && side && symbol) {
        const held = cash.get(symbol) || 0;
        if (side === 'sell' && quantity > held) {
          rowErrors.push(`任一时点的累计卖出不能超过累计买入（${symbol} 当前可用数量 ${held}）。暂不支持缺少期初持仓的账单。`);
        }
        if (!rowErrors.length) {
          cash.set(symbol, side === 'buy' ? held + quantity : held - quantity);
        }
      }

      if (rowErrors.length) {
        errors.push({ line: lineNo, message: rowErrors.join(' ') });
        continue;
      }

      trades.push({
        line: lineNo,
        date,
        symbol,
        side,
        price,
        quantity,
        fee,
        tax,
        name: '',
      });
    }

    if (!trades.length && !errors.length) {
      errors.push({ message: '没有找到交易行，请检查文件是否只有表头。' });
    }

    const warnings = trades
      .filter((t) => t.fee === null || t.tax === null)
      .map((t) => ({ line: t.line, message: '费用或税费为空，按 0 展示并标注。' }));

    return { trades, errors, warnings };
  }

  async function readFile(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
      reader.readAsText(file);
    });
  }

  async function handleFile(file) {
    const name = file.name || '未命名.csv';
    if (!/\.csv$/i.test(name) && !String(file.type || '').includes('csv')) {
      state.bill = {
        ...idleBill(),
        status: 'error',
        source: 'local',
        fileName: name,
        fileSize: file.size,
        error: `文件类型不符合预期：${name}。请选择 .csv 账单文件，未读取该文件。`,
      };
      render();
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      state.bill = {
        ...idleBill(),
        status: 'error',
        source: 'local',
        fileName: name,
        fileSize: file.size,
        error: '文件超过 2 MB。请检查是否导出了全部历史数据，或先导出较小的时间范围。',
      };
      render();
      return;
    }

    state.bill = {
      ...idleBill(),
      status: 'loading',
      source: 'local',
      fileName: name,
      fileSize: file.size,
    };
    render();

    try {
      const text = await readFile(file);
      const parsed = parseCsv(text);
      if (parsed.errors.length) {
        state.bill = {
          ...idleBill(),
          status: 'invalid',
          source: 'local',
          fileName: name,
          fileSize: file.size,
          trades: [],
          warnings: parsed.warnings,
          errors: parsed.errors,
        };
        render();
        showToast('校验未通过：请按提示修改后重新选择文件。');
        return;
      }
      state.bill = {
        ...idleBill(),
        status: 'loaded',
        source: 'local',
        fileName: name,
        fileSize: file.size,
        trades: parsed.trades,
        warnings: parsed.warnings,
      };
      render();
      showToast(`已在本机读取并校验 ${parsed.trades.length} 笔交易。`);
    } catch (err) {
      state.bill = {
        ...idleBill(),
        status: 'error',
        source: 'local',
        fileName: name,
        fileSize: file.size,
        error: err && err.message ? err.message : String(err),
      };
      render();
    }
  }

  function loadDemoBill() {
    state.bill = {
      status: 'loaded',
      source: 'demo',
      confirmed: false,
      fileName: 'demo-bill.csv',
      fileSize: 0,
      trades: DEMO.trades.map((t) => ({ ...t })),
      warnings: [
        { line: 5, message: '费用或税费为空，按 0 展示并标注。' },
      ],
      errors: [],
      error: '',
    };
    render();
    showToast('已加载示例账单（5 笔交易）。可以逐行核对了。');
  }

  function downloadDemoCsv() {
    const csv = '\uFEFF日期,标的,方向,价格,数量,费用,税费\n'
      + '2024-11-06,600519,买入,200.00,100,5.00,0.00\n'
      + '2025-01-15,600519,卖出,220.00,100,5.00,10.00\n'
      + '2024-11-06,300750,买入,150.00,200,5.00,0.00\n'
      + '2025-03-14,300750,卖出,160.00,100,5.00,10.00\n'
      + '2024-11-07,601318,买入,100.00,500,,\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'demo-bill.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('示例 CSV 已下载，可重新选择上传并走一遍校验。');
  }

  /* ---------- page-specific mounting ---------- */

  function bindImport() {
    const drop = document.getElementById('dropzone');
    const input = document.getElementById('file-input');
    const loadDemo = document.getElementById('load-demo');
    const download = document.getElementById('download-demo');
    const confirm = document.getElementById('confirm-bill');

    if (loadDemo) loadDemo.addEventListener('click', loadDemoBill);
    if (download) download.addEventListener('click', downloadDemoCsv);

    if (confirm) {
      confirm.addEventListener('click', () => {
        if (state.bill.status !== 'loaded') return;
        state.bill.confirmed = true;
        location.hash = '#/report';
        showToast('已确认 · 正在打开报告。');
      });
    }

    if (!drop || !input) return;

    const openPicker = () => {
      if (state.bill.status === 'loading') return;
      input.click();
    };

    drop.addEventListener('click', openPicker);
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPicker();
      }
    });
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleFile(file);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
      });
    });
    drop.addEventListener('dragleave', (e) => {
      if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-over');
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
  }

  function bindChart() {
    const stage = document.getElementById('chart-stage');
    if (!stage || !lastChartPoints.length) return;
    const svg = stage.querySelector('svg');
    const tip = stage.querySelector('.chart-tip');
    const focus = stage.querySelector('.chart-focus');
    const line = document.getElementById('chart-focus-line');
    const dotActual = document.getElementById('chart-focus-actual');
    const dotPassive = document.getElementById('chart-focus-passive');
    if (!svg || !tip || !focus) return;

    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const ratio = Math.min(Math.max((ev.clientX - rect.left) / rect.width, 0), 1);
      const targetX = ratio * 1000;
      let best = lastChartPoints[0];
      lastChartPoints.forEach((p) => {
        if (Math.abs(p.x - targetX) < Math.abs(best.x - targetX)) best = p;
      });
      focus.hidden = false;
      line.setAttribute('x1', best.x);
      line.setAttribute('x2', best.x);
      dotActual.setAttribute('cx', best.x);
      dotActual.setAttribute('cy', best.yActual);
      dotPassive.setAttribute('cx', best.x);
      dotPassive.setAttribute('cy', best.yPassive);

      const stageRect = stage.getBoundingClientRect();
      const pointLeft = (best.x / 1000) * stageRect.width;
      const clampedLeft = Math.min(Math.max(pointLeft, 88), stageRect.width - 88);
      tip.style.left = `${clampedLeft}px`;
      tip.style.top = `${Math.max((best.yActual / 340) * stageRect.height, 72)}px`;
      tip.innerHTML = `<div class="tip-date">${best.date}</div>
        <div class="tip-row actual"><span>你的操作</span><b>${money(best.actual)}</b></div>
        <div class="tip-row passive"><span>买入不动</span><b>${money(best.passive)}</b></div>`;
      tip.hidden = false;
    };

    const leave = () => {
      tip.hidden = true;
      focus.hidden = true;
    };

    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerdown', move);
    stage.addEventListener('pointerleave', leave);
  }

  function animateChartLine() {
    if (reduceMotion()) return;
    const path = document.querySelector('.js-chart-line');
    if (!path || typeof path.getTotalLength !== 'function') return;
    const length = path.getTotalLength();
    if (!length) return;
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    path.getBoundingClientRect();
    path.style.transition = 'stroke-dashoffset 1.5s cubic-bezier(0.22, 1, 0.36, 1)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        path.style.strokeDashoffset = '0';
      });
    });
  }

  function bindReport() {
    animateChartLine();
    bindChart();
    if (state.focusEvidence) {
      state.focusEvidence = false;
      requestAnimationFrame(() => {
        const section = document.getElementById('evidence');
        if (section) {
          section.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
          section.setAttribute('tabindex', '-1');
          section.focus({ preventScroll: true });
        }
      });
    }
  }

  function bindChat() {
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    const log = document.getElementById('chat-log');
    const clear = document.getElementById('clear-chat');

    document.querySelectorAll('[data-question]').forEach((btn) => {
      btn.addEventListener('click', () => askQuestion(btn.getAttribute('data-question')));
    });

    if (form && input) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        askQuestion(input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }

    if (clear) {
      clear.addEventListener('click', () => {
        clearTimeout(chatTimer);
        chatRequestSeq += 1;
        state.chat.messages = [];
        state.chat.pending = false;
        state.chat.requestId = null;
        render();
        showToast('对话已清空，问题示例还在。');
      });
    }

    if (log) {
      requestAnimationFrame(() => {
        log.scrollTop = log.scrollHeight;
      });
    }
  }

  function bindRules() {
    document.querySelectorAll('[data-rule-confirm]').forEach((btn) => {
      btn.addEventListener('click', () => confirmRule(btn.getAttribute('data-rule-confirm')));
    });
    document.querySelectorAll('[data-rule-reject]').forEach((btn) => {
      btn.addEventListener('click', () => rejectRule(btn.getAttribute('data-rule-reject')));
    });
    document.querySelectorAll('[data-rule-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openRuleEditor(btn.getAttribute('data-rule-edit')));
    });
    document.querySelectorAll('[data-rule-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => toggleRule(btn.getAttribute('data-rule-toggle')));
    });
    const reset = document.getElementById('reset-rules');
    if (reset) reset.addEventListener('click', openResetRules);
  }

  /* ---------- render ---------- */

  function onSharedChange(keys) {
    if (keys.length === 1 && keys[0] === 'assistant') {
      bridge.renderAssistant();
      return;
    }
    render();
  }

  function render() {
    state.route = currentRoute();
    bridge.setRoute(state.route);
    const mode = pageMode();
    document.title = TITLES[state.route];
    renderChrome();

    let html = '';
    if (state.route === 'home') html = homePage();
    else if (state.route === 'import') html = importPage();
    else if (state.route === 'report') html = reportPage();
    else if (state.route === 'chat') html = chatPage();
    else if (state.route === 'rules') html = renderRulesPage();
    app.innerHTML = html;

    if (state.route === 'home') animateCounters(app);
    if (state.route === 'import') {
      bridge.mountImportView(document.getElementById('tm-real-import'));
    }
    if (state.route === 'report' && mode === 'demo') bindReport();
    if (state.route === 'report' && mode === 'real' && isConfirmedLocal()) {
      renderRealReport(document.getElementById('tm-real-report'), sharedState().bill, bridge.getCtx());
    }
    if (state.route === 'chat' && mode === 'demo') bindChat();
    if (state.route === 'chat' && mode === 'real' && isConfirmedLocal()) {
      renderRealChat(document.getElementById('tm-real-chat'), bridge.getCtx());
    }
    if (state.route === 'rules' && mode === 'demo') bindRules();
    if (state.route === 'rules' && mode === 'real') {
      renderRealProfile(document.getElementById('tm-real-profile'), bridge.getCtx());
      bridge.mountContractView(document.getElementById('tm-real-rules'));
    }

    bridge.bindAssistantToggle();
    bridge.renderAssistant();
    bridge.applyAssistantShell();
  }

  /* ---------- global events ---------- */

  document.addEventListener('click', (e) => {
    const developer = e.target.closest('[data-developer-link]');
    if (developer) {
      e.preventDefault();
      confirmDeveloperExit(developer.getAttribute('href') || '../../');
      return;
    }
    const demo = e.target.closest('[data-demo-link], [data-demo-route]');
    if (demo) {
      e.preventDefault();
      enterDemoRoute(demo.getAttribute('data-demo-route'));
      return;
    }
    const evidenceLink = e.target.closest('[data-evidence-link]');
    if (!evidenceLink) return;
    e.preventDefault();
    state.focusEvidence = true;
    if (currentRoute() === 'report') {
      render();
    } else {
      location.hash = '#/report';
    }
  });

  if (modalRoot) {
    modalRoot.addEventListener('click', (e) => {
      if (e.target === modalRoot) closeModal();
    });
  }

  window.addEventListener('hashchange', () => {
    closeModal();
    render();
    scrollTop();
  });

  window.addEventListener('resize', () => {
    bridge.onViewportChange();
  });

  if (!location.hash) {
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}#/home`);
    } catch (err) {
      /* file:// 或沙箱环境可能禁止改写历史记录，不影响原型使用 */
    }
  }

  bridge.initBridge({ onChange: onSharedChange });
  render();
})();
