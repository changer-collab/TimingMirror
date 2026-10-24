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
check('线上页：提供统一的重新导入入口且不重置预算', /data-action="reimport"/.test(live)
  && /重新导入/.test(live) && !/completeFlow\(\{ reason: 'user_restart' \}\)/.test(live)
  && /buildReimportRecovery/.test(live) && /modelCalls/.test(live));
check('线上页：显示已用/剩余预算', /budgetText/.test(live) && /剩余/.test(live));
check('线上页：渲染 unresolved 及原因', /unresolvedPanelHTML/.test(live) && /rec\?\.draft\?\.unresolved/.test(live));
check('线上页：unresolved row 为 null 时显示未标明原图行号', /unresolvedRowLabel/.test(live)
  && /未标明原图行号/.test(draftModule) && !/记录 \$\{esc\(item\.row\)\}/.test(live));
check('线上页：视觉重复只警示，不自动取消勾选', /duplicatePolicy: 'warn'/.test(live));
check('线上页：视觉草稿只显示一条紧凑交收日期提示', /日期来自交收日期，请确认/.test(live)
  && !/AI 使用了交收日期/.test(live) && !/日期来源需要核对/.test(live));
check('线上页：行级与账本级校验反馈分开渲染', /validationFeedbackHTML/.test(live)
  && /有 \$\{Math\.max\(1, feedback\.rowErrorCount/.test(live)
  && /feedback\.ledgerMessage/.test(live) && /feedback\.ledgerAdvice/.test(live)
  && /账本校验未通过/.test(draftModule) && /可能缺少期初持仓/.test(draftModule)
  && /请补录期初持仓/.test(draftModule));
check('线上页：长截图走分片入口', /prepareImageFiles\(files/.test(live));
check('样式：删除按钮有定位样式', /\.tm-thumb-remove\s*\{/.test(css));

/* —— 统一表头与两类表格的行为边界 —— */
check('线上页：表头统一定义为 行/日期/标的/方向/价格/数量/费用/税费/状态/操作',
  /const TABLE_HEADERS = Object\.freeze\(\[[\s\S]*?label: '行'[\s\S]*?label: '日期'[\s\S]*?label: '标的'[\s\S]*?label: '方向'[\s\S]*?label: '价格'[\s\S]*?label: '数量'[\s\S]*?label: '费用'[\s\S]*?label: '税费'[\s\S]*?label: '状态'[\s\S]*?label: '操作'[\s\S]*?\]\)/.test(live)
  && /function tableHeadHTML/.test(live));
const draftTableStart = live.indexOf('function draftTable');
const tradesTableStart = live.indexOf('function tradesTableHTML');
const tradesTableEnd = live.indexOf('function billWarningsHTML');
const draftBlock = live.slice(draftTableStart, tradesTableStart);
const confirmedBlock = live.slice(tradesTableStart, tradesTableEnd);
check('线上页：草稿表与确认表都使用统一表头', draftBlock.includes('${tableHeadHTML()}')
  && confirmedBlock.includes('${tableHeadHTML()}'));
check('线上页：两类表格共用 tm-import-table 样式类', /class="ledger tm-import-table tm-draft-table"/.test(live)
  && /class="ledger tm-import-table"/.test(live));
check('线上页：图片草稿保留可编辑字段与删除入口',
  /input\(row, 'date'/.test(draftBlock) && /input\(row, 'symbol'/.test(draftBlock)
  && /data-field="side"/.test(draftBlock) && /input\(row, 'price'/.test(draftBlock)
  && /input\(row, 'quantity'/.test(draftBlock) && /input\(row, 'fee'/.test(draftBlock)
  && /input\(row, 'tax'/.test(draftBlock) && /data-action="remove-row"/.test(draftBlock));
check('线上页：图片草稿显示行状态且 not 全部呈现阻断红', /tm-row-status is-\$\{severity\}/.test(live)
  && /tm-status-pill/.test(live) && /draftRowSeverity/.test(live));
check('线上页：文件确认表格保持只读', !/tm-cell-input|data-field=|remove-row/.test(confirmedBlock)
  && /只读/.test(confirmedBlock) && /已确认/.test(confirmedBlock));
check('线上页：费用税费缺失只显示一条补填提示', /未识别到费用\/税费，可在确认前补填/.test(live)
  && /if \(key === 'fee' \|\| key === 'tax'\) return ''/.test(live)
  && !/费用、税费可留空：/.test(live));

/* —— 原图列名映射与金额补充展示 —— */
check('线上页：渲染原图列名映射且独立于统一表头', /columnMappingHTML/.test(live)
  && /原图列名映射/.test(live) && /展示识别到的原图列名，不改变可编辑表格列/.test(live));
check('线上页：复合列显示子字段与箭头', /tm-column-map-groups/.test(live)
  && /group\.source_display/.test(live) && /group\.target_display/.test(live)
  && /columnMappingRows\(draft\.columnMapping\)/.test(live));
check('线上页：每个规范字段显示原图列名或未匹配', /view\.fields\.map/.test(live)
  && /source_display:\s*first/.test(mappingModule) && /未匹配/.test(mappingModule));
check('线上页：缺少映射只显示中性说明，不阻断草稿', /本次识别没有返回原图列名映射/.test(live)
  && /不影响已有交易草稿/.test(live) && /hasMapping/.test(mappingModule));
check('线上页：交收日期提示保持确定性且不推导成交日期', /日期来自交收日期，请确认/.test(live)
  && /系统不会倒推成交日期/.test(live) && /hasSettlementDate/.test(live)
  && /不改变可编辑表格列/.test(live));
check('映射：复合列标签覆盖名称/代码、标志/交收日期、成交价/量、成交/清算额',
  ['名称', '标的', '方向', '交收日期', '价格', '数量', '成交额', '清算额'].every((label) => mappingModule.includes(label)));
check('线上页：成交额/清算额只在原图补充信息中展示', /visionExtrasHTML/.test(live)
  && /原图金额补充/.test(live) && /成交额、清算额只按原图展示，不写入费用或税费/.test(live)
  && /fields\?\.amount/.test(live) && /fields\?\.settlementAmount/.test(live)
  && !/fields\.fee\s*=\s*[^;\n]*(amount|settlementAmount)/.test(live));
check('线上页：视觉草稿不再按原图列名改写统一表头', !/visionDraftColumns/.test(live)
  && !/useSourceColumns/.test(live) && !/is-source-columns/.test(live));

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
check('样式：行状态按 severity 着色', /\.tm-row-status\.is-warning \.tm-status-pill\s*\{[\s\S]*?var\(--warn\)/.test(css)
  && /\.tm-row-status\.is-error \.tm-status-pill\s*\{[\s\S]*?var\(--loss\)/.test(css)
  && /\.tm-row-status\.is-success \.tm-status-pill\s*\{[\s\S]*?var\(--ok\)/.test(css));
check('样式：待确认行只用浅 warning 底色，不用 error 红',
  /\.tm-import-table tr\.tm-severity-warning > td\s*\{[\s\S]*?rgba\(154, 90, 19/.test(css)
  && !/\.tm-import-table tr\.tm-severity-warning > td\s*\{[^}]*var\(--loss\)/.test(css));
check('样式：删除按钮默认中性，hover/focus 才变红',
  /\.tm-row-remove\s*\{[\s\S]*?color:\s*var\(--gray\)/.test(css)
  && /\.tm-row-remove:hover[\s\S]*?color:\s*var\(--loss\)/.test(css)
  && /\.tm-thumb-remove:hover[\s\S]*?color:\s*var\(--loss\)/.test(css));
check('样式：统一表头高度、行高、内边距与分隔线',
  /table\.ledger\.tm-import-table th,\s*\n\s*table\.ledger\.tm-import-table td\s*\{[\s\S]*?height:\s*40px;[\s\S]*?padding:\s*8px 10px;[\s\S]*?border-bottom:\s*1px solid var\(--line-soft\)/.test(styles)
  && /table\.ledger\.tm-import-table th\s*\{[\s\S]*?height:\s*34px;/.test(styles));
check('样式：数字列右对齐，紧凑输入框统一高度与聚焦色',
  /table\.ledger\.tm-import-table td\.num\s*\{[\s\S]*?text-align:\s*right/.test(styles)
  && /\.tm-import-table td\.num \.tm-cell-input\s*\{[\s\S]*?text-align:\s*right/.test(css)
  && /\.tm-import-table \.tm-cell-input\s*\{[\s\S]*?height:\s*28px;[\s\S]*?border-radius:\s*4px/.test(css)
  && /\.tm-import-table \.tm-cell-input:focus\s*\{[\s\S]*?var\(--ink\)/.test(css));
check('样式：移动端表格可横向滚动且不挤压列',
  /table\.ledger\.tm-import-table\s*\{[\s\S]*?min-width:\s*860px;/.test(styles)
  && /\.tm-import-table-wrap\s*\{[\s\S]*?overscroll-behavior-x:\s*contain/.test(css)
  && /\.table-wrap\s*\{[\s\S]*?overflow-x:\s*auto/.test(styles));

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
  && /row\.source === 'manual'/.test(live) && /visionExtrasHTML/.test(live)
  && /fields\?\.amount/.test(live) && /fields\?\.settlementAmount/.test(live));
check('样式：添加按钮虚线、手动行有独立样式', /\.tm-add-row-btn\s*\{[\s\S]*?border-style:\s*dashed/.test(css)
  && /\.tm-import-table tr\.is-manual-row/.test(css));
check('线上页：图片删除与重新识别会清空旧草稿/手动行', /localDraft: null/.test(live)
  && /draft: null/.test(live) && /localDraft: rec\.localDraft \?\? null/.test(live));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
