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
  '用户消息是 JSON：{"question":"...","facts":[...]}；facts 每项的 display 是唯一允许在回答中出现的数字文本。',
  '必须遵守：',
  '1. 只能引用 facts 中的数字；不得计算、换算、四舍五入、补零，也不得改写正负号、小数位、千分位或单位。',
  '2. 引用某个数值时必须逐字符原样复制该 fact 的 display，不得根据 value 自行拼写。',
  '3. pp 不得写成 %、百分数或“个百分点”；% 不得写成 pp；¥ 不得省略或写成“元”。',
  '4. 例如 display 为 "+2.0pp" 就写 "+2.0pp"（不能写 "+2.0%"）；display 为 "¥-2,805.00" 就写 "¥-2,805.00"（不能写 "-2805 元"）；display 为 "+5.4%" 就写 "+5.4%"（不能写 "5.4%"）。',
  '5. 不确定 display 时宁可不引用该数值，也不得凭印象改写。',
  '输出 JSON 对象：{"answer_text":"..."}。',
  'answer_text 使用简体中文，简洁；不要输出 Markdown、代码块或额外字段。',
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

  async function call(messages, overrides = {}) {
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
              ...overrides,
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
      // 低温度只用于降低复述时的格式漂移；数字仍由浏览器端逐项核对。
      return call([
        { role: 'system', content: RESTATE_SYSTEM },
        { role: 'user', content: JSON.stringify({ question, facts }) },
      ], { temperature: 0.1 });
    },
  });
}
