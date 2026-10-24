// 操作类型归因（候选口径 v2）：按行为证据与仓位事实把逐笔差额归到 7 类。
// 边界：金额一律取自逐笔分解，不重算；行为不可用时不做分类；同类只归一次（按优先级）；
//       涨跌只读日线收盘价，不看成本，不做盈亏判断；清仓/部分减仓只陈述仓位事实。
import { fmtMoney } from './display.js';

export const OP_TYPE_CONFIG = Object.freeze({
  version: 'operation-attribution-2',
  momentum_window_days: 5,
  momentum_threshold: 0.05,
  source: '候选口径：卖出前一交易日收盘与 5 个交易日前收盘比较（不复权）；阈值 5% 由负责人 2026-10-25 确认',
});

const BUCKET_DEFS = Object.freeze([
  { id: 'rebuy', label: '回补式卖出', hint: '卖出后 2 个交易日内又买回同一只标的', priority: 1 },
  { id: 'quick_flip', label: '快进快出卖出', hint: '买入后 3 个交易日内卖出同一只标的', priority: 2 },
  { id: 'down', label: '下跌中卖出', hint: '卖出前 5 个交易日该股累计跌幅达到阈值', priority: 3 },
  { id: 'up', label: '上涨中卖出', hint: '卖出前 5 个交易日该股累计涨幅达到阈值', priority: 4 },
  { id: 'clear', label: '清仓卖出', hint: '本次卖出后该标的持仓归零', priority: 5 },
  { id: 'trim', label: '部分减仓', hint: '未命中以上；卖出后仍有持仓', priority: 6 },
  { id: 'other', label: '其他卖出', hint: '缺少可核对的持仓记录：证据不足，不强行归类', priority: 7 },
]);

const moneyEqual = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function idsOfPattern(patterns, patternId, pick) {
  const ids = new Set();
  for (const pattern of patterns) {
    if (pattern?.pattern_id !== patternId) continue;
    for (const row of Array.isArray(pattern.evidence) ? pattern.evidence : []) {
      const id = pick(row);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function compareTrades(a, b) {
  const da = String(a?.trade_date ?? '');
  const db = String(b?.trade_date ?? '');
  if (da !== db) return da < db ? -1 : 1;
  const la = Number.isFinite(a?.source?.line) ? a.source.line : Number.MAX_SAFE_INTEGER;
  const lb = Number.isFinite(b?.source?.line) ? b.source.line : Number.MAX_SAFE_INTEGER;
  if (la !== lb) return la - lb;
  const ta = String(a?.trade_id ?? '');
  const tb = String(b?.trade_id ?? '');
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

// 按成交顺序累积持仓；卖出前没有可核对买入（数量不足）的标的，之后一律视为持仓证据缺失。
function buildHoldings(trades) {
  const out = new Map();
  if (!Array.isArray(trades) || trades.length === 0) return out;
  const sorted = [...trades].sort(compareTrades);
  const held = new Map();
  const unknown = new Set();
  for (const trade of sorted) {
    if (!trade?.symbol || (trade.side !== 'buy' && trade.side !== 'sell')) continue;
    const quantity = Number(trade.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const before = held.get(trade.symbol) ?? 0;
    if (trade.side === 'buy') {
      held.set(trade.symbol, before + quantity);
      continue;
    }
    const known = !unknown.has(trade.symbol) && quantity <= before;
    if (!known) unknown.add(trade.symbol);
    const after = Math.max(0, before - quantity);
    if (trade.trade_id) out.set(trade.trade_id, { before, after, known });
    held.set(trade.symbol, unknown.has(trade.symbol) ? 0 : after);
  }
  return out;
}

function buildMomentum(market, trade) {
  if (!market || !Array.isArray(market.tradingDays)
    || typeof market.resolveValuation !== 'function' || typeof market.getClose !== 'function') return null;
  const resolved = market.resolveValuation(trade.trade_date);
  if (!resolved || resolved.blocked === true) return null;
  const days = market.tradingDays;
  const index = days.indexOf(resolved.effective_date);
  if (index < 0) return null;
  const prevIndex = index - 1;
  const startIndex = prevIndex - OP_TYPE_CONFIG.momentum_window_days;
  if (startIndex < 0) return null;
  const prevDate = days[prevIndex];
  const startDate = days[startIndex];
  const prevClose = market.getClose(trade.symbol, prevDate);
  const startClose = market.getClose(trade.symbol, startDate);
  if (!Number.isFinite(prevClose) || !Number.isFinite(startClose) || startClose === 0) return null;
  const change = prevClose / startClose - 1;
  const direction = change >= OP_TYPE_CONFIG.momentum_threshold
    ? 'up'
    : change <= -OP_TYPE_CONFIG.momentum_threshold ? 'down' : null;
  return { change, direction, start_date: startDate, prev_date: prevDate, start_close: startClose, prev_close: prevClose };
}

function pctText(change) {
  return `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
}

function classify({ tradeId, rebuyIds, flipIds, momentum, holding }) {
  if (rebuyIds.has(tradeId)) {
    return { bucket_id: 'rebuy', evidence: { kind: 'rebuy', detail: '卖出后 2 个交易日内买回' } };
  }
  if (flipIds.has(tradeId)) {
    return { bucket_id: 'quick_flip', evidence: { kind: 'quick_flip', detail: '买入后 3 个交易日内卖出' } };
  }
  if (momentum?.direction) {
    return {
      bucket_id: momentum.direction,
      evidence: {
        kind: 'momentum',
        direction: momentum.direction,
        change: momentum.change,
        window_days: OP_TYPE_CONFIG.momentum_window_days,
        threshold: OP_TYPE_CONFIG.momentum_threshold,
        start_date: momentum.start_date,
        prev_date: momentum.prev_date,
        detail: `卖出前 ${OP_TYPE_CONFIG.momentum_window_days} 个交易日 ${pctText(momentum.change)}`,
      },
    };
  }
  if (holding?.known) {
    return holding.after === 0
      ? { bucket_id: 'clear', evidence: { kind: 'holding', holding_before: holding.before, holding_after: 0, detail: `卖前 ${holding.before} 股，卖后清仓` } }
      : { bucket_id: 'trim', evidence: { kind: 'holding', holding_before: holding.before, holding_after: holding.after, detail: `卖后仍持有 ${holding.after} 股` } };
  }
  return { bucket_id: 'other', evidence: { kind: 'unknown', detail: '缺少可核对的持仓记录' } };
}

export function buildOperationAttribution({ decomposition, behavior, trades = null, market = null } = {}) {
  if (!decomposition) return { ok: false, reason: '逐笔分解没有生成：不展示操作类型归因' };
  const total = Number(decomposition.total?.value);
  if (!Number.isFinite(total)) return { ok: false, reason: '逐笔分解缺少总额：不展示操作类型归因' };
  if (decomposition.blocked === true) {
    return { ok: false, reason: '逐笔分解未通过加总或回源校验：不展示操作类型归因' };
  }
  if (behavior?.available !== true || !Array.isArray(behavior?.data?.patterns)) {
    return { ok: false, reason: behavior?.reason || '行为发现没有生成：不强行按操作类型分类' };
  }

  const patterns = behavior.data.patterns;
  const rebuyIds = idsOfPattern(patterns, 'sell_rebuy_within_2d', (row) => row?.prior_trade_id);
  const flipIds = idsOfPattern(patterns, 'quick_flip', (row) => row?.trade_id);

  const tradeIndex = new Map();
  for (const trade of Array.isArray(trades) ? trades : []) {
    if (trade?.trade_id) tradeIndex.set(trade.trade_id, trade);
  }
  const holdings = buildHoldings(trades);

  const buckets = BUCKET_DEFS.map((def) => ({
    ...def, count: 0, money: 0, share: null, trade_ids: [],
  }));
  const byId = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  const byTrade = new Map();
  const items = Array.isArray(decomposition.items) ? decomposition.items : [];
  for (const item of items) {
    const tradeId = item?.trade_id;
    const trade = tradeIndex.get(tradeId);
    const momentum = trade ? buildMomentum(market, trade) : null;
    const type = classify({ tradeId, rebuyIds, flipIds, momentum, holding: holdings.get(tradeId) });
    const bucket = byId.get(type.bucket_id);
    bucket.count += 1;
    bucket.money += Number(item?.dragMoney) || 0;
    bucket.trade_ids.push(tradeId);
    if (tradeId) {
      byTrade.set(tradeId, {
        trade_id: tradeId,
        bucket_id: type.bucket_id,
        label: bucket.label,
        hint: bucket.hint,
        detail: type.evidence.detail,
        evidence: type.evidence,
      });
    }
  }

  const sum = buckets.reduce((acc, bucket) => acc + bucket.money, 0);
  if (decomposition.checks?.sum_equals_total === false || !moneyEqual(sum, total)) {
    return { ok: false, reason: '操作类型归因加总与逐笔分解不一致：不展示' };
  }

  for (const bucket of buckets) {
    bucket.share = total === 0 ? null : bucket.money / total;
    bucket.display = {
      money: fmtMoney(bucket.money),
      share: bucket.share === null ? '—' : `${(bucket.share * 100).toFixed(1)}%`,
    };
  }

  return {
    ok: true,
    config: { ...OP_TYPE_CONFIG },
    total: { value: total, display: decomposition.total?.display ?? fmtMoney(total) },
    buckets,
    by_trade: Object.fromEntries(byTrade),
    basis: '按行为证据与仓位事实归类；金额仍以逐笔分解为准；不是对动机的判断',
    notes: [
      '同一笔只归一类；优先级：回补式 > 快进快出 > 下跌中/上涨中 > 清仓 > 部分减仓 > 其他。',
      `涨跌口径：卖出前一交易日收盘 ÷ ${OP_TYPE_CONFIG.momentum_window_days} 个交易日前收盘 − 1，阈值 ±${(OP_TYPE_CONFIG.momentum_threshold * 100).toFixed(0)}%（不复权）。`,
      '清仓 / 部分减仓只描述卖出后的持仓事实；分类不参与金额计算。',
    ],
  };
}
