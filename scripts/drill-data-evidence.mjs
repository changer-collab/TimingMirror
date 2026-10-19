// M2-C4 数据侧证据复跑（R1 可复算 + R2 缓存范围提示）。
// 仅本地合成夹具与已签收行情缓存；不联网、不读账户数据、不替代页面演练。
// 断言值来自 docs/yinchen/m2c4-drill-prep.md §1.3/§2.3；若引擎或夹具口径变化，本脚本失败并提示同步文档。
import { readFileSync } from 'node:fs';
import { assessCacheDoc, createMarketCache, fromFixtures, fromPullDraft } from '../src/engine/marketCache.js';
import { parseCsvText, normalizeRows } from '../src/engine/csvNormalize.js';
import { computeIndicators } from '../src/engine/indicators.js';
import { buildVerifyReport } from '../src/engine/verify.js';

const REPO = new URL('../', import.meta.url);
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const near = (a, b, tol = 1e-9) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, REPO), 'utf8'));
const readText = (path) => readFileSync(new URL(path, REPO), 'utf8');

function tradesOf(path) {
  const name = path.split('/').pop();
  const normalized = normalizeRows(parseCsvText(readText(path)), name);
  if (normalized.blocked) throw new Error(`${name} 标准化被阻断：${JSON.stringify(normalized.errors)}`);
  return normalized.trades;
}

function scope(report, key) {
  return key === 'portfolio' ? report.portfolio : report.per_stock[key];
}

/* ---- R1：演示账单 A/A′ 受影响指标按预期变化，不受影响指标允许不变 ---- */
const fxMarket = createMarketCache(fromFixtures(
  readJson('m0/market-cache/fixtures/mock-calendar.json'),
  readJson('m0/market-cache/fixtures/mock-daily-bars.json'),
));
const effectiveDate = fxMarket.tradingDays.at(-1);
const tradesA = tradesOf('m0/csv-input/fixtures/demo-bill.csv');
const tradesAp = tradesOf('m0/csv-input/fixtures/demo-bill-aprime.csv');

check('R1 估值日=合成夹具末日 2024-10-11', effectiveDate === '2024-10-11', effectiveDate);
check('R1 估值日不早于账单末笔 2024-10-10', fxMarket.checkLastTrade(effectiveDate, '2024-10-10').blocked === false);
const closes = Object.fromEntries(fxMarket.symbols.map((s) => [s, fxMarket.getClose(s, effectiveDate)]));
check('R1 估值日不复权 close 与文档一致（108 / 1580 / 57）', eq(closes, { '888888': 1580, '000000': 108, '001234': 57 }), JSON.stringify(closes));

const rA = computeIndicators({ trades: tradesA, closes });
const rAp = computeIndicators({ trades: tradesAp, closes });
const a000 = scope(rA, '000000');
const b000 = scope(rAp, '000000');
check('R1 000000 actualValue 22000→23000（+1,000）', near(a000.actualValue, 22000) && near(b000.actualValue, 23000), `${a000.actualValue}→${b000.actualValue}`);
check('R1 000000 dragMoney -400→-1400（-1,000）', near(a000.dragMoney, -400) && near(b000.dragMoney, -1400), `${a000.dragMoney}→${b000.dragMoney}`);
check('R1 000000 drag -2.0pp→-7.0pp', near(a000.drag, -0.02) && near(b000.drag, -0.07), `${a000.drag}→${b000.drag}`);

const a888 = scope(rA, '888888');
const b888 = scope(rAp, '888888');
check('R1 888888 不受影响（actualValue 14700、dragMoney 1100、drag 7.33%）',
  near(a888.actualValue, 14700) && near(b888.actualValue, 14700)
  && near(a888.dragMoney, 1100) && near(b888.dragMoney, 1100)
  && near(a888.drag, 1100 / 15000) && near(b888.drag, 1100 / 15000),
  `${a888.actualValue}/${b888.actualValue}, ${a888.dragMoney}/${b888.dragMoney}`);

const aPool = rA.portfolio;
const bPool = rAp.portfolio;
check('R1 组合 actualValue 36700→37700', near(aPool.actualValue, 36700) && near(bPool.actualValue, 37700), `${aPool.actualValue}→${bPool.actualValue}`);
check('R1 组合 dragMoney +700→-300', near(aPool.dragMoney, 700) && near(bPool.dragMoney, -300), `${aPool.dragMoney}→${bPool.dragMoney}`);
check('R1 组合 drag +2.0pp→-0.9pp', near(aPool.drag, 0.02) && near(bPool.drag, -300 / 35000), `${aPool.drag}→${bPool.drag}`);

const vA = buildVerifyReport({ report: rA, trades: tradesA, closes });
const vAp = buildVerifyReport({ report: rAp, trades: tradesAp, closes });
check('R1 A 验算 26/26、恒等式 0 失败', vA.summary.n_facts === 26 && vA.summary.pass === 26 && vA.summary.fail === 0 && vA.summary.identities_fail === 0, JSON.stringify(vA.summary));
check('R1 A′ 验算 26/26、恒等式 0 失败', vAp.summary.n_facts === 26 && vAp.summary.pass === 26 && vAp.summary.fail === 0 && vAp.summary.identities_fail === 0, JSON.stringify(vAp.summary));

/* ---- R2：范围映射 / 范围外日期 / 范围外标的 / 早于末笔 / 缺价不回落 ---- */
const cacheDoc = readJson('data/market-cache.json');
const gate = assessCacheDoc(cacheDoc);
check('R2 签收门：data/market-cache.json 通过（signed、manifest-0.2）',
  gate.usable === true && gate.signed === true && gate.manifest_version === 'manifest-0.2'
  && gate.accepted_by === 'changer-collab' && gate.accepted_date === '2026-10-19',
  JSON.stringify(gate));
const signedMarket = createMarketCache(fromPullDraft(cacheDoc));
const days = signedMarket.tradingDays;
check('R2 签收范围 2023-01-01..2025-12-31、727 个交易日、首末 2023-01-03..2025-12-31',
  eq(signedMarket.range, { start: '2023-01-01', end: '2025-12-31' })
  && days.length === 727 && days[0] === '2023-01-03' && days.at(-1) === '2025-12-31',
  `${JSON.stringify(signedMarket.range)} / ${days.length} / ${days[0]}..${days.at(-1)}`);

const vHol = signedMarket.resolveValuation('2025-10-01');
check('R2 非交易日 2025-10-01 → 2025-09-30', !vHol.blocked && vHol.effective_date === '2025-09-30', JSON.stringify(vHol));
for (const d of ['2022-06-01', '2026-01-05']) {
  const v = signedMarket.resolveValuation(d);
  check(`R2 范围外日期 ${d} → E_VALUATION_OUT_OF_RANGE`, v.blocked && v.code === 'E_VALUATION_OUT_OF_RANGE', JSON.stringify(v));
}
const rUnknown = signedMarket.resolvePrices(['000001'], '2025-12-31');
check('R2 范围外标的 000001 → E_PRICE_MISSING 且 no_fallback_used、组合阻断',
  rUnknown.per_symbol['000001'].blocked === true
  && rUnknown.per_symbol['000001'].code === 'E_PRICE_MISSING'
  && rUnknown.per_symbol['000001'].no_fallback_used === true
  && rUnknown.portfolio.blocked === true,
  JSON.stringify(rUnknown));
const lastCheck = signedMarket.checkLastTrade('2024-10-01', '2024-10-08');
check('R2 估值日 2024-10-01 早于末笔 2024-10-08 → E_VALUATION_BEFORE_LAST_TRADE', lastCheck.blocked && lastCheck.code === 'E_VALUATION_BEFORE_LAST_TRADE', JSON.stringify(lastCheck));
const fxMissing = fxMarket.resolvePrices(fxMarket.symbols, '2024-10-10');
check('R2 合成夹具 2024-10-10：888888 缺价阻断、000000/001234 正常、组合阻断',
  fxMissing.per_symbol['888888'].blocked === true && fxMissing.per_symbol['888888'].no_fallback_used === true
  && fxMissing.per_symbol['000000'].blocked === false && fxMissing.per_symbol['000000'].close === 107
  && fxMissing.per_symbol['001234'].blocked === false && fxMissing.per_symbol['001234'].close === 56
  && fxMissing.portfolio.blocked === true,
  JSON.stringify(fxMissing));

/* ---- 输出 ---- */
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   → ${r.detail}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n== M2-C4 数据侧证据：合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}（不替代页面演练）==`);
process.exit(failed.length ? 1 : 0);
