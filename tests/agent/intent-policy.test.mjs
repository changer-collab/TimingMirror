#!/usr/bin/env node
/**
 * 意图策略 —— 离线单测（分类器为合成桩；不联网）
 *
 * 覆盖：芯片零模型调用、自由输入模型优先、超时/失败/非法/低置信回落本地、
 *       本地与模型冲突时以本地为准、置信度阈值、槽位白名单与合并。
 * 运行：node tests/agent/intent-policy.test.mjs（或 npm run check）
 */
import {
  createIntentPolicy,
  INTENT_TIMEOUT_MS,
  INTENT_MIN_CONFIDENCE,
  INTENT_AGREEMENT_CONFIDENCE,
  INTENT_FALLBACK_LABELS,
} from '../../src/agent/intentPolicy.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };

const LOCAL_WORST = {
  intent: 'worst_trade', slots: {}, layer: 'L1', source: 'L1', confidence: 1, matchedBy: 'rule',
};
const LOCAL_LOSS = {
  intent: 'loss_overview', slots: {}, layer: 'L1', source: 'L1', confidence: 1, matchedBy: 'rule',
};
const model = (intent, confidence = 0.9, slots = {}) => ({ ok: true, intentJson: { intent, slots, confidence } });

/* ==== ① 阈值与文案冻结 ==== */
{
  check('阈值：超时 2500ms / 最低置信 0.6 / 一致阈值 0.8',
    INTENT_TIMEOUT_MS === 2500 && INTENT_MIN_CONFIDENCE === 0.6 && INTENT_AGREEMENT_CONFIDENCE === 0.8,
    JSON.stringify({ INTENT_TIMEOUT_MS, INTENT_MIN_CONFIDENCE, INTENT_AGREEMENT_CONFIDENCE }));
  check('回落文案：每个原因都有中文说明',
    ['chip', 'local', 'timeout', 'unavailable', 'invalid', 'low_confidence', 'conflict'].every((key) => typeof INTENT_FALLBACK_LABELS[key] === 'string' && INTENT_FALLBACK_LABELS[key].length > 0),
    JSON.stringify(INTENT_FALLBACK_LABELS));
}

/* ==== ② 芯片：只用本地，零模型调用 ==== */
{
  let calls = 0;
  const policy = createIntentPolicy({
    classifyLocal: () => ({ ...LOCAL_LOSS, matchedBy: 'chip', chip_id: 'portfolio' }),
    classifyIntent: async () => { calls += 1; return model('loss_overview'); },
  });
  const d = await policy.decide({ question: '组合整体表现如何？', source: 'chip' });
  check('芯片：intent/L1/chip_id，未调用模型', d.ok && d.intent === 'loss_overview'
    && d.route.layer === 'L1' && d.route.chip_id === 'portfolio'
    && d.model_called === false && d.local_check === 'chip' && d.latency_ms === 0 && calls === 0, JSON.stringify(d));
}

/* ==== ③ 自由输入：模型优先，本地未命中时采用模型 ==== */
{
  const c = clock();
  let seen = null;
  const policy = createIntentPolicy({
    classifyLocal: () => ({ intent: null, slots: {}, layer: 'L3', source: 'L3', confidence: null, ambiguous: true }),
    classifyIntent: async (args) => { seen = args; c.tick(120); return model('loss_overview', 0.88); },
    now: c.now,
  });
  const d = await policy.decide({ question: '帮我看看这个账户', source: 'typed' });
  check('模型优先：本地未命中 → 采用模型意图（layer L2）', d.ok && d.intent === 'loss_overview'
    && d.route.layer === 'L2' && d.decided_by === 'model' && d.local_check === 'model_only'
    && d.model_called === true && d.latency_ms === 120, JSON.stringify(d));
  check('模型优先：分类器收到问题与可取消信号', seen?.question === '帮我看看这个账户' && !!seen?.signal, JSON.stringify(seen));
}

/* ==== ④ 超时 / 失败 / 非法 / 低置信：回落本地，不猜测 ==== */
{
  const c = clock();
  let signal = null;
  const timeoutPolicy = createIntentPolicy({
    classifyLocal: () => ({ intent: null, slots: {}, layer: 'L3', source: 'L3', confidence: null }),
    classifyIntent: ({ signal: s }) => { signal = s; return new Promise(() => {}); },
    timeoutMs: 10,
    now: c.now,
  });
  const timedOut = await timeoutPolicy.decide({ question: '帮我看看这个账户' });
  check('超时：回落澄清并说明没有猜测', timedOut.ok === false && timedOut.intent === null
    && timedOut.model_called === true && timedOut.local_check === 'timeout'
    && timedOut.route.notice.includes('没有据此猜测'), JSON.stringify(timedOut));
  check('超时：取消正在进行的模型请求', signal?.aborted === true, String(signal?.aborted));

  const failPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => ({ ok: false, code: 'E_INTENT_DOWN' }),
  });
  const failed = await failPolicy.decide({ question: '帮我看看' });
  check('失败：回落澄清，不算模型命中', failed.ok === false && failed.local_check === 'unavailable'
    && failed.model_called === true && failed.route.notice.includes('账单与事实没有发送'), JSON.stringify(failed));

  const unknownPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => model('market_forecast', 0.99),
  });
  const unknown = await unknownPolicy.decide({ question: '帮我看看' });
  check('非法意图：schema 外类别不进入回答', unknown.ok === false && unknown.local_check === 'invalid', JSON.stringify(unknown));

  const tooHighPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => model('loss_overview', 1.5),
  });
  const tooHigh = await tooHighPolicy.decide({ question: '帮我看看' });
  check('非法置信度：超出 [0,1] 视为不合规', tooHigh.ok === false && tooHigh.local_check === 'invalid', JSON.stringify(tooHigh));

  const lowPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => model('profile', 0.4),
  });
  const low = await lowPolicy.decide({ question: '帮我看看' });
  check('低置信：回落澄清且不采用模型意图', low.ok === false && low.intent === null
    && low.local_check === 'low_confidence' && low.model_intent === 'profile', JSON.stringify(low));

  const nonePolicy = createIntentPolicy({ classifyLocal: () => null });
  const none = await nonePolicy.decide({ question: '帮我看看' });
  check('未注入分类器：不请求网络，保持澄清', none.ok === false && none.model_called === false
    && none.local_check === 'unavailable' && none.route.notice.includes('账单与事实没有发送'), JSON.stringify(none));
}

/* ==== ⑤ 本地与模型冲突：以本地为准；一致时合并槽位 ==== */
{
  const conflictPolicy = createIntentPolicy({
    classifyLocal: () => LOCAL_WORST,
    classifyIntent: async () => model('loss_overview', 0.95),
  });
  const conflict = await conflictPolicy.decide({ question: '我最错的一笔是哪个？' });
  check('冲突：本地规则优先，模型意图只记录不采用', conflict.ok && conflict.intent === 'worst_trade'
    && conflict.route.layer === 'L1' && conflict.local_check === 'conflict'
    && conflict.model_intent === 'loss_overview' && conflict.model_called === true, JSON.stringify(conflict));

  const agreePolicy = createIntentPolicy({
    classifyLocal: () => ({
      intent: 'what_if', slots: { trade_date: '2024-09-30' }, layer: 'L1', source: 'L1', confidence: 1,
    }),
    classifyIntent: async () => model('what_if', 0.9, { symbol: '600519', trade_date: '2024-1-2', pattern: 'chase_high_buy' }),
  });
  const agree = await agreePolicy.decide({ question: '如果 2024-9-30 那笔卖出没发生，会怎样？' });
  check('一致：采用模型置信度并合并槽位（本地日期优先）', agree.ok && agree.route.layer === 'L2'
    && agree.local_check === 'agree' && agree.route.confidence === 0.9
    && agree.slots.symbol === '600519' && agree.slots.trade_date === '2024-09-30'
    && !('pattern' in agree.slots), JSON.stringify(agree));

  const agreeLowPolicy = createIntentPolicy({
    classifyLocal: () => LOCAL_LOSS,
    classifyIntent: async () => model('loss_overview', 0.7),
  });
  const agreeLow = await agreeLowPolicy.decide({ question: '组合整体表现如何？' });
  check('一致但置信度不足 0.8：仍采用并标记 agree_low', agreeLow.ok && agreeLow.local_check === 'agree_low'
    && agreeLow.intent === 'loss_overview' && agreeLow.route.layer === 'L2', JSON.stringify(agreeLow));
}

/* ==== ⑥ 槽位白名单与 what_if 指代 ==== */
{
  const slotPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => model('what_if', 0.8, { symbol: ' 000001 ', trade_date: '2024-9-3', possible_cause: '情绪' }),
  });
  const slot = await slotPolicy.decide({ question: '如果那笔卖出没发生' });
  check('槽位：代码/日期归一化，未声明字段丢弃', slot.slots.symbol === '000001'
    && slot.slots.trade_date === '2024-09-03' && Object.keys(slot.slots).sort().join(',') === 'symbol,trade_date',
    JSON.stringify(slot));

  const badSlotPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => model('what_if', 0.8, { symbol: 'abc', trade_date: '下周' }),
  });
  const badSlot = await badSlotPolicy.decide({ question: '如果那笔卖出没发生' });
  check('槽位：非法代码/日期被丢弃，不猜年份', Object.keys(badSlot.slots).length === 0, JSON.stringify(badSlot));

  const ambiguousPolicy = createIntentPolicy({
    classifyLocal: () => null,
    classifyIntent: async () => model('what_if', 0.8),
  });
  const ambiguous = await ambiguousPolicy.decide({ question: '如果那笔卖出没发生，会怎样？' });
  check('what_if：模型未给槽位且问题含“那笔” → ambiguousTrade', ambiguous.route.ambiguousTrade === true, JSON.stringify(ambiguous.route));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
