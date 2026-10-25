#!/usr/bin/env node
/**
 * 报告 AI 解释真实调用链（fake fetch；不联网、不调用真实模型）
 *
 * 覆盖：示例报告与真实账单都能经 qaDeps.explainReport → chatOnline/restate；
 *       缺有效报告事实/未确认账单时不发请求；出站只有问题与四项已发布事实。
 * 运行：node tests/ui/report-explain-bridge.test.mjs
 */
import { loadReportScenarioBill, loadUserBillReport } from '../../src/demo/adapter.js';
import { runReview } from '../../src/agent/reviewPipeline.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const body = JSON.parse(options.body ?? '{}');
  calls.push({ url: String(url), body });
  const facts = Array.isArray(body.facts) ? body.facts : [];
  const answer = `组合数字：${facts.map((fact) => fact.display).join('，')}。`;
  return {
    ok: true,
    status: 200,
    json: async () => ({ rawText: JSON.stringify({ answer_text: answer }) }),
  };
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const bridge = await import('../../prototype/user-frontend/realBridge.js');
const explain = (args) => bridge.getCtx().qaDeps.explainReport(args);
const QUESTION = '解释当前页面已发布的组合数字及其含义';

/* ==== 示例报告：真实调用链放行，且只发已发布事实 ==== */
{
  const bill = await loadReportScenarioBill('chase', { contextId: 'bridge-demo-report' });
  const bundle = await loadUserBillReport(bill);
  check('示例报告：报告已复核发布并仍标记示例', bill.demo === true
    && bundle.demo === true
    && bundle.review?.portfolio_published === true,
  JSON.stringify({ demo: bill.demo, published: bundle.review?.portfolio_published }));

  calls.length = 0;
  const result = await explain({ question: QUESTION, bundle, bill });
  const request = calls[0] ?? {};
  const serialized = JSON.stringify(request.body ?? {});
  check('示例报告：点击链路实际发起一次 restate 请求', result.ok === true
    && calls.length === 1
    && /\/functions\/v1\/app\/api\/llm\/restate$/.test(request.url ?? ''),
  JSON.stringify({ result, calls: calls.length }));
  check('示例报告：出站只有问题与四项已发布事实',
    Object.keys(request.body ?? {}).join(',') === 'question,facts'
    && Array.isArray(request.body?.facts) && request.body.facts.length === 4
    && !serialized.includes('bridge-demo-report')
    && !serialized.includes('demo')
    && !serialized.includes('chase')
    && !serialized.includes('fileName')
    && !serialized.includes('trades'),
    serialized.slice(0, 420));
}

/* ==== 真实账单：同一调用链可用 ==== */
{
  const trade = (id, date, symbol, side, price, quantity) => ({
    trade_id: id, trade_date: date, symbol, side, price, quantity,
    fee: 0, tax: 0, fee_missing: false, tax_missing: false,
    source: { file: 'bridge.csv', line: 2 },
  });
  const review = runReview({
    trades: [
      trade('B1', '2024-09-24', '000000', 'buy', 10, 100),
      trade('S1', '2024-09-27', '000000', 'sell', 11, 100),
    ],
    closes: { '000000': 12 },
    valuation: { requested_date: '2024-09-30', effective_date: '2024-09-30' },
  });
  const bill = {
    status: 'confirmed', sourceType: 'local', blocked: false,
    contextId: 'bridge-real-report', trades: [trade('B1', '2024-09-24', '000000', 'buy', 10, 100)],
  };
  const bundle = { review };
  calls.length = 0;
  const result = await explain({ question: QUESTION, bundle, bill });
  check('真实账单：同一链路可用且只发一次请求',
    review.portfolio_published === true
    && result.ok === true
    && calls.length === 1
    && JSON.stringify(calls[0]?.body ?? {}).length > 0,
    JSON.stringify({ result, calls: calls.length }));
}

/* ==== 缺有效事实/未确认：不调用 ==== */
{
  const baseBill = {
    status: 'confirmed', sourceType: 'local', blocked: false,
    contextId: 'bridge-missing', trades: [{ trade_id: 'T1' }],
  };
  calls.length = 0;
  const loaded = await explain({
    question: QUESTION,
    bundle: { review: { portfolio_published: true, published_facts: [] } },
    bill: { ...baseBill, status: 'loaded' },
  });
  const incomplete = await explain({
    question: QUESTION,
    bundle: {
      review: {
        portfolio_published: true,
        published_facts: [{ scope: 'portfolio', key: 'actualRet', display: '+3.7%' }],
      },
    },
    bill: baseBill,
  });
  const unpublished = await explain({
    question: QUESTION,
    bundle: { review: { portfolio_published: false, published_facts: [] } },
    bill: baseBill,
  });
  check('未确认账单、事实不完整、组合未发布：均不发起请求',
    loaded.ok === false && incomplete.ok === false && unpublished.ok === false
    && calls.length === 0,
    JSON.stringify({ loaded, incomplete, unpublished, calls: calls.length }));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
