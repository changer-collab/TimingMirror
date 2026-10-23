#!/usr/bin/env node
/**
 * 账单 / 画像数据 API 单测（内存 Supabase 替身；不联网、不接触真实数据库）
 *
 * 覆盖：Gateway 身份校验、跨用户隔离、账单去重/翻页/明细升级/快照幂等、
 * 画像事实校验与去重、错误脱敏，以及匿名数据库 adapter 的传输守卫。
 */
import { createHandler } from '../../server/site-functions/handler.mjs';
import { DATA_CODES, contentHashOfTrades } from '../../server/site-functions/dataApi.mjs';
import { serveSite } from '../../server/site-functions/adapter.mjs';
import { createDevUserContext, createMemorySupabase } from '../../scripts/dev-memory-supabase.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const USER_A = 'user-a';
const USER_B = 'user-b';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

let uuidCounter = 0;
const nextUuid = () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
let clockTick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 23, 4, 0, clockTick++)).toISOString();

function tradesFor(seed = 0) {
  return [
    { trade_id: 'T1', trade_date: '2026-01-05', symbol: '600519', side: 'buy', price: 100 + seed, quantity: 100, fee: 5, tax: 0 },
    { trade_id: 'T2', trade_date: '2026-02-05', symbol: '000001', side: 'sell', price: 10 + seed, quantity: 200, fee: 1, tax: 0.5 },
  ];
}

async function billBody({ seed = 0, mode = 'summary', trades = tradesFor(seed), contentHash } = {}) {
  return {
    content_hash: contentHash ?? await contentHashOfTrades(trades),
    context_id: `ctx-${seed}`,
    source_type: 'local',
    effective_date: '2026-09-30',
    import_method: 'ai',
    metadata: {
      trades_count: trades.length,
      warnings_count: 0,
      data_mode: 'sample',
      date_from: '2026-01-05',
      date_to: '2026-09-30',
      symbol_count: 2,
    },
    payload_mode: mode,
    ...(mode === 'full' ? { payload: { trades } } : {}),
  };
}

function snapshotFor(tradeCount = 2, overrides = {}) {
  return {
    version: 1,
    at: '2026-10-23T04:00:00.000Z',
    profile_key: 'abcd1234',
    bill: { trade_count: tradeCount },
    review: { portfolio_published: true },
    ...overrides,
  };
}

async function invoke(handler, path, {
  method = 'GET',
  body,
  bodyStream,
  userId = USER_A,
  context,
  contextHeader,
  supabase,
  omitContentType = false,
  extraHeaders = {},
} = {}) {
  const headers = new Headers(extraHeaders);
  if (!omitContentType) headers.set('content-type', 'application/json');
  if (contextHeader !== undefined) {
    if (contextHeader !== null) headers.set('x-qoder-user-context', contextHeader);
  } else if (userId !== null) {
    headers.set('x-qoder-user-context', context ?? createDevUserContext({ userId }));
  }
  const init = { method, headers };
  if (bodyStream !== undefined) {
    init.body = bodyStream;
    init.duplex = 'half';
  } else if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const request = new Request(`https://timingmirror.example/functions/v1/app${path}`, init);
  const response = await handler(request, { supabase });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 由断言处理 */ }
  return { status: response.status, headers: response.headers, text, json };
}

function streamOfChunks(count, size) {
  const chunk = 'x'.repeat(size);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < count; i++) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function stubSupabase(resultFor) {
  return {
    from() {
      const query = { op: 'select' };
      const builder = {
        select() { return builder; },
        insert() { query.op = 'insert'; return builder; },
        update() { query.op = 'update'; return builder; },
        delete() { query.op = 'delete'; return builder; },
        eq() { return builder; },
        order() { return builder; },
        range() { return Promise.resolve(resultFor(query)); },
        limit() { return Promise.resolve(resultFor(query)); },
        maybeSingle() { return Promise.resolve(resultFor(query)); },
        single() { return Promise.resolve(resultFor(query)); },
        then(resolve) { return Promise.resolve(resultFor(query)).then(resolve); },
      };
      return builder;
    },
  };
}

/* ==== 身份、路由与请求边界 ==== */
{
  const supabase = createMemorySupabase();
  const handler = createHandler({ transport: null, now: clock, randomUUID: nextUuid });
  const body = await billBody({ seed: 1 });

  const anonymous = await invoke(handler, '/api/bills', { method: 'POST', body, userId: null, supabase });
  check('身份：缺少 Gateway 上下文 → 401 login_required',
    anonymous.status === 401 && anonymous.json.error === DATA_CODES.LOGIN_REQUIRED, anonymous.text);

  const forged = await invoke(handler, '/api/bills', { method: 'POST', body, contextHeader: 'not-base64!!', supabase });
  check('身份：格式非法的上下文 → 403 invalid_user_context',
    forged.status === 403 && forged.json.error === DATA_CODES.INVALID_CONTEXT, forged.text);

  const expired = await invoke(handler, '/api/bills', {
    method: 'POST',
    body,
    context: createDevUserContext({ userId: USER_A, expiresAt: Math.floor(Date.now() / 1000) - 60 }),
    supabase,
  });
  check('身份：过期上下文 → 403 invalid_user_context',
    expired.status === 403 && expired.json.error === DATA_CODES.INVALID_CONTEXT, expired.text);

  const wrongMethod = await invoke(handler, '/api/bills', { method: 'PUT', body, supabase });
  check('路由：PUT /api/bills → 405 且 Allow 头正确',
    wrongMethod.status === 405 && wrongMethod.json.error === DATA_CODES.METHOD
    && wrongMethod.headers.get('allow') === 'GET, POST', `${wrongMethod.status} ${wrongMethod.headers.get('allow')}`);

  const profilePost = await invoke(handler, '/api/profile', { method: 'POST', body: {}, supabase });
  check('路由：POST /api/profile → 405', profilePost.status === 405 && profilePost.json.error === DATA_CODES.METHOD);

  const unknown = await invoke(handler, '/api/bills/abc/snapshot/extra', { supabase });
  check('路由：未知子路径 → 404', unknown.status === 404);

  const noType = await invoke(handler, '/api/bills', { method: 'POST', body, supabase, omitContentType: true });
  check('请求：POST 缺少 JSON Content-Type → 415', noType.status === 415 && noType.json.error === DATA_CODES.CONTENT_TYPE);

  const noDb = await invoke(handler, '/api/bills');
  check('数据库：未注入 supabase → 503 database_unavailable',
    noDb.status === 503 && noDb.json.error === DATA_CODES.DATABASE_UNAVAILABLE, noDb.text);

  const tooLarge = await invoke(handler, '/api/bills', {
    method: 'POST', bodyStream: streamOfChunks(4, 300 * 1024), supabase,
  });
  check('请求：请求体超限 → 413 request_too_large',
    tooLarge.status === 413 && tooLarge.json.error === DATA_CODES.BODY_TOO_LARGE, tooLarge.text);

  const badJson = await invoke(handler, '/api/bills', { method: 'POST', body: '{bad-json', supabase });
  check('请求：非法 JSON → 400 request_invalid', badJson.status === 400 && badJson.json.error === DATA_CODES.REQUEST_INVALID);

  const unknownField = await invoke(handler, '/api/bills', {
    method: 'POST', body: { ...body, user_id: USER_B }, supabase,
  });
  check('请求：账单不允许浏览器传入 user_id → 400',
    unknownField.status === 400 && unknownField.json.error === DATA_CODES.REQUEST_INVALID, unknownField.text);
}

/* ==== 账单创建、去重与读取 ==== */
const memory = createMemorySupabase();
const handler = createHandler({ transport: null, now: clock, randomUUID: nextUuid });
const billOne = await billBody({ seed: 1 });
const billTwo = await billBody({ seed: 2 });

let created = await invoke(handler, '/api/bills', { method: 'POST', body: billOne, supabase: memory });
const billOneId = created.json?.bill?.id;
check('账单：创建 → 201 且返回摘要视图',
  created.status === 201 && created.json.ok === true && created.json.duplicate === false
  && created.json.bill.has_payload === false && created.json.bill.metadata.trades_count === 2, created.text);
check('账单：响应不包含 user_id 或账单键', !/user_id|bill_key|content_hash/u.test(created.text), created.text);

const duplicate = await invoke(handler, '/api/bills', { method: 'POST', body: billOne, supabase: memory });
check('账单：同用户同内容重复导入 → 200 duplicate 且 id 不变',
  duplicate.status === 200 && duplicate.json.duplicate === true && duplicate.json.bill.id === billOneId, duplicate.text);

const otherUser = await invoke(handler, '/api/bills', { method: 'POST', body: billOne, supabase: memory, userId: USER_B });
check('账单：另一用户同内容 → 独立 201、独立 id',
  otherUser.status === 201 && otherUser.json.duplicate === false
  && otherUser.json.bill.id !== billOneId, otherUser.text);
const otherUserId = otherUser.json?.bill?.id;

const createdTwo = await invoke(handler, '/api/bills', { method: 'POST', body: billTwo, supabase: memory });
check('账单：第二条账单创建成功', createdTwo.status === 201);

const pageOne = await invoke(handler, '/api/bills?limit=1', { supabase: memory });
check('账单：limit=1 返回最新一条且 next_offset=1',
  pageOne.status === 200 && pageOne.json.bills.length === 1
  && pageOne.json.bills[0].id === createdTwo.json.bill.id && pageOne.json.next_offset === 1, pageOne.text);
const pageTwo = await invoke(handler, '/api/bills?limit=1&offset=1', { supabase: memory });
check('账单：第二页返回旧一条且 next_offset=null',
  pageTwo.status === 200 && pageTwo.json.bills.length === 1
  && pageTwo.json.bills[0].id === billOneId && pageTwo.json.next_offset === null, pageTwo.text);
const badLimit = await invoke(handler, '/api/bills?limit=0', { supabase: memory });
check('账单：非法 limit → 400', badLimit.status === 400 && badLimit.json.error === DATA_CODES.REQUEST_INVALID);

const summaryGet = await invoke(handler, `/api/bills/${billOneId}`, { supabase: memory });
check('账单：摘要模式不返回明细', summaryGet.status === 200
  && summaryGet.json.bill.has_payload === false && !('payload' in summaryGet.json.bill), summaryGet.text);

const fullBody = await billBody({ seed: 1, mode: 'full' });
const upgraded = await invoke(handler, '/api/bills', { method: 'POST', body: fullBody, supabase: memory });
check('账单：显式 full 重复导入 → 升级明细且仍判重复',
  upgraded.status === 200 && upgraded.json.duplicate === true
  && upgraded.json.bill.has_payload === true, upgraded.text);
const fullGet = await invoke(handler, `/api/bills/${billOneId}`, { supabase: memory });
check('账单：full 模式读取包含规范化明细',
  fullGet.status === 200 && fullGet.json.bill.payload?.trades?.length === 2
  && fullGet.json.bill.payload.trades[0].symbol === '600519', fullGet.text);

const mismatch = await invoke(handler, '/api/bills', {
  method: 'POST',
  body: await billBody({ seed: 1, mode: 'full', contentHash: 'f'.repeat(64) }),
  supabase: memory,
});
check('账单：明细与内容哈希不一致 → 400 content_hash_mismatch',
  mismatch.status === 400 && mismatch.json.error === DATA_CODES.HASH_MISMATCH, mismatch.text);

const countMismatch = await invoke(handler, '/api/bills', {
  method: 'POST',
  body: {
    ...await billBody({ seed: 3 }),
    payload_mode: 'full',
    payload: { trades: tradesFor(3) },
    metadata: { trades_count: 1 },
  },
  supabase: memory,
});
check('账单：full 明细数与 metadata 不一致 → 400',
  countMismatch.status === 400 && countMismatch.json.error === DATA_CODES.REQUEST_INVALID, countMismatch.text);

const summaryWithPayload = await invoke(handler, '/api/bills', {
  method: 'POST',
  body: { ...await billBody({ seed: 4 }), payload: { trades: tradesFor(4) } },
  supabase: memory,
});
check('账单：summary 模式夹带明细 → 400',
  summaryWithPayload.status === 400 && summaryWithPayload.json.error === DATA_CODES.REQUEST_INVALID);

const invalidId = await invoke(handler, '/api/bills/not-a-uuid', { supabase: memory });
check('账单：非法 id → 400', invalidId.status === 400 && invalidId.json.error === DATA_CODES.REQUEST_INVALID);
const missingId = await invoke(handler, '/api/bills/00000000-0000-4000-8000-000000000099', { supabase: memory });
check('账单：不存在 → 404', missingId.status === 404 && missingId.json.error === DATA_CODES.NOT_FOUND);
const crossRead = await invoke(handler, `/api/bills/${billOneId}`, { supabase: memory, userId: USER_B });
check('隔离：用户 B 读取用户 A 账单 → 404', crossRead.status === 404, crossRead.text);
const bList = await invoke(handler, '/api/bills', { supabase: memory, userId: USER_B });
check('隔离：用户 B 只看到自己的账单',
  bList.status === 200 && bList.json.bills.length === 1 && bList.json.bills[0].id === otherUserId, bList.text);

/* ==== 快照 ==== */
const snapshotBody = { snapshot: snapshotFor(2) };
const snapshotDenied = await invoke(handler, `/api/bills/${billOneId}/snapshot`, {
  method: 'POST', body: snapshotBody, supabase: memory, userId: USER_B,
});
check('快照：跨用户写入 → 404', snapshotDenied.status === 404, snapshotDenied.text);

const snapshotSaved = await invoke(handler, `/api/bills/${billOneId}/snapshot`, {
  method: 'POST', body: snapshotBody, supabase: memory,
});
check('快照：已发布报告写入 → 200 duplicate=false',
  snapshotSaved.status === 200 && snapshotSaved.json.duplicate === false && !!snapshotSaved.json.snapshot_at, snapshotSaved.text);
const snapshotReplay = await invoke(handler, `/api/bills/${billOneId}/snapshot`, {
  method: 'POST', body: snapshotBody, supabase: memory,
});
check('快照：同内容重放 → 200 duplicate=true',
  snapshotReplay.status === 200 && snapshotReplay.json.duplicate === true, snapshotReplay.text);

const snapshotCountMismatch = await invoke(handler, `/api/bills/${billOneId}/snapshot`, {
  method: 'POST', body: { snapshot: snapshotFor(3) }, supabase: memory,
});
check('快照：trade_count 与账单不一致 → 400',
  snapshotCountMismatch.status === 400 && snapshotCountMismatch.json.error === DATA_CODES.REQUEST_INVALID);

const snapshotUnpublished = await invoke(handler, `/api/bills/${billOneId}/snapshot`, {
  method: 'POST', body: { snapshot: snapshotFor(2, { review: { portfolio_published: false } }) }, supabase: memory,
});
check('快照：未发布报告 → 400',
  snapshotUnpublished.status === 400 && snapshotUnpublished.json.error === DATA_CODES.REQUEST_INVALID);

const snapshotUnknownField = await invoke(handler, `/api/bills/${billOneId}/snapshot`, {
  method: 'POST', body: { snapshot: snapshotFor(2), user_id: USER_B }, supabase: memory,
});
check('快照：未知顶层字段 → 400',
  snapshotUnknownField.status === 400 && snapshotUnknownField.json.error === DATA_CODES.REQUEST_INVALID);

const listWithSnapshot = await invoke(handler, '/api/bills?limit=10', { supabase: memory });
check('快照：账单列表回传已发布快照',
  listWithSnapshot.status === 200
  && listWithSnapshot.json.bills.find((bill) => bill.id === billOneId)?.snapshot?.profile_key === 'abcd1234');

/* ==== 画像事实 ==== */
const factsBody = {
  facts: [
    { kind: 'goal', key: 'retirement_horizon', value: '希望 5 年内保持较低回撤', source: 'manual' },
    { kind: 'risk_tolerance', key: 'drawdown_limit', value: '最大回撤不超过 15%', source: 'chat', evidence: '用户：最多亏 15% 我就睡不着' },
  ],
};
const factsCreated = await invoke(handler, '/api/profile/facts', { method: 'POST', body: factsBody, supabase: memory });
check('事实：新增两条 → 201 added=2',
  factsCreated.status === 201 && factsCreated.json.added.length === 2 && factsCreated.json.duplicates.length === 0, factsCreated.text);
check('事实：响应不包含 user_id', !/user_id|fact_hash/u.test(factsCreated.text), factsCreated.text);
const factId = factsCreated.json?.added?.[0]?.id;

const factsReplay = await invoke(handler, '/api/profile/facts', { method: 'POST', body: factsBody, supabase: memory });
check('事实：同内容重复 → 200 duplicates=2',
  factsReplay.status === 200 && factsReplay.json.added.length === 0 && factsReplay.json.duplicates.length === 2, factsReplay.text);

const profileA = await invoke(handler, '/api/profile', { supabase: memory });
check('画像：用户 A 读取两条事实',
  profileA.status === 200 && profileA.json.facts.length === 2 && profileA.json.summary === null, profileA.text);
const profileB = await invoke(handler, '/api/profile', { supabase: memory, userId: USER_B });
check('隔离：用户 B 画像为空', profileB.status === 200 && profileB.json.facts.length === 0, profileB.text);

memory.seed('profiles', [{
  user_id: USER_A,
  summary_json: { schema_version: 1, headline: '稳健派' },
  summary_at: '2026-10-23T04:10:00.000Z',
  summary_version: 1,
}]);
const profileWithSummary = await invoke(handler, '/api/profile', { supabase: memory });
check('画像：附带 AI 摘要缓存',
  profileWithSummary.json.summary?.headline === '稳健派'
  && profileWithSummary.json.summary_version === 1, profileWithSummary.text);

const invalidFacts = [
  [{ kind: 'personality', key: 'x', value: 'y' }, '未知 kind'],
  [{ kind: 'habit', key: 'x', value: 'y', source: 'chat' }, 'chat 无证据'],
  [{ kind: 'habit', key: 'x', value: 'y', source: 'chat', evidence: '证'.repeat(121) }, '证据超长'],
  [{ kind: 'habit', key: 'x', value: 'y', extra: true }, '未知字段'],
  [{ kind: 'habit', key: 'UPPER', value: 'y' }, '非法 key'],
  [{ kind: 'habit', key: 'x', value: 'y', source: 'ai' }, '非法 source'],
];
for (const [fact, label] of invalidFacts) {
  const response = await invoke(handler, '/api/profile/facts', { method: 'POST', body: { facts: [fact] }, supabase: memory });
  check(`事实校验：${label} → 400`, response.status === 400 && response.json.error === DATA_CODES.REQUEST_INVALID, response.text);
}
const tooManyFacts = await invoke(handler, '/api/profile/facts', {
  method: 'POST',
  body: { facts: Array.from({ length: 11 }, (_, index) => ({ kind: 'habit', key: `k${index}`, value: `v${index}` })) },
  supabase: memory,
});
check('事实校验：单次超过 10 条 → 400', tooManyFacts.status === 400);

const crossDeleteFact = await invoke(handler, `/api/profile/facts/${factId}`, {
  method: 'DELETE', supabase: memory, userId: USER_B,
});
check('事实：跨用户删除 → 404', crossDeleteFact.status === 404, crossDeleteFact.text);
const deleteFact = await invoke(handler, `/api/profile/facts/${factId}`, { method: 'DELETE', supabase: memory });
check('事实：本人删除 → 200', deleteFact.status === 200 && deleteFact.json.deleted === true);
const deleteFactAgain = await invoke(handler, `/api/profile/facts/${factId}`, { method: 'DELETE', supabase: memory });
check('事实：重复删除 → 404', deleteFactAgain.status === 404);

/* ==== 账单删除 ==== */
const crossDeleteBill = await invoke(handler, `/api/bills/${billOneId}`, {
  method: 'DELETE', supabase: memory, userId: USER_B,
});
check('账单：跨用户删除 → 404', crossDeleteBill.status === 404, crossDeleteBill.text);
const deleteBill = await invoke(handler, `/api/bills/${billOneId}`, { method: 'DELETE', supabase: memory });
check('账单：本人删除 → 200', deleteBill.status === 200 && deleteBill.json.deleted === true, deleteBill.text);
const deleteBillAgain = await invoke(handler, `/api/bills/${billOneId}`, { method: 'DELETE', supabase: memory });
check('账单：重复删除 → 404', deleteBillAgain.status === 404);

/* ==== 数据库错误脱敏 ==== */
{
  const readFailure = stubSupabase(() => ({ data: null, error: { code: '08006', message: 'connection refused secret-host' } }));
  const response = await invoke(handler, '/api/bills', { supabase: readFailure });
  check('错误：读取失败 → 503 read_failed 且不泄露上游信息',
    response.status === 503 && response.json.error === DATA_CODES.READ_FAILED
    && !/secret-host|connection refused/u.test(response.text), response.text);
}

{
  const rejected = stubSupabase((query) => (query.op === 'insert'
    ? { data: null, error: { code: '23514', message: 'check constraint violated' } }
    : { data: null, error: null }));
  const response = await invoke(createHandler({ transport: null }), '/api/bills', {
    method: 'POST', body: await billBody({ seed: 9 }), supabase: rejected,
  });
  check('错误：写入被拒 → 503 write_rejected',
    response.status === 503 && response.json.error === DATA_CODES.WRITE_REJECTED, response.text);
}

{
  const unknown = stubSupabase((query) => (query.op === 'insert'
    ? { data: null, error: { code: '08006' } }
    : { data: null, error: null }));
  const response = await invoke(createHandler({ transport: null }), '/api/bills', {
    method: 'POST', body: await billBody({ seed: 10 }), supabase: unknown,
  });
  check('错误：写入结果未知 → 503 write_result_unknown',
    response.status === 503 && response.json.error === DATA_CODES.WRITE_UNKNOWN, response.text);
}

/* ==== 匿名数据库 adapter 传输守卫 ==== */
{
  let called = 0;
  const siteHandler = serveSite(({ request }) => {
    called += 1;
    return Response.json({
      context: request.headers.get('x-qoder-user-context'),
      authorization: request.headers.get('authorization'),
      cookie: request.headers.get('cookie'),
      instance: request.headers.get('x-instance-id'),
    });
  }, {
    createClient: () => ({}),
    env: (name) => ({ SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'anon-key' })[name],
  });
  const missing = await siteHandler(new Request('https://site.example/api/bills'));
  check('adapter：缺少 x-instance-id → 503 且不进入业务',
    missing.status === 503 && called === 0, `${missing.status} called=${called}`);
}

{
  let called = 0;
  const siteHandler = serveSite(() => { called += 1; return Response.json({ ok: true }); }, {
    createClient: () => ({}),
    env: (name) => ({ SUPABASE_URL: 'https://db.example/evil', SUPABASE_ANON_KEY: 'anon' })[name],
  });
  const response = await siteHandler(new Request('https://site.example/api/bills', {
    headers: { 'x-instance-id': INSTANCE_ID },
  }));
  check('adapter：数据库地址带路径 → 503', response.status === 503 && called === 0);
}

{
  const client = {};
  let clientCapture = null;
  let handlerCapture = null;
  const siteHandler = serveSite(async ({ request, supabase }) => {
    handlerCapture = { request, supabase };
    return Response.json({ ok: true });
  }, {
    createClient: (url, key, options) => { clientCapture = { url, key, options }; return client; },
    env: (name) => ({ SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'anon-key' })[name],
  });
  const response = await siteHandler(new Request('https://site.example/api/bills', {
    headers: {
      'x-instance-id': INSTANCE_ID,
      'x-qoder-user-context': createDevUserContext({ userId: USER_A }),
      authorization: 'Bearer browser',
      cookie: 'session=1',
    },
  }));
  check('adapter：合法请求进入业务并保留 Gateway 身份头',
    response.status === 200 && handlerCapture.request.headers.get('x-qoder-user-context')
    && handlerCapture.request.headers.get('authorization') === null
    && handlerCapture.request.headers.get('cookie') === null
    && handlerCapture.request.headers.get('x-instance-id') === null);
  check('adapter：createClient 使用环境凭证且关闭会话持久化',
    clientCapture.url === 'https://db.example' && clientCapture.key === 'anon-key'
    && clientCapture.options?.auth?.persistSession === false && handlerCapture.supabase === client);

  let rejected = false;
  try {
    await clientCapture.options.global.fetch('https://evil.example/rest/v1/bills');
  } catch { rejected = true; }
  check('adapter：routed fetch 拒绝非数据库 origin', rejected);
}

{
  const client = {};
  let clientOptions = null;
  let sentRequest = null;
  const siteHandler = serveSite(() => Response.json({ ok: true }), {
    createClient: (url, key, options) => { clientOptions = options; return client; },
    env: (name) => ({ SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'anon-key' })[name],
    fetch: async (request) => {
      sentRequest = request;
      return Response.json([]);
    },
  });
  await siteHandler(new Request('https://site.example/api/bills', {
    headers: { 'x-instance-id': INSTANCE_ID, 'x-qoder-user-context': createDevUserContext({ userId: USER_A }) },
  }));
  const response = await clientOptions.global.fetch('https://db.example/rest/v1/bills?select=id', {
    headers: { cookie: 'secret', 'x-qsites-origin': 'browser' },
  });
  check('adapter：routed fetch 只放行 /rest/v1 并注入租户与 anon key',
    response.status === 200 && sentRequest.headers.get('x-instance-id') === INSTANCE_ID
    && sentRequest.headers.get('apikey') === 'anon-key'
    && sentRequest.headers.get('authorization') === 'Bearer anon-key'
    && sentRequest.headers.get('cookie') === null
    && sentRequest.headers.get('x-qsites-origin') === null);
}

/* ==== 汇总 ==== */
const failed = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok ? '' : `   → ${result.detail}`}`);
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
