// 全部股票保留 v1 文本与哈希；限定代码另用 v2 规范化对象，避免改变已保存规则的身份。
import { parseContract, canonicalHash, HASH_ALGORITHM, CONTRACT_CODES, CONTRACT_TEMPLATES } from './contractMatch.js';

export const RULE_SCHEMA_V1 = 'contract-v1';
export const RULE_SCHEMA_V2 = 'contract-v2';

export const RULE_SPEC_CODES = Object.freeze({
  SCOPE_INVALID: 'E_RULE_SCOPE_INVALID',
  SCOPE_NOT_APPLICABLE: 'I_RULE_SCOPE_NOT_APPLICABLE',
  ACTION_NOT_APPLICABLE: 'I_RULE_ACTION_NOT_APPLICABLE',
});

const SYMBOL_RE = /^\d{6}$/;

export const RULE_CAPABILITIES = Object.freeze({
  version: 'capability-2',
  // 兼容已发布的 capability-1 调用方：默认提醒动作仍为申报买入。
  action: Object.freeze({ id: 'buy', label: '申报买入时提醒（只提醒，不阻止或执行交易）' }),
  actions: Object.freeze({
    buy: Object.freeze({ id: 'buy', label: '申报买入时提醒', note: '只提醒，不阻止或执行交易。' }),
    sell: Object.freeze({ id: 'sell', label: '申报卖出时提醒', note: '只提醒，不阻止或执行交易。' }),
  }),
  conditions: Object.freeze({
    no_buy_on_surge: Object.freeze({
      template_id: 'no_buy_on_surge',
      action: 'buy',
      data: Object.freeze(['日线收盘价（申报日与前一交易日）', '交易日历']),
      timing: '收盘后历史复盘：用申报日收盘价与前一交易日收盘价计算当日涨幅（收盘 / 前收 − 1）。盘中申报时当日收盘价尚未产生，因此这不是盘中实时提醒。',
    }),
    no_buy_back_within: Object.freeze({
      template_id: 'no_buy_back_within',
      action: 'buy',
      data: Object.freeze(['交易来源中的卖出记录（只有成交日期，没有成交时刻）', '交易日历']),
      timing: '按交易来源中卖出记录的成交日期与交易日历计算交易日距离；账单没有成交时刻，同一天先卖后买不计为“卖出后”；不读取价格。',
    }),
    sell_within_after_buy: Object.freeze({
      template_id: 'sell_within_after_buy',
      action: 'sell',
      data: Object.freeze(['交易来源中同一标的的买入记录（只有成交日期，没有成交时刻）', '交易日历']),
      timing: '收盘后历史复盘：按交易来源中同一标的的买入记录与交易日历计算交易日距离，只统计严格早于卖出日的买入，买入后的第 1 到第 N 个交易日属于窗口。账单没有成交时刻，同日买入不计为“买入后”，先后顺序未知；不读取价格。账单没有“历史买入完整”的可靠依据：只有同日买入、最近可见买入已超出窗口或找不到买入记录时，都显示“无法确认 / 数据不足”，不显示“未命中”；命中时注明基于当前导入账单中的可见买入记录。',
    }),
  }),
  scopes: Object.freeze({
    all: Object.freeze({ kind: 'all', label: '全部股票' }),
    symbol: Object.freeze({ kind: 'symbol', label: '单个股票代码（6 位数字）', note: '只校验代码格式，不校验代码是否真实存在；测试时没有该标的行情会显示“数据不足”。' }),
  }),
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function scopeLabel(scope) {
  return scope && scope.kind === 'symbol' ? `仅 ${scope.symbol}` : '全部股票';
}

export function normalizeScope(scope) {
  if (scope === undefined || scope === null) return { ok: true, scope: { kind: 'all' } };
  const bad = (message) => ({ ok: false, code: RULE_SPEC_CODES.SCOPE_INVALID, message });
  if (!isPlainObject(scope)) return bad('适用范围格式无效。');
  const extra = Object.keys(scope).filter((k) => k !== 'kind' && k !== 'symbol');
  if (extra.length) return bad(`适用范围包含未知字段：${extra.join('、')}。`);
  if (scope.kind === 'all') {
    if (scope.symbol !== undefined && scope.symbol !== null && scope.symbol !== '') return bad('“全部股票”不能同时填写股票代码。');
    return { ok: true, scope: { kind: 'all' } };
  }
  if (scope.kind === 'symbol') {
    if (typeof scope.symbol !== 'string' || !SYMBOL_RE.test(scope.symbol)) {
      return bad(`股票代码须为 6 位数字（按文本保留前导零，如 000001）：收到「${scope.symbol === undefined ? '' : String(scope.symbol)}」。`);
    }
    return { ok: true, scope: { kind: 'symbol', symbol: scope.symbol } };
  }
  return bad(`未知的适用范围类型「${String(scope.kind)}」：可选 全部股票 / 单个股票代码。`);
}

export function parseRuleSpec(spec = {}) {
  const bad = (message) => ({ supported: false, code: 'E_RULE_SPEC_INVALID', message });
  if (!isPlainObject(spec)) return bad('规则结构须为对象。');
  if (Object.keys(spec).some((k) => !['template_id', 'fields', 'scope'].includes(k))) return bad('规则含未支持的字段，不忽略附加条件或动作。');
  const { template_id, fields = {}, scope } = spec;
  if (template_id && !Object.hasOwn(RULE_CAPABILITIES.conditions, template_id)) {
    return { supported: false, code: CONTRACT_CODES.TEMPLATE_UNKNOWN, message: '该规则类型未登记，不能执行。' };
  }
  if (!isPlainObject(fields)) return bad('规则参数须为对象。');
  const template = CONTRACT_TEMPLATES[template_id];
  if (template && Object.keys(fields).some((k) => !Object.hasOwn(template.fields, k))) {
    return { supported: false, code: CONTRACT_CODES.FIELD_UNKNOWN, message: '规则含未支持的参数，不忽略附加要求。' };
  }
  const s = normalizeScope(scope);
  if (!s.ok) return { supported: false, code: s.code, field: 'scope', message: s.message };
  if (s.scope.kind === 'symbol' && template && Object.keys(template.fields).some((k) => fields[k] === undefined)) return bad('限定个股规则必须明确提供全部参数，不填默认值。');
  const base = parseContract({ template_id, fields });
  if (!base.supported) return base;
  const cap = RULE_CAPABILITIES.conditions[base.template_id];
  const common = { action: cap.action, timing: cap.timing, data_needs: [...cap.data], base_text: base.text, base_hash: base.hash };
  if (s.scope.kind === 'all') return { ...base, ...common, schema: RULE_SCHEMA_V1, scope: { kind: 'all' }, scope_text: scopeLabel(s.scope) };
  const canonical = { schema: 'contract-canonical-2', base: base.canonical, scope: { kind: 'symbol', symbol: s.scope.symbol } };
  return {
    ...base,
    ...common,
    schema: RULE_SCHEMA_V2,
    scope: { kind: 'symbol', symbol: s.scope.symbol },
    scope_text: scopeLabel(s.scope),
    text: `仅限 ${s.scope.symbol}：${base.text}`,
    canonical,
    hash: canonicalHash(canonical),
    hash_algorithm: HASH_ALGORITHM,
  };
}

export function scopeApplies(scope, symbol) {
  return !scope || scope.kind !== 'symbol' || scope.symbol === String(symbol ?? '');
}

const ACTION_LABELS = { buy: '申报买入', sell: '申报卖出' };

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? String(action ?? '—');
}

export function actionApplies(ruleAction, scenarioAction) {
  return (ruleAction ?? 'buy') === (scenarioAction ?? 'buy');
}

export function notApplicableActionMessage(ruleAction, scenarioAction) {
  return `不适用：这条规则只在${actionLabel(ruleAction)}时提醒，本次测试是${actionLabel(scenarioAction)}情境；未读取行情或交易记录，不计为命中或未命中。`;
}

export function notApplicableMessage(scope, symbol) {
  return `不适用：这条规则仅限 ${scope.symbol}，本次测试标的为 ${String(symbol ?? '—')}；未读取行情或交易记录，不计为命中或未命中。`;
}

const scopeKey = (s) => (s && s.kind === 'symbol' ? `symbol:${s.symbol}` : 'all');

// 替代当前规则时的范围变化；from 为空（该类型没有当前规则）时返回 null。范围有变化即须用户确认。
export function describeScopeChange(fromScope, toScope, templateName = '') {
  if (!fromScope) return null;
  const name = templateName ? `「${templateName}」类` : '此类';
  const from = scopeKey(fromScope);
  const to = scopeKey(toScope);
  if (from === to) return { kind: 'same', requires_ack: false, from: scopeLabel(fromScope), to: scopeLabel(toScope), message: `适用范围不变：${scopeLabel(toScope)}。` };
  const base = { requires_ack: true, from: scopeLabel(fromScope), to: scopeLabel(toScope) };
  if (from === 'all') {
    return { ...base, kind: 'narrow', message: `适用范围将从“全部股票”缩小为“仅 ${toScope.symbol}”：替代后，除 ${toScope.symbol} 外的其他股票将不再有${name}提醒。` };
  }
  if (to === 'all') {
    return { ...base, kind: 'widen', message: `适用范围将从“仅 ${fromScope.symbol}”扩大为“全部股票”：替代后，所有股票都按新规则提醒。` };
  }
  return { ...base, kind: 'switch', message: `适用范围将从“仅 ${fromScope.symbol}”改为“仅 ${toScope.symbol}”：替代后，${fromScope.symbol} 将不再有${name}提醒。` };
}
