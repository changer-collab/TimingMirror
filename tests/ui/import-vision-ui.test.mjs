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
check('线上页：视觉重复只警示，不自动取消勾选', /duplicatePolicy: 'warn'/.test(live));
check('线上页：视觉草稿显示交收日期来源提示', /AI 使用了交收日期/.test(live) && /日期来源需要核对/.test(live));
check('线上页：最终账本校验显示明确阻断原因且保留草稿', /validationErrorsHTML/.test(live)
  && /最终账本校验未通过/.test(live) && /草稿仍保留/.test(live));
check('线上页：长截图走分片入口', /prepareImageFiles\(files/.test(live));
check('样式：删除按钮有定位样式', /\.tm-thumb-remove\s*\{/.test(css));

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
