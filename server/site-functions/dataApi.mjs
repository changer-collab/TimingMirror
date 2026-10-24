// Bills and profile facts API.
// Ownership is application-level: requireUser(request) is the only identity source,
// every query is scoped by user_id, and no browser-supplied owner field is accepted.
import { requireUser, UserContextError } from './auth.mjs';
import {
  normalizeProfileSummaryRequest,
  profileDigestHash,
  validateProfileSummaryValue,
} from './profileSummary.mjs';

export const DATA_CODES = Object.freeze({
  METHOD: 'method_not_allowed',
  NOT_FOUND: 'not_found',
  REQUEST_INVALID: 'request_invalid',
  CONTENT_TYPE: 'content_type_invalid',
  BODY_TOO_LARGE: 'request_too_large',
  LOGIN_REQUIRED: 'login_required',
  INVALID_CONTEXT: 'invalid_user_context',
  DATABASE_UNAVAILABLE: 'database_unavailable',
  READ_FAILED: 'read_failed',
  WRITE_REJECTED: 'write_rejected',
  WRITE_UNKNOWN: 'write_result_unknown',
  HASH_MISMATCH: 'content_hash_mismatch',
  DATA_UNAVAILABLE: 'data_unavailable',
});

export const DATA_LIMITS = Object.freeze({
  billListDefault: 20,
  billListMax: 50,
  billBody: 1024 * 1024 + 64 * 1024,
  snapshotBody: 512 * 1024,
  factBody: 32 * 1024,
  summaryBody: 64 * 1024,
  ruleBody: 256 * 1024,
  maxTrades: 2000,
  maxFacts: 10,
  maxRules: 500,
  maxMetadataBytes: 16 * 1024,
  maxSnapshotBytes: 512 * 1024,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const PROFILE_KEY_RE = /^[0-9a-f]{8}$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/u;
const TEXT_CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const RULE_HASH_RE = /^[0-9a-f]{16}$/u;
const RULE_STATUSES = new Set(['已确认', '已改写', '已拒绝']);
// 原始文件名属于本机信息，快照中任何层级都不接受文件名字段。
const PRIVATE_KEY_RE = /^(file|file_name|filename|source_file|source_filename|sourcefile|sourcefilename|raw_file|rawfile)$/iu;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 20000;

const BILL_KEYS = new Set([
  'content_hash', 'context_id', 'source_type', 'effective_date',
  'import_method', 'metadata', 'payload_mode', 'payload',
]);
const META_KEYS = new Set([
  'trades_count', 'warnings_count', 'data_mode', 'date_from', 'date_to', 'symbol_count',
]);
const TRADE_KEYS = new Set([
  'trade_id', 'trade_date', 'symbol', 'side', 'price', 'quantity', 'fee', 'tax',
]);
const SNAPSHOT_KEYS = new Set(['snapshot']);
const RULES_KEYS = new Set(['versions']);
const FACT_KEYS = new Set(['kind', 'key', 'value', 'evidence', 'source', 'source_ref']);
const FACT_KINDS = new Set(['goal', 'preference', 'constraint', 'habit', 'risk_tolerance']);
const FACT_SOURCES = new Set(['chat', 'manual']);

const BILL_COLUMNS = 'id,imported_at,effective_date,payload_mode,metadata_json,snapshot_json,snapshot_at,created_at,updated_at';
const BILL_COLUMNS_WITH_PAYLOAD = `${BILL_COLUMNS},payload_json`;
const FACT_COLUMNS = 'id,kind,fact_key,fact_value,evidence,source,source_ref,confidence,created_at';

function json(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function fail(status, code, extraHeaders = {}) {
  return json(status, { ok: false, error: code }, extraHeaders);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function jsonBytes(value) {
  return utf8Length(JSON.stringify(value));
}

function boundedText(value, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) return null;
  if (utf8Length(trimmed) > max || TEXT_CONTROL_RE.test(trimmed)) return null;
  return trimmed;
}

function boundedId(value, max = 64) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || utf8Length(trimmed) > max || !ID_RE.test(trimmed)) return null;
  return trimmed;
}

function integerWithin(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function dateText(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return value;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

// 拒绝危险键与文件名键：快照会原样回到浏览器，服务端也要守住隐私边界。
function jsonShapeSafe(value) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (node === null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push([item, depth + 1]);
      continue;
    }
    if (!isPlainObject(node)) return false;
    for (const [key, item] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key) || PRIVATE_KEY_RE.test(key)) return false;
      stack.push([item, depth + 1]);
    }
  }
  return true;
}

function positiveNumber(value, { allowZero = false } = {}) {
  return typeof value === 'number' && Number.isFinite(value)
    && (allowZero ? value >= 0 : value > 0) ? value : null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function numberText(value) {
  return Number.isFinite(value) ? String(value) : '';
}

// Trade order, ids and source filenames are excluded so reimporting the same bill dedupes.
export async function contentHashOfTrades(trades) {
  const rows = (Array.isArray(trades) ? trades : []).map((trade) => [
    trade?.trade_date,
    trade?.symbol,
    trade?.side,
    numberText(trade?.price),
    numberText(trade?.quantity),
    trade?.fee == null ? '' : numberText(trade.fee),
    trade?.tax == null ? '' : numberText(trade.tax),
  ].join('\t'));
  rows.sort();
  return sha256Hex(rows.join('\n'));
}

export function resolveDataRoute(pathname, method) {
  const parts = String(pathname).replace(/\/+$/u, '').split('/').filter(Boolean);
  const apiIndex = parts.lastIndexOf('api');
  if (apiIndex < 0) return null;
  const rest = parts.slice(apiIndex + 1);
  if (rest[0] !== 'bills' && rest[0] !== 'profile' && rest[0] !== 'rules') return null;
  const route = (kind, allow, id = null) => (allow.includes(method)
    ? { kind, allow, id }
    : { methodNotAllowed: true, allow });

  if (rest[0] === 'bills') {
    if (rest.length === 1) return route(method === 'GET' ? 'bill.list' : 'bill.create', ['GET', 'POST']);
    if (rest.length === 2) return route(method === 'GET' ? 'bill.get' : 'bill.delete', ['GET', 'DELETE'], rest[1]);
    if (rest.length === 3 && rest[2] === 'snapshot') return route('bill.snapshot', ['POST'], rest[1]);
    return { kind: null };
  }
  if (rest[0] === 'rules') {
    if (rest.length !== 1) return { kind: null };
    return route(method === 'GET' ? 'rules.get' : 'rules.save', ['GET', 'PUT']);
  }
  if (rest.length === 1) return route('profile.get', ['GET']);
  if (rest.length === 2 && rest[1] === 'facts') return route('profile.facts.create', ['POST']);
  if (rest.length === 2 && rest[1] === 'summary') return route('profile.summary.save', ['POST']);
  if (rest.length === 3 && rest[1] === 'facts') return route('profile.facts.delete', ['DELETE'], rest[2]);
  return { kind: null };
}

export function dataMethodNotAllowed(allow) {
  return fail(405, DATA_CODES.METHOD, { Allow: allow.join(', ') });
}

export async function handleDataRequest({
  request,
  supabase,
  route,
  now = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID(),
}) {
  if (!supabase) return fail(503, DATA_CODES.DATABASE_UNAVAILABLE);
  let user;
  try {
    user = requireUser(request);
  } catch (error) {
    if (error instanceof UserContextError) return fail(error.status, error.code);
    return fail(403, DATA_CODES.INVALID_CONTEXT);
  }

  try {
    if (route.kind === 'bill.create') return await createBill({ request, supabase, user, now, randomUUID });
    if (route.kind === 'bill.list') return await listBills({ request, supabase, user });
    if (route.kind === 'bill.get') return await getBill({ supabase, user, id: route.id });
    if (route.kind === 'bill.snapshot') {
      return await saveSnapshot({ request, supabase, user, id: route.id, now });
    }
    if (route.kind === 'bill.delete') return await deleteBill({ supabase, user, id: route.id });
    if (route.kind === 'rules.get') return await getRules({ supabase, user });
    if (route.kind === 'rules.save') return await saveRules({ request, supabase, user, now });
    if (route.kind === 'profile.get') return await getProfile({ supabase, user });
    if (route.kind === 'profile.facts.create') {
      return await createFacts({ request, supabase, user, now, randomUUID });
    }
    if (route.kind === 'profile.facts.delete') {
      return await deleteFact({ supabase, user, id: route.id });
    }
    if (route.kind === 'profile.summary.save') {
      return await saveProfileSummary({ request, supabase, user, now });
    }
    return fail(404, DATA_CODES.NOT_FOUND);
  } catch {
    return fail(503, DATA_CODES.DATA_UNAVAILABLE);
  }
}

async function readJson(request, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')) {
    return { ok: false, status: 415, code: DATA_CODES.CONTENT_TYPE };
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await request.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, status: 413, code: DATA_CODES.BODY_TOO_LARGE };
  }
  if (!request.body) return { ok: false, status: 400, code: DATA_CODES.REQUEST_INVALID };
  let reader;
  try { reader = request.body.getReader(); } catch {
    return { ok: false, status: 400, code: DATA_CODES.REQUEST_INVALID };
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { ok: false, status: 413, code: DATA_CODES.BODY_TOO_LARGE };
      }
      chunks.push(value);
    }
  } catch {
    try { await reader.cancel(); } catch { /* ignore */ }
    return { ok: false, status: 400, code: DATA_CODES.REQUEST_INVALID };
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400, code: DATA_CODES.REQUEST_INVALID };
  }
  if (!isPlainObject(value)) return { ok: false, status: 400, code: DATA_CODES.REQUEST_INVALID };
  return { ok: true, value };
}

function normalizeMetadata(value) {
  if (!hasOnlyKeys(value, META_KEYS)) return null;
  const tradesCount = integerWithin(value.trades_count, 0, 100000);
  const warningsCount = value.warnings_count === undefined ? 0 : integerWithin(value.warnings_count, 0, 10000);
  if (tradesCount === null || warningsCount === null) return null;
  const dataMode = value.data_mode == null ? null : boundedId(value.data_mode, 32);
  if (value.data_mode != null && dataMode === null) return null;
  const dateFrom = value.date_from == null ? null : dateText(value.date_from);
  const dateTo = value.date_to == null ? null : dateText(value.date_to);
  if (value.date_from != null && dateFrom === null) return null;
  if (value.date_to != null && dateTo === null) return null;
  if (dateFrom && dateTo && dateFrom > dateTo) return null;
  const symbolCount = value.symbol_count == null ? null : integerWithin(value.symbol_count, 0, 100000);
  if (value.symbol_count != null && symbolCount === null) return null;
  const metadata = {
    trades_count: tradesCount,
    warnings_count: warningsCount,
    data_mode: dataMode,
    date_from: dateFrom,
    date_to: dateTo,
    symbol_count: symbolCount,
  };
  return jsonBytes(metadata) <= DATA_LIMITS.maxMetadataBytes ? metadata : null;
}

function normalizeTrade(value) {
  if (!hasOnlyKeys(value, TRADE_KEYS)) return null;
  const tradeId = boundedId(value.trade_id, 32);
  const tradeDate = dateText(value.trade_date);
  const symbol = typeof value.symbol === 'string' && /^\d{6}$/u.test(value.symbol) ? value.symbol : null;
  const side = value.side === 'buy' || value.side === 'sell' ? value.side : null;
  const price = positiveNumber(value.price);
  const quantity = positiveNumber(value.quantity);
  const fee = value.fee == null ? null : positiveNumber(value.fee, { allowZero: true });
  const tax = value.tax == null ? null : positiveNumber(value.tax, { allowZero: true });
  if (!tradeId || !tradeDate || !symbol || !side || price === null || quantity === null
      || (value.fee != null && fee === null) || (value.tax != null && tax === null)) return null;
  return {
    trade_id: tradeId,
    trade_date: tradeDate,
    symbol,
    side,
    price,
    quantity,
    fee,
    tax,
  };
}

function normalizePayload(value) {
  if (!hasOnlyKeys(value, new Set(['trades'])) || !Array.isArray(value.trades)) return null;
  if (value.trades.length > DATA_LIMITS.maxTrades) return null;
  const trades = [];
  for (const raw of value.trades) {
    const trade = normalizeTrade(raw);
    if (!trade) return null;
    trades.push(trade);
  }
  return { trades };
}

async function normalizeBillCreate(input) {
  if (!hasOnlyKeys(input, BILL_KEYS)) return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  if (typeof input.content_hash !== 'string' || !HASH_RE.test(input.content_hash)) {
    return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  }
  if (input.source_type !== 'local') return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  const contextId = input.context_id == null ? null : boundedId(input.context_id, 64);
  if (input.context_id != null && contextId === null) return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  const effectiveDate = input.effective_date == null ? null : dateText(input.effective_date);
  if (input.effective_date != null && effectiveDate === null) return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  const importMethod = input.import_method == null ? 'unknown' : input.import_method;
  if (!['manual', 'ai', 'unknown'].includes(importMethod)) {
    return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  }
  const metadata = normalizeMetadata(input.metadata);
  if (!metadata) return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  if (input.payload_mode !== 'summary' && input.payload_mode !== 'full') {
    return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  }
  let payload = null;
  if (input.payload_mode === 'full') {
    payload = normalizePayload(input.payload);
    if (!payload || payload.trades.length !== metadata.trades_count) {
      return { ok: false, code: DATA_CODES.REQUEST_INVALID };
    }
    if (await contentHashOfTrades(payload.trades) !== input.content_hash) {
      return { ok: false, code: DATA_CODES.HASH_MISMATCH };
    }
  } else if (input.payload != null) {
    return { ok: false, code: DATA_CODES.REQUEST_INVALID };
  }
  return {
    ok: true,
    value: {
      content_hash: input.content_hash,
      context_id: contextId,
      source_type: 'local',
      effective_date: effectiveDate,
      import_method: importMethod,
      metadata,
      payload_mode: input.payload_mode,
      payload,
    },
  };
}

function validSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || (snapshot.version !== 1 && snapshot.version !== 2)) return false;
  if (typeof snapshot.profile_key !== 'string' || !PROFILE_KEY_RE.test(snapshot.profile_key)) return false;
  if (isoTimestamp(snapshot.at) === null) return false;
  if (!isPlainObject(snapshot.bill)) return false;
  if (integerWithin(snapshot.bill.trade_count, 0, 100000) === null) return false;
  if (snapshot.review?.portfolio_published !== true) return false;
  if (snapshot.version === 2) {
    if (!isPlainObject(snapshot.profile) || !isPlainObject(snapshot.profile.latest)) return false;
    if (snapshot.profile.latest.profile_key !== snapshot.profile_key) return false;
    if (snapshot.profile.latest.review?.portfolio_published !== true) return false;
    if (snapshot.report != null && !isPlainObject(snapshot.report)) return false;
    if (snapshot.report_available !== undefined && typeof snapshot.report_available !== 'boolean') return false;
  }
  if (!jsonShapeSafe(snapshot)) return false;
  return jsonBytes(snapshot) <= DATA_LIMITS.maxSnapshotBytes;
}

function validRuleRecord(record) {
  if (!isPlainObject(record)) return false;
  if (typeof record.hash !== 'string' || !RULE_HASH_RE.test(record.hash)) return false;
  if (!Number.isInteger(record.v) || record.v < 1 || record.v > 1000000) return false;
  if (!RULE_STATUSES.has(record.status)) return false;
  return jsonBytes(record) <= 16 * 1024 && jsonShapeSafe(record);
}

function normalizeRuleSet(versions) {
  if (!Array.isArray(versions) || versions.length > DATA_LIMITS.maxRules) return null;
  if (!versions.every(validRuleRecord)) return null;
  return versions;
}

function normalizeFact(input) {
  if (!hasOnlyKeys(input, FACT_KEYS)) return null;
  if (!FACT_KINDS.has(input.kind)) return null;
  if (typeof input.key !== 'string' || !SLUG_RE.test(input.key)) return null;
  const factValue = boundedText(input.value, 240);
  if (!factValue) return null;
  const source = input.source == null ? 'chat' : input.source;
  if (!FACT_SOURCES.has(source)) return null;
  const evidence = input.evidence == null ? null : boundedText(input.evidence, 120);
  if (input.evidence != null && evidence === null) return null;
  if (source === 'chat' && !evidence) return null;
  const sourceRef = input.source_ref == null ? null : boundedId(input.source_ref, 64);
  if (input.source_ref != null && sourceRef === null) return null;
  return {
    kind: input.kind,
    key: input.key,
    value: factValue,
    evidence,
    source,
    source_ref: sourceRef,
  };
}

function dbFailure(error, writing) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const rejected = /^(22|23|42)[A-Z0-9]{3}$/u.test(code);
  return fail(503, writing
    ? (rejected ? DATA_CODES.WRITE_REJECTED : DATA_CODES.WRITE_UNKNOWN)
    : DATA_CODES.READ_FAILED);
}

function billView(row, { includePayload = false } = {}) {
  return {
    id: row.id,
    imported_at: row.imported_at,
    effective_date: row.effective_date ?? null,
    payload_mode: row.payload_mode,
    has_payload: row.payload_mode === 'full',
    metadata: row.metadata_json ?? {},
    snapshot: row.snapshot_json ?? null,
    snapshot_at: row.snapshot_at ?? null,
    ...(includePayload && row.payload_mode === 'full'
      ? { payload: row.payload_json ?? null }
      : {}),
  };
}

function factView(row) {
  return {
    id: row.id,
    kind: row.kind,
    key: row.fact_key,
    value: row.fact_value,
    evidence: row.evidence ?? null,
    source: row.source,
    source_ref: row.source_ref ?? null,
    confidence: row.confidence,
    created_at: row.created_at,
  };
}

function queryInteger(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,7}$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

async function createBill({ request, supabase, user, now, randomUUID }) {
  const parsed = await readJson(request, DATA_LIMITS.billBody);
  if (!parsed.ok) return fail(parsed.status, parsed.code);
  const normalized = await normalizeBillCreate(parsed.value);
  if (!normalized.ok) return fail(400, normalized.code);
  const value = normalized.value;
  const billKey = await sha256Hex(`${user.user_id}\n${value.content_hash}`);
  const at = now();

  const existing = await supabase.from('bills')
    .select(BILL_COLUMNS)
    .eq('bill_key', billKey)
    .maybeSingle();
  if (existing.error) return dbFailure(existing.error, false);
  if (existing.data) {
    let row = existing.data;
    if (value.payload_mode === 'full' && row.payload_mode !== 'full') {
      const upgraded = await supabase.from('bills')
        .update({
          payload_mode: 'full',
          payload_json: value.payload,
          updated_at: at,
        })
        .eq('id', row.id)
        .eq('user_id', user.user_id)
        .select(BILL_COLUMNS)
        .maybeSingle();
      if (upgraded.error) return dbFailure(upgraded.error, true);
      if (upgraded.data) row = upgraded.data;
    }
    return json(200, { ok: true, duplicate: true, bill: billView(row) });
  }

  const row = {
    id: randomUUID(),
    user_id: user.user_id,
    bill_key: billKey,
    content_hash: value.content_hash,
    context_id: value.context_id,
    status: 'confirmed',
    source_type: value.source_type,
    effective_date: value.effective_date,
    imported_at: at,
    payload_mode: value.payload_mode,
    metadata_json: value.metadata,
    payload_json: value.payload,
    snapshot_json: null,
    snapshot_hash: null,
    snapshot_at: null,
    created_at: at,
    updated_at: at,
  };
  const inserted = await supabase.from('bills').insert(row).select(BILL_COLUMNS).single();
  if (inserted.error) {
    if (inserted.error.code === '23505') {
      const replay = await supabase.from('bills')
        .select(BILL_COLUMNS)
        .eq('bill_key', billKey)
        .maybeSingle();
      if (!replay.error && replay.data) {
        return json(200, { ok: true, duplicate: true, bill: billView(replay.data) });
      }
    }
    return dbFailure(inserted.error, true);
  }
  return json(201, { ok: true, duplicate: false, bill: billView(inserted.data) });
}

async function listBills({ request, supabase, user }) {
  const url = new URL(request.url);
  const limit = queryInteger(url, 'limit', DATA_LIMITS.billListDefault, 1, DATA_LIMITS.billListMax);
  const offset = queryInteger(url, 'offset', 0, 0, 100000);
  if (limit === null || offset === null) return fail(400, DATA_CODES.REQUEST_INVALID);
  const result = await supabase.from('bills')
    .select(BILL_COLUMNS)
    .eq('user_id', user.user_id)
    .order('imported_at', { ascending: false })
    .range(offset, offset + limit);
  if (result.error) return dbFailure(result.error, false);
  const rows = Array.isArray(result.data) ? result.data : [];
  const hasMore = rows.length > limit;
  return json(200, {
    ok: true,
    bills: rows.slice(0, limit).map((row) => billView(row)),
    next_offset: hasMore ? offset + limit : null,
  });
}

async function getBill({ supabase, user, id }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const result = await supabase.from('bills')
    .select(BILL_COLUMNS_WITH_PAYLOAD)
    .eq('id', id)
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (result.error) return dbFailure(result.error, false);
  if (!result.data) return fail(404, DATA_CODES.NOT_FOUND);
  return json(200, { ok: true, bill: billView(result.data, { includePayload: true }) });
}

async function saveSnapshot({ request, supabase, user, id, now }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const parsed = await readJson(request, DATA_LIMITS.snapshotBody);
  if (!parsed.ok) return fail(parsed.status, parsed.code);
  if (!hasOnlyKeys(parsed.value, SNAPSHOT_KEYS)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const snapshot = parsed.value.snapshot;
  if (!validSnapshot(snapshot)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const current = await supabase.from('bills')
    .select('id,metadata_json,snapshot_hash,snapshot_at')
    .eq('id', id)
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (current.error) return dbFailure(current.error, false);
  if (!current.data) return fail(404, DATA_CODES.NOT_FOUND);
  if (Number(current.data.metadata_json?.trades_count) !== snapshot.bill.trade_count) {
    return fail(400, DATA_CODES.REQUEST_INVALID);
  }
  const hash = await sha256Hex(JSON.stringify(snapshot));
  if (current.data.snapshot_hash === hash) {
    return json(200, { ok: true, duplicate: true, snapshot_at: current.data.snapshot_at });
  }
  const at = now();
  const updated = await supabase.from('bills')
    .update({
      snapshot_json: snapshot,
      snapshot_hash: hash,
      snapshot_at: at,
      updated_at: at,
    })
    .eq('id', id)
    .eq('user_id', user.user_id)
    .select('snapshot_at')
    .maybeSingle();
  if (updated.error) return dbFailure(updated.error, true);
  if (!updated.data) return fail(404, DATA_CODES.NOT_FOUND);
  return json(200, { ok: true, duplicate: false, snapshot_at: updated.data.snapshot_at });
}

async function deleteBill({ supabase, user, id }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const result = await supabase.from('bills')
    .delete()
    .eq('id', id)
    .eq('user_id', user.user_id)
    .select('id');
  if (result.error) return dbFailure(result.error, true);
  if (!Array.isArray(result.data) || result.data.length === 0) return fail(404, DATA_CODES.NOT_FOUND);
  return json(200, { ok: true, deleted: true });
}

async function getRules({ supabase, user }) {
  const result = await supabase.from('rule_sets')
    .select('payload_json,revision,updated_at')
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (result.error) return dbFailure(result.error, false);
  if (!result.data) return json(200, { ok: true, rules: [], revision: 0, updated_at: null });
  return json(200, {
    ok: true,
    rules: Array.isArray(result.data.payload_json) ? result.data.payload_json : [],
    revision: Number.isInteger(result.data.revision) ? result.data.revision : 0,
    updated_at: result.data.updated_at ?? null,
  });
}

async function saveRules({ request, supabase, user, now }) {
  const parsed = await readJson(request, DATA_LIMITS.ruleBody);
  if (!parsed.ok) return fail(parsed.status, parsed.code);
  if (!hasOnlyKeys(parsed.value, RULES_KEYS)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const versions = normalizeRuleSet(parsed.value.versions);
  if (!versions) return fail(400, DATA_CODES.REQUEST_INVALID);
  const at = now();
  const existing = await supabase.from('rule_sets')
    .select('user_id,revision')
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (existing.error) return dbFailure(existing.error, false);
  let saved;
  if (existing.data) {
    const revision = (Number.isInteger(existing.data.revision) ? existing.data.revision : 0) + 1;
    saved = await supabase.from('rule_sets')
      .update({ payload_json: versions, revision, updated_at: at })
      .eq('user_id', user.user_id)
      .select('revision,updated_at')
      .maybeSingle();
  } else {
    saved = await supabase.from('rule_sets')
      .insert({
        user_id: user.user_id,
        payload_json: versions,
        revision: 1,
        created_at: at,
        updated_at: at,
      })
      .select('revision,updated_at')
      .single();
  }
  if (saved.error) return dbFailure(saved.error, true);
  if (!saved.data) return fail(404, DATA_CODES.NOT_FOUND);
  return json(200, {
    ok: true,
    revision: saved.data.revision,
    updated_at: saved.data.updated_at,
    count: versions.length,
  });
}

async function getProfile({ supabase, user }) {
  const [facts, summary] = await Promise.all([
    supabase.from('profile_facts')
      .select(FACT_COLUMNS)
      .eq('user_id', user.user_id)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('profiles')
      .select('summary_json,summary_at,summary_version,summary_source_hash')
      .eq('user_id', user.user_id)
      .maybeSingle(),
  ]);
  if (facts.error) return dbFailure(facts.error, false);
  if (summary.error) return dbFailure(summary.error, false);
  const summaryRow = summary.data ?? null;
  return json(200, {
    ok: true,
    facts: (Array.isArray(facts.data) ? facts.data : []).map(factView),
    summary: summaryRow?.summary_json ?? null,
    summary_at: summaryRow?.summary_at ?? null,
    summary_version: summaryRow?.summary_version ?? null,
    summary_source_hash: summaryRow?.summary_source_hash ?? null,
  });
}

async function createFacts({ request, supabase, user, now, randomUUID }) {
  const parsed = await readJson(request, DATA_LIMITS.factBody);
  if (!parsed.ok) return fail(parsed.status, parsed.code);
  if (!hasOnlyKeys(parsed.value, new Set(['facts']))) return fail(400, DATA_CODES.REQUEST_INVALID);
  const list = parsed.value.facts;
  if (!Array.isArray(list) || list.length === 0 || list.length > DATA_LIMITS.maxFacts) {
    return fail(400, DATA_CODES.REQUEST_INVALID);
  }
  const normalized = [];
  for (const raw of list) {
    const fact = normalizeFact(raw);
    if (!fact) return fail(400, DATA_CODES.REQUEST_INVALID);
    normalized.push(fact);
  }

  const at = now();
  const added = [];
  const duplicates = [];
  for (const fact of normalized) {
    const factHash = await sha256Hex(`${user.user_id}\n${fact.kind}\n${fact.key}\n${fact.value}`);
    const row = {
      id: randomUUID(),
      user_id: user.user_id,
      kind: fact.kind,
      fact_key: fact.key,
      fact_value: fact.value,
      evidence: fact.evidence,
      source: fact.source,
      source_ref: fact.source_ref,
      confidence: 100,
      fact_hash: factHash,
      created_at: at,
      updated_at: at,
    };
    const inserted = await supabase.from('profile_facts')
      .insert(row)
      .select(FACT_COLUMNS)
      .single();
    if (!inserted.error) {
      added.push(factView(inserted.data));
      continue;
    }
    if (inserted.error.code === '23505') {
      duplicates.push({ kind: fact.kind, key: fact.key, value: fact.value });
      continue;
    }
    return dbFailure(inserted.error, true);
  }
  return json(added.length ? 201 : 200, { ok: true, added, duplicates });
}

async function deleteFact({ supabase, user, id }) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return fail(400, DATA_CODES.REQUEST_INVALID);
  const result = await supabase.from('profile_facts')
    .delete()
    .eq('id', id)
    .eq('user_id', user.user_id)
    .select('id');
  if (result.error) return dbFailure(result.error, true);
  if (!Array.isArray(result.data) || result.data.length === 0) return fail(404, DATA_CODES.NOT_FOUND);
  return json(200, { ok: true, deleted: true });
}

async function saveProfileSummary({ request, supabase, user, now }) {
  const parsed = await readJson(request, DATA_LIMITS.summaryBody);
  if (!parsed.ok) return fail(parsed.status, parsed.code);
  if (!hasOnlyKeys(parsed.value, new Set(['digest', 'summary']))) {
    return fail(400, DATA_CODES.REQUEST_INVALID);
  }
  const normalized = normalizeProfileSummaryRequest({ digest: parsed.value.digest });
  if (!normalized.ok) return fail(400, DATA_CODES.REQUEST_INVALID);
  const checked = validateProfileSummaryValue(parsed.value.summary, normalized.digest);
  if (!checked.ok) return fail(400, DATA_CODES.REQUEST_INVALID);
  const sourceHash = await profileDigestHash(normalized.digest);
  const at = now();
  const existing = await supabase.from('profiles')
    .select('user_id')
    .eq('user_id', user.user_id)
    .maybeSingle();
  if (existing.error) return dbFailure(existing.error, false);
  let saved;
  if (existing.data) {
    saved = await supabase.from('profiles')
      .update({
        summary_json: checked.value,
        summary_source_hash: sourceHash,
        summary_at: at,
        summary_version: 1,
        updated_at: at,
      })
      .eq('user_id', user.user_id)
      .select('summary_at,summary_version,summary_source_hash')
      .maybeSingle();
  } else {
    saved = await supabase.from('profiles')
      .insert({
        user_id: user.user_id,
        summary_json: checked.value,
        summary_source_hash: sourceHash,
        summary_at: at,
        summary_version: 1,
        created_at: at,
        updated_at: at,
      })
      .select('summary_at,summary_version,summary_source_hash')
      .single();
  }
  if (saved.error) return dbFailure(saved.error, true);
  if (!saved.data) return fail(404, DATA_CODES.NOT_FOUND);
  return json(200, {
    ok: true,
    summary_at: saved.data.summary_at,
    summary_version: saved.data.summary_version,
    source_hash: saved.data.summary_source_hash,
  });
}
