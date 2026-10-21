#!/usr/bin/env node
/**
 * 账单导入 AI 补救回归（本地 mock；不联网、不读取真实账户数据）。
 *
 * 覆盖：粘贴文字/CSV、XLSX、文本型 PDF、截图能力缺口；
 *       常规解析零模型请求、用户点击才请求、预算不可刷新、无效响应重试、
 *       可编辑草稿、重复不入账、最终校验与拒绝入账。
 * 运行：node tests/import-recovery.test.mjs
 */
import zlib from 'node:zlib';
import {
  extractSource,
  extractXlsxTable,
  extractPdfText,
  parseDelimitedText,
  detectSourceKind,
  IMPORT_SOURCE_KINDS,
} from '../src/engine/importSource.js';
import {
  buildLocalDraft,
  isLocalDraftComplete,
  buildAiDraft,
  draftToNormalized,
  draftSummary,
  refreshRowStatus,
} from '../src/engine/importDraft.js';
import {
  createImportRecovery,
  validateRecoveryResponse,
  IMPORT_RECOVERY_CODES,
} from '../src/agent/importRecovery.js';
import { validateVisionInput } from '../src/agent/importVision.js';
import { exportImportTraceJsonl } from '../src/agent/traceAudit.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const CSV = '日期,标的,方向,价格,数量,费用,税费\n2024-09-24,600519,买入,100.00,100,5.00,0.00\n';
const AI_TRADE = {
  date: '2024-09-25', symbol: '600519', side: '卖出', price: '110.00', quantity: '100',
  fee: '5.00', tax: '1.00', confidence: 0.91, issues: [],
};
const AI_BODY = JSON.stringify({ trades: [AI_TRADE], unresolved: [] });

function aiBody(trades, unresolved = []) {
  return JSON.stringify({ trades, unresolved });
}

function makeZip(files, { deflate = true } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const source = Buffer.from(content);
    const data = deflate ? zlib.deflateRawSync(source) : source;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);
    central.push({ nameBytes, offset, compressed: data.length, original: source.length });
    offset += 30 + nameBytes.length + data.length;
  }
  const centralStart = offset;
  const centralChunks = [];
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(deflate ? 8 : 0, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(0, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.original, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    centralChunks.push(header, entry.nameBytes);
    offset += 46 + entry.nameBytes.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

function makeXlsx({ dateStyle = '1' } = {}) {
  const shared = ['日期', '标的', '方向', '价格', '数量', '费用', '税费', '600519', '买入'];
  const sharedXml = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c></row>
<row r="2"><c r="A2" s="${dateStyle}"><v>45559</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="s"><v>8</v></c><c r="D2"><v>100</v></c><c r="E2"><v>100</v></c><c r="F2"><v>5</v></c><c r="G2"><v>0</v></c></row>
</sheetData></worksheet>`;
  const stylesXml = '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
  return makeZip({
    'xl/worksheets/sheet1.xml': sheetXml,
    'xl/sharedStrings.xml': sharedXml,
    'xl/styles.xml': stylesXml,
  });
}

function makePdf({ text = 'date,symbol,side,price,quantity\n2024-09-24,600519,buy,100.00,100', compress = true } = {}) {
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text.replace(/\n/g, ') Tj T* (')}) Tj ET`, 'latin1');
  const data = compress ? zlib.deflateSync(content) : content;
  const dictionary = `/Length ${data.length}${compress ? ' /Filter /FlateDecode' : ''}`;
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< ${dictionary} >>\nstream\n`, 'latin1');
  const tail = Buffer.from('endstream\nendobj\n%%EOF', 'latin1');
  return Buffer.concat([head, data, tail]);
}

/* —— 本地输入：CSV/粘贴、XLSX、PDF、截图 —— */
{
  const table = parseDelimitedText(CSV);
  const draft = buildLocalDraft(table, 'paste.csv');
  check('粘贴/CSV：常规解析完整，无需模型', draft.headerOk === true && draft.rows.length === 1
    && draft.rows[0].status === 'valid' && isLocalDraftComplete(draft, 'paste.csv') === true, JSON.stringify(draft));
}

{
  const xlsx = makeXlsx();
  const extracted = await extractSource({ kind: IMPORT_SOURCE_KINDS.XLSX, bytes: xlsx });
  check('XLSX：本地解压并提取第一个工作表（含日期样式）', extracted.ok === true
    && extracted.table.header.join(',') === '日期,标的,方向,价格,数量,费用,税费'
    && extracted.table.rows[0].cells[0] === '2024-09-24'
    && extracted.table.rows[0].cells[1] === '600519', JSON.stringify(extracted.table ?? extracted));
  const draft = buildLocalDraft(extracted.table, 'sample.xlsx');
  check('XLSX：提取后走同一套字段校验', draft.rows[0].status === 'valid'
    && isLocalDraftComplete(draft, 'sample.xlsx') === true, JSON.stringify(draft.rows[0]));
  const rawDate = await extractXlsxTable(makeXlsx({ dateStyle: '0' }));
  check('XLSX：表头明确为日期时，未套日期格式的序列号也做确定性换算', rawDate.rows[0].cells[0] === '2024-09-24', JSON.stringify(rawDate.rows[0]?.cells));
}

{
  const pdf = makePdf();
  const extracted = await extractPdfText(pdf);
  check('PDF：文本型 PDF 提取文本层（FlateDecode）', extracted.ok === true
    && extracted.text.includes('date,symbol,side') && extracted.text.includes('600519'), JSON.stringify(extracted));
  const noText = makePdf({ text: '', compress: false });
  const empty = await extractPdfText(noText);
  check('PDF：没有文本层 → 明确缺口，不猜测 OCR', empty.ok === false && empty.hasText === false
    && empty.message.includes('没有可提取的文本层'), JSON.stringify(empty));
}

{
  const image = await extractSource({ kind: detectSourceKind('shot.png', 'image/png') });
  const visual = validateVisionInput({
    images: [{ mime: 'image/jpeg', data_base64: 'AAAA', bytes: 3 }],
    sourceKind: 'image',
  });
  check('截图：文本提取层不走 OCR，视觉入口由独立图片批次约束', detectSourceKind('shot.png') === IMPORT_SOURCE_KINDS.IMAGE
    && image.ok === false && visual.ok === true && visual.images.length === 1, JSON.stringify({ image, visual }));
  check('文件类型：xlsx/pdf/tsv/txt 分派正确', detectSourceKind('a.xlsx') === 'xlsx'
    && detectSourceKind('a.pdf') === 'pdf' && detectSourceKind('a.tsv') === 'tsv'
    && detectSourceKind('a.txt') === 'text' && detectSourceKind('a.zip') === 'unsupported');
}

/* —— 响应结构与重试/预算 —— */
{
  const valid = validateRecoveryResponse(AI_BODY);
  check('响应：合法 trades 通过并保留字符串原值', valid.ok === true && valid.trades[0].price === '110.00'
    && valid.trades[0].side === '卖出', JSON.stringify(valid));
  const extra = validateRecoveryResponse(JSON.stringify({ trades: [AI_TRADE], unresolved: [], total: 1 }));
  check('响应：额外字段拒绝', extra.ok === false && extra.code === IMPORT_RECOVERY_CODES.MODEL_RESPONSE);
  const noResult = validateRecoveryResponse(JSON.stringify({ trades: [], unresolved: [] }));
  check('响应：空结果拒绝', noResult.ok === false && noResult.code === IMPORT_RECOVERY_CODES.EMPTY_RESULT);
  const unresolvedOnly = validateRecoveryResponse(JSON.stringify({ trades: [], unresolved: [{ row: 2, reason: '日期无法确定' }] }));
  check('响应：只有待确认说明也允许进入草稿', unresolvedOnly.ok === true && unresolvedOnly.unresolved[0].reason.includes('日期'));
}

{
  const calls = [];
  const transport = {
    async importRecover(request) {
      calls.push(request);
      return { rawText: calls.length === 1 ? 'not-json' : AI_BODY };
    },
  };
  const client = createImportRecovery({ transport, timeoutMs: 1000 });
  check('flow 起点：创建客户端不建 flow、不发请求', calls.length === 0
    && client.getSession().flow_id === null && client.getSession().model_calls === 0
    && client.getTrace() === null);
  const first = await client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('重试：首次非法、第二次合法，共 2 次且不重置预算', first.ok === true
    && calls.length === 2 && first.model_calls === 2 && first.budget_max === 2
    && first.flow.requests.length === 2, JSON.stringify(first));
  const second = await client.requestRecovery({ content: '另一份内容', sourceKind: 'text' });
  check('预算：重新上传/改内容后仍不能刷新（第三次不再出站）', second.ok === false
    && second.code === IMPORT_RECOVERY_CODES.BUDGET_EXHAUSTED && calls.length === 2
    && second.flow.flow_id === first.flow.flow_id, JSON.stringify(second));
  const trace = client.getTrace();
  check('trace：四种消息、含 flow_id/request_id/预算，不含原文', trace.messages.length === 4
    && trace.messages.every((m) => m.flow_id === first.flow.flow_id)
    && trace.messages[0].request_ids.length === 2
    && !JSON.stringify(trace).includes('600519'), JSON.stringify(trace).slice(0, 300));
  const exported = client.exportTrace();
  const lines = exported.ok ? exported.jsonl.split('\n').map((line) => JSON.parse(line)) : [];
  check('JSONL：导入 trace 四行、flow_id/request_ids 贯通、llm_mode 原含义 + modality 独立、无正文', exported.ok
    && exported.line_count === 4 && lines.length === 4
    && lines.every((line) => line.flow_id === first.flow.flow_id
      && Array.isArray(line.request_ids) && line.request_ids.length === 2
      && line.llm_mode === 'unknown' && line.modality === 'text')
    && !exported.jsonl.includes('600519') && !exported.jsonl.includes('日期'), exported.jsonl?.slice(0, 300));
}

/* —— 视觉请求：同一 flow 计数、模态与 trace、超限不出站 —— */
{
  const calls = [];
  const images = [{
    mime: 'image/jpeg', data_base64: 'AAAA', bytes: 3, width: 10, height: 10, pageNumber: 2,
  }];
  const transport = {
    async importRecover(request) { calls.push({ kind: 'text', request }); return { rawText: AI_BODY }; },
    async importVision(request) { calls.push({ kind: 'vision', request }); return { rawText: AI_BODY }; },
  };
  const client = createImportRecovery({ transport, timeoutMs: 1000 });
  const text = await client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  const vision = await client.requestVision({ images, sourceKind: 'pdf_scan', pageCount: 3, pageRange: { start: 2, end: 2 } });
  check('视觉请求：与文字共用同一 flow，按实际请求计数', text.ok === true && vision.ok === true
    && vision.flow.flow_id === text.flow.flow_id && vision.model_calls === 2
    && vision.flow.requests.length === 2
    && vision.flow.requests[0].modality === 'text' && vision.flow.requests[1].modality === 'vision'
    && vision.flow.requests[1].image_count === 1
    && vision.flow.requests[1].request_id === calls[1].request.request_id
    && calls[1].request.images.length === 1 && !('width' in calls[1].request.images[0]), JSON.stringify(vision));
  const exported = client.exportTrace();
  const parsedLines = exported.ok ? exported.jsonl.split('\n').map((line) => JSON.parse(line)) : [];
  check('视觉 trace：modality=vision、图片计数、请求 ID 贯通、不含 Base64', exported.ok
    && client.getTrace().modality === 'vision'
    && client.getTrace().messages[0].image_count === 1
    && parsedLines.every((line) => line.flow_id === text.flow.flow_id && line.modality === 'vision')
    && parsedLines.some((line) => line.message_type === 'model_call' && line.calls[1].modality === 'vision')
    && !exported.jsonl.includes('AAAA'), exported.jsonl?.slice(0, 300));
  const taintedTrace = JSON.parse(JSON.stringify(client.getTrace()));
  taintedTrace.messages[0].data_base64 = 'AAAA';
  const taintedExport = exportImportTraceJsonl(taintedTrace);
  check('JSONL：含图片/正文/文件名等字段时拒绝导出', taintedExport.ok === false
    && taintedExport.code === 'E_TRACE_EXPORT_INVALID', JSON.stringify(taintedExport));
  const overLimit = await client.requestVision({
    images: Array.from({ length: 9 }, () => images[0]),
    sourceKind: 'pdf_scan',
  });
  check('视觉超限：本地拒绝且不新增请求', overLimit.ok === false
    && overLimit.model_calls === 2 && calls.length === 2, JSON.stringify(overLimit));
}

{
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const firstCalls = [];
  const firstClient = createImportRecovery({
    transport: { async importRecover(request) { firstCalls.push(request); return { rawText: AI_BODY }; } },
    timeoutMs: 1000,
    storage,
  });
  await firstClient.requestRecovery({ content: CSV, sourceKind: 'csv' });
  const secondCalls = [];
  const secondClient = createImportRecovery({
    transport: { async importRecover(request) { secondCalls.push(request); return { rawText: AI_BODY }; } },
    timeoutMs: 1000,
    storage,
  });
  check('刷新/新客户端：从会话存储恢复预算与 flow_id，不保存账单内容', secondClient.getSession().model_calls === 1
    && secondClient.getSession().flow_id === firstClient.getSession().flow_id
    && ![...store.values()].join('').includes('600519'), JSON.stringify([...store.values()]));
  await secondClient.requestRecovery({ content: CSV, sourceKind: 'csv' });
  const thirdCalls = [];
  const thirdClient = createImportRecovery({
    transport: { async importRecover(request) { thirdCalls.push(request); return { rawText: AI_BODY }; } },
    timeoutMs: 1000,
    storage,
  });
  const exhausted = await thirdClient.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('刷新/新客户端：两次用完后仍拒绝，不再出站', secondCalls.length === 1 && thirdCalls.length === 0
    && exhausted.code === IMPORT_RECOVERY_CODES.BUDGET_EXHAUSTED && thirdClient.getSession().model_calls === 2,
  JSON.stringify({ secondCalls: secondCalls.length, thirdCalls: thirdCalls.length, exhausted }));
}

{
  const calls = [];
  const transport = {
    async importRecover(request) {
      calls.push(request);
      const error = new Error('upstream failed');
      error.status = 502;
      error.upstreamCode = 'E_IMPORT_RECOVER_RESPONSE_INVALID';
      throw error;
    },
  };
  const client = createImportRecovery({ transport, timeoutMs: 1000 });
  const failed = await client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('错误返回：保留服务端错误码，且本次失败也计入 flow 预算', failed.ok === false
    && failed.status === 'unavailable'
    && failed.upstream?.code === 'E_IMPORT_RECOVER_RESPONSE_INVALID'
    && failed.upstream?.status === 502
    && failed.model_calls === 1
    && client.getTrace().messages[1].calls[0].upstream_code === 'E_IMPORT_RECOVER_RESPONSE_INVALID',
  JSON.stringify(failed));
  const retried = await client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('错误重试：同一 flow 第二次仍失败，预算耗尽', retried.ok === false
    && retried.model_calls === 2 && calls.length === 2
    && client.getSession().model_calls === 2, JSON.stringify(retried));
  const exhausted = await client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('错误重试：耗尽后不再出站', exhausted.code === IMPORT_RECOVERY_CODES.BUDGET_EXHAUSTED
    && calls.length === 2, JSON.stringify(exhausted));
}

{
  const calls = [];
  let resolveFirst;
  const transport = {
    async importRecover(request) {
      calls.push(request);
      return new Promise((resolve) => { resolveFirst = resolve; });
    },
  };
  const client = createImportRecovery({ transport, timeoutMs: 1000 });
  const first = client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  const second = await client.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('并发：第二次点击不发送请求、不改变预算', second.ok === false
    && second.status === 'busy' && calls.length === 1 && client.getSession().model_calls === 1,
  JSON.stringify({ second, calls: calls.length }));
  resolveFirst({ rawText: AI_BODY });
  const firstResult = await first;
  check('并发：首次请求完成后仍只计 1 次', firstResult.ok === true
    && calls.length === 1 && client.getSession().model_calls === 1, JSON.stringify(firstResult));
}

{
  const calls = [];
  const transport = { async importRecover(request) { calls.push(request); return { rawText: AI_BODY }; } };
  const client = createImportRecovery({ transport, timeoutMs: 1000 });
  const blocked = await client.requestRecovery({ content: '账户号 123，身份证 110101199001011234', sourceKind: 'text' });
  check('隐私预检：敏感信息不进入模型，也不创建 flow', blocked.ok === false
    && blocked.code === IMPORT_RECOVERY_CODES.LOCAL_BLOCKED && calls.length === 0
    && client.getSession().flow_id === null && client.getSession().model_calls === 0, JSON.stringify(blocked));
  const accountOnly = await client.requestRecovery({ content: '资金账号：88888888', sourceKind: 'text' });
  check('隐私预检：资金账号也不会出站', accountOnly.ok === false
    && accountOnly.code === IMPORT_RECOVERY_CODES.LOCAL_BLOCKED && calls.length === 0, JSON.stringify(accountOnly));
}

/* —— flow 结束与新任务：只有正式确认收口；新任务重新 0/2 —— */
{
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const store = new Map();
  const transport = { async importRecover() { return { rawText: AI_BODY }; } };
  const first = createImportRecovery({ transport, timeoutMs: 1000, storage });
  await first.requestRecovery({ content: CSV, sourceKind: 'csv' });
  const oldFlowId = first.getSession().flow_id;
  const completed = first.completeFlow({ reason: 'bill_confirmed', billContextId: 'bill-1' });
  check('flow 结束：正式确认后清除活动 flow，trace 含 flow_end', completed.ok === true
    && completed.completed === true && first.getSession().flow_id === null
    && first.getSession().model_calls === 0
    && completed.trace.messages.some((m) => m.type === 'flow_end'
      && m.reason === 'bill_confirmed' && m.bill_context_id === 'bill-1'), JSON.stringify(completed.trace.messages.slice(-2)));
  const completedExport = first.exportTrace();
  check('JSONL：完成 trace 五行、flow_end 与请求 ID 保留', completedExport.ok
    && completedExport.line_count === 5
    && completedExport.jsonl.split('\n').map((line) => JSON.parse(line)).at(-1).message_type === 'flow_end'
    && completedExport.jsonl.includes('bill-1'), completedExport.jsonl?.slice(-300));
  const fresh = createImportRecovery({ transport, timeoutMs: 1000, storage });
  const newResult = await fresh.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('新任务：确认结束后是新 flow，额度重新 0/2，不是同一 flow 刷新', newResult.ok === true
    && fresh.getSession().model_calls === 1
    && fresh.getSession().flow_id !== oldFlowId, JSON.stringify({ oldFlowId, newFlowId: fresh.getSession().flow_id }));
  const noFlow = createImportRecovery({ transport, timeoutMs: 1000, storage: new Map() });
  check('flow 结束：没有活动 flow 时收口为空操作', noFlow.completeFlow().completed === false);
}

/* —— 新标签页：独立存储、独立 flow，不改变原标签页的 flow —— */
{
  const storageA = {
    getItem: (key) => storeA.get(key) ?? null,
    setItem: (key, value) => storeA.set(key, String(value)),
    removeItem: (key) => storeA.delete(key),
  };
  const storeA = new Map();
  const storageB = {
    getItem: (key) => storeB.get(key) ?? null,
    setItem: (key, value) => storeB.set(key, String(value)),
    removeItem: (key) => storeB.delete(key),
  };
  const storeB = new Map();
  const callsA = [];
  const callsB = [];
  const tabA = createImportRecovery({
    transport: { async importRecover(request) { callsA.push(request); return { rawText: AI_BODY }; } },
    timeoutMs: 1000,
    storage: storageA,
  });
  await tabA.requestRecovery({ content: CSV, sourceKind: 'csv' });
  const tabB = createImportRecovery({
    transport: { async importRecover(request) { callsB.push(request); return { rawText: AI_BODY }; } },
    timeoutMs: 1000,
    storage: storageB,
  });
  check('新标签页：独立 flow 从 0/2 开始，不影响原标签页计数', tabB.getSession().model_calls === 0
    && tabA.getSession().model_calls === 1);
  await tabB.requestRecovery({ content: CSV, sourceKind: 'csv' });
  check('新标签页：两个 flow 各自计数、互不占用', tabA.getSession().model_calls === 1
    && tabB.getSession().model_calls === 1
    && tabA.getSession().flow_id !== tabB.getSession().flow_id
    && callsA.length === 1 && callsB.length === 1,
  JSON.stringify({ a: tabA.getSession(), b: tabB.getSession() }));
}

{
  const totalsOnly = buildAiDraft({
    aiTrades: [{
      date: null, symbol: null, side: null, price: null, quantity: null,
      fee: null, tax: null, confidence: 0.9, issues: [],
    }],
    unresolved: [],
    localDraft: null,
    sourceFile: 'ai.csv',
  });
  check('余额/合计：没有交易字段的行不进入草稿，只列为待确认说明', totalsOnly.rows.length === 0
    && totalsOnly.unresolved.some((item) => item.reason.includes('余额') || item.reason.includes('合计')),
  JSON.stringify(totalsOnly));
}

/* —— 草稿：可编辑、无效不入账、重复不计入 —— */
{
  const localTable = parseDelimitedText(CSV);
  const localDraft = buildLocalDraft(localTable, 'mix.csv');
  const duplicateAiTrade = { ...AI_TRADE, date: '2024-09-24', side: '买入', price: '100.00', quantity: '100', fee: '5.00', tax: '0.00' };
  const aiDraft = buildAiDraft({
    aiTrades: [duplicateAiTrade, AI_TRADE],
    unresolved: [],
    localDraft,
    sourceFile: 'mix.csv',
  });
  const summary = draftSummary(aiDraft);
  check('重复：AI 返回本地已识别行 → 标记疑似重复且默认不导入', summary.duplicate === 1
    && aiDraft.rows.find((r) => r.source === 'ai' && r.fields.date === '2024-09-24').include === false,
  JSON.stringify(aiDraft.rows.map((r) => ({ s: r.source, d: r.fields.date, i: r.include, st: r.status }))));
  const normalized = draftToNormalized(aiDraft, 'mix.csv');
  check('重复：默认导出不含重复行，本地行 + 新 AI 行各一条', normalized.ok === true
    && normalized.normalized.trades.length === 2
    && normalized.normalized.trades[0].trade_date === '2024-09-24'
    && normalized.normalized.trades[1].trade_date === '2024-09-25', JSON.stringify(normalized.normalized));
  const duplicateRow = aiDraft.rows.find((r) => r.source === 'ai' && r.fields.date === '2024-09-24');
  duplicateRow.include = true;
  aiDraft.rows.find((r) => r.source === 'local').include = false;
  const selectedAi = draftToNormalized(aiDraft, 'mix.csv');
  check('重复：用户手动勾选后可选择保留 AI 行，但不会与本地行同时计入', selectedAi.ok === true
    && selectedAi.normalized.trades.length === 2
    && selectedAi.normalized.trades.filter((t) => t.trade_date === '2024-09-24').length === 1,
  JSON.stringify(selectedAi.normalized.trades));
}

{
  const localDraft = buildLocalDraft(parseDelimitedText(CSV), 'mix.csv');
  const manualRow = {
    ...localDraft.rows[0],
    id: 'manual-1',
    source: 'manual',
    fields: { date: '2024-09-26', symbol: '000001', side: '买入', price: '10.00', quantity: '200', fee: '1.00', tax: '0.00' },
    status: 'valid',
    include: true,
    issues: [],
  };
  const base = { ...localDraft, rows: [...localDraft.rows, manualRow] };
  const aiDraft = buildAiDraft({ aiTrades: [AI_TRADE], unresolved: [], localDraft: base, sourceFile: 'mix.csv' });
  check('再次识别：保留常规解析与手动添加的行，只替换 AI 行', aiDraft.rows.some((r) => r.source === 'local')
    && aiDraft.rows.some((r) => r.source === 'manual' && r.fields.symbol === '000001')
    && aiDraft.rows.some((r) => r.source === 'ai'), JSON.stringify(aiDraft.rows.map((r) => r.source)));
}

{
  const incomplete = buildAiDraft({
    aiTrades: [{ ...AI_TRADE, date: null, side: '买入' }],
    unresolved: [{ row: 2, reason: '日期无法确定' }],
    localDraft: null,
    sourceFile: 'ai.csv',
  });
  check('待确认：缺日期不猜默认值，草稿标待确认', incomplete.rows.length === 1
    && incomplete.rows[0].status === 'needs_review' && incomplete.rows[0].fields.date === ''
    && incomplete.unresolved.length === 1, JSON.stringify(incomplete.rows[0]));
  const rejected = draftToNormalized(incomplete, 'ai.csv');
  check('无效草稿：不能直接入账', rejected.ok === false && rejected.normalized.blocked === true, JSON.stringify(rejected));
  const fixed = { ...incomplete.rows[0], fields: { ...incomplete.rows[0].fields, date: '2024-09-25' } };
  const fixedDraft = { ...incomplete, rows: [refreshRowStatus(fixed, 'ai.csv')] };
  const accepted = draftToNormalized(fixedDraft, 'ai.csv');
  check('可编辑：补齐字段后校验通过', accepted.ok === true && accepted.normalized.trades.length === 1, JSON.stringify(accepted));
}

{
  const incomplete = buildAiDraft({
    aiTrades: [{ ...AI_TRADE, side: null }],
    unresolved: [],
    localDraft: null,
    sourceFile: 'ai.csv',
  });
  const checked = incomplete.rows[0];
  check('模糊方向：不猜测买卖方向', checked.status === 'needs_review' && checked.fields.side === ''
    && checked.issues.some((text) => text.includes('方向')), JSON.stringify(checked));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
