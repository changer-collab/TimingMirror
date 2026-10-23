#!/usr/bin/env node
/**
 * 账单云端同步载荷测试（纯函数；不联网）
 *
 * 覆盖：哈希与服务端一致、默认仅统计、完整明细显式开启、字段白名单、无效明细拒绝。
 */
import { BILL_SYNC_CODES, buildBillSyncBody, contentHashOfTrades } from '../../src/agent/billSync.js';
import { contentHashOfTrades as serverContentHash } from '../../server/site-functions/dataApi.mjs';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TRADES = [
  {
    trade_id: 'T001', trade_date: '2024-03-01', symbol: '600519', side: 'buy',
    price: 1680.5, quantity: 100, fee: 5, tax: 0, source: { file: 'my-broker.csv', line: 2 },
  },
  {
    trade_id: 'T002', trade_date: '2024-10-09', symbol: '600519', side: 'sell',
    price: 1520, quantity: 100, fee: null, tax: 1.52, source: { file: 'my-broker.csv', line: 3 },
  },
  {
    trade_id: 'T003', trade_date: '2024-06-14', symbol: '300750', side: 'buy',
    price: 188.25, quantity: 200, fee: 5, source: { file: 'my-broker.csv', line: 4 },
  },
];

function billOf(overrides = {}) {
  return {
    status: 'confirmed',
    sourceType: 'local',
    contextId: 'bill-3',
    fileName: 'my-broker.csv',
    importMethod: 'manual',
    dataMode: 'dynamic-tushare',
    warnings: [{ code: 'W_FEE_COLUMN_MISSING' }],
    trades: TRADES,
    ...overrides,
  };
}

/* ==== 哈希：与服务端逐字节一致 ==== */
{
  const client = await contentHashOfTrades(TRADES);
  const server = await serverContentHash(TRADES);
  check('哈希：客户端与服务端一致', client === server && /^[0-9a-f]{64}$/u.test(client), `${client} / ${server}`);

  const reordered = await contentHashOfTrades([TRADES[2], TRADES[0], TRADES[1]]);
  check('哈希：与导入顺序无关', reordered === client, `${reordered} / ${client}`);

  const changed = await contentHashOfTrades([{ ...TRADES[0], price: 1680.51 }, TRADES[1], TRADES[2]]);
  check('哈希：价格变化会产生不同指纹', changed !== client);
}

/* ==== 默认仅统计 ==== */
{
  const body = await buildBillSyncBody(billOf());
  check('仅统计：payload_mode=summary 且无 payload', body.payload_mode === 'summary' && body.payload === undefined, JSON.stringify(body));
  check('仅统计：不含文件名 / 成交行 / 账户字段',
    !JSON.stringify(body).includes('my-broker.csv')
    && !JSON.stringify(body).includes('trade_id')
    && !Object.keys(body).some((k) => /file|account|broker/i.test(k)), JSON.stringify(body));
  check('统计字段：笔数 / 区间 / 标的数 / 警告数',
    body.metadata.trades_count === 3
    && body.metadata.date_from === '2024-03-01'
    && body.metadata.date_to === '2024-10-09'
    && body.metadata.symbol_count === 2
    && body.metadata.warnings_count === 1, JSON.stringify(body.metadata));
  check('顶层字段：内容指纹 / 上下文 / 来源 / 估值日',
    body.content_hash === await contentHashOfTrades(TRADES)
    && body.context_id === 'bill-3'
    && body.source_type === 'local'
    && body.effective_date === '2024-10-09'
    && body.import_method === 'manual', JSON.stringify(body));
}

/* ==== 完整明细：显式开启 ==== */
{
  const body = await buildBillSyncBody(billOf(), { includeTrades: true });
  check('完整明细：payload_mode=full 且带白名单字段',
    body.payload_mode === 'full'
    && body.payload.trades.length === 3
    && Object.keys(body.payload.trades[0]).join(',') === 'trade_id,trade_date,symbol,side,price,quantity,fee,tax', JSON.stringify(body.payload?.trades?.[0]));
  check('完整明细：源文件行与来源对象不会上传', !JSON.stringify(body).includes('my-broker.csv')
    && !JSON.stringify(body).includes('"source"') && !JSON.stringify(body).includes('"line"'));
  check('完整明细：哈希与载荷一致',
    (await serverContentHash(body.payload.trades)) === body.content_hash, body.content_hash);
}

/* ==== 无效明细与降级字段 ==== */
{
  let error = null;
  try { await buildBillSyncBody(billOf({ trades: [{ ...TRADES[0], price: 0 }] }), { includeTrades: true }); } catch (e) { error = e; }
  check('完整明细：价格非法 → E_BILL_SYNC_TRADE_INVALID',
    error && error.code === BILL_SYNC_CODES.TRADE_INVALID, error && error.code);

  const fallback = await buildBillSyncBody(billOf({
    contextId: '账单 1',
    importMethod: 'demo',
    dataMode: 'Data Mode / 中文',
    trades: [{ ...TRADES[0], trade_id: '带中文的成交编号超过允许长度', trade_date: '2024/03/01', symbol: 'abc' }],
  }));
  check('降级：非法上下文 / 导入方式 / 数据模式写成空值',
    fallback.context_id === null && fallback.import_method === 'unknown' && fallback.metadata.data_mode === null,
    JSON.stringify(fallback));
  check('降级：无效日期不进入区间', fallback.metadata.date_from === null && fallback.metadata.date_to === null,
    JSON.stringify(fallback.metadata));

  const usableIds = await buildBillSyncBody(billOf({
    trades: [{ ...TRADES[0], trade_id: '带中文的成交编号超过允许长度' }],
  }), { includeTrades: true });
  check('降级：非法成交编号回退为 T001', usableIds.payload.trades[0].trade_id === 'T001',
    usableIds.payload.trades[0].trade_id);

  let noBill = null;
  try { await buildBillSyncBody(null); } catch (e) { noBill = e; }
  check('请求：空账单 → E_BILL_SYNC_NO_BILL', noBill && noBill.code === BILL_SYNC_CODES.NO_BILL, noBill && noBill.code);
}

/* ==== 零费用 / 零税费与空费用保持服务端口径 ==== */
{
  const zero = await buildBillSyncBody(billOf({
    trades: [
      { trade_id: 'T1', trade_date: '2024-01-02', symbol: '000001', side: 'buy', price: 10, quantity: 100, fee: 0, tax: 0 },
      { trade_id: 'T2', trade_date: '2024-01-03', symbol: '000001', side: 'sell', price: 11, quantity: 100 },
    ],
  }), { includeTrades: true });
  check('费用：0 保留为 0，缺失保留为 null',
    zero.payload.trades[0].fee === 0 && zero.payload.trades[0].tax === 0
    && zero.payload.trades[1].fee === null && zero.payload.trades[1].tax === null,
    JSON.stringify(zero.payload.trades));
  check('费用：完整明细哈希仍与服务端一致',
    (await serverContentHash(zero.payload.trades)) === zero.content_hash);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
