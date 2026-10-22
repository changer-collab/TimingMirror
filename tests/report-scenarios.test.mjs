#!/usr/bin/env node
/**
 * 报告页示例场景 + 条件展示单元测试。
 * 覆盖：八套场景均为冻结行情且复核发布；行为/候选/PGR 只在成立或样本足够时进入用户视图；
 *       无卖出账单不生成单笔反事实与瀑布；无模式/低样本/卖后追回/频繁交易按预期暴露 AI 盲区。
 */
import { loadReportScenarioBill, loadUserBillFromTable, loadUserBillReport } from '../src/demo/adapter.js';
import { REPORT_SCENARIOS, getReportScenarioByFileName, matchReportScenario } from '../src/demo/reportScenarios.js';
import { buildLocalDraft, isLocalDraftComplete, localDraftTable } from '../src/engine/importDraft.js';
import { parseDelimitedText } from '../src/engine/importSource.js';
import { buildRuleCandidates } from '../src/engine/userProfile.js';
import { reportVisibility } from '../prototype/user-frontend/realReport.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const EMPTY_RULE_STATE = { active_templates: [], active_count: 0, version_count: 0 };

async function scenarioBundle(id) {
  const bill = await loadReportScenarioBill(id, { contextId: `test-${id}` });
  const bundle = await loadUserBillReport(bill);
  const candidatePack = buildRuleCandidates({
    behavior: bundle.insights?.behavior?.available ? bundle.insights.behavior.data : null,
    ruleState: EMPTY_RULE_STATE,
    profile: null,
  });
  return { bill, bundle, candidatePack, vis: reportVisibility({ bundle, candidatePack }) };
}

const chase = await scenarioBundle('chase');
const early = await scenarioBundle('early');
const stop = await scenarioBundle('stop');
const hold = await scenarioBundle('hold');
const noPattern = await scenarioBundle('no_pattern');
const lowSample = await scenarioBundle('low_sample');
const sellRebuy = await scenarioBundle('sell_rebuy');
const overtrading = await scenarioBundle('overtrading');
const allScenarios = [chase, early, stop, hold, noPattern, lowSample, sellRebuy, overtrading];

check('场景清单：8 个场景且 id / 文件名唯一', REPORT_SCENARIOS.length === 8
  && new Set(REPORT_SCENARIOS.map((s) => s.id)).size === 8
  && new Set(REPORT_SCENARIOS.map((s) => s.fileName)).size === 8
  && REPORT_SCENARIOS.every((s) => s.expectation && Number.isFinite(s.expectation.sample_n)), JSON.stringify(REPORT_SCENARIOS.map((s) => s.id)));

for (const { bill, bundle } of allScenarios) {
  const id = bill.demoScenarioId;
  check(`${id}：示例账单标记且走冻结行情`, bill.demo === true && bundle.demo === true && bundle.marketSource?.id === 'demo-frozen', JSON.stringify({ demo: bundle.demo, market: bundle.marketSource?.id }));
  check(`${id}：复核发布且行情不联网`, bundle.review?.portfolio_published === true && bundle.marketSource?.dynamic === false, JSON.stringify({ published: bundle.review?.portfolio_published, dynamic: bundle.marketSource?.dynamic }));
}

for (const { bill, vis } of allScenarios) {
  const scenario = REPORT_SCENARIOS.find((item) => item.id === bill.demoScenarioId);
  const expected = scenario.expectation;
  const pattern = expected.pattern_id
    ? vis.patterns.find((p) => p.pattern_id === expected.pattern_id) ?? vis.pattern
    : vis.pattern;
  check(`${scenario.id}：场景预期与引擎三态一致`, pattern?.status === expected.behavior_status
    && pattern?.sample_n === expected.sample_n
    && pattern?.evaluated_n === expected.evaluated_n
    && vis.behavior === expected.behavior_visible
    && vis.candidate === expected.candidate_visible, JSON.stringify({
    expected: { status: expected.behavior_status, n: expected.sample_n, evaluated: expected.evaluated_n },
    actual: { status: pattern?.status, n: pattern?.sample_n, evaluated: pattern?.evaluated_n, behavior: vis.behavior, candidate: vis.candidate },
  }));
}

{
  const { bundle, vis } = chase;
  const portfolio = bundle.insights.portfolio;
  const pgr = bundle.insights.pgr.data;
  check('chase：行为成立且报告展示', vis.behavior === true && vis.pattern?.status === '成立' && vis.pattern.sample_n === 2, JSON.stringify({ behavior: vis.behavior, sample: vis.pattern?.sample_n }));
  check('chase：规则候选可用', vis.candidate === true && vis.candidateData?.status === 'available', JSON.stringify(vis.candidateData));
  check('chase：三笔反事实与正损耗', portfolio.counterfactuals.length === 3 && portfolio.report.portfolio.dragMoney === 1750.5, JSON.stringify({ cf: portfolio.counterfactuals.length, drag: portfolio.report.portfolio.dragMoney }));
  check('chase：PGR 样本足够后展示', vis.pgr === true && pgr.counts.realized.total === 3 && pgr.counts.paper.total === 2, JSON.stringify(pgr.counts));
  check('chase：对照/瀑布/归因可见', vis.ghost && vis.waterfall && vis.attribution && vis.stockSelf, JSON.stringify(vis));
}

{
  const { bundle, vis } = early;
  const portfolio = bundle.insights.portfolio;
  check('early：行为未成立则不展示', vis.behavior === false && vis.pattern?.status === '不成立', JSON.stringify({ behavior: vis.behavior, status: vis.pattern?.status }));
  check('early：没有可用候选则不展示', vis.candidate === false, JSON.stringify(vis.candidate));
  check('early：两笔反事实且损耗为正', portfolio.counterfactuals.length === 2 && portfolio.report.portfolio.dragMoney === 509, JSON.stringify({ cf: portfolio.counterfactuals.length, drag: portfolio.report.portfolio.dragMoney }));
  check('early：卖出样本不足则不展示 PGR', vis.pgr === false, JSON.stringify(bundle.insights.pgr.data?.counts));
  check('early：对照与瀑布仍可见', vis.ghost && vis.waterfall && vis.attribution, '');
}

{
  const { bundle, vis } = stop;
  const portfolio = bundle.insights.portfolio;
  const cf = portfolio.counterfactuals[0];
  check('stop：行为证据不足则不展示', vis.behavior === false && vis.pattern?.status === '证据不足', JSON.stringify({ behavior: vis.behavior, status: vis.pattern?.status }));
  check('stop：止损后下跌显示为负损耗', portfolio.report.portfolio.dragMoney === -2364 && cf.replace.recoveredMoney === -2364, JSON.stringify({ drag: portfolio.report.portfolio.dragMoney, recovered: cf?.replace?.recoveredMoney }));
  check('stop：没有候选与 PGR', vis.candidate === false && vis.pgr === false, JSON.stringify({ candidate: vis.candidate, pgr: vis.pgr }));
}

{
  const { bundle, vis } = hold;
  const portfolio = bundle.insights.portfolio;
  check('hold：无卖出则无单笔对照', vis.hasSells === false && vis.ghost === false && vis.waterfall === false, JSON.stringify({ sells: vis.hasSells, ghost: vis.ghost, waterfall: vis.waterfall }));
  check('hold：损耗为 0 且行为未成立', portfolio.report.portfolio.dragMoney === 0 && vis.behavior === false, JSON.stringify({ drag: portfolio.report.portfolio.dragMoney, behavior: vis.behavior }));
  check('hold：只有买入不展示候选与 PGR', vis.candidate === false && vis.pgr === false, '');
}

{
  const { bundle, vis } = noPattern;
  check('no_pattern：3 笔可评估、0 命中，不展示行为与候选', vis.behavior === false && vis.pattern?.status === '不成立'
    && vis.pattern.sample_n === 0 && vis.pattern.evaluated_n === 3 && vis.candidate === false, JSON.stringify({ status: vis.pattern?.status, n: vis.pattern?.sample_n, evaluated: vis.pattern?.evaluated_n }));
  check('no_pattern：仍能看到普通交易的反事实', Array.isArray(bundle.insights.portfolio.counterfactuals) && bundle.insights.portfolio.counterfactuals.length >= 2, JSON.stringify(bundle.insights.portfolio.counterfactuals?.length));
}

{
  const { vis } = lowSample;
  check('low_sample：单次命中判证据不足，不展示行为与候选', vis.behavior === false && vis.pattern?.status === '证据不足'
    && vis.pattern.sample_n === 1 && vis.pattern.evaluated_n === 1 && vis.candidate === false, JSON.stringify({ status: vis.pattern?.status, n: vis.pattern?.sample_n, evaluated: vis.pattern?.evaluated_n }));
}

{
  const { vis } = sellRebuy;
  const p = vis.patterns.find((x) => x.pattern_id === 'sell_rebuy_within_2d') ?? {};
  check('sell_rebuy：卖后两日内买回成立（n=2/已评估2），展示行为与候选', vis.behavior === true && p.status === '成立'
    && p.sample_n === 2 && p.evaluated_n === 2 && vis.candidate === true
    && vis.candidates.some((c) => c.template_id === 'no_buy_back_within'), JSON.stringify({ visible: vis.behavior, status: p.status, n: p.sample_n, evaluated: p.evaluated_n, candidates: vis.candidates?.map((c) => c.template_id) }));
}

{
  const { vis } = overtrading;
  const p = vis.patterns.find((x) => x.pattern_id === 'overtrading') ?? {};
  check('overtrading：4 次完整往返成立，展示行为但暂无对应规则模板', vis.behavior === true && p.status === '成立'
    && p.sample_n === 4 && p.evaluated_n === 4 && vis.candidate === false, JSON.stringify({ visible: vis.behavior, status: p.status, n: p.sample_n, evaluated: p.evaluated_n }));
}

{
  const { vis } = chase;
  check('展示开关不含内部状态码', !JSON.stringify(vis).includes('not_recommended') && !JSON.stringify(vis).includes('dismissed'), '');
}

{
  const expected = new Map(allScenarios.map((item) => [item.bill.demoScenarioId, item]));
  for (const scenario of REPORT_SCENARIOS) {
    const parsed = parseDelimitedText(scenario.csv);
    const draft = buildLocalDraft(parsed, scenario.fileName);
    const table = localDraftTable(draft);
    const byName = getReportScenarioByFileName(scenario.fileName);
    const byContent = matchReportScenario({ fileName: '重命名后的示例.csv', table });
    const bill = await loadUserBillFromTable(table, scenario.fileName, { method: 'manual', scenario: byContent });
    const bundle = await loadUserBillReport({ ...bill, status: 'confirmed', contextId: `upload-${scenario.id}` });
    const candidatePack = buildRuleCandidates({ behavior: bundle.insights?.behavior?.available ? bundle.insights.behavior.data : null, ruleState: EMPTY_RULE_STATE, profile: null });
    const vis = reportVisibility({ bundle, candidatePack });
    const direct = expected.get(scenario.id).vis;
    check(`${scenario.id}：下载的 CSV 可被本地解析并通过上传校验`, parsed.header.length === 7 && parsed.rows.length === scenario.table.rows.length && isLocalDraftComplete(draft, scenario.fileName), JSON.stringify({ header: parsed.header, rows: parsed.rows.length }));
    check(`${scenario.id}：上传后按文件名或内容识别并走冻结行情`, byName?.id === scenario.id && byContent?.id === scenario.id && bill.demo === true && bundle.marketSource?.id === 'demo-frozen' && bundle.review?.portfolio_published === true, JSON.stringify({ name: byName?.id, content: byContent?.id, demo: bill.demo, market: bundle.marketSource?.id }));
    check(`${scenario.id}：上传路径与直接示例的展示结果一致`, vis.ghost === direct.ghost && vis.waterfall === direct.waterfall && vis.attribution === direct.attribution && vis.behavior === direct.behavior && vis.pgr === direct.pgr && vis.candidate === direct.candidate, JSON.stringify({ uploaded: { ghost: vis.ghost, behavior: vis.behavior, pgr: vis.pgr, candidate: vis.candidate }, direct: { ghost: direct.ghost, behavior: direct.behavior, pgr: direct.pgr, candidate: direct.candidate } }));
  }
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
