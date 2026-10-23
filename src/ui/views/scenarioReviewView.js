// 操作复盘页（#/scenario）：按账单里的每一笔真实成交，逐笔对照当前生效规则；
// 画像只描述已成立的习惯，不参与合规判定。数据获取仍走 adapter.contractSimContext。
import { el, chip } from '../components.js';
import * as adapter from '../../demo/adapter.js';

const safe = (x) => (x === null || x === undefined || x === '' ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
const fmtPrice = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—');
const fmtQty = (v) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('en-US') : '—');

const OUTCOME_KIND = Object.freeze({
  violated: 'warn',
  warned: 'mode',
  missing: '',
  compliant: 'ok',
  not_applicable: '',
  no_rule: '',
});

const HABIT_NAME = Object.freeze({
  sell_rebuy_within_2d: '卖出后回补',
  chase_high_buy: '追高买入',
  quick_flip: '快进快出',
  overtrading: '交易频率偏高',
});

const MISSING_COPY = Object.freeze({
  E_BUY_HISTORY_UNCONFIRMED: '账单里没有该标的在卖出前的买入记录，无法确认这个窗口；不算作符合。',
  E_BUY_OUTSIDE_WINDOW_UNCONFIRMED: '账单里的买入记录不足以确认这个窗口；不算作符合。',
  E_SAME_DAY_BUY_UNCONFIRMED: '只有同日买入，成交先后顺序未知，无法确认这个窗口；不算作符合。',
  E_TRADING_CALENDAR_MISSING: '缺少交易日历，无法计算交易日窗口。',
  E_DATE_NOT_IN_CALENDAR: '成交日不在交易日历中，无法计算交易日窗口。',
  E_SELL_DAY_NOT_IN_CALENDAR: '卖出日不在交易日历中，无法计算交易日窗口。',
  E_BUY_DAY_NOT_IN_CALENDAR: '买入日不在交易日历中，无法计算交易日窗口。',
  E_CHANGE_PCT_MISSING: '缺少当日或前收行情，无法复核这笔操作。',
  E_PREV_DAY_BEYOND_CACHE: '前收日早于行情范围，无法复核这笔操作。',
  E_LEDGER_MARKET_UNAVAILABLE: '本次没有可用行情，无法复核这笔操作。',
});

let loadingKey = null;

function marketErrorText(error) {
  const raw = typeof error === 'string' ? error : String(error?.message ?? '');
  if (/E_MARKET_NOT_CONFIGURED/.test(raw)) return '当前没有可用的行情服务，暂时无法完成这次复盘。';
  if (/E_MARKET_UNAVAILABLE/.test(raw)) return '行情服务暂不可用，暂时无法完成这次复盘。';
  return '暂时无法获取行情，未能完成这次复盘。';
}

function shortMessage(event) {
  if (event.outcome === 'missing' && MISSING_COPY[event.code]) return MISSING_COPY[event.code];
  return event.message;
}

function habitName(h) {
  return HABIT_NAME[h.pattern_id] ?? h.name;
}

function habitDetail(h) {
  if (h.pattern_id === 'chase_high_buy') return `买入前 5 个交易日涨幅 ${h.display?.rise ?? '—'}；画像口径，不参与规则判定。`;
  if (h.pattern_id === 'sell_rebuy_within_2d') return `卖出后 ${h.gap_days ?? '—'} 个交易日回补；画像口径，不参与规则判定。`;
  if (h.pattern_id === 'quick_flip') return `买入后 ${h.gap_days ?? '—'} 个交易日卖出；画像口径，不参与规则判定。`;
  return '画像口径，不参与规则判定。';
}

function headlineOf(review, customN = 0) {
  const s = review.summary;
  if (!s.trades_n) return [el('span', {}, ['这份账单里还没有可复盘的操作。'])];
  if (!s.rules_n && customN) return [`${s.trades_n} 笔操作，`, el('strong', {}, [`${customN} 条自定义规则暂未纳入逐笔复核`]), '。'];
  if (!s.rules_n) return [`${s.trades_n} 笔操作，`, el('strong', {}, ['还没有可对照的规则']), '。'];
  if (s.violated_n) return [`${s.trades_n} 笔操作，`, el('strong', {}, [`${s.violated_n} 笔违背了规则`]), '。'];
  if (s.missing_n) return [`${s.trades_n} 笔操作，`, el('strong', { class: 'ok' }, ['暂未发现违背规则的操作']), `；${s.missing_n} 笔无法确认。`];
  if (s.compliant_n === s.trades_n) return [`${s.trades_n} 笔操作，`, el('strong', { class: 'ok' }, ['全部符合当前规则']), '。'];
  return [`${s.trades_n} 笔操作，`, el('strong', { class: 'ok' }, [`${s.compliant_n} 笔符合规则`]), `；${s.trades_n - s.compliant_n} 笔无对应情境或未参与复核。`];
}

function stat(label, value, kind = '') {
  return el('div', { class: 'tr-stat', 'data-kind': kind }, [
    el('span', {}, [label]),
    el('strong', {}, [String(value)]),
  ]);
}

function operationHint(op) {
  const violated = op.events.find((e) => e.outcome === 'violated');
  if (violated && violated.template_id === 'no_buy_back_within' && violated.fact?.distance_trading_days !== undefined) {
    return `卖出后 ${violated.fact.distance_trading_days} 个交易日回补`;
  }
  if (op.outcome === 'violated') return '触发了你设置的守约规则';
  if (op.outcome === 'warned') return '命中提醒规则，只提醒，不计违反';
  if (op.outcome === 'missing') return '缺少可确认的数据';
  if (op.outcome === 'not_applicable') return '没有对应情境';
  if (op.outcome === 'no_rule') return '当前规则未覆盖这笔操作';
  return '符合当前规则';
}

function chainOf(event, op, byTrade) {
  if (event.template_id === 'no_buy_back_within' && event.fact) {
    const prior = event.fact.last_sell;
    if (!prior) return el('div', { class: 'tr-chain' }, [`${op.trade_date} 之前，账单里没有 ${op.symbol} 的卖出记录`]);
    const prev = byTrade.get(prior.trade_id);
    return el('div', { class: 'tr-chain' }, [
      el('span', {}, [`${prior.trade_date} 卖出${prev ? ` ${fmtQty(prev.quantity)} 股 @${fmtPrice(prev.price)}` : ''}`]),
      el('span', { class: 'tr-chain-arrow' }, [`→ ${event.fact.distance_trading_days ?? '—'} 个交易日 →`]),
      el('span', {}, [`${op.trade_date} 买入 ${fmtQty(op.quantity)} 股 @${fmtPrice(op.price)}`]),
    ]);
  }
  if (event.template_id === 'sell_within_after_buy' && event.fact?.last_buy) {
    const prev = byTrade.get(event.fact.last_buy.trade_id);
    return el('div', { class: 'tr-chain' }, [
      el('span', {}, [`${event.fact.last_buy.trade_date} 买入${prev ? ` ${fmtQty(prev.quantity)} 股 @${fmtPrice(prev.price)}` : ''}`]),
      el('span', { class: 'tr-chain-arrow' }, [`→ ${event.fact.distance_trading_days ?? '—'} 个交易日 →`]),
      el('span', {}, [`${op.trade_date} 卖出 ${fmtQty(op.quantity)} 股 @${fmtPrice(op.price)}`]),
    ]);
  }
  return null;
}

function eventRow(event, op, byTrade) {
  const kind = OUTCOME_KIND[event.outcome] ?? '';
  return el('div', { class: 'tr-rule', 'data-outcome': event.outcome }, [
    el('div', { class: 'tr-rule-head' }, [
      el('span', { class: 'tr-rule-name' }, [event.template_name]),
      chip(event.outcome_label, kind),
    ]),
    el('div', { class: 'tr-rule-text' }, [event.rule_text]),
    el('div', { class: 'tr-rule-msg' }, [shortMessage(event)]),
    chainOf(event, op, byTrade),
    el('details', { class: 'tr-rule-more' }, [
      el('summary', {}, ['依据']),
      el('div', {}, [event.message]),
    ]),
  ]);
}

function habitRow(h) {
  return el('div', { class: 'tr-habitrow' }, [
    el('span', { class: 'tr-habitrow-label' }, ['画像习惯']),
    el('span', { class: 'tr-habitrow-name' }, [`${habitName(h)} ×${h.sample_n}`]),
    el('span', { class: 'tr-habitrow-note' }, [habitDetail(h)]),
  ]);
}

function operationCard(op, open, byTrade) {
  const kind = OUTCOME_KIND[op.outcome] ?? '';
  const details = el('details', {
    class: 'tr-op',
    'data-outcome': op.outcome,
    'data-trade-id': op.trade_id,
    open: open ? '' : null,
  }, [
    el('summary', { class: 'tr-op-head' }, [
      el('span', { class: 'tr-op-when' }, [
        el('span', { class: 'tr-op-date' }, [op.trade_date]),
        el('span', { class: `tr-side ${op.side}` }, [op.side_label]),
      ]),
      el('span', { class: 'tr-op-main' }, [
        el('span', { class: 'tr-op-symbol' }, [op.symbol]),
        el('span', { class: 'tr-op-price' }, [`${fmtQty(op.quantity)} 股 @${fmtPrice(op.price)}`]),
      ]),
      el('span', { class: 'tr-op-outcome' }, [
        chip(op.outcome_label, kind),
        el('span', { class: 'tr-op-hint' }, [operationHint(op)]),
      ]),
      el('span', { class: 'tr-op-caret', 'aria-hidden': 'true' }, ['›']),
    ]),
    el('div', { class: 'tr-op-body' }, [
      ...op.habits.map(habitRow),
      ...op.events.map((e) => eventRow(e, op, byTrade)),
      op.events.length ? null : el('div', { class: 'muted small' }, ['当前没有适用于这笔操作的生效规则。']),
    ]),
  ]);
  return details;
}

function ruleSummarySection(review) {
  const rules = review.rules;
  if (!rules.length) return null;
  return el('section', { class: 'tr-rules card' }, [
    el('div', { class: 'tr-section-head' }, [
      el('h3', { class: 'tr-section-title' }, ['按规则看']),
      el('span', { class: 'muted small' }, [`当前生效 ${rules.length} 条`]),
    ]),
    ...rules.map((r) => el('div', { class: 'tr-rule-row', 'data-hash': r.hash }, [
      el('div', { class: 'tr-rule-row-head' }, [
        el('span', { class: 'tr-rule-row-name' }, [r.template_name]),
        chip(r.enforcement_label, r.enforcement === 'remind' ? 'mode' : 'warn'),
      ]),
      el('div', { class: 'tr-rule-row-text' }, [r.rule_text]),
      el('div', { class: 'tr-rule-row-counts' }, [
        r.violated_n ? chip(`${r.violated_n} 笔违背`, 'warn') : null,
        r.warned_n ? chip(`${r.warned_n} 笔已提醒`, 'mode') : null,
        r.compliant_n ? chip(`${r.compliant_n} 笔符合`, 'ok') : null,
        r.missing_n ? chip(`${r.missing_n} 笔无法确认`, '') : null,
        r.not_applicable_n ? chip(`${r.not_applicable_n} 笔无此情境`, '') : null,
        el('span', { class: 'muted small' }, [r.applies_n ? `共 ${r.applies_n} 笔复核` : '账单中没有该规则范围内的记录']),
      ]),
    ])),
  ]);
}

function dataDisclosure(review, context, localBill) {
  const market = context.marketSource;
  return el('details', { class: 'tr-tech' }, [
    el('summary', {}, ['数据与口径']),
    el('div', { class: 'tr-tech-body' }, [
      el('div', {}, [`交易来源：${context.tradesSource?.label ?? (localBill ? '本地已确认账单' : '示例账单')}`]),
      el('div', {}, [`行情：${market?.label ?? '—'}${context.asOfDate ? ` · 截至 ${context.asOfDate}` : ''}（服务端获取，非实时）`]),
      el('div', {}, [`行情范围：${context.range?.start ?? '—'} 至 ${context.range?.end ?? '—'} · ${context.tradingDays?.length ?? 0} 个交易日`]),
      ...review.notes.map((n) => el('div', {}, [n])),
    ]),
  ]);
}

function emptyGate() {
  return el('div', { class: 'tr-empty card' }, [
    el('p', { class: 'tr-empty-label' }, ['NO REAL BILL / 尚未开始']),
    el('h2', { class: 'tr-empty-title' }, ['先导入并确认一份账单。']),
    el('p', { class: 'tr-empty-copy' }, ['导入并确认账单后，这里会按真实成交逐笔对照当前规则。没有账单时不会自动加载示例数据。']),
    el('div', { class: 'tr-empty-actions' }, [
      el('a', { class: 'btn primary tr-empty-action', href: '#/import' }, ['导入账单', el('span', { class: 'arrow' }, ['→'])]),
    ]),
  ]);
}

function emptyNoRules() {
  return el('div', { class: 'tr-notice' }, [
    el('strong', {}, ['还没有生效规则。']),
    el('span', {}, ['没有尺子就无法判断每笔操作是否符合你的理想规则；可以先设置一条，再回来复盘。']),
    el('a', { class: 'text-link', href: '#/me' }, ['去设置规则 →']),
  ]);
}

export function renderScenarioReview(root, ctx) {
  const { state, set } = ctx;
  const c = state.contracts ?? {};
  const localBill = !!(state.bill && state.bill.status === 'confirmed' && state.bill.sourceType === 'local');
  const demoAllowed = ctx.allowDemoSimulation !== false;
  const marketSource = localBill ? adapter.DEFAULT_MARKET_SOURCE : (c.marketSource === 'synthetic-fixture' ? 'synthetic-fixture' : adapter.DEFAULT_MARKET_SOURCE);
  const src = adapter.contractTradeSource(state.bill, marketSource);
  const page = el('div', { class: 'stack tr-page' });
  root.append(page);

  if (!localBill && !demoAllowed) {
    page.append(emptyGate());
    return;
  }

  page.append(el('div', { class: 'tr-toolbar' }, [
    el('div', { class: 'tr-toolbar-left' }, [
      localBill
        ? chip('本地已确认账单', 'ok')
        : demoAllowed
          ? chip('示例账单', 'mode')
          : chip('未确认账单', ''),
      chip('历史复盘 · 非实时', ''),
    ]),
    localBill
      ? el('span', { class: 'muted small' }, ['行情来源：Tushare 动态日线'])
      : demoAllowed
        ? el('div', { class: 'tr-source' }, [
          el('span', { class: 'tr-source-label' }, ['行情来源']),
          el('div', { class: 'rp-seg' }, adapter.CONTRACT_MARKET_OPTIONS.map((o) => el('button', {
            type: 'button',
            class: marketSource === o.id ? 'active' : '',
            onclick: () => {
              if (marketSource === o.id) return;
              loadingKey = null;
              set({ contracts: { marketSource: o.id, simContext: null } });
            },
          }, [o.label]))),
        ])
        : el('span', { class: 'muted small' }, ['确认账单后获取行情']),
  ]));

  const ruleSet = adapter.contractRuleSet(c.versions ?? []);
  const currentRules = ruleSet.current;
  const customRules = ruleSet.customCurrent ?? [];
  const customN = customRules.length;
  const contextKey = `${src.key}|${currentRules.map((r) => r.hash).join('|')}`;
  const context = c.simContext;

  if (context?.error && context.reviewKey === contextKey) {
    page.append(el('div', { class: 'tr-error card' }, [
      el('strong', {}, ['暂时无法复盘']),
      el('p', { class: 'tr-error-copy' }, [marketErrorText(context.error)]),
      el('p', { class: 'muted small' }, ['不回落示例数据，也不改用其他行情来源。请稍后重试。']),
      el('button', {
        class: 'btn small',
        onclick: () => { loadingKey = null; set({ contracts: { simContext: null } }); },
      }, ['重试']),
    ]));
    return;
  }

  if (!context || context.sourceKey !== src.key || context.reviewKey !== contextKey || (!context.error && !context.review)) {
    page.append(el('div', { class: 'tr-loading card' }, [
      el('strong', {}, [localBill ? '正在获取账单与 Tushare 动态行情…' : '正在获取示例账单与行情…']),
      el('div', { class: 'muted small' }, [`交易来源：${src.label}。行情与规则复核都在本地完成，原始 CSV 不上传。`]),
    ]));
    if (loadingKey !== contextKey) {
      loadingKey = contextKey;
      const key = contextKey;
      adapter.contractSimContext({ bill: state.bill, marketSource, versions: c.versions ?? [] })
        .then((d) => {
          if (loadingKey !== key) return;
          loadingKey = null;
          set({ contracts: { simContext: { ...d, reviewKey: key } } });
        })
        .catch((e) => {
          if (loadingKey !== key) return;
          loadingKey = null;
          set({ contracts: { simContext: { error: String(e && e.message ? e.message : e), sourceKey: src.key, reviewKey: key } } });
        });
    }
    return;
  }

  const review = context.review;
  const s = review.summary;

  page.append(el('div', { class: 'tr-billbar' }, [
    el('div', { class: 'tr-billbar-main' }, [
      el('span', { class: 'tr-bill-source' }, [context.tradesSource?.label ?? src.label]),
      el('span', {}, ['·',]),
      el('span', {}, [`${s.trades_n} 笔操作`]),
      el('span', {}, ['·']),
      el('span', {}, [`${review.symbols.length} 只标的${review.symbols.length ? `（${review.symbols.slice(0, 3).join('、')}${review.symbols.length > 3 ? ' 等' : ''}）` : ''}`]),
      review.range ? el('span', {}, ['·']) : null,
      review.range ? el('span', {}, [`${review.range.start} → ${review.range.end}`]) : null,
    ]),
  ]));

  page.append(el('section', { class: 'tr-summary' }, [
    el('div', { class: 'tr-eyebrow' }, ['操作复盘 / TRADE REVIEW']),
    el('h2', { class: 'tr-headline' }, headlineOf(review, customN)),
    el('p', { class: 'tr-lede' }, ['按成交顺序逐笔复核，点开卡片看依据。']),
    s.rules_n
      ? el('div', { class: 'tr-stats' }, [
        stat('操作', s.trades_n),
        stat('违背', s.violated_n, 'loss'),
        stat('符合', s.compliant_n, 'ok'),
        stat('无法确认', s.missing_n, 'mode'),
      ])
      : el('div', { class: 'tr-stats tr-stats-plain' }, [
        stat('操作', s.trades_n),
        stat('标的', review.symbols.length),
        stat('画像习惯', s.habits_n),
      ]),
    s.not_applicable_n ? el('p', { class: 'tr-note' }, [`另有 ${s.not_applicable_n} 笔操作没有对应情境，不计为符合。`]) : null,
    s.warned_n ? el('p', { class: 'tr-note' }, [`${s.warned_n} 笔操作命中提醒规则，只提醒，不计违反。`]) : null,
    s.no_rule_n ? el('p', { class: 'tr-note' }, [`${s.no_rule_n} 笔操作不在当前规则覆盖范围内，未参与复核。`]) : null,
  ]));

  if (customN) {
    page.append(el('div', { class: 'tr-notice' }, [
      el('strong', {}, ['自定义规则暂不参与逐笔复盘。']),
      el('span', {}, [`${customN} 条自定义规则需要按原话逐笔判断，当前版本只对模板规则给出确定性结论；这里不把它们算作“符合”。`]),
      el('a', { class: 'text-link', href: '#/me' }, ['查看规则 →']),
    ]));
  }

  if (review.habits.length) {
    page.append(el('aside', { class: 'tr-habits' }, [
      el('span', { class: 'tr-habits-label' }, ['画像同时看到']),
      ...review.habits.map((h) => el('span', { class: 'tr-habit-chip' }, [
        `${habitName(h)} ×${h.sample_n}`,
      ])),
      el('span', { class: 'tr-habits-note' }, ['画像口径，不是合规结论']),
      el('a', { class: 'tr-habits-link', href: '#/me' }, ['查看完整画像 →']),
    ]));
  } else {
    page.append(el('aside', { class: 'tr-habits tr-habits-empty' }, [
      el('span', { class: 'tr-habits-label' }, ['画像']),
      el('span', { class: 'tr-habits-note' }, ['暂未发现已成立的习惯；样本不足时不贴标签。']),
      el('a', { class: 'tr-habits-link', href: '#/me' }, ['查看个人画像 →']),
    ]));
  }

  if (!s.rules_n && !customN) page.append(emptyNoRules());

  const byTrade = new Map(review.operations.map((op) => [op.trade_id, op]));
  const cards = [];
  let opened = false;
  for (const op of review.operations) {
    const open = !opened && op.outcome === 'violated';
    if (open) opened = true;
    cards.push(operationCard(op, open, byTrade));
  }

  if (cards.length) {
    const list = el('div', { class: 'tr-list' }, cards);
    const filterEmpty = el('div', { class: 'tr-filter-empty muted small', hidden: '' }, ['当前筛选下没有操作。']);
    const filterButtons = [];
    const applyFilter = (id) => {
      let shown = 0;
      for (const card of cards) {
        const ok = id === 'all' || card.getAttribute('data-outcome') === id;
        card.hidden = !ok;
        if (ok) shown += 1;
      }
      filterEmpty.hidden = shown > 0;
      for (const b of filterButtons) b.classList.toggle('active', b.getAttribute('data-filter') === id);
    };
    const filters = [{ id: 'all', label: `全部 ${s.trades_n}` }];
    if (s.violated_n) filters.push({ id: 'violated', label: `违背 ${s.violated_n}` });
    if (s.missing_n) filters.push({ id: 'missing', label: `无法确认 ${s.missing_n}` });
    const filterBar = filters.length > 1 ? el('div', { class: 'tr-filter' }, filters.map((f) => {
      const b = el('button', { type: 'button', class: f.id === 'all' ? 'active' : '', 'data-filter': f.id, onclick: () => applyFilter(f.id) }, [f.label]);
      filterButtons.push(b);
      return b;
    })) : null;
    page.append(el('div', { class: 'tr-section-head tr-list-head' }, [
      el('h3', { class: 'tr-section-title' }, ['逐笔操作']),
      el('span', { class: 'muted small' }, ['按日期顺序 · 点开看依据']),
      filterBar,
    ]));
    page.append(list, filterEmpty);
  } else {
    page.append(el('div', { class: 'tr-empty card' }, [
      el('p', { class: 'tr-empty-label' }, ['NO TRADES / 无可复盘操作']),
      el('h2', { class: 'tr-empty-title' }, ['这份账单里还没有可复盘的操作。']),
      el('p', { class: 'tr-empty-copy' }, ['导入包含成交记录的账单后，这里会逐笔对照当前规则。']),
      el('div', { class: 'tr-empty-actions' }, [
        el('a', { class: 'btn primary tr-empty-action', href: '#/import' }, ['导入账单', el('span', { class: 'arrow' }, ['→'])]),
      ]),
    ]));
  }

  const rulesSection = ruleSummarySection(review);
  if (rulesSection) page.append(rulesSection);
  page.append(dataDisclosure(review, context, localBill));
}
