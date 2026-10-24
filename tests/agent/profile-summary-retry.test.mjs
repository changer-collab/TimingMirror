#!/usr/bin/env node
/**
 * 画像解读重试包装测试（纯函数；不联网）
 *
 * 覆盖：只对限流/临时不可用/未知瞬时错误重试一次；
 *       鉴权、权限、配置、超时、内容校验与 AI 成功均不重试；
 *       网络异常重试一次，第二次失败时行为稳定。
 */
import {
  shouldRetryProfileSummary,
  requestProfileSummaryWithRetry,
} from '../../src/agent/profileSummaryRetry.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const AI = Object.freeze({
  ok: true,
  source: 'ai',
  source_hash: 'a'.repeat(64),
  fallback_reason: null,
  fallback_detail: null,
  summary: { headline: 'x', summary: 'y' },
});

function template(detail) {
  return {
    ok: true,
    source: 'template',
    source_hash: 'b'.repeat(64),
    fallback_reason: 'model_unavailable',
    fallback_detail: detail,
    summary: { headline: 'x', summary: 'y' },
  };
}

async function run(responses, { throws = [] } = {}) {
  let calls = 0;
  const seen = [];
  const result = await requestProfileSummaryWithRetry({
    request: async (args) => {
      calls += 1;
      seen.push(args);
      if (throws.includes(calls)) throw new Error('network');
      return responses[Math.min(calls - 1, responses.length - 1)];
    },
    digest: { schema_version: 1 },
    signal: undefined,
    sleep: async () => {},
  });
  return { result, calls, seen };
}

/* ==== 是否重试的判断 ==== */
{
  check('判断：限流/临时不可用/未知错误可重试',
    ['upstream_rate_limited', 'upstream_unavailable', 'upstream_unknown']
      .every((detail) => shouldRetryProfileSummary(template(detail))));
  check('判断：鉴权/权限/请求配置/超时/内容校验不重试',
    ['upstream_auth', 'upstream_forbidden', 'upstream_request', 'upstream_timeout', 'upstream_response']
      .every((detail) => !shouldRetryProfileSummary(template(detail))));
  check('判断：AI 成功或缺少标记不重试',
    !shouldRetryProfileSummary(AI)
    && !shouldRetryProfileSummary({ ...AI, source: 'template' })
    && !shouldRetryProfileSummary(null));
}

/* ==== 瞬时错误：最多补一次 ==== */
{
  const { result, calls } = await run([template('upstream_unavailable'), AI]);
  check('瞬时错误：第二次成功即返回 AI 结果', calls === 2 && result.source === 'ai', JSON.stringify({ calls, result }));

  const last = await run([template('upstream_rate_limited'), template('upstream_unknown')]);
  check('瞬时错误：第二次仍是模板时返回最后一次', last.calls === 2
    && last.result.fallback_detail === 'upstream_unknown', JSON.stringify(last));

  const down = await run([template('upstream_unavailable')], { throws: [2] });
  check('瞬时错误：第二次网络异常时保留第一次可读结果', down.calls === 2
    && down.result.fallback_detail === 'upstream_unavailable', JSON.stringify(down));
}

/* ==== 非瞬时错误：不补请求 ==== */
{
  const cases = ['upstream_auth', 'upstream_forbidden', 'upstream_request', 'upstream_timeout', 'upstream_response'];
  for (const detail of cases) {
    const { result, calls } = await run([template(detail), AI]);
    check(`非瞬时（${detail}）：只请求一次`, calls === 1 && result.fallback_detail === detail,
      JSON.stringify({ calls, result }));
  }
  const ai = await run([AI]);
  check('AI 成功：只请求一次', ai.calls === 1 && ai.result.source === 'ai', JSON.stringify(ai));
}

/* ==== 网络异常 ==== */
{
  const retried = await run([null, AI], { throws: [1] });
  check('网络异常：首次抛出后补一次', retried.calls === 2 && retried.result.source === 'ai',
    JSON.stringify(retried));

  let calls = 0;
  let message = '';
  try {
    await requestProfileSummaryWithRetry({
      request: async () => { calls += 1; throw new Error('network'); },
      digest: {},
      sleep: async () => {},
    });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  check('网络异常：两次都失败时抛出，且不超过两次', calls === 2 && message === 'network',
    JSON.stringify({ calls, message }));
}

{
  const same = await run([template('upstream_unavailable'), AI]);
  check('请求：重试时传递同一 digest', same.seen.length === 2
    && same.seen[0].digest === same.seen[1].digest, JSON.stringify(same.seen));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
