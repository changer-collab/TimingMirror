// M2-C1 数据侧（一）—— 独立复核双路径（附 A.2；接口 §4-6 复核结果）
// 输入：computeIndicators 结果（facts = 主实现值）＋原始标准化交易＋closes（估值日不复权 close）。
// 输出：verify_report { verify_id, facts[每 fact {path_a, path_b, diff, tol, verdict, reasons[]}],
//       identity_checks[], provenance_complete, dangling_refs[], data_source_notes[], summary }。
// 口径（附 A.2）：①|diff|>tol ②恒等式破坏 ③provenance 缺失 ④源行不可定位——任一命中 → verdict=fail（不发布）。
//       容差：金额统一舍入比较到分；收益率相对容差 1e-9（候选值，F-2 正式容差未冻结——M0）。
//       错误分类：计算错误（双路径实现不一致 / 恒等式破坏 / 独立重算不一致 → 可被本报告捕获）；
//       数据源错误（行情/成交源数据错误；双路径共用同源时可能同时算错 → 不承诺必然捕获，
//       以本模块 source_validation 告警为检测依据之一，疑似错误仍须口径核对兜底——附 A.2 明示）。
// 边界：本模块不做“重算回流”（A.3，changer 侧）；verify_id 为内容摘要（数值 + verdict + provenance_complete，确定性；不含 source_refs/reasons），重算/编排归 M1-C7。

import { INDICATOR_FORMULA_IDS, PORTFOLIO_FORMULA_IDS } from './indicators.js';

export const VERIFY_CODES = Object.freeze({
  RECOMPUTE_MISMATCH: 'E_VERIFY_RECOMPUTE_MISMATCH',
  DUAL_PATH_MISMATCH: 'E_VERIFY_DUAL_PATH_MISMATCH',
  IDENTITY_BREAK: 'E_VERIFY_IDENTITY_BREAK',
  PROVENANCE_MISSING: 'E_VERIFY_PROVENANCE_MISSING',
  SOURCE_UNRESOLVED: 'E_VERIFY_SOURCE_UNRESOLVED',
  SOURCE_VALIDATION: 'W_VERIFY_SOURCE_VALIDATION',
});

const REL_TOL = 1e-9; // 候选值（与引擎 dual_path 同）；正式容差随 M0 冻结
const STOCK_FACT_KEYS = ['buyCost', 'sellProceeds', 'heldShares', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'];
const PORTFOLIO_FACT_KEYS = STOCK_FACT_KEYS.filter((k) => k !== 'heldShares');
const MONEY_KEYS = new Set(['buyCost', 'sellProceeds', 'actualValue', 'ghostValue', 'dragMoney']);
const DUAL_KEYS = new Set(['dragMoney', 'ghostValue']);

const moneyEqual = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(Math.round(a * 100) - Math.round(b * 100)) === 0;

function tolFor(key) {
  if (MONEY_KEYS.has(key)) return { kind: 'round_to_cent', value: 0.005 };
  if (key === 'heldShares') return { kind: 'exact', value: 0 };
  return { kind: 'relative', value: REL_TOL };
}

function compare(key, a, b) {
  const tol = tolFor(key);
  if (tol.kind === 'round_to_cent') return { diff: a - b, tol, ok: moneyEqual(a, b) };
  if (tol.kind === 'exact') return { diff: a - b, tol, ok: a === b };
  const limit = REL_TOL * Math.max(1, Math.abs(a), Math.abs(b));
  return { diff: a - b, tol: { ...tol, limit }, ok: Math.abs(a - b) <= limit };
}

// 独立重算（与 indicators.computeOne 分开实现：本模块单遍直算，作为第二实现对照）
function recomputeSymbol(symTrades, close) {
  const ordered = symTrades
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.trade_date === b.t.trade_date ? a.i - b.i : a.t.trade_date < b.t.trade_date ? -1 : 1))
    .map((x) => x.t);
  let buyCost = 0;
  let sellProceeds = 0;
  let boughtQty = 0;
  let soldQty = 0;
  for (const t of ordered) {
    const amount = t.price * t.quantity;
    if (t.side === 'buy') { buyCost += amount; boughtQty += t.quantity; }
    else { sellProceeds += amount; soldQty += t.quantity; }
  }
  const heldShares = boughtQty - soldQty;
  const actualValue = sellProceeds + heldShares * close;
  const ghostValue = boughtQty * close;
  const actualRet = actualValue / buyCost - 1;
  const ghostRet = ghostValue / buyCost - 1;
  const dragMoney = ghostValue - actualValue;
  const drag = ghostRet - actualRet;
  return { buyCost, sellProceeds, heldShares, actualValue, ghostValue, actualRet, ghostRet, dragMoney, drag, boughtQty, soldQty };
}

function fnv1a64(str) {
  const MASK = (1n << 64n) - 1n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) { h ^= BigInt(str.charCodeAt(i)); h = (h * 0x100000001b3n) & MASK; }
  return h.toString(16).padStart(16, '0');
}

export function buildVerifyReport({ report, trades, closes }) {
  if (!report?.per_stock || !report?.portfolio) throw new TypeError('buildVerifyReport：report 须为 computeIndicators 结果');
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('buildVerifyReport：trades 为空');
  if (!closes || typeof closes !== 'object') throw new TypeError('buildVerifyReport：closes 缺失');

  const bySymbol = new Map();
  for (const t of trades) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  }
  const recomputed = {};
  for (const [sym, list] of bySymbol) {
    if (!report.per_stock[sym]) throw new TypeError(`buildVerifyReport：report 缺少 ${sym} 的 facts`);
    recomputed[sym] = recomputeSymbol(list, closes[sym]);
  }
  const portfolioRecomp = (() => {
    const keys = ['buyCost', 'sellProceeds', 'actualValue', 'ghostValue'];
    const sums = {};
    for (const k of keys) sums[k] = Object.values(recomputed).reduce((s, x) => s + x[k], 0);
    sums.actualRet = sums.actualValue / sums.buyCost - 1;
    sums.ghostRet = sums.ghostValue / sums.buyCost - 1;
    sums.dragMoney = sums.ghostValue - sums.actualValue;
    sums.drag = sums.ghostRet - sums.actualRet;
    return sums;
  })();

  const tradeIndex = new Map(trades.map((t) => [t.trade_id, t]));
  const dangling_refs = [];
  const sourceValidation = [];

  for (const [sym, list] of bySymbol) {
    for (const t of list) {
      if (!t.source || !t.source.file || !Number.isFinite(t.source.line)) {
        sourceValidation.push({ code: VERIFY_CODES.SOURCE_VALIDATION, scope: t.trade_id, message: `成交 ${t.trade_id} 源行不完整（源行不可定位判据之一，附 A.2 ④）` });
      }
      if (!Number.isFinite(t.price) || t.price <= 0) sourceValidation.push({ code: VERIFY_CODES.SOURCE_VALIDATION, scope: t.trade_id, message: `成交 ${t.trade_id} 价格非正数（数据源校验）` });
      if (!Number.isInteger(t.quantity) || t.quantity <= 0) sourceValidation.push({ code: VERIFY_CODES.SOURCE_VALIDATION, scope: t.trade_id, message: `成交 ${t.trade_id} 数量非法（数据源校验）` });
    }
    if (!Number.isFinite(closes[sym]) || closes[sym] <= 0) {
      sourceValidation.push({ code: VERIFY_CODES.SOURCE_VALIDATION, scope: sym, message: `${sym} 估值 close 非正数（数据源校验；不承诺双路径必然捕获，附 A.2）` });
    }
  }

  function makeFact(fact_id, key, mainValue, recompValue, entry) {
    const reasons = [];
    const cmp = compare(key, mainValue, recompValue);
    if (!cmp.ok) reasons.push({ code: VERIFY_CODES.RECOMPUTE_MISMATCH, message: `独立重算不一致（主实现 ${mainValue} ≠ 重算 ${recompValue}）`, kind: '计算错误' });
    const formula_id = entry.formula_ids?.[key] ?? null;
    if (!formula_id) reasons.push({ code: VERIFY_CODES.PROVENANCE_MISSING, message: `缺少 formula_id（provenance 缺失，附 A.2 ③）`, kind: '计算错误' });
    if (DUAL_KEYS.has(key)) {
      const dual = entry.dual_path?.[key];
      if (!dual) reasons.push({ code: VERIFY_CODES.PROVENANCE_MISSING, message: `缺少引擎双路径记录（${key}）`, kind: '计算错误' });
      else if (!Number.isFinite(dual.path_a) || !Number.isFinite(dual.path_b)) {
        reasons.push({ code: VERIFY_CODES.DUAL_PATH_MISMATCH, message: `引擎双路径记录非法（${key}：P-A ${dual.path_a} / P-B ${dual.path_b}）`, kind: '计算错误' });
      } else {
        // 独立复核不从引擎自报的 consistent/tol 读结论：由原始双路径值重算（单侧注入必然命中）
        const diff = dual.path_a - dual.path_b;
        const tol = REL_TOL * Math.max(1, Math.abs(dual.path_a), Math.abs(dual.path_b));
        if (Math.abs(diff) > tol) reasons.push({ code: VERIFY_CODES.DUAL_PATH_MISMATCH, message: `引擎双路径不一致（P-A ${dual.path_a} ≠ P-B ${dual.path_b}，diff ${diff}）`, kind: '计算错误' });
      }
    }
    return { fact_id, key, value: mainValue, path_a: mainValue, path_b: recompValue, diff: cmp.diff, tol: cmp.tol, formula_id, reasons, verdict: reasons.length === 0 ? 'pass' : 'fail' };
  }

  function resolveRefs(ids, scope) {
    const refs = [];
    let unresolved = 0;
    for (const id of ids) {
      const t = tradeIndex.get(id);
      if (t?.source?.file && Number.isFinite(t.source?.line)) refs.push({ type: 'trade', key: id, file: t.source.file, line: t.source.line });
      else { unresolved += 1; dangling_refs.push({ fact_scope: scope, ref: { type: 'trade', key: id } }); }
    }
    return { refs, unresolved };
  }

  const facts = [];
  for (const [sym, recomp] of Object.entries(recomputed)) {
    const entry = report.per_stock[sym];
    const ids = bySymbol.get(sym).map((t) => t.trade_id);
    const { refs, unresolved } = resolveRefs(ids, sym);
    for (const key of STOCK_FACT_KEYS) {
      const f = makeFact(`${sym}.${key}`, key, entry[key], recomp[key], entry);
      if (unresolved > 0) f.reasons.push({ code: VERIFY_CODES.SOURCE_UNRESOLVED, message: `输入含源行不可定位的成交（${unresolved} 笔，附 A.2 ④）`, kind: '计算错误' });
      f.inputs = { trade_ids: ids, close: closes[sym] };
      f.source_refs = refs;
      f.verdict = f.reasons.length === 0 ? 'pass' : 'fail';
      facts.push(f);
    }
  }
  {
    const entry = report.portfolio;
    const ids = trades.map((t) => t.trade_id);
    const { refs, unresolved } = resolveRefs(ids, 'portfolio');
    for (const key of PORTFOLIO_FACT_KEYS) {
      const f = makeFact(`portfolio.${key}`, key, entry[key], portfolioRecomp[key], entry);
      if (unresolved > 0) f.reasons.push({ code: VERIFY_CODES.SOURCE_UNRESOLVED, message: `输入含源行不可定位的成交（${unresolved} 笔，附 A.2 ④）`, kind: '计算错误' });
      f.inputs = { trade_ids: ids, close_basis: '各标的估值日不复权 close' };
      f.source_refs = refs;
      f.verdict = f.reasons.length === 0 ? 'pass' : 'fail';
      facts.push(f);
    }
  }

  const identity_checks = [];
  function pushIdentity(identity_id, name, scope, lhs, rhs, tolKind) {
    const cmp = tolKind === 'exact'
      ? { diff: lhs - rhs, tol: { kind: 'exact', value: 0 }, ok: lhs === rhs }
      : { diff: lhs - rhs, tol: { kind: 'round_to_cent', value: 0.005 }, ok: moneyEqual(lhs, rhs) };
    identity_checks.push({ identity_id, name, scope, lhs, rhs, diff: cmp.diff, tol: cmp.tol, verdict: cmp.ok ? 'pass' : 'fail', code: cmp.ok ? null : VERIFY_CODES.IDENTITY_BREAK });
  }
  for (const [sym, recomp] of Object.entries(recomputed)) {
    const entry = report.per_stock[sym];
    const lineSum = (entry.drag_lines ?? []).reduce((s, l) => s + l.dragMoney, 0);
    pushIdentity('ID-1', 'Σ逐笔损耗 = 总损耗', sym, lineSum, entry.dragMoney, 'money');
    pushIdentity('ID-2', 'dragMoney = ghostValue − actualValue', sym, entry.ghostValue - entry.actualValue, entry.dragMoney, 'money');
    pushIdentity('ID-3', 'dragMoney = drag × buyCost', sym, entry.drag * entry.buyCost, entry.dragMoney, 'money');
    pushIdentity('ID-4', '股数守恒：Σ买 − Σ卖 = heldShares', sym, recomp.boughtQty - recomp.soldQty, entry.heldShares, 'exact');
  }
  {
    const entry = report.portfolio;
    const lineSum = Object.values(report.per_stock).reduce((s, x) => s + (x.drag_lines ?? []).reduce((a, l) => a + l.dragMoney, 0), 0);
    pushIdentity('ID-1', 'Σ逐笔损耗 = 总损耗', 'portfolio', lineSum, entry.dragMoney, 'money');
    pushIdentity('ID-2', 'dragMoney = ghostValue − actualValue', 'portfolio', entry.ghostValue - entry.actualValue, entry.dragMoney, 'money');
    pushIdentity('ID-3', 'dragMoney = drag × buyCost', 'portfolio', entry.drag * entry.buyCost, entry.dragMoney, 'money');
  }

  const provenance_complete = facts.every((f) => f.formula_id !== null && f.source_refs.length > 0) && dangling_refs.length === 0;
  const n_pass = facts.filter((f) => f.verdict === 'pass').length;
  // verdict 纳入摘要：来源修复可在数值不变时改变可发布性，verify_id 不应保持不变。
  const digest = fnv1a64(JSON.stringify({
    facts: facts.map((f) => [f.fact_id, f.value, f.verdict]),
    identities: identity_checks.map((i) => [i.identity_id, i.scope, i.lhs, i.rhs, i.verdict]),
    provenance_complete,
  })).slice(0, 8);

  return {
    verify_id: `V-${digest}`,
    facts,
    identity_checks,
    provenance_complete,
    dangling_refs,
    data_source_notes: [
      {
        code: VERIFY_CODES.SOURCE_VALIDATION,
        message: '数据源错误（行情/成交源数据）在双路径共用同源时不承诺必然捕获（附 A.2）：本模块双路径与独立重算均消费同一份输入；以下告警为检测依据之一，疑似错误须口径核对兜底。',
      },
      ...sourceValidation,
    ],
    error_taxonomy: {
      calculation: '计算错误：双路径实现不一致 / 恒等式破坏 / 独立重算不一致——可被本报告捕获（单侧实现注入必然命中）。',
      data_source: '数据源错误：行情/成交源错误——双路径共用同源时可能同时算错，不承诺必然捕获；检测依据＝source_validation 告警与口径核对。',
    },
    summary: { n_facts: facts.length, pass: n_pass, fail: facts.length - n_pass, identities_fail: identity_checks.filter((i) => i.verdict === 'fail').length },
  };
}
