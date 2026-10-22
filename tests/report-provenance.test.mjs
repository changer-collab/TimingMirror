#!/usr/bin/env node
/**
 * 真实报告事实级来源展开 —— 离线单测（示例冻结场景；不调用真实行情/模型）
 *
 * 覆盖：每个组合已发布事实可回到公式、成交行与复核结论；
 *       provenance_fact_id 映射；来源行 file/line/trade key 完整；
 *       sellProceeds 等无 display 事实的金额格式化兜底。
 * 运行：node tests/report-provenance.test.mjs
 */
import { loadReportScenarioBill } from '../src/demo/adapter.js';
import { loadUserBillReport } from '../src/demo/adapter.js';
import { factDisplay, factDetail, factProvenance } from '../prototype/user-frontend/realReport.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const bill = await loadReportScenarioBill('chase', { contextId: 'report-provenance-chase' });
const bundle = await loadUserBillReport(bill);
const portfolioFacts = (bundle.review?.published_facts ?? []).filter((f) => (f.scope || 'portfolio') === 'portfolio');
const labelled = portfolioFacts.filter((f) => ['buyCost', 'sellProceeds', 'actualValue', 'ghostValue', 'actualRet', 'ghostRet', 'dragMoney', 'drag'].includes(f.key));

check('场景：报告已发布且使用冻结行情', bundle.review?.portfolio_published === true && bundle.marketSource?.id === 'demo-frozen', JSON.stringify({ published: bundle.review?.portfolio_published, market: bundle.marketSource?.id }));
check('事实：组合已发布事实至少 8 项', portfolioFacts.length >= 8, JSON.stringify(portfolioFacts.length));

for (const fact of labelled) {
  const p = factProvenance(bundle, fact);
  check(`${fact.key}：可展开公式、来源行与复核结论`, p
    && typeof p.formula_id === 'string' && p.formula_id.length > 0
    && Array.isArray(p.source_refs) && p.source_refs.length > 0
    && p.source_refs.every((r) => typeof r.file === 'string' && Number.isFinite(r.line) && typeof r.key === 'string')
    && p.verify_verdict === 'pass'
    && typeof p.verify_id === 'string' && p.verify_id.length > 0
    && p.blocked === false, JSON.stringify(p));
}

check('provenance_fact_id：按事实映射而非重新计算', portfolioFacts.every((fact) => {
  const p = factProvenance(bundle, fact);
  return p && p.fact_id === (fact.provenance_fact_id ?? fact.fact_id);
}), JSON.stringify(portfolioFacts.map((f) => ({ id: f.fact_id, prov: f.provenance_fact_id }))));

check('展示兜底：sellProceeds 无 display 时仍格式化为金额', factDisplay({ key: 'sellProceeds', value: 11000, display: null }) === '¥11,000.00',
  factDisplay({ key: 'sellProceeds', value: 11000, display: null }));
check('展示兜底：已有 display 不被改写', factDisplay({ key: 'drag', value: 0.1, display: '+10.0pp' }) === '+10.0pp',
  factDisplay({ key: 'drag', value: 0.1, display: '+10.0pp' }));
check('展示兜底：heldShares 显示股数', factDisplay({ key: 'heldShares', value: 100 }) === '100 股');

/* —— 单条事实使用自己的 verify verdict，而不是整份 review.status —— */
{
  const [passFact, failFact] = labelled;
  const review = {
    ...bundle.review,
    status: 'degraded',
    verify: {
      ...bundle.review.verify,
      facts: bundle.review.verify.facts.map((f) => {
        if (f.fact_id === passFact.fact_id) return { ...f, verdict: 'pass' };
        if (f.fact_id === failFact.fact_id) return { ...f, verdict: 'fail', reasons: [{ code: 'E_TEST_FAIL', message: '合成失败原因' }] };
        return f;
      }),
    },
  };
  const mixed = { ...bundle, review };
  const passProv = factProvenance(mixed, passFact);
  const failProv = factProvenance(mixed, failFact);
  const failHtml = factDetail(failFact, mixed);
  check('复核状态：整份 review=degraded 时仍按单条 fact verdict 显示', passProv.verify_verdict === 'pass'
    && failProv.verify_verdict === 'fail' && failProv.blocked === true, JSON.stringify({ pass: passProv.verify_verdict, fail: failProv.verify_verdict }));
  check('复核状态：失败事实展开显示 fail 与原因，不显示整份 review.status', failHtml.includes('复核：fail')
    && failHtml.includes('E_TEST_FAIL') && !failHtml.includes('复核：degraded'), failHtml.slice(0, 500));
}

/* —— 超过 8 笔来源时可展开全部，逐笔可回成交行 —— */
{
  const refs = Array.from({ length: 12 }, (_, i) => ({ type: 'trade', key: `T${String(i + 1).padStart(3, '0')}`, file: 'synthetic.csv', line: i + 2 }));
  const fact = { key: 'buyCost', fact_id: 'portfolio.buyCost', provenance_fact_id: 'portfolio.buyCost', display: '¥1.00' };
  const fake = {
    review: {
      status: 'degraded',
      meta: { verify_id: 'V-test0001' },
      verify: { facts: [{ fact_id: 'portfolio.buyCost', verdict: 'pass' }] },
      published_facts: [fact],
    },
    provenance: { items: [{ fact_id: 'portfolio.buyCost', formula_id: 'CALC_TEST', formula_text: 'test', source_refs: refs, steps: [], blocked: false }] },
  };
  const html = factDetail(fact, fake);
  check('来源全部可达：12 笔时显示“查看全部 12 笔来源”，含第 12 笔文件/行号', html.includes('查看全部 12 笔来源')
    && html.includes('T012') && html.includes('synthetic.csv 第 13 行'), html.slice(-1200));
  check('来源全部可达：每笔 source_ref 都进入展开列表', refs.every((r) => html.includes(`${r.file} 第 ${r.line} 行（${r.key}）`)), 'missing source row');
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
