// M1-C5 行为发现引擎（F-10）—— 情境切分→重复模式→样本数 n＋成交明细＋证据状态。
// 边界：纯函数；输入为标准化交易（csvNormalize.js 输出同形）＋行情缓存引擎实例（marketCache.js）；不发网络请求。
// 口径：F-10.2 每条模式含 模式名/结论状态/样本数 n/成交记录 ID/阈值与检验方式/证据与计算路径；
//       F-10.3 与 PRD:234 —— 样本不足显示“证据不足”，不下确定结论；F-10.6 “清单是唯一事实出口”限定于本模块；
//       行情取值遵循缓存引擎语义（B2 不复权、B3 不晚于请求日的最近交易日、B4 缺价不回落、R2 范围外不支持）。
// 范围（v1，降级）：仅实现基线点名的“追高买入”；其余 PRD 模式清单未到位（PRD 副本在负责人本机），
//       不虚构模式名与阈值。回看窗口与阈值为候选占位（F-5.1 要求按 PRD 固定后替换并升配置版本）。
// 非已冻结公式：本模块 rise 为行为判定中间量，未入 m0/calc-baseline 公式表（不擅自新增 formula_id）。

import { fmtPct } from './display.js';
import { sortTrades } from './indicators.js';

export const BEHAVIOR_CODES = Object.freeze({
  PRICE_MISSING: 'E_PRICE_MISSING', // 窗口端点缺收盘价（B4 不回落）
  WINDOW_BEYOND_CACHE: 'E_WINDOW_BEYOND_CACHE', // 回看窗口早于缓存交易日起点（R2 不支持，不静默外推）
});

export const PATTERN_CONFIG = Object.freeze({
  version: 'candidate-1',
  source: '候选占位（PRD 完整规则副本未到位）：回看窗口/阈值/最小样本数均为待确认参数，按 F-5.1 待负责人确认后替换',
  patterns: Object.freeze({
    chase_high_buy: Object.freeze({
      pattern_id: 'chase_high_buy',
      name: '追高买入',
      side: 'buy',
      lookback_days: 5,
      rise_threshold: 0.1,
      min_samples: 2,
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

export function buildPatternList({ trades, market, config = PATTERN_CONFIG }) {
  if (!Array.isArray(trades) || trades.length === 0) throw new TypeError('buildPatternList：trades 为空，无行为发现输入');
  if (typeof market?.resolveValuation !== 'function' || typeof market?.getClose !== 'function') {
    throw new TypeError('buildPatternList：market 须为 createMarketCache 实例');
  }
  const p = config.patterns.chase_high_buy;
  const sorted = sortTrades(trades);
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
  const status = n >= p.min_samples ? '成立' : '证据不足';
  const card = {
    pattern_id: p.pattern_id,
    name: p.name,
    implemented: true,
    status,
    sample_n: n,
    min_samples: p.min_samples,
    buy_count: buyCount,
    conclusion:
      status === '成立'
        ? `样本数 n=${n} ≥ 最小样本 ${p.min_samples}：出现重复模式（候选阈值；不宣称阈值为已验证的普适标准，F-5.1）`
        : `样本数 n=${n} < 最小样本 ${p.min_samples}：证据不足，不下确定结论（F-10.3 / PRD:234）`,
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
  return {
    config_version: config.version,
    config_source: config.source,
    scope: { trade_count: trades.length, buy_count: buyCount, sell_count: trades.length - buyCount },
    patterns: [card],
    notes: [
      '“清单是唯一事实出口”限定于行为发现模块（F-10.6）；对话解释须引用本清单 pattern_id 与成交 ID（F-10.4）。',
      '其余 PRD 模式清单未到位（PRD 副本在负责人本机）：不虚构模式名与阈值（F-5.1），待副本后集中登记。',
      '回看窗口与阈值为候选占位，待负责人确认后替换并升配置版本。',
    ],
  };
}
