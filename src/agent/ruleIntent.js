// 交易规则自然语言识别（候选口径，未冻结）：模型只做意图识别；规则是否合法、能否执行由本模块与契约引擎确定性判定。
// 链路：本地预检 → 同源站点函数 /api/llm/rule（仅 { text }）→ 严格校验模型 JSON → 映射到既有引擎模板 → parseRuleSpec（适用范围：全部股票 / 单个 6 位代码）。
// 出站只含用户输入的规则文本；不发送 CSV、交易记录、账户信息、行情或已保存规则。模型输出不作为代码执行。
// 关键词、连接词与数值检查只是辅助手段，不能保证识别了全部意图；无法确认完整表达时只提示补充或暂不支持，不截取部分启用。
import { CONTRACT_TEMPLATES } from '../engine/contractMatch.js';
import { parseRuleSpec } from '../engine/ruleSpec.js';

export const RULE_INTENT_URL = '/functions/v1/app/api/llm/rule';
export const RULE_TEXT_MAX_CHARS = 200;
export const RULE_INTENT_TIMEOUT_MS = 15000;
// 站点函数在规则响应中回报的协议版本；旧版函数不返回。新增模板须先确认该版本，避免旧服务端 + 新前端静默误解。
export const RULE_INTENT_PROTOCOL = 'rule-intent-v2';

export const RULE_INTENT_CODES = Object.freeze({
  TEXT_EMPTY: 'E_RULE_TEXT_EMPTY',
  TEXT_TOO_LONG: 'E_RULE_TEXT_TOO_LONG',
  TEXT_SENSITIVE: 'E_RULE_TEXT_SENSITIVE',
  TEXT_FORMAT: 'E_RULE_TEXT_FORMAT',
  NETWORK: 'E_RULE_NETWORK',
  TIMEOUT: 'E_RULE_TIMEOUT',
  STATUS: 'E_RULE_SERVICE_STATUS',
  RESPONSE: 'E_RULE_RESPONSE_INVALID',
  JSON: 'E_RULE_JSON_INVALID',
  SCHEMA: 'E_RULE_SCHEMA_INVALID',
});

const C = RULE_INTENT_CODES;

const LOCAL_MESSAGES = Object.freeze({
  [C.TEXT_EMPTY]: '请先用一句话描述你的规则。',
  [C.TEXT_TOO_LONG]: `规则描述最多 ${RULE_TEXT_MAX_CHARS} 个字，请精简为一句话。`,
  [C.TEXT_SENSITIVE]: '描述中含有疑似账号、证件号、手机号或邮箱的内容（8 位以上连续数字或邮箱地址），为避免发送账户信息，未提交识别。股票代码为 6 位，可以保留。',
  [C.TEXT_FORMAT]: '描述看起来像多行表格或账单内容。识别只需要一句规则描述，请不要粘贴 CSV 或交易记录。',
  [C.NETWORK]: '无法连接识别服务（网络异常或站点函数不可达）。',
  [C.TIMEOUT]: '识别服务超时，请稍后重试。',
  [C.RESPONSE]: '识别服务响应格式异常，未生成规则。',
  [C.JSON]: '模型返回的内容不是合法 JSON，未生成规则。',
  [C.SCHEMA]: '模型返回的内容不符合约定格式，未生成规则。',
});

const SERVICE_MESSAGES = Object.freeze({
  E_MODEL_NOT_CONFIGURED: '识别服务未启用：站点函数未读取到 DASHSCOPE_API_KEY（请在站点设置中配置后重新发布函数）。',
  E_MODEL_TIMEOUT: '百炼模型响应超时，请稍后重试。',
  E_MODEL_UNAVAILABLE: '百炼模型服务暂时不可用，请稍后重试。',
  E_MODEL_RESPONSE_INVALID: '百炼模型返回格式异常，请稍后重试。',
  E_FUNCTION_NOT_FOUND: '识别接口不存在：站点函数可能尚未发布包含规则识别（/api/llm/rule）的版本。',
  E_FUNCTION_REQUEST_INVALID: '规则文本未通过服务端校验（不能为空，最多 200 字）。',
  E_FUNCTION_UNKNOWN_FIELD: '请求包含不允许的字段，已被服务端拒绝。',
  E_FUNCTION_BODY_TOO_LARGE: '请求体超过服务端大小限制。',
});

// 模型只能从固定代码中选择“缺少的能力”；展示文本由程序给出，不直接展示模型对能力的描述
export const RULE_NEED_TEXT = Object.freeze({
  trade_pnl: '判定单笔或连续盈亏：当前规则引擎不计算单笔已实现盈亏，亏损口径（成本计算方法、是否计入费用）也未确定。',
  sell_action: '建议卖出（该卖 / 提醒我卖出）：当前只有“买入后 N 个交易日内卖出同一只股票时提醒”，不判断是否应该卖出。',
  sell_restriction: '限制卖出（止损、止盈、不卖 / 别卖）：当前规则只做提醒，不阻止卖出。',
  pause_trading: '暂停交易 / 冷却期：除“卖出后 N 个交易日内不追回同一只股票”外，暂不支持其他暂停条件。',
  position_size: '仓位、金额或股数限制：当前没有按仓位或金额判定的规则模板。',
  account_funds: '账户资金、总资产或持仓市值：系统不读取账户信息。',
  intraday_price: '盘中、分时、开盘价或实时价格：行情只有每日收盘价（非实时）。',
  volume: '成交量、换手率：行情数据只含收盘价，不含成交量。',
  technical_indicator: '均线、MACD 等技术指标：当前规则引擎不计算技术指标。',
  price_drop: '跌幅或下跌条件：当前只支持“当天涨幅超过阈值”的买入提醒。',
  fundamentals: '财报、估值、新闻或行业信息：系统没有这类数据。',
  specific_symbol: '按股票名称、简称、板块或类别限定：系统不根据名称推断股票代码；目前只支持用一个 6 位股票代码限定适用范围（例如“只针对 600519”）。',
  multi_symbol: '同时限定多个股票代码：每条规则只能限定一个 6 位代码，请分别识别、分别保存。',
  scope_exclude: '排除某只股票（如“除了 600519”）：目前只支持“全部股票”或“仅某一个 6 位代码”。',
  trade_frequency: '交易次数或频率限制：当前没有按交易次数判定的规则模板。',
  auto_execution: '自动下单或自动止损：系统只做提醒，不执行交易。',
  compound_condition: '多个条件组合：当前每条规则只能对应一个模板条件。',
  comparator_gte: '“达到或超过”阈值：当前只支持“超过（严格大于）”阈值，可改为“超过 X%”。',
  comparator_below: '“低于 / 不超过 / 没超过”阈值：当前只支持“当天涨幅超过阈值时不买”。',
  date_scope: '按星期、日期、节假日或时间段限定：当前规则每天统一生效，不能限定日期或时段。',
  calendar_days: '按自然日、周或月计的窗口：当前窗口都按交易日计算，可改为“N 个交易日”。',
  other: '当前规则模板无法表达这条规则。',
});

const MISSING_TEXT = Object.freeze({
  threshold_pct: '请写明涨幅阈值的具体数字，例如“当天涨幅超过 5% 不买入”。',
  days: '请写明卖出后多少个交易日内不买回，例如“卖出后 3 个交易日内不买回同一只股票”。',
  days_sell: '请写明买入后多少个交易日内卖出时提醒，例如“买入后 3 个交易日内卖出这只股票时提醒我”。',
  same_symbol: '这条规则只针对“卖出同一只股票”，但原文没有写清“同一只 / 这只股票”，也没有给出单个 6 位代码。请补充后重新描述。',
  condition: '请说明在什么情况下提醒你（例如当天涨幅超过多少，或卖出后多少个交易日内又买回）。',
  action: '请说明希望在哪类申报动作时提醒：申报买入时按涨幅 / 卖出后不买回，或申报卖出时按买入后窗口。',
});

export const SUPPORTED_RULE_EXAMPLES = Object.freeze([
  '当天涨幅超过 5% 的股票我不买',
  '卖出后 3 个交易日内不买回同一只股票',
  '只针对 600519：当天涨幅超过 3% 不买',
  '买入后 3 个交易日内卖出这只股票时提醒我',
]);

const EXECUTION_TEXT = Object.freeze({
  change_pct_threshold: '历史情境测试中，按所选标的与申报日读取日线收盘价计算当日涨跌幅（收盘 / 前收 − 1），超过阈值即命中。这是收盘后的历史复盘，不是盘中实时提醒；缺价或超范围时显示“数据不足”，不补造数值。',
  sell_buyback_window: '历史情境测试中，读取交易来源里的卖出记录（只有成交日期，没有成交时刻）与交易日历，计算申报日距最近一次卖出同一标的的交易日数，落在窗口内即命中；同一天先卖后买不计为“卖出后”；不读取价格。',
  buy_sell_window: '历史情境测试中（仅在“假如卖出”情境），读取交易来源里同一标的的买入记录（只有成交日期，没有成交时刻）与交易日历，计算申报日距最近一次可见买入的交易日数：买入后的第 1 到第 N 个交易日属于窗口，同日买入不计，先后顺序未知。不读取价格。账单没有“历史买入完整”的可靠依据：只有同日买入、最近可见买入已超出窗口或找不到买入记录时，都显示“无法确认 / 数据不足”，不显示“未命中”；命中时注明结果基于当前导入账单中的可见买入记录。',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function precheckRuleText(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (text === '') return { ok: false, code: C.TEXT_EMPTY, message: LOCAL_MESSAGES[C.TEXT_EMPTY] };
  if ([...text].length > RULE_TEXT_MAX_CHARS) return { ok: false, code: C.TEXT_TOO_LONG, message: LOCAL_MESSAGES[C.TEXT_TOO_LONG] };
  const ascii = toAsciiDigits(text);
  if (/\d{8,}/.test(ascii) || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(ascii)) {
    return { ok: false, code: C.TEXT_SENSITIVE, message: LOCAL_MESSAGES[C.TEXT_SENSITIVE] };
  }
  if (text.split(/\r?\n/).filter((l) => l.trim()).length > 3 || /日期\s*,\s*标的/.test(text)) {
    return { ok: false, code: C.TEXT_FORMAT, message: LOCAL_MESSAGES[C.TEXT_FORMAT] };
  }
  return { ok: true, text };
}

export function ruleServiceMessage(code, status = null) {
  if (code && SERVICE_MESSAGES[code]) return SERVICE_MESSAGES[code];
  if (code && LOCAL_MESSAGES[code]) return LOCAL_MESSAGES[code];
  return `识别服务返回 HTTP ${status ?? '错误'}（站点函数未发布、未激活或访问受限时会这样）。`;
}

function serviceFail(code, status = null) {
  return { ok: false, code, status, message: ruleServiceMessage(code, status) };
}

export async function requestRuleIntent(text, { fetchImpl = globalThis.fetch, timeoutMs = RULE_INTENT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(RULE_INTENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        credentials: 'same-origin',
      });
    } catch {
      return serviceFail(controller.signal.aborted ? C.TIMEOUT : C.NETWORK);
    }
    if (!response || typeof response.ok !== 'boolean') return serviceFail(C.RESPONSE);
    let payload = null;
    try { payload = await response.json(); } catch { payload = null; }
    if (controller.signal.aborted) return serviceFail(C.TIMEOUT);
    if (!response.ok) {
      const code = isPlainObject(payload) && typeof payload.code === 'string' ? payload.code : null;
      return { ok: false, code: code ?? C.STATUS, status: response.status, message: ruleServiceMessage(code, response.status) };
    }
    if (!isPlainObject(payload) || typeof payload.rawText !== 'string') return serviceFail(C.RESPONSE);
    return { ok: true, rawText: payload.rawText, protocol: typeof payload.protocol === 'string' ? payload.protocol : null };
  } finally {
    clearTimeout(timer);
  }
}

const STATUSES = new Set(['template', 'unsupported', 'unclear']);
const COMPARATORS = new Set(['gt', 'gte']);
const DAY_UNITS = new Set(['trading_day', 'calendar_day', 'unspecified']);
const SCOPE_KINDS = new Set(['all', 'symbol']);

// 只读取约定字段；类型不符即整体拒绝（不猜测、不纠正）
export function validateRuleJson(obj) {
  const bad = (why) => ({ ok: false, code: C.SCHEMA, why });
  if (!isPlainObject(obj)) return bad('not_object');
  if (Object.keys(obj).some((k) => !['status', 'template_id', 'params', 'scope', 'needs', 'missing', 'understanding'].includes(k))) return bad('unknown_field');
  if (!STATUSES.has(obj.status)) return bad('status');
  const tid = obj.template_id ?? null;
  if (tid !== null && typeof tid !== 'string') return bad('template_id');
  const params = obj.params ?? {};
  if (!isPlainObject(params)) return bad('params');
  if (Object.keys(params).some((k) => !['threshold_pct', 'comparator', 'days', 'day_unit'].includes(k))) return bad('unknown_param');
  if (tid === 'no_buy_on_surge' && (params.days != null || params.day_unit != null)) return bad('unused_param');
  if ((tid === 'no_buy_back_within' || tid === 'sell_within_after_buy') && (params.threshold_pct != null || params.comparator != null)) return bad('unused_param');
  const num = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (!num(params.threshold_pct) || !num(params.days)) return bad('param_number');
  if (params.comparator != null && !COMPARATORS.has(params.comparator)) return bad('comparator');
  if (params.day_unit != null && !DAY_UNITS.has(params.day_unit)) return bad('day_unit');
  const strList = (v) => v === undefined || v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (!strList(obj.needs) || !strList(obj.missing)) return bad('lists');
  if (obj.understanding != null && typeof obj.understanding !== 'string') return bad('understanding');
  // scope 可缺省（旧版站点函数不返回）；缺省时由程序按原文是否含代码决定能否继续，不默认放宽为全部股票
  let scope = null;
  if (obj.scope != null) {
    if (!isPlainObject(obj.scope) || !SCOPE_KINDS.has(obj.scope.kind)) return bad('scope');
    if (Object.keys(obj.scope).some((k) => !['kind', 'symbol'].includes(k))) return bad('unknown_scope_field');
    if (obj.scope.kind === 'all' && obj.scope.symbol != null) return bad('scope_all_symbol');
    if (obj.scope.kind === 'symbol' && (typeof obj.scope.symbol !== 'string' || !/^\d{6}$/.test(obj.scope.symbol))) return bad('scope_symbol');
    scope = { kind: obj.scope.kind, symbol: obj.scope.symbol ?? null };
  }
  return {
    ok: true,
    value: {
      status: obj.status,
      template_id: tid,
      params: {
        threshold_pct: params.threshold_pct ?? null,
        comparator: params.comparator ?? null,
        days: params.days ?? null,
        day_unit: params.day_unit ?? null,
      },
      scope,
      needs: [...(obj.needs ?? [])],
      missing: [...(obj.missing ?? [])],
      understanding: String(obj.understanding ?? '').trim().slice(0, 120),
    },
  };
}

function toAsciiDigits(s) {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).replace(/．/g, '.');
}

const CN_DIGIT = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const CN_UNIT = Object.freeze({ 十: 10, 百: 100, 千: 1000 });

function parseCnInt(s) {
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) cur = CN_DIGIT[ch];
    else { total += (cur || 1) * CN_UNIT[ch]; cur = 0; }
  }
  return total + cur;
}

function parseNumeral(s) {
  if (/^\d/.test(s)) return Number(s);
  const [intPart, frac] = s.split('点');
  const n = parseCnInt(intPart);
  return frac ? Number(`${n}.${[...frac].map((ch) => CN_DIGIT[ch]).join('')}`) : n;
}

const NUMERAL = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千]+(?:点[零〇一二三四五六七八九]+)?)';
const QTY_RE = new RegExp(`${NUMERAL}\\s*(%|％|个百分点|个点|个?交易日|个?自然日|个?日历日|个?工作日|天|日|次|倍|个?星期|周|个?月)`, 'g');
const PCT_CN_RE = new RegExp(`百分之${NUMERAL}`, 'g');

function unitKind(unit) {
  if (/^(%|％|个百分点|个点)$/.test(unit)) return 'pct';
  const u = unit.replace(/^个/, '');
  if (u === '交易日') return 'trading';
  if (/^(自然日|日历日|星期|周|月)$/.test(u)) return 'calendar';
  if (/^(天|日|工作日)$/.test(u)) return 'day';
  return u === '次' ? 'times' : 'multiple';
}

// 原文中“数字 + 单位”的数量（阿拉伯数字与常见中文数字）；模型给出的参数必须与其中一项对应
export function extractQuantities(text) {
  const s = toAsciiDigits(String(text ?? ''));
  const out = [];
  const seen = new Set();
  const add = (value, unit, kind) => {
    const key = `${value}|${kind}`;
    if (!Number.isFinite(value) || seen.has(key)) return;
    seen.add(key);
    out.push({ value, unit, kind });
  };
  for (const m of s.matchAll(PCT_CN_RE)) add(parseNumeral(m[1]), '百分之', 'pct');
  for (const m of s.matchAll(QTY_RE)) add(parseNumeral(m[1]), m[2], unitKind(m[2]));
  return out;
}

// 程序侧文本检查（与模型输出无关）：模板以外的数据/能力、多条件、名称或类别限定；命中任一项都不能生成可启用规则。
// 只是常见表达的关键词检查：不能保证覆盖所有说法（例如未列入的股票名称、没有关键词的附加条件）。
const NEED_PATTERNS = Object.freeze([
  ['specific_symbol', /创业板|科创板|北交所|主板|ST股|\*ST|板块|行业|概念股|龙头|白马股|银行股|券商股|白酒股|盘股|蓝筹|题材|次新|妖股|新股|港股|美股|基金|ETF|可转债|债券|某只股票|那只/],
  ['trade_pnl', /亏损|亏了|亏钱|亏本|盈利|赚了|赚钱|浮亏|浮盈|回撤|收益|盈亏|套牢|成本价/],
  ['sell_restriction', /止损|止盈|割肉|减仓|清仓|不卖|别卖|不要卖|不准卖|禁止卖|不许卖|不能卖|勿卖|莫卖|拒绝卖|暂缓卖|先不卖/],
  ['sell_action', /提醒我卖|该卖|卖出信号|卖点/],
  ['pause_trading', /暂停|停止交易|停手|冷静期|休息|不交易|别交易|不操作/],
  ['position_size', /仓位|满仓|半仓|重仓|轻仓|加仓|补仓|金额|万元|股数|多少股|买太多|买得太多|多买|少买/],
  ['account_funds', /账户|资金|总资产|市值|余额|本金/],
  ['intraday_price', /盘中|开盘|收盘前|尾盘|集合竞价|分时|实时|分钟|早盘|午盘|高开|低开|冲高|上午|下午|中午|午后/],
  ['date_scope', /周[一二三四五六日天末]|星期[一二三四五六日天]|礼拜|节前|节后|假期|月初|月末|月底|年底|年初|\d+月\d+[日号]|\d{4}-\d{1,2}-\d{1,2}/],
  ['volume', /成交量|成交额|放量|缩量|换手/],
  ['technical_indicator', /均线|MACD|KDJ|RSI|布林|金叉|死叉|K线|阳线|阴线|突破|支撑位|压力位|新高|新低|连涨|连阳|连板/],
  ['price_drop', /跌/],
  ['fundamentals', /财报|业绩|市盈率|市净率|估值|分红|新闻|公告|利好|利空|消息/],
  ['trade_frequency', /次数|频繁|每天最多|每周最多|连续/],
  ['auto_execution', /自动|帮我下单|帮我买|帮我卖|直接卖|直接买/],
]);
const COMPOUND_RE = /并且|而且|同时|且|或者|或是|以及|另外|此外|还要|还有|加上|除非|除了|除外|例外|排除|但是|不过|否则/;
const GTE_RE = /达到|不低于|不少于|大于等于|大于或等于|≥|>=|及以上|或以上|以上(?:含|包括)/;
const BELOW_RE = /没超过|未超过|不超过|没有超过|低于|小于|少于|不到|以内|之内|以下/;
const STRICT_RE = /超过|高于|大于|多于|>/;
const BUY_RE = /买|追|入手|建仓|上车|进场|入场|接回|回补/;
// 模板语义是“提醒不要买入”；原文必须有明确的否定买入表达，否则可能是相反意思（如“也可以买”）
const NO_BUY_RE = /(不|别|勿|莫|禁止|不准|不许|绝不|不再|不去|不能|不要|不会|不想|拒绝)[^，,。；;]{0,4}(买|追|入手|建仓|上车|进场|入场|接回|回补|碰)/;
const CODE_RE = /(?<!\d)\d{6}(?!\d)/g;
const SCOPE_EXCLUDE_RE = /除了|除外|排除|不包括|不包含|不含|以外|之外|例外/;
const SCOPE_WIDE_RE = /所有|全部|任何|每只|每一只|别的|其他|其它/;

// 原文中的 6 位数字代码（按文本保留前导零，去重）
export function extractSymbols(text) {
  return [...new Set(toAsciiDigits(String(text ?? '')).match(CODE_RE) ?? [])];
}

export function analyzeRuleText(text) {
  const raw = toAsciiDigits(String(text ?? ''));
  const symbols = extractSymbols(raw);
  // 代码本身不是规则参数：先替换掉，避免被当作数值或日期
  const t = raw.replace(CODE_RE, '〔代码〕');
  const needs = NEED_PATTERNS.filter(([, re]) => re.test(t)).map(([code]) => code);
  if (symbols.length > 1) needs.push('multi_symbol');
  if (symbols.length && SCOPE_EXCLUDE_RE.test(t)) needs.push('scope_exclude');
  const quantities = extractQuantities(t);
  const compound = [];
  const conj = t.match(COMPOUND_RE);
  if (conj) compound.push(`原文含有连接词“${conj[0]}”，可能包含多个条件`);
  if (quantities.length > 1) compound.push(`原文出现多个数值（${quantities.map((q) => `${q.value}${q.unit}`).join('、')}），而一条规则只有一个参数`);
  const clauses = t.split(/[，,；;。！!？?\n]/).filter((s) => s.trim()).length;
  return { needs, quantities, compound, symbols, tooManyClauses: clauses >= 4 };
}

const fmtNum = (v) => String(Number(v));

function unsupported(codes, understanding, detail = []) {
  const list = [...new Set(codes.map((c) => (RULE_NEED_TEXT[c] ? c : 'other')))];
  if (!list.length) list.push('other');
  return { status: 'unsupported', needs: list.map((code) => ({ code, message: RULE_NEED_TEXT[code] })), detail, understanding, examples: SUPPORTED_RULE_EXAMPLES };
}

function unclear(questions, understanding) {
  return { status: 'unclear', questions: questions.length ? questions : [MISSING_TEXT.condition], understanding, examples: SUPPORTED_RULE_EXAMPLES };
}

const scopePhrase = (parsed) => (parsed.scope && parsed.scope.kind === 'symbol'
  ? `只对股票代码 ${parsed.scope.symbol} 生效（其他股票不受这条规则提醒）`
  : '对所有股票统一生效');

function conditionOf(parsed) {
  const sym = parsed.scope && parsed.scope.kind === 'symbol' ? parsed.scope.symbol : null;
  if (parsed.kind === 'change_pct_threshold') {
    return `${sym ? `申报买入股票 ${sym} 当天，其` : '申报买入当天，该股票'}涨幅超过 ${parsed.threshold.display}（达到阈值本身不触发；按收盘数据做收盘后复盘）`;
  }
  if (parsed.kind === 'buy_sell_window') {
    return `买入${sym ? `股票 ${sym}` : '某只股票'}后第 1 到第 ${parsed.condition.window_days} 个交易日（不含买入当天，同日买入不计）内卖出同一只股票`;
  }
  return `卖出${sym ? `股票 ${sym}` : '某只股票'}后 ${parsed.threshold.display}内（不含卖出当天）再次申报买入同一只股票`;
}

function fullRuleOf(parsed) {
  if (parsed.kind === 'change_pct_threshold') {
    return `${scopePhrase(parsed)}：申报买入时，若该股票当天涨幅超过 ${parsed.threshold.display}，提醒你不要买入。只做提醒，不会阻止或执行交易。按当前模板，这条规则只包含“当天涨幅超过阈值时不买入”一个条件；请对照原话核对是否还有其他限定。`;
  }
  if (parsed.kind === 'buy_sell_window') {
    return `${scopePhrase(parsed)}：申报卖出时，若最近一次买入同一只股票的时间在买入后第 1 到第 ${parsed.condition.window_days} 个交易日（不含买入当天）内，提醒你注意。只做提醒，不会阻止或执行交易。账单没有成交时刻，同日买入不计为“买入后”；按当前模板，这条规则只包含“买入后窗口内卖出同一只股票时提醒”一个条件，请对照原话核对是否还有其他限定。`;
  }
  return `${scopePhrase(parsed)}：卖出某只股票后 ${parsed.threshold.display}内，若再次申报买入同一只股票，提醒你不要买回。只做提醒，不会阻止或执行交易。按当前模板，这条规则只包含“卖出后窗口内不再买回同一只股票”一个条件；请对照原话核对是否还有其他限定。`;
}

const ONE_RULE = '请一次只描述一条规则；如需多条规则，请分别识别、分别保存。';
const NO_BUY_TEXT = '未能从原文确认你是要“提醒我不要买入”（没有找到“不买 / 别买 / 不追”等表达，可能是相反的意思）。请写明在什么情况下不买入。';
const SCOPE_STALE_TEXT = '识别服务没有按“单个 6 位股票代码”返回适用范围（可能是站点函数尚未更新到支持适用范围的版本，或原文另有按名称、类别的限定）。为避免把限定个股的规则当成全部股票，未生成规则；也可以点击“新增规则”选择模板并填写股票代码。';
const NO_CODE_TEXT = '识别结果认为这条规则只针对某只股票，但原文中没有 6 位股票代码。系统不根据股票名称或简称推断代码；如只针对某只股票，请写明 6 位代码，否则请去掉限定后重新识别。';
const PROTOCOL_STALE_TEXT = '识别服务仍是旧版本（未返回买入后卖出提醒所需的协议版本），不能确认它已理解这条规则。未生成规则，请发布更新后的站点函数后重试，或点击“新增规则”选择“买入后 N 个交易日内卖出提醒”模板创建。';

// 适用范围：以原文中程序提取的代码为准，模型结果必须与之一致；不一致或缺失时不生成规则
function resolveScope(intent, scan, text) {
  const codes = scan.symbols;
  const ms = intent.scope;
  if (codes.length === 0) {
    if (ms && ms.kind === 'symbol') return { error: NO_CODE_TEXT };
    return { scope: { kind: 'all' }, check: '适用范围：原文中没有 6 位股票代码，按全部股票生效。系统不识别股票名称对应的代码，辅助检查也不能保证覆盖所有名称或隐含限定；如原话有限定，请改写并核对。' };
  }
  if (!ms) return { error: SCOPE_STALE_TEXT };
  if (ms.kind !== 'symbol' || ms.symbol !== codes[0]) {
    return { error: `原文写的股票代码是 ${codes[0]}，但识别结果的适用范围是“${ms.kind === 'symbol' ? `仅 ${safeCode(ms.symbol)}` : '全部股票'}”，两者不一致；未生成规则，请核对后重新识别。` };
  }
  if (SCOPE_WIDE_RE.test(toAsciiDigits(text))) {
    return { error: `原文同时写了股票代码 ${codes[0]} 和“所有 / 其他 / 任何股票”一类的说法，无法确认适用范围是只针对 ${codes[0]} 还是全部股票。请只保留一种说法后重新识别。` };
  }
  return { scope: { kind: 'symbol', symbol: codes[0] }, check: `适用范围：原文中找到 1 个 6 位代码 ${codes[0]}，与识别结果一致；只对该代码生效，不对其他股票提醒。` };
}

const safeCode = (s) => (typeof s === 'string' && /^\d{1,8}$/.test(s) ? s : '（无效代码）');
const RULE_WORDS = /不买回|买回来|买回|买入|不追回|追回|不追|买|追|入手|建仓|上车|进场|入场|接回|回补|碰|申报|卖出|卖了|卖|涨幅|涨了|涨|超过|高于|大于|多于|达到|以上|再|同一只|同一|一只|这只|该股|该股票|该标的|同一标的|股票代码|股票|代码|标的|票|当天|当日|当|天|交易日|后|以后|之前|时|的时候|期间|内|如果|若|只针对|针对|只对|只适用于|仅限|仅对|仅|适用范围|全部|所有|统一|生效|提醒我|提醒|提示|通知|告诉我|叫我|警告|注意|我|你|就|的|了|是|个|绝不|不会|不准|不许|不再|不去|不能|不要|不想|禁止|拒绝|别|勿|莫|不|以后|再|回|>+/g;

// 未识别文字一律要求补充；词表只是保守的表达边界，不证明自然语言语义完整。
function unexpressedText(text) {
  return toAsciiDigits(text)
    .replace(CODE_RE, '')
    .replace(PCT_CN_RE, '')
    .replace(QTY_RE, '')
    .replace(RULE_WORDS, '')
    .replace(/[\s，,。；;：:！!？?、“”「」()（）]/g, '');
}

const BUY_IN_RE = /买入|买了|买进|购入/;
const SELL_OUT_RE = /卖出|卖掉|卖/;
const SAME_STOCK_RE = /同一只|同一|这只|该股|该股票|该标的|同一标的/;
const REMIND_RE = /提醒|提示|通知|告诉我|叫我|警告|注意/;
const looksLikeBuySellRule = (text) => BUY_IN_RE.test(text) && SELL_OUT_RE.test(text) && !NO_BUY_RE.test(text) && /后/.test(text);

// 模型结果 → 程序判定：先按原文做确定性检查（不依赖模型），再只接受既有模板 + 原文中明确写出的参数与代码；
// 原文含义不唯一的地方（只写“天”、未写“超过/达到”）列为待确认项，未确认前不能保存。
export function resolveRuleIntent(intent, text, meta = {}) {
  const understanding = intent.understanding;
  const scan = analyzeRuleText(text);
  const t = toAsciiDigits(text);
  const protocolStale = meta.serverProtocol !== RULE_INTENT_PROTOCOL;
  // 旧版站点函数不认识“买入后卖出提醒”；不能把它的“暂不支持”当成用户表达不清，也不能静默套用旧模板。
  if (protocolStale && looksLikeBuySellRule(t)) return unclear([PROTOCOL_STALE_TEXT], understanding);
  const modelNeeds = intent.status === 'unsupported' ? intent.needs : [];
  if (scan.needs.length) return unsupported([...scan.needs, ...modelNeeds], understanding);
  if (intent.status === 'unsupported') {
    if (scan.symbols.length === 1 && modelNeeds.length && modelNeeds.every((n) => n === 'specific_symbol')) return unclear([SCOPE_STALE_TEXT], understanding);
    return unsupported(modelNeeds, understanding);
  }
  if (scan.compound.length) return unsupported(['compound_condition'], understanding, [...scan.compound, ONE_RULE]);
  if (scan.tooManyClauses) return unclear([`描述包含多个分句，无法确认是否只表达了一条规则。${ONE_RULE}`], understanding);
  if (intent.status === 'unclear') {
    return unclear([...new Set(intent.missing)].map((m) => MISSING_TEXT[m]).filter(Boolean), understanding);
  }
  const tpl = CONTRACT_TEMPLATES[intent.template_id ?? ''];
  if (!tpl) return { status: 'error', stage: 'schema', code: C.SCHEMA, message: '模型返回了系统中不存在的规则模板，未生成规则。' };
  if (/不是|并非|不一定|不必|无需|不需要|只有|仅当/.test(t)) return unclear(['原文含有额外的否定或条件限定，无法可靠确认是否完整对应当前单条件规则。请用明确的单条件表达重新描述。'], understanding);
  const confirmations = [];
  let fields;
  let paramCheck;
  if (tpl.kind === 'change_pct_threshold') {
    if (!/涨/.test(t) || !BUY_RE.test(t)) return unclear(['未能从原文确认这是一条“申报买入时按当天涨幅提醒”的规则。', MISSING_TEXT.threshold_pct], understanding);
    if (/卖/.test(t)) return unclear([`原文同时提到卖出，无法确认它只是一条“买入时按涨幅提醒”的规则。${ONE_RULE}`], understanding);
    if (!NO_BUY_RE.test(t)) return unclear([NO_BUY_TEXT], understanding);
    const v = intent.params.threshold_pct;
    if (v === null) return unclear([MISSING_TEXT.threshold_pct], understanding);
    if (!scan.quantities.some((q) => q.kind === 'pct' && q.value === v)) {
      return unclear([`原文中没有找到阈值 ${fmtNum(v)}%（需写成百分比，如“5%”或“五个点”），系统不使用推测或默认值。${MISSING_TEXT.threshold_pct}`], understanding);
    }
    if (BELOW_RE.test(t)) return unsupported(['comparator_below'], understanding);
    if (GTE_RE.test(t)) return unsupported(['comparator_gte'], understanding);
    if (!STRICT_RE.test(t)) {
      confirmations.push({
        key: 'comparator',
        question: `原文没有写明是“超过 ${fmtNum(v)}%”还是“达到 ${fmtNum(v)}% 就算”。请选择你的本意：`,
        options: [
          { id: 'gt', label: `超过 ${fmtNum(v)}%（严格大于；恰好 ${fmtNum(v)}% 不提醒）`, supported: true },
          { id: 'gte', label: `达到或超过 ${fmtNum(v)}%（恰好 ${fmtNum(v)}% 也提醒）`, supported: false, message: RULE_NEED_TEXT.comparator_gte },
        ],
      });
    }
    fields = { threshold_pct: fmtNum(v) };
    paramCheck = `参数在原文中找到：${fmtNum(v)}%`;
  } else if (tpl.kind === 'buy_sell_window') {
    if (!BUY_IN_RE.test(t) || !SELL_OUT_RE.test(t)) return unclear(['未能从原文确认这是一条“买入后若干交易日内卖出同一只股票时提醒”的规则。', MISSING_TEXT.days_sell], understanding);
    if (!/后/.test(t)) return unclear(['原文没有写明“买入后”，无法确认交易日窗口从哪一天开始计算。请补充“买入后 N 个交易日内”。'], understanding);
    if (NO_BUY_RE.test(t)) return unclear([`原文同时含有“不买 / 别买”等限制买入的表达，无法确认它只是“买入后卖出时提醒”的规则。${ONE_RULE}`], understanding);
    if (/涨/.test(t)) return unclear([`原文同时提到涨幅，无法确认它只是一条“买入后卖出提醒”的规则。${ONE_RULE}`], understanding);
    if (/别的|其他|其它|任何|所有|每只|每一只/.test(t)) return unclear(['原文提到其他或任何股票，而这条规则只针对“卖出同一只股票”。请确认是否只针对同一只股票。'], understanding);
    if (!SAME_STOCK_RE.test(t) && scan.symbols.length !== 1) return unclear([MISSING_TEXT.same_symbol], understanding);
    if (!REMIND_RE.test(t)) return unclear([MISSING_TEXT.action], understanding);
    const v = intent.params.days;
    if (v === null) return unclear([MISSING_TEXT.days_sell], understanding);
    const q = scan.quantities.find((x) => x.value === v && ['trading', 'calendar', 'day'].includes(x.kind));
    if (!q) return unclear([`原文中没有找到天数 ${fmtNum(v)}（需写成“3 个交易日”这样的数字加单位），系统不使用推测或默认值。${MISSING_TEXT.days_sell}`], understanding);
    if (q.kind === 'calendar') return unsupported(['calendar_days'], understanding);
    if (q.kind === 'day') {
      confirmations.push({
        key: 'day_unit',
        question: `原文写的是“${fmtNum(v)}${q.unit}”，没有说明是交易日还是自然日。请选择你的本意：`,
        options: [
          { id: 'trading_day', label: `${fmtNum(v)} 个交易日（不含周末和休市日）`, supported: true },
          { id: 'calendar_day', label: `${fmtNum(v)} 个自然日（含周末和节假日）`, supported: false, message: RULE_NEED_TEXT.calendar_days },
        ],
      });
    }
    fields = { days: fmtNum(v) };
    paramCheck = `参数在原文中找到：${fmtNum(v)}${q.unit}`;
  } else {
    if (!/卖/.test(t) || !BUY_RE.test(t)) return unclear(['未能从原文确认这是一条“卖出后若干交易日内不买回”的规则。', MISSING_TEXT.days], understanding);
    if (/涨/.test(t)) return unclear([`原文同时提到涨幅，无法确认它只是一条“卖出后不买回”的规则。${ONE_RULE}`], understanding);
    if (!NO_BUY_RE.test(t)) return unclear([NO_BUY_TEXT], understanding);
    if (/别的|其他|其它|任何|所有/.test(t)) return unclear(['原文提到其他或任何股票，而这条规则只针对“卖出后再买回同一只股票”；限制买入其他股票属于暂停交易，暂不支持。请确认是否只针对同一只股票。'], understanding);
    const v = intent.params.days;
    if (v === null) return unclear([MISSING_TEXT.days], understanding);
    const q = scan.quantities.find((x) => x.value === v && ['trading', 'calendar', 'day'].includes(x.kind));
    if (!q) return unclear([`原文中没有找到天数 ${fmtNum(v)}（需写成“3 个交易日”这样的数字加单位），系统不使用推测或默认值。${MISSING_TEXT.days}`], understanding);
    if (q.kind === 'calendar') return unsupported(['calendar_days'], understanding);
    if (q.kind === 'day') {
      confirmations.push({
        key: 'day_unit',
        question: `原文写的是“${fmtNum(v)}${q.unit}”，没有说明是交易日还是自然日。请选择你的本意：`,
        options: [
          { id: 'trading_day', label: `${fmtNum(v)} 个交易日（不含周末和休市日）`, supported: true },
          { id: 'calendar_day', label: `${fmtNum(v)} 个自然日（含周末和节假日）`, supported: false, message: RULE_NEED_TEXT.calendar_days },
        ],
      });
    }
    fields = { days: fmtNum(v) };
    paramCheck = `参数在原文中找到：${fmtNum(v)}${q.unit}`;
  }
  const sc = resolveScope(intent, scan, text);
  if (sc.error) return unclear([sc.error], understanding);
  const residual = unexpressedText(text);
  if (residual) return unclear([`以下文字无法可靠对应当前规则能力：「${residual}」。它可能是股票名称、附加条件或另一种含义；未生成规则，不会忽略这部分后启用。请改用明确的股票代码，或补充、改写描述后重新识别。`], understanding);
  const parsed = parseRuleSpec({ template_id: tpl.template_id, fields, scope: sc.scope });
  if (!parsed.supported) return { status: 'invalid', code: parsed.code, message: parsed.message, understanding };
  return {
    status: 'supported',
    understanding,
    parsed,
    template_name: parsed.template_name,
    scope: parsed.scope,
    scope_text: parsed.scope_text,
    condition: conditionOf(parsed),
    fullRule: fullRuleOf(parsed),
    params: Object.entries(parsed.fields).map(([key, value]) => ({ key, label: tpl.fields[key].label, value })),
    reminder: parsed.reminder,
    execution: EXECUTION_TEXT[parsed.kind],
    confirmations,
    checks: [
      '按常见关键词未发现盈亏、仓位、成交量、技术指标、板块或类别等模板以外的要求（关键词检查只能覆盖常见说法，不能保证识别了全部意图，包括所有股票名称、附加条件或隐含限定）',
      '按连接词与数值个数未发现多个条件（同样只是辅助检查）',
      paramCheck,
      sc.check,
    ],
  };
}

// 待确认项全部选择了系统支持的选项才可保存；返回 { ok, pending, blocked }
export function confirmationState(result, choices = {}) {
  const items = result && Array.isArray(result.confirmations) ? result.confirmations : [];
  const pending = items.filter((c) => !c.options.some((o) => o.id === choices[c.key]));
  const blocked = items.map((c) => c.options.find((o) => o.id === choices[c.key])).filter((o) => o && !o.supported);
  return { ok: pending.length === 0 && blocked.length === 0, pending, blocked };
}

export async function recognizeRule(input, opts = {}) {
  const pre = precheckRuleText(input);
  if (!pre.ok) return { status: 'error', stage: 'precheck', code: pre.code, message: pre.message };
  const res = await requestRuleIntent(pre.text, opts);
  if (!res.ok) return { status: 'error', stage: 'service', code: res.code, httpStatus: res.status ?? null, message: res.message };
  let json;
  try {
    json = JSON.parse(res.rawText);
  } catch {
    return { status: 'error', stage: 'schema', code: C.JSON, message: LOCAL_MESSAGES[C.JSON] };
  }
  const valid = validateRuleJson(json);
  if (!valid.ok) return { status: 'error', stage: 'schema', code: C.SCHEMA, message: LOCAL_MESSAGES[C.SCHEMA] };
  return { ...resolveRuleIntent(valid.value, pre.text, { serverProtocol: res.protocol }), text: pre.text };
}
