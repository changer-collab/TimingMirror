#!/usr/bin/env node
/**
 * M1-C1 · 行情缓存引擎单测（零依赖；node tests/market-cache.test.mjs）
 *
 * 输入：① 合成夹具 m0/market-cache/fixtures/（S1–S5 场景语义移植）
 *       ② 拉数草案 data/market-cache.json（范围/节假日/无可用交易日/快照边界用例；
 *          该文件结构已由 npm run check 的核验区覆盖）
 * 边界：仅证明引擎函数语义与候选口径一致；不证明真实行情可用；
 *       不涉及股数事件检测（事件数据未提供，M3 未决；B5）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMarketCache, fromFixtures, fromPullDraft } from '../src/engine/marketCache.js';

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

/* ---- 拉数草案（data/market-cache.json）：范围/节假日/首个交易日/快照 ---- */
{
  const raw = load('data/market-cache.json');
  const draft = createMarketCache(fromPullDraft(raw));
  const days = draft.tradingDays;
  const asOf = '2025-12-31';

  const vEnd = draft.resolveValuation(asOf);
  check('草案：asOfDate 2025-12-31 为交易日、未阻断', days.includes(asOf) && !vEnd.blocked && vEnd.effective_date === asOf, JSON.stringify(vEnd));

  const hol = '2025-10-01';
  const vHol = draft.resolveValuation(hol);
  const expectedHol = [...days].reverse().find((d) => d <= hol);
  check('草案：国庆 2025-10-01 非交易日 → 取不晚于请求日的最近交易日', !days.includes(hol) && !vHol.blocked && vHol.effective_date === expectedHol, JSON.stringify(vHol));

  const vEarly = draft.resolveValuation('2023-01-02');
  check('草案：2023-01-02（区间内、首个交易日前）→ E_NO_EFFECTIVE_TRADING_DAY（候选新增码）', vEarly.blocked === true && vEarly.code === 'E_NO_EFFECTIVE_TRADING_DAY' && vEarly.effective_date === null, JSON.stringify(vEarly));

  const vFirst = draft.resolveValuation('2023-01-03');
  check('草案：首个交易日 2023-01-03 正常取价', !vFirst.blocked && vFirst.effective_date === '2023-01-03');

  const r = draft.resolvePrices(['600519', '300750', '601318'], asOf);
  const rawClose = (sym) => raw.symbols[sym].bars.find((b) => b.date === asOf).close;
  check('草案：三标的组合未阻断且金额与数据文件直读一致', !r.portfolio.blocked && ['600519', '300750', '601318'].every((s) => r.per_symbol[s].close === rawClose(s)));

  const snap = draft.snapshot;
  check('草案：快照要素分离（标识/抓取时间/复权基准分列；B6）', !!snap.snapshot_id && !!snap.fetch_time && !!snap.adjustment_basis && snap.snapshot_id !== snap.fetch_time && snap.adjustment_basis !== snap.fetch_time);

  const vOut = draft.resolveValuation('2026-01-05');
  check('草案：超出 2025-12-31 → E_VALUATION_OUT_OF_RANGE', vOut.blocked === true && vOut.code === 'E_VALUATION_OUT_OF_RANGE');
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
