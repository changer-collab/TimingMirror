// 导入补救草稿（纯函数）：逐行校验、可编辑行、疑似重复标记、最终整表校验。
// 最终写入仍由 normalizeRows 决定；草稿不是正式账单。
import { normalizeQuantity, normalizeRows } from './csvNormalize.js';
import { CANONICAL_HEADER, mapTableHeader, normalizeSide } from './importSource.js';

const FIELD_KEYS = Object.freeze(['date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax']);
const REQUIRED_KEYS = Object.freeze(['date', 'symbol', 'side', 'price', 'quantity']);
const REQUIRED_HEADER = Object.freeze(['日期', '标的', '方向', '价格', '数量']);
let manualRowSequence = 0;

const ISSUE_TEXT = Object.freeze({
  E_DATE_FORMAT: '日期需写成 2024-09-25 这样的年-月-日',
  E_SYMBOL_FORMAT: '标的需为 6 位数字代码，请保留前导零',
  E_SIDE_VALUE: '方向只能是买入或卖出',
  E_PRICE_VALUE: '价格需为大于 0 的数字',
  E_PRICE_PRECISION: '价格最多 2 位有效小数（尾随零不计），系统不会自动四舍五入',
  E_QTY_INTEGER: '数量需为正整数',
  E_MONEY_VALUE: '费用、税费需为不小于 0 的数字',
  E_MONEY_PRECISION: '费用、税费最多 2 位小数',
  E_QTY_EXCEEDS: '任一时点累计卖出超过累计买入，请核对期初持仓或交易顺序',
});

const missingRequired = (fields) => REQUIRED_KEYS.some((key) => String(fields?.[key] ?? '').trim() === '');

function issueFor(error) {
  return ISSUE_TEXT[error.code] ?? error.message ?? '这一行未通过校验';
}

function rowFieldsFromCells(cells, indexes) {
  const fields = {};
  for (const key of FIELD_KEYS) {
    const header = CANONICAL_HEADER[FIELD_KEYS.indexOf(key)];
    const value = indexes[header] === undefined ? '' : String(cells[indexes[header]] ?? '').trim();
    fields[key] = key === 'side' ? normalizeSide(value) : value;
  }
  return fields;
}

function cellsForValidation(fields) {
  return [
    fields.date ?? '',
    fields.symbol ?? '',
    fields.side ?? '',
    fields.price ?? '',
    fields.quantity ?? '',
    fields.fee ?? '',
    fields.tax ?? '',
  ];
}

function validateFields(fields, sourceFile, line) {
  const single = normalizeRows(
    { header: [...CANONICAL_HEADER], rows: [{ line, cells: cellsForValidation(fields) }] },
    sourceFile,
    { skipQuantityCheck: true },
  );
  const errors = single.errors;
  const warnings = single.warnings.filter((w) => w.code === 'W_FEE_MISSING_AS_ZERO' || w.code === 'W_TAX_MISSING_AS_ZERO');
  const missing = missingRequired(fields);
  const status = errors.length === 0 && !missing
    ? 'valid'
    : errors.some((e) => e.code !== 'E_DATE_FORMAT' || String(fields.date ?? '').trim() !== '')
      && !missing
      ? 'invalid'
      : 'needs_review';
  return {
    status,
    trade: single.trades[0] ?? null,
    errors,
    warnings,
    issues: errors.map(issueFor),
  };
}

function makeRow({ fields, source, line, trade = null, status, issues = [], warnings = [], meta = {} }) {
  return {
    id: null,
    source,
    line: Number.isFinite(line) ? line : null,
    fields: { ...fields },
    include: true,
    duplicateOf: null,
    trade,
    status,
    issues: [...issues],
    warnings: [...warnings],
    ...meta,
  };
}

/** 本地表格 → 草稿行；复用 normalizeRows 的字段规则，数量校验留到最终整表。 */
export function buildLocalDraft(table, sourceFile) {
  const header = Array.isArray(table?.header) ? table.header : [];
  const rawRows = Array.isArray(table?.rows) ? table.rows : [];
  const mapped = mapTableHeader(header);
  const missing = REQUIRED_HEADER.filter((name) => !(name in mapped.indexes));
  if (missing.length) {
    return {
      origin: 'local',
      headerOk: false,
      missing,
      rows: [],
      rawRows,
      warnings: [],
      note: `未识别到标准表头：缺少${missing.join('、')}。可以粘贴带表头的文字，或让 AI 整理交易明细。`,
    };
  }
  const rows = rawRows.map((row, index) => {
    const fields = rowFieldsFromCells(row.cells, mapped.indexes);
    const checked = validateFields(fields, sourceFile, row.line ?? index + 2);
    return makeRow({
      fields,
      source: 'local',
      line: row.line ?? index + 2,
      trade: checked.trade,
      status: checked.status,
      issues: checked.issues,
      warnings: checked.warnings,
      meta: { confidence: null },
    });
  });
  return {
    origin: 'local',
    headerOk: true,
    missing: [],
    optionalPresent: { fee: '费用' in mapped.indexes, tax: '税费' in mapped.indexes },
    rows,
    rawRows,
    warnings: [],
    note: '',
  };
}

function tableForDraft(draft, includedRows) {
  const hasFeeValue = includedRows.some((row) => String(row.fields.fee ?? '').trim() !== '');
  const hasTaxValue = includedRows.some((row) => String(row.fields.tax ?? '').trim() !== '');
  const includeFee = draft?.optionalPresent?.fee !== false || hasFeeValue;
  const includeTax = draft?.optionalPresent?.tax !== false || hasTaxValue;
  const header = [...REQUIRED_HEADER];
  if (includeFee) header.push('费用');
  if (includeTax) header.push('税费');
  return {
    header,
    rows: includedRows.map((row, index) => {
      const cells = [row.fields.date ?? '', row.fields.symbol ?? '', row.fields.side ?? '', row.fields.price ?? '', row.fields.quantity ?? ''];
      if (includeFee) cells.push(row.fields.fee ?? '');
      if (includeTax) cells.push(row.fields.tax ?? '');
      return { line: Number.isFinite(row.line) ? row.line : index + 2, cells };
    }),
  };
}

export function isLocalDraftComplete(draft, sourceFile = '') {
  if (!draft || draft.headerOk !== true || !Array.isArray(draft.rows) || draft.rows.length === 0) return false;
  if (!draft.rows.every((row) => row.status === 'valid')) return false;
  const normalized = normalizeRows(localDraftTable(draft), sourceFile);
  return !normalized.blocked && normalized.trades.length > 0;
}

export function localDraftTable(draft) {
  if (!draft || !draft.headerOk) return null;
  return tableForDraft(draft, draft.rows ?? []);
}

function fingerprint(fields) {
  if (missingRequired(fields)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields.date ?? ''))) return null;
  if (!/^\d{6}$/.test(String(fields.symbol ?? ''))) return null;
  const side = normalizeSide(fields.side);
  if (side !== '买入' && side !== '卖出') return null;
  const price = Number(fields.price);
  const quantity = normalizeQuantity(fields.quantity);
  if (!Number.isFinite(price) || quantity === null) return null;
  return [fields.date, fields.symbol, side, price, quantity].join('|');
}

function aiTradeToFields(trade) {
  return {
    date: trade.date ?? '',
    symbol: trade.symbol ?? '',
    name: trade.name ?? '',
    side: normalizeSide(trade.side ?? ''),
    price: trade.price ?? '',
    quantity: trade.quantity ?? '',
    amount: trade.amount ?? '',
    settlementAmount: trade.settlement_amount ?? '',
    fee: trade.fee ?? '',
    tax: trade.tax ?? '',
  };
}

/** AI 结果 → 草稿；本地已识别行保留。视觉重复行只警示、不自动取消勾选。 */
export function buildAiDraft({
  aiTrades = [],
  unresolved = [],
  localDraft = null,
  sourceFile = '',
  requestId = null,
  duplicatePolicy = 'exclude',
  nonTradePolicy = 'draft',
  columnMapping = [],
} = {}) {
  const warnOnly = duplicatePolicy === 'warn';
  const unresolvedNonTrades = nonTradePolicy === 'unresolved';
  const localRows = Array.isArray(localDraft?.rows)
    ? localDraft.rows.filter((r) => r.source === 'local' || r.source === 'manual')
    : [];
  const rows = localRows.map((row) => ({ ...row, id: null, include: row.include !== false }));
  const known = new Map();
  localRows.forEach((row, index) => {
    const key = fingerprint(row.fields);
    const label = row.source === 'manual' ? `手动添加第 ${index + 1} 行` : `常规解析第 ${index + 1} 行`;
    if (key && row.status === 'valid' && !known.has(key)) known.set(key, label);
  });
  const extraUnresolved = [];
  const aiRows = [];
  aiTrades.forEach((trade, index) => {
    const fields = aiTradeToFields(trade);
    const line = index + 2;
    const core = [fields.date, fields.symbol, fields.side, fields.price, fields.quantity];
    if (core.every((value) => String(value ?? '').trim() === '')) {
      extraUnresolved.push({ row: line, reason: 'AI 返回了一行没有交易字段的内容；可能是余额、合计或汇总，未计入草稿' });
      return;
    }
    if (unresolvedNonTrades && !fields.side) {
      extraUnresolved.push({
        row: line,
        reason: '没有明确的买入/卖出方向；可能是证券转银行、利息等非交易记录，也可能是方向未识别；未计入交易草稿，请核对原图',
      });
      return;
    }
    const checked = validateFields(fields, sourceFile, line);
    const issues = [...checked.issues, ...(Array.isArray(trade.issues) ? trade.issues : [])];
    if (Number.isFinite(trade.confidence) && trade.confidence < 0.5) issues.push('AI 识别置信度较低，请逐项核对');
    const status = checked.status === 'valid' && issues.length > 0 ? 'needs_review' : checked.status;
    const row = makeRow({
      fields,
      source: 'ai',
      line,
      trade: checked.trade,
      status,
      issues,
      warnings: checked.warnings,
      meta: { confidence: Number.isFinite(trade.confidence) ? trade.confidence : null },
    });
    const key = fingerprint(fields);
    if (key && known.has(key)) {
      row.duplicateOf = known.get(key);
      if (warnOnly) {
        // 相同日期/代码/方向/价格/数量可能是真实多笔，也可能只是重叠片段重复；只警示，不自动取消勾选。
        row.duplicateWarn = true;
        row.issues = [`与${known.get(key)}字段相同，可能是真实多笔或重叠片段重复；请核对后决定是否保留`, ...row.issues];
        if (row.status === 'valid') row.status = 'needs_review';
      } else {
        row.include = false;
        row.issues = [`疑似与${known.get(key)}重复，默认不导入`, ...row.issues];
        if (row.status === 'valid') row.status = 'duplicate';
      }
    } else if (key && row.status !== 'invalid') {
      known.set(key, `AI 草稿第 ${index + 1} 行`);
    }
    aiRows.push(row);
  });
  rows.push(...aiRows);
  rows.forEach((row, index) => { row.id = `draft-${index + 1}`; });
  return {
    origin: 'ai',
    headerOk: true,
    missing: [],
    optionalPresent: localDraft?.optionalPresent,
    rows,
    rawRows: [],
    unresolved: [...(Array.isArray(unresolved) ? unresolved : []), ...extraUnresolved],
    columnMapping: Array.isArray(columnMapping) ? columnMapping.map((entry) => ({ ...entry })) : [],
    requestId,
    note: '',
  };
}

export function addBlankRow(draft) {
  const rows = Array.isArray(draft?.rows) ? [...draft.rows] : [];
  const row = makeRow({
    fields: {
      date: '', symbol: '', name: '', side: '', price: '', quantity: '',
      amount: '', settlementAmount: '', fee: '', tax: '',
    },
    source: 'manual',
    line: rows.length + 2,
    trade: null,
    status: 'needs_review',
    issues: ['手动新增：请补齐日期、标的、方向、价格和数量；成交额/清算额可留空'],
    meta: { confidence: null },
  });
  row.id = `draft-${rows.length + 1}-manual-${++manualRowSequence}`;
  rows.push(row);
  return { ...draft, rows };
}

export function removeRow(draft, rowId) {
  return { ...draft, rows: (draft?.rows ?? []).filter((row) => row.id !== rowId) };
}

export function refreshRowStatus(row, sourceFile) {
  const checked = validateFields(row.fields, sourceFile, row.line ?? 2);
  if (row.duplicateOf && row.duplicateWarn) {
    return {
      ...row,
      trade: checked.trade,
      status: checked.status === 'valid' ? 'needs_review' : checked.status,
      issues: [`与${row.duplicateOf}字段相同，可能是真实多笔或重叠片段重复；请核对后决定是否保留`, ...checked.issues],
      warnings: checked.warnings,
    };
  }
  if (row.duplicateOf && checked.status === 'valid') {
    return {
      ...row,
      trade: checked.trade,
      status: 'duplicate',
      issues: [`疑似与${row.duplicateOf}重复，默认不导入`, ...checked.issues],
      warnings: checked.warnings,
    };
  }
  return {
    ...row,
    trade: checked.trade,
    status: checked.status,
    issues: checked.issues,
    warnings: checked.warnings,
  };
}

export function draftIncludedRows(draft) {
  return (draft?.rows ?? []).filter((row) => row.include !== false);
}

export function draftToNormalized(draft, sourceFile) {
  const included = draftIncludedRows(draft);
  if (included.length === 0) {
    return { ok: false, code: 'E_DRAFT_EMPTY', message: '还没有勾选任何交易；请勾选至少一行后再导入', normalized: null, table: null, included };
  }
  const table = tableForDraft(draft, included);
  const normalized = normalizeRows(table, sourceFile);
  if (normalized.blocked || normalized.trades.length === 0) {
    return {
      ok: false,
      code: normalized.errors[0]?.code ?? 'E_DRAFT_INVALID',
      message: '草稿里还有需要修正的行；请根据下方提示修改，或取消勾选该行',
      normalized,
      table,
      included,
    };
  }
  return { ok: true, code: null, message: '', normalized, table, included };
}

export function draftSummary(draft) {
  const rows = Array.isArray(draft?.rows) ? draft.rows : [];
  const summary = { total: rows.length, included: 0, valid: 0, needs_review: 0, invalid: 0, duplicate: 0, missing_fee: 0 };
  for (const row of rows) {
    if (row.include !== false) summary.included += 1;
    if (row.status === 'valid') summary.valid += 1;
    else if (row.status === 'needs_review') summary.needs_review += 1;
    else if (row.status === 'invalid') summary.invalid += 1;
    else if (row.status === 'duplicate') summary.duplicate += 1;
    if (row.warnings?.some((w) => w.code === 'W_FEE_MISSING_AS_ZERO' || w.code === 'W_TAX_MISSING_AS_ZERO')) summary.missing_fee += 1;
  }
  return summary;
}

export function draftRowStatusText(row) {
  if (row.status === 'duplicate') return '疑似重复，默认不导入';
  if (row.status === 'needs_review') return row.source === 'manual' ? '手动新增 · 待确认' : '待确认';
  if (row.status === 'invalid') return '需修正';
  if (row.status === 'valid') return '可导入';
  return '待确认';
}

/** 行状态语义：红色只留给阻断修正；待确认/重复是可处理警告。 */
export function draftRowSeverity(row) {
  if (row?.status === 'invalid') return 'error';
  if (row?.status === 'duplicate' || row?.status === 'needs_review') return 'warning';
  if (row?.status === 'valid') return 'success';
  return 'info';
}

/** 未确定记录的来源行号；null/异常值不渲染成“记录 undefined”。 */
export function unresolvedRowLabel(row) {
  return Number.isInteger(row) ? `记录 ${row}` : '未标明原图行号';
}
