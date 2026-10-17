#!/usr/bin/env node
/**
 * M1-C10 离线段 · 事实 JSON 导出器 —— 离线单测（合成数据；零依赖）
 *
 * 覆盖：只导出 published_facts；blocked_facts 不进入；portfolio_published=false 不导出组合；
 *       source_ref 匿名化（trade_id/file/line 不外泄）；白名单字段固定；重复导出完全一致；
 *       intent 选择（支持集/unsupported/零事实）；作用域校验（needs_context）；行为标签须有证据；
 *       provenance 逐 fact 缺失阻断；诊断消息匿名化（不回显原始 fact_id/scope；结构化断言）；
 *       blocked review 失败语义（F4：provenance 可为 null）；非法输入明确失败状态。
 * 边界：纯函数测试；通过仅证明导出器语义与单测一致，不证明在线链路或产品端到端验收通过。
 * 运行：node tests/agent/fact-export.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { exportFacts, FACT_EXPORT_CODES, FACT_SET_VERSION } from '../../src/agent/factExport.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity, src = true) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  ...(src ? { source: { file: 'mini.csv', line: id === 'T001' ? 2 : 3 } } : {}),
});
const A_CLEAN = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100), mk('T002', '2024-09-27', '000000', 'sell', 11, 100)];
const A_DIRTY = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100, false), mk('T002', '2024-09-27', '000000', 'sell', 11, 100, false)];
const B_CLEAN = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10), mk('B102', '2024-09-30', '888888', 'sell', 105, 10)];
const CLOSES2 = { '000000': 12, '888888': 110 };

const buildPublished = () => runReview({ trades: A_CLEAN(), closes: { '000000': 12 }, valuation: VAL });
const buildFull = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: CLOSES2, valuation: VAL });
const buildDegraded = () => runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12 }, valuation: VAL });
const buildBlocked = () => runReview({ trades: A_DIRTY(), closes: { '000000': 12 } });

/* ==== ① 只导出 published_facts ==== */
{
  const review = buildPublished();
  const ex = exportFacts({ review });
  check('导出：status ok 且数量等于 published_facts（17）', ex.status === 'ok' && ex.meta.exported === 17 && ex.facts.length === 17, JSON.stringify(ex.meta));
  check('导出：fact_set_version 为候选版本', ex.fact_set_version === FACT_SET_VERSION);
  const keys = new Set(ex.facts.map((f) => f.key));
  check('导出：包含 9 类标的 fact + 8 类组合 fact', keys.size === 9 && ex.facts.filter((f) => f.scope === 'portfolio').length === 8, JSON.stringify([...keys]));
  const bc = ex.facts.find((f) => f.key === 'buyCost' && f.scope === 'stock-1');
  check('导出：fact 抽查（buyCost=1000 / ¥1,000.00 / CALC_BUY_COST_V1）', bc && near(bc.value, 1000) && bc.display === '¥1,000.00' && bc.formula_ref === 'CALC_BUY_COST_V1', JSON.stringify(bc));
  check('导出：meta 计数（published/blocked/recompute_attempts）', ex.meta.published_total === 17 && ex.meta.blocked_total === 0 && ex.meta.recompute_attempts === 0, JSON.stringify(ex.meta));
}

/* ==== ② blocked_facts 不进入 + ⑤ 白名单字段 ==== */
{
  const review = buildDegraded();
  const ex = exportFacts({ review });
  const s = JSON.stringify(ex);
  check('阻断：degraded review 只导出未阻断标的的 9 项', ex.status === 'ok' && ex.facts.length === 9 && ex.facts.every((f) => f.scope === 'stock-1'), JSON.stringify(ex.meta));
  check('阻断：888888 的 display 不进入（+5.0% / ¥50.00 / +5.0pp 均缺席）', !s.includes('+5.0%') && !s.includes('¥50.00') && !s.includes('+5.0pp'), s.slice(0, 200));
  check('阻断：diagnostics 含组合扣发告警（W_FACT_PORTFOLIO_WITHHELD）', ex.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.PORTFOLIO_WITHHELD));
  check('阻断：blocked review → status blocked + E_FACT_NOT_PUBLISHED + 零事实', (() => {
    const b = exportFacts({ review: buildBlocked() });
    return b.status === 'blocked' && b.facts.length === 0 && b.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.REVIEW_NOT_PUBLISHED);
  })(), JSON.stringify(exportFacts({ review: buildBlocked() })));

  const allowed = new Set(['fact_ref', 'scope', 'key', 'value', 'unit', 'display', 'formula_ref', 'source_ref']);
  check('白名单：每个 fact 字段 ⊆ {fact_ref, scope, key, value, unit, display, formula_ref, source_ref}', ex.facts.every((f) => Object.keys(f).every((k) => allowed.has(k))), JSON.stringify(Object.keys(ex.facts[0])));
  check('白名单：必需字段齐备（value 数值 / display / formula_ref / source_ref）', ex.facts.every((f) => typeof f.value === 'number' && (f.display === null || typeof f.display === 'string') && typeof f.formula_ref === 'string' && typeof f.source_ref === 'string'));
}

/* ==== ③ portfolio_published=false 不导出组合 ==== */
{
  const degradedEx = exportFacts({ review: buildDegraded() });
  const fullEx = exportFacts({ review: buildFull() });
  check('组合扣发：degraded 导出不含 portfolio 作用域', degradedEx.facts.every((f) => f.scope !== 'portfolio'));
  check('组合发布：全量导出含 8 项组合 fact', fullEx.facts.filter((f) => f.scope === 'portfolio').length === 8 && fullEx.meta.exported === 26, JSON.stringify(fullEx.meta));
}

/* ==== ④ source_ref 匿名化（原始 trade_id/file/line 不外泄） ==== */
{
  const ex = exportFacts({ review: buildFull() });
  const s = JSON.stringify(ex);
  check('匿名化：不含 trade_id / 文件名 / 行号 / file,line 字段', !s.includes('T001') && !s.includes('B101') && !s.includes('mini.csv') && !s.includes('"file"') && !s.includes('"line"') && !s.includes('trade_id'));
  // 结构化断言：剔除 value（内部浮点尾数含长 0 串，如 0.10000000000000009）后不得出现裸标的代码/字段名
  const stripped = JSON.stringify({ ...ex, facts: ex.facts.map((f) => ({ ...f, value: undefined })) });
  check('匿名化：剔除 value 浮点尾数后无裸标的代码/symbol 字段（结构化）', !stripped.includes('000000') && !stripped.includes('888888') && !stripped.includes('"symbol"'), stripped.slice(0, 160));
  check('匿名化：source_ref 为稳定匿名哈希（src- + 8hex）', ex.facts.every((f) => /^src-[0-9a-f]{8}$/.test(f.source_ref)));
  check('匿名化：fact_ref 为稳定匿名哈希（F- + 8hex）；scope 为匿名句柄', ex.facts.every((f) => /^F-[0-9a-f]{8}$/.test(f.fact_ref)) && ex.facts.every((f) => ['portfolio', 'stock-1', 'stock-2'].includes(f.scope)));
}

/* ==== ⑥ 同一输入重复导出完全一致 ==== */
{
  const r1 = buildPublished();
  const r2 = buildPublished();
  const e1a = JSON.stringify(exportFacts({ review: r1 }));
  const e1b = JSON.stringify(exportFacts({ review: r1 }));
  const e2 = JSON.stringify(exportFacts({ review: r2 }));
  check('确定性：同一 review 两次导出完全一致', e1a === e1b);
  check('确定性：同输入两次独立链路导出完全一致', e1a === e2);
}

/* ==== ⑪ intent 选择：支持集 / unsupported / 零事实 ==== */
{
  const review = buildPublished();
  const wt = exportFacts({ review, intent: 'worst_trade' });
  check('intent：worst_trade 只取 drag 类事实（每作用域 2 项）', wt.status === 'ok' && wt.facts.length === 4 && wt.facts.every((f) => f.key === 'dragMoney' || f.key === 'drag'), JSON.stringify(wt.facts.map((f) => f.key)));
  const lo = exportFacts({ review, intent: 'loss_overview' });
  check('intent：loss_overview 全量（17）', lo.status === 'ok' && lo.facts.length === 17);
  const mc = exportFacts({ review, intent: 'meta_calc' });
  check('intent：meta_calc 全量且带 formula_ref', mc.status === 'ok' && mc.facts.every((f) => typeof f.formula_ref === 'string'));
  const oos = exportFacts({ review, intent: 'out_of_scope' });
  check('intent：out_of_scope 零事实合规（ok + 0）', oos.status === 'ok' && oos.facts.length === 0 && oos.meta.exported === 0);
  for (const intent of ['pattern_explain', 'what_if', 'contract_setup', 'profile']) {
    const u = exportFacts({ review, intent });
    check(`intent：${intent} → unsupported（不生成伪造事实）`, u.status === 'unsupported' && u.facts.length === 0 && u.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.INTENT_UNSUPPORTED), JSON.stringify(u.diagnostics));
  }
  const unknown = exportFacts({ review, intent: 'not_an_intent' });
  check('intent：未知值 → unsupported（不猜测）', unknown.status === 'unsupported' && unknown.facts.length === 0);
}

/* ==== 作用域校验（needs_context）与行为标签 ==== */
{
  const review = buildFull();
  const onlyA = exportFacts({ review, scope: '000000' });
  check('作用域：scope=000000 只导出该标的 9 项（stock-1）', onlyA.status === 'ok' && onlyA.facts.length === 9 && onlyA.facts.every((f) => f.scope === 'stock-1'));
  const onlyP = exportFacts({ review, scope: 'portfolio' });
  check('作用域：scope=portfolio 只导出组合 8 项', onlyP.status === 'ok' && onlyP.facts.length === 8 && onlyP.facts.every((f) => f.scope === 'portfolio'));
  const bad = exportFacts({ review, scope: '999999' });
  check('作用域：未知 scope → needs_context + E_FACT_SCOPE_UNAVAILABLE', bad.status === 'needs_context' && bad.facts.length === 0 && bad.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.SCOPE_UNAVAILABLE));
  check('诊断匿名化：未命中作用域不回显原始输入（不含 999999）', bad.status === 'needs_context' && !JSON.stringify(bad.diagnostics).includes('999999'), JSON.stringify(bad.diagnostics));

  const tags = exportFacts({ review, behavior_tags: [{ tag: '追高买入', evidence_ref: 'pattern-candidate-1' }, { tag: '无证据标签' }] });
  check('行为标签：仅有证据者导出；无证据者丢弃并告警', Array.isArray(tags.behavior_tags) && tags.behavior_tags.length === 1 && tags.behavior_tags[0].tag === '追高买入' && tags.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.BEHAVIOR_TAG_DROPPED));
}

/* ==== provenance 逐 fact 缺失 → 阻断该 fact ==== */
{
  const review = buildPublished();
  const filtered = { ...review, provenance: { ...review.provenance, items: review.provenance.items.filter((i) => i.fact_id !== '000000.buyCost') } };
  const ex = exportFacts({ review: filtered });
  check('provenance：缺失项的 fact 不导出（17→16）且给出 E_FACT_PROVENANCE_MISSING', ex.status === 'ok' && ex.facts.length === 16 && ex.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.PROVENANCE_MISSING));
  const diagStr = JSON.stringify(ex.diagnostics);
  check('诊断匿名化：PROVENANCE_MISSING 消息不含原始 fact_id/标的代码（仅匿名句柄 F-8hex）', !diagStr.includes('000000') && !diagStr.includes('buyCost') && /F-[0-9a-f]{8}/.test(diagStr), diagStr.slice(0, 200));
}

/* ==== ⑫ 非法输入明确失败状态 + 失败语义（F4） ==== */
{
  const e1 = exportFacts({});
  const e2 = exportFacts({ review: { published_facts: [], blocked_facts: [], provenance: null, meta: {} } });
  const e3 = exportFacts({ review: null });
  check('非法输入：缺 review → invalid + E_FACT_INPUT_INVALID', e1.status === 'invalid' && e1.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.INPUT_INVALID));
  check('失败语义：空事实 review（provenance 可为 null 的合法阻断输出）→ blocked，不误判 invalid', e2.status === 'blocked' && e2.facts.length === 0 && e2.diagnostics.some((d) => d.code === FACT_EXPORT_CODES.REVIEW_NOT_PUBLISHED));
  check('非法输入：review=null → invalid', e3.status === 'invalid' && e3.facts.length === 0);
  const emptyTrades = exportFacts({ review: runReview({ trades: [], closes: { '000000': 12 } }) });
  check('失败语义：runReview 空 trades 输出（status=blocked、provenance=null）→ 导出 blocked（F4 对齐）', emptyTrades.status === 'blocked' && emptyTrades.facts.length === 0, JSON.stringify(emptyTrades.diagnostics));
  const noProv = exportFacts({ review: { ...buildPublished(), provenance: null } });
  check('非法输入：已发布事实但 provenance 缺失 → invalid（消息提及 provenance）', noProv.status === 'invalid' && noProv.diagnostics[0].message.includes('provenance'));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
