// 问答范围判断：先用本地确定性规则把问题分成六类，再决定是否需要意图与账单。
// 纯函数；不读取账单、不调用模型、不发起网络请求。
import { isPageHelpQuestion } from './pageHelp.js';
import { glossaryTermOf } from './glossary.js';

export const SCOPE_KINDS = Object.freeze([
  'bill', 'product_help', 'general_finance', 'small_talk', 'refusal', 'unrelated',
]);

export const SCOPE_LABELS = Object.freeze({
  bill: '账单问题',
  product_help: '产品帮助',
  general_finance: '金融概念',
  small_talk: '寒暄',
  refusal: '越界请求',
  unrelated: '无关任务',
});

// 荐股、预测、代做买卖决定：范围判断先于意图，避免被后续规则改写成事实问题。
export const REFUSAL_PATTERN = /(荐股|推荐.*(股票|标的|基金)|买什么|卖不卖|该买|该卖|能不能买|可以买吗|能买吗|抄底|逃顶|会涨|会跌|会不会涨|会不会跌|涨不涨|跌不跌|预测|目标价|明天买|明天卖|后市|涨停|翻倍)/u;

const CONCEPT_CUE = /(什么是|是什么意思|啥意思|怎么理解|解释一下|讲讲|指的是|定义|含义)/u;

const SMALL_TALK_RE = /^(你好|您好|hi|hello|嗨|哈喽|在吗|在不在|谢谢|多谢|感谢|辛苦了|早上好|中午好|晚上好|晚安|你是谁|你能做什么|你会什么|自我介绍)[\s!！。.，,？?~～]*$/iu;

const UNRELATED_RE = /(天气|气温|下雨|写代码|编程|javascript|python|翻译|作文|笑话|星座|电影|电视剧|旅游|菜谱|做菜|食谱|减肥|医院|感冒|机票|酒店|新闻|汇率|黄金价格)/u;

export function isRefusalQuestion(text) {
  return REFUSAL_PATTERN.test(String(text ?? ''));
}

function billCountOf(bill, explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  return bill ? 1 : 0;
}

export function routeScope({ question = '', bill = null, billCount = null } = {}) {
  const text = String(question ?? '').replace(/\s+/gu, ' ').trim();
  const base = {
    synthetic: bill?.demo === true,
    bill_count: billCountOf(bill, billCount),
  };
  if (!text) return { ...base, kind: 'bill' };
  if (isRefusalQuestion(text)) return { ...base, kind: 'refusal' };
  if (isPageHelpQuestion(text)) return { ...base, kind: 'product_help' };
  if (CONCEPT_CUE.test(text) && glossaryTermOf(text)) return { ...base, kind: 'general_finance' };
  if (SMALL_TALK_RE.test(text)) return { ...base, kind: 'small_talk' };
  if (UNRELATED_RE.test(text)) return { ...base, kind: 'unrelated' };
  return { ...base, kind: 'bill' };
}
