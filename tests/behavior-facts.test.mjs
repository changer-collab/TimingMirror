#!/usr/bin/env node
/**
 * 行为分析请求事实（浏览器侧）单元测试。
 * 覆盖：脱敏边界、相对交易日偏移、买入窗口覆盖、服务端重算与本地三态一致、协议错误分支。
 */
import { loadReportScenarioBill, loadUserBillReport } from '../src/demo/adapter.js';
import { REPORT_SCENARIOS } from '../src/demo/reportScenarios.js';
import { buildBehaviorFactsRequest, BEHAVIOR_FACTS_CODES } from '../src/engine/behaviorFacts.js';
import { normalizeBehaviorFactsRequest, buildBehaviorFacts } from '../server/site-functions/behaviorAnalysis.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const bundles = new Map();
for (const scenario of REPORT_SCENARIOS) {
  const bill = await loadReportScenarioBill(scenario.id, { contextId: `facts-${scenario.id}` });
  const bundle = await loadUserBillReport(bill);
  bundles.set(scenario.id, { bill, bundle });
}

for (const scenario of REPORT_SCENARIOS) {
  const { bill, bundle } = bundles.get(scenario.id);
  const facts = bundle.behaviorFacts;
  const pattern = bundle.insights.behavior.data.patterns[0];
  const serialized = JSON.stringify(facts);
  const buys = bill.trades.filter((t) => t.side === 'buy').length;
  const sides = new Set(facts?.events?.map((e) => e.side));
  const eventKeys = new Set(Object.keys(facts?.events?.[0] ?? {}));
  check(`${scenario.id}：事实协议与字段白名单`, facts?.protocol === 'behavior-facts-v1'
    && JSON.stringify(Object.keys(facts).sort()) === JSON.stringify(['buy_windows', 'events', 'protocol'])
    && JSON.stringify([...eventKeys].sort()) === JSON.stringify(['asset_key', 'day_offset', 'side'])
    && JSON.stringify(Object.keys(facts.buy_windows[0]).sort()) === JSON.stringify(['evaluated', 'event_index', 'rise_pct'])
    && sides.has('buy'), JSON.stringify(facts));
  check(`${scenario.id}：事件与窗口覆盖全部交易/买入`, facts.events.length === bill.trades.length
    && facts.buy_windows.length === buys
    && facts.buy_windows.every((w) => facts.events[w.event_index]?.side === 'buy'), JSON.stringify({ events: facts.events.length, windows: facts.buy_windows.length, buys }));
  check(`${scenario.id}：相对偏移从 0 开始且非递减`, facts.events[0].day_offset === 0
    && facts.events.every((event, index) => index === 0 || event.day_offset >= facts.events[index - 1].day_offset)
    && facts.events.every((event) => Number.isInteger(event.day_offset) && event.day_offset >= 0), JSON.stringify(facts.events.map((e) => e.day_offset)));
  const symbols = [...new Set(bill.trades.map((trade) => trade.symbol))];
  check(`${scenario.id}：不含标的/日期/文件名`, symbols.every((symbol) => !serialized.includes(symbol))
    && !/\d{4}-\d{2}-\d{2}/.test(serialized)
    && !serialized.includes(scenario.fileName)
    && facts.events.every((event) => /^A\d{1,3}$/.test(event.asset_key)), serialized.slice(0, 240));

  const normalized = normalizeBehaviorFactsRequest(facts);
  check(`${scenario.id}：服务端接受请求`, normalized.ok, JSON.stringify(normalized));
  if (normalized.ok) {
    const serverFacts = buildBehaviorFacts(normalized.request);
    check(`${scenario.id}：服务端重算三态与本地一致`, serverFacts.pattern.status === pattern.status
      && serverFacts.pattern.sample_n === pattern.sample_n
      && serverFacts.pattern.evaluated_n === pattern.evaluated_n
      && serverFacts.pattern.evidence_event_indexes.length === pattern.evidence.length, JSON.stringify({
      local: { status: pattern.status, n: pattern.sample_n, evaluated: pattern.evaluated_n },
      server: serverFacts.pattern,
    }));
  }
}

{
  const sellRebuy = bundles.get('sell_rebuy').bundle.behaviorFacts;
  const normalized = normalizeBehaviorFactsRequest(sellRebuy);
  const trading = normalized.ok ? buildBehaviorFacts(normalized.request).trading : null;
  check('卖后追回：相对偏移保留 2 个交易日间隔', trading?.sell_rebuy_within_2d_count === 1, JSON.stringify(trading));
  const overtrading = bundles.get('overtrading').bundle.behaviorFacts;
  const overNormalized = normalizeBehaviorFactsRequest(overtrading);
  const overTrading = overNormalized.ok ? buildBehaviorFacts(overNormalized.request).trading : null;
  check('频繁交易：四次卖出计入交易次数', overTrading?.sell_after_buy_count === 4, JSON.stringify(overTrading));
}

{
  const { bill, bundle } = bundles.get('chase');
  const behavior = bundle.insights.behavior.data;
  const noTrades = buildBehaviorFactsRequest({ trades: [], behavior, tradingDays: ['2025-01-02'] });
  check('空账单：明确拒绝', noTrades.ok === false && noTrades.code === BEHAVIOR_FACTS_CODES.TRADES_EMPTY, JSON.stringify(noTrades));
  const noBehavior = buildBehaviorFactsRequest({ trades: bill.trades, behavior: null, tradingDays: ['2025-01-02'] });
  check('行为不可用：明确拒绝', noBehavior.ok === false && noBehavior.code === BEHAVIOR_FACTS_CODES.BEHAVIOR_UNAVAILABLE, JSON.stringify(noBehavior));
  const noCalendar = buildBehaviorFactsRequest({ trades: bill.trades, behavior, tradingDays: [] });
  check('缺交易日历：明确拒绝', noCalendar.ok === false && noCalendar.code === BEHAVIOR_FACTS_CODES.CALENDAR_MISSING, JSON.stringify(noCalendar));
  const tooMany = buildBehaviorFactsRequest({
    trades: Array.from({ length: 501 }, (_, index) => ({ ...bill.trades[0], trade_id: `X${index}` })),
    behavior,
    tradingDays: ['2025-01-02'],
  });
  check('超过 500 笔：明确拒绝', tooMany.ok === false && tooMany.code === BEHAVIOR_FACTS_CODES.TOO_MANY_EVENTS, JSON.stringify(tooMany));

  const missingWindow = buildBehaviorFactsRequest({
    trades: bill.trades,
    behavior: { patterns: [{ ...behavior.patterns[0], evidence: [], evaluated_others: [], unevaluated: [] }] },
    tradingDays: ['2025-01-02'],
  });
  check('买入缺窗口：不发送残缺事实', missingWindow.ok === false && missingWindow.code === BEHAVIOR_FACTS_CODES.WINDOW_MISSING, JSON.stringify(missingWindow));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   → ${r.detail}`}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
