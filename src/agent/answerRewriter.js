// 自动重写：本地事实草稿 → rewrite-v2 → 三层白话；任何失败整体回退本地草稿。
// 4 秒超时、按用户/范围/意图/claims 缓存；不记录模型原文，也不把错误码交给界面。
import { buildPlainDraft } from './plainLanguage.js';
import { buildRewriteRequest, createQaRewrite } from './qaRewrite.js';

export const REWRITE_TIMEOUT_MS = 4000;
export const REWRITE_CACHE_MAX = 64;

const TIMEOUT = Symbol('timeout');

export function rewriteCacheKey({ userKey = '', intent = '', scope = {}, draft = null, claims = [], facts = [] } = {}) {
  const parts = [
    String(userKey),
    String(intent),
    String(scope?.kind ?? ''),
    String(scope?.synthetic === true),
    ...(Array.isArray(claims) ? claims.map((claim) => `${claim.id}:${claim.text}`) : []),
    ...(Array.isArray(facts) ? facts.map((fact) => `${fact.label}=${fact.value}`) : []),
    ...(Array.isArray(draft?.plain) ? draft.plain.map((item) => item.text) : []),
  ];
  const input = parts.join('\u0001');
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function localRewrite({ draft, intent, scope, claims = [] }) {
  const built = draft ?? buildPlainDraft({ intent, text: '', facts: [], demo: scope?.synthetic === true });
  return {
    status: 'local_fallback',
    source: 'local',
    headline: built.headline,
    plain: (built.plain ?? []).map((item, index) => ({
      id: item.id ?? `P${index + 1}`,
      text: item.text,
      claim_ids: [],
    })),
    terms: built.terms ?? [],
    claim_map: [],
    boundaries: built.boundaries ?? [],
    claims,
  };
}

function modelRewrite({ value, request, claims }) {
  const byTerm = new Map((request.glossary ?? []).map((item) => [item.term, item.definition]));
  const plain = value.plain.map((item, index) => ({
    id: `P${index + 1}`,
    text: item.text,
    claim_ids: item.claim_ids,
  }));
  const claimMap = claims.map((claim) => ({
    claim_id: claim.id,
    plain_ids: plain.filter((item) => item.claim_ids.includes(claim.id)).map((item) => item.id),
  })).filter((item) => item.plain_ids.length > 0);
  return {
    status: 'ok',
    source: 'model',
    headline: value.headline,
    plain,
    terms: value.used_terms.map((term) => ({ term, definition: byTerm.get(term) ?? '' })),
    claim_map: claimMap,
    boundaries: [],
    claims,
  };
}

export function createAnswerRewriter({
  transport = null,
  timeoutMs = REWRITE_TIMEOUT_MS,
  cache = new Map(),
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  maxCache = REWRITE_CACHE_MAX,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正整数');
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');
  const client = createQaRewrite({ transport });

  async function rewrite({
    question = '', intent = '', scope = { kind: 'bill' }, draft = null,
    claims = [], facts = [], evidence = [], userKey = '', force = false,
  } = {}) {
    const started = now();
    const fallback = localRewrite({ draft, intent, scope, claims });
    const built = buildRewriteRequest({
      question, intent, scope, draft, claims, facts, evidence, glossary: draft?.terms ?? [],
    });
    if (!built.ok) {
      return {
        ok: false,
        rewrite: fallback,
        meta: {
          status: 'local_fallback', model_called: false, cached: false, ms: Math.max(0, now() - started), timeout_ms: timeoutMs, reason: 'request_invalid',
        },
      };
    }
    if (typeof transport?.rewrite !== 'function') {
      return {
        ok: false,
        rewrite: fallback,
        meta: {
          status: 'local_fallback', model_called: false, cached: false, ms: Math.max(0, now() - started), timeout_ms: timeoutMs, reason: 'unavailable',
        },
      };
    }

    const key = rewriteCacheKey({ userKey, intent, scope, draft, claims, facts });
    if (!force && cache.has(key)) {
      return {
        ok: true,
        rewrite: cache.get(key),
        meta: {
          status: 'ok', model_called: true, cached: true, ms: Math.max(0, now() - started), timeout_ms: timeoutMs,
        },
      };
    }

    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT);
      }, timeoutMs);
    });
    const call = Promise.resolve().then(() => transport.rewrite(built.request, { signal: controller.signal }));
    call.catch(() => { /* 超时后忽略迟到的失败 */ });
    let result;
    try {
      result = await Promise.race([call, timeout]);
    } catch {
      result = null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const ms = Math.max(0, now() - started);
    if (result === TIMEOUT || controller.signal.aborted) {
      return {
        ok: false,
        rewrite: fallback,
        meta: {
          status: 'local_fallback', model_called: true, cached: false, ms, timeout_ms: timeoutMs, reason: 'timeout',
        },
      };
    }
    if (!result?.ok) {
      return {
        ok: false,
        rewrite: fallback,
        meta: {
          status: 'local_fallback', model_called: true, cached: false, ms, timeout_ms: timeoutMs, reason: result?.code === 'E_QA_REWRITE_CHECK' ? 'response_invalid' : 'unavailable',
        },
      };
    }

    const rewriteValue = modelRewrite({ value: result.value, request: built.request, claims });
    if (fallback.boundaries.length) rewriteValue.boundaries = fallback.boundaries;
    if (cache.size >= maxCache) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
    cache.set(key, rewriteValue);
    return {
      ok: true,
      rewrite: rewriteValue,
      meta: {
        status: 'ok', model_called: true, cached: false, ms, timeout_ms: timeoutMs,
      },
    };
  }

  return Object.freeze({ rewrite });
}
