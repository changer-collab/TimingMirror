#!/usr/bin/env node
/**
 * 独立问答页意图路由 —— 离线单测（不调用模型/行情/网络）
 *
 * 覆盖：12 类意图代表问法、规则优先级、五个既有芯片、L2 命中/低置信度/失败降级、
 *       槽位提取与问题归一化。
 * 运行：node tests/ui/qa-intent.test.mjs（或 npm run check）
 */
import {
  QA_SUGGESTIONS,
  QA_INTENT_LABELS,
  MIN_L2_CONFIDENCE,
  normalizeQuestion,
  extractSlots,
  routeQuestion,
  createIntentRouter,
} from '../../prototype/user-frontend/qaIntent.js';
import { QA_CHIPS } from '../../src/agent/qaChips.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

/* ==== ① 示例问法与既有芯片一致 ==== */
{
  check('示例问法：共 8 条，前 5 条与既有芯片同题同标签',
    QA_SUGGESTIONS.length === 8
    && QA_SUGGESTIONS.slice(0, 5).every((s, i) => s.question === QA_CHIPS[i].question && s.label === QA_CHIPS[i].label)
    && QA_SUGGESTIONS.filter((s) => s.online).length === 1
    && QA_SUGGESTIONS.find((s) => s.online).id === 'portfolio', JSON.stringify(QA_SUGGESTIONS));
  check('意图标签：12 类均有中文短标签', Object.keys(QA_INTENT_LABELS).length === 12
    && Object.values(QA_INTENT_LABELS).every((v) => typeof v === 'string' && v.length > 0), JSON.stringify(QA_INTENT_LABELS));
}

/* ==== ② 12 类代表问法 ==== */
{
  const cases = [
    ['我最错的一笔是哪个？', 'worst_trade'],
    ['组合整体表现如何？', 'loss_overview'],
    ['为什么说我追高？', 'pattern_explain'],
    ['我是谁？', 'profile'],
    ['如果那笔卖出没发生，会怎样？', 'what_if'],
    ['历史上类似情况怎么样？', 'similar_context'],
    ['我该怎么改？', 'how_to_change'],
    ['帮我定个止损。', 'contract_setup'],
    ['我的规则守得住吗？', 'contract_status'],
    ['这些数字是怎么算出来的？', 'meta_calc'],
    ['这些数可信吗？', 'meta_trust'],
    ['明天买什么？', 'out_of_scope'],
  ];
  for (const [question, intent] of cases) {
    const r = routeQuestion(question);
    check(`路由：${question} → ${intent}`, r.intent === intent && r.layer === 'L1' && r.confidence === 1, JSON.stringify(r));
  }
}

/* ==== ③ 优先级与边界 ==== */
{
  check('优先级：拒绝类先于归因类（明天买什么）', routeQuestion('明天买什么？').intent === 'out_of_scope');
  check('优先级：怎么避免追高 → how_to_change', routeQuestion('怎么避免追高？').intent === 'how_to_change');
  check('优先级：为什么追高 → pattern_explain', routeQuestion('为什么追高？').intent === 'pattern_explain');
  check('优先级：亏损最大的一笔 → worst_trade', routeQuestion('亏损最大的一笔是哪笔？').intent === 'worst_trade');
  check('优先级：我的规则怎么改 → how_to_change', routeQuestion('我的规则怎么改？').intent === 'how_to_change');
  check('优先级：规则守得住吗 → contract_status', routeQuestion('规则守得住吗？').intent === 'contract_status');
  check('优先级：帮我定个止损 → contract_setup', routeQuestion('帮我定个止损。').intent === 'contract_setup');
  check('优先级：收益怎么样 → loss_overview', routeQuestion('收益怎么样？').intent === 'loss_overview');
  check('未命中：帮我看看 → 澄清', (() => {
    const r = routeQuestion('帮我看看');
    return r.intent === null && r.ambiguous === true && r.layer === 'L3';
  })());
}

/* ==== ④ 既有芯片：有无标点都命中，带 chip_id ==== */
{
  for (const chip of QA_CHIPS) {
    const withMark = routeQuestion(chip.question);
    const withoutMark = routeQuestion(chip.question.replace(/[？?]$/u, ''));
    check(`芯片：${chip.id} 精确问题命中且带 chip_id`,
      withMark.intent === chip.intent && withMark.chip_id === chip.id
      && withoutMark.intent === chip.intent && withoutMark.matchedBy === 'chip', JSON.stringify({ withMark, withoutMark }));
  }
}

/* ==== ⑤ 归一化与槽位 ==== */
{
  const long = '问'.repeat(260);
  check('归一化：合并空白、去尾部标点、截断 200',
    normalizeQuestion('  我   最错的一笔是哪个？  ') === '我 最错的一笔是哪个'
    && normalizeQuestion('组合怎么样。。。') === '组合怎么样'
    && normalizeQuestion(long).length === 200
    && normalizeQuestion('   ') === '', JSON.stringify({ a: normalizeQuestion('  我   最错的一笔是哪个？  '), b: normalizeQuestion(long).length }));
  const slots = extractSlots('如果 2024-10-9 卖出 600519 那笔没发生会怎样');
  check('槽位：日期补零、6 位代码提取',
    slots.trade_date === '2024-10-09' && slots.symbol === '600519', JSON.stringify(slots));
  const noDate = extractSlots('如果那笔卖出没发生');
  check('槽位：无日期/代码时为空', Object.keys(noDate).length === 0, JSON.stringify(noDate));
  const r = routeQuestion('如果那笔卖出没发生会怎样？');
  check('what_if：只有“那笔”时标记 ambiguousTrade', r.intent === 'what_if' && r.ambiguousTrade === true, JSON.stringify(r));
  const withDate = routeQuestion('如果 2024-10-9 那笔卖出没发生会怎样？');
  check('what_if：带日期时不标记 ambiguousTrade', withDate.intent === 'what_if' && !withDate.ambiguousTrade, JSON.stringify(withDate));
}

/* ==== ⑥ L2：仅 L1 未命中时调用；低置信度/失败降级为澄清 ==== */
{
  let calls = [];
  const router = createIntentRouter({
    classifyIntent: async ({ question }) => {
      calls.push(question);
      return { ok: true, intentJson: { intent: 'loss_overview', slots: {}, confidence: 0.9 } };
    },
  });
  const hit = await router.route('帮我看看这个账户');
  check('L2：未命中 → 在线意图命中 loss_overview（layer L2）',
    hit.intent === 'loss_overview' && hit.layer === 'L2' && hit.confidence === 0.9 && calls.length === 1, JSON.stringify(hit));

  const boundaryRouter = createIntentRouter({
    classifyIntent: async () => ({
      ok: true,
      stage: 'intent',
      data: { intentJson: { intent: 'loss_overview', slots: {}, confidence: 0.88 } },
    }),
  });
  const boundaryHit = await boundaryRouter.route('帮我看看这个账户');
  check('L2：兼容 onlineBoundary 的 data.intentJson 返回形状',
    boundaryHit.intent === 'loss_overview' && boundaryHit.layer === 'L2' && boundaryHit.confidence === 0.88,
    JSON.stringify(boundaryHit));

  calls = [];
  const refusal = await router.route('明天买什么？');
  check('L2：L1 拒绝类不调用 classifier', refusal.intent === 'out_of_scope' && calls.length === 0, JSON.stringify({ refusal, calls }));

  const lowRouter = createIntentRouter({
    classifyIntent: async () => ({ ok: true, intentJson: { intent: 'profile', slots: {}, confidence: MIN_L2_CONFIDENCE - 0.2 } }),
  });
  const low = await lowRouter.route('帮我看看这个账户');
  check('L2：低置信度 → 澄清并说明未发送账单/事实',
    low.intent === null && low.ambiguous === true && low.layer === 'L2'
    && low.notice.includes('置信度不足') && low.notice.includes('账单与事实没有发送'), JSON.stringify(low));

  const failRouter = createIntentRouter({
    classifyIntent: async () => ({ ok: false, code: 'E_INTENT_DOWN' }),
  });
  const failed = await failRouter.route('帮我看看这个账户');
  check('L2：分类失败 → 澄清并说明未发送',
    failed.intent === null && failed.ambiguous === true
    && failed.notice.includes('未就绪') && failed.notice.includes('没有发送'), JSON.stringify(failed));

  const throwRouter = createIntentRouter({
    classifyIntent: async () => { throw new Error('network'); },
  });
  const thrown = await throwRouter.route('帮我看看这个账户');
  check('L2：抛错 → 澄清，不向上冒泡', thrown.intent === null && thrown.ambiguous === true, JSON.stringify(thrown));

  const noL2 = createIntentRouter();
  const none = await noL2.route('帮我看看这个账户');
  check('L2：未注入 classifier → 保持在 L3 澄清', none.intent === null && none.layer === 'L3', JSON.stringify(none));

  const slotRouter = createIntentRouter({
    classifyIntent: async () => ({ ok: true, intentJson: { intent: 'what_if', slots: { trade_date: '2024-9-3', symbol: '000001' }, confidence: 0.8 } }),
  });
  const slotHit = await slotRouter.route('帮我看看这笔操作');
  check('L2：槽位归一化（日期补零/代码保留）',
    slotHit.intent === 'what_if' && slotHit.slots.trade_date === '2024-09-03' && slotHit.slots.symbol === '000001', JSON.stringify(slotHit));

  const extraSlotRouter = createIntentRouter({
    classifyIntent: async () => ({
      ok: true,
      intentJson: {
        intent: 'pattern_explain',
        slots: { pattern: 'chase_high_buy', possible_cause: '情绪', symbol: '600519' },
        confidence: 0.82,
      },
    }),
  });
  const extraSlotHit = await extraSlotRouter.route('为什么我会反复这样');
  check('L2：未声明槽位（pattern/possible_cause）被丢弃，仅保留 symbol',
    extraSlotHit.intent === 'pattern_explain'
    && Object.keys(extraSlotHit.slots).join(',') === 'symbol'
    && extraSlotHit.slots.symbol === '600519', JSON.stringify(extraSlotHit));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` :: ${r.detail}`}`);
}
console.log(`\nqa-intent：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
