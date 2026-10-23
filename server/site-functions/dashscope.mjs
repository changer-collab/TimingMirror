// 站点 Function 的旧 DashScope transport（保留供人工回滚；当前入口优先 DeepSeek）。
// 固定北京地域、qwen-plus、JSON mode/非思考；超时按单次上游调用配置。
// 不记录 question/facts/rawText/API Key；不向调用方回传供应商原始正文。
import { BEHAVIOR_CANDIDATE } from './behaviorAnalysis.mjs';

export const DASHSCOPE_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
export const DASHSCOPE_MULTIMODAL_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const DASHSCOPE_VISION_MODEL = 'qwen3-vl-plus';

const INTENTS = [
  'worst_trade', 'loss_overview', 'pattern_explain', 'profile', 'what_if', 'similar_context',
  'how_to_change', 'contract_setup', 'contract_status', 'meta_calc', 'meta_trust', 'out_of_scope',
];

const INTENT_SYSTEM = [
  '你是 TimingMirror 的意图分类器。只判断用户问题属于哪一类，不回答、不解释、不提供投资建议。',
  `intent 必须严格属于：${INTENTS.join(', ')}。`,
  '类别定义（按提问目的判断，不要求出现关键词）：',
  '- worst_trade：哪一笔交易相对持有到估值日代价最大、最让人后悔或亏损最大。',
  '- loss_overview：整份账单或组合的整体表现、实际收益、对照收益、择时损耗。',
  '- pattern_explain：解释这份账单里某种重复交易行为为什么被标记，例如追高、卖出后很快买回、买入后很快卖出、交易频繁；用户可能用“总在同一个地方栽跟头”“手痒”“拿不住”等口语。',
  '- profile：想了解自己的交易习惯、风格或“我是谁”；只描述本账单可验证的行为。',
  '- what_if：对已经发生的某笔交易做反事实假设，例如“如果当时没卖会怎样”。',
  '- similar_context：寻找历史相似情境、过去类似情况或跨账单比较。',
  '- how_to_change：寻求如何改变习惯、下次怎么约束自己、怎么改规则。',
  '- contract_setup：要求建立、设置或定义一条个人交易规则，例如止损、涨跌幅提醒、买回提醒。',
  '- contract_status：询问已设定的规则是否生效、是否被遵守、触发过几次。',
  '- meta_calc：询问数字的计算口径、公式或数据来源。',
  '- meta_trust：询问数字是否可信、会不会算错、有没有经过校验。',
  '- out_of_scope：荐股、预测涨跌或点位、让模型替用户决定买卖、与这份账单无关的通用投资知识。',
  '判定规则：',
  '1. 先判断是否越界；out_of_scope 优先于其他类别。',
  '2. 解释“为什么会被标记/为什么我总是……”归 pattern_explain；“我该怎么改/下次怎么办/如何避免”归 how_to_change。',
  '3. 提到设置规则、阈值、提醒、止损线归 contract_setup；问规则是否生效、是否守住、触发几次归 contract_status。',
  '4. 问数字怎么算、从哪来归 meta_calc；问准不准、可不可信归 meta_trust。',
  '5. 模糊问法按最接近的提问目的归类；实在无法判断时 confidence 低于 0.5，不要猜一个高置信度。',
  'slots 只能包含 symbol 和 trade_date，不要输出任何其他槽位（如 pattern、reason、amount）。',
  '- symbol：问题中明确出现的 6 位股票代码，字符串并保留前导零；没有就省略。',
  '- trade_date：问题中明确出现的日期，规范为 YYYY-MM-DD（月、日补零）；没有就省略，不要猜年份。',
  '只输出 JSON 对象：{"intent":"...","slots":{},"confidence":0.0}；不要输出 Markdown、解释或额外字段。',
  '示例：',
  '问：我最错的一笔是哪个？ → {"intent":"worst_trade","slots":{},"confidence":0.98}',
  '问：帮我看看整体收益怎么样 → {"intent":"loss_overview","slots":{},"confidence":0.95}',
  '问：我是不是老在同一个地方栽跟头 → {"intent":"pattern_explain","slots":{},"confidence":0.72}',
  '问：我总是拿不住，刚买就卖 → {"intent":"pattern_explain","slots":{},"confidence":0.9}',
  '问：怎么才能不手痒 → {"intent":"how_to_change","slots":{},"confidence":0.9}',
  '问：帮我设个提醒，买入后三天内卖出就提示我 → {"intent":"contract_setup","slots":{},"confidence":0.95}',
  '问：给我加一条买入前的提醒规则 → {"intent":"contract_setup","slots":{},"confidence":0.9}',
  '问：我设的规则还生效吗 → {"intent":"contract_status","slots":{},"confidence":0.95}',
  '问：我的提醒最近触发过几次 → {"intent":"contract_status","slots":{},"confidence":0.9}',
  '问：这个损耗是怎么算出来的 → {"intent":"meta_calc","slots":{},"confidence":0.95}',
  '问：这些数字靠谱吗 → {"intent":"meta_trust","slots":{},"confidence":0.9}',
  '问：2024-9-3 如果没卖 000001 会怎样 → {"intent":"what_if","slots":{"trade_date":"2024-09-03","symbol":"000001"},"confidence":0.95}',
  '问：历史上类似的情况多吗 → {"intent":"similar_context","slots":{},"confidence":0.9}',
  '问：明天买什么能涨 → {"intent":"out_of_scope","slots":{},"confidence":0.99}',
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

const CUSTOM_RULE_JUDGMENT_SYSTEM = [
  '你是 TimingMirror 的自定义规则情境判定器。用户消息是 JSON：{"rule":{...},"scenario":{...},"data":{...}}。',
  'rule.text 是用户确认过的自定义交易规则原文；你的任务是把这条规则与本次情境提供的数据对照，给出辅助判定，供程序展示给用户。',
  '只能使用输入中的 rule/scenario/data；不得引入输入中没有的数字、日期、标的、持仓、行情或交易记录，不得编造数据。',
  'data 里的买入/卖出日期与交易日历是当前账单中可见的记录，不保证完整；若规则需要账单里看不到的数据（如持仓、盈亏、盘中价格、成交量），或无法确认数据足够，verdict 必须为 “unable”，并在 reason 中说明缺什么。',
  'rule.action 表示申报买入（buy）或申报卖出（sell）时提醒；scenario.action 是本次模拟的申报动作。规则限定范围外的情境不属于本次判定。',
  '判定只用于提醒，不下单、不阻止交易；不得预测收益或涨跌，不得推荐买入/卖出，不得建议保存或修改规则。',
  '输出 JSON 对象：{"verdict":"triggered|not_triggered|unable","reason":"...","used_data":[]}。',
  'verdict=triggered 表示按规则原文与给定数据该情境应提醒；not_triggered 表示数据足够且明确不满足提醒条件；无法确认时一律用 unable。',
  'used_data 只能取 change_pct、buys、sells、calendar 的子集，列出你实际用到的数据；无法判定时可为空数组。',
  'reason 使用简体中文，不超过 600 字，说明判断依据；不要输出 Markdown、代码块、URL、文件名或额外字段。',
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

const BEHAVIOR_ANALYSIS_SYSTEM = [
  '你是 TimingMirror 的行为分析器。用户消息是脱敏后的行为事实 JSON，不含股票代码、价格、金额、日期或文件名。',
  '确定性引擎已经算出 chase_high_buy 的三态、sample_n、evaluated_n 与证据索引；你必须原样复述，不得改写、补算、四舍五入或编造。',
  '只输出 JSON 对象：{"patterns":[{"pattern_id":"chase_high_buy","status":"成立|不成立|证据不足","sample_n":0,"evaluated_n":0,"evidence_event_indexes":[],"comment":""}],"observations":[],"rule_candidates":[]}。',
  'patterns 必须恰好一条，字段与事实完全一致；comment 用简体中文，不超过 80 字，只描述事实，不预测、不荐股、不承诺收益、不给出买卖指令。',
  'observations 只能使用 sell_rebuy_within_2d 或 overtrading；每项为 {"observation_id":"...","text":"...","evidence_event_indexes":[...]}；必须引用 events 中真实索引；没有就 []。',
  '只有 facts.trading.sell_rebuy_within_2d_count ≥ 1 时才可输出 sell_rebuy_within_2d；只有 facts.trading.sell_after_buy_count ≥ 4 时才可输出 overtrading。',
  'rule_candidates 必须原样复制 facts.allowed_rule_candidates：数组长度、顺序、candidate_id、template_id 都必须完全一致；不要新增、漏掉或改写，也不要自行补充 fields、reason 或阈值。',
  'facts.allowed_rule_candidates 为空时，rule_candidates 必须为 []。',
  `示例：allowed_rule_candidates 为 [{"candidate_id":"${BEHAVIOR_CANDIDATE.candidate_id}","template_id":"${BEHAVIOR_CANDIDATE.template_id}"}] 时，rule_candidates 返回同一数组；patterns[0].status 不为“成立”时返回 []。`,
  '不要输出 Markdown、代码块、网址或额外字段。',
].join('\n');

export const RULE_NEED_CODES = Object.freeze([
  'trade_pnl', 'sell_action', 'sell_restriction', 'pause_trading', 'position_size', 'account_funds', 'intraday_price', 'volume',
  'technical_indicator', 'price_drop', 'fundamentals', 'specific_symbol', 'multi_symbol', 'scope_exclude', 'trade_frequency',
  'auto_execution', 'compound_condition', 'calendar_days', 'other',
]);// 只做意图识别：把用户的一句话映射到既有规则模板或说明缺口；是否合法、能否执行由浏览器端程序确定性校验。
const RULE_SYSTEM = [
  '你是 TimingMirror 交易规则的意图识别器，只负责理解用户用一句话描述的个人交易规则，不执行、不生成代码、不提供投资建议。',
  '系统目前只有三个可执行的规则模板：',
  '1. no_buy_on_surge（提醒动作：申报买入）：申报买入当天该股票涨幅超过 threshold_pct%（严格大于）时提醒不要买入。参数 threshold_pct 为百分数数值（例如 5 表示 5%）。',
  '2. no_buy_back_within（提醒动作：申报买入）：卖出某只股票后 days 个交易日内又买回同一只股票时提醒。参数 days 为正整数。',
  '3. sell_within_after_buy（提醒动作：申报卖出）：买入某只股票后 days 个交易日内卖出同一只股票时提醒。参数 days 为正整数；只提醒，不阻止卖出。',
  '适用范围 scope：默认对所有股票生效，{"kind":"all","symbol":null}；只有原文明确写出一个 6 位数字股票代码并表示只针对它时，才为 {"kind":"symbol","symbol":"该 6 位代码（字符串，保留前导零）"}。',
  '提醒动作 action：指”用户准备执行什么操作时需要提醒”。买入提醒（buy）＝申报买入时提醒；卖出提醒（sell）＝申报卖出时提醒；两者都适用时为 “both”。',
  '判断规则：',
  '- 只有当用户描述与某个模板语义完全一致、且不含模板无法表达的额外条件时，status 才为 “template”。',
  '- 能理解但不能完整映射到模板的单条规则（包括需要其他数据或多个条件），返回 custom，保留全部条件；不能将其截取成模板规则。custom 仅保存，不表示当前可执行。',
  '- 多个股票代码、排除股票或一句话包含多条独立规则且范围无法用 all 或 symbol 表达时，返回 unsupported，并在 needs 中列出原因。',
  '- 只用股票名称、简称、板块、行业或类别限定时，不得推断或补全股票代码，status 为 “unsupported”，needs 含 specific_symbol。',
  '- 若描述能对应某个模板但缺少具体数字、或意思含糊，status 为 “unclear”，在 missing 中列出缺少的项；不得自行假设默认值。',
  '- 若描述无法匹配任何模板，但你能理解用户的规则意图（例如自定义的交易纪律、提醒条件），status 为 “custom”，kind 为 “custom”，template_id 为 null，并在 action 中给出你识别的提醒动作（buy/sell/both/无法确定时留空）。',
  '- threshold_pct、days 只能取用户原文中明确写出的数字；comparator：”超过/高于/大于”为 “gt”，”达到/不低于/及以上”为 “gte”。',
  '- day_unit：原文写”交易日”为 “trading_day”，写”自然日/日历日/周/月”为 “calendar_day”，只写”天/日”为 “unspecified”。',
  '- 买入后卖出提醒必须明确”同一只股票 / 这只股票”或以单个 6 位代码限定；不能把”买入”和”卖出”分开当成其他模板。',
  `needs 代码只能取：${RULE_NEED_CODES.join(', ')}。`,
  'missing 代码只能取：threshold_pct, days, days_sell, same_symbol, condition, action。',
  '只输出标准 JSON 对象，示例：{"status":"custom","kind":"custom","template_id":null,"params":{},"scope":{"kind":"all","symbol":null},"action":"buy","needs":[],"missing":[],"understanding":"买入前检查用户条件"}。status 可为 template、custom、unsupported 或 unclear；action 可为 buy、sell、both 或 null。',
  'understanding 用简体中文、不超过 60 字，复述你对用户规则的理解；不要输出 Markdown、解释或额外字段。',
  'status 为 “custom” 时：kind 必须为 “custom”，template_id 必须为 null，params 为空对象，action 为你识别的提醒动作（无法确定时留空）。',
].join('\n');

const PROFILE_SUMMARY_SYSTEM = [
  '你是 TimingMirror 的画像解读助手。输入是一份 JSON 画像摘要，包含确定性统计和用户明确陈述的目标/偏好/约束。',
  '任务：用简体中文写一段容易理解的分析，帮用户看懂自己的择时行为。只做解释，不预测后市，不推荐股票，不承诺收益。',
  '硬性要求：',
  '- 只能引用输入中出现的数字、日期、标签和事实；不得自行计算或编造新的数字、日期、股票代码或金额。',
  '- 不评价人格，不使用“你总是/你一定/必然”等绝对化表述；区分“数据显示”和“可能”。',
  '- headline 不超过 24 字；summary 不超过 240 字。',
  '- strengths、blind_spots、next_actions 各 0-3 条，每条不超过 60 字；next_actions 只写可执行的行为提醒，不写买卖建议。',
  '- data_limits 0-3 条，每条不超过 80 字，说明样本量、缺失数据或推断边界。',
  '- confidence 只能取 low、medium、high；账单少于 3 份或交易少于 20 笔时不得高于 medium。',
  '- 只输出 JSON 对象，不要 Markdown、解释或额外字段。字段固定为：schema_version（必须为 1）、headline、summary、strengths、blind_spots、next_actions、confidence、data_limits。',
].join('\n');

const PROFILE_FACT_SYSTEM = [
  '你是 TimingMirror 的画像事实抽取器。输入是一条用户在问答页发送的消息。',
  '只抽取用户明确陈述的、与投资或交易有关的长期目标、偏好、约束、自述习惯或风险承受度。',
  '不得抽取：提问、假设、举例、引用他人、否定句、一次性的交易计划、具体持仓或金额、情绪化表达、对助手的指令。',
  '每条事实的规则：',
  '- kind 只能是 goal、preference、constraint、habit、risk_tolerance 之一。',
  '- key 为英文小写 slug，例如 drawdown_limit。',
  '- value 为不超过 240 字节的中文概括，不得包含账号、手机号、身份证、密码等敏感信息。',
  '- evidence 必须是用户原话中逐字连续的一段（不超过 120 字），不得改写、拼接或补全。',
  '如果没有符合条件的内容，输出 {"facts":[]}。最多 3 条，按确定性从高到低排列。',
  '只输出 JSON 对象，字段固定为 {"facts":[{"kind":"...","key":"...","value":"...","evidence":"..."}]}，不要 Markdown 或解释。',
].join('\n');

export const MODEL_PROMPTS = Object.freeze({
  intent: INTENT_SYSTEM,
  restate: RESTATE_SYSTEM,
  ruleIntent: RULE_INTENT_SYSTEM,
  behaviorAnalysis: BEHAVIOR_ANALYSIS_SYSTEM,
  resultExplanation: RESULT_EXPLANATION_SYSTEM,
  scenarioJudgment: SCENARIO_JUDGMENT_SYSTEM,
  customRuleJudgment: CUSTOM_RULE_JUDGMENT_SYSTEM,
  importRecover: IMPORT_RECOVER_SYSTEM,
  importVisionSystem: IMPORT_VISION_SYSTEM,
  importVisionUser: IMPORT_VISION_USER_TEXT,
  rule: RULE_SYSTEM,
  profileSummary: PROFILE_SUMMARY_SYSTEM,
  profileFact: PROFILE_FACT_SYSTEM,
});

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
    behaviorAnalysis({ facts }) {
      return call([
        { role: 'system', content: BEHAVIOR_ANALYSIS_SYSTEM },
        { role: 'user', content: JSON.stringify(facts) },
      ], { temperature: 0.1 });
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
    customRuleJudgment({ rule, scenario, data }) {
      return call([
        { role: 'system', content: CUSTOM_RULE_JUDGMENT_SYSTEM },
        { role: 'user', content: JSON.stringify({ rule, scenario, data }) },
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
