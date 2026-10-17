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
globalThis.document = {
  createElement: (t) => makeEl(t),
  createElementNS: (ns, t) => makeEl(t),
  createTextNode,
};
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
  check('报告：演示条目收起时显示中文事实名 + 展示值 + 公式编号', sumTxt.includes('组合 · ') && /CALC_/.test(sumTxt) && sumTxt.split('|').length === 3, sumTxt);
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

/* ==== 单笔反事实（S1 幽灵线双面板）：演示账单 000000 → T004 ==== */
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('反事实：入口 + S1 口径 + 替换笔信息（T004 · 2024-10-08 · 110 × 200）', txt.includes('单笔反事实') && txt.includes('S1') && txt.includes('T004') && txt.includes('2024-10-08') && txt.includes('110 × 200'), txt.slice(0, 260));
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
check('用户报告：组合 scope 反事实入口提示选择标的（不画图）', txt.includes('请选择一个标的查看单笔卖出反事实'), txt.slice(0, 160));
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
    && !!ret && factSummary(ret).includes('+4.0%'), JSON.stringify(nodes.map(factSummary)).slice(0, 300));
  check('证据视图：展开后含公式编号/公式文本/输入/来源行/计算步骤',
    retTxt.includes('CALC_RET_V1') && retTxt.includes('actualValue / buyCost − 1') && retTxt.includes('成交 T001、T002')
    && retTxt.includes('user-bill.csv 第 2 行') && retTxt.includes('计算步骤') && retTxt.includes('S1 口径') && retTxt.includes('S3 逐批')
    && retTxt.includes('复核通过并发布') && !retTxt.includes('undefined'), retTxt.slice(0, 400));
}
await clickLabel('000000'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户反事实：未阻断标可进入反事实图（入口 + 引擎 display ¥10,800.00 / +8.0% / +4.0pp）', txt.includes('单笔反事实') && txt.includes('S1') && txt.includes('假设结果价值 ¥10,800.00') && txt.includes('假设收益 +8.0%') && txt.includes('相对改善 +4.0pp'), txt.slice(0, 300));
check('用户反事实：双 SVG 面板与图例渲染正常', findByTag(current, 'svg').length >= 2 && txt.includes('当前替换笔') && txt.includes('不构成投资建议'), txt.slice(0, 200));

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
check('证据视图·缺价：未发布事实表列出组合扣发原因 + 600519 未进入计算 + 无组合指标卡',
  txt.includes('组合不发布') && txt.includes('未发布事实（8 项）') && txt.includes('portfolio.actualRet') && txt.includes('E_REVIEW_PORTFOLIO_WITHHELD')
  && txt.includes('组合结论整体扣发') && txt.includes('「600519」未进入计算') && findByClass(current, 'rp-metric').length === 0, txt.slice(0, 400));
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
await clickLabel('000000'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：未阻断标的 000000 仍发布（+4.0%）', txt.includes('+4.0%') && txt.includes('¥400.00'), txt.slice(0, 200));
await clickLabel('600519'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('用户报告：600519 视图不发布（支持范围外说明，且不出反事实图）', txt.includes('600519」结果不发布') && txt.includes('合成行情缓存支持范围') && !txt.includes('单笔反事实'), txt.slice(0, 200));
check('证据视图·缺价标的：600519 无计算路径且说明未进入计算', txt.includes('「600519」没有计算路径') && factNodes().length === 0, txt.slice(0, 300));

const allOutCsv = '日期,标的,方向,价格,数量,费用,税费\n2024-09-26,600519,买入,30,100,5,0\n';
state.route = 'import';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle();
await pickFile({ name: 'allout-bill.csv', size: allOutCsv.length, __content: allOutCsv });
await flush();
await clickLabel('确认交易列表');
await flush(); await flush(); await flush();
txt = texts(current).join('|');
check('证据视图·复核未运行：verify 未产出、计算路径不可用、无已发布数字',
  txt.includes('复核：blocked') && txt.includes('未产出（复核未运行）') && txt.includes('已发布事实 0 项') && txt.includes('复核检查未运行')
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
  && !txt.includes('+4.0%') && !txt.includes('¥400.00') && !txt.includes('¥10,000.00') && !txt.includes('复核通过并发布'), txt.slice(0, 400));
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·悬空来源：组合显示复核/证据问题（来源行不可定位 / 无备用重算），不归因缺价或超范围，无指标卡',
    boxTxt.includes('「组合」结果不发布') && boxTxt.includes('E_VERIFY_SOURCE_UNRESOLVED') && boxTxt.includes('E_REVIEW_RECOMPUTE_NO_ALTERNATIVE')
    && boxTxt.includes('复核或证据不足') && !boxTxt.includes('缺价') && !boxTxt.includes('超范围') && !boxTxt.includes('不按剩余标的')
    && !boxTxt.includes('不回退其他日期') && findByClass(current, 'rp-metric').length === 0, boxTxt.slice(0, 400));
}
await clickLabel('000000'); await flush(); await flush(); await flush();
txt = texts(current).join('|');
{
  const boxTxt = texts(blockedBoxOf()).join('|');
  check('阻断框·悬空来源：标的 000000 同样显示真实原因，不归因缺价，不显示数字与反事实图',
    boxTxt.includes('「000000」结果不发布') && boxTxt.includes('E_VERIFY_SOURCE_UNRESOLVED') && boxTxt.includes('复核或证据不足')
    && !boxTxt.includes('缺价') && !boxTxt.includes('超范围') && !boxTxt.includes('其他估值日')
    && findByClass(current, 'rp-metric').length === 0 && !txt.includes('单笔反事实') && !txt.includes('+4.0%') && !txt.includes('¥400.00'), boxTxt.slice(0, 400));
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

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '   → ' + r.detail));
console.log('\n== 合计 ' + results.length + ' 项检查：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ==');
process.exitCode = failed.length ? 1 : 0;
