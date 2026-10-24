// 操作类型归因（候选口径）：把逐笔差额按行为证据归到回补/快进快出/其他三类。
// 边界：金额一律取自逐笔分解，不重算；行为不可用时不做分类；同类只归一次（回补优先）。
import { fmtMoney } from './display.js';

const BUCKET_DEFS = Object.freeze([
  { id: 'rebuy', label: '回补式卖出', hint: '卖出后 2 个交易日内又买回同一只标的' },
  { id: 'quick_flip', label: '快进快出卖出', hint: '买入后 3 个交易日内卖出同一只标的' },
  { id: 'other', label: '其他卖出', hint: '没有命中上述两类行为证据' },
]);

const moneyEqual = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

function idsOfPattern(patterns, patternId, pick) {
  const ids = new Set();
  for (const pattern of patterns) {
    if (pattern?.pattern_id !== patternId) continue;
    for (const row of Array.isArray(pattern.evidence) ? pattern.evidence : []) {
      const id = pick(row);
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function buildOperationAttribution({ decomposition, behavior } = {}) {
  if (!decomposition) return { ok: false, reason: '逐笔分解没有生成：不展示操作类型归因' };
  const total = Number(decomposition.total?.value);
  if (!Number.isFinite(total)) return { ok: false, reason: '逐笔分解缺少总额：不展示操作类型归因' };
  if (decomposition.blocked === true) {
    return { ok: false, reason: '逐笔分解未通过加总或回源校验：不展示操作类型归因' };
  }
  if (behavior?.available !== true || !Array.isArray(behavior?.data?.patterns)) {
    return { ok: false, reason: behavior?.reason || '行为发现没有生成：不强行按操作类型分类' };
  }

  const patterns = behavior.data.patterns;
  const rebuyIds = idsOfPattern(patterns, 'sell_rebuy_within_2d', (row) => row?.prior_trade_id);
  const flipIds = idsOfPattern(patterns, 'quick_flip', (row) => row?.trade_id);

  const buckets = BUCKET_DEFS.map((def) => ({
    ...def, count: 0, money: 0, share: null, trade_ids: [],
  }));
  const byId = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  const items = Array.isArray(decomposition.items) ? decomposition.items : [];
  for (const item of items) {
    const tradeId = item?.trade_id;
    const bucket = rebuyIds.has(tradeId)
      ? byId.get('rebuy')
      : flipIds.has(tradeId) ? byId.get('quick_flip') : byId.get('other');
    bucket.count += 1;
    bucket.money += Number(item?.dragMoney) || 0;
    bucket.trade_ids.push(tradeId);
  }

  const sum = buckets.reduce((acc, bucket) => acc + bucket.money, 0);
  if (decomposition.checks?.sum_equals_total === false || !moneyEqual(sum, total)) {
    return { ok: false, reason: '操作类型归因加总与逐笔分解不一致：不展示' };
  }

  for (const bucket of buckets) {
    bucket.share = total === 0 ? null : bucket.money / total;
    bucket.display = {
      money: fmtMoney(bucket.money),
      share: bucket.share === null ? '—' : `${(bucket.share * 100).toFixed(1)}%`,
    };
  }

  return {
    ok: true,
    total: { value: total, display: decomposition.total?.display ?? fmtMoney(total) },
    buckets,
    basis: '按行为证据归类；金额仍以逐笔分解为准；不是对动机的判断',
  };
}
