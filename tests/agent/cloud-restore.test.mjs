import assert from 'node:assert/strict';
import {
  billFromCloudBill, cloudReportKeys, normalizeCloudRules,
} from '../../src/agent/cloudRestore.js';

const row = {
  id: 'bill-1',
  payload_mode: 'full',
  metadata: { data_mode: 'ledger' },
  payload: {
    trades: [
      {
        trade_id: 'T001', trade_date: '2025-01-06', symbol: '600519', side: 'buy', price: 1500.5, quantity: 100, fee: 5, tax: 0,
      },
      {
        trade_date: '2025-01-08', symbol: '000001', side: 'sell', price: 11.2, quantity: 500,
      },
    ],
    fileName: '我的对账单.csv',
    file_name: '我的对账单.csv',
  },
};

const bill = billFromCloudBill(row);
assert.equal(bill.status, 'confirmed');
assert.equal(bill.sourceType, 'local');
assert.equal(bill.cloudRestored, true);
assert.equal(bill.cloudBillId, 'bill-1');
assert.equal(bill.contextId, 'cloud-bill-1');
assert.equal(bill.fileName, '');
assert.equal(bill.trades.length, 2);
assert.equal(bill.trades[0].fee, 5);
assert.equal(bill.trades[1].trade_id, 'T002', '缺省成交编号按顺序补齐');
assert.equal(bill.trades[1].fee, null);
assert.equal(bill.trades[1].tax, null);
assert.ok(!JSON.stringify(bill).includes('我的对账单'), '文件名不进入账单');
console.log('云端完整明细还原检查通过');

assert.equal(billFromCloudBill(null), null);
assert.equal(billFromCloudBill({ ...row, payload_mode: 'summary' }), null, '仅统计账单不还原');
assert.equal(billFromCloudBill({ ...row, payload: { trades: [] } }), null, '无明细不还原');
assert.equal(billFromCloudBill({
  ...row,
  payload: { trades: [{ trade_date: '2025/01/06', symbol: '600519', side: 'buy', price: 1, quantity: 1 }] },
}), null, '非法日期整份拒绝');
assert.equal(billFromCloudBill({
  ...row,
  payload: { trades: [{ trade_date: '2025-01-06', symbol: '600519', side: 'hold', price: 1, quantity: 1 }] },
}), null, '非法方向整份拒绝');
assert.equal(billFromCloudBill({
  ...row,
  payload: { trades: [{ trade_date: '2025-01-06', symbol: '600519', side: 'buy', price: -1, quantity: 1 }] },
}), null, '非正价格整份拒绝');
assert.equal(billFromCloudBill({
  ...row,
  payload: { trades: [{ trade_date: '2025-01-06', symbol: '600519', side: 'buy', price: 1, quantity: 1, fee: -1 }] },
}), null, '非法费用整份拒绝');
assert.equal(billFromCloudBill({
  ...row,
  payload: { trades: [row.payload.trades[0], { trade_date: 'bad' }] },
}), null, '一笔非法则整份拒绝');
console.log('云端明细非法结构拒绝检查通过');

assert.deepEqual(normalizeCloudRules({ rules: [versionsRow(), null, 7, 'x', [1]] }), [versionsRow()]);
assert.deepEqual(normalizeCloudRules({}), []);
assert.deepEqual(normalizeCloudRules(null), []);
console.log('云端规则过滤检查通过');

function versionsRow() {
  return { schema: 'contract-v1', v: 1, status: '已确认', hash: '0123456789abcdef' };
}

const payload = {
  bills: [
    { id: 'a', snapshot: { report_key: 'abc' } },
    { id: 'b', snapshot: { report_key: 42 } },
    { id: 'c', snapshot: null },
    { id: 'd', snapshot: { report_key: 'def' } },
    null,
  ],
};
assert.deepEqual(cloudReportKeys(payload), ['abc', 'def']);
assert.deepEqual(cloudReportKeys(null), []);
console.log('云端报告去重键检查通过');
