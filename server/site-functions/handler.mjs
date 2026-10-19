// 站点 Edge Function 的 HTTP handler（Web Request/Response；可注入 fake transport）。
// 路由由平台挂在 /functions/v1/app 下；这里按 /api/llm/intent 与 /api/llm/restate 后缀分派。
// 不记录 question/facts/rawText，不返回上游原始错误。
import { projectFacts } from './validation.mjs';

export const SITE_FUNCTION_CODES = Object.freeze({
  NOT_FOUND: 'E_FUNCTION_NOT_FOUND',
  METHOD: 'E_FUNCTION_METHOD_NOT_ALLOWED',
  CONTENT_TYPE: 'E_FUNCTION_CONTENT_TYPE',
  BODY_TOO_LARGE: 'E_FUNCTION_BODY_TOO_LARGE',
  BODY_INVALID: 'E_FUNCTION_BODY_INVALID',
  JSON: 'E_FUNCTION_JSON_INVALID',
  UNKNOWN_FIELD: 'E_FUNCTION_UNKNOWN_FIELD',
  REQUEST_INVALID: 'E_FUNCTION_REQUEST_INVALID',
  MODEL_NOT_CONFIGURED: 'E_MODEL_NOT_CONFIGURED',
  MODEL_UNAVAILABLE: 'E_MODEL_UNAVAILABLE',
  MODEL_TIMEOUT: 'E_MODEL_TIMEOUT',
  MODEL_RESPONSE: 'E_MODEL_RESPONSE_INVALID',
});

const MESSAGES = Object.freeze({
  [SITE_FUNCTION_CODES.NOT_FOUND]: '接口不存在',
  [SITE_FUNCTION_CODES.METHOD]: '请求方法不允许',
  [SITE_FUNCTION_CODES.CONTENT_TYPE]: '仅接受 application/json',
  [SITE_FUNCTION_CODES.BODY_TOO_LARGE]: '请求体超过大小限制',
  [SITE_FUNCTION_CODES.BODY_INVALID]: '请求体读取失败',
  [SITE_FUNCTION_CODES.JSON]: '请求体不是合法 JSON',
  [SITE_FUNCTION_CODES.UNKNOWN_FIELD]: '请求包含不允许的字段',
  [SITE_FUNCTION_CODES.REQUEST_INVALID]: '请求未通过服务端校验',
  [SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED]: '模型未启用：服务端尚未配置 DASHSCOPE_API_KEY',
  [SITE_FUNCTION_CODES.MODEL_UNAVAILABLE]: '模型服务不可用',
  [SITE_FUNCTION_CODES.MODEL_TIMEOUT]: '模型服务超时',
  [SITE_FUNCTION_CODES.MODEL_RESPONSE]: '模型服务响应格式非法',
});

const F6 = new Set(['value', 'unit', 'display', 'formula_ref', 'source_ref']);
const INTENT_KEYS = new Set(['question']);
const RESTATE_KEYS = new Set(['question', 'facts']);

function jsonResponse(status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function errorResponse(status, code, extraHeaders = {}) {
  return jsonResponse(status, { ok: false, code, message: MESSAGES[code] ?? MESSAGES[SITE_FUNCTION_CODES.REQUEST_INVALID] }, extraHeaders);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function parseContentType(request) {
  const raw = request.headers.get('content-type');
  return typeof raw === 'string' && /^application\/json(?:\s*;|$)/i.test(raw);
}

async function readBody(request, maxBodyBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    try { await request.body?.cancel(); } catch { /* 忽略取消失败 */ }
    throw new Error(SITE_FUNCTION_CODES.BODY_TOO_LARGE);
  }
  if (!request.body) return { text: '' };
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    throw new Error(SITE_FUNCTION_CODES.BODY_INVALID);
  }
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        try { await reader.cancel(); } catch { /* 忽略取消失败 */ }
        throw new Error(SITE_FUNCTION_CODES.BODY_TOO_LARGE);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error && error.message === SITE_FUNCTION_CODES.BODY_TOO_LARGE) throw error;
    try { await reader.cancel(); } catch { /* 忽略取消失败 */ }
    throw new Error(SITE_FUNCTION_CODES.BODY_INVALID);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes) };
}

async function callTransport(transport, stage, request) {
  if (transport === null) {
    return { ok: false, status: 503, code: SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED };
  }
  try {
    const result = await transport[stage](request);
    if (!isPlainObject(result) || typeof result.rawText !== 'string') {
      return { ok: false, status: 502, code: SITE_FUNCTION_CODES.MODEL_RESPONSE };
    }
    return { ok: true, rawText: result.rawText };
  } catch (error) {
    if (error && error.code === SITE_FUNCTION_CODES.MODEL_TIMEOUT) {
      return { ok: false, status: 504, code: SITE_FUNCTION_CODES.MODEL_TIMEOUT };
    }
    return { ok: false, status: 502, code: SITE_FUNCTION_CODES.MODEL_UNAVAILABLE };
  }
}

export function createHandler({ transport = null, maxBodyBytes = 64 * 1024 } = {}) {
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('maxBodyBytes 必须为正整数');
  }
  return async function handler(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
    }
    const path = url.pathname;
    const stage = path.endsWith('/api/llm/intent')
      ? 'intent'
      : path.endsWith('/api/llm/restate')
        ? 'restate'
        : null;
    if (stage === null) return errorResponse(404, SITE_FUNCTION_CODES.NOT_FOUND);
    if (request.method !== 'POST') {
      return errorResponse(405, SITE_FUNCTION_CODES.METHOD, { Allow: 'POST' });
    }
    if (!parseContentType(request)) {
      return errorResponse(415, SITE_FUNCTION_CODES.CONTENT_TYPE);
    }

    let bodyText;
    try {
      bodyText = (await readBody(request, maxBodyBytes)).text;
    } catch (error) {
      const code = error && error.message === SITE_FUNCTION_CODES.BODY_TOO_LARGE
        ? SITE_FUNCTION_CODES.BODY_TOO_LARGE
        : SITE_FUNCTION_CODES.BODY_INVALID;
      return errorResponse(code === SITE_FUNCTION_CODES.BODY_TOO_LARGE ? 413 : 400, code);
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, SITE_FUNCTION_CODES.JSON);
    }
    if (!isPlainObject(body)) {
      return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
    }

    let requestBody;
    if (stage === 'intent') {
      if (!hasOnlyKeys(body, INTENT_KEYS)) {
        return errorResponse(400, SITE_FUNCTION_CODES.UNKNOWN_FIELD);
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'question')
        || typeof body.question !== 'string' || body.question.trim() === '') {
        return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
      }
      requestBody = { question: body.question };
    } else {
      if (!hasOnlyKeys(body, RESTATE_KEYS)) {
        return errorResponse(400, SITE_FUNCTION_CODES.UNKNOWN_FIELD);
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'question')
        || typeof body.question !== 'string' || body.question.trim() === ''
        || !Array.isArray(body.facts)) {
        return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
      }
      for (const fact of body.facts) {
        if (!isPlainObject(fact) || !Object.keys(fact).every((key) => F6.has(key))) {
          return errorResponse(400, SITE_FUNCTION_CODES.UNKNOWN_FIELD);
        }
      }
      const projected = projectFacts(body.facts);
      if (!projected.ok) {
        return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
      }
      requestBody = { question: body.question, facts: projected.facts };
    }

    const result = await callTransport(transport, stage, requestBody);
    if (!result.ok) return errorResponse(result.status, result.code);
    return jsonResponse(200, { rawText: result.rawText });
  };
}
