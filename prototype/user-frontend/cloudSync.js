// 账单后台云同步：确认导入后保存完整明细与报告快照。
// 同步失败不回滚报告；状态只影响提示，不阻断任何本机能力。
import { buildBillSyncBody } from '../../src/agent/billSync.js';

const entries = new Map();
const snapshotJobs = new Map();
const listeners = new Set();

function cloudMessage(error) {
  const code = error?.upstreamCode ?? error?.code ?? '';
  if (code === 'database_unavailable') return '云端数据库暂不可用';
  if (code === 'login_required' || code === 'invalid_user_context') return '未取得云端身份';
  if (code === 'request_too_large' || code === 'request_invalid' || code === 'content_hash_mismatch') {
    return '云端拒绝了这份账单';
  }
  return '云端同步失败';
}

export function cloudStatusText(status) {
  if (!status || status.state === 'demo') return '';
  if (status.state === 'pending') return '云端同步中';
  if (status.state === 'synced') {
    return status.duplicate ? '云端已存这份账单（含明细）' : '云端已存账单 + 明细';
  }
  if (status.state === 'restored') return '已从云端恢复';
  if (status.state === 'failed') return '云端未同步';
  return '本页数据';
}

export function cloudStatusTitle(status) {
  if (!status || status.state === 'demo') return '';
  if (status.state === 'pending') return '正在后台保存账单明细与报告快照，不影响报告与问答';
  if (status.state === 'synced') return '云端已保存成交明细与报告快照；可删除云端记录';
  if (status.state === 'restored') return '本次账单来自云端保存的成交明细与报告快照';
  if (status.state === 'failed') return `${status.message ?? '云端同步失败'}；可稍后重试`;
  return '登录后账单会保存到云端；不会上传原始 CSV';
}

function paintNode(node) {
  const contextId = node.getAttribute('data-context') ?? '';
  const status = entries.get(contextId);
  if (!status || status.state === 'demo') return;
  node.textContent = cloudStatusText(status);
  node.title = cloudStatusTitle(status);
  node.setAttribute('data-state', status.state);
}

function emit(contextId) {
  for (const listener of listeners) {
    try { listener(contextId, entries.get(contextId) ?? null); } catch { /* 订阅者失败不影响同步 */ }
  }
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[data-role="cloud-sync"]').forEach((node) => {
    if (contextId && node.getAttribute('data-context') !== contextId) return;
    paintNode(node);
  });
}

export function billSyncStatus(bill) {
  if (bill?.demo === true) return { state: 'demo' };
  const contextId = bill?.contextId ?? null;
  const entry = entries.get(contextId);
  if (entry) return entry;
  if (bill?.cloudRestored === true) {
    return { state: 'restored', contextId, mode: 'full', billId: bill.cloudBillId ?? null };
  }
  return { state: 'local', contextId, mode: null, billId: null };
}

export function subscribeBillSync(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function syncBill({ bill, saveBill } = {}) {
  const contextId = bill?.contextId ?? null;
  if (typeof saveBill !== 'function') return Promise.resolve({ state: 'local', reason: 'no-client' });
  if (!bill || bill.demo === true || bill.sourceType !== 'local') {
    return Promise.resolve({ state: 'local', reason: 'not-syncable' });
  }
  if (!contextId) return Promise.resolve({ state: 'local', reason: 'not-syncable' });
  if (!Array.isArray(bill.trades) || bill.trades.length === 0) {
    return Promise.resolve({ state: 'local', reason: 'no-trades' });
  }
  const current = entries.get(contextId);
  if (current?.state === 'pending' && current.promise) return current.promise;

  const entry = {
    state: 'pending',
    contextId,
    mode: 'full',
    billId: current?.billId ?? null,
    duplicate: false,
    code: null,
    message: '',
    at: Date.now(),
    promise: null,
  };
  entries.set(contextId, entry);
  emit(contextId);

  const promise = (async () => {
    let next;
    try {
      const body = await buildBillSyncBody(bill);
      const result = await saveBill({ body });
      next = {
        state: 'synced',
        contextId,
        mode: body.payload_mode,
        billId: result?.bill?.id ?? null,
        duplicate: result?.duplicate === true,
        code: null,
        message: '',
        at: Date.now(),
      };
    } catch (error) {
      next = {
        state: 'failed',
        contextId,
        mode: entry.mode,
        billId: null,
        duplicate: false,
        code: error?.upstreamCode ?? error?.code ?? 'E_CLOUD_SYNC_FAILED',
        message: cloudMessage(error),
        at: Date.now(),
      };
    }
    entries.set(contextId, next);
    emit(contextId);
    return next;
  })();
  entry.promise = promise;
  return promise;
}

// 报告发布后才上传派生快照；等账单同步完成再取云端 id，失败只记录，不影响报告。
export function syncSnapshot({ bill, snapshot, saveSnapshot } = {}) {
  if (typeof saveSnapshot !== 'function' || !bill || bill.demo === true || !snapshot) {
    return Promise.resolve({ ok: false, code: 'E_CLOUD_SNAPSHOT_SKIPPED' });
  }
  const contextId = bill.contextId ?? null;
  if (!contextId) return Promise.resolve({ ok: false, code: 'E_CLOUD_SNAPSHOT_SKIPPED' });
  const key = `${snapshot.profile_key ?? ''}|${snapshot.at ?? ''}|${snapshot.bill?.trade_count ?? ''}`;
  const cached = snapshotJobs.get(contextId);
  if (cached?.key === key) return cached.promise;

  const run = () => {
    const billId = entries.get(contextId)?.billId;
    if (!billId) return Promise.resolve({ ok: false, code: 'E_CLOUD_BILL_NOT_SYNCED' });
    return Promise.resolve()
      .then(() => saveSnapshot({ id: billId, snapshot }))
      .then((result) => ({ ok: true, duplicate: result?.duplicate === true, snapshot_at: result?.snapshot_at ?? null }))
      .catch((error) => ({ ok: false, code: error?.upstreamCode ?? error?.code ?? 'E_CLOUD_SNAPSHOT_FAILED' }));
  };
  const pending = entries.get(contextId);
  const promise = pending?.state === 'pending' && pending.promise
    ? pending.promise.then(run)
    : run();
  snapshotJobs.set(contextId, { key, promise });
  // 失败不留在缓存里：下次渲染仍可重试（成功或重复才复用）。
  promise.then((result) => {
    if (result?.ok) return;
    const current = snapshotJobs.get(contextId);
    if (current?.key === key && current.promise === promise) snapshotJobs.delete(contextId);
  });
  return promise;
}

// 刷新页面后内存状态会丢失；报告发布时先幂等补齐账单同步，再上传快照。
export async function syncSnapshotWithBill({
  bill, snapshot, saveBill, saveSnapshot,
} = {}) {
  if (typeof saveBill !== 'function' || typeof saveSnapshot !== 'function') {
    return { ok: false, code: 'E_CLOUD_SNAPSHOT_SKIPPED' };
  }
  const current = billSyncStatus(bill);
  if (current.state !== 'synced' || !current.billId) {
    const synced = await syncBill({ bill, saveBill });
    if (synced.state !== 'synced' || !synced.billId) {
      return { ok: false, code: 'E_CLOUD_BILL_NOT_SYNCED' };
    }
  }
  return syncSnapshot({ bill, snapshot, saveSnapshot });
}

export function markCloudBillRemoved(billId) {
  if (!billId) return;
  for (const [contextId, entry] of entries.entries()) {
    if (entry?.billId !== billId) continue;
    entries.set(contextId, {
      state: 'local',
      contextId,
      mode: null,
      billId: null,
      duplicate: false,
      code: null,
      message: '云端记录已删除',
      at: Date.now(),
    });
    snapshotJobs.delete(contextId);
    emit(contextId);
  }
}

export function resetBillSync() {
  entries.clear();
  snapshotJobs.clear();
}
