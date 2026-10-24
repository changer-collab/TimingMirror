#!/usr/bin/env node
/**
 * 线上导入页视觉状态静态回归（不联网、不启动浏览器）。
 * 只检查线上入口 prototype/user-frontend/realImport.js 的删除、空状态、unresolved、预算和分片接线。
 * 运行：node tests/ui/import-vision-ui.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const live = readFileSync(join(ROOT, 'prototype/user-frontend/realImport.js'), 'utf8');
const css = readFileSync(join(ROOT, 'prototype/user-frontend/real-views.css'), 'utf8');
const shared = readFileSync(join(ROOT, 'src/agent/importVision.js'), 'utf8');
const styles = readFileSync(join(ROOT, 'prototype/user-frontend/styles.css'), 'utf8');
const mappingModule = readFileSync(join(ROOT, 'src/engine/importColumnMapping.js'), 'utf8');
const draftModule = readFileSync(join(ROOT, 'src/engine/importDraft.js'), 'utf8');
const stateSource = readFileSync(join(ROOT, 'src/state.js'), 'utf8');
const bridgeSource = readFileSync(join(ROOT, 'prototype/user-frontend/realBridge.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

check('线上页：每张图片有删除按钮', /data-action="remove-image"/.test(live)
  && /data-source-index="\$\{sourceIndex\}"/.test(live) && /data-index="\$\{index\}"/.test(live));
check('线上页：删除按钮在请求中禁用', /pending \? 'disabled' : ''/.test(live));
check('线上页：长图按来源整组删除', /removeVisionSource\(rec\.vision, sourceIndex/.test(live));
check('线上页：删除通过 state 迁移并失效旧草稿/确认状态', /removeVisionImage\(rec\.vision, index/.test(live)
  && /draft: null/.test(live) && /unresolved: \[\]/.test(live) && /status: 'none'/.test(live) && /ctx\.set\(/.test(live));
check('线上页：空状态使用明确标题', /visionStatusTitle\(vision\)/.test(live) && /请选择截图/.test(shared));
check('线上页：标题只在 preparing 时显示正在准备', /status === 'preparing'/.test(shared) && !/count \? `已在本机准备 \$\{count\} 张截图。` : '正在准备截图…'/.test(live));
check('线上页：提供结束本次识别/重新开始入口', /data-action="restart-import"/.test(live) && /completeFlow\(\{ reason: 'user_restart' \}\)/.test(live));
check('线上页：显示已用/剩余预算', /budgetText/.test(live) && /剩余/.test(live));
check('线上页：渲染 unresolved 及原因', /unresolvedPanelHTML/.test(live) && /rec\?\.draft\?\.unresolved/.test(live));
check('线上页：unresolved row 为 null 时显示未标明原图行号', /unresolvedRowLabel/.test(live)
  && /未标明原图行号/.test(draftModule) && !/记录 \$\{esc\(item\.row\)\}/.test(live));
check('线上页：视觉重复只警示，不自动取消勾选', /duplicatePolicy: 'warn'/.test(live));
check('线上页：视觉草稿显示交收日期来源提示', /AI 使用了交收日期/.test(live) && /日期来源需要核对/.test(live));
check('线上页：最终账本校验显示明确阻断原因且保留草稿', /validationErrorsHTML/.test(live)
  && /最终账本校验未通过/.test(live) && /草稿仍保留/.test(live));
check('线上页：长截图走分片入口', /prepareImageFiles\(files/.test(live));
check('样式：删除按钮有定位样式', /\.tm-thumb-remove\s*\{/.test(css));

/* —— 原图列名映射展示 —— */
check('线上页：渲染原图列名映射且独立于可编辑列', /columnMappingHTML/.test(live)
  && /原图列名映射/.test(live) && /<th>日期<\/th><th>标的<\/th><th>方向<\/th>/.test(live));
check('线上页：复合列显示子字段与箭头', /tm-column-map-groups/.test(live)
  && /group\.source_display/.test(live) && /group\.target_display/.test(live)
  && /columnMappingRows\(draft\.columnMapping\)/.test(live));
check('线上页：每个规范字段显示原图列名或未匹配', /view\.fields\.map/.test(live)
  && /source_display:\s*first/.test(mappingModule) && /未匹配/.test(mappingModule));
check('线上页：缺少映射只显示中性说明，不阻断草稿', /本次识别没有返回原图列名映射/.test(live)
  && /不影响已有交易草稿/.test(live) && /hasMapping/.test(mappingModule));
check('线上页：交收日期提示保持确定性且不推导成交日期', /使用交收日期/.test(live)
  && /系统不会倒推成交日期/.test(live) && /hasSettlementDate/.test(live));
check('映射：复合列标签覆盖名称/代码、标志/交收日期、成交价/量、成交/清算额',
  ['名称', '标的', '方向', '交收日期', '价格', '数量', '成交额', '清算额'].every((label) => mappingModule.includes(label)));
check('线上页：视觉草稿按原图映射动态出列', /visionDraftColumns/.test(live)
  && /draftTable\(rec, \{ useSourceColumns: isVisionDraft \}\)/.test(live)
  && /sourceColumns\.map/.test(live) && /is-source-columns/.test(live));
check('线上页：金额列只读展示，标的可带名称辅助值', /tm-cell-static/.test(live)
  && /settlementAmount/.test(mappingModule) && /column\.nameAux/.test(live)
  && /tm-cell-stack/.test(live));
check('线上页：CSV/文字仍使用固定规范表头', /<th>日期<\/th><th>标的<\/th><th>方向<\/th>/.test(live)
  && /useSourceColumns: isVisionDraft/.test(live));

/* —— severity 分色 —— */
check('线上页：warning 与 blocking error 使用不同语义 class',
  /tm-alert tm-alert--warning/.test(live) && /tm-alert tm-alert--error/.test(live)
  && /tm-alert tm-alert--info/.test(live) && /status-tag--success/.test(live)
  && /status-tag--warning/.test(live) && /status-tag--info/.test(live));
check('线上页：行状态带显式 severity，红色只用于 invalid',
  /tm-severity-\$\{severity\}/.test(live) && /tm-row-status is-\$\{severity\}/.test(live)
  && /draftRowSeverity/.test(live));
check('样式：warning 用琥珀色、error 用红色、info 用中性蓝灰',
  /--warn:\s*#/.test(styles) && /--ok:\s*#/.test(styles) && /--info:\s*#/.test(styles)
  && /\.tm-alert--warning\s*\{[\s\S]*?var\(--warn\)/.test(styles)
  && /\.tm-alert--error\s*\{[\s\S]*?var\(--loss\)/.test(styles)
  && /\.tm-alert--info\s*\{[\s\S]*?var\(--info\)/.test(styles));
check('样式：行状态按 severity 着色', /\.tm-row-status\.is-warning\s*\{[\s\S]*?var\(--warn\)/.test(css)
  && /\.tm-row-status\.is-error\s*\{[\s\S]*?var\(--loss\)/.test(css)
  && /\.tm-row-status\.is-success\s*\{[\s\S]*?var\(--ok\)/.test(css));
check('样式：删除按钮默认中性，hover/focus 才变红',
  /\.tm-row-remove\s*\{[\s\S]*?color:\s*var\(--gray\)/.test(css)
  && /\.tm-row-remove:hover[\s\S]*?color:\s*var\(--loss\)/.test(css)
  && /\.tm-thumb-remove:hover[\s\S]*?color:\s*var\(--loss\)/.test(css));

/* —— 手动新增成交行 —— */
check('线上页：草稿表格底部提供添加成交行按钮', /data-action="add-row"/.test(live)
  && /＋ 添加成交行/.test(live) && /tm-add-row-bar/.test(live));
check('线上页：添加按钮只在可编辑草稿面板', live.indexOf('data-action="add-row"') > live.indexOf('function draftPanelHTML')
  && live.indexOf('data-action="add-row"') < live.indexOf('function billPanelHTML'));
const addRowStart = live.indexOf("action === 'add-row'");
const addRowBranch = live.slice(addRowStart, live.indexOf("action === 'remove-row'", addRowStart));
check('线上页：添加行只更新草稿，不触发模型请求', addRowBranch.includes('addBlankRow(state.importRecovery.draft)')
  && !/requestVision|requestRecovery|client\(/.test(addRowBranch), addRowBranch.slice(0, 240));
check('线上页：手动行状态与金额字段接入草稿渲染', draftModule.includes('手动新增 · 待确认')
  && /row\.source === 'manual'/.test(live) && /column\.key === 'amount'/.test(live)
  && /column\.key === 'settlementAmount'/.test(live));
check('样式：添加按钮虚线、手动行有独立样式', /\.tm-add-row-btn\s*\{[\s\S]*?border-style:\s*dashed/.test(css)
  && /\.tm-draft-table tr\.is-manual-row/.test(css));
check('线上页：图片删除与重新识别会清空旧草稿/手动行', /localDraft: null/.test(live)
  && /draft: null/.test(live) && /localDraft: rec\.localDraft \?\? null/.test(live));
check('线上页：云端恢复的账单不伪装成本次导入结果', /if \(bill\.cloudRestored === true\) return '';/.test(live)
  && /cloudRestored: false/.test(stateSource) && /cloudBillId: null/.test(stateSource));
check('历史账单：导入页底部渲染最近云端账单', /function historySectionHTML/.test(live)
  && /\$\{historySectionHTML\(state\)\}/.test(live) && /id="tm-import-history"/.test(live)
  && /listBills\(\{ limit: 20 \}\)/.test(live) && /normalizeCloudBills\(payload\)/.test(live));
check('历史账单：当前账单禁用，其余行载入明细后跳转报告', /data-history-action="open"/.test(live)
  && /\$\{current \? 'disabled' : ''\}/.test(live) && /'当前使用' : '查看报告'/.test(live)
  && /await ctx\.cloudDeps\.loadCloudBill\(\{ id \}\)/.test(live) && /ctx\.go\('report'\)/.test(live));
check('历史账单：空状态、失败重试与导入后刷新', /这个账号还没有云端账单/.test(live)
  && /data-history-action="retry"/.test(live) && /\.finally\(\(\) => refreshImportHistory\(ctx\)\)/.test(live));
check('历史账单：样式存在且窄屏单列', /\.tm-history\s*\{/.test(styles) && /\.tm-history-row\s*\{/.test(styles)
  && /\.tm-history-row\.is-current/.test(styles));
{
  const start = bridgeSource.indexOf('export function restoreFromCloud');
  const end = bridgeSource.indexOf('// 历史账单：按 id', start);
  const restoreBody = bridgeSource.slice(start, end < 0 ? bridgeSource.length : end);
  check('启动：只恢复规则/画像/历史，不自动选中云端账单', start >= 0
    && /setProfileBase\(cloudProfileFromBills\(rows\)/.test(restoreBody)
    && !/shared\.bill\s*=/.test(restoreBody) && !/seedRealReport\(/.test(restoreBody)
    && !/getBill\(/.test(restoreBody));
}
check('历史账单：点选后仍复用已发布快照', /export async function loadCloudBill/.test(bridgeSource)
  && /if \(hasReport\) seedRealReport\(restored, report\)/.test(bridgeSource));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
