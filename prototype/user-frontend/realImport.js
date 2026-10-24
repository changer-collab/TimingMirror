// 新前端导入视图：页面结构与文案沿用 PR #37 用户端导入页；解析、AI 预算、视觉、草稿、校验和确认复用既有模块。
import { defaultBill, defaultChat, defaultImportRecovery, createBillContextId } from '../../src/state.js';
import * as demo from '../../src/demo/adapter.js';
import {
  IMPORT_SOURCE_KINDS,
  detectSourceKind,
  parseDelimitedText,
  extractSource,
} from '../../src/engine/importSource.js';
import {
  buildLocalDraft,
  isLocalDraftComplete,
  localDraftTable,
  buildAiDraft,
  addBlankRow,
  removeRow,
  refreshRowStatus,
  draftToNormalized,
  draftSummary,
  draftRowStatusText,
  draftRowSeverity,
  unresolvedRowLabel,
} from '../../src/engine/importDraft.js';
import { columnMappingRows } from '../../src/engine/importColumnMapping.js';
import {
  IMPORT_VISION_MAX_IMAGES,
  validateVisionInput,
  removeVisionImage,
  removeVisionSource,
  visionStatusTitle,
} from '../../src/agent/importVision.js';
import { getPdfPageCount, renderPdfPages } from '../../src/engine/pdfRender.js';
import { prepareImageFiles } from '../../src/engine/visionImage.js';
import { finalizeConfirmedBill } from '../../src/agent/importFinalize.js';
import { REPORT_SCENARIOS, matchReportScenario } from '../../src/demo/reportScenarios.js';
import {
  billSyncStatus, cloudStatusText, cloudStatusTitle,
} from './cloudSync.js';

const FILE_ACCEPT = '.csv,.tsv,.xlsx,.pdf,.txt,.png,.jpg,.jpeg,.webp,text/csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*';
const SOURCE_LABEL = Object.freeze({ csv: 'CSV', tsv: 'TSV', xlsx: 'Excel', pdf: 'PDF', text: '粘贴文字', image: '截图', unsupported: '文件' });
const TABLE_HEADERS = Object.freeze([
  { label: '行', className: 'tm-col-line' },
  { label: '日期' },
  { label: '标的' },
  { label: '方向' },
  { label: '价格', className: 'num' },
  { label: '数量', className: 'num' },
  { label: '费用', className: 'num' },
  { label: '税费', className: 'num' },
  { label: '状态', className: 'tm-col-status' },
  { label: '操作', className: 'tm-col-action' },
]);

function tableHeadHTML() {
  return `<thead><tr>${TABLE_HEADERS.map(({ label, className }) => `<th${className ? ` class="${className}"` : ''}>${label}</th>`).join('')}</tr></thead>`;
}

let pdfSource = null;
let sourceSeq = 0;
const MIN_PARSE_FEEDBACK_MS = 450;
let importFeedback = null;
let importWatch = null;
let importFlashTimer = null;

function parsingInFlight(state, rec) {
  return state?.bill?.status === 'loading' || rec?.status === 'reading';
}

function stopImportWatch() {
  if (!importWatch) return;
  importWatch.cleanup?.();
  importWatch = null;
}

function beginImportFeedback(sourceId, { sourceKind = '', fileName = '' } = {}) {
  stopImportWatch();
  const pasted = sourceKind === 'text';
  const subject = pasted ? '粘贴的内容' : (fileName || '账单文件');
  importFeedback = {
    sourceId,
    phase: 'loading',
    context: pasted ? 'paste' : 'top',
    title: '正在解析账单',
    detail: pasted ? `正在本机读取与校验${subject}，请稍候…` : `正在本机读取与校验：${subject}，请稍候…`,
    showJump: false,
    autoScrollPending: false,
  };
  const watch = { sourceId, interacted: false, startedAt: Date.now(), cleanup: null };
  const mark = () => { watch.interacted = true; };
  const events = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
  if (typeof document !== 'undefined') {
    events.forEach((name) => document.addEventListener(name, mark, { capture: true, passive: true }));
    watch.cleanup = () => events.forEach((name) => document.removeEventListener(name, mark, { capture: true }));
  }
  importWatch = watch;
  return watch;
}

async function holdMinimumParseFeedback(sourceId) {
  if (importWatch?.sourceId !== sourceId) return;
  const remaining = MIN_PARSE_FEEDBACK_MS - (Date.now() - importWatch.startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function finishImportFeedback(sourceId, next) {
  stopImportWatch();
  if (importFeedback?.sourceId !== sourceId) return;
  importFeedback = { ...importFeedback, ...next, sourceId, autoScrollPending: next.autoScrollPending === true };
}

function showImportError(title, detail, sourceId = null, context = 'top') {
  stopImportWatch();
  importFeedback = { sourceId, phase: 'error', context, title, detail, showJump: false, autoScrollPending: false };
}

function clearImportFeedback() {
  stopImportWatch();
  importFeedback = null;
}

function feedbackFor(rec, busy) {
  if (busy) {
    if (importFeedback?.phase === 'loading') return importFeedback;
    return { phase: 'loading', context: 'top', title: '正在解析账单', detail: '正在本机读取与校验，请稍候…', showJump: false };
  }
  if (!importFeedback) return null;
  if (importFeedback.sourceId && rec?.sourceId && importFeedback.sourceId !== rec.sourceId) return null;
  return importFeedback;
}

function importFeedbackHTML(rec, busy, placement) {
  const fb = feedbackFor(rec, busy);
  if (!fb || fb.context !== placement) return '';
  const loading = fb.phase === 'loading';
  const marker = loading
    ? '<span class="tm-import-spinner" aria-hidden="true"></span>'
    : `<span class="tm-import-status-mark${fb.phase === 'error' ? ' is-error' : ''}" aria-hidden="true">${fb.phase === 'error' ? '!' : '✓'}</span>`;
  const attrs = fb.phase === 'error'
    ? 'role="alert" aria-atomic="true"'
    : 'role="status" aria-live="polite" aria-atomic="true"';
  return `<div class="tm-import-status is-${esc(fb.phase)} tm-import-status--${esc(placement)}" ${attrs}>
    ${marker}
    <div class="tm-import-status-body">
      <strong>${esc(fb.title)}</strong>
      <span>${esc(fb.detail)}</span>
    </div>
    ${fb.showJump ? '<button class="btn btn-outline btn-sm tm-import-status-action" type="button" data-action="view-import-result">查看导入结果</button>' : ''}
  </div>`;
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function highlightImportTable(host) {
  const title = host.querySelector('#bill-title');
  if (!title) return;
  title.classList.remove('is-just-imported');
  void title.offsetWidth;
  title.classList.add('is-just-imported');
  clearTimeout(importFlashTimer);
  importFlashTimer = setTimeout(() => title.classList.remove('is-just-imported'), 1800);
}

function revealImportResult(host) {
  const panel = host.querySelector('#bill');
  if (!panel) return false;
  panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  highlightImportTable(host);
  return true;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function freshBill(fields = {}) {
  return { ...defaultBill(), ...fields };
}

function budgetText(rec) {
  const used = Number.isInteger(rec?.modelCalls) ? rec.modelCalls : 0;
  const max = Number.isInteger(rec?.budgetMax) ? rec.budgetMax : 2;
  return `已用 ${used}/${max} 次，剩余 ${Math.max(0, max - used)} 次`;
}

function imageCountText(vision) {
  const count = Array.isArray(vision?.images) ? vision.images.length : 0;
  if (vision?.kind === 'pdf_scan') return `${count} 页`;
  const segmented = (vision?.images ?? []).some((image) => Number.isInteger(image.segmentCount) && image.segmentCount > 1);
  return segmented ? `${count} 个图片片段` : `${count} 张截图`;
}

function aiDraftNotice(trades, unresolved, duplicates = 0) {
  const tradeCount = Array.isArray(trades) ? trades.length : 0;
  const unresolvedCount = Array.isArray(unresolved) ? unresolved.length : 0;
  if (tradeCount > 0) {
    return `AI 返回 ${tradeCount} 条交易草稿${duplicates ? `，其中 ${duplicates} 条疑似重复` : ''}${unresolvedCount ? `，另有 ${unresolvedCount} 条未确定记录` : ''}`;
  }
  if (unresolvedCount > 0) return `AI 没有整理出交易；有 ${unresolvedCount} 条记录需要人工确认`;
  return 'AI 没有整理出新的交易。';
}

function loadedBillFields(bill) {
  return {
    trades: bill.trades,
    warnings: bill.warnings,
    errors: bill.errors,
    dataMode: bill.dataMode,
    sourceNote: bill.sourceNote,
    resultLabelling: bill.resultLabelling,
    demo: bill.demo === true,
    demoScenarioId: bill.demoScenarioId ?? null,
    demoScenario: bill.demoScenario ?? null,
    marketSource: bill.marketSource ?? null,
  };
}

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`无法读取文件内容：${file.name}`));
    reader.readAsText(file);
  });
}

function readBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error(`无法读取文件内容：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

function client(ctx) {
  return ctx.importRecovery;
}

function sessionInfo(ctx) {
  try { return client(ctx).getSession(); } catch { return { flow_id: null, model_calls: 0, budget_max: 2, remaining: 2 }; }
}

function recoveryBase({ sourceId, sourceKind, fileName, fileSize, content, session, status = 'reading' }) {
  return {
    ...defaultImportRecovery(),
    status,
    sourceId,
    sourceKind,
    fileName,
    fileSize,
    content,
    modelCalls: session.model_calls ?? 0,
    budgetMax: session.budget_max ?? 2,
    budgetExhausted: (session.model_calls ?? 0) >= (session.budget_max ?? 2),
    flowId: session.flow_id ?? null,
  };
}

function applySession(recovery, session) {
  const requestIds = Array.isArray(session.request_ids) ? session.request_ids : [];
  return {
    ...recovery,
    modelCalls: session.model_calls ?? recovery.modelCalls,
    budgetMax: session.budget_max ?? recovery.budgetMax,
    budgetExhausted: (session.model_calls ?? recovery.modelCalls) >= (session.budget_max ?? recovery.budgetMax),
    flowId: session.flow_id ?? recovery.flowId,
    requestId: requestIds.length ? requestIds[requestIds.length - 1] : recovery.requestId,
  };
}

function errorLine(rec) {
  if (rec?.error?.message) return `<p class="tm-inline-error" role="alert">${esc(rec.error.message)}</p>`;
  return '';
}

function sendNotice(rec) {
  if (rec?.vision?.images?.length) return `将发送所选 ${imageCountText(rec.vision)}（压缩图）；原始文件不会上传。`;
  if (String(rec?.content ?? '').trim()) return '将发送提取出的文字；原始文件不会上传。';
  return '只有你点击识别时才会发送内容；原始文件不会上传。';
}

function pageHeadHTML() {
  return `<section class="page-head">
    <div class="container">
      <div class="page-topline">
        <span class="page-code">STEP 01 / IMPORT</span>
        <div class="page-topline-right"><span class="sample-tag">本机导入</span></div>
      </div>
      <div class="page-head-grid">
        <h1>先把账单<br>放进来。</h1>
        <div class="page-intro">
          <p>选择一份账单，在本机完成读取与校验。确认之前，账单不会离开浏览器。</p>
          <ul class="mini-rules"><li>本地读取</li><li>原始文件不上传</li><li>逐行可核对</li><li>错误整批阻断</li></ul>
        </div>
      </div>
      <div class="page-head-rule" aria-hidden="true"></div>
    </div>
  </section>`;
}

function uploadCardHTML(state, rec) {
  const bill = state.bill ?? {};
  const parsing = parsingInFlight(state, rec);
  const pasted = importFeedback?.context === 'paste' || rec.sourceKind === 'text';
  const textParsing = parsing && pasted;
  const fileParsing = parsing && !pasted;
  const dropInner = fileParsing
    ? `<span class="tm-import-spinner dropzone-spinner" aria-hidden="true"></span>
       <h2>正在解析账单</h2>
       <p>${esc(rec.fileName || bill.fileName || '账单文件')}</p>
       <p class="dropzone-foot mono">READING LOCALLY · 不会上传</p>`
    : `<span class="dropzone-mark" aria-hidden="true">+</span>
       <h2>把账单拖到这里</h2>
       <p>或 <span class="text-link">选择文件</span>。CSV / TSV 第一行为表头，UTF-8 编码。</p>
       <div class="dropzone-actions"><span class="btn btn-outline">选择账单文件</span></div>
       <p class="dropzone-foot mono">CSV / TSV · XLSX · PDF · 截图 · 只在本机读取</p>`;
  const pasteValue = rec.sourceKind === 'text' ? esc(rec.content) : '';
  return `<section class="panel upload-card${fileParsing ? ' is-busy' : ''}" aria-label="选择账单文件" aria-busy="${fileParsing ? 'true' : 'false'}">
    <div class="panel-head"><span>01 / 本地文件</span><span class="lock-note">原始文件不上传</span></div>
    ${importFeedbackHTML(rec, fileParsing, 'top')}
    <div class="dropzone${fileParsing ? ' is-busy' : ''}" id="dropzone" role="button" tabindex="0" aria-label="选择或拖入账单文件" ${parsing ? 'aria-disabled="true"' : ''}>
      ${dropInner}
      <div class="dropzone-overlay" aria-hidden="true">
        <div class="dropzone-overlay-inner">
          <span class="dropzone-overlay-mark">↓</span>
          <strong class="dropzone-overlay-title">松开即可读取账单</strong>
          <span class="dropzone-overlay-sub">CSV / TSV · XLSX · PDF · 截图 · 只在本机读取</span>
        </div>
      </div>
    </div>
    <input type="file" id="file-input" accept="${FILE_ACCEPT}" multiple hidden ${parsing ? 'disabled' : ''}>
    <p class="upload-note">支持 CSV / TSV、Excel（第一个工作表）、文本型 PDF、扫描 PDF 与截图；费用、税费可选，缺失会按 0 标注。原始文件只在本机读取。</p>
    <div class="tm-paste${textParsing ? ' is-busy' : ''}" id="tm-paste-panel" ${textParsing ? 'aria-busy="true"' : ''}>
      <div class="tm-paste-head">
        <label class="tm-paste-label" for="tm-paste-input">粘贴账单文字</label>
        <span class="tm-paste-kicker">LOCAL / 常规解析优先</span>
      </div>
      <p class="tm-paste-help" id="tm-paste-help">支持粘贴 CSV、表格文字或账单片段；解析在本机完成，失败时内容会保留。</p>
      <textarea id="tm-paste-input" rows="4" aria-describedby="tm-paste-help" placeholder="支持粘贴 CSV、表格文字或账单片段" ${parsing ? 'disabled' : ''}>${pasteValue}</textarea>
      <div class="tm-paste-actions">
        <button class="btn btn-outline btn-sm" type="button" data-action="parse-paste" ${parsing ? 'disabled' : ''}>${textParsing ? '解析中…' : '解析文字'}</button>
        <span class="tm-paste-shortcut">Ctrl / ⌘ + Enter</span>
      </div>
    </div>
    ${importFeedbackHTML(rec, textParsing, 'paste')}
  </section>`;
}

function sampleCardHTML() {
  const items = REPORT_SCENARIOS.map((scenario) => `<button class="scenario-item" type="button" data-action="download-scenario" data-scenario="${esc(scenario.id)}">
    <span class="scenario-main">
      <span class="scenario-title">${esc(scenario.title)}</span>
      <span class="scenario-tag">${esc(scenario.tag)}</span>
    </span>
    <span class="scenario-download">下载 CSV ↓</span>
  </button>`).join('');
  return `<aside class="sample-card scenario-card" id="tm-sample-scenarios" aria-label="示例场景">
    <span class="sample-stamp">DEMO / ${REPORT_SCENARIOS.length} 个场景</span>
    <h2>没有账单？<br>下载示例再上传。</h2>
    <p>下载任一场景的 CSV，拖回左侧导入，就能看到对应报告。含无模式、低样本等边界场景。</p>
    <div class="scenario-list" role="group" aria-label="示例场景列表" tabindex="0">${items}</div>
    <p class="fine" data-role="scenario-hint" role="status">示例 CSV 只含合成交易，不是真实账户。</p>
  </aside>`;
}

function imageStrip(vision, { pending = false } = {}) {
  if (!vision?.images?.length) return '';
  const removable = vision.kind !== 'pdf_scan';
  const images = vision.images.map((image, index) => {
    const segmented = Number.isInteger(image.segmentCount) && image.segmentCount > 1;
    const label = segmented
      ? `第 ${image.segmentIndex}/${image.segmentCount} 段`
      : (image.pageNumber ? `第 ${image.pageNumber} 页` : fmtSize(image.bytes));
    const sourceIndex = Number.isInteger(image.sourceIndex) ? image.sourceIndex : null;
    const firstOfSource = segmented ? image.segmentIndex === 1 : true;
    const deleteLabel = segmented ? `删除这张来源图（${image.segmentCount} 段）` : `删除第 ${index + 1} 张图片`;
    const remove = removable && firstOfSource
      ? `<button class="tm-thumb-remove" type="button" data-action="remove-image" ${sourceIndex !== null ? `data-source-index="${sourceIndex}"` : `data-index="${index}"`} aria-label="${deleteLabel}" ${pending ? 'disabled' : ''}>×</button>`
      : '';
    return `<figure class="tm-thumb">${remove}<img src="data:${image.mime};base64,${image.data_base64}" alt="${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`;
  }).join('');
  return `<div class="tm-thumb-strip">${images}</div>`;
}

function pdfSelector(rec) {
  const vision = rec.vision ?? {};
  if (rec.sourceKind !== 'pdf' && vision.kind !== 'pdf_scan') return '';
  const count = vision.pageCount || 0;
  const start = vision.startPage || 1;
  const end = vision.endPage || Math.min(count || 1, IMPORT_VISION_MAX_IMAGES);
  return `<details class="tm-pdf" ${vision.kind === 'pdf_scan' ? 'open' : ''}>
    <summary>PDF 页面识别${count ? ` · 共 ${count} 页` : ''}</summary>
    <div class="tm-pdf-row">
      <label>起始页 <input id="tm-page-start" type="number" min="1" max="${count || 1}" value="${start}"></label>
      <label>结束页 <input id="tm-page-end" type="number" min="1" max="${count || 1}" value="${end}"></label>
      <button class="btn btn-outline btn-sm" type="button" data-action="render-pdf" ${lastPdfBusy(rec) ? 'disabled' : ''}>${lastPdfBusy(rec) ? '渲染中…' : '渲染所选页面'}</button>
    </div>
    <p class="tm-note">一次最多 ${IMPORT_VISION_MAX_IMAGES} 页；渲染在本机完成，不发送文件。</p>
  </details>`;
}

function lastPdfBusy(rec) {
  return rec?.vision?.status === 'rendering' || rec?.vision?.status === 'preparing';
}

function amountValue(value) {
  return String(value ?? '').trim();
}

function visionExtrasHTML(draft) {
  if (!draft || !Array.isArray(draft.rows)) return '';
  const rows = draft.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => amountValue(row.fields?.amount) || amountValue(row.fields?.settlementAmount));
  if (!rows.length) return '';
  const items = rows.map(({ row, index }) => {
    const line = String(Number.isFinite(row.line) ? row.line : index + 2).padStart(2, '0');
    const parts = [];
    const amount = amountValue(row.fields?.amount);
    const settlement = amountValue(row.fields?.settlementAmount);
    if (amount) parts.push(`成交额 <b>${esc(amount)}</b>`);
    if (settlement) parts.push(`清算额 <b>${esc(settlement)}</b>`);
    return `<li><span>第 ${line} 行</span>${parts.join(' · ')}</li>`;
  }).join('');
  return `<div class="tm-vision-extras" role="status">
    <strong>原图金额补充</strong>
    <ul>${items}</ul>
    <span>成交额、清算额只按原图展示，不写入费用或税费，也不参与最终账本计算。</span>
  </div>`;
}

function draftTable(rec, { mappingView = null } = {}) {
  const draft = rec.draft;
  if (!draft) return '';
  const visionDraft = rec.sourceKind === 'image' || rec.vision?.kind === 'image' || rec.vision?.kind === 'pdf_scan';
  const mappedFields = new Set((mappingView?.fields ?? []).filter((field) => field.matched).map((field) => field.key));
  const mapped = (key) => !visionDraft || mappedFields.has(key);
  const dateTitle = visionDraft && mappingView?.hasSettlementDate
    ? '原图使用交收日期，不代表成交日期；请逐行核对'
    : '';
  const input = (row, key, extra = '') => `<input class="tm-cell-input" data-row="${esc(row.id)}" data-field="${key}" value="${esc(row.fields[key] ?? '')}" ${extra}>`;
  const placeholderFor = (key, manual, fallback) => {
    if (manual) return ` placeholder="${fallback}"`;
    return mapped(key) ? '' : ' placeholder="未匹配"';
  };
  const rows = draft.rows.map((row, index) => {
    const status = draftRowStatusText(row);
    const severity = draftRowSeverity(row);
    const manual = row.source === 'manual';
    const issues = Array.isArray(row.issues) && row.issues.length ? row.issues.join('；') : '';
    const name = String(row.fields.name ?? '').trim();
    const sideOptions = `${manual && !row.fields.side ? '<option value="" selected>请选择</option>' : ''}<option value="买入" ${row.fields.side === '买入' ? 'selected' : ''}>买入</option><option value="卖出" ${row.fields.side === '卖出' ? 'selected' : ''}>卖出</option>`;
    const dateExtra = `${dateTitle ? ` title="${esc(dateTitle)}"` : ''}`;
    return `<tr class="tm-draft-row ${row.status} tm-severity-${severity}${manual ? ' is-manual-row' : ''}">
      <td class="line-no tm-col-line"><label class="tm-line-pick"><input type="checkbox" data-row="${esc(row.id)}" data-include ${row.include === false ? '' : 'checked'} aria-label="导入第 ${row.line ?? index + 2} 行"><span>${String(row.line ?? index + 2).padStart(2, '0')}</span></label></td>
      <td>${input(row, 'date', `inputmode="numeric"${placeholderFor('date', manual, 'YYYY-MM-DD')}${dateExtra}`)}</td>
      <td><div class="tm-cell-stack">${input(row, 'symbol', `inputmode="numeric"${placeholderFor('symbol', manual, '6 位代码')}`)}${name ? `<span class="sym-name">${esc(name)}</span>` : ''}</div></td>
      <td><select class="tm-cell-input" data-row="${esc(row.id)}" data-field="side">${sideOptions}</select></td>
      <td class="num">${input(row, 'price', `inputmode="decimal"${placeholderFor('price', manual, '0.00')}`)}</td>
      <td class="num">${input(row, 'quantity', `inputmode="numeric"${placeholderFor('quantity', manual, '股数')}`)}</td>
      <td class="num">${input(row, 'fee', `inputmode="decimal"${placeholderFor('fee', manual, '可留空')}`)}</td>
      <td class="num">${input(row, 'tax', `inputmode="decimal"${placeholderFor('tax', manual, '可留空')}`)}</td>
      <td class="tm-row-status is-${severity}"><span class="tm-status-pill">${esc(status)}</span>${issues ? `<span class="tm-row-issue">${esc(issues)}</span>` : ''}</td>
      <td class="tm-col-action"><button class="tm-link tm-row-remove" type="button" data-action="remove-row" data-row="${esc(row.id)}">删除</button></td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap tm-import-table-wrap"><table class="ledger tm-import-table tm-draft-table">
    <caption class="sr-only">交易草稿，使用统一表头；可逐行核对并编辑。</caption>
    ${tableHeadHTML()}
    <tbody>${rows}</tbody>
  </table></div>`;
}

function tradesTableHTML(trades, bill = {}) {
  const confirmed = bill.status === 'confirmed';
  const statusText = confirmed ? '已确认' : '校验通过';
  const rows = trades.map((trade, index) => {
    const line = trade.source?.line ?? index + 2;
    const date = trade.trade_date || trade.date;
    const feeMissing = trade.fee_missing === true || trade.fee === null || trade.fee === undefined;
    const taxMissing = trade.tax_missing === true || trade.tax === null || trade.tax === undefined;
    return `<tr class="${feeMissing || taxMissing ? 'is-missing' : ''}">
      <td class="line-no tm-col-line">${String(line).padStart(2, '0')}</td>
      <td>${esc(date)}</td>
      <td><span class="sym">${esc(trade.symbol)}</span></td>
      <td><span class="side ${trade.side === 'buy' ? 'buy' : 'sell'}">${trade.side === 'buy' ? '买入' : '卖出'}</span></td>
      <td class="num">${Number(trade.price).toFixed(2)}</td>
      <td class="num">${Number(trade.quantity)}</td>
      <td class="num">${feeMissing ? '<span class="missing">缺失（按 0）</span>' : Number(trade.fee ?? 0).toFixed(2)}</td>
      <td class="num">${taxMissing ? '<span class="missing">缺失（按 0）</span>' : Number(trade.tax ?? 0).toFixed(2)}</td>
      <td class="tm-row-status is-success"><span class="tm-status-pill">${statusText}</span></td>
      <td class="tm-col-action"><span class="tm-readonly">只读</span></td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap tm-import-table-wrap">
    <table class="ledger tm-import-table">
      <caption class="sr-only">交易列表，只读；可逐行核对日期、标的、方向、价格、数量、费用与税费。</caption>
      ${tableHeadHTML()}
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function billWarningsHTML(bill) {
  const missing = (bill.trades ?? []).filter((trade) => trade.fee_missing === true || trade.tax_missing === true);
  if (!missing.length) return '';
  const lines = missing.map((trade) => trade.source?.line).filter(Boolean).join('、');
  return `<div class="tm-alert tm-alert--warning" role="status">
    <strong>${missing.length} 行费用或税费缺失</strong>
    <span>${lines ? `第 ${lines} 行` : '缺失行'}按 0 展示并标注。</span>
  </div>`;
}

function details(rec) {
  const text = String(rec.content ?? '');
  return `<details class="tm-import-details">
    <summary>原文与识别信息</summary>
    <div class="tm-details-body">
      <p>${esc(SOURCE_LABEL[rec.sourceKind] || '文件')} · ${rec.fileName ? esc(rec.fileName) : '未选择文件'}</p>
      <pre class="tm-original">${esc(text.slice(0, 4000))}${text.length > 4000 ? '\n…' : ''}</pre>
    </div>
  </details>`;
}

function aiButton(state, rec) {
  const bill = state.bill ?? {};
  if (rec.pending || rec.draft || bill.status === 'loaded' || bill.status === 'confirmed'
    || rec.status === 'local_ready' || rec.status === 'accepted') return '';
  const text = String(rec.content ?? '').trim();
  const imageCount = rec.vision?.images?.length ?? 0;
  const canText = ['csv', 'tsv', 'xlsx', 'pdf', 'text'].includes(rec.sourceKind) && text.length > 0;
  const canVision = imageCount > 0 && rec.vision?.status === 'ready';
  if (!canText && !canVision) return '';
  if (rec.budgetExhausted) {
    return `<p class="tm-note">本次 AI 识别次数已用完（${budgetText(rec)}）。${imageCount ? '可在下方结束本次识别后重新开始，' : ''}或手动修改。</p>`;
  }
  const label = imageCount
    ? `让 AI 识别这 ${imageCountText(rec.vision)}`
    : (rec.modelCalls > 0 ? `再次让 AI 识别（剩余 ${Math.max(0, rec.budgetMax - rec.modelCalls)} 次）` : '让 AI 帮我识别');
  return `<div class="tm-ai-row"><button class="btn btn-primary" type="button" data-action="${imageCount ? 'ai-vision' : 'ai-text'}">${label}</button><span class="tm-note">${sendNotice(rec)} · ${budgetText(rec)}</span></div>`;
}

function pendingPanelHTML(rec) {
  return `<section class="panel bill tm-pending-panel" aria-labelledby="pending-title">
    <div class="bill-head">
      <div>
        <p class="mono-label">READING / 识别中</p>
        <h2 id="pending-title">正在整理可核对交易。</h2>
      </div>
      <div class="bill-tags"><span class="status-tag status-tag--info">进行中</span></div>
    </div>
    <p class="tm-note">${rec.vision?.images?.length ? `正在识别所选 ${imageCountText(rec.vision)}。` : '正在识别提取出的文字。'}完成后会直接显示可编辑交易表。</p>
    <p class="tm-note">本次识别${budgetText(rec)}。</p>
    ${errorLine(rec)}
  </section>`;
}

function errorPanelHTML(state, rec) {
  const bill = state.bill ?? {};
  const errors = Array.isArray(bill.errors) ? bill.errors : [];
  const message = rec.error?.message || bill.error;
  if (bill.status === 'error' || rec.status === 'unsupported'
    || (rec.error && !errors.length && !rec.draft)) {
    return `<div class="error-panel" role="alert">
      <h2>没有读取成功</h2>
      <p>${esc(message || '未知错误')}</p>
      <p class="fine">原始文件不会被上传。修正问题后，可以重新选择文件。</p>
      ${aiButton(state, rec)}
    </div>`;
  }
  if (bill.status !== 'invalid' && !errors.length && !rec.error) return '';
  const shown = errors.slice(0, 10);
  const rest = errors.length - shown.length;
  return `<div class="error-panel" role="alert">
    <h2>不能生成报告：文件里有需要修改的地方</h2>
    <p>为保证结果可核对，只要一处不通过就整批阻断，不生成部分结果。${bill.fileName ? `当前文件：${esc(bill.fileName)}。` : ''}</p>
    ${shown.length ? `<ul class="error-list">
      ${shown.map((e) => `<li>${e.line ? `第 ${e.line} 行 · ` : ''}${esc(e.message)}</li>`).join('')}
      ${rest > 0 ? `<li>另有 ${rest} 处问题未展开。</li>` : ''}
    </ul>` : ''}
    ${errorLine(rec)}
    <p class="fine">修改后，重新拖入或选择文件即可；当前结果不会被用于报告。</p>
    ${aiButton(state, rec)}
  </div>`;
}

function unresolvedPanelHTML(rec) {
  const items = rec?.draft?.unresolved ?? rec?.unresolved ?? [];
  if (!items.length) return '';
  const rows = items.map((item) => `<li>${esc(unresolvedRowLabel(item.row))} · ${esc(item.reason)}</li>`).join('');
  return `<div class="tm-alert tm-alert--warning" role="status">
    <strong>${items.length} 条记录未进入交易草稿</strong>
    <ul class="tm-unresolved">${rows}</ul>
    <span>它们可能是证券转银行、利息、汇总等非买卖记录；请核对原图后手动处理。</span>
  </div>`;
}

function validationErrorsHTML(rec) {
  const errors = Array.isArray(rec?.validationErrors) ? rec.validationErrors : [];
  if (!errors.length) return '';
  const shown = errors.slice(0, 10);
  const items = shown.map((error) => `<li>${error.line ? `第 ${error.line} 行 · ` : ''}${esc(error.message)}</li>`).join('');
  return `<div class="tm-alert tm-alert--error" role="alert">
    <strong>最终账本校验未通过</strong>
    <ul class="tm-unresolved">${items}</ul>
    <span>草稿仍保留；系统不会补猜期初持仓或自动改动交易。</span>
  </div>`;
}

function columnMappingHTML(view) {
  if (!view.hasMapping) {
    return `<div class="tm-alert tm-alert--info" role="status">
      <strong>原图列名映射</strong>
      <span>本次识别没有返回原图列名映射；不影响已有交易草稿，请继续逐行核对。</span>
    </div>`;
  }
  const groups = view.groups.map((group) => `<li>
      <span class="tm-column-map-source">${esc(group.source_display)}</span>
      <span class="tm-column-map-arrow" aria-hidden="true">→</span>
      <span class="tm-column-map-target">${esc(group.target_display)}</span>
    </li>`).join('');
  const fields = view.fields.map((field) => `<div class="tm-column-map-field">
      <dt>${esc(field.label)}</dt>
      <dd class="${field.matched ? 'is-matched' : 'is-unmatched'}">${esc(field.source_display)}</dd>
    </div>`).join('');
  return `<section class="tm-column-map" aria-labelledby="column-map-title">
    <div class="tm-column-map-head">
      <strong id="column-map-title">原图列名映射</strong>
      <span>展示识别到的原图列名，不改变可编辑表格列</span>
    </div>
    <ul class="tm-column-map-groups">${groups}</ul>
    <dl class="tm-column-map-fields">${fields}</dl>
    ${view.hasSettlementDate ? '<p class="tm-column-map-foot">交收日期只作为日期来源展示；系统不会倒推成交日期。</p>' : ''}
  </section>`;
}

function draftPanelHTML(state, rec) {
  const draft = rec.draft;
  const summary = draftSummary(draft);
  const dates = draft.rows.map((row) => row.fields.date).filter(Boolean).sort();
  const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—';
  const symbols = new Set(draft.rows.map((row) => row.fields.symbol).filter(Boolean)).size;
  const isVisionDraft = rec.sourceKind === 'image' || rec.vision?.kind === 'image' || rec.vision?.kind === 'pdf_scan';
  const sourceLabel = isVisionDraft ? 'AI 视觉识别' : rec.modelCalls > 0 ? 'AI 识别' : '本地解析';
  const mappingView = columnMappingRows(draft.columnMapping);
  const usesSettlementDate = (draft.rows ?? []).some((row) => (row.issues ?? []).some((issue) => String(issue).includes('交收日期')))
    || mappingView.hasSettlementDate;
  const dateSourceNotice = isVisionDraft
    ? `<div class="tm-alert tm-alert--warning" role="status">
      <strong>${usesSettlementDate ? '使用交收日期' : '日期来源需要核对'}</strong>
      <span>${usesSettlementDate
        ? 'AI 使用了交收日期作为草稿日期，不代表成交日期；系统不会倒推成交日期，请逐行核对并按原始成交日期修正。'
        : '视觉识别只使用截图中可见的日期列；若列名是“交收日期”，它不是成交日期。系统不会自动倒推，请逐行核对。'}</span>
    </div>`
    : '';
  return `<section class="panel bill" aria-labelledby="draft-title">
    <div class="bill-head">
      <div>
        <p class="mono-label">BILL / 交易核对</p>
        <h2 id="draft-title">已整理 ${draft.rows.length} 行草稿。</h2>
      </div>
      <div class="bill-tags"><span class="status-tag status-tag--warning">待核对</span><span class="status-tag status-tag--info">仅本机</span></div>
    </div>
    <div class="bill-meta">
      <span>来源 <b>${sourceLabel}</b></span>
      <span>文件 <b class="file-line">${esc(rec.fileName || '粘贴文字')}</b></span>
      <span>期间 <b>${range}</b></span>
      <span>标的 <b>${symbols} 个</b></span>
    </div>
    <p class="tm-note">已选 ${summary.included} 行 · 可导入 ${summary.valid} 行${summary.duplicate ? ` · 疑似重复 ${summary.duplicate}` : ''} · 本次识别${budgetText(rec)}</p>
    ${rec.notice ? `<div class="tm-alert tm-alert--info" role="status"><strong>${esc(rec.notice)}</strong><span>导入前仍需要你逐行核对并校验。</span></div>` : ''}
    ${dateSourceNotice}
    ${errorLine(rec)}
    ${validationErrorsHTML(rec)}
    ${isVisionDraft ? columnMappingHTML(mappingView) : ''}
    ${isVisionDraft ? visionExtrasHTML(draft) : ''}
    ${draftTable(rec, { mappingView })}
    <p class="tm-note tm-fee-note">费用、税费可留空：留空按 0 记录并标注，不阻断导入；确认前可手动填写。</p>
    <div class="tm-add-row-bar">
      <button class="btn btn-outline btn-sm tm-add-row-btn" type="button" data-action="add-row">＋ 添加成交行</button>
      <p class="tm-note">手动新增行会一起参与校验；成交额/清算额可留空，确认前请补齐。</p>
    </div>
    ${unresolvedPanelHTML(rec)}
    <div class="bill-actions">
      <div class="bill-actions-note">
        <span class="plus" aria-hidden="true">＋</span>
        <p class="fine">只导入勾选的行；错误与重复提示在对应行。修改后请先校验。</p>
      </div>
      <div class="tm-action-group">
        <button class="btn btn-primary" type="button" data-action="validate">校验并用于导入</button>
      </div>
    </div>
  </section>`;
}

function billPanelHTML(state, rec) {
  const bill = state.bill ?? {};
  const trades = Array.isArray(bill.trades) ? bill.trades : [];
  const symbols = new Set(trades.map((trade) => trade.symbol)).size;
  const dates = trades.map((trade) => trade.trade_date || trade.date).filter(Boolean).sort();
  const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '—';
  const confirmed = bill.status === 'confirmed';
  const sourceLabel = rec?.sourceKind === 'text' ? '粘贴文字' : '本地文件';
  const fileSize = rec?.sourceKind === 'text' ? '—' : (bill.fileSize ? fmtSize(bill.fileSize) : '—');
  const statusTag = confirmed
    ? '<span class="status-tag status-tag--success">已确认</span>'
    : '<span class="status-tag status-tag--success">本地校验通过</span>';
  const sync = billSyncStatus(bill);
  const cloudTag = confirmed
    ? `<span class="status-tag tm-cloud-chip" data-role="cloud-sync" data-context="${esc(bill.contextId ?? '')}" data-state="${esc(sync.state)}" title="${esc(cloudStatusTitle(sync))}">${esc(cloudStatusText(sync))}</span>`
    : '<span class="status-tag status-tag--info">仅本机</span>';
  return `<section class="panel bill" id="bill" aria-labelledby="bill-title">
    <div class="bill-head">
      <div>
        <p class="mono-label">BILL / 交易核对</p>
        <h2 id="bill-title">已读取 ${trades.length} 笔交易。</h2>
      </div>
      <div class="bill-tags">${statusTag}${cloudTag}</div>
    </div>
    <div class="bill-meta">
      <span>来源 <b>${sourceLabel}</b></span>
      <span>文件 <b class="file-line">${esc(bill.fileName || '—')}</b></span>
      <span>期间 <b>${range}</b></span>
      <span>标的 <b>${symbols} 个</b></span>
      <span>文件大小 <b>${fileSize}</b></span>
    </div>
    ${billWarningsHTML(bill)}
    ${errorLine(rec)}
    ${tradesTableHTML(trades, bill)}
    <div class="bill-actions">
      <div class="bill-actions-note">
        <span class="plus" aria-hidden="true">＋</span>
        <p class="fine">确认后生成报告，账单明细与报告快照会同步到云端画像；原始 CSV 与文件名不上传。不会执行交易。</p>
      </div>
      <div class="tm-action-group">
        ${rec?.status === 'accepted' && rec.draft ? '<button class="btn btn-ghost btn-sm" type="button" data-action="return-draft">返回修改草稿</button>' : ''}
        ${confirmed
          ? '<a class="btn btn-primary" href="#/report">前往报告 <span class="arrow">→</span></a>'
          : '<button class="btn btn-primary" type="button" data-action="confirm">确认并生成报告 →</button>'}
      </div>
    </div>
  </section>`;
}

function visionPanelHTML(state, rec) {
  const vision = rec.vision ?? {};
  const count = vision.images?.length ?? 0;
  const preparing = vision.status === 'preparing';
  const title = visionStatusTitle(vision);
  const emptyNote = count || preparing || vision.notice ? '' : `<p class="tm-note">${vision.status === 'error'
    ? '图片没有准备成功；请重新选择截图。'
    : '还没有选择截图；请从上方选择文件。'}</p>`;
  const canRestart = rec.pending !== true && (rec.error || rec.budgetExhausted || vision.status === 'error');
  return `<section class="panel bill" aria-labelledby="vision-title">
    <div class="bill-head">
      <div>
        <p class="mono-label">VISION / 图片与 PDF</p>
        <h2 id="vision-title">${esc(title)}</h2>
      </div>
      <div class="bill-tags"><span class="status-tag status-tag--info">仅本机处理</span><span class="status-tag status-tag--info">识别前不发送</span></div>
    </div>
    <div class="bill-meta">
      <span>来源 <b>${vision.kind === 'pdf_scan' ? '扫描 PDF' : '截图'}</b></span>
      <span>文件 <b class="file-line">${esc(rec.fileName || vision.fileName || '—')}</b></span>
    </div>
    ${errorLine(rec)}
    ${vision.notice ? `<p class="tm-note">${esc(vision.notice)}</p>` : ''}
    ${imageStrip(vision, { pending: rec.pending === true })}
    ${count ? `<p class="tm-note">已选 ${imageCountText(vision)} · 输入约 ${fmtSize(vision.totalBytes)}${vision.payloadBytes ? ` · 请求约 ${fmtSize(vision.payloadBytes)}` : ''}</p>` : ''}
    ${emptyNote}
    ${vision.kind === 'pdf_scan' ? pdfSelector(rec) : ''}
    <p class="tm-note">本次识别${budgetText(rec)}。</p>
    <div class="bill-actions">
      ${aiButton(state, rec) || '<p class="fine">图片与 PDF 页面先在本机处理；只有点击识别时才会发送所选内容。</p>'}
      ${canRestart ? '<button class="btn btn-outline btn-sm" type="button" data-action="restart-import">结束本次识别并重新开始</button>' : ''}
    </div>
  </section>`;
}

function renderBelow(state, rec) {
  const bill = state.bill ?? {};
  if (rec.pending) return pendingPanelHTML(rec);
  if (bill.status === 'confirmed') return billPanelHTML(state, rec);
  const visionActive = !!rec.vision && (rec.sourceKind === 'image' || rec.sourceKind === 'pdf')
    && !rec.draft && bill.status !== 'loaded' && bill.status !== 'invalid';
  if (visionActive) return visionPanelHTML(state, rec);
  if (bill.status === 'loaded') return billPanelHTML(state, rec);
  if (rec.draft) return draftPanelHTML(state, rec);
  if (bill.status === 'invalid' || bill.status === 'error' || rec.error?.message || rec.status === 'unsupported') {
    return errorPanelHTML(state, rec);
  }
  return '';
}

function downloadScenarioCsv(scenario, button) {
  if (!scenario) return;
  const blob = new Blob([scenario.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = scenario.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  const hint = button.closest('.scenario-card')?.querySelector('[data-role="scenario-hint"]');
  if (hint) hint.textContent = `已下载 ${scenario.fileName}。把它拖回左侧，核对并确认后即可查看报告。`;
}

export function renderRealImport(host, ctx) {
  if (!host) return;
  const { state } = ctx;
  const rec = state.importRecovery ?? defaultImportRecovery();
  const bill = state.bill ?? {};
  const hasSource = !!(rec.fileName || bill.fileName);
  const hasDetails = hasSource && String(rec.content ?? '').trim();
  host.innerHTML = `${pageHeadHTML()}
    <div class="container page-body">
      <div class="import-grid">
        ${uploadCardHTML(state, rec)}
        ${sampleCardHTML()}
      </div>
      ${renderBelow(state, rec)}
      ${hasDetails ? details(rec) : ''}
    </div>`;

  const drop = host.querySelector('#dropzone');
  const input = host.querySelector('#file-input');
  const busyNow = () => parsingInFlight(ctx.state, ctx.state.importRecovery);
  const openPicker = () => { if (!busyNow()) input?.click(); };
  drop?.addEventListener('click', openPicker);
  drop?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  let dragDepth = 0;
  const setDrag = (on) => drop?.classList.toggle('is-over', on);
  drop?.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (busyNow()) return;
    dragDepth += 1;
    setDrag(true);
  });
  drop?.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (busyNow()) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setDrag(true);
  });
  drop?.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDrag(false);
  });
  drop?.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    setDrag(false);
    if (busyNow()) return;
    handleFiles(ctx, [...(e.dataTransfer?.files ?? [])]);
  });
  input?.addEventListener('change', (e) => {
    if (busyNow()) return;
    handleFiles(ctx, [...(e.target.files ?? [])]);
  });
  const pasteInput = host.querySelector('#tm-paste-input');
  pasteInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (busyNow()) return;
      handlePaste(ctx, pasteInput.value);
    }
  });
  host.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-action');
      if (action === 'parse-paste') {
        handlePaste(ctx, host.querySelector('#tm-paste-input')?.value ?? '');
      } else if (action === 'view-import-result') {
        revealImportResult(host);
      } else if (action === 'download-scenario') {
        downloadScenarioCsv(REPORT_SCENARIOS.find((item) => item.id === button.getAttribute('data-scenario')), button);
      } else if (action === 'ai-text') {
        aiRecover(ctx);
      } else if (action === 'ai-vision') {
        aiVision(ctx);
      } else if (action === 'remove-image') {
        const sourceAttr = button.getAttribute('data-source-index');
        const indexAttr = button.getAttribute('data-index');
        removeImage(ctx, {
          sourceIndex: sourceAttr === null ? null : Number(sourceAttr),
          index: indexAttr === null ? null : Number(indexAttr),
        });
      } else if (action === 'restart-import') {
        restartImport(ctx);
      } else if (action === 'render-pdf') {
        renderPdf(ctx);
      } else if (action === 'validate') {
        validateDraft(ctx);
      } else if (action === 'confirm') {
        const result = finalizeConfirmedBill({ state, set: ctx.set, go: ctx.go, client: ctx.importRecovery });
        if (result?.ok) {
          void ctx.prewarmScenario?.(state.bill);
          if (typeof ctx.cloudDeps?.syncBill === 'function') {
            Promise.resolve(ctx.cloudDeps.syncBill({ bill: state.bill })).catch(() => {});
          }
        }
      } else if (action === 'return-draft') {
        clearImportFeedback();
        ctx.set({ bill: freshBill({ contextId: state.bill.contextId, status: 'none', sourceType: 'local', fileName: state.bill.fileName, fileSize: state.bill.fileSize }), importRecovery: { ...state.importRecovery, status: 'draft' } });
      } else if (action === 'add-row') {
        if (!state.importRecovery?.draft) return;
        ctx.set({ importRecovery: { ...state.importRecovery, draft: addBlankRow(state.importRecovery.draft) } });
      } else if (action === 'remove-row') {
        if (!state.importRecovery?.draft) return;
        ctx.set({ importRecovery: { ...state.importRecovery, draft: removeRow(state.importRecovery.draft, button.getAttribute('data-row')) } });
      }
    });
  });

  host.querySelectorAll('[data-include]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const draft = state.importRecovery?.draft;
      if (!draft) return;
      const row = draft.rows.find((r) => r.id === checkbox.getAttribute('data-row'));
      if (!row) return;
      row.include = checkbox.checked;
      ctx.set({ importRecovery: { ...state.importRecovery, draft } });
    });
  });
  host.querySelectorAll('[data-row][data-field]').forEach((field) => {
    field.addEventListener('input', () => {
      const draft = state.importRecovery?.draft;
      if (!draft) return;
      const row = draft.rows.find((r) => r.id === field.getAttribute('data-row'));
      if (!row) return;
      row.fields[field.getAttribute('data-field')] = field.value;
    });
    field.addEventListener('change', () => {
      const draft = state.importRecovery?.draft;
      if (!draft) return;
      const row = draft.rows.find((r) => r.id === field.getAttribute('data-row'));
      if (!row) return;
      Object.assign(row, refreshRowStatus(row, state.importRecovery.fileName || '粘贴文字'));
      ctx.set({ importRecovery: { ...state.importRecovery, draft } });
    });
  });

  if (importFeedback?.phase === 'success' && importFeedback.autoScrollPending) {
    importFeedback.autoScrollPending = false;
    requestAnimationFrame(() => revealImportResult(host));
  }
}

async function handleFiles(ctx, files) {
  const { state, set } = ctx;
  if (!files.length) return;
  if (parsingInFlight(state, state.importRecovery)) return;
  if (files.length > 1 && !files.every((f) => detectSourceKind(f.name, f.type) === IMPORT_SOURCE_KINDS.IMAGE)) {
    showImportError('无法一次导入多个文件', '一次只能选择一个账单文件；多选仅支持截图。');
    set({ importRecovery: { ...defaultImportRecovery(), error: { code: 'E_IMPORT_MULTI_FILE', message: '一次只能选择一个账单文件；多选仅支持截图。' } } });
    return;
  }
  if (files.every((f) => detectSourceKind(f.name, f.type) === IMPORT_SOURCE_KINDS.IMAGE)) {
    clearImportFeedback();
    await openImages(ctx, files);
    return;
  }
  const file = files[0];
  const kind = detectSourceKind(file.name, file.type);
  const contextId = createBillContextId();
  const sourceId = ++sourceSeq;
  const session = sessionInfo(ctx);
  const base = recoveryBase({ sourceId, sourceKind: kind, fileName: file.name, fileSize: file.size, content: '', session, status: 'reading' });
  pdfSource = null;
  if (kind === IMPORT_SOURCE_KINDS.UNSUPPORTED) {
    showImportError('暂不支持这种文件类型', '请使用 CSV、TSV、Excel、文本型 PDF 或截图后重试。', sourceId);
    set({ bill: freshBill({ contextId, status: 'none', sourceType: 'local', fileName: file.name, fileSize: file.size }), chat: defaultChat(contextId), importRecovery: { ...base, status: 'unsupported', error: { code: 'W_IMPORT_SOURCE_UNSUPPORTED', message: '暂不支持这种文件类型；请使用 CSV、TSV、Excel、文本型 PDF 或截图' } } });
    return;
  }
  beginImportFeedback(sourceId, { sourceKind: kind, fileName: file.name });
  set({ bill: freshBill({ contextId, status: 'loading', sourceType: 'local', fileName: file.name, fileSize: file.size }), chat: defaultChat(contextId), importRecovery: base });
  try {
    if (kind === IMPORT_SOURCE_KINDS.PDF) {
      const bytes = await readBuffer(file);
      pdfSource = { bytes, fileName: file.name, fileSize: file.size };
      const extracted = await extractSource({ kind, bytes });
      if (!extracted.ok || !String(extracted.text ?? '').trim()) {
        clearImportFeedback();
        await openPdf(ctx, { bytes, fileName: file.name, fileSize: file.size, contextId });
        return;
      }
      await applySource(ctx, { sourceId, contextId, sourceKind: kind, content: extracted.text, fileName: file.name, fileSize: file.size });
      return;
    }
    if (kind === IMPORT_SOURCE_KINDS.XLSX) {
      const bytes = await readBuffer(file);
      const extracted = await extractSource({ kind, bytes });
      if (!extracted.ok) {
        showImportError('Excel 文本提取失败', extracted.message || '无法提取 Excel 文本；可另存为 CSV 后重试。', sourceId);
        set({ bill: freshBill({ contextId, status: 'none', sourceType: 'local', fileName: file.name, fileSize: file.size }), importRecovery: { ...base, status: 'unsupported', error: { code: 'W_IMPORT_SOURCE_UNSUPPORTED', message: extracted.message || '无法提取 Excel 文本' } } });
        return;
      }
      await applySource(ctx, { sourceId, contextId, sourceKind: kind, content: extracted.text, table: extracted.table ?? null, fileName: file.name, fileSize: file.size });
      return;
    }
    const text = await readText(file);
    await applySource(ctx, { sourceId, contextId, sourceKind: kind, content: text, fileName: file.name, fileSize: file.size });
  } catch (error) {
    showImportError('没有读取成功', error.message || '文件读取失败，请重试。', sourceId);
    set({ bill: freshBill({ contextId, status: 'error', sourceType: 'local', fileName: file.name, fileSize: file.size, error: error.message }), importRecovery: { ...base, status: 'error', error: { code: 'E_IMPORT_READ', message: error.message } } });
  }
}

async function applySource(ctx, { sourceId, contextId, sourceKind, content, table = null, fileName, fileSize }) {
  const { set } = ctx;
  const base = recoveryBase({ sourceId, sourceKind, fileName, fileSize, content, session: sessionInfo(ctx), status: 'reading' });
  const parsed = table ?? parseDelimitedText(content);
  const localDraft = parsed?.header?.length ? buildLocalDraft(parsed, fileName) : {
    origin: 'local', headerOk: false, missing: ['日期', '标的', '方向', '价格', '数量'], rows: [], rawRows: parsed?.rows ?? [],
    note: '未识别到标准表头；可以粘贴带表头的文字，或让 AI 整理交易明细。',
  };
  if (isLocalDraftComplete(localDraft, fileName)) {
    const table = localDraftTable(localDraft);
    const scenario = matchReportScenario({ fileName, table });
    const bill = await demo.loadUserBillFromTable(table, fileName, { method: 'manual', scenario });
    await holdMinimumParseFeedback(sourceId);
    const autoScroll = importWatch?.sourceId === sourceId && importWatch.interacted !== true;
    const count = Array.isArray(bill.trades) ? bill.trades.length : 0;
    const subject = sourceKind === 'text' ? '粘贴的文字' : fileName;
    finishImportFeedback(sourceId, {
      phase: 'success',
      title: `导入成功，已识别 ${count} 条数据`,
      detail: `${subject} 已在本机完成解析；确认前不会离开浏览器。`,
      showJump: !autoScroll,
      autoScrollPending: autoScroll,
    });
    set({
      bill: freshBill({ contextId, status: 'loaded', sourceType: 'local', fileName, fileSize, ...loadedBillFields(bill), importMethod: 'manual' }),
      chat: defaultChat(contextId),
      importRecovery: { ...base, status: 'local_ready', localDraft, draft: null },
    });
    return;
  }
  const hasRows = Array.isArray(localDraft.rows) && localDraft.rows.length > 0;
  const normalized = localDraft.headerOk ? localDraftTable(localDraft) : parsed;
  const errors = normalized?.header?.length ? [{ code: 'E_LOCAL_INCOMPLETE', message: '常规解析不完整，请补全字段或让 AI 整理' }] : [{ code: 'E_HEADER_MISSING', message: '未识别到标准表头（日期、标的、方向、价格、数量）' }];
  await holdMinimumParseFeedback(sourceId);
  finishImportFeedback(sourceId, {
    phase: 'error',
    title: hasRows ? '没有直接导入成功' : '没有解析出可导入的数据',
    detail: hasRows
      ? `已整理 ${localDraft.rows.length} 行草稿，但仍有字段需要补全；可在下方逐行修改，或让 AI 整理。`
      : (localDraft.headerOk ? '账单里有表头，但没有可导入的交易行；请检查后重试。' : '未识别到标准表头（日期、标的、方向、价格、数量）；请检查格式后重试。'),
    showJump: false,
    autoScrollPending: false,
  });
  set({
    bill: freshBill({ contextId, status: 'invalid', sourceType: 'local', fileName, fileSize, blocked: true, errors, sourceNote: `来源：${fileName}（本机解析未完成；未生成正式账单）` }),
    chat: defaultChat(contextId),
    importRecovery: { ...base, status: hasRows ? 'draft' : 'needs_ai', localDraft, draft: hasRows ? localDraft : null },
  });
}

async function handlePaste(ctx, pasted) {
  const { state, set } = ctx;
  if (parsingInFlight(state, state.importRecovery)) return;
  const content = String(pasted ?? state.importRecovery?.content ?? '');
  if (!content.trim()) {
    showImportError('没有可解析的内容', '请先粘贴账单文字，再解析。', null, 'paste');
    set({ importRecovery: { ...(state.importRecovery ?? defaultImportRecovery()), error: { code: 'E_IMPORT_EMPTY_TEXT', message: '请先粘贴账单文字' } } });
    return;
  }
  const contextId = createBillContextId();
  const sourceId = ++sourceSeq;
  const base = recoveryBase({ sourceId, sourceKind: 'text', fileName: '粘贴文字', fileSize: content.length, content, session: sessionInfo(ctx), status: 'reading' });
  beginImportFeedback(sourceId, { sourceKind: 'text', fileName: '粘贴文字' });
  set({ bill: freshBill({ contextId, status: 'loading', sourceType: 'local', fileName: '粘贴文字', fileSize: content.length }), chat: defaultChat(contextId), importRecovery: base });
  try {
    await applySource(ctx, { sourceId, contextId, sourceKind: 'text', content, fileName: '粘贴文字', fileSize: content.length });
  } catch (error) {
    showImportError('没有读取成功', error.message || '解析文字时出现错误，请重试。', sourceId, 'paste');
    set({ bill: freshBill({ contextId, status: 'error', sourceType: 'local', fileName: '粘贴文字', fileSize: content.length, error: error.message }), importRecovery: { ...base, status: 'error', error: { code: 'E_IMPORT_PARSE', message: error.message || '解析文字时出现错误' } } });
  }
}

async function aiRecover(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (!rec || rec.pending || rec.budgetExhausted) return { ok: false, kind: 'text', code: 'E_IMPORT_AI_BUSY' };
  const content = String(rec.content ?? '');
  if (!content.trim()) return { ok: false, kind: 'text', code: 'E_IMPORT_AI_NO_SOURCE' };
  clearImportFeedback();
  const sourceId = rec.sourceId;
  const localDraft = rec.localDraft ?? (parseDelimitedText(content)?.header?.length ? buildLocalDraft(parseDelimitedText(content), rec.fileName || '粘贴文字') : null);
  set({ importRecovery: { ...rec, pending: true, error: null, validationErrors: [] } });
  try {
    const result = await client(ctx).requestRecovery({ content, sourceKind: rec.sourceKind || 'text' });
    const session = client(ctx).getSession();
    if (state.importRecovery.sourceId !== sourceId) {
      set({ importRecovery: applySession({ ...state.importRecovery, pending: false }, session) });
      return { ok: false, kind: 'text', code: 'E_IMPORT_SOURCE_STALE' };
    }
    if (!result.ok) {
      set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session), error: { code: result.code, message: result.message, upstream: result.upstream ?? null, retryable: result.retryable === true } } });
      return { ok: false, kind: 'text', code: result.code };
    }
    const draft = buildAiDraft({ aiTrades: result.draft.trades, unresolved: result.draft.unresolved, localDraft, sourceFile: rec.fileName || '粘贴文字', requestId: session.request_ids?.at(-1) ?? null });
    const duplicates = draft.rows.filter((row) => row.duplicateOf).length;
    set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session), status: 'draft', draft, unresolved: result.draft.unresolved, notice: aiDraftNotice(result.draft.trades, result.draft.unresolved, duplicates), error: null } });
    return { ok: true, kind: 'text', draftCount: draft.rows.filter((row) => row.include !== false).length };
  } catch {
    set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false }, client(ctx).getSession()), error: { code: 'E_IMPORT_RECOVERY_UNEXPECTED', message: '识别链路出现未预期错误' } } });
    return { ok: false, kind: 'text', code: 'E_IMPORT_RECOVERY_UNEXPECTED' };
  }
}

export async function runImportAi(ctx) {
  const rec = ctx?.state?.importRecovery;
  if (!rec) return { ok: false, code: 'E_IMPORT_AI_NO_SOURCE' };
  if (rec.pending) return { ok: false, code: 'E_IMPORT_AI_BUSY' };
  if (rec.budgetExhausted) return { ok: false, code: 'E_IMPORT_AI_BUDGET' };
  const vision = rec.vision;
  const visionReady = Array.isArray(vision?.images) && vision.images.length > 0 && vision.status === 'ready';
  if (visionReady) return aiVision(ctx);
  if (String(rec.content ?? '').trim()) return aiRecover(ctx);
  return { ok: false, code: 'E_IMPORT_AI_NO_SOURCE' };
}

function removeImage(ctx, { sourceIndex = null, index = null } = {}) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (!rec || rec.pending || rec.vision?.kind !== 'image') return;
  const nextVision = Number.isInteger(sourceIndex)
    ? removeVisionSource(rec.vision, sourceIndex, { sourceKind: 'image' })
    : removeVisionImage(rec.vision, index, { sourceKind: 'image' });
  if (!nextVision) return;
  const hasImages = nextVision.images.length > 0;
  const contextId = createBillContextId();
  set({
    // 删除图片必须让旧草稿、旧 unresolved 和旧确认状态全部失效。
    bill: freshBill({ contextId, status: 'none', sourceType: 'local', fileName: '截图识别', fileSize: 0 }),
    chat: defaultChat(contextId),
    importRecovery: {
      ...rec,
      status: hasImages ? 'vision_ready' : 'vision_pdf',
      vision: nextVision,
      localDraft: null,
      draft: null,
      unresolved: [],
      error: null,
      notice: null,
      validationErrors: [],
    },
  });
}

function restartImport(ctx) {
  const { set } = ctx;
  clearImportFeedback();
  try {
    client(ctx).completeFlow({ reason: 'user_restart' });
  } catch { /* flow 收口失败不阻断新的本地导入 */ }
  pdfSource = null;
  const contextId = createBillContextId();
  set({
    bill: freshBill({ contextId, status: 'none', sourceType: 'local', fileName: '截图识别', fileSize: 0 }),
    chat: defaultChat(contextId),
    importRecovery: {
      ...defaultImportRecovery(),
      status: 'vision_pdf',
      sourceKind: 'image',
      vision: {
        ...defaultImportRecovery().vision,
        kind: 'image',
        status: 'empty',
        notice: '已结束本次识别任务；请重新选择截图。',
      },
    },
  });
}

async function openImages(ctx, files) {
  const { set } = ctx;
  const contextId = createBillContextId();
  const sourceId = ++sourceSeq;
  const base = recoveryBase({ sourceId, sourceKind: 'image', fileName: '截图识别', fileSize: files.reduce((sum, f) => sum + (f.size || 0), 0), content: '', session: sessionInfo(ctx), status: 'vision_pdf' });
  set({ bill: freshBill({ contextId, status: 'none', sourceType: 'local', fileName: '截图识别', fileSize: base.fileSize }), chat: defaultChat(contextId), importRecovery: { ...base, status: 'vision_pdf', vision: { ...defaultImportRecovery().vision, kind: 'image', fileName: '截图识别', images: [], status: 'preparing' } } });
  try {
    if (files.length > IMPORT_VISION_MAX_IMAGES) {
      throw new Error(`一次最多处理 ${IMPORT_VISION_MAX_IMAGES} 张图片；请减少截图数量或分次导入`);
    }
    const images = await prepareImageFiles(files, { maxImages: IMPORT_VISION_MAX_IMAGES });
    const checked = validateVisionInput({ images, sourceKind: 'image' });
    if (!checked.ok) throw new Error(checked.message);
    set({ importRecovery: { ...base, status: 'vision_ready', vision: { ...defaultImportRecovery().vision, kind: 'image', fileName: '截图识别', images: checked.images, totalBytes: checked.totalBytes, totalBase64Chars: checked.totalBase64Chars, payloadBytes: checked.payloadBytes, status: 'ready', notice: `已在本机准备 ${imageCountText({ images: checked.images })}；点击识别前不会发送。` } } });
  } catch (error) {
    set({
      importRecovery: {
        ...base,
        status: 'vision_pdf',
        error: { code: 'E_IMPORT_IMAGE', message: error.message },
        vision: {
          ...defaultImportRecovery().vision,
          kind: 'image',
          fileName: '截图识别',
          images: [],
          status: 'error',
          error: { code: 'E_IMPORT_IMAGE', message: error.message },
          notice: '未发送任何图片。',
        },
      },
    });
  }
}

async function openPdf(ctx, { bytes, fileName, fileSize, contextId }) {
  const { set } = ctx;
  const sourceId = ++sourceSeq;
  const base = recoveryBase({ sourceId, sourceKind: 'pdf', fileName, fileSize, content: '', session: sessionInfo(ctx), status: 'vision_pdf' });
  set({ bill: freshBill({ contextId, status: 'none', sourceType: 'local', fileName, fileSize }), chat: defaultChat(contextId), importRecovery: { ...base, status: 'vision_pdf', vision: { ...defaultImportRecovery().vision, kind: 'pdf_scan', fileName, pageCount: 0, status: 'preparing' } } });
  try {
    const pageCount = await getPdfPageCount(bytes);
    const endPage = Math.min(pageCount, IMPORT_VISION_MAX_IMAGES);
    set({ importRecovery: { ...base, status: 'vision_pdf', vision: { ...defaultImportRecovery().vision, kind: 'pdf_scan', fileName, pageCount, startPage: 1, endPage, status: 'selecting' } } });
  } catch (error) {
    set({ importRecovery: { ...base, status: 'error', error: { code: 'E_IMPORT_PDF', message: error.message } } });
  }
}

async function renderPdf(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (!pdfSource || !rec?.vision) return;
  const start = Number(hostNumber('tm-page-start'));
  const end = Number(hostNumber('tm-page-end'));
  const vision = rec.vision;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > vision.pageCount || end - start + 1 > IMPORT_VISION_MAX_IMAGES) {
    set({ importRecovery: { ...rec, vision: { ...vision, error: { code: 'E_IMPORT_PAGE_RANGE', message: `请输入 1-${Math.min(vision.pageCount, IMPORT_VISION_MAX_IMAGES)} 页以内的连续页码` } } } });
    return;
  }
  set({ importRecovery: { ...rec, vision: { ...vision, startPage: start, endPage: end, status: 'rendering', error: null } } });
  try {
    const images = await renderPdfPages(pdfSource.bytes, Array.from({ length: end - start + 1 }, (_, i) => start + i));
    const checked = validateVisionInput({ images, sourceKind: 'pdf_scan' });
    if (!checked.ok) throw new Error(checked.message);
    set({ importRecovery: { ...state.importRecovery, status: 'vision_ready', vision: { ...vision, startPage: start, endPage: end, images: checked.images, totalBytes: checked.totalBytes, totalBase64Chars: checked.totalBase64Chars, payloadBytes: checked.payloadBytes, status: 'ready', error: null } } });
  } catch (error) {
    set({ importRecovery: { ...state.importRecovery, vision: { ...vision, status: 'selecting', error: { code: 'E_IMPORT_PDF_RENDER', message: error.message } } } });
  }
}

function hostNumber(id) {
  return document.getElementById(id)?.value;
}

async function aiVision(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (!rec || rec.pending || rec.budgetExhausted) return { ok: false, kind: 'vision', code: 'E_IMPORT_AI_BUSY' };
  const vision = rec.vision;
  const checked = validateVisionInput({ images: vision?.images ?? [], sourceKind: vision?.kind });
  if (!checked.ok) return { ok: false, kind: 'vision', code: checked.code };
  clearImportFeedback();
  const sourceId = rec.sourceId;
  set({ importRecovery: { ...rec, pending: true, error: null } });
  try {
    const result = await client(ctx).requestVision({ images: checked.images, sourceKind: vision.kind, pageCount: vision.pageCount, pageRange: vision.kind === 'pdf_scan' ? { start: vision.startPage, end: vision.endPage } : null });
    const session = client(ctx).getSession();
    if (state.importRecovery.sourceId !== sourceId) {
      set({ importRecovery: applySession({ ...state.importRecovery, pending: false }, session) });
      return { ok: false, kind: 'vision', code: 'E_IMPORT_SOURCE_STALE' };
    }
    if (!result.ok) {
      set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session), error: { code: result.code, message: result.message, upstream: result.upstream ?? null, retryable: result.retryable === true } } });
      return { ok: false, kind: 'vision', code: result.code };
    }
    const draft = buildAiDraft({ aiTrades: result.draft.trades, unresolved: result.draft.unresolved, localDraft: rec.localDraft ?? null, sourceFile: rec.fileName || '视觉识别', requestId: session.request_ids?.at(-1) ?? null, duplicatePolicy: 'warn', nonTradePolicy: 'unresolved', columnMapping: result.draft.columnMapping ?? [] });
    set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session), status: 'draft', draft, unresolved: result.draft.unresolved, notice: aiDraftNotice(result.draft.trades, result.draft.unresolved), error: null } });
    return { ok: true, kind: 'vision', draftCount: draft.rows.filter((row) => row.include !== false).length };
  } catch {
    set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false }, client(ctx).getSession()), error: { code: 'E_IMPORT_VISION_UNEXPECTED', message: '视觉识别链路出现未预期错误' } } });
    return { ok: false, kind: 'vision', code: 'E_IMPORT_VISION_UNEXPECTED' };
  }
}

async function validateDraft(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (!rec?.draft) return;
  clearImportFeedback();
  const sourceFile = rec.fileName || '粘贴文字';
  const draft = { ...rec.draft, rows: rec.draft.rows.map((row) => refreshRowStatus(row, sourceFile)) };
  const checked = draftToNormalized(draft, sourceFile);
  if (!checked.ok) {
    set({ importRecovery: { ...rec, draft, error: { code: checked.code, message: checked.message }, validationErrors: checked.normalized?.errors ?? [] } });
    return;
  }
  const method = draft.rows.some((row) => row.source === 'ai' && row.include !== false) ? 'ai' : 'manual';
  const modality = rec.vision?.kind ? 'vision' : 'text';
  const scenario = matchReportScenario({ fileName: sourceFile, table: checked.table });
  const bill = await demo.loadUserBillFromTable(checked.table, sourceFile, { method, modality, scenario });
  set({
    bill: freshBill({ contextId: state.bill.contextId ?? createBillContextId(), status: 'loaded', sourceType: 'local', fileName: sourceFile, fileSize: rec.fileSize, blocked: false, ...loadedBillFields(bill), importMethod: method, importModality: modality }),
    importRecovery: { ...rec, draft, status: 'accepted', error: null, validationErrors: [] },
  });
}
