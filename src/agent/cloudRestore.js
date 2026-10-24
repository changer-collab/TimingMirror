// 云端恢复的纯函数：把云端账单行还原成页面账单，并过滤云端规则记录。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const SYMBOL_RE = /^\d{6}$/u;

function text(value, max = 64) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function cloudTrade(trade, index) {
  if (!trade || typeof trade !== 'object') return null;
  const tradeDate = text(trade.trade_date, 10);
  const symbol = text(trade.symbol, 6);
  const price = positive(trade.price);
  const quantity = positive(trade.quantity);
  if (!DATE_RE.test(tradeDate) || !SYMBOL_RE.test(symbol)) return null;
  if (trade.side !== 'buy' && trade.side !== 'sell') return null;
  if (price === null || quantity === null) return null;
  const fee = trade.fee == null ? null : nonNegative(trade.fee);
  const tax = trade.tax == null ? null : nonNegative(trade.tax);
  if (trade.fee != null && fee === null) return null;
  if (trade.tax != null && tax === null) return null;
  return {
    trade_id: text(trade.trade_id, 32) || `T${String(index + 1).padStart(3, '0')}`,
    trade_date: tradeDate,
    symbol,
    side: trade.side,
    price,
    quantity,
    fee,
    tax,
  };
}

// 只接受云端已保存的完整明细；任何一笔无法还原都整份拒绝，不生成部分账单。
export function billFromCloudBill(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') return null;
  if (row.payload_mode !== 'full' || !Array.isArray(row.payload?.trades) || row.payload.trades.length === 0) return null;
  const trades = row.payload.trades.map(cloudTrade);
  if (trades.some((trade) => trade === null)) return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const dataMode = text(metadata.data_mode, 32);
  return {
    status: 'confirmed',
    scenario: 'R',
    trades,
    warnings: [],
    errors: [],
    sourceNote: '云端账单（原始 CSV 与文件名未上传）',
    resultLabelling: null,
    error: '',
    sourceType: 'local',
    fileName: '',
    fileSize: 0,
    blocked: false,
    dataMode: dataMode || null,
    contextId: `cloud-${row.id}`,
    importMethod: 'manual',
    cloudBillId: row.id,
    cloudRestored: true,
  };
}

export function normalizeCloudRules(payload) {
  const rows = Array.isArray(payload?.rules) ? payload.rules : [];
  return rows.filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
}

// 云端记录的 report_key 用于重启后跳过同一份报告的重复观察。
export function cloudReportKeys(payload) {
  const rows = Array.isArray(payload?.bills) ? payload.bills : [];
  return rows
    .map((row) => (typeof row?.snapshot?.report_key === 'string' ? row.snapshot.report_key : ''))
    .filter(Boolean);
}
