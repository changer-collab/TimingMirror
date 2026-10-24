#!/usr/bin/env node
/**
 * P2 · 上下文装配 —— 离线单测（合成账单/报告对象；零网络）
 *
 * 覆盖：发布门槛（报告状态＋组合结果）、示例标记、工具参数透传、
 *       固定假设/边界、账单切换后的上下文失效判定。
 * 运行：node tests/agent/context-assembler.test.mjs（或 npm run check）
 */
import {
  assembleContext, contextStillCurrent, CONTEXT_VERSION, CONTEXT_BOUNDARIES,
} from '../../src/agent/contextAssembler.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BILL = { status: 'confirmed', contextId: 'bill-ctx-1', trades: [{ trade_id: 'T001' }, { trade_id: 'T002' }] };
const BUNDLE = {
  status: 'ok',
  review: { portfolio_published: true },
  insights: {
    portfolio: { report: { per_stock: {} }, decomposition: { items: [] } },
    behavior: { available: true, data: { patterns: [] } },
  },
  closes: { '000000': 12 },
  market: { tradingDays: [] },
  valuation: { effective_date: '2024-10-11' },
};

/* ==== ① 发布门槛 ==== */
{
  const ctx = assembleContext({ bill: BILL, bundle: BUNDLE, versions: [{ id: 'v1' }], question: '组合怎么样？' });
  check('上下文：版本与已发布门槛', ctx.version === CONTEXT_VERSION
    && ctx.gate.published === true && ctx.gate.demo === false
    && ctx.gate.report_status === 'ok' && ctx.gate.bill_context_id === 'bill-ctx-1', JSON.stringify(ctx.gate));

  const blocked = assembleContext({ bill: BILL, bundle: { ...BUNDLE, status: 'blocked' } });
  check('上下文：报告阻断 → 未发布', blocked.gate.published === false, JSON.stringify(blocked.gate));

  const withheld = assembleContext({ bill: BILL, bundle: { ...BUNDLE, review: { portfolio_published: false } } });
  check('上下文：组合结果未发布 → 未发布', withheld.gate.published === false, JSON.stringify(withheld.gate));

  const demo = assembleContext({ bill: { ...BILL, demo: true }, bundle: BUNDLE });
  check('上下文：示例账单单独标记', demo.gate.demo === true && demo.gate.published === true, JSON.stringify(demo.gate));
}

/* ==== ② 工具参数透传 ==== */
{
  const ctx = assembleContext({
    bill: BILL, bundle: BUNDLE, versions: [{ id: 'v1' }],
    ruleState: { active_count: 1 }, profile: { tags: [] }, question: '为什么说我追高？',
    extras: { custom: 'x' },
  });
  const tc = ctx.toolContext;
  check('参数：账单/报告/分解/行为/行情按引用透传', tc.trades === BILL.trades
    && tc.report === BUNDLE.insights.portfolio.report
    && tc.decomposition === BUNDLE.insights.portfolio.decomposition
    && tc.behavior === BUNDLE.insights.behavior
    && tc.closes === BUNDLE.closes && tc.market === BUNDLE.market && tc.valuation === BUNDLE.valuation);
  check('参数：规则/画像/问题与扩展字段', tc.versions.length === 1 && tc.ruleState.active_count === 1
    && tc.profile.tags.length === 0 && tc.question === '为什么说我追高？' && tc.custom === 'x');
  check('参数：缺省为空而不是 undefined', assembleContext({}).toolContext.trades.length === 0
    && assembleContext({}).toolContext.closes === null);
}

/* ==== ③ 假设与边界 ==== */
{
  const ctx = assembleContext({ bill: BILL, bundle: BUNDLE });
  check('假设：估值口径与费用缺失如实写入', ctx.assumptions.includes('按估值日不复权收盘价计算')
    && ctx.assumptions.includes('未计入费用、税费与分红'), JSON.stringify(ctx.assumptions));
  check('边界：不跨账单、不预测、只用已发布数字', ctx.boundaries.join('|') === CONTEXT_BOUNDARIES.join('|')
    && ctx.boundaries.some((b) => b.includes('不跨用户')) && ctx.boundaries.some((b) => b.includes('不预测涨跌')));
  const noValuation = assembleContext({ bill: BILL, bundle: { ...BUNDLE, valuation: null } });
  check('假设：没有估值日时不写估值口径', !noValuation.assumptions.includes('按估值日不复权收盘价计算'));
}

/* ==== ④ 账单切换后失效 ==== */
{
  const ctx = assembleContext({ bill: BILL, bundle: BUNDLE });
  check('失效判定：同一账单仍有效', contextStillCurrent(BILL, ctx) === true);
  check('失效判定：账单切换后失效', contextStillCurrent({ ...BILL, contextId: 'bill-ctx-2' }, ctx) === false);
  check('失效判定：空账单上下文不误判', contextStillCurrent(null, ctx) === false
    && contextStillCurrent({ contextId: null }, assembleContext({})) === true);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
