// 操作复盘：把守约账本的逐规则事件按真实成交（trade_id）聚合成“一笔操作”，
// 同时挂接行为画像证据。规则是尺子，画像是镜子：画像只描述已成立的习惯，不参与合规判定。
// 边界：纯函数；不读取行情网络；不猜测缺失数据；汇总结论按唯一操作计数，不按规则事件计数。

import { sortTrades } from './indicators.js';

export const TRADE_REVIEW_VERSION = 'trade-review-1';

const OUTCOME_LABEL = Object.freeze({
  violated: '违背规则',
  warned: '已提醒',
  missing: '无法确认',
  compliant: '符合',
  not_applicable: '无此情境',
  no_rule: '未参与复核',
});

const OUTCOME_PRIORITY = Object.freeze({ violated: 5, warned: 4, missing: 3, compliant: 2, not_applicable: 1, no_rule: 0 });

// 逐笔挂接的画像模式；交易频率是账单级特征，只在习惯条展示。
const PER_TRADE_HABITS = new Set(['chase_high_buy', 'sell_rebuy_within_2d', 'quick_flip']);

function operationOutcome(events) {
  if (!events.length) return 'no_rule';
  return events.reduce((best, e) => (OUTCOME_PRIORITY[e.outcome] > OUTCOME_PRIORITY[best] ? e.outcome : best), 'not_applicable');
}

function sameDaySellOf(trades, symbol, date) {
  return trades.some((t) => t.side === 'sell' && t.symbol === symbol && t.trade_date === date);
}

// “没有卖出记录”不是“守住了不追回规则”，改判“无此情境”，避免把不适用算成符合。
function normalizeEvent(rule, event, trades) {
  if (rule.template_id !== 'no_buy_back_within' || event.outcome !== 'compliant' || event.fact?.last_sell !== null) return event;
  const sameDay = sameDaySellOf(trades, event.symbol, event.at);
  return {
    ...event,
    outcome: 'not_applicable',
    outcome_label: OUTCOME_LABEL.not_applicable,
    code: 'E_NO_PRIOR_SELL',
    message: sameDay
      ? `${event.at} 之前账单里没有 ${event.symbol} 的卖出记录；同日先卖后买的先后顺序未知，不视为“卖出后回补”情境，因此不计为符合。`
      : `${event.at} 之前账单里没有 ${event.symbol} 的卖出记录：没有“卖出后回补”情境，不计为符合。`,
  };
}

function emptyRuleSummary(rule) {
  return {
    hash: rule.hash,
    template_id: rule.template_id,
    template_name: rule.template_name,
    rule_text: rule.text,
    enforcement: rule.enforcement,
    enforcement_label: rule.enforcement_label,
    scope_text: rule.scope_text,
    applies_n: 0,
    violated_n: 0,
    warned_n: 0,
    missing_n: 0,
    compliant_n: 0,
    not_applicable_n: 0,
  };
}

function tallyRule(summary, outcome) {
  summary.applies_n += 1;
  if (outcome === 'violated') summary.violated_n += 1;
  else if (outcome === 'warned') summary.warned_n += 1;
  else if (outcome === 'missing') summary.missing_n += 1;
  else if (outcome === 'compliant') summary.compliant_n += 1;
  else if (outcome === 'not_applicable') summary.not_applicable_n += 1;
}

function buildHabitIndex(patterns) {
  const byTrade = new Map();
  const summary = [];
  for (const p of patterns?.patterns ?? []) {
    if (p.status !== '成立') continue;
    summary.push({
      pattern_id: p.pattern_id,
      name: p.name,
      status: p.status,
      sample_n: p.sample_n,
      min_samples: p.min_samples,
      trade_ids: (p.evidence ?? []).map((e) => e.trade_id),
    });
    if (!PER_TRADE_HABITS.has(p.pattern_id)) continue;
    for (const e of p.evidence ?? []) {
      if (!byTrade.has(e.trade_id)) byTrade.set(e.trade_id, []);
      byTrade.get(e.trade_id).push({
        pattern_id: p.pattern_id,
        name: p.name,
        status: p.status,
        sample_n: p.sample_n,
        min_samples: p.min_samples,
        gap_days: e.gap_days ?? null,
        rise: e.rise ?? null,
        prior_trade_id: e.prior_trade_id ?? null,
        prior_trade_date: e.prior_trade_date ?? null,
        display: e.display ?? null,
      });
    }
  }
  return { byTrade, summary };
}

function operationLabel(side) {
  return side === 'buy' ? '买入' : side === 'sell' ? '卖出' : side;
}

/**
 * @param {object} p
 * @param {Array} p.trades 标准化交易
 * @param {object|null} p.ledger buildRuleLedger 输出
 * @param {object|null} p.patterns buildPatternList 输出
 * @param {object|null} p.market 行情缓存（仅用于口径说明，当前不直接读价）
 */
export function buildTradeReview({ trades = [], ledger = null, patterns = null, market = null } = {}) {
  const sorted = Array.isArray(trades) ? sortTrades(trades) : [];
  const habitIndex = buildHabitIndex(patterns);
  const ruleSummaries = new Map((ledger?.rules ?? []).map((r) => [r.hash, emptyRuleSummary(r)]));
  const eventsByTrade = new Map();

  for (const rule of ledger?.rules ?? []) {
    const summary = ruleSummaries.get(rule.hash);
    for (const raw of rule.events ?? []) {
      const event = normalizeEvent(rule, raw, sorted);
      tallyRule(summary, event.outcome);
      if (!eventsByTrade.has(event.trade_id)) eventsByTrade.set(event.trade_id, []);
      eventsByTrade.get(event.trade_id).push({
        rule_hash: event.rule_hash,
        template_id: event.template_id,
        template_name: event.template_name,
        rule_text: rule.text,
        enforcement: rule.enforcement,
        enforcement_label: rule.enforcement_label,
        outcome: event.outcome,
        outcome_label: OUTCOME_LABEL[event.outcome] ?? event.outcome_label,
        message: event.message,
        code: event.code,
        fact: event.fact,
        at: event.at,
      });
    }
  }

  const operations = sorted.map((t) => {
    const events = (eventsByTrade.get(t.trade_id) ?? []).sort((a, b) => (OUTCOME_PRIORITY[b.outcome] - OUTCOME_PRIORITY[a.outcome])
      || String(a.rule_hash).localeCompare(String(b.rule_hash)));
    const outcome = operationOutcome(events);
    return {
      trade_id: t.trade_id,
      trade_date: t.trade_date,
      symbol: t.symbol,
      side: t.side,
      side_label: operationLabel(t.side),
      price: t.price,
      quantity: t.quantity,
      source: t.source ?? null,
      outcome,
      outcome_label: OUTCOME_LABEL[outcome] ?? outcome,
      events,
      habits: habitIndex.byTrade.get(t.trade_id) ?? [],
    };
  });

  const summary = operations.reduce((acc, op) => {
    acc.trades_n += 1;
    acc[`${op.outcome}_n`] = (acc[`${op.outcome}_n`] ?? 0) + 1;
    return acc;
  }, {
    trades_n: 0,
    rules_n: ledger?.rules?.length ?? 0,
    violated_n: 0,
    warned_n: 0,
    missing_n: 0,
    compliant_n: 0,
    not_applicable_n: 0,
    no_rule_n: 0,
    habits_n: habitIndex.summary.length,
  });

  const symbols = [...new Set(sorted.map((t) => t.symbol))];
  const dates = sorted.map((t) => t.trade_date).sort();

  return {
    version: TRADE_REVIEW_VERSION,
    as_of: ledger?.as_of ?? (dates.length ? dates[dates.length - 1] : null),
    range: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    symbols,
    summary,
    operations,
    rules: [...ruleSummaries.values()],
    habits: habitIndex.summary,
    notes: [
      '按账单里的每一笔真实操作复盘：规则结论只代表这笔操作是否触发或违背当前生效规则；这是历史复盘，不是实时提醒记录，也不是券商拦截记录。',
      '“无此情境”和“无法确认”都不等于“符合”：没有前置卖出、缺行情、缺交易日历或账单完整性不足时，不把未知算成守约。',
      '画像只描述已成立的行为模式，不参与规则判定；画像口径与规则口径可能不同（追高看买入前 5 个交易日涨幅，规则看当日涨幅）。',
      '账单没有成交时刻：同日买卖的先后顺序无法确定，相关结论保持“无法确认”或“无此情境”，不猜测。',
      ...(market?.tradingDays?.length ? [] : ['本次没有可用交易日历：涉及交易日窗口的规则一律记为“无法确认”。']),
    ],
  };
}
