// 守约账本：假设当前规则在账单期间已生效，逐笔复核买入/卖出记录。
// 只读取当前导入账单的可见交易与所选行情；守约类规则（买入前约束）命中后仍执行记违反，
// 提醒类规则（卖出提醒）命中只记“已提醒”，不记违反。缺行情/缺成交时刻/账单完整性不足一律记“数据不足”，不猜测。

import { CONTRACT_CODES, dayChangePct, matchContract } from './contractMatch.js';
import { scopeApplies, actionLabel } from './ruleSpec.js';

export const RULE_LEDGER_VERSION = 'rule-ledger-1';

const SIDE_LABEL = Object.freeze({ buy: '买入', sell: '卖出' });

const ENFORCEMENT = Object.freeze({
  prohibit: Object.freeze({ id: 'prohibit', label: '守约规则', note: '命中后仍然执行，记为违反。' }),
  remind: Object.freeze({ id: 'remind', label: '提醒规则', note: '命中记为“已提醒”，不计违反。' }),
});

export function enforcementOf(kind) {
  return kind === 'buy_sell_window' ? ENFORCEMENT.remind : ENFORCEMENT.prohibit;
}

function emptyCounts() {
  return { reviewed_n: 0, triggered_n: 0, violated_n: 0, warned_n: 0, compliant_n: 0, missing_n: 0 };
}

function eventOf({ rule, trade, outcome, code = null, message, fact = null, extra = null }) {
  return {
    rule_hash: rule.hash,
    rule_v: rule.v,
    template_id: rule.template_id,
    template_name: rule.template_name,
    outcome,
    outcome_label: {
      violated: '违反', warned: '已提醒', compliant: '守约', missing: '数据不足',
    }[outcome],
    code,
    at: trade.trade_date,
    trade_id: trade.trade_id,
    symbol: trade.symbol,
    side: trade.side,
    side_label: SIDE_LABEL[trade.side] ?? trade.side,
    message,
    fact,
    ...(extra ? { display: extra } : {}),
  };
}

function tally(entry, event) {
  entry.reviewed_n += 1;
  entry.events.push(event);
  if (event.outcome === 'violated') { entry.triggered_n += 1; entry.violated_n += 1; }
  else if (event.outcome === 'warned') { entry.triggered_n += 1; entry.warned_n += 1; }
  else if (event.outcome === 'compliant') entry.compliant_n += 1;
  else {
    entry.missing_n += 1;
    const g = entry.missing_codes.find((x) => x.code === event.code);
    if (g) g.n += 1;
    else entry.missing_codes.push({ code: event.code ?? 'E_LEDGER_MISSING', n: 1, message: event.message });
  }
}

function changeRuleEvents(rule, trades, market) {
  const out = [];
  for (const t of trades) {
    if (t.side !== 'buy') continue;
    if (!market) {
      out.push({ trade: t, outcome: 'missing', code: 'E_LEDGER_MARKET_UNAVAILABLE', message: '本次没有可用行情：无法复核当日涨幅，记“数据不足”。', fact: { symbol: t.symbol, date: t.trade_date } });
      continue;
    }
    const change = dayChangePct(market, t.symbol, t.trade_date);
    if (!change.complete) {
      out.push({ trade: t, outcome: 'missing', code: change.code, message: change.message, fact: { symbol: t.symbol, date: t.trade_date } });
      continue;
    }
    const match = matchContract(rule.parsed, { symbol: t.symbol, date: t.trade_date, changePct: change.change_pct });
    const dateNote = change.effective_date === t.trade_date ? '' : `（${t.trade_date} 非交易日，实际取 ${change.effective_date} 收盘与 ${change.prev_date} 前收）`;
    out.push({
      trade: t, outcome: match.verdict === 'triggered' ? 'violated' : 'compliant', code: match.code,
      message: `${match.message}${dateNote}`,
      fact: { ...match.fact, effective_date: change.effective_date, prev_date: change.prev_date },
      extra: { change_pct: change.display.change_pct },
    });
  }
  return out;
}

function windowRuleEvents(rule, trades, side, tradingDays) {
  const out = [];
  for (const t of trades) {
    if (t.side !== side) continue;
    if (!Array.isArray(tradingDays) || tradingDays.length === 0) {
      out.push({ trade: t, outcome: 'missing', code: CONTRACT_CODES.TRADING_CALENDAR_MISSING, message: '缺少交易日历：无法计算交易日窗口，记“数据不足”。', fact: { symbol: t.symbol, date: t.trade_date } });
      continue;
    }
    const match = matchContract(rule.parsed, { symbol: t.symbol, date: t.trade_date, trades, tradingDays });
    const outcome = match.verdict === 'triggered' ? (side === 'sell' ? 'warned' : 'violated') : match.verdict === 'not_triggered' ? 'compliant' : 'missing';
    out.push({ trade: t, outcome, code: match.code, message: match.message, fact: match.fact });
  }
  return out;
}

function statusTextOf(entry) {
  const label = entry.enforcement === 'remind' ? '已提醒' : '记违反';
  const base = `复核 ${entry.reviewed_n} 笔${entry.side_label} · 命中 ${entry.triggered_n} 笔（${label}） · ${entry.enforcement === 'remind' ? '未命中' : '守约'} ${entry.compliant_n} 笔 · 数据不足 ${entry.missing_n} 笔`;
  return entry.reviewed_n === 0 ? `账单中没有该规则范围内的${entry.side_label}记录：本次无可复核记录。` : base;
}

function reviewRule(rule, trades, market) {
  const enf = enforcementOf(rule.parsed?.kind);
  const scoped = trades.filter((t) => scopeApplies(rule.scope, t.symbol));
  const side = enf.id === 'remind' ? 'sell' : 'buy';
  const entry = {
    hash: rule.hash, v: rule.v, template_id: rule.template_id, template_name: rule.template_name,
    text: rule.text, scope_text: rule.scope_text, scope: rule.scope,
    action: rule.action, action_label: actionLabel(rule.action),
    enforcement: enf.id, enforcement_label: enf.label, enforcement_note: enf.note,
    side, side_label: SIDE_LABEL[side],
    ...emptyCounts(), missing_codes: [], events: [],
  };
  let assessed;
  if (rule.parsed?.kind === 'change_pct_threshold') assessed = changeRuleEvents(rule, scoped, market);
  else if (rule.parsed?.kind === 'sell_buyback_window') assessed = windowRuleEvents(rule, scoped, 'buy', market?.tradingDays);
  else if (rule.parsed?.kind === 'buy_sell_window') assessed = windowRuleEvents(rule, scoped, 'sell', market?.tradingDays);
  else assessed = [];
  for (const a of assessed) tally(entry, eventOf({ rule, trade: a.trade, outcome: a.outcome, code: a.code, message: a.message, fact: a.fact, extra: a.extra }));
  entry.events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : String(a.trade_id).localeCompare(String(b.trade_id))));
  entry.status_text = statusTextOf(entry);
  entry.hit_note = enf.id === 'remind'
    ? '提醒类规则：命中表示按你的规则本应提醒，不表示违反承诺。'
    : '守约类规则：命中表示条件成立；若对应成交已发生，账本记为违反。';
  return entry;
}

/**
 * @param {object} p
 * @param {Array} p.rules contractRuleSet(...).current（每个模板唯一当前规则）
 * @param {Array} p.trades 标准化交易
 * @param {object|null} p.market 行情缓存（resolveValuation/getClose/tradingDays）
 * @param {number} [p.max_events] 顶部事件列表上限
 */
export function buildRuleLedger({ rules = [], trades = [], market = null, max_events = 8 } = {}) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.parsed?.supported === true) : [];
  const all = Array.isArray(trades) ? trades : [];
  const reviewed = list.map((r) => reviewRule(r, all, market));
  const summary = reviewed.reduce((acc, r) => {
    acc.reviewed_n += r.reviewed_n; acc.triggered_n += r.triggered_n; acc.violated_n += r.violated_n;
    acc.warned_n += r.warned_n; acc.compliant_n += r.compliant_n; acc.missing_n += r.missing_n;
    return acc;
  }, { rules_n: reviewed.length, ...emptyCounts() });
  const events = reviewed.flatMap((r) => r.events)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : String(a.rule_hash).localeCompare(String(b.rule_hash))))
    .slice(0, Math.max(0, max_events));
  const asOf = all.reduce((m, t) => (t.trade_date > m ? t.trade_date : m), '');
  return {
    version: RULE_LEDGER_VERSION,
    as_of: asOf || null,
    trades_n: all.length,
    summary,
    rules: reviewed,
    events,
    notes: [
      '假设当前规则在整段账单期间已经生效：这是历史复盘，不是实时申报记录，也不是券商拦截记录。',
      '只读取当前导入账单中的可见交易与所选行情；缺少行情、成交时刻或账单完整性依据时记为“数据不足”，不猜测。',
      '提醒类规则命中只表示“本应提醒你”，不记为违反；守约类规则命中后仍执行，记为违反。',
      '只复核当前生效规则；历史版本不参与账本。',
    ],
  };
}
