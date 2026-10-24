// 原图列名映射（纯函数）：只描述截图中可见列名到规范字段的对应关系。
// 不承载图片、Base64、CSV、账户信息或模型原文；字段与枚举固定，避免把展示数据扩展成自由文本通道。
export const IMPORT_COLUMN_TARGET_FIELDS = Object.freeze([
  'name', 'symbol', 'direction', 'date', 'settlement_date',
  'price', 'quantity', 'amount', 'settlement_amount', 'fee', 'tax',
]);
export const IMPORT_COLUMN_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const IMPORT_COLUMN_MAPPING_KEYS = Object.freeze([
  'source_label', 'source_subfield', 'target_field', 'confidence',
]);
export const IMPORT_COLUMN_MAX_ENTRIES = 50;
export const IMPORT_COLUMN_MAX_LABEL_CHARS = 40;

export const IMPORT_COLUMN_TARGET_LABELS = Object.freeze({
  name: '名称',
  symbol: '标的',
  direction: '方向',
  date: '日期',
  settlement_date: '交收日期',
  price: '价格',
  quantity: '数量',
  amount: '成交额',
  settlement_amount: '清算额',
  fee: '费用',
  tax: '税费',
});

export const DRAFT_FIELD_LABELS = Object.freeze({
  date: '日期',
  symbol: '标的',
  side: '方向',
  price: '价格',
  quantity: '数量',
  fee: '费用',
  tax: '税费',
});

const TARGET_TO_DRAFT_FIELD = Object.freeze({
  date: 'date',
  settlement_date: 'date',
  symbol: 'symbol',
  direction: 'side',
  price: 'price',
  quantity: 'quantity',
  fee: 'fee',
  tax: 'tax',
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 列名只允许短标签；拒绝换行/逗号/结构化符号、Base64、URL/路径、账户字段和模型 JSON 关键词。
const UNSAFE_LABEL_PATTERNS = Object.freeze([
  /[\u0000-\u001f\u007f]/,
  /[,\t\r\n]/,
  /[<>{}[\]"]/,
  /data:image|base64/i,
  /^[A-Za-z0-9+/=]{32,}$/,
  /(?:https?:\/\/|www\.|file:\/\/|[A-Za-z]:\\|\/\/)/i,
  /(账户|账号|资金号|股东号|证券号|银行卡|身份证|手机号|邮箱|密码|token|api[\s_-]?key|authorization|bearer|credential)/i,
  /\b(?:trades?|unresolved|column_mapping|source_label|source_subfield|target_field|confidence)\b/i,
]);

function readLabel(value, { optional = false } = {}) {
  if (value === undefined || value === null) {
    return optional ? { ok: true, value: null } : { ok: false, reason: 'required' };
  }
  if (typeof value !== 'string') return { ok: false, reason: 'type' };
  const trimmed = value.trim();
  if (trimmed === '') return optional ? { ok: true, value: null } : { ok: false, reason: 'empty' };
  if ([...trimmed].length > IMPORT_COLUMN_MAX_LABEL_CHARS) return { ok: false, reason: 'length' };
  if (UNSAFE_LABEL_PATTERNS.some((re) => re.test(trimmed))) return { ok: false, reason: 'unsafe' };
  return { ok: true, value: trimmed };
}

/** 严格校验 column_mapping；缺失由调用方处理，数组内任何一项非法都整体拒绝。 */
export function validateColumnMapping(raw) {
  if (!Array.isArray(raw)) return { ok: false, reason: 'not_array' };
  if (raw.length > IMPORT_COLUMN_MAX_ENTRIES) return { ok: false, reason: 'too_many' };
  const value = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isObject(item)) return { ok: false, reason: 'item_invalid', index: i };
    const extra = Object.keys(item).filter((key) => !IMPORT_COLUMN_MAPPING_KEYS.includes(key));
    if (extra.length) return { ok: false, reason: 'unexpected_key', index: i };
    const label = readLabel(item.source_label);
    if (!label.ok) return { ok: false, reason: 'source_label_invalid', index: i };
    const subfield = readLabel(item.source_subfield, { optional: true });
    if (!subfield.ok) return { ok: false, reason: 'source_subfield_invalid', index: i };
    if (typeof item.target_field !== 'string' || !IMPORT_COLUMN_TARGET_FIELDS.includes(item.target_field)) {
      return { ok: false, reason: 'target_invalid', index: i };
    }
    if (typeof item.confidence !== 'string' || !IMPORT_COLUMN_CONFIDENCES.includes(item.confidence)) {
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

function sourceDisplay(entry) {
  return entry.source_subfield
    ? `${entry.source_label} · ${entry.source_subfield}`
    : entry.source_label;
}

/**
 * 生成展示结构：先按原图列名分组（复合列显示子字段），再列出每个规范字段的覆盖情况。
 * 缺少映射时 hasMapping=false，调用方只显示中性说明，不影响草稿行。
 */
export function columnMappingRows(raw) {
  const checked = Array.isArray(raw) ? validateColumnMapping(raw) : { ok: true, value: [] };
  const entries = checked.ok ? checked.value : [];
  const groups = [];
  const byLabel = new Map();
  for (const entry of entries) {
    let group = byLabel.get(entry.source_label);
    if (!group) {
      group = { source_label: entry.source_label, entries: [] };
      byLabel.set(entry.source_label, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  const groupRows = groups.map((group) => {
    const subfields = [...new Set(group.entries.map((entry) => entry.source_subfield).filter(Boolean))];
    const targets = group.entries.map((entry) => ({
      target_field: entry.target_field,
      label: IMPORT_COLUMN_TARGET_LABELS[entry.target_field],
    }));
    return {
      source_label: group.source_label,
      source_subfield: subfields.length === 1 ? subfields[0] : null,
      source_display: subfields.length === 1 ? `${group.source_label} · ${subfields[0]}` : group.source_label,
      targets,
      target_display: targets.map((target) => target.label).join(' / '),
    };
  });

  const fields = Object.keys(DRAFT_FIELD_LABELS).map((key) => {
    const matches = entries.filter((entry) => TARGET_TO_DRAFT_FIELD[entry.target_field] === key);
    const first = matches[0] ?? null;
    return {
      key,
      label: DRAFT_FIELD_LABELS[key],
      matched: first !== null,
      source_display: first ? sourceDisplay(first) : '未匹配',
      target_field: first?.target_field ?? null,
      confidence: first?.confidence ?? null,
    };
  });

  return {
    hasMapping: entries.length > 0,
    hasSettlementDate: entries.some((entry) => entry.target_field === 'settlement_date'
      || /交收/.test(entry.source_subfield ?? '')),
    groups: groupRows,
    fields,
  };
}

function sourceText(entry) {
  return `${entry.source_label} ${entry.source_subfield ?? ''}`;
}

/**
 * 视觉草稿列：只根据原图映射生成列，未映射的字段不伪造列名。
 * 成交额/清算额只作为展示列，不进入 fee/tax 或最终账本字段。
 */
export function visionDraftColumns(raw) {
  const checked = Array.isArray(raw) ? validateColumnMapping(raw) : { ok: true, value: [] };
  const entries = checked.ok ? checked.value : [];
  if (entries.length === 0) return [];
  const find = (target) => entries.find((entry) => entry.target_field === target) ?? null;
  const settlementDate = find('settlement_date');
  const date = settlementDate ?? find('date');
  const symbol = find('symbol');
  const name = find('name');
  const direction = find('direction');
  const price = find('price');
  const quantity = find('quantity');
  const amount = find('amount');
  const settlementAmount = find('settlement_amount');
  const fee = find('fee');
  const tax = find('tax');
  const columns = [];

  if (date) {
    columns.push({
      key: 'date',
      field: 'date',
      label: settlementDate || /交收/.test(date.source_subfield ?? '') ? '交收日期' : '日期',
      editable: true,
      inputmode: 'numeric',
      settlement: Boolean(settlementDate) || /交收/.test(date.source_subfield ?? ''),
    });
  }
  if (symbol) {
    columns.push({
      key: 'symbol',
      field: 'symbol',
      label: name || /名称/.test(sourceText(symbol)) ? '标的/代码' : '标的',
      editable: true,
      inputmode: 'numeric',
      nameAux: Boolean(name) || /名称/.test(symbol.source_label),
    });
  } else if (name) {
    columns.push({ key: 'name', field: 'name', label: '名称', editable: false });
  }
  if (direction) {
    columns.push({ key: 'side', field: 'side', label: '方向', editable: true, select: true });
  }
  if (price) {
    columns.push({
      key: 'price',
      field: 'price',
      label: /成交价/.test(sourceText(price)) ? '成交价' : '价格',
      editable: true,
      inputmode: 'decimal',
      numeric: true,
    });
  }
  if (quantity) {
    columns.push({
      key: 'quantity', field: 'quantity', label: '数量',
      editable: true, inputmode: 'numeric', numeric: true,
    });
  }
  if (amount) {
    columns.push({ key: 'amount', field: 'amount', label: '成交额', editable: false, numeric: true });
  }
  if (settlementAmount) {
    columns.push({
      key: 'settlementAmount', field: 'settlementAmount', label: '清算额',
      editable: false, numeric: true,
    });
  }
  if (fee) {
    columns.push({
      key: 'fee', field: 'fee', label: '费用',
      editable: true, inputmode: 'decimal', numeric: true,
    });
  }
  if (tax) {
    columns.push({
      key: 'tax', field: 'tax', label: '税费',
      editable: true, inputmode: 'decimal', numeric: true,
    });
  }
  return columns;
}
