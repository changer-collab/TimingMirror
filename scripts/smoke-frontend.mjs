// 前端交互冒烟（零依赖：Node + 最小 DOM 桩；非产品代码，仅回归工具）
// 覆盖：导入/确认、报告切换（组合/标的/A′/差异）、对话离线、契约三态与持久化、状态徽标色映射。
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
  const data = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  return { ok: true, status: 200, json: async () => data };
};
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const { state, subscribe, notify } = await imp('src/state.js');
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

/* ==== 导入页：加载 → 待确认 → 确认 ==== */
state.route = 'import';
state.bill = { status: 'none', scenario: 'A', trades: [], warnings: [], sourceNote: '', resultLabelling: null, error: '' };
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

/* ==== 报告页：组合 / 标的 / A′ / 证据 / 差异 ==== */
state.route = 'report';
state.report = { scenario: 'A', symbol: 'pool' };
mountCycle(); await flush(); await flush();
txt = texts(current).join('|');
check('报告：组合指标（+4.9% / +16.0% / +11.1pp / ¥3,900.00）', txt.includes('+4.9%') && txt.includes('+16.0%') && txt.includes('+11.1pp') && txt.includes('¥3,900.00'));
check('报告：买入不动口径与组合持仓处理', txt.includes('买入不动') && txt.includes('组合不汇总个股股数') && !txt.includes('undefined'));
await clickLabel('000000'); await flush(); await flush();
txt = texts(current).join('|');
check('报告：标的切换 000000（+10.0% / +15.0pp / ¥3,000.00）', txt.includes('+10.0%') && txt.includes('+15.0pp') && txt.includes('¥3,000.00'));
await clickLabel('A′'); await flush(); await flush();
txt = texts(current).join('|');
check('报告：A′ 切换 + 差异面板', state.report.scenario === 'Aprime' && txt.includes('+15.0%') && txt.includes('与基准 A 的差异') && txt.includes('仅改第 5 行卖出价'), txt.slice(0, 260));
await clickLabel('基准账单 A'); await flush(); await flush();
txt = texts(current).join('|');
check('报告：切回 A 恢复（实际收益卡与证据入口正常）', state.report.scenario === 'A' && txt.includes('实际收益') && txt.includes('查看证据与计算路径'));

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

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '   → ' + r.detail));
console.log('\n== 合计 ' + results.length + ' 项检查：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length + ' ==');
process.exitCode = failed.length ? 1 : 0;
