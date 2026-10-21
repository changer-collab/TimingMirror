// 站点 Function 的百炼 transport（仅在配置 DASHSCOPE_API_KEY 后由入口构造）。
// 固定北京地域、qwen-plus、JSON mode/非思考；超时按单次上游调用配置。
// 不记录 question/facts/rawText/API Key；不向调用方回传供应商原始正文。
export const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

const INTENTS = [
  'worst_trade', 'loss_overview', 'pattern_explain', 'profile', 'what_if', 'similar_context',
  'how_to_change', 'contract_setup', 'contract_status', 'meta_calc', 'meta_trust', 'out_of_scope',
];

const INTENT_SYSTEM = [
  '你是 TimingMirror 的意图分类器。',
  `intent 必须严格属于：${INTENTS.join(', ')}。`,
  '只输出 JSON 对象：{"intent":"...","slots":{},"confidence":0.0}。',
  'confidence 必须在 0 到 1 之间；不要输出解释、Markdown 或额外文本。',
].join('\n');

const RESTATE_SYSTEM = [
  '你只做已复核事实的复述。',
  '只能使用用户消息 facts 数组中的数字与展示值，不得生成新数字、外推收益或提供投资建议。',
  '输出 JSON 对象：{"answer_text":"..."}。',
  'answer_text 使用简体中文，简洁；不要输出 Markdown、代码块或额外字段。',
].join('\n');

export const RULE_NEED_CODES = Object.freeze([
  'trade_pnl', 'sell_action', 'sell_restriction', 'pause_trading', 'position_size', 'account_funds', 'intraday_price', 'volume',
  'technical_indicator', 'price_drop', 'fundamentals', 'specific_symbol', 'multi_symbol', 'scope_exclude', 'trade_frequency',
  'auto_execution', 'compound_condition', 'calendar_days', 'other',
]);

// 只做意图识别：把用户的一句话映射到既有规则模板或说明缺口；是否合法、能否执行由浏览器端程序确定性校验。
const RULE_SYSTEM = [
  '你是 TimingMirror 交易规则的意图识别器，只负责理解用户用一句话描述的个人交易规则，不执行、不生成代码、不提供投资建议。',
  '系统目前只有三个可执行的规则模板：',
  '1. no_buy_on_surge（提醒动作：申报买入）：申报买入当天该股票涨幅超过 threshold_pct%（严格大于）时提醒不要买入。参数 threshold_pct 为百分数数值（例如 5 表示 5%）。',
  '2. no_buy_back_within（提醒动作：申报买入）：卖出某只股票后 days 个交易日内又买回同一只股票时提醒。参数 days 为正整数。',
  '3. sell_within_after_buy（提醒动作：申报卖出）：买入某只股票后 days 个交易日内卖出同一只股票时提醒。参数 days 为正整数；只提醒，不阻止卖出。',
  '适用范围 scope：默认对所有股票生效，{"kind":"all","symbol":null}；只有原文明确写出一个 6 位数字股票代码并表示只针对它时，才为 {"kind":"symbol","symbol":"该 6 位代码（字符串，保留前导零）"}。',
  '判断规则：',
  '- 只有当用户描述与某个模板语义完全一致、且不含模板无法表达的额外条件时，status 才为 "template"。',
  '- 若描述需要模板以外的数据或判定能力（含部分超出），status 为 "unsupported"，并在 needs 中列出所需能力代码，不得只截取其中一部分套用模板。',
  '- 含有多个条件（如“并且/同时/或者”、多个数值）、多个股票代码、排除某只股票、或一句话里有多条规则时，同样为 "unsupported"（compound_condition）。',
  '- 只用股票名称、简称、板块、行业或类别限定时，不得推断或补全股票代码，status 为 "unsupported"，needs 含 specific_symbol。',
  '- 若描述能对应某个模板但缺少具体数字、或意思含糊，status 为 "unclear"，在 missing 中列出缺少的项；不得自行假设默认值。',
  '- threshold_pct、days 只能取用户原文中明确写出的数字；comparator：“超过/高于/大于”为 "gt"，“达到/不低于/及以上”为 "gte"。',
  '- day_unit：原文写“交易日”为 "trading_day"，写“自然日/日历日/周/月”为 "calendar_day"，只写“天/日”为 "unspecified"。',
  '- 买入后卖出提醒必须明确“同一只股票 / 这只股票”或以单个 6 位代码限定；不能把“买入”和“卖出”分开当成其他模板。',
  `needs 代码只能取：${RULE_NEED_CODES.join(', ')}。`,
  'missing 代码只能取：threshold_pct, days, days_sell, same_symbol, condition, action。',
  '只输出 JSON 对象：{"status":"template|unsupported|unclear","template_id":"no_buy_on_surge|no_buy_back_within|sell_within_after_buy|null","params":{"threshold_pct":null,"comparator":null,"days":null,"day_unit":null},"scope":{"kind":"all|symbol","symbol":null},"needs":[],"missing":[],"understanding":"..."}。',
  'understanding 用简体中文、不超过 60 字，复述你对用户规则的理解；不要输出 Markdown、解释或额外字段。',
].join('\n');

export class ModelTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ModelTransportError';
    this.code = code;
  }
}

function fail(code) {
  return new ModelTransportError(code);
}

export function createDashScopeTransport({
  apiKey,
  model = 'qwen-plus',
  region = 'cn-beijing',
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey 必须为非空字符串');
  }
  if (region !== 'cn-beijing') throw new TypeError('当前仅支持 cn-beijing');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正整数');

  async function call(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(DASHSCOPE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: { messages },
            parameters: {
              result_format: 'message',
              enable_thinking: false,
              response_format: { type: 'json_object' },
            },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error && error.name === 'AbortError')) {
          throw fail('E_MODEL_TIMEOUT');
        }
        throw fail('E_MODEL_UNAVAILABLE');
      }
      if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean' || !response.ok) {
        throw fail('E_MODEL_UNAVAILABLE');
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || (error && error.name === 'AbortError')) {
          throw fail('E_MODEL_TIMEOUT');
        }
        throw fail('E_MODEL_RESPONSE_INVALID');
      }
      if (controller.signal.aborted) throw fail('E_MODEL_TIMEOUT');
      const content = payload?.output?.choices?.[0]?.message?.content ?? payload?.output?.text;
      if (typeof content !== 'string' || content.trim() === '') {
        throw fail('E_MODEL_RESPONSE_INVALID');
      }
      return { rawText: content };
    } catch (error) {
      if (error instanceof ModelTransportError) throw error;
      if (controller.signal.aborted || (error && error.name === 'AbortError')) {
        throw fail('E_MODEL_TIMEOUT');
      }
      throw fail('E_MODEL_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    intent({ question }) {
      return call([
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: question },
      ]);
    },
    restate({ question, facts }) {
      return call([
        { role: 'system', content: RESTATE_SYSTEM },
        { role: 'user', content: JSON.stringify({ question, facts }) },
      ]);
    },
    rule({ text }) {
      return call([
        { role: 'system', content: RULE_SYSTEM },
        { role: 'user', content: text },
      ]);
    },
  });
}
