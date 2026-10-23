// M1-C10 在线接入准备 · 本地代理 HTTP transport（接口候选，未冻结）
// 职责：把 onlineBoundary / 规则助手 / 导入补救的 transport 接口映射到站点端点。
// 不实现：真实百炼供应商请求、API Key 配置、UI 接线或云部署。
// 请求体严格为 { question } 或 { question, facts }；signal 只用于 fetch 取消，不进入 JSON。
// 站点同源请求携带浏览器登录会话（same-origin）；本地代理不携带凭证（omit）。
import { TransportError } from './onlineBoundary.js';

export const DEFAULT_PROXY_BASE_URL = 'http://127.0.0.1:5181';
export const SAME_ORIGIN_BASE = 'same-origin';
export const DEFAULT_PROXY_PATHS = Object.freeze({
  intent: '/api/llm/intent',
  restate: '/api/llm/restate',
});
export const SITE_FUNCTION_PATHS = Object.freeze({
  intent: '/functions/v1/app/api/llm/intent',
  restate: '/functions/v1/app/api/llm/restate',
  ruleIntent: '/functions/v1/app/api/llm/rule-intent',
  resultExplanation: '/functions/v1/app/api/llm/result-explanation',
  scenarioJudgment: '/functions/v1/app/api/llm/scenario-judgment',
  customRuleJudgment: '/functions/v1/app/api/llm/custom-rule-judgment',
  importRecover: '/functions/v1/app/api/llm/import-recover',
  importVision: '/functions/v1/app/api/llm/import-vision',
  profileSummary: '/functions/v1/app/api/llm/profile-summary',
  profileFact: '/functions/v1/app/api/llm/profile-fact',
});

export const HTTP_TRANSPORT_CODES = Object.freeze({
  CONFIG: 'E_HTTP_CONFIG',
  NETWORK: 'E_HTTP_NETWORK',
  ABORTED: 'E_HTTP_ABORTED',
  STATUS: 'E_HTTP_STATUS',
  JSON: 'E_HTTP_JSON',
  RESPONSE: 'E_HTTP_RESPONSE',
});

const FIXED_MESSAGES = Object.freeze({
  [HTTP_TRANSPORT_CODES.CONFIG]: '本地代理地址或 fetch 配置非法',
  [HTTP_TRANSPORT_CODES.NETWORK]: '本地代理网络请求失败',
  [HTTP_TRANSPORT_CODES.ABORTED]: '本地代理请求已取消',
  [HTTP_TRANSPORT_CODES.STATUS]: '本地代理返回非成功状态',
  [HTTP_TRANSPORT_CODES.JSON]: '本地代理响应不是合法 JSON',
  [HTTP_TRANSPORT_CODES.RESPONSE]: '本地代理响应格式非法',
});

function transportError(code) {
  return new TransportError(code, FIXED_MESSAGES[code] ?? FIXED_MESSAGES[HTTP_TRANSPORT_CODES.RESPONSE]);
}

/* 只允许本机回环代理地址，避免客户端 transport 被误配置到外网。 */
export function normalizeProxyBaseUrl(input = DEFAULT_PROXY_BASE_URL) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('baseUrl 必须为合法 URL');
  }
  if (url.protocol !== 'http:') throw new TypeError('baseUrl 仅支持 http');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new TypeError('baseUrl 仅允许本机回环地址');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('baseUrl 必须为 origin，不含凭证、路径或查询');
  }
  return url.origin;
}

function normalizePaths(paths) {
  if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new TypeError('paths 必须为对象');
  }
  const out = {};
  for (const key of ['intent', 'restate', 'ruleIntent', 'resultExplanation', 'scenarioJudgment', 'customRuleJudgment', 'importRecover', 'importVision', 'profileSummary', 'profileFact']) {
    const value = paths[key];
    if (value === undefined) {
      if (key === 'ruleIntent' || key === 'resultExplanation' || key === 'scenarioJudgment' || key === 'customRuleJudgment' || key === 'importRecover' || key === 'importVision' || key === 'profileSummary' || key === 'profileFact') continue;
      throw new TypeError(`paths.${key} 缺失`);
    }
    if (typeof value !== 'string' || !value.startsWith('/')
      || value.startsWith('//') || value.includes('?') || value.includes('#')) {
      throw new TypeError('paths 必须为站内绝对路径');
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

export function createHttpTransport({
  baseUrl = DEFAULT_PROXY_BASE_URL,
  fetchImpl = globalThis.fetch,
  paths = DEFAULT_PROXY_PATHS,
} = {}) {
  const sameOrigin = baseUrl === SAME_ORIGIN_BASE;
  const origin = sameOrigin ? '' : normalizeProxyBaseUrl(baseUrl);
  const routes = normalizePaths(paths);
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl 必须为函数');
  }

  async function request(path, body, signal) {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        credentials: sameOrigin ? 'same-origin' : 'omit',
      });
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
        throw transportError(HTTP_TRANSPORT_CODES.ABORTED);
      }
      throw transportError(HTTP_TRANSPORT_CODES.NETWORK);
    }
    if (signal && signal.aborted) throw transportError(HTTP_TRANSPORT_CODES.ABORTED);
    if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') {
      throw transportError(HTTP_TRANSPORT_CODES.RESPONSE);
    }
    if (!response.ok) {
      const error = transportError(HTTP_TRANSPORT_CODES.STATUS);
      error.status = Number.isInteger(response.status) ? response.status : null;
      try {
        const payload = await response.json();
        if (payload && typeof payload.code === 'string') error.upstreamCode = payload.code;
        if (payload && typeof payload.message === 'string') error.upstreamMessage = payload.message;
      } catch { /* 错误体不是 JSON 时只保留 HTTP 状态 */ }
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
        throw transportError(HTTP_TRANSPORT_CODES.ABORTED);
      }
      throw transportError(HTTP_TRANSPORT_CODES.JSON);
    }
    if (signal && signal.aborted) throw transportError(HTTP_TRANSPORT_CODES.ABORTED);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw transportError(HTTP_TRANSPORT_CODES.RESPONSE);
    }
    return payload;
  }

  async function call(path, body, signal) {
    const payload = await request(path, body, signal);
    if (typeof payload.rawText !== 'string') {
      throw transportError(HTTP_TRANSPORT_CODES.RESPONSE);
    }
    return { rawText: payload.rawText };
  }

  return Object.freeze({
    intent({ question, signal } = {}) {
      return call(routes.intent, { question }, signal);
    },
    restate({ question, facts, signal } = {}) {
      return call(routes.restate, { question, facts }, signal);
    },
    profileSummary({ digest, signal } = {}) {
      if (!routes.profileSummary) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return request(routes.profileSummary, { digest }, signal);
    },
    profileFact({ message, signal } = {}) {
      if (!routes.profileFact) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return request(routes.profileFact, { message }, signal);
    },
    ruleIntent({ question, stage, allowed_intents, allowed_templates, allowed_tools, context_summary, signal } = {}) {
      if (!routes.ruleIntent) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return call(routes.ruleIntent, {
        question,
        stage,
        allowed_intents,
        allowed_templates,
        allowed_tools,
        context_summary,
      }, signal);
    },
    resultExplanation({ stage, flow_id, request_id, rule, simulation, signal } = {}) {
      if (!routes.resultExplanation) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return call(routes.resultExplanation, { stage, flow_id, request_id, rule, simulation }, signal);
    },
    scenarioJudgment({ stage, flow_id, request_id, scenario_id, rule_set_hash, scenario, signal } = {}) {
      if (!routes.scenarioJudgment) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return call(routes.scenarioJudgment, { stage, flow_id, request_id, scenario_id, rule_set_hash, scenario }, signal);
    },
    customRuleJudgment({ stage, flow_id, request_id, judgment_id, rule, scenario, data, signal } = {}) {
      if (!routes.customRuleJudgment) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return call(routes.customRuleJudgment, { stage, flow_id, request_id, judgment_id, rule, scenario, data }, signal);
    },
    importRecover({ content, stage, source_kind, flow_id, request_id, signal } = {}) {
      if (!routes.importRecover) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return call(routes.importRecover, { content, stage, source_kind, flow_id, request_id }, signal);
    },
    importVision({ images, stage, source_kind, flow_id, request_id, signal } = {}) {
      if (!routes.importVision) throw transportError(HTTP_TRANSPORT_CODES.CONFIG);
      return call(routes.importVision, {
        images: Array.isArray(images) ? images.map((image) => ({ mime: image.mime, data_base64: image.data_base64 })) : images,
        stage,
        source_kind,
        flow_id,
        request_id,
      }, signal);
    },
  });
}
