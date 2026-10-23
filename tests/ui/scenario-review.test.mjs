#!/usr/bin/env node
/**
 * 操作复盘页（#/scenario）静态契约回归（不联网）。
 * 覆盖：真实成交聚合、汇总/习惯/时间线、状态分支、报告发布后预加载、口径披露与移动端样式。
 * 运行：node tests/ui/scenario-review.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const view = readFileSync(join(ROOT, 'src/ui/views/scenarioReviewView.js'), 'utf8');
const engine = readFileSync(join(ROOT, 'src/engine/tradeReview.js'), 'utf8');
const adapter = readFileSync(join(ROOT, 'src/demo/adapter.js'), 'utf8');
const contract = readFileSync(join(ROOT, 'src/ui/views/contractView.js'), 'utf8');
const css = readFileSync(join(ROOT, 'src/ui/styles.css'), 'utf8');
const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
const bridge = readFileSync(join(ROOT, 'prototype/user-frontend/realBridge.js'), 'utf8');
const report = readFileSync(join(ROOT, 'prototype/user-frontend/realReport.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

check('入口：scenario 委托到操作复盘视图',
  /if \(section === 'scenario'\) \{\s*renderScenarioReview\(root, ctx\);\s*return;/.test(contract)
  && /export function renderScenarioReview\(root, ctx\)/.test(view));

check('数据：适配器一次返回账本、画像与逐笔复盘',
  /const ledger = buildRuleLedger\(\{ rules, trades, market \}\)/.test(adapter)
  && /const patterns = trades\.length \? buildPatternList\(\{ trades, market \}\) : null/.test(adapter)
  && /review: buildTradeReview\(\{ trades, ledger, patterns, market \}\)/.test(adapter));

check('引擎：按 trade_id 聚合，汇总按唯一操作计数',
  /eventsByTrade\.get\(event\.trade_id\)/.test(engine)
  && /acc\.trades_n \+= 1/.test(engine)
  && /no_buy_back_within/.test(engine)
  && /E_NO_PRIOR_SELL/.test(engine));

check('引擎：画像只挂已成立模式，交易频率不逐笔挂接',
  /p\.status !== '成立'/.test(engine)
  && /PER_TRADE_HABITS = new Set\(\['chase_high_buy', 'sell_rebuy_within_2d', 'quick_flip'\]\)/.test(engine));

check('结论：区分违背/已提醒/无法确认/符合/无此情境/未参与复核',
  ['violated: \'违背规则\'', 'warned: \'已提醒\'', 'missing: \'无法确认\'', 'compliant: \'符合\'', 'not_applicable: \'无此情境\'', 'no_rule: \'未参与复核\'']
    .every((line) => engine.includes(line))
  && /violated: 5, warned: 4, missing: 3, compliant: 2, not_applicable: 1, no_rule: 0/.test(engine.replace(/\s+/g, ' ')));

check('汇总：结果先行，显示操作/违背/符合/无法确认',
  /function headlineOf\(review, customN = 0\)/.test(view)
  && /笔违背了规则/.test(view)
  && /stat\('操作', s\.trades_n\)/.test(view)
  && /stat\('违背', s\.violated_n, 'loss'\)/.test(view)
  && /stat\('符合', s\.compliant_n, 'ok'\)/.test(view)
  && /stat\('无法确认', s\.missing_n, 'mode'\)/.test(view));

check('自定义规则：明确披露未参与逐笔复盘，不计作符合',
  /const customRules = ruleSet\.customCurrent \?\? \[\]/.test(view)
  && /自定义规则暂不参与逐笔复盘/.test(view)
  && /不把它们算作“符合”/.test(view)
  && /customN/.test(view));

check('习惯条：展示已成立习惯并声明不是合规结论',
  /画像同时看到/.test(view)
  && /画像口径，不是合规结论/.test(view)
  && /href: '#\/me'/.test(view));

check('时间线：按成交卡片展示、默认展开首笔违背、可看依据，不显示内部原因码',
  /for \(const op of review\.operations\)/.test(view)
  && /op\.outcome === 'violated'/.test(view)
  && /data-trade-id/.test(view)
  && /tr-rule-more/.test(view)
  && !/原因码/.test(view));

check('情节：交易类规则展示“卖出/买入 → 交易日 → 操作”链',
  /function chainOf\(event, op, byTrade\)/.test(view)
  && /distance_trading_days/.test(view)
  && /tr-chain-arrow/.test(view)
  && /last_sell/.test(view) && /last_buy/.test(view));

check('筛选：提供全部/违背/无法确认，不改变数据',
  /data-filter/.test(view)
  && /label: `违背 \$\{s\.violated_n\}`/.test(view)
  && /label: `无法确认 \$\{s\.missing_n\}`/.test(view)
  && /card\.hidden = !ok/.test(view));

check('规则汇总：每条规则显示复核、违背与无此情境',
  /function ruleSummarySection\(review\)/.test(view)
  && /r\.violated_n/.test(view) && /r\.not_applicable_n/.test(view)
  && /共 \$\{r\.applies_n\} 笔复核/.test(view));

check('口径：披露历史复盘、行情来源/范围、非实时与数据不足不等于符合',
  /function dataDisclosure\(review, context, localBill\)/.test(view)
  && /数据与口径/.test(view)
  && /服务端获取，非实时/.test(view)
  && /行情范围：/.test(view)
  && /review\.notes\.map/.test(view)
  && !/fetchedAt/.test(view) && !/拉取/.test(view));

check('状态：加载/错误/未确认账单/无生效规则/无交易均有明确分支',
  /tr-loading/.test(view) && /tr-error/.test(view)
  && /先导入并确认一份账单/.test(view)
  && /还没有生效规则/.test(view)
  && /这份账单里还没有可复盘的操作/.test(view)
  && /不回落示例数据/.test(view));

check('行情：本地账单固定 Tushare 动态，示例账单可切换来源',
  /const marketSource = localBill \? adapter\.DEFAULT_MARKET_SOURCE/.test(view)
  && /adapter\.CONTRACT_MARKET_OPTIONS\.map/.test(view)
  && /if \(!localBill && !demoAllowed\)/.test(view));

check('边界：页面不再包含假设买入/卖出表单或直连行情',
  !/假如买入|假如卖出|sim-symbol|sim-date/.test(view)
  && !/\bfetch\(/.test(view)
  && /adapter\.contractSimContext\(/.test(view));

check('样式：使用 tr-* 命名并提供移动端 2×2 统计与单列事件',
  /\.tr-page\s*\{/.test(css)
  && /\.tr-op-head\s*\{/.test(css)
  && /@media \(max-width: 680px\) \{[\s\S]*?\.tr-stats, \.tr-stats-plain \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/.test(css)
  && /\.tr-op-main \{ flex-basis: 100%; order: 3; \}/.test(css));

check('预加载：报告发布后按与页面相同的 reviewKey 预取复盘上下文',
  /async function prewarmScenarioReview\(bill\)/.test(bridge)
  && /reviewKey = `\$\{src\.key\}\|\$\{currentRules\.map\(\(rule\) => rule\.hash\)\.join\('\|'\)\}`/.test(bridge)
  && /shared\.contracts = \{ \.\.\.\(shared\.contracts \?\? \{\}\), simContext: \{ \.\.\.context, reviewKey \} \}/.test(bridge)
  && /prewarmScenario: prewarmScenarioReview/.test(bridge)
  && /if \(!demo\) void ctx\?\.prewarmScenario\?\.\(bill\);/.test(report)
  && /const contextKey = `\$\{src\.key\}\|\$\{currentRules\.map\(\(r\) => r\.hash\)\.join\('\|'\)\}`/.test(view));

check('脚本：引擎与页面测试均加入 npm run check',
  /node tests\/trade-review\.test\.mjs/.test(pkg)
  && /node tests\/ui\/scenario-review\.test\.mjs/.test(pkg));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
