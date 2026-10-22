#!/usr/bin/env node
/**
 * 在线意图（L2）准确率评测：对固定合成问题逐个调用站点函数，统计严格/可接受准确率。
 *
 * 只发送问题文本（不含账单、成交、文件或凭证）；结果对应当前已部署的函数版本。
 * 本地修改提示词后，需重新部署函数才会改变评测结果。
 *
 * 用法：
 *   node scripts/eval-intent.mjs
 *   node scripts/eval-intent.mjs --base=https://<site> [--threshold=0.8] [--timeout=15000]
 *   node scripts/eval-intent.mjs --json
 *   node scripts/eval-intent.mjs --snippet   # 私有站点：输出可在已登录页面控制台运行的脚本
 *   node scripts/eval-intent.mjs --dry-run
 */
import { INTENTS } from '../src/agent/planner.js';
import { INTENT_EVAL_CASES } from '../tests/agent/intent-eval-cases.mjs';

const DEFAULT_BASE = 'https://timingmirror-85sdcc1aphk.qoder.website';
const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_TIMEOUT = 15000;

function parseArgs(argv) {
  const opts = {
    base: process.env.TM_SITE_BASE || DEFAULT_BASE,
    endpoint: process.env.TM_INTENT_ENDPOINT || null,
    threshold: DEFAULT_THRESHOLD,
    timeout: DEFAULT_TIMEOUT,
    json: false,
    dryRun: false,
    snippet: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--snippet') opts.snippet = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg.startsWith('--endpoint=')) opts.endpoint = arg.slice('--endpoint='.length);
    else if (arg.startsWith('--threshold=')) opts.threshold = Number(arg.slice('--threshold='.length));
    else if (arg.startsWith('--timeout=')) opts.timeout = Number(arg.slice('--timeout='.length));
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(opts.threshold) || opts.threshold < 0 || opts.threshold > 1) {
    throw new Error('--threshold 必须为 0-1 的数值');
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout 必须为正整数毫秒');
  opts.endpoint = opts.endpoint || `${String(opts.base).replace(/\/+$/u, '')}/functions/v1/app/api/llm/intent`;
  return opts;
}

function elapsedSince(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function parseRawIntent(rawText) {
  if (typeof rawText !== 'string' || rawText.trim() === '') return { ok: false, code: 'E_RAW_TEXT_MISSING' };
  const trimmed = rawText.trim().replace(/^\uFEFF/u, '');
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1].trim() : trimmed);
  } catch {
    return { ok: false, code: 'E_INTENT_JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'E_INTENT_SCHEMA' };
  if (!INTENTS.includes(parsed.intent)) return { ok: false, code: 'E_INTENT_SCHEMA' };
  if (!parsed.slots || typeof parsed.slots !== 'object' || Array.isArray(parsed.slots)) return { ok: false, code: 'E_INTENT_SCHEMA' };
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)
    || parsed.confidence < 0 || parsed.confidence > 1) {
    return { ok: false, code: 'E_INTENT_SCHEMA' };
  }
  return { ok: true, intent: parsed.intent, slots: parsed.slots, confidence: parsed.confidence };
}

async function classify(endpoint, question, timeoutMs) {
  const started = performance.now();
  let response;
  const headers = { 'Content-Type': 'application/json' };
  try {
    const origin = new URL(endpoint).origin;
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
  } catch { /* endpoint 非绝对地址时交由 fetch 报错 */ }
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'E_TIMEOUT' : 'E_NETWORK';
    return { ok: false, code, latencyMs: elapsedSince(started) };
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? 'E_TIMEOUT' : 'E_RESPONSE_READ';
    return { ok: false, code, latencyMs: elapsedSince(started) };
  }
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = null; }
  const gatewayCode = typeof payload?.code === 'string' && payload.code.startsWith('sites_gateway_');
  if (!response.ok) {
    return {
      ok: false,
      code: payload?.code ?? `E_HTTP_${response.status}`,
      gateway: gatewayCode || response.status === 401,
      latencyMs: elapsedSince(started),
    };
  }
  return { ...parseRawIntent(payload?.rawText), latencyMs: elapsedSince(started) };
}

function slotsMatch(expected, actual) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function browserSnippet(endpoint) {
  const cases = INTENT_EVAL_CASES.map((item) => ({
    id: item.id,
    question: item.question,
    expected: item.expected,
    acceptable: item.acceptable ?? [item.expected],
    slots: item.slots ?? null,
  }));
  let target = '/functions/v1/app/api/llm/intent';
  try {
    const url = new URL(endpoint);
    target = url.pathname + url.search;
  } catch { /* 保留站内默认路径 */ }
  return [
    '(async () => {',
    `  const cases = ${JSON.stringify(cases)};`,
    '  const rows = [];',
    '  for (const c of cases) {',
    '    const t0 = performance.now();',
    "    const record = { id: c.id, expected: c.expected, acceptable: c.acceptable.join('|'), intent: null, confidence: null, slots: null, ok: false, error: null, latencyMs: 0 };",
    '    try {',
    `      const res = await fetch(${JSON.stringify(target)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: c.question }) });`,
    '      const text = await res.text();',
    '      let parsed = null;',
    '      try { parsed = JSON.parse(JSON.parse(text).rawText); } catch { parsed = null; }',
    '      if (parsed) {',
    '        record.ok = true;',
    '        record.intent = parsed.intent;',
    '        record.confidence = parsed.confidence;',
    '        record.slots = parsed.slots;',
    '      } else {',
    "        record.error = 'HTTP ' + res.status + ' ' + text.slice(0, 100);",
    '      }',
    '    } catch (e) {',
    '      record.error = e.name;',
    '    }',
    '    record.latencyMs = Math.round(performance.now() - t0);',
    '    record.strict = record.ok && record.intent === c.expected;',
    '    record.accepted = record.ok && c.acceptable.includes(record.intent);',
    '    record.slotOk = c.slots ? (record.ok && Object.entries(c.slots).every(([k, v]) => record.slots && record.slots[k] === v)) : null;',
    '    rows.push(record);',
    '  }',
    '  const total = rows.length;',
    '  const strict = rows.filter((r) => r.strict).length;',
    '  const accepted = rows.filter((r) => r.accepted).length;',
    '  const slotRows = rows.filter((r) => r.slotOk !== null);',
    '  const slotPass = slotRows.filter((r) => r.slotOk).length;',
    '  const requestFailures = rows.filter((r) => !r.ok).length;',
    '  console.table(rows);',
    "  console.log('严格准确率：' + strict + '/' + total + ' = ' + (strict / total * 100).toFixed(1) + '%');",
    "  console.log('可接受准确率：' + accepted + '/' + total + ' = ' + (accepted / total * 100).toFixed(1) + '%');",
    "  if (slotRows.length) console.log('槽位用例：' + slotPass + '/' + slotRows.length);",
    "  console.log('请求失败：' + requestFailures);",
    "  console.log(JSON.stringify({ protocol: 'intent-eval-v1', total, strict, accepted, slotCases: slotRows.length, slotPass, requestFailures, results: rows }, null, 2));",
    '})();',
  ].join('\n');
}

function helpText() {
  return [
    'TimingMirror 在线意图评测（只发送固定合成问题，不含账单/成交/凭证）',
    '',
    '用法：node scripts/eval-intent.mjs [选项]',
    '  --base=<url>       站点根地址；默认已部署站点',
    '  --endpoint=<url>   直接指定 /api/llm/intent 完整地址（覆盖 --base）',
    '  --threshold=<0-1>  严格准确率阈值；默认 0.8',
    '  --timeout=<ms>     单次请求超时；默认 15000',
    '  --json             输出机器可读 JSON',
    '  --snippet          输出可在已登录站点控制台运行的评测脚本',
    '  --dry-run          只列出用例，不发起请求',
  ].join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(helpText());
    return 0;
  }
  if (opts.snippet) {
    console.log(browserSnippet(opts.endpoint));
    return 0;
  }
  if (opts.dryRun) {
    for (const item of INTENT_EVAL_CASES) {
      console.log(`${item.id}\t${item.expected}\t${item.acceptable ? item.acceptable.join('|') : item.expected}\t${item.question}`);
    }
    console.log(`\n共 ${INTENT_EVAL_CASES.length} 条；未发起请求。`);
    return 0;
  }

  if (!opts.json) {
    console.log('TimingMirror 在线意图评测（L2）');
    console.log(`目标：${opts.endpoint}`);
    console.log(`用例：${INTENT_EVAL_CASES.length} 条固定合成问题；不含账单/成交数据。`);
    console.log('注意：结果对应当前已部署的函数版本；本地提示词改动需重新部署后才会生效。\n');
  }

  const records = [];
  for (const item of INTENT_EVAL_CASES) {
    const result = await classify(opts.endpoint, item.question, opts.timeout);
    const acceptable = item.acceptable ?? [item.expected];
    const strict = result.ok && result.intent === item.expected;
    const accepted = result.ok && acceptable.includes(result.intent);
    const slotOk = item.slots ? (result.ok && slotsMatch(item.slots, result.slots)) : null;
    records.push({ item, result, strict, accepted, slotOk });
    if (!opts.json) {
      const detail = result.ok
        ? `${item.expected} ← ${result.intent} conf=${result.confidence.toFixed(2)} ${result.latencyMs}ms${slotOk === false ? ' [槽位不符]' : ''}`
        : `${item.expected} ← 失败 ${result.code} ${result.latencyMs}ms`;
      console.log(`${strict ? 'PASS' : (accepted ? 'WEAK' : 'FAIL')} ${item.id.padEnd(10)} ${detail}`);
    }
  }

  const total = records.length;
  const gatewayBlocked = records.filter((r) => r.result.gateway).length;
  const evaluated = total - gatewayBlocked;
  const strictCount = records.filter((r) => r.strict).length;
  const acceptedCount = records.filter((r) => r.accepted).length;
  const slotRecords = records.filter((r) => r.slotOk !== null && !r.result.gateway);
  const slotPass = slotRecords.filter((r) => r.slotOk).length;
  const requestFailures = records.filter((r) => !r.result.ok && !r.result.gateway).length;
  const accuracy = evaluated ? strictCount / evaluated : 0;
  const acceptableAccuracy = evaluated ? acceptedCount / evaluated : 0;

  if (opts.json) {
    console.log(JSON.stringify({
      protocol: 'intent-eval-v1',
      endpoint: opts.endpoint,
      threshold: opts.threshold,
      total,
      strict: strictCount,
      acceptable: acceptedCount,
      accuracy,
      acceptableAccuracy,
      slotCases: slotRecords.length,
      slotPass,
      requestFailures,
      gatewayBlocked,
      results: records.map((r) => ({
        id: r.item.id,
        expected: r.item.expected,
        acceptable: r.item.acceptable ?? [r.item.expected],
        ok: r.result.ok,
        intent: r.result.intent ?? null,
        confidence: r.result.confidence ?? null,
        slots: r.result.slots ?? null,
        error: r.result.ok ? null : r.result.code,
        latencyMs: r.result.latencyMs,
        strict: r.strict,
        accepted: r.accepted,
        slotOk: r.slotOk,
      })),
    }, null, 2));
  } else {
    if (evaluated === 0) {
      console.log('\n没有进入模型的有效样本，无法计算准确率。');
    } else {
      console.log(`\n严格准确率：${strictCount}/${evaluated} = ${(accuracy * 100).toFixed(1)}%（阈值 ${(opts.threshold * 100).toFixed(1)}%）`);
      console.log(`可接受准确率：${acceptedCount}/${evaluated} = ${(acceptableAccuracy * 100).toFixed(1)}%`);
      if (slotRecords.length) console.log(`槽位用例：${slotPass}/${slotRecords.length}`);
    }
    console.log(`请求失败：${requestFailures}${gatewayBlocked ? `；网关拦截（未进入模型）：${gatewayBlocked}` : ''}`);
    const failed = records.filter((r) => r.result.ok && !r.accepted);
    if (failed.length) {
      console.log('\n未达可接受判定：');
      for (const r of failed) {
        console.log(`- ${r.item.id}：期望 ${r.item.expected}，得到 ${r.result.intent}｜${r.item.question}`);
      }
    }
  }

  const belowThreshold = evaluated > 0 && accuracy < opts.threshold;
  if (belowThreshold) console.error(`\n严格准确率低于阈值 ${(opts.threshold * 100).toFixed(1)}%。`);
  if (gatewayBlocked) {
    console.error(`\n有 ${gatewayBlocked} 条在站点网关层被拦截，未进入模型。私有站点请在已登录页面运行：node scripts/eval-intent.mjs --snippet`);
  }
  if (requestFailures) console.error(`\n有 ${requestFailures} 条请求失败，评测不完整。`);
  return belowThreshold || requestFailures || gatewayBlocked ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`评测未执行：${String(error && error.message ? error.message : error).slice(0, 240)}`);
    process.exitCode = 1;
  });
