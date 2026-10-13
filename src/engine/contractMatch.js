// M1-C11 契约匹配纯函数（接口 §4-7；F-5/F-9；与吴涵晶分工：她负责状态机/持久化/页面，本模块为判定链路）
// 口径：F-5.3 首版只支持“明确规则模板＋可编辑字段”；自由文本明确提示不支持——不猜测、不静默套默认阈值；
//       解析结果（条件/阈值/提醒/展示文本）供保存前确认；F-9.2 命中→警告、未命中→未触发、缺失行情→明确提示不补造数值；
//       F-9.1 涨跌幅由行情缓存读取（不复权 B2；非交易日按不晚于请求日最近交易日 B3；范围外/缺价不补造 R2/B4）；
//       行情取值复用 src/engine/marketCache.js 实例语义（本模块不发起网络请求）。
// 版本与哈希：契约“版本号”由状态层（吴涵晶）管理；本模块提供内容哈希用于 R4（刷新后哈希一致且仍触发）。
//       哈希算法为**占位**（fnv1a64，算法随 M0 §4-7“契约状态”接口冻结后替换）；哈希覆盖判定语义与展示文本
//       （template_id/条件/参数/文本），字段顺序固定 → 同内容必得同哈希。
// 边界（v1 候选口径，待确认）：“卖出后 N 个交易日内不追回”以交易日距离 1..N 判定（同日先卖后买不视为“卖出后”）；
//       文本改写不进入本函数（自由文本不支持；改写＝换模板/改字段后重新解析）。

import { fmtPct } from './display.js';

export const CONTRACT_CODES = Object.freeze({
  UNSUPPORTED_TEXT: 'E_CONTRACT_UNSUPPORTED_TEXT',
  TEMPLATE_UNKNOWN: 'E_CONTRACT_TEMPLATE_UNKNOWN',
  FIELD_UNKNOWN: 'E_CONTRACT_FIELD_UNKNOWN',
  FIELD_INVALID: 'E_CONTRACT_FIELD_INVALID',
  CHANGE_PCT_MISSING: 'E_CHANGE_PCT_MISSING',
  PREV_DAY_BEYOND_CACHE: 'E_PREV_DAY_BEYOND_CACHE',
  DATE_NOT_IN_CALENDAR: 'E_DATE_NOT_IN_CALENDAR',
  SELL_DAY_NOT_IN_CALENDAR: 'E_SELL_DAY_NOT_IN_CALENDAR',
});

export const HASH_ALGORITHM = 'fnv1a64-placeholder';

export const CONTRACT_TEMPLATES = Object.freeze({
  no_buy_on_surge: Object.freeze({
    template_id: 'no_buy_on_surge',
    name: '涨幅超阈值不买入',
    kind: 'change_pct_threshold',
    fields: Object.freeze({
      threshold_pct: Object.freeze({ label: '涨幅阈值（%）', default: 5, min: 0, integer: false }),
    }),
    text_template: '当天涨幅超过 {threshold_pct}% 的票，我绝不买入。',
    comparator: '>',
    reminder: '申报买入时，若该标的当日涨幅超过你确认的阈值，将显示警告（规则、阈值与当前情境事实）。',
  }),
  no_buy_back_within: Object.freeze({
    template_id: 'no_buy_back_within',
    name: '卖出后 N 个交易日内不追回',
    kind: 'sell_buyback_window',
    fields: Object.freeze({
      days: Object.freeze({ label: '不追回窗口（交易日）', default: 3, min: 1, integer: true }),
    }),
    text_template: '卖出后 {days} 个交易日内不追回同一只票。',
    comparator: '<=',
    reminder: '申报买入时，若距最近一次卖出同一标的不足你确认的交易日窗口，将显示警告。',
  }),
});

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
  }
  return null;
}

export function parseContract({ template_id, fields = {} } = {}) {
  if (!template_id) {
    return {
      supported: false,
      code: CONTRACT_CODES.UNSUPPORTED_TEXT,
      message: '自由文本暂不支持：请选择规则模板并用可编辑字段填写参数——不猜测语义、不静默套用默认阈值（F-5.3）。',
    };
  }
  const template = CONTRACT_TEMPLATES[template_id];
  if (!template) {
    return {
      supported: false,
      code: CONTRACT_CODES.TEMPLATE_UNKNOWN,
      message: `未知规则模板「${template_id}」：可选 ${Object.keys(CONTRACT_TEMPLATES).join(' / ')}。`,
    };
  }
  for (const key of Object.keys(fields)) {
    if (!template.fields[key]) {
      return {
        supported: false,
        code: CONTRACT_CODES.FIELD_UNKNOWN,
        field: key,
        message: `模板「${template.name}」没有可编辑字段「${key}」（不猜测、不忽略，避免静默套用默认值）。`,
      };
    }
  }
  const resolved = {};
  for (const [key, spec] of Object.entries(template.fields)) {
    const raw = fields[key] === undefined ? spec.default : fields[key];
    const value = toNumber(raw);
    if (value === null) {
      return {
        supported: false,
        code: CONTRACT_CODES.FIELD_INVALID,
        field: key,
        received: String(raw),
        message: `字段「${spec.label}」须为数字（不含 % 等符号）：收到「${String(raw)}」。`,
      };
    }
    if (value < spec.min || (spec.integer && !Number.isInteger(value))) {
      return {
        supported: false,
        code: CONTRACT_CODES.FIELD_INVALID,
        field: key,
        received: String(raw),
        message: `字段「${spec.label}」取值非法：${spec.integer ? `须为 ≥ ${spec.min} 的整数` : `须 ≥ ${spec.min}`}，收到「${String(raw)}」。`,
      };
    }
    resolved[key] = value;
  }

  let condition;
  let threshold;
  if (template.kind === 'change_pct_threshold') {
    condition = { kind: template.kind, comparator: template.comparator, threshold: resolved.threshold_pct / 100 };
    threshold = { unit: 'ratio', value: condition.threshold, display: `${resolved.threshold_pct.toFixed(1)}%` };
  } else {
    condition = { kind: template.kind, comparator: template.comparator, window_days: resolved.days };
    threshold = { unit: 'trading_days', value: resolved.days, display: `${resolved.days} 个交易日` };
  }
  const text = template.text_template.replace(/\{(\w+)\}/g, (_, k) => String(resolved[k]));
  const canonical = {
    schema: 'contract-canonical-1',
    template_id: template.template_id,
    kind: template.kind,
    comparator: template.comparator,
    threshold: condition.threshold ?? null,
    window_days: condition.window_days ?? null,
    text,
  };
  return {
    supported: true,
    template_id: template.template_id,
    template_name: template.name,
    kind: template.kind,
    text,
    fields: resolved,
    condition,
    threshold,
    reminder: template.reminder,
    canonical,
    hash: fnv1a64(JSON.stringify(canonical)),
    hash_algorithm: HASH_ALGORITHM,
  };
}

export function dayChangePct(market, symbol, requestedDate) {
  const resolved = market.resolveValuation(requestedDate);
  if (resolved.blocked) {
    return { complete: false, code: resolved.code, message: `请求日 ${requestedDate} 无可解析估值日（${resolved.code}）。` };
  }
  const days = market.tradingDays;
  const k = days.indexOf(resolved.effective_date);
  if (k - 1 < 0) {
    return {
      complete: false,
      code: CONTRACT_CODES.PREV_DAY_BEYOND_CACHE,
      message: `前收日早于缓存交易日起点（${days[0]}）：不补造数值（R2）。`,
    };
  }
  const prevDate = days[k - 1];
  const close = market.getClose(symbol, resolved.effective_date);
  const prevClose = market.getClose(symbol, prevDate);
  if (close === null || prevClose === null) {
    const missing = close === null ? resolved.effective_date : prevDate;
    return {
      complete: false,
      code: CONTRACT_CODES.CHANGE_PCT_MISSING,
      message: `缺 ${symbol} 收盘价（${missing}；标的可能不在缓存支持范围 R2；缺价不补造 B4）。`,
    };
  }
  const change_pct = close / prevClose - 1;
  return {
    complete: true,
    effective_date: resolved.effective_date,
    prev_date: prevDate,
    close,
    prev_close: prevClose,
    change_pct,
    display: { change_pct: fmtPct(change_pct) },
    source_note: `行情：${symbol} ${resolved.effective_date} 收盘 ${close}（前收 ${prevDate} ${prevClose}；不复权 B2；非交易日按不晚于请求日最近交易日 B3）。`,
  };
}

function base(parsed) {
  return {
    template_id: parsed.template_id,
    contract_hash: parsed.hash,
    contract_text: parsed.text,
    threshold: parsed.threshold,
    reminder: parsed.reminder,
  };
}

export function matchContract(parsed, context) {
  if (!parsed || parsed.supported !== true) {
    throw new TypeError('matchContract：仅接受 parseContract 成功结果（自由文本不支持，F-5.3）');
  }
  if (parsed.kind === 'change_pct_threshold') {
    const { symbol, date, changePct, reason_code = null } = context ?? {};
    if (changePct === null || changePct === undefined || !Number.isFinite(changePct)) {
      return {
        ...base(parsed),
        verdict: 'missing_data',
        code: reason_code ?? CONTRACT_CODES.CHANGE_PCT_MISSING,
        fact: { symbol, date, change_pct: null },
        message: '缺失行情：明确提示，不补造数值（F-9.2）。请先经 dayChangePct 取得完整行情后再判定。',
        warning: null,
      };
    }
    const triggered = changePct > parsed.condition.threshold;
    const fact = { symbol, date, change_pct: changePct, display: { change_pct: fmtPct(changePct) } };
    return {
      ...base(parsed),
      verdict: triggered ? 'triggered' : 'not_triggered',
      code: null,
      fact,
      message: triggered
        ? `规则命中：${symbol} ${date} 当日涨幅 ${fmtPct(changePct)} 超过阈值 ${parsed.threshold.display}（达到阈值本身不触发）。`
        : `未触发：${symbol} ${date} 当日涨幅 ${fmtPct(changePct)} 未超过阈值 ${parsed.threshold.display}。`,
      warning: triggered
        ? { rule_text: parsed.text, threshold_display: parsed.threshold.display, situation: fact }
        : null,
    };
  }
  if (parsed.kind === 'sell_buyback_window') {
    const { symbol, date, trades, tradingDays } = context ?? {};
    if (!Array.isArray(trades) || !Array.isArray(tradingDays) || tradingDays.length === 0) {
      throw new TypeError('matchContract：sell_buyback_window 需提供 trades 与 tradingDays');
    }
    const k = tradingDays.indexOf(date);
    if (k < 0) {
      return {
        ...base(parsed),
        verdict: 'missing_data',
        code: CONTRACT_CODES.DATE_NOT_IN_CALENDAR,
        fact: { symbol, date },
        message: `日期 ${date} 不在缓存交易日历：无法计算交易日距离，不猜测（F-9.2）。`,
        warning: null,
      };
    }
    let lastSell = null;
    for (const t of trades) {
      if (t.side !== 'sell' || t.symbol !== symbol || t.trade_date >= date) continue;
      if (!lastSell || t.trade_date > lastSell.trade_date) lastSell = t;
    }
    if (!lastSell) {
      return {
        ...base(parsed),
        verdict: 'not_triggered',
        code: null,
        fact: { symbol, date, last_sell: null },
        message: `未触发：${symbol} 在 ${date} 之前无卖出记录（无“卖出后追回”情境；同日先卖后买不视为“卖出后”，v1 候选口径）。`,
        warning: null,
      };
    }
    const kSell = tradingDays.indexOf(lastSell.trade_date);
    if (kSell < 0) {
      return {
        ...base(parsed),
        verdict: 'missing_data',
        code: CONTRACT_CODES.SELL_DAY_NOT_IN_CALENDAR,
        fact: { symbol, date, last_sell: { trade_id: lastSell.trade_id, trade_date: lastSell.trade_date } },
        message: `最近卖出日 ${lastSell.trade_date} 不在缓存交易日历：无法计算交易日距离，不猜测（F-9.2）。`,
        warning: null,
      };
    }
    const distance = k - kSell;
    const triggered = distance <= parsed.condition.window_days;
    const fact = {
      symbol,
      date,
      last_sell: { trade_id: lastSell.trade_id, trade_date: lastSell.trade_date },
      distance_trading_days: distance,
      window_days: parsed.condition.window_days,
    };
    return {
      ...base(parsed),
      verdict: triggered ? 'triggered' : 'not_triggered',
      code: null,
      fact,
      message: triggered
        ? `规则命中：${symbol} 最近一次卖出（${lastSell.trade_date}）距 ${date} 为 ${distance} 个交易日，落在 ${parsed.threshold.display}窗口内。`
        : `未触发：距最近一次卖出（${lastSell.trade_date}）已 ${distance} 个交易日，超出 ${parsed.threshold.display}窗口。`,
      warning: triggered
        ? { rule_text: parsed.text, threshold_display: parsed.threshold.display, situation: fact }
        : null,
    };
  }
  throw new TypeError(`matchContract：未知判定类型 ${parsed.kind}`);
}
