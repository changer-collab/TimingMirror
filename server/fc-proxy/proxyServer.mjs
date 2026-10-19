// TimingMirror 本地代理骨架（Node 原生 HTTP；零依赖；接口候选，未冻结）
// 仅用于本机回环联调：不实现百炼 HTTP、不部署云资源、不读取凭证。
// 默认 model transport 禁用；health 只表示代理进程存活，不表示百炼连通。
import http from 'node:http';
import {
  buildIntentRequest,
  buildRestateRequest,
  projectOnlineFacts,
  CONFIRMED_FACT_FIELDS,
} from '../../src/agent/onlineBoundary.js';

export const DASHSCOPE_API_KEY_ENV = 'DASHSCOPE_API_KEY';
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://127.0.0.1:5180',
  'http://localhost:5180',
]);
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export const PROXY_CODES = Object.freeze({
  CORS_DENIED: 'E_PROXY_CORS_DENIED',
  METHOD_NOT_ALLOWED: 'E_PROXY_METHOD_NOT_ALLOWED',
  NOT_FOUND: 'E_PROXY_NOT_FOUND',
  CONTENT_TYPE: 'E_PROXY_CONTENT_TYPE',
  BODY_TOO_LARGE: 'E_PROXY_BODY_TOO_LARGE',
  BODY_INVALID: 'E_PROXY_BODY_INVALID',
  JSON_INVALID: 'E_PROXY_JSON_INVALID',
  UNKNOWN_FIELD: 'E_PROXY_UNKNOWN_FIELD',
  REQUEST_INVALID: 'E_PROXY_REQUEST_INVALID',
  MODEL_DISABLED: 'E_PROXY_MODEL_DISABLED',
  MODEL_UNAVAILABLE: 'E_PROXY_MODEL_UNAVAILABLE',
  MODEL_RESPONSE_INVALID: 'E_PROXY_MODEL_RESPONSE_INVALID',
  INTERNAL: 'E_PROXY_INTERNAL',
});

const STATIC_MESSAGES = Object.freeze({
  [PROXY_CODES.CORS_DENIED]: '请求来源不在本地开发 allowlist',
  [PROXY_CODES.METHOD_NOT_ALLOWED]: '请求方法不允许',
  [PROXY_CODES.NOT_FOUND]: '接口不存在',
  [PROXY_CODES.CONTENT_TYPE]: '仅接受 application/json',
  [PROXY_CODES.BODY_TOO_LARGE]: '请求体超过大小限制',
  [PROXY_CODES.BODY_INVALID]: '请求体读取失败',
  [PROXY_CODES.JSON_INVALID]: '请求体不是合法 JSON',
  [PROXY_CODES.UNKNOWN_FIELD]: '请求包含不允许的字段',
  [PROXY_CODES.REQUEST_INVALID]: '请求未通过服务端校验',
  [PROXY_CODES.MODEL_DISABLED]: '模型 transport 未配置；本地代理骨架默认禁用',
  [PROXY_CODES.MODEL_UNAVAILABLE]: '模型服务不可用',
  [PROXY_CODES.MODEL_RESPONSE_INVALID]: '模型服务响应格式非法',
  [PROXY_CODES.INTERNAL]: '代理内部错误',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function validateLocalOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') throw new TypeError('allowedOrigins 必须为非空字符串');
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError('allowedOrigins 必须为合法 origin');
  }
  if (url.origin !== origin) throw new TypeError('allowedOrigins 必须是 origin，不含路径或查询');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('allowedOrigins 仅支持 http/https');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new TypeError('allowedOrigins 仅允许本机回环地址');
  }
  return origin;
}

export function createProxyConfig(input = {}) {
  if (!isPlainObject(input)) throw new TypeError('proxy config 必须为对象');
  const {
    apiKey = null,
    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = input;
  if (apiKey !== null && typeof apiKey !== 'string') throw new TypeError('apiKey 必须为字符串或 null');
  if (!Array.isArray(allowedOrigins)) throw new TypeError('allowedOrigins 必须为数组');
  const origins = [...new Set(allowedOrigins.map(validateLocalOrigin))];
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new TypeError('maxBodyBytes 必须为正整数');
  return Object.freeze({
    apiKey: apiKey === '' ? null : apiKey,
    allowedOrigins: Object.freeze(origins),
    maxBodyBytes,
  });
}

function corsHeaders(origin, allowedOrigins) {
  if (origin === undefined) return {};
  if (!allowedOrigins.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendJson(res, status, code, cors, extraHeaders = {}) {
  const payload = { ok: false, code, message: STATIC_MESSAGES[code] ?? STATIC_MESSAGES[PROXY_CODES.INTERNAL] };
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...cors,
    ...extraHeaders,
  });
  res.end(body);
}

function sendSuccess(res, status, payload, cors) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...cors,
  });
  res.end(body);
}

function readBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      req.resume();
      reject({ code: PROXY_CODES.BODY_TOO_LARGE });
      return;
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (code) => {
      if (settled) return;
      settled = true;
      req.resume();
      reject({ code });
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(PROXY_CODES.BODY_TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('aborted', () => fail(PROXY_CODES.BODY_INVALID));
    req.on('error', () => fail(PROXY_CODES.BODY_INVALID));
  });
}

function parseContentType(req) {
  const raw = req.headers['content-type'];
  if (typeof raw !== 'string') return false;
  return /^application\/json(?:\s*;|$)/i.test(raw);
}

async function callTransport(transport, stage, request) {
  if (transport === null) {
    return { ok: false, code: PROXY_CODES.MODEL_DISABLED, status: 503 };
  }
  try {
    const result = await transport[stage](request);
    if (!isPlainObject(result) || typeof result.rawText !== 'string') {
      return { ok: false, code: PROXY_CODES.MODEL_RESPONSE_INVALID, status: 502 };
    }
    return { ok: true, rawText: result.rawText };
  } catch {
    return { ok: false, code: PROXY_CODES.MODEL_UNAVAILABLE, status: 502 };
  }
}

async function handleRequest(req, res, { transport, config }) {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin, config.allowedOrigins);
  if (cors === null) {
    sendJson(res, 403, PROXY_CODES.CORS_DENIED, {});
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
    return;
  }
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (path === '/health') {
    if (req.method !== 'GET') {
      sendJson(res, 405, PROXY_CODES.METHOD_NOT_ALLOWED, cors, { Allow: 'GET, OPTIONS' });
      return;
    }
    sendSuccess(res, 200, { ok: true, service: 'fc-proxy', status: 'alive' }, cors);
    return;
  }

  const stage = path === '/api/llm/intent'
    ? 'intent'
    : path === '/api/llm/restate'
      ? 'restate'
      : null;
  if (stage === null) {
    sendJson(res, 404, PROXY_CODES.NOT_FOUND, cors);
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, PROXY_CODES.METHOD_NOT_ALLOWED, cors, { Allow: 'POST, OPTIONS' });
    return;
  }
  if (!parseContentType(req)) {
    sendJson(res, 415, PROXY_CODES.CONTENT_TYPE, cors);
    return;
  }

  let raw;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (error) {
    const code = error && error.code === PROXY_CODES.BODY_TOO_LARGE
      ? PROXY_CODES.BODY_TOO_LARGE
      : PROXY_CODES.BODY_INVALID;
    sendJson(res, code === PROXY_CODES.BODY_TOO_LARGE ? 413 : 400, code, cors);
    return;
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, PROXY_CODES.JSON_INVALID, cors);
    return;
  }
  if (!isPlainObject(body)) {
    sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
    return;
  }

  let request;
  if (stage === 'intent') {
    if (!hasOnlyKeys(body, ['question'])) {
      sendJson(res, 400, PROXY_CODES.UNKNOWN_FIELD, cors);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'question')) {
      sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
      return;
    }
    const built = buildIntentRequest({ question: body.question });
    if (!built.ok) {
      sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
      return;
    }
    request = built.request;
  } else {
    if (!hasOnlyKeys(body, ['question', 'facts'])) {
      sendJson(res, 400, PROXY_CODES.UNKNOWN_FIELD, cors);
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'question')
      || !Object.prototype.hasOwnProperty.call(body, 'facts')) {
      sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
      return;
    }
    if (!Array.isArray(body.facts)) {
      sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
      return;
    }
    for (const fact of body.facts) {
      if (!isPlainObject(fact)) {
        sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
        return;
      }
      if (!hasOnlyKeys(fact, CONFIRMED_FACT_FIELDS)) {
        sendJson(res, 400, PROXY_CODES.UNKNOWN_FIELD, cors);
        return;
      }
    }
    const projected = projectOnlineFacts(body.facts);
    if (!projected.ok) {
      sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
      return;
    }
    const built = buildRestateRequest({ question: body.question, facts: projected.facts });
    if (!built.ok) {
      sendJson(res, 400, PROXY_CODES.REQUEST_INVALID, cors);
      return;
    }
    request = built.request;
  }

  const result = await callTransport(transport, stage, request);
  if (!result.ok) {
    sendJson(res, result.status, result.code, cors);
    return;
  }
  sendSuccess(res, 200, { rawText: result.rawText }, cors);
}

export function createProxyServer({ transport = null, config = {} } = {}) {
  if (transport !== null && (!isPlainObject(transport)
    || typeof transport.intent !== 'function' || typeof transport.restate !== 'function')) {
    throw new TypeError('transport 必须为 null 或提供 intent()/restate()');
  }
  const cfg = createProxyConfig(config);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { transport, config: cfg }).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, PROXY_CODES.INTERNAL, {});
      } else {
        res.destroy();
      }
    });
  });
  return server;
}
