// 账单识别补救阶段 · 服务端固定约束与校验。
// 只接受已提取的文字，不接受图片/PDF/Excel 二进制，也不接受文件名或账户信息。
// 不记录内容原文；不返回上游原始错误；模型输出必须通过结构与类型校验。
// 本函数无状态：不跟踪 flow、不计数、不接收 flow_id/request_id；每 flow 两次预算由客户端约束。
export const IMPORT_RECOVER_STAGE = 'bill_extract';
export const IMPORT_RECOVER_MAX_CONTENT_CHARS = 15000;
export const IMPORT_RECOVER_MAX_TRADES = 500;
export const IMPORT_RECOVER_SOURCE_KINDS = Object.freeze(['csv', 'tsv', 'xlsx', 'pdf', 'text']);

export const IMPORT_RECOVER_CODES = Object.freeze({
  REQUEST_INVALID: 'E_IMPORT_RECOVER_REQUEST_INVALID',
  RESPONSE: 'E_IMPORT_RECOVER_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['content', 'stage', 'source_kind', 'flow_id', 'request_id']);
const RESPONSE_KEYS = new Set(['trades', 'unresolved']);
const VISION_RESPONSE_KEYS = new Set(['trades', 'unresolved', 'column_mapping']);
const DIAGNOSTIC_RESPONSE_KEYS = new Set(['trades', 'unresolved', 'column_mapping']);
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const TRADE_KEYS = new Set(['date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax', 'confidence', 'issues']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = 200) => typeof v === 'string' && v.length <= max;

export const COLUMN_MAPPING_MAX_ENTRIES = 50;
export const COLUMN_MAPPING_MAX_LABEL_CHARS = 40;
export const COLUMN_MAPPING_TARGET_FIELDS = Object.freeze([
  'name', 'symbol', 'direction', 'date', 'settlement_date',
  'price', 'quantity', 'amount', 'settlement_amount', 'fee', 'tax',
]);
export const COLUMN_MAPPING_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
const COLUMN_MAPPING_KEYS = new Set(['source_label', 'source_subfield', 'target_field', 'confidence']);
const UNSAFE_COLUMN_LABEL_RES = Object.freeze([
  /[\u0000-\u001f\u007f]/,
  /[,\t\r\n]/,
  /[<>{}[\]"]/,
  /data:image|base64/i,
  /^[A-Za-z0-9+/=]{32,}$/,
  /(?:https?:\/\/|www\.|file:\/\/|[A-Za-z]:\\|\/\/)/i,
  /(账户|账号|资金号|股东号|证券号|银行卡|身份证|手机号|邮箱|密码|token|api[\s_-]?key|authorization|bearer|credential)/i,
  /\b(?:trades?|unresolved|column_mapping|source_label|source_subfield|target_field|confidence)\b/i,
]);

function fail(code, message) {
  return { ok: false, code, errors: [message] };
}

function responseMeta(rawText, parsed) {
  const meta = { response_type: typeof rawText };
  if (typeof rawText === 'string') meta.raw_length = [...rawText].length;
  if (isObject(parsed)) {
    meta.parsed_keys = Object.keys(parsed).filter((key) => DIAGNOSTIC_RESPONSE_KEYS.has(key));
    if (Array.isArray(parsed.trades)) meta.trades_count = parsed.trades.length;
    if (Array.isArray(parsed.unresolved)) meta.unresolved_count = parsed.unresolved.length;
  }
  return meta;
}

function readColumnLabel(value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    return optional ? { ok: true, value: null } : { ok: false, reason: 'required' };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'type' };
  const trimmed = value.trim();
  if (trimmed === '') return optional ? { ok: true, value: null } : { ok: false, reason: 'empty' };
  if ([...trimmed].length > COLUMN_MAPPING_MAX_LABEL_CHARS) return { ok: false, reason: 'length' };
  if (UNSAFE_COLUMN_LABEL_RES.some((re) => re.test(trimmed))) return { ok: false, reason: 'unsafe' };
  return { ok: true, value: trimmed };
}

/** 可选映射：只允许固定字段和枚举；任何一项非法都拒绝，避免把自由文本透传到页面。 */
export function validateColumnMapping(raw) {
  if (!Array.isArray(raw)) return { ok: false, reason: 'not_array' };
  if (raw.length > COLUMN_MAPPING_MAX_ENTRIES) return { ok: false, reason: 'too_many' };
  const value = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObject(item)) return { ok: false, reason: 'item_invalid', index: i };
    if (Object.keys(item).some((key) => !COLUMN_MAPPING_KEYS.has(key))) {
      return { ok: false, reason: 'unexpected_key', index: i };
    }
    const label = readColumnLabel(item.source_label);
    if (!label.ok) return { ok: false, reason: 'source_label_invalid', index: i };
    const subfield = readColumnLabel(item.source_subfield, { optional: true });
    if (!subfield.ok) return { ok: false, reason: 'source_subfield_invalid', index: i };
    if (typeof item.target_field !== 'string' || !COLUMN_MAPPING_TARGET_FIELDS.includes(item.target_field)) {
      return { ok: false, reason: 'target_invalid', index: i };
    }
    if (typeof item.confidence !== 'string' || !COLUMN_MAPPING_CONFIDENCES.includes(item.confidence)) {
      return { ok: false, reason: 'confidence_invalid', index: i };
    }
    value.push({
      source_label: label.value,
      source_subfield: subfield.value,
      target_field: item.target_field,
      confidence: item.confidence,
    });
  }
  return { ok: true, value };
}

function failResponse(rawText, parsed, message, validationReason, field) {
  const result = fail(IMPORT_RECOVER_CODES.RESPONSE, message);
  result.diagnostics = {
    validation_reason: validationReason,
    field,
    ...responseMeta(rawText, parsed),
  };
  return result;
}

export function normalizeImportRecoverRequest(body) {
  if (!isObject(body)) return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, '请求体必须为对象');
  for (const key of Object.keys(body)) {
    if (!REQUEST_KEYS.has(key)) return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, `不允许字段：${key}`);
  }
  if (typeof body.content !== 'string' || body.content.trim() === '') {
    return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, 'content 必须为非空字符串');
  }
  if (body.content.length > IMPORT_RECOVER_MAX_CONTENT_CHARS) {
    return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, `content 超过 ${IMPORT_RECOVER_MAX_CONTENT_CHARS} 字符`);
  }
  if (body.stage !== IMPORT_RECOVER_STAGE) return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, 'stage 必须为 bill_extract');
  if (!IMPORT_RECOVER_SOURCE_KINDS.includes(body.source_kind)) {
    return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, 'source_kind 不在允许范围');
  }
  for (const key of ['flow_id', 'request_id']) {
    if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== 'string' || !TRACE_ID_RE.test(body[key]))) {
      return fail(IMPORT_RECOVER_CODES.REQUEST_INVALID, `${key} 格式非法`);
    }
  }
  return {
    ok: true,
    request: {
      content: body.content,
      stage: IMPORT_RECOVER_STAGE,
      source_kind: body.source_kind,
      flow_id: body.flow_id ?? null,
      request_id: body.request_id ?? null,
    },
  };
}

function toText(value, max = 32) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

function normalizeSide(value) {
  if (value === null || value === undefined || value === '') return null;
  const side = String(value).trim().toLowerCase();
  if (['买入', '买', 'buy', 'b'].includes(side)) return '买入';
  if (['卖出', '卖', 'sell', 's'].includes(side)) return '卖出';
  return undefined;
}

const ROW_DIGITS_RE = /^\d+$/;
const ROW_CN_LABEL_RE = /^第(\d+)行$/;
const ROW_RECORD_LABEL_RE = /^记录 ?(\d+)$/;

function digitsToRow(value) {
  if (!ROW_DIGITS_RE.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * 视觉来源行号只做窄范围归一化：数字与固定中文行号格式转为数字，其余安全降级为 null。
 * 不从任意文本中提取数字，也不改变行号基准。
 */
export function coerceUnresolvedRow(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const direct = digitsToRow(text);
  if (direct !== null) return direct;
  const cnLabel = text.match(ROW_CN_LABEL_RE);
  if (cnLabel) return digitsToRow(cnLabel[1]);
  const recordLabel = text.match(ROW_RECORD_LABEL_RE);
  if (recordLabel) return digitsToRow(recordLabel[1]);
  return null;
}

export function validateImportRecoverResponse(rawText, {
  allowColumnMapping = false,
  normalizeUnresolvedRow: normalizeRow = false,
} = {}) {
  const responseKeys = allowColumnMapping ? VISION_RESPONSE_KEYS : RESPONSE_KEYS;
  if (typeof rawText !== 'string') {
    return failResponse(rawText, null, '响应正文必须为字符串', 'response_not_string', 'response');
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return failResponse(rawText, null, '响应不是合法 JSON', 'invalid_json', 'json');
  }
  if (!isObject(parsed)) {
    return failResponse(rawText, parsed, '响应必须为对象', 'response_not_object', 'response');
  }
  for (const key of Object.keys(parsed)) {
    if (!responseKeys.has(key)) {
      return failResponse(rawText, parsed, `响应不允许字段：${key}`, 'response_unexpected_key', 'response.keys');
    }
  }
  if (parsed.trades === undefined) {
    return failResponse(rawText, parsed, 'trades 必须为数组且不超过上限', 'missing_trades', 'trades');
  }
  if (!Array.isArray(parsed.trades)) {
    return failResponse(rawText, parsed, 'trades 必须为数组且不超过上限', 'trades_not_array', 'trades');
  }
  if (parsed.trades.length > IMPORT_RECOVER_MAX_TRADES) {
    return failResponse(rawText, parsed, 'trades 必须为数组且不超过上限', 'trades_too_many', 'trades');
  }
  if (parsed.unresolved !== undefined && !Array.isArray(parsed.unresolved)) {
    return failResponse(rawText, parsed, 'unresolved 必须为数组', 'unresolved_not_array', 'unresolved');
  }
  const trades = [];
  for (let i = 0; i < parsed.trades.length; i++) {
    const raw = parsed.trades[i];
    if (!isObject(raw)) {
      return failResponse(rawText, parsed, `trades[${i}] 必须为对象`, 'trade_not_object', 'trades[]');
    }
    const extraKeys = Object.keys(raw).filter((key) => !TRADE_KEYS.has(key));
    if (extraKeys.length) {
      return failResponse(rawText, parsed, `trades[${i}] 包含不允许字段`, 'trade_unexpected_key', 'trades[].keys');
    }
    const values = {
      date: raw.date === null || raw.date === undefined ? null : (isText(raw.date, 32) ? raw.date.trim() : undefined),
      symbol: raw.symbol === null || raw.symbol === undefined ? null : (isText(raw.symbol, 16) ? raw.symbol.trim() : undefined),
      side: normalizeSide(raw.side),
      price: toText(raw.price),
      quantity: toText(raw.quantity),
      fee: toText(raw.fee),
      tax: toText(raw.tax),
    };
    const invalidField = Object.keys(values).find((key) => values[key] === undefined);
    if (invalidField) {
      return failResponse(rawText, parsed, `trades[${i}] 字段类型或长度非法`, 'trade_field_invalid', `trades[].${invalidField}`);
    }
    const { date, symbol, side, price, quantity, fee, tax } = values;
    const confidence = raw.confidence === undefined ? 0 : raw.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return failResponse(rawText, parsed, `trades[${i}].confidence 必须为 [0,1]`, 'trade_confidence_invalid', 'trades[].confidence');
    }
    const issues = raw.issues === undefined ? [] : raw.issues;
    if (!Array.isArray(issues) || issues.length > 5 || issues.some((issue) => !isText(issue, 200) || issue.trim() === '')) {
      return failResponse(rawText, parsed, `trades[${i}].issues 必须为最多 5 条短文本`, 'trade_issues_invalid', 'trades[].issues');
    }
    trades.push({
      date,
      symbol,
      side,
      price,
      quantity,
      fee,
      tax,
      confidence,
      issues: issues.map((issue) => issue.trim()),
    });
  }
  const unresolved = [];
  for (let i = 0; i < (parsed.unresolved ?? []).length; i++) {
    const raw = parsed.unresolved[i];
    if (!isObject(raw)) {
      return failResponse(rawText, parsed, `unresolved[${i}] 必须为对象`, 'unresolved_not_object', 'unresolved[]');
    }
    const extraKeys = Object.keys(raw).filter((key) => !['row', 'reason'].includes(key));
    if (extraKeys.length) {
      return failResponse(rawText, parsed, `unresolved[${i}] 包含不允许字段`, 'unresolved_unexpected_key', 'unresolved[].keys');
    }
    if (!isText(raw.reason, 300) || raw.reason.trim() === '') {
      return failResponse(rawText, parsed, `unresolved[${i}].reason 必须为非空短文本`, 'unresolved_reason_invalid', 'unresolved[].reason');
    }
    const row = normalizeRow ? coerceUnresolvedRow(raw.row) : (raw.row ?? null);
    if (!normalizeRow && row !== null && (!Number.isInteger(row) || row < 0)) {
      return failResponse(rawText, parsed, `unresolved[${i}].row 必须为非负整数或 null`, 'unresolved_row_invalid', 'unresolved[].row');
    }
    unresolved.push({ row, reason: raw.reason.trim() });
  }
  let columnMapping;
  if (allowColumnMapping && parsed.column_mapping !== undefined) {
    const checked = validateColumnMapping(parsed.column_mapping);
    if (!checked.ok) {
      return failResponse(
        rawText,
        parsed,
        `column_mapping 未通过校验：${checked.reason}`,
        `column_mapping_${checked.reason}`,
        checked.index === undefined ? 'column_mapping' : `column_mapping[${checked.index}]`,
      );
    }
    columnMapping = checked.value;
  }
  if (trades.length === 0 && unresolved.length === 0) {
    return failResponse(rawText, parsed, '响应没有可用的交易或待确认说明', 'empty_result', 'result');
  }
  const value = { trades, unresolved };
  if (columnMapping !== undefined) value.column_mapping = columnMapping;
  return { ok: true, value };
}
