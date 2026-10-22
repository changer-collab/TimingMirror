#!/usr/bin/env node
/**
 * 规则模拟未匹配 AI 兜底 —— 离线单测（fake transport；不调用真实模型/行情）
 *
 * 覆盖：规则命中时不调用 AI；无锁定规则但情景有效时仍调用；
 *       情景判断请求包含完整情景与规则状态；binding 有效/缺失/不匹配校验；
 *       AI 失败不覆盖规则、不写规则记录。
 * 运行：node tests/agent/rule-fallback.test.mjs
 */
import {
  pickScenarioForJudgment,
  buildScenarioJudgmentRequest,
  validateScenarioJudgmentResponse,
  createRuleFallback,
  ruleSetHash,
  RULE_FALLBACK_CODES,
} from '../../src/agent/ruleFallback.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const RULE = {
  hash: 'a1b2c3d4e5f60708',
  v: 2,
  template_id: 'no_buy_on_surge',
  fields: { threshold_pct: 10 },
  scope: { kind: 'all' },
  parsed: { kind: 'change_pct_threshold' },
  integrity: { ok: true },
};
const RULE2 = {
  hash: 'b1b2c3d4e5f60708',
  v: 1,
  template_id: 'no_buy_back_within',
  fields: { days: 3 },
  scope: { kind: 'symbol', symbol: '300750' },
  parsed: { kind: 'sell_buyback_window' },
  integrity: { ok: true },
};
const baseSimulation = (overrides = {}) => ({
  marketSourceId: 'dynamic-tushare',
  symbol: '300750',
  requested_date: '2025-05-13',
  scenario_action: 'buy',
  summary: { triggered: 0, not_triggered: 1, missing_data: 0, not_applicable: 0, error: 0 },
  results: [{
    display_verdict: 'not_triggered',
    verdict: 'not_triggered',
    symbol: '300750',
    requested_date: '2025-05-13',
    change: { effective_date: '2025-05-13', change_pct: 0.0069 },
    code: null,
    message: '未触发',
    rule: { hash: RULE.hash },
  }],
  ...overrides,
});

/* ==== 选择条件 ==== */
{
  const picked = pickScenarioForJudgment({ simulation: baseSimulation(), currentRules: [RULE] });
  check('未匹配锁定规则：允许 AI 判断', picked.ok === true && picked.scenario.symbol === '300750'
    && picked.scenario.requested_date === '2025-05-13' && picked.scenario.effective_date === '2025-05-13'
    && picked.scenario.change_pct === 0.0069, JSON.stringify(picked));

  const hit = baseSimulation({ summary: { triggered: 1, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 0 } });
  const hitPick = pickScenarioForJudgment({ simulation: hit, currentRules: [RULE] });
  check('已有锁定规则命中：不调用 AI', hitPick.ok === false && hitPick.code === RULE_FALLBACK_CODES.RULE_HIT, JSON.stringify(hitPick));

  const noRules = pickScenarioForJudgment({ simulation: baseSimulation(), currentRules: [] });
  check('没有锁定规则但情景有效：仍允许 AI 解释“无可匹配规则”', noRules.ok === true && noRules.currentRules.length === 0, JSON.stringify(noRules));

  const noScenario = pickScenarioForJudgment({
    simulation: { summary: { triggered: 0, not_triggered: 0, missing_data: 1, not_applicable: 0, error: 0 }, results: [] },
    currentRules: [RULE],
  });
  check('没有标的/日期：不调用 AI（不猜测）', noScenario.ok === false && noScenario.code === RULE_FALLBACK_CODES.NO_JUDGEABLE_SCENARIO, JSON.stringify(noScenario));
}

/* ==== 请求构造 ==== */
{
  const sim = baseSimulation();
  const built = buildScenarioJudgmentRequest({ simulation: sim, currentRules: [RULE, RULE2], runId: 'run-test-1' });
  check('请求：使用 scenario_judgment，含情景、规则状态与集合哈希', built.ok
    && built.request.stage === 'scenario_judgment'
    && built.request.scenario.symbol === '300750'
    && built.request.scenario.rules.length === 2
    && built.request.scenario.rules[0].template_id === 'no_buy_on_surge'
    && built.request.scenario.rules[0].fields.threshold_pct === 10
    && built.request.scenario.rules[1].scope.symbol === '300750'
    && built.request.rule_set_hash === ruleSetHash([RULE.hash, RULE2.hash]), JSON.stringify(built));

  const noRules = buildScenarioJudgmentRequest({ simulation: sim, currentRules: [], runId: 'run-test-1' });
  check('请求：没有锁定规则时不跳过，rules=[] 仍可调用', noRules.ok === true
    && noRules.request.scenario.rules.length === 0
    && noRules.request.rule_set_hash === ruleSetHash([]), JSON.stringify(noRules));

  const hit = baseSimulation({ summary: { triggered: 1, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 0 } });
  const hitBuilt = buildScenarioJudgmentRequest({ simulation: hit, currentRules: [RULE], runId: 'run-test-1' });
  check('请求：规则命中时本地拒绝，不进入 AI', hitBuilt.ok === false && hitBuilt.code === RULE_FALLBACK_CODES.RULE_HIT);
}

/* ==== 响应绑定校验 ==== */
{
  const sim = baseSimulation();
  const built = buildScenarioJudgmentRequest({ simulation: sim, currentRules: [RULE], runId: 'run-test-2' });
  const expected = built.expected;
  const valid = { judgment: 'no_match', answer_text: '本次情景没有匹配任何已锁定规则；规则结果仍以本地判定为准。', binding: expected };
  const ok = validateScenarioJudgmentResponse(JSON.stringify(valid), expected);
  check('响应：有效 binding 通过', ok.ok === true && ok.judgment === 'no_match' && ok.binding.rule_set_hash === expected.rule_set_hash, JSON.stringify(ok));

  const missing = { judgment: 'no_match', answer_text: valid.answer_text };
  const missingOut = validateScenarioJudgmentResponse(JSON.stringify(missing), expected);
  check('响应：缺少 binding 被拒绝', missingOut.ok === false && missingOut.code === RULE_FALLBACK_CODES.BINDING_MISMATCH, JSON.stringify(missingOut));

  const mismatched = { ...valid, binding: { ...expected, scenario_id: 'scenario-other' } };
  const mismatchedOut = validateScenarioJudgmentResponse(JSON.stringify(mismatched), expected);
  check('响应：binding 不匹配被拒绝', mismatchedOut.ok === false && mismatchedOut.code === RULE_FALLBACK_CODES.BINDING_MISMATCH, JSON.stringify(mismatchedOut));

  const claimed = { ...valid, judgment: 'matched' };
  const claimedOut = validateScenarioJudgmentResponse(JSON.stringify(claimed), expected);
  check('响应：AI 声称命中被拒绝，不能覆盖规则', claimedOut.ok === false && claimedOut.code === RULE_FALLBACK_CODES.RESPONSE_INVALID, JSON.stringify(claimedOut));

  const unsafe = { ...valid, answer_text: '建议买入，明天会涨。' };
  const unsafeOut = validateScenarioJudgmentResponse(JSON.stringify(unsafe), expected);
  check('响应：建议/预测内容被拒绝', unsafeOut.ok === false && unsafeOut.code === RULE_FALLBACK_CODES.RESPONSE_INVALID, JSON.stringify(unsafeOut));
}

/* ==== 客户端调用：失败不覆盖规则、不持久化 ==== */
{
  const sim = baseSimulation();
  const calls = [];
  const fallback = createRuleFallback({
    transport: {
      async scenarioJudgment(request) {
        calls.push(request);
        return {
          rawText: JSON.stringify({
            judgment: 'no_match',
            answer_text: '本次情景没有匹配任何已锁定规则；仅解释未匹配原因。',
            binding: {
              flow_id: request.flow_id,
              request_id: request.request_id,
              scenario_id: request.scenario_id,
              rule_set_hash: request.rule_set_hash,
            },
          }),
        };
      },
    },
    timeoutMs: 1000,
  });
  const rulesBefore = JSON.stringify([RULE, RULE2]);
  const judged = await fallback.judgeScenario({ simulation: sim, currentRules: [RULE, RULE2], runId: 'run-test-3' });
  check('调用：只调用一次情景判断，返回正文与 binding', judged.ok === true && calls.length === 1
    && judged.answer_text.includes('没有匹配') && judged.binding.scenario_id === calls[0].scenario_id, JSON.stringify(judged));
  check('边界：AI 判断不修改规则对象', JSON.stringify([RULE, RULE2]) === rulesBefore);
  check('边界：请求不含成交行/文件名/账户', !JSON.stringify(calls[0]).includes('browser-')
    && !JSON.stringify(calls[0]).includes('trade_id') && !JSON.stringify(calls[0]).includes('account'), JSON.stringify(calls[0]));

  const noRules = await fallback.judgeScenario({ simulation: sim, currentRules: [], runId: 'run-test-4' });
  check('调用：没有锁定规则时仍会请求 AI 判断', noRules.ok === true && calls.length === 2
    && calls[1].scenario.rules.length === 0, JSON.stringify({ noRules, calls: calls.length }));

  const hit = baseSimulation({ summary: { triggered: 1, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 0 } });
  const callsBeforeHit = calls.length;
  const hitResult = await fallback.judgeScenario({ simulation: hit, currentRules: [RULE], runId: 'run-test-5' });
  check('规则命中：不调用 AI', hitResult.ok === false && hitResult.code === RULE_FALLBACK_CODES.RULE_HIT
    && calls.length === callsBeforeHit, JSON.stringify(hitResult));

  const missingBinding = createRuleFallback({
    transport: { async scenarioJudgment() { return { rawText: JSON.stringify({ judgment: 'no_match', answer_text: '未匹配。' }) }; } },
    timeoutMs: 1000,
  });
  const missingOut = await missingBinding.judgeScenario({ simulation: sim, currentRules: [RULE], runId: 'run-test-6' });
  check('缺 binding：客户端拒绝成功响应', missingOut.ok === false && missingOut.code === RULE_FALLBACK_CODES.BINDING_MISMATCH, JSON.stringify(missingOut));

  const unavailable = createRuleFallback({ transport: null });
  const failed = await unavailable.judgeScenario({ simulation: sim, currentRules: [RULE], runId: 'run-test-7' });
  check('未配置接口：不发起调用', failed.ok === false && failed.code === RULE_FALLBACK_CODES.UNAVAILABLE, JSON.stringify(failed));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
