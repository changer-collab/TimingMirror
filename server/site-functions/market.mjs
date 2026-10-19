// 站点 Function 的 Tushare 动态日线 transport（仅在配置 TUSHARE_TOKEN 后由入口构造）。
// 只提供最新已收盘日线（非实时）：trade_cal + daily + adj_factor，按标的一次性构建快照。
// 边界：token 仅存在于服务端请求体，不写日志、不进入响应；不接收用户成交、文件名或 CSV 内容；
//       短 TTL 缓存与同键在途去重，降低匿名接口被重复调用的上游压力。
export const TUSHARE_ENDPOINT = 'https://api.tushare.pro';
export const DYNAMIC_CACHE_ARTIFACT = 'market-cache-dynamic';
export const MARKET_MAX_SYMBOLS = 10;
export const MARKET_MAX_RANGE_DAYS = 7305;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^\d{6}$/;
const TUSHARE_DATE_RE = /^\d{8}$/;

export const MARKET_TRANSPORT_CODES = Object.freeze({
  NOT_CONFIGURED: 'E_MARKET_NOT_CONFIGURED',
  REQUEST_INVALID: 'E_MARKET_REQUEST_INVALID',
  NO_DATA: 'E_MARKET_NO_DATA',
  UPSTREAM: 'E_MARKET_UNAVAILABLE',
  TIMEOUT: 'E_MARKET_TIMEOUT',
  RESPONSE: 'E_MARKET_RESPONSE_INVALID',
});

export class MarketTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MarketTransportError';
    this.code = code;
  }
}

const fail = (code) => new MarketTransportError(code);

export function isMarketDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isMarketSymbol(value) {
  return typeof value === 'string' && SYMBOL_RE.test(value);
}

export function marketSymbolToTsCode(symbol) {
  if (/^[69]/.test(symbol)) return `${symbol}.SH`;
  if (/^[03]/.test(symbol)) return `${symbol}.SZ`;
  if (/^[48]/.test(symbol)) return `${symbol}.BJ`;
  return `${symbol}.SZ`;
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

function createTushareCaller({ token, fetchImpl, timeoutMs }) {
  return async function callTushare({ apiName, params, fields }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        if (controller.signal.aborted || (error && error.name === 'AbortError')) throw fail(MARKET_TRANSPORT_CODES.TIMEOUT);
        throw fail(MARKET_TRANSPORT_CODES.UPSTREAM);
      }
      if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean' || !response.ok) {
        throw fail(MARKET_TRANSPORT_CODES.UPSTREAM);
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || (error && error.name === 'AbortError')) throw fail(MARKET_TRANSPORT_CODES.TIMEOUT);
        throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
      }
      if (controller.signal.aborted) throw fail(MARKET_TRANSPORT_CODES.TIMEOUT);
      if (!payload || typeof payload !== 'object' || payload.code !== 0) throw fail(MARKET_TRANSPORT_CODES.UPSTREAM);
      const names = payload.data?.fields;
      const rows = payload.data?.items;
      if (!Array.isArray(names) || !Array.isArray(rows)) throw fail(MARKET_TRANSPORT_CODES.RESPONSE);
      return rows.map((row) => {
        const out = {};
        names.forEach((name, i) => { out[name] = Array.isArray(row) ? row[i] : undefined; });
        return out;
      });
    } catch (error) {
      if (error instanceof MarketTransportError) throw error;
      if (controller.signal.aborted || (error && error.name === 'AbortError')) throw fail(MARKET_TRANSPORT_CODES.TIMEOUT);
      throw fail(MARKET_TRANSPORT_CODES.UPSTREAM);
    } finally {
      clearTimeout(timer);
    }
  };
}

function buildSymbolSeries(dailyRows, adjRows, calendarSet) {
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
  const dates = [...closes.keys()].sort();
  const latestFactor = [...factors.keys()].sort().map((d) => factors.get(d)).at(-1) ?? null;
  const bars = dates.map((date) => ({ date, close: closes.get(date) }));
  const barsFwdadj = latestFactor === null
    ? []
    : dates.filter((date) => factors.has(date)).map((date) => ({
      date,
      close: round4(closes.get(date) * factors.get(date) / latestFactor),
    }));
  return { bars, bars_fwdadj: barsFwdadj };
}

async function buildSnapshot({ symbols, start, end, callTushare, now }) {
  const calendarRows = await callTushare({
    apiName: 'trade_cal',
    params: { exchange: 'SSE', start_date: compactDate(start), end_date: compactDate(end), is_open: '1' },
    fields: 'cal_date',
  });
  const allDays = [...new Set(calendarRows.map((r) => normalizeTradeDate(r.cal_date)).filter(Boolean))].sort();
  if (allDays.length === 0) throw fail(MARKET_TRANSPORT_CODES.NO_DATA);
  const calendarSet = new Set(allDays);

  const seriesList = await Promise.all(symbols.map(async (symbol) => {
    const tsCode = marketSymbolToTsCode(symbol);
    const [dailyRows, adjRows] = await Promise.all([
      callTushare({
        apiName: 'daily',
        params: { ts_code: tsCode, start_date: compactDate(start), end_date: compactDate(end) },
        fields: 'ts_code,trade_date,close',
      }),
      callTushare({
        apiName: 'adj_factor',
        params: { ts_code: tsCode, start_date: compactDate(start), end_date: compactDate(end) },
        fields: 'ts_code,trade_date,adj_factor',
      }),
    ]);
    return { symbol, ...buildSymbolSeries(dailyRows, adjRows, calendarSet) };
  }));

  const latestBarDate = seriesList
    .flatMap((s) => s.bars.map((b) => b.date))
    .sort()
    .at(-1) ?? null;
  if (latestBarDate === null) throw fail(MARKET_TRANSPORT_CODES.NO_DATA);
  const asOfDate = latestBarDate;
  const tradingDays = allDays.filter((d) => d <= asOfDate);
  if (tradingDays.length === 0) throw fail(MARKET_TRANSPORT_CODES.NO_DATA);

  const series = {};
  for (const item of seriesList) {
    series[item.symbol] = {
      bars: item.bars.filter((b) => b.date <= asOfDate),
      bars_fwdadj: item.bars_fwdadj.filter((b) => b.date <= asOfDate),
    };
  }

  const range = { start, end: asOfDate };
  const canonical = JSON.stringify({
    asOfDate,
    calendar: tradingDays,
    symbols: symbols.map((symbol) => ({ symbol, ...series[symbol] })),
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
      apis: ['trade_cal', 'daily', 'adj_factor'],
      freshness: 'latest_closed_daily',
      adjustment: '前复权 close = close × adj_factor / 区间最新 adj_factor；估值使用不复权 close',
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
      symbols: [...symbols],
      provider: 'tushare',
      calendar_source: 'trade_cal（SSE，is_open=1）',
      adjustment_basis: '前复权展示；不复权估值',
    },
  };
}

export function createTushareMarketTransport({
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  ttlMs = 60000,
  maxEntries = 32,
  now = () => new Date(),
} = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('token 必须为非空字符串');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正整数');
  if (!Number.isInteger(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs 必须为非负整数');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError('maxEntries 必须为正整数');

  const callTushare = createTushareCaller({ token: token.trim(), fetchImpl, timeoutMs });
  const cache = new Map();

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

      const pending = buildSnapshot({ symbols: unique, start, end, callTushare, now })
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
