// 沪深 300 第三线：把指数收盘按“与本次单笔反事实相同的买入本金”折算，只作同额对照。
// 边界：起点必须与反事实序列首日一致；缺指数收盘的日期留空并计数，不回落其他日期、不猜值。
// 该线不参与任何收益、损耗或规则判定，也不改写 replaceSell 的 actual/ghost/cf。

export const BENCHMARK_LINE_VERSION = 'benchmark-line-1';

export function buildBenchmarkLine({ points, buyCost, closeOf, meta = null } = {}) {
  if (!Array.isArray(points) || points.length === 0) {
    return { available: false, reason: 'E_BENCHMARK_POINTS_MISSING' };
  }
  if (!Number.isFinite(buyCost) || buyCost <= 0) {
    return { available: false, reason: 'E_BENCHMARK_COST_MISSING' };
  }
  if (!meta || typeof meta !== 'object' || typeof closeOf !== 'function') {
    return { available: false, reason: 'E_BENCHMARK_META_MISSING' };
  }
  const baseDate = points[0].date;
  const baseClose = closeOf(baseDate);
  if (!Number.isFinite(baseClose) || baseClose <= 0) {
    return { available: false, reason: 'E_BENCHMARK_BASE_MISSING', base_date: baseDate };
  }
  const missing = [];
  const enriched = points.map((point) => {
    const close = closeOf(point.date);
    if (!Number.isFinite(close) || close <= 0) {
      if (!missing.includes(point.date)) missing.push(point.date);
      return { ...point, benchmark: null };
    }
    return { ...point, benchmark: buyCost * close / baseClose };
  });
  return {
    available: true,
    points: enriched,
    meta: {
      version: BENCHMARK_LINE_VERSION,
      name: typeof meta.name === 'string' ? meta.name : '沪深300',
      ts_code: typeof meta.ts_code === 'string' ? meta.ts_code : null,
      source: typeof meta.source === 'string' ? meta.source : null,
      base_date: baseDate,
      base_close: baseClose,
      base_value: buyCost,
      complete: missing.length === 0,
      missing_dates: missing,
    },
  };
}
