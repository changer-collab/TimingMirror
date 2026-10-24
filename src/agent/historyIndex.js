// 历史账单索引：把本人已保存账单的已发布快照投影为紧凑行，供跨账单同类操作检索。
// 边界：只输出聚合计数与标的代码；不含账单 UUID、文件名、原始成交行或金额。
export const HISTORY_INDEX_VERSION = 'history-index-1';

export const HISTORY_EXCLUDED_REASONS = Object.freeze({
  current_bill: '当前账单',
  no_snapshot: '没有生成过报告',
  unpublished: '报告未发布',
  report_missing: '报告未保存',
});

export const HOLDING_BUCKETS = Object.freeze([
  Object.freeze({ id: '0-3', label: '0–3 天', min: 0, max: 3 }),
  Object.freeze({ id: '4-10', label: '4–10 天', min: 4, max: 10 }),
  Object.freeze({ id: '11-30', label: '11–30 天', min: 11, max: 30 }),
  Object.freeze({ id: '31+', label: '31 天以上', min: 31, max: null }),
]);

const SYMBOL_RE = /^\d{6}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i += 1) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/* 不透明引用：同输入稳定，不能反推账单 UUID。 */
export function refOf(value) {
  return `h${fnv1a64(String(value ?? ''))}`;
}

export function holdingBucketOf(days) {
  if (!Number.isFinite(days) || days < 0) return null;
  return HOLDING_BUCKETS.find((bucket) => (bucket.max === null ? days >= bucket.min : days >= bucket.min && days <= bucket.max)) ?? null;
}

function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86400000);
}

/* 按先进先出配对买卖，只产出持有天数桶计数；不保留成交明细。 */
export function holdingBucketsOf(trades) {
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
    const buyDate = queue.shift();
    const days = daysBetween(buyDate, String(trade.trade_date));
    if (days === null) continue;
    const bucket = holdingBucketOf(days);
    if (!bucket) continue;
    counts.set(bucket.id, (counts.get(bucket.id) ?? 0) + 1);
  }
  return HOLDING_BUCKETS
    .filter((bucket) => counts.has(bucket.id))
    .map((bucket) => ({ id: bucket.id, label: bucket.label, count: counts.get(bucket.id) }));
}

export function symbolsOf(trades) {
  const list = (Array.isArray(trades) ? trades : [])
    .map((trade) => trade?.symbol)
    .filter((symbol) => SYMBOL_RE.test(String(symbol ?? '')));
  return [...new Set(list.map(String))].sort();
}

/* 只取成立且命中过的重复模式；证据不足/不成立不参与跨账单匹配。
   同时接受已投影的 {id,name,hits}，便于工具结果二次使用。 */
export function establishedPatternsOf(patterns) {
  const rows = Array.isArray(patterns) ? patterns : [];
  const seen = new Set();
  const out = [];
  for (const pattern of rows) {
    if (!pattern || typeof pattern !== 'object') continue;
    const id = typeof pattern.pattern_id === 'string' ? pattern.pattern_id : pattern.id;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    const hasStatus = typeof pattern.status === 'string';
    if (hasStatus && pattern.status !== '成立') continue;
    if (!hasStatus && pattern.pattern_id !== undefined) continue;
    const hits = Number.isFinite(pattern.sample_n) ? pattern.sample_n : (Number.isFinite(pattern.hits) ? pattern.hits : 0);
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

function reportSaved(snapshot) {
  return snapshot.version === 2 && snapshot.report_available === true
    && snapshot.report !== null && typeof snapshot.report === 'object';
}

/**
 * 单份账单 → 紧凑索引行。未发布或没有报告时返回排除原因，不生成行。
 * @param {{ref:string,effective_date?:string|null,snapshot?:object|null,trades?:Array|null}} entry
 */
export function projectHistoryRow({ ref, effective_date = null, snapshot = null, trades = null } = {}) {
  if (typeof ref !== 'string' || !ref) throw new TypeError('ref 必须为非空字符串');
  const published = publishedSnapshot(snapshot);
  if (!published) {
    return { ok: false, excluded: { ref, reason: snapshot ? 'unpublished' : 'no_snapshot' } };
  }
  if (!reportSaved(published)) {
    return { ok: false, excluded: { ref, reason: 'report_missing' } };
  }
  const latest = published.version === 2 ? published.profile?.latest : null;
  const tradeCount = Number.isFinite(latest?.bill?.trade_count)
    ? Math.max(0, Math.round(latest.bill.trade_count))
    : Math.max(0, Math.round(Number(published.bill?.trade_count) || 0));
  const patterns = establishedPatternsOf(latest?.behavior?.patterns ?? []);
  return {
    ok: true,
    row: {
      ref,
      effective_date: DATE_RE.test(String(effective_date ?? '')) ? String(effective_date) : null,
      trade_count: tradeCount,
      patterns,
      symbols: symbolsOf(trades),
      holding_buckets: holdingBucketsOf(trades),
      report_available: true,
    },
  };
}

/**
 * @param {object} p
 * @param {Array} [p.entries] 每项 {ref, effective_date, snapshot, trades}
 * @param {string[]} [p.excludeRefs] 需要排除的引用（当前账单）
 * @param {boolean} [p.synthetic] 是否为示例账单组
 * @param {string} [p.scope] 'user_saved' | 'demo_group'
 */
export function buildHistoryIndex({
  entries = [], excludeRefs = [], synthetic = false, scope = 'user_saved',
} = {}) {
  const excludedRefs = new Set((Array.isArray(excludeRefs) ? excludeRefs : []).filter(Boolean));
  const rows = [];
  const excluded = [];
  let scanned = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    scanned += 1;
    const projected = projectHistoryRow(entry);
    if (excludedRefs.has(projected.ok ? projected.row.ref : projected.excluded.ref)) {
      excluded.push({ ref: projected.excluded?.ref ?? projected.row.ref, reason: 'current_bill' });
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
    scope: scope === 'demo_group' ? 'demo_group' : 'user_saved',
    synthetic: synthetic === true,
    rows,
    excluded,
    coverage: {
      bills_scanned: scanned,
      bills_included: rows.length,
      bills_excluded: excluded.filter((item) => item.reason !== 'current_bill').length,
    },
  };
}
