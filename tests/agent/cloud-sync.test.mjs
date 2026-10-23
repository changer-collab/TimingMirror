#!/usr/bin/env node
/**
 * 前端云同步状态测试（fake save；不联网）
 *
 * 覆盖：偏好持久化、统计/明细模式、并发去重、失败文案、快照等待与删除标记。
 */
import {
  billSyncStatus,
  cloudStatusText,
  getFullTradesPreference,
  markCloudBillRemoved,
  resetBillSync,
  setFullTradesPreference,
  syncBill,
  syncSnapshot,
  syncSnapshotWithBill,
} from '../../prototype/user-frontend/cloudSync.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
};

const BILL_ID = '11111111-1111-4111-8111-111111111111';

function bill(contextId, overrides = {}) {
  return {
    contextId,
    sourceType: 'local',
    demo: false,
    importMethod: 'manual',
    dataMode: 'real',
    trades: [
      { trade_date: '2024-03-01', symbol: '600000', side: 'buy', price: 10.5, quantity: 100, fee: 5, tax: 0 },
      { trade_date: '2024-03-05', symbol: '600000', side: 'sell', price: 11, quantity: 100, fee: 5, tax: 0.5 },
    ],
    warnings: [],
    ...overrides,
  };
}

function snapshot(key = 'abcdef01') {
  return {
    version: 1,
    at: '2026-10-22T08:00:00.000Z',
    profile_key: key,
    bill: { trade_count: 2 },
    review: { portfolio_published: true },
  };
}

resetBillSync();

/* ==== 偏好 ==== */
check('偏好：默认只存统计', getFullTradesPreference() === false);
setFullTradesPreference(true);
check('偏好：勾选后保存为 1', getFullTradesPreference() === true && store.get('tm.cloud.fullTrades') === '1');
setFullTradesPreference(false);
check('偏好：取消后保存为 0', getFullTradesPreference() === false && store.get('tm.cloud.fullTrades') === '0');

/* ==== 统计模式 ==== */
{
  const calls = [];
  const target = bill('ctx-summary');
  const result = await syncBill({
    bill: target,
    saveBill: async ({ body }) => {
      calls.push(body);
      return { ok: true, bill: { id: BILL_ID }, duplicate: false };
    },
  });
  check('统计：只调用一次保存', calls.length === 1, calls.length);
  check('统计：请求体为 summary 且不带成交行',
    calls[0].payload_mode === 'summary' && !('payload' in calls[0]), JSON.stringify(Object.keys(calls[0])));
  check('统计：状态已同步并记录云端 id',
    result.state === 'synced' && result.mode === 'summary' && result.billId === BILL_ID
    && billSyncStatus(target).state === 'synced');
  check('统计：状态文案', cloudStatusText(result) === '云端已存统计', cloudStatusText(result));
}

/* ==== 完整明细 opt-in ==== */
{
  let body = null;
  const result = await syncBill({
    bill: bill('ctx-full'),
    includeTrades: true,
    saveBill: async ({ body: sent }) => {
      body = sent;
      return { ok: true, bill: { id: BILL_ID }, duplicate: true };
    },
  });
  check('明细：payload_mode=full 并带两笔成交',
    body.payload_mode === 'full' && body.payload.trades.length === 2, JSON.stringify(body.payload_mode));
  check('明细：重复导入只标记 duplicate',
    result.duplicate === true && cloudStatusText(result) === '云端已存（含明细）', cloudStatusText(result));
}

/* ==== 不该同步的账单 ==== */
{
  let called = 0;
  const saveBill = async () => { called += 1; return { ok: true }; };
  const demo = await syncBill({ bill: bill('ctx-demo', { demo: true }), saveBill });
  const empty = await syncBill({ bill: bill('ctx-empty', { trades: [] }), saveBill });
  const noContext = await syncBill({ bill: bill(null), saveBill });
  check('边界：示例 / 空成交 / 无上下文都不发起请求',
    called === 0 && demo.state === 'local' && empty.reason === 'no-trades' && noContext.reason === 'not-syncable',
    JSON.stringify({ called, demo, empty, noContext }));
}

/* ==== 并发去重 ==== */
{
  let calls = 0;
  let release;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const saveBill = async () => {
    calls += 1;
    startedResolve();
    await gate;
    return { ok: true, bill: { id: BILL_ID }, duplicate: false };
  };
  const first = syncBill({ bill: bill('ctx-pending'), saveBill });
  const second = syncBill({ bill: bill('ctx-pending'), saveBill });
  await started;
  check('并发：同一账单复用同一个请求', first === second && calls === 1, `${first === second}/${calls}`);
  check('并发：进行中状态', billSyncStatus({ contextId: 'ctx-pending' }).state === 'pending');
  release();
  await Promise.all([first, second]);
  check('并发：完成后只保留一次保存', calls === 1 && billSyncStatus({ contextId: 'ctx-pending' }).state === 'synced');
}

/* ==== 失败文案 ==== */
{
  const error = Object.assign(new Error('hidden'), { upstreamCode: 'database_unavailable' });
  const result = await syncBill({
    bill: bill('ctx-failed'),
    saveBill: async () => { throw error; },
  });
  check('失败：状态 failed 且不透传内部消息',
    result.state === 'failed' && result.code === 'database_unavailable'
    && result.message === '云端数据库暂不可用，账单仍只在本机'
    && !result.message.includes('hidden'), JSON.stringify(result));
  check('失败：状态文案', cloudStatusText(result) === '仅本机 · 云端未同步' && result.billId === null);
}

/* ==== 快照同步 ==== */
{
  resetBillSync();
  const saves = [];
  let billId = null;
  const saveBill = async () => {
    billId = BILL_ID;
    return { ok: true, bill: { id: BILL_ID }, duplicate: false };
  };
  const saveSnapshot = async ({ id, snapshot: sent }) => {
    saves.push({ id, key: sent.profile_key });
    return { ok: true, duplicate: false, snapshot_at: '2026-10-22T08:01:00.000Z' };
  };
  const target = bill('ctx-snapshot');
  const billPromise = syncBill({ bill: target, saveBill });
  const snapshotPromise = syncSnapshot({ bill: target, snapshot: snapshot(), saveSnapshot });
  await billPromise;
  const result = await snapshotPromise;
  check('快照：等账单同步后使用云端 id', result.ok === true && saves.length === 1
    && saves[0].id === billId && saves[0].key === 'abcdef01', JSON.stringify({ result, saves, billId }));

  const again = await syncSnapshot({ bill: target, snapshot: snapshot(), saveSnapshot });
  check('快照：同一内容复用请求', again === result && saves.length === 1, saves.length);

  const failedTarget = bill('ctx-snapshot-failed');
  await syncBill({ bill: failedTarget, saveBill: async () => { throw new Error('offline'); } });
  const failed = await syncSnapshot({ bill: failedTarget, snapshot: snapshot('abcdef02'), saveSnapshot });
  check('快照：账单未同步时跳过', failed.ok === false && failed.code === 'E_CLOUD_BILL_NOT_SYNCED', JSON.stringify(failed));

  markCloudBillRemoved(BILL_ID);
  check('删除：清理对应账单的同步状态与云端 id',
    billSyncStatus(target).state === 'local' && billSyncStatus(target).billId === null);
  const afterDelete = await syncSnapshot({ bill: target, snapshot: snapshot('abcdef03'), saveSnapshot });
  check('删除：之后的快照不再上传', afterDelete.ok === false && afterDelete.code === 'E_CLOUD_BILL_NOT_SYNCED');
}

/* ==== 刷新后快照补偿 ==== */
{
  resetBillSync();
  let billSaves = 0;
  const snapshotSaves = [];
  const saveBill = async () => { billSaves += 1; return { ok: true, bill: { id: BILL_ID }, duplicate: true }; };
  const saveSnapshot = async ({ id }) => {
    snapshotSaves.push(id);
    return { ok: true, duplicate: false, snapshot_at: '2026-10-22T08:01:00.000Z' };
  };
  const target = bill('ctx-reload');
  const first = await syncSnapshotWithBill({ bill: target, snapshot: snapshot('abcdef04'), saveBill, saveSnapshot });
  check('补偿：刷新后先补账单同步再上传快照',
    first.ok === true && billSaves === 1 && snapshotSaves.length === 1 && snapshotSaves[0] === BILL_ID,
    JSON.stringify({ first, billSaves, snapshotSaves }));
  const second = await syncSnapshotWithBill({ bill: target, snapshot: snapshot('abcdef04'), saveBill, saveSnapshot });
  check('补偿：已同步后复用快照结果且不重复保存账单',
    second === first && billSaves === 1 && snapshotSaves.length === 1, JSON.stringify({ billSaves, snapshotSaves }));

  resetBillSync();
  let failedSnapshotCalls = 0;
  const failed = await syncSnapshotWithBill({
    bill: bill('ctx-reload-failed'),
    snapshot: snapshot('abcdef05'),
    saveBill: async () => ({ ok: true, bill: { id: BILL_ID }, duplicate: false }),
    saveSnapshot: async () => { failedSnapshotCalls += 1; throw new Error('offline'); },
  });
  check('补偿：快照上传失败返回失败码，下次可重试',
    failed.ok === false && failed.code === 'E_CLOUD_SNAPSHOT_FAILED' && failedSnapshotCalls === 1, JSON.stringify(failed));
  const retried = await syncSnapshotWithBill({
    bill: bill('ctx-reload-failed'),
    snapshot: snapshot('abcdef05'),
    saveBill: async () => ({ ok: true, bill: { id: BILL_ID }, duplicate: false }),
    saveSnapshot: async () => { failedSnapshotCalls += 1; return { ok: true, duplicate: false }; },
  });
  check('补偿：失败结果不缓存，重试可成功', retried.ok === true && failedSnapshotCalls === 2, failedSnapshotCalls);
}

resetBillSync();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
