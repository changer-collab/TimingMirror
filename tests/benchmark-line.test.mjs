#!/usr/bin/env node
/**
 * 沪深 300 第三线（src/engine/benchmarkLine.js + marketCache 基准序列）
 * 边界：只验证同额折算、缺数留空、基准形状校验；不验证真实指数行情正确性。
 */
import { BENCHMARK_LINE_VERSION, buildBenchmarkLine } from '../src/engine/benchmarkLine.js';
import { createMarketCache, fromPullDraft, normalizeBenchmarkDoc } from '../src/engine/marketCache.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-9;

const POINTS = [
  { date: '2024-01-02', close: 100, actual: 1000, ghost: 1000, cf: 1000, gap: 0 },
  { date: '2024-01-03', close: 110, actual: 1000, ghost: 1100, cf: 1100, gap: 100 },
  { date: '2024-01-04', close: 105, actual: 1000, ghost: 1050, cf: 900, gap: -100 },
  { date: '2024-01-05', close: 120, actual: 1000, ghost: 1200, cf: 1200, gap: 200 },
];
const BENCH = {
  ts_code: '000300.SH',
  name: '沪深300',
  source: 'tushare.index_daily',
  bars: [
    { date: '2024-01-02', close: 4000 },
    { date: '2024-01-03', close: 4400 },
    { date: '2024-01-04', close: 4200 },
    { date: '2024-01-05', close: 4600 },
  ],
};

{
  const closes = new Map(BENCH.bars.map((b) => [b.date, b.close]));
  const line = buildBenchmarkLine({
    points: POINTS,
    buyCost: 1000,
    closeOf: (d) => closes.get(d) ?? null,
    meta: BENCH,
  });
  check('第三线：同额折算到买入本金（4000→4400 = 1100）', line.available === true
    && near(line.points[0].benchmark, 1000) && near(line.points[1].benchmark, 1100)
    && near(line.points[2].benchmark, 1050) && near(line.points[3].benchmark, 1150), JSON.stringify(line.points));
  check('第三线：元信息含版本、基准日、本金、完整标记', line.meta.version === BENCHMARK_LINE_VERSION
    && line.meta.base_date === '2024-01-02' && line.meta.base_close === 4000
    && line.meta.base_value === 1000 && line.meta.complete === true
    && line.meta.missing_dates.length === 0 && line.meta.source === 'tushare.index_daily', JSON.stringify(line.meta));
  check('第三线：不改写 actual/ghost/cf/gap', line.points.every((p, i) => p.actual === POINTS[i].actual
    && p.ghost === POINTS[i].ghost && p.cf === POINTS[i].cf && p.gap === POINTS[i].gap));
  check('第三线：不修改输入点', POINTS.every((p) => !('benchmark' in p)));
}

{
  const closes = new Map([['2024-01-02', 4000], ['2024-01-03', 4400], ['2024-01-05', 4600]]);
  const line = buildBenchmarkLine({
    points: POINTS,
    buyCost: 1000,
    closeOf: (d) => closes.get(d) ?? null,
    meta: BENCH,
  });
  check('第三线：缺指数收盘的日期留空并计数，不回落', line.available === true
    && line.points[2].benchmark === null && line.meta.complete === false
    && JSON.stringify(line.meta.missing_dates) === JSON.stringify(['2024-01-04']), JSON.stringify(line.meta));
}

{
  const line = buildBenchmarkLine({
    points: POINTS,
    buyCost: 1000,
    closeOf: () => null,
    meta: BENCH,
  });
  check('第三线：起点无指数收盘 → 明确不可用，不绘制', line.available === false
    && line.reason === 'E_BENCHMARK_BASE_MISSING' && line.base_date === '2024-01-02', JSON.stringify(line));
}

{
  const noPoints = buildBenchmarkLine({ points: [], buyCost: 1000, closeOf: () => 1, meta: BENCH });
  const noCost = buildBenchmarkLine({ points: POINTS, buyCost: 0, closeOf: () => 1, meta: BENCH });
  const noMeta = buildBenchmarkLine({ points: POINTS, buyCost: 1000, closeOf: () => 1 });
  check('第三线：缺少点/本金/元信息均明确不可用', noPoints.available === false && noPoints.reason === 'E_BENCHMARK_POINTS_MISSING'
    && noCost.available === false && noCost.reason === 'E_BENCHMARK_COST_MISSING'
    && noMeta.available === false && noMeta.reason === 'E_BENCHMARK_META_MISSING');
}

{
  const cache = createMarketCache({
    tradingDays: BENCH.bars.map((b) => b.date),
    range: { start: '2024-01-02', end: '2024-01-05' },
    symbols: { '000001': { bars: [{ date: '2024-01-02', close: 10 }], bars_fwdadj: [{ date: '2024-01-02', close: 10 }] } },
    benchmark: { available: true, ...BENCH },
  });
  check('行情缓存：暴露基准序列与逐日指数收盘', cache.benchmark?.name === '沪深300'
    && cache.benchmark.ts_code === '000300.SH'
    && cache.getBenchmarkClose('2024-01-03') === 4400
    && cache.getBenchmarkClose('2024-01-06') === null, JSON.stringify(cache.benchmark));
  const pulled = fromPullDraft({
    calendar: { trading_days: BENCH.bars.map((b) => b.date) },
    manifest: { date_range: { start: '2024-01-02', end: '2024-01-05' } },
    symbols: { '000001': { bars: [{ date: '2024-01-02', close: 10 }], bars_fwdadj: [] } },
    benchmark: { available: true, ...BENCH },
  });
  check('行情缓存：fromPullDraft 透传动态响应中的基准序列', pulled.benchmark?.available === true
    && pulled.benchmark.bars.length === 4);
}

{
  const days = BENCH.bars.map((b) => b.date);
  const invalidBars = [
    [{ date: '2024-01-02', close: 4000 }, { date: '2024-01-03', close: 0 }],
    [{ date: '2024-01-03', close: 4000 }, { date: '2024-01-02', close: 4100 }],
    [{ date: '2024-01-06', close: 4000 }],
    [{ date: '2024-01-02', close: '4000' }],
  ];
  check('基准校验：非法 close/乱序/越界日期/非数字一律忽略', invalidBars.every((bars) => normalizeBenchmarkDoc({
    available: true, ts_code: '000300.SH', bars,
  }, days) === null));
  const cache = createMarketCache({
    tradingDays: days,
    range: { start: '2024-01-02', end: '2024-01-05' },
    symbols: { '000001': { bars: [], bars_fwdadj: [] } },
    benchmark: { available: false, ts_code: '000300.SH', reason: 'E_BENCHMARK_UNAVAILABLE' },
  });
  check('基准校验：服务端标记不可用时缓存不伪造第三线', cache.benchmark === null && cache.getBenchmarkClose('2024-01-02') === null);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  if (!r.ok) console.log(`FAIL  ${r.name}   → ${r.detail}`);
}
console.log(`\n== 沪深300第三线 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
if (failed.length > 0) process.exit(1);
