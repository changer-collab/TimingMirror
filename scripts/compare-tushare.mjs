#!/usr/bin/env node
/**
 * 只读对比：Tushare Pro 行情 vs data/market-cache.json（已签收 akshare 缓存）
 *
 * 边界：只读公开行情；不写签名缓存、不改产品链路、不读取账户数据；
 *       TUSHARE_TOKEN 仅从环境变量读取，不落盘、不打印。
 * 运行：read -rsp "TUSHARE_TOKEN: " TUSHARE_TOKEN; echo; export TUSHARE_TOKEN
 *       node scripts/compare-tushare.mjs
 *       node scripts/compare-tushare.mjs --selftest
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessCacheDoc } from '../src/engine/marketCache.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PATH = resolve(REPO, 'data', 'market-cache.json');
const API_URL = 'https://api.tushare.pro';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT_RE = /^\d{8}$/;
const SYMBOL_RE = /^\d{6}$/;
const TOL = 1e-9;
const LOT_SIZE = 100;
// Tushare vol 单位为手（可带小数），缓存 volume 为股且为整手；±0.5 手覆盖手→股换算的整手舍入。
const VOLUME_TOL_SHARES = LOT_SIZE / 2 + 1e-6;

function usage() {
  return [
    '用法：',
    '  read -rsp "TUSHARE_TOKEN: " TUSHARE_TOKEN; echo; export TUSHARE_TOKEN',
    '  node scripts/compare-tushare.mjs [选项]',
    '',
    '选项：',
    '  --start=YYYY-MM-DD   对比区间起（默认取缓存 manifest.date_range.start）',
    '  --end=YYYY-MM-DD     对比区间止（默认取缓存 manifest.date_range.end）',
    '  --symbols=600519,... 对比标的（默认取缓存 manifest.symbols；必须是缓存内标的）',
    '  --adj-end=YYYY-MM-DD 复权因子拉取截止日（默认取缓存 snapshot.fetch_time 的日期）',
    '  --out=PATH           写出 JSON 报告（--out=- 输出到 stdout；不得指向缓存文件）',
    '  --selftest           用内置小样本校验对比逻辑（不联网、不读 token）',
    '  --help               显示本帮助',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { start: null, end: null, symbols: null, adjEnd: null, out: null, selftest: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--selftest') { opts.selftest = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    const eq = arg.indexOf('=');
    if (eq < 0) throw new Error(`参数缺少值：${arg}`);
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    if (key === 'start') opts.start = value;
    else if (key === 'end') opts.end = value;
    else if (key === 'symbols') opts.symbols = value;
    else if (key === 'adj-end') opts.adjEnd = value;
    else if (key === 'out') opts.out = value;
    else throw new Error(`未知参数：--${key}`);
  }
  return opts;
}

function assertDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) throw new Error(`${label} 必须为 YYYY-MM-DD：${value}`);
}

function compact(date) {
  return date.replaceAll('-', '');
}

function dashed(value) {
  if (typeof value !== 'string' || !COMPACT_RE.test(value)) throw new Error(`Tushare 日期格式异常：${value}`);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function dateFromIso(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return match ? match[1] : null;
}

function parseSymbols(value) {
  const list = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
  if (list.length === 0) throw new Error('--symbols 不能为空');
  for (const symbol of list) {
    if (!SYMBOL_RE.test(symbol)) throw new Error(`标的须为 6 位数字：${symbol}`);
  }
  return list;
}

function toTsCode(symbol) {
  if (/^6/.test(symbol)) return `${symbol}.SH`;
  if (/^[03]/.test(symbol)) return `${symbol}.SZ`;
  if (/^[48]/.test(symbol)) return `${symbol}.BJ`;
  throw new Error(`无法推断交易所后缀：${symbol}`);
}

async function fetchTushare(token, apiName, params, fields) {
  const body = JSON.stringify({ api_name: apiName, token, params, fields });
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        error.retryable = res.status >= 500;
        throw error;
      }
      const json = await res.json();
      if (json.code !== 0) {
        const error = new Error(`Tushare ${apiName} 返回 code=${json.code}：${json.msg}`);
        error.retryable = false;
        throw error;
      }
      const dataFields = json.data?.fields ?? [];
      const items = json.data?.items ?? [];
      return items.map((item) => Object.fromEntries(dataFields.map((f, i) => [f, item[i]])));
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === 2) break;
    }
  }
  throw lastError;
}

function numericSummary(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    count: values.length,
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const meanX = xs.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.slice(0, n).reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

function summarizeDates(dates) {
  return {
    count: dates.length,
    first: dates[0] ?? null,
    last: dates.at(-1) ?? null,
    samples: dates.slice(0, 10),
  };
}

function compareCalendar(cacheDays, tsDays) {
  const cacheSet = new Set(cacheDays);
  const tsSet = new Set(tsDays);
  const missingInTushare = cacheDays.filter((date) => !tsSet.has(date));
  const extraInTushare = tsDays.filter((date) => !cacheSet.has(date));
  return {
    cache_count: cacheDays.length,
    tushare_count: tsDays.length,
    missing_in_tushare: missingInTushare,
    extra_in_tushare: extraInTushare,
    equal: cacheDays.length === tsDays.length && missingInTushare.length === 0 && extraInTushare.length === 0,
  };
}

function compareNumericField({ cacheByDate, tsByDate, commonDates, cacheField, tsField, tsMultiplier = 1, tolerance = TOL }) {
  const diffs = [];
  for (const date of commonDates) {
    const cache = Number(cacheByDate.get(date)?.[cacheField]);
    const rawTushare = Number(tsByDate.get(date)?.[tsField]);
    if (!Number.isFinite(cache) || !Number.isFinite(rawTushare)) continue;
    const tushare = rawTushare * tsMultiplier;
    const abs = Math.abs(cache - tushare);
    const rel = abs / Math.max(Math.abs(cache), Math.abs(tushare), 1e-12);
    diffs.push({ date, cache, tushare, abs, rel });
  }
  if (diffs.length === 0) {
    return {
      count: 0,
      exact_equal_count: 0,
      equal_count: 0,
      rounding_only_count: 0,
      mismatch_count: 0,
      tolerance,
      max_abs_diff: null,
      max_abs_diff_date: null,
      max_rel_diff: null,
      mismatch_samples: [],
    };
  }
  const exactMismatches = diffs.filter((row) => row.abs > TOL);
  const mismatches = diffs.filter((row) => row.abs > tolerance);
  const worst = diffs.reduce((best, row) => (row.abs > best.abs ? row : best), diffs[0]);
  return {
    count: diffs.length,
    exact_equal_count: diffs.length - exactMismatches.length,
    equal_count: diffs.length - mismatches.length,
    rounding_only_count: exactMismatches.length - mismatches.length,
    mismatch_count: mismatches.length,
    tolerance,
    max_abs_diff: worst.abs,
    max_abs_diff_date: worst.date,
    max_abs_diff_cache: worst.cache,
    max_abs_diff_tushare: worst.tushare,
    max_rel_diff: worst.rel,
    mismatch_samples: mismatches.slice(0, 10),
  };
}

function buildAdjLookup(rows) {
  const map = new Map();
  for (const row of rows) {
    const date = dashed(row.trade_date);
    const factor = Number(row.adj_factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`adj_factor 非法（${row.trade_date}）：${row.adj_factor}`);
    }
    map.set(date, factor);
  }
  const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  function asOf(date) {
    let low = 0;
    let high = entries.length - 1;
    let found = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (entries[middle][0] <= date) {
        found = entries[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found ? { date: found[0], factor: found[1] } : null;
  }
  return { entries, asOf };
}

function levelRatio(cacheValues, tushareValues) {
  const ratios = [];
  for (let i = 0; i < cacheValues.length; i += 1) {
    if (cacheValues[i] !== 0 && tushareValues[i] !== 0) ratios.push(cacheValues[i] / tushareValues[i]);
  }
  const summary = numericSummary(ratios);
  if (!summary) return null;
  return {
    ...summary,
    max_over_min: summary.min === 0 ? null : summary.max / summary.min,
    constant: summary.min !== 0 && summary.max / summary.min - 1 <= 1e-9,
  };
}

function normalizedDiff(dates, cacheValues, tushareValues) {
  const n = Math.min(cacheValues.length, tushareValues.length);
  if (n < 2) return null;
  const cacheLast = cacheValues[n - 1];
  const tushareLast = tushareValues[n - 1];
  if (cacheLast === 0 || tushareLast === 0) return null;
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const cache = cacheValues[i] / cacheLast;
    const tushare = tushareValues[i] / tushareLast;
    rows.push({ date: dates[i], cache, tushare, abs: Math.abs(cache - tushare) });
  }
  const worst = rows.reduce((best, row) => (row.abs > best.abs ? row : best), rows[0]);
  return {
    count: rows.length,
    max_abs_diff: worst.abs,
    max_abs_diff_date: worst.date,
    mean_abs_diff: rows.reduce((sum, row) => sum + row.abs, 0) / rows.length,
    mismatch_count: rows.filter((row) => row.abs > TOL).length,
    mismatch_samples: rows.filter((row) => row.abs > TOL).slice(0, 10),
  };
}

function returnDiff(dates, cacheValues, tushareValues) {
  const rows = [];
  const cacheReturns = [];
  const tushareReturns = [];
  for (let i = 1; i < Math.min(cacheValues.length, tushareValues.length); i += 1) {
    if (cacheValues[i - 1] === 0 || tushareValues[i - 1] === 0) continue;
    const cacheReturn = cacheValues[i] / cacheValues[i - 1] - 1;
    const tushareReturn = tushareValues[i] / tushareValues[i - 1] - 1;
    cacheReturns.push(cacheReturn);
    tushareReturns.push(tushareReturn);
    rows.push({
      date: dates[i],
      cache_return: cacheReturn,
      tushare_return: tushareReturn,
      abs_diff: Math.abs(cacheReturn - tushareReturn),
    });
  }
  if (rows.length === 0) return null;
  const worst = rows.reduce((best, row) => (row.abs_diff > best.abs_diff ? row : best), rows[0]);
  return {
    count: rows.length,
    max_abs_diff: worst.abs_diff,
    max_abs_diff_date: worst.date,
    mean_abs_diff: rows.reduce((sum, row) => sum + row.abs_diff, 0) / rows.length,
    correlation: pearson(cacheReturns, tushareReturns),
    mismatch_count: rows.filter((row) => row.abs_diff > TOL).length,
    mismatch_samples: rows.filter((row) => row.abs_diff > TOL).slice(0, 10),
  };
}

function factorChangesAfter(adj, end, adjEnd) {
  const changes = [];
  let previous = adj.asOf(end);
  for (const [date, factor] of adj.entries) {
    if (date <= end || date > adjEnd) continue;
    if (previous && Math.abs(factor - previous.factor) > TOL) {
      changes.push({ date, before: previous.factor, after: factor, ratio: factor / previous.factor });
    }
    previous = { date, factor };
  }
  return changes;
}

function compareQfq({ dates, cacheFwdByDate, tsByDate, adj, end, adjEnd }) {
  const endAnchor = adj.asOf(end);
  const latestEntry = adj.entries.filter(([date]) => date <= adjEnd).at(-1);
  const latestAnchor = latestEntry ? { date: latestEntry[0], factor: latestEntry[1] } : null;
  if (!endAnchor || !latestAnchor) {
    return { error: '缺少复权因子，无法计算 qfq' };
  }

  const usedDates = [];
  const skippedDates = [];
  const cacheValues = [];
  const endValues = [];
  const latestValues = [];
  for (const date of dates) {
    const cache = Number(cacheFwdByDate.get(date)?.close);
    const tushare = Number(tsByDate.get(date)?.close);
    const factor = adj.asOf(date);
    if (!Number.isFinite(cache) || !Number.isFinite(tushare) || !factor) {
      skippedDates.push(date);
      continue;
    }
    usedDates.push(date);
    cacheValues.push(cache);
    endValues.push(tushare * factor.factor / endAnchor.factor);
    latestValues.push(tushare * factor.factor / latestAnchor.factor);
  }

  return {
    end_anchor_date: endAnchor.date,
    end_anchor_factor: endAnchor.factor,
    latest_anchor_date: latestAnchor.date,
    latest_anchor_factor: latestAnchor.factor,
    scale_between_anchors: latestAnchor.factor / endAnchor.factor,
    used_dates: usedDates.length,
    skipped_dates: summarizeDates(skippedDates),
    level_ratio_end: levelRatio(cacheValues, endValues),
    level_ratio_latest: levelRatio(cacheValues, latestValues),
    normalized: normalizedDiff(usedDates, cacheValues, endValues),
    returns: returnDiff(usedDates, cacheValues, endValues),
    factor_changes_after_end: factorChangesAfter(adj, end, adjEnd),
  };
}

function compareSymbol({ symbol, symbolName, cacheSeries, tsDaily, tsAdj, end, adjEnd }) {
  const cacheBars = [...(cacheSeries.bars ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const cacheFwd = [...(cacheSeries.bars_fwdadj ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const cacheByDate = new Map(cacheBars.map((bar) => [bar.date, bar]));
  const cacheFwdByDate = new Map(cacheFwd.map((bar) => [bar.date, bar]));
  const tsByDate = new Map(tsDaily.map((row) => [row.date, row]));
  const commonDates = [...cacheByDate.keys()].filter((date) => tsByDate.has(date)).sort();
  const datesOnlyInCache = [...cacheByDate.keys()].filter((date) => !tsByDate.has(date)).sort();
  const datesOnlyInTushare = [...tsByDate.keys()].filter((date) => !cacheByDate.has(date)).sort();

  const unadjusted = {};
  for (const field of ['open', 'high', 'low', 'close']) {
    unadjusted[field] = compareNumericField({
      cacheByDate,
      tsByDate,
      commonDates,
      cacheField: field,
      tsField: field,
    });
  }
  unadjusted.volume = compareNumericField({
    cacheByDate,
    tsByDate,
    commonDates,
    cacheField: 'volume',
    tsField: 'vol',
    tsMultiplier: LOT_SIZE,
    tolerance: VOLUME_TOL_SHARES,
  });

  const adj = buildAdjLookup(tsAdj);
  return {
    symbol,
    ts_code: toTsCode(symbol),
    symbol_name: symbolName,
    cache_bars: cacheBars.length,
    cache_fwdadj_bars: cacheFwd.length,
    tushare_daily_rows: tsDaily.length,
    tushare_adj_rows: tsAdj.length,
    common_dates: commonDates.length,
    dates_only_in_cache: summarizeDates(datesOnlyInCache),
    dates_only_in_tushare: summarizeDates(datesOnlyInTushare),
    unadjusted,
    qfq: compareQfq({ dates: commonDates, cacheFwdByDate, tsByDate, adj, end, adjEnd }),
  };
}

function buildVerdict(calendar, symbolReports) {
  const coreIssues = [];
  const coverageIssues = [];
  const volumeRounding = [];
  if (!calendar.equal) {
    coreIssues.push(`交易日历不一致：缓存缺 ${calendar.missing_in_tushare.length} 日，Tushare 多 ${calendar.extra_in_tushare.length} 日`);
  }
  for (const report of symbolReports) {
    for (const field of ['open', 'high', 'low', 'close']) {
      const result = report.unadjusted[field];
      if (result.mismatch_count > 0) {
        coreIssues.push(`${report.ts_code} ${field} 有 ${result.mismatch_count} 日不一致（max|Δ|=${fmt(result.max_abs_diff)}，${result.max_abs_diff_date}）`);
      }
    }
    const volume = report.unadjusted.volume;
    if (volume.mismatch_count > 0) {
      coreIssues.push(`${report.ts_code} volume 有 ${volume.mismatch_count} 日超出整手容差 ±0.5 手（max|Δ|=${fmt(volume.max_abs_diff)} 股，${volume.max_abs_diff_date}）`);
    } else if (volume.rounding_only_count > 0) {
      volumeRounding.push(`${report.ts_code} ${volume.rounding_only_count} 日为整手舍入差（max|Δ|=${fmt(volume.max_abs_diff)} 股 = ${fmt(volume.max_abs_diff / LOT_SIZE)} 手）`);
    }
    if (report.dates_only_in_tushare.count > 0) {
      coverageIssues.push(`${report.ts_code} Tushare 多出 ${report.dates_only_in_tushare.count} 日`);
    }
    if (report.dates_only_in_cache.count > 0) {
      coverageIssues.push(`${report.ts_code} 缓存多出 ${report.dates_only_in_cache.count} 日（可能停牌/覆盖差异）`);
    }
  }

  const qfqNormalizedMax = symbolReports.reduce(
    (max, report) => Math.max(max, report.qfq.normalized?.max_abs_diff ?? 0),
    0,
  );
  const qfqReturnMax = symbolReports.reduce(
    (max, report) => Math.max(max, report.qfq.returns?.max_abs_diff ?? 0),
    0,
  );

  return {
    core_equal: coreIssues.length === 0,
    coverage_equal: coverageIssues.length === 0,
    core_issues: coreIssues,
    coverage_issues: coverageIssues,
    volume_rounding_notes: volumeRounding,
    qfq_normalized_max_abs_diff: qfqNormalizedMax,
    qfq_return_max_abs_diff: qfqReturnMax,
  };
}

function fmt(value, digits = 6) {
  if (value === null || value === undefined) return 'n/a';
  if (!Number.isFinite(value)) return String(value);
  if (value !== 0 && Math.abs(value) < 1e-6) return value.toExponential(3);
  return value.toFixed(digits);
}

function ratioText(summary) {
  if (!summary) return 'n/a';
  return `min=${fmt(summary.min, 8)} · median=${fmt(summary.median, 8)} · max=${fmt(summary.max, 8)}${summary.constant ? '（常数）' : ''}`;
}

function printReport(report) {
  console.log('== TimingMirror · Tushare 只读对比 ==');
  console.log(`缓存：data/market-cache.json · sha256=${report.cache.sha256}`);
  console.log(`签收门：usable=${report.cache.gate.usable} · accepted_by=${report.cache.gate.accepted_by} · accepted_date=${report.cache.gate.accepted_date} · asOfDate=${report.cache.gate.asOfDate}`);
  console.log(`区间：${report.tushare.range.start}..${report.tushare.range.end} · 标的：${report.symbols.map((s) => s.ts_code).join(', ')}`);
  console.log(`Tushare：trade_cal / daily / adj_factor · 复权因子截止 ${report.tushare.adj_end}`);
  console.log(`日历：缓存 ${report.calendar.cache_count} / Tushare ${report.calendar.tushare_count} · ${report.calendar.equal ? '一致' : `不一致（缓存缺 ${report.calendar.missing_in_tushare.length}，Tushare 多 ${report.calendar.extra_in_tushare.length}）`}`);
  console.log('');

  for (const symbol of report.symbols) {
    console.log(`${symbol.ts_code} ${symbol.symbol_name || ''}`.trim());
    console.log(`  行数：缓存 ${symbol.cache_bars} / Tushare ${symbol.tushare_daily_rows} / 共同 ${symbol.common_dates}；仅缓存 ${symbol.dates_only_in_cache.count}；仅 Tushare ${symbol.dates_only_in_tushare.count}`);
    const close = symbol.unadjusted.close;
    console.log(`  不复权 close：${close.equal_count}/${close.count} 一致；max|Δ|=${fmt(close.max_abs_diff)}${close.mismatch_count ? `（${close.mismatch_count} 日不一致）` : ''}`);
    const ohlc = ['open', 'high', 'low'].map((field) => `${field} max|Δ|=${fmt(symbol.unadjusted[field].max_abs_diff)}`).join(' · ');
    console.log(`  OHLC：${ohlc}`);
    const volume = symbol.unadjusted.volume;
    const volumeExact = volume.rounding_only_count > 0
      ? `；精确一致 ${volume.exact_equal_count}/${volume.count}，${volume.rounding_only_count} 日为整手舍入差`
      : '';
    console.log(`  成交量（整手口径，容差 ±0.5 手）：${volume.equal_count}/${volume.count} 一致；max|Δ|=${fmt(volume.max_abs_diff)} 股=${fmt(volume.max_abs_diff / LOT_SIZE)} 手${volume.mismatch_count ? `（${volume.mismatch_count} 日超出容差）` : volumeExact}`);
    if (symbol.qfq.error) {
      console.log(`  qfq：${symbol.qfq.error}`);
    } else {
      console.log(`  qfq：共同 ${symbol.qfq.used_dates} 日；锚点因子比 ${fmt(symbol.qfq.scale_between_anchors, 8)}（${symbol.qfq.end_anchor_date} → ${symbol.qfq.latest_anchor_date}）`);
      console.log(`       水平比@结束锚点：${ratioText(symbol.qfq.level_ratio_end)}`);
      console.log(`       水平比@最新锚点：${ratioText(symbol.qfq.level_ratio_latest)}`);
      console.log(`       归一化 max|Δ|=${fmt(symbol.qfq.normalized?.max_abs_diff)}；日收益 max|Δ|=${fmt(symbol.qfq.returns?.max_abs_diff)}（相关=${fmt(symbol.qfq.returns?.correlation)}）`);
    }
    console.log('');
  }

  const verdict = report.verdict;
  console.log('== 结论 ==');
  console.log(`核心口径（日历 + 共同交易日不复权 OHLC + 成交量整手口径）：${verdict.core_equal ? '一致' : '存在差异'}`);
  if (!verdict.core_equal) {
    for (const issue of verdict.core_issues) console.log(`  - ${issue}`);
  }
  if (verdict.volume_rounding_notes.length > 0) {
    console.log('成交量整手舍入（不参与产品计算）：');
    for (const note of verdict.volume_rounding_notes) console.log(`  - ${note}`);
  }
  console.log(`覆盖日期：${verdict.coverage_equal ? '一致' : '存在差异'}`);
  if (!verdict.coverage_equal) {
    for (const issue of verdict.coverage_issues) console.log(`  - ${issue}`);
  }
  console.log(`qfq 展示口径：归一化 max|Δ|=${fmt(verdict.qfq_normalized_max_abs_diff)}；日收益 max|Δ|=${fmt(verdict.qfq_return_max_abs_diff)}`);
  console.log('说明：qfq 仅用于展示；估值仍使用不复权 close。未修改签名缓存或产品链路。');
}

function selftest() {
  const cacheBars = [
    { date: '2023-01-03', open: 10, high: 11, low: 9, close: 10, volume: 1000 },
    { date: '2023-01-04', open: 11, high: 12, low: 10, close: 11, volume: 2000 },
  ];
  const tsDaily = [
    { date: '2023-01-03', open: 10, high: 11, low: 9, close: 10, vol: 10.5 },
    { date: '2023-01-04', open: 11, high: 12, low: 10, close: 11, vol: 20 },
  ];
  const tsAdj = [
    { trade_date: '20230103', adj_factor: 1 },
    { trade_date: '20230104', adj_factor: 1.1 },
    { trade_date: '20230105', adj_factor: 1.1 },
  ];
  const cacheFwd = [
    { ...cacheBars[0], close: 10 / 1.1 },
    { ...cacheBars[1], close: 11 },
  ];
  const cacheSeries = { bars: cacheBars, bars_fwdadj: cacheFwd };
  const result = compareSymbol({
    symbol: '600000',
    symbolName: '测试标的',
    cacheSeries,
    tsDaily,
    tsAdj,
    end: '2023-01-04',
    adjEnd: '2023-01-05',
  });
  const assert = (condition, message) => {
    if (!condition) throw new Error(`SELFTEST FAIL：${message}`);
  };
  assert(result.unadjusted.close.mismatch_count === 0, '不复权 close 应一致');
  assert(result.unadjusted.volume.mismatch_count === 0, '整手容差内的成交量差不应判为不一致');
  assert(result.unadjusted.volume.rounding_only_count === 1, '应识别 1 日整手舍入差');
  assert(result.unadjusted.volume.exact_equal_count === 1, '应识别 1 日精确一致');
  assert(result.unadjusted.volume.max_abs_diff === LOT_SIZE / 2, '整手舍入差应为 0.5 手');
  const badVolume = compareNumericField({
    cacheByDate: new Map([['2023-01-04', { volume: 2000 }]]),
    tsByDate: new Map([['2023-01-04', { vol: 20.51 }]]),
    commonDates: ['2023-01-04'],
    cacheField: 'volume',
    tsField: 'vol',
    tsMultiplier: LOT_SIZE,
    tolerance: VOLUME_TOL_SHARES,
  });
  assert(badVolume.mismatch_count === 1, '超出整手容差应标记不一致');
  assert(result.qfq.normalized.max_abs_diff < TOL, 'qfq 归一化序列应一致');
  assert(result.qfq.returns.max_abs_diff < TOL, 'qfq 日收益应一致');
  assert(Math.abs(result.qfq.level_ratio_latest.max - 1) < TOL, '最新锚点水平比应为 1');
  console.log('SELFTEST PASS');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (opts.selftest) {
    selftest();
    return;
  }

  const token = process.env.TUSHARE_TOKEN?.trim();
  if (!token) {
    console.error('缺少环境变量 TUSHARE_TOKEN。请在本机临时设置后重试；脚本不会写入或打印该凭证。');
    process.exitCode = 2;
    return;
  }

  if (opts.out && opts.out !== '-' && resolve(opts.out) === CACHE_PATH) {
    throw new Error('--out 不得指向签名缓存 data/market-cache.json');
  }

  const cacheRaw = await readFile(CACHE_PATH, 'utf8');
  const cache = JSON.parse(cacheRaw);
  const gate = assessCacheDoc(cache);
  if (!gate.usable) {
    throw new Error(`缓存未通过签收门：${gate.reason}${gate.detail ? `（${gate.detail}）` : ''}`);
  }
  const cacheSha256 = createHash('sha256').update(cacheRaw).digest('hex');

  const range = {
    start: opts.start ?? cache.manifest.date_range.start,
    end: opts.end ?? cache.manifest.date_range.end,
  };
  assertDate(range.start, '--start');
  assertDate(range.end, '--end');
  if (range.start > range.end) throw new Error('--start 不能晚于 --end');
  if (range.start < cache.manifest.date_range.start || range.end > cache.manifest.date_range.end) {
    throw new Error(`对比区间必须位于缓存范围内 ${cache.manifest.date_range.start}..${cache.manifest.date_range.end}`);
  }

  const symbolList = opts.symbols ? parseSymbols(opts.symbols) : [...cache.manifest.symbols];
  for (const symbol of symbolList) {
    if (!cache.symbols[symbol]) throw new Error(`标的 ${symbol} 不在签名缓存内`);
  }

  const adjEnd = opts.adjEnd ?? dateFromIso(cache.snapshot?.fetch_time) ?? shanghaiToday();
  assertDate(adjEnd, '--adj-end');
  if (adjEnd < range.end) throw new Error('--adj-end 不能早于对比区间结束日');

  const calls = [];
  async function callApi(apiName, params, fields) {
    const rows = await fetchTushare(token, apiName, params, fields);
    calls.push({ api_name: apiName, params, rows: rows.length });
    return rows;
  }

  const calRows = await callApi('trade_cal', {
    exchange: 'SSE',
    start_date: compact(range.start),
    end_date: compact(range.end),
    is_open: '1',
  }, 'cal_date,is_open');
  const tsCalendar = [...new Set(calRows
    .filter((row) => Number(row.is_open) === 1)
    .map((row) => dashed(row.cal_date)))].sort();
  if (tsCalendar.length === 0) throw new Error('Tushare 交易日历为空');
  const calendar = compareCalendar([...cache.calendar.trading_days].sort(), tsCalendar);

  const symbolReports = [];
  for (const symbol of symbolList) {
    const tsCode = toTsCode(symbol);
    const dailyRows = await callApi('daily', {
      ts_code: tsCode,
      start_date: compact(range.start),
      end_date: compact(range.end),
    }, 'ts_code,trade_date,open,high,low,close,vol');
    if (dailyRows.some((row) => row.ts_code !== tsCode)) {
      throw new Error(`Tushare daily 返回了非请求标的：${tsCode}`);
    }
    const tsDaily = dailyRows.map((row) => {
      const record = { date: dashed(row.trade_date) };
      for (const field of ['open', 'high', 'low', 'close', 'vol']) {
        const value = Number(row[field]);
        if (!Number.isFinite(value)) {
          throw new Error(`Tushare daily 字段 ${field} 非法（${row.trade_date}）：${row[field]}`);
        }
        record[field] = value;
      }
      return record;
    });
    const adjRows = await callApi('adj_factor', {
      ts_code: tsCode,
      start_date: compact(range.start),
      end_date: compact(adjEnd),
    }, 'ts_code,trade_date,adj_factor');
    if (adjRows.length === 0) throw new Error(`Tushare adj_factor 为空：${tsCode}`);

    symbolReports.push(compareSymbol({
      symbol,
      symbolName: cache.manifest.symbol_names?.[symbol] ?? '',
      cacheSeries: cache.symbols[symbol],
      tsDaily,
      tsAdj: adjRows,
      end: range.end,
      adjEnd,
    }));
  }

  const report = {
    artifact: 'tushare-compare-report',
    generated_at: new Date().toISOString(),
    boundaries: {
      readonly: true,
      writes_cache: false,
      token_source: 'env:TUSHARE_TOKEN',
      note: '只读对比；不修改 data/market-cache.json，不进入产品链路。',
    },
    cache: {
      path: 'data/market-cache.json',
      sha256: cacheSha256,
      gate: {
        usable: gate.usable,
        signed: gate.signed,
        accepted_by: gate.accepted_by,
        accepted_date: gate.accepted_date,
        manifest_version: gate.manifest_version,
        range: gate.range,
        asOfDate: gate.asOfDate,
        symbols: gate.symbols,
      },
      data_source: cache.manifest.data_source,
      snapshot: cache.snapshot ? {
        snapshot_id: cache.snapshot.snapshot_id,
        fetch_time: cache.snapshot.fetch_time,
      } : null,
    },
    tushare: {
      api_url: API_URL,
      range,
      adj_end: adjEnd,
      calendar_exchange: 'SSE',
      calls,
      volume_rule: {
        cache_unit: '股（缓存值均为整手）',
        tushare_unit: '手（可带小数）',
        whole_lot_shares: LOT_SIZE,
        tolerance_shares: VOLUME_TOL_SHARES - 1e-6,
        note: '±0.5 手为手→股换算的整手舍入容差；成交量不参与产品计算。',
      },
    },
    calendar,
    symbols: symbolReports,
    verdict: buildVerdict(calendar, symbolReports),
  };

  printReport(report);

  if (opts.out === '-') {
    console.log('\n== JSON 报告 ==');
    console.log(JSON.stringify(report, null, 2));
  } else if (opts.out) {
    const outPath = resolve(opts.out);
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\n已写出 JSON 报告：${outPath}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`对比失败：${error.message}`);
  process.exitCode = 1;
}
