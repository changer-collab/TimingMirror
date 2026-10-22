// M1-C5 行为发现引擎（F-10）—— 情境切分→重复模式→样本数 n＋成交明细＋证据状态。
// M2-C1 数据侧（三）扩展（OUTPUT02/T1-14）：结论三态（成立/不成立/证据不足，不利结论照实）＋ hypotheses 视图（n＋检验方式）。
// 本轮扩充（candidate-2）：在追高买入之外，登记“卖出后两日内买回”“买入后三日内卖出”“交易频率偏高”三条候选模式；
//   配对与往返只使用交易日历和成交方向/数量，不读取价格，不做盈亏判断。
// 边界：纯函数；输入为标准化交易（csvNormalize.js 输出同形）＋行情缓存引擎实例（marketCache.js）；不发网络请求。
// 口径：F-10.2 每条模式含 模式名/结论状态/样本数 n/成交记录 ID/阈值与检验方式/证据与计算路径；
//       F-10.3 与 PRD:234 —— 样本不足显示“证据不足”，不下确定结论；F-10.6 “清单是唯一事实出口”限定于本模块；
//       行情取值遵循缓存引擎语义（B2 不复权、B3 不晚于请求日的最近交易日、B4 缺价不回落、R2 范围外不支持）。
// 范围（candidate-2）：四条模式均为候选口径；PRD 完整规则副本未到位，不虚构其余模式名与阈值。
//       回看窗口、往返窗口与阈值待 F-5.1 负责人确认后替换并升配置版本。
// 非已冻结公式：本模块 rise/gap_days 为行为判定中间量，未入 m0/calc-baseline 公式表（不擅自新增 formula_id）。

import { fmtPct } from './display.js';
import { sortTrades } from './indicators.js';

export const BEHAVIOR_CODES = Object.freeze({
  PRICE_MISSING: 'E_PRICE_MISSING', // 窗口端点缺收盘价（B4 不回落）
  WINDOW_BEYOND_CACHE: 'E_WINDOW_BEYOND_CACHE', // 回看窗口早于缓存交易日起点（R2 不支持，不静默外推）
  DATE_UNRESOLVED: 'E_DATE_UNRESOLVED', // 成交日无可解析估值日
  SAME_DAY_ORDER_UNKNOWN: 'E_SAME_DAY_ORDER_UNKNOWN', // 同日反向成交先后顺序未知，不配对
});

const SIDE_LABEL = Object.freeze({ buy: '买入', sell: '卖出' });

export const PATTERN_CONFIG = Object.freeze({
  version: 'candidate-2',
  source: '候选占位（PRD 完整规则副本未到位）：回看窗口、往返窗口、阈值与最小样本数均为待确认参数，按 F-5.1 待负责人确认后替换',
  patterns: Object.freeze({
    chase_high_buy: Object.freeze({
      pattern_id: 'chase_high_buy',
      name: '追高买入',
      side: 'buy',
      kind: 'rise_before_buy',
      lookback_days: 5,
      rise_threshold: 0.1,
      min_samples: 2,
    }),
    sell_rebuy_within_2d: Object.freeze({
      pattern_id: 'sell_rebuy_within_2d',
      name: '卖出后两日内买回',
      side: 'buy',
      kind: 'sell_rebuy_window',
      window_days: 2,
      min_samples: 2,
    }),
    quick_flip: Object.freeze({
      pattern_id: 'quick_flip',
      name: '买入后三日内卖出',
      side: 'sell',
      kind: 'buy_sell_window',
      window_days: 3,
      min_samples: 2,
    }),
    overtrading: Object.freeze({
      pattern_id: 'overtrading',
      name: '交易频率偏高',
      side: 'trade',
      kind: 'round_trips',
      threshold_round_trips: 4,
      min_samples: 4,
    }),
  }),
});

export function listPatternDefinitions(config = PATTERN_CONFIG) {
  return {
    config_version: config.version,
    config_source: config.source,
    patterns: Object.values(config.patterns).map((p) => ({ ...p })),
  };
}

function resolveTradeIndex(market, trade) {
  const resolved = market.resolveValuation(trade.trade_date);
  if (resolved.blocked) {
    return { ok: false, code: resolved.code ?? BEHAVIOR_CODES.DATE_UNRESOLVED, message: `成交日 ${trade.trade_date} 无可解析估值日（${resolved.code}）` };
  }
  const index = market.tradingDays.indexOf(resolved.effective_date);
  if (index < 0) {
    return {
      ok: false,
      code: BEHAVIOR_CODES.WINDOW_BEYOND_CACHE,
      message: `成交日 ${trade.trade_date} 映射到 ${resolved.effective_date}，不在缓存交易日历：不静默外推（R2）`,
    };
  }
  return { ok: true, index, effective_date: resolved.effective_date };
}

function evaluateBuy(trade, market, p) {
  const resolved = market.resolveValuation(trade.trade_date);
  if (resolved.blocked) {
    return { evaluated: false, code: resolved.code, message: `买入日 ${trade.trade_date} 无可解析估值日（${resolved.code}）` };
  }
  const days = market.tradingDays;
  const k = days.indexOf(resolved.effective_date);
  const prevIdx = k - 1;
  const startIdx = prevIdx - p.lookback_days;
  if (startIdx < 0) {
    return {
      evaluated: false,
      code: BEHAVIOR_CODES.WINDOW_BEYOND_CACHE,
      message: `回看窗口早于缓存交易日起点（${days[0]}）：不静默外推（R2）`,
    };
  }
  const prevDate = days[prevIdx];
  const startDate = days[startIdx];
  const prevClose = market.getClose(trade.symbol, prevDate);
  const startClose = market.getClose(trade.symbol, startDate);
  if (prevClose === null || startClose === null) {
    const missing = prevClose === null ? prevDate : startDate;
    return {
      evaluated: false,
      code: BEHAVIOR_CODES.PRICE_MISSING,
      message: `窗口端点缺收盘价（${trade.symbol} ${missing}；B4 不回落）`,
    };
  }
  const rise = prevClose / startClose - 1;
  return {
    evaluated: true,
    matched: rise >= p.rise_threshold,
    rise,
    path: {
      effective_date: resolved.effective_date,
      window: { start_date: startDate, start_close: startClose, prev_date: prevDate, prev_close: prevClose, lookback_days: p.lookback_days },
      rise,
      threshold: p.rise_threshold,
      comparator: '≥',
      method: 'rise = close(买入前一交易日) / close(回看起点交易日) − 1（不复权 B2；非交易日按不晚于当日最近交易日 B3）',
    },
  };
}

function statusOf(n, evaluatedCount, minSamples) {
  return n >= minSamples ? '成立' : evaluatedCount >= minSamples ? '不成立' : '证据不足';
}

function conclusionOf(status, n, evaluatedCount, minSamples) {
  if (status === '成立') {
    return `样本数 n=${n} ≥ 最小样本 ${minSamples}：出现重复模式（候选阈值；不宣称阈值为已验证的普适标准，F-5.1）`;
  }
  if (status === '不成立') {
    return `已评估 ${evaluatedCount} 笔 ≥ 最小样本 ${minSamples}，但命中 n=${n} < ${minSamples}：未达最小重复数，模式不成立（不利结论照实，T1-14）`;
  }
  return `可评估样本 ${evaluatedCount} < 最小样本 ${minSamples}：证据不足，不下确定结论（F-10.3 / PRD:234）`;
}

function hypothesisOf(card, statement) {
  return {
    hypothesis_id: card.pattern_id,
    statement,
    status: card.status,
    n: card.sample_n,
    evaluated_n: card.evaluated_n,
    min_samples: card.min_samples,
    check_method: card.check_method,
    evidence_ids: card.evidence.map((e) => e.trade_id),
    conclusion: card.conclusion,
  };
}

function chasePattern({ sorted, market, config, p }) {
  const evidence = [];
  const evaluatedOthers = [];
  const unevaluated = [];
  let buyCount = 0;
  for (const t of sorted) {
    if (t.side !== 'buy') continue;
    buyCount += 1;
    const r = evaluateBuy(t, market, p);
    if (!r.evaluated) {
      unevaluated.push({ trade_id: t.trade_id, trade_date: t.trade_date, symbol: t.symbol, code: r.code, message: r.message });
      continue;
    }
    if (r.matched) {
      evidence.push({
        trade_id: t.trade_id,
        trade_date: t.trade_date,
        symbol: t.symbol,
        price: t.price,
        quantity: t.quantity,
        rise: r.rise,
        display: { rise: fmtPct(r.rise) },
        path: r.path,
        source: t.source,
      });
    } else {
      evaluatedOthers.push({ trade_id: t.trade_id, trade_date: t.trade_date, symbol: t.symbol, rise: r.rise, display: { rise: fmtPct(r.rise) } });
    }
  }
  const n = evidence.length;
  const evaluatedCount = evidence.length + evaluatedOthers.length;
  const status = statusOf(n, evaluatedCount, p.min_samples);
  const conclusion = conclusionOf(status, n, evaluatedCount, p.min_samples);
  const card = {
    pattern_id: p.pattern_id,
    name: p.name,
    implemented: true,
    status,
    sample_n: n,
    evaluated_n: evaluatedCount,
    min_samples: p.min_samples,
    buy_count: buyCount,
    sell_count: sorted.length - buyCount,
    conclusion,
    rule: {
      side: '买入',
      window: `买入日前 ${p.lookback_days} 个交易日`,
      comparator: '≥',
      threshold: p.rise_threshold,
      threshold_display: `${(p.rise_threshold * 100).toFixed(1)}%`,
    },
    check_method: '情境切分：逐笔买入 × 买入日前 lookback 个交易日窗口；窗口涨幅＝前一日收盘/窗口起点收盘−1；命中即计入样本；行情取值遵循缓存引擎（B2/B3/B4/R2）',
    threshold_meta: { config_version: config.version, source: config.source },
    evidence,
    evaluated_others: evaluatedOthers,
    unevaluated,
  };
  const hypothesis = hypothesisOf(
    card,
    `存在“${p.name}”重复模式：买入日前 ${p.lookback_days} 个交易日内涨幅 ≥ ${(p.rise_threshold * 100).toFixed(1)}% 的笔数 ≥ ${p.min_samples}（阈值候选，F-5.1）`,
  );
  return { card, hypothesis };
}

// 配对模式（卖出后买回 / 买入后卖出）：每笔当前方向成交回看同标的最近一笔严格更早的反向成交；
// 同日反向成交先后顺序未知，不配对并列入 unevaluated（不猜测）。
function pairPattern({ sorted, market, config, p }) {
  const isRebuy = p.kind === 'sell_rebuy_window';
  const currentSide = isRebuy ? 'buy' : 'sell';
  const priorSide = isRebuy ? 'sell' : 'buy';
  const priorLists = new Map();
  const evidence = [];
  const evaluatedOthers = [];
  const unevaluated = [];
  let currentCount = 0;
  for (const t of sorted) {
    const current = t.side === currentSide;
    const r = resolveTradeIndex(market, t);
    if (!r.ok) {
      if (current) {
        currentCount += 1;
        unevaluated.push({ trade_id: t.trade_id, trade_date: t.trade_date, symbol: t.symbol, code: r.code, message: r.message });
      }
      continue;
    }
    if (current) {
      currentCount += 1;
      const list = priorLists.get(`${t.symbol}|${priorSide}`) ?? [];
      const strict = list.filter((x) => x.index < r.index);
      const prior = strict.length ? strict[strict.length - 1] : null;
      if (!prior) {
        if (list.some((x) => x.index === r.index)) {
          unevaluated.push({
            trade_id: t.trade_id,
            trade_date: t.trade_date,
            symbol: t.symbol,
            code: BEHAVIOR_CODES.SAME_DAY_ORDER_UNKNOWN,
            message: `同日存在${SIDE_LABEL[priorSide]}成交，先后顺序未知：不配为“${p.name}”样本`,
          });
        }
      } else {
        const gap = r.index - prior.index;
        const row = {
          trade_id: t.trade_id,
          trade_date: t.trade_date,
          symbol: t.symbol,
          price: t.price,
          quantity: t.quantity,
          side: currentSide,
          side_label: SIDE_LABEL[currentSide],
          prior_trade_id: prior.trade.trade_id,
          prior_trade_date: prior.trade.trade_date,
          prior_side_label: SIDE_LABEL[priorSide],
          gap_days: gap,
          display: { gap_days: `${gap} 个交易日` },
          source: t.source,
        };
        if (gap <= p.window_days) evidence.push(row);
        else evaluatedOthers.push(row);
      }
    }
    const key = `${t.symbol}|${t.side}`;
    if (!priorLists.has(key)) priorLists.set(key, []);
    priorLists.get(key).push({ index: r.index, trade: t });
  }
  const n = evidence.length;
  const evaluatedCount = evidence.length + evaluatedOthers.length;
  const status = statusOf(n, evaluatedCount, p.min_samples);
  const conclusion = conclusionOf(status, n, evaluatedCount, p.min_samples);
  const windowText = isRebuy ? `卖出后 ${p.window_days} 个交易日内买回` : `买入后 ${p.window_days} 个交易日内卖出`;
  const card = {
    pattern_id: p.pattern_id,
    name: p.name,
    implemented: true,
    status,
    sample_n: n,
    evaluated_n: evaluatedCount,
    min_samples: p.min_samples,
    buy_count: sorted.filter((t) => t.side === 'buy').length,
    sell_count: sorted.filter((t) => t.side === 'sell').length,
    conclusion,
    rule: {
      side: SIDE_LABEL[currentSide],
      window: windowText,
      comparator: '≤',
      threshold: p.window_days,
      threshold_display: `${p.window_days} 个交易日`,
    },
    check_method: `按标的配对：逐笔${SIDE_LABEL[currentSide]}回看同标的最近一笔严格更早的${SIDE_LABEL[priorSide]}；交易日间隔（按交易日历）≤ ${p.window_days} 即命中；同日买卖先后顺序未知，不配对；不读取价格、不做盈亏判断`,
    threshold_meta: { config_version: config.version, source: config.source },
    evidence,
    evaluated_others: evaluatedOthers,
    unevaluated,
  };
  const hypothesis = hypothesisOf(
    card,
    `存在“${p.name}”重复模式：${windowText}的笔数 ≥ ${p.min_samples}（窗口候选，F-5.1）`,
  );
  return { card, hypothesis };
}

// 交易频率：按标的先进先出配对买入与卖出数量；只把严格早于卖出日的买入计入，
// 同日买卖顺序未知不配对。完整往返数达到最小样本即成立；不足时只报证据不足（无法据此否定频率偏高）。
function roundTripPattern({ sorted, market, config, p }) {
  const openLots = new Map();
  const evidence = [];
  const unevaluated = [];
  const byDate = new Map();
  for (const t of sorted) {
    const r = resolveTradeIndex(market, t);
    if (!r.ok) {
      unevaluated.push({ trade_id: t.trade_id, trade_date: t.trade_date, symbol: t.symbol, code: r.code, message: r.message });
      continue;
    }
    const key = `${t.trade_date}|${t.symbol}`;
    if (!byDate.has(key)) byDate.set(key, { date: t.trade_date, symbol: t.symbol, index: r.index, buys: [], sells: [] });
    byDate.get(key)[t.side === 'buy' ? 'buys' : 'sells'].push(t);
  }
  for (const group of byDate.values()) {
    // 先处理卖出：只与更早日期的买入配对；同日本组买入在卖出之后再入账。
    for (const sell of group.sells) {
      const lots = openLots.get(sell.symbol) ?? [];
      let remaining = sell.quantity;
      const matched = [];
      while (remaining > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(remaining, lot.remaining);
        lot.remaining -= take;
        remaining -= take;
        matched.push({ trade_id: lot.trade.trade_id, trade_date: lot.trade.trade_date, quantity: take, index: lot.index });
        if (lot.remaining <= 0) lots.shift();
      }
      if (!matched.length) continue;
      const gap = group.index - matched[0].index;
      evidence.push({
        trade_id: sell.trade_id,
        trade_date: sell.trade_date,
        symbol: sell.symbol,
        price: sell.price,
        quantity: sell.quantity,
        matched_quantity: sell.quantity - remaining,
        buy_trade_ids: matched.map((m) => m.trade_id),
        gap_days: gap,
        display: { gap_days: `${gap} 个交易日` },
        source: sell.source,
      });
    }
    for (const buy of group.buys) {
      if (!openLots.has(buy.symbol)) openLots.set(buy.symbol, []);
      openLots.get(buy.symbol).push({ trade: buy, remaining: buy.quantity, index: group.index });
    }
  }
  const n = evidence.length;
  const status = n >= p.min_samples ? '成立' : '证据不足';
  const conclusion = status === '成立'
    ? `本账单出现 n=${n} 次完整往返（买入后有卖出），达到最小样本 ${p.min_samples}：交易频率偏高（候选口径；只描述频率，不评价交易好坏，F-5.1）`
    : `完整往返 n=${n} < 最小样本 ${p.min_samples}：证据不足，不下频率结论（F-10.3 / PRD:234）`;
  const card = {
    pattern_id: p.pattern_id,
    name: p.name,
    implemented: true,
    status,
    sample_n: n,
    evaluated_n: n,
    min_samples: p.min_samples,
    buy_count: sorted.filter((t) => t.side === 'buy').length,
    sell_count: sorted.filter((t) => t.side === 'sell').length,
    round_trip_count: n,
    conclusion,
    rule: {
      side: '交易',
      window: '买入后完成卖出',
      comparator: '≥',
      threshold: p.threshold_round_trips,
      threshold_display: `${p.threshold_round_trips} 次往返`,
    },
    check_method: '按标的先进先出配对：每笔卖出与更早日期未平仓的买入按数量匹配，计一次完整往返；同日买卖顺序未知，不配对；卖出超出持仓的数量不计入；不读取价格、不做盈亏判断',
    threshold_meta: { config_version: config.version, source: config.source },
    evidence,
    evaluated_others: [],
    unevaluated,
  };
  const hypothesis = hypothesisOf(
    card,
    `存在“${p.name}”模式：完整往返笔数 ≥ ${p.threshold_round_trips}（阈值候选，F-5.1；只描述频率，不评价交易好坏）`,
  );
  return { card, hypothesis };
}

export function buildPatternList({ trades, market, config = PATTERN_CONFIG }) {
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('buildPatternList：trades 为空，无行为发现输入');
  if (typeof market?.resolveValuation !== 'function' || typeof market?.getClose !== 'function') {
    throw new TypeError('buildPatternList：market 须为 createMarketCache 实例');
  }
  const sorted = sortTrades(trades);
  const buyCount = sorted.filter((t) => t.side === 'buy').length;
  const cards = [];
  const hypotheses = [];
  for (const p of Object.values(config.patterns)) {
    let built;
    if (p.kind === 'rise_before_buy') built = chasePattern({ sorted, market, config, p });
    else if (p.kind === 'sell_rebuy_window' || p.kind === 'buy_sell_window') built = pairPattern({ sorted, market, config, p });
    else if (p.kind === 'round_trips') built = roundTripPattern({ sorted, market, config, p });
    else continue;
    cards.push(built.card);
    hypotheses.push(built.hypothesis);
  }
  return {
    config_version: config.version,
    config_source: config.source,
    scope: {
      trade_count: trades.length,
      buy_count: buyCount,
      sell_count: trades.length - buyCount,
      pattern_count: cards.length,
    },
    patterns: cards,
    hypotheses,
    notes: [
      '“清单是唯一事实出口”限定于行为发现模块（F-10.6）；对话解释须引用本清单 pattern_id 与成交 ID（F-10.4）。',
      `当前登记 ${cards.length} 条候选模式（追高买入 / 卖出后两日内买回 / 买入后三日内卖出 / 交易频率偏高）；PRD 完整规则副本未到位，不虚构其余模式名与阈值（F-5.1）。`,
      '回看窗口、往返窗口与阈值均为候选占位，待负责人确认后替换并升配置版本。',
      '结论三态（成立/不成立/证据不足）：观测充分性门槛＝最小重复数（同为 min_samples，候选）；不利结论照实、不与“证据不足”混同（T1-14 / F-10.3）。',
    ],
  };
}
