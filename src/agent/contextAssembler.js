// 上下文装配：把账单、报告、规则等已有对象整理成工具参数与发布门槛。
// 边界：不加载行情、不请求网络；报告未载入/未发布时如实标记，不用其他账单补齐。
export const CONTEXT_VERSION = 'context-1';

export const CONTEXT_BOUNDARIES = Object.freeze([
  '只使用当前账单已核对并发布的数字',
  '不跨用户、不读取其他账单',
  '事后对照，不预测涨跌',
]);

export function assembleContext({
  bill = null, bundle = null, versions = [], ruleState = null,
  profile = null, question = '', extras = {},
} = {}) {
  const published = bundle?.status !== 'blocked' && bundle?.review?.portfolio_published === true;
  const demo = bill?.demo === true;
  const trades = Array.isArray(bill?.trades) ? bill.trades : [];
  const report = bundle?.insights?.portfolio?.report ?? null;
  const decomposition = bundle?.insights?.portfolio?.decomposition ?? null;
  const behavior = bundle?.insights?.behavior ?? null;

  const gate = Object.freeze({
    published,
    demo,
    report_status: bundle?.status ?? null,
    bill_context_id: bill?.contextId ?? null,
  });

  const assumptions = [];
  if (bundle?.valuation) assumptions.push('按估值日不复权收盘价计算');
  assumptions.push('未计入费用、税费与分红');

  return {
    version: CONTEXT_VERSION,
    gate,
    boundaries: [...CONTEXT_BOUNDARIES],
    assumptions,
    toolContext: {
      trades,
      report,
      closes: bundle?.closes ?? null,
      market: bundle?.market ?? null,
      decomposition,
      behavior,
      versions,
      ruleState,
      profile,
      question: String(question ?? ''),
      valuation: bundle?.valuation ?? null,
      ...extras,
    },
  };
}

export function contextStillCurrent(bill, assembled) {
  return (bill?.contextId ?? null) === (assembled?.gate?.bill_context_id ?? null);
}
