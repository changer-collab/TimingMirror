// Dev-only in-memory stand-in for the subset of the Supabase query builder used by
// server/site-functions/dataApi.mjs. It exists so bills/profile routes can be exercised
// locally without credentials; it is never shipped or used by the deployed Function.
const TABLES = Object.freeze({
  bills: [['bill_key'], ['id']],
  profile_facts: [['fact_hash'], ['id']],
  profiles: [['user_id']],
});

const clone = (value) => structuredClone(value);

function uniqueViolation() {
  return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
}

function project(row, columns) {
  if (!columns || columns === '*') return clone(row);
  const keys = String(columns).split(',').map((key) => key.trim()).filter(Boolean);
  const output = {};
  for (const key of keys) if (key in row) output[key] = clone(row[key]);
  return output;
}

function matches(row, filters) {
  return filters.every(([column, value]) => row[column] === value);
}

function conflict(table, candidate, rows, skipIndex = -1) {
  return (TABLES[table] ?? []).some((columns) => rows.some((row, index) => index !== skipIndex
    && columns.every((column) => row[column] !== undefined && row[column] === candidate[column])));
}

function execute(state, query, { single = null } = {}) {
  const rows = state.tables[query.table];
  const returning = query.returning;
  const finish = (data) => {
    if (single === 'one') {
      if (data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'expected one row' } };
      return { data: data[0], error: null };
    }
    if (single === 'maybe') return { data: data[0] ?? null, error: null };
    return { data, error: null };
  };
  const filtered = rows.map((row, index) => ({ row, index })).filter(({ row }) => matches(row, query.filters));

  if (query.op === 'insert') {
    const inserted = [];
    const working = rows.map(clone);
    for (const raw of query.rows) {
      const row = clone(raw);
      if (conflict(query.table, row, working)) return uniqueViolation();
      working.push(row);
      inserted.push(row);
    }
    state.tables[query.table] = working;
    if (!returning) return { data: null, error: null };
    return finish(inserted.map((row) => project(row, returning)));
  }

  if (query.op === 'update') {
    const updated = [];
    for (const { row, index } of filtered) {
      const next = { ...clone(row), ...clone(query.patch) };
      if (conflict(query.table, next, rows, index)) return uniqueViolation();
      rows[index] = next;
      updated.push(next);
    }
    if (!returning) return { data: null, error: null };
    return finish(updated.map((row) => project(row, returning)));
  }

  if (query.op === 'delete') {
    const removed = filtered.map(({ row }) => row);
    const remaining = rows.filter((_, index) => !filtered.some((entry) => entry.index === index));
    state.tables[query.table] = remaining;
    if (!returning) return { data: null, error: null };
    return finish(removed.map((row) => project(row, returning)));
  }

  let picked = filtered.map(({ row }) => row);
  if (query.order) {
    const { column, ascending } = query.order;
    picked = picked
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        if (a.row[column] === b.row[column]) return a.index - b.index;
        return (a.row[column] < b.row[column] ? -1 : 1) * (ascending ? 1 : -1);
      })
      .map(({ row }) => row);
  }
  if (query.range) picked = picked.slice(query.range.from, query.range.to + 1);
  if (query.limit !== null) picked = picked.slice(0, query.limit);
  return finish(picked.map((row) => project(row, returning ?? '*')));
}

function createQuery(state, table) {
  if (!state.tables[table]) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
  const query = {
    table,
    op: 'select',
    filters: [],
    rows: null,
    patch: null,
    returning: null,
    order: null,
    range: null,
    limit: null,
  };
  const builder = {
    select(columns) { query.returning = columns; return builder; },
    insert(rows) { query.op = 'insert'; query.rows = Array.isArray(rows) ? rows : [rows]; return builder; },
    update(patch) { query.op = 'update'; query.patch = patch; return builder; },
    delete() { query.op = 'delete'; return builder; },
    eq(column, value) { query.filters.push([column, value]); return builder; },
    order(column, { ascending = true } = {}) { query.order = { column, ascending }; return builder; },
    range(from, to) { query.range = { from, to }; return builder; },
    limit(count) { query.limit = count; return builder; },
    maybeSingle() { return Promise.resolve().then(() => execute(state, query, { single: 'maybe' })); },
    single() { return Promise.resolve().then(() => execute(state, query, { single: 'one' })); },
    then(resolve, reject) { return Promise.resolve().then(() => execute(state, query)).then(resolve, reject); },
  };
  return builder;
}

export function createMemorySupabase() {
  const state = { tables: { bills: [], profile_facts: [], profiles: [] } };
  return {
    from: (table) => createQuery(state, table),
    seed(table, rows) {
      state.tables[table] = (Array.isArray(rows) ? rows : [rows]).map(clone);
    },
    rows: (table) => clone(state.tables[table] ?? []),
  };
}

// Local dev has no Gateway, so the dev server injects the same header shape it would
// receive in production. Real identity still comes from the platform ingress only.
export function createDevUserContext({
  userId,
  name = '本地开发用户',
  siteId = 'dev-site',
  hostId = 'dev-host',
  orgId,
  expiresAt = Math.floor(Date.now() / 1000) + 8 * 3600,
} = {}) {
  if (typeof userId !== 'string' || userId.trim() === '') throw new TypeError('userId 必填');
  const payload = {
    user_id: userId,
    name,
    picture: '',
    site_id: siteId,
    host_id: hostId,
    session_expires_at: expiresAt,
    ...(orgId === undefined ? {} : { org_id: orgId }),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
