#!/usr/bin/env node
/**
 * P3 · 历史账单索引 —— 离线单测（合成夹具；零网络）
 *
 * 覆盖：不透明引用、持有天数桶（先进先出）、标的聚合、成立模式筛选、
 *       未发布/无报告/无快照排除、当前账单排除、排序与覆盖、字段白名单。
 * 运行：node tests/agent/history-index.test.mjs（或 npm run check）
 */
import {
  HISTORY_INDEX_VERSION, HOLDING_BUCKETS, refOf, holdingBucketOf, holdingBucketsOf,
  symbolsOf, establishedPatternsOf, projectHistoryRow, buildHistoryIndex,
} from '../../src/agent/historyIndex.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const trade = (tradeDate, symbol, side) => ({ trade_date: tradeDate, symbol, side, price: 10, quantity: 100 });

function snapshotOf({ patterns = [], published = true, version = 2 } = {}) {
  const latest = {
    profile_key: 'abcd1234',
    at: '2026-09-30T10:00:00.000Z',
    bill: { trade_count: 4 },
    behavior: { patterns },
    review: { portfolio_published: published },
  };
  if (version === 1) {
    return {
      version: 1,
      at: '2026-09-30T10:00:00.000Z',
      profile_key: 'abcd1234',
      bill: { trade_count: 4 },
      review: { portfolio_published: published },
    };
  }
  return {
    version: 2,
    at: '2026-09-30T10:00:00.000Z',
    profile_key: 'abcd1234',
    bill: { trade_count: 4 },
    review: { portfolio_published: published },
    profile: { latest },
    report: published ? { portfolio: null } : null,
    report_available: published,
  };
}

/* ==== ① 不透明引用 ==== */
{
  const a = refOf('bill-uuid-1111');
  check('引用：稳定且形如 h+16 位十六进制', /^h[0-9a-f]{16}$/u.test(a) && refOf('bill-uuid-1111') === a, a);
  check('引用：不同输入不同值且不可反推', a !== refOf('bill-uuid-2222')
    && !a.includes('bill-uuid') && !a.includes('1111'), a);
}

/* ==== ② 持有天数桶 ==== */
{
  check('桶：边界值归入正确区间', holdingBucketOf(0)?.id === '0-3' && holdingBucketOf(3)?.id === '0-3'
    && holdingBucketOf(4)?.id === '4-10' && holdingBucketOf(10)?.id === '4-10'
    && holdingBucketOf(11)?.id === '11-30' && holdingBucketOf(30)?.id === '11-30'
    && holdingBucketOf(31)?.id === '31+' && holdingBucketOf(-1) === null, JSON.stringify(HOLDING_BUCKETS));
  const buckets = holdingBucketsOf([
    trade('2026-09-01', '600519', 'buy'),
    trade('2026-09-02', '600519', 'sell'),
    trade('2026-09-03', '600519', 'buy'),
    trade('2026-09-20', '600519', 'sell'),
    trade('2026-09-21', '000001', 'sell'),
    trade('2026-09-22', '000001', 'buy'),
  ]);
  check('桶：先进先出配对，单边卖出不计数', buckets.length === 2
    && buckets[0].id === '0-3' && buckets[0].count === 1
    && buckets[1].id === '11-30' && buckets[1].count === 1, JSON.stringify(buckets));
}

/* ==== ③ 标的与行为模式聚合 ==== */
{
  check('标的：去重排序且只留 6 位代码', symbolsOf([
    { symbol: '600519' }, { symbol: '000001' }, { symbol: '600519' }, { symbol: 'abc' }, null,
  ]).join(',') === '000001,600519');
  const patterns = establishedPatternsOf([
    { pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 3 },
    { pattern_id: 'quick_flip', name: '买入后三日内卖出', status: '不成立', sample_n: 2 },
    { pattern_id: 'overtrading', name: '交易频率偏高', status: '证据不足', sample_n: 0 },
    { pattern_id: 'sell_rebuy_within_2d', status: '成立', sample_n: 0 },
    { pattern_id: 'chase_high_buy', status: '成立', sample_n: 9 },
  ]);
  check('模式：只留成立且命中过的项并去重', patterns.length === 1
    && patterns[0].id === 'chase_high_buy' && patterns[0].hits === 3, JSON.stringify(patterns));
  check('模式：已投影的 {id,hits} 可再次使用', establishedPatternsOf(patterns).length === 1
    && establishedPatternsOf(patterns)[0].hits === 3);
}

/* ==== ④ 单份账单投影 ==== */
{
  const ref = refOf('bill-1');
  const ok = projectHistoryRow({
    ref, effective_date: '2026-09-30', snapshot: snapshotOf({
      patterns: [{ pattern_id: 'chase_high_buy', name: '追高买入', status: '成立', sample_n: 3 }],
    }), trades: [trade('2026-09-01', '600519', 'buy'), trade('2026-09-02', '600519', 'sell')],
  });
  check('投影：已发布且有报告 → 紧凑行', ok.ok === true && ok.row.ref === ref
    && ok.row.trade_count === 4
    && ok.row.patterns.length === 1 && ok.row.symbols.join(',') === '600519'
    && ok.row.holding_buckets[0].id === '0-3' && ok.row.report_available === true, JSON.stringify(ok));
  check('投影：行内不含 UUID/文件名/成交/金额',
    !JSON.stringify(ok.row).match(/uuid|fileName|\.csv|price|quantity|amount/u), JSON.stringify(ok.row));

  const unpublished = projectHistoryRow({ ref, snapshot: snapshotOf({ published: false }) });
  check('排除：未发布报告 → unpublished', unpublished.ok === false && unpublished.excluded.reason === 'unpublished');
  const none = projectHistoryRow({ ref, snapshot: null });
  check('排除：没有快照 → no_snapshot', none.ok === false && none.excluded.reason === 'no_snapshot');
  const missing = projectHistoryRow({ ref, snapshot: { ...snapshotOf({}), report: null, report_available: false } });
  check('排除：报告未保存 → report_missing', missing.ok === false && missing.excluded.reason === 'report_missing');
  const v1 = projectHistoryRow({ ref, snapshot: snapshotOf({ version: 1 }) });
  check('排除：v1 快照没有报告 → report_missing', v1.ok === false && v1.excluded.reason === 'report_missing');
}

/* ==== ⑤ 索引构建 ==== */
{
  const entries = [
    { ref: refOf('old'), effective_date: '2026-07-31', snapshot: snapshotOf({}), trades: [] },
    { ref: refOf('new'), effective_date: '2026-09-30', snapshot: snapshotOf({}), trades: [] },
    { ref: refOf('draft'), effective_date: '2026-10-15', snapshot: snapshotOf({ published: false }), trades: [] },
    { ref: refOf('empty'), effective_date: '2026-10-20', snapshot: null, trades: [] },
    { ref: refOf('current'), effective_date: '2026-10-23', snapshot: snapshotOf({}), trades: [] },
  ];
  const index = buildHistoryIndex({ entries, excludeRefs: [refOf('current')] });
  check('索引：版本 / 范围 / 非示例', index.version === HISTORY_INDEX_VERSION
    && index.scope === 'user_saved' && index.synthetic === false);
  check('索引：按日期倒序且排除当前账单', index.rows.map((row) => row.effective_date).join(',') === '2026-09-30,2026-07-31',
    JSON.stringify(index.rows.map((row) => row.effective_date)));
  check('索引：排除原因完整', index.excluded.length === 3
    && index.excluded.some((item) => item.reason === 'current_bill')
    && index.excluded.some((item) => item.reason === 'unpublished')
    && index.excluded.some((item) => item.reason === 'no_snapshot'), JSON.stringify(index.excluded));
  check('索引：覆盖计数不含当前账单', index.coverage.bills_scanned === 5
    && index.coverage.bills_included === 2 && index.coverage.bills_excluded === 2,
    JSON.stringify(index.coverage));
  check('索引：不输出 UUID 或原始成交',
    !JSON.stringify(index).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/u), JSON.stringify(index));
  const demo = buildHistoryIndex({ entries, synthetic: true, scope: 'demo_group' });
  check('索引：示例组明确标记', demo.synthetic === true && demo.scope === 'demo_group');
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
