#!/usr/bin/env node
/**
 * 用户端独立操作复盘页 / 已确认账单横幅回归（静态结构；不联网）。
 * 只检查路由、入口和渲染分支，实际交互由浏览器验证覆盖。
 * 运行：node tests/ui/user-scenario-page.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const app = readFileSync(join(ROOT, 'prototype/user-frontend/app.js'), 'utf8');
const bridge = readFileSync(join(ROOT, 'prototype/user-frontend/realBridge.js'), 'utf8');
const contract = readFileSync(join(ROOT, 'src/ui/views/contractView.js'), 'utf8');
const reviewView = readFileSync(join(ROOT, 'src/ui/views/scenarioReviewView.js'), 'utf8');
const reviewEngine = readFileSync(join(ROOT, 'src/engine/tradeReview.js'), 'utf8');
const assistant = readFileSync(join(ROOT, 'src/ui/assistantPanel.js'), 'utf8');
const css = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');
const styles = readFileSync(join(ROOT, 'prototype/user-frontend/styles.css'), 'utf8');
const realChat = readFileSync(join(ROOT, 'prototype/user-frontend/realChat.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const block = (source, start, endMarker) => {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(endMarker, from + start.length);
  return source.slice(from, to < 0 ? source.length : to);
};

const banner = block(app, 'function confirmedBillBanner()', '\n  function ');
const importPage = block(app, 'function importPage()', '\n  /* ---------- report');
const mePage = block(app, 'function mePage()', '\n  function scenarioPage()');
const scenarioPage = block(app, 'function scenarioPage()', '\n  /* ---------- home');
const reportPage = block(app, 'function reportPage()', '\n  function realPendingPage');
const chatPage = block(app, 'function chatPage()', '\n  function realChatPage');
const goSimulation = block(assistant, 'function goSimulation()', '\n  function ');

check('路由：scenario 在 ROUTES/TITLES',
  /const ROUTES = \[[^\]]*'scenario'/.test(app) && /scenario: '操作复盘 · 择时镜子'/.test(app));
check('导航：桌面主导航包含“复盘”，移动导航含“复盘”入口',
  /navLink\('scenario', '复盘'\)/.test(app)
  && /\['scenario', '复盘'\]/.test(app)
  && /aria-label="操作复盘"/.test(app)
  && /grid-template-columns: repeat\(6, 1fr\)/.test(styles));
check('路由：render 分支挂载独立 scenario 视图',
  /state\.route === 'scenario'\) html = scenarioPage\(\)/.test(app)
  && /mountScenarioView\(document\.getElementById\('tm-real-scenario'\)\)/.test(app));
check('入口：规则工作区提供 #/scenario 链接',
  /href="#\/scenario"/.test(mePage) && /打开操作复盘/.test(mePage));
check('入口：规则页卡片不再重复测试按钮',
  !/href="#\/scenario"/.test(contract));
check('页面：scenario 有独立标题/返回规则管理链接',
  /title: '还没有可复盘的真实账单。'/.test(scenarioPage) && /href="#\/me"/.test(scenarioPage));
check('规则页：scenario 委托到操作复盘视图，不再渲染假设测试区',
  /if \(section === 'scenario'\) \{\s*renderScenarioReview\(root, ctx\);\s*return;/.test(contract)
  && /export function renderScenarioReview/.test(reviewView));
check('操作复盘：页面按真实操作聚合，展示汇总/习惯/时间线/口径',
  /按账单里的每一笔真实操作/.test(app)
  && /const review = context\.review/.test(reviewView)
  && /tr-headline/.test(reviewView) && /tr-stats/.test(reviewView)
  && /画像同时看到/.test(reviewView) && /数据与口径/.test(reviewView));
check('操作复盘：不再出现“假如买入/假如卖出”表单',
  !/假如买入|假如卖出|sim-symbol|sim-date/.test(reviewView)
  && /function buildTradeReview/.test(reviewEngine));
check('桥接：mountScenarioView 使用 scenario-only 渲染',
  /export function mountScenarioView/.test(bridge) && /section: 'scenario'/.test(bridge)
  && /route === 'me' \|\| route === 'scenario' \? 'contract' : route/.test(bridge));
check('助手：前往操作复盘切到 scenario，不回到规则页',
  /go\('scenario'\)/.test(goSimulation) && /scrollSimulation/.test(goSimulation)
  && !/go\('contract'\)/.test(goSimulation));
check('横幅：无确认账单/me 页面隐藏',
  /bill\.status !== 'confirmed'/.test(banner) && /bill\.sourceType !== 'local'/.test(banner)
  && /state\.route === 'me'/.test(banner));
check('横幅：示例/本地文案和链接区分',
  /当前是示例场景/.test(banner) && /当前有已确认的本地账单/.test(banner)
  && /报告、问答和规则测试都使用这笔账单。/.test(banner)
  && /换个场景 →/.test(banner) && /更换账单 →/.test(banner)
  && /查看报告 →/.test(banner) && /去事实问答 →/.test(banner)
  && /历史情境测试 →/.test(banner));
check('横幅：报告/事实问答/历史测试页接入，规则页不接入',
  /confirmedBillBanner\(\)\}\$\{realReportPage\(\)\}/.test(reportPage)
  && /confirmedBillBanner\(\)\}\$\{realChatPage\(\)\}/.test(chatPage)
  && /confirmedBillBanner\(\)/.test(scenarioPage)
  && !/confirmedBillBanner/.test(mePage));
check('导入页：接入一次共享已确认账单横幅',
  /function importPage\(\) \{\s*return `\$\{confirmedBillBanner\(\)\}<div id="tm-real-import"><\/div>`;\s*\}/.test(app));
check('问答页：重复账单状态栏代码与专用样式已移除',
  !/tm-qa-context|contextHTML/.test(realChat) && !/tm-qa-context/.test(css));
check('问答页：仍保留顶部共享横幅，面板内不再重复渲染',
  /confirmedBillBanner\(\)\}\$\{realChatPage\(\)\}/.test(chatPage)
  && !/confirmedBillBanner|tm-bill-banner/.test(realChat));
check('样式：统一横幅及窄屏规则存在',
  /\.tm-bill-banner\s*\{/.test(css) && /\.tm-bill-banner-links\s*\{/.test(css)
  && /\.tm-bill-banner \{[\s\S]*?flex-direction: column/.test(css));
check('问答页：横幅与对话区共享高度，输入底栏留在视口内',
  /body\.tm-qa-standalone #app \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/.test(css)
  && /body\.tm-qa-standalone #tm-real-chat \{ flex: 1 1 auto; height: auto; min-height: 0; \}/.test(css));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
