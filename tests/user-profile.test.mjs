#!/usr/bin/env node
/**
 * 用户画像与规则候选（src/engine/userProfile.js）单元测试。
 * 覆盖：画像快照只含派生统计（不含成交明细/文件名）、稳定 profile_key、维度行；
 *       连续合并（观察数/历史上限/趋势）、候选事件；规则候选三态（可建立/已有/已忽略/不推荐）、
 *       阈值映射与证据展示串（% 而非 pp）、口径提示（模板=当天涨幅≠回看窗口）。
 */
import { computeIndicators } from '../src/engine/indicators.js';
import { buildPatternList } from '../src/engine/behavior.js';
import { computePGR } from '../src/engine/pgr.js';
import {
  PROFILE_VERSION, RULE_CANDIDATE_VERSION, CHASE_CANDIDATE_ID,
  emptyProfile, buildProfileSnapshot, mergeProfile, withCandidateEvent, withRuleState, buildRuleCandidates,
} from '../src/engine/userProfile.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const DAYS = ['2024-08-01', '2024-08-02', '2024-08-05', '2024-08-06', '2024-08-07', '2024-08-08', '2024-08-09', '2024-08-12', '2024-08-13', '2024-08-14'];
const CLOSES = [100, 100, 100, 100, 100, 100, 120, 120, 120, 121];
const market = {
  tradingDays: DAYS,
  resolveValuation: (date) => (DAYS.includes(date)
    ? { blocked: false, effective_date: date }
    : { blocked: true, code: 'E_DATE_OUT_OF_RANGE' }),
  getClose: (symbol, date) => {
    const i = DAYS.indexOf(date);
    return symbol === 'AAA' && i >= 0 ? CLOSES[i] : null;
  },
};
const trades = [
  { trade_id: 'T1', trade_date: '2024-08-12', symbol: 'AAA', side: 'buy', price: 118, quantity: 100, source: { file: 'my-bill.csv', line: 2 } },
  { trade_id: 'T2', trade_date: '2024-08-13', symbol: 'AAA', side: 'buy', price: 119, quantity: 50, source: { file: 'my-bill.csv', line: 3 } },
  { trade_id: 'T3', trade_date: '2024-08-14', symbol: 'AAA', side: 'sell', price: 121, quantity: 30, source: { file: 'my-bill.csv', line: 4 } },
];
const behavior = buildPatternList({ trades, market });
const report = computeIndicators({ trades, closes: { AAA: 121 } });
const pgr = computePGR({ trades, closes: { AAA: 121 } });
const review = {
  status: 'ok',
  portfolio_published: true,
  published_facts: [{ key: 'actualRet' }, { key: 'ghostRet' }],
  blocked_facts: [],
  degraded: [],
  meta: { verify_id: 'V-1' },
  provenance: { summary: { n: 2, blocked_n: 0 } },
};
const stockSelf = {
  status: 'complete', ret: 0.21, display: { ret: '+21.0%' },
  coverage: { total_buy_cost: 17750, covered_buy_cost: 17750, ratio: 1, complete: true },
};
const ruleState = { active_templates: [], active_count: 0, version_count: 0, active_count_placeholder: null };

/* ---- 画像快照：只派生、不保存成交明细 ---- */
{
  check('行为夹具：追高成立 n=2（已评估 2）', behavior.patterns[0].status === '成立' && behavior.patterns[0].sample_n === 2, JSON.stringify({ s: behavior.patterns[0].status, n: behavior.patterns[0].sample_n }));
  const snap = buildProfileSnapshot({ report, behavior, stockSelf, pgr, review, trades, ruleState, at: '2026-10-21T00:00:00.000Z' });
  check('快照版本与时间戳', snap.version === PROFILE_VERSION && snap.at === '2026-10-21T00:00:00.000Z', JSON.stringify({ v: snap.version, at: snap.at }));
  check('账单摘要：3 笔 / 2 买 / 1 卖 / 1 只标的', snap.bill.trade_count === 3 && snap.bill.buy_count === 2 && snap.bill.sell_count === 1 && snap.bill.symbol_count === 1, JSON.stringify(snap.bill));
  check('结果摘要沿用组合展示串', snap.outcome.actual_ret === report.portfolio.actualRet && snap.outcome.drag === report.portfolio.drag && snap.outcome.display.drag_money === report.portfolio.display.dragMoney, JSON.stringify(snap.outcome));
  check('行为摘要：模式名/三态/n/阈值齐备', snap.behavior.patterns[0].name === '追高买入' && snap.behavior.patterns[0].status === '成立' && snap.behavior.patterns[0].sample_n === 2 && snap.behavior.patterns[0].rule.threshold === 0.1, JSON.stringify(snap.behavior));
  check('PGR 摘要：计数与展示串', snap.pgr.pgr === pgr.pgr && snap.pgr.display.pgr === pgr.display.pgr && snap.pgr.counts.realized.gain === 1, JSON.stringify(snap.pgr));
  check('复核摘要：发布/阻断/降级计数与 verify_id', snap.review.portfolio_published === true && snap.review.published_count === 2 && snap.review.verify_id === 'V-1', JSON.stringify(snap.review));
  check('画像维度 5 行（交易样貌/结果差距/行为证据/卖出倾向/规则使用）', JSON.stringify(snap.dimensions.map((d) => d.key)) === JSON.stringify(['activity', 'outcome', 'behavior', 'disposition', 'rules']), JSON.stringify(snap.dimensions.map((d) => d.key)));
  const text = JSON.stringify(snap);
  check('隐私边界：快照不含成交 ID、标的代码、价格、文件名或 CSV 行号', !text.includes('T1') && !text.includes('AAA') && !text.includes('my-bill.csv') && !text.includes('trade_id') && !text.includes('118'), text.slice(0, 300));
  check('稳定 profile_key：同一账单同键、不同账单不同键', snap.profile_key === buildProfileSnapshot({ report, behavior, stockSelf, pgr, review, trades, ruleState }).profile_key && snap.profile_key !== buildProfileSnapshot({ report, behavior, stockSelf, pgr, review, trades: trades.slice(0, 2), ruleState }).profile_key, snap.profile_key);
  const empty = buildProfileSnapshot({ trades, ruleState });
  check('未发布结果：outcome/behavior/pgr 为 null，画像不编造结论', empty.outcome === null && empty.behavior === null && empty.pgr === null && empty.stock_self === null && empty.dimensions.find((d) => d.key === 'outcome').value === '组合结果未发布', JSON.stringify(empty.outcome));
}

/* ---- 连续画像：观察数、历史上限、趋势、候选事件 ---- */
{
  const snap = buildProfileSnapshot({ report, behavior, stockSelf, pgr, review, trades, ruleState, at: '2026-10-21T00:00:00.000Z' });
  const empty = emptyProfile();
  check('空画像结构', empty.version === PROFILE_VERSION && empty.observations === 0 && Array.isArray(empty.history) && empty.latest === null && typeof empty.rule_events === 'object', JSON.stringify(empty));
  const first = mergeProfile(empty, snap, { at: '2026-10-21T00:00:00.000Z' });
  check('首次合并：观察数 1、历史 1、created_at=updated_at', first.observations === 1 && first.history.length === 1 && first.created_at === '2026-10-21T00:00:00.000Z' && first.updated_at === first.created_at, JSON.stringify({ o: first.observations, h: first.history.length }));
  const later = buildProfileSnapshot({ report, behavior, stockSelf, pgr, review, trades: trades.slice(0, 2), ruleState, at: '2026-10-22T00:00:00.000Z' });
  const second = mergeProfile(first, later, { at: '2026-10-22T00:00:00.000Z' });
  check('二次合并：观察数 2、保留创建时间、更新 latest', second.observations === 2 && second.created_at === first.created_at && second.latest.bill.trade_count === 2, JSON.stringify({ o: second.observations, trades: second.latest.bill.trade_count }));
  check('趋势：交易数 −1 天、损耗差额有方向与展示串', second.trend.trade_count_delta === -1 && ['up', 'down', 'flat'].includes(second.trend.drag_direction) && /^[+-]¥/.test(second.trend.drag_money_delta_display), JSON.stringify(second.trend));
  check('历史条目：保留引擎展示串（不在页面重算格式）', second.history[1].display.drag_money === report.portfolio.display.dragMoney && second.history[1].display.actual_ret === report.portfolio.display.actualRet, JSON.stringify(second.history[1]));
  let many = first;
  for (let i = 0; i < 14; i += 1) many = mergeProfile(many, later, { at: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` });
  check('历史最多保留 12 条', many.history.length === 12 && many.observations === 15, JSON.stringify({ h: many.history.length, o: many.observations }));
  const opened = withCandidateEvent(many, CHASE_CANDIDATE_ID, 'opened', { at: '2026-11-20T00:00:00.000Z' });
  const dismissed = withCandidateEvent(opened, CHASE_CANDIDATE_ID, 'dismissed', { at: '2026-11-21T00:00:00.000Z' });
  check('候选事件：记录 opened→dismissed 与时间', dismissed.rule_events[CHASE_CANDIDATE_ID].status === 'dismissed' && dismissed.rule_events[CHASE_CANDIDATE_ID].at === '2026-11-21T00:00:00.000Z', JSON.stringify(dismissed.rule_events));
  check('候选事件：非法状态不写入', withCandidateEvent(dismissed, CHASE_CANDIDATE_ID, 'bogus').rule_events[CHASE_CANDIDATE_ID].status === 'dismissed', '');
  check('候选事件：保留历史与观察数', dismissed.history.length === 12 && dismissed.observations === 15, JSON.stringify({ h: dismissed.history.length, o: dismissed.observations }));
  const synced = withRuleState(dismissed, { active_templates: ['no_buy_on_surge'], active_count: 1, version_count: 2 }, { at: '2026-11-22T00:00:00.000Z' });
  check('规则同步：更新规则维度但不增加观察次数', synced.observations === 15 && synced.latest.rules.active_count === 1 && synced.latest.dimensions.find((d) => d.key === 'rules').value === '当前 1 条 / 版本 2 条', JSON.stringify(synced.latest.rules));
  check('规则同步：无变化时原样返回', withRuleState(synced, { active_templates: ['no_buy_on_surge'], active_count: 1, version_count: 2 }) === synced, '');
}

/* ---- 规则候选：由行为证据映射到既有模板，须用户确认 ---- */
{
  const { candidates, notes } = buildRuleCandidates({ behavior, ruleState, profile: null });
  const c = candidates[0];
  check('候选版本与唯一候选 ID', RULE_CANDIDATE_VERSION === 'candidate-1' && c.candidate_id === CHASE_CANDIDATE_ID && c.version === RULE_CANDIDATE_VERSION, JSON.stringify({ id: c.candidate_id }));
  check('候选：模板映射 no_buy_on_surge，阈值 = 10%', c.template_id === 'no_buy_on_surge' && c.threshold === 10 && c.fields.threshold_pct === '10' && c.text.includes('10%'), JSON.stringify({ t: c.template_id, th: c.threshold, text: c.text }));
  check('候选：可建立状态与证据引用', c.status === 'available' && c.source_pattern.status === '成立' && c.source_pattern.sample_n === 2 && c.evidence.length === 2 && c.evidence.every((e) => e.trade_id && e.line.includes('%')), JSON.stringify({ s: c.status, e: c.evidence }));
  check('候选：证据展示用 % 而非 pp', c.evidence.every((e) => !e.line.includes('pp')) && c.evidence[0].line.includes('+20.0%'), JSON.stringify(c.evidence.map((e) => e.line)));
  check('候选：依据不重复“买入日前”且含最小样本', c.basis.includes('买入日前 5 个交易日') && !c.basis.includes('买入日前 买入日前') && c.basis.includes('最小样本 2'), c.basis);
  check('候选：口径提示（当天涨幅 ≠ 回看窗口）且不自动生效', c.caveat.includes('当天涨幅') && c.caveat.includes('回看窗口') && c.caveat.includes('不替你定规矩'), c.caveat);
  check('候选说明：来源为账单证据、非 LLM、非其他用户', notes.length === 2 && notes[0].includes('不来自 LLM') && notes[1].includes('不会自动生效'), JSON.stringify(notes));

  const active = buildRuleCandidates({ behavior, ruleState: { active_templates: ['no_buy_on_surge'], active_count: 1, version_count: 1 } }).candidates[0];
  check('已存在同类规则：不重复推荐', active.status === 'active' && active.status_text === '已有同类规则' && active.reason.includes('不重复推荐'), JSON.stringify({ s: active.status, r: active.reason }));

  const snap = buildProfileSnapshot({ report, behavior, stockSelf, pgr, review, trades, ruleState });
  const profile = mergeProfile(emptyProfile(), snap);
  const dismissedProfile = withCandidateEvent(profile, CHASE_CANDIDATE_ID, 'dismissed');
  const dismissed = buildRuleCandidates({ behavior, ruleState, profile: dismissedProfile }).candidates[0];
  check('已忽略：状态 dismissed 且记录事件时间', dismissed.status === 'dismissed' && dismissed.status_text === '已忽略' && dismissed.event.status === 'dismissed', JSON.stringify({ s: dismissed.status, e: dismissed.event }));

  const insufficient = { ...behavior, patterns: [{ ...behavior.patterns[0], status: '证据不足', evaluated_n: 1 }] };
  const nr = buildRuleCandidates({ behavior: insufficient, ruleState, profile: null }).candidates[0];
  check('证据不足：不推荐且理由引用最小样本', nr.status === 'not_recommended' && nr.reason.includes('证据不足') && nr.reason.includes('最小样本 2'), JSON.stringify({ s: nr.status, r: nr.reason }));
  check('无行为发现：不生成候选、不虚构模式', buildRuleCandidates({ behavior: null, ruleState }).candidates.length === 0, '');
}

let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
