#!/usr/bin/env node
/**
 * P3 · 历史账单索引 API 单测（内存 Supabase 替身；不联网、不接触真实数据库）
 *
 * 覆盖：本人隔离、limit/exclude 校验、未发布/无报告排除、当前账单排除、
 *       字段白名单（不含 UUID/文件名/成交/金额）、错误与路由。
 * 运行：node tests/server/history-index.test.mjs（或 npm run check）
 */
import { createHandler } from '../../server/site-functions/handler.mjs';
import { DATA_CODES } from '../../server/site-functions/dataApi.mjs';
import { createDevUserContext, createMemorySupabase } from '../../scripts/dev-memory-supabase.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const USER_A = 'user-a';
const USER_B = 'user-b';
const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function publishedSnapshot({ patterns = [], report = { portfolio: null }, tradeCount = 4 } = {}) {
  const latest = {
    profile_key: 'abcd1234',
    at: '2026-09-30T10:00:00.000Z',
    bill: { trade_count: tradeCount },
    behavior: { patterns },
    review: { portfolio_published: true },
  };
  return {
    version: 2,
    at: '2026-09-30T10:00:00.000Z',
    profile_key: 'abcd1234',
    bill: { trade_count: tradeCount },
    review: { portfolio_published: true },
    profile: { latest },
    report,
    report_available: true,
  };
}

const TRADES = [
  { trade_id: 'T1', trade_date: '2026-09-01', symbol: '600519', side: 'buy', price: 100, quantity: 100, fee: 0, tax: 0 },
  { trade_id: 'T2', trade_date: '2026-09-02', symbol: '600519', side: 'sell', price: 110, quantity: 100, fee: 0, tax: 0 },
];

const B_TRADES = [
  { trade_id: 'B1', trade_date: '2026-09-10', symbol: '000001', side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0 },
  { trade_id: 'B2', trade_date: '2026-09-11', symbol: '000001', side: 'sell', price: 11, quantity: 100, fee: 0, tax: 0 },
];

const BILL_1 = UUID(1);
const BILL_2 = UUID(2);
const BILL_3 = UUID(3);
const BILL_4 = UUID(4);
const BILL_B = UUID(5);

const memory = createMemorySupabase();
memory.seed('bills', [
  {
    id: BILL_1, user_id: USER_A, imported_at: '2026-10-01T00:00:00.000Z', effective_date: '2026-09-30',
    payload_mode: 'full', payload_json: { trades: TRADES },
    snapshot_json: publishedSnapshot({
      tradeCount: 2,
      patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 3 }],
    }),
  },
  {
    id: BILL_2, user_id: USER_A, imported_at: '2026-09-01T00:00:00.000Z', effective_date: '2026-08-29',
    payload_mode: 'summary', payload_json: null,
    snapshot_json: publishedSnapshot({
      tradeCount: 4,
      patterns: [{ pattern_id: 'quick_flip', name: '买入后三日内卖出', status: '成立', sample_n: 2 }],
    }),
  },
  {
    id: BILL_3, user_id: USER_A, imported_at: '2026-08-01T00:00:00.000Z', effective_date: '2026-07-31',
    payload_mode: 'summary', payload_json: null,
    snapshot_json: { version: 1, review: { portfolio_published: false }, bill: { trade_count: 3 } },
  },
  {
    id: BILL_4, user_id: USER_A, imported_at: '2026-07-01T00:00:00.000Z', effective_date: '2026-06-30',
    payload_mode: 'summary', payload_json: null,
    snapshot_json: { version: 1, review: { portfolio_published: true }, bill: { trade_count: 2 } },
  },
  {
    id: BILL_B, user_id: USER_B, imported_at: '2026-10-02T00:00:00.000Z', effective_date: '2026-10-01',
    payload_mode: 'full', payload_json: { trades: B_TRADES },
    snapshot_json: publishedSnapshot({
      tradeCount: 2,
      patterns: [{ pattern_id: 'overtrading', name: '交易频率偏高', status: '成立', sample_n: 5 }],
    }),
  },
]);

const handler = createHandler({ transport: null, now: () => '2026-10-24T00:00:00.000Z' });

async function get(path, { userId = USER_A, supabase, method = 'GET' } = {}) {
  const db = supabase === undefined ? memory : supabase;
  const headers = new Headers();
  if (userId !== null) headers.set('x-qoder-user-context', createDevUserContext({ userId }));
  const response = await handler(new Request(`https://timingmirror.example/functions/v1/app${path}`, { method, headers }), { supabase: db });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 断言处理 */ }
  return { status: response.status, headers: response.headers, text, json };
}

/* ==== ① 本人索引与排除 ==== */
{
  const response = await get('/api/history/index');
  const index = response.json?.index;
  check('索引：200 且只含本人已发布账单', response.status === 200 && index?.rows?.length === 2
    && index.scope === 'user_saved' && index.synthetic === false, response.text);
  check('索引：按导入时间取最新（日期倒序）', index.rows[0].effective_date === '2026-09-30'
    && index.rows[1].effective_date === '2026-08-29', JSON.stringify(index.rows.map((row) => row.effective_date)));
  check('索引：未发布与无报告如实排除', index.excluded.length === 2
    && index.excluded.some((item) => item.reason === 'unpublished')
    && index.excluded.some((item) => item.reason === 'report_missing'), JSON.stringify(index.excluded));
  check('索引：覆盖计数', index.coverage.bills_scanned === 4
    && index.coverage.bills_included === 2 && index.coverage.bills_excluded === 2, JSON.stringify(index.coverage));
}

/* ==== ② 字段白名单 ==== */
{
  const response = await get('/api/history/index');
  const index = response.json.index;
  const rowKeys = [...new Set(index.rows.flatMap((row) => Object.keys(row)))].sort();
  check('白名单：行字段固定', rowKeys.join(',') === 'effective_date,holding_buckets,patterns,ref,report_available,symbols,trade_count',
    rowKeys.join(','));
  check('白名单：不含 UUID/文件名/成交/金额/画像键',
    !response.text.match(new RegExp(`${BILL_1}|${BILL_2}|\.csv|fileName|price|quantity|fee|payload|profile_key`, 'u')),
    response.text);
  check('白名单：引用形如 h+16 位且稳定', /^h[0-9a-f]{16}$/u.test(index.rows[0].ref), index.rows[0].ref);
  check('白名单：明细只出聚合（标的与持有桶）',
    index.rows[0].symbols.join(',') === '600519' && index.rows[0].holding_buckets[0]?.id === '0-3'
    && index.rows[1].symbols.length === 0, JSON.stringify(index.rows.map((row) => ({ symbols: row.symbols, buckets: row.holding_buckets }))));
}

/* ==== ③ 当前账单排除 ==== */
{
  const response = await get(`/api/history/index?exclude=${BILL_1}`);
  const index = response.json?.index;
  check('排除：当前账单不进入可比对行', response.status === 200 && index.rows.length === 1
    && index.rows[0].effective_date === '2026-08-29', response.text);
  check('排除：当前账单计入 current_bill 且不算异常排除', index.excluded.some((item) => item.reason === 'current_bill')
    && index.coverage.bills_excluded === 2, JSON.stringify(index.excluded));
  const invalid = await get('/api/history/index?exclude=not-a-uuid');
  check('排除：非法 UUID → 400', invalid.status === 400 && invalid.json.error === DATA_CODES.REQUEST_INVALID, invalid.text);
}

/* ==== ④ limit 校验 ==== */
{
  const one = await get('/api/history/index?limit=1');
  check('limit：1 只扫描最新一份', one.status === 200 && one.json.index.coverage.bills_scanned === 1
    && one.json.index.rows.length === 1, one.text);
  for (const bad of ['0', '51', 'abc', '1.5']) {
    const response = await get(`/api/history/index?limit=${bad}`);
    check(`limit：${bad} → 400`, response.status === 400 && response.json.error === DATA_CODES.REQUEST_INVALID, response.text);
  }
}

/* ==== ⑤ 同用户隔离 ==== */
{
  const response = await get('/api/history/index', { userId: USER_B });
  const index = response.json?.index;
  check('隔离：用户 B 只看到自己的账单', response.status === 200 && index.rows.length === 1
    && index.rows[0].effective_date === '2026-10-01' && index.rows[0].patterns[0].id === 'overtrading', response.text);
  check('隔离：用户 B 的索引不含用户 A 的日期或标的', !response.text.includes('2026-09-30')
    && !response.text.includes('600519'), response.text);
  const a = await get('/api/history/index');
  check('隔离：用户 A 仍只有自己的两份', a.json.index.rows.length === 2
    && a.json.index.rows.every((row) => row.effective_date !== '2026-10-01'), a.text);
}

/* ==== ⑥ 路由与错误 ==== */
{
  const post = await get('/api/history/index', { method: 'POST' });
  check('路由：POST → 405 且 Allow 为 GET', post.status === 405 && post.headers.get('allow') === 'GET',
    `${post.status} ${post.headers.get('allow')}`);
  const nested = await get('/api/history/index/extra');
  check('路由：未知子路径 → 404', nested.status === 404, nested.text);
  const noDb = await get('/api/history/index', { supabase: null });
  check('数据库：未注入 supabase → 503', noDb.status === 503
    && noDb.json.error === DATA_CODES.DATABASE_UNAVAILABLE, noDb.text);
  const anonymous = await get('/api/history/index', { userId: null });
  check('身份：缺少 Gateway 上下文 → 401', anonymous.status === 401
    && anonymous.json.error === DATA_CODES.LOGIN_REQUIRED, anonymous.text);
}

/* ==== ⑦ 数据库失败脱敏 ==== */
{
  const failing = {
    from() {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        order() { return builder; },
        limit() { return Promise.resolve({ data: null, error: { code: '08006', message: 'secret-host refused' } }); },
      };
      return builder;
    },
  };
  const response = await get('/api/history/index', { supabase: failing });
  check('错误：读取失败 → 503 且不泄露上游信息', response.status === 503
    && response.json.error === DATA_CODES.READ_FAILED && !response.text.includes('secret-host'), response.text);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
