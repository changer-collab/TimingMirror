// 新旧导入视图共用的确认收口：正式账单状态、助手通知与导入 flow 结束。
import { defaultImportRecovery } from '../state.js';

export function assistantImportText(bill) {
  const method = bill.importMethod === 'ai'
    ? (bill.importModality === 'vision' ? '视觉识别后由你校对' : 'AI 识别后由你校对')
    : '本机解析';
  return `账单已确认导入：${bill.fileName}（${bill.trades.length} 笔，${method}）。可以继续描述交易规则。`;
}

export function canConfirmBill(state) {
  const bill = state.bill;
  return !!bill && bill.status === 'loaded' && !bill.blocked
    && Array.isArray(bill.errors) && bill.errors.length === 0
    && Array.isArray(bill.trades) && bill.trades.length > 0
    && state.importRecovery?.pending !== true;
}

export function finalizeConfirmedBill({ state, set, go, client } = {}) {
  const bill = state.bill;
  if (!canConfirmBill(state)) {
    set({
      importRecovery: {
        ...(state.importRecovery ?? defaultImportRecovery()),
        error: { code: 'E_IMPORT_CONFIRM_BLOCKED', message: '当前账单没有通过校验，不能确认导入' },
      },
    });
    return { ok: false, code: 'E_IMPORT_CONFIRM_BLOCKED' };
  }
  set({ bill: { status: 'confirmed' } });
  if (state.bill.status !== 'confirmed') return { ok: false, code: 'E_IMPORT_CONFIRM_BLOCKED' };
  if (bill.sourceType === 'local') {
    set({
      assistant: {
        ...state.assistant,
        messages: [...(state.assistant?.messages ?? []), { role: 'assistant', kind: 'notice', text: assistantImportText(bill) }],
      },
    });
    try {
      if (client && typeof client.completeFlow === 'function') {
        const completed = client.completeFlow({ reason: 'bill_confirmed', billContextId: bill.contextId ?? null });
        if (completed?.trace?.messages) {
          set({ importRecovery: { ...(state.importRecovery ?? defaultImportRecovery()), trace: completed.trace } });
        }
      }
    } catch { /* 预算收口失败不阻断已确认账单 */ }
  }
  set({
    importRecovery: {
      ...(state.importRecovery ?? defaultImportRecovery()),
      sourceId: null,
      pending: false,
    },
  });
  go('report');
  return { ok: true };
}
