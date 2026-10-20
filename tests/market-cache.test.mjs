#!/usr/bin/env node
/**
 * M1-C1 · 行情缓存引擎单测（零依赖；node tests/market-cache.test.mjs）
 *
 * 输入：① 合成夹具 m0/market-cache/fixtures/（S1–S5 场景语义移植）
 *       ② 已签收缓存 data/market-cache.json（范围/节假日/无可用交易日/快照边界/签收门用例；
 *          该文件结构已由 npm run check 的核验区覆盖）
 * 边界：仅证明引擎函数语义与候选口径一致；不证明真实行情正确性；
 *       不涉及股数事件检测（C1：v1 不实现；300750 2023-04-26 靠演示避让与披露）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assessCacheDoc, assessDynamicCacheDoc, createMarketCache, fromFixtures, fromPullDraft, MARKET_CACHE_GATE_CODES, MARKET_DYNAMIC_GATE_CODES } from '../src/engine/marketCache.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const mc = createMarketCache(fromFixtures(
  load('m0/market-cache/fixtures/mock-calendar.json'),
  load('m0/market-cache/fixtures/mock-daily-bars.json'),
));

/* ---- S1 正常取价（交易日） ---- */
{
  const v = mc.resolveValuation('2024-10-09');
  check('S1：交易日取当日、未阻断', !v.blocked && v.effective_date === '2024-10-09', JSON.stringify(v));
  check('S1：不复权 close = 106.0（估值用序列）', mc.getClose('000000', '2024-10-09') === 106.0);
  check('S1：前复权 close = 104.5（仅展示用序列）', mc.getClose('000000', '2024-10-09', 'fwdadj') === 104.5);
}

/* ---- S2 非交易日映射（按适用日历最近交易日；不按数据共同日） ---- */
{
  const v = mc.resolveValuation('2024-10-03');
  check('S2：假期请求 10-03 → 09-30，且 requested_date 原样保留', !v.blocked && v.effective_date === '2024-09-30' && v.requested_date === '2024-10-03', JSON.stringify(v));
  check('S2：映射后 close = 104.0', mc.getClose('000000', v.effective_date) === 104.0);
}

/* ---- S3 缺价与组合阻断（不回退、不按剩余标的重算） ---- */
{
  const v = mc.resolveValuation('2024-10-10');
  const r = mc.resolvePrices(['000000', '888888'], v.effective_date);
  check('S3：000000 取价 107.0 未阻断', r.per_symbol['000000'].blocked === false && r.per_symbol['000000'].close === 107.0);
  check('S3：888888 缺价 → E_PRICE_MISSING 且标注无回退', r.per_symbol['888888'].blocked === true && r.per_symbol['888888'].code === 'E_PRICE_MISSING' && r.per_symbol['888888'].no_fallback_used === true);
  check('S3：组合阻断且不冒充完整（不按剩余标的重算）', r.portfolio.blocked === true && r.portfolio.code === 'E_PRICE_MISSING');
  check('S3：缺价日两个序列均缺（不复权/前复权一致）', mc.getClose('888888', '2024-10-10', 'fwdadj') === null);
  check('S3：同标的前一日有价 1570.0——引擎不自动回退到它', mc.getClose('888888', '2024-10-09') === 1570.0 && mc.getClose('888888', '2024-10-10') === null);
}

/* ---- S4 超范围阻断（不静默改期） ---- */
{
  const after = mc.resolveValuation('2026-01-05');
  check('S4：晚于范围 → E_VALUATION_OUT_OF_RANGE、effective=null', after.blocked === true && after.code === 'E_VALUATION_OUT_OF_RANGE' && after.effective_date === null);
  const before = mc.resolveValuation('2024-09-01');
  check('S4：早于范围 → 同样阻断', before.blocked === true && before.code === 'E_VALUATION_OUT_OF_RANGE' && before.effective_date === null);
}

/* ---- S5 有效估值日早于账单末笔交易日 ---- */
{
  const v = mc.resolveValuation('2024-10-09');
  const c = mc.checkLastTrade(v.effective_date, '2024-10-10');
  check('S5：10-09 早于末笔 10-10 → E_VALUATION_BEFORE_LAST_TRADE', !v.blocked && c.blocked === true && c.code === 'E_VALUATION_BEFORE_LAST_TRADE');
  check('S5：同日（末笔当日）不阻断', mc.checkLastTrade('2024-10-10', '2024-10-10').blocked === false);
  check('S5：晚于末笔不阻断', mc.checkLastTrade('2024-10-11', '2024-10-10').blocked === false);
}

/* ---- 输入边界（API 层拒绝非法输入，不猜测） ---- */
{
  let threw = false;
  try { mc.resolveValuation('2024/10/09'); } catch { threw = true; }
  check('边界：非法日期格式抛 TypeError', threw);
  threw = false;
  try { mc.getClose('000000', '2024-10-09', 'raw'); } catch { threw = true; }
  check('边界：非法序列名抛 TypeError（仅 unadj/fwdadj）', threw);
  check('边界：未知标的 → null（不抛错、不假造价格）', mc.getClose('999999', '2024-10-09') === null);
}

/* ---- R2 签收门：未冻结/未签收/形状不全一律不可用（不静默回退） ---- */
{
  const raw = load('data/market-cache.json');
  const ok = assessCacheDoc(raw);
  check('签收门：已签收缓存 usable（frozen + sign_off + 形状）', ok.usable === true && ok.signed === true && ok.accepted_by === raw.sign_off.accepted_by, JSON.stringify(ok));
  check('签收门：返回支持范围与固定 asOfDate', JSON.stringify(ok.symbols) === JSON.stringify(raw.manifest.symbols) && ok.asOfDate === raw.manifest.asOfDate && ok.range.start === raw.manifest.date_range.start, JSON.stringify(ok));
  const unsigned = structuredClone(raw); unsigned.sign_off.accepted_by = '';
  const r1 = assessCacheDoc(unsigned);
  check('签收门：sign_off 缺失 → NOT_SIGNED', r1.usable === false && r1.reason === MARKET_CACHE_GATE_CODES.NOT_SIGNED, JSON.stringify(r1));
  const unfrozen = structuredClone(raw); unfrozen.frozen = false;
  const r2 = assessCacheDoc(unfrozen);
  check('签收门：frozen=false → NOT_FROZEN', r2.usable === false && r2.reason === MARKET_CACHE_GATE_CODES.NOT_FROZEN, JSON.stringify(r2));
  const malformed = structuredClone(raw); delete malformed.calendar;
  const r3 = assessCacheDoc(malformed);
  check('签收门：结构缺失 → MALFORMED', r3.usable === false && r3.reason === MARKET_CACHE_GATE_CODES.MALFORMED, JSON.stringify(r3));
  const draft = structuredClone(raw); draft.artifact = 'market-cache-pull-draft';
  const r4 = assessCacheDoc(draft);
  check('签收门：草案 artifact → MALFORMED（不得冒充签收件）', r4.usable === false && r4.reason === MARKET_CACHE_GATE_CODES.MALFORMED, JSON.stringify(r4));
  const r5 = assessCacheDoc(null);
  check('签收门：空文档 → MALFORMED', r5.usable === false && r5.reason === MARKET_CACHE_GATE_CODES.MALFORMED, JSON.stringify(r5));
}

/* ---- 已签收缓存（data/market-cache.json）：范围/节假日/首个交易日/快照 ---- */
{
  const raw = load('data/market-cache.json');
  const signed = createMarketCache(fromPullDraft(raw));
  const days = signed.tradingDays;
  const asOf = '2025-12-31';

  const vEnd = signed.resolveValuation(asOf);
  check('已签收缓存：asOfDate 2025-12-31 为交易日、未阻断', days.includes(asOf) && !vEnd.blocked && vEnd.effective_date === asOf, JSON.stringify(vEnd));

  const hol = '2025-10-01';
  const vHol = signed.resolveValuation(hol);
  const expectedHol = [...days].reverse().find((d) => d <= hol);
  check('已签收缓存：国庆 2025-10-01 非交易日 → 取不晚于请求日的最近交易日', !days.includes(hol) && !vHol.blocked && vHol.effective_date === expectedHol, JSON.stringify(vHol));

  const vEarly = signed.resolveValuation('2023-01-02');
  check('已签收缓存：2023-01-02（区间内、首个交易日前）→ E_NO_EFFECTIVE_TRADING_DAY（候选新增码）', vEarly.blocked === true && vEarly.code === 'E_NO_EFFECTIVE_TRADING_DAY' && vEarly.effective_date === null, JSON.stringify(vEarly));

  const vFirst = signed.resolveValuation('2023-01-03');
  check('已签收缓存：首个交易日 2023-01-03 正常取价', !vFirst.blocked && vFirst.effective_date === '2023-01-03');

  const r = signed.resolvePrices(['600519', '300750', '601318'], asOf);
  const rawClose = (sym) => raw.symbols[sym].bars.find((b) => b.date === asOf).close;
  check('已签收缓存：三标的组合未阻断且金额与数据文件直读一致', !r.portfolio.blocked && ['600519', '300750', '601318'].every((s) => r.per_symbol[s].close === rawClose(s)));

  const snap = signed.snapshot;
  check('已签收缓存：快照要素分离（标识/抓取时间/复权基准分列；B6）', !!snap.snapshot_id && !!snap.fetch_time && !!snap.adjustment_basis && snap.snapshot_id !== snap.fetch_time && snap.adjustment_basis !== snap.fetch_time);

  const vOut = signed.resolveValuation('2026-01-05');
  check('已签收缓存：超出 2025-12-31 → E_VALUATION_OUT_OF_RANGE', vOut.blocked === true && vOut.code === 'E_VALUATION_OUT_OF_RANGE');
}

/* ---- 动态行情门：Tushare 响应形状/范围/序列（无人工签收，凭 fetched_at/snapshot_id/checksum 留痕） ---- */
{
  const mk = () => ({
    artifact: 'market-cache-dynamic',
    manifest_version: 'dynamic-v1',
    fetched_at: '2026-10-19T01:30:00.000Z',
    checksum: 'a'.repeat(64),
    manifest: { asOfDate: '2024-10-10', date_range: { start: '2024-10-01', end: '2024-10-10' }, symbols: ['000000'] },
    calendar: { trading_days: ['2024-10-08', '2024-10-09', '2024-10-10'] },
    symbols: {
      '000000': {
        bars: [{ date: '2024-10-09', close: 106 }, { date: '2024-10-10', close: 107 }],
        bars_fwdadj: [{ date: '2024-10-09', close: 104.5 }, { date: '2024-10-10', close: 105.5 }],
      },
    },
    snapshot: { snapshot_id: 'tushare-20241010-aaaaaaaa', latest_trade_date: '2024-10-10' },
    source: { provider: 'tushare' },
  });
  const g = assessDynamicCacheDoc(mk());
  check('动态门：合法 Tushare 响应 usable 且带拉取元数据', g.usable === true && g.dynamic === true && g.signed === false
    && g.provider === 'tushare' && g.fetched_at === '2026-10-19T01:30:00.000Z'
    && g.snapshot_id === 'tushare-20241010-aaaaaaaa' && g.checksum === 'a'.repeat(64)
    && g.latest_trade_date === '2024-10-10' && g.asOfDate === '2024-10-10', JSON.stringify(g));

  const badArtifact = mk(); badArtifact.artifact = 'market-cache-signed';
  check('动态门：静态签收件不能冒充动态响应', assessDynamicCacheDoc(badArtifact).usable === false
    && assessDynamicCacheDoc(badArtifact).reason === MARKET_DYNAMIC_GATE_CODES.NOT_DYNAMIC);
  check('静态门：动态响应不能冒充签收件', assessCacheDoc(mk()).usable === false
    && assessCacheDoc(mk()).reason === MARKET_CACHE_GATE_CODES.MALFORMED);

  const badProvider = mk(); badProvider.source.provider = 'akshare';
  check('动态门：provider 非 tushare → NOT_DYNAMIC', assessDynamicCacheDoc(badProvider).reason === MARKET_DYNAMIC_GATE_CODES.NOT_DYNAMIC);

  const badChecksum = mk(); badChecksum.checksum = 'abc';
  check('动态门：checksum 非 64 位十六进制 → MALFORMED', assessDynamicCacheDoc(badChecksum).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const badTime = mk(); badTime.fetched_at = '2026-10-19 01:30';
  check('动态门：fetched_at 非 ISO → MALFORMED', assessDynamicCacheDoc(badTime).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const badLatest = mk(); badLatest.snapshot.latest_trade_date = '2024-10-09';
  check('动态门：latest_trade_date 与 asOfDate 不一致 → MALFORMED', assessDynamicCacheDoc(badLatest).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const offCalendar = mk(); offCalendar.symbols['000000'].bars[1].date = '2024-10-11';
  check('动态门：bar 不在交易日历 → MALFORMED', assessDynamicCacheDoc(offCalendar).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const badClose = mk(); badClose.symbols['000000'].bars[0].close = 0;
  check('动态门：close 非正数 → MALFORMED', assessDynamicCacheDoc(badClose).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const unordered = mk(); unordered.symbols['000000'].bars.reverse();
  check('动态门：bar 日期乱序 → MALFORMED', assessDynamicCacheDoc(unordered).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const emptyBars = mk();
  emptyBars.manifest.symbols.push('888888');
  emptyBars.symbols['888888'] = { bars: [], bars_fwdadj: [] };
  check('动态门：某标的无 bar 可接受（缺价由市场段单独阻断）', assessDynamicCacheDoc(emptyBars).usable === true);

  const coverage = mk(); coverage.symbols['999999'] = coverage.symbols['000000']; delete coverage.symbols['000000'];
  check('动态门：标的覆盖与 manifest 不一致 → MALFORMED', assessDynamicCacheDoc(coverage).reason === MARKET_DYNAMIC_GATE_CODES.MALFORMED);

  const dynamicMarket = createMarketCache(fromPullDraft(mk()));
  check('动态门：通过后可按统一形状取价', dynamicMarket.getClose('000000', '2024-10-10') === 107
    && dynamicMarket.getClose('000000', '2024-10-10', 'fwdadj') === 105.5);
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
