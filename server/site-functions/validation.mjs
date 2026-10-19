// 站点 Function 的请求事实校验/投影（与 src/agent/onlineBoundary.js 的在线出站契约保持一致）。
// 保留 F-6 白名单、unit 显式映射、strict 内容校验；不读取 environment，不记录事实正文。
export const CONFIRMED_FACT_FIELDS = Object.freeze([
  'value', 'unit', 'display', 'formula_ref', 'source_ref',
]);
export const SUPPORTED_FACT_UNITS = Object.freeze(['%', 'pp', '元', '股', '手', '份']);

const FORMULA_UNIT_MAP = Object.freeze({
  CALC_RET_V1: '%',
  CALC_DRAG_PP_V1: 'pp',
  CALC_DRAG_MONEY_V1: '元',
});
const DESCRIPTIVE_UNIT_MAP = Object.freeze({
  '无量纲（展示 %，1 位小数）': '%',
  'pp（展示 1 位小数）': 'pp',
  '元（展示 2 位小数＋千分位）': '元',
});
const FORMULA_REF_RE = /^CALC_[A-Z0-9_]+$/;
const MAX_FORMULA_REF_LENGTH = 64;
const ANONYMOUS_SOURCE_REF_RE = /^src-[0-9a-f]{8}$/;
const MONEY_PATTERN = '[+-]?¥[+-]?\\d[\\d,]*(?:\\.\\d+)?';
const PCT_PATTERN = '[+-]?\\d+(?:\\.\\d+)?%';
const PP_PATTERN = '[+-]?\\d+(?:\\.\\d+)?pp';
const DISPLAY_EXACT_RES = Object.freeze([
  new RegExp(`^(?:${MONEY_PATTERN})$`),
  new RegExp(`^(?:${PCT_PATTERN})$`),
  new RegExp(`^(?:${PP_PATTERN})$`, 'i'),
]);
const MAX_DISPLAY_LENGTH = 64;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function fail(code, message) {
  return { ok: false, code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSupportedDisplay(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DISPLAY_LENGTH) return false;
  const canon = value
    .replace(/[％＋－−￥．，０-９]/g, (ch) => ({
      '％': '%', '＋': '+', '－': '-', '−': '-', '￥': '¥', '．': '.', '，': ',',
      ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String.fromCharCode(0xff10 + i), String(i)])),
    })[ch]);
  if (canon !== canon.trim()) return false;
  return DISPLAY_EXACT_RES.some((re) => re.test(canon));
}

function resolveUnit(fact, i) {
  const formulaRef = hasOwn(fact, 'formula_ref') ? fact.formula_ref : null;
  if (formulaRef === null) {
    return fail('E_FACT_FIELD_INVALID', `facts[${i}].formula_ref 缺失，无法确定短单位`);
  }
  const formulaUnit = Object.prototype.hasOwnProperty.call(FORMULA_UNIT_MAP, formulaRef)
    ? FORMULA_UNIT_MAP[formulaRef]
    : null;
  if (formulaUnit === null) {
    return fail('E_FACT_FIELD_INVALID', `facts[${i}].formula_ref 无法映射为短单位`);
  }
  let sourceUnit = null;
  if (hasOwn(fact, 'unit')) {
    const raw = fact.unit;
    if (raw !== null) {
      if (typeof raw === 'string' && SUPPORTED_FACT_UNITS.includes(raw)) sourceUnit = raw;
      else if (typeof raw === 'string' && Object.prototype.hasOwnProperty.call(DESCRIPTIVE_UNIT_MAP, raw)) {
        sourceUnit = DESCRIPTIVE_UNIT_MAP[raw];
      } else {
        return fail('E_FACT_FIELD_INVALID', `facts[${i}].unit 无法映射为短单位`);
      }
    }
  }
  if (sourceUnit !== null && sourceUnit !== formulaUnit) {
    return fail('E_FACT_FIELD_INVALID', `facts[${i}].unit 与 formula_ref 映射不一致`);
  }
  return { ok: true, unit: formulaUnit };
}

export function projectFacts(facts) {
  if (!Array.isArray(facts) || facts.length === 0) {
    return fail('E_FACT_FIELD_INVALID', 'facts 必须为非空数组');
  }
  const projected = [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    if (!isPlainObject(fact)) {
      return fail('E_FACT_FIELD_INVALID', '每个 fact 必须为对象');
    }
    if (!Object.keys(fact).every((key) => CONFIRMED_FACT_FIELDS.includes(key))) {
      return fail('E_FUNCTION_UNKNOWN_FIELD', '事实包含不允许的字段');
    }
    if (!hasOwn(fact, 'value') || !Number.isFinite(fact.value)) {
      return fail('E_FACT_FIELD_INVALID', `facts[${i}].value 必须为有限数值`);
    }
    if (hasOwn(fact, 'display')) {
      const value = fact.display;
      if (!(value === null || isSupportedDisplay(value))) {
        return fail('E_FACT_FIELD_INVALID', `facts[${i}].display 必须为现有数字展示格式或 null`);
      }
    }
    if (hasOwn(fact, 'formula_ref')) {
      const value = fact.formula_ref;
      if (!(value === null || (typeof value === 'string' && value.length <= MAX_FORMULA_REF_LENGTH
        && value === value.trim() && FORMULA_REF_RE.test(value)))) {
        return fail('E_FACT_FIELD_INVALID', `facts[${i}].formula_ref 必须为 CALC_ 公式 ID 或 null`);
      }
    }
    if (hasOwn(fact, 'source_ref')) {
      const value = fact.source_ref;
      if (!(value === null || (typeof value === 'string' && value === value.trim()
        && ANONYMOUS_SOURCE_REF_RE.test(value)))) {
        return fail('E_FACT_FIELD_INVALID', `facts[${i}].source_ref 必须为 null 或 src-8hex 匿名句柄`);
      }
    }
    const unit = resolveUnit(fact, i);
    if (!unit.ok) return unit;
    const normalized = {};
    for (const key of CONFIRMED_FACT_FIELDS) {
      if (hasOwn(fact, key)) normalized[key] = fact[key];
    }
    normalized.unit = unit.unit;
    projected.push(normalized);
  }
  return { ok: true, facts: projected };
}
