#!/usr/bin/env node
/**
 * 自动重写（answerRewriter）—— 离线单测（fake transport；不联网、不调用真实模型）。
 *
 * 覆盖：成功路径三层与 claim_map、缓存命中与强制重写、4 秒超时可注入、
 *       请求非法/不可用/响应不合格整体回退本地草稿、数字与草稿原文不变。
 * 运行：node tests/agent/answer-rewriter.test.mjs（或 npm run check）
 */
import {
  REWRITE_TIMEOUT_MS,
  createAnswerRewriter,
  rewriteCacheKey,
} from '../../src/agent/answerRewriter.js';
import {
  HEADLINE_MAX_CHARS,
  PLAIN_ITEM_MAX_CHARS,
  PLAIN_MAX_ITEMS,
  PLAIN_TOTAL_MAX_CHARS,
  charLength,
} from '../../src/agent/plainLanguage.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const DRAFT = {
  headline: '最错的交易差额 -¥1,200.00',
  plain: [
    { id: 'P1', text: '这笔交易的差额是 -¥1,200.00，只说明本次操作的结果。' },
    { id: 'P2', text: '差额来自卖出前后的价差对照，不涉及对其他交易的判断。' },
  ],
  terms: [],
  boundaries: ['只使用当前账单已核对并发布的数字'],
};
const CLAIMS = [{ id: 'Q1', text: '这笔交易的差额是 -¥1,200.00。', evidence_ids: ['F1'] }];
const FACTS = [{ label: '差额', value: '-¥1,200.00' }];
const EVIDENCE = [{ label: '公式', detail: '¥1,300.00 − ¥2,500.00 = -¥1,200.00' }];
const MODEL_VALUE = {
  headline: '最错的交易差额 -¥1,200.00',
  plain: [
    { text: '这笔交易的差额是 -¥1,200.00，只说明本次操作的结果。', claim_ids: ['Q1'] },
    { text: '差额来自卖出前后的价差对照，不涉及对其他交易的判断。', claim_ids: ['Q1'] },
  ],
  used_terms: [],
};

function args(overrides = {}) {
  return {
    question: '我最错的一笔是哪个？',
    intent: 'worst_trade',
    scope: { kind: 'bill', synthetic: false },
    draft: DRAFT,
    claims: CLAIMS,
    facts: FACTS,
    evidence: EVIDENCE,
    userKey: 'user-a',
    ...overrides,
  };
}

function fakeTransport(value = MODEL_VALUE) {
  const sent = [];
  return {
    sent,
    async rewrite(request) {
      sent.push(request);
      return { ok: true, value };
    },
  };
}

/* ==== ① 成功路径 ==== */
{
  const transport = fakeTransport();
  const rewriter = createAnswerRewriter({ transport });
  const result = await rewriter.rewrite(args());
  check('成功：状态 ok 且来源为 model', result.ok === true
    && result.rewrite.status === 'ok' && result.rewrite.source === 'model', JSON.stringify(result.meta));
  check('成功：三层结构与长度符合约定', charLength(result.rewrite.headline) <= HEADLINE_MAX_CHARS
    && result.rewrite.plain.length >= 1 && result.rewrite.plain.length <= PLAIN_MAX_ITEMS
    && result.rewrite.plain.every((item) => charLength(item.text) <= PLAIN_ITEM_MAX_CHARS)
    && result.rewrite.plain.reduce((sum, item) => sum + charLength(item.text), 0) <= PLAIN_TOTAL_MAX_CHARS,
  JSON.stringify(result.rewrite));
  check('成功：claim_map 绑定 claim 与段落', result.rewrite.claim_map.length === 1
    && result.rewrite.claim_map[0].claim_id === 'Q1'
    && result.rewrite.claim_map[0].plain_ids.join(',') === 'P1,P2', JSON.stringify(result.rewrite.claim_map));
  check('成功：保留本地边界', result.rewrite.boundaries.join('|') === DRAFT.boundaries.join('|'));
  check('成功：元信息记录用时与超时', result.meta.status === 'ok' && result.meta.model_called === true
    && result.meta.cached === false && result.meta.timeout_ms === REWRITE_TIMEOUT_MS
    && Number.isFinite(result.meta.ms), JSON.stringify(result.meta));
  check('成功：请求只带协议字段且不含本地答案原文', transport.sent.length === 1
    && Object.keys(transport.sent[0]).join(',') === 'question,intent,scope,draft,claims,facts,evidence,allowed,glossary,limits'
    && !('text' in transport.sent[0]), JSON.stringify(transport.sent[0]));
}

/* ==== ② 缓存与强制重写 ==== */
{
  const transport = fakeTransport();
  const rewriter = createAnswerRewriter({ transport });
  const first = await rewriter.rewrite(args());
  let now = 100;
  const clocked = createAnswerRewriter({ transport, now: () => (now += 5) });
  const a = await clocked.rewrite(args());
  const b = await clocked.rewrite(args());
  check('缓存：同一请求第二次命中且不再调模型', a.meta.cached === false && b.meta.cached === true
    && a.meta.model_called === true && b.meta.model_called === true && transport.sent.length === 2,
  JSON.stringify({ sent: transport.sent.length, b: b.meta }));
  const forced = await clocked.rewrite(args({ force: true }));
  check('缓存：force 绕过缓存', forced.meta.cached === false && transport.sent.length === 3, JSON.stringify(forced.meta));

  const changedUser = await clocked.rewrite(args({ userKey: 'user-b' }));
  check('缓存：不同用户不共用缓存', changedUser.meta.cached === false && transport.sent.length === 4, JSON.stringify(changedUser.meta));
  const changedScope = await clocked.rewrite(args({ scope: { kind: 'bill', synthetic: true } }));
  check('缓存：示例与云端不共用缓存', changedScope.meta.cached === false && transport.sent.length === 5, JSON.stringify(changedScope.meta));
  check('缓存：键随用户/范围/事实变化', rewriteCacheKey(args()) !== rewriteCacheKey(args({ userKey: 'user-b' }))
    && rewriteCacheKey(args()) !== rewriteCacheKey(args({ facts: [{ label: '差额', value: '-¥9,999.00' }] })));
  check('缓存：键稳定', rewriteCacheKey(args()) === rewriteCacheKey(args()));
}

/* ==== ③ 超时与失败整体回退 ==== */
{
  const slow = createAnswerRewriter({
    transport: { rewrite: () => new Promise(() => {}) },
    timeoutMs: 20,
  });
  const timedOut = await slow.rewrite(args());
  check('超时：回退本地草稿并标记 timeout', timedOut.ok === false
    && timedOut.rewrite.status === 'local_fallback'
    && timedOut.meta.reason === 'timeout'
    && timedOut.meta.model_called === true, JSON.stringify(timedOut.meta));
  check('超时：本地草稿原文与数字不变', timedOut.rewrite.headline === DRAFT.headline
    && timedOut.rewrite.plain.map((item) => item.text).join('|') === DRAFT.plain.map((item) => item.text).join('|')
    && timedOut.rewrite.plain.every((item) => item.claim_ids.length === 0), JSON.stringify(timedOut.rewrite));

  const invalid = createAnswerRewriter({
    transport: { async rewrite() { return { ok: false, code: 'E_QA_REWRITE_CHECK' }; } },
  });
  const checked = await invalid.rewrite(args());
  check('不合格：回退并标记 response_invalid', checked.ok === false
    && checked.meta.reason === 'response_invalid' && checked.rewrite.status === 'local_fallback', JSON.stringify(checked.meta));

  const unavailable = createAnswerRewriter({ transport: null });
  const noTransport = await unavailable.rewrite(args());
  check('不可用：未注入客户端直接回退', noTransport.ok === false
    && noTransport.meta.reason === 'unavailable' && noTransport.meta.model_called === false, JSON.stringify(noTransport.meta));

  const badRequest = createAnswerRewriter({ transport: fakeTransport() });
  const noDraft = await badRequest.rewrite(args({ draft: null }));
  check('请求非法：回退并标记 request_invalid', noDraft.ok === false
    && noDraft.meta.reason === 'request_invalid' && noDraft.meta.model_called === false, JSON.stringify(noDraft.meta));

  const throwing = createAnswerRewriter({ transport: { async rewrite() { throw new Error('offline'); } } });
  const offline = await throwing.rewrite(args());
  check('在线异常：回退且不带错误码文本', offline.ok === false
    && offline.meta.reason === 'unavailable' && !('code' in offline), JSON.stringify(offline.meta));
}

/* ==== ④ 示例账单只发已核对事实 ==== */
{
  const transport = fakeTransport();
  const rewriter = createAnswerRewriter({ transport });
  await rewriter.rewrite(args({ scope: { kind: 'demo_group', synthetic: true } }));
  const sent = JSON.stringify(transport.sent[0]);
  check('示例：请求标记 synthetic 且不带账户/文件名', transport.sent[0].scope.synthetic === true
    && !/\.csv|account|账户/u.test(sent), sent);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
