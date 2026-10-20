// 前端交互冒烟（零依赖：Node + 最小 DOM 桩；非产品代码，仅回归工具）
// 覆盖：导入/确认（演示账单 + 本地 CSV 本机校验）、报告切换（组合/标的/A′/差异）、对话离线、契约（引擎模板解析/确认改写拒绝/持久化/历史情境三态）、状态徽标色映射。
// 运行：npm run smoke
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const imp = (p) => import(new URL('../' + p, import.meta.url).href);

class FakeNode {}
function createTextNode(t) { const n = Object.create(FakeNode.prototype); n.__text = String(t); return n; }
function makeEl(tag) {
  const node = Object.create(FakeNode.prototype);
  node.tagName = String(tag).toUpperCase();
  node.children = []; node.attrs = {}; node.listeners = {}; node.value = ''; node.disabled = false;
  node.setAttribute = function (k, v) {
    this.attrs[k] = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'disabled') this.disabled = true;
  };
  node.getAttribute = function (k) { return this.attrs[k]; };
  node.addEventListener = function (type, fn) { (this.listeners[type] ??= []).push(fn); };
  node.append = function (...cs) { for (const c of cs) if (c != null) this.children.push(c); };
  node.replaceChildren = function (...cs) { this.children = cs.filter((c) => c != null); };
  node.remove = function () { this.__removed = true; };
  node.focus = function () { globalThis.__focused = this; };
  node.querySelector = function (sel) {
    const cls = sel.replace(/^\./, '');
    const walk = (n) => {
      for (const c of n.children) {
        if (!c || c.__text !== undefined) continue;
        if (String(c.attrs.class ?? '').split(/\s+/).includes(cls)) return c;
        const r = walk(c); if (r) return r;
      }
      return null;
    };
    return walk(this);
  };
  Object.defineProperty(node, 'className', {
    get() { return this.attrs.class ?? ''; },
    set(v) { this.attrs.class = String(v); },
  });
  return node;
}
globalThis.Node = FakeNode;
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

// 动态行情 fake：用签收缓存历史段裁剪出与服务端一致形状（artifact=market-cache-dynamic），
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
globalThis.fetch = async (url, options = {}) => {
  if (isMarketSnapshot(url)) {
    const body = JSON.parse(String(options.body ?? '{}'));
    marketCalls.push(body);
    return siteHttpResponse({ body: { ok: true, market: buildMarketFixture(body) } });
  }
  if (isSiteFunction(url)) {
    siteCalls.push({ url: String(url), options });
    const queued = siteQueue.shift();
    if (queued) return queued.promise ? queued.promise : siteHttpResponse(queued);
    return siteHttpResponse(siteResponse);
  }
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
}
globalThis.FileReader = FakeFileReader;

const { state, subscribe, notify, defaultBill, defaultChat, defaultContracts, loadContractsDemo } = await imp('src/state.js');
const { renderImport } = await imp('src/ui/views/importView.js');
const { renderReport } = await imp('src/ui/views/reportView.js');
const { renderChat } = await imp('src/ui/views/chatView.js');
const { renderContract } = await imp('src/ui/views/contractView.js');
const VIEWS = { import: renderImport, report: renderReport, chat: renderChat, contract: renderContract };

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
check('导入·准备账单：仅 CSV / 本机读取不上传 / 确认不下单 + 字段说明（与 csvNormalize 一致）',
  txt.includes('准备账单') && txt.includes('仅支持 CSV 文件') && txt.includes('原始 CSV 仅在本机读取和校验，不上传') && txt.includes('不会下单、不会执行交易')
  && txt.includes('日期（YYYY-MM-DD）') && txt.includes('标的（6 位数字代码）') && txt.includes('方向（买入 / 卖出）') && txt.includes('数量（正整数）')
  && txt.includes('可选列：费用、税费') && txt.includes('日期,标的,方向,价格,数量,费用,税费') && txt.includes('累计卖出不能超过累计买入'), txt.slice(0, 400));
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
  && txt.includes('估值日收盘价（合成行情）'), txt.slice(0, 320));
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

/* ==== 报告页：默认 Tushare 动态行情 R / R′（服务端拉取、非实时；最新交易日 2025-12-31）==== */
state.route = 'report';
state.report = { scenario: 'R', symbol: 'pool' };
state.bill = defaultBill();
mountCycle(); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('真实报告 R·组合：引擎输出 +5.4% / +4.8% / -0.7pp / ¥-2,805.00', txt.includes('+5.4%') && txt.includes('+4.8%') && txt.includes('-0.7pp') && txt.includes('¥-2,805.00'), txt.slice(0, 260));
check('真实报告 R·标注：Tushare 动态日线（服务端获取、非实时）/ 拉取时间 / 最新交易日 2025-12-31 / 快照与校验 / 不出现合成演示行情或已签收措辞',
  txt.includes('示例交易 + Tushare 动态日线（服务端获取，非实时）') && txt.includes('Tushare 动态日线（服务端获取，非实时）') && txt.includes('非实时')
  && txt.includes('拉取 ') && txt.includes('最新交易日 2025-12-31') && txt.includes('快照 tushare-20251231-01234567') && txt.includes('校验 0123456789ab…')
  && txt.includes('估值日：2025-12-31') && !txt.includes('合成演示数据（非真实账户') && !txt.includes('已签收'), txt.slice(0, 500));
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

/* ==== 对话页：组合四事实在线复述（站点同源 fake；不调用百炼） ==== */
{
  const chatOnlineMod = await imp('src/agent/chatOnline.js');
  const chatCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,600519,买入,1488.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n';
  const chatCsv2 = chatCsv;
  const chatCsv3 = chatCsv;
  const answerCsv1 = '组合实际收益 -6.6%，对照收益 -7.4%，择时损耗 -0.8pp，损耗金额 ¥-1,254.00。';
  const answerCsv2 = answerCsv1;
  const answerCsv3 = answerCsv1;
  const settleChat = async () => { for (let i = 0; i < 8; i++) await flush(); };
  const lastAssistant = () => state.chat.messages.filter((m) => m.role === 'assistant').at(-1) ?? null;
  const pageTxt = () => texts(current).join('|');
  const chatButton = () => findButtons(current).find((b) => labelOf(b) === '组合整体表现如何？');
  const startChatSend = () => {
    const b = chatButton();
    if (!b) throw new Error('找不到对话发送按钮');
    return b.listeners.click[0]({});
  };
  const importChatBill = async (name, csv) => {
    state.route = 'import'; mountCycle();
    await pickFile({ name, size: csv.length, __content: csv }); await flush();
    await clickLabel('确认交易列表'); await flush(); await flush(); await flush();
    return state.bill.contextId;
  };
  const waitForSiteCalls = async (expected) => {
    for (let i = 0; i < 30 && siteCalls.length < expected; i++) await flush();
  };

  /* 1) 未确认本地账单：不发起在线请求，明确兜底 */
  state.route = 'chat'; state.bill = defaultBill(); state.chat = defaultChat(); mountCycle();
  check('对话·范围提示：中文标题/仅支持组合整体表现/真实验证未完成/不展示模型原文；内部范围与错误码在详情',
    visibleTexts(current).join('|').includes('分析问答') && visibleTexts(current).join('|').includes('当前仅支持组合整体表现')
    && visibleTexts(current).join('|').includes('尚未完成真实服务验证') && visibleTexts(current).join('|').includes('不展示模型原文')
    && !visibleTexts(current).join('|').includes('loss_overview') && !visibleTexts(current).join('|').includes('portfolio')
    && pageTxt().includes('内部范围：loss_overview · portfolio'), pageTxt().slice(0, 300));
  const callsBeforeBill = siteCalls.length;
  await clickLabel('组合整体表现如何？'); await settleChat();
  {
    const a = lastAssistant();
    check('对话·未确认账单：固定兜底 + 明确原因，不发起在线请求',
      state.chat.messages.length === 2 && !!a && a.text === chatOnlineMod.CHAT_ONLINE_FALLBACK_TEXT
      && a.tag.includes('已兜底') && a.detail.includes('W_CHAT_BILL_NOT_CONFIRMED') && siteCalls.length === callsBeforeBill,
      JSON.stringify(state.chat));
  }

  /* 2) 已确认本地账单 + fake 成功：仅展示通过数字校验的复述 */
  const context1 = await importChatBill('chat-bill.csv', chatCsv);
  state.route = 'chat'; state.chat = defaultChat(state.bill.contextId); mountCycle();
  const okAnswer = answerCsv1;
  siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: okAnswer }) } };
  await clickLabel('组合整体表现如何？'); await settleChat();
  {
    const a = lastAssistant();
    const call = siteCalls.at(-1);
    const body = call ? JSON.parse(call.options.body) : null;
    check('对话·在线成功：仅展示通过本地数字校验的复述 + 成功标签 + 账单来源',
      state.bill.contextId === context1 && state.chat.contextId === context1
      && state.chat.messages.length === 2 && !!a && a.text === okAnswer
      && a.tag.includes('本地数字校验通过') && a.detail.includes('已核对 4 个可识别数字')
      && pageTxt().includes('已确认本地账单 · chat-bill.csv'), JSON.stringify(state.chat));
    check('对话·同源 transport：POST /functions/v1/app/api/llm/restate，body 仅 question + F-6 四事实',
      !!call && call.url === '/functions/v1/app/api/llm/restate' && call.options.method === 'POST'
      && Object.keys(body).join(',') === 'question,facts' && body.facts.length === 4
      && body.facts.every((f) => Object.keys(f).every((k) => ['value', 'unit', 'display', 'formula_ref', 'source_ref'].includes(k)))
      && body.facts.every((f) => !('key' in f) && !('fact_ref' in f) && !('scope' in f))
      && body.facts.every((f) => ['%', 'pp', '元'].includes(f.unit)), JSON.stringify({ url: call && call.url, body }));
    check('对话·出站不含账单文件名/成交/复核痕迹，请求头无 Key，pending 复位',
      !JSON.stringify(body).includes('chat-bill.csv') && !JSON.stringify(body).includes('T001')
      && !JSON.stringify(body).includes('provenance')
      && !Object.keys(call.options.headers).some((h) => /authorization|api[-_]?key/i.test(h))
      && state.chat.pending === false);
  }

  /* 3) 伪造数字：固定兜底，不回显候选数字 */
  siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: '组合实际收益 +99.9%。' }) } };
  state.chat = defaultChat(state.bill.contextId); mountCycle();
  await clickLabel('组合整体表现如何？'); await settleChat();
  {
    const a = lastAssistant();
    check('对话·数字失败：固定兜底、不回显候选数字',
      state.chat.messages.length === 2 && !!a && a.text === chatOnlineMod.CHAT_ONLINE_FALLBACK_TEXT
      && a.tag.includes('已兜底') && a.detail.includes('W_ANSWER_NUMBERS_FAILED') && a.detail.includes('未通过 1')
      && !JSON.stringify(state.chat).includes('99.9') && !pageTxt().includes('99.9'), JSON.stringify(state.chat));
  }

  /* 4) 站点函数未就绪（503）：明确兜底，不展示任何模型文本 */
  siteResponse = { status: 503, body: {} };
  state.chat = defaultChat(state.bill.contextId); mountCycle();
  await clickLabel('组合整体表现如何？'); await settleChat();
  {
    const a = lastAssistant();
    check('对话·服务未就绪：E_HTTP_STATUS 兜底，不展示模型文本',
      state.chat.messages.length === 2 && !!a && a.text === chatOnlineMod.CHAT_ONLINE_FALLBACK_TEXT
      && a.detail.includes('E_HTTP_STATUS') && a.detail.includes('函数未发布'), JSON.stringify(state.chat));
  }
  siteResponse = { status: 200, body: { rawText: JSON.stringify({ answer_text: '' }) } };

  /* 5) 已完成回答后更换账单（同名重导入）：旧回答不再展示 */
  const contextBeforeReplace = state.bill.contextId;
  const context2 = await importChatBill('chat-bill.csv', chatCsv2);
  check('对话·换账单（同名重导入）：生成新上下文并清理旧聊天',
    context2 !== contextBeforeReplace && state.bill.fileName === 'chat-bill.csv'
    && state.bill.contextId === context2 && state.chat.contextId === context2
    && state.chat.messages.length === 0 && state.chat.pending === false, JSON.stringify(state.chat));
  state.route = 'chat'; mountCycle();
  check('对话·换账单：旧回答不再展示',
    !pageTxt().includes('+4.0%') && !pageTxt().includes('¥400.00') && !pageTxt().includes(answerCsv1), pageTxt().slice(0, 300));

  /* 6) 请求未完成时更换账单：旧响应返回后不污染新聊天状态 */
  const contextBeforePending = state.bill.contextId;
  const callsBeforeOld = siteCalls.length;
  const oldDeferred = deferredSiteResponse({ rawText: JSON.stringify({ answer_text: answerCsv2 }) });
  siteQueue.push(oldDeferred);
  state.route = 'chat'; mountCycle();
  const oldPending = startChatSend();
  await waitForSiteCalls(callsBeforeOld + 1);
  check('对话·待定请求：已发出且 pending',
    state.chat.pending === true && state.chat.contextId === contextBeforePending && siteCalls.length === callsBeforeOld + 1,
    JSON.stringify(state.chat));

  const context3 = await importChatBill('chat-bill.csv', chatCsv3);
  check('对话·请求未完成时换账单：清空旧聊天并生成新上下文',
    context3 !== contextBeforePending && state.bill.contextId === context3 && state.chat.contextId === context3
    && state.chat.messages.length === 0 && state.chat.pending === false, JSON.stringify(state.chat));

  const callsBeforeNew = siteCalls.length;
  const newDeferred = deferredSiteResponse({ rawText: JSON.stringify({ answer_text: answerCsv3 }) });
  siteQueue.push(newDeferred);
  state.route = 'chat'; mountCycle();
  const newPending = startChatSend();
  await waitForSiteCalls(callsBeforeNew + 1);
  check('对话·新上下文请求 pending',
    state.chat.pending === true && state.chat.messages.length === 1 && state.chat.messages[0].role === 'user',
    JSON.stringify(state.chat));

  oldDeferred.resolve();
  await oldPending; await flush();
  check('对话·旧响应返回：不追加回答、不覆盖新 pending',
    state.chat.messages.length === 1 && state.chat.messages[0].role === 'user'
    && state.chat.pending === true && !JSON.stringify(state.chat).includes(answerCsv2), JSON.stringify(state.chat));

  newDeferred.resolve();
  await newPending; await settleChat();
  {
    const a = lastAssistant();
    check('对话·新响应正常写回',
      state.chat.pending === false && state.chat.messages.length === 2 && !!a && a.text === answerCsv3
      && a.tag.includes('本地数字校验通过'), JSON.stringify(state.chat));
  }

  // 恢复对话前的演示账单已确认态，避免影响后续契约情境用例
  state.bill = { ...defaultBill(), status: 'confirmed' };
  state.chat = defaultChat();
}

/* ==== 契约页：当前规则（每种类型一条）→ 新增 / 修改弹窗 → 历史规则 → 历史情境测试（合成行情）==== */
const fire = async (node, type, value) => { node.value = value; for (const fn of node.listeners[type] ?? []) await fn({ target: { value } }); };
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
const cardDetail = (hash) => { const n = ruleCardOf(hash); const d = n ? findByClass(n, 'cv-rule-detail')[0] : null; return d ? texts(d).join('|') : ''; };
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
{
  const adapterMod = await imp('src/demo/adapter.js');
  const viewSrc = readFileSync(join(ROOT, 'src/ui/views/contractView.js'), 'utf8');
  check('契约：页面只经 adapter 取数（不 import contractMatch / marketCache / engine），当前 / 历史划分由 adapter 提供（页面不自行比较版本或排序），旧的并行 / 整理接口已移除',
    !/from\s+['"][^'"]*engine\//.test(viewSrc) && !viewSrc.includes('contractMatch') && !viewSrc.includes('marketCache') && !viewSrc.includes('.activated') && !/\.sort\(/.test(viewSrc)
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
    check('默认布局：当前生效规则（0）空状态 + 两种类型各显示“暂未设置 / 新增此类规则”；历史规则默认折叠“历史规则（0）”；无并行 / 整理 / 替换选择字样',
      txt.includes('当前生效规则（0）') && txt.includes('暂无当前生效的规则') && slotHashes('no_buy_on_surge').length === 0
      && texts(slotNode('no_buy_back_within')).join('|').includes('暂未设置「卖出后 N 个交易日内不追回」规则') && findButtons(current).filter((b) => labelOf(b) === '新增此类规则').length === 2
      && hist.tagName === 'DETAILS' && hist.attrs.open === undefined && texts(hist).join('|').includes('历史规则（0）')
      && !txt.includes('同时保留') && !txt.includes('整理此组') && !txt.includes('替换旧规则（推荐）') && !txt.includes('并行'), txt.slice(0, 300));
  }

  /* —— 2. 新增弹窗：出现 / 预览 / 参数错误 / 取消 / Esc / 关闭 —— */
  await clickRole('add-rule');
  {
    const m = modalNode();
    check('新增弹窗：出现“新增交易规则”（role=dialog、aria-modal、打开即获得焦点），背景页面设为 inert；含模板选择（2 个）、参数、备注、实时预览，按钮“取消 / 保存并启用”',
      !!m && m.attrs.role === 'dialog' && m.attrs['aria-modal'] === 'true' && globalThis.__focused === m && modalTxt().includes('新增交易规则')
      && findByClass(current, 'cv-page')[0].attrs.inert === '' && findByTag(byRole('template'), 'option').length === 2
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
  check('当前规则卡默认视图：“已启用”+ 规则名称 + 规则文本 + 触发条件 + 弱化版本号 + 修改 / 停用；不显示哈希 / 占位算法 / M0-C1 / 模板字段名 / 原始状态',
    cardVisible(hS3).includes('已启用') && cardVisible(hS3).includes('涨幅超阈值不买入') && cardVisible(hS3).includes('当天涨幅超过 3% 的票，我绝不买入。')
    && cardVisible(hS3).includes('触发条件：申报买入当天涨幅超过 3.0%') && cardVisible(hS3).includes('版本 v1') && cardVisible(hS3).includes('查看详情')
    && findButtons(ruleCardOf(hS3)).some((b) => labelOf(b) === '修改') && findButtons(ruleCardOf(hS3)).some((b) => labelOf(b) === '停用')
    && !cardVisible(hS3).includes(hS3) && !cardVisible(hS3).includes('候选哈希') && !cardVisible(hS3).includes('fnv1a64') && !cardVisible(hS3).includes('M0-C1')
    && !cardVisible(hS3).includes('涨幅阈值（%）') && !cardVisible(hS3).includes('已确认') && !cardVisible(hS3).includes('历史状态变更'), cardVisible(hS3));
  check('当前规则卡详情（展开后）：版本号、完整候选哈希、占位算法与待 M0-C1 冻结提示、创建 / 最近变更时间、备注、历史状态变更',
    cardDetail(hS3).includes('版本 v1') && cardDetail(hS3).includes(`候选哈希，待 M0-C1 冻结：${hS3}`) && cardDetail(hS3).includes('fnv1a64-placeholder') && cardDetail(hS3).includes('待 M0-C1 冻结后可能替换')
    && cardDetail(hS3).includes('创建时间：') && cardDetail(hS3).includes('最近状态变更：') && cardDetail(hS3).includes('备注（不参与规则判定）：追高总亏')
    && cardDetail(hS3).includes('历史状态变更：') && cardDetail(hS3).includes('涨幅阈值（%）：3'), cardDetail(hS3).slice(0, 400));
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
    const head = findByClass(current, 'cv-sim-headline')[0];
    check('测试：两种类型的当前规则各判定一次，结果顶部列出“本次测试使用的规则”（名称 / 规则文本 / 版本），无并行 / 重复提醒 / 整理字样',
      sameSet(simHashes(), [hS3, hB5]) && texts(head).join('') === '本次测试：2 条规则中，命中 1 条 / 未命中 1 条 / 数据不足 0 条'
      && s.includes('本次测试使用的规则：涨幅超阈值不买入「当天涨幅超过 3% 的票，我绝不买入。」（版本 v1）；卖出后 N 个交易日内不追回「卖出后 5 个交易日内不追回同一只票。」（版本 v2）')
      && summaryOf('triggered') === '命中 1 条' && summaryOf('error') === '无法判定 0 条' && !s.includes('并行') && !s.includes('可能重复') && !s.includes('整理'), s.slice(0, 400));
  }
  check('测试·不追回：000000 2024-10-10（距卖出 2 日 ≤ 5）→ 命中 + 规则 / 阈值 / 情境事实 / 警告 / 候选哈希 / 演示来源；涨幅 3% 未命中且不使用账单交易',
    verdictOf(hB5) === '命中' && ruleTxt(hB5).includes('规则提醒：此情境命中你确认的规则') && ruleTxt(hB5).includes('规则：卖出后 5 个交易日内不追回同一只票。') && ruleTxt(hB5).includes('阈值：5 个交易日')
    && ruleTxt(hB5).includes('最近卖出：T004 · 2024-10-08') && ruleTxt(hB5).includes('距最近卖出：2 个交易日') && txt.includes('合成回归行情 · 不构成投资建议')
    && ruleTxt(hB5).includes(`候选哈希，待 M0-C1 冻结：${hB5}`) && ruleTxt(hB5).includes('交易来源：演示账单 A')
    && verdictOf(hS3) === '未命中' && ruleTxt(hS3).includes('未超过阈值 3.0%') && !ruleTxt(hS3).includes('规则提醒') && ruleTxt(hS3).includes('涨幅模板不使用账单交易'), ruleTxt(hB5).slice(0, 400));

  /* —— 4. 修改涨幅 3% → 5%：自动替代 —— */
  await clickIn(ruleCardOf(hS3), '修改');
  check('修改弹窗：标题“修改交易规则”，带入该规则的模板（不可更换类型）、参数 3 与备注；说明正在修改当前规则、不改写历史；按钮“保存并替换当前规则”+ 替换说明',
    modalTxt().includes('修改交易规则') && !byRole('template') && modalTxt().includes('规则模板（修改时不能更换类型）') && modalTxt().includes('涨幅超阈值不买入')
    && fieldInput('threshold_pct').value === '3' && byRole('note').value === '追高总亏'
    && modalTxt().includes('正在修改当前规则「当天涨幅超过 3% 的票，我绝不买入。」（版本 v1）') && modalTxt().includes('历史版本保持原样，不会被改写')
    && labelOf(roleBtn('modal-save')) === '保存并替换当前规则' && modalTxt().includes('保存后，新规则会立即生效；当前同类型规则会进入历史记录，不再参与测试。')
    && !modalTxt().includes('同时保留') && !modalTxt().includes('整理'), modalTxt().slice(0, 400));
  check('修改弹窗·未改参数：与当前规则相同 → 保存不可点（同一哈希不重复保存、备注不能单独形成新规则）',
    roleBtn('modal-save').disabled === true && modalTxt().includes('与当前规则相同：同一规则不会重复保存'), modalTxt().slice(-200));
  await fire(fieldInput('threshold_pct'), 'input', '5');
  check('修改弹窗：改为 5 → 预览 5%、可保存，提示生成版本 v3', hashOf(liveTxt()) === hS5 && roleBtn('modal-save').disabled === false && modalTxt().includes('保存后生成版本 v3'), modalTxt().slice(-200));
  await saveModal();
  {
    const [newRec, oldRec] = stored().slice(2);
    check('修改·写入：追加新规则 v3（已改写，from_v=1，replaces_v=[1]）+ 旧 3% 追加一条“已拒绝 · 经替代”状态记录（仍为 v1，replaced_by_v=3）；原记录未改写、未删除',
      stored().length === 4 && newRec.hash === hS5 && newRec.v === 3 && newRec.status === '已改写' && newRec.from_v === 1 && JSON.stringify(newRec.replaces_v) === '[1]'
      && oldRec.hash === hS3 && oldRec.v === 1 && oldRec.status === '已拒绝' && oldRec.via === '替代' && oldRec.replaced_by_v === 3 && oldRec.replaced_by_hash === hS5 && oldRec.transition_from === '已确认'
      && JSON.stringify(stored()[0]) === firstRec, JSON.stringify(stored().slice(2)).slice(0, 400));
  }
  txt = texts(current).join('|');
  check('修改涨幅 3%→5%：只保留 5% 为当前（买入限制一条，版本 v3），3% 进入历史并标注“已被当前规则替代，不参与后续测试。”可恢复；不追回 5 日不受影响',
    sameSet(enabledHashes(), [hS5, hB5]) && slotHashes('no_buy_on_surge').join() === hS5 && cardVisible(hS5).includes('已启用') && cardVisible(hS5).includes('版本 v3')
    && histHashes().join() === hS3 && histState(hS3) === 'replaced' && histVisible(hS3).includes('已被替代') && histVisible(hS3).includes('已被当前规则替代，不参与后续测试。')
    && histVisible(hS3).includes('恢复为当前规则') && txt.includes('历史规则（1）') && slotHashes('no_buy_back_within').join() === hB5, JSON.stringify({ on: enabledHashes(), hist: histHashes() }));
  check('历史规则详情：被替代规则可展开查看完整详情（候选哈希、备注、“被同类型规则 v3 替代”的状态变更）',
    (() => { const d = findByClass(histOf(hS3), 'cv-rule-detail')[0]; const t = d ? texts(d).join('|') : ''; return d.tagName === 'DETAILS' && t.includes(hS3) && t.includes('追高总亏') && t.includes('被同类型规则 v3 替代，未新增版本'); })(),
    texts(findByClass(histOf(hS3), 'cv-rule-detail')[0] ?? { children: [] }).join('|').slice(0, 300));
  s = await simulate('000000', '2024-09-30');
  check('修改后测试：只使用涨幅 5%（不含 3%）与不追回 5 日；000000 2024-09-30 涨约 +4% → 5% 未命中',
    sameSet(simHashes(), [hS5, hB5]) && verdictOf(hS5) === '未命中' && ruleTxt(hS5).includes('未超过阈值 5.0%') && !s.includes('当天涨幅超过 3% 的票'), JSON.stringify(simHashes()));

  /* —— 5. 修改不追回 5 日 → 3 日 —— */
  await clickIn(ruleCardOf(hB5), '修改');
  check('修改弹窗·不追回：带入 5 日', fieldInput('days').value === '5' && !byRole('template') && labelOf(roleBtn('modal-save')) === '保存并替换当前规则', modalTxt().slice(0, 200));
  await fire(fieldInput('days'), 'input', '3');
  await saveModal();
  check('修改不追回 5 日→3 日：只保留 3 日为当前（v4，已改写），5 日进入历史（已被当前规则替代）；涨幅 5%（v3）不受影响、未追加任何记录',
    sameSet(enabledHashes(), [hS5, hB3]) && slotHashes('no_buy_back_within').join() === hB3 && sameSet(histHashes(), [hS3, hB5]) && histState(hB5) === 'replaced'
    && histVisible(hB5).includes('已被当前规则替代，不参与后续测试。') && stored().length === 6 && stored().filter((r) => r.hash === hS5).length === 1
    && cardVisible(hB3).includes('版本 v4') && cardVisible(hB3).includes('触发条件：卖出后 3 个交易日内再次买入同一标的') && stored()[4].status === '已改写', JSON.stringify(stored().slice(4)).slice(0, 300));
  s = await simulate('000000', '2024-10-10');
  check('修改后测试：不追回只用 3 日（命中，距卖出 2 日），5 日不参与', sameSet(simHashes(), [hS5, hB3]) && verdictOf(hB3) === '命中' && ruleTxt(hB3).includes('距最近卖出：2 个交易日') && ruleTxt(hB3).includes('阈值：3 个交易日'), JSON.stringify(simHashes()));

  /* —— 6. 用“新增规则”保存已有类型：同样自动替代，不出现选择 —— */
  await clickRole('add-rule');
  await fire(fieldInput('threshold_pct'), 'input', '4');
  check('新增已有类型（涨幅 4%）：按钮“保存并启用”，并明确说明已有同类型当前规则（v3）会进入历史；不出现“同时保留 / 替换旧规则（推荐）/ 整理此组”',
    labelOf(roleBtn('modal-save')) === '保存并启用' && modalTxt().includes('已有同类型当前规则（版本 v3）。保存后，新规则会立即生效；当前同类型规则会进入历史记录，不再参与测试。')
    && !modalTxt().includes('同时保留') && !modalTxt().includes('替换旧规则（推荐）') && !modalTxt().includes('整理此组'), modalTxt().slice(-300));
  await saveModal();
  check('新增已有类型：涨幅 4%（v5）自动成为唯一涨幅当前规则，5%（v3）进入历史；更早的 3%（v1）改为“已被新规则（版本 v3）替代”',
    sameSet(enabledHashes(), [hS4, hB3]) && histState(hS5) === 'replaced' && stored().length === 8 && cardVisible(hS4).includes('版本 v5')
    && histVisible(hS3).includes('已被新规则（版本 v3）替代，不参与后续测试。'), JSON.stringify(enabledHashes()));

  /* —— 7. 从历史恢复 —— */
  {
    const n0 = stored().length;
    check('恢复提示：历史 3% 显示“恢复后，当前同类型规则（版本 v5）会进入历史规则。”', histVisible(hS3).includes('恢复后，当前同类型规则（版本 v5）会进入历史规则。'), histVisible(hS3));
    await clickIn(histOf(hS3), '恢复为当前规则'); await settle();
    const [restoreRec, retireRec] = stored().slice(n0);
    check('恢复历史规则：3%（v1）成为涨幅唯一当前规则（版本号不变，追加“经恢复”状态记录），原当前 4%（v5）追加“经替代”记录进入历史；不追回 3 日不受影响',
      sameSet(enabledHashes(), [hS3, hB3]) && slotHashes('no_buy_on_surge').join() === hS3 && cardVisible(hS3).includes('版本 v1') && stored().length === n0 + 2
      && restoreRec.hash === hS3 && restoreRec.v === 1 && restoreRec.via === '恢复' && restoreRec.status === '已确认' && restoreRec.transition_from === '已拒绝'
      && retireRec.hash === hS4 && retireRec.v === 5 && retireRec.via === '替代' && retireRec.replaced_by_v === 1 && histState(hS4) === 'replaced'
      && histVisible(hS4).includes('已被当前规则替代') && maxV() === 5, JSON.stringify(stored().slice(n0)).slice(0, 300));
    await reload();
    check('恢复后刷新：当前规则仍为 3%（v1）+ 不追回 3 日（v4），历史为 5% / 4% / 不追回 5 日，记录数不变', sameSet(enabledHashes(), [hS3, hB3]) && sameSet(histHashes(), [hS5, hS4, hB5])
      && state.contracts.versions.length === n0 + 2, JSON.stringify({ on: enabledHashes(), hist: histHashes() }));
  }

  /* —— 8. 测试语义回归（命中 / 缺价 / 超范围 / 输入无效 / 日历外）—— */
  s = await simulate('000000', '2024-09-30');
  check('测试·涨幅：000000 2024-09-30 → 3% 命中 + 规则 / 阈值 3.0% / 当日涨跌幅（引擎 display）/ 前收日 / 不复权 / 合成行情',
    verdictOf(hS3) === '命中' && ruleTxt(hS3).includes('规则提醒') && ruleTxt(hS3).includes('规则：当天涨幅超过 3% 的票，我绝不买入。') && ruleTxt(hS3).includes('阈值：3.0%')
    && /当日涨跌幅：\+4\.\d+%/.test(ruleTxt(hS3)) && ruleTxt(hS3).includes('前收日 2024-09-27') && ruleTxt(hS3).includes('不复权') && txt.includes('合成回归行情 · 不构成投资建议'), ruleTxt(hS3).slice(0, 400));
  s = await simulate('000000', '2024-10-08');
  check('测试·涨幅：000000 2024-10-08 → 未命中', verdictOf(hS3) === '未命中' && ruleTxt(hS3).includes('未超过阈值 3.0%') && !ruleTxt(hS3).includes('规则提醒'), ruleTxt(hS3).slice(0, 300));
  s = await simulate('888888', '2024-10-10');
  check('测试·涨幅：888888 2024-10-10 缺价 → 数据不足（E_CHANGE_PCT_MISSING + 引擎原因，不补造）',
    verdictOf(hS3) === '数据不足' && ruleTxt(hS3).includes('E_CHANGE_PCT_MISSING') && ruleTxt(hS3).includes('缺 888888 收盘价') && !ruleTxt(hS3).includes('当日涨跌幅：') && !ruleTxt(hS3).includes('规则提醒'), ruleTxt(hS3).slice(0, 300));
  s = await simulate('000000', '2024-09-23');
  check('测试·涨幅：缓存首日 → 数据不足（E_PREV_DAY_BEYOND_CACHE 前收不足）', verdictOf(hS3) === '数据不足' && ruleTxt(hS3).includes('E_PREV_DAY_BEYOND_CACHE'), ruleTxt(hS3).slice(0, 300));
  s = await simulate('000000', '2024-11-05');
  check('测试·涨幅：超出缓存范围 → 数据不足（E_VALUATION_OUT_OF_RANGE，不回退）', verdictOf(hS3) === '数据不足' && ruleTxt(hS3).includes('E_VALUATION_OUT_OF_RANGE'), ruleTxt(hS3).slice(0, 300));
  s = await simulate('000000', '');
  check('测试：日期为空 → 涨幅规则“无法判定”并显示引擎输入错误（不默认日期），计入汇总“无法判定 1 条”',
    verdictOf(hS3) === '无法判定' && ruleTxt(hS3).includes('E_CONTRACT_SIM_INPUT_INVALID') && summaryOf('error') === '无法判定 1 条', ruleTxt(hS3).slice(0, 300));
  s = await simulate('000000', '2024-10-05');
  check('测试·不追回：2024-10-05 不在交易日历 → 数据不足（E_DATE_NOT_IN_CALENDAR，不猜测）', verdictOf(hB3) === '数据不足' && ruleTxt(hB3).includes('E_DATE_NOT_IN_CALENDAR')
    && ruleTxt(hB3).includes('不在缓存交易日历') && !ruleTxt(hB3).includes('规则提醒') && simHashes().length === 2, ruleTxt(hB3).slice(0, 300));

  /* —— 9. 同一哈希不新增版本：修改为历史已有参数 = 恢复该版本 —— */
  await clickIn(ruleCardOf(hS3), '修改');
  await fire(fieldInput('threshold_pct'), 'input', '5');
  check('修改为历史已有参数（5%）：提示与历史版本 v3 相同，保存将恢复该版本、不新增版本号', modalTxt().includes('与历史版本 v3 相同：保存后将恢复该版本为当前规则，不新增版本号。') && roleBtn('modal-save').disabled === false, modalTxt().slice(-300));
  {
    const n1 = stored().length;
    await saveModal();
    check('同一哈希重复保存不新增版本：5% 以原版本 v3 恢复为当前（经恢复），3%（v1）经替代进入历史，最大版本号仍为 5',
      sameSet(enabledHashes(), [hS5, hB3]) && cardVisible(hS5).includes('版本 v3') && maxV() === 5 && stored().length === n1 + 2 && stored().at(-2).via === '恢复' && stored().at(-2).v === 3
      && stored().at(-1).hash === hS3 && stored().at(-1).via === '替代', JSON.stringify(stored().slice(n1)).slice(0, 300));
  }

  /* —— 10. 停用（二次确认）→ 进入历史 → 恢复 —— */
  {
    const n2 = stored().length;
    await clickIn(ruleCardOf(hB3), '停用');
    check('停用确认：先出现简短确认（说明进入历史规则、不再参与测试、可恢复），未写入记录',
      stored().length === n2 && cardVisible(hB3).includes('确认停用“卖出后 3 个交易日内不追回同一只票。”？') && cardVisible(hB3).includes('停用后，该规则进入历史规则，不再参与之后的历史情境测试；可随时恢复为当前规则。'), cardVisible(hB3));
    await clickIn(ruleCardOf(hB3), '取消');
    check('停用确认：取消后恢复原状，不写入记录', stored().length === n2 && enabledHashes().includes(hB3) && !cardVisible(hB3).includes('确认停用'), cardVisible(hB3));
    await disableRule(hB3);
    check('停用：不追回 3 日（v4）追加“已拒绝 · 手动停用”（版本号不变），进入历史“已停用，不参与后续测试。”；卖出后限制显示“暂未设置 / 新增此类规则”',
      !enabledHashes().includes(hB3) && histState(hB3) === 'stopped' && histVisible(hB3).includes('已停用，不参与后续测试。') && histVisible(hB3).includes('恢复为当前规则')
      && stored().length === n2 + 1 && stored().at(-1).v === 4 && stored().at(-1).via === '停用' && stored().at(-1).status === '已拒绝'
      && texts(slotNode('no_buy_back_within')).join('|').includes('暂未设置「卖出后 N 个交易日内不追回」规则') && sellsLine() === '', JSON.stringify(stored().at(-1)).slice(0, 200));
    s = await simulate('000000', '2024-10-10');
    check('停用后测试：只剩涨幅 5%（1 条）', simHashes().join() === hS5 && s.includes('本次测试：1 条规则中'), JSON.stringify(simHashes()));
    await clickIn(histOf(hB3), '恢复为当前规则'); await settle();
    check('恢复已停用规则：不追回 3 日以原版本 v4 回到当前（经恢复），不新增版本号', enabledHashes().includes(hB3) && cardVisible(hB3).includes('版本 v4') && stored().at(-1).via === '恢复' && stored().at(-1).v === 4 && maxV() === 5,
      JSON.stringify(stored().at(-1)).slice(0, 200));
  }

  /* —— 11. 旧的同类型并行规则：按“最新保存优先”派生，不删记录、不要求整理 —— */
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
    check('旧并行规则迁移：载入后每种类型只取最新保存的一条为当前（涨幅 5% v2、不追回 5 日 v4），较旧的 3% / 3 日归入历史“已被较新的同类型规则替代”；本地记录未删除、未改写（仍 4 条）',
      sameSet(enabledHashes(), [hS5, hB5]) && sameSet(histHashes(), [hS3, hB3]) && [hS3, hB3].every((h) => histState(h) === 'superseded' && histVisible(h).includes('已被较新的同类型规则替代，不参与后续测试。') && histVisible(h).includes('恢复为当前规则'))
      && state.contracts.versions.length === 4 && JSON.stringify(stored()) === JSON.stringify(pre) && txt.includes('当前生效规则（2）') && !txt.includes('整理此组') && !txt.includes('同时保留'), JSON.stringify({ on: enabledHashes(), hist: histHashes() }));
    s = await simulate('000000', '2024-10-10');
    check('旧并行规则迁移·测试：只使用每种类型最新的一条（5% 与 5 日），3% / 3 日不参与，无重复提醒提示', sameSet(simHashes(), [hS5, hB5]) && !s.includes('重复'), JSON.stringify(simHashes()));
    await reload();
    check('旧并行规则迁移·刷新稳定：再次载入划分相同、记录仍 4 条', sameSet(enabledHashes(), [hS5, hB5]) && sameSet(histHashes(), [hS3, hB3]) && stored().length === 4, JSON.stringify(enabledHashes()));
    await clickIn(histOf(hS3), '恢复为当前规则'); await settle();
    check('旧并行规则·恢复较旧的 3%：成为唯一涨幅当前规则，5%（v2）追加“经替代”记录进入历史；不会制造同类型并行，不追回组不受影响',
      sameSet(enabledHashes(), [hS3, hB5]) && slotHashes('no_buy_on_surge').join() === hS3 && histState(hS5) === 'replaced' && histState(hB3) === 'superseded'
      && JSON.stringify(stored().slice(4).map((r) => [r.hash, r.via, r.v])) === JSON.stringify([[hS3, '恢复', 1], [hS5, '替代', 2]]), JSON.stringify(stored().slice(4)).slice(0, 300));
    await disableRule(hB5);
    check('旧并行规则·停用当前 5 日：较旧的 3 日不会“复活”为当前（同时补追加替代记录），卖出后限制变为“暂未设置”',
      !enabledHashes().includes(hB5) && !enabledHashes().includes(hB3) && histState(hB5) === 'stopped' && histState(hB3) === 'replaced' && stored().length === 8
      && stored().at(-2).hash === hB5 && stored().at(-2).via === '停用' && stored().at(-1).hash === hB3 && stored().at(-1).via === '替代', JSON.stringify(stored().slice(6)).slice(0, 300));
    await reload();
    check('旧并行规则·停用后刷新稳定：当前只有涨幅 3%', enabledHashes().join() === hS3 && stored().length === 8, JSON.stringify(enabledHashes()));
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
  check('早期重复记录：同一哈希的 v4/v5/v6 合并为一条当前规则（版本 v4，详情注明早期重复记录 v5、v6），本地数据未删除',
    enabledHashes().join() === dup.hash && cardVisible(dup.hash).includes('版本 v4') && cardDetail(dup.hash).includes('早期重复记录') && cardDetail(dup.hash).includes('v5、v6') && stored().length === 3, cardDetail(dup.hash).slice(0, 300));
  await clickRole('add-rule');
  await fire(byRole('template'), 'change', 'no_buy_on_surge');
  check('同一哈希不重复保存：新增弹窗选涨幅模板（默认 5%）与当前规则相同 → 保存不可点', roleBtn('modal-save').disabled === true && modalTxt().includes('与当前规则相同'), modalTxt().slice(-200));
  await fire(fieldInput('threshold_pct'), 'input', '6');
  await saveModal();
  const h6 = H('no_buy_on_surge', { threshold_pct: '6' });
  check('早期重复记录后修改：新版本 v7（已改写）成为当前，v4 进入历史，旧记录全部保留', enabledHashes().join() === h6 && cardVisible(h6).includes('版本 v7') && histState(dup.hash) === 'replaced' && stored().length === 5, JSON.stringify(stored().map((r) => r.v)));
  {
    const badHash = '0123456789abcdef';
    state.contracts = { ...defaultContracts(), marketSource: 'synthetic-fixture', versions: [...state.contracts.versions, { ...dupRec(8, '2026-10-02T00:00:00Z'), hash: badHash }] }; mountCycle(); await settle();
    txt = texts(current).join('|');
    check('完整性：哈希不一致的启用规则不计入当前规则（仍为 6%），单列“待重新确认的规则（1）”，非恐慌式说明；技术原因码只在详情中',
      txt.includes('当前生效规则（1）') && enabledHashes().join() === h6 && txt.includes('待重新确认的规则（1）') && reconfirmHashes().join() === badHash
      && cardVisible(badHash).includes('待重新确认') && cardVisible(badHash).includes('这条规则的保存内容与当前校验标识不一致。为避免误用，它暂不参与测试。')
      && !cardVisible(badHash).includes('E_CONTRACT_RULE_HASH_MISMATCH') && !cardVisible(badHash).includes(badHash) && cardDetail(badHash).includes('E_CONTRACT_RULE_HASH_MISMATCH') && cardDetail(badHash).includes(badHash), cardVisible(badHash).slice(0, 320));
    const sr = await simulate('000000', '2024-09-30');
    check('完整性：待重新确认规则不参与判定，只判当前 6%（未命中），并说明另有 1 条未参与', simHashes().join() === h6 && verdictOf(h6) === '未命中' && summaryOf('error') === '无法判定 0 条'
      && sr.includes('另有 1 条规则因内容与候选哈希不一致未参与本次判定（见“待重新确认的规则”）'), sr.slice(0, 320));
    await clickIn(ruleCardOf(badHash), '停用'); await settle();
    check('完整性：停用待重新确认规则 → 进入历史（已停用，不能恢复），当前规则不变', reconfirmHashes().length === 0 && histState(badHash) === 'stopped'
      && histVisible(badHash).includes('不能恢复') && !findButtons(histOf(badHash)).some((b) => labelOf(b).includes('恢复')) && enabledHashes().join() === h6, histVisible(badHash));
  }
  store.set('tm.contracts.demo', '{broken');
  check('契约·旧记录：损坏的本地存储 → 空记录（不崩溃）', loadContractsDemo().length === 0);
}

/* ==== 导入页：用户本地 CSV（FileReader 本机读取 → adapter 校验 → 确认门槛 → 旧账单清理）==== */
state.route = 'import';
state.bill = defaultBill();
mountCycle();
check('用户CSV：空状态提示 + accept 限定 csv', texts(current).join('|').includes('尚未选择账单') && findInputs(current)[0].attrs.accept === '.csv,text/csv');
{
  const sample = findByTag(current, 'a').find((a) => String(a.attrs.href ?? '') === '/m0/csv-input/fixtures/demo-bill-real.csv');
  const emptyTxt = texts(current).join('|');
  check('用户CSV：提供示例账单下载用于本地上传演示，并说明演示按钮不进入在线对话',
    !!sample && sample.attrs.download === 'demo-bill-local.csv'
    && texts(sample).join('').includes('下载示例账单')
    && emptyTxt.includes('只有本地上传的账单会进入复核与在线对话')
    && emptyTxt.includes('“加载演示账单”不会上传 CSV，也不会进入在线对话'), sample ? JSON.stringify(sample.attrs) : emptyTxt.slice(0, 300));
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

await pickFile({ name: 'notes.txt', size: 12, __content: 'hello' });
await flush();
confirmBtn = findButtons(current).find((b) => labelOf(b).includes('确认交易列表'));
check('用户CSV：有效账单后选 .txt → 旧账单完全重置且不可确认', state.bill.status === 'none' && state.bill.error.includes('文件类型不符合预期') && state.bill.trades.length === 0 && state.bill.warnings.length === 0 && state.bill.errors.length === 0 && state.bill.blocked === false && state.bill.dataMode === null && state.bill.resultLabelling === null && state.bill.sourceNote === '' && !confirmBtn, JSON.stringify(state.bill).slice(0, 220));

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

state.route = 'import';
state.bill = defaultBill();
mountCycle();
const loadPromise = clickLabel('加载演示账单');
const loadingBtn = findButtons(current).find((b) => labelOf(b).includes('加载'));
check('演示加载：期间 status=loading 且文件选择/按钮均禁用', state.bill.status === 'loading' && !!loadingBtn && loadingBtn.disabled === true && findInputs(current)[0].disabled === true, JSON.stringify({ s: state.bill.status }));
await loadPromise;
check('演示加载：结束后恢复 loaded + 待确认（默认 R 场景 8 笔）', state.bill.status === 'loaded' && state.bill.trades.length === 8
  && texts(findByClass(current, 'im-status')[0] ?? { children: [] }).join('').includes('待确认：'), JSON.stringify({ s: state.bill.status, n: state.bill.trades.length }));

/* ==== 用户账单 → 报告页（确认 → 合成行情 → runReview 发布门槛）==== */
const oosCsv = '日期,标的,方向,价格,数量,费用,税费\n2025-01-02,600519,买入,1488.00,100,5,0\n2025-01-02,000001,买入,10.00,100,5,0\n2025-12-30,600519,卖出,1389.72,100,5,1\n';
const lateCsv = '日期,标的,方向,价格,数量,费用,税费\n2026-01-05,600519,买入,1377.18,100,5,0\n';

state.route = 'import';
state.bill = defaultBill();
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'user-bill.csv', size: happyCsv.length, __content: happyCsv });
await flush();
await clickLabel('确认交易列表');
check('用户报告：确认后 status=confirmed 且进入报告页（用户字段不被覆盖）', state.bill.status === 'confirmed' && state.route === 'report' && state.bill.fileName === 'user-bill.csv' && state.bill.trades.length === 2 && state.bill.dataMode && state.bill.dataMode.id === 'user_bill_dynamic_market', JSON.stringify({ s: state.bill.status, r: state.route }));
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：文件名 + 用户本地账单 + Tushare 动态行情标注（拉取/最新交易日/快照）', txt.includes('用户本地账单') && txt.includes('文件名：user-bill.csv') && txt.includes('用户本地账单 + Tushare 动态行情') && txt.includes('Tushare 动态行情（服务端获取，非实时') && txt.includes('最新交易日 2025-12-31') && txt.includes('快照 tushare-20251231-01234567'), txt.slice(0, 320));
check('用户报告·公司行为限制：显式披露 v1 不自动识别股数事件', txt.includes('公司行为限制：')
  && txt.includes('v1 不自动识别送转、拆合股、配股等股数事件') && txt.includes('可能估值不准确'), txt.slice(0, 320));
check('报告·用户账单：底部同样不出现“契约匹配未接线”，契约状态与未接入项照实说明', wiringOk(txt), txt.slice(-300));
check('报告·用户摘要：数据来源=已确认本地账单（文件名）/ Tushare 动态日线 / 估值日 / 组合结果已发布（已通过复核）',
  summaryTxt().includes('已确认本地账单 · user-bill.csv') && summaryTxt().includes('Tushare 动态日线（服务端获取，非实时）') && summaryTxt().includes('估值日')
  && summaryTxt().includes('组合结果已发布（已通过复核）') && summaryTxt().includes('数字基于 Tushare 最新已收盘日线（服务端获取，非实时）') && !summaryTxt().includes('不要据此作交易判断'), summaryTxt());
check('用户报告：指标来自用户交易（-6.6%/-7.4%/¥-1,254.00），非示例 R', txt.includes('-6.6%') && txt.includes('-7.4%') && txt.includes('¥-1,254.00') && !txt.includes('+5.4%') && !txt.includes('¥-2,805.00') && !txt.includes('undefined'), txt.slice(0, 240));
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
check('用户反事实：未阻断标可进入反事实图（入口 + 引擎 display ¥137,718.00 / -7.4% / -0.8pp）', txt.includes('单笔反事实') && txt.includes('S1') && txt.includes('假设结果价值 ¥137,718.00') && txt.includes('假设收益 -7.4%') && txt.includes('相对改善 -0.8pp'), txt.slice(0, 300));
check('用户反事实：双 SVG 面板与图例渲染正常', findByTag(current, 'svg').length >= 2 && txt.includes('当前替换笔') && txt.includes('不构成投资建议'), txt.slice(0, 200));

state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'oos-bill.csv', size: oosCsv.length, __content: oosCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：范围外标的 000001 阻断展示（E_PRICE_MISSING · 不回落演示）', txt.includes('000001') && txt.includes('E_PRICE_MISSING') && !txt.includes('+5.4%') && !txt.includes('¥-2,805.00'), txt.slice(0, 260));
check('用户报告：复核“部分事实已发布” + 组合结果不发布（不按剩余标的重算）',
  txt.includes('复核：部分事实已发布') && txt.includes('内部状态标识：degraded') && txt.includes('组合」结果不发布') && txt.includes('不按剩余标的'), txt.slice(0, 260));
{
  const vis = visibleTexts(current).join('|');
  check('用户报告·阻断：中文阻断原因与行号可见，错误码只在技术详情', vis.includes('结果不发布') && !vis.includes('E_PRICE_MISSING') && txt.includes('E_PRICE_MISSING'), vis.slice(-300));
}
check('报告·用户摘要·阻断：优先显示阻断原因（000001 超出真实行情范围）+“不要据此作交易判断。”+ 组合结果未发布，摘要不含任何数值',
  summaryTxt().startsWith('本次分析摘要|存在阻断：') && summaryTxt().includes('000001') && summaryTxt().includes('不要据此作交易判断。') && summaryTxt().includes('部分标的结果已通过复核')
  && summaryTxt().includes('组合结果未发布') && !summaryTxt().includes('已发布（') && !/[+-]\d+\.\d%|¥/.test(summaryTxt()), summaryTxt());
check('证据视图·缺价：未发布事实表列出组合扣发原因 + 000001 未进入计算 + 无组合指标卡',
  txt.includes('组合不发布') && txt.includes('未发布事实（8 项）') && txt.includes('portfolio.actualRet') && txt.includes('E_REVIEW_PORTFOLIO_WITHHELD')
  && txt.includes('组合结论整体扣发') && txt.includes('「000001」未进入计算') && findByClass(current, 'rp-metric').length === 0, txt.slice(0, 400));
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·缺价：组合扣发显示真实原因（E_PRICE_MISSING / WITHHELD）+ B4 文案，不出现复核证据不足说明',
    boxTxt.includes('「组合」结果不发布') && boxTxt.includes('E_PRICE_MISSING') && boxTxt.includes('E_REVIEW_PORTFOLIO_WITHHELD')
    && boxTxt.includes('不按剩余标的') && boxTxt.includes('不回退其他日期') && !boxTxt.includes('复核或证据不足') && !boxTxt.includes('+4.0%'), boxTxt.slice(0, 400));
}
{
  const nodes = factNodes();
  const allTxt = nodes.map((n) => texts(n).join('|')).join('||');
  check('证据视图·缺价：组合事实条目全部“未发布”，不外露按剩余标的算出的数字',
    nodes.length === 8 && nodes.every((n) => String(n.attrs.class).includes('bad') && factSummary(n).includes('未发布'))
    && !allTxt.includes('+4.0%') && !allTxt.includes('¥400.00') && !allTxt.includes('¥10,400.00') && !allTxt.includes('复核通过并发布')
    && allTxt.includes('不展示该步骤的中间数值'), allTxt.slice(0, 400));
}
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：未阻断标的 600519 仍发布（-6.6% / ¥-1,254.00）', txt.includes('-6.6%') && txt.includes('¥-1,254.00'), txt.slice(0, 200));
await clickLabel('000001'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：000001 视图不发布（缺价/支持范围外说明，且不出反事实图）', txt.includes('000001」结果不发布') && txt.includes('缺价或超出行情支持范围') && !txt.includes('单笔反事实'), txt.slice(0, 200));
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
  check('阻断框·全部超范围：组合阻断显示缺价原因与 B4 文案',
    boxTxt.includes('E_PRICE_MISSING') && boxTxt.includes('不按剩余标的') && !boxTxt.includes('复核或证据不足'), boxTxt.slice(0, 300));
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
  && !txt.includes('-6.6%') && !txt.includes('¥-1,254.00') && !txt.includes('¥137,718.00') && !txt.includes('复核通过并发布'), txt.slice(0, 400));
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
check('用户报告：估值早于末笔 → 明确阻断（不回退演示）', txt.includes('E_VALUATION_BEFORE_LAST_TRADE') && !txt.includes('演示场景') && !txt.includes('¥700.00'), txt.slice(0, 240));
check('报告·用户摘要·复核未运行：阻断原因（估值日早于末笔交易日）+“不要据此作交易判断。”+ 组合结果未发布（复核未运行）',
  summaryTxt().includes('存在阻断：') && summaryTxt().includes('早于账单末笔交易日') && summaryTxt().includes('不要据此作交易判断。') && summaryTxt().includes('组合结果未发布（复核未运行）')
  && summaryTxt().includes('已确认本地账单 · late-bill.csv'), summaryTxt());

/* ==== 契约情境模拟：交易来源随账单模式切换（已确认本地账单 → 用户 trades；否则演示账单 A）==== */
{
  const cfCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-09-24,000000,买入,100,100,5,0\n2024-10-09,000000,卖出,104,100,5,1\n2024-09-25,600519,买入,30,100,5,0\n2024-09-30,600519,卖出,31,100,5,0\n';
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
  check('情境来源·已确认本地账单：交易来源=已确认本地账单（cf-user.csv）· 行情=合成演示行情；卖出列表为用户交易（非演示 T004）',
    state.bill.status === 'confirmed' && sourceLine().startsWith('交易来源：已确认本地账单（cf-user.csv）') && sourceLine().includes('行情：合成演示行情')
    && txt.includes('T002 000000 2024-10-09') && txt.includes('T004 600519 2024-09-30') && !txt.includes('T004 000000 2024-10-08') && !txt.includes('演示账单 A')
    && txt.includes('合成夹具（非真实行情）· 候选口径（待 M0-C1 冻结）· 不构成投资建议'), sourceLine() + ' || ' + txt.slice(-300));
  check('情境来源·已确认本地账单：范围外标的 600519 列出且标注“不在本次行情”（不隐藏、不替代）',
    symOpts.some((o) => o.startsWith('600519') && o.includes('不在本次行情')) && symOpts.some((o) => o.startsWith('000000')), JSON.stringify(symOpts));

  let s = await simulate('000000', '2024-10-10');
  check('情境模拟·用户账单不追回：000000 2024-10-10 用用户卖出 T002（2024-10-09，距 1 日）→ 命中，结果标注用户来源',
    verdictOf(hB3) === '命中' && ruleTxt(hB3).includes('最近卖出：T002 · 2024-10-09') && ruleTxt(hB3).includes('距最近卖出：1 个交易日') && !s.includes('T004 · 2024-10-08')
    && ruleTxt(hB3).includes('交易来源：已确认本地账单（cf-user.csv）') && !s.includes('演示账单 A') && simHashes().length === 2, s.slice(0, 400));
  s = await simulate('600519', '2024-11-06');
  check('情境模拟·用户账单不追回：600519 申报日超出缓存日历 → 数据不足（E_DATE_NOT_IN_CALENDAR），不回退演示账单',
    verdictOf(hB3) === '数据不足' && ruleTxt(hB3).includes('E_DATE_NOT_IN_CALENDAR') && ruleTxt(hB3).includes('不在本次行情支持范围') && ruleTxt(hB3).includes('已确认本地账单（cf-user.csv）') && !s.includes('演示账单 A'), s.slice(0, 400));
  s = await simulate('600519', '2024-10-08');
  check('情境模拟·用户账单不追回：600519（缓存外）照用用户卖出 T004 判定，并如实说明只用交易日历、不读价格',
    ruleTxt(hB3).includes('最近卖出：T004 · 2024-09-30') && ruleTxt(hB3).includes('不追回判定只使用交易日历与账单交易') && !s.includes('演示账单 A'), s.slice(0, 400));

  mountCycle();
  await settle();
  check('情境来源·优化二（不追回+涨幅同时启用）：标注“仅不追回规则读取这些交易，涨幅规则不读取账单交易”，且显示卖出记录列表',
    sourceLine().includes('仅不追回规则读取这些交易，涨幅规则不读取账单交易') && sellsLine().includes('卖出记录来源：已确认本地账单（cf-user.csv）') && sellsLine().includes('T002 000000 2024-10-09'), sourceLine() + ' || ' + sellsLine());
  await disableRule(hB3);
  check('情境来源·优化二（仅涨幅启用）：只显示“涨幅规则只读取行情，不使用账单交易”，不显示卖出记录列表',
    !enabledHashes().includes(hB3) && sourceLine().includes('涨幅规则只读取行情，不使用账单交易') && !sourceLine().includes('仅不追回') && sellsLine() === '', sourceLine() + ' || sells=' + sellsLine());
  await clickIn(histOf(hB3), '恢复为当前规则'); await settle();
  check('情境来源·优化二（从历史恢复不追回）：卖出记录列表恢复显示', enabledHashes().includes(hB3) && sellsLine().includes('T002 000000 2024-10-09'), sellsLine());
  s = await simulate('600519', '2024-10-08');
  check('情境模拟·用户账单涨幅：600519 不在缓存 → 数据不足（E_CHANGE_PCT_MISSING + 引擎原因），不替换标的、不回退',
    verdictOf(hS3) === '数据不足' && ruleTxt(hS3).includes('E_CHANGE_PCT_MISSING') && ruleTxt(hS3).includes('缺 600519 收盘价') && ruleTxt(hS3).includes('无法读取涨跌幅') && ruleTxt(hS3).includes('600519 · 申报日 2024-10-08') && !ruleTxt(hS3).includes('当日涨跌幅：'), s.slice(0, 400));

  state.bill = defaultBill();
  state.route = 'contract'; mountCycle(); await settle();
  await settle();
  check('情境来源·清空账单后：自动切回演示账单 A，旧用户上下文与结果被丢弃', sourceLine().startsWith('交易来源：演示账单 A') && simTxt() === '' && texts(current).join('|').includes('T004 000000 2024-10-08'), sourceLine());
  s = await simulate('000000', '2024-10-10');
  check('情境模拟·演示模式不追回：仍用演示账单 A 的 T004（2024-10-08，距 2 日），结果标注演示来源',
    verdictOf(hB3) === '命中' && ruleTxt(hB3).includes('最近卖出：T004 · 2024-10-08') && ruleTxt(hB3).includes('距最近卖出：2 个交易日') && ruleTxt(hB3).includes('交易来源：演示账单 A') && !s.includes('cf-user.csv') && simHashes().length === 2, s.slice(0, 400));
}

/* ==== 全站外壳（main.js）：分析流程 1→4、三种数据状态、了解口径、导航命名 —— 最后导入，避免其订阅影响前面的用例 ==== */
{
  const els = { 'capability-chips': makeEl('div'), nav: makeEl('nav'), view: makeEl('main'), 'footer-labels': makeEl('div') };
  els.nav.after = (n) => { els.flow = n; };
  const hashListeners = [];
  globalThis.document.getElementById = (id) => els[id] ?? null;
  globalThis.location = { hash: '#/import' };
  globalThis.window = { addEventListener: (t, fn) => { if (t === 'hashchange') hashListeners.push(fn); } };
  state.report = { scenario: 'R', symbol: 'pool' };
  state.bill = defaultBill();
  await imp('src/main.js');
  const shell = () => texts(els.flow).join('|');
  const currentStep = () => { const n = findByClass(els.flow, 'current')[0]; return n ? texts(n).join('') : ''; };
  const goHash = async (h) => { location.hash = h; for (const fn of hashListeners) fn(); await settle(); };
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
  check('外壳·能力状态：动态行情在真实网络 E2E 验收前保持“待验收”（不得提前置 ready）',
    adapterShell.CAPABILITY.marketCache.ready === false
    && texts(els['capability-chips']).join('|').includes('Tushare 动态日线·服务端获取（非实时）')
    && texts(els['capability-chips']).join('|').includes('待验收'), texts(els['capability-chips']).join('|').slice(0, 300));
  check('外壳·了解口径：折叠区解释估值日 / 择时损耗 / 反事实 / 阻断 / 证据', findByClass(els.flow, 'glossary')[0]?.tagName === 'DETAILS'
    && ['估值日', '择时损耗', '反事实', '阻断', '证据'].every((k) => shell().includes(k)) && shell().includes('不会改用其他日期'), shell().slice(-300));
  state.bill = { ...defaultBill(), status: 'loaded', sourceType: 'local', fileName: 'pending.csv' };
  await goHash('#/import');
  check('外壳·数据状态：待确认本地账单 → “待确认本地账单”（含文件名、尚未确认，不冒称已有行情）',
    shell().includes('数据状态：待确认本地账单') && !shell().includes('数据状态：待确认本地账单 +') && shell().includes('pending.csv') && shell().includes('尚未确认'), shell());
  state.bill = { ...defaultBill(), status: 'confirmed', sourceType: 'local', fileName: 'shell.csv' };
  await goHash('#/report');
  check('外壳·数据状态：已确认本地账单 → “已确认本地账单 + Tushare 动态行情”（含文件名、未上传、服务端只收标的与范围），报告页为第 3 步',
    shell().includes('数据状态：已确认本地账单 + Tushare 动态行情') && shell().includes('shell.csv') && shell().includes('未上传')
    && shell().includes('服务端只收到标的代码与日期范围') && shell().includes('Tushare 最新已收盘日线（非实时）') && currentStep() === '3 查看报告当前', shell());
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
