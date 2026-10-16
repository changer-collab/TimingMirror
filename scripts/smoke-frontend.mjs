// 前端交互冒烟（零依赖：Node + 最小 DOM 桩；非产品代码，仅回归工具）
// 覆盖：导入/确认（演示账单 + 本地 CSV 本机校验）、报告切换（组合/标的/A′/差异）、对话离线、契约三态与持久化、状态徽标色映射。
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
globalThis.document = { createElement: (t) => makeEl(t), createTextNode };
globalThis.fetch = async (url) => {
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

const { state, subscribe, notify, defaultBill } = await imp('src/state.js');
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

/* ==== 导入页：加载 → 待确认 → 确认 ==== */
state.route = 'import';
state.bill = defaultBill();
mountCycle();
await clickLabel('加载演示账单');
let txt = texts(current).join('|');
check('导入：加载后出现“待确认”徽标（mode 样式）', findChips(current).some((c) => texts(c).join('').includes('待确认') && String(c.attrs.class).includes('mode')));
check('导入：费用缺失与口径标注仍在', txt.includes('缺失（按 0）') && txt.includes('未计入费用、税费') && txt.includes('分红未计入'), txt.slice(0, 160));
await clickLabel('确认交易列表');
check('导入：确认后状态=confirmed 且路由=report', state.bill.status === 'confirmed' && state.route === 'report', JSON.stringify({ s: state.bill.status, r: state.route }));
state.route = 'import'; mountCycle();
check('导入：确认态徽标为“已确认”（ok 样式）', findChips(current).some((c) => texts(c).join('') === '已确认' && String(c.attrs.class).includes('ok')));
await flush(); await flush();

/* ==== 报告页（引擎接线：演示账单 CSV → csvNormalize → marketCache(合成夹具) → indicators → provenance）==== */
state.route = 'report';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle(); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：组合指标（引擎输出 +4.9% / +6.9% / +2.0pp / ¥700.00）', txt.includes('+4.9%') && txt.includes('+6.9%') && txt.includes('+2.0pp') && txt.includes('¥700.00'), txt.slice(0, 220));
check('报告：合成演示标注 + 买入不动口径 + 无 undefined', txt.includes('合成演示数据') && txt.includes('买入不动') && txt.includes('组合不汇总个股股数') && !txt.includes('undefined'));
await clickLabel('000000'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：标的切换 000000（引擎输出 +10.0% / -2.0pp / ¥-400.00）', txt.includes('+10.0%') && txt.includes('-2.0pp') && txt.includes('¥-400.00'), txt.slice(0, 220));
await clickLabel('A′'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：A′ 切换 + 引擎差异面板', state.report.scenario === 'Aprime' && txt.includes('与基准 A 的差异') && txt.includes('仅改第 5 行卖出价') && txt.includes('-7.0pp'), txt.slice(0, 280));
await clickLabel('基准账单 A'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：切回 A 恢复（实际收益卡与证据入口正常）', state.report.scenario === 'A' && txt.includes('实际收益') && txt.includes('查看证据与计算路径'));
const provM = txt.match(/计算路径（fact (\d+) 项 · 阻断 (\d+) 项）/);
check('报告：演示链路 provenance 完整（fact>0、阻断 0、无 E_PROVENANCE）', !!provM && Number(provM[1]) > 0 && Number(provM[2]) === 0 && !txt.includes('E_PROVENANCE'), txt.slice(0, 320));

/* ==== 对话页 ==== */
state.route = 'chat'; state.chat = { messages: [], draft: '' }; mountCycle();
await clickLabel('为什么说我追高？');
txt = texts(current).join('|');
check('对话：发送后两条消息 + 离线模式标注', state.chat.messages.length === 2 && txt.includes('离线模式（百炼未接入）') && txt.includes('事实 JSON'), txt.slice(0, 200));

/* ==== 契约页：确认 / 改写 / 拒绝 + 状态色 + 持久化 ==== */
state.route = 'contract'; state.contracts = { versions: [] }; mountCycle();
check('契约：空状态提示存在', texts(current).join('|').includes('暂无记录'));
await clickLabel('确认');
check('契约：确认后 v1 徽标（ok）', findChips(current).some((c) => texts(c).join('') === '已确认 v1' && String(c.attrs.class).includes('ok')));
await clickLabel('改写', 1);
const ta = current.querySelector('.input');
ta.value = '卖出后 5 个交易日内不追回同一只票。';
await clickLabel('保存改写');
check('契约：改写后 v2 徽标（mode）', findChips(current).some((c) => texts(c).join('') === '已改写 v2' && String(c.attrs.class).includes('mode')));
await clickLabel('拒绝', 1);
check('契约：拒绝后 v3 徽标（warn）', findChips(current).some((c) => texts(c).join('') === '已拒绝 v3' && String(c.attrs.class).includes('warn')));
check('契约：持久化写入与版本记录', String(store.get('tm.contracts.demo') ?? '').includes('已拒绝') && texts(current).join('|').includes('哈希：未接入'));

/* ==== 导入页：用户本地 CSV（FileReader 本机读取 → adapter 校验 → 确认门槛 → 旧账单清理）==== */
state.route = 'import';
state.bill = defaultBill();
mountCycle();
check('用户CSV：空状态提示 + accept 限定 csv', texts(current).join('|').includes('尚未选择账单') && findInputs(current)[0].attrs.accept === '.csv,text/csv');

const happyCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-09-25,000000,买入,100,100,5,0\n2024-10-09,000000,卖出,104,100,5,1\n';
await pickFile({ name: 'my-bill.csv', size: 2048, __content: happyCsv });
await flush();
txt = texts(current).join('|');
check('用户CSV：校验通过 → loaded + 待确认 + 文件名/大小', state.bill.status === 'loaded' && state.bill.sourceType === 'local' && state.bill.trades.length === 2 && txt.includes('my-bill.csv') && txt.includes('2 KB') && findChips(current).some((c) => texts(c).join('').includes('待确认')), txt.slice(0, 200));
check('用户CSV：本机处理与数据模式标注', txt.includes('仅在本机读取和校验，不上传') && txt.includes('用户本地账单 + 合成演示行情'), txt.slice(0, 200));
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
check('演示加载：结束后恢复 loaded + 待确认（5 笔）', state.bill.status === 'loaded' && state.bill.trades.length === 5 && findChips(current).some((c) => texts(c).join('').includes('待确认')), JSON.stringify({ s: state.bill.status, n: state.bill.trades.length }));

/* ==== 用户账单 → 报告页（确认 → 合成行情 → runReview 发布门槛）==== */
const oosCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-09-25,000000,买入,100,100,5,0\n2024-09-26,600519,买入,30,100,5,0\n2024-10-09,000000,卖出,104,100,5,1\n';
const lateCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-11-05,000000,买入,100,100,5,0\n';

state.route = 'import';
state.bill = defaultBill();
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'user-bill.csv', size: happyCsv.length, __content: happyCsv });
await flush();
await clickLabel('确认交易列表');
check('用户报告：确认后 status=confirmed 且进入报告页（用户字段不被覆盖）', state.bill.status === 'confirmed' && state.route === 'report' && state.bill.fileName === 'user-bill.csv' && state.bill.trades.length === 2 && state.bill.dataMode && state.bill.dataMode.id === 'user_bill_synthetic_market', JSON.stringify({ s: state.bill.status, r: state.route }));
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：文件名 + 用户本地账单 + 合成行情标注', txt.includes('用户本地账单') && txt.includes('文件名：user-bill.csv') && txt.includes('用户本地账单 + 合成演示行情') && txt.includes('m0 合成夹具'), txt.slice(0, 240));
check('用户报告：指标来自用户交易（+4.0%/+8.0%/¥400.00），非演示 A', txt.includes('+4.0%') && txt.includes('+8.0%') && txt.includes('¥400.00') && !txt.includes('+4.9%') && !txt.includes('¥700.00') && !txt.includes('undefined'), txt.slice(0, 240));
check('用户报告：无 A/A′ 场景切换与差异面板', !txt.includes('演示场景') && !txt.includes('A′') && !txt.includes('与基准 A 的差异'), txt.slice(0, 160));
check('用户报告：复核 published + 已发布 17 项 + 组合已发布', txt.includes('复核：published') && txt.includes('已发布事实 17 项') && txt.includes('组合已发布'), txt.slice(0, 200));

state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'oos-bill.csv', size: oosCsv.length, __content: oosCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：范围外标的 600519 阻断展示（E_PRICE_MISSING · 不回落演示）', txt.includes('600519') && txt.includes('E_PRICE_MISSING') && !txt.includes('+4.9%') && !txt.includes('¥700.00'), txt.slice(0, 260));
check('用户报告：复核 degraded + 组合结果不发布（不按剩余标的重算）', txt.includes('复核：degraded') && txt.includes('组合」结果不发布') && txt.includes('不按剩余标的'), txt.slice(0, 260));
await clickLabel('000000'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：未阻断标的 000000 仍发布（+4.0%）', txt.includes('+4.0%') && txt.includes('¥400.00'), txt.slice(0, 200));
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：600519 视图不发布（支持范围外说明）', txt.includes('600519」结果不发布') && txt.includes('合成行情缓存支持范围'), txt.slice(0, 200));

state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'late-bill.csv', size: lateCsv.length, __content: lateCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：估值早于末笔 → 明确阻断（不回退演示）', txt.includes('E_VALUATION_BEFORE_LAST_TRADE') && !txt.includes('演示场景') && !txt.includes('¥700.00'), txt.slice(0, 240));

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '   → ' + r.detail));
console.log('\n== 合计 ' + results.length + ' 项检查：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ==');
process.exitCode = failed.length ? 1 : 0;
