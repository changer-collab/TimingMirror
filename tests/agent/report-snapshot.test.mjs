#!/usr/bin/env node
/**
 * 报告快照 v2 测试（纯函数；不联网）
 *
 * 覆盖：画像 + 报告 bundle、文件名与行情明细剥离、超限降级、缺失画像拒绝。
 */
import {
  REPORT_SNAPSHOT_LIMITS,
  REPORT_SNAPSHOT_VERSION,
  buildReportSnapshot,
  sanitizeReportBundle,
} from '../../src/agent/reportSnapshot.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function profile() {
  return {
    version: 1,
    observations: 1,
    latest: {
      version: 1,
      at: '2026-10-23T08:00:00.000Z',
      profile_key: 'abcdef01',
      bill: { trade_count: 3 },
      review: { portfolio_published: true, published_count: 6 },
    },
    history: [],
  };
}

function bundle() {
  return {
    sourceType: 'local',
    fileName: 'my-broker-2024.csv',
    asOfDate: '2025-10-17',
    status: 'ok',
    prices: { '600519': [[1, 2, 3]] },
    closes: { '600519': 1500 },
    market: { days: new Array(500).fill(1500) },
    review: { portfolio_published: true },
    factsByScope: { portfolio: { dragMoney: { value: 6440 } } },
    provenance: { items: [{ fact_id: 'f1', source_refs: [{ file: 'my-broker-2024.csv', line: 2 }] }] },
    insights: {
      portfolio: {
        report: { portfolio: { dragMoney: 6440 } },
        counterfactuals: [{ symbol: '600519', series: { points: [{ date: '2025-01-02', cf: 10, actual: 9 }] } }],
      },
    },
    nested: { sourceFile: 'my-broker-2024.csv', keep: 'ok' },
  };
}

/* ==== 基本结构 ==== */
{
  const snapshot = buildReportSnapshot({ profile: profile(), bundle: bundle() });
  check('版本：v2 并带画像键与时间', snapshot?.version === REPORT_SNAPSHOT_VERSION
    && snapshot.profile_key === 'abcdef01' && snapshot.at === '2026-10-23T08:00:00.000Z', JSON.stringify(snapshot && Object.keys(snapshot)));
  check('画像：latest 与顶层键一致', snapshot?.profile?.latest?.profile_key === 'abcdef01'
    && snapshot?.profile?.latest?.review?.portfolio_published === true);
  check('账单：只保留成交笔数', JSON.stringify(snapshot?.bill) === '{"trade_count":3}', JSON.stringify(snapshot?.bill));
  check('报告：保留渲染所需字段', snapshot?.report_available === true
    && snapshot?.report?.factsByScope?.portfolio?.dragMoney?.value === 6440
    && snapshot?.report?.insights?.portfolio?.counterfactuals?.length === 1);
}

/* ==== 隐私与体积 ==== */
{
  const snapshot = buildReportSnapshot({ profile: profile(), bundle: bundle() });
  const text = JSON.stringify(snapshot);
  check('隐私：文件名在任何层级都被剥离', !text.includes('my-broker-2024.csv')
    && !('fileName' in (snapshot.report || {}))
    && !('sourceFile' in (snapshot.report?.nested || {}))
    && snapshot.report?.nested?.keep === 'ok', text.slice(0, 200));
  check('体积：行情明细不进入快照', !('prices' in snapshot.report)
    && !('closes' in snapshot.report) && !('market' in snapshot.report));
  check('体积：快照在客户端上限内', new TextEncoder().encode(text).byteLength <= REPORT_SNAPSHOT_LIMITS.maxBytes);
}

/* ==== 超限降级 ==== */
{
  const huge = bundle();
  huge.insights.portfolio.filler = new Array(60000).fill('x'.repeat(20));
  const snapshot = buildReportSnapshot({ profile: profile(), bundle: huge });
  check('降级：报告超限时只保留画像', snapshot?.version === REPORT_SNAPSHOT_VERSION
    && snapshot.report === null && snapshot.report_available === false
    && snapshot.profile?.latest?.profile_key === 'abcdef01', JSON.stringify(snapshot && { report: snapshot.report, available: snapshot.report_available }));
}

/* ==== 拒绝条件 ==== */
{
  const unpublished = profile();
  unpublished.latest.review = { portfolio_published: false };
  check('拒绝：组合结果未发布', buildReportSnapshot({ profile: unpublished, bundle: bundle() }) === null);

  const noKey = profile();
  noKey.latest.profile_key = '';
  check('拒绝：缺少画像键', buildReportSnapshot({ profile: noKey, bundle: bundle() }) === null);
  check('拒绝：缺少画像', buildReportSnapshot({ bundle: bundle() }) === null);
  check('清洗：非对象 bundle 返回 null', sanitizeReportBundle('x') === null);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
