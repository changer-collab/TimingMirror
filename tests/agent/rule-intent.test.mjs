#!/usr/bin/env node
/**
 * 交易规则自然语言识别（src/agent/ruleIntent.js）定向测试（本地离线；fake fetch；零依赖）
 *
 * 覆盖：本地预检（空 / 超长 / 疑似账号 / 邮箱 / CSV）；出站只含 { text }；服务失败原因映射；
 *       模型 JSON 严格校验；程序按原文检查（模板外要求、多条件、限定标的、概念不符）——模型说“可用模板”也不放行；
 *       参数必须以“数字+单位”出现在原文；“天”与“超过/达到”含义不明时列为待确认项；
 *       支持的结果与引擎 parseContract 完全一致（同哈希）。
 * 运行：node tests/agent/rule-intent.test.mjs（或 npm run check）
 */
import {
  precheckRuleText,
  extractQuantities,
  analyzeRuleText,
  validateRuleJson,
  resolveRuleIntent,
  confirmationState,
  recognizeRule,
  RULE_INTENT_CODES as C,
  RULE_INTENT_URL,
  RULE_INTENT_PROTOCOL,
  RULE_NEED_TEXT,
} from '../../src/agent/ruleIntent.js';
import { parseContract } from '../../src/engine/contractMatch.js';
import { parseRuleSpec } from '../../src/engine/ruleSpec.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const intent = (o) => {
  const v = validateRuleJson(o);
  if (!v.ok) throw new Error(`fixture invalid: ${v.why}`);
  return v.value;
};
const surge = (threshold_pct, comparator = 'gt') => intent({ status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct, comparator }, understanding: '涨幅超阈值不买' });
const buyback = (days, day_unit = 'trading_day') => intent({ status: 'template', template_id: 'no_buy_back_within', params: { days, day_unit } });
const codes = (r) => (r.needs ?? []).map((n) => n.code);

/* ==== 本地预检 ==== */
check('预检：空白 → E_RULE_TEXT_EMPTY', precheckRuleText('   ').code === C.TEXT_EMPTY);
check('预检：201 字 → E_RULE_TEXT_TOO_LONG；200 字通过', precheckRuleText('涨'.repeat(201)).code === C.TEXT_TOO_LONG && precheckRuleText('涨'.repeat(200)).ok);
check('预检：8 位以上连续数字（含全角）→ E_RULE_TEXT_SENSITIVE', precheckRuleText('我的账户 12345678 涨幅超过5%不买').code === C.TEXT_SENSITIVE
  && precheckRuleText('资金账号１２３４５６７８９').code === C.TEXT_SENSITIVE);
check('预检：邮箱 → E_RULE_TEXT_SENSITIVE', precheckRuleText('发到 a.b@example.com 提醒我').code === C.TEXT_SENSITIVE);
check('预检：粘贴 CSV 表头 → E_RULE_TEXT_FORMAT', precheckRuleText('日期,标的,方向,价格,数量\n2024-09-25,600519,买入,100,100').code === C.TEXT_FORMAT);
check('预检：6 位股票代码与普通描述可通过，并去除首尾空白', precheckRuleText('  600519 涨幅超过5%我不买 ').ok && precheckRuleText('  600519 涨幅超过5%我不买 ').text === '600519 涨幅超过5%我不买');

/* ==== 原文数量（数字 + 单位） ==== */
const q = (t) => extractQuantities(t).map((x) => `${x.value}:${x.kind}`).join(',');
check('数量：阿拉伯 / 小数 / 全角百分比', q('超过5%') === '5:pct' && q('超过2.5%') === '2.5:pct' && q('超过１０%') === '10:pct');
check('数量：中文数字（五个点 / 百分之五 / 三点五个点 / 十五个交易日）', q('五个点') === '5:pct' && q('百分之五') === '5:pct' && q('三点五个点') === '3.5:pct' && q('十五个交易日') === '15:trading');
check('数量：天数单位区分交易日 / 天 / 自然日 / 周 / 月', q('3个交易日') === '3:trading' && q('3天') === '3:day' && q('3日') === '3:day'
  && q('7个自然日') === '7:calendar' && q('一周') === '1:calendar' && q('两个月') === '2:calendar');
check('数量：“同一只股票”“当天”不算数量', q('卖出后三个交易日内不买回同一只股票') === '3:trading' && q('当天涨幅超过5%') === '5:pct');

/* ==== 模型 JSON 校验 ==== */
check('校验：status 不在约定内 → 拒绝', !validateRuleJson({ status: 'ok' }).ok);
check('校验：参数为字符串 → 拒绝（不做类型纠正）', !validateRuleJson({ status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct: '5' } }).ok);
check('校验：comparator / day_unit 非约定值 → 拒绝', !validateRuleJson({ status: 'template', params: { comparator: 'ge' } }).ok && !validateRuleJson({ status: 'template', params: { day_unit: 'week' } }).ok);
check('校验：needs 非字符串数组 → 拒绝', !validateRuleJson({ status: 'unsupported', needs: [1] }).ok);
check('校验：非对象 → 拒绝', !validateRuleJson([1]).ok && !validateRuleJson(null).ok);

/* ==== 支持：涨幅模板 ==== */
{
  const text = '当天涨幅超过5%的股票我不买';
  const r = resolveRuleIntent(surge(5), text);
  const engine = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '5' } });
  check('支持·涨幅：status=supported，结果与引擎 parseContract 同哈希、同文本，无待确认项', r.status === 'supported' && r.parsed.hash === engine.hash && r.parsed.text === engine.text
    && r.confirmations.length === 0 && confirmationState(r, {}).ok, JSON.stringify(r).slice(0, 200));
  check('支持·涨幅：规则说明“对所有股票统一生效 / 只提醒 / 当前模板一个条件 / 请对照原话核对”，并列出程序检查与参数来源',
    r.fullRule.includes('对所有股票统一生效') && r.fullRule.includes('超过 5.0%') && r.fullRule.includes('按当前模板')
    && r.fullRule.includes('请对照原话核对') && !r.fullRule.includes('除此之外没有其他条件')
    && r.condition.includes('超过 5.0%') && r.params[0].value === 5 && r.reminder === engine.reminder && r.execution.includes('收盘 / 前收 − 1')
    && r.checks.length === 4 && r.checks[2] === '参数在原文中找到：5%' && r.checks[3].includes('按全部股票生效') && r.checks[3].includes('不识别股票名称')
    && r.checks[0].includes('不能保证识别了全部意图') && r.checks[0].includes('附加条件或隐含限定')
    && r.scope.kind === 'all' && r.parsed.schema === 'contract-v1', JSON.stringify(r));
  const zh = resolveRuleIntent(surge(5), '当天涨幅超过五个点的票不买');
  check('支持·涨幅：中文“五个点”对应参数 5', zh.status === 'supported' && zh.parsed.hash === engine.hash && zh.confirmations.length === 0);
}

/* ==== “超过 / 达到”：按原文判定，不采信模型 ==== */
{
  const noCmp = resolveRuleIntent(intent({ status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct: 5, comparator: 'gt' } }), '涨幅5%的不买');
  const st = (choices) => confirmationState(noCmp, choices);
  check('比较方式未写明（即使模型说 gt）→ 待确认，不默认“超过”', noCmp.status === 'supported' && noCmp.confirmations.length === 1 && noCmp.confirmations[0].key === 'comparator'
    && !st({}).ok && st({}).pending.length === 1, JSON.stringify(noCmp.confirmations));
  check('比较方式确认：选“达到或超过”→ 不支持、不能保存；选“超过”→ 可保存', !st({ comparator: 'gte' }).ok && st({ comparator: 'gte' }).blocked[0].message === RULE_NEED_TEXT.comparator_gte
    && st({ comparator: 'gt' }).ok && !st({ comparator: 'bogus' }).ok);
  const yishang = resolveRuleIntent(surge(5), '当天涨了五个点以上的票不买');
  check('“以上”（未写“超过”）→ 待确认', yishang.status === 'supported' && yishang.confirmations[0]?.key === 'comparator');
  const gte = resolveRuleIntent(surge(5, 'gt'), '涨幅达到5%就不买');
  check('“达到”→ 暂不支持（comparator_gte），即使模型说 gt 也不改成“超过”', gte.status === 'unsupported' && codes(gte)[0] === 'comparator_gte');
}

/* ==== 参数必须以“数字+单位”出现在原文；不使用默认值 ==== */
{
  const r = resolveRuleIntent(surge(9.9), '涨停的票我不追');
  check('原文无数字：模型给出 9.9 → 需要补充（不使用推测值）', r.status === 'unclear' && r.questions[0].includes('原文中没有找到阈值 9.9%'), JSON.stringify(r));
  const bare = resolveRuleIntent(surge(5), '涨幅超过5的不买');
  check('原文数字缺少 % 单位 → 需要补充（不默认理解为 5%）', bare.status === 'unclear' && bare.questions[0].includes('需写成百分比'));
  const missing = resolveRuleIntent(intent({ status: 'template', template_id: 'no_buy_on_surge', params: {} }), '涨太多的不买');
  check('模型未给阈值 → 需要补充（不套默认 5%）', missing.status === 'unclear' && missing.questions[0].includes('涨幅阈值'));
}

/* ==== 支持：不追回模板；“天”必须确认 ==== */
{
  const engine = parseContract({ template_id: 'no_buy_back_within', fields: { days: '3' } });
  const r = resolveRuleIntent(buyback(3), '卖出后三个交易日内不买回同一只股票');
  check('支持·不追回：写明“交易日”→ supported，同引擎哈希，无待确认项', r.status === 'supported' && r.parsed.hash === engine.hash && r.condition.includes('3 个交易日') && r.confirmations.length === 0, JSON.stringify(r).slice(0, 200));
  const day = resolveRuleIntent(buyback(3, 'trading_day'), '卖了以后3天内别买回来');
  const st = (choices) => confirmationState(day, choices);
  check('只写“天”（即使模型说 trading_day）→ 待确认交易日 / 自然日，未选择不能保存', day.status === 'supported' && day.confirmations.length === 1 && day.confirmations[0].key === 'day_unit'
    && day.confirmations[0].question.includes('“3天”') && !st({}).ok, JSON.stringify(day.confirmations));
  check('“天”确认：选自然日 → 不支持、不能保存；选交易日 → 可保存（仍为 3 个交易日同哈希）',
    !st({ day_unit: 'calendar_day' }).ok && st({ day_unit: 'calendar_day' }).blocked[0].message === RULE_NEED_TEXT.calendar_days
    && st({ day_unit: 'trading_day' }).ok && day.parsed.hash === engine.hash);
  const ri = resolveRuleIntent(buyback(5, 'unspecified'), '卖出后5日内不买回');
  check('只写“日”同样待确认', ri.status === 'supported' && ri.confirmations[0]?.key === 'day_unit');
  const cal = resolveRuleIntent(buyback(7, 'trading_day'), '卖出后 7 个自然日内不买回');
  const week = resolveRuleIntent(buyback(1, 'trading_day'), '卖出后一周内不买回');
  check('自然日 / 周 → 暂不支持（calendar_days），即使模型说 trading_day', cal.status === 'unsupported' && codes(cal)[0] === 'calendar_days' && week.status === 'unsupported' && codes(week)[0] === 'calendar_days');
  const frac = resolveRuleIntent(buyback(2.5), '卖出后2.5个交易日内不买回');
  check('不追回·小数天数 → 引擎校验失败（invalid，E_CONTRACT_FIELD_INVALID），不四舍五入', frac.status === 'invalid' && frac.code === 'E_CONTRACT_FIELD_INVALID', JSON.stringify(frac));
}

/* ==== 支持：买入后 N 个交易日内卖出提醒（新协议） ==== */
{
  const P = { serverProtocol: RULE_INTENT_PROTOCOL };
  const sym = (s) => ({ kind: 'symbol', symbol: s });
  const sellWithin = (days, day_unit = 'trading_day', scope = null) => intent({ status: 'template', template_id: 'sell_within_after_buy', params: { days, day_unit }, scope });
  const text = '买入后3个交易日内卖出这只股票时提醒我';
  const engine = parseContract({ template_id: 'sell_within_after_buy', fields: { days: '3' } });

  const r = resolveRuleIntent(sellWithin(3), text, P);
  check('支持·买入后卖出：写明交易日 → supported，同引擎哈希，动作=卖出，无待确认项', r.status === 'supported' && r.parsed.hash === engine.hash
    && r.parsed.action === 'sell' && r.parsed.text === engine.text && r.confirmations.length === 0 && confirmationState(r, {}).ok, JSON.stringify(r).slice(0, 300));
  check('支持·买入后卖出：预览写明申报卖出、第 1 到第 N 个交易日、同日买入不计、只提醒',
    r.fullRule.includes('申报卖出时') && r.fullRule.includes('第 1 到第 3 个交易日') && r.fullRule.includes('同日买入不计')
    && r.condition.includes('第 1 到第 3 个交易日') && r.reminder.includes('只提醒') && r.execution.includes('仅在“假如卖出”情境')
    && r.execution.includes('同日买入不计') && r.execution.includes('数据不足') && r.scope.kind === 'all', JSON.stringify(r));
  check('支持·买入后卖出：参数来源与范围检查如实列出“天 / 日”为待确认、关键词检查只是辅助',
    r.checks[2] === '参数在原文中找到：3个交易日' && r.checks[0].includes('不能保证识别了全部意图') && r.checks[3].includes('按全部股票生效'), JSON.stringify(r.checks));

  const day = resolveRuleIntent(sellWithin(3), '买入后3天内卖出这只股票时提醒我', P);
  const st = (choices) => confirmationState(day, choices);
  check('买入后卖出·只写“天” → 待确认交易日 / 自然日，未选择不能保存', day.status === 'supported' && day.confirmations.length === 1
    && day.confirmations[0].key === 'day_unit' && day.confirmations[0].question.includes('“3天”') && !st({}).ok, JSON.stringify(day.confirmations));
  check('买入后卖出·“天”确认：自然日不支持，交易日可保存且同哈希', !st({ day_unit: 'calendar_day' }).ok
    && st({ day_unit: 'calendar_day' }).blocked[0].message === RULE_NEED_TEXT.calendar_days
    && st({ day_unit: 'trading_day' }).ok && day.parsed.hash === engine.hash);

  const cal = resolveRuleIntent(sellWithin(7), '买入后7个自然日内卖出这只股票时提醒我', P);
  check('买入后卖出·写明自然日 → 暂不支持（calendar_days）', cal.status === 'unsupported' && codes(cal)[0] === 'calendar_days', JSON.stringify(cal).slice(0, 200));
  const noSame = resolveRuleIntent(sellWithin(3), '买入后3个交易日内卖出时提醒我', P);
  check('买入后卖出·没有写明同一只股票 → 需要补充（不默认同一只）', noSame.status === 'unclear' && noSame.questions[0].includes('同一只'), JSON.stringify(noSame).slice(0, 200));
  const otherStocks = resolveRuleIntent(sellWithin(3), '买入后3个交易日内卖出其他股票时提醒我', P);
  check('买入后卖出·提到其他股票 → 需要补充', otherStocks.status === 'unclear' && otherStocks.questions[0].includes('同一只股票'), JSON.stringify(otherStocks).slice(0, 200));
  const compound = resolveRuleIntent(sellWithin(3), '买入后3个交易日内卖出同一只股票并且亏损时提醒我', P);
  check('买入后卖出·附加亏损条件 → 暂不支持（trade_pnl），不截取后启用', compound.status === 'unsupported' && codes(compound).includes('trade_pnl') && !compound.parsed);
  const restriction = resolveRuleIntent(sellWithin(3), '买入后3个交易日内不要卖出这只股票', P);
  check('买入后卖出·意思是限制卖出 → 暂不支持（sell_restriction），不当成提醒卖出', restriction.status === 'unsupported' && codes(restriction).includes('sell_restriction'), JSON.stringify(restriction).slice(0, 200));

  const scoped = resolveRuleIntent(sellWithin(3, 'trading_day', sym('600519')), '买入后3个交易日内卖出 600519 时提醒我', P);
  check('买入后卖出·单个代码：contract-v2，范围只对代码生效', scoped.status === 'supported' && scoped.parsed.schema === 'contract-v2'
    && scoped.parsed.scope.symbol === '600519' && scoped.parsed.action === 'sell' && scoped.fullRule.includes('只对股票代码 600519 生效'), JSON.stringify(scoped).slice(0, 300));
  const scopedStale = resolveRuleIntent(sellWithin(3, 'trading_day', null), '买入后3个交易日内卖出 600519 时提醒我', P);
  check('买入后卖出·原文有代码但模型未返回范围 → 需要补充，不当成全部股票', scopedStale.status === 'unclear' && scopedStale.questions[0].includes('没有按“单个 6 位股票代码”返回适用范围'));

  const stale = resolveRuleIntent(sellWithin(3), text);
  check('买入后卖出·旧服务端（无协议版本）→ 需要补充并说明发布站点函数，不套用旧模板', stale.status === 'unclear' && !stale.parsed
    && stale.questions[0].includes('仍是旧版本') && stale.questions[0].includes('发布更新后的站点函数'), JSON.stringify(stale).slice(0, 300));
  const oldOk = resolveRuleIntent(surge(5), '当天涨幅超过5%的股票我不买');
  check('旧规则不受协议检查影响：涨幅规则在旧服务端下仍可识别', oldOk.status === 'supported' && oldOk.parsed.hash === parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '5' } }).hash);
  check('结构校验：买入后卖出模板不接受阈值 / 比较方式参数', !validateRuleJson({ status: 'template', template_id: 'sell_within_after_buy', params: { threshold_pct: 5 } }).ok
    && !validateRuleJson({ status: 'template', template_id: 'sell_within_after_buy', params: { days: 3, comparator: 'gt' } }).ok);
}

/* ==== 多条件 / 限定标的 / 模板外要求：模型说“可用模板”也不放行，不截取部分 ==== */
{
  const cases = [
    ['当天涨幅超过5%并且成交量放大的股票不买', 'volume'],
    ['当天涨幅超过5%且换手率超过10%不买', 'volume'],
    ['当天涨幅超过5%同时大盘下跌时不买', 'price_drop'],
    ['创业板的票涨幅超过10%不买', 'specific_symbol'],
    ['涨幅超过5%提醒我卖出', 'sell_action'],
    ['开盘涨幅超过5%不买', 'intraday_price'],
    ['站上均线且涨幅超过5%不买', 'technical_indicator'],
    ['仓位超过一半时涨幅超过5%不买', 'position_size'],
    ['涨幅超过5%的小盘股不买', 'specific_symbol'],
    ['下午涨幅超过5%不买', 'intraday_price'],
    ['涨幅超过5%不买，周五除外', 'date_scope'],
    ['10月8日以后涨幅超过5%不买', 'date_scope'],
    ['涨幅超过5%不要买太多', 'position_size'],
    ['港股涨幅超过5%不买', 'specific_symbol'],
    ['连涨后涨幅超过5%不买', 'technical_indicator'],
  ];
  for (const [text, code] of cases) {
    const r = resolveRuleIntent(surge(5), text);
    check(`模板外要求：「${text}」→ 暂不支持（${code}），不生成规则`, r.status === 'unsupported' && !r.parsed && codes(r).includes(code), JSON.stringify(r).slice(0, 200));
  }
  const conj = resolveRuleIntent(surge(5), '当天涨幅超过5%并且是我持有过的股票不买');
  check('多条件（连接词“并且”，无其他关键字）→ 暂不支持 compound_condition，并说明原因', conj.status === 'unsupported' && codes(conj)[0] === 'compound_condition' && conj.detail[0].includes('“并且”'), JSON.stringify(conj));
  const two = resolveRuleIntent(surge(5), '当天涨幅超过5%不买，卖出后3个交易日内不买回');
  check('一句话两条规则（多个数值）→ 暂不支持 compound_condition，提示分别描述', two.status === 'unsupported' && codes(two)[0] === 'compound_condition'
    && two.detail.some((d) => d.includes('多个数值')) && two.detail.some((d) => d.includes('分别识别')), JSON.stringify(two));
  const clauses = resolveRuleIntent(surge(5), '如果当天，涨幅，超过5%，我不买');
  check('分句过多 → 需要补充（无法确认完整表达）', clauses.status === 'unclear' && clauses.questions[0].includes('无法确认是否只表达了一条规则'));
  const mUnclear = resolveRuleIntent(intent({ status: 'unclear', missing: ['threshold_pct'] }), '放量上涨的票不买');
  check('模型说“需要补充”但原文含模板外要求 → 以程序检查为准，暂不支持', mUnclear.status === 'unsupported' && codes(mUnclear).includes('volume'));
  const mismatch1 = resolveRuleIntent(surge(3), '卖出后3个交易日内不买回');
  const mismatch2 = resolveRuleIntent(buyback(5), '当天涨幅超过5%不买');
  check('模型选错模板（原文概念不符）→ 需要补充，不生成规则', mismatch1.status === 'unclear' && mismatch2.status === 'unclear', JSON.stringify([mismatch1.status, mismatch2.status]));
  const mixed = resolveRuleIntent(buyback(3), '卖出后3个交易日内不追涨买回');
  check('不追回规则里出现“涨”→ 需要补充（可能混入涨幅条件）', mixed.status === 'unclear');
  const except = resolveRuleIntent(surge(5), '涨幅超过5%的不买，除了茅台');
  check('例外条件（“除了”）→ 暂不支持 compound_condition', except.status === 'unsupported' && codes(except)[0] === 'compound_condition', JSON.stringify(except));
  const reverse1 = resolveRuleIntent(surge(5), '涨幅超过5%也可以买');
  const reverse2 = resolveRuleIntent(buyback(3), '卖出后三个交易日内可以买回');
  check('意思相反（没有“不买 / 别买”等否定表达）→ 需要补充，不生成“不买”规则', reverse1.status === 'unclear' && reverse2.status === 'unclear'
    && reverse1.questions[0].includes('可能是相反的意思'), JSON.stringify([reverse1, reverse2]).slice(0, 300));
  const below = resolveRuleIntent(surge(5), '涨幅没超过5%不买');
  const within = resolveRuleIntent(surge(5), '涨幅在5%以内的不买');
  check('“没超过 / 以内”（方向相反）→ 暂不支持 comparator_below', below.status === 'unsupported' && codes(below)[0] === 'comparator_below' && codes(within)[0] === 'comparator_below');
  const neg = ['我绝不买入当天涨幅超过5%的股票', '当天涨幅超过5%的票别买', '涨幅超过5%的，我不会再追'].map((t) => resolveRuleIntent(surge(5), t).status);
  check('常见否定买入写法（绝不买入 / 别买 / 不会再追）均可识别', neg.every((x) => x === 'supported'), JSON.stringify(neg));
  const other = resolveRuleIntent(buyback(3), '卖出后3个交易日内不买回别的票');
  check('不追回规则提到“别的 / 任何股票”→ 需要补充（不是同一只股票的语义）', other.status === 'unclear' && other.questions[0].includes('同一只股票'));
}

/* ==== 暂不支持 / 需要补充 / 未知模板 ==== */
{
  const r = resolveRuleIntent(intent({ status: 'unsupported', needs: ['trade_pnl', 'pause_trading', 'trade_pnl'], understanding: '连续亏损两次后暂停一天' }), '如果同一只股票连续亏损两次，提醒我暂停交易一天');
  check('暂不支持：示例规则（连续亏损 + 暂停交易）→ 程序检查与模型代码合并去重，不生成规则', r.status === 'unsupported' && !r.parsed
    && JSON.stringify(codes(r)) === JSON.stringify(['trade_pnl', 'pause_trading', 'trade_frequency']) && r.needs[0].message === RULE_NEED_TEXT.trade_pnl, JSON.stringify(codes(r)));
  const asTemplate = resolveRuleIntent(buyback(1), '如果同一只股票连续亏损两次，提醒我暂停交易一天');
  check('暂不支持：同一示例即使模型误判为模板，程序检查仍判暂不支持', asTemplate.status === 'unsupported' && codes(asTemplate).includes('trade_pnl'));
  const unknown = resolveRuleIntent(intent({ status: 'unsupported', needs: ['made_up'] }), 'xx');
  const none = resolveRuleIntent(intent({ status: 'unsupported' }), 'xx');
  check('暂不支持：未知能力代码 / 空列表 → 统一显示 other，不展示模型自造说明', unknown.needs[0].code === 'other' && none.needs[0].code === 'other');
  const unclear = resolveRuleIntent(intent({ status: 'unclear', missing: ['days', 'bogus'] }), '卖出后别急着买回');
  check('需要补充：missing → 程序给定的补充提示（未知项忽略）', unclear.status === 'unclear' && unclear.questions.length === 1 && unclear.questions[0].includes('多少个交易日'));
  const bad = resolveRuleIntent(intent({ status: 'template', template_id: 'stop_loss', params: { threshold_pct: 5 } }), '当天涨幅超过5%不买');
  check('模板不存在 → error（不执行、不猜测）', bad.status === 'error' && bad.code === C.SCHEMA);
  check('analyzeRuleText：支持示例原文无模板外要求、无多条件', ['当天涨幅超过 5% 的股票我不买', '卖出后 3 个交易日内不买回同一只股票'].every((t) => {
    const a = analyzeRuleText(t);
    return a.needs.length === 0 && a.compound.length === 0 && !a.tooManyClauses;
  }));
}

/* ==== 适用范围：单个 6 位代码（以原文中程序提取的代码为准，模型结果须一致） ==== */
{
  const scoped = (tpl, params, scope) => intent({ status: 'template', template_id: tpl, params, scope, understanding: 'x' });
  const sym = (s) => ({ kind: 'symbol', symbol: s });
  const text = '只针对 600519：当天涨幅超过 3% 不买';
  const r = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 3, comparator: 'gt' }, sym('600519')), text);
  const engine = parseRuleSpec({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' }, scope: sym('600519') });
  check('范围·单代码：supported，contract-v2，与 parseRuleSpec 同哈希、同文本', r.status === 'supported' && r.parsed.schema === 'contract-v2' && r.parsed.hash === engine.hash
    && r.parsed.text === engine.text && r.scope.symbol === '600519', JSON.stringify(r).slice(0, 300));
  check('范围·单代码：完整规则写明只对该代码生效、其他股票不提醒；程序检查列出代码来源', r.fullRule.includes('只对股票代码 600519 生效') && r.fullRule.includes('其他股票不受这条规则提醒')
    && r.checks[3].includes('找到 1 个 6 位代码 600519'), JSON.stringify([r.fullRule, r.checks]));
  const lead = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 5, comparator: 'gt' }, sym('000001')), '000001 当天涨幅超过5%不买');
  check('范围·前导零代码 000001 按文本保留', lead.status === 'supported' && lead.parsed.scope.symbol === '000001' && lead.parsed.text.startsWith('仅限 000001：'));
  const bb = resolveRuleIntent(scoped('no_buy_back_within', { days: 3, day_unit: 'trading_day' }, sym('600519')), '只针对 600519：卖出后 3 个交易日内不买回');
  check('范围·不追回规则也可限定单个代码（代码不被当成数值参数）', bb.status === 'supported' && bb.parsed.schema === 'contract-v2' && bb.confirmations.length === 0
    && analyzeRuleText('600519日内涨幅超过5%').quantities.map((x) => `${x.value}:${x.kind}`).join(',') === '5:pct', JSON.stringify(bb).slice(0, 200));
  const stale = resolveRuleIntent(surge(3), text);
  const staleOld = resolveRuleIntent(intent({ status: 'unsupported', needs: ['specific_symbol'] }), text);
  check('范围·原文有代码但模型未返回 scope（旧版站点函数）→ 需要补充，不当成全部股票', stale.status === 'unclear' && stale.questions[0].includes('没有按“单个 6 位股票代码”返回适用范围')
    && staleOld.status === 'unclear' && staleOld.questions[0].includes('站点函数尚未更新'), JSON.stringify([stale, staleOld]).slice(0, 300));
  const all = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 3, comparator: 'gt' }, { kind: 'all' }), text);
  const other = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 3, comparator: 'gt' }, sym('600036')), text);
  check('范围·模型范围与原文代码不一致（全部股票 / 另一个代码）→ 需要补充', all.status === 'unclear' && all.questions[0].includes('两者不一致')
    && other.status === 'unclear' && other.questions[0].includes('仅 600036'));
  const byName = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 5, comparator: 'gt' }, sym('600519')), '茅台当天涨幅超过5%不买');
  check('范围·原文无代码而模型按名称推断出代码 → 需要补充（不根据名称推断代码）', byName.status === 'unclear' && byName.questions[0].includes('不根据股票名称或简称推断代码'));
  const blind = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 5, comparator: 'gt' }, { kind: 'all' }), '茅台当天涨幅超过5%不买');
  check('只写股票名称且模型误判为全部股票 → 未表达文字检查要求补充，不生成可启用规则', blind.status === 'unclear' && !blind.parsed
    && blind.questions[0].includes('茅台') && blind.questions[0].includes('不会忽略这部分后启用'), JSON.stringify(blind));
  for (const text of ['心情不好时当天涨幅超过5%不买', '当天涨幅超过5%不买，要等回调', '宁德时代当天涨幅超过5%不买', '当天涨幅超过5%尽量不买', '不是涨幅超过5%就不买']) {
    const partial = resolveRuleIntent(surge(5), text);
    check(`未表达内容：「${text}」→ 需要补充，不截取后启用`, partial.status === 'unclear' && !partial.parsed, JSON.stringify(partial));
  }
  check('结构校验拒绝未知顶层、参数、范围字段与不匹配模板的参数，不能静默忽略模型附加能力',
    !validateRuleJson({ status: 'template', code: 'throw 1' }).ok
    && !validateRuleJson({ status: 'template', params: { action: 'sell' } }).ok
    && !validateRuleJson({ status: 'template', scope: { kind: 'all', exclude: '600519' } }).ok
    && !validateRuleJson({ status: 'template', scope: { kind: 'all', symbol: '600519' } }).ok
    && !validateRuleJson({ status: 'template', template_id: 'no_buy_on_surge', params: { days: 3 } }).ok);
  const two = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 5, comparator: 'gt' }, sym('600519')), '600519、300750 当天涨幅超过5%不买');
  check('范围·多个代码 → 暂不支持（multi_symbol）', two.status === 'unsupported' && codes(two).includes('multi_symbol'), JSON.stringify(two).slice(0, 200));
  const excl = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 5, comparator: 'gt' }, sym('600519')), '除了 600519，当天涨幅超过5%不买');
  check('范围·排除某个代码 → 暂不支持（scope_exclude）', excl.status === 'unsupported' && codes(excl).includes('scope_exclude'));
  const wide = resolveRuleIntent(scoped('no_buy_on_surge', { threshold_pct: 5, comparator: 'gt' }, sym('600519')), '600519 跟所有股票一样涨幅超过5%不买');
  check('范围·代码与“所有股票”同时出现 → 需要补充', wide.status === 'unclear' && wide.questions[0].includes('无法确认适用范围'), JSON.stringify(wide).slice(0, 200));
  check('校验：scope.kind 非约定值 / symbol 非字符串 → 拒绝；缺省 scope 允许（null）', !validateRuleJson({ status: 'template', scope: { kind: 'board' } }).ok
    && !validateRuleJson({ status: 'template', scope: { kind: 'symbol', symbol: 600519 } }).ok && validateRuleJson({ status: 'template' }).value.scope === null);
}

/* ==== recognizeRule：出站与失败原因 ==== */
{
  const calls = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchOk = async (url, options) => { calls.push({ url, options }); return reply(200, { rawText: JSON.stringify({ status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct: 5, comparator: 'gt' }, understanding: 'x' }) }); };
  const r = await recognizeRule('  当天涨幅超过5%的股票我不买  ', { fetchImpl: fetchOk });
  check('识别：同源 POST，body 仅 {"text": 去空白原文}，same-origin', calls.length === 1 && calls[0].url === RULE_INTENT_URL && calls[0].options.method === 'POST'
    && calls[0].options.body === JSON.stringify({ text: '当天涨幅超过5%的股票我不买' }) && calls[0].options.credentials === 'same-origin', JSON.stringify(calls[0]?.options));
  check('识别：成功 → supported 并带回原文 text', r.status === 'supported' && r.text === '当天涨幅超过5%的股票我不买');
  const scopedRaw = JSON.stringify({ status: 'template', template_id: 'no_buy_on_surge', params: { threshold_pct: 3, comparator: 'gt' }, scope: { kind: 'symbol', symbol: '600519' }, understanding: 'x' });
  const rs = await recognizeRule('只针对 600519：当天涨幅超过 3% 不买', { fetchImpl: async () => reply(200, { rawText: scopedRaw }) });
  check('识别：模型返回 scope 且与原文代码一致 → contract-v2 规则', rs.status === 'supported' && rs.parsed.schema === 'contract-v2' && rs.parsed.scope.symbol === '600519');

  const sellRaw = JSON.stringify({ status: 'template', template_id: 'sell_within_after_buy', params: { days: 3, day_unit: 'trading_day' }, understanding: 'x' });
  const rp = await recognizeRule('买入后3个交易日内卖出这只股票时提醒我', { fetchImpl: async () => reply(200, { rawText: sellRaw, protocol: RULE_INTENT_PROTOCOL }) });
  check('识别：服务端返回协议版本 → 买入后卖出规则可生成（动作=卖出）', rp.status === 'supported' && rp.parsed.kind === 'buy_sell_window'
    && rp.parsed.action === 'sell' && rp.parsed.fields.days === 3, JSON.stringify(rp).slice(0, 300));
  const rpOld = await recognizeRule('买入后3个交易日内卖出这只股票时提醒我', { fetchImpl: async () => reply(200, { rawText: sellRaw }) });
  check('识别：旧服务端未返回协议版本 → 不静默启用新规则，提示发布站点函数', rpOld.status === 'unclear' && !rpOld.parsed
    && rpOld.questions[0].includes('仍是旧版本'), JSON.stringify(rpOld).slice(0, 300));
  check('识别：涨幅规则不要求协议版本（旧规则兼容）', r.status === 'supported' && !r.parsed.kind.includes('buy_sell'));

  const pre = await recognizeRule('账户 1234567890', { fetchImpl: fetchOk });
  check('识别：预检失败不发请求', pre.status === 'error' && pre.stage === 'precheck' && calls.length === 1);

  const noKey = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => reply(503, { ok: false, code: 'E_MODEL_NOT_CONFIGURED', message: 'x' }) });
  check('识别：503 未配置 → 提示 DEEPSEEK_API_KEY', noKey.status === 'error' && noKey.code === 'E_MODEL_NOT_CONFIGURED' && noKey.message.includes('DEEPSEEK_API_KEY') && noKey.httpStatus === 503);
  const notFound = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => ({ ok: false, status: 404, json: async () => { throw new Error('html'); } }) });
  check('识别：404 非 JSON → E_RULE_SERVICE_STATUS 且说明 HTTP 404', notFound.code === C.STATUS && notFound.message.includes('HTTP 404'));
  const fnMissing = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => reply(404, { ok: false, code: 'E_FUNCTION_NOT_FOUND' }) });
  check('识别：函数旧版本（无 /api/llm/rule）→ 提示需发布新版本', fnMissing.message.includes('尚未发布'));
  const net = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  check('识别：网络异常 → E_RULE_NETWORK', net.code === C.NETWORK);
  const slow = await recognizeRule('涨幅超过5%不买', {
    timeoutMs: 10,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  check('识别：超时 → E_RULE_TIMEOUT', slow.code === C.TIMEOUT);
  const notJson = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => reply(200, { rawText: 'function(){}' }) });
  check('识别：模型返回非 JSON → E_RULE_JSON_INVALID（不执行）', notJson.status === 'error' && notJson.code === C.JSON);
  const badShape = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => reply(200, { rawText: '{"status":"template","params":{"threshold_pct":"5"}}' }) });
  check('识别：模型 JSON 字段类型不符 → E_RULE_SCHEMA_INVALID', badShape.code === C.SCHEMA);
  const noRaw = await recognizeRule('涨幅超过5%不买', { fetchImpl: async () => reply(200, { answer: 1 }) });
  check('识别：响应缺 rawText → E_RULE_RESPONSE_INVALID', noRaw.code === C.RESPONSE);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
