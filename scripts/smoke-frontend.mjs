// 前端交互冒烟（零依赖：Node + 最小 DOM 桩；非产品代码，仅回归工具）
// 覆盖：导入/确认（演示账单 + 本地 CSV 本机校验）、报告切换（组合/标的/A′/差异）、对话离线、契约（引擎模板解析/确认改写拒绝/持久化/历史情境三态）、状态徽标色映射。
// 运行：npm run smoke
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const imp = (p) => import(new URL('../' + p, import.meta.url).href);

class FakeNode {}
function createTextNode(t) {
  const n = Object.create(FakeNode.prototype);
  n.__text = String(t);
  n.parentNode = null;
  return n;
}
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
function selectorTest(sel) {
  const s = String(sel ?? '').trim();
  if (s.startsWith('[')) {
    const m = s.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
    if (!m) return () => false;
    const [, key, value] = m;
    return (n) => Boolean(n.attrs) && (value === undefined ? n.attrs[key] !== undefined : n.attrs[key] === value);
  }
  if (s.startsWith('.')) {
    const cls = s.slice(1);
    return (n) => String(n.attrs?.class ?? '').split(/\s+/).includes(cls);
  }
  if (s.startsWith('#')) {
    const id = s.slice(1);
    return (n) => n.attrs?.id === id;
  }
  return (n) => n.tagName === s.toUpperCase();
}
// 极简 HTML 解析：仅供账本页 innerHTML 模板在 Node 桩内还原为可查询节点。
function parseHTML(html) {
  const root = makeEl('#fragment');
  const stack = [root];
  let i = 0;
  const pushText = (raw) => {
    if (!raw) return;
    const text = createTextNode(decodeEntities(raw));
    text.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].children.push(text);
  };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { pushText(html.slice(i)); break; }
    if (lt > i) pushText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt < 0) { pushText(html.slice(lt)); break; }
    let raw = html.slice(lt + 1, gt).trim();
    if (raw.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1).trim();
    const name = raw.match(/^([a-zA-Z][\w:-]*)/);
    if (!name) { i = gt + 1; continue; }
    const el = makeEl(name[1]);
    const attrRe = /([^\s=]+)(?:\s*=\s*"([^"]*)")?/g;
    let m;
    while ((m = attrRe.exec(raw.slice(name[0].length)))) {
      el.setAttribute(m[1], m[2] === undefined ? '' : decodeEntities(m[2]));
    }
    el.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].children.push(el);
    if (!selfClosing && !VOID_TAGS.has(name[1].toLowerCase())) stack.push(el);
    i = gt + 1;
  }
  return root.children;
}
function makeEl(tag) {
  const node = Object.create(FakeNode.prototype);
  node.tagName = String(tag).toUpperCase();
  node.children = []; node.attrs = {}; node.listeners = {}; node.value = ''; node.disabled = false;
  node.parentNode = null; node.onclick = null; node.__html = '';
  node.setAttribute = function (k, v) {
    this.attrs[k] = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'disabled') this.disabled = true;
  };
  node.getAttribute = function (k) { return this.attrs[k]; };
  node.addEventListener = function (type, fn) { (this.listeners[type] ??= []).push(fn); };
  node.append = function (...cs) {
    for (const c of cs) {
      if (c == null) continue;
      if (typeof c === 'object') c.parentNode = this;
      this.children.push(c);
    }
  };
  node.insertBefore = function (child, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(child);
    else this.children.splice(i, 0, child);
    if (child && typeof child === 'object') child.parentNode = this;
    return child;
  };
  node.replaceChildren = function (...cs) {
    this.children = cs.filter((c) => c != null);
    for (const c of this.children) if (c && typeof c === 'object') c.parentNode = this;
  };
  node.remove = function () {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
    }
    this.__removed = true;
  };
  node.focus = function () { globalThis.__focused = this; };
  node.querySelector = function (sel) {
    const test = selectorTest(sel);
    const walk = (n) => {
      for (const c of n.children) {
        if (!c || c.__text !== undefined) continue;
        if (test(c)) return c;
        const r = walk(c); if (r) return r;
      }
      return null;
    };
    return walk(this);
  };
  node.closest = function (sel) {
    const test = selectorTest(sel);
    let n = this;
    while (n) {
      if (n.attrs && test(n)) return n;
      n = n.parentNode;
    }
    return null;
  };
  node.contains = function (child) {
    let n = child;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  };
  node.scrollIntoView = function () { this.__scrolled = true; };
  node.requestSubmit = function () {
    for (const fn of this.listeners.submit ?? []) fn({ preventDefault() {} });
  };
  Object.defineProperty(node, 'className', {
    get() { return this.attrs.class ?? ''; },
    set(v) { this.attrs.class = String(v); },
  });
  Object.defineProperty(node, 'lastElementChild', {
    get() {
      for (let i = this.children.length - 1; i >= 0; i -= 1) {
        const c = this.children[i];
        if (c && c.__text === undefined) return c;
      }
      return null;
    },
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return this.__html; },
    set(v) {
      this.__html = String(v);
      this.children = parseHTML(this.__html);
      for (const c of this.children) if (c && c.__text === undefined) c.parentNode = this;
    },
  });
  return node;
}
globalThis.Node = FakeNode;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const docListeners = {};
globalThis.document = {
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  createTextNode,
  addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
};
// 站点同源函数 fake：页面链路测试只替换响应内容，不发起真实网络。
let siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: '' }) } };
const siteQueue = [];
const siteCalls = [];
const isSiteFunction = (url) => String(url).startsWith('/functions/v1/app/');
function siteHttpResponse({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// 动态行情 fake：用历史行情夹具裁剪出与服务端一致形状（artifact=market-cache-dynamic），
// 只按请求 symbols/start 裁剪；未知标的返回空序列。记录请求体供隐私与范围断言。
const staticMarketDoc = JSON.parse(readFileSync(join(ROOT, 'data/market-cache.json'), 'utf8'));
const MARKET_SNAPSHOT_PATH = '/functions/v1/app/api/market/snapshot';
const MARKET_FIXTURE_ASOF = '2025-12-31';
const MARKET_FIXTURE_FETCHED_AT = '2026-10-19T01:30:00.000Z';
const MARKET_FIXTURE_CHECKSUM = '0123456789abcdef'.repeat(4);
const MARKET_FIXTURE_SNAPSHOT = 'tushare-20251231-01234567';
const marketCalls = [];
const isMarketSnapshot = (url) => String(url) === MARKET_SNAPSHOT_PATH;
function buildMarketFixture(req) {
  const start = String(req.start);
  const end = MARKET_FIXTURE_ASOF;
  const pick = (bars) => (bars ?? [])
    .filter((b) => b.date >= start && b.date <= end)
    .map((b) => ({ date: b.date, close: b.close }));
  const days = staticMarketDoc.calendar.trading_days.filter((d) => d >= start && d <= end);
  const symbols = {};
  for (const sym of req.symbols) {
    const src = staticMarketDoc.symbols[sym];
    symbols[sym] = { bars: pick(src?.bars), bars_fwdadj: pick(src?.bars_fwdadj) };
  }
  return {
    artifact: 'market-cache-dynamic',
    manifest_version: 'dynamic-v1',
    fetched_at: MARKET_FIXTURE_FETCHED_AT,
    checksum: MARKET_FIXTURE_CHECKSUM,
    asOfDate: end,
    source: { provider: 'tushare', freshness: 'latest_closed_daily' },
    manifest: { asOfDate: end, date_range: { start, end }, symbols: [...req.symbols] },
    calendar: { trading_days: days },
    symbols,
    snapshot: {
      snapshot_id: MARKET_FIXTURE_SNAPSHOT,
      fetch_time: MARKET_FIXTURE_FETCHED_AT,
      latest_trade_date: end,
      range: { start, end },
      symbols: [...req.symbols],
      provider: 'tushare',
    },
  };
}
function localTodayIso(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function deferredSiteResponse(body) {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve: () => resolve(siteHttpResponse({ body })) };
}
let marketResponseHook = null;
let siteResponseHook = null;
const resourceCalls = [];
globalThis.fetch = async (url, options = {}) => {
  if (isMarketSnapshot(url)) {
    const body = JSON.parse(String(options.body ?? '{}'));
    marketCalls.push(body);
    if (marketResponseHook) return marketResponseHook(body);
    return siteHttpResponse({ body: { ok: true, market: buildMarketFixture(body) } });
  }
  if (isSiteFunction(url)) {
    siteCalls.push({ url: String(url), options });
    if (siteResponseHook) {
      const hooked = siteResponseHook(String(url), options);
      if (hooked) return hooked;
    }
    const queued = siteQueue.shift();
    if (queued) return queued.promise ? queued.promise : siteHttpResponse(queued);
    return siteHttpResponse(siteResponse);
  }
  resourceCalls.push(String(url));
  const rel = String(url).replace(/^\//, '');
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(raw), text: async () => raw };
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
// FileReader 桩（异步回调，模拟浏览器 readAsText；fake file 用 __content / __readError 控制行为）
class FakeFileReader {
  readAsText(file) {
    setTimeout(() => {
      if (file && file.__readError) { if (this.onerror) this.onerror({}); return; }
      this.result = file && file.__content !== undefined ? file.__content : '';
      if (this.onload) this.onload({});
    }, 0);
  }
  readAsArrayBuffer(file) {
    setTimeout(() => {
      if (file && file.__readError) { if (this.onerror) this.onerror({}); return; }
      this.result = file && file.__buffer !== undefined ? file.__buffer : new ArrayBuffer(0);
      if (this.onload) this.onload({});
    }, 0);
  }
}
globalThis.FileReader = FakeFileReader;

const { state, subscribe, notify, defaultBill, defaultChat, defaultContracts, defaultImportRecovery, loadContractsDemo } = await imp('src/state.js');
const { renderImport } = await imp('src/ui/views/importView.js');
const { renderReport } = await imp('src/ui/views/reportView.js');
const { renderRealChat } = await imp('prototype/user-frontend/realChat.js');
const { renderContract } = await imp('src/ui/views/contractView.js');
const { createQaAnswerService } = await imp('prototype/user-frontend/qaAnswer.js');
const { createChatOnline } = await imp('src/agent/chatOnline.js');
const { createOnlineBoundary } = await imp('src/agent/onlineBoundary.js');
const { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } = await imp('src/agent/httpTransport.js');
const { loadUserBillReport } = await imp('src/demo/adapter.js');
const { ruleStateOf } = await imp('src/agent/qaChips.js');
const VIEWS = { import: renderImport, report: renderReport, chat: renderRealChat, contract: renderContract };

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

let current = null;
const ctx = { state, set, go };
function set(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && state[k] && typeof state[k] === 'object' && !Array.isArray(state[k])) state[k] = { ...state[k], ...v };
    else state[k] = v;
  }
  notify();
}
function go(id) { state.route = id; mountCycle(); }
function mountCycle() { current = makeEl('main'); VIEWS[state.route](current, ctx); }
subscribe(() => mountCycle());
const flush = () => new Promise((r) => setTimeout(r, 0));

// 问答页依赖：真实 qaAnswer 编排 + 站点同源 fake；bundle 复用报告适配层并按上下文缓存。
const qaBundles = new Map();
function getSmokeBundle(bill) {
  const cached = qaBundles.get(bill?.contextId || 'anonymous');
  return cached?.status === 'ready' ? cached.bundle : null;
}
async function loadSmokeBundle(bill) {
  const key = bill?.contextId || 'anonymous';
  const cached = qaBundles.get(key);
  if (cached?.status === 'ready') return cached.bundle;
  const bundle = await loadUserBillReport(bill);
  qaBundles.set(key, { status: 'ready', bundle });
  return bundle;
}
let smokeAnswerClient = null;
function getSmokeAnswerClient() {
  if (!smokeAnswerClient) {
    const transport = createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS });
    const online = createChatOnline({ transport });
    const boundary = createOnlineBoundary({ transport, timeoutMs: 5000 });
    smokeAnswerClient = createQaAnswerService({
      getBundle: getSmokeBundle,
      loadBundle: loadSmokeBundle,
      askOnline: ({ question, review }) => online.ask({ question, review }),
      loadProfile: () => null,
      classifyIntent: ({ question }) => boundary.classifyIntent({ question }),
    });
  }
  return smokeAnswerClient;
}
ctx.qaDeps = {
  askQuestion: (args) => getSmokeAnswerClient().ask(args),
  getReportBundle: getSmokeBundle,
  loadReportBundle: loadSmokeBundle,
  ruleStateOf,
  loadProfile: () => null,
  openRuleCandidate: (c, candidate) => { ctx.__openedCandidate = candidate; },
};

function texts(node, out = []) {
  for (const c of node.children ?? []) {
    if (c == null) continue;
    if (c.__text !== undefined) out.push(c.__text);
    else { if (c.value) out.push(String(c.value)); texts(c, out); }
  }
  return out;
}
function findButtons(node, out = []) {
  for (const c of node.children ?? []) {
    if (!c || c.__text !== undefined) continue;
    if (c.tagName === 'BUTTON') out.push(c);
    findButtons(c, out);
  }
  return out;
}
function findInputs(node, out = []) {
  for (const c of node.children ?? []) {
    if (!c || c.__text !== undefined) continue;
    if (c.tagName === 'INPUT') out.push(c);
    findInputs(c, out);
  }
  return out;
}
function findChips(node, out = []) {
  for (const c of node.children ?? []) {
    if (!c || c.__text !== undefined) continue;
    if (String(c.attrs.class ?? '').includes('chip')) out.push(c);
    findChips(c, out);
  }
  return out;
}
function findByClass(node, cls, out = []) {
  for (const c of node.children ?? []) {
    if (!c || typeof c !== 'object' || c.__text !== undefined) continue;
    if (String(c.attrs.class ?? '').split(/\s+/).includes(cls)) out.push(c);
    findByClass(c, cls, out);
  }
  return out;
}
function findByTag(node, tag, out = []) {
  for (const c of node.children ?? []) {
    if (!c || typeof c !== 'object' || c.__text !== undefined) continue;
    if (c.tagName === String(tag).toUpperCase()) out.push(c);
    findByTag(c, tag, out);
  }
  return out;
}
const labelOf = (b) => texts(b).join('');
async function clickLabel(label, nth = 0) {
  const btns = findButtons(current).filter((b) => labelOf(b).includes(label));
  if (!btns[nth]) throw new Error('找不到按钮：' + label + '（序号 ' + nth + '）');
  for (const fn of btns[nth].listeners.click ?? []) await fn({});
}
async function pickFile(fakeFile) {
  const inp = findInputs(current)[0];
  if (!inp) throw new Error('找不到文件选择控件');
  for (const fn of inp.listeners.change ?? []) await fn({ target: { files: [fakeFile] } });
}

/* ==== 导入页：加载 → 待确认 → 确认（合成回归场景 A） ==== */
state.route = 'import';
state.bill = { ...defaultBill(), scenario: 'A' };
mountCycle();
await clickLabel('加载演示账单');
let txt = texts(current).join('|');
check('导入：加载后出现“待确认”状态行（loaded 样式）', String(findByClass(current, 'im-status')[0]?.attrs.class ?? '').includes('loaded')
  && texts(findByClass(current, 'im-status')[0] ?? { children: [] }).join('').includes('待确认：'));
check('导入：费用缺失与口径标注仍在', txt.includes('缺失（按 0）') && txt.includes('未计入费用、税费') && txt.includes('分红未计入'), txt.slice(0, 160));
check('导入·准备账单：多输入 / 常规解析优先 / 本机读取不上传 / 确认不下单 + 字段说明（与 csvNormalize 一致）',
  txt.includes('准备账单') && txt.includes('支持 CSV/TSV、Excel（.xlsx）、含文本的 PDF') && txt.includes('截图和扫描版 PDF 使用视觉识别') && txt.includes('原始 CSV/表格仅在本机读取和校验，不上传')
  && txt.includes('不会下单、不会执行交易')
  && txt.includes('日期（YYYY-MM-DD）') && txt.includes('标的（6 位数字代码）') && txt.includes('方向（买入 / 卖出）') && txt.includes('数量（正整数）')
  && txt.includes('可选列：费用、税费') && txt.includes('日期,标的,方向,价格,数量,费用,税费') && txt.includes('任一时点卖出不能超过此前买入'), txt.slice(0, 400));
check('导入·公司行为限制：显式披露 v1 不自动识别股数事件', txt.includes('公司行为限制：')
  && txt.includes('v1 不自动识别送转、拆合股、配股等股数事件') && txt.includes('可能估值不准确'), txt.slice(0, 400));
{
  const feeBox = findByClass(current, 'im-feetax')[0];
  const feeTxt = feeBox ? texts(feeBox).join('|') : '';
  check('导入·待确认：交易预览上方显示“待确认：请核对交易数、日期、标的和费用税费”，并有费用/税费缺失醒目汇总（按 0 规则不变）',
    txt.includes('待确认：请核对交易数、日期、标的和费用税费') && feeTxt.includes('部分费用或税费缺失，当前结果按现有口径计算，可能与实际对账结果不同。')
    && /(费用|税费)缺失：第 \d+(、\d+)* 行（按 0 计）/.test(feeTxt) && txt.includes('缺失（按 0）'), feeTxt || txt.slice(0, 300));
}
check('导入·确认说明：确认按钮旁写明“确认后进入分析报告；不会上传账单、不会执行交易。”', txt.includes('确认后进入分析报告；不会上传账单、不会执行交易。'), txt.slice(-300));
check('导入·合成 A：加载与预览不发起动态行情请求（合成来源仍可离线回归）', marketCalls.length === 0, JSON.stringify(marketCalls));
await clickLabel('确认交易列表');
check('导入：确认后状态=confirmed 且路由=report', state.bill.status === 'confirmed' && state.route === 'report', JSON.stringify({ s: state.bill.status, r: state.route }));
state.route = 'import'; mountCycle();
check('导入：确认态状态行为“已确认”（confirmed 样式）', String(findByClass(current, 'im-status')[0]?.attrs.class ?? '').includes('confirmed')
  && texts(findByClass(current, 'im-status')[0] ?? { children: [] }).join('').includes('已确认：'));
check('导入·已确认：状态说明“已确认：已用于本地分析（演示账单）”', texts(current).join('|').includes('已确认：已用于本地分析（演示账单）'), texts(current).join('|').slice(0, 300));
await flush(); await flush();

/* ==== 导入页：默认 Tushare 动态行情（R） ==== */
state.route = 'import';
state.bill = defaultBill();
mountCycle();
await clickLabel('加载演示账单');
txt = texts(current).join('|');
const rImportCall = marketCalls.at(-1);
check('导入·动态行情默认：R 场景 8 笔交易 + Tushare 动态日线（服务端拉取、非实时）+ 请求范围/最新交易日/快照',
  state.bill.status === 'loaded' && state.bill.trades.length === 8
  && state.bill.dataMode && state.bill.dataMode.id === 'demo_bill_dynamic_market'
  && state.bill.marketSource && state.bill.marketSource.dynamic === true && state.bill.marketSource.provider === 'tushare'
  && state.bill.marketSource.fetchedAt === MARKET_FIXTURE_FETCHED_AT && state.bill.marketSource.latestTradeDate === MARKET_FIXTURE_ASOF
  && state.bill.marketSource.snapshotId === MARKET_FIXTURE_SNAPSHOT
  && txt.includes('示例交易 + Tushare 动态行情') && txt.includes('Tushare 动态日线（服务端获取，非实时）')
  && txt.includes('请求范围 2024-12-19 → 2025-12-31') && txt.includes('最新交易日 2025-12-31')
  && txt.includes('300750 / 600519 / 601318') && txt.includes('拉取时间 ') && txt.includes('快照 tushare-20251231-01234567')
  && txt.includes('demo-bill-real.csv') && !txt.includes('行情：合成演示行情') && !txt.includes('已签收'),
  JSON.stringify({ s: state.bill.status, n: state.bill.trades.length, meta: state.bill.marketSource }) + ' || ' + txt.slice(0, 400));
check('导入·动态行情请求：仅 symbols/start/end，标的为账单 3 只，日期范围符合本地推导',
  marketCalls.length === 1 && !!rImportCall
  && Object.keys(rImportCall).sort().join(',') === 'end,start,symbols'
  && JSON.stringify(rImportCall.symbols) === JSON.stringify(['300750', '600519', '601318'])
  && rImportCall.start === '2024-12-19' && rImportCall.end === localTodayIso(),
  JSON.stringify({ calls: marketCalls.length, body: rImportCall }));
await clickLabel('确认交易列表');
check('导入·动态行情确认：状态=confirmed 且路由=report', state.bill.status === 'confirmed' && state.route === 'report', JSON.stringify({ s: state.bill.status, r: state.route }));
state.route = 'import'; mountCycle();
check('导入·动态行情确认态：说明“已用于本地分析（示例交易）”', texts(current).join('|').includes('已确认：已用于本地分析（示例交易）'), texts(current).join('|').slice(0, 300));
await flush(); await flush();

/* ==== 报告页（引擎接线：演示账单 CSV → csvNormalize → marketCache(合成夹具) → indicators → provenance）==== */
const marketCallsBeforeReportA = marketCalls.length;
state.route = 'report';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle(); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：组合指标（引擎输出 +4.9% / +6.9% / +2.0pp / ¥700.00）', txt.includes('+4.9%') && txt.includes('+6.9%') && txt.includes('+2.0pp') && txt.includes('¥700.00'), txt.slice(0, 220));
check('报告：合成演示标注 + 买入不动口径 + 无 undefined', txt.includes('合成演示数据') && txt.includes('买入不动') && txt.includes('组合不汇总个股股数') && !txt.includes('undefined'));
const pageOf = () => findByClass(current, 'report-page')[0];
const summaryTxt = () => { const n = findByClass(current, 'rp-summary')[0]; return n ? texts(n).join('|') : ''; };
const orderOf = (...classes) => classes.map((cls) => pageOf().children.findIndex((c) => c && c.attrs && String(c.attrs.class ?? '').split(/\s+/).includes(cls)));
{
  const sm = summaryTxt();
  check('报告·演示摘要：数据来源=演示账单 / 行情=合成演示行情（非真实行情）/ 估值日 / 结论状态（演示不使用“发布”措辞）',
    sm.includes('本次分析摘要') && sm.includes('演示账单 · 基准账单 A（合成）') && sm.includes('合成演示行情（非真实行情）') && sm.includes('估值日') && sm.includes('2024-10-11')
    && sm.includes('组合结果：已由本地引擎算出（演示数据，未经复核发布流程）') && sm.includes('演示结论：以下数字来自合成账单与合成行情') && !sm.includes('已发布'), sm);
  const [iSum, iMetrics, iCf, iEvd] = orderOf('rp-summary', 'rp-metrics', 'rp-cf', 'rp-evidence');
  check('报告·阅读顺序：状态与结论（摘要）→ 核心指标 → 反事实 → 证据与计算路径', iSum >= 0 && iSum < iMetrics && iMetrics < iCf && iCf < iEvd
    && txt.includes('核心指标 · 组合') && txt.includes('证据与计算路径'), JSON.stringify([iSum, iMetrics, iCf, iEvd]));
  const fact = findByClass(current, 'rp-fact')[0];
  const bodyNode = fact ? fact.children[1] : null;
  const plainVis = bodyNode ? visibleTexts(bodyNode).join('|') : '';
  const techNode = bodyNode ? findByClass(bodyNode, 'rp-tech')[0] : null;
  check('报告·演示证据：先说明“这项结果代表什么 / 来源于哪些交易 / 是否经过复核”，S1–S4、公式编号与原始行号收进技术细节',
    plainVis.includes('这项结果代表什么') && plainVis.includes('来源于哪些交易') && plainVis.includes('成交 T00') && plainVis.includes('演示计算路径，未经过复核发布流程')
    && !plainVis.includes('S1 口径') && !/CALC_[A-Z_]+_V1/.test(plainVis) && !/第 \d+ 行/.test(plainVis) && !!techNode && techNode.tagName === 'DETAILS'
    && texts(techNode).join('|').includes('S1 口径') && texts(techNode).join('|').includes('公式编号') && /第 \d+ 行/.test(texts(techNode).join('|')), plainVis.slice(0, 300));
}
const wiringOk = (t) => !t.includes('契约匹配') && !t.includes('未接线') && t.includes('契约页已接入候选模板与历史情境模拟') && t.includes('契约不会自动改变本报告结论')
  && t.includes('未接入：实时/分钟级行情') && t.includes('最新已收盘日线') && t.includes('对话页事实回跳') && t.includes('尚未完成真实服务验证');
check('报告·演示：底部不再写“契约匹配未接线”，如实说明契约页已接入且不改报告结论，实时/分钟级行情、事实回跳与真实服务验证仍未接入', wiringOk(txt), txt.slice(-300));
const demoFacts = () => findByClass(current, 'rp-fact');
const provA = txt.match(/演示计算路径（当前范围「组合」· (\d+) 项）/);
check('报告：A 演示计算路径完整（组合 8 项可展开条目、无阻断项、无 E_PROVENANCE）', !!provA && Number(provA[1]) === 8 && demoFacts().length === 8
  && demoFacts().every((n) => n.tagName === 'DETAILS' && String(n.attrs.class).includes('demo')) && !txt.includes('存在阻断项') && !txt.includes('E_PROVENANCE'), txt.slice(0, 320));
check('报告：演示模式常驻“未经过复核发布流程”提示，不出现复核链路专属词（已发布/复核通过/阻断事实/verify_id/复核概览）',
  txt.includes('以下为演示计算路径，未经过复核发布流程（runReview），不代表复核结果。')
  && !txt.includes('已发布') && !txt.includes('复核通过') && !txt.includes('阻断事实') && !txt.includes('verify_id') && !txt.includes('复核概览'), txt.slice(0, 320));
{
  const first = demoFacts()[0];
  const sumTxt = texts(first.children[0]).join('|');
  const allTxt = demoFacts().map((n) => texts(n).join('|')).join('||');
  check('报告：演示条目收起时显示中文事实名 + 展示值，公式编号收进技术详情',
    sumTxt.includes('组合 · ') && !/CALC_/.test(sumTxt) && sumTxt.split('|').length === 2
    && texts(first).join('|').includes('CALC_'), sumTxt);
  check('报告：演示条目展开后为可读文本（公式/输入/来源引用/S1–S4），不平铺原始 JSON',
    allTxt.includes('公式编号') && allTxt.includes('输入') && allTxt.includes('估值日不复权 close') && allTxt.includes('来源引用') && /第 \d+ 行/.test(allTxt)
    && allTxt.includes('S1 口径') && allTxt.includes('S2 批次') && allTxt.includes('S3 逐批') && allTxt.includes('S4 排序') && allTxt.includes('处理顺序')
    && !txt.includes('inputs：') && !txt.includes('"trade_ids"') && !txt.includes('steps：'), allTxt.slice(0, 400));
  check('报告：演示 S3 逐笔明细沿用明细表', demoFacts().every((n) => findByClass(n, 'rp-tbl').length === 1), String(demoFacts().map((n) => findByClass(n, 'rp-tbl').length)));
}
await clickLabel('000000'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：标的切换 000000（引擎输出 +10.0% / -2.0pp / ¥-400.00）', txt.includes('+10.0%') && txt.includes('-2.0pp') && txt.includes('¥-400.00'), txt.slice(0, 220));
check('报告：演示计算路径随范围切换（000000 · 9 项，输入含估值日收盘价）', txt.includes('演示计算路径（当前范围「000000」· 9 项）') && demoFacts().length === 9
  && txt.includes('估值日不复权收盘价'), txt.slice(0, 320));
await clickLabel('A′'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：A′ 切换 + 引擎差异面板', state.report.scenario === 'Aprime' && txt.includes('与基准 A 的差异') && txt.includes('仅改第 5 行卖出价') && txt.includes('-7.0pp'), txt.slice(0, 280));
const provAp = txt.match(/演示计算路径（当前范围「000000」· (\d+) 项）/);
check('报告：A′ 演示计算路径完整（9 项、无阻断项、无复核专属词、无 E_PROVENANCE）', !!provAp && Number(provAp[1]) === 9 && demoFacts().length === 9
  && !txt.includes('存在阻断项') && !txt.includes('已发布') && !txt.includes('复核通过') && !txt.includes('verify_id') && !txt.includes('E_PROVENANCE'), txt.slice(0, 320));
await clickLabel('基准账单 A'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：切回 A 恢复（实际收益卡与证据入口正常）', state.report.scenario === 'A' && txt.includes('实际收益') && txt.includes('查看证据与计算路径'));
const provM = txt.match(/演示计算路径（当前范围「[^」]+」· (\d+) 项）/);
check('报告：切回 A 后演示计算路径仍完整（9 项、无阻断、无 E_PROVENANCE）', !!provM && Number(provM[1]) === 9 && demoFacts().length === 9 && !txt.includes('存在阻断项') && !txt.includes('E_PROVENANCE'), txt.slice(0, 320));
check('报告·合成 A/A′：整个过程中不发起动态行情请求', marketCalls.length === marketCallsBeforeReportA, JSON.stringify(marketCalls));

/* ==== 单笔反事实（S1 幽灵线双面板）：演示账单 000000 → T004 ==== */
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('反事实：入口 + S1 口径 + 替换笔信息（T004 · 2024-10-08 · 110 × 200）', txt.includes('单笔反事实') && txt.includes('S1') && txt.includes('T004') && txt.includes('2024-10-08') && txt.includes('110 × 200'), txt.slice(0, 260));
{
  const lead = findByClass(current, 'rp-cf-lead')[0];
  const leadTxt = lead ? texts(lead).join('') : '';
  check('反事实·新标题与结论：“如果当时没有卖出这一笔，结果会怎样？”+ 图上方一句话（选中卖出 / 可发布 / 相对改善引擎 display），公式口径折叠',
    txt.includes('如果当时没有卖出这一笔，结果会怎样？') && leadTxt.includes('当前选中：T004（2024-10-08 卖出 110 × 200）') && leadTxt.includes('结论：可发布；')
    && leadTxt.includes('相对改善 -2.0pp') && findByClass(current, 'rp-cf-tech').every((n) => n.tagName === 'DETAILS') && texts(findByClass(current, 'rp-cf-tech')[0]).join('').includes('CALC_CF_REPLACE_SELL_V1'), leadTxt);
}
check('反事实：双 SVG 面板 + 易读图例与读图提示（实际/持有/假设结果/差额/买入/卖出）', findByTag(current, 'svg').length >= 2 && txt.includes('读图提示') && txt.includes('资产价值变化') && txt.includes('每日收盘价与交易时间点') && txt.includes('假如这笔卖出没有发生') && txt.includes('当前替换笔'), txt.slice(0, 320));
check('反事实：引擎 display（假设结果价值 ¥21,600.00 / 假设收益 +8.0% / 相对改善 -2.0pp / 剩余损耗金额 ¥0.00）', txt.includes('假设结果价值 ¥21,600.00') && txt.includes('假设收益 +8.0%') && txt.includes('相对改善 -2.0pp') && txt.includes('剩余损耗金额 ¥0.00'), txt.slice(0, 280));
check('反事实：公式标识 + 负值说明 + 非真实行情与免责标注', txt.includes('CALC_CF_REPLACE_SELL_V1') && txt.includes('负值表示这笔卖出反而优于持有') && txt.includes('合成行情') && txt.includes('不构成投资建议'), txt.slice(0, 280));
{
  const wrap = findByClass(current, 'gc-wrap')[0];
  const step = (1000 - 76 - 20) / 8; // 000000 序列 9 点（2024-09-24 → 2024-10-11）
  for (const fn of wrap.listeners.mousemove ?? []) await fn({ offsetX: 76 + 3 * step });
  const crosses = findByClass(current, 'gc-cross');
  const tipTxt = texts(findByClass(current, 'gc-tip')[0]).join('|');
  check('反事实：十字线两面板同步 + 提示六项（日期/实际/对照/反事实/缺口/收盘价）', crosses.length === 2
    && crosses[0].attrs.x1 === crosses[1].attrs.x1 && String(crosses[0].attrs.x1) === String(76 + 3 * step)
    && tipTxt.includes('2024-09-27') && tipTxt.includes('实际') && tipTxt.includes('对照') && tipTxt.includes('反事实') && tipTxt.includes('缺口') && tipTxt.includes('收盘价'),
    JSON.stringify({ n: crosses.length, x1: crosses[0]?.attrs.x1, tip: tipTxt.slice(0, 120) }));
}
await clickLabel('组合'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('反事实：组合 scope 不画图并提示选择标的', txt.includes('请选择一个标的查看单笔卖出反事实') && !txt.includes('当前替换笔') && findByClass(current, 'gc-svg').length === 0, txt.slice(0, 200));
await clickLabel('888888'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('反事实：缺价序列断开并列出缺失日期（2024-10-10；引擎 display 照实）', txt.includes('序列不完整') && txt.includes('路径已断开') && txt.includes('2024-10-10') && txt.includes('假设结果价值 ¥15,800.00'), txt.slice(0, 300));
check('反事实·缺价结论：图上方如实说明“可发布，但价格序列不完整（缺 2024-10-10），图中对应日期断线”',
  texts(findByClass(current, 'rp-cf-lead')[0] ?? { children: [] }).join('').includes('结论：可发布，但价格序列不完整（缺 2024-10-10），图中对应日期断线'), texts(findByClass(current, 'rp-cf-lead')[0] ?? { children: [] }).join(''));
{
  const closePath = findByClass(current, 'gc-line-close')[0];
  check('反事实：缺价日断线（close 路径为多段 M）', !!closePath && (closePath.attrs.d.match(/M/g) ?? []).length >= 2, closePath?.attrs.d?.slice(0, 80));
  check('反事实：缺价后有效孤立点、完整末日期和底缘交易含义均可见', findByClass(current, 'gc-isolated-point').length >= 4
    && txt.includes('2024-10-11') && txt.includes('断线后有效值（实际）') && txt.includes('断线后有效值（对照／反事实）')
    && txt.includes('断线后收盘价有效（2024-10-11）') && txt.includes('2024-10-10：交易日缺价')
    && txt.includes('底缘买卖标记表示该交易日缺价'), txt.slice(0, 440));
}

state.report = { scenario: 'A', symbol: '000000', cfTradeId: 'T004' };
mountCycle(); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('反事实：同标的内指定卖出笔仍生效（T004 · 假设结果价值 ¥21,600.00）', txt.includes('T004 · 2024-10-08') && txt.includes('假设结果价值 ¥21,600.00'), txt.slice(0, 260));
await clickLabel('888888'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('反事实：切标的后残留 tradeId 不报错（无 E_CF_TRADE_NOT_FOUND），落 B 默认第一笔 T005', !txt.includes('E_CF_TRADE_NOT_FOUND') && !txt.includes('该反事实结论不发布') && txt.includes('T005 · 2024-10-10') && txt.includes('假设结果价值 ¥15,800.00'), txt.slice(0, 300));

/* ==== 已确认本地账单：Tushare 动态行情（成功 / 服务失败 / 公司行为边界） ==== */
{
  const localCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,600519,买入,1488.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n';
  const billOf = async (adapter, text, name) => ({ ...(await adapter.loadUserBillFromText(text, name)), status: 'confirmed' });
  const countSynthetic = () => resourceCalls.filter((p) => p.startsWith('/m0/market-cache/')).length;
  const before = countSynthetic();

  const okAdapter = await imp('src/demo/adapter.js?smoke=dynamic-ok');
  const okBill = await billOf(okAdapter, localCsv, 'dynamic-ok.csv');
  const okReport = await okAdapter.loadUserBillReport(okBill);
  check('动态行情·本地账单成功：来源 dynamic-tushare、asOfDate 2025-12-31、快照/校验/支持范围齐全，估值只用不复权收盘价',
    okReport.status === 'ok' && okReport.review?.portfolio_published === true
    && okReport.marketSource?.id === 'dynamic-tushare' && okReport.marketSource.dynamic === true && okReport.marketSource.signed === false
    && okReport.asOfDate === '2025-12-31' && okReport.valuation?.effective_date === '2025-12-31'
    && okReport.supportScope?.symbols.join('、') === '600519' && okReport.supportScope.range.end === '2025-12-31'
    && okReport.marketSource.snapshotId === MARKET_FIXTURE_SNAPSHOT && okReport.marketSource.checksum === MARKET_FIXTURE_CHECKSUM
    && okReport.prices.per_symbol['600519'].close === 1377.18 && countSynthetic() === before, JSON.stringify(okReport.errors));
  const okCtx = await okAdapter.contractSimContext({ bill: okBill });
  check('动态行情·契约上下文：账单标的 + 示例标的（不超上限）、asOfDate/交易日历来自动态响应',
    !okCtx.error && okCtx.marketSource?.id === 'dynamic-tushare' && okCtx.asOfDate === '2025-12-31'
    && okCtx.symbols.length === 3 && ['600519', '300750', '601318'].every((s) => okCtx.symbols.some((x) => x.symbol === s))
    && okCtx.tradingDays.at(-1) === '2025-12-31', JSON.stringify(okCtx));

  marketResponseHook = () => siteHttpResponse({ status: 503, body: { ok: false, code: 'E_MARKET_UNAVAILABLE', message: '行情服务暂不可用' } });
  const failAdapter = await imp('src/demo/adapter.js?smoke=dynamic-fail');
  const failed = await failAdapter.loadUserBillReport(await billOf(failAdapter, localCsv, 'dynamic-fail.csv'));
  check('动态行情·服务端失败：明确阻断 E_MARKET_SOURCE，无复核/支持范围，不回落合成或静态缓存',
    failed.status === 'blocked' && failed.blocked === true && failed.review === null && failed.marketSource === null && failed.supportScope === null
    && failed.errors[0].code === 'E_MARKET_SOURCE' && failed.errors[0].message.includes('E_MARKET_UNAVAILABLE')
    && countSynthetic() === before, JSON.stringify(failed.errors));
  const failCtx = await failAdapter.contractSimContext({ bill: await billOf(failAdapter, localCsv, 'dynamic-fail.csv') });
  check('动态行情·契约上下文失败：返回 error，不产生可测试标的/日期', !!failCtx.error && !failCtx.symbols && !failCtx.tradingDays, failCtx.error);
  state.route = 'report';
  state.bill = await billOf(okAdapter, '日期,标的,方向,价格,数量,费用,税费\n2025-01-03,600519,买入,1488.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n', 'dynamic-page-fail.csv');
  state.report = { scenario: 'A', symbol: 'pool' };
  mountCycle(); await flush(); await flush(); await flush();
  check('报告动态行情失败展示：错误明确、不冒称已获取行情、没有旧指标卡/反事实',
    texts(current).join('|').includes('动态行情获取失败') && texts(current).join('|').includes('E_MARKET_UNAVAILABLE')
    && !texts(current).join('|').includes('已签收真实行情缓存') && findByClass(current, 'rp-metric').length === 0, texts(current).join('|').slice(0, 300));

  marketResponseHook = (req) => {
    const doc = buildMarketFixture(req);
    doc.artifact = 'market-cache-pull-draft';
    return siteHttpResponse({ body: { ok: true, market: doc } });
  };
  const malformedAdapter = await imp('src/demo/adapter.js?smoke=dynamic-malformed');
  const malformed = await malformedAdapter.loadUserBillReport(await billOf(malformedAdapter, localCsv, 'dynamic-malformed.csv'));
  check('动态行情·响应未通过校验：E_MARKET_SOURCE 阻断，不回落合成或静态缓存',
    malformed.blocked && !malformed.review && malformed.errors[0].code === 'E_MARKET_SOURCE'
    && malformed.errors[0].message.includes('未通过校验') && countSynthetic() === before, JSON.stringify(malformed.errors));

  marketResponseHook = null;
  const boundaryAdapter = await imp('src/demo/adapter.js?smoke=dynamic-boundary');
  const boundaryCsv = '日期,标的,方向,价格,数量,费用,税费\n2023-04-25,300750,买入,100,100,5,0\n';
  const boundaryBill = await billOf(boundaryAdapter, boundaryCsv, 'dynamic-boundary.csv');
  const callsBefore = marketCalls.length;
  const boundary = await boundaryAdapter.loadUserBillReport(boundaryBill);
  check('公司行为边界：300750 事件前交易在取数前整批阻断（E_MARKET_CORPORATE_ACTION_BOUNDARY），不发起行情请求、复核不运行',
    boundary.blocked && !boundary.review && boundary.errors[0].code === 'E_MARKET_CORPORATE_ACTION_BOUNDARY'
    && boundary.errors[0].message.includes('对照路径仍可能跨越该事件') && marketCalls.length === callsBefore, JSON.stringify(boundary.errors));

  let resolveOldReport;
  marketResponseHook = () => new Promise((resolve) => { resolveOldReport = resolve; });
  state.route = 'report';
  state.bill = await billOf(okAdapter, '日期,标的,方向,价格,数量,费用,税费\n2025-01-06,600519,买入,1488.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n', 'dynamic-late.csv');
  mountCycle(); await flush();
  state.bill = { ...defaultBill(), status: 'confirmed' }; mountCycle(); await flush(); await flush(); await flush();
  resolveOldReport(siteHttpResponse({ body: { ok: true, market: buildMarketFixture({ symbols: ['600519'], start: '2024-12-23', end: localTodayIso() }) } }));
  await flush(); await flush(); await flush();
  check('报告异步隔离：旧动态行情响应晚到，不覆盖已经切回的示例报告（合成来源/A数据不串用）',
    texts(current).join('|').includes('合成演示行情') && texts(current).join('|').includes('+4.9%')
    && !texts(current).join('|').includes('dynamic-late.csv'), texts(current).join('|').slice(0, 300));
  marketResponseHook = null;
  state.bill = { ...defaultBill(), status: 'confirmed' };
}

/* ==== 报告页：默认 Tushare 动态行情 R / R′（服务端拉取、非实时；最新交易日 2025-12-31）==== */
state.route = 'report';
state.report = { scenario: 'R', symbol: 'pool' };
state.bill = defaultBill();
mountCycle(); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('真实报告 R·组合：引擎输出 +5.4% / +4.8% / -0.7pp / ¥-2,805.00', txt.includes('+5.4%') && txt.includes('+4.8%') && txt.includes('-0.7pp') && txt.includes('¥-2,805.00'), txt.slice(0, 260));
check('真实报告 R·标注：Tushare 动态日线（服务端获取、非实时）/ 拉取时间 / 最新交易日 2025-12-31 / 快照与校验 / 不出现合成演示行情或签收行情来源措辞',
  txt.includes('示例交易 + Tushare 动态日线（服务端获取，非实时）') && txt.includes('Tushare 动态日线（服务端获取，非实时）') && txt.includes('非实时')
  && txt.includes('拉取 ') && txt.includes('最新交易日 2025-12-31') && txt.includes('快照 tushare-20251231-01234567') && txt.includes('校验 0123456789ab…')
  && txt.includes('估值日：2025-12-31') && !txt.includes('合成演示数据（非真实账户') && !txt.includes('已签收真实行情缓存') && !txt.includes('真实行情缓存 · 签收门'), txt.slice(0, 500));
{
  const sm = summaryTxt();
  check('真实报告 R·摘要：数据来源=示例账单 R（示例交易）/ 行情=Tushare 动态日线 / 结论状态不使用“发布”措辞',
    sm.includes('示例账单 · 示例 R · Tushare 动态行情（示例交易）')
    && sm.includes('Tushare 动态日线（服务端获取，非实时） · 2024-12-19 → 2025-12-31')
    && sm.includes('示例结论：以下数字来自示例交易与 Tushare 最新已收盘日线（服务端获取，非实时）')
    && sm.includes('组合结果：已由本地引擎算出（示例交易 + Tushare 动态日线，未经复核发布流程）') && !sm.includes('已发布'), sm);
}
const provR = txt.match(/示例计算路径（当前范围「组合」· (\d+) 项）/);
check('真实报告 R·证据：示例计算路径 8 项、无阻断、无复核专属词', !!provR && Number(provR[1]) === 8 && demoFacts().length === 8
  && !txt.includes('存在阻断项') && !txt.includes('E_PROVENANCE') && !txt.includes('已发布') && !txt.includes('verify_id'), txt.slice(0, 320));
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('真实报告 R·600519：-7.3% / -8.1% / -0.8pp / ¥-2,508.00', txt.includes('-7.3%') && txt.includes('-8.1%') && txt.includes('-0.8pp') && txt.includes('¥-2,508.00'), txt.slice(0, 260));
check('真实报告 R·反事实：T006 + Tushare 动态行情标注 + 假设结果价值 ¥275,436.00',
  txt.includes('T006') && txt.includes('假设结果价值 ¥275,436.00') && txt.includes('Tushare 动态日线（最新已收盘，服务端获取，非实时，草案口径）') && !txt.includes('该反事实结论不发布'), txt.slice(0, 320));
await clickLabel('组合'); await flush(); await flush(); await flush();
await clickLabel('示例 R′ · 仅改一笔卖出'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('真实报告 R′·组合切换与差异面板：+5.9% / -1.1pp / ¥-4,861.00，与基准 R 差异、仅改第 7 行',
  state.report.scenario === 'Rprime' && txt.includes('+5.9%') && txt.includes('-1.1pp') && txt.includes('¥-4,861.00')
  && txt.includes('与基准 R 的差异') && txt.includes('仅改第 7 行 600519 卖出价')
  && (() => { const d = texts(findByClass(current, 'rp-delta')[0] ?? { children: [] }).join('|'); return d.includes('实际收益|+5.4%|→|+5.9%') && d.includes('择时损耗|-0.7pp|→|-1.1pp') && d.includes('择时损耗金额|¥-2,805.00|→|¥-4,861.00'); })(),
  JSON.stringify({ sc: state.report.scenario, a: txt.includes('+5.9%'), b: txt.includes('-1.1pp'), c: txt.includes('¥-4,861.00'), d: txt.includes('与基准 R 的差异'), e: txt.includes('仅改第 7 行 600519 卖出价'), delta: (findByClass(current, 'rp-delta')[0] ? texts(findByClass(current, 'rp-delta')[0]).join('|') : '') }));
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('真实报告 R′·600519：-6.6% / -1.5pp / ¥-4,564.00', txt.includes('-6.6%') && txt.includes('-1.5pp') && txt.includes('¥-4,564.00'), txt.slice(0, 260));
state.report = { scenario: 'A', symbol: 'pool' };

/* ==== 问答页「对话账本」：通用问法 → 意图 → 最小事实包 → 本地/在线回答 → 证据 ==== */
{
  const chatCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-09-25,600519,买入,100,100,5,0\n2024-10-09,600519,卖出,104,100,5,1\n';
  const chatCsv2 = '日期,标的,方向,价格,数量,费用,税费\n2024-09-25,600519,买入,100,100,5,0\n2024-10-09,600519,卖出,110,100,5,1\n';
  const chatCsv3 = '日期,标的,方向,价格,数量,费用,税费\n2024-09-25,600519,买入,100,100,5,0\n2024-10-09,600519,卖出,106,100,5,1\n';
  const answerCsv1 = '组合实际收益 +4.0%，对照收益 +1277.2%，择时损耗 +1273.2pp，损耗金额 ¥127,318.00。';
  const answerCsv2 = '组合实际收益 +10.0%，对照收益 +1277.2%，择时损耗 +1267.2pp，损耗金额 ¥126,718.00。';
  const answerCsv3 = '组合实际收益 +6.0%，对照收益 +1277.2%，择时损耗 +1271.2pp，损耗金额 ¥127,118.00。';
  const settleChat = async () => { for (let i = 0; i < 30; i++) await flush(); };
  const pageTxt = () => texts(current).join('|');
  const pageVisibleTxt = () => visibleTexts(current).join('|');
  const entries = () => findByClass(current, 'tm-qa-entry');
  const entryOf = (intent) => [...entries()].reverse().find((n) => n.attrs['data-intent'] === intent) ?? null;
  const chips = () => findButtons(current).filter((b) => b.attrs['data-role'] === 'qa-chip');
  const chipOf = (label) => chips().find((b) => labelOf(b).includes(label)) ?? null;
  const textarea = () => findByTag(current, 'textarea').find((n) => n.attrs['data-role'] === 'qa-input') ?? null;
  const askForm = () => findByTag(current, 'form').find((n) => n.attrs['data-role'] === 'qa-form') ?? null;
  const clickNode = (node) => {
    let n = node;
    while (n) {
      for (const fn of n.listeners?.click ?? []) fn({ target: node, preventDefault() {} });
      if (typeof n.onclick === 'function') n.onclick({ target: node, preventDefault() {} });
      n = n.parentNode;
    }
  };
  const askText = async (q) => {
    const input = textarea();
    const form = askForm();
    if (!input || !form) throw new Error('找不到提问框');
    input.value = q;
    for (const fn of input.listeners.input ?? []) await fn({ target: { value: q } });
    for (const fn of form.listeners.submit ?? []) await fn({ preventDefault() {} });
    await settleChat();
  };
  const askChip = async (label) => {
    const chip = chipOf(label);
    if (!chip) throw new Error('找不到示例芯片：' + label);
    clickNode(chip);
    await settleChat();
  };
  const resetChat = () => { state.chat = defaultChat(state.bill.contextId); mountCycle(); };
  const importChatBill = async (name, csv) => {
    state.route = 'import'; mountCycle();
    await pickFile({ name, size: csv.length, __content: csv }); await flush();
    await clickLabel('确认交易列表'); await flush(); await flush(); await flush();
    state.route = 'chat';
    state.contracts = defaultContracts();
    mountCycle();
    return state.bill.contextId;
  };
  const waitForSiteCalls = async (expected) => {
    for (let i = 0; i < 30 && siteCalls.length < expected; i++) await flush();
  };

  /* 1) 页首、空状态与示例芯片 */
  const context1 = await importChatBill('chat-bill.csv', chatCsv);
  {
    const page = findByClass(current, 'tm-qa-page')[0];
    const ledger = findByClass(current, 'tm-qa-log')[0];
    const scroller = findByClass(page ?? {}, 'tm-qa-scroll')[0] ?? null;
    const dock = findByClass(page ?? {}, 'tm-qa-dock')[0] ?? null;
    const form = askForm();
    check('问答账本·页首与空状态：账本独立滚动/输入底栏/8 个示例芯片（1 个在线，标签不写 ONLINE）',
      !!page && !!ledger && ledger.attrs['data-role'] === 'qa-ledger'
      && !!scroller && !!dock && !!form && form.parentNode === dock && ledger.parentNode === scroller
      && pageVisibleTxt().includes('STEP 03 / ASK') && pageVisibleTxt().includes('问它为什么，')
      && pageVisibleTxt().includes('别问它买什么。')
      && pageVisibleTxt().includes('还没有提问。示例问法只是入口，不是全部。')
      && chips().length === 8 && chips().filter((b) => b.attrs['data-online'] === 'true').length === 1
      && chips().every((b) => !labelOf(b).includes('ONLINE'))
      && pageVisibleTxt().includes('规则 v0 · 生效 0 条') && pageVisibleTxt().includes('原始 CSV 仅本机')
      && entries().length === 0, pageTxt().slice(0, 320));
  }

  /* 2) 本地回答：最错一笔 → 4 条事实 + 折叠证据，不发起在线请求 */
  const siteBeforeWorst = siteCalls.length;
  await askText('我最错的一笔是哪个？');
  {
    const entry = entryOf('worst_trade');
    const facts = entry ? findByClass(entry, 'tm-qa-facts')[0] : null;
    const evidence = entry ? findByClass(entry, 'tm-qa-evidence')[0] : null;
    const evidenceSummary = evidence ? findByTag(evidence, 'summary')[0] : null;
    check('问答账本·最错一笔：local/本地规则/4 条事实/证据折叠/报告已发布',
      state.chat.pending === false && !!entry && entry.attrs['data-state'] === 'local'
      && entry.attrs['data-role'] === 'qa-entry'
      && texts(entry).join('|').includes('本地规则')
      && facts && findByClass(facts, 'tm-qa-fact').length === 4
      && evidenceSummary && texts(evidenceSummary).join('').includes('证据')
      && pageVisibleTxt().includes('已校验') && pageVisibleTxt().includes('报告 已发布')
      && siteCalls.length === siteBeforeWorst,
      JSON.stringify({ attrs: entry?.attrs, facts: facts ? texts(facts) : null, site: siteCalls.length - siteBeforeWorst }));
  }

  /* 3) 边界拒绝：不加载报告、不调用模型、0 条事实 */
  const callsBeforeRefusal = siteCalls.length;
  const marketsBeforeRefusal = marketCalls.length;
  await askText('明天买什么？');
  {
    const entry = entryOf('out_of_scope');
    check('问答账本·越界问题：refusal/边界拦截/0 条事实/不加载报告不调用模型',
      !!entry && entry.attrs['data-state'] === 'refusal'
      && !findByClass(entry, 'tm-qa-facts').length
      && texts(entry).join('|').includes('不荐股、不预测涨跌、不替你决定买卖')
      && siteCalls.length === callsBeforeRefusal && marketCalls.length === marketsBeforeRefusal,
      JSON.stringify({ attrs: entry?.attrs, site: siteCalls.length - callsBeforeRefusal, market: marketCalls.length - marketsBeforeRefusal }));
  }

  /* 4) 清空对话：账本与消息一起清空 */
  {
    const clear = findButtons(current).find((b) => b.attrs['data-role'] === 'qa-clear');
    if (clear) clickNode(clear);
    await flush();
    check('问答账本·清空对话：消息清空、回到空状态',
      state.chat.messages.length === 0 && entries().length === 0
      && pageVisibleTxt().includes('还没有提问'), JSON.stringify(state.chat));
  }

  /* 5) 登记式应答：不替用户决定，动作跳规则工作区 */
  await askText('帮我定个止损。');
  {
    const entry = entryOf('contract_setup');
    const action = entry ? findButtons(entry).find((b) => labelOf(b).includes('去规则工作区')) : null;
    check('问答账本·登记式应答：registration/不替你决定/去规则工作区',
      !!entry && entry.attrs['data-state'] === 'registration'
      && texts(entry).join('|').includes('我不能替你定止损')
      && texts(entry).join('|').includes('不内联保存、不自动生成规则')
      && !!action, JSON.stringify({ attrs: entry?.attrs, actions: entry ? findButtons(entry).map(labelOf) : [] }));
  }

  /* 6) 计算口径：只列索引，不出现文件名或成交行 */
  await askText('这些数字是怎么算出来的？');
  {
    const entry = entryOf('meta_calc');
    const facts = entry ? findByClass(entry, 'tm-qa-facts')[0] : null;
    const factsTxt = facts ? texts(facts).join('|') : '';
    const entryTxt = entry ? texts(entry).join('|') : '';
    check('问答账本·计算口径：meta_calc/可回源事实与公式数/证据不含文件名与成交行',
      !!entry && entry.attrs['data-state'] === 'local'
      && factsTxt.includes('可回源事实') && factsTxt.includes('公式')
      && entryTxt.includes('回源') && !entryTxt.includes('chat-bill.csv') && !entryTxt.includes('第 2 行'),
      JSON.stringify({ attrs: entry?.attrs, facts: factsTxt, text: entryTxt.slice(0, 260) }));
  }

  /* 7) 反事实指代不清：待澄清 + 明确选项 */
  await askText('如果那笔卖出没发生，会怎样？');
  {
    const entry = entryOf('what_if');
    const actions = entry ? findButtons(entry) : [];
    check('问答账本·反事实：what_if/clarify/不猜指代并给出具体候选',
      !!entry && entry.attrs['data-state'] === 'clarify'
      && texts(entry).join('|').includes('指哪一笔还不明确')
      && actions.length >= 2 && actions.some((b) => labelOf(b).includes('2024-')),
      JSON.stringify({ attrs: entry?.attrs, actions: actions.map(labelOf) }));
  }

  /* 8) 规则状态：无生效规则时如实说明，不生成命中数 */
  await askText('我的规则守得住吗？');
  {
    const entry = entryOf('contract_status');
    check('问答账本·规则状态：无生效规则时如实说明',
      !!entry && entry.attrs['data-state'] === 'local'
      && texts(entry).join('|').includes('当前没有生效规则')
      && texts(entry).join('|').includes('规则只做提醒，不下单、不阻止交易'),
      JSON.stringify({ attrs: entry?.attrs, text: entry ? texts(entry).join('|').slice(0, 240) : '' }));
  }

  /* 9) 组合芯片在线成功：只展示通过数字校验的复述 */
  resetChat();
  siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: answerCsv1 }) } };
  const siteBeforeOnline = siteCalls.length;
  await askChip('组合表现');
  {
    const entry = entryOf('loss_overview');
    const call = siteCalls.at(-1);
    const body = call ? JSON.parse(call.options.body) : null;
    const entryTxt = entry ? texts(entry).join('|') : '';
    check('问答账本·在线成功：online/复述文本一致/数字校验/上下文账单',
      !!entry && entry.attrs['data-state'] === 'online'
      && entryTxt.includes(answerCsv1) && entryTxt.includes('已核对 4 个可识别数字')
      && entryTxt.includes('在线复述 · 已校验')
      && state.bill.contextId === context1 && pageVisibleTxt().includes('chat-bill.csv')
      && siteCalls.length === siteBeforeOnline + 1,
      JSON.stringify({ attrs: entry?.attrs, text: entryTxt.slice(0, 240), calls: siteCalls.length - siteBeforeOnline }));
    check('问答账本·在线出站：POST restate，body 仅 question + F-6 四事实',
      !!call && call.url === '/functions/v1/app/api/llm/restate' && call.options.method === 'POST'
      && Object.keys(body).join(',') === 'question,facts' && body.facts.length === 4
      && body.facts.every((f) => Object.keys(f).every((k) => ['value', 'unit', 'display', 'formula_ref', 'source_ref'].includes(k)))
      && body.facts.every((f) => !('key' in f) && !('fact_ref' in f) && !('scope' in f))
      && body.facts.every((f) => ['%', 'pp', '元'].includes(f.unit)),
      JSON.stringify({ url: call && call.url, body }));
    check('问答账本·在线出站不含文件名/成交/复核痕迹，请求头无 Key，pending 复位',
      !!body && !JSON.stringify(body).includes('chat-bill.csv') && !JSON.stringify(body).includes('T001')
      && !JSON.stringify(body).includes('provenance')
      && !Object.keys(call.options.headers).some((h) => /authorization|api[-_]?key/i.test(h))
      && state.chat.pending === false);
  }

  /* 10) 伪造数字：回退本地事实，不回显候选数字 */
  resetChat();
  siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: '组合实际收益 +99.9%。' }) } };
  await askChip('组合表现');
  {
    const entry = entryOf('loss_overview');
    check('问答账本·数字失败：回退 local + notice，页面不出现候选数字 99.9',
      !!entry && entry.attrs['data-state'] === 'local'
      && texts(entry).join('|').includes('在线复述未完成，已改为本地已发布事实')
      && !JSON.stringify(state.chat).includes('99.9') && !pageTxt().includes('99.9'),
      JSON.stringify({ attrs: entry?.attrs, chat: JSON.stringify(state.chat).slice(0, 260) }));
  }

  /* 11) 站点函数未就绪（503）：同样回退本地事实并说明原因 */
  resetChat();
  siteResponse = { status: 503, body: {} };
  await askChip('组合表现');
  {
    const entry = entryOf('loss_overview');
    check('问答账本·服务未就绪：local 回退 + 原因，不展示模型文本',
      !!entry && entry.attrs['data-state'] === 'local'
      && texts(entry).join('|').includes('在线复述未完成，已改为本地已发布事实')
      && texts(entry).join('|').includes('函数未发布'),
      JSON.stringify({ attrs: entry?.attrs, text: entry ? texts(entry).join('|').slice(0, 260) : '' }));
  }
  siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: '' }) } };

  /* 12) 换账单：旧回答不展示，新上下文重新开始 */
  const contextBeforeReplace = state.bill.contextId;
  const context2 = await importChatBill('chat-bill.csv', chatCsv2);
  check('问答账本·换账单（同名重导入）：新上下文、旧聊天清空',
    context2 !== contextBeforeReplace && state.bill.fileName === 'chat-bill.csv'
    && state.bill.contextId === context2 && state.chat.contextId === context2
    && state.chat.messages.length === 0 && state.chat.pending === false, JSON.stringify(state.chat));
  check('问答账本·换账单：旧回答不再展示',
    !pageTxt().includes('¥127,318.00') && !pageTxt().includes(answerCsv1), pageTxt().slice(0, 300));

  /* 13) 待定请求换账单：旧响应返回后不污染新上下文 */
  const contextBeforePending = state.bill.contextId;
  const callsBeforeOld = siteCalls.length;
  const oldDeferred = deferredSiteResponse({ rawText: JSON.stringify({ answer_text: answerCsv2 }) });
  siteQueue.push(oldDeferred);
  const oldChip = chipOf('组合表现');
  clickNode(oldChip);
  await waitForSiteCalls(callsBeforeOld + 1);
  check('问答账本·待定请求：已发出、pending、入口禁用',
    state.chat.pending === true && state.chat.contextId === contextBeforePending
    && siteCalls.length === callsBeforeOld + 1 && chipOf('组合表现')?.disabled === true,
    JSON.stringify(state.chat));

  const context3 = await importChatBill('chat-bill.csv', chatCsv3);
  check('问答账本·请求未完成时换账单：清空旧聊天并生成新上下文',
    context3 !== contextBeforePending && state.bill.contextId === context3 && state.chat.contextId === context3
    && state.chat.messages.length === 0 && state.chat.pending === false, JSON.stringify(state.chat));

  const callsBeforeNew = siteCalls.length;
  const newDeferred = deferredSiteResponse({ rawText: JSON.stringify({ answer_text: answerCsv3 }) });
  siteQueue.push(newDeferred);
  const newChip = chipOf('组合表现');
  clickNode(newChip);
  await waitForSiteCalls(callsBeforeNew + 1);
  check('问答账本·新上下文请求 pending',
    state.chat.pending === true && state.chat.messages.length === 1 && state.chat.messages[0].role === 'user',
    JSON.stringify(state.chat));

  oldDeferred.resolve();
  await settleChat();
  check('问答账本·旧响应返回：不追加回答、不覆盖新 pending',
    state.chat.messages.length === 1 && state.chat.messages[0].role === 'user'
    && state.chat.pending === true && !JSON.stringify(state.chat).includes(answerCsv2), JSON.stringify(state.chat));

  newDeferred.resolve();
  await settleChat();
  {
    const entry = entryOf('loss_overview');
    check('问答账本·新响应正常写回：新上下文 online 回答',
      state.chat.pending === false && !!entry && entry.attrs['data-state'] === 'online'
      && texts(entry).join('|').includes(answerCsv3), JSON.stringify(state.chat));
  }

  /* 14) L2 在线意图：只发送问题文本；命中后仍用本地事实回答 */
  resetChat();
  const callsBeforeL2 = siteCalls.length;
  siteQueue.push({ status: 200, body: { rawText: JSON.stringify({ intent: 'loss_overview', slots: {}, confidence: 0.92 }) } });
  await askText('帮我看看这个账户');
  {
    const entry = entryOf('loss_overview');
    const entryTxt = entry ? texts(entry).join('|') : '';
    const call = siteCalls[callsBeforeL2];
    const body = call ? JSON.parse(call.options.body) : null;
    check('问答账本·L2 在线意图：layer=在线意图/只发送问题文本/本地事实回答',
      !!entry && entry.attrs['data-state'] === 'local' && entryTxt.includes('在线意图')
      && entryTxt.includes('4 条事实') && siteCalls.length === callsBeforeL2 + 1
      && !!body && Object.keys(body).join(',') === 'question' && body.question === '帮我看看这个账户',
      JSON.stringify({ attrs: entry?.attrs, url: call?.url, body, text: entryTxt.slice(0, 240), chat: state.chat }));
  }

  // 恢复对话前的演示账单已确认态，避免影响后续契约情境用例
  state.bill = { ...defaultBill(), status: 'confirmed' };
  state.chat = defaultChat();
}

/* ==== 契约页：当前规则（多条共存）→ 新增弹窗 → 历史规则 → 历史情境测试（合成行情）==== */
const fire = async (node, type, value) => { node.value = value; for (const fn of node.listeners[type] ?? []) await fn({ target: { value } }); };
const checkbox = async (role, checked = true) => {
  const input = byRole(role);
  if (!input) throw new Error(`Missing checkbox ${role}`);
  for (const fn of input.listeners.change ?? []) await fn({ target: { checked } });
};
const fieldInput = (key) => findInputs(current).find((i) => i.attrs['data-field'] === key);
const byRole = (role) => [...findByTag(current, 'select'), ...findInputs(current), ...findByTag(current, 'textarea')].find((n) => n.attrs['data-role'] === role);
const modalNode = () => findByClass(current, 'cv-modal')[0] ?? null;
const modalTxt = () => { const m = modalNode(); return m ? texts(m).join('|') : ''; };
const liveTxt = () => texts(findByClass(current, 'cv-live')[0] ?? { children: [] }).join('|');
const simTxt = () => texts(findByClass(current, 'cv-sim-out')[0] ?? { children: [] }).join('|');
const ruleBox = (hash) => findByClass(current, 'cv-sim-result').find((n) => n.attrs['data-hash'] === hash);
const ruleTxt = (hash) => { const n = ruleBox(hash); return n ? texts(n).join('|') : ''; };
const verdictOf = (hash) => { const n = ruleBox(hash); const v = n ? findByClass(n, 'cv-verdict')[0] : null; return v ? texts(v).join('') : ''; };
const simHashes = () => findByClass(current, 'cv-sim-result').map((n) => n.attrs['data-hash']);
const summaryOf = (k) => { const n = findByClass(current, 'cv-sim-summary')[0]; const ch = n ? n.children.find((x) => x && x.attrs && x.attrs['data-verdict'] === k) : null; return ch ? texts(ch).join('') : ''; };
const ruleCards = (cls) => findByClass(current, 'cv-rule').filter((n) => String(n.attrs.class).split(/\s+/).includes(cls));
const enabledHashes = () => ruleCards('on').map((n) => n.attrs['data-hash']);
const reconfirmHashes = () => ruleCards('reconfirm').map((n) => n.attrs['data-hash']);
const histNodes = () => findByClass(current, 'cv-hist').filter((n) => n.attrs['data-hash']);
const histHashes = () => histNodes().map((n) => n.attrs['data-hash']);
const histOf = (hash) => histNodes().find((n) => n.attrs['data-hash'] === hash);
const histState = (hash) => histOf(hash)?.attrs['data-state'] ?? '';
const sellsLine = () => { const n = findByClass(current, 'cv-sells')[0]; return n ? texts(n).join('') : ''; };
const ruleCardOf = (hash) => findByClass(current, 'cv-rule').find((n) => n.attrs['data-hash'] === hash);
const slotNode = (tid) => findByClass(current, 'cv-slot').find((n) => n.attrs['data-template'] === tid);
const slotHashes = (tid) => findByClass(slotNode(tid) ?? { children: [] }, 'cv-rule').map((n) => n.attrs['data-hash']);
// 默认可见文本：收起的 <details> 只计 <summary>
function visibleTexts(node, out = []) {
  for (const c of node.children ?? []) {
    if (c == null) continue;
    if (c.__text !== undefined) { out.push(c.__text); continue; }
    if (c.tagName === 'DETAILS') { const s = (c.children ?? []).find((x) => x && x.tagName === 'SUMMARY'); if (s) visibleTexts(s, out); continue; }
    if (c.value) out.push(String(c.value));
    visibleTexts(c, out);
  }
  return out;
}
const cardVisible = (hash) => { const n = ruleCardOf(hash); return n ? visibleTexts(n).join('|') : ''; };
const histVisible = (hash) => { const n = histOf(hash); return n ? visibleTexts(n).join('|') : ''; };
const disableRule = async (hash) => { await clickIn(ruleCardOf(hash), '停用'); await clickIn(ruleCardOf(hash), '确认停用'); await settle(); };
const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));
async function clickIn(node, label) {
  const b = node && findButtons(node).find((x) => labelOf(x).includes(label));
  if (!b) throw new Error('找不到按钮：' + label);
  for (const fn of b.listeners.click ?? []) await fn({});
}
const btnOf = (label) => findButtons(current).find((b) => labelOf(b).includes(label));
const roleBtn = (role) => findButtons(current).find((b) => b.attrs['data-role'] === role);
async function clickRole(role) {
  const b = roleBtn(role);
  if (!b) throw new Error('找不到按钮：' + role);
  for (const fn of b.listeners.click ?? []) await fn({});
}
const pressEsc = async () => { for (const fn of docListeners.keydown ?? []) await fn({ key: 'Escape' }); };
const hashOf = (s) => (s.match(/候选哈希，待 M0-C1 冻结：([0-9a-f]{16})/) ?? [])[1] ?? null;
const settle = async () => { await flush(); await flush(); await flush(); };
const SIM_BTN = '测试该日买入是否触发规则';
const simulate = async (symbol, date) => {
  await fire(byRole('sim-symbol'), 'change', symbol);
  await fire(byRole('sim-date'), 'input', date);
  await clickLabel(SIM_BTN); await settle();
  return simTxt();
};
const sourceLine = () => texts(findByClass(current, 'cv-source')[0] ?? { children: [] }).join('');
const stored = () => JSON.parse(store.get('tm.contracts.demo') ?? '{}').versions ?? [];
const maxV = () => Math.max(...state.contracts.versions.map((r) => (Number.isFinite(r.v) ? r.v : 0)));
const reload = async () => { state.contracts = { ...defaultContracts(), marketSource: state.contracts.marketSource ?? 'synthetic-fixture', versions: loadContractsDemo() }; mountCycle(); await settle(); };
const saveModal = async () => { await clickRole('modal-save'); await settle(); };
const nlPanel = () => findByClass(current, 'cv-nl-embedded')[0] ?? null;
const openCustom = async () => { await clickRole('add-rule'); await fire(byRole('template'), 'change', '__custom__'); await settle(); };
{
  const adapterMod = await imp('src/demo/adapter.js');
  const viewSrc = readFileSync(join(ROOT, 'src/ui/views/contractView.js'), 'utf8');
  check('契约：页面只经 adapter 取数（不 import contractMatch / marketCache / engine），当前 / 历史划分由 adapter 提供（页面不自行比较版本或排序），旧的并行 / 整理接口已移除',
    !/from\s+['"][^'"]*engine\//.test(viewSrc) && !viewSrc.includes('contractMatch') && !viewSrc.includes('marketCache') && !viewSrc.includes('.activated')
    && typeof adapterMod.contractOrganizeRecords === 'undefined' && typeof adapterMod.contractToggleRecord === 'undefined' && typeof adapterMod.contractEditorRecord === 'undefined'
    && adapterMod.CAPABILITY.contractEngine.label.includes('已接入（候选口径）') && adapterMod.CAPABILITY.bailian.label.includes('未接通'), adapterMod.CAPABILITY.contractEngine.label);
  const H = (template_id, fields) => adapterMod.previewContract({ template_id, fields }).hash;
  const hS3 = H('no_buy_on_surge', { threshold_pct: '3' }), hS4 = H('no_buy_on_surge', { threshold_pct: '4' }), hS5 = H('no_buy_on_surge', { threshold_pct: '5' });
  const hB3 = H('no_buy_back_within', { days: '3' }), hB5 = H('no_buy_back_within', { days: '5' });

  /* —— 1. 默认布局 —— */
  const marketCallsBeforeContract = marketCalls.length;
  state.route = 'contract'; state.contracts = defaultContracts(); mountCycle(); await settle(); await settle();
  txt = texts(current).join('|');
  {
    const symOpts = findByTag(byRole('sim-symbol'), 'option').map((o) => o.attrs.value);
    check('契约·默认动态行情：标题“历史情境测试（Tushare 动态行情）”，交易来源=示例账单 R，行情=Tushare 动态日线，拉取/快照可见',
      txt.includes('历史情境测试（Tushare 动态行情）') && sourceLine().startsWith('交易来源：示例账单 R')
      && sourceLine().includes('行情：Tushare 动态日线（服务端获取，非实时）')
      && txt.includes('Tushare 动态日线（服务端获取，非实时）· 不构成投资建议')
      && txt.includes('最新已收盘日线（非实时）· 候选规则口径（待 M0-C1 冻结）· 不构成投资建议')
      && txt.includes('行情拉取：') && txt.includes('最新交易日 2025-12-31') && txt.includes('快照 tushare-20251231-01234567') && txt.includes('校验 0123456789ab…')
      && txt.includes('2024-12-19 ~ 2025-12-31') && !txt.includes('已签收'), sourceLine() + ' || ' + txt.slice(0, 420));
    check('契约·动态行情范围：示例 3 只标的均在本次行情；只请求标的与日期范围（TTL 内复用同一范围，不重复请求）',
      JSON.stringify(symOpts) === JSON.stringify(['300750', '600519', '601318'])
      && marketCalls.slice(marketCallsBeforeContract).every((c) => Object.keys(c).sort().join(',') === 'end,start,symbols'
        && JSON.stringify(c.symbols) === JSON.stringify(['300750', '600519', '601318']) && c.start === '2024-12-19')
      && marketCalls.length - marketCallsBeforeContract <= 1,
      JSON.stringify({ symOpts, calls: marketCalls.slice(marketCallsBeforeContract) }));
  }
  store.delete('tm.contracts.demo');
  state.route = 'contract'; state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' }; mountCycle(); await settle();
  txt = texts(current).join('|');
  {
    const headVis = visibleTexts(findByClass(current, 'cv-head')[0]).join('|');
    const hist = findByClass(current, 'cv-history')[0];
    check('默认布局：没有常驻编辑器（无弹窗 / 模板选择 / 参数输入 / 规则预览），页头为“交易规则”+ 简介 + 本地存储说明 + 主按钮“新增规则”',
      !modalNode() && !byRole('template') && !fieldInput('threshold_pct') && findByClass(current, 'cv-live').length === 0
      && labelOf(roleBtn('add-rule')) === '新增规则' && String(roleBtn('add-rule').attrs.class).includes('primary')
      && headVis.includes('交易规则') && headVis.includes('设置在历史情境测试中用于提醒自己的交易规则。') && headVis.includes('规则仅保存在当前浏览器；不会自动交易，也不会改变分析报告结论。')
      && headVis.includes('技术说明（候选口径）') && !headVis.includes('M0-C1') && !!btnOf(SIM_BTN) && !btnOf('模拟申报买入'), headVis);
    check('默认布局：当前生效规则（0）空状态 + 三种类型各显示“暂未设置 / 新增此类规则”；历史规则默认折叠“历史规则（0）”；无并行 / 整理 / 替换选择字样',
      txt.includes('当前生效规则（0）') && txt.includes('暂无当前生效的规则') && slotHashes('no_buy_on_surge').length === 0
      && texts(slotNode('no_buy_back_within')).join('|').includes('暂未设置「卖出后 N 个交易日内不追回」规则')
      && texts(slotNode('sell_within_after_buy')).join('|').includes('暂未设置「买入后 N 个交易日内卖出提醒」规则')
      && findButtons(current).filter((b) => labelOf(b) === '新增规则').length === 4
      && hist.tagName === 'DETAILS' && hist.attrs.open === undefined && texts(hist).join('|').includes('历史规则（0）')
      && !txt.includes('同时保留') && !txt.includes('整理此组') && !txt.includes('替换旧规则（推荐）') && !txt.includes('并行'), txt.slice(0, 300));
  }

  /* —— 2. 新增弹窗：出现 / 预览 / 参数错误 / 取消 / Esc / 关闭 —— */
  await clickRole('add-rule');
  {
    const m = modalNode();
    check('新增弹窗：出现“新增交易规则”（role=dialog、aria-modal、打开即获得焦点），背景页面设为 inert；含 3 个模板 + 自定义规则、参数、备注、实时预览，按钮“取消 / 保存并启用”',
      !!m && m.attrs.role === 'dialog' && m.attrs['aria-modal'] === 'true' && globalThis.__focused === m && modalTxt().includes('新增交易规则')
      && findByClass(current, 'cv-page')[0].attrs.inert === '' && findByTag(byRole('template'), 'option').length === 4
      && findByTag(byRole('template'), 'option').some((o) => o.attrs.value === '__custom__')
      && !!fieldInput('threshold_pct') && !!byRole('note') && liveTxt().includes('当天涨幅超过 5% 的票，我绝不买入。') && liveTxt().includes('阈值：5.0%') && liveTxt().includes('提醒：申报买入时')
      && labelOf(roleBtn('modal-save')) === '保存并启用' && labelOf(roleBtn('modal-cancel')) === '取消' && roleBtn('modal-close').attrs['aria-label'] === '关闭'
      && roleBtn('modal-save').disabled === false && !modalTxt().includes('同时保留') && state.contracts.versions.length === 0, modalTxt().slice(0, 300));
  }
  await fire(fieldInput('threshold_pct'), 'input', '3');
  check('弹窗·实时预览：阈值改为 3 → 预览“3% / 3.0%”，候选哈希随之变化（技术信息默认折叠）',
    liveTxt().includes('当天涨幅超过 3% 的票') && liveTxt().includes('阈值：3.0%') && hashOf(liveTxt()) === hS3 && !visibleTexts(findByClass(current, 'cv-live')[0]).join('|').includes(hS3), liveTxt().slice(0, 300));
  await fire(fieldInput('threshold_pct'), 'input', '5%');
  check('弹窗·参数错误：显示引擎错误（E_CONTRACT_FIELD_INVALID · 须为数字 · 收到「5%」），不生成规则 / 哈希，保存不可点',
    liveTxt().includes('E_CONTRACT_FIELD_INVALID') && liveTxt().includes('须为数字') && liveTxt().includes('收到「5%」') && !hashOf(liveTxt()) && !liveTxt().includes('阈值：')
    && roleBtn('modal-save').disabled === true, liveTxt().slice(0, 300));
  await fire(fieldInput('threshold_pct'), 'input', '-1');
  check('弹窗·参数错误：负阈值显示“须 ≥ 0”（不自动纠正），保存不可点', liveTxt().includes('须 ≥ 0') && liveTxt().includes('收到「-1」') && roleBtn('modal-save').disabled === true, liveTxt().slice(0, 200));
  await fire(byRole('template'), 'change', 'no_buy_back_within');
  await fire(fieldInput('days'), 'input', '2.5');
  check('弹窗·不追回模板：切换后小数窗口 → 引擎错误“须为 ≥ 1 的整数”，保存不可点', liveTxt().includes('E_CONTRACT_FIELD_INVALID') && liveTxt().includes('须为 ≥ 1 的整数') && roleBtn('modal-save').disabled === true, liveTxt().slice(0, 200));
  await clickRole('modal-cancel');
  check('弹窗·取消：关闭弹窗，不写入任何记录（内存与本地存储均为 0 条），背景恢复可操作',
    !modalNode() && state.contracts.versions.length === 0 && stored().length === 0 && findByClass(current, 'cv-page')[0].attrs.inert === undefined, String(state.contracts.versions.length));
  await clickRole('add-rule'); await pressEsc();
  check('弹窗·Esc：按 Esc 关闭，不写入记录', !modalNode() && state.contracts.versions.length === 0 && stored().length === 0);
  await clickRole('add-rule'); await clickRole('modal-close');
  check('弹窗·关闭按钮（×）：关闭，不写入记录', !modalNode() && state.contracts.versions.length === 0 && stored().length === 0);

  /* —— 3. 新增两种不同类型 → 同时生效 —— */
  await clickRole('add-rule');
  await fire(fieldInput('threshold_pct'), 'input', '3');
  await fire(byRole('note'), 'input', '追高总亏');
  await saveModal();
  const firstRec = JSON.stringify(stored()[0]);
  check('新增·保存并启用：弹窗关闭，涨幅 3% 成为当前规则 v1（已确认），记录含模板 / 参数 / 规则文本 / 哈希 / 算法 / 备注并持久化',
    !modalNode() && sameSet(enabledHashes(), [hS3]) && stored().length === 1 && stored()[0].v === 1 && stored()[0].status === '已确认' && stored()[0].hash === hS3
    && stored()[0].schema === 'contract-v1' && stored()[0].template_id === 'no_buy_on_surge' && stored()[0].fields.threshold_pct === 3 && stored()[0].note === '追高总亏'
    && stored()[0].hash_algorithm === 'fnv1a64-placeholder' && !!stored()[0].at, JSON.stringify(stored()).slice(0, 300));
  check('当前规则卡默认视图：已启用、规则文本、触发条件与折叠详情，不显示模板名称及技术信息',
    cardVisible(hS3).includes('已启用') && !cardVisible(hS3).includes('涨幅超阈值不买入') && cardVisible(hS3).includes('当天涨幅超过 3% 的票，我绝不买入。')
    && cardVisible(hS3).includes('触发条件：申报买入当天涨幅超过 3.0%') && cardVisible(hS3).includes('版本 v1') && cardVisible(hS3).includes('查看详情')
    && findButtons(ruleCardOf(hS3)).some((b) => labelOf(b) === '停用')
    && !cardVisible(hS3).includes(hS3) && !cardVisible(hS3).includes('候选哈希') && !cardVisible(hS3).includes('fnv1a64') && !cardVisible(hS3).includes('M0-C1')
    && !cardVisible(hS3).includes('涨幅阈值（%）') && !cardVisible(hS3).includes('已确认') && !cardVisible(hS3).includes('历史状态变更'), cardVisible(hS3));
  await clickRole('add-rule');
  {
    const sel = findByTag(byRole('template'), 'option').find((o) => o.attrs.selected === 'selected');
    check('新增弹窗：已有涨幅规则时默认选中尚未设置的“卖出后不追回”模板（默认 3 个交易日），无替换说明',
      !!sel && sel.attrs.value === 'no_buy_back_within' && liveTxt().includes('卖出后 3 个交易日内不追回同一只票。') && liveTxt().includes('阈值：3 个交易日')
      && !modalTxt().includes('进入历史记录'), modalTxt().slice(0, 300));
  }
  await fire(fieldInput('days'), 'input', '5');
  await saveModal();
  txt = texts(current).join('|');
  check('不同类型同时生效：新增不追回 5 日（v2，已确认）后，涨幅 3% 与不追回 5 日都是当前规则（各占一个类型），互不替代、无替代记录、历史为空',
    sameSet(enabledHashes(), [hS3, hB5]) && slotHashes('no_buy_on_surge').join() === hS3 && slotHashes('no_buy_back_within').join() === hB5
    && stored().length === 2 && stored()[1].v === 2 && stored()[1].status === '已确认' && !stored().some((r) => r.via === '替代')
    && txt.includes('当前生效规则（2）') && histHashes().length === 0 && txt.includes('历史规则（0）'), JSON.stringify(stored().map((r) => [r.v, r.status])));
  check('情境来源·演示模式：交易来源=演示账单 A · 行情=合成演示行情 + 非真实行情 / 候选口径 / 不构成投资建议；不追回规则生效时列出卖出记录',
    state.bill.status === 'confirmed' && state.bill.sourceType !== 'local' && sourceLine().startsWith('交易来源：演示账单 A') && sourceLine().includes('行情：合成演示行情')
    && txt.includes('合成夹具（非真实行情）· 候选口径（待 M0-C1 冻结）· 不构成投资建议') && sellsLine().includes('T004 000000 2024-10-08'), sourceLine());
  let s = await simulate('000000', '2024-10-10');
  {
    const ledger = findByClass(current, 'cv-ledger')[0];
    const ledgerText = ledger ? texts(ledger).join('|') : '';
    check('守约账本：情境测试加载后展示当前规则复核、汇总与口径说明',
      !!ledger && ledgerText.includes('守约账本') && ledgerText.includes('按当前生效规则复核账单中的')
      && ledgerText.includes('涨幅超阈值不买入') && ledgerText.includes('卖出后 N 个交易日内不追回')
      && ledgerText.includes('账本口径') && ledgerText.includes('不是实时申报记录'), ledgerText.slice(0, 400));
  }
  {
    check('测试：两种类型的当前规则各判定一次（无“本次测试使用的规则”汇总行），无并行 / 重复提醒 / 整理字样',
      sameSet(simHashes(), [hS3, hB5]) && !findByClass(current, 'cv-sim-headline').length
      && s.includes('当天涨幅超过 3% 的票，我绝不买入。') && s.includes('卖出后 5 个交易日内不追回同一只票。')
      && !s.includes('本次测试使用的规则')
      && summaryOf('triggered') === '命中 1 条' && summaryOf('not_triggered') === '未命中 1 条' && !summaryOf('error') && !summaryOf('missing_data') && !s.includes('并行') && !s.includes('可能重复') && !s.includes('整理'), s.slice(0, 400));
  }
  check('测试·不追回：000000 2024-10-10（距卖出 2 日 ≤ 5）→ 命中 + 规则 / 阈值 / 情境事实 / 警告 / 候选哈希；涨幅 3% 未命中且不使用账单交易',
    verdictOf(hB5) === '命中' && ruleTxt(hB5).includes('规则提醒：此情境命中你确认的规则') && ruleTxt(hB5).includes('规则：卖出后 5 个交易日内不追回同一只票。') && ruleTxt(hB5).includes('阈值：5 个交易日')
    && ruleTxt(hB5).includes('最近卖出：T004 · 2024-10-08') && ruleTxt(hB5).includes('距最近卖出：2 个交易日') && txt.includes('合成回归行情 · 不构成投资建议')
    && ruleTxt(hB5).includes(`候选哈希，待 M0-C1 冻结：${hB5}`)
    && verdictOf(hS3) === '未命中' && ruleTxt(hS3).includes('未超过阈值 3.0%') && !ruleTxt(hS3).includes('规则提醒'), ruleTxt(hB5).slice(0, 400));

  /* —— 4. 编辑涨幅规则：3% → 5%，创建新版本 v3，旧版本 v1 进入历史 —— */
  await clickIn(ruleCardOf(hS3), '编辑');
  await fire(fieldInput('threshold_pct'), 'input', '5');
  check('编辑弹窗：涨幅 5% 预览正确，提示”保存后生成版本 v3，当前版本 v1 将进入历史规则”',
    hashOf(liveTxt()) === hS5 && labelOf(roleBtn('modal-save')) === '保存并启用' && modalTxt().includes('保存后生成版本 v3，当前版本 v1 将进入历史规则'), modalTxt().slice(-300));
  await saveModal();
  {
    const newRec = stored().at(-1);
    const oldRec = stored().at(-2);
    check('编辑·写入：追加新规则 v3（已确认），旧规则 v1 标记为”替代”进入历史',
      stored().length === 4 && newRec.hash === hS5 && newRec.v === 3 && newRec.status === '已确认'
      && oldRec.hash === hS3 && oldRec.v === 1 && oldRec.status === '已拒绝' && oldRec.via === '替代' && oldRec.replaced_by_hash === hS5, JSON.stringify(stored().slice(2)).slice(0, 400));
  }
  txt = texts(current).join('|');
  check('编辑涨幅 5%：当前规则更新为 5%（v3），不追回 5 日不受影响，历史包含旧 3%（v1）',
    sameSet(enabledHashes(), [hS5, hB5]) && slotHashes('no_buy_on_surge').join() === hS5
    && cardVisible(hS5).includes('版本 v3') && histHashes().includes(hS3) && histState(hS3) === 'replaced'
    && histVisible(hS3).includes('已被替代') && slotHashes('no_buy_back_within').join() === hB5, JSON.stringify({ on: enabledHashes(), hist: histHashes() }));
  s = await simulate('000000', '2024-09-30');
  check('编辑后测试：涨幅 5% 未命中，无先前卖出记录时不追回规则未命中',
    sameSet(simHashes(), [hS5, hB5]) && verdictOf(hS5) === '未命中' && verdictOf(hB5) === '未命中' && ruleTxt(hB5).includes('无卖出记录'), ruleTxt(hB5));

  /* —— 5. 编辑不追回规则：5 日 → 3 日，创建新版本 v4，旧版本 v2 进入历史 —— */
  await clickIn(ruleCardOf(hB5), '编辑');
  await fire(fieldInput('days'), 'input', '3');
  await saveModal();
  check('编辑不追回 3 日：当前规则更新为 3 日（v4），旧 5 日（v2）进入历史，涨幅 5% 不受影响',
    sameSet(enabledHashes(), [hS5, hB3]) && slotHashes('no_buy_back_within').join() === hB3
    && sameSet(histHashes(), [hS3, hB5]) && stored().length === 6
    && cardVisible(hB3).includes('版本 v4') && histState(hB5) === 'replaced', JSON.stringify(stored().slice(4)).slice(0, 300));
  s = await simulate('000000', '2024-10-10');
  check('编辑后测试：涨幅 5%（未命中）+ 不追回 3 日（命中，距卖出 2 日 ≤ 3）', sameSet(simHashes(), [hS5, hB3]) && verdictOf(hB3) === '命中' && verdictOf(hS5) === '未命中', JSON.stringify(simHashes()));

  /* —— 6. 再次编辑涨幅规则：5% → 4%，创建新版本 v5，旧版本 v3 进入历史 —— */
  await clickIn(ruleCardOf(hS5), '编辑');
  await fire(fieldInput('threshold_pct'), 'input', '4');
  await saveModal();
  check('再次编辑涨幅 4%：当前规则更新为 4%（v5），旧 5%（v3）进入历史，不追回 3 日不受影响',
    enabledHashes().sort().join() === [hS4, hB3].sort().join() && stored().length === 8 && cardVisible(hS4).includes('版本 v5')
    && sameSet(histHashes(), [hS3, hB5, hS5]) && histState(hS5) === 'replaced', JSON.stringify(enabledHashes()));

  /* —— 7. 从历史恢复（停用后再恢复）—— */
  {
    const n0 = stored().length;
    await clickIn(ruleCardOf(hS4), '停用'); await clickIn(ruleCardOf(hS4), '确认停用'); await settle();
    check('停用涨幅 4%：进入历史，不追回 3 日不受影响',
      !enabledHashes().includes(hS4) && enabledHashes().join() === hB3 && stored().length === n0 + 1, JSON.stringify(enabledHashes()));
    check('恢复提示：历史 4% 显示”恢复后，该规则重新参与情境测试”', histVisible(hS4).includes('恢复后，该规则重新参与情境测试'), histVisible(hS4));
    await clickIn(histOf(hS4), '恢复为当前规则'); await settle();
    const restoreRec = stored().at(-1);
    check('恢复历史规则：4%（v5）重新成为当前（追加”经恢复”状态记录）',
      enabledHashes().includes(hS4) && slotHashes('no_buy_on_surge').join() === hS4 && stored().length === n0 + 2
      && restoreRec.hash === hS4 && restoreRec.v === 5 && restoreRec.via === '恢复' && restoreRec.status === '已确认' && restoreRec.transition_from === '已拒绝'
      && maxV() === 5, JSON.stringify(stored().at(-1)).slice(0, 300));
    await reload();
    check('恢复后刷新：当前规则仍为涨幅 4% + 不追回 3 日，记录数不变', sameSet(enabledHashes(), [hS4, hB3])
      && state.contracts.versions.length === n0 + 2, JSON.stringify({ on: enabledHashes() }));
  }

  /* —— 8. 测试语义回归（命中 / 缺价 / 超范围 / 输入无效 / 日历外）—— */
  s = await simulate('000000', '2024-09-30');
  check('测试·涨幅：000000 2024-09-30 → 4% 命中 + 规则 / 阈值 4.0% / 当日涨跌幅（引擎 display）/ 前收日',
    verdictOf(hS4) === '命中' && ruleTxt(hS4).includes('规则提醒') && ruleTxt(hS4).includes('规则：当天涨幅超过 4% 的票，我绝不买入。') && ruleTxt(hS4).includes('阈值：4.0%')
    && /当日涨跌幅：\+4\.\d+%/.test(ruleTxt(hS4)) && ruleTxt(hS4).includes('前收日 2024-09-27') && txt.includes('合成回归行情 · 不构成投资建议'), ruleTxt(hS4).slice(0, 400));
  s = await simulate('000000', '2024-10-08');
  check('测试·涨幅：000000 2024-10-08 → 未命中', verdictOf(hS4) === '未命中' && ruleTxt(hS4).includes('未超过阈值 4.0%') && !ruleTxt(hS4).includes('规则提醒'), ruleTxt(hS4).slice(0, 300));
  s = await simulate('888888', '2024-10-10');
  check('测试·涨幅：888888 2024-10-10 缺价 → 数据不足（E_CHANGE_PCT_MISSING + 引擎原因，不补造）',
    verdictOf(hS4) === '数据不足' && ruleTxt(hS4).includes('E_CHANGE_PCT_MISSING') && ruleTxt(hS4).includes('缺 888888 收盘价') && !ruleTxt(hS4).includes('当日涨跌幅：') && !ruleTxt(hS4).includes('规则提醒'), ruleTxt(hS4).slice(0, 300));
  s = await simulate('000000', '2024-09-23');
  check('测试·涨幅：缓存首日 → 数据不足（E_PREV_DAY_BEYOND_CACHE 前收不足）', verdictOf(hS4) === '数据不足' && ruleTxt(hS4).includes('E_PREV_DAY_BEYOND_CACHE'), ruleTxt(hS4).slice(0, 300));
  s = await simulate('000000', '2024-11-05');
  check('测试·涨幅：超出缓存范围 → 数据不足（E_VALUATION_OUT_OF_RANGE，不回退）', verdictOf(hS4) === '数据不足' && ruleTxt(hS4).includes('E_VALUATION_OUT_OF_RANGE'), ruleTxt(hS4).slice(0, 300));
  s = await simulate('000000', '');
  check('测试：日期为空 → 涨幅规则”无法判定”并显示引擎输入错误（不默认日期），计入汇总”无法判定 1 条”',
    verdictOf(hS4) === '无法判定' && ruleTxt(hS4).includes('E_CONTRACT_SIM_INPUT_INVALID') && summaryOf('error') === '无法判定 1 条', ruleTxt(hS4).slice(0, 300));
  s = await simulate('000000', '2024-10-05');
  check('测试·不追回：2024-10-05 不在交易日历 → 数据不足（E_DATE_NOT_IN_CALENDAR，不猜测）', verdictOf(hB3) === '数据不足' && ruleTxt(hB3).includes('E_DATE_NOT_IN_CALENDAR')
    && ruleTxt(hB3).includes('不在缓存交易日历') && !ruleTxt(hB3).includes('规则提醒') && simHashes().length === 2, ruleTxt(hB3).slice(0, 300));

  /* —— 9. 完全重复规则：编辑当前规则但不改参数，提示重复 —— */
  await clickIn(ruleCardOf(hS4), '编辑');
  check('编辑规则未修改：不重复保存', hashOf(liveTxt()) === hS4 && modalTxt().includes('与当前规则相同') && roleBtn('modal-save').disabled === true);
  await clickRole('modal-cancel');

  /* —— 10. 停用（二次确认）→ 进入历史 → 恢复 —— */
  {
    const n2 = stored().length;
    await clickIn(ruleCardOf(hB3), '停用');
    check('停用确认：先出现简短确认（说明进入历史规则、不再参与测试、可恢复），未写入记录',
      stored().length === n2 && cardVisible(hB3).includes('确认停用\u201c卖出后 3 个交易日内不追回同一只票。\u201d？') && cardVisible(hB3).includes('停用后，该规则进入历史规则，不再参与之后的历史情境测试；可随时恢复为当前规则。'), cardVisible(hB3));
    await clickIn(ruleCardOf(hB3), '取消');
    check('停用确认：取消后恢复原状，不写入记录', stored().length === n2 && enabledHashes().includes(hB3) && !cardVisible(hB3).includes('确认停用'), cardVisible(hB3));
    await disableRule(hB3);
    check('停用：不追回 3 日（v4）追加”已拒绝 · 手动停用”（版本号不变），进入历史；不追回模板无当前规则',
      !enabledHashes().includes(hB3) && histState(hB3) === 'stopped' && histVisible(hB3).includes('已停用，不参与后续测试。') && histVisible(hB3).includes('恢复为当前规则')
      && stored().length === n2 + 1 && stored().at(-1).v === 4 && stored().at(-1).via === '停用' && stored().at(-1).status === '已拒绝'
      && !enabledHashes().includes(hB5), JSON.stringify(stored().at(-1)).slice(0, 200));
    s = await simulate('000000', '2024-10-10');
    check('停用后测试：只有涨幅 4% 参与判定（不追回模板无当前规则）', sameSet(simHashes(), [hS4]), JSON.stringify(simHashes()));
    await clickIn(histOf(hB3), '恢复为当前规则'); await settle();
    check('恢复已停用规则：不追回 3 日以原版本 v4 回到当前（经恢复），不新增版本号；涨幅规则不受影响',
      enabledHashes().includes(hB3) && cardVisible(hB3).includes('版本 v4') && stored().at(-1).via === '恢复' && stored().at(-1).v === 4 && maxV() === 5
      && sameSet(enabledHashes(), [hS4, hB3]),
      JSON.stringify(stored().at(-1)).slice(0, 200));
  }

  /* —— 11. 旧的同类型并行数据：同模板只保留最新版本为当前，其余进入历史 —— */
  {
    const mk = (template_id, fields, v, at) => {
      const p = adapterMod.previewContract({ template_id, fields });
      return { schema: 'contract-v1', v, status: v === 1 ? '已确认' : '已改写', template_id, template_name: p.template_name, fields: { ...p.fields }, text: p.text, threshold_display: p.threshold.display, hash: p.hash, hash_algorithm: p.hash_algorithm, at, note: null };
    };
    const pre = [
      mk('no_buy_on_surge', { threshold_pct: '3' }, 1, '2026-10-03T00:00:00Z'), mk('no_buy_on_surge', { threshold_pct: '5' }, 2, '2026-10-03T00:01:00Z'),
      mk('no_buy_back_within', { days: '3' }, 3, '2026-10-03T00:02:00Z'), mk('no_buy_back_within', { days: '5' }, 4, '2026-10-03T00:03:00Z'),
    ];
    store.set('tm.contracts.demo', JSON.stringify({ versions: pre }));
    await reload();
    txt = texts(current).join('|');
    check('旧并行数据在同模板单规则模型下：每种模板只保留最新版本为当前（涨幅 5% v2、不追回 5 日 v4），旧版本进入历史（涨幅 3% v1、不追回 3 日 v3 均为 superseded）',
      sameSet(enabledHashes(), [hS5, hB5]) && sameSet(histHashes(), [hS3, hB3])
      && [hS3, hB3].every((h) => histState(h) === 'superseded')
      && state.contracts.versions.length === 4 && JSON.stringify(stored()) === JSON.stringify(pre)
      && txt.includes('当前生效规则（2）') && txt.includes('历史规则（2）'), JSON.stringify({ on: enabledHashes(), hist: histHashes() }));
    s = await simulate('000000', '2024-10-10');
    check('旧并行数据·测试：只使用每种模板的最新版本（涨幅 5% 与不追回 5 日），旧版本不参与', sameSet(simHashes(), [hS5, hB5]), JSON.stringify(simHashes()));
    await reload();
    check('旧并行数据·刷新稳定：当前规则仍为 2 条（涨幅 5% + 不追回 5 日），历史 2 条，记录仍 4 条', sameSet(enabledHashes(), [hS5, hB5]) && sameSet(histHashes(), [hS3, hB3]) && stored().length === 4, JSON.stringify(enabledHashes()));
    await clickIn(histOf(hS3), '恢复为当前规则'); await settle();
    check('旧并行数据·恢复涨幅 3%：3% 成为当前，5% 进入历史（replaced），不追回组不受影响',
      sameSet(enabledHashes(), [hS3, hB5]) && sameSet(histHashes(), [hS5, hB3]) && histState(hS5) === 'replaced'
      && stored().at(-2).via === '恢复' && stored().at(-2).v === 1 && stored().at(-1).via === '替代' && stored().at(-1).hash === hS5, JSON.stringify(stored().slice(-2)).slice(0, 300));
    await disableRule(hS3);
    check('旧并行数据·停用涨幅 3%：5% 不会”复活”为当前（同模板单规则，停用后该模板无当前规则），历史包含 3% 和 5%',
      !enabledHashes().includes(hS3) && !enabledHashes().includes(hS5) && enabledHashes().join() === hB5 && histState(hS3) === 'stopped' && stored().length === 7, JSON.stringify(enabledHashes()));
    await reload();
    check('旧并行数据·停用后刷新稳定：当前只有不追回 5 日', enabledHashes().join() === hB5 && stored().length === 7, JSON.stringify(enabledHashes()));
  }

  /* —— 12. 旧演示记录 / 早期重复记录 / 哈希完整性 / 损坏存储 —— */
  store.set('tm.contracts.demo', JSON.stringify({ versions: [{ v: 1, candidateId: 'RC-1', status: '已确认', text: '当天涨幅超过 5% 的票，我绝不买入。', at: '2026/10/1 10:00:00', hash: '未接入' }, null, 7, 'x'] }));
  await reload();
  txt = texts(current).join('|');
  check('旧演示记录：归入历史规则（“旧演示记录 · 未经规则引擎解析：不参与测试，不能恢复”），非对象条目被丢弃，当前规则为 0',
    state.contracts.versions.length === 1 && txt.includes('历史规则（1）') && txt.includes('旧演示记录') && txt.includes('未经规则引擎解析：不参与测试，不能恢复。')
    && txt.includes('当前生效规则（0）') && findByClass(current, 'cv-rule').length === 0 && !findButtons(findByClass(current, 'cv-history')[0]).some((b) => labelOf(b).includes('恢复')), txt.slice(0, 300));
  s = await simulate('000000', '2024-09-30');
  check('测试·空状态：没有当前规则时显示空状态，不显示命中 / 未命中', s.includes('本次没有当前生效的规则参与判定，不会产生规则提醒') && s.includes('不等于“未命中”')
    && findByClass(current, 'cv-verdict').length === 0 && findByClass(current, 'cv-sim-summary').length === 0, s.slice(0, 300));
  await clickRole('add-rule'); await saveModal();
  check('旧演示记录后新增：版本号延续为 v2（已确认），旧记录保留', stored().length === 2 && stored()[1].v === 2 && stored()[1].status === '已确认' && stored()[0].candidateId === 'RC-1', JSON.stringify(stored()).slice(0, 200));

  const dup = adapterMod.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '5' } });
  const dupRec = (v, at) => ({ schema: 'contract-v1', v, status: '已确认', template_id: dup.template_id, template_name: dup.template_name, fields: { ...dup.fields }, text: dup.text, threshold_display: dup.threshold.display, hash: dup.hash, hash_algorithm: dup.hash_algorithm, at, note: null });
  store.set('tm.contracts.demo', JSON.stringify({ versions: [dupRec(4, '2026-10-01T01:00:00Z'), dupRec(5, '2026-10-01T01:00:05Z'), dupRec(6, '2026-10-01T01:00:09Z')] }));
  await reload();
  check('早期重复记录：同一哈希的 v4/v5/v6 合并为一条当前规则（版本 v4），本地数据未删除',
    enabledHashes().join() === dup.hash && cardVisible(dup.hash).includes('版本 v4') && stored().length === 3, JSON.stringify(stored().map((r) => [r.v, r.status])));
  await clickRole('add-rule');
  await fire(byRole('template'), 'change', 'no_buy_on_surge');
  check('同一哈希不重复保存：新增弹窗选涨幅模板（默认 5%）与当前规则相同 → 提示"已存在完全相同的当前规则"，保存不可点（需勾选确认）', roleBtn('modal-save').disabled === true && modalTxt().includes('已存在完全相同的当前规则'), modalTxt().slice(-200));
  await clickRole('modal-cancel');
  await clickRole('add-rule');
  await fire(byRole('template'), 'change', 'no_buy_on_surge');
  await fire(fieldInput('threshold_pct'), 'input', '6');
  await saveModal();
  const h6 = H('no_buy_on_surge', { threshold_pct: '6' });
  check('早期重复记录后新增不同哈希：新版本 v7（已确认）成为当前，旧 5% 进入历史（superseded）',
    enabledHashes().join() === h6 && cardVisible(h6).includes('版本 v7') && histState(dup.hash) === 'replaced'
    && stored().length === 5, JSON.stringify(stored().map((r) => [r.v, r.hash === h6 ? 'h6' : 'dup'])));
  {
    const badHash = '0123456789abcdef';
    state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture', versions: [...state.contracts.versions, { ...dupRec(8, '2026-10-02T00:00:00Z'), hash: badHash }] }; mountCycle(); await settle();
    txt = texts(current).join('|');
    check('完整性：哈希不一致的启用规则不计入当前规则（只有 6% 为当前），单列”待重新确认的规则（1）”',
      txt.includes('当前生效规则（1）') && enabledHashes().join() === h6 && txt.includes('待重新确认的规则（1）') && reconfirmHashes().join() === badHash
      && cardVisible(badHash).includes('待重新确认') && cardVisible(badHash).includes('这条规则的保存内容与当前校验标识不一致。为避免误用，它暂不参与测试。')
      && !cardVisible(badHash).includes('E_CONTRACT_RULE_HASH_MISMATCH') && !cardVisible(badHash).includes(badHash), cardVisible(badHash).slice(0, 320));
    const sr = await simulate('000000', '2024-09-30');
  check('完整性：待重新确认规则不参与判定，只判当前 6%（未命中），并说明另有 1 条未参与', sameSet(simHashes(), [h6]) && verdictOf(h6) === '未命中' && !summaryOf('error')
      && sr.includes('另有 1 条规则因内容与候选哈希不一致未参与本次判定（见“待重新确认的规则”）'), sr.slice(0, 320));
    await clickIn(ruleCardOf(badHash), '停用'); await settle();
    check('完整性：停用待重新确认规则 → 进入历史（已停用，不能恢复），当前规则不变', reconfirmHashes().length === 0 && histState(badHash) === 'stopped'
      && histVisible(badHash).includes('不能恢复') && !findButtons(histOf(badHash)).some((b) => labelOf(b).includes('恢复')) && enabledHashes().join() === h6, histVisible(badHash));
  }
  store.set('tm.contracts.demo', '{broken');
  check('契约·旧记录：损坏的本地存储 → 空记录（不崩溃）', loadContractsDemo().length === 0);

  /* —— 9. 自然语言规则：识别 → 预览 → 确认才保存；修改 / 取消不生效；暂不支持 / 服务失败不影响已有功能 —— */
  store.delete('tm.contracts.demo');
  state.route = 'contract'; state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' }; mountCycle(); await settle();
  const nlTxt = () => { const m = nlPanel(); return m ? texts(m).join('|') : ''; };
  const ruleReply = (obj) => ({ status: 200, body: { rawText: JSON.stringify(obj) } });
  const surge3 = { status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct: 3, comparator: 'gt', days: null, day_unit: null }, needs: [], missing: [], understanding: '当天涨幅超过 3% 时不买入' };
  const recognize = async (text, reply) => {
    await fire(byRole('nl-text'), 'input', text);
    if (reply) siteQueue.push(reply);
    await clickRole('nl-recognize'); await settle();
  };
  const tickAck = async (checked = true) => { for (const fn of byRole('nl-ack').listeners.change ?? []) await fn({ target: { checked } }); };
  check('自然语言·入口：页头只有“新增规则”，不再有独立“用一句话描述规则”按钮', labelOf(roleBtn('add-rule')) === '新增规则' && !roleBtn('nl-rule'));
  await clickRole('add-rule');
  check('自然语言·入口：规则模板下拉包含“自定义规则（用一句话描述）”，选择前不显示识别输入框',
    findByTag(byRole('template'), 'option').some((o) => o.attrs.value === '__custom__' && texts(o).join('') === '自定义规则（用一句话描述）')
    && !byRole('nl-text') && !roleBtn('nl-recognize'));
  await fire(byRole('template'), 'change', '__custom__'); await settle();
  check('自然语言·弹窗：在同一“新增交易规则”弹窗内显示说明，模板参数 / 范围控件隐藏；只发送规则文字、不发送 CSV / 交易 / 账户信息、由程序判定；背景 inert；空文本时识别不可点',
    !!nlPanel() && findByClass(modalNode(), 'cv-nl-embedded').length === 1 && modalTxt().includes('新增交易规则')
    && !fieldInput('threshold_pct') && !byRole('note') && !byRole('scope-kind')
    && nlTxt().includes('只把下方输入框里的这段文字发送到站点服务端') && nlTxt().includes('不发送 CSV、交易记录、账户信息或已保存的规则')
    && nlTxt().includes('均由本地程序按规则模板确定性判定') && findByClass(current, 'cv-page')[0].attrs.inert === '' && roleBtn('nl-recognize').disabled === true && !roleBtn('nl-save'), nlTxt().slice(0, 300));
  const callsBefore = siteCalls.length;
  await recognize('当天涨幅超过3%的股票我不买', ruleReply(surge3));
  const ruleCall = siteCalls[siteCalls.length - 1];
  check('自然语言·出站：只向 /functions/v1/app/api/llm/rule 发送 {"text": 规则原文}（无 CSV / 交易 / 账户字段）',
    siteCalls.length === callsBefore + 1 && ruleCall.url === '/functions/v1/app/api/llm/rule' && ruleCall.options.body === JSON.stringify({ text: '当天涨幅超过3%的股票我不买' }), JSON.stringify(ruleCall));
  check('自然语言·预览：含程序生成的规则文本、提醒动作、类型、适用范围、触发条件与程序检查',
    nlTxt().includes('当前系统支持执行') && nlTxt().includes('规则预览')
    && nlTxt().includes('提醒动作：买入提醒')
    && nlTxt().includes('不能保证发现所有股票名称、附加条件或隐含限定')
    && nlTxt().includes('我已逐字对照原话核对')
    && nlTxt().includes('当天涨幅超过 3% 的票，我绝不买入。') && nlTxt().includes('规则类型：涨幅超阈值不买入')
    && nlTxt().includes('触发条件：申报买入当天，该股票涨幅超过 3.0%')
    && nlTxt().includes('模型理解（仅供核对，不参与判定）') && nlTxt().includes('程序检查（按原文判定，与模型结果无关）')
    && state.contracts.versions.length === 0 && stored().length === 0, nlTxt().slice(0, 600));
  check('自然语言·核对确认：未勾选“我已核对”前确认按钮不可用（不把模型结果直接当作可启用）',
    !!roleBtn('nl-save') && roleBtn('nl-save').disabled === true && nlTxt().includes('请先勾选核对确认') && !!byRole('nl-ack'), nlTxt().slice(-300));
  await tickAck();
  check('自然语言·勾选后：确认按钮可用，提示将生成 v1', roleBtn('nl-save').disabled === false && nlTxt().includes('确认后生成版本 v1'), nlTxt().slice(-300));
  await fire(byRole('nl-text'), 'input', '当天涨幅超过4%的股票我不买');
  check('自然语言·修改描述：旧预览作废、确认按钮消失，不写入记录', findByClass(nlPanel(), 'cv-nl-preview').length === 0 && !nlTxt().includes('当前系统支持执行') && !roleBtn('nl-save') && state.contracts.versions.length === 0, nlTxt().slice(-200));
  await recognize('当天涨幅超过3%的股票我不买', ruleReply(surge3));
  await clickRole('nl-cancel');
  check('自然语言·取消：关闭弹窗，不写入记录', !nlPanel() && state.contracts.versions.length === 0 && stored().length === 0);

  await openCustom();
  const customReply = (action) => ruleReply({ status: 'custom', kind: 'custom', template_id: null, params: {}, scope: { kind: 'all', symbol: null }, action, needs: [], missing: [], understanding: '自定义提醒' });
  await recognize('只针对 600519：买入前核对交易计划', customReply('buy'));
  check('自定义规则·范围冲突：原文限定个股但识别为全部股票时禁止保存', nlTxt().includes('两者不一致') && !roleBtn('nl-save') && state.contracts.versions.length === 0, nlTxt().slice(0, 400));
  await recognize('买入前核对自己的交易计划', customReply('buy'));
  await clickRole('nl-action-buy');
  check('自定义规则·动作确认：用户选择买入提醒', state.contracts.nl.actionChoice === 'buy');
  await fire(byRole('nl-text'), 'input', '卖出前核对自己的交易计划');
  check('自定义规则·修改描述：清除先前动作选择', state.contracts.nl.actionChoice === null && !roleBtn('nl-save'));
  siteQueue.push(customReply('sell'));
  await clickRole('nl-recognize'); await settle();
  await tickAck();
  check('自定义规则·重新识别：必须重新选择动作才能保存', state.contracts.nl.actionChoice === null
    && nlTxt().includes('识别服务建议：卖出提醒') && roleBtn('nl-save').disabled === true);
  await clickRole('nl-action-sell');
  siteQueue.push(customReply('buy'));
  await clickRole('nl-recognize'); await settle();
  check('自定义规则·再次识别相同描述：清除旧动作与核对确认', state.contracts.nl.actionChoice === null
    && roleBtn('nl-save').disabled === true && !state.contracts.nl.ack);
  await clickRole('nl-cancel');

  await openCustom();
  await recognize('如果同一只股票连续亏损两次，提醒我暂停交易一天', ruleReply({ status: 'unsupported', template_id: null, params: {}, needs: ['trade_pnl', 'pause_trading'], missing: [], understanding: '同一股票连续两次亏损后暂停交易一天' }));
  check('自然语言·暂不支持：明确说明缺少单笔盈亏判定与暂停交易能力，无确认按钮，不写入记录',
    nlTxt().includes('暂不支持') && nlTxt().includes('当前规则引擎不计算单笔已实现盈亏') && nlTxt().includes('暂停交易 / 冷却期') && nlTxt().includes('未生成规则，也不会保存或启用')
    && !roleBtn('nl-save') && state.contracts.versions.length === 0, nlTxt().slice(0, 400));
  await recognize('涨得太多的票不买', ruleReply({ status: 'unclear', template_id: 'no_buy_on_surge', params: {}, needs: [], missing: ['threshold_pct'], understanding: '' }));
  check('自然语言·表述不清：引导补充具体阈值，无确认按钮', nlTxt().includes('需要补充') && nlTxt().includes('请写明涨幅阈值的具体数字') && !roleBtn('nl-save'), nlTxt().slice(0, 300));
  await recognize('涨停的票我不追', ruleReply({ ...surge3, params: { ...surge3.params, threshold_pct: 9.9 } }));
  check('自然语言·参数不在原文：模型给出 9.9 → 需要补充，不使用推测值', nlTxt().includes('原文中没有找到阈值 9.9') && !roleBtn('nl-save'), nlTxt().slice(0, 300));
  const beforeSensitive = siteCalls.length;
  await recognize('资金账号 12345678 涨幅超过5%不买', null);
  check('自然语言·疑似账户信息：本地拦截，不发送请求', siteCalls.length === beforeSensitive && nlTxt().includes('疑似账号') && !roleBtn('nl-save'), nlTxt().slice(0, 300));
  await recognize('当天涨幅超过3%的股票我不买', { status: 503, body: { ok: false, code: 'E_MODEL_NOT_CONFIGURED', message: '模型未启用' } });
  check('自然语言·服务失败：提示原因（DEEPSEEK_API_KEY 未配置）与已有功能不受影响，无确认按钮',
    nlTxt().includes('识别未完成') && nlTxt().includes('DEEPSEEK_API_KEY') && nlTxt().includes('已有规则、模板新增与历史情境测试不受影响') && !roleBtn('nl-save'), nlTxt().slice(0, 300));
  await recognize('当天涨幅超过3%的股票我不买', { status: 404, body: {} });
  check('自然语言·函数未发布：HTTP 404 → 说明原因', nlTxt().includes('HTTP 404') && !roleBtn('nl-save'), nlTxt().slice(0, 300));

  const surge5 = { ...surge3, params: { ...surge3.params, threshold_pct: 5 } };
  await recognize('当天涨幅超过5%并且成交量放大的股票不买', ruleReply(surge5));
  check('自然语言·多条件（模型误判为模板）：程序检查判暂不支持，说明不会只截取那部分启用，无确认按钮',
    nlTxt().includes('暂不支持') && nlTxt().includes('成交量') && nlTxt().includes('不会只截取那部分启用') && nlTxt().includes('你的原话：「当天涨幅超过5%并且成交量放大的股票不买」')
    && !roleBtn('nl-save') && !roleBtn('nl-to-template') && state.contracts.versions.length === 0, nlTxt().slice(0, 400));
  await recognize('当天涨幅超过5%并且是我持有过的股票不买', ruleReply(surge5));
  check('自然语言·连接词“并且”：暂不支持多个条件组合，并说明原因', nlTxt().includes('多个条件组合') && nlTxt().includes('原文含有连接词“并且”') && !roleBtn('nl-save'), nlTxt().slice(0, 400));
  await recognize('600519 当天涨幅超过5%我不买', ruleReply(surge5));
  check('自然语言·限定代码但识别结果未返回适用范围（旧版站点函数）：需要补充，不当成全部股票，无确认按钮',
    nlTxt().includes('需要补充') && nlTxt().includes('没有按“单个 6 位股票代码”返回适用范围') && !roleBtn('nl-save'), nlTxt().slice(0, 400));
  await recognize('当天涨幅超过5%不买，卖出后3个交易日内不买回', ruleReply(surge5));
  check('自然语言·一句话两条规则：暂不支持，提示分别识别、分别保存', nlTxt().includes('多个数值') && nlTxt().includes('分别识别、分别保存') && !roleBtn('nl-save'), nlTxt().slice(0, 400));

  const buyback3 = { status: 'template', template_id: 'no_buy_back_within', params: { threshold_pct: null, comparator: null, days: 3, day_unit: 'trading_day' }, needs: [], missing: [], understanding: '卖出后 3 个交易日内不买回' };
  await recognize('卖出后3天内不买回同一只股票', ruleReply(buyback3));
  check('自然语言·只写“天”（模型声称交易日）：显示“待你确认”与交易日 / 自然日选项；未选择时即使勾选核对也不能保存',
    nlTxt().includes('待你确认') && nlTxt().includes('没有说明是交易日还是自然日') && !!roleBtn('nl-choice-day_unit-trading_day') && !!roleBtn('nl-choice-day_unit-calendar_day')
    && nlTxt().includes('未选择前不能保存') && roleBtn('nl-save').disabled === true, nlTxt().slice(0, 500));
  await tickAck();
  check('自然语言·只写“天”：勾选核对后仍不可保存（待确认项未选）', roleBtn('nl-save').disabled === true && nlTxt().includes('还有待确认的理解'), nlTxt().slice(-300));
  await clickRole('nl-choice-day_unit-calendar_day');
  check('自然语言·选择“自然日”：提示暂不支持，仍不能保存', nlTxt().includes('暂不支持：按自然日、周或月计的窗口：当前窗口都按交易日计算') && roleBtn('nl-save').disabled === true && nlTxt().includes('你选择的理解当前系统不支持'), nlTxt().slice(-400));
  await clickRole('nl-choice-day_unit-trading_day');
  check('自然语言·选择“交易日”+ 已勾选核对：才可保存', roleBtn('nl-save').disabled === false && nlTxt().includes('确认后生成版本 v1'), nlTxt().slice(-300));
  await fire(byRole('nl-text'), 'input', '卖出后3天内不买回同一只股票。');
  check('自然语言·修改描述：已选的理解与核对一并作废', !roleBtn('nl-save') && state.contracts.nl.ack === false && Object.keys(state.contracts.nl.choices).length === 0);
  await recognize('卖出后3天内不买回同一只股票', ruleReply(buyback3));
  await clickRole('nl-choice-day_unit-trading_day'); await tickAck();
  await clickRole('nl-save'); await settle();
  check('自然语言·“天”确认后保存：生成 3 个交易日规则（与模板同哈希），记录保存原话与所选理解',
    sameSet(enabledHashes(), [hB3]) && stored().length === 1 && stored()[0].origin?.confirmations?.day_unit === 'trading_day' && stored()[0].origin.text === '卖出后3天内不买回同一只股票', JSON.stringify(stored()).slice(0, 300));
  store.delete('tm.contracts.demo');
  state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' }; mountCycle(); await settle();
  await openCustom();

  await clickRole('modal-close');
  await clickRole('add-rule');
  check('自然语言·服务失败后：模板新增弹窗照常可用', !!modalNode() && findByTag(byRole('template'), 'option').length === 4 && !!roleBtn('modal-save'));
  await clickRole('modal-cancel');

  await openCustom();
  await recognize('当天涨幅超过3%的股票我不买', ruleReply(surge3));
  await tickAck();
  await clickRole('nl-save'); await settle();
  check('自然语言·确认保存：弹窗关闭，生成 v1 当前规则（与模板 3% 同哈希），记录保留自然语言原文且不影响哈希',
    !nlPanel() && sameSet(enabledHashes(), [hS3]) && stored().length === 1 && stored()[0].hash === hS3 && stored()[0].v === 1 && stored()[0].status === '已确认'
    && stored()[0].origin?.kind === 'natural_language' && stored()[0].origin.text === '当天涨幅超过3%的股票我不买', JSON.stringify(stored()).slice(0, 300));
  s = await simulate('000000', '2024-09-30');
  check('自然语言·参与测试：已启用规则进入历史情境测试，000000 2024-09-30 → 命中（引擎判定）',
    simHashes().join() === hS3 && verdictOf(hS3) === '命中' && ruleTxt(hS3).includes('规则：当天涨幅超过 3% 的票，我绝不买入。'), s.slice(0, 300));

  await openCustom();
  await recognize('卖出后三个交易日内不买回同一只股票', ruleReply({ status: 'template', template_id: 'no_buy_back_within', params: { threshold_pct: null, comparator: null, days: 3, day_unit: 'trading_day' }, needs: [], missing: [], understanding: '卖出后 3 个交易日内不买回' }));
  check('自然语言·不追回：识别为”卖出后 N 个交易日内不追回”，显示提醒动作与触发条件', nlTxt().includes('规则类型：卖出后 N 个交易日内不追回') && nlTxt().includes('提醒动作：买入提醒') && nlTxt().includes('触发条件'), nlTxt().slice(0, 300));
  await clickRole('nl-to-template');
  check('自然语言·在模板中调整：转入新增弹窗并预填模板与参数，未保存', !nlPanel() && !!modalNode() && fieldInput('days')?.value === '3' && liveTxt().includes('卖出后 3 个交易日内不追回同一只票。') && stored().length === 1, liveTxt().slice(0, 200));
  await clickRole('modal-cancel');
  check('自然语言·在模板中调整后取消：不写入记录', stored().length === 1 && sameSet(enabledHashes(), [hS3]));
  store.delete('tm.contracts.demo');
}

{
  const A = await imp('src/demo/adapter.js');
  store.delete('tm.contracts.demo'); state.route = 'contract'; state.bill = defaultBill();
  state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' }; mountCycle(); await settle();
  const original = A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' } });
  const updated = A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' }, scope: { kind: 'symbol', symbol: '600519' } });
  await clickRole('add-rule'); await fire(byRole('template'), 'change', 'no_buy_on_surge'); await settle();
  await fire(fieldInput('threshold_pct'), 'input', '3'); await saveModal();
  await clickIn(ruleCardOf(original.hash), '编辑');
  await fire(byRole('scope-kind'), 'change', 'symbol'); await settle();
  await fire(byRole('scope-symbol-input'), 'input', '600519');
  check('编辑范围：保存前必须确认原范围将进入历史', roleBtn('modal-save').disabled && !!byRole('edit-scope-ack'));
  await checkbox('edit-scope-ack'); await saveModal();
  check('编辑范围：只保留新范围，旧版本进入历史', sameSet(enabledHashes(), [updated.hash]) && histState(original.hash) === 'replaced');
  await clickIn(histOf(original.hash), '恢复为当前规则'); await settle();
  check('跨范围恢复：先显示变化说明，不立即替换', enabledHashes().includes(updated.hash) && histVisible(original.hash).includes('确认恢复') && histVisible(original.hash).includes('全部股票'));
  await clickIn(histOf(original.hash), '确认恢复'); await settle();
  check('跨范围恢复：确认后原范围生效，新范围进入历史', sameSet(enabledHashes(), [original.hash]) && histState(updated.hash) === 'replaced');
  const text = '买入前检查交易计划';
  const customHash = A.CONTRACT_CUSTOM_HASH({ schema: 'custom-v1', kind: 'custom', text, action: 'buy', scope: { kind: 'all' } });
  state.contracts.versions.push(...A.contractSaveCustomRecords(state.contracts.versions, { rule_id: 'custom-edit-test', text, action: 'buy', scope: { kind: 'all' }, understanding: '核对计划', hash: customHash }));
  mountCycle(); await settle();
  await clickIn(ruleCardOf(customHash), '编辑');
  check('自定义规则编辑：加载原文、动作和 AI 理解', byRole('nl-text')?.value === text && state.contracts.nl.actionChoice === 'buy' && texts(nlPanel()).join('|').includes('核对计划'));
  await fire(byRole('nl-text'), 'input', '卖出前检查交易计划');
  siteQueue.push({ status: 200, body: { rawText: JSON.stringify({ status: 'custom', kind: 'custom', template_id: null, params: {}, scope: { kind: 'all', symbol: null }, action: 'sell', needs: [], missing: [], understanding: '卖出核对计划' }) } });
  await clickRole('nl-recognize'); await settle(); await clickRole('nl-action-sell'); await checkbox('nl-ack'); await clickRole('nl-save'); await settle();
  const edited = A.contractRuleSet(state.contracts.versions).customCurrent.find((r) => r.rule_id === 'custom-edit-test');
  check('自定义规则编辑：保留身份，更新内容并保留历史', edited?.text === '卖出前检查交易计划' && edited?.action === 'sell' && A.contractRuleSet(state.contracts.versions).history.some((r) => r.rule_id === 'custom-edit-test' && r.hash === customHash));
  store.delete('tm.contracts.demo'); state.contracts = defaultContracts();
}

{
  const A = await imp('src/demo/adapter.js');
  const s3 = A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' } });
  const scoped = A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' }, scope: { kind: 'symbol', symbol: '000000' } });
  store.delete('tm.contracts.demo');
  state.route = 'contract'; state.bill = defaultBill();
  state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' };
  mountCycle(); await settle();
  check('能力库：页面说明多规则共存，对话页读取规则状态但不支持限定代码，非交易日来源口径待统一',
    texts(current).join('|').includes('不同类型或不同股票范围的规则可以同时生效')
    && texts(current).join('|').includes('对话页会读取已生效规则来回答规则状态')
    && texts(current).join('|').includes('非交易日处理沿用各来源原有口径（待统一）'));
  await clickRole('add-rule'); await fire(fieldInput('threshold_pct'), 'input', '3'); await saveModal();
  const first = JSON.stringify(stored()[0]);
  check('能力库：全部股票仍按 v1 保存，不增加范围字段，原哈希不变', stored()[0].schema === 'contract-v1' && !('scope' in stored()[0]) && stored()[0].hash === s3.hash);
  await clickRole('add-rule');
  await fire(byRole('template'), 'change', 'no_buy_on_surge'); await settle();
  await fire(fieldInput('threshold_pct'), 'input', '3');
  {
    const opts = findByTag(byRole('scope-kind'), 'option');
    const sel = opts.find((o) => o.attrs.selected === 'selected');
    check('能力库·模板：新增弹窗中适用范围为下拉框，选项为”全部股票 / 单个股票”，默认全部股票',
      byRole('scope-kind').tagName === 'SELECT' && opts.map((o) => texts(o).join('')).join('/') === '全部股票/单个股票'
      && sel?.attrs.value === 'all' && !byRole('scope-symbol-input'));
  }
  await fire(byRole('scope-kind'), 'change', 'symbol'); await settle();
  check('能力库·模板：选择”单个股票”后出现代码输入框', !!byRole('scope-symbol-input'));
  await fire(byRole('scope-symbol-input'), 'input', '00000');
  check('能力库·模板：不足 6 位代码时不能保存，不补前导零', roleBtn('modal-save').disabled && liveTxt().includes('股票代码须为 6 位数字'));
  await fire(byRole('scope-symbol-input'), 'input', '000000');
  await fire(byRole('scope-kind'), 'change', 'all'); await settle();
  check('能力库·模板：切回”全部股票”后代码输入框消失，预览恢复全部股票', !byRole('scope-symbol-input') && liveTxt().includes('适用范围：全部股票'));
  await fire(byRole('scope-kind'), 'change', 'symbol'); await settle();
  check('能力库·模板：再次选择”单个股票”保留刚输入的代码', byRole('scope-symbol-input').value === '000000');
  check('能力库·模板：个股范围预览显示”仅 000000”，保存按钮可用（多规则共存，无需额外确认）',
    liveTxt().includes('仅 000000') && roleBtn('modal-save').disabled === false);
  await saveModal();
  const actualScopedHash = stored()[1].hash;
  check('能力库·共存：保存后 scoped v2 与 v1 并行共存（不同哈希），记录数 = 2',
    stored().length === 2 && stored()[1].schema === 'contract-v2' && stored()[1].scope.symbol === '000000'
    && stored()[0].schema === 'contract-v1', JSON.stringify(stored().map((r) => ({ v: r.v, schema: r.schema, hash: r.hash?.slice(0, 8) }))).slice(0, 300));
  check('能力库·共存：两条规则均为当前（不同哈希）',
    sameSet(enabledHashes(), [s3.hash, actualScopedHash]), JSON.stringify({ enabled: enabledHashes(), s3: s3.hash?.slice(0, 8), scoped: actualScopedHash?.slice(0, 8) }));
  check('能力库·共存显示：全部股票与单个股票规则均显示在同模板下',
    sameSet(slotHashes('no_buy_on_surge'), [s3.hash, actualScopedHash])
    && texts(slotNode('no_buy_on_surge')).join('|').includes('适用范围：全部股票')
    && texts(slotNode('no_buy_on_surge')).join('|').includes('适用范围：仅 000000'), JSON.stringify({ cards: slotHashes('no_buy_on_surge'), enabled: enabledHashes(), slots: findByClass(current, 'cv-slot').map(n => [n.attrs['data-template'], n.attrs['data-action'], findByClass(n, 'cv-rule').map(x => x.attrs['data-hash'])]) }));
  await simulate('888888', '2024-10-10');
  check('能力库·不适用：scoped 规则对 888888 不进入结果列表（只计入“不适用 1 条”汇总），v1 规则正常判定',
    !simHashes().includes(actualScopedHash) && simHashes().join() === s3.hash && summaryOf('not_applicable') === '不适用 1 条');
  await simulate('000000', '2024-10-05');
  check('能力库·B3：scoped v2 对 000000 正常判定，页面同时展示申报日和实际使用的交易日',
    ruleTxt(actualScopedHash).includes('申报日 2024-10-05 → 实际使用交易日 2024-09-30') && ruleTxt(actualScopedHash).includes('收盘数据'));
  await reload();
  check('能力库·刷新：v1/v2 均为当前（多规则共存），记录数不变', sameSet(enabledHashes(), [s3.hash, actualScopedHash]) && stored().length === 2);
  check('能力库·刷新显示：两个不同范围的规则仍可见', sameSet(slotHashes('no_buy_on_surge'), [s3.hash, actualScopedHash]), JSON.stringify({ cards: slotHashes('no_buy_on_surge'), enabled: enabledHashes() }));
  await disableRule(s3.hash);
  check('能力库·停用 v1：v2 不受影响（多规则共存），历史只有 v1',
    !enabledHashes().includes(s3.hash) && enabledHashes().includes(actualScopedHash) && histState(s3.hash) === 'stopped' && stored().length === 3);
  await clickIn(histOf(s3.hash), '恢复为当前规则'); await settle();
  check('能力库·恢复 v1：回到当前，v2 不受影响',
    sameSet(enabledHashes(), [s3.hash, actualScopedHash]) && stored().at(-1).via === '恢复' && stored().at(-1).v === 1);
  await openCustom();
  const reply = (obj) => ({ status: 200, body: { rawText: JSON.stringify(obj) } });
  const intent = { status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct: 3, comparator: 'gt' }, scope: { kind: 'symbol', symbol: '000000' }, needs: [], missing: [], understanding: 'x' };
  const recognize = async (text, data) => { await fire(byRole('nl-text'), 'input', text); siteQueue.push(reply(data)); await clickRole('nl-recognize'); await settle(); };
  await recognize('只针对 000000：当天涨幅超过3%不买', intent);
  check('能力库·自然语言：预览写明适用代码与提醒动作，不自动生效', modalTxt().includes('适用范围：仅 000000')
    && modalTxt().includes('提醒动作：买入提醒') && roleBtn('nl-save').disabled);
  await checkbox('nl-ack');
  check('能力库·自然语言：重复规则需要额外确认', roleBtn('nl-save').disabled === true && !!byRole('nl-dup-ack'));
  await checkbox('nl-dup-ack');
  const beforeNl = stored().length;
  await clickRole('nl-save'); await settle();
  check('能力库·自然语言：保存后新增同哈希 scoped 规则（同 hash 合并版本），记录数 +1', stored().length === beforeNl + 1);
  await openCustom(); await recognize('只针对 000000：当天涨幅超过3%不买', intent); await clickRole('nl-to-template');
  check('能力库·转模板：保留识别出的代码和参数，不把个股规则变为全市场', byRole('scope-symbol-input').value === '000000'
    && fieldInput('threshold_pct').value === '3' && liveTxt().includes('适用范围：仅 000000'));
  await clickRole('modal-cancel'); await openCustom();
  await recognize('茅台当天涨幅超过3%不买', { ...intent, scope: { kind: 'all' } });
  check('能力库·名称盲区：模型误判为全市场也要求补充，不生成保存按钮', modalTxt().includes('需要补充') && modalTxt().includes('茅台') && !roleBtn('nl-save'));
  await recognize('当天涨幅超过3%不买，要等回调', { ...intent, scope: { kind: 'all' } });
  check('能力库·附加内容：无法表达时要求补充，不静默截取规则后启用', modalTxt().includes('不会忽略这部分后启用') && !roleBtn('nl-save'));
  await recognize('只针对 600519、300750：当天涨幅超过3%不买', { ...intent, scope: { kind: 'symbol', symbol: '600519' } });
  check('能力库·多代码：暂不支持，不截取第一个代码后启用', modalTxt().includes('每条规则只能限定一个 6 位代码') && !roleBtn('nl-save'));
  await clickRole('nl-cancel');
  store.delete('tm.contracts.demo'); state.contracts = defaultContracts();
}

/* ==== 买入后 N 个交易日内卖出提醒：模板创建 / 假如卖出 / 动作隔离（合成行情）==== */
{
  const A = await imp('src/demo/adapter.js');
  const hBS3 = A.previewContract({ template_id: 'sell_within_after_buy', fields: { days: '3' } }).hash;
  const hSurge3 = A.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' } }).hash;
  const setAction = async (action) => {
    const b = roleBtn(`sim-action-${action}`);
    if (!b) throw new Error('找不到情境动作：' + action);
    for (const fn of b.listeners.click ?? []) await fn({});
    await settle();
  };
  const simulateSell = async (symbol, date) => {
    await setAction('sell');
    await fire(byRole('sim-symbol'), 'change', symbol);
    await fire(byRole('sim-date'), 'input', date);
    await clickLabel('测试该日卖出是否触发规则'); await settle();
    return simTxt();
  };

  store.delete('tm.contracts.demo');
  state.route = 'contract'; state.bill = defaultBill();
  state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' };
  mountCycle(); await settle();
  await clickIn(slotNode('sell_within_after_buy'), '新增规则');
  check('买入后卖出·模板入口：默认窗口 3 个交易日，预览写明申报卖出、历史复盘、同日买入不计与只提醒',
    fieldInput('days').value === '3' && liveTxt().includes('买入后 3 个交易日内卖出同一只票时，提醒我。')
    && liveTxt().includes('申报卖出时') && liveTxt().includes('同日买入不计') && liveTxt().includes('提醒：申报卖出时'));
  await saveModal();
  check('买入后卖出·保存：成为当前规则（v1），卡片写明触发条件，记录为 contract-v1',
    sameSet(enabledHashes(), [hBS3]) && !cardVisible(hBS3).includes('买入后 N 个交易日内卖出提醒')
    && cardVisible(hBS3).includes('触发条件：买入后 3 个交易日内卖出同一标的（不含买入当天，同日买入不计）')
    && stored().length === 1 && stored()[0].schema === 'contract-v1' && stored()[0].template_id === 'sell_within_after_buy');
  check('买入后卖出·默认情境：有“假如买入 / 假如卖出”选择，默认假如买入，并说明规则动作',
    !!roleBtn('sim-action-buy') && !!roleBtn('sim-action-sell') && String(roleBtn('sim-action-buy').attrs.class).includes('active')
    && texts(current).join('|').includes('买入提醒类规则只在“假如买入”情境判定，卖出提醒类规则只在“假如卖出”情境判定'), texts(current).join('|').slice(-400));

  let sbs = await simulate('000000', '2024-10-09');
  check('买入后卖出·假如买入：卖出提醒规则不进入结果列表（只计入“不适用 1 条”），不计命中 / 未命中',
    !simHashes().includes(hBS3) && simHashes().length === 0 && summaryOf('not_applicable') === '不适用 1 条' && !summaryOf('triggered')
    && sbs.includes('假如买入'), sbs.slice(0, 400));

  sbs = await simulateSell('000000', '2024-09-24');
  check('买入后卖出·仅有同日买入：显示“无法确认 / 数据不足”，说明同日顺序未知与可能有未导出交易，不显示未命中',
    verdictOf(hBS3) === '无法确认' && ruleTxt(hBS3).includes('E_SAME_DAY_BUY_UNCONFIRMED') && ruleTxt(hBS3).includes('同日买入 1 笔')
    && ruleTxt(hBS3).includes('先后顺序未知') && ruleTxt(hBS3).includes('可能存在未导出的更早或窗口内买入')
    && !ruleTxt(hBS3).includes('规则提醒') && summaryOf('missing_data') === '数据不足 1 条', ruleTxt(hBS3).slice(0, 600));

  sbs = await simulateSell('000000', '2024-10-09');
  const sellPage = texts(current).join('|');
  check('买入后卖出·假如卖出：T003（2024-09-27 买入）后第 3 个交易日 → 命中，展示最近买入、交易日距离与“基于当前导入记录”',
    verdictOf(hBS3) === '命中' && ruleTxt(hBS3).includes('最近买入：T003 · 2024-09-27') && ruleTxt(hBS3).includes('距最近买入：3 个交易日')
    && ruleTxt(hBS3).includes('结果依据：当前导入账单中的可见买入记录') && ruleTxt(hBS3).includes('基于当前账单里的可见买入记录')
    && ruleTxt(hBS3).includes('账单完整性：未确认')
    && ruleTxt(hBS3).includes('规则提醒') && sbs.includes('情境：卖出') && sellPage.includes('买入记录来源')
    && sellPage.includes('T003 000000 2024-09-27'), sellPage.slice(-500));
  check('买入后卖出·来源说明：只读取同一标的的买入记录；按钮与标题随情境变为“卖出”',
    sourceLine().includes('买入后卖出提醒只读取同一标的的买入记录')
    && !!btnOf('测试该日卖出是否触发规则') && sbs.includes('000000 · 申报日 2024-10-09 · 假如卖出'), sourceLine() + ' || ' + sbs.slice(0, 240));

  await fire(byRole('sim-symbol'), 'change', '000000');
  await fire(byRole('sim-date'), 'input', '2024-10-10');
  await clickLabel('测试该日卖出是否触发规则'); await settle();
  check('买入后卖出·第 N+1 天：显示“无法确认 / 数据不足”，说明最近可见买入已超窗且可能存在未导出交易，不显示未命中',
    verdictOf(hBS3) === '无法确认' && ruleTxt(hBS3).includes('E_BUY_OUTSIDE_WINDOW_UNCONFIRMED')
    && ruleTxt(hBS3).includes('距最近买入：4 个交易日') && ruleTxt(hBS3).includes('已超出买入后 3 个交易日窗口')
    && ruleTxt(hBS3).includes('可能存在未导出的窗口内买入') && ruleTxt(hBS3).includes('账单完整性：未确认')
    && !ruleTxt(hBS3).includes('规则提醒'), ruleTxt(hBS3).slice(0, 600));

  sbs = await simulateSell('888888', '2024-10-01');
  check('买入后卖出·申报日不在交易日历：数据不足并说明原因，不编造“未触发”',
    verdictOf(hBS3) === '数据不足' && ruleTxt(hBS3).includes('E_DATE_NOT_IN_CALENDAR') && !ruleTxt(hBS3).includes('规则提醒') && !sbs.includes('未命中 1 条'), ruleTxt(hBS3).slice(0, 300));

  await clickRole('add-rule');
  await fire(fieldInput('threshold_pct'), 'input', '3'); await saveModal();
  check('买入后卖出·混合规则：涨幅 3% 与买入后卖出同时为当前规则，分属申报买入 / 申报卖出动作',
    sameSet(enabledHashes(), [hBS3, hSurge3]) && stored().length === 2 && stored()[1].template_id === 'no_buy_on_surge');
  sbs = await simulateSell('000000', '2024-09-30');
  check('买入后卖出·动作隔离：假如卖出时涨幅规则不进入结果列表（只计“不适用 1 条”），买入后卖出规则正常命中（T003 后第 1 个交易日）',
    !simHashes().includes(hSurge3) && simHashes().join() === hBS3 && verdictOf(hBS3) === '命中' && ruleTxt(hBS3).includes('距最近买入：1 个交易日')
    && summaryOf('not_applicable') === '不适用 1 条', ruleTxt(hBS3).slice(0, 300));
  await setAction('buy');
  sbs = await simulate('000000', '2024-09-30');
  check('买入后卖出·反向隔离：假如买入时涨幅规则正常判定，买入后卖出规则不进入结果列表（只计“不适用 1 条”）',
    verdictOf(hSurge3) === '命中' && !simHashes().includes(hBS3) && summaryOf('not_applicable') === '不适用 1 条' && sbs.includes('情境：买入'), sbs.slice(0, 300));

  const hBS2 = A.previewContract({ template_id: 'sell_within_after_buy', fields: { days: '2' } }).hash;
  const nlSellText = '买入后 2 个交易日内卖出这只股票时提醒我';
  await openCustom();
  await fire(byRole('nl-text'), 'input', nlSellText);
  siteQueue.push({ status: 200, body: { protocol: 'rule-intent-v2', rawText: JSON.stringify({
    status: 'template', template_id: 'sell_within_after_buy',
    params: { threshold_pct: null, comparator: null, days: 2, day_unit: 'trading_day' },
    scope: { kind: 'all', symbol: null }, needs: [], missing: [], understanding: '买入后2个交易日内卖出同一只股票时提醒',
  }) } });
  await clickRole('nl-recognize'); await settle();
  check('买入后卖出·自然语言：预览写明提醒动作、2 个交易日与同日不计，确认前不写入记录',
    modalTxt().includes('规则类型：买入后 N 个交易日内卖出提醒') && modalTxt().includes('买入后 2 个交易日')
    && modalTxt().includes('提醒动作：卖出提醒') && modalTxt().includes('同日买入不计')
    && roleBtn('nl-save').disabled === true && stored().length === 2, modalTxt().slice(0, 500));
  for (const fn of byRole('nl-ack').listeners.change ?? []) await fn({ target: { checked: true } });
  await clickRole('nl-save'); await settle();
  check('买入后卖出·自然语言确认后保存：生成新版本 v3，旧版本 v1 进入历史（替代），保留原话与所选理解',
    enabledHashes().includes(hBS2) && !enabledHashes().includes(hBS3) && stored().length === 4
    && stored()[3].v === 3 && stored()[3].status === '已确认'
    && stored()[3].origin?.text === nlSellText
    && stored()[2].via === '替代' && stored()[2].hash === hBS3,
    JSON.stringify(stored().slice(1)).slice(0, 400));
  sbs = await simulateSell('000000', '2024-10-09');
  check('买入后卖出·自然语言规则参与判定：T003 后第 3 个交易日超出 2 日窗口 → 无法确认（不显示未命中，不用原话或模型理解判定）',
    verdictOf(hBS2) === '无法确认' && ruleTxt(hBS2).includes('E_BUY_OUTSIDE_WINDOW_UNCONFIRMED')
    && ruleTxt(hBS2).includes('距最近买入：3 个交易日') && ruleTxt(hBS2).includes('已超出买入后 2 个交易日窗口')
    && ruleTxt(hBS2).includes('可能存在未导出的窗口内买入'), ruleTxt(hBS2).slice(0, 500));

  store.delete('tm.contracts.demo'); state.contracts = defaultContracts(); state.bill = defaultBill();
}

/* ==== 自定义规则参与情境测试：逐条辅助判定（隐私、失败回退、旧结果不覆盖新测试）==== */
{
  const ruleReply = (obj) => ({ status: 200, body: { rawText: JSON.stringify(obj) } });
  const tickAck = async (checked = true) => { for (const fn of byRole('nl-ack').listeners.change ?? []) await fn({ target: { checked } }); };
  const judgeReply = (obj) => ({ status: 200, body: { rawText: JSON.stringify(obj) } });
  // 判定回包钩子：模拟站点服务端为模型回包附加 binding（真实链路在服务端完成；siteQueue 用于失败/丢弃类回包）。
  const bindOf = (req) => ({
    flow_id: req.flow_id, request_id: req.request_id, judgment_id: req.judgment_id,
    rule_id: req.rule.rule_id ?? null, rule_hash: req.rule.hash, rule_version: req.rule.version,
    rule_action: req.rule.action, scenario_symbol: req.scenario.symbol,
    scenario_requested_date: req.scenario.requested_date, scenario_action: req.scenario.action,
  });
  let judgePlan = null;
  siteResponseHook = (url, options) => {
    if (!judgePlan || !String(url).endsWith('/api/llm/custom-rule-judgment')) return null;
    const req = JSON.parse(String(options.body));
    const reply = judgePlan(req);
    return reply ? siteHttpResponse({ body: { rawText: JSON.stringify({ ...reply, binding: bindOf(req) }) } }) : null;
  };
  const runSim = async (symbol, date) => {
    await fire(byRole('sim-symbol'), 'change', symbol);
    await fire(byRole('sim-date'), 'input', date);
    const btn = btnOf('测试该日买入是否触发规则') ?? btnOf('测试该日卖出是否触发规则');
    for (const fn of btn.listeners.click ?? []) await fn({});
    await settle();
    return simTxt();
  };
  const saveCustom = async (text, action, symbol = null) => {
    await openCustom();
    await fire(byRole('nl-text'), 'input', text);
    siteQueue.push(ruleReply({ status: 'custom', kind: 'custom', template_id: null, params: {}, scope: symbol ? { kind: 'symbol', symbol } : { kind: 'all', symbol: null }, action, needs: [], missing: [], understanding: '判定用自定义规则' }));
    await clickRole('nl-recognize'); await settle();
    await clickRole(`nl-action-${action}`); await tickAck();
    await clickRole('nl-save'); await settle();
  };
  const setSimAction = async (action) => {
    const b = roleBtn(`sim-action-${action}`);
    for (const fn of b.listeners.click ?? []) await fn({});
    await settle();
  };

  store.delete('tm.contracts.demo');
  state.route = 'contract'; state.bill = defaultBill();
  state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' };
  mountCycle(); await settle();
  await saveCustom('买入前核对自己的交易计划', 'buy');
  const hCustom = enabledHashes()[0];
  check('自定义规则·准备：保存为当前规则（买入提醒，全部股票）', !!hCustom && stored().length === 1 && stored()[0].schema === 'custom-v1', JSON.stringify(enabledHashes()));
  await clickRole('add-rule');
  await fire(fieldInput('threshold_pct'), 'input', '3'); await saveModal();
  const hSurge = enabledHashes().find((h) => h !== hCustom);

  const beforeCalls = siteCalls.length;
  judgePlan = () => ({ verdict: 'triggered', reason: '按规则原文，该情境需要先核对交易计划。', used_data: ['change_pct'] });
  const st1 = await runSim('000000', '2024-09-30');
  const call1 = siteCalls[beforeCalls];
  const body1 = call1 ? JSON.parse(call1.options.body) : null;
  check('自定义规则·判定请求：发往独立路由 custom-rule-judgment，只含规则身份与最小数据（无价格/金额/完整交易明细）',
    !!call1 && call1.url === '/functions/v1/app/api/llm/custom-rule-judgment'
    && Object.keys(body1).sort().join() === 'data,flow_id,judgment_id,request_id,rule,scenario,stage'
    && body1.stage === 'custom_rule_judgment'
    && body1.rule.text === '买入前核对自己的交易计划' && body1.rule.action === 'buy' && body1.rule.schema === 'custom-v1'
    && body1.scenario.symbol === '000000' && body1.scenario.requested_date === '2024-09-30' && body1.scenario.action === 'buy'
    && Array.isArray(body1.data.buys) && Array.isArray(body1.data.sells) && Array.isArray(body1.data.trading_days)
    && body1.data.buys.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) && body1.data.buys.length + body1.data.sells.length > 0
    && !call1.options.body.includes('"price"') && !call1.options.body.includes('amount') && !call1.options.body.includes('trade_id'),
    JSON.stringify(body1));
  check('自定义规则·命中：与模板命中并存、逐条显示判断依据与使用的数据，不标注“AI 辅助分析”，并写明发送内容',
    verdictOf(hCustom) === '命中' && verdictOf(hSurge) === '命中' && summaryOf('triggered') === '命中 2 条'
    && ruleTxt(hCustom).includes('判断依据：按规则原文，该情境需要先核对交易计划。')
    && ruleTxt(hCustom).includes('使用的数据：当日涨跌幅')
    && !ruleTxt(hCustom).includes('AI 辅助分析')
    && ruleTxt(hCustom).includes('不发送原始账单、CSV 文件、价格金额')
    && ruleTxt(hCustom).includes('只用于复盘对照，不下单、不阻止交易'), ruleTxt(hCustom).slice(0, 500));

  judgePlan = () => ({ verdict: 'not_triggered', reason: '规则条件与给定数据不符。', used_data: [] });
  await runSim('000000', '2024-09-30');
  check('自定义规则·未命中：仅在判定明确时显示，模板命中不受影响', verdictOf(hCustom) === '未命中' && verdictOf(hSurge) === '命中'
    && summaryOf('not_triggered') === '未命中 1 条' && ruleTxt(hCustom).includes('判断依据：规则条件与给定数据不符。'), ruleTxt(hCustom).slice(0, 400));

  judgePlan = () => ({ verdict: 'unable', reason: '规则需要持仓数据，本次未提供。', used_data: [] });
  const stU = await runSim('000000', '2024-09-30');
  check('自定义规则·判定无法确认：显示“无法判断”（不当作未命中）', verdictOf(hCustom) === '无法判断'
    && ruleTxt(hCustom).includes('规则需要持仓数据，本次未提供。') && ruleTxt(hCustom).includes('本次不显示“未命中”')
    && summaryOf('unable') === '无法判断 1 条' && !stU.includes('未命中 1 条'), ruleTxt(hCustom).slice(0, 400));

  judgePlan = null;
  siteQueue.push({ status: 503, body: { ok: false, code: 'E_MODEL_NOT_CONFIGURED', message: '模型未启用：服务端尚未配置 DEEPSEEK_API_KEY' } });
  await runSim('000000', '2024-09-30');
  check('自定义规则·服务失败：显示“无法判断”与原因码，规则结果不作命中判定', verdictOf(hCustom) === '无法判断'
    && ruleTxt(hCustom).includes('E_MODEL_NOT_CONFIGURED') && ruleTxt(hCustom).includes('模型未启用'), ruleTxt(hCustom).slice(0, 400));

  judgePlan = null;
  siteQueue.push({ status: 200, body: { rawText: 'not-json' } });
  await runSim('000000', '2024-09-30');
  check('自定义规则·响应无效：显示“无法判断”，不当作未命中', verdictOf(hCustom) === '无法判断'
    && ruleTxt(hCustom).includes('E_CUSTOM_RULE_JUDGMENT_RESPONSE_INVALID'), ruleTxt(hCustom).slice(0, 400));

  judgePlan = null;
  siteQueue.push(judgeReply({ verdict: 'triggered', reason: '过期运行的结果。', used_data: [], binding: { flow_id: 'custom-run-other', request_id: 'x', judgment_id: 'y', rule_id: null, rule_hash: hCustom, rule_version: 1, rule_action: 'buy', scenario_symbol: '000000', scenario_requested_date: '2024-09-30', scenario_action: 'buy' } }));
  await runSim('000000', '2024-09-30');
  check('自定义规则·绑定不一致：旧请求结果被丢弃，显示“无法判断”', verdictOf(hCustom) === '无法判断'
    && ruleTxt(hCustom).includes('W_CUSTOM_RULE_JUDGMENT_BINDING_MISMATCH') && !ruleTxt(hCustom).includes('过期运行的结果'), ruleTxt(hCustom).slice(0, 400));

  const staleDeferred = deferredSiteResponse({ rawText: JSON.stringify({ verdict: 'triggered', reason: '旧运行结果', used_data: [] }) });
  judgePlan = null;
  siteQueue.push(staleDeferred);
  await runSim('000000', '2024-09-30');
  check('自定义规则·判定中：请求期间显示“判定中…”', verdictOf(hCustom) === '判定中…', verdictOf(hCustom));
  judgePlan = () => ({ verdict: 'not_triggered', reason: '新运行：明确未满足。', used_data: [] });
  await runSim('000000', '2024-10-08');
  check('自定义规则·情境变化：新测试采用新判定结果', verdictOf(hCustom) === '未命中' && ruleTxt(hCustom).includes('新运行：明确未满足。'), ruleTxt(hCustom).slice(0, 300));
  staleDeferred.resolve(); await settle();
  check('自定义规则·旧请求回包：不覆盖新测试', verdictOf(hCustom) === '未命中' && !simTxt().includes('旧运行结果'), verdictOf(hCustom));

  await saveCustom('只针对 001234：买入前核对计划', 'buy', '001234');
  const hScoped = enabledHashes().find((h) => h !== hCustom && h !== hSurge);
  check('自定义规则·多规则：第二条自定义规则（限定 001234）保存为当前规则', !!hScoped && enabledHashes().length === 3, JSON.stringify(enabledHashes()));
  const beforeScoped = siteCalls.length;
  judgePlan = () => ({ verdict: 'not_triggered', reason: '全部股票规则：给定数据下明确不满足。', used_data: [] });
  await runSim('000000', '2024-09-30');
  check('自定义规则·范围筛选：限定 001234 的规则在 000000 情境不进入结果列表（只计“不适用 1 条”），不发起判定请求',
    !simHashes().includes(hScoped) && simHashes().length === 2 && summaryOf('not_applicable') === '不适用 1 条'
    && siteCalls.length === beforeScoped + 1, `${siteCalls.length - beforeScoped}`);
  judgePlan = (req) => (req.rule.scope.kind === 'symbol'
    ? { verdict: 'unable', reason: '规则需要持仓数据，本次未提供。', used_data: [] }
    : { verdict: 'triggered', reason: '全部股票规则：该情境应提醒。', used_data: [] });
  await runSim('001234', '2024-09-30');
  check('自定义规则·单股情境：两条自定义规则分别判定（全部股票命中、限定 001234 无法判断），结果互不覆盖',
    verdictOf(hCustom) === '命中' && verdictOf(hScoped) === '无法判断' && summaryOf('unable') === '无法判断 1 条'
    && summaryOf('triggered') === '命中 2 条', `${verdictOf(hCustom)}|${verdictOf(hScoped)}|${verdictOf(hSurge)}`);

  await setSimAction('sell');
  const beforeSell = siteCalls.length;
  await runSim('001234', '2024-09-30');
  check('自定义规则·动作筛选：假如卖出时买入提醒类规则不进入结果列表（只计“不适用 3 条”），不发起判定请求',
    simHashes().length === 0 && summaryOf('not_applicable') === '不适用 3 条'
    && siteCalls.length === beforeSell, JSON.stringify(simHashes()));
  await setSimAction('buy');

  siteResponseHook = null; judgePlan = null;
  store.delete('tm.contracts.demo'); state.contracts = defaultContracts(); state.bill = defaultBill();
}

/* ==== 导入页：用户本地 CSV（FileReader 本机读取 → adapter 校验 → 确认门槛 → 旧账单清理）==== */
state.route = 'import';
state.bill = defaultBill();
state.importRecovery = defaultImportRecovery();
mountCycle();
check('用户输入：空状态提示 + accept 覆盖 CSV/TSV/Excel/PDF/文字/图片', texts(current).join('|').includes('尚未选择账单')
  && ['.csv', '.tsv', '.xlsx', '.pdf', '.txt', '.png'].every((ext) => findInputs(current)[0].attrs.accept.includes(ext)),
  findInputs(current)[0].attrs.accept);
{
  const sample = findByTag(current, 'a').find((a) => String(a.attrs.href ?? '') === '/m0/csv-input/fixtures/demo-bill-real.csv');
  const emptyTxt = texts(current).join('|');
  check('用户CSV：提供示例账单下载用于本地上传演示，并说明演示按钮不进入在线对话',
    !!sample && sample.attrs.download === 'demo-bill-local.csv'
    && texts(sample).join('').includes('下载示例账单')
    && emptyTxt.includes('只有本地上传的账单会进入复核与在线对话')
    && emptyTxt.includes('加载演示账单'), sample ? JSON.stringify(sample.attrs) : emptyTxt.slice(0, 300));
}

const happyCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,600519,买入,1488.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n';
await pickFile({ name: 'my-bill.csv', size: 2048, __content: happyCsv });
await flush();
txt = texts(current).join('|');
check('用户CSV：校验通过 → loaded + 待确认 + 文件名/大小', state.bill.status === 'loaded' && state.bill.sourceType === 'local' && state.bill.trades.length === 2 && txt.includes('my-bill.csv') && txt.includes('2 KB')
  && texts(findByClass(current, 'im-status')[0] ?? { children: [] }).join('').includes('待确认：'), txt.slice(0, 200));
check('用户CSV：本机处理与数据模式标注', txt.includes('仅在本机读取和校验，不上传') && txt.includes('用户本地账单 + Tushare 动态行情') && txt.includes('服务端只接收标的代码与日期范围'), txt.slice(0, 260));
let confirmBtn = findButtons(current).find((b) => labelOf(b).includes('确认交易列表'));
check('用户CSV：正常校验通过后确认按钮可用', !!confirmBtn && !confirmBtn.disabled);

await pickFile({ name: 'notes.zip', size: 12 });
await flush();
confirmBtn = findButtons(current).find((b) => labelOf(b).includes('确认交易列表'));
check('用户输入：有效账单后选不支持类型 → 旧账单完全重置且不可确认', state.bill.status === 'none'
  && state.importRecovery.status === 'unsupported'
  && state.importRecovery.unsupported.message.includes('暂不支持这种文件类型')
  && state.bill.trades.length === 0 && state.bill.warnings.length === 0 && state.bill.errors.length === 0 && state.bill.blocked === false && state.bill.dataMode === null && state.bill.resultLabelling === null && state.bill.sourceNote === '' && !confirmBtn, JSON.stringify(state.bill).slice(0, 220));

await pickFile({ name: 'bad.csv', size: 64, __content: '日期,标的,方向,价格,数量\n2024-10-09,ABC,买入,100,100\n' });
await flush();
txt = texts(current).join('|');
confirmBtn = findButtons(current).find((b) => labelOf(b).includes('确认交易列表'));
check('用户CSV：blocked → invalid + trades 为空 + 确认按钮禁用', state.bill.status === 'invalid' && state.bill.blocked === true && state.bill.trades.length === 0 && !!confirmBtn && confirmBtn.disabled === true, JSON.stringify({ s: state.bill.status, b: state.bill.blocked }));
check('用户CSV：errors/warnings 渲染（错误码/行号/警告码/整批阻断）', txt.includes('整批阻断') && txt.includes('E_SYMBOL_FORMAT') && txt.includes('第 2 行') && txt.includes('W_FEE_COLUMN_MISSING'), txt.slice(0, 260));
{
  const vis = visibleTexts(current).join('|');
  const tech = findByClass(current, 'im-tech')[0];
  check('用户CSV·校验失败：先用人话说明为什么不能分析、该改什么（标的需为 6 位数字代码，第 2 行），错误码收进“技术详情”',
    vis.includes('不能分析：账单里有需要修改的地方') && vis.includes('标的需为 6 位数字代码（例如 000001），请保留前导零。（第 2 行）') && vis.includes('技术详情（错误码）')
    && !vis.includes('E_SYMBOL_FORMAT') && !!tech && tech.tagName === 'DETAILS' && texts(tech).join('|').includes('E_SYMBOL_FORMAT（第 2 行）'), vis.slice(0, 400));
}

await pickFile({ name: 'my-bill.csv', size: 2048, __content: happyCsv });
await flush();
await pickFile({ name: 'broken.csv', size: 8, __readError: true });
await flush();
confirmBtn = findButtons(current).find((b) => labelOf(b).includes('确认交易列表'));
check('用户CSV：有效账单后读取失败 → 干净错误态且不可确认', state.bill.status === 'error' && state.bill.fileName === 'broken.csv' && state.bill.fileSize === 8 && state.bill.sourceType === 'local' && state.bill.error.includes('无法读取文件内容') && state.bill.trades.length === 0 && state.bill.warnings.length === 0 && state.bill.errors.length === 0 && state.bill.blocked === false && state.bill.dataMode === null && !confirmBtn, JSON.stringify(state.bill).slice(0, 220));

/* ==== 导入页：文本型 PDF 本机提取；截图能力缺口 ==== */
{
  state.route = 'import';
  state.bill = defaultBill();
  state.importRecovery = defaultImportRecovery();
  mountCycle();
  const pdfText = 'date,symbol,side,price,quantity\n2024-09-24,600519,buy,100.00,100';
  const pdfContent = `BT /F1 12 Tf 72 720 Td (${pdfText.replace(/\n/g, ') Tj T* (')}) Tj ET`;
  const pdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${Buffer.byteLength(pdfContent)} >>\nstream\n${pdfContent}endstream\nendobj\n%%EOF`, 'latin1');
  const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
  const callsBeforePdf = siteCalls.filter((c) => String(c.url).includes('import-recover')).length;
  await pickFile({ name: 'bill.pdf', size: pdf.length, type: 'application/pdf', __buffer: buffer });
  await flush();
  await flush();
  check('用户PDF：文本层本机提取并走常规校验，零模型请求', state.bill.status === 'loaded'
    && state.bill.sourceType === 'local' && state.bill.trades.length === 1
    && state.bill.trades[0].symbol === '600519'
    && state.importRecovery.status === 'local_ready'
    && siteCalls.filter((c) => String(c.url).includes('import-recover')).length === callsBeforePdf,
  JSON.stringify({ bill: state.bill.status, trades: state.bill.trades.length, rec: state.importRecovery.status }));

  const visionCallsBefore = siteCalls.filter((call) => String(call.url).includes('import-vision')).length;
  await pickFile({ name: 'shot.png', size: 10, type: 'image/png' });
  await flush();
  check('用户截图：进入视觉分支，不直接入账，未产生模型请求', state.bill.status === 'none'
    && state.importRecovery.vision?.kind === 'image'
    && state.bill.trades.length === 0
    && siteCalls.filter((call) => String(call.url).includes('import-vision')).length === visionCallsBefore,
  JSON.stringify({ bill: state.bill.status, rec: state.importRecovery.status, vision: state.importRecovery.vision?.status }));
}

/* ==== 导入页：粘贴文字 → 本地不完整 → 用户点击 AI → 可编辑草稿 → 校验 → 既有确认 ==== */
{
  const { createImportRecovery } = await imp('src/agent/importRecovery.js');
  state.route = 'import';
  state.bill = defaultBill();
  state.importRecovery = defaultImportRecovery();
  state.assistant = { ...state.assistant, messages: [] };
  const versionsBefore = state.contracts.versions.length;
  const calls = [];
  const recoveryClient = createImportRecovery({
    transport: {
      async importRecover(request) {
        calls.push(request);
        return {
          rawText: JSON.stringify({
            trades: [
              { date: '2024-09-24', symbol: '600519', side: '买入', price: '100.00', quantity: '100', fee: '5.00', tax: '0.00', confidence: 0.9, issues: [] },
              { date: '2024-09-25', symbol: '600519', side: '卖出', price: '110.00', quantity: '100', fee: '5.00', tax: '1.00', confidence: 0.9, issues: [] },
            ],
            unresolved: [],
          }),
        };
      },
    },
    timeoutMs: 1000,
  });
  ctx.importRecovery = recoveryClient;
  mountCycle();
  const partial = '日期,标的,方向,价格,数量,费用,税费\n2024-09-24,600519,买入,100.00,100,5.00,0.00\n2024-09-25,ABC,卖出,110.00,100,5.00,1.00\n';
  const textarea = findByTag(current, 'textarea')[0];
  textarea.value = partial;
  for (const fn of textarea.listeners.input ?? []) await fn({ target: { value: partial } });
  await clickLabel('解析这段文字');
  await flush();
  check('AI补救：本地不完整时保留输入并展示草稿，模型零请求', state.bill.status === 'invalid'
    && state.importRecovery.draft?.rows.length === 2
    && calls.length === 0
    && texts(current).join('|').includes('让 AI 帮我识别'), JSON.stringify({ bill: state.bill.status, rec: state.importRecovery.status }));
  await clickLabel('让 AI 帮我识别');
  await flush();
  await flush();
  check('AI补救：只有用户点击才请求，草稿可编辑且重复行默认不导入', calls.length === 1
    && state.importRecovery.draft?.rows.length === 4
    && state.importRecovery.draft.rows.some((r) => r.source === 'ai' && r.include === false)
    && state.importRecovery.modelCalls === 1
    && state.assistant.messages.length === 0
    && JSON.stringify(calls[0]).includes('2024-09-25,ABC')
    && !JSON.stringify(calls[0]).includes('fileName'), JSON.stringify(calls[0]));
  await clickLabel('校验并用于导入');
  await flush();
  check('AI补救：未修正的无效行不能直接入账，并列出最终校验原因', state.bill.status === 'invalid'
    && !!state.importRecovery.error?.code
    && state.importRecovery.validationErrors?.length > 0
    && state.assistant.messages.length === 0
    && texts(current).join('|').includes('最终校验未通过'), JSON.stringify(state.importRecovery.error));
  const invalidRow = findByClass(current, 'im-draft-row').find((n) => String(n.attrs.class).includes('invalid'));
  const invalidCheck = invalidRow ? findInputs(invalidRow)[0] : null;
  for (const fn of invalidCheck?.listeners.change ?? []) await fn({ target: { checked: false } });
  await clickLabel('校验并用于导入');
  await flush();
  await flush();
  check('AI补救：取消无效行后走既有流程生成待确认账单，并如实标注 AI 数据模式', state.bill.status === 'loaded'
    && state.bill.importMethod === 'ai' && state.importRecovery.status === 'accepted'
    && state.bill.dataMode.label.includes('AI 识别后校对')
    && state.bill.dataMode.note.includes('提取出的文字')
    && state.assistant.messages.length === 0
    && texts(current).join('|').includes('AI 识别后由你校对，未上传原始文件）'),
  JSON.stringify({ bill: state.bill.status, method: state.bill.importMethod, dataMode: state.bill.dataMode }));
  await clickLabel('返回修改草稿');
  await flush();
  check('AI补救：返回修改草稿不显示已导入，也不结束 flow', state.bill.status === 'none'
    && state.assistant.messages.length === 0
    && recoveryClient.getSession().flow_id !== null, JSON.stringify({ bill: state.bill.status, session: recoveryClient.getSession() }));
  await clickLabel('校验并用于导入');
  await flush();
  await flush();
  await clickLabel('确认交易列表');
  await flush();
  check('AI补救：正式确认后才同步已导入并收口 flow', state.bill.status === 'confirmed'
    && state.assistant.messages.some((m) => String(m.text).includes('账单已确认导入'))
    && state.contracts.versions.length === versionsBefore
    && recoveryClient.getSession().flow_id === null
    && recoveryClient.getSession().model_calls === 0
    && recoveryClient.getTrace()?.messages.some((m) => m.type === 'flow_end' && m.reason === 'bill_confirmed')
    && state.importRecovery.trace?.messages.some((m) => m.type === 'flow_end'),
  JSON.stringify({ messages: state.assistant.messages.slice(-1), session: recoveryClient.getSession() }));
  delete ctx.importRecovery;
  state.importRecovery = defaultImportRecovery();
}

state.route = 'import';
state.bill = defaultBill();
mountCycle();
const loadPromise = clickLabel('加载演示账单');
const loadingBtn = findButtons(current).find((b) => labelOf(b).includes('加载'));
check('演示加载：期间 status=loading 且文件选择/按钮均禁用', state.bill.status === 'loading' && !!loadingBtn && loadingBtn.disabled === true && findInputs(current)[0].disabled === true, JSON.stringify({ s: state.bill.status }));
await loadPromise;
check('演示加载：结束后恢复 loaded + 待确认（默认 R 场景 8 笔）', state.bill.status === 'loaded' && state.bill.trades.length === 8
  && texts(findByClass(current, 'im-status')[0] ?? { children: [] }).join('').includes('待确认：'), JSON.stringify({ s: state.bill.status, n: state.bill.trades.length }));

/* ==== 用户账单 → 报告页（确认 → Tushare 动态行情 → runReview 发布门槛）==== */
const userReportAdapter = await imp('src/demo/adapter.js');
const oosCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,600519,买入,1488.00,100,5,0\n2025-01-02,000001,买入,10.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n';
const lateCsv = '日期,标的,方向,价格,数量,费用,税费\n2026-01-05,600519,买入,100,100,5,0\n';

state.route = 'import';
state.bill = defaultBill();
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'user-bill.csv', size: happyCsv.length, __content: happyCsv });
await flush();
await clickLabel('确认交易列表');
check('用户报告：确认后 status=confirmed 且进入报告页（用户字段不被覆盖）', state.bill.status === 'confirmed' && state.route === 'report' && state.bill.fileName === 'user-bill.csv' && state.bill.trades.length === 2 && state.bill.trades.every((t) => t.symbol === '600519') && state.bill.dataMode?.id === 'user_bill_dynamic_market' && state.bill.dataMode.label === '用户本地账单 + Tushare 动态行情', JSON.stringify({ s: state.bill.status, r: state.route }));
await flush(); await flush(); await flush();
const dynamicUserReport = await userReportAdapter.loadUserBillReport(state.bill);
check('用户报告·loader：动态行情成功、来源 dynamic-tushare、asOfDate/估值 2025-12-31，只请求账单标的',
  dynamicUserReport.status === 'ok' && !dynamicUserReport.blocked && dynamicUserReport.review?.portfolio_published === true
  && dynamicUserReport.marketSource?.id === 'dynamic-tushare' && dynamicUserReport.marketSource.dynamic === true && dynamicUserReport.marketSource.signed === false
  && dynamicUserReport.asOfDate === '2025-12-31' && dynamicUserReport.valuation?.effective_date === '2025-12-31'
  && dynamicUserReport.supportScope?.symbols.join('、') === '600519'
  && dynamicUserReport.supportScope.range.start === '2024-12-19' && dynamicUserReport.supportScope.range.end === '2025-12-31'
  && dynamicUserReport.marketSource.snapshotId === MARKET_FIXTURE_SNAPSHOT && dynamicUserReport.marketSource.checksum === MARKET_FIXTURE_CHECKSUM
  && dynamicUserReport.marketSource.fetchedAt === MARKET_FIXTURE_FETCHED_AT, JSON.stringify(dynamicUserReport.marketSource));
txt = texts(current).join('|');
check('用户报告：已确认本地账单文件名 + 用户本地账单 + Tushare 动态行情；不把用户账单称作非真实账户', txt.includes('用户本地账单')
  && txt.includes('已确认本地账单（user-bill.csv）')
  && txt.includes('用户本地账单 + Tushare 动态行情') && txt.includes('Tushare 动态日线（服务端获取，非实时）')
  && txt.includes('artifact：market-cache-dynamic')
  && txt.includes('2025-12-31') && !txt.includes('合成演示行情（非真实行情）') && !txt.includes('非真实账户'), txt.slice(0, 240));
check('用户报告·公司行为限制：显式披露 v1 不自动识别股数事件', txt.includes('公司行为限制：')
  && txt.includes('v1 不自动识别送转、拆合股、配股等股数事件') && txt.includes('可能估值不准确'), txt.slice(0, 320));
check('报告·用户账单：底部同样不出现“契约匹配未接线”，契约状态与未接入项照实说明', wiringOk(txt), txt.slice(-300));
check('报告·用户摘要：数据来源=已确认本地账单（文件名）/ Tushare 动态行情（2024-12-19 → 2025-12-31）/ 估值日 2025-12-31 / 组合结果已发布（已通过复核）',
  summaryTxt().includes('已确认本地账单 · user-bill.csv') && summaryTxt().includes('Tushare 动态日线（服务端获取，非实时） · 2024-12-19 → 2025-12-31') && summaryTxt().includes('估值日') && summaryTxt().includes('2025-12-31')
  && summaryTxt().includes('组合结果已发布（已通过复核）') && summaryTxt().includes('本次结论：组合结果已通过复核并发布') && summaryTxt().includes('数字基于Tushare 动态日线（服务端获取，非实时）与本次已确认账单') && !summaryTxt().includes('不要据此作交易判断'), summaryTxt());
check('用户报告：指标来自用户交易与动态估值（-6.6%/-7.4%/¥-1,254.00），非演示 A', txt.includes('-6.6%') && txt.includes('-7.4%') && txt.includes('¥-1,254.00') && !txt.includes('+4.9%') && !txt.includes('¥700.00') && !txt.includes('undefined'), txt.slice(0, 240));
check('用户报告：无 A/A′ 场景切换与差异面板', !txt.includes('演示场景') && !txt.includes('A′') && !txt.includes('与基准 A 的差异'), txt.slice(0, 160));
check('用户报告：复核状态中文“全部事实已发布” + 已发布 17 项 + 组合已发布（内部状态在详情）',
  txt.includes('复核：全部事实已发布') && txt.includes('内部状态标识：published') && txt.includes('已发布事实 17 项') && txt.includes('组合已发布'), txt.slice(0, 200));
check('用户报告：组合范围反事实入口提示选择标的（不画图）', txt.includes('请选择一个标的查看单笔卖出反事实') && !visibleTexts(current).join('|').includes('scope'), txt.slice(0, 160));
const factNodes = () => findByClass(current, 'rp-fact');
const blockedBoxOf = () => findByClass(current, 'rp-error').find((n) => texts(n).join('').includes('结果不发布：')) ?? { children: [] };
const factSummary = (n) => texts(n.children[0]).join('|');
check('证据视图：复核概览（verify_id / 已发布 17 / 阻断 0 / 组合已发布）+ 已发布事实表（fact_id / display / 公式编号）',
  txt.includes('复核概览') && /V-[0-9a-f]{8}/.test(txt) && txt.includes('阻断事实 0 项') && txt.includes('已发布事实（17 项）')
  && txt.includes('portfolio.actualRet') && txt.includes('CALC_RET_V1') && txt.includes('组合 · 实际收益') && txt.includes('无未发布事实'), txt.slice(0, 400));
check('证据视图：复核检查（独立重算 17/17、恒等式全过、路径完整、无悬空引用）',
  txt.includes('事实独立重算') && txt.includes('17/17 通过') && txt.includes('恒等式校验') && txt.includes('ID-1') && txt.includes('计算路径完整性') && txt.includes('悬空来源引用'), txt.slice(0, 400));
check('证据视图：无备用重算来源时如实说明（重算尝试 0 次 · 未提供重算来源）', txt.includes('重算尝试 0 次 · 未提供重算来源') && txt.includes('无需重算'), txt.slice(0, 300));
{
  const nodes = factNodes();
  const ret = nodes.find((n) => factSummary(n).includes('组合 · 实际收益'));
  const retTxt = ret ? texts(ret).join('|') : '';
  check('证据视图：组合 8 项事实均已发布，条目标题含事实名 + 引擎 display + 已发布',
    nodes.length === 8 && nodes.every((n) => String(n.attrs.class).includes('ok') && factSummary(n).includes('已发布'))
    && !!ret && factSummary(ret).includes('-6.6%'), JSON.stringify(nodes.map(factSummary)).slice(0, 300));
  check('证据视图：展开后含公式编号/公式文本/输入/来源行/计算步骤',
    retTxt.includes('CALC_RET_V1') && retTxt.includes('actualValue / buyCost − 1') && retTxt.includes('成交 T001、T002')
    && retTxt.includes('user-bill.csv 第 2 行') && retTxt.includes('计算步骤') && retTxt.includes('S1 口径') && retTxt.includes('S3 逐批')
    && retTxt.includes('复核通过并发布') && !retTxt.includes('undefined'), retTxt.slice(0, 400));
  check('证据视图·用户导读：已发布事实先说明代表什么 / 来源成交 / 已通过复核（verify_id），技术细节折叠',
    retTxt.includes('这项结果代表什么') && retTxt.includes('实际期末价值相对买入成本的收益率') && retTxt.includes('来源于哪些交易') && /已通过复核并发布（V-[0-9a-f]{8}）/.test(retTxt)
    && !!ret && findByClass(ret, 'rp-tech').length === 1 && findByClass(ret, 'rp-tech')[0].tagName === 'DETAILS', retTxt.slice(0, 300));
}
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户反事实：600519 使用动态行情与 asOfDate 估值（S1 + 引擎 display ¥137,718.00 / -7.4% / -0.8pp）', txt.includes('单笔反事实') && txt.includes('S1') && txt.includes('2025-12-31') && txt.includes('假设结果价值 ¥137,718.00') && txt.includes('假设收益 -7.4%') && txt.includes('相对改善 -0.8pp'), txt.slice(0, 300));
check('用户反事实：双 SVG 面板与图例渲染正常，caption 为 Tushare 动态日线而非合成行情', findByTag(current, 'svg').length >= 2 && txt.includes('当前替换笔') && txt.includes('不构成投资建议')
  && findByClass(current, 'gc-caption').some((n) => texts(n).join('').includes('Tushare 动态日线') && !texts(n).join('').includes('合成')), txt.slice(0, 200));

state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'oos-bill.csv', size: oosCsv.length, __content: oosCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：请求标的 000001 在 2025-12-31 缺价阻断（E_PRICE_MISSING · B4 不回退）', txt.includes('000001') && txt.includes('2025-12-31') && txt.includes('缺价') && txt.includes('E_PRICE_MISSING')
  && !txt.includes('+4.9%') && !txt.includes('¥700.00'), txt.slice(0, 260));
check('用户报告：复核“部分事实已发布” + 组合结果不发布（不按剩余标的重算）',
  txt.includes('复核：部分事实已发布') && txt.includes('内部状态标识：degraded') && txt.includes('组合」结果不发布') && txt.includes('不按剩余标的'), txt.slice(0, 260));
{
  const vis = visibleTexts(current).join('|');
  check('用户报告·阻断：中文阻断原因与行号可见，错误码只在技术详情', vis.includes('结果不发布') && !vis.includes('E_PRICE_MISSING') && txt.includes('E_PRICE_MISSING'), vis.slice(-300));
}
check('报告·用户摘要·阻断：优先显示阻断原因（000001 缺价）+“不要据此作交易判断。”+ 组合结果未发布，摘要不含任何数值',
  summaryTxt().startsWith('本次分析摘要|存在阻断：') && summaryTxt().includes('000001') && summaryTxt().includes('缺价') && summaryTxt().includes('不要据此作交易判断。') && summaryTxt().includes('部分标的结果已通过复核')
  && summaryTxt().includes('组合结果未发布') && !summaryTxt().includes('已发布（') && !/[+-]\d+\.\d%|¥/.test(summaryTxt()), summaryTxt());
check('证据视图·缺价：未发布事实表列出组合扣发原因 + 000001 未进入计算 + 无组合指标卡',
  txt.includes('组合不发布') && txt.includes('未发布事实（8 项）') && txt.includes('portfolio.actualRet') && txt.includes('E_REVIEW_PORTFOLIO_WITHHELD')
  && txt.includes('组合结论整体扣发') && txt.includes('「000001」未进入计算') && findByClass(current, 'rp-metric').length === 0, txt.slice(0, 400));
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·缺价：组合扣发显示真实原因（E_PRICE_MISSING / WITHHELD）+ B4 文案，不出现复核证据不足说明',
    boxTxt.includes('「组合」结果不发布') && boxTxt.includes('E_PRICE_MISSING') && boxTxt.includes('E_REVIEW_PORTFOLIO_WITHHELD')
    && boxTxt.includes('不按剩余标的') && boxTxt.includes('不回退其他日期') && !boxTxt.includes('复核或证据不足') && !boxTxt.includes('-6.6%'), boxTxt.slice(0, 400));
}
{
  const nodes = factNodes();
  const allTxt = nodes.map((n) => texts(n).join('|')).join('||');
  check('证据视图·缺价：组合事实条目全部“未发布”，不外露按剩余标的算出的数字',
    nodes.length === 8 && nodes.every((n) => String(n.attrs.class).includes('bad') && factSummary(n).includes('未发布'))
    && !allTxt.includes('-6.6%') && !allTxt.includes('¥-1,254.00') && !allTxt.includes('¥137,718.00') && !allTxt.includes('复核通过并发布')
    && allTxt.includes('不展示该步骤的中间数值'), allTxt.slice(0, 400));
}
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：未阻断标的 600519 仍发布（-6.6%/¥-1,254.00）', txt.includes('-6.6%') && txt.includes('¥-1,254.00'), txt.slice(0, 200));
await clickLabel('000001'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：000001 视图不发布（缺价说明，且不出反事实图）', txt.includes('000001」结果不发布') && txt.includes('2025-12-31') && txt.includes('缺价') && !txt.includes('单笔反事实'), txt.slice(0, 200));
check('证据视图·缺价标的：000001 无计算路径且说明未进入计算', txt.includes('「000001」没有计算路径') && factNodes().length === 0, txt.slice(0, 300));

const allOutCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,000001,买入,10.00,100,5,0\n';
state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'allout-bill.csv', size: allOutCsv.length, __content: allOutCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('证据视图·复核未运行：verify 未产出、计算路径不可用、无已发布数字',
  txt.includes('复核：无可发布事实') && txt.includes('内部状态标识：blocked') && txt.includes('未产出（复核未运行）') && txt.includes('已发布事实 0 项') && txt.includes('复核检查未运行')
  && txt.includes('计算路径不可用') && txt.includes('不标记为已验证') && txt.includes('重算尝试 0 次 · 未提供重算来源')
  && findByClass(current, 'rp-metric').length === 0 && factNodes().length === 0, txt.slice(0, 400));
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·全部缺价：仅 601318 的组合阻断显示缺价原因与 B4 文案',
    boxTxt.includes('E_PRICE_MISSING') && boxTxt.includes('不按剩余标的') && !boxTxt.includes('复核或证据不足') && !txt.includes('E_MARKET_OUT_OF_SUPPORT'), boxTxt.slice(0, 300));
}

state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'dangling-bill.csv', size: happyCsv.length, __content: happyCsv });
await flush();
state.bill = { ...state.bill, trades: state.bill.trades.map((t, i) => (i === 0 ? { ...t, source: { file: null, line: null } } : t)) };
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('证据视图·悬空引用：路径不完整 + 悬空成交 T001 + E_PROV_DANGLING_REF 显著标注',
  txt.includes('计算路径完整性') && txt.includes('不完整') && txt.includes('引用的成交 T001 无法定位') && txt.includes('E_PROV_DANGLING_REF')
  && txt.includes('E_VERIFY_SOURCE_UNRESOLVED') && txt.includes('计算路径存在阻断或悬空引用'), txt.slice(0, 400));
check('证据视图·悬空引用：重算记录如实列出（无备用来源 / 已停止 / 尝试 0 次）',
  /R-[0-9a-f]{8}/.test(txt) && txt.includes('没有备用来源') && txt.includes('已停止') && txt.includes('E_REVIEW_RECOMPUTE_NO_ALTERNATIVE') && txt.includes('重算尝试 0 次'), txt.slice(0, 400));
check('证据视图·悬空引用：全部事实未发布，页面不出现任何有效数字或“复核通过”',
  factNodes().length === 8 && factNodes().every((n) => factSummary(n).includes('未发布')) && txt.includes('没有通过复核的事实')
  && !txt.includes('-6.6%') && !txt.includes('¥-1,254.00') && !txt.includes('¥137,718.00') && !txt.includes('¥138,972.00') && !txt.includes('复核通过并发布'), txt.slice(0, 400));
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·悬空来源：组合显示复核/证据问题（来源行不可定位 / 无备用重算），不归因缺价或超范围，无指标卡',
    boxTxt.includes('「组合」结果不发布') && boxTxt.includes('E_VERIFY_SOURCE_UNRESOLVED') && boxTxt.includes('E_REVIEW_RECOMPUTE_NO_ALTERNATIVE')
    && boxTxt.includes('复核或证据不足') && !boxTxt.includes('缺价') && !boxTxt.includes('超范围') && !boxTxt.includes('不按剩余标的')
    && !boxTxt.includes('不回退其他日期') && findByClass(current, 'rp-metric').length === 0, boxTxt.slice(0, 400));
}
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·悬空来源：标的 600519 同样显示真实原因，不归因缺价，不显示数字与反事实图',
    boxTxt.includes('「600519」结果不发布') && boxTxt.includes('E_VERIFY_SOURCE_UNRESOLVED') && boxTxt.includes('复核或证据不足')
    && !boxTxt.includes('缺价') && !boxTxt.includes('超范围') && !boxTxt.includes('其他估值日')
    && findByClass(current, 'rp-metric').length === 0 && !txt.includes('单笔反事实') && !txt.includes('-6.6%') && !txt.includes('¥-1,254.00'), boxTxt.slice(0, 400));
}

state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'late-bill.csv', size: lateCsv.length, __content: lateCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：600519 2026-01-05 晚于估值 → 明确阻断（不回退演示）', txt.includes('E_VALUATION_BEFORE_LAST_TRADE')
  && txt.includes('2026-01-05') && !txt.includes('演示场景') && !txt.includes('¥700.00') && findByClass(current, 'rp-metric').length === 0, txt.slice(0, 240));
check('报告·用户摘要·复核未运行：阻断原因（估值日早于末笔交易日）+“不要据此作交易判断。”+ 组合结果未发布（复核未运行）',
  summaryTxt().includes('存在阻断：') && summaryTxt().includes('早于账单末笔交易日') && summaryTxt().includes('不要据此作交易判断。') && summaryTxt().includes('组合结果未发布（复核未运行）')
  && summaryTxt().includes('已确认本地账单 · late-bill.csv'), summaryTxt());

/* ==== 混合账单：缺价标的按 B4 扣发（其余可估值标的仍发布；页面与复核一并检查） ==== */
{
  const mixedCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,600519,买入,1488.00,100,5,0\n2025-01-02,000000,买入,10.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n';
  state.route = 'import';
  state.bill = defaultBill();
  state.report = { scenario: 'A', symbol: 'pool' };
  mountCycle();
  await pickFile({ name: 'mixed-bill.csv', size: mixedCsv.length, __content: mixedCsv });
  await flush();
  await clickLabel('确认交易列表');
  await flush(); await flush(); await flush();
  const mixed = await userReportAdapter.loadUserBillReport(state.bill);
  check('混合账单·loader：000000 缺价（E_PRICE_MISSING）不再整批阻断；600519 发布、组合扣发不按剩余重算',
    mixed.status === 'partial' && mixed.blockedSymbols.includes('000000') && !mixed.blockedSymbols.includes('600519')
    && mixed.errors.some((e) => e.code === 'E_PRICE_MISSING' && e.symbol === '000000')
    && mixed.review.blocked_symbols.some((s) => s.symbol === '000000') && mixed.review.portfolio_published === false
    && !!mixed.factsByScope['600519'] && !mixed.factsByScope['000000'] && !mixed.factsByScope.portfolio, JSON.stringify(mixed.errors));
  txt = texts(current).join('|');
  check('混合账单·页面（组合）：复核“部分事实已发布”，组合不发布并说明缺价与不按剩余标的重算',
    txt.includes('复核：部分事实已发布') && txt.includes('组合」结果不发布') && txt.includes('缺价') && txt.includes('不按剩余标的'), txt.slice(0, 300));
  {
    const boxTxt = texts(blockedBoxOf()).join('|');
    check('混合账单·阻断框：000000 显示缺价原因，组合扣发原因为 WITHHELD',
      boxTxt.includes('E_PRICE_MISSING') && boxTxt.includes('E_REVIEW_PORTFOLIO_WITHHELD') && boxTxt.includes('缺价'), boxTxt.slice(0, 400));
  }
  await clickLabel('600519'); await flush(); await flush(); await flush();
  txt = texts(current).join('|');
  check('混合账单·可估值标的 600519 仍发布（-6.6%/-7.4%/¥-1,254.00）且反事实入口保留',
    txt.includes('-6.6%') && txt.includes('-7.4%') && txt.includes('¥-1,254.00') && txt.includes('单笔反事实'), txt.slice(0, 240));
  await clickLabel('000000'); await flush(); await flush(); await flush();
  txt = texts(current).join('|');
  check('混合账单·缺价标的视图：「000000」不发布，给缺价原因，无指标卡、无反事实',
    txt.includes('「000000」结果不发布') && txt.includes('缺价') && txt.includes('未进入计算')
    && findByClass(current, 'rp-metric').length === 0 && !txt.includes('当前替换笔'), txt.slice(0, 300));
}

/* ==== 300750 已知事件边界：任一事件前交易保守拦截（对照路径仍可能跨事件），事件后不受限 ==== */
{
  const mk = (rows) => `日期,标的,方向,价格,数量,费用,税费\n${rows}`;
  const caCases = [
    { name: 'ca-closed-before.csv', csv: mk('2023-01-03,300750,买入,100,100,5,0\n2023-04-25,300750,卖出,104,100,5,1\n'), blocked: true, label: '事件前已清仓（对照路径仍可能跨事件）' },
    { name: 'ca-holding.csv', csv: mk('2023-01-03,300750,买入,100,100,5,0\n2024-09-25,300750,卖出,104,100,5,1\n'), blocked: true, label: '事件前买入、跨事件持仓' },
    { name: 'ca-after.csv', csv: mk('2023-04-26,300750,买入,100,100,5,0\n2024-09-25,300750,卖出,104,100,5,1\n'), blocked: false, label: '事件后交易不受事件边界限制' },
  ];
  for (const c of caCases) {
    state.route = 'import';
    state.bill = defaultBill();
    state.report = { scenario: 'A', symbol: 'pool' };
    mountCycle();
    await pickFile({ name: c.name, size: c.csv.length, __content: c.csv });
    await flush();
    await clickLabel('确认交易列表');
    await flush(); await flush(); await flush();
    const bundle = await userReportAdapter.loadUserBillReport(state.bill);
    check(`300750 边界·${c.label}：${c.blocked ? '整批阻断（E_MARKET_CORPORATE_ACTION_BOUNDARY，不是缺价）、复核不运行' : '照常发布（事件边界只拦事件前交易）'}`,
      c.blocked
        ? (bundle.blocked && !bundle.review && bundle.errors.some((e) => e.code === 'E_MARKET_CORPORATE_ACTION_BOUNDARY') && !bundle.errors.some((e) => e.code === 'E_PRICE_MISSING'))
        : (!bundle.blocked && bundle.review?.portfolio_published === true && !bundle.errors.some((e) => e.code === 'E_MARKET_CORPORATE_ACTION_BOUNDARY')),
      JSON.stringify(bundle.errors));
    if (c.blocked) {
      txt = texts(current).join('|');
      check(`300750 边界·页面（${c.label}）：明确事件边界与“对照路径仍可能跨越该事件，无法断言放行是安全的”，复核未运行、无数字`,
        txt.includes('E_MARKET_CORPORATE_ACTION_BOUNDARY') && txt.includes('对照路径仍可能跨越该事件') && txt.includes('无法断言放行是安全的') && txt.includes('复核未运行')
        && findByClass(current, 'rp-metric').length === 0 && !/[+-]\d+\.\d%|¥/.test(txt), txt.slice(0, 300));
    }
  }
}

/* ==== M2-C4 旧复现路径失效确认：A/A′ 原字节走用户上传路径（可复现核查，不伪造演练结果） ==== */
{
  for (const [label, file] of [['A', 'demo-bill.csv'], ['A′', 'demo-bill-aprime.csv']]) {
    const fixtureText = readFileSync(join(ROOT, 'm0/csv-input/fixtures', file), 'utf8');
    const bill = { ...(await userReportAdapter.loadUserBillFromText(fixtureText, file)), status: 'confirmed' };
    const r = await userReportAdapter.loadUserBillReport(bill);
    check(`M2-C4 复现核查·${label} 原字节用户路径：888888/000000 在测试行情中无数据 → 缺价阻断、无可发布事实，不出现 26/26 复核记录`,
      r.blocked && r.review && !r.review.verify && Object.keys(r.factsByScope).length === 0
      && ['888888', '000000'].every((s) => r.errors.some((e) => e.code === 'E_PRICE_MISSING' && e.symbol === s)), JSON.stringify(r.errors));
  }
}

/* ==== M2-C4 新演练账单（合成交易 + Tushare 动态行情）：A/A′ 走用户导入与 runReview（数据侧复跑；页面走查待人工） ==== */
{
  const drillAdapter = await imp('src/demo/adapter.js?smoke=m2c4-drill');
  const countSynthetic = () => resourceCalls.filter((p) => p.startsWith('/m0/market-cache/')).length;
  const before = countSynthetic();
  const runs = {};
  for (const [label, file] of [['A', 'm2c4-synthetic-bill-A.csv'], ['A′', 'm2c4-synthetic-bill-Aprime.csv']]) {
    const billText = readFileSync(join(ROOT, 'docs/yinchen/m2c4-drill-bills', file), 'utf8');
    const bill = { ...(await drillAdapter.loadUserBillFromText(billText, file)), status: 'confirmed' };
    const r = await drillAdapter.loadUserBillReport(bill);
    runs[label] = r;
    const v = r.review.verify;
    check(`M2-C4 演练账单·${label}（${file}）：动态行情通过校验并运行复核，26/26 事实、11/11 恒等式、来源=账单文件第 2–5 行`,
      !r.blocked && r.review.portfolio_published && r.marketSource.id === 'dynamic-tushare' && r.marketSource.dynamic && r.asOfDate === '2025-12-31'
      && v.facts.length === 26 && v.facts.every((f) => f.verdict === 'pass' && f.path_a === f.path_b && f.diff === 0)
      && v.identity_checks.length === 11 && v.identity_checks.every((i) => i.verdict === 'pass')
      && v.provenance_complete && v.dangling_refs.length === 0 && r.review.blocked_symbols.length === 0 && r.review.degraded.length === 0
      && v.facts.every((f) => f.source_refs.length >= 2 && f.source_refs.every((s) => s.file === file && s.line >= 2 && s.line <= 5))
      && countSynthetic() === before, JSON.stringify(r.errors ?? v.summary));
  }
  const fact = (r, scope, key) => r.factsByScope[scope][key].value;
  check('M2-C4 演练账单·受影响（600519）：A′ 卖出价 1590→1600 → sellProceeds/actualValue +1,000、dragMoney −1,000、actualRet 上升、drag 更负',
    fact(runs.A, '600519', 'sellProceeds') === 159000 && fact(runs['A′'], '600519', 'sellProceeds') === 160000
    && fact(runs.A, '600519', 'actualValue') === 159000 && fact(runs['A′'], '600519', 'actualValue') === 160000
    && Math.round(fact(runs['A′'], '600519', 'dragMoney') - fact(runs.A, '600519', 'dragMoney')) === -1000
    && fact(runs.A, '600519', 'actualRet') < fact(runs['A′'], '600519', 'actualRet') && fact(runs.A, '600519', 'drag') > fact(runs['A′'], '600519', 'drag')
    && Math.round((fact(runs['A′'], '600519', 'actualRet') - fact(runs.A, '600519', 'actualRet')) * fact(runs.A, '600519', 'buyCost')) === 1000, JSON.stringify({ a: runs.A.factsByScope['600519'], ap: runs['A′'].factsByScope['600519'] }));
  check('M2-C4 演练账单·不受影响：600519 基础四项（buyCost/heldShares/ghostValue/ghostRet）与 601318 全部九项在 A/A′ 间逐项相同',
    fact(runs.A, '600519', 'buyCost') === fact(runs['A′'], '600519', 'buyCost') && fact(runs.A, '600519', 'heldShares') === fact(runs['A′'], '600519', 'heldShares')
    && fact(runs.A, '600519', 'ghostValue') === fact(runs['A′'], '600519', 'ghostValue') && fact(runs.A, '600519', 'ghostRet') === fact(runs['A′'], '600519', 'ghostRet')
    && JSON.stringify(runs.A.factsByScope['601318']) === JSON.stringify(runs['A′'].factsByScope['601318']), JSON.stringify(runs.A.factsByScope['601318']));
  check('M2-C4 演练账单·组合：actualValue +1,000、dragMoney −1,000，buyCost/ghostValue/ghostRet 不变（不按剩余标的重算的反面：全量口径）',
    Math.round(fact(runs['A′'], 'portfolio', 'actualValue') - fact(runs.A, 'portfolio', 'actualValue')) === 1000
    && Math.round(fact(runs['A′'], 'portfolio', 'dragMoney') - fact(runs.A, 'portfolio', 'dragMoney')) === -1000
    && fact(runs.A, 'portfolio', 'buyCost') === fact(runs['A′'], 'portfolio', 'buyCost') && fact(runs.A, 'portfolio', 'ghostValue') === fact(runs['A′'], 'portfolio', 'ghostValue')
    && fact(runs.A, 'portfolio', 'ghostRet') === fact(runs['A′'], 'portfolio', 'ghostRet'), JSON.stringify(runs.A.factsByScope.portfolio));
}

/* ==== 契约情境模拟：交易来源随账单模式切换（已确认本地账单 → 用户 trades；否则演示账单 A）==== */
{
  const cfCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-09-24,600519,买入,100,100,5,0\n2024-10-09,600519,卖出,104,100,5,1\n2024-09-25,300750,买入,30,100,5,0\n2024-09-30,300750,卖出,31,100,5,0\n';
  const adapterMod = await imp('src/demo/adapter.js');
  const hB3 = adapterMod.previewContract({ template_id: 'no_buy_back_within', fields: { days: '3' } }).hash;
  const hS3 = adapterMod.previewContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' } }).hash;
  store.delete('tm.contracts.demo');
  state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture' };
  state.route = 'import'; state.bill = defaultBill(); mountCycle();
  await pickFile({ name: 'cf-user.csv', size: cfCsv.length, __content: cfCsv });
  await flush();
  state.route = 'contract'; mountCycle(); await settle();
  check('情境来源·未确认本地账单（loaded）：仍用演示账单 A，不显示用户文件名',
    state.bill.status === 'loaded' && sourceLine().startsWith('交易来源：演示账单 A') && !sourceLine().includes('cf-user.csv'), sourceLine());

  state.route = 'import'; mountCycle();
  await clickLabel('确认交易列表'); await settle();
  state.route = 'contract'; mountCycle(); await settle();
  await clickRole('add-rule'); await fire(byRole('template'), 'change', 'no_buy_back_within'); await saveModal();
  await clickRole('add-rule'); await fire(byRole('template'), 'change', 'no_buy_on_surge'); await fire(fieldInput('threshold_pct'), 'input', '3'); await saveModal();
  check('用户账单模式：新增 不追回 3 日（v1）+ 涨幅 3%（v2）两条不同类型规则，同时为当前规则', sameSet(enabledHashes(), [hB3, hS3]), JSON.stringify(enabledHashes()));
  txt = texts(current).join('|');
  const symOpts = findByTag(byRole('sim-symbol'), 'option').map((o) => texts(o).join(''));
  check('情境来源·已确认本地账单：交易来源=已确认本地账单（cf-user.csv）· 行情=Tushare 动态日线；卖出列表为用户交易（非演示 T004）',
    state.bill.status === 'confirmed' && sourceLine().startsWith('交易来源：已确认本地账单（cf-user.csv）') && sourceLine().includes('行情：Tushare 动态日线（服务端获取，非实时）') && !sourceLine().includes('合成')
    && txt.includes('T002 600519 2024-10-09') && txt.includes('T004 300750 2024-09-30') && !txt.includes('T004 000000 2024-10-08') && !txt.includes('演示账单 A')
    && txt.includes('Tushare 动态日线（服务端获取，非实时） · 非实时行情 · 不构成投资建议') && !txt.includes('合成行情（非真实行情）') && txt.includes('候选口径（待冻结）') && txt.includes('不构成投资建议'), sourceLine() + ' || ' + txt.slice(-300));
  check('情境来源·已确认本地账单：显示支持列表 600519/300750/601318，账单标的均在本次行情，不隐藏、不替代',
    symOpts.length === 3 && ['600519', '300750', '601318'].every((symbol) => symOpts.some((o) => o.startsWith(symbol)))
    && symOpts.every((o) => !o.includes('不在') && !o.includes('合成')) && txt.includes('支持标的：300750、600519、601318')
    && txt.includes('2024-09-10 至 2025-12-31') && txt.includes('asOfDate：2025-12-31') && txt.includes('快照：tushare-20251231-01234567'), JSON.stringify(symOpts));

  let s = await simulate('600519', '2024-10-10');
  check('情境模拟·用户账单不追回：600519 2024-10-10 用用户卖出 T002（2024-10-09，距 1 日）→ 命中',
    verdictOf(hB3) === '命中' && ruleTxt(hB3).includes('最近卖出：T002 · 2024-10-09') && ruleTxt(hB3).includes('距最近卖出：1 个交易日') && !s.includes('T004 · 2024-10-08')
    && !s.includes('演示账单 A') && !s.includes('合成') && simHashes().length === 2, s.slice(0, 400));
  s = await simulate('600519', '2026-11-06');
  check('情境模拟·用户账单不追回：600519 申报日超出动态行情日期范围 → 涨幅规则数据不足（E_VALUATION_OUT_OF_RANGE）、不追回规则不在日历（E_DATE_NOT_IN_CALENDAR），均不回退演示账单',
    verdictOf(hS3) === '数据不足' && ruleTxt(hS3).includes('E_VALUATION_OUT_OF_RANGE')
    && verdictOf(hB3) === '数据不足' && ruleTxt(hB3).includes('E_DATE_NOT_IN_CALENDAR') && ruleTxt(hB3).includes('不在缓存交易日历')
    && !s.includes('演示账单 A'), `${ruleTxt(hS3).slice(0, 400)} || ${ruleTxt(hB3).slice(0, 400)}`);
  s = await simulate('300750', '2024-10-08');
  check('情境模拟·用户账单不追回：300750 在支持范围内，用用户卖出 T004 判定，只使用交易日历与账单、不读取价格',
    verdictOf(hB3) === '命中' && ruleTxt(hB3).includes('最近卖出：T004 · 2024-09-30') && ruleTxt(hB3).includes('距最近卖出：1 个交易日')
    && !ruleTxt(hB3).includes('当日涨跌幅：')
    && !s.includes('演示账单 A') && !s.includes('合成'), s.slice(0, 400));

  mountCycle();
  await settle();
  check('情境来源·优化二（不追回+涨幅同时启用）：标注“仅不追回读取卖出记录；涨幅规则不读取账单交易”，且显示卖出记录列表',
    sourceLine().includes('仅不追回读取卖出记录；涨幅规则不读取账单交易') && sourceLine().includes('不读取价格')
    && sellsLine().includes('卖出记录来源：已确认本地账单（cf-user.csv）') && sellsLine().includes('T002 600519 2024-10-09'), sourceLine() + ' || ' + sellsLine());
  await disableRule(hB3);
  check('情境来源·优化二（仅涨幅启用）：只显示“涨幅规则只读取Tushare 动态日线（服务端获取，非实时），不使用账单交易”，不显示卖出记录列表',
    !enabledHashes().includes(hB3) && sourceLine().includes('涨幅规则只读取Tushare 动态日线（服务端获取，非实时），不使用账单交易') && !sourceLine().includes('合成') && !sourceLine().includes('仅不追回') && sellsLine() === '', sourceLine() + ' || sells=' + sellsLine());
  await clickIn(histOf(hB3), '恢复为当前规则'); await settle();
  check('情境来源·优化二（从历史恢复不追回）：卖出记录列表恢复显示', enabledHashes().includes(hB3) && sellsLine().includes('T002 600519 2024-10-09'), sellsLine());
  s = await simulate('601318', '2025-12-31');
  check('情境模拟·用户账单涨幅：601318 动态行情完整（前收 2025-12-30）→ 未命中，只读行情、不使用账单交易',
    verdictOf(hS3) === '未命中' && !ruleTxt(hS3).includes('E_CHANGE_PCT_MISSING') && ruleTxt(hS3).includes('当日涨跌幅：-0.6%')
    && !s.includes('E_MARKET_OUT_OF_SUPPORT') && !s.includes('演示账单 A') && !s.includes('合成'), s.slice(0, 400));

  state.bill = defaultBill();
  state.route = 'contract'; mountCycle(); await settle();
  await settle();
  check('情境来源·清空账单后：自动切回演示账单 A，旧用户上下文与结果被丢弃', sourceLine().startsWith('交易来源：演示账单 A') && simTxt() === '' && texts(current).join('|').includes('T004 000000 2024-10-08'), sourceLine());
  s = await simulate('000000', '2024-10-10');
  check('情境模拟·演示模式不追回：仍用演示账单 A 的 T004（2024-10-08，距 2 日）',
    verdictOf(hB3) === '命中' && ruleTxt(hB3).includes('最近卖出：T004 · 2024-10-08') && ruleTxt(hB3).includes('距最近卖出：2 个交易日') && !s.includes('cf-user.csv') && simHashes().length === 2, s.slice(0, 400));
}

/* ==== 全站外壳（main.js）：分析流程 1→4、三种数据状态、了解口径、导航命名 —— 最后导入，避免其订阅影响前面的用例 ==== */
{
  const els = { 'capability-chips': makeEl('div'), nav: makeEl('nav'), view: makeEl('main'), 'footer-labels': makeEl('div'), assistant: makeEl('aside'), 'app-body': makeEl('div'), 'assistant-toggle': makeEl('button') };
  els.nav.after = (n) => { els.flow = n; };
  const hashListeners = [];
  globalThis.document.getElementById = (id) => els[id] ?? null;
  globalThis.location = { hash: '#/import' };
  let mobileLayout = false;
  globalThis.window = {
    innerWidth: 1440,
    addEventListener: (t, fn) => { if (t === 'hashchange') hashListeners.push(fn); },
    matchMedia: () => ({ matches: mobileLayout }),
  };
  state.report = { scenario: 'R', symbol: 'pool' };
  state.bill = defaultBill();
  await imp('src/main.js');
  const shell = () => texts(els.flow).join('|');
  const currentStep = () => { const n = findByClass(els.flow, 'current')[0]; return n ? texts(n).join('') : ''; };
  const goHash = async (h) => { location.hash = h; for (const fn of hashListeners) fn(); await settle(); };
  check('外壳·助手：宽屏默认显示在业务主区右侧，且可收起/展开',
    texts(els.assistant).join('|').includes('AI 规则助手')
    && els['app-body'].className.includes('assistant-open')
    && els['assistant-toggle'].textContent === '收起助手'
    && els['assistant-toggle'].attrs['aria-expanded'] === 'true', texts(els.assistant).join('|').slice(0, 240));
  await els['assistant-toggle'].onclick();
  check('外壳·助手：桌面收起后主区恢复全宽，按钮文案切为“打开 AI 助手”',
    state.assistant.open === false && !els['app-body'].className.includes('assistant-open')
    && els['assistant-toggle'].textContent === '打开 AI 助手' && els['assistant-toggle'].attrs['aria-expanded'] === 'false', els['app-body'].className);
  await els['assistant-toggle'].onclick();
  mobileLayout = true;
  globalThis.window.innerWidth = 390;
  await goHash('#/import');
  check('外壳·助手：窄屏按钮不显示“收起助手”，点击后进入独立全屏助手视图',
    els['assistant-toggle'].textContent === 'AI 助手' && !els['app-body'].className.includes('assistant-mobile-open')
    && state.assistant.mobileView === false, els['assistant-toggle'].textContent);
  await els['assistant-toggle'].onclick();
  check('外壳·助手：窄屏进入助手后主区隐藏，返回按钮出现',
    state.assistant.mobileView === true && els['app-body'].className.includes('assistant-mobile-open')
    && findButtons(els.assistant).some((b) => labelOf(b).includes('返回业务')), els['app-body'].className);
  await els['assistant-toggle'].onclick();
  mobileLayout = false;
  globalThis.window.innerWidth = 1440;
  await goHash('#/import');
  state.bill = { ...defaultBill(), status: 'confirmed', sourceType: 'local', fileName: 'chat-gate.csv', contextId: 'ctx-gate' };
  state.chat = defaultChat('ctx-gate');
  state.route = 'chat';
  mountCycle();
  const gateCallsBefore = siteCalls.length;
  const gateMarketsBefore = marketCalls.length;
  const gateInput = findByTag(current, 'textarea').find((n) => n.attrs['data-role'] === 'qa-input');
  gateInput.value = '明天买什么？';
  for (const fn of gateInput.listeners.input ?? []) await fn({ target: { value: '明天买什么？' } });
  const gateForm = findByTag(current, 'form').find((n) => n.attrs['data-role'] === 'qa-form');
  for (const fn of gateForm?.listeners.submit ?? []) await fn({ preventDefault() {} });
  await flush(); await flush();
  check('入口门禁：越界问答在本地拦截，零站点请求、零行情请求，不进入在线复述',
    siteCalls.length === gateCallsBefore && marketCalls.length === gateMarketsBefore
    && state.chat.messages.some((m) => m.answer?.status === 'refusal' && m.answer?.intent === 'out_of_scope')
    && texts(current).join('|').includes('边界拦截')
    && texts(current).join('|').includes('未加载账单、未调用模型、0 条事实'),
    JSON.stringify({ calls: siteCalls.length - gateCallsBefore, markets: marketCalls.length - gateMarketsBefore, messages: state.chat.messages.slice(-1) }));
  state.route = 'import';
  state.bill = defaultBill();
  state.chat = defaultChat();
  mountCycle();
  await goHash('#/import');
  state.report = { scenario: 'R', symbol: 'pool' };
  check('外壳·流程提示：1 导入账单 → 2 核对交易 → 3 查看报告 → 4 查看证据 / 设置规则；导入页未选账单时第 1 步为当前（文字标注“当前”）',
    shell().includes('1 导入账单') && shell().includes('2 核对交易') && shell().includes('3 查看报告') && shell().includes('4 查看证据 / 设置规则')
    && currentStep() === '1 导入账单当前', currentStep());
  check('外壳·数据状态：默认“示例交易 + Tushare 动态行情”，导航为“交易规则 / 分析问答”，页脚说明动态行情且不再写“非真实账户交易结果”',
    shell().includes('数据状态：示例交易 + Tushare 动态行情') && shell().includes('Tushare 最新已收盘日线（服务端获取，非实时）') && shell().includes('可在报告页切换到合成回归场景')
    && texts(els.nav).join('|').includes('交易规则') && texts(els.nav).join('|').includes('分析问答')
    && !texts(els.nav).join('|').includes('契约') && !texts(els.nav).join('|').includes('组合复述')
    && !texts(els['footer-labels']).join('|').includes('非真实账户交易结果') && texts(els['footer-labels']).join('|').includes('不构成投资建议')
    && texts(els['footer-labels']).join('|').includes('行情由服务端从 Tushare 获取最新已收盘日线（非实时）'), shell());
  check('外壳·顶部：常显动态行情状态，能力状态默认折叠且不出现 fake',
    visibleTexts(els['capability-chips']).join('|').includes('示例交易 + Tushare 动态行情')
    && visibleTexts(els['capability-chips']).join('|').includes('查看能力状态')
    && !visibleTexts(els['capability-chips']).join('|').includes('百炼')
    && findByClass(els['capability-chips'], 'cap-details')[0]?.tagName === 'DETAILS'
    && !texts(els['capability-chips']).join('|').includes('fake')
    && texts(els['capability-chips']).join('|').includes('Tushare 动态日线'), texts(els['capability-chips']).join('|').slice(0, 300));
  const adapterShell = await imp('src/demo/adapter.js');
  check('外壳·能力状态：动态行情在真实网络 E2E 验收前保持“待验收”（不得提前置 ready），标签照实说明示例与本地账单均走 Tushare 动态日线',
    adapterShell.CAPABILITY.marketCache.ready === false
    && texts(els['capability-chips']).join('|').includes('示例与本地账单均走 Tushare 动态日线（服务端获取，非实时）')
    && texts(els['capability-chips']).join('|').includes('待验收'), texts(els['capability-chips']).join('|').slice(0, 300));
  check('外壳·了解口径：折叠区解释估值日 / 择时损耗 / 反事实 / 阻断 / 证据', findByClass(els.flow, 'glossary')[0]?.tagName === 'DETAILS'
    && ['估值日', '择时损耗', '反事实', '阻断', '证据'].every((k) => shell().includes(k)) && shell().includes('不会改用其他日期'), shell().slice(-300));
  state.bill = { ...defaultBill(), status: 'loaded', sourceType: 'local', fileName: 'pending.csv' };
  await goHash('#/import');
  check('外壳·数据状态：待确认本地账单 → “待确认本地账单”（含文件名、尚未确认，不冒称已有行情）',
    shell().includes('数据状态：待确认本地账单') && !shell().includes('数据状态：待确认本地账单 +') && shell().includes('pending.csv') && shell().includes('尚未确认'), shell());
  state.bill = { ...defaultBill(), status: 'confirmed', sourceType: 'local', fileName: 'shell.csv' };
  await goHash('#/report');
  check('外壳·数据状态：已确认本地账单 → “已确认本地账单 + Tushare 动态行情”（含文件名、未上传），报告页为第 3 步',
    shell().includes('数据状态：已确认本地账单 + Tushare 动态行情') && shell().includes('shell.csv') && shell().includes('未上传') && currentStep() === '3 查看报告当前', shell());
  check('外壳·顶部·已确认本地账单：Tushare 动态行情 · 最新已收盘日线（非实时），不显示合成行情标签',
    visibleTexts(els['capability-chips']).join('|').includes('Tushare 动态行情 · 最新已收盘日线（非实时）')
    && !visibleTexts(els['capability-chips']).join('|').includes('合成行情'), texts(els['capability-chips']).join('|').slice(0, 300));
  check('外壳·页脚·已确认本地账单：Tushare 动态行情非实时，取数失败阻断不回退，金额使用不复权，前复权仅用于走势展示',
    texts(els['footer-labels']).join('|').includes('本地账单与示例均使用服务端从 Tushare 获取的最新已收盘日线（非实时），取数失败时阻断、不回落静态缓存')
    && texts(els['footer-labels']).join('|').includes('金额使用不复权价格、前复权仅用于走势展示')
    && !texts(els['footer-labels']).join('|').includes('合成演示数据') && texts(els['footer-labels']).join('|').includes('不构成投资建议'), texts(els['footer-labels']).join('|'));
  state.bill = { ...defaultBill(), status: 'invalid', sourceType: 'local', fileName: 'bad.csv', blocked: true };
  await goHash('#/import');
  check('外壳·数据状态：校验失败 → “阻断 · 本地账单不能分析”，导入页处于第 2 步核对交易',
    shell().includes('数据状态：阻断 · 本地账单不能分析') && shell().includes('不能用于分析') && currentStep() === '2 核对交易当前', shell());
  await goHash('#/contract');
  check('外壳：交易规则页为第 4 步“查看证据 / 设置规则”', currentStep() === '4 查看证据 / 设置规则当前', currentStep());
}

/* ==== 动态行情：出站隐私与单次标的上限 ==== */
{
  const adapterMod = await imp('src/demo/adapter.js');
  check('动态行情请求：全程只含 symbols/start/end，不含成交、价格、数量、文件名或 CSV 内容',
    marketCalls.length > 0 && marketCalls.every((c) => Object.keys(c).sort().join(',') === 'end,start,symbols'
      && /^\d{4}-\d{2}-\d{2}$/.test(c.start) && /^\d{4}-\d{2}-\d{2}$/.test(c.end)
      && c.symbols.every((s) => /^\d{6}$/.test(s))
      && !JSON.stringify(c).includes('csv') && !JSON.stringify(c).includes('T00') && !JSON.stringify(c).includes('quantity')),
    JSON.stringify(marketCalls));
  const many = Array.from({ length: 11 }, (_, i) => ({ symbol: String(600000 + i), trade_date: '2025-01-02' }));
  let limitError = null;
  try { adapterMod.marketScopeFromTrades(many); } catch (e) { limitError = e; }
  check('动态行情：超过单次 10 只标的 → 明确阻断（不截断、不用部分标的冒充完整组合）',
    !!limitError && limitError.message.includes('上限 10') && limitError.message.includes('不截断'), limitError && limitError.message);
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '   → ' + r.detail));
console.log('\n== 合计 ' + results.length + ' 项检查：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ==');
process.exitCode = failed.length ? 1 : 0;
