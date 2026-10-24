#!/usr/bin/env node
/**
 * 个人中心“画像与规则”回归（静态结构 + 助手入口；不联网、不调用模型）
 *
 * 覆盖：个人中心标题与结构；不出现 SELF CHECK / 申报前自检 / 假如买入卖出 / 自检控件；
 *       画像、历史观察与规则管理保留；#/scenario 仍按真实成交逐笔复盘；
 *       助手在个人中心只给历史复盘入口，复盘页在结果加载后才给 AI 解释。
 * 运行：node tests/ui/me-page-rules.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defaultAssistant, defaultBill, defaultContracts } from '../../src/state.js';
import { pageHelpInfo } from '../../src/ui/qaAssistant.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const app = readFileSync(join(ROOT, 'prototype/user-frontend/app.js'), 'utf8');
const bridge = readFileSync(join(ROOT, 'prototype/user-frontend/realBridge.js'), 'utf8');
const contractView = readFileSync(join(ROOT, 'src/ui/views/contractView.js'), 'utf8');
const scenarioView = readFileSync(join(ROOT, 'src/ui/views/scenarioReviewView.js'), 'utf8');
const reviewEngine = readFileSync(join(ROOT, 'src/engine/tradeReview.js'), 'utf8');
const realProfile = readFileSync(join(ROOT, 'prototype/user-frontend/realProfile.js'), 'utf8');
const assistant = readFileSync(join(ROOT, 'src/ui/qaAssistant.js'), 'utf8');
const css = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const block = (source, start, endMarker) => {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(endMarker, from + start.length);
  return source.slice(from, to < 0 ? source.length : to);
};

const mePage = block(app, 'function mePage()', '\n  function scenarioPage()');
const scenarioPage = block(app, 'function scenarioPage()', '\n  /* ---------- home');
const FORBIDDEN = /SELF CHECK|申报前自检|假如买入|假如卖出|sim-action-|sim-symbol|sim-date|测试该日/;

/* ==== 个人中心结构 ==== */
check('个人中心：标题为“画像与规则”',
  /<h1>画像与规则<\/h1>/.test(mePage)
  && /PROFILE &amp; RULES \/ 画像与规则/.test(mePage)
  && !/画像、规则与自检|MY MIRROR/.test(mePage),
  mePage.slice(0, 360));

check('个人中心：不再出现自检区块、假如买入卖出或单次日期/标的控件',
  !FORBIDDEN.test(mePage)
  && !/tm-real-selfcheck|tm-me-selfcheck/.test(app)
  && !/mountSelfCheckView/.test(app + bridge)
  && !FORBIDDEN.test(contractView)
  && !/section === 'selfcheck'/.test(contractView)
  && !/tm-me-selfcheck|tm-real-selfcheck/.test(css),
  [mePage, contractView].join('\n').slice(0, 600));

check('个人中心：保留画像、历史观察与规则管理挂载',
  /id="tm-real-profile"/.test(mePage) && /id="tm-real-rules"/.test(mePage)
  && /renderRealProfile\(document\.getElementById\('tm-real-profile'\)/.test(app)
  && /mountContractView\(document\.getElementById\('tm-real-rules'\)\)/.test(app)
  && /function historyBlock\(profile\)/.test(realProfile)
  && /最近观察/.test(realProfile)
  && /class="rp-profile"/.test(realProfile),
  mePage);

check('个人中心：规则新增/编辑/停用/恢复/版本历史仍在规则工作区',
  /data-role': `add-rule-\$\{action\}`/.test(contractView)
  && /data-role': 'edit'/.test(contractView)
  && /data-role': 'stop'/.test(contractView)
  && /data-role': 'restore'/.test(contractView)
  && /data-role': 'history'/.test(contractView)
  && /历史规则（\$\{histCount\}）/.test(contractView)
  && /版本 v\$\{safe\(/.test(contractView)
  && /data-role': 'rule-modal'/.test(contractView));

/* ==== #/scenario 历史复盘保留 ==== */
check('复盘页：仍挂载独立 scenario 视图并自动加载历史复盘',
  /state\.route === 'scenario'\) html = scenarioPage\(\)/.test(app)
  && /mountScenarioView\(document\.getElementById\('tm-real-scenario'\)\)/.test(app)
  && /export function mountScenarioView/.test(bridge)
  && /section: 'scenario'/.test(bridge)
  && /if \(section === 'scenario'\) \{\s*renderScenarioReview\(root, ctx\);\s*return;/.test(contractView)
  && /adapter\.contractSimContext\(/.test(scenarioView));

check('复盘页：展示操作总数、违背、符合、无法确认、无此情境与逐笔依据',
  /stat\('操作', s\.trades_n\)/.test(scenarioView)
  && /stat\('违背', s\.violated_n/.test(scenarioView)
  && /stat\('符合', s\.compliant_n/.test(scenarioView)
  && /stat\('无法确认', s\.missing_n/.test(scenarioView)
  && /没有对应情境/.test(scenarioView)
  && /not_applicable: '无此情境'/.test(reviewEngine)
  && /data-trade-id/.test(scenarioView)
  && /tr-rule-more/.test(scenarioView)
  && /el\('div', \{\}, \[event\.message\]\)/.test(scenarioView)
  && /buildTradeReview\(\{ trades, ledger, patterns, market \}\)/.test(
    readFileSync(join(ROOT, 'src/demo/adapter.js'), 'utf8'),
  ));

check('复盘页：报告发布后仍按 reviewKey 预取，规则变化会失效',
  /async function prewarmScenarioReview\(bill\)/.test(bridge)
  && /reviewKey = `\$\{src\.key\}\|\$\{currentRules\.map/.test(bridge)
  && /simContext: \{ \.\.\.context, reviewKey \}/.test(bridge)
  && /context\.reviewKey !== contextKey/.test(scenarioView)
  && /const ruleSet = adapter\.contractRuleSet\(c\.versions \?\? \[\]\)/.test(scenarioView));

/* ==== 助手入口：个人中心 vs 历史复盘 ==== */
function helpState(overrides = {}) {
  return {
    route: 'contract',
    contractPage: 'me',
    bill: {
      ...defaultBill(),
      status: 'confirmed',
      sourceType: 'local',
      blocked: false,
      trades: [{ trade_id: 'T1' }],
      contextId: 'me-rules-1',
    },
    report: { symbol: 'pool' },
    chat: { messages: [] },
    contracts: { ...defaultContracts(), versions: [], simContext: null },
    assistant: { ...defaultAssistant(), view: 'explain', qaMessages: [] },
    ...overrides,
  };
}
const deps = { getReportBundle: () => null, explainReviewResult: async () => ({ ok: false }) };
const REVIEW = { summary: { trades_n: 1 }, operations: [] };

{
  const state = helpState({
    contractPage: 'me',
    contracts: { ...defaultContracts(), versions: [], simContext: { review: REVIEW } },
    assistant: { ...defaultAssistant(), simulation: { result_id: 'sim-1' }, resultExplanation: { answer_text: 'x' } },
  });
  const primary = pageHelpInfo(state, deps).primary;
  check('助手·个人中心：只提供前往历史复盘，不显示复盘 AI 解释或自检入口',
    primary?.id === 'review-open'
    && primary?.kind === 'link'
    && primary?.href === '#/scenario'
    && primary?.label === '前往历史复盘'
    && !FORBIDDEN.test(primary?.label + primary?.note)
    && !/让 AI 解释复盘结果/.test(primary?.label ?? ''),
    JSON.stringify(primary));
}

{
  const state = helpState({
    contractPage: 'scenario',
    contracts: { ...defaultContracts(), versions: [], simContext: null },
    assistant: { ...defaultAssistant(), simulation: { result_id: 'sim-1' } },
  });
  const primary = pageHelpInfo(state, deps).primary;
  check('助手·复盘页：复盘结果未加载时只提供打开规则管理',
    primary?.id === 'rules-open'
    && primary?.kind === 'link'
    && primary?.href === '#/me'
    && primary?.label === '打开规则管理'
    && !/让 AI 解释复盘结果/.test(primary?.label ?? ''),
    JSON.stringify(primary));
}

{
  const state = helpState({
    contractPage: 'scenario',
    contracts: { ...defaultContracts(), versions: [], simContext: { review: REVIEW } },
    assistant: { ...defaultAssistant(), simulation: { result_id: 'sim-1' } },
  });
  const primary = pageHelpInfo(state, deps).primary;
  check('助手·复盘页：复盘结果加载且有复核摘要时才显示 AI 解释入口',
    primary?.id === 'review-ai'
    && primary?.kind === 'review-ai'
    && primary?.label === '让 AI 解释复盘结果'
    && primary?.disabled === false,
    JSON.stringify(primary));
}

{
  const state = helpState({
    contractPage: 'scenario',
    contracts: { ...defaultContracts(), versions: [], simContext: { review: REVIEW } },
    assistant: { ...defaultAssistant() },
  });
  const primary = pageHelpInfo(state, deps).primary;
  check('助手·复盘页：不伪造 simulation/flow 来强行显示 AI 解释',
    primary?.id === 'rules-open'
    && primary?.label === '打开规则管理'
    && !/让 AI 解释复盘结果/.test(primary?.label ?? ''),
    JSON.stringify(primary));
}

check('助手：历史复盘解释仍走 explainReviewResult，且不依赖个人中心自检',
  /explainReviewResult: \(\) => explainReviewResult\(\)/.test(bridge)
  && /async function explainReviewResult\(\)/.test(bridge)
  && /const pending = explainAssistantResult\(\)/.test(bridge)
  && /if \(ctx\.state\.contractPage !== 'scenario' \|\| !ctx\.state\.contracts\?\.simContext\?\.review\) return;/.test(assistant)
  && !/selfcheck|申报前自检|simulateContracts|requested_date/.test(
    block(assistant, 'async function runReviewExplain(ctx)', '\n}\n'),
  ));

check('脚本：个人中心回归测试加入 npm run check',
  /node tests\/ui\/me-page-rules\.test\.mjs/.test(pkg));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
