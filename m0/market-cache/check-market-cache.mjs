#!/usr/bin/env node
/**
 * M0 · 行情缓存候选接口 —— 合成样例离线校验（v1.1，含本次审校修订）
 *
 * 定位：按 schema.candidate.json 的候选语义，对 fixtures 下 mock 样例执行场景校验
 *       （S1–S8：正常取价/非交易日映射/缺价与组合阻断/超范围/早于账单末日/股数事件/快照元信息）
 *       与分红对齐手算复核。
 * 边界：非产品实现（产品侧为 M1-C1）；全部数据为合成夹具，非真实行情；
 *       通过仅证明候选语义与样例一致，不证明真实行情可用、产品引擎或端到端验证通过。
 * 运行：node m0/market-cache/check-market-cache.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = join(HERE, 'fixtures');
const load = (f) => JSON.parse(readFileSync(join(FX, f), 'utf8'));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const calendar = load('mock-calendar.json');
const cache = load('mock-daily-bars.json');
const events = load('mock-share-events.json');
const scenarios = load('scenarios.expected.json');
const dividendCase = load('dividend-alignment.json');

const DAYS = calendar.trading_days;
const RANGE = cache.snapshot.range;

function resolveValuation(requested) {
  if (requested < RANGE.start || requested > RANGE.end) {
    return { blocked: true, code: 'E_VALUATION_OUT_OF_RANGE', effective_date: null, no_silent_clamp: true };
  }
  const effective = [...DAYS].reverse().find((d) => d <= requested) ?? null;
  return { effective_date: effective, blocked: false };
}

function getClose(symbol, date, series) {
  const bars = series === 'fwdadj' ? cache.symbols[symbol]?.bars_fwdadj : cache.symbols[symbol]?.bars;
  const bar = bars?.find((b) => b.date === date);
  return bar ? bar.close : null;
}

function eventHit(symbol, start, end) {
  return events.events.find((e) => e.symbol === symbol && e.effective_date >= start && e.effective_date <= end) ?? null;
}

function runScenario(id, input) {
  switch (id) {
    case 'S1-normal': {
      const v = resolveValuation(input.requested_date);
      return { ...v, close_unadj: getClose(input.symbol, v.effective_date, 'unadj'), close_fwdadj: getClose(input.symbol, v.effective_date, 'fwdadj'), used_series: 'unadjusted' };
    }
    case 'S2-nontrading': {
      const v = resolveValuation(input.requested_date);
      return { ...v, close_unadj: getClose(input.symbol, v.effective_date, 'unadj'), used_series: 'unadjusted' };
    }
    case 'S3-missing-price': {
      const v = resolveValuation(input.requested_date);
      const per = {};
      let anyMissing = false;
      for (const s of input.symbols) {
        const price = getClose(s, v.effective_date, 'unadj');
        if (price === null) { per[s] = { blocked: true, code: 'E_PRICE_MISSING', mark: '数据缺失', no_fallback_used: true }; anyMissing = true; }
        else per[s] = { blocked: false, close_unadj: price };
      }
      return { effective_date: v.effective_date, ...per, portfolio: { blocked: anyMissing, recomputed_with_remaining: false } };
    }
    case 'S4-out-of-range':
      return resolveValuation(input.requested_date);
    case 'S5-before-last-trade': {
      const v = resolveValuation(input.requested_date);
      const blocked = v.effective_date !== null && v.effective_date < input.last_trade_date;
      return { effective_date: v.effective_date, blocked: blocked || v.blocked, code: blocked ? 'E_VALUATION_BEFORE_LAST_TRADE' : v.code };
    }
    case 'S6-event-actual': {
      const hit = eventHit(input.symbol, input.actual_interval[0], input.actual_interval[1]);
      return { blocked: !!hit, code: hit ? 'E_SHARE_EVENT_UNSUPPORTED' : null, mark: hit ? '超出支持范围' : null };
    }
    case 'S7-event-split-scope': {
      const a = eventHit(input.symbol, input.actual_interval[0], input.actual_interval[1]);
      const c = eventHit(input.symbol, input.counterfactual_interval[0], input.counterfactual_interval[1]);
      return { actual_blocked: !!a, counterfactual_blocked: !!c, code: c ? 'E_SHARE_EVENT_UNSUPPORTED' : null };
    }
    case 'S8-snapshot-meta': {
      const s = cache.snapshot;
      return {
        snapshot_id: s.snapshot_id,
        fetch_time_present: !!s.fetch_time,
        adjustment_basis: s.adjustment_basis,
        adjustment_basis_note: s.adjustment_basis_note,
        fields_distinct: s.snapshot_id !== s.fetch_time && s.adjustment_basis !== s.fetch_time && RANGE.start !== RANGE.end,
      };
    }
    default:
      return {};
  }
}

function compareExp(exp, got, path) {
  if (exp === null) { check(path, got === null || got === undefined, `got ${JSON.stringify(got)}`); return; }
  if (typeof exp === 'number') { check(path, Number.isFinite(got) && Math.abs(got - exp) <= 1e-9 * Math.max(1, Math.abs(exp), Math.abs(got)), `got ${got}`); return; }
  if (typeof exp === 'object') { for (const k of Object.keys(exp)) compareExp(exp[k], got?.[k], `${path}.${k}`); return; }
  check(path, got === exp, `got ${JSON.stringify(got)}`);
}

/* ---- 夹具来源性质：全部标记为合成 ---- */
for (const [name, obj] of [['mock-calendar', calendar], ['mock-daily-bars', cache], ['mock-share-events', events], ['scenarios.expected', scenarios], ['dividend-alignment', dividendCase]]) {
  check(`夹具标注：${name} 明确标记为合成`, obj.artifact === 'synthetic-fixture' && typeof obj.note === 'string' && obj.note.includes('合成'), JSON.stringify(obj.artifact));
}

/* ---- OHLC 完整性（基线 §4-2 纠正：两个序列 OHLC 必填） ---- */
{
  const bad = [];
  for (const [sym, s] of Object.entries(cache.symbols)) {
    for (const seriesKey of ['bars', 'bars_fwdadj']) {
      for (const b of s[seriesKey] ?? []) {
        const numsOk = ['open', 'high', 'low', 'close'].every((k) => Number.isFinite(b[k]));
        const rangeOk = numsOk && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close);
        if (!rangeOk) bad.push(`${sym}/${seriesKey}/${b.date}`);
      }
    }
  }
  check('OHLC 完整性：两序列 OHLC 齐全且 high≥max(o,c)、low≤min(o,c)', bad.length === 0, JSON.stringify(bad));
}

/* ---- S1–S8 场景校验 ---- */
for (const sc of scenarios.scenarios) {
  const got = runScenario(sc.id, sc.input);
  for (const k of Object.keys(sc.expected)) {
    compareExp(sc.expected[k], got[k], `场景 ${sc.id}（${sc.desc}）.${k}`);
  }
}

/* ---- 分红对齐手算案例（不可被前复权价格涨幅替代） ---- */
{
  const d = dividendCase;
  const buyCost = d.inputs.buy.price * d.inputs.buy.qty;
  const actualValue = d.inputs.buy.qty * d.inputs.end_unadj_close;
  const ghostValue = d.inputs.buy.qty * d.inputs.end_unadj_close;
  const actualRet = actualValue / buyCost - 1;
  const ghostRet = ghostValue / buyCost - 1;
  const dragMoney = ghostValue - actualValue;
  const drag = ghostRet - actualRet;
  const fwdChange = d.inputs.fwd_adj_series[1] / d.inputs.fwd_adj_series[0] - 1;
  const expect = d.expected;

  check('分红对齐：buyCost = 1,000', buyCost === expect.buyCost, buyCost);
  check('分红对齐：actualValue = 900（v1 分红未计入）', actualValue === expect.actualValue, actualValue);
  check('分红对齐：ghostValue = 900', ghostValue === expect.ghostValue, ghostValue);
  check('分红对齐：两条金额收益均 = −10%', Math.abs(actualRet - expect.actualRet) < 1e-12 && Math.abs(ghostRet - expect.ghostRet) < 1e-12, `${actualRet}/${ghostRet}`);
  check('分红对齐：dragMoney = 0 元', dragMoney === expect.dragMoney, dragMoney);
  check('分红对齐：drag = 0pp', Math.abs(drag - expect.drag) < 1e-12, drag);
  check('分红对齐：前复权序列涨幅 = 0%', Math.abs(fwdChange - expect.fwdadj_price_change) < 1e-12, fwdChange);
  const naive = fwdChange - actualRet; // 0 − (−0.1) = +0.1
  check('分红对齐：价格涨幅不得与金额收益直接相减（混算差 +10pp ≠ drag 0）', Math.abs(naive - 0.1) < 1e-12 && Math.abs(naive - drag) > 1e-9, `naive=${naive}, drag=${drag}`);
  const aligned = expect.aligned_with_dividend;
  const actualWithDiv = actualValue + d.inputs.buy.qty * d.inputs.cash_dividend_per_share;
  const ghostWithDiv = ghostValue + d.inputs.buy.qty * d.inputs.cash_dividend_per_share;
  check('分红对齐（对照）：一致计入分红 → 两路径均 0%（损耗仍 0）',
    Math.abs(actualWithDiv / buyCost - 1 - aligned.actualRet) < 1e-12 && Math.abs(ghostWithDiv / buyCost - 1 - aligned.ghostRet) < 1e-12 && aligned.drag === 0,
    `${actualWithDiv}/${ghostWithDiv}`);
}

/* ---- 输出 ---- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
