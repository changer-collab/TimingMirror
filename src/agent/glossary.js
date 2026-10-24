// 产品术语词表：页面术语表与问答帮助共用同一份定义，避免两套说法。
// 纯数据与纯函数；不读取账单、不调用模型。
export const QA_GLOSSARY = Object.freeze([
  Object.freeze(['估值日', '计算期末持仓价值时使用的收盘价日期。所选日期不是交易日时按口径使用最近的交易日，并同时显示请求日期与实际使用日期；当天缺价时相应结果不发布，不会改用其他日期。']),
  Object.freeze(['择时损耗', '对照收益（买入后持有不动）减去实际收益。正值表示买卖时机让结果比“持有不动”差，负值表示实际操作更好。']),
  Object.freeze(['反事实', '假设某一笔卖出没有发生、其余交易不变时的结果，用来看这一笔卖出的影响；它不是对未来的预测。']),
  Object.freeze(['阻断', '数据不完整或无法核对时（如账单校验未通过、估值日缺价、复核未通过），对应结论不发布，也不用替代数字或其他日期补上。']),
  Object.freeze(['证据', '每个数字的公式编号、用到的成交（含账单文件行号）和计算步骤，可在报告页“查看证据与计算路径”中逐项核对。']),
]);

const TERMS_BY_LENGTH = [...QA_GLOSSARY].sort((a, b) => b[0].length - a[0].length);

export function glossaryEntry(term) {
  const found = QA_GLOSSARY.find(([key]) => key === term);
  return found ? { term: found[0], definition: found[1] } : null;
}

/* 只在问题里出现已知术语时返回；长术语优先，避免“证据”抢先匹配“证据链”。 */
export function glossaryTermOf(text) {
  const value = String(text ?? '');
  for (const [term, definition] of TERMS_BY_LENGTH) {
    if (value.includes(term)) return { term, definition };
  }
  return null;
}

export function termsInText(text) {
  const value = String(text ?? '');
  return TERMS_BY_LENGTH.filter(([term]) => value.includes(term)).map(([term]) => term);
}
