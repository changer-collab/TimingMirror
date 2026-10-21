// 组合四事实入口的本地范围门禁；新旧前端共用，未支持的问题在出站前拦截。
export const SUPPORTED_CHAT_PATTERNS = Object.freeze([
  /^(请问)?(我的|当前|这个)?(组合|整体|账户|持仓|总体)(的)?(整体)?(表现|实际收益|对照收益|择时损耗|损耗金额|收益|盈亏|亏损|盈利|差距|总览|概况)(如何|怎么样|怎样|是多少|多少|情况如何|情况怎么样)?[？?]?$/,
  /^(组合|整体|账户|持仓|总体)(的)?(实际收益|对照收益|择时损耗|损耗金额|收益|盈亏|亏损|盈利|差距)(如何|怎么样|怎样|是多少|多少)[？?]?$/,
]);

export function isSupportedChatQuestion(question) {
  const normalized = String(question ?? '').trim().replace(/\s+/g, '');
  return normalized !== '' && SUPPORTED_CHAT_PATTERNS.some((re) => re.test(normalized));
}
