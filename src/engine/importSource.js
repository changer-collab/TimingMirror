// 账单补救输入提取（纯本地；不上传原始文件）。
// 支持：CSV/TSV/粘贴文字、XLSX 单元格文本、文本型 PDF 文本层。
// 图片与扫描版 PDF 需要 OCR/视觉模型，当前未接通；这里只返回明确的能力缺口。
export const IMPORT_SOURCE_KINDS = Object.freeze({
  CSV: 'csv',
  TSV: 'tsv',
  XLSX: 'xlsx',
  PDF: 'pdf',
  TEXT: 'text',
  IMAGE: 'image',
  UNSUPPORTED: 'unsupported',
});

export const IMPORT_SOURCE_TEXT_MAX = 15000;

export const CANONICAL_HEADER = Object.freeze(['日期', '标的', '方向', '价格', '数量', '费用', '税费']);

const HEADER_ALIASES = Object.freeze({
  日期: ['日期', '成交日期', '交易日期', '发生日期', 'date', 'tradedate', 'tradeday', '成交时间'],
  标的: ['标的', '证券代码', '股票代码', '代码', 'symbol', 'tscode', 'stockcode'],
  方向: ['方向', '买卖', '买卖方向', '交易方向', 'side', 'buysell'],
  价格: ['价格', '成交价格', '成交均价', '均价', 'price'],
  数量: ['数量', '成交数量', '成交量', '股数', 'quantity', 'qty', 'volume'],
  费用: ['费用', '佣金', '手续费', 'fee', 'commission'],
  税费: ['税费', '印花税', 'tax', 'stampduty'],
});

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|heic)$/i;
const IMAGE_MIME = /^image\//i;
const UNSUPPORTED_EXT = /\.(docx?|xls|zip|rar|7z|exe|bin)$/i;

const normalizeHeaderName = (value) => String(value ?? '')
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .replace(/[\s_\-（）()]/g, '');

const ALIAS_LOOKUP = (() => {
  const map = new Map();
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    map.set(normalizeHeaderName(canonical), canonical);
    for (const alias of aliases) map.set(normalizeHeaderName(alias), canonical);
  }
  return map;
})();

export function canonicalHeaderName(raw) {
  return ALIAS_LOOKUP.get(normalizeHeaderName(raw)) ?? null;
}

export function normalizeSide(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (['买入', '买', 'buy', 'b'].includes(value)) return '买入';
  if (['卖出', '卖', 'sell', 's'].includes(value)) return '卖出';
  return String(raw ?? '').trim();
}

export function detectSourceKind(name = '', type = '') {
  const lower = String(name ?? '').toLowerCase();
  const mime = String(type ?? '').toLowerCase();
  if (IMAGE_EXT.test(lower) || IMAGE_MIME.test(mime)) return IMPORT_SOURCE_KINDS.IMAGE;
  if (/\.xlsx$/i.test(lower)) return IMPORT_SOURCE_KINDS.XLSX;
  if (/\.pdf$/i.test(lower) || mime === 'application/pdf') return IMPORT_SOURCE_KINDS.PDF;
  if (/\.tsv$/i.test(lower) || mime.includes('tab-separated')) return IMPORT_SOURCE_KINDS.TSV;
  if (/\.csv$/i.test(lower) || mime.includes('csv')) return IMPORT_SOURCE_KINDS.CSV;
  if (/\.txt$/i.test(lower) || mime.startsWith('text/')) return IMPORT_SOURCE_KINDS.TEXT;
  if (UNSUPPORTED_EXT.test(lower)) return IMPORT_SOURCE_KINDS.UNSUPPORTED;
  return IMPORT_SOURCE_KINDS.UNSUPPORTED;
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function detectDelimiter(lines) {
  const sample = lines.slice(0, 5).join('\n');
  const commas = (sample.match(/,/g) ?? []).length;
  const tabs = (sample.match(/\t/g) ?? []).length;
  const semis = (sample.match(/;/g) ?? []).length;
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/** 文本 → {header, rows[{line, cells}]}；支持逗号/制表符/分号与双引号转义。 */
export function parseDelimitedText(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { header: [], rows: [] };
  const delimiter = detectDelimiter(lines);
  return {
    header: splitDelimitedLine(lines[0], delimiter),
    rows: lines.slice(1).map((raw, i) => ({ line: i + 2, cells: splitDelimitedLine(raw, delimiter) })),
  };
}

export function mapTableHeader(header = []) {
  const canonical = [];
  const indexes = {};
  header.forEach((raw, index) => {
    const name = canonicalHeaderName(raw);
    if (!name || name in indexes) return;
    indexes[name] = index;
    canonical.push(name);
  });
  return { canonical, indexes };
}

export function tableToText(table) {
  const header = Array.isArray(table?.header) ? table.header : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  return [header, ...rows.map((r) => r.cells)].map((cells) => cells.map((c) => String(c ?? '')).join('\t')).join('\n');
}

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

function findZipEocd(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (readU32(view, i) === 0x06054b50) return i;
  }
  return -1;
}

function readZipEntries(bytes) {
  const eocd = findZipEocd(bytes);
  if (eocd < 0) throw new Error('不是有效的 Excel 文件（未找到 ZIP 结构）');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = readU16(view, eocd + 10);
  let offset = readU32(view, eocd + 16);
  const entries = new Map();
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    if (readU32(view, offset) !== 0x02014b50) break;
    const method = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const uncompressedSize = readU32(view, offset + 24);
    const nameLen = readU16(view, offset + 28);
    const extraLen = readU16(view, offset + 30);
    const commentLen = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateBytes(bytes, format) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压 Excel/PDF 内容');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipFile(bytes, entry) {
  if (!entry) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readU32(view, entry.localOffset) !== 0x04034b50) throw new Error('Excel ZIP 条目损坏');
  const nameLen = readU16(view, entry.localOffset + 26);
  const extraLen = readU16(view, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateBytes(data, 'deflate-raw');
  throw new Error(`Excel 使用了暂不支持的压缩方式：${entry.method}`);
}

const decodeXml = (value) => String(value ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

function xmlText(xml) {
  return [...String(xml ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
}

function columnIndex(letters) {
  let n = 0;
  for (const ch of String(letters ?? '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateNumberFormat(id, customFormats) {
  if (!Number.isFinite(id)) return false;
  if (BUILTIN_DATE_FORMATS.has(id)) return true;
  const code = customFormats.get(id);
  if (!code) return false;
  const cleaned = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[yd]/i.test(cleaned);
}

function excelSerialToIso(serial) {
  const value = Number(serial);
  if (!Number.isFinite(value) || value < 1) return String(serial);
  const days = Math.floor(value) - (value >= 60 ? 1 : 0);
  const date = new Date(Date.UTC(1899, 11, 31) + days * 86400000);
  return date.toISOString().slice(0, 10);
}

function parseXlsxStyles(xml) {
  const customFormats = new Map();
  for (const m of String(xml ?? '').matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    customFormats.set(Number(m[1]), decodeXml(m[2]));
  }
  const styleIds = [];
  const xfs = String(xml ?? '').match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] ?? '';
  for (const m of xfs.matchAll(/<xf\b[^>]*numFmtId="(\d+)"/g)) styleIds.push(Number(m[1]));
  return { customFormats, styleIds };
}

function parseXlsxSheet(xml, sharedStrings, styles) {
  const matrix = new Map();
  let maxCol = 0;
  for (const rowMatch of String(xml ?? '').matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNo = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? 0);
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const ref = attrs.match(/\br="([A-Z]+)\d+"/);
      if (!ref) continue;
      const col = columnIndex(ref[1]);
      const type = attrs.match(/\bt="([^"]*)"/)?.[1] ?? 'n';
      const styleIndex = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
      const body = cellMatch[2];
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] ?? '';
      let value = '';
      if (type === 's') value = sharedStrings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = xmlText(body);
      else if (type === 'str' || type === 'e') value = decodeXml(raw);
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (raw !== '') {
        const fmtId = styles.styleIds[styleIndex];
        value = isDateNumberFormat(fmtId, styles.customFormats) ? excelSerialToIso(raw) : decodeXml(raw);
      }
      cells[col] = value;
      if (col > maxCol) maxCol = col;
    }
    if (cells.length) matrix.set(rowNo, cells);
  }
  const rowNumbers = [...matrix.keys()].sort((a, b) => a - b);
  const rows = rowNumbers.map((n) => {
    const cells = matrix.get(n);
    return { line: n, cells: Array.from({ length: maxCol + 1 }, (_, i) => String(cells[i] ?? '')) };
  });
  return rows;
}

/** XLSX → {header, rows, text}；只读取第一个工作表，不执行公式。 */
export async function extractXlsxTable(bytes) {
  const entries = readZipEntries(bytes);
  const sheetName = [...entries.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  if (!sheetName) throw new Error('Excel 中没有可读取的工作表');
  const [sheetXml, sharedXml, stylesXml] = await Promise.all([
    readZipFile(bytes, entries.get(sheetName)).then((b) => (b ? new TextDecoder('utf-8').decode(b) : '')),
    entries.has('xl/sharedStrings.xml')
      ? readZipFile(bytes, entries.get('xl/sharedStrings.xml')).then((b) => (b ? new TextDecoder('utf-8').decode(b) : ''))
      : Promise.resolve(''),
    entries.has('xl/styles.xml')
      ? readZipFile(bytes, entries.get('xl/styles.xml')).then((b) => (b ? new TextDecoder('utf-8').decode(b) : ''))
      : Promise.resolve(''),
  ]);
  const sharedStrings = [...String(sharedXml).matchAll(/<si\b[\s\S]*?<\/si>/g)].map((m) => xmlText(m[0]));
  const styles = parseXlsxStyles(stylesXml);
  const allRows = parseXlsxSheet(sheetXml, sharedStrings, styles);
  const dataRows = allRows.filter((row) => row.cells.some((cell) => cell !== ''));
  if (dataRows.length === 0) throw new Error('Excel 工作表为空');
  const header = dataRows[0].cells;
  const rows = dataRows.slice(1);
  // 有些导出把日期存成未套日期格式的序列号；表头明确为“日期”时做确定性的序列号换算。
  const dateColumns = header.map((value, index) => (canonicalHeaderName(value) === '日期' ? index : -1)).filter((index) => index >= 0);
  for (const row of rows) {
    for (const index of dateColumns) {
      const value = String(row.cells[index] ?? '');
      if (/^\d+(\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) < 60000) {
        row.cells[index] = excelSerialToIso(value);
      }
    }
  }
  return {
    header,
    rows,
    text: tableToText({ header, rows }),
    sheetName: sheetName.split('/').pop(),
    source: 'xlsx',
  };
}

function pdfLiteralString(raw) {
  const text = raw.slice(1, -1);
  let bytes = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\\') { bytes.push(text.charCodeAt(i) & 0xff); continue; }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === 'n') { bytes.push(10); i += 1; }
    else if (next === 'r') { bytes.push(13); i += 1; }
    else if (next === 't') { bytes.push(9); i += 1; }
    else if (next === 'b') { bytes.push(8); i += 1; }
    else if (next === 'f') { bytes.push(12); i += 1; }
    else if (next === '\n' || next === '\r') i += 1;
    else if (/[0-7]/.test(next)) {
      let oct = '';
      let j = i + 1;
      while (j < text.length && oct.length < 3 && /[0-7]/.test(text[j])) { oct += text[j]; j += 1; }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
    } else { bytes.push(next.charCodeAt(0) & 0xff); i += 1; }
  }
  return bytes;
}

function pdfHexString(raw) {
  const hex = raw.slice(1, -1).replace(/\s+/g, '');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
  return bytes;
}

function decodePdfBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return new TextDecoder('latin1').decode(new Uint8Array(bytes));
}

function extractPdfContentText(content) {
  let out = '';
  const token = /(\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]+>)|(Tj|TJ|T\*|Td|TD|ET|BT|'|")/g;
  let m;
  while ((m = token.exec(content)) !== null) {
    if (m[1]) {
      const bytes = m[1].startsWith('(') ? pdfLiteralString(m[1]) : pdfHexString(m[1]);
      out += decodePdfBytes(bytes);
    } else if (m[2] === 'T*' || m[2] === 'ET' || m[2] === "'" ) {
      out += '\n';
    } else if (m[2] === 'Td' || m[2] === 'TD') {
      out += ' ';
    } else if (m[2] === 'BT') {
      out += '\n';
    }
  }
  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function decompressPdfStream(data) {
  try { return await inflateBytes(data, 'deflate'); } catch { return inflateBytes(data, 'deflate-raw'); }
}

/** 文本型 PDF → 文本层；扫描版/加密 PDF 不猜测、不 OCR。 */
export async function extractPdfText(bytes) {
  const latin = new TextDecoder('latin1').decode(bytes);
  if (/\/Encrypt\b/.test(latin)) {
    return { ok: false, hasText: false, text: '', message: 'PDF 已加密，无法在本机提取文本' };
  }
  const parts = [];
  let cursor = 0;
  while (cursor < latin.length) {
    const streamAt = latin.indexOf('stream', cursor);
    if (streamAt < 0) break;
    let dataStart = streamAt + 6;
    if (latin[dataStart] === '\r') dataStart += 1;
    if (latin[dataStart] === '\n') dataStart += 1;
    const endAt = latin.indexOf('endstream', dataStart);
    if (endAt < 0) break;
    const dictStart = latin.lastIndexOf('<<', streamAt);
    const dict = dictStart >= 0 ? latin.slice(dictStart, streamAt) : '';
    const isImage = /\/Subtype\s*\/Image\b/.test(dict) || /\/Type\s*\/XObject\b/.test(dict) || /\/DCTDecode\b/.test(dict);
    if (!isImage) {
      const data = bytes.subarray(dataStart, endAt);
      let contentBytes = data;
      if (/\/FlateDecode\b/.test(dict)) {
        try { contentBytes = await decompressPdfStream(data); } catch { contentBytes = null; }
      }
      if (contentBytes) {
        const text = extractPdfContentText(new TextDecoder('latin1').decode(contentBytes));
        if (text) parts.push(text);
      }
    }
    cursor = endAt + 9;
  }
  const text = parts.join('\n').trim();
  if (!text) {
    return {
      ok: false,
      hasText: false,
      text: '',
      message: 'PDF 没有可提取的文本层（可能是扫描版）；当前版本未接通 OCR，请粘贴文字或上传含文本的 PDF',
    };
  }
  return { ok: true, hasText: true, text, message: '' };
}

export async function extractSource({ kind, bytes = null, text = '' } = {}) {
  if (kind === IMPORT_SOURCE_KINDS.CSV || kind === IMPORT_SOURCE_KINDS.TSV || kind === IMPORT_SOURCE_KINDS.TEXT) {
    return { ok: true, kind, text: String(text ?? ''), table: null, message: '' };
  }
  if (kind === IMPORT_SOURCE_KINDS.IMAGE) {
    return {
      ok: false,
      kind,
      supported: false,
      message: '截图识别尚未接通（当前没有 OCR/视觉模型）；请粘贴文字，或上传含文本的 PDF/Excel',
    };
  }
  if (kind === IMPORT_SOURCE_KINDS.XLSX) {
    if (!bytes) return { ok: false, kind, supported: false, message: '没有读取到 Excel 文件内容' };
    try {
      const table = await extractXlsxTable(bytes);
      return { ok: true, kind, table, text: table.text, message: '' };
    } catch (error) {
      return { ok: false, kind, supported: false, message: `无法提取 Excel 文本：${error.message}` };
    }
  }
  if (kind === IMPORT_SOURCE_KINDS.PDF) {
    if (!bytes) return { ok: false, kind, supported: false, message: '没有读取到 PDF 文件内容' };
    const pdf = await extractPdfText(bytes);
    return { ...pdf, kind };
  }
  return {
    ok: false,
    kind: IMPORT_SOURCE_KINDS.UNSUPPORTED,
    supported: false,
    message: '暂不支持这种文件类型；请使用 CSV、TSV、.xlsx、文本型 PDF，或直接粘贴文字',
  };
}
