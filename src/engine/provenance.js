// M2-C1 数据侧（四）OUTPUT03 计算路径 steps→provenance（T1-15 ＋ 附 A.4）。
// 输入：computeIndicators 结果＋原始标准化交易（source 供回源）＋closes；可选 valuation 透传（估值日解析结果）。
// 输出：单 fact 或全量 {blocked, fact_id, formula_id, formula_text, unit, value, display, inputs,
//       source_refs[], steps[口径→批次→逐批→排序], errors[]}。
// 口径（附 A.4）：①全量 refs 解析通过；②悬空引用→告警+阻断（blocked，不发布）；
//       steps 每步含 detail 与可回源引用；source_refs 匿名（仅 {type:'trade', key, file, line}——
//       无账户/身份字样，出站白名单 F-6 由 planner 侧执行）。验算视图渲染（③④走查）属 UI 侧。
// 边界：本模块只做留痕与引用解析，不重算数值（重算对照属 verify.js）；缺 formula_id → blocked（与 A.2 ③ 联动）。

import { CALC_FORMULAS, INDICATOR_FORMULA_IDS, PORTFOLIO_FORMULA_IDS, sortTrades } from './indicators.js';
import { fmtMoney, fmtPct, fmtPP } from './display.js';

export const PROVENANCE_CODES = Object.freeze({
  DANGLING_REF: 'E_PROV_DANGLING_REF',
  FORMULA_MISSING: 'E_PROV_FORMULA_MISSING',
});

const STOCK_FACT_KEYS = ['buyCost', 'sellProceeds', 'heldShares', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'];
const PORTFOLIO_FACT_KEYS = STOCK_FACT_KEYS.filter((k) => k !== 'heldShares');
const MONEY_KEYS = new Set(['buyCost', 'sellProceeds', 'actualValue', 'ghostValue', 'dragMoney']);
const RET_KEYS = new Set(['actualRet', 'ghostRet']);

const BATCH_TEXT = Object.freeze({
  buyCost: '批次聚合：Σ 买入 (price×quantity)',
  sellProceeds: '批次聚合：Σ 卖出 (price×quantity)',
  heldShares: '批次聚合：Σ买入 quantity − Σ卖出 quantity（O3 保证 ≥0）',
  actualValue: '批次聚合：sellProceeds + heldShares×close（双路径 P-B 聚合公式）',
  ghostValue: '批次聚合：boughtQty×close（双路径 P-B 直接乘积）',
  actualRet: '批次聚合：actualValue / buyCost − 1',
  ghostRet: '批次聚合：ghostValue / buyCost − 1',
  dragMoney: '批次聚合：ghostValue − actualValue（双路径 P-B）；P-A＝逐笔卖出重放 Σ quantity×(close−price)',
  drag: '批次聚合：ghostRet − actualRet（＝ dragMoney / buyCost）',
});

function displayOf(key, v) {
  if (MONEY_KEYS.has(key)) return fmtMoney(v);
  if (RET_KEYS.has(key)) return fmtPct(v);
  if (key === 'drag') return fmtPP(v);
  return `${v} 股`;
}

export function listFactIds(report) {
  if (!report?.per_stock || !report?.portfolio) throw new TypeError('listFactIds：report 须为 computeIndicators 结果');
  const ids = [];
  for (const sym of Object.keys(report.per_stock)) for (const k of STOCK_FACT_KEYS) ids.push(`${sym}.${k}`);
  for (const k of PORTFOLIO_FACT_KEYS) ids.push(`portfolio.${k}`);
  return ids;
}

function parseFactId(fact_id, report) {
  const i = String(fact_id ?? '').indexOf('.');
  if (i <= 0) throw new TypeError(`buildProvenance：fact_id 非法（${fact_id}）`);
  const scope = fact_id.slice(0, i);
  const key = fact_id.slice(i + 1);
  const entry = report.per_stock?.[scope] ?? (scope === 'portfolio' ? report.portfolio : null);
  if (!entry) throw new TypeError(`buildProvenance：fact_id 作用域不存在（${scope}）`);
  const keys = scope === 'portfolio' ? PORTFOLIO_FACT_KEYS : STOCK_FACT_KEYS;
  if (!keys.includes(key)) throw new TypeError(`buildProvenance：${scope} 不含 fact ${key}`);
  const formula_ids = scope === 'portfolio' ? PORTFOLIO_FORMULA_IDS : INDICATOR_FORMULA_IDS;
  return { scope, key, entry, formula_id: formula_ids[key] };
}

export function buildProvenance({ report, trades, closes, fact_id, valuation }) {
  if (!report?.per_stock || !report?.portfolio) throw new TypeError('buildProvenance：report 须为 computeIndicators 结果');
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('buildProvenance：trades 为空');
  if (!closes || typeof closes !== 'object') throw new TypeError('buildProvenance：closes 缺失');
  const { scope, key, entry, formula_id } = parseFactId(fact_id, report);

  const scopeTrades = scope === 'portfolio' ? trades : trades.filter((t) => t.symbol === scope);
  if (scopeTrades.length === 0) throw new TypeError(`buildProvenance：trades 不含作用域 ${scope} 的成交`);

  const errors = [];
  const formula = CALC_FORMULAS[formula_id];
  if (!formula) errors.push({ code: PROVENANCE_CODES.FORMULA_MISSING, message: `公式注册表缺少 ${formula_id}（不发布，附 A.4）` });

  const resolveRef = (t) => {
    if (t?.source?.file && Number.isFinite(t.source?.line)) {
      return { ref: { type: 'trade', key: t.trade_id, file: t.source.file, line: t.source.line }, resolved: true };
    }
    return { ref: { type: 'trade', key: t.trade_id, file: null, line: null }, resolved: false };
  };
  const refs = scopeTrades.map(resolveRef);
  const dangling = refs.filter((r) => !r.resolved);
  if (dangling.length > 0) {
    errors.push({ code: PROVENANCE_CODES.DANGLING_REF, scope, message: `源行不可定位 ${dangling.length} 笔（${dangling.map((d) => d.ref.key).join(', ')}）：悬空引用阻断发布（附 A.4 ②）` });
  }

  const ordered = sortTrades(scopeTrades);
  const lines = ordered.map((t, i) => ({
    seq: i + 1,
    trade_id: t.trade_id,
    trade_date: t.trade_date,
    side: t.side,
    price: t.price,
    quantity: t.quantity,
    amount: t.price * t.quantity,
    ref: resolveRef(t).ref,
  }));

  const closeText = scope === 'portfolio'
    ? '各标的估值日不复权 close（组合聚合）'
    : `close(${scope}, effective_date) = ${closes[scope]}`;
  const valuationText = valuation
    ? `；估值日解析透传：requested=${valuation.requested_date ?? '—'} → effective=${valuation.effective_date ?? '—'}`
    : '';
  const dual = entry.dual_path?.[key];

  const steps = [
    {
      step_id: 'S1', kind: 'caliber', label: '口径',
      detail: `估值口径：价值折算用 effective_date 不复权 close（B2）；非交易日回退最近交易日（B3）、缺价不回落（B4）由行情缓存（M1-C1）解析后传入${valuationText}。公式（${formula_id}）：${formula ? formula.formula_text : '（缺失）'}`,
      refs: [],
    },
    {
      step_id: 'S2', kind: 'batch', label: '批次',
      detail: `${BATCH_TEXT[key]}。批次输入：${closeText}；本 fact 值 = ${displayOf(key, entry[key])}${dual ? `；双路径 P-A=${dual.path_a} / P-B=${dual.path_b}（diff ${dual.diff}，容差 ${dual.tol}）` : ''}`,
      refs: refs.map((r) => r.ref),
    },
    {
      step_id: 'S3', kind: 'lines', label: '逐批（逐笔明细）',
      detail: `逐笔明细 ${lines.length} 笔（price×quantity 可逐笔复算；任一行可回原始成交换行）`,
      lines,
      refs: refs.map((r) => r.ref),
    },
    {
      step_id: 'S4', kind: 'sort', label: '排序',
      detail: '规范顺序：trade_date 升序、同日按原始行序稳定（Q7 候选）；排序不改变求和（可加总）；反事实与行为回放共用此顺序',
      order: ordered.map((t) => t.trade_id),
      refs: [],
    },
  ];

  return {
    blocked: errors.length > 0,
    fact_id,
    scope,
    key,
    formula_id,
    formula_text: formula ? formula.formula_text : null,
    unit: formula ? formula.unit : null,
    value: entry[key],
    display: displayOf(key, entry[key]),
    inputs: scope === 'portfolio'
      ? { trade_ids: scopeTrades.map((t) => t.trade_id), close_basis: '各标的估值日不复权 close' }
      : { trade_ids: scopeTrades.map((t) => t.trade_id), close: closes[scope] },
    source_refs: refs.filter((r) => r.resolved).map((r) => r.ref),
    steps,
    errors,
  };
}

export function buildProvenanceReport({ report, trades, closes, valuation }) {
  const items = listFactIds(report).map((fact_id) => buildProvenance({ report, trades, closes, fact_id, valuation }));
  const dangling_refs = [];
  for (const it of items) {
    for (const e of it.errors) {
      if (e.code === PROVENANCE_CODES.DANGLING_REF) dangling_refs.push({ fact_id: it.fact_id, scope: it.scope, message: e.message });
    }
  }
  return {
    blocked: items.some((it) => it.blocked),
    dangling_refs,
    items,
    summary: { n: items.length, blocked_n: items.filter((it) => it.blocked).length },
  };
}
