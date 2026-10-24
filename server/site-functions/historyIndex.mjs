// 服务端历史账单投影：只把本人已发布账单聚合成跨账单检索所需的紧凑行。
// 字段白名单固定在 projectHistoryRow 里：不返回账单 UUID、文件名、原始成交或金额。
export const HISTORY_INDEX_VERSION = 'history-index-1';

export const HOLDING_BUCKETS = Object.freeze([
  Object.freeze({ id: '0-3', label: '0–3 天', min: 0, max: 3 }),
  Object.freeze({ id: '4-10', label: '4–10 天', min: 4, max: 10 }),
  Object.freeze({ id: '11-30', label: '11–30 天', min: 11, max: 30 }),
  Object.freeze({ id: '31+', label: '31 天以上', min: 31, max: null }),
]);

const SYMBOL_RE = /^\d{6}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function bucketOf(days) {
  if (!Number.isFinite(days) || days < 0) return null;
  return HOLDING_BUCKETS.find((bucket) => (bucket.max === null
    ? days >= bucket.min
    : days >= bucket.min && days <= bucket.max)) ?? null;
}

function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86400000);
}

function holdingBucketsOf(trades) {
  const rows = (Array.isArray(trades) ? trades : [])
    .filter((t) => t && DATE_RE.test(String(t.trade_date ?? '')) && SYMBOL_RE.test(String(t.symbol ?? ''))
      && (t.side === 'buy' || t.side === 'sell'))
    .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
  const queues = new Map();
  const counts = new Map();
  for (const trade of rows) {
    const symbol = String(trade.symbol);
    if (trade.side === 'buy') {
      const queue = queues.get(symbol) ?? [];
      queue.push(String(trade.trade_date));
      queues.set(symbol, queue);
      continue;
    }
    const queue = queues.get(symbol);
    if (!queue || queue.length === 0) continue;
    const days = daysBetween(queue.shift(), String(trade.trade_date));
    if (days === null) continue;
    const bucket = bucketOf(days);
    if (!bucket) continue;
    counts.set(bucket.id, (counts.get(bucket.id) ?? 0) + 1);
  }
  return HOLDING_BUCKETS
    .filter((bucket) => counts.has(bucket.id))
    .map((bucket) => ({ id: bucket.id, label: bucket.label, count: counts.get(bucket.id) }));
}

function symbolsOf(trades) {
  const list = (Array.isArray(trades) ? trades : [])
    .map((trade) => trade?.symbol)
    .filter((symbol) => SYMBOL_RE.test(String(symbol ?? '')));
  return [...new Set(list.map(String))].sort();
}

function patternsOf(patterns) {
  const seen = new Set();
  const out = [];
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (!pattern || typeof pattern !== 'object') continue;
    if (pattern.status !== '成立') continue;
    const id = typeof pattern.pattern_id === 'string' ? pattern.pattern_id : null;
    if (!id || seen.has(id)) continue;
    const hits = Number.isFinite(pattern.sample_n) ? pattern.sample_n : 0;
    if (hits <= 0) continue;
    seen.add(id);
    out.push({ id, name: typeof pattern.name === 'string' && pattern.name ? pattern.name : id, hits });
  }
  return out;
}

function publishedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.version !== 1 && snapshot.version !== 2) return null;
  if (snapshot.review?.portfolio_published !== true) return null;
  if (snapshot.version === 2 && snapshot.profile?.latest?.review?.portfolio_published !== true) return null;
  return snapshot;
}

export function projectHistoryRow({ ref, effective_date = null, snapshot = null, trades = null } = {}) {
  const published = publishedSnapshot(snapshot);
  if (!published) {
    return { ok: false, excluded: { ref, reason: snapshot ? 'unpublished' : 'no_snapshot' } };
  }
  if (published.version !== 2 || published.report_available !== true
      || published.report === null || typeof published.report !== 'object') {
    return { ok: false, excluded: { ref, reason: 'report_missing' } };
  }
  const latest = published.profile?.latest ?? null;
  const tradeCount = Number.isFinite(latest?.bill?.trade_count)
    ? Math.max(0, Math.round(latest.bill.trade_count))
    : Math.max(0, Math.round(Number(published.bill?.trade_count) || 0));
  return {
    ok: true,
    row: {
      ref,
      effective_date: DATE_RE.test(String(effective_date ?? '')) ? String(effective_date) : null,
      trade_count: tradeCount,
      patterns: patternsOf(latest?.behavior?.patterns ?? []),
      symbols: symbolsOf(trades),
      holding_buckets: holdingBucketsOf(trades),
      report_available: true,
    },
  };
}

export function buildHistoryIndex({ entries = [], excludeRefs = [] } = {}) {
  const excludedRefs = new Set((Array.isArray(excludeRefs) ? excludeRefs : []).filter(Boolean));
  const rows = [];
  const excluded = [];
  let scanned = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    scanned += 1;
    const projected = projectHistoryRow(entry);
    if (excludedRefs.has(entry?.ref)) {
      excluded.push({ ref: entry.ref, reason: 'current_bill' });
      continue;
    }
    if (projected.ok) rows.push(projected.row);
    else excluded.push(projected.excluded);
  }
  rows.sort((a, b) => {
    if (a.effective_date === b.effective_date) return a.ref.localeCompare(b.ref);
    if (a.effective_date === null) return 1;
    if (b.effective_date === null) return -1;
    return b.effective_date.localeCompare(a.effective_date);
  });
  return {
    version: HISTORY_INDEX_VERSION,
    scope: 'user_saved',
    synthetic: false,
    rows,
    excluded,
    coverage: {
      bills_scanned: scanned,
      bills_included: rows.length,
      bills_excluded: excluded.filter((item) => item.reason !== 'current_bill').length,
    },
  };
}
