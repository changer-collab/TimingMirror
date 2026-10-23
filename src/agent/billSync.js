// 账单云端同步载荷（纯函数）：默认只生成统计字段；完整成交明细需要调用方显式开启。
// content_hash 与 server/site-functions/dataApi.mjs 的 contentHashOfTrades 必须逐字节一致，
// 否则同一份账单在“仅统计 → 完整明细”升级时会被服务端判为不同账单。
export const BILL_SYNC_CODES = Object.freeze({
  NO_BILL: 'E_BILL_SYNC_NO_BILL',
  TRADE_INVALID: 'E_BILL_SYNC_TRADE_INVALID',
  HASH_UNSUPPORTED: 'E_BILL_SYNC_HASH_UNSUPPORTED',
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
const CONTEXT_RE = /^[A-Za-z0-9._:-]{1,64}$/u;
const TRADE_ID_RE = /^[A-Za-z0-9._:-]{1,32}$/u;
const DATA_MODE_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/u;
const IMPORT_METHODS = new Set(['manual', 'ai']);

function syncError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function numberText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function dateText(value) {
  const date = text(value);
  if (!DATE_RE.test(date)) return null;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? date : null;
}

async function sha256Hex(value) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw syncError(BILL_SYNC_CODES.HASH_UNSUPPORTED);
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 保持与服务端完全相同的行顺序与字段；排序后再哈希，导入顺序不同也视为同一份账单。
export async function contentHashOfTrades(trades) {
  const rows = (Array.isArray(trades) ? trades : []).map((trade) => [
    trade?.trade_date ?? '',
    trade?.symbol ?? '',
    trade?.side ?? '',
    numberText(trade?.price),
    numberText(trade?.quantity),
    trade?.fee == null ? '' : numberText(trade.fee),
    trade?.tax == null ? '' : numberText(trade.tax),
  ].join('\t'));
  rows.sort();
  return sha256Hex(rows.join('\n'));
}

function normalizedTradeId(value, index) {
  const id = text(value);
  return TRADE_ID_RE.test(id) ? id : `T${String(index + 1).padStart(3, '0')}`;
}

function normalizeTrade(trade, index) {
  if (trade === null || typeof trade !== 'object') return null;
  const tradeDate = dateText(trade.trade_date);
  const symbol = text(trade.symbol);
  const side = trade.side === 'buy' || trade.side === 'sell' ? trade.side : null;
  const price = typeof trade.price === 'number' && Number.isFinite(trade.price) && trade.price > 0 ? trade.price : null;
  const quantity = typeof trade.quantity === 'number' && Number.isFinite(trade.quantity) && trade.quantity > 0 ? trade.quantity : null;
  const fee = trade.fee == null ? null : (typeof trade.fee === 'number' && Number.isFinite(trade.fee) && trade.fee >= 0 ? trade.fee : null);
  const tax = trade.tax == null ? null : (typeof trade.tax === 'number' && Number.isFinite(trade.tax) && trade.tax >= 0 ? trade.tax : null);
  if (!tradeDate || !/^\d{6}$/u.test(symbol) || !side || price === null || quantity === null
    || (trade.fee != null && fee === null) || (trade.tax != null && tax === null)) return null;
  return {
    trade_id: normalizedTradeId(trade.trade_id, index),
    trade_date: tradeDate,
    symbol,
    side,
    price,
    quantity,
    fee,
    tax,
  };
}

export async function buildBillSyncBody(bill, { includeTrades = false } = {}) {
  if (!bill || typeof bill !== 'object') throw syncError(BILL_SYNC_CODES.NO_BILL);
  const trades = Array.isArray(bill.trades) ? bill.trades : [];
  const dates = trades.map((trade) => dateText(trade?.trade_date)).filter(Boolean).sort();
  const symbols = new Set(trades.map((trade) => text(trade?.symbol)).filter((symbol) => /^\d{6}$/u.test(symbol)));
  const contentHash = await contentHashOfTrades(trades);
  if (!HASH_RE.test(contentHash)) throw syncError(BILL_SYNC_CODES.HASH_UNSUPPORTED);
  const contextId = text(bill.contextId);
  const dataMode = text(bill.dataMode);
  const body = {
    content_hash: contentHash,
    context_id: CONTEXT_RE.test(contextId) ? contextId : null,
    source_type: 'local',
    effective_date: dates[dates.length - 1] ?? null,
    import_method: IMPORT_METHODS.has(bill.importMethod) ? bill.importMethod : 'unknown',
    metadata: {
      trades_count: trades.length,
      warnings_count: Array.isArray(bill.warnings) ? bill.warnings.length : 0,
      data_mode: DATA_MODE_RE.test(dataMode) ? dataMode : null,
      date_from: dates[0] ?? null,
      date_to: dates[dates.length - 1] ?? null,
      symbol_count: symbols.size,
    },
    payload_mode: includeTrades ? 'full' : 'summary',
  };
  if (includeTrades) {
    const payloadTrades = trades.map((trade, index) => normalizeTrade(trade, index));
    if (payloadTrades.some((trade) => trade === null)) {
      throw syncError(BILL_SYNC_CODES.TRADE_INVALID);
    }
    body.payload = { trades: payloadTrades };
  }
  return body;
}
