// 独立问答页的意图层：归一化 → L1 确定性规则 →（未命中才）L2 在线意图。
// 只处理问题文本；不读取账单、不加载报告、不发起除注入 classifier 以外的请求。
import { QA_CHIPS } from '../../src/agent/qaChips.js';
import { classifyOffline } from '../../src/agent/offlineIntent.js';
import { isSupportedChatQuestion } from '../../src/agent/chatScope.js';
import { isPageHelpQuestion, buildPageHelpAnswer } from '../../src/agent/pageHelp.js';
import { REFUSAL_PATTERN } from '../../src/agent/scopeRouter.js';

export { isPageHelpQuestion, buildPageHelpAnswer };

export const MIN_L2_CONFIDENCE = 0.5;
export const QA_QUESTION_MAX = 200;

export const QA_SUGGESTIONS = Object.freeze([
  ...QA_CHIPS.map((chip) => Object.freeze({
    id: chip.id,
    intent: chip.intent,
    label: chip.label,
    question: chip.question,
    online: false,
  })),
  Object.freeze({ id: 'what_if', intent: 'what_if', label: '如果没卖', question: '如果那笔卖出没发生，会怎样？', online: false }),
  Object.freeze({ id: 'meta_calc', intent: 'meta_calc', label: '怎么算的', question: '这些数字是怎么算出来的？', online: false }),
  Object.freeze({ id: 'contract_status', intent: 'contract_status', label: '规则状态', question: '我的规则守得住吗？', online: false }),
  Object.freeze({ id: 'similar_context', intent: 'similar_context', label: '相似情境', question: '这份账单里有没有类似的情况？', online: false }),
  Object.freeze({ id: 'cross_bill', intent: 'cross_bill', label: '跨账单看看', question: '我在其他账单里有没有类似的操作？', online: false }),
]);

export const QA_INTENT_LABELS = Object.freeze({
  worst_trade: '最错一笔',
  best_trade: '最赚一笔',
  loss_overview: '组合表现',
  pattern_explain: '追高解释',
  profile: '行为画像',
  what_if: '如果没卖',
  similar_context: '相似情境',
  cross_bill: '跨账单',
  how_to_change: '怎么改',
  contract_setup: '设置规则',
  contract_status: '规则状态',
  meta_calc: '怎么算的',
  meta_trust: '可信度',
  out_of_scope: '超出回答范围',
  product_help: '页面帮助',
  general_finance: '概念说明',
  small_talk: '寒暄',
  unrelated: '范围外问题',
});

export const QA_LAYER_LABELS = Object.freeze({
  L1: '本地规则',
  L2: '在线意图',
  L3: '边界',
});

const TRAILING_PUNCT = /[？?。.!！…，,、;；：:]+$/u;
const DATE_PATTERN = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/u;
const SYMBOL_PATTERN = /(?:^|[^\d])(\d{6})(?!\d)/u;

export function normalizeQuestion(raw) {
  const text = String(raw ?? '')
    .replace(/\u3000/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, QA_QUESTION_MAX)
    .trim();
  return text.replace(TRAILING_PUNCT, '').trim();
}

function normalizedKey(value) {
  return String(value ?? '').replace(/\s+/gu, '').replace(TRAILING_PUNCT, '');
}

function chipIntentOf(question) {
  const key = normalizedKey(question);
  if (!key) return null;
  const chip = QA_SUGGESTIONS.find((item) => normalizedKey(item.question) === key);
  if (chip) return { intent: chip.intent, chipId: chip.id };
  const offline = classifyOffline(`${question}？`);
  if (offline.intent !== 'out_of_scope') return { intent: offline.intent, chipId: null };
  return null;
}

export { chipIntentOf };

const L1_RULES = Object.freeze([
  {
    intent: 'out_of_scope',
    test: REFUSAL_PATTERN,
  },
  {
    intent: 'contract_setup',
    test: /(止损|止盈|帮我定|定个|立规矩|设提醒|设个规则|定规则|仓位建议|帮我设)/u,
    // 提到止损/止盈但问的是既有规则的状态时，交给 contract_status，不当作新建规则。
    exclude: /(?:规则|止损|止盈|提醒|规矩).*(?:守得住|守住|生效|有效|被触发|触发过|触发了|触发几次|触发了几次|违反|状态|表现)/u,
  },
  {
    intent: 'what_if',
    test: /(如果|要是|假如|倘若).*(没卖|没买|没发生|不卖|不买|没有卖|没有买|卖出|买入)|反事实/u,
  },
  {
    intent: 'contract_status',
    test: /(规则.*(守|触发|违反|状态|生效|命中|提醒)|守约|规则表现)/u,
  },
  {
    intent: 'cross_bill',
    test: /(跨账单|跨.*账单|所有账单|多份账单|历史账单|以前的账单|之前的账单|其他账单|每份账单|各个账单|我上传过.*账单|换.*账单.*看)/u,
  },
  {
    intent: 'meta_calc',
    test: /(怎么算|如何算|怎么计算|如何计算|口径|公式|计算路径|数字.*(来源|怎么来))/u,
  },
  {
    intent: 'meta_trust',
    test: /(可信|靠谱|准确|复核|验证|对不对|有没有错|算错)/u,
  },
  {
    intent: 'how_to_change',
    test: /(怎么改|如何改|怎么避免|如何避免|下次不再|改进|怎么才能|如何能|下次.*不)/u,
  },
  {
    intent: 'pattern_explain',
    test: /(追高|追涨|买在高点|高点买入|总买在高位)/u,
  },
  {
    intent: 'profile',
    test: /(我是谁|我的风格|交易风格|画像|我的习惯|性格|我是什么样)/u,
  },
  {
    intent: 'best_trade',
    test: /(获利最高|赚得最多|赚最多|盈利最多|收益最高|最赚|最成功|赚得最好|最好的一笔)/u,
  },
  {
    intent: 'worst_trade',
    test: /(最错|最伤|最亏|最差|亏损最大|亏最多|亏得最多|哪笔亏|最失败|最糟|代价最高)/u,
  },
  {
    intent: 'loss_overview',
    test: /(组合|整体|账户|持仓|总体).*(表现|收益|盈亏|亏损|盈利|赚|亏|情况)|^(收益|盈亏|亏损|赚了|亏了|表现).*(怎么样|如何|多少|情况)/u,
  },
  {
    intent: 'similar_context',
    test: /(类似|相似|历史上|以前.*(情况|时候)|过往.*情况|同类型)/u,
  },
]);

export function extractSlots(question) {
  const text = normalizeQuestion(question);
  const slots = {};
  const symbol = text.match(SYMBOL_PATTERN);
  if (symbol) slots.symbol = symbol[1];
  const date = text.match(DATE_PATTERN);
  if (date) {
    const month = String(Number(date[2])).padStart(2, '0');
    const day = String(Number(date[3])).padStart(2, '0');
    slots.trade_date = `${date[1]}-${month}-${day}`;
  }
  return slots;
}

export function routeQuestion(raw) {
  const question = normalizeQuestion(raw);
  if (!question) return { intent: null, slots: {}, ambiguous: true, layer: 'L1', source: 'L1', confidence: null };
  const chip = chipIntentOf(question);
  if (chip) {
    const slots = extractSlots(question);
    const result = {
      intent: chip.intent,
      slots,
      layer: 'L1',
      source: 'L1',
      confidence: 1,
      matchedBy: 'chip',
      chip_id: chip.chipId,
    };
    if (result.intent === 'what_if' && !slots.symbol && !slots.trade_date && /(那笔|这笔|那次|这次)/u.test(question)) {
      result.ambiguousTrade = true;
    }
    return result;
  }
  const slots = extractSlots(question);
  for (const rule of L1_RULES) {
    if (rule.exclude && rule.exclude.test(question)) continue;
    if (rule.test.test(question)) {
      const result = {
        intent: rule.intent,
        slots,
        layer: 'L1',
        source: 'L1',
        confidence: 1,
        matchedBy: 'rule',
      };
      if (rule.intent === 'what_if' && !slots.symbol && !slots.trade_date && /(那笔|这笔|那次|这次)/u.test(question)) {
        result.ambiguousTrade = true;
      }
      return result;
    }
  }
  if (isSupportedChatQuestion(question)) {
    return { intent: 'loss_overview', slots, layer: 'L1', source: 'L1', confidence: 1, matchedBy: 'scope' };
  }
  return { intent: null, slots, ambiguous: true, layer: 'L3', source: 'L3', confidence: null };
}

/* 自由输入在模型不可用/不采用时的本地兜底；芯片文本同样可在这里命中。 */
export function classifyLocal(raw) {
  return routeQuestion(raw);
}

function normalizeL2Slots(raw) {  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  if (typeof raw.symbol === 'string' && /^\d{6}$/u.test(raw.symbol)) out.symbol = raw.symbol;
  if (typeof raw.trade_date === 'string') {
    const date = raw.trade_date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);
    if (date) out.trade_date = `${date[1]}-${String(Number(date[2])).padStart(2, '0')}-${String(Number(date[3])).padStart(2, '0')}`;
  }
  return out;
}

export function createIntentRouter({ classifyIntent = null } = {}) {
  async function route(raw) {
    const question = normalizeQuestion(raw);
    const local = routeQuestion(question);
    if (local.intent || !classifyIntent) return local;
    let result;
    try {
      result = await classifyIntent({ question });
    } catch {
      result = null;
    }
    // onlineBoundary 成功时把意图放在 data.intentJson；兼容注入方的扁平形状。
    const intentJson = result?.intentJson ?? result?.data?.intentJson ?? null;
    if (!result?.ok || !intentJson) {
      return {
        ...local,
        layer: 'L2',
        source: 'L2',
        ambiguous: true,
        notice: '这次没能理解问法：问题文本未能匹配，账单与事实没有发送。',
      };
    }
    const { intent, confidence } = intentJson;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)
      || confidence < MIN_L2_CONFIDENCE || confidence > 1) {
      return {
        ...local,
        layer: 'L2',
        source: 'L2',
        confidence: Number.isFinite(confidence) ? confidence : null,
        ambiguous: true,
        notice: '这次没能确定你的问法，没有据此猜测；账单与事实没有发送。',
      };
    }
    if (!Object.prototype.hasOwnProperty.call(QA_INTENT_LABELS, intent)) {
      return {
        ...local,
        layer: 'L2',
        source: 'L2',
        confidence,
        ambiguous: true,
        notice: '这个问题不在支持范围，没有据此回答；账单与事实没有发送。',
      };
    }
    const slots = { ...normalizeL2Slots(intentJson.slots), ...local.slots };
    const routed = {
      intent,
      slots,
      layer: 'L2',
      source: 'L2',
      confidence,
      matchedBy: 'online',
    };
    if (intent === 'what_if' && !slots.symbol && !slots.trade_date && /(那笔|这笔|那次|这次)/u.test(question)) {
      routed.ambiguousTrade = true;
    }
    return routed;
  }

  return Object.freeze({ route });
}
