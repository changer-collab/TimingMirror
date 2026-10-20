// 站点 Function 的 Tushare 动态日线 transport（仅在配置 TUSHARE_TOKEN 后由入口构造）。
// 只提供最新已收盘日线（非实时）：stock_basic + trade_cal + daily + adj_factor，按标的一次性构建快照。
// 边界：token 仅存在于服务端请求体，不写日志、不进入响应；不接收用户成交、文件名或 CSV 内容；
//       短 TTL 缓存与同键在途去重，降低匿名接口被重复调用的上游压力。
export const TUSHARE_ENDPOINT = 'https://api.tushare.pro';
export const DYNAMIC_CACHE_ARTIFACT = 'market-cache-dynamic';
export const MARKET_MAX_SYMBOLS = 10;
export const MARKET_MAX_RANGE_DAYS = 7305;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^\d{6}$/;
const TS_CODE_RE = /^\d{6}\.(?:SH|SZ|BJ)$/;
const TUSHARE_DATE_RE = /^\d{8}$/;
// Tushare 日线/股票列表单次最多 6000 行；接口文档未提供 offset 分页，因此按日期区间/交易所拆分，
// 任一响应达到上限即失败，不截断后宣称完整。
const TUSHARE_MAX_ROWS = 6000;
const TUSHARE_CHUNK_TRADING_DAYS = 4000;
const STOCK_BASIC_STATUSES = ['L', 'P', 'D'];
const STOCK_BASIC_EXCHANGES = ['SSE', 'SZSE', 'BSE'];
// Tushare 频次限制以 HTTP 200 + 业务码返回，40203 表示每分钟调用超限，可退避重试。
const RETRYABLE_TUSHARE_CODES = new Set([40203]);

export const MARKET_TRANSPORT_CODES = Object.freeze({
  NOT_CONFIGURED: 'E_MARKET_NOT_CONFIGURED',
  REQUEST_INVALID: 'E_MARKET_REQUEST_INVALID',
  SYMBOL_UNKNOWN: 'E_MARKET_SYMBOL_UNKNOWN',
  NO_DATA: 'E_MARKET_NO_DATA',
  UPSTREAM: 'E_MARKET_UNAVAILABLE',
  TIMEOUT: 'E_MARKET_TIMEOUT',
  RESPONSE: 'E_MARKET_RESPONSE_INVALID',
});

export class MarketTransportError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.name = 'MarketTransportError';
    this.code = code;
    this.retryable = retryable;
  }
}

const fail = (code, retryable = false) => new MarketTransportError(code, retryable);

export function isMarketDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isMarketSymbol(value) {
  return typeof value === 'string' && SYMBOL_RE.test(value);
}

function compactDate(date) {
  return date.replace(/-/g, '');
}

function normalizeTradeDate(value) {
  const raw = String(value ?? '').trim();
  if (TUSHARE_DATE_RE.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return isMarketDate(raw) ? raw : null;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function createTushareCaller({ token, fetchImpl, timeoutMs, maxAttempts, retryDelayMs, sleepImpl }) {
  async function callOnce({ apiName, params, fields }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = () => controller.signal.aborted;
    try {
      let response;
      try {
        response = await fetchImpl(TUSHARE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_name: apiName, token, params, fields }),
          signal: controller.signal,
        });
      } catch (error) {
        throw timedOut() || (error && error.name === 'AbortError')
          ? fail(MARKET_TRANSPORT_CODES.TIMEOUT, true)
          : fail(MARKET_TRANSPORT_CODES.UPSTREAM, true);
      }
      if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') {
        throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
      }
      if (!response.ok) {
        const status = Number(response.status);
        throw fail(MARKET_TRANSPORT_CODES.UPSTREAM, status === 429 || status >= 500);
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw timedOut() || (error && error.name === 'AbortError')
          ? fail(MARKET_TRANSPORT_CODES.TIMEOUT, true)
          : fail(MARKET_TRANSPORT_CODES.RESPONSE);
      }
      if (timedOut()) throw fail(MARKET_TRANSPORT_CODES.TIMEOUT, true);
      if (!payload || typeof payload !== 'object') throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
      if (payload.code !== 0) {
        throw fail(MARKET_TRANSPORT_CODES.UPSTREAM, RETRYABLE_TUSHARE_CODES.has(Number(payload.code)));
      }
      const names = payload.data?.fields;
      const rows = payload.data?.items;
      if (!Array.isArray(names) || !Array.isArray(rows)) throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
      return rows.map((row) => {
        const out = {};
        names.forEach((name, i) => { out[name] = Array.isArray(row) ? row[i] : undefined; });
        return out;
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return async function callTushare(request) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await callOnce(request);
      } catch (error) {
        lastError = error instanceof MarketTransportError ? error : fail(MARKET_TRANSPORT_CODES.UPSTREAM);
        if (!lastError.retryable || attempt === maxAttempts) throw lastError;
        if (retryDelayMs > 0) await sleepImpl(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  };
}

function chunkByTradingDays(days, chunkSize) {
  const chunks = [];
  for (let i = 0; i < days.length; i += chunkSize) {
    const slice = days.slice(i, i + chunkSize);
    chunks.push({ start: slice[0], end: slice.at(-1) });
  }
  return chunks;
}

async function callTushareByRange(callTushare, { apiName, tsCode, fields, tradingDays, chunkSize, rowLimit }) {
  const rows = [];
  for (const chunk of chunkByTradingDays(tradingDays, chunkSize)) {
    const params = { start_date: compactDate(chunk.start), end_date: compactDate(chunk.end) };
    if (tsCode) params.ts_code = tsCode;
    const batch = await callTushare({ apiName, params, fields });
    if (batch.length >= rowLimit) throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
    rows.push(...batch);
  }
  return rows;
}

async function loadStockBasicMappings({ callTushare, rowLimit }) {
  const mapping = new Map();
  for (const listStatus of STOCK_BASIC_STATUSES) {
    for (const exchange of STOCK_BASIC_EXCHANGES) {
      const rows = await callTushare({
        apiName: 'stock_basic',
        params: { list_status: listStatus, exchange },
        fields: 'ts_code,symbol,list_status',
      });
      if (rows.length >= rowLimit) throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
      for (const row of rows) {
        const symbol = String(row.symbol ?? '').trim();
        const tsCode = String(row.ts_code ?? '').trim();
        if (!SYMBOL_RE.test(symbol) || !TS_CODE_RE.test(tsCode) || !tsCode.startsWith(symbol)) {
          throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
        }
        if (!mapping.has(symbol)) mapping.set(symbol, tsCode);
      }
    }
  }
  if (mapping.size === 0) throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
  return mapping;
}

function resolveTsCodes(symbols, mapping) {
  return symbols.map((symbol) => {
    const tsCode = mapping.get(symbol);
    if (!tsCode) throw fail(MARKET_TRANSPORT_CODES.SYMBOL_UNKNOWN);
    return tsCode;
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function indexSeries(dailyRows, adjRows, calendarSet) {
  const closes = new Map();
  for (const row of dailyRows) {
    const date = normalizeTradeDate(row.trade_date);
    const close = positiveNumber(row.close);
    if (date === null || close === null || !calendarSet.has(date)) continue;
    closes.set(date, close);
  }
  const factors = new Map();
  for (const row of adjRows) {
    const date = normalizeTradeDate(row.trade_date);
    const factor = positiveNumber(row.adj_factor);
    if (date === null || factor === null || !calendarSet.has(date)) continue;
    factors.set(date, factor);
  }
  return { closes, factors, dates: [...closes.keys()].sort() };
}

function finalizeSeries(item, asOfDate) {
  const dates = item.dates.filter((date) => date <= asOfDate);
  const baseDate = [...item.factors.keys()].filter((date) => date <= asOfDate).sort().at(-1) ?? null;
  const baseFactor = baseDate === null ? null : item.factors.get(baseDate);
  const bars = dates.map((date) => ({ date, close: item.closes.get(date) }));
  const barsFwdadj = baseFactor === null
    ? []
    : dates.filter((date) => item.factors.has(date)).map((date) => ({
      date,
      close: round4(item.closes.get(date) * item.factors.get(date) / baseFactor),
    }));
  return {
    bars,
    bars_fwdadj: barsFwdadj,
    adj_factor_base: baseDate === null ? null : { date: baseDate, factor: baseFactor },
  };
}

async function buildSnapshot({
  symbols, start, end, callTushare, getStockBasicMappings, now,
  chunkTradingDays, rowLimit, maxConcurrency,
}) {
  const mapping = await getStockBasicMappings();
  const tsCodes = resolveTsCodes(symbols, mapping);

  const calendarRows = await callTushare({
    apiName: 'trade_cal',
    params: { exchange: 'SSE', start_date: compactDate(start), end_date: compactDate(end), is_open: '1' },
    fields: 'cal_date',
  });
  if (calendarRows.length >= rowLimit) throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
  const allDays = [...new Set(calendarRows.map((r) => normalizeTradeDate(r.cal_date)).filter(Boolean))].sort();
  if (allDays.length === 0) throw fail(MARKET_TRANSPORT_CODES.NO_DATA);
  const calendarSet = new Set(allDays);

  const indexed = await mapLimit(symbols, maxConcurrency, async (symbol, index) => {
    const tsCode = tsCodes[index];
    const dailyRows = await callTushareByRange(callTushare, {
      apiName: 'daily',
      tsCode,
      fields: 'ts_code,trade_date,close',
      tradingDays: allDays,
      chunkSize: chunkTradingDays,
      rowLimit,
    });
    const adjRows = await callTushareByRange(callTushare, {
      apiName: 'adj_factor',
      tsCode,
      fields: 'ts_code,trade_date,adj_factor',
      tradingDays: allDays,
      chunkSize: chunkTradingDays,
      rowLimit,
    });
    return { symbol, ts_code: tsCode, ...indexSeries(dailyRows, adjRows, calendarSet) };
  });

  const latestBarDate = indexed.flatMap((item) => item.dates).sort().at(-1) ?? null;
  if (latestBarDate === null) throw fail(MARKET_TRANSPORT_CODES.NO_DATA);
  const asOfDate = latestBarDate;
  const tradingDays = allDays.filter((d) => d <= asOfDate);
  if (tradingDays.length === 0) throw fail(MARKET_TRANSPORT_CODES.NO_DATA);

  const series = {};
  indexed.forEach((item) => {
    series[item.symbol] = { ts_code: item.ts_code, ...finalizeSeries(item, asOfDate) };
  });

  const range = { start, end: asOfDate };
  const canonical = JSON.stringify({
    asOfDate,
    calendar: tradingDays,
    symbols: symbols.map((symbol) => ({
      symbol,
      ts_code: series[symbol].ts_code,
      bars: series[symbol].bars,
      bars_fwdadj: series[symbol].bars_fwdadj,
      adj_factor_base: series[symbol].adj_factor_base,
    })),
  });
  const checksum = await sha256Hex(canonical);
  const fetchedAt = now().toISOString();

  return {
    artifact: DYNAMIC_CACHE_ARTIFACT,
    manifest_version: 'dynamic-v1',
    fetched_at: fetchedAt,
    checksum,
    asOfDate,
    source: {
      provider: 'tushare',
      endpoint: TUSHARE_ENDPOINT,
      apis: ['stock_basic', 'trade_cal', 'daily', 'adj_factor'],
      mapping: 'stock_basic（交易所 × list_status=L/P/D）',
      segmentation: `daily/adj_factor 按交易日分段（每段 ≤${chunkTradingDays} 个交易日）；单次响应达到 ${rowLimit} 行即失败`,
      freshness: 'latest_closed_daily',
      adjustment: '前复权 close = close × adj_factor / 基准日 adj_factor；估值使用不复权 close',
      note: '服务端获取的最新已收盘日线，非实时；不包含分钟级数据',
    },
    manifest: {
      asOfDate,
      date_range: { ...range },
      symbols: [...symbols],
    },
    calendar: { trading_days: tradingDays },
    symbols: series,
    snapshot: {
      snapshot_id: `tushare-${asOfDate.replace(/-/g, '')}-${checksum.slice(0, 8)}`,
      fetch_time: fetchedAt,
      latest_trade_date: asOfDate,
      range: { ...range },
      requested_range: { start, end },
      symbols: [...symbols],
      provider: 'tushare',
      calendar_source: 'trade_cal（SSE，is_open=1）',
      mapping_source: 'stock_basic（交易所 × L/P/D，含退市）',
      adjustment_basis: '前复权展示（基准日见各标的 adj_factor_base）；不复权估值',
    },
  };
}

export function createTushareMarketTransport({
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  ttlMs = 60000,
  maxEntries = 32,
  maxAttempts = 3,
  retryDelayMs = 200,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  chunkTradingDays = TUSHARE_CHUNK_TRADING_DAYS,
  rowLimit = TUSHARE_MAX_ROWS,
  maxConcurrency = 4,
  stockBasicTtlMs = 6 * 60 * 60 * 1000,
  now = () => new Date(),
} = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('token 必须为非空字符串');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正整数');
  if (!Number.isInteger(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs 必须为非负整数');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError('maxEntries 必须为正整数');
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new TypeError('maxAttempts 必须为正整数');
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) throw new TypeError('retryDelayMs 必须为非负整数');
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl 必须为函数');
  if (!Number.isInteger(chunkTradingDays) || chunkTradingDays <= 0) throw new TypeError('chunkTradingDays 必须为正整数');
  if (!Number.isInteger(rowLimit) || rowLimit <= 0) throw new TypeError('rowLimit 必须为正整数');
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) throw new TypeError('maxConcurrency 必须为正整数');
  if (!Number.isInteger(stockBasicTtlMs) || stockBasicTtlMs < 0) throw new TypeError('stockBasicTtlMs 必须为非负整数');

  const callTushare = createTushareCaller({
    token: token.trim(), fetchImpl, timeoutMs, maxAttempts, retryDelayMs, sleepImpl,
  });
  const cache = new Map();
  let stockBasicEntry = null;

  function getStockBasicMappings() {
    const at = Date.now();
    if (stockBasicEntry && at - stockBasicEntry.at <= stockBasicTtlMs) return stockBasicEntry.promise;
    const promise = loadStockBasicMappings({ callTushare, rowLimit })
      .catch((error) => {
        if (stockBasicEntry && stockBasicEntry.promise === promise) stockBasicEntry = null;
        throw error;
      });
    stockBasicEntry = { at, promise };
    return promise;
  }

  function sweep() {
    const at = Date.now();
    for (const [key, entry] of cache) {
      if (entry.doc && at - entry.at > ttlMs) cache.delete(key);
    }
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  return Object.freeze({
    async snapshot({ symbols, start, end }) {
      const unique = [...new Set(symbols)].sort();
      if (unique.length === 0 || unique.length > MARKET_MAX_SYMBOLS || !unique.every(isMarketSymbol)) {
        throw fail(MARKET_TRANSPORT_CODES.REQUEST_INVALID);
      }
      if (!isMarketDate(start) || !isMarketDate(end) || start > end) {
        throw fail(MARKET_TRANSPORT_CODES.REQUEST_INVALID);
      }
      const key = `${start}|${end}|${unique.join(',')}`;
      const hit = cache.get(key);
      if (hit && hit.doc && Date.now() - hit.at <= ttlMs) return hit.doc;
      if (hit && hit.pending) return hit.pending;

      const pending = buildSnapshot({
        symbols: unique,
        start,
        end,
        callTushare,
        getStockBasicMappings,
        now,
        chunkTradingDays,
        rowLimit,
        maxConcurrency,
      })
        .then((doc) => {
          cache.set(key, { at: Date.now(), doc });
          sweep();
          return doc;
        })
        .catch((error) => {
          cache.delete(key);
          throw error;
        });
      cache.set(key, { at: Date.now(), pending });
      return pending;
    },
  });
}
