#!/usr/bin/env node
/**
 * 自定义规则情境判定客户端模块测试（构造请求 / 校验响应 / 超时与失败回退；不联网）。
 * 运行：node tests/agent/custom-rule-judgment.test.mjs
 */
import {
  buildCustomRuleJudgmentRequest,
  validateCustomRuleJudgmentResult,
  createCustomRuleJudgment,
  CUSTOM_RULE_JUDGMENT_CODES,
} from '../../src/agent/customRuleJudgment.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const entry = {
  ok: true,
  verdict: 'custom_pending',
  display_verdict: 'custom_pending',
  scenario_action: 'buy',
  symbol: '000000',
  requested_date: '2024-10-09',
  rule: {
    hash: '47a10ba4d26648cf',
    short_hash: '47a10ba4',
    v: 2,
    status: '已确认',
    text: '买入前核对自己的交易计划',
    template_id: null,
    template_name: '自定义规则',
    fields_text: '',
    schema: 'custom-v1',
    scope: { kind: 'all' },
    scope_text: '全部股票',
    timing: '',
    action: 'buy',
    action_label: '买入提醒',
    kind: 'custom',
    rule_id: 'nl-abc123',
  },
  custom: {
    status: 'pending',
    data: {
      symbol: '000000',
      requested_date: '2024-10-09',
      effective_date: '2024-10-09',
      change_pct: 0.042,
      market_label: 'Tushare 动态日线',
      buys: ['2024-09-27'],
      sells: [],
      trading_days: ['2024-10-08', '2024-10-09'],
      calendar_truncated: false,
    },
  },
};

/* —— 请求构造：只含规则身份与最小数据，附 binding 期望 —— */
{
  const built = buildCustomRuleJudgmentRequest({ entry, runId: 'run-1' });
  check('构造：请求通过本地检查，字段齐备且不含价格/金额/其他标的',
    built.ok
    && built.request.stage === 'custom_rule_judgment'
    && built.request.rule.text === '买入前核对自己的交易计划'
    && built.request.rule.rule_id === 'nl-abc123'
    && built.request.rule.version === 2
    && built.request.scenario.action === 'buy'
    && built.request.scenario.change_pct === 0.042
    && built.request.data.buys.join() === '2024-09-27'
    && !JSON.stringify(built.request).includes('price') && !JSON.stringify(built.request).includes('amount'),
    JSON.stringify(built.request ?? built));
  check('构造：expected 绑定含运行、规则身份与情境要素',
    built.expected.flow_id === 'custom-run-1'
    && built.expected.judgment_id === 'custom-run-1-47a10ba4d266'
    && built.expected.rule_hash === '47a10ba4d26648cf'
    && built.expected.rule_version === 2
    && built.expected.scenario_symbol === '000000'
    && built.expected.scenario_requested_date === '2024-10-09', JSON.stringify(built.expected ?? built));
}

/* —— 请求构造失败：缺数据 / 字段非法 —— */
{
  const noData = buildCustomRuleJudgmentRequest({ entry: { rule: entry.rule }, runId: 'run-1' });
  check('构造：缺少情境数据 → 不发起判定', !noData.ok && noData.code === CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, JSON.stringify(noData));
  const badRule = buildCustomRuleJudgmentRequest({ entry: { ...entry, rule: { ...entry.rule, hash: 'nothex' } }, runId: 'run-1' });
  check('构造：规则哈希非法 → 不发起判定', !badRule.ok && badRule.code === CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, JSON.stringify(badRule));
  const badText = buildCustomRuleJudgmentRequest({ entry: { ...entry, rule: { ...entry.rule, text: '长'.repeat(201) } }, runId: 'run-1' });
  check('构造：规则原文超 200 字 → 不发起判定', !badText.ok && badText.code === CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, JSON.stringify(badText));
  const badScope = buildCustomRuleJudgmentRequest({ entry: { ...entry, rule: { ...entry.rule, scope: { kind: 'symbol', symbol: '60051' } } }, runId: 'run-1' });
  check('构造：范围代码非法 → 不发起判定', !badScope.ok && badScope.code === CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID, JSON.stringify(badScope));
}

/* —— 响应校验：合法 / 绑定不一致 / 越界内容 / 字段非法 —— */
{
  const expected = buildCustomRuleJudgmentRequest({ entry, runId: 'run-1' }).expected;
  const ok = validateCustomRuleJudgmentResult(JSON.stringify({
    verdict: 'triggered',
    reason: '按规则原文与给定数据，该情境应提醒。',
    used_data: ['change_pct'],
    binding: { ...expected },
  }), expected);
  check('校验：合法响应通过', ok.ok && ok.verdict === 'triggered' && ok.used_data.join() === 'change_pct', JSON.stringify(ok));
  const mismatch = validateCustomRuleJudgmentResult(JSON.stringify({
    verdict: 'triggered', reason: 'x'.repeat(5), used_data: [],
    binding: { ...expected, judgment_id: 'custom-run-2-47a10ba4d266' },
  }), expected);
  check('校验：绑定不一致（旧运行的结果）→ 丢弃', !mismatch.ok && mismatch.code === CUSTOM_RULE_JUDGMENT_CODES.BINDING_MISMATCH, JSON.stringify(mismatch));
  const staleRule = validateCustomRuleJudgmentResult(JSON.stringify({
    verdict: 'triggered', reason: 'x'.repeat(5), used_data: [],
    binding: { ...expected, rule_version: 1 },
  }), expected);
  check('校验：规则版本不一致（旧版本的结果）→ 丢弃', !staleRule.ok && staleRule.code === CUSTOM_RULE_JUDGMENT_CODES.BINDING_MISMATCH, JSON.stringify(staleRule));
  const unsafe = validateCustomRuleJudgmentResult(JSON.stringify({
    verdict: 'not_triggered', reason: '建议卖出其他股票', used_data: [],
    binding: { ...expected },
  }), expected);
  check('校验：越界内容（买卖建议）→ 丢弃', !unsafe.ok && unsafe.code === CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, JSON.stringify(unsafe));
  const badVerdict = validateCustomRuleJudgmentResult(JSON.stringify({
    verdict: 'no_match', reason: 'x', used_data: [], binding: { ...expected },
  }), expected);
  check('校验：verdict 非法 → 丢弃（不得当作未命中）', !badVerdict.ok && badVerdict.code === CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, JSON.stringify(badVerdict));
}

/* —— 客户端：成功 / 服务失败 / 超时 / 响应无效 —— */
{
  const expected = buildCustomRuleJudgmentRequest({ entry, runId: 'run-1' }).expected;
  const judge = createCustomRuleJudgment({
    transport: {
      async customRuleJudgment(req) {
        const binding = {
          flow_id: req.flow_id, request_id: req.request_id, judgment_id: req.judgment_id,
          rule_id: req.rule.rule_id, rule_hash: req.rule.hash, rule_version: req.rule.version, rule_action: req.rule.action,
          scenario_symbol: req.scenario.symbol, scenario_requested_date: req.scenario.requested_date, scenario_action: req.scenario.action,
        };
        return { rawText: JSON.stringify({ verdict: 'unable', reason: '缺少持仓数据。', used_data: [], binding }) };
      },
    },
  });
  const ok = await judge.judgeRule({ entry, runId: 'run-1' });
  check('客户端：unable 判定原样通过（页面显示“无法判断”）', ok.ok && ok.verdict === 'unable' && ok.binding.rule_hash === expected.rule_hash, JSON.stringify(ok));

  const down = createCustomRuleJudgment({ transport: { async customRuleJudgment() { throw new Error('x'); } } });
  const failed = await down.judgeRule({ entry, runId: 'run-1' });
  check('客户端：服务不可用 → 失败码，不当作未命中', !failed.ok && failed.code === CUSTOM_RULE_JUDGMENT_CODES.UNAVAILABLE, JSON.stringify(failed));

  const upstream = createCustomRuleJudgment({
    transport: { async customRuleJudgment() { const e = new Error('x'); e.upstreamCode = 'E_MODEL_NOT_CONFIGURED'; e.upstreamMessage = '模型未启用'; throw e; } },
  });
  const cfg = await upstream.judgeRule({ entry, runId: 'run-1' });
  check('客户端：上游错误码透传（模型未启用）', !cfg.ok && cfg.code === 'E_MODEL_NOT_CONFIGURED' && cfg.message === '模型未启用', JSON.stringify(cfg));

  const bad = createCustomRuleJudgment({ transport: { async customRuleJudgment() { return { rawText: 'not-json' }; } } });
  const invalid = await bad.judgeRule({ entry, runId: 'run-1' });
  check('客户端：响应无效 → 失败码', !invalid.ok && invalid.code === CUSTOM_RULE_JUDGMENT_CODES.RESPONSE_INVALID, JSON.stringify(invalid));

  const noTransport = createCustomRuleJudgment({ transport: null });
  const unconfigured = await noTransport.judgeRule({ entry, runId: 'run-1' });
  check('客户端：接口未配置 → 失败码', !unconfigured.ok && unconfigured.code === CUSTOM_RULE_JUDGMENT_CODES.UNAVAILABLE, JSON.stringify(unconfigured));
}

const failedCases = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`);
console.log(`custom-rule-judgment-client: ${results.length - failedCases.length}/${results.length}`);
if (failedCases.length) process.exit(1);
