#!/usr/bin/env node
/**
 * 站点数据客户端测试（fake fetch；不联网）
 *
 * 覆盖：同源路径与凭证模式、body 白名单、错误码与上游错误不透传正文。
 */
import { DATA_CLIENT_CODES, DATA_CLIENT_PATHS, createDataClient } from '../../src/agent/dataClient.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const FACTS = [{
  kind: 'constraint',
  key: 'max_position',
  value: '仓位控制在五成以内',
  evidence: '把仓位控制在五成以内',
  source: 'chat',
  source_ref: 'bill-1',
}];

/* ==== 成功 ==== */
{
  const calls = [];
  const client = createDataClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, added: [{ id: 'f1' }], duplicates: [] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await client.saveFacts({ facts: FACTS });
  const body = JSON.parse(calls[0].options.body);
  check('路径：固定站点 Function 地址', calls[0].url === '/functions/v1/app/api/profile/facts'
    && calls[0].url === DATA_CLIENT_PATHS.facts, calls[0].url);
  check('请求：POST + 同源会话 + 只发送 facts', calls[0].options.method === 'POST'
    && calls[0].options.credentials === 'same-origin'
    && Object.keys(body).join(',') === 'facts'
    && body.facts.length === 1, JSON.stringify(body));
  check('请求：无自定义认证头', !Object.keys(calls[0].options.headers).some((h) => /authorization|api[-_]?key/i.test(h)));
  check('响应：返回服务端结果', result.ok === true && result.added.length === 1);
}

/* ==== 账单 / 画像 / 快照路径 ==== */
{
  const calls = [];
  const client = createDataClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, bill: { id: 'b1' }, bills: [], facts: [], deleted: true, index: { version: 'history-index-1', rows: [], excluded: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const id = '11111111-1111-4111-8111-111111111111';
  await client.saveBill({ body: { content_hash: 'a'.repeat(64) } });
  await client.listBills({ limit: 5, offset: 10 });
  await client.deleteBill({ id });
  await client.saveSnapshot({ id, snapshot: { version: 1 } });
  await client.getProfile();
  await client.deleteFact({ id });
  await client.saveProfileSummary({ digest: { profile_key: 'abcdef01' }, summary: { headline: 'x' } });
  await client.getBill({ id });
  await client.getRules();
  await client.saveRules({ versions: [] });
  const history = await client.historyIndex({ limit: 5, exclude: id });

  check('账单：保存到 /api/bills（POST）', calls[0].url === '/functions/v1/app/api/bills'
    && calls[0].options.method === 'POST'
    && JSON.parse(calls[0].options.body).content_hash === 'a'.repeat(64), JSON.stringify(calls[0]));
  check('账单：列表带 limit / offset', calls[1].url === '/functions/v1/app/api/bills?limit=5&offset=10'
    && calls[1].options.method === 'GET' && calls[1].options.body === undefined, calls[1].url);
  check('账单：删除按 id', calls[2].url === `/functions/v1/app/api/bills/${id}` && calls[2].options.method === 'DELETE');
  check('账单：快照按 id + /snapshot', calls[3].url === `/functions/v1/app/api/bills/${id}/snapshot`
    && calls[3].options.method === 'POST'
    && Object.keys(JSON.parse(calls[3].options.body)).join(',') === 'snapshot', calls[3].url);
  check('画像：读取 /api/profile', calls[4].url === '/functions/v1/app/api/profile' && calls[4].options.method === 'GET');
  check('画像：删除事实按 id', calls[5].url === `/functions/v1/app/api/profile/facts/${id}` && calls[5].options.method === 'DELETE');
  check('画像：保存摘要只发送 digest / summary', calls[6].url === '/functions/v1/app/api/profile/summary'
    && Object.keys(JSON.parse(calls[6].options.body)).join(',') === 'digest,summary', calls[6].url);
  check('账单：按 id 读取（GET，无 body）', calls[7].url === `/functions/v1/app/api/bills/${id}`
    && calls[7].options.method === 'GET' && calls[7].options.body === undefined, calls[7].url);
  check('规则：读取 /api/rules（GET）', calls[8].url === '/functions/v1/app/api/rules'
    && calls[8].options.method === 'GET' && calls[8].options.body === undefined, calls[8].url);
  check('规则：保存只发送 versions（PUT）', calls[9].url === '/functions/v1/app/api/rules'
    && calls[9].options.method === 'PUT'
    && Object.keys(JSON.parse(calls[9].options.body)).join(',') === 'versions'
    && JSON.parse(calls[9].options.body).versions.length === 0, calls[9].url);
  check('历史索引：GET + limit/exclude', calls[10].url === `/functions/v1/app/api/history/index?limit=5&exclude=${id}`
    && calls[10].options.method === 'GET' && calls[10].options.body === undefined, calls[10].url);
  check('历史索引：返回 index 对象', history.version === 'history-index-1' && Array.isArray(history.rows), JSON.stringify(history));
}

/* ==== 请求校验 ==== */
{
  const client = createDataClient({ fetchImpl: async () => new Response('{}', { status: 200 }) });
  const id = '11111111-1111-4111-8111-111111111111';
  const invalidId = 'not-a-uuid';
  const cases = [
    ['保存账单：空 body', () => client.saveBill({})],
    ['列表：非法 limit', () => client.listBills({ limit: 0 })],
    ['列表：非法 offset', () => client.listBills({ offset: -1 })],
    ['删除账单：非法 id', () => client.deleteBill({ id: invalidId })],
    ['读取账单：非法 id', () => client.getBill({ id: invalidId })],
    ['保存规则：非数组', () => client.saveRules({ versions: 'x' })],
    ['保存规则：缺失 versions', () => client.saveRules()],
    ['快照：非法 id', () => client.saveSnapshot({ id: invalidId, snapshot: {} })],
    ['快照：空 snapshot', () => client.saveSnapshot({ id })],
    ['删除事实：非法 id', () => client.deleteFact({ id: invalidId })],
    ['摘要：空 digest', () => client.saveProfileSummary({ summary: {} })],
    ['摘要：空 summary', () => client.saveProfileSummary({ digest: {} })],
    ['历史索引：非法 limit', () => client.historyIndex({ limit: 0 })],
    ['历史索引：超上限 limit', () => client.historyIndex({ limit: 51 })],
    ['历史索引：非法 exclude', () => client.historyIndex({ exclude: invalidId })],
  ];
  for (const [name, run] of cases) {
    let error = null;
    try { await run(); } catch (e) { error = e; }
    check(`请求：拒绝${name}`, error && error.code === DATA_CLIENT_CODES.REQUEST, error && error.code);
  }
}

/* ==== 请求校验（事实） ==== */
{
  const client = createDataClient({ fetchImpl: async () => new Response('{}', { status: 200 }) });
  for (const [name, facts] of [['空数组', []], ['非数组', 'x'], ['缺失', undefined]]) {
    let error = null;
    try { await client.saveFacts({ facts }); } catch (e) { error = e; }
    check(`请求：拒绝${name}`, error && error.code === DATA_CLIENT_CODES.REQUEST, error && error.code);
  }
}

/* ==== HTTP 错误：只保留状态与上游错误码 ==== */
{
  const client = createDataClient({
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'write_rejected', message: '数据库写入失败' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  let error = null;
  try { await client.saveFacts({ facts: FACTS }); } catch (e) { error = e; }
  check('错误：非 2xx 保留状态与上游码', error
    && error.code === DATA_CLIENT_CODES.STATUS
    && error.status === 503
    && error.upstreamCode === 'write_rejected'
    && !error.message.includes('数据库写入失败'), JSON.stringify({ code: error?.code, status: error?.status, upstreamCode: error?.upstreamCode }));
}

/* ==== 非法响应 ==== */
{
  const invalidJson = createDataClient({
    fetchImpl: async () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let e1 = null;
  try { await invalidJson.saveFacts({ facts: FACTS }); } catch (e) { e1 = e; }
  check('错误：非法 JSON → E_DATA_JSON', e1 && e1.code === DATA_CLIENT_CODES.JSON
    && !e1.message.includes('not-json'), e1 && e1.message);

  const invalidShape = createDataClient({
    fetchImpl: async () => new Response(JSON.stringify({ added: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  let e2 = null;
  try { await invalidShape.saveFacts({ facts: FACTS }); } catch (e) { e2 = e; }
  check('错误：缺少 ok → E_DATA_RESPONSE', e2 && e2.code === DATA_CLIENT_CODES.RESPONSE, e2 && e2.message);
}

/* ==== 网络失败与取消 ==== */
{
  const network = createDataClient({ fetchImpl: async () => { throw new Error('offline'); } });
  let e1 = null;
  try { await network.saveFacts({ facts: FACTS }); } catch (e) { e1 = e; }
  check('错误：网络失败 → E_DATA_NETWORK', e1 && e1.code === DATA_CLIENT_CODES.NETWORK, e1 && e1.code);

  const client = createDataClient({
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = client.saveFacts({ facts: FACTS, signal: controller.signal });
  controller.abort();
  let e2 = null;
  try { await pending; } catch (e) { e2 = e; }
  check('错误：取消 → E_DATA_ABORTED', e2 && e2.code === DATA_CLIENT_CODES.ABORTED, e2 && e2.code);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
