#!/usr/bin/env node
/**
 * 用户端内部信息清理回归（静态结构；不联网）。
 *
 * 覆盖：助手/导入/问答/规则/画像/情境页移除内部追踪、错误码与技术折叠；
 *       报告“数字与来源”保留数字、公式含义、成交来源与计算步骤；
 *       用户语言替换与无空白折叠入口。
 * 运行：node tests/ui/user-facing-internal-cleanup.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
const app = read('prototype/user-frontend/app.js');
const assistant = read('src/ui/assistantPanel.js');
const qaAssistant = read('src/ui/qaAssistant.js');
const realImport = read('prototype/user-frontend/realImport.js');
const realChat = read('prototype/user-frontend/realChat.js');
const qaAnswer = read('prototype/user-frontend/qaAnswer.js');
const realReport = read('prototype/user-frontend/realReport.js');
const realProfile = read('prototype/user-frontend/realProfile.js');
const scenarioView = read('src/ui/views/scenarioReviewView.js');
const contractView = read('src/ui/views/contractView.js');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const block = (source, start, endMarker) => {
  const from = source.indexOf(start);
  if (from < 0) return '';
  const to = source.indexOf(endMarker, from + start.length);
  return source.slice(from, to < 0 ? source.length : to);
};

/* —— 助手与导入：内部调试、flow、trace、模型计数 —— */
check('助手：不再渲染开发调试技术信息（任务/请求/计划/哈希/trace/模型计数）',
  !/technicalDetails|techLine|开发调试（技术信息）|任务编号|请求编号|草案哈希|保存规则哈希|模拟执行规则|技术详情（行情错误）/.test(assistant));
check('导入：原文折叠不显示 trace/flow/模型请求，空原文不生成折叠',
  (() => {
    const detailBlock = block(realImport, 'function details(rec)', '\n}\n');
    return detailBlock.includes('原文与识别信息')
      && detailBlock.includes('tm-original')
      && !/trace|模型请求|flow_id|任务编号|request_id/.test(detailBlock)
      && /String\(rec\.content \?\? ''\)\.trim\(\)/.test(realImport)
      && /hasDetails = hasSource && String/.test(realImport);
  })());
check('问答：不显示 trace、路由层、耗时、置信度、模板/计划或错误码技术折叠',
  !/traceHTML|diagnosticsHTML|如何得出|技术详情（错误码）|QA_LAYER_LABELS|tm-qa-layer|意图置信度|模板 ID|计划 ID/.test(realChat));
check('问答：状态改为用户语言，不再使用已校验/未接入/登记式应答/待澄清',
  /local: '本机回答'/.test(realChat) && /online: '在线复述'/.test(realChat)
  && /clarify: '需要补充信息'/.test(realChat) && /registration: '需要你确认'/.test(realChat)
  && /unavailable: '本版本暂不支持'/.test(realChat) && /error: '本次暂时无法回答'/.test(realChat)
  && !/已校验|未接入|登记式应答|待澄清/.test(realChat));
check('助手侧栏：消息不再渲染技术详情折叠或计划模板',
  !/技术详情|计划模板|规则版本/.test(qaAssistant));

/* —— 规则 / 画像 / 情境：内部实现背景与错误码 —— */
check('规则页：移除候选口径长技术说明、哈希算法与模型请求计数',
  !/技术说明（候选口径）|技术信息（候选哈希）|M0-C1|模型请求/.test(contractView)
  && !/参数无效 · \$\{parsed\.code\}/.test(contractView)
  && /规则只保存在本机，不会自动交易/.test(contractView));
check('规则页：NL 错误只保留可读原因，不渲染错误码/技术折叠',
  !/技术详情（错误码）|技术信息（规则哈希）|safe\(r\.code\)|safe\(r\.httpStatus\)/.test(contractView)
  && !/参数无效 · \$\{parsed\.code\}/.test(contractView));
check('画像：内部快照/候选生成失败表述改为用户语言',
  !/画像快照|规则候选生成失败/.test(realProfile) && /画像更新于：/.test(realProfile)
  && /这次暂时没有可生成的规则候选/.test(realProfile));
check('情境：不显示原因码与服务端拉取时间，保留数据截止/范围说明',
  !/原因码|fetchedAt|拉取/.test(scenarioView)
  && /数据与口径/.test(scenarioView) && /服务端获取，非实时/.test(scenarioView)
  && /行情范围：/.test(scenarioView));
check('研发语言：相似情境/接入措辞改成本版本可用性说明',
  /本版本暂不支持相似情境检索/.test(qaAnswer)
  && /右侧助手也使用这份账单/.test(qaAssistant)
  && !/还没有接入|右侧助手也接入/.test(qaAnswer + qaAssistant));
check('报告：AI 观察不再使用“规则引擎兜底/本地规则引擎”内部称呼',
  /本机规则补充/.test(realReport) && /本机规则识别/.test(realReport)
  && !/规则引擎兜底|本地规则引擎/.test(realReport));

/* —— 报告“数字与来源”：保留证据，移除内部外壳 —— */
{
  const basis = block(realReport, 'function basisSection(bundle, demo)', '\n}\n');
  const detail = block(realReport, 'export function factDetail(fact, bundle)', '\n}\n');
  check('报告：折叠标题为“数字与来源”，没有计数和“已复核”状态',
    basis.includes('数字与来源')
    && !basis.includes('核对数据') && !basis.includes('项已复核')
    && !basis.includes('published.length'));
  check('报告：无数字时不生成空折叠',
    /if \(!facts\.length\) return ''/.test(basis)
    && /details \? `<div class="rp-provenance-list">/.test(basis));
  check('报告：用户证据保留数字、公式含义、成交来源与计算步骤',
    /rp-basis-grid/.test(basis) && /公式含义/.test(detail)
    && /成交来源/.test(detail) && /计算步骤/.test(detail)
    && /FACT_FORMULAS/.test(realReport));
  check('报告：证据不显示 formula_id / verify_id / 复核 verdict / 原因码或内部步骤编号',
    !/formula_id|verify_id|复核：|复核原因|原因码|CALC_|M1-C1/.test(detail)
    && /FACT_STEPS/.test(realReport)
    && !/当前事实没有可展开的计算路径/.test(realReport)
    && !/\(.*key.*\)/.test(block(realReport, 'function sourceLineText(ref)', '\n}\n')));
}

/* —— 页面入口和视觉边界不因清理发生变化 —— */
check('范围：未改动开发者入口、STEP 标签和报告顶部已复核状态',
  /data-developer-link>开发者/.test(app)
  && /STEP 03 \/ ASK/.test(realChat)
  && /portfolio_published === true \? '已复核'/.test(realReport));

const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : '   → ' + result.detail}`);
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
