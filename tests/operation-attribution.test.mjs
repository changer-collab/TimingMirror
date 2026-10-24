#!/usr/bin/env node
/**
 * 操作类型归因 —— 离线单测（合成夹具；不调用行情/网络）
 *
 * 覆盖：回补/快进快出/其他三桶不重不漏且加总等于逐笔分解；
 *       同一卖出同时命中两类时只归回补；行为不可用或分解阻断时不分类。
 * 运行：node tests/operation-attribution.test.mjs（或 npm run check）
 */
import { buildOperationAttribution } from '../src/engine/operationAttribution.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const item = (tradeId, dragMoney) => ({ trade_id: tradeId, symbol: '000000', trade_date: '2024-09-27', quantity: 100, dragMoney });
const decomposition = (items, total, extra = {}) => ({
  items,
  total: { value: total, display: `¥${total.toFixed(2)}` },
  blocked: false,
  checks: { sum_equals_total: near(items.reduce((s, it) => s + it.dragMoney, 0), total) },
  ...extra,
});
const behavior = (patterns) => ({ available: true, reason: '', data: { patterns } });
const rebuy = (sellId) => ({ pattern_id: 'sell_rebuy_within_2d', evidence: [{ trade_id: 'B9', prior_trade_id: sellId }] });
const flip = (sellId) => ({ pattern_id: 'quick_flip', evidence: [{ trade_id: sellId, prior_trade_id: 'B9' }] });

/* ==== ① 三桶分类与加总 ==== */
{
  const d = decomposition([item('S1', 100), item('S2', 50), item('S3', -20)], 130);
  const r = buildOperationAttribution({ decomposition: d, behavior: behavior([rebuy('S1'), flip('S2')]) });
  const bucket = (id) => r.buckets.find((b) => b.id === id);
  check('归因：回补/快进快出/其他三桶笔数与金额正确', r.ok === true
    && bucket('rebuy').count === 1 && near(bucket('rebuy').money, 100)
    && bucket('quick_flip').count === 1 && near(bucket('quick_flip').money, 50)
    && bucket('other').count === 1 && near(bucket('other').money, -20), JSON.stringify(r.buckets));
  check('归因：三桶金额加总等于逐笔分解总额', r.ok === true
    && near(r.buckets.reduce((s, b) => s + b.money, 0), 130) && near(r.total.value, 130), JSON.stringify(r.total));
  check('归因：占比按组合总差额计算，不显示正号', r.ok === true
    && near(bucket('rebuy').share, 100 / 130) && near(bucket('other').share, -20 / 130)
    && bucket('rebuy').display.share === '76.9%', JSON.stringify(bucket('rebuy')));
  check('归因：口径说明不评价动机', r.ok === true && r.basis.includes('不是对动机的判断'), r.basis);
}

/* ==== ② 同一卖出命中两类：只归回补 ==== */
{
  const d = decomposition([item('S1', 100), item('S2', 30)], 130);
  const r = buildOperationAttribution({ decomposition: d, behavior: behavior([rebuy('S2'), flip('S2')]) });
  const bucket = (id) => r.buckets.find((b) => b.id === id);
  check('归因：同时命中回补与快进快出 → 只归回补，不重复计数', r.ok === true
    && bucket('rebuy').count === 1 && bucket('rebuy').trade_ids.includes('S2')
    && bucket('quick_flip').count === 0, JSON.stringify(r.buckets));
}

/* ==== ③ 行为证据缺失：不强行分类 ==== */
{
  const d = decomposition([item('S1', 100), item('S2', 30)], 130);
  const none = buildOperationAttribution({ decomposition: d, behavior: behavior([]) });
  const bucket = (r, id) => r.buckets.find((b) => b.id === id);
  check('归因：行为可用但无命中证据 → 全部归其他，不虚构类型', none.ok === true
    && bucket(none, 'other').count === 2 && near(bucket(none, 'other').money, 130)
    && bucket(none, 'rebuy').count === 0, JSON.stringify(none.buckets));

  const unavailable = buildOperationAttribution({ decomposition: d, behavior: { available: false, reason: '行为发现失败' } });
  check('归因：行为不可用 → ok=false 且不分类', unavailable.ok === false && /行为发现失败/.test(unavailable.reason), JSON.stringify(unavailable));
}

/* ==== ④ 分解阻断或加总不一致：不展示 ==== */
{
  const d = decomposition([item('S1', 100)], 100, { blocked: true });
  const blocked = buildOperationAttribution({ decomposition: d, behavior: behavior([rebuy('S1')]) });
  check('归因：逐笔分解阻断 → ok=false', blocked.ok === false && /校验/.test(blocked.reason), JSON.stringify(blocked));

  const broken = decomposition([item('S1', 100)], 130);
  broken.checks.sum_equals_total = false;
  const mismatch = buildOperationAttribution({ decomposition: broken, behavior: behavior([rebuy('S1')]) });
  check('归因：加总与总额不一致 → ok=false', mismatch.ok === false && /不一致/.test(mismatch.reason), JSON.stringify(mismatch));

  const missing = buildOperationAttribution({ decomposition: null, behavior: behavior([]) });
  check('归因：缺少逐笔分解 → ok=false', missing.ok === false, JSON.stringify(missing));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
