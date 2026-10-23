#!/usr/bin/env node
/**
 * 共享账单横幅回归（静态 + 纯函数；不联网）。
 *
 * 覆盖：五个适用页面统一使用 confirmedBillBanner；本地账单文案与四个链接固定顺序；
 *       me/未确认账单隐藏；首页不再使用旧的短文案；横幅外壳与正文容器使用同一宽度约束。
 * 运行：node tests/ui/bill-banner.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const app = readFileSync(join(ROOT, 'prototype/user-frontend/app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');
const realImport = readFileSync(join(ROOT, 'prototype/user-frontend/realImport.js'), 'utf8');
const realReport = readFileSync(join(ROOT, 'prototype/user-frontend/realReport.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const block = (source, start, endMarker) => {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(endMarker, from + start.length);
  return source.slice(from, to < 0 ? source.length : to);
};
const cssBlock = (selector) => block(css, selector, '}');

const bannerSource = block(app, 'function confirmedBillBanner()', '\n  function ');
const homePage = block(app, 'function homePage()', '\n  /* ---------- import');
const importPage = block(app, 'function importPage()', '\n  /* ---------- report');
const reportPage = block(app, 'function reportPage()', '\n  /* ---------- chat');
const chatPage = block(app, 'function chatPage()', '\n  function answerFor');
const scenarioPage = block(app, 'function scenarioPage()', '\n  /* ---------- home');
const mePage = block(app, 'function mePage()', '\n  function scenarioPage()');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const makeBanner = new Function('state', 'sharedState', 'esc', `${bannerSource}\n  return confirmedBillBanner;`);
const renderBanner = (route, bill) => makeBanner({ route }, () => ({ bill }), escapeHtml)();
const LOCAL = {
  status: 'confirmed',
  sourceType: 'local',
  demo: false,
  fileName: '本地账单-2025.csv',
};
const ROUTES = ['home', 'import', 'report', 'chat', 'scenario'];
const EXPECTED_LINKS = [
  ['#/report', '查看报告 →'],
  ['#/chat', '去事实问答 →'],
  ['#/scenario', '历史情境测试 →'],
  ['#/import', '更换账单 →'],
];

function linksOf(html) {
  return [...html.matchAll(/<a class="text-link" href="([^"]+)">([^<]+)<\/a>/g)]
    .map((match) => [match[1], match[2]]);
}
function classTokens(html) {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/).filter(Boolean));
}
function countToken(html, token) {
  return classTokens(html).filter((value) => value === token).length;
}
function textOf(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/* —— 唯一共享函数与五个页面接入 —— */
check('接入：首页/导入/报告/问答/情境页都通过 confirmedBillBanner 渲染，无页面内复制横幅标记',
  [homePage, importPage, reportPage, chatPage, scenarioPage].every((page) => /confirmedBillBanner\(\)/.test(page)
    && !/class="[^"]*tm-bill-banner/.test(page)
    && !/tm-real-home-banner/.test(page)));
check('接入：首页、导入、情境页各只调用一次共享横幅',
  (homePage.match(/confirmedBillBanner\(\)/g) ?? []).length === 1
  && (importPage.match(/confirmedBillBanner\(\)/g) ?? []).length === 1
  && (scenarioPage.match(/confirmedBillBanner\(\)/g) ?? []).length === 1);
check('接入：画像与规则页不注入横幅',
  !/confirmedBillBanner|tm-bill-banner|tm-real-home-banner/.test(mePage));
check('清理：首页旧横幅和短文案已移除',
  !/tm-real-home-banner/.test(app)
  && !/查看真实报告|报告、问答和助手都使用这笔账单/.test(app));

/* —— 本地账单：文案、四个链接、顺序在所有适用页面一致 —— */
{
  const rendered = ROUTES.map((route) => {
    const html = renderBanner(route, LOCAL);
    return {
      route,
      html,
      text: textOf(html),
      links: linksOf(html),
      cardCount: countToken(html, 'tm-bill-banner'),
      shellCount: countToken(html, 'tm-bill-banner-shell'),
      qaShell: countToken(html, 'tm-bill-banner-shell--qa'),
    };
  });
  check('本地账单：五个页面标题与内容完全一致',
    rendered.every((item) => item.text.includes('当前有已确认的本地账单')
      && item.text.includes(`${LOCAL.fileName} · 报告、问答和规则测试都使用这笔账单。`)));
  check('本地账单：四个链接及顺序在所有页面一致',
    rendered.every((item) => JSON.stringify(item.links) === JSON.stringify(EXPECTED_LINKS)));
  check('本地账单：每个页面只有一个共享横幅外壳和一张横幅',
    rendered.every((item) => item.shellCount === 1 && item.cardCount === 1));
  check('本地账单：仅问答页使用与 .tm-qa-inner 对齐的窄容器',
    rendered.every((item) => (item.route === 'chat' ? item.qaShell === 1 : item.qaShell === 0)));
  check('本地账单：首页不再显示旧的较少链接或旧文案',
    !rendered.find((item) => item.route === 'home').text.includes('助手都使用这笔账单')
    && rendered.find((item) => item.route === 'home').links.length === 4);
}

/* —— 隐藏与示例状态边界 —— */
check('隐藏：#/me 不渲染横幅', renderBanner('me', LOCAL) === '');
check('隐藏：未确认/非本地账单不渲染横幅',
  renderBanner('home', { ...LOCAL, status: 'loaded' }) === ''
  && renderBanner('home', { ...LOCAL, sourceType: 'demo' }) === ''
  && renderBanner('import', { status: 'none', sourceType: null }) === '');
{
  const demo = renderBanner('home', {
    ...LOCAL,
    demo: true,
    fileName: 'demo.csv',
    demoScenario: { title: '示例场景' },
  });
  check('示例账单：保留示例场景文案，不冒充已确认本地账单',
    textOf(demo).includes('当前是示例场景')
    && !textOf(demo).includes('当前有已确认的本地账单')
    && textOf(demo).includes('合成账单与示例行情，仅用于演示。'));
}

/* —— 横幅外壳与正文主容器使用同一布局约束 —— */
{
  const shellRule = cssBlock('.tm-bill-banner-shell {');
  const qaShellRule = cssBlock('.tm-bill-banner-shell.tm-bill-banner-shell--qa {');
  const bannerRule = cssBlock('.tm-bill-banner {');
  const qaInnerRule = cssBlock('.tm-qa-inner {');
  check('布局：横幅外壳使用 container，卡片不再把 container padding 覆盖成 16px',
    /class="container tm-bill-banner-shell/.test(bannerSource)
    && /margin-top:\s*18px/.test(shellRule)
    && !/margin-top/.test(bannerRule));
  check('布局：首页/导入/报告/情境页正文均使用 container',
    /class="container hero-grid"/.test(homePage)
    && /class="container page-body"/.test(realImport)
    && /class="container report-body"/.test(realReport)
    && /class="container page-body tm-scenario-page"/.test(scenarioPage));
  check('布局：问答横幅外壳与 .tm-qa-inner 使用同一 920px/24px 约束',
    /max-width:\s*920px/.test(qaShellRule) && /padding-inline:\s*24px/.test(qaShellRule)
    && /max-width:\s*920px/.test(qaInnerRule) && /padding:\s*0 24px/.test(qaInnerRule));
  check('布局：窄屏问答横幅与 .tm-qa-inner 同步使用 14px gutter',
    /\.tm-bill-banner-shell\.tm-bill-banner-shell--qa\s*\{\s*padding-inline:\s*14px;\s*\}/.test(css)
    && /\.tm-qa-inner\s*\{\s*padding:\s*0 14px;\s*\}/.test(css));
  check('布局：横幅卡片保留自身内边距，不承担页面 gutter',
    /padding:\s*12px 16px/.test(bannerRule));
}

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : '   → ' + result.detail}`);
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
