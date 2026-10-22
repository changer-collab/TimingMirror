// 行为分析请求事实：把已复核的行为发现转成脱敏事件与买入窗口。
// 边界：只含方向、资产代号、相对交易日偏移与涨幅百分比；不含代码、日期、价格、金额、文件名。
// 买入窗口取自行为发现（evidence / evaluated_others / unevaluated），不在这里重算行情。
import { sortTrades } from './indicators.js';

export const BEHAVIOR_FACTS_PROTOCOL = 'behavior-facts-v1';
export const BEHAVIOR_FACTS_MAX_EVENTS = 500;
export const BEHAVIOR_FACTS_MAX_SPAN_DAYS = 3650;

export const BEHAVIOR_FACTS_CODES = Object.freeze({
  TRADES_EMPTY: 'W_BEHAVIOR_FACTS_TRADES_EMPTY',
  BEHAVIOR_UNAVAILABLE: 'W_BEHAVIOR_FACTS_BEHAVIOR_UNAVAILABLE',
  TOO_MANY_EVENTS: 'W_BEHAVIOR_FACTS_TOO_MANY_EVENTS',
  CALENDAR_MISSING: 'W_BEHAVIOR_FACTS_CALENDAR_MISSING',
  WINDOW_MISSING: 'W_BEHAVIOR_FACTS_WINDOW_MISSING',
  WINDOW_INVALID: 'W_BEHAVIOR_FACTS_WINDOW_INVALID',
  TRADE_INVALID: 'W_BEHAVIOR_FACTS_TRADE_INVALID',
});

const fail = (code, message) => ({ ok: false, code, message });

function lastTradingDayIndex(tradingDays, date) {
  let lo = 0;
  let hi = tradingDays.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tradingDays[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function windowMapOf(behavior) {
  const pattern = behavior?.patterns?.[0];
  if (!pattern) return null;
  const map = new Map();
  for (const item of pattern.evidence ?? []) {
    if (item?.trade_id) map.set(item.trade_id, { evaluated: true, rise: item.rise });
  }
  for (const item of pattern.evaluated_others ?? []) {
    if (item?.trade_id) map.set(item.trade_id, { evaluated: true, rise: item.rise });
  }
  for (const item of pattern.unevaluated ?? []) {
    if (item?.trade_id) map.set(item.trade_id, { evaluated: false, rise: null });
  }
  return map;
}

/** 已复核账单 → behavior-facts-v1 请求体；不可构造时返回明确原因，不发送残缺事实。 */
export function buildBehaviorFactsRequest({ trades, behavior, tradingDays } = {}) {
  const list = sortTrades(Array.isArray(trades) ? trades : []);
  if (list.length === 0) return fail(BEHAVIOR_FACTS_CODES.TRADES_EMPTY, '账单没有交易');
  if (list.length > BEHAVIOR_FACTS_MAX_EVENTS) {
    return fail(BEHAVIOR_FACTS_CODES.TOO_MANY_EVENTS, `交易笔数超过 ${BEHAVIOR_FACTS_MAX_EVENTS}`);
  }
  const windows = windowMapOf(behavior);
  if (!windows) return fail(BEHAVIOR_FACTS_CODES.BEHAVIOR_UNAVAILABLE, '行为发现结果不可用');
  if (!Array.isArray(tradingDays) || tradingDays.length === 0) {
    return fail(BEHAVIOR_FACTS_CODES.CALENDAR_MISSING, '缺少交易日历');
  }

  const baseIndex = lastTradingDayIndex(tradingDays, list[0].trade_date);
  if (baseIndex < 0) return fail(BEHAVIOR_FACTS_CODES.CALENDAR_MISSING, '账单起始日早于交易日历');

  const assetKeys = new Map();
  const events = [];
  const buyWindows = [];
  for (const trade of list) {
    if (!trade || (trade.side !== 'buy' && trade.side !== 'sell') || typeof trade.symbol !== 'string' || typeof trade.trade_date !== 'string') {
      return fail(BEHAVIOR_FACTS_CODES.TRADE_INVALID, '交易缺少方向、标的或日期');
    }
    const dayIndex = lastTradingDayIndex(tradingDays, trade.trade_date);
    if (dayIndex < 0) return fail(BEHAVIOR_FACTS_CODES.CALENDAR_MISSING, '交易日期早于交易日历');
    const dayOffset = dayIndex - baseIndex;
    if (dayOffset < 0 || dayOffset > BEHAVIOR_FACTS_MAX_SPAN_DAYS) {
      return fail(BEHAVIOR_FACTS_CODES.TRADE_INVALID, '交易日期超出相对偏移范围');
    }
    if (!assetKeys.has(trade.symbol)) assetKeys.set(trade.symbol, `A${assetKeys.size + 1}`);
    const eventIndex = events.length;
    events.push({ side: trade.side, asset_key: assetKeys.get(trade.symbol), day_offset: dayOffset });
    if (trade.side !== 'buy') continue;

    const info = windows.get(trade.trade_id);
    if (!info) return fail(BEHAVIOR_FACTS_CODES.WINDOW_MISSING, '买入缺少行为窗口');
    if (!info.evaluated) {
      buyWindows.push({ event_index: eventIndex, rise_pct: null, evaluated: false });
      continue;
    }
    if (!Number.isFinite(info.rise)) return fail(BEHAVIOR_FACTS_CODES.WINDOW_INVALID, '买入窗口涨幅无效');
    const risePct = info.rise * 100;
    if (!Number.isFinite(risePct) || risePct < -100 || risePct > 1000) {
      return fail(BEHAVIOR_FACTS_CODES.WINDOW_INVALID, '买入窗口涨幅超出协议范围');
    }
    buyWindows.push({ event_index: eventIndex, rise_pct: risePct, evaluated: true });
  }
  if (buyWindows.length === 0) return fail(BEHAVIOR_FACTS_CODES.TRADES_EMPTY, '账单没有可分析的买入');

  return {
    ok: true,
    request: {
      protocol: BEHAVIOR_FACTS_PROTOCOL,
      events,
      buy_windows: buyWindows,
    },
  };
}
