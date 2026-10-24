// 报告快照 v2：画像摘要 + 已脱敏的报告 bundle，供换设备后还原报告页。
// 不含原始 CSV、文件名或行情明细；超过云端上限时只保留画像，不截断报告。
export const REPORT_SNAPSHOT_VERSION = 2;
export const REPORT_SNAPSHOT_LIMITS = Object.freeze({
  maxBytes: 480 * 1024,
  maxDepth: 15,
  maxNodes: 19000,
});

const PRIVATE_KEY_RE = /^(file|file_name|filename|source_file|source_filename|sourcefile|sourcefilename|raw_file|rawfile)$/iu;
// 报告渲染不消费行情明细；它们只供同进程的 planner 复用，上传只会挤占快照额度。
const NON_REPORT_KEYS = new Set(['prices', 'closes', 'market']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitize(value, depth = 0) {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;
  if (depth > REPORT_SNAPSHOT_LIMITS.maxDepth) return null;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY_RE.test(key)) continue;
    if (depth === 0 && NON_REPORT_KEYS.has(key)) continue;
    out[key] = sanitize(item, depth + 1);
  }
  return out;
}

function stats(value) {
  let nodes = 0;
  let depth = 0;
  const stack = [{ value, level: 0 }];
  while (stack.length) {
    const { value: node, level } = stack.pop();
    nodes += 1;
    if (level > depth) depth = level;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ value: item, level: level + 1 });
    } else if (isPlainObject(node)) {
      for (const item of Object.values(node)) stack.push({ value: item, level: level + 1 });
    }
  }
  return { nodes, depth };
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function sanitizeReportBundle(bundle) {
  if (!isPlainObject(bundle)) return null;
  return sanitize(bundle);
}

function withinLimits(value) {
  if (!value) return false;
  const { nodes, depth } = stats(value);
  return nodes <= REPORT_SNAPSHOT_LIMITS.maxNodes
    && depth <= REPORT_SNAPSHOT_LIMITS.maxDepth
    && byteLength(value) <= REPORT_SNAPSHOT_LIMITS.maxBytes;
}

export function buildReportSnapshot({ profile = null, bundle = null, reportKey = null } = {}) {
  const latest = profile?.latest ?? null;
  if (!latest?.profile_key || latest.review?.portfolio_published !== true) return null;
  if (typeof latest.at !== 'string' || !Number.isFinite(latest.bill?.trade_count)) return null;
  const base = {
    version: REPORT_SNAPSHOT_VERSION,
    at: latest.at,
    profile_key: latest.profile_key,
    report_key: typeof reportKey === 'string' && reportKey ? reportKey : null,
    bill: { trade_count: latest.bill.trade_count },
    review: latest.review,
    profile: { latest },
  };
  const report = sanitizeReportBundle(bundle);
  const withReport = { ...base, report, report_available: true };
  if (withinLimits(withReport)) return withReport;
  const fallback = { ...base, report: null, report_available: false };
  return withinLimits(fallback) ? fallback : null;
}
