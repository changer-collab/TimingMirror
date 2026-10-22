// 站点 Function 的百炼 transport（仅在配置 DASHSCOPE_API_KEY 后由入口构造）。
// 固定北京地域、qwen-plus、JSON mode/非思考；超时按单次上游调用配置。
// 不记录 question/facts/rawText/API Key；不向调用方回传供应商原始正文。
export const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
export const DASHSCOPE_MULTIMODAL_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const DASHSCOPE_VISION_MODEL = 'qwen3-vl-plus';

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

const RESULT_EXPLANATION_SYSTEM = [
  '你是 TimingMirror 的结果解释器。用户消息是 JSON：{"rule":{...},"simulation":{...}}。',
  '只能解释给定规则在给定模拟中的结果，不得引入输入中没有的新数字、日期、标的或事实。',
  '不得预测收益或涨跌，不得推荐买入/卖出，不得做组合、总收益或下一步操作结论。',
  '只说明本次执行是否完成、命中/未命中以及逐项 verdict/code/message 的含义；不声称独立复核。',
  '输出 JSON 对象：{"answer_text":"..."}。',
  'answer_text 使用简体中文，简洁；不要输出 Markdown、代码块、URL、文件名或额外字段。',
].join('\n');

const SCENARIO_JUDGMENT_SYSTEM = [
  '你是 TimingMirror 的模拟情景判断器。用户消息是 JSON：{"scenario":{...}}。',
  '后端确定性规则已经判定：scenario.rules 中没有任何一条规则命中；你只能解释当前情景为什么没有匹配任何已锁定规则。',
  '不得声称任何规则命中，不得创建、修改或建议保存规则，不得预测收益或涨跌，不得推荐买入/卖出，不得做组合或总收益结论。',
  '只能使用输入中的情景事实、规则模板/参数/版本和逐项 verdict；不得引入输入中没有的数字、日期、标的或规则。',
  '如果规则列表为空，说明当前没有已锁定规则可供匹配；如果规则数据不足，如实说明缺少什么，不猜测。',
  '输出 JSON 对象：{"judgment":"no_match","answer_text":"..."}。',
  'answer_text 使用简体中文，简洁；不要输出 Markdown、代码块、URL、文件名或额外字段。',
].join('\n');

const RULE_INTENT_SYSTEM = [
  '你是 TimingMirror 的规则理解器。',
  '只允许选择用户消息 allowed_templates 中的模板，不得创建新规则、预测收益或提供买卖建议。',
  '只输出 JSON 对象：{"intent":"contract_setup","confidence":0.0,"template_id":null,"fields":{},"clarify":null,"unsupported":null}。',
  'intent 必须为 contract_setup；confidence 必须在 0 到 1 之间。',
  '如果信息不足或存在歧义，template_id 为 null、fields 为空，clarify 用一句中文说明需要补充什么。',
  '如果用户要求的是未提供的规则或未定义能力，clarify 为 null、unsupported 用一句中文说明当前不支持。',
  '不要输出解释、Markdown 或额外字段；不要自行补默认阈值。',
].join('\n');

const IMPORT_RECOVER_SYSTEM = [
  '你是 TimingMirror 的账单识别器。只把用户提供的文字整理成交易明细，不猜测、不补默认值。',
  '输入可能来自 CSV、TSV、Excel 提取文字、PDF 文本层或用户粘贴文字。',
  '只输出 JSON 对象：{"trades":[{"date":null,"symbol":null,"side":null,"price":null,"quantity":null,"fee":null,"tax":null,"confidence":0.0,"issues":[]}],"unresolved":[{"row":null,"reason":""}]}。',
  '每一条 trade 必须是一笔真实的买入或卖出；余额、可用资金、总资产、合计、持仓汇总、行情价格都不是交易，不得写入 trades。',
  'date 必须为 YYYY-MM-DD；symbol 为 6 位数字代码并保留前导零；side 只能是“买入”或“卖出”；price、quantity、fee、tax 用原始数字字符串。',
  '无法确定的字段填 null，并在 issues 中说明；不要四舍五入、不要拆分或合并交易、不要套用默认方向或默认数量。',
  'unresolved 只记录无法可靠整理的片段，原因用一句中文；没有内容就填 []。',
  'confidence 为 0 到 1；不确定时降低 confidence。不要输出解释、Markdown 或额外字段。',
].join('\n');

const IMPORT_VISION_SYSTEM = [
  '你是 TimingMirror 的账单识别器。输入是用户截图或本地渲染的扫描版 PDF 页面图片。',
  '只把图片中的真实买入/卖出交易整理成明细；余额、可用资金、总资产、合计、持仓汇总、行情数字都不是交易，不得写入 trades。',
  '只输出 JSON 对象：{"trades":[{"date":null,"symbol":null,"side":null,"price":null,"quantity":null,"fee":null,"tax":null,"confidence":0.0,"issues":[]}],"unresolved":[{"row":null,"reason":""}]}。',
  'date 必须为 YYYY-MM-DD；symbol 为 6 位数字代码并保留前导零；side 只能是“买入”或“卖出”；price、quantity、fee、tax 用原始数字字符串。',
  '无法确定的字段填 null，并在 issues 中说明；不猜测、不补默认值、不四舍五入、不拆分或合并交易。',
  'unresolved 只记录无法可靠整理的片段，原因用一句中文；没有内容就填 []。',
  'confidence 为 0 到 1；不确定时降低 confidence。不要输出解释、Markdown、代码块或额外字段。',
].join('\n');

const IMPORT_VISION_USER_TEXT = '请识别这些页面中的交易明细，并按系统要求返回 JSON。无法确定的内容留空并写入 unresolved，不要猜测。';

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
  visionModel = DASHSCOPE_VISION_MODEL,
  region = 'cn-beijing',
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey 必须为非空字符串');
  }
  if (region !== 'cn-beijing') throw new TypeError('当前仅支持 cn-beijing');
  if (typeof visionModel !== 'string' || visionModel.trim() === '') throw new TypeError('visionModel 必须为非空字符串');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正整数');

  async function request(endpoint, body, extract) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
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
      const rawText = extract(payload);
      if (typeof rawText !== 'string' || rawText.trim() === '') {
        throw fail('E_MODEL_RESPONSE_INVALID');
      }
      return { rawText };
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

  function textFromPayload(payload) {
    return payload?.output?.choices?.[0]?.message?.content ?? payload?.output?.text;
  }

  function visionTextFromPayload(payload) {
    const content = payload?.output?.choices?.[0]?.message?.content ?? payload?.output?.text;
    const text = Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : ''))).join('')
      : content;
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
  }

  function call(messages, overrides = {}) {
    return request(DASHSCOPE_ENDPOINT, {
      model,
      input: { messages },
      parameters: {
        result_format: 'message',
        enable_thinking: false,
        response_format: { type: 'json_object' },
        ...overrides,
      },
    }, textFromPayload);
  }

  function callVision(images) {
    const content = [
      ...images.map((image) => ({ image: `data:${image.mime};base64,${image.data_base64}` })),
      { text: IMPORT_VISION_USER_TEXT },
    ];
    return request(DASHSCOPE_MULTIMODAL_ENDPOINT, {
      model: visionModel,
      input: {
        messages: [
          { role: 'system', content: IMPORT_VISION_SYSTEM },
          { role: 'user', content },
        ],
      },
      parameters: { result_format: 'message' },
    }, visionTextFromPayload);
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
    ruleIntent({ question, allowed_templates, context_summary }) {
      return call([
        { role: 'system', content: RULE_INTENT_SYSTEM },
        { role: 'user', content: JSON.stringify({ question, allowed_templates, context_summary }) },
      ]);
    },
    resultExplanation({ rule, simulation }) {
      return call([
        { role: 'system', content: RESULT_EXPLANATION_SYSTEM },
        { role: 'user', content: JSON.stringify({ rule, simulation }) },
      ], { temperature: 0.1 });
    },
    scenarioJudgment({ scenario }) {
      return call([
        { role: 'system', content: SCENARIO_JUDGMENT_SYSTEM },
        { role: 'user', content: JSON.stringify({ scenario }) },
      ], { temperature: 0.1 });
    },
    importRecover({ content, source_kind }) {
      return call([
        { role: 'system', content: IMPORT_RECOVER_SYSTEM },
        { role: 'user', content: JSON.stringify({ source_kind, content }) },
      ]);
    },
    vision({ images }) {
      return callVision(images);
    },
    rule({ text }) {
      return call([
        { role: 'system', content: RULE_SYSTEM },
        { role: 'user', content: text },
      ]);
    },
  });
}
