// 导入 · 确认：本机读取 CSV/TSV/Excel/文本型 PDF/粘贴文字 → 常规校验 → 不完整时可让 AI 整理草稿。
// 边界：常规解析优先且零模型请求；只有用户点击才发送提取文字；草稿可编辑，最终仍由 normalizeRows 与既有确认流程写入。
import { el, chip } from '../components.js';
import { defaultBill, defaultChat, defaultImportRecovery, createBillContextId } from '../../state.js';
import * as demo from '../../demo/adapter.js';
import {
  IMPORT_SOURCE_KINDS,
  detectSourceKind,
  parseDelimitedText,
  extractSource,
} from '../../engine/importSource.js';
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
} from '../../engine/importDraft.js';
import { createImportRecovery } from '../../agent/importRecovery.js';
import { finalizeConfirmedBill } from '../../agent/importFinalize.js';
import {
  IMPORT_VISION_MAX_IMAGES,
  IMPORT_VISION_MAX_PAYLOAD_BYTES,
  validateVisionInput,
} from '../../agent/importVision.js';
import { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } from '../../agent/httpTransport.js';

const AI_NOTICE = '只有你点击“让 AI 帮我识别”时，才会把提取出的文字发送给模型；原始文件不会上传。';
const MARKET_NOTICE = '当前用户账单使用 Tushare 动态日线（服务端获取，非实时）；取数失败、标的超出单次上限或日期范围不足时，报告会明确阻断，不回退静态缓存或合成行情。';
const CORPORATE_ACTION_NOTICE = '公司行为限制：v1 不自动识别送转、拆合股、配股等股数事件；涉及相关区间的账单可能估值不准确，请核对后再使用。';
const CONFIRM_NOTE = '确认后进入分析报告；不会上传账单、不会执行交易。';
const FEE_TAX_NOTE = '部分费用或税费缺失，当前结果按现有口径计算，可能与实际对账结果不同。';
const PDF_GAP = 'PDF 没有可提取的文本层（可能是扫描版）；可改为选择页面，在本机渲染后使用视觉识别。';
const AI_CONSENT = '点击后会发送“提取出的文字”（不含文件名、原始文件或图片）；仅用于整理交易明细。';

const SOURCE_LABEL = Object.freeze({ csv: 'CSV', tsv: 'TSV', xlsx: 'Excel', pdf: 'PDF 文本', text: '粘贴文字', image: '截图', unsupported: '文件' });

// 人话说明与 csvNormalize 的错误码一一对应（规则以引擎为准，此处只做解释）
const ERROR_HELP = Object.freeze({
  E_EMPTY: '没有可用的交易行。请提供包含交易记录的内容。',
  E_HEADER_MISSING: '缺少必需列。第一行表头需要包含：日期、标的、方向、价格、数量。',
  E_DATE_FORMAT: '日期格式不对，请写成 2024-09-25 这样的“年-月-日”。',
  E_SYMBOL_FORMAT: '标的需为 6 位数字代码（例如 000001），请保留前导零。',
  E_SIDE_VALUE: '方向只能填“买入”或“卖出”。',
  E_PRICE_VALUE: '价格需为大于 0 的数字。',
  E_PRICE_PRECISION: '价格最多 2 位小数；系统不会自动四舍五入，请修正。',
  E_QTY_INTEGER: '数量需为正整数。',
  E_MONEY_VALUE: '费用、税费需为不小于 0 的数字（留空表示缺失，按 0 计并标注）。',
  E_MONEY_PRECISION: '费用、税费最多 2 位小数；系统不会自动四舍五入，请修正。',
  E_QTY_EXCEEDS: '某只标的在某个时点的累计卖出超过了此前累计买入。当前不支持缺少期初持仓的账单，请从首笔买入开始提供。',
  E_DRAFT_EMPTY: '还没有勾选任何交易；请勾选至少一行后再导入。',
});

let sourceSeq = 0;
let defaultRecoveryClient = null;
let pdfSource = null;

function emptyVision() {
  return {
    kind: null,
    fileName: '',
    pageCount: 0,
    startPage: 1,
    endPage: 1,
    images: [],
    totalBytes: 0,
    totalBase64Chars: 0,
    payloadBytes: 0,
    status: 'idle',
    error: null,
    notice: '',
  };
}

function clearPdfSource() {
  pdfSource = null;
}

function getRecoveryClient(ctx) {
  if (ctx.importRecovery) return ctx.importRecovery;
  if (!defaultRecoveryClient) {
    const transport = createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS });
    defaultRecoveryClient = createImportRecovery({ transport });
  }
  return defaultRecoveryClient;
}

function sessionInfo(ctx) {
  try {
    return getRecoveryClient(ctx).getSession();
  } catch {
    return { flow_id: null, model_calls: 0, budget_max: 2, remaining: 2 };
  }
}

function prepGuide() {
  return el('div', { class: 'card im-prep' }, [
    el('div', { class: 'section-title' }, ['准备账单']),
    el('ul', { class: 'im-list' }, [
      el('li', {}, ['支持 CSV/TSV、Excel（.xlsx）、含文本的 PDF、截图，或扫描版 PDF（本地渲染页面后识别）。']),
      el('li', {}, ['能常规解析的内容优先常规解析，不调用模型。']),
      el('li', {}, ['解析失败或不完整时，可点击“让 AI 帮我识别”；AI 只生成可编辑草稿，不是导入成功。']),
      el('li', {}, ['截图和扫描版 PDF 使用视觉识别；预览、选页和本地渲染不触发模型，点击识别后才发送所选图片，Excel 只读取第一个工作表。']),
      el('li', {}, ['账单需从首笔买入开始；任一时点卖出不能超过此前买入。']),
      el('li', {}, ['确认只用于本地分析，不会下单、不会执行交易。']),
    ]),
    el('details', { class: 'im-format' }, [
      el('summary', {}, ['查看字段、格式与限制']),
      el('ul', { class: 'im-list' }, [
        el('li', {}, ['必填列：日期（YYYY-MM-DD）、标的（6 位数字代码）、方向（买入 / 卖出）、价格（大于 0，最多 2 位小数）、数量（正整数）。']),
        el('li', {}, ['可选列：费用、税费（不小于 0，最多 2 位小数；缺失按 0 计并标注）。其他列会被忽略。']),
        el('li', {}, ['原始 CSV/表格仅在本机读取和校验，不上传；文本识别只发送提取文字；截图/扫描页只在点击识别后发送所选压缩图片。']),
        el('li', {}, [AI_NOTICE]),
        el('li', {}, [CORPORATE_ACTION_NOTICE]),
        el('li', {}, [MARKET_NOTICE]),
      ]),
      el('div', { class: 'muted small' }, ['表头示例：', el('code', { class: 'im-code' }, ['日期,标的,方向,价格,数量,费用,税费'])]),
    ]),
  ]);
}

function feeTaxSummary(trades) {
  const fee = trades.filter((t) => t.fee_missing).map((t) => t.source.line);
  const tax = trades.filter((t) => t.tax_missing).map((t) => t.source.line);
  if (!fee.length && !tax.length) return null;
  return el('div', { class: 'banner warn-banner im-feetax' }, [
    el('strong', {}, ['费用 / 税费有缺失']),
    FEE_TAX_NOTE,
    fee.length ? el('div', {}, [`费用缺失：第 ${fee.join('、')} 行（按 0 计）`]) : null,
    tax.length ? el('div', {}, [`税费缺失：第 ${tax.join('、')} 行（按 0 计）`]) : null,
  ]);
}

function invalidBlock(errors) {
  const groups = new Map();
  for (const e of errors) {
    const g = groups.get(e.code) ?? { lines: [], message: e.message };
    if (e.line) g.lines.push(e.line);
    groups.set(e.code, g);
  }
  const eb = el('div', { class: 'banner warn-banner' }, [
    el('strong', {}, ['不能分析：账单里有需要修改的地方（整批阻断）']),
    el('div', { class: 'muted small' }, ['为保证结果可以核对，只要有一处必需字段不通过，就不会生成正式账单。可以继续修改下方草稿，或让 AI 重新整理。']),
  ]);
  for (const [code, g] of groups) {
    eb.append(el('div', { class: 'im-fix' }, [`· ${ERROR_HELP[code] ?? g.message}${g.lines.length ? `（第 ${g.lines.join('、')} 行）` : ''}`]));
  }
  eb.append(el('details', { class: 'im-tech' }, [
    el('summary', {}, ['技术详情（错误码）']),
    ...errors.map((e) => el('div', { class: 'muted small' }, [errText(e)])),
  ]));
  return eb;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtAt(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN');
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取文件内容：${file.name}`));
    reader.readAsText(file);
  });
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error(`无法读取文件内容：${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

// 每次状态迁移都基于 defaultBill() 全量重建，避免上一份账单的 trades/warnings/dataMode 等残留到下一状态
function freshBill(scenario, fields = {}) {
  return { ...defaultBill(), scenario: scenario || 'R', ...fields };
}

function errText(e) {
  return `${e.code}${e.line ? `（第 ${e.line} 行）` : ''} · ${e.message}`;
}

function stripSpecRefs(text) {
  return String(text ?? '')
    .replace(/（[^）]*\b(?:[BFRQS]-\d+|[BFRQS]\d+)\b[^）]*）/g, '')
    .replace(/\b(?:[BFRQS]-\d+|[BFRQS]\d+)\b/g, '')
    .trim();
}

function displayLabel(text) {
  return String(text ?? '').replace(/（Q\d+）/g, '');
}

function warningsBlock(warnings) {
  const wl = el('div', { class: 'banner warn-banner' }, [el('strong', {}, ['警告（照实展示）'])]);
  for (const w of warnings) {
    const meta = [w.line ? `第 ${w.line} 行` : '', w.column ? `列：${w.column}` : ''].filter(Boolean).join(' · ');
    wl.append(el('div', {}, [`${meta ? `${meta} · ` : ''}${stripSpecRefs(w.message) || '未提供说明'}`]));
  }
  wl.append(el('details', { class: 'im-tech' }, [
    el('summary', {}, ['技术详情（警告码）']),
    ...warnings.map((w) => el('div', { class: 'muted small' }, [
      `${w.code}${w.line ? `（第 ${w.line} 行）` : ''}${w.column ? ` · ${w.column}` : ''}${w.message ? ` · ${w.message}` : ''}`,
    ])),
  ]));
  return wl;
}

function sourceNoteText(note) {
  return String(note || '')
    .replace(/m0\/csv-input\/fixtures/gi, '内置演示夹具')
    .replace(/[；;]\s*\bschema\s+[^\s）]+/gi, '')
    .replace(/[；;]\s*$/, '');
}

function dataModeLine(dataMode) {
  return el('div', { class: 'muted small' }, [`数据模式：${dataMode.label} —— ${dataMode.note}`]);
}

function marketLine(marketSource, supportScope) {
  if (!marketSource) return null;
  const scope = supportScope
    ? ` · 请求范围 ${supportScope.range.start} → ${supportScope.range.end}（${supportScope.symbols.join(' / ')}，最新交易日 ${supportScope.asOfDate}）${supportScope.fetchedAt ? ` · 拉取时间 ${fmtAt(supportScope.fetchedAt)} · 快照 ${supportScope.snapshotId ?? '—'}` : ''}`
    : '';
  return el('div', { class: 'muted small' }, [`行情：${marketSource.label}${scope}`]);
}

function tradesTable(trades) {
  const table = el('table', { class: 'tbl' });
  const head = el('tr');
  for (const h of ['行', '交易日', '标的', '方向', '价格', '数量', '费用', '税费']) head.append(el('th', {}, [h]));
  table.append(el('thead', {}, [head]));
  const body = el('tbody');
  for (const tr of trades) {
    const row = el('tr');
    row.append(el('td', {}, [String(tr.source.line)]));
    row.append(el('td', {}, [tr.trade_date]));
    row.append(el('td', {}, [tr.symbol]));
    row.append(el('td', {}, [tr.side === 'buy' ? '买入' : '卖出']));
    row.append(el('td', {}, [tr.price.toFixed(2)]));
    row.append(el('td', {}, [String(tr.quantity)]));
    row.append(el('td', { class: tr.fee_missing ? 'warn' : '' }, [tr.fee_missing ? '缺失（按 0）' : tr.fee.toFixed(2)]));
    row.append(el('td', { class: tr.tax_missing ? 'warn' : '' }, [tr.tax_missing ? '缺失（按 0）' : tr.tax.toFixed(2)]));
    body.append(row);
  }
  table.append(body);
  return el('div', { class: 'table-wrap' }, [table]);
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

async function applySource(ctx, { sourceId, contextId, sourceKind, content, table = null, fileName, fileSize }) {
  const { state, set } = ctx;
  const scenario = state.bill.scenario;
  const session = sessionInfo(ctx);
  const base = recoveryBase({ sourceId, sourceKind, fileName, fileSize, content, session });
  const parsedTable = table ?? parseDelimitedText(content);
  const localDraft = parsedTable.header?.length
    ? buildLocalDraft(parsedTable, fileName)
    : {
      origin: 'local',
      headerOk: false,
      missing: ['日期', '标的', '方向', '价格', '数量'],
      rows: [],
      rawRows: parsedTable.rows ?? [],
      note: '未识别到标准表头；可以粘贴带表头的文字，或让 AI 整理交易明细。',
    };
  const complete = isLocalDraftComplete(localDraft, fileName);
  if (complete) {
    const bill = await demo.loadUserBillFromTable(localDraftTable(localDraft), fileName, { method: 'manual' });
    set({
      bill: freshBill(scenario, {
        contextId,
        status: 'loaded',
        sourceType: 'local',
        fileName,
        fileSize,
        blocked: false,
        trades: bill.trades,
        warnings: bill.warnings,
        errors: bill.errors,
        dataMode: bill.dataMode,
        sourceNote: bill.sourceNote,
        resultLabelling: bill.resultLabelling,
        importMethod: 'manual',
      }),
      chat: defaultChat(contextId),
      importRecovery: {
        ...base,
        status: 'local_ready',
        localDraft,
        draft: null,
        localNote: '常规解析成功，未调用 AI；请核对下方交易列表后确认。',
      },
    });
    return;
  }
  const canonicalTable = localDraft.headerOk ? localDraftTable(localDraft) : parsedTable;
  const normalized = canonicalTable?.header?.length
    ? await demo.loadUserBillFromTable(canonicalTable, fileName)
    : null;
  const errors = normalized?.errors?.length
    ? normalized.errors
    : [{ line: 1, code: 'E_HEADER_MISSING', message: '未识别到标准表头（日期、标的、方向、价格、数量）' }];
  const warnings = normalized?.warnings ?? [];
  const hasRows = (localDraft.rows ?? []).length > 0;
  set({
    bill: freshBill(scenario, {
      contextId,
      status: 'invalid',
      sourceType: 'local',
      fileName,
      fileSize,
      blocked: true,
      trades: [],
      warnings,
      errors,
      sourceNote: `来源：${fileName}（本机解析未完成；未生成正式账单）`,
    }),
    chat: defaultChat(contextId),
    importRecovery: {
      ...base,
      status: hasRows ? 'draft' : 'needs_ai',
      localDraft,
      draft: hasRows ? localDraft : null,
      localNote: localDraft.note || `常规解析识别到 ${localDraft.rows.filter((r) => r.status === 'valid').length} 行可用交易，其余仍需核对。`,
    },
  });
}

function setVisionState(ctx, { contextId, sourceId, kind, fileName, fileSize, pageCount = 0, startPage = 1, endPage = 1, images = [], status, error = null, notice = '', localDraft = null }) {
  const { state, set } = ctx;
  const session = sessionInfo(ctx);
  const checked = images.length ? validateVisionInput({ images, sourceKind: kind }) : null;
  const vision = {
    ...emptyVision(),
    kind,
    fileName,
    pageCount,
    startPage,
    endPage,
    images,
    totalBytes: images.reduce((sum, image) => sum + (Number.isFinite(image.bytes) ? image.bytes : 0), 0),
    totalBase64Chars: checked?.ok ? checked.totalBase64Chars : images.reduce((sum, image) => sum + String(image.data_base64 ?? '').length, 0),
    payloadBytes: checked?.ok ? checked.payloadBytes : 0,
    status,
    error: error ?? (checked && !checked.ok ? { code: checked.code, message: checked.message } : null),
    notice,
  };
  const base = recoveryBase({
    sourceId,
    sourceKind: kind === 'pdf_scan' ? 'pdf' : 'image',
    fileName,
    fileSize,
    content: '',
    session,
    status: images.length ? 'vision_ready' : 'vision_pdf',
  });
  set({
    bill: freshBill(state.bill.scenario, {
      contextId,
      status: 'none',
      sourceType: 'local',
      fileName,
      fileSize,
    }),
    chat: defaultChat(contextId),
    importRecovery: {
      ...base,
      status: images.length ? 'vision_ready' : 'vision_pdf',
      localDraft,
      vision,
      error: null,
      validationErrors: [],
      notice: '',
    },
  });
}

async function openVisionPdf(ctx, { bytes, fileName, fileSize, contextId, localDraft = null, note = '' }) {
  const { state, set } = ctx;
  const sourceId = ++sourceSeq;
  pdfSource = { bytes, fileName, fileSize };
  const session = sessionInfo(ctx);
  set({
    bill: freshBill(state.bill.scenario, { contextId, status: 'loading', sourceType: 'local', fileName, fileSize }),
    chat: defaultChat(contextId),
    importRecovery: {
      ...recoveryBase({ sourceId, sourceKind: 'pdf', fileName, fileSize, content: '', session, status: 'vision_pdf' }),
      status: 'vision_pdf',
      localDraft,
      vision: { ...emptyVision(), kind: 'pdf_scan', fileName, status: 'preparing', notice: '正在本机读取 PDF 页数；不会触发模型…' },
    },
  });
  try {
    const { getPdfPageCount } = await import('../../engine/pdfRender.js');
    const pageCount = await getPdfPageCount(bytes);
    if (ctx.state.importRecovery.sourceId !== sourceId) return;
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF 没有可渲染的页面');
    const endPage = Math.min(pageCount, IMPORT_VISION_MAX_IMAGES);
    set({
      bill: freshBill(state.bill.scenario, { contextId, status: 'none', sourceType: 'local', fileName, fileSize }),
      importRecovery: {
        ...recoveryBase({ sourceId, sourceKind: 'pdf', fileName, fileSize, content: '', session, status: 'vision_pdf' }),
        status: 'vision_pdf',
        localDraft,
        vision: {
          ...emptyVision(),
          kind: 'pdf_scan',
          fileName,
          pageCount,
          startPage: 1,
          endPage,
          status: 'selecting',
          notice: pageCount > IMPORT_VISION_MAX_IMAGES
            ? `PDF 共 ${pageCount} 页；一次最多渲染 ${IMPORT_VISION_MAX_IMAGES} 页，请选择范围。`
            : (note || '请选择页面并在本机渲染；点击识别前不会发送图片。'),
        },
      },
    });
  } catch (error) {
    set({
      bill: freshBill(state.bill.scenario, { contextId, status: 'none', sourceType: 'local', fileName, fileSize }),
      importRecovery: {
        ...recoveryBase({ sourceId, sourceKind: 'pdf', fileName, fileSize, content: '', session, status: 'unsupported' }),
        status: 'unsupported',
        unsupported: {
          code: 'W_IMPORT_PDF_RENDER_UNSUPPORTED',
          message: `PDF 页面无法在本机渲染：${error && error.message ? error.message : String(error)}；请粘贴文字或换一个 PDF`,
        },
      },
    });
  }
}

async function onVisionImagesPicked(ctx, files) {
  const { state, set } = ctx;
  const scenario = state.bill.scenario;
  const contextId = createBillContextId();
  const sourceId = ++sourceSeq;
  const session = sessionInfo(ctx);
  clearPdfSource();
  if (files.length > IMPORT_VISION_MAX_IMAGES) {
    setVisionState(ctx, {
      contextId,
      sourceId,
      kind: 'image',
      fileName: '截图识别',
      fileSize: files.reduce((sum, file) => sum + (file.size || 0), 0),
      status: 'error',
      error: { code: 'E_IMPORT_VISION_TOO_MANY', message: `一次最多 ${IMPORT_VISION_MAX_IMAGES} 张截图；请重新选择更少的图片` },
      notice: '未发送任何图片。',
    });
    return;
  }
  set({
    bill: freshBill(scenario, { contextId, status: 'loading', sourceType: 'local', fileName: '截图识别', fileSize: files.reduce((sum, file) => sum + (file.size || 0), 0) }),
    chat: defaultChat(contextId),
    importRecovery: {
      ...recoveryBase({ sourceId, sourceKind: 'image', fileName: '截图识别', fileSize: files.reduce((sum, file) => sum + (file.size || 0), 0), content: '', session, status: 'vision_pdf' }),
      status: 'vision_pdf',
      vision: { ...emptyVision(), kind: 'image', fileName: '截图识别', status: 'preparing', notice: `正在本机压缩 ${files.length} 张图片；不会触发模型…` },
    },
  });
  try {
    const { prepareImageFile } = await import('../../engine/visionImage.js');
    const images = [];
    for (const file of files) {
      const prepared = await prepareImageFile(file);
      images.push(prepared);
    }
    if (ctx.state.importRecovery.sourceId !== sourceId) return;
    const checked = validateVisionInput({ images, sourceKind: 'image' });
    setVisionState(ctx, {
      contextId,
      sourceId,
      kind: 'image',
      fileName: '截图识别',
      fileSize: files.reduce((sum, file) => sum + (file.size || 0), 0),
      pageCount: 0,
      startPage: 0,
      endPage: 0,
      images,
      status: 'ready',
      error: checked.ok ? null : { code: checked.code, message: checked.message },
      notice: checked.ok
        ? `已在本机压缩 ${images.length} 张图片；点击识别前不会发送。`
        : '图片总量超过限制；请重新选择更少的图片。',
    });
  } catch (error) {
    setVisionState(ctx, {
      contextId,
      sourceId,
      kind: 'image',
      fileName: '截图识别',
      fileSize: files.reduce((sum, file) => sum + (file.size || 0), 0),
      status: 'error',
      error: { code: 'E_IMPORT_IMAGE_PREPARE', message: error && error.message ? error.message : String(error) },
      notice: '未发送任何图片。',
    });
  }
}

async function onVisionRender(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  const vision = rec.vision;
  if (rec.pending) return;
  if (!pdfSource || vision.kind !== 'pdf_scan') {
    set({ importRecovery: { ...rec, vision: { ...vision, status: 'selecting', error: { code: 'E_IMPORT_PDF_MISSING', message: 'PDF 文件已不在当前页面；请重新选择 PDF' } } } });
    return;
  }
  const sourceId = rec.sourceId;
  const start = Number(vision.startPage);
  const end = Number(vision.endPage);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > vision.pageCount) {
    set({ importRecovery: { ...rec, vision: { ...vision, error: { code: 'E_IMPORT_PAGE_RANGE', message: `请输入 ${vision.pageCount} 页以内的有效连续页码` } } } });
    return;
  }
  if (end - start + 1 > IMPORT_VISION_MAX_IMAGES) {
    set({ importRecovery: { ...rec, vision: { ...vision, error: { code: 'E_IMPORT_PAGE_RANGE', message: `一次最多渲染 ${IMPORT_VISION_MAX_IMAGES} 页；请缩小页码范围` } } } });
    return;
  }
  set({
    importRecovery: {
      ...rec,
      status: 'vision_pdf',
      vision: { ...vision, status: 'rendering', error: null, notice: `正在本机渲染第 ${start}-${end} 页；不会触发模型…` },
    },
  });
  try {
    const { renderPdfPages } = await import('../../engine/pdfRender.js');
    const pages = [];
    for (let page = start; page <= end; page++) pages.push(page);
    const images = await renderPdfPages(pdfSource.bytes, pages);
    if (ctx.state.importRecovery.sourceId !== sourceId) return;
    const checked = validateVisionInput({ images, sourceKind: 'pdf_scan' });
    set({
      importRecovery: {
        ...state.importRecovery,
        status: 'vision_ready',
        vision: {
          ...state.importRecovery.vision,
          images,
          startPage: start,
          endPage: end,
          totalBytes: images.reduce((sum, image) => sum + image.bytes, 0),
          totalBase64Chars: checked.ok ? checked.totalBase64Chars : images.reduce((sum, image) => sum + image.data_base64.length, 0),
          payloadBytes: checked.ok ? checked.payloadBytes : 0,
          status: 'ready',
          error: checked.ok ? null : { code: checked.code, message: checked.message },
          notice: checked.ok
            ? `已在本机渲染第 ${start}-${end} 页（${images.length} 张）；点击识别前不会发送。`
            : '渲染结果超过请求限制；请缩小页码范围后重新渲染。',
        },
      },
    });
  } catch (error) {
    set({
      importRecovery: {
        ...state.importRecovery,
        status: 'vision_pdf',
        vision: {
          ...state.importRecovery.vision,
          status: 'selecting',
          error: { code: 'E_IMPORT_PDF_RENDER', message: error && error.message ? error.message : String(error) },
          notice: '页面渲染失败；未触发模型。',
        },
      },
    });
  }
}

async function onVisionAiClick(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  const vision = rec.vision;
  const checked = validateVisionInput({ images: vision.images, sourceKind: vision.kind });
  if (!checked.ok) {
    set({ importRecovery: { ...rec, vision: { ...vision, error: { code: checked.code, message: checked.message } } } });
    return;
  }
  if (rec.pending || rec.budgetExhausted) return;
  if (vision.status !== 'ready') {
    set({ importRecovery: { ...rec, vision: { ...vision, error: { code: 'E_IMPORT_VISION_NOT_READY', message: '页码或图片已修改；请先重新本地渲染，再点击识别' } } } });
    return;
  }
  const sourceId = rec.sourceId;
  const client = getRecoveryClient(ctx);
  const keep = rec.draft?.rows?.filter((row) => row.source === 'local' || row.source === 'manual') ?? [];
  const localDraft = keep.length
    ? { ...(rec.localDraft ?? {}), headerOk: true, rows: keep }
    : (rec.localDraft ?? null);
  set({
    importRecovery: {
      ...rec,
      pending: true,
      error: null,
      validationErrors: [],
      notice: `正在识别所选图片；只会发送这 ${vision.images.length} 张压缩图片，不发送文件名或其他文件…`,
    },
  });
  let result;
  try {
    result = await client.requestVision({
      images: vision.images,
      sourceKind: vision.kind,
      pageCount: vision.pageCount,
      pageRange: vision.kind === 'pdf_scan' ? { start: vision.startPage, end: vision.endPage } : null,
    });
  } catch {
    const session = client.getSession();
    set({ importRecovery: { ...applySession({ ...state.importRecovery, pending: false }, session), error: { code: 'E_IMPORT_VISION_UNEXPECTED', message: '图片识别链路出现未预期错误' } } });
    return;
  }
  const session = client.getSession();
  if (state.importRecovery.sourceId !== sourceId) {
    set({ importRecovery: applySession({ ...state.importRecovery, pending: false }, session) });
    return;
  }
  if (!result.ok) {
    set({
      importRecovery: {
        ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session),
        error: { code: result.code, message: result.message, upstream: result.upstream ?? null },
        notice: null,
      },
    });
    return;
  }
  const draft = buildAiDraft({
    aiTrades: result.draft.trades,
    unresolved: result.draft.unresolved,
    localDraft,
    sourceFile: rec.fileName || '视觉识别',
    requestId: session.request_ids?.[session.request_ids.length - 1] ?? null,
  });
  const duplicates = draft.rows.filter((row) => row.duplicateOf).length;
  set({
    importRecovery: {
      ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session),
      status: 'draft',
      draft,
      unresolved: result.draft.unresolved,
      validationErrors: [],
      notice: result.draft.trades.length > 0
        ? `AI 返回 ${result.draft.trades.length} 条交易草稿${duplicates ? `，其中 ${duplicates} 条疑似重复` : ''}；尚未导入，请逐行核对。`
        : 'AI 没有整理出新的交易；请查看下方待确认说明，或手动添加。',
      error: null,
    },
  });
}

async function onFilePicked(ev, ctx) {
  const { state, set } = ctx;
  const files = Array.from(ev?.target?.files ?? []);
  if (files.length === 0 || state.bill.status === 'loading') return;
  const kinds = files.map((file) => detectSourceKind(file.name, file.type));
  if (files.length > 1 || kinds[0] === IMPORT_SOURCE_KINDS.IMAGE) {
    if (kinds.every((kind) => kind === IMPORT_SOURCE_KINDS.IMAGE)) {
      await onVisionImagesPicked(ctx, files);
      return;
    }
    clearPdfSource();
    const scenario = state.bill.scenario;
    const contextId = createBillContextId();
    set({
      bill: freshBill(scenario, {
        contextId,
        status: 'none',
        sourceType: 'local',
        error: '一次只能选择一个账单文件；多选仅支持截图。',
      }),
      chat: defaultChat(contextId),
      importRecovery: { ...defaultImportRecovery(), error: { code: 'E_IMPORT_MULTI_FILE', message: '一次只能选择一个账单文件；多选仅支持截图。' } },
    });
    return;
  }
  const file = files[0];
  const kind = kinds[0];
  const scenario = state.bill.scenario;
  const contextId = createBillContextId();
  const sourceId = ++sourceSeq;
  const session = sessionInfo(ctx);
  const base = recoveryBase({
    sourceId,
    sourceKind: kind,
    fileName: file.name,
    fileSize: file.size,
    content: '',
    session,
    status: 'reading',
  });
  if (kind === IMPORT_SOURCE_KINDS.UNSUPPORTED) {
    clearPdfSource();
    const message = `暂不支持这种文件类型（${file.name}）；请使用 CSV、TSV、.xlsx、文本型 PDF 或截图`;
    set({
      bill: freshBill(scenario, { contextId, status: 'none', sourceType: 'local', fileName: file.name, fileSize: file.size }),
      chat: defaultChat(contextId),
      importRecovery: {
        ...base,
        status: 'unsupported',
        unsupported: { code: 'W_IMPORT_SOURCE_UNSUPPORTED', message },
      },
    });
    return;
  }
  set({
    bill: freshBill(scenario, { contextId, status: 'loading', sourceType: 'local', fileName: file.name, fileSize: file.size }),
    chat: defaultChat(contextId),
    importRecovery: { ...base, status: 'reading' },
  });
  try {
    if (kind === IMPORT_SOURCE_KINDS.PDF) {
      const bytes = await readAsArrayBuffer(file);
      pdfSource = { bytes, fileName: file.name, fileSize: file.size };
      const extracted = await extractSource({ kind, bytes });
      if (extracted.ok) {
        await applySource(ctx, {
          sourceId,
          contextId,
          sourceKind: kind,
          content: extracted.text,
          table: null,
          fileName: file.name,
          fileSize: file.size,
        });
        return;
      }
      await openVisionPdf(ctx, {
        bytes,
        fileName: file.name,
        fileSize: file.size,
        contextId,
        note: PDF_GAP,
      });
      return;
    }
    if (kind === IMPORT_SOURCE_KINDS.XLSX) {
      clearPdfSource();
      const bytes = await readAsArrayBuffer(file);
      const extracted = await extractSource({ kind, bytes });
      if (!extracted.ok) {
        set({
          bill: freshBill(scenario, { contextId, status: 'none', sourceType: 'local', fileName: file.name, fileSize: file.size }),
          importRecovery: {
            ...base,
            status: 'unsupported',
            unsupported: { code: 'W_IMPORT_SOURCE_UNSUPPORTED', message: extracted.message || PDF_GAP },
          },
        });
        return;
      }
      await applySource(ctx, {
        sourceId,
        contextId,
        sourceKind: kind,
        content: extracted.text,
        table: extracted.table ?? null,
        fileName: file.name,
        fileSize: file.size,
      });
      return;
    }
    clearPdfSource();
    const text = await readAsText(file);
    await applySource(ctx, { sourceId, contextId, sourceKind: kind, content: text, table: null, fileName: file.name, fileSize: file.size });
  } catch (e) {
    set({
      bill: freshBill(scenario, {
        contextId,
        status: 'error',
        sourceType: 'local',
        fileName: file.name,
        fileSize: file.size,
        error: e && e.message ? e.message : String(e),
      }),
      importRecovery: { ...base, status: 'error', error: { code: 'E_IMPORT_READ', message: e && e.message ? e.message : String(e) } },
    });
  }
}

async function onPasteParse(ctx) {
  const { state, set } = ctx;
  clearPdfSource();
  const content = String(state.importRecovery.content ?? '');
  if (content.trim() === '') {
    set({ importRecovery: { ...state.importRecovery, error: { code: 'E_IMPORT_EMPTY_TEXT', message: '请先粘贴账单文字，再解析' } } });
    return;
  }
  const contextId = createBillContextId();
  const sourceId = ++sourceSeq;
  const session = sessionInfo(ctx);
  const base = recoveryBase({
    sourceId,
    sourceKind: IMPORT_SOURCE_KINDS.TEXT,
    fileName: '粘贴文字',
    fileSize: content.length,
    content,
    session,
    status: 'reading',
  });
  set({
    bill: freshBill(state.bill.scenario, { contextId, status: 'loading', sourceType: 'local', fileName: '粘贴文字', fileSize: content.length }),
    chat: defaultChat(contextId),
    importRecovery: base,
  });
  await applySource(ctx, {
    sourceId,
    contextId,
    sourceKind: IMPORT_SOURCE_KINDS.TEXT,
    content,
    table: null,
    fileName: '粘贴文字',
    fileSize: content.length,
  });
}

async function onAiClick(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (rec.pending || rec.budgetExhausted) return;
  const content = String(rec.content ?? '');
  if (content.trim() === '') {
    set({ importRecovery: { ...rec, error: { code: 'E_IMPORT_EMPTY_TEXT', message: '没有可识别的文字内容' } } });
    return;
  }
  const sourceId = rec.sourceId;
  let localDraft = rec.localDraft ?? null;
  if (rec.contentEdited || !localDraft) {
    const table = parseDelimitedText(content);
    localDraft = table.header?.length ? buildLocalDraft(table, rec.fileName || '粘贴文字') : localDraft;
  } else if (rec.draft?.rows?.length) {
    const keep = rec.draft.rows.filter((row) => row.source === 'local' || row.source === 'manual');
    if (keep.length) localDraft = { ...localDraft, headerOk: true, rows: keep };
  }
  const client = getRecoveryClient(ctx);
  set({
    importRecovery: {
      ...rec,
      pending: true,
      localDraft,
      error: null,
      validationErrors: [],
      notice: '正在整理交易明细；只发送提取出的文字，不发送原始文件…',
    },
  });
  let result;
  try {
    result = await client.requestRecovery({ content, sourceKind: rec.sourceKind || IMPORT_SOURCE_KINDS.TEXT });
  } catch (e) {
    const session = client.getSession();
    set({
      importRecovery: {
        ...applySession({ ...state.importRecovery, pending: false }, session),
        error: { code: 'E_IMPORT_RECOVERY_UNEXPECTED', message: 'AI 识别链路出现未预期错误' },
      },
    });
    return;
  }
  const session = client.getSession();
  if (state.importRecovery.sourceId !== sourceId) {
    set({ importRecovery: applySession({ ...state.importRecovery, pending: false }, session) });
    return;
  }
  if (!result.ok) {
    set({
      importRecovery: {
        ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session),
        error: { code: result.code, message: result.message, upstream: result.upstream ?? null },
        notice: null,
      },
    });
    return;
  }
  const draft = buildAiDraft({
    aiTrades: result.draft.trades,
    unresolved: result.draft.unresolved,
    localDraft,
    sourceFile: rec.fileName || '粘贴文字',
    requestId: session.request_ids?.[session.request_ids.length - 1] ?? null,
  });
  const duplicates = draft.rows.filter((row) => row.duplicateOf).length;
  set({
    importRecovery: {
      ...applySession({ ...state.importRecovery, pending: false, trace: result.trace ?? null }, session),
      status: 'draft',
      draft,
      unresolved: result.draft.unresolved,
      validationErrors: [],
      notice: result.draft.trades.length > 0
        ? `AI 返回 ${result.draft.trades.length} 条交易草稿${duplicates ? `，其中 ${duplicates} 条疑似重复` : ''}；尚未导入，请逐行核对。`
        : 'AI 没有整理出新的交易；请查看下方待确认说明，或手动添加。',
      error: null,
    },
  });
}

async function onValidateDraft(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  if (!rec.draft) return;
  const sourceFile = rec.fileName || '粘贴文字';
  const draft = { ...rec.draft, rows: rec.draft.rows.map((row) => refreshRowStatus(row, sourceFile)) };
  const checked = draftToNormalized(draft, sourceFile);
  if (!checked.ok) {
    set({
      importRecovery: {
        ...rec,
        draft,
        error: { code: checked.code, message: checked.message },
        validationErrors: checked.normalized?.errors ?? [],
        notice: null,
      },
    });
    return;
  }
  const method = draft.rows.some((row) => row.source === 'ai' && row.include !== false) ? 'ai' : 'manual';
  const modality = rec.vision?.kind ? 'vision' : 'text';
  const bill = await demo.loadUserBillFromTable(checked.table, sourceFile, { method, modality });
  const contextId = state.bill.contextId ?? createBillContextId();
  set({
    bill: freshBill(state.bill.scenario, {
      contextId,
      status: 'loaded',
      sourceType: 'local',
      fileName: sourceFile,
      fileSize: rec.fileSize,
      blocked: false,
      trades: bill.trades,
      warnings: bill.warnings,
      errors: bill.errors,
      dataMode: bill.dataMode,
      sourceNote: bill.sourceNote,
      resultLabelling: bill.resultLabelling,
      importMethod: method,
      importModality: modality,
    }),
    importRecovery: {
      ...rec,
      draft,
      status: 'accepted',
      error: null,
      validationErrors: [],
      notice: '草稿已通过校验，生成待确认账单；请使用下方“确认交易列表并生成报告”完成导入。',
    },
  });
}

function onReturnToDraft(ctx) {
  const { state, set } = ctx;
  const rec = state.importRecovery;
  const contextId = state.bill.contextId ?? createBillContextId();
  set({
    bill: freshBill(state.bill.scenario, {
      contextId,
      status: 'none',
      sourceType: 'local',
      fileName: rec.fileName,
      fileSize: rec.fileSize,
    }),
    importRecovery: { ...rec, status: 'draft', notice: '已返回草稿；修改后请再次校验。' },
  });
}

function confirmBill(ctx) {
  const { state, set, go } = ctx;
  return finalizeConfirmedBill({
    state,
    set,
    go,
    client: getRecoveryClient(ctx),
  });
}

function draftSourceLabel(row) {
  if (row.source === 'ai') return 'AI 整理';
  if (row.source === 'manual') return '手动添加';
  return '常规解析';
}

function draftRowNode(ctx, row) {
  const tr = el('tr', { class: `im-draft-row ${row.status}` });
  const include = el('input', { type: 'checkbox', 'aria-label': '是否导入这一行', checked: row.include !== false ? 'checked' : null });
  include.addEventListener('change', (e) => { row.include = e.target.checked === true; });
  tr.append(el('td', { class: 'im-draft-check' }, [include]));
  tr.append(el('td', {}, [draftSourceLabel(row)]));
  const fieldCell = (key, type = 'text') => {
    const input = el('input', {
      class: 'input im-cell',
      type,
      inputmode: key === 'date' ? null : 'decimal',
      value: row.fields[key] ?? '',
      'aria-label': key,
    });
    input.addEventListener('input', (e) => { row.fields[key] = e.target.value; });
    return el('td', {}, [input]);
  };
  tr.append(fieldCell('date', 'text'));
  tr.append(fieldCell('symbol'));
  const sideSelect = el('select', { class: 'input im-cell', 'aria-label': '方向' }, [
    el('option', { value: '', selected: !row.fields.side ? 'selected' : null }, ['未确认']),
    el('option', { value: '买入', selected: row.fields.side === '买入' ? 'selected' : null }, ['买入']),
    el('option', { value: '卖出', selected: row.fields.side === '卖出' ? 'selected' : null }, ['卖出']),
  ]);
  sideSelect.addEventListener('change', (e) => { row.fields.side = e.target.value; });
  tr.append(el('td', {}, [sideSelect]));
  tr.append(fieldCell('price'));
  tr.append(fieldCell('quantity'));
  tr.append(fieldCell('fee'));
  tr.append(fieldCell('tax'));
  const kind = row.status === 'valid' ? 'ok' : row.status === 'needs_review' || row.status === 'duplicate' ? 'mode' : 'warn';
  const issues = (row.issues ?? []).slice(0, 3);
  tr.append(el('td', { class: 'im-draft-status' }, [
    chip(draftRowStatusText(row), kind),
    ...issues.map((text) => el('div', { class: 'muted small' }, [text])),
    issues.length < (row.issues ?? []).length ? el('div', { class: 'muted small' }, ['…']) : null,
  ]));
  const del = el('button', { class: 'btn small', type: 'button' }, ['删除']);
  del.addEventListener('click', () => {
    ctx.set({ importRecovery: { ...ctx.state.importRecovery, draft: removeRow(ctx.state.importRecovery.draft, row.id), notice: null } });
  });
  tr.append(el('td', {}, [del]));
  return tr;
}

function draftBlock(ctx) {
  const rec = ctx.state.importRecovery;
  const draft = rec.draft;
  if (!draft) return null;
  const summary = draftSummary(draft);
  const box = el('div', { class: 'im-draft' });
  box.append(el('div', { class: 'section-title' }, ['识别草稿（尚未导入）']));
  box.append(el('div', { class: 'muted small' }, ['可以直接修改字段；只有勾选的行会进入最终校验。疑似重复项默认不导入。']));
  box.append(el('div', { class: 'row im-draft-summary' }, [
    chip(`勾选 ${summary.included} 行`, 'mode'),
    chip(`可导入 ${summary.valid} 行`, 'ok'),
    summary.needs_review ? chip(`待确认 ${summary.needs_review} 行`, 'mode') : null,
    summary.invalid ? chip(`需修正 ${summary.invalid} 行`, 'warn') : null,
    summary.duplicate ? chip(`疑似重复 ${summary.duplicate} 行`, 'warn') : null,
  ].filter(Boolean)));
  if ((rec.unresolved ?? []).length) {
    const unresolved = el('div', { class: 'banner warn-banner' }, [el('strong', {}, ['AI 标出的不确定片段'])]);
    for (const item of rec.unresolved) {
      unresolved.append(el('div', {}, [`${item.row ? `第 ${item.row} 行 · ` : ''}${item.reason}`]));
    }
    box.append(unresolved);
  }
  const table = el('table', { class: 'tbl im-draft-table' });
  const head = el('tr');
  for (const h of ['选用', '来源', '日期', '标的', '方向', '价格', '数量', '费用', '税费', '状态 / 提示', '操作']) head.append(el('th', {}, [h]));
  table.append(el('thead', {}, [head]));
  const body = el('tbody');
  for (const row of draft.rows) body.append(draftRowNode(ctx, row));
  table.append(body);
  box.append(el('div', { class: 'table-wrap' }, [table]));
  const add = el('button', { class: 'btn small', type: 'button' }, ['添加一行']);
  add.addEventListener('click', () => {
    ctx.set({ importRecovery: { ...ctx.state.importRecovery, draft: addBlankRow(draft), notice: null } });
  });
  const validate = el('button', { class: 'btn primary', type: 'button' }, ['校验并用于导入']);
  validate.addEventListener('click', () => { onValidateDraft(ctx); });
  box.append(el('div', { class: 'row im-draft-actions' }, [validate, add]));
  box.append(el('div', { class: 'muted small' }, ['“校验并用于导入”只生成待确认账单，不会直接显示导入成功；还需要使用下方既有确认按钮。']));
  return box;
}

function traceDetails(ctx) {
  const rec = ctx.state.importRecovery;
  if (!rec.trace?.messages) return null;
  const details = el('details', { class: 'im-tech' }, [
    el('summary', {}, ['开发调试（识别任务）']),
    el('div', { class: 'muted small' }, [`任务编号：${rec.flowId ?? '—'} · 请求：${rec.trace.request_ids?.join('、') || rec.requestId || '—'}`]),
    el('div', { class: 'muted small' }, [`llm_mode：${rec.trace.llm_mode ?? 'unknown'} · 模态：${rec.trace.modality ?? rec.vision?.kind ?? 'text'} · 模型请求：${rec.modelCalls}/${rec.budgetMax}`]),
    el('div', { class: 'muted small' }, [`trace：${rec.trace.messages.map((m) => m.type).join(' → ')}`]),
    (rec.vision?.images?.length ? el('div', { class: 'muted small' }, [`图片 ${rec.vision.images.length} 张 · 页数 ${rec.vision.pageCount || '—'} · 输入约 ${fmtSize(rec.vision.totalBytes)}`]) : null),
  ]);
  const exportBtn = el('button', { class: 'btn small', type: 'button' }, ['导出 trace（JSONL）']);
  exportBtn.addEventListener('click', () => {
    try {
      const exported = getRecoveryClient(ctx).exportTrace?.();
      if (!exported || !exported.ok) {
        ctx.set({ importRecovery: { ...ctx.state.importRecovery, error: { code: exported?.code ?? 'E_TRACE_EXPORT', message: exported?.errors?.[0] ?? '当前没有可导出的 trace' } } });
        return;
      }
      const blob = new Blob([exported.jsonl], { type: 'application/jsonl' });
      const url = URL.createObjectURL(blob);
      const anchor = el('a', { href: url, download: `import-trace-${rec.flowId ?? 'local'}.jsonl` });
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      ctx.set({ importRecovery: { ...ctx.state.importRecovery, error: { code: 'E_TRACE_EXPORT', message: '当前环境不支持导出 trace' } } });
    }
  });
  details.append(exportBtn);
  return details;
}

function validationErrorsBlock(rec) {
  if (!rec.validationErrors?.length) return null;
  const errors = el('div', { class: 'banner warn-banner' }, [el('strong', {}, ['最终校验未通过'])]);
  for (const error of rec.validationErrors) {
    errors.append(el('div', {}, [`${error.line ? `第 ${error.line} 行 · ` : ''}${ERROR_HELP[error.code] ?? error.message}`]));
  }
  errors.append(el('details', { class: 'im-tech' }, [
    el('summary', {}, ['技术详情（错误码）']),
    ...rec.validationErrors.map((error) => el('div', { class: 'muted small' }, [errText(error)])),
  ]));
  return errors;
}

function visionImageSrc(image) {
  return `data:${image.mime};base64,${image.data_base64}`;
}

function pageSpanText(pages) {
  const sorted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const spans = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) { i += 1; end += 1; }
    spans.push(start === end ? String(start) : `${start}-${end}`);
  }
  return spans.join('、');
}

function visionPanel(ctx) {
  const rec = ctx.state.importRecovery;
  const vision = rec.vision;
  const box = el('div', { class: 'card im-recovery im-vision' });
  box.append(el('div', { class: 'section-title' }, ['截图 / 扫描版 PDF 视觉识别']));
  box.append(el('div', { class: 'muted small im-source-line' }, [
    vision.kind === 'pdf_scan'
      ? `扫描版 PDF：共 ${vision.pageCount || '—'} 页 · 已选第 ${vision.startPage}-${vision.endPage} 页`
      : `截图：${vision.images.length} 张`,
  ]));
  if (vision.kind === 'pdf_scan' && vision.pageCount > 0) {
    const processedPages = [...new Set(vision.images.map((image) => image.pageNumber).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
    const hasDraft = rec.status === 'draft' || rec.status === 'accepted';
    const unprocessed = Array.from({ length: vision.pageCount }, (_, i) => i + 1)
      .filter((page) => !processedPages.includes(page));
    box.append(el('div', { class: 'muted small' }, [
      hasDraft && processedPages.length
        ? `已处理：第 ${pageSpanText(processedPages)} 页`
        : `尚未识别：已选第 ${vision.startPage}-${vision.endPage} 页`,
      unprocessed.length
        ? `；未处理：第 ${pageSpanText(unprocessed)} 页（不在本次草稿中）`
        : '；未处理：无',
    ]));
  }
  if (rec.localDraft?.rows?.length) {
    box.append(el('div', { class: 'muted small' }, ['已保留常规解析识别到的行；视觉结果会与这些行去重。']));
  }
  if (vision.kind === 'pdf_scan') {
    const start = el('input', { class: 'input im-page-input', type: 'number', min: '1', max: String(vision.pageCount || 1), value: String(vision.startPage), 'aria-label': '起始页', disabled: rec.pending ? 'disabled' : null });
    const end = el('input', { class: 'input im-page-input', type: 'number', min: '1', max: String(vision.pageCount || 1), value: String(vision.endPage), 'aria-label': '结束页', disabled: rec.pending ? 'disabled' : null });
    const markDirty = () => {
      vision.status = 'selecting';
      vision.notice = '页码已修改；请重新本地渲染后再识别。';
    };
    start.addEventListener('input', (event) => { vision.startPage = event.target.value; markDirty(); });
    end.addEventListener('input', (event) => { vision.endPage = event.target.value; markDirty(); });
    const renderBtn = el('button', {
      class: 'btn',
      type: 'button',
      disabled: rec.pending || vision.status === 'rendering' || vision.status === 'preparing' ? 'disabled' : null,
    }, [vision.status === 'rendering' || vision.status === 'preparing' ? '正在本机渲染…' : '本地渲染所选页面']);
    renderBtn.addEventListener('click', () => { onVisionRender(ctx); });
    box.append(el('div', { class: 'row im-vision-controls' }, [
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['起始页']), start]),
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['结束页']), end]),
      renderBtn,
    ]));
    box.append(el('div', { class: 'muted small' }, [
      `一次最多渲染 ${IMPORT_VISION_MAX_IMAGES} 页；预览和渲染都在本机完成，不触发模型。单次请求总图片约不超过 ${Math.round(IMPORT_VISION_MAX_PAYLOAD_BYTES / 1024 / 1024)}MB。`,
    ]));
  }
  if (vision.status === 'preparing') {
    box.append(el('div', { class: 'banner' }, ['正在本机准备图片/读取 PDF 页数；不会触发模型。']));
  }
  if (vision.notice) box.append(el('div', { class: 'muted small' }, [vision.notice]));
  if (vision.error) {
    box.append(el('div', { class: 'error' }, [vision.error.message]));
    if (vision.error.code) {
      box.append(el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术详情（错误码）']),
        el('div', { class: 'muted small' }, [vision.error.code]),
      ]));
    }
  }
  if (vision.images.length) {
    const grid = el('div', { class: 'im-vision-grid' });
    for (const image of vision.images) {
      grid.append(el('figure', { class: 'im-vision-item' }, [
        el('img', { src: visionImageSrc(image), alt: image.pageNumber ? `第 ${image.pageNumber} 页` : '截图', class: 'im-vision-thumb' }),
        el('figcaption', { class: 'muted small' }, [image.pageNumber ? `第 ${image.pageNumber} 页 · ${fmtSize(image.bytes)}` : fmtSize(image.bytes)]),
      ]));
    }
    box.append(grid);
    box.append(el('div', { class: 'muted small' }, [
      `已选 ${vision.images.length} 张 · 原始约 ${fmtSize(vision.totalBytes)}${vision.payloadBytes ? ` · 请求约 ${fmtSize(vision.payloadBytes)}` : ''}`,
    ]));
  }
  const canAi = vision.images.length > 0 && vision.status === 'ready' && !vision.error
    && !rec.pending && !rec.budgetExhausted && rec.status !== 'accepted';
  const aiLabel = rec.pending
    ? '识别中…'
    : rec.budgetExhausted
      ? '模型请求次数已用完'
      : vision.images.length
        ? `让 AI 识别这 ${vision.images.length} 张图`
        : '请先本地渲染';
  const ai = el('button', {
    class: 'btn primary',
    type: 'button',
    disabled: canAi ? null : 'disabled',
  }, [aiLabel]);
  ai.addEventListener('click', () => { onVisionAiClick(ctx); });
  box.append(el('div', { class: 'row im-ai-row' }, [ai, el('span', { class: 'muted small' }, [`本次导入任务：模型请求 ${rec.modelCalls}/${rec.budgetMax} 次`])]));
  box.append(el('div', { class: 'muted small' }, [
    vision.images.length
      ? `只有点击后才会发送这 ${vision.images.length} 张压缩图片；不发送文件名、其他文件或原始 PDF。`
      : '本地渲染完成后再点击识别；不会自动发送。',
  ]));
  if (rec.budgetExhausted) {
    box.append(el('div', { class: 'muted small' }, ['本次导入任务的模型请求次数已用完；仍可手动修改草稿、重新渲染或使用常规解析，不会再请求模型。']));
  }
  if (rec.draft?.rows?.some((row) => row.source === 'ai') && !rec.contentEdited) {
    box.append(el('div', { class: 'muted small' }, ['再次识别会替换 AI 整理的行；常规解析和手动添加的行会保留。']));
  }
  if (rec.notice) box.append(el('div', { class: 'banner' }, [rec.notice]));
  if (rec.error) {
    box.append(el('div', { class: 'error' }, [rec.error.message ?? '视觉识别未完成']));
    if (rec.error.upstream?.code) {
      box.append(el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术详情（错误码）']),
        el('div', { class: 'muted small' }, [rec.error.code]),
        el('div', { class: 'muted small' }, [`服务端错误码：${rec.error.upstream.code}${rec.error.upstream.status ? `（HTTP ${rec.error.upstream.status}）` : ''}`]),
      ]));
    } else if (rec.error.code) {
      box.append(el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术详情（错误码）']),
        el('div', { class: 'muted small' }, [rec.error.code]),
      ]));
    }
  }
  const validationErrors = validationErrorsBlock(rec);
  if (validationErrors) box.append(validationErrors);
  const draft = draftBlock(ctx);
  if (draft) box.append(draft);
  const trace = traceDetails(ctx);
  if (trace) box.append(trace);
  return box;
}

function recoverySection(ctx) {
  const rec = ctx.state.importRecovery;
  if (!rec || rec.status === 'idle' || rec.status === 'local_ready' || rec.status === 'accepted') return null;
  if (rec.status === 'reading') {
    return el('div', { class: 'card im-recovery' }, [
      el('div', { class: 'section-title' }, ['正在本机读取和校验']),
      el('div', { class: 'muted' }, ['常规解析完成后才会显示结果；这一步不会调用模型。']),
    ]);
  }
  if (rec.status === 'unsupported') {
    return el('div', { class: 'card im-recovery' }, [
      el('div', { class: 'section-title' }, ['没有可用的识别通道']),
      el('div', { class: 'banner warn-banner' }, [rec.unsupported?.message || '当前文件暂时无法识别']),
      el('div', { class: 'muted small' }, ['可继续粘贴文字，或上传 CSV/TSV/Excel/PDF/截图。']),
      rec.unsupported?.code ? el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术详情（能力缺口）']),
        el('div', { class: 'muted small' }, [rec.unsupported.code]),
      ]) : null,
    ]);
  }
  if (rec.status === 'error') {
    return el('div', { class: 'card im-recovery' }, [
      el('div', { class: 'section-title' }, ['读取未完成']),
      el('div', { class: 'error' }, [rec.error?.message ?? '无法读取这份内容']),
      el('div', { class: 'muted small' }, ['当前输入已保留，可以修正后重试。']),
    ]);
  }
  if (rec.vision?.kind) return visionPanel(ctx);
  const box = el('div', { class: 'card im-recovery' });
  const needsAi = rec.status === 'draft' || rec.status === 'needs_ai';
  box.append(el('div', { class: 'section-title' }, [needsAi ? '解析不完整，可让 AI 帮你识别' : '识别草稿']));
  box.append(el('div', { class: 'muted small im-source-line' }, [
    `来源：${rec.fileName || '粘贴文字'}${rec.fileSize ? `（${fmtSize(rec.fileSize)}）` : ''} · 类型：${SOURCE_LABEL[rec.sourceKind] ?? '文字'}`,
  ]));
  if (rec.localNote) box.append(el('div', { class: 'muted small' }, [rec.localNote]));
  if (rec.sourceKind === 'xlsx') box.append(el('div', { class: 'muted small' }, ['Excel 只读取第一个工作表；其他工作表请另存或粘贴。']));
  if (rec.sourceKind === 'pdf') box.append(el('div', { class: 'muted small' }, ['文本型 PDF 优先在本机提取；提取不完整可改用页面识别（本地渲染，点击识别后才发送图片）。']));
  if (rec.notice) box.append(el('div', { class: 'banner' }, [rec.notice]));
  if (rec.error) {
    box.append(el('div', { class: 'error' }, [rec.error.message ?? 'AI 识别未完成']));
    if (rec.validationErrors?.length) {
      const errors = el('div', { class: 'banner warn-banner' }, [el('strong', {}, ['最终校验未通过'])]);
      for (const error of rec.validationErrors) {
        errors.append(el('div', {}, [`${error.line ? `第 ${error.line} 行 · ` : ''}${ERROR_HELP[error.code] ?? error.message}`]));
      }
      errors.append(el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术详情（错误码）']),
        ...rec.validationErrors.map((error) => el('div', { class: 'muted small' }, [errText(error)])),
      ]));
      box.append(errors);
    } else if (rec.error.code) {
      box.append(el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术详情（错误码）']),
        el('div', { class: 'muted small' }, [rec.error.code]),
        rec.error.upstream?.code
          ? el('div', { class: 'muted small' }, [`服务端错误码：${rec.error.upstream.code}${rec.error.upstream.status ? `（HTTP ${rec.error.upstream.status}）` : ''}`])
          : null,
      ]));
    }
  }
  if (needsAi) {
    const canAi = ['csv', 'tsv', 'xlsx', 'pdf', 'text'].includes(rec.sourceKind) && String(rec.content ?? '').trim() !== '';
    const label = rec.pending
      ? '识别中…'
      : rec.budgetExhausted
        ? 'AI 识别次数已用完'
        : rec.modelCalls > 0
          ? `再次让 AI 识别（剩 ${Math.max(0, rec.budgetMax - rec.modelCalls)} 次）`
          : '让 AI 帮我识别';
    const ai = el('button', {
      class: 'btn primary',
      type: 'button',
      disabled: rec.pending || rec.budgetExhausted || !canAi ? 'disabled' : null,
    }, [label]);
    ai.addEventListener('click', () => { onAiClick(ctx); });
    box.append(el('div', { class: 'row im-ai-row' }, [ai, el('span', { class: 'muted small' }, [`本次导入任务：模型请求 ${rec.modelCalls}/${rec.budgetMax} 次`])]));
    box.append(el('div', { class: 'muted small' }, [AI_CONSENT]));
    if (rec.draft?.rows?.some((row) => row.source === 'ai')) {
      box.append(el('div', { class: 'muted small' }, [rec.contentEdited
        ? '识别文字已修改；再次识别会以当前文字重新整理，未重新解析的草稿行可能被替换。'
        : '再次识别会替换 AI 整理的行；常规解析和手动添加的行会保留。']));
    }
    if (rec.budgetExhausted) {
      box.append(el('div', { class: 'muted small' }, ['本次导入任务的模型请求次数已用完；仍可继续手动修改草稿、重新解析文字或使用常规解析，不会再请求模型。']));
    }
  }
  if (pdfSource && rec.sourceKind === 'pdf') {
    const fallback = el('button', { class: 'btn small', type: 'button' }, ['改用页面识别（本地渲染）']);
    fallback.addEventListener('click', () => {
      const keep = rec.draft?.rows?.filter((row) => row.source === 'local' || row.source === 'manual') ?? [];
      const localDraft = keep.length ? { ...(rec.localDraft ?? {}), headerOk: true, rows: keep } : (rec.localDraft ?? null);
      openVisionPdf(ctx, {
        bytes: pdfSource.bytes,
        fileName: pdfSource.fileName,
        fileSize: pdfSource.fileSize,
        contextId: ctx.state.bill.contextId ?? createBillContextId(),
        localDraft,
        note: '文本提取不完整；请选择页面在本机渲染后识别。',
      });
    });
    box.append(el('div', { class: 'row im-draft-actions' }, [
      fallback,
      el('span', { class: 'muted small' }, ['只在本机渲染；点击识别后才发送图片。']),
    ]));
  }
  const draft = draftBlock(ctx);
  if (draft) box.append(draft);
  const trace = traceDetails(ctx);
  if (trace) box.append(trace);
  return box;
}

export function renderImport(root, ctx) {
  const { state, set, go } = ctx;
  const bill = state.bill;
  const rec = state.importRecovery ?? defaultImportRecovery();
  const wrap = el('div', { class: 'stack' });

  wrap.append(prepGuide());

  const bar = el('div', { class: 'row' });
  bar.append(el('input', {
    type: 'file',
    accept: '.csv,.tsv,.xlsx,.pdf,.txt,.png,.jpg,.jpeg,.webp,text/csv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*',
    class: 'input',
    multiple: 'multiple',
    disabled: bill.status === 'loading' ? '' : null,
    onchange: (ev) => onFilePicked(ev, ctx),
  }));
  const loadBtn = el('button', {
    class: 'btn',
    disabled: bill.status === 'loading' ? '' : null,
    onclick: async () => {
      if (state.bill.status === 'loading') return;
      clearPdfSource();
      const scenario = state.bill.scenario;
      const contextId = createBillContextId();
      set({
        bill: freshBill(scenario, { contextId, status: 'loading' }),
        chat: defaultChat(contextId),
        importRecovery: defaultImportRecovery(),
      });
      try {
        const b = await demo.loadDemoBill(scenario);
        set({
          bill: freshBill(scenario, {
            contextId,
            status: 'loaded',
            trades: b.trades,
            warnings: b.warnings,
            dataMode: b.dataMode,
            marketSource: b.marketSource,
            supportScope: b.supportScope,
            sourceNote: b.sourceNote,
            resultLabelling: b.resultLabelling,
            importMethod: 'demo',
          }),
        });
      } catch (e) {
        set({ bill: freshBill(scenario, { contextId, status: 'error', error: e.message }) });
      }
    },
  }, [bill.status === 'loading' ? '加载中…' : '加载演示账单']);
  bar.append(loadBtn);
  wrap.append(bar);
  wrap.append(el('div', { class: 'muted small im-input-limits' }, [
    '选择前请确认：Excel 只读取第一个工作表；文本型 PDF 优先本机提取；截图/扫描版 PDF 支持视觉识别，一次最多 8 张/页，点击识别才发送；.xls 不支持。',
  ]));
  wrap.append(el('div', { class: 'muted small im-sample' }, [
    '演示真实后台：',
    el('a', { href: '/m0/csv-input/fixtures/demo-bill-real.csv', download: 'demo-bill-local.csv' }, ['下载示例账单 CSV']),
    '，再用“选择文件”上传确认。只有本地上传的账单会进入复核与在线对话。',
  ]));

  const paste = el('textarea', {
    class: 'input im-paste',
    rows: '4',
    placeholder: '可直接粘贴 CSV、表格文字或账单片段；解析失败时内容会保留',
    disabled: rec.pending || bill.status === 'loading' ? 'disabled' : null,
  });
  paste.value = rec.content ?? '';
  paste.addEventListener('input', (e) => {
    state.importRecovery.content = e.target.value;
    state.importRecovery.contentEdited = true;
  });
  const pasteBtn = el('button', {
    class: 'btn',
    type: 'button',
    disabled: rec.pending || bill.status === 'loading' ? 'disabled' : null,
  }, ['解析这段文字']);
  pasteBtn.addEventListener('click', () => { onPasteParse(ctx); });
  wrap.append(el('div', { class: 'card im-paste-card' }, [
    el('div', { class: 'section-title' }, ['粘贴账单文字']),
    el('div', { class: 'muted small' }, ['常规解析优先；解析失败或不完整时，再使用 AI 识别补救。']),
    paste,
    el('div', { class: 'row im-paste-actions' }, [pasteBtn]),
    rec.contentEdited ? el('div', { class: 'muted small' }, ['文字已修改；请重新解析或让 AI 重新整理当前内容。']) : null,
  ]));

  if (bill.status === 'loading') {
    wrap.append(el('div', { class: 'banner' }, [
      bill.fileName
        ? `正在本机读取：${bill.fileName}（${fmtSize(bill.fileSize)}）… 读取与校验完成后展示结果。`
        : '正在加载演示账单…',
    ]));
  } else if (bill.status === 'error') {
    wrap.append(el('div', { class: 'error' }, ['读取失败：' + bill.error]));
  } else if (bill.status === 'none' && bill.error) {
    wrap.append(el('div', { class: 'error' }, [bill.error]));
  } else if (bill.status === 'none' && rec.status === 'idle') {
    wrap.append(el('div', { class: 'muted' }, ['尚未选择账单：选择文件后在本机完成校验；也可以直接粘贴文字。常规解析失败时再选择 AI 识别补救。']));
  }

  if (bill.fileName && (bill.status === 'invalid' || bill.status === 'loaded' || bill.status === 'confirmed')) {
    wrap.append(el('div', { class: 'muted small' }, [
      `已选择：${bill.fileName}（${fmtSize(bill.fileSize)}）`,
    ]));
  }

  if (bill.status === 'invalid') {
    wrap.append(invalidBlock(bill.errors));
    if (bill.warnings.length) wrap.append(warningsBlock(bill.warnings));
    if (bill.dataMode) wrap.append(dataModeLine(bill.dataMode));
    wrap.append(el('button', { class: 'btn primary', disabled: '' }, ['确认交易列表并生成报告']));
    wrap.append(el('div', { class: 'muted small' }, ['校验未通过，确认不可用；下方草稿修好后会重新走这项校验。']));
  }

  if (bill.status === 'loaded' || bill.status === 'confirmed') {
    const t = bill.trades;
    const dynamic = !!(bill.marketSource && bill.marketSource.dynamic);
    wrap.append(el('div', { class: `im-status ${bill.status}` }, [
      bill.status === 'loaded'
        ? '待确认：请核对交易数、日期、标的和费用税费'
        : `已确认：已用于本地分析${bill.sourceType === 'local' ? '' : dynamic ? '（示例交易）' : '（演示账单）'}`,
    ]));
    wrap.append(el('div', { class: 'section-title' }, [`交易列表（${t.length} 条）`]));
    wrap.append(el('div', { class: 'muted small' }, [sourceNoteText(bill.sourceNote)]));

    const feeTax = feeTaxSummary(t);
    if (feeTax) wrap.append(feeTax);
    wrap.append(tradesTable(t));

    if (bill.warnings && bill.warnings.length) wrap.append(warningsBlock(bill.warnings));
    if (bill.dataMode) wrap.append(dataModeLine(bill.dataMode));
    const mktLine = marketLine(bill.marketSource, bill.supportScope);
    if (mktLine) wrap.append(mktLine);

    const lab = bill.resultLabelling;
    if (lab) {
      wrap.append(el('div', { class: 'muted small' }, [`结果口径：${displayLabel(lab.fees_taxes)}；${displayLabel(lab.dividend)}。`]));
      wrap.append(el('details', { class: 'im-tech' }, [
        el('summary', {}, ['技术说明（口径编号）']),
        el('div', { class: 'muted small' }, [`费用税费口径：${lab.fees_taxes}；分红口径：${lab.dividend}`]),
      ]));
    }

    if (bill.status === 'loaded') {
      const canConfirm = bill.status === 'loaded' && !bill.blocked && bill.errors.length === 0 && t.length > 0
        && !rec.pending;
      const confirm = el('button', {
        class: 'btn primary',
        disabled: canConfirm ? null : '',
      }, ['确认交易列表并生成报告']);
      if (canConfirm) confirm.addEventListener('click', () => { confirmBill(ctx); });
      wrap.append(confirm);
      wrap.append(el('div', { class: 'muted small im-confirm-note' }, [CONFIRM_NOTE]));
      if (rec.pending) {
        wrap.append(el('div', { class: 'muted small' }, ['AI 识别请求还在进行中；完成后再确认导入。']));
      } else if (!canConfirm) {
        wrap.append(el('div', { class: 'muted small' }, ['当前状态不可确认（有错误或无交易）。']));
      }
      if (rec.status === 'accepted' && rec.draft) {
        const back = el('button', { class: 'btn small', type: 'button' }, ['返回修改草稿']);
        back.addEventListener('click', () => { onReturnToDraft(ctx); });
        wrap.append(el('div', { class: 'row im-draft-actions' }, [back]));
      }
      const trace = traceDetails(ctx);
      if (trace) wrap.append(trace);
    } else if (bill.sourceType === 'local') {
      wrap.append(el('div', { class: 'ok-line' }, ['已确认 ✓（报告页展示你的账单结果；行情为 Tushare 最新已收盘日线，服务端获取、非实时）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    } else {
      wrap.append(el('div', { class: 'ok-line' }, [dynamic
        ? '已确认 ✓（示例交易 + Tushare 动态行情：确认动作仅切换应用状态）'
        : '已确认 ✓（演示账单：确认动作仅切换应用状态）']));
      wrap.append(el('button', { class: 'btn', onclick: () => go('report') }, ['前往报告 · 证据']));
    }
  }

  const recovery = recoverySection(ctx);
  if (recovery) wrap.append(recovery);

  root.append(wrap);
}
