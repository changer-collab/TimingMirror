// 站点 Edge Function 的 HTTP handler（Web Request/Response；可注入 fake transport）。
// 路由由平台挂在 /functions/v1/app 下；这里按 /api/llm/intent、/api/llm/restate、/api/llm/rule、/api/llm/rule-intent、/api/llm/result-explanation、/api/llm/scenario-judgment、/api/llm/custom-rule-judgment、/api/llm/import-recover、/api/llm/import-vision、/api/market/snapshot 与 /api/bills、/api/profile 后缀分派。
// 不记录 question/facts/text/rawText/行情请求/账单内容，不返回上游原始错误或 token。
import { dataMethodNotAllowed, handleDataRequest, resolveDataRoute } from './dataApi.mjs';
import { projectFacts } from './validation.mjs';
import { DYNAMIC_CACHE_ARTIFACT, MARKET_MAX_RANGE_DAYS, MARKET_MAX_SYMBOLS, isMarketDate } from './market.mjs';
import {
  RULE_INTENT_CODES,
  normalizeRuleIntentRequest,
  validateRuleIntentResponse,
} from './ruleIntent.mjs';
import {
  IMPORT_RECOVER_CODES,
  normalizeImportRecoverRequest,
  validateImportRecoverResponse,
} from './importRecover.mjs';
import {
  IMPORT_VISION_CODES,
  normalizeImportVisionRequest,
  validateImportVisionResponse,
} from './importVision.mjs';
import {
  PROFILE_SUMMARY_CODES,
  buildProfileSummaryFallback,
  normalizeProfileSummaryRequest,
  profileDigestHash,
  validateProfileSummaryResponse,
} from './profileSummary.mjs';
import {
  PROFILE_FACT_CODES,
  normalizeProfileFactRequest,
  validateProfileFactResponse,
} from './profileFact.mjs';
import { validateChatIntentResponse } from './chatIntent.mjs';
import {
  RESULT_EXPLANATION_CODES,
  normalizeResultExplanationRequest,
  validateResultExplanationResponse,
} from './resultExplanation.mjs';
import {
  BEHAVIOR_CODES,
  normalizeBehaviorFactsRequest,
  buildBehaviorFacts,
  behaviorFactsForAi,
  validateBehaviorAiResponse,
  buildAiBehaviorAnalysis,
} from './behaviorAnalysis.mjs';
import { buildBehaviorFallback } from './behaviorFallback.mjs';
import {
  SCENARIO_JUDGMENT_CODES,
  normalizeScenarioJudgmentRequest,
  validateScenarioJudgmentResponse,
} from './scenarioJudgment.mjs';
import {
  CUSTOM_RULE_JUDGMENT_CODES,
  normalizeCustomRuleJudgmentRequest,
  validateCustomRuleJudgmentResponse,
} from './customRuleJudgment.mjs';
import {
  QA_NARRATIVE_CODES,
  normalizeQaNarrativeRequest,
  validateQaNarrativeResponse,
} from './qaNarrative.mjs';

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
  MODEL_AUTH_FAILED: 'E_MODEL_AUTH_FAILED',
  MODEL_FORBIDDEN: 'E_MODEL_FORBIDDEN',
  MODEL_RATE_LIMITED: 'E_MODEL_RATE_LIMITED',
  MODEL_UNAVAILABLE: 'E_MODEL_UNAVAILABLE',
  MODEL_TIMEOUT: 'E_MODEL_TIMEOUT',
  MODEL_RESPONSE: 'E_MODEL_RESPONSE_INVALID',
  RULE_INTENT_REQUEST_INVALID: RULE_INTENT_CODES.REQUEST_INVALID,
  RULE_INTENT_SCOPE: RULE_INTENT_CODES.SCOPE,
  RULE_INTENT_RESPONSE: RULE_INTENT_CODES.RESPONSE,
  BEHAVIOR_REQUEST_INVALID: BEHAVIOR_CODES.REQUEST_INVALID,
  IMPORT_RECOVER_REQUEST_INVALID: IMPORT_RECOVER_CODES.REQUEST_INVALID,
  IMPORT_RECOVER_RESPONSE: IMPORT_RECOVER_CODES.RESPONSE,
  IMPORT_VISION_REQUEST_INVALID: IMPORT_VISION_CODES.REQUEST_INVALID,
  IMPORT_VISION_RESPONSE: IMPORT_VISION_CODES.RESPONSE,
  PROFILE_SUMMARY_REQUEST_INVALID: PROFILE_SUMMARY_CODES.REQUEST_INVALID,
  PROFILE_SUMMARY_RESPONSE: PROFILE_SUMMARY_CODES.RESPONSE,
  PROFILE_FACT_REQUEST_INVALID: PROFILE_FACT_CODES.REQUEST_INVALID,
  PROFILE_FACT_RESPONSE: PROFILE_FACT_CODES.RESPONSE,
  RESULT_EXPLANATION_REQUEST_INVALID: RESULT_EXPLANATION_CODES.REQUEST_INVALID,
  RESULT_EXPLANATION_RESPONSE: RESULT_EXPLANATION_CODES.RESPONSE,
  SCENARIO_JUDGMENT_REQUEST_INVALID: SCENARIO_JUDGMENT_CODES.REQUEST_INVALID,
  SCENARIO_JUDGMENT_RESPONSE: SCENARIO_JUDGMENT_CODES.RESPONSE,
  CUSTOM_RULE_JUDGMENT_REQUEST_INVALID: CUSTOM_RULE_JUDGMENT_CODES.REQUEST_INVALID,
  CUSTOM_RULE_JUDGMENT_RESPONSE: CUSTOM_RULE_JUDGMENT_CODES.RESPONSE,
  QA_NARRATIVE_REQUEST_INVALID: QA_NARRATIVE_CODES.REQUEST_INVALID,
  QA_NARRATIVE_RESPONSE: QA_NARRATIVE_CODES.RESPONSE,
  MARKET_NOT_CONFIGURED: 'E_MARKET_NOT_CONFIGURED',
  MARKET_REQUEST_INVALID: 'E_MARKET_REQUEST_INVALID',
  MARKET_SYMBOL_UNKNOWN: 'E_MARKET_SYMBOL_UNKNOWN',
  MARKET_NO_DATA: 'E_MARKET_NO_DATA',
  MARKET_UNAVAILABLE: 'E_MARKET_UNAVAILABLE',
  MARKET_TIMEOUT: 'E_MARKET_TIMEOUT',
  MARKET_RESPONSE: 'E_MARKET_RESPONSE_INVALID',
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
  [SITE_FUNCTION_CODES.MODEL_NOT_CONFIGURED]: '模型未启用：服务端尚未配置 DEEPSEEK_API_KEY',
  [SITE_FUNCTION_CODES.MODEL_AUTH_FAILED]: '模型服务鉴权失败：请检查服务端模型 Key',
  [SITE_FUNCTION_CODES.MODEL_FORBIDDEN]: '模型服务无访问权限：请检查模型权限',
  [SITE_FUNCTION_CODES.MODEL_RATE_LIMITED]: '模型服务请求过于频繁：请稍后重试',
  [SITE_FUNCTION_CODES.MODEL_UNAVAILABLE]: '模型服务不可用',
  [SITE_FUNCTION_CODES.MODEL_TIMEOUT]: '模型服务超时',
  [SITE_FUNCTION_CODES.MODEL_RESPONSE]: '模型服务响应格式非法',
  [SITE_FUNCTION_CODES.RULE_INTENT_REQUEST_INVALID]: '规则理解请求未通过服务端校验',
  [SITE_FUNCTION_CODES.RULE_INTENT_SCOPE]: '规则理解请求超出服务端允许范围',
  [SITE_FUNCTION_CODES.RULE_INTENT_RESPONSE]: '规则理解响应未通过服务端校验',
  [SITE_FUNCTION_CODES.BEHAVIOR_REQUEST_INVALID]: '行为分析请求未通过服务端校验',
  [SITE_FUNCTION_CODES.IMPORT_RECOVER_REQUEST_INVALID]: '账单识别请求未通过服务端校验',
  [SITE_FUNCTION_CODES.IMPORT_RECOVER_RESPONSE]: '账单识别响应未通过服务端校验',
  [SITE_FUNCTION_CODES.IMPORT_VISION_REQUEST_INVALID]: '图片识别请求未通过服务端校验',
  [SITE_FUNCTION_CODES.IMPORT_VISION_RESPONSE]: '图片识别响应未通过服务端校验',
  [SITE_FUNCTION_CODES.PROFILE_SUMMARY_REQUEST_INVALID]: '画像解读请求未通过服务端校验',
  [SITE_FUNCTION_CODES.PROFILE_SUMMARY_RESPONSE]: '画像解读响应未通过服务端校验',
  [SITE_FUNCTION_CODES.PROFILE_FACT_REQUEST_INVALID]: '画像事实请求未通过服务端校验',
  [SITE_FUNCTION_CODES.PROFILE_FACT_RESPONSE]: '画像事实响应未通过服务端校验',
  [SITE_FUNCTION_CODES.RESULT_EXPLANATION_REQUEST_INVALID]: '结果解释请求未通过服务端校验',
  [SITE_FUNCTION_CODES.RESULT_EXPLANATION_RESPONSE]: '结果解释响应未通过服务端校验',
  [SITE_FUNCTION_CODES.SCENARIO_JUDGMENT_REQUEST_INVALID]: '情景判断请求未通过服务端校验',
  [SITE_FUNCTION_CODES.SCENARIO_JUDGMENT_RESPONSE]: '情景判断响应未通过服务端校验',
  [SITE_FUNCTION_CODES.CUSTOM_RULE_JUDGMENT_REQUEST_INVALID]: '自定义规则判定请求未通过服务端校验',
  [SITE_FUNCTION_CODES.CUSTOM_RULE_JUDGMENT_RESPONSE]: '自定义规则判定响应未通过服务端校验',
  [SITE_FUNCTION_CODES.QA_NARRATIVE_REQUEST_INVALID]: '问答解读请求未通过服务端校验',
  [SITE_FUNCTION_CODES.QA_NARRATIVE_RESPONSE]: '问答解读响应未通过服务端校验',
  [SITE_FUNCTION_CODES.MARKET_NOT_CONFIGURED]: '行情未启用：服务端尚未配置 TUSHARE_TOKEN',
  [SITE_FUNCTION_CODES.MARKET_REQUEST_INVALID]: '行情请求未通过服务端校验',
  [SITE_FUNCTION_CODES.MARKET_SYMBOL_UNKNOWN]: '行情标的未在股票列表中找到（请核对 6 位 A 股代码）',
  [SITE_FUNCTION_CODES.MARKET_NO_DATA]: '行情源在请求范围内没有可用数据',
  [SITE_FUNCTION_CODES.MARKET_UNAVAILABLE]: '行情服务不可用',
  [SITE_FUNCTION_CODES.MARKET_TIMEOUT]: '行情服务超时',
  [SITE_FUNCTION_CODES.MARKET_RESPONSE]: '行情服务响应格式非法',
});

const F6 = new Set(['value', 'unit', 'display', 'formula_ref', 'source_ref']);
const INTENT_KEYS = new Set(['question']);
const RESTATE_KEYS = new Set(['question', 'facts']);
const RULE_KEYS = new Set(['text']);
export const RULE_TEXT_MAX_CHARS = 200;
// 规则识别响应的协议版本（仅附加字段，旧客户端忽略；新客户端据此拒绝不认识新模板的旧函数）。
export const RULE_INTENT_PROTOCOL = 'rule-intent-v2';
const MARKET_KEYS = new Set(['symbols', 'start', 'end']);
const MARKET_STATUS = Object.freeze({
  [SITE_FUNCTION_CODES.MARKET_NOT_CONFIGURED]: 503,
  [SITE_FUNCTION_CODES.MARKET_REQUEST_INVALID]: 400,
  [SITE_FUNCTION_CODES.MARKET_SYMBOL_UNKNOWN]: 422,
  [SITE_FUNCTION_CODES.MARKET_NO_DATA]: 422,
  [SITE_FUNCTION_CODES.MARKET_UNAVAILABLE]: 502,
  [SITE_FUNCTION_CODES.MARKET_TIMEOUT]: 504,
  [SITE_FUNCTION_CODES.MARKET_RESPONSE]: 502,
});
const MODEL_STATUS = Object.freeze({
  [SITE_FUNCTION_CODES.MODEL_AUTH_FAILED]: 502,
  [SITE_FUNCTION_CODES.MODEL_FORBIDDEN]: 502,
  [SITE_FUNCTION_CODES.MODEL_RATE_LIMITED]: 429,
  [SITE_FUNCTION_CODES.MODEL_UNAVAILABLE]: 502,
  [SITE_FUNCTION_CODES.MODEL_TIMEOUT]: 504,
  [SITE_FUNCTION_CODES.MODEL_RESPONSE]: 502,
});

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
  if (typeof transport[stage] !== 'function') {
    return { ok: false, status: 502, code: SITE_FUNCTION_CODES.MODEL_UNAVAILABLE };
  }
  try {
    const result = await transport[stage](request);
    if (!isPlainObject(result) || typeof result.rawText !== 'string') {
      return { ok: false, status: 502, code: SITE_FUNCTION_CODES.MODEL_RESPONSE };
    }
    return { ok: true, rawText: result.rawText };
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    const status = MODEL_STATUS[code];
    if (status) return { ok: false, status, code };
    return { ok: false, status: 502, code: SITE_FUNCTION_CODES.MODEL_UNAVAILABLE };
  }
}

function daysBetween(start, end) {
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

function validateMarketBody(body) {
  if (!hasOnlyKeys(body, MARKET_KEYS)) return { ok: false, code: SITE_FUNCTION_CODES.UNKNOWN_FIELD };
  const { symbols, start, end } = body;
  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > MARKET_MAX_SYMBOLS) {
    return { ok: false, code: SITE_FUNCTION_CODES.MARKET_REQUEST_INVALID };
  }
  const unique = new Set();
  for (const symbol of symbols) {
    if (typeof symbol !== 'string' || !/^\d{6}$/.test(symbol) || unique.has(symbol)) {
      return { ok: false, code: SITE_FUNCTION_CODES.MARKET_REQUEST_INVALID };
    }
    unique.add(symbol);
  }
  if (!isMarketDate(start) || !isMarketDate(end) || start > end || daysBetween(start, end) > MARKET_MAX_RANGE_DAYS) {
    return { ok: false, code: SITE_FUNCTION_CODES.MARKET_REQUEST_INVALID };
  }
  return { ok: true, request: { symbols: [...symbols], start, end } };
}

async function callMarketTransport(marketTransport, request) {
  if (marketTransport === null) {
    return { ok: false, status: 503, code: SITE_FUNCTION_CODES.MARKET_NOT_CONFIGURED };
  }
  try {
    const doc = await marketTransport.snapshot(request);
    if (!isPlainObject(doc) || doc.artifact !== DYNAMIC_CACHE_ARTIFACT) {
      return { ok: false, status: 502, code: SITE_FUNCTION_CODES.MARKET_RESPONSE };
    }
    return { ok: true, doc };
  } catch (error) {
    const code = error && MARKET_STATUS[error.code] ? error.code : SITE_FUNCTION_CODES.MARKET_UNAVAILABLE;
    return { ok: false, status: MARKET_STATUS[code], code };
  }
}

export function createHandler({
  transport = null,
  marketTransport = null,
  maxBodyBytes = 64 * 1024,
  maxVisionBodyBytes = 8 * 1024 * 1024,
  now = () => new Date().toISOString(),
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new TypeError('maxBodyBytes 必须为正整数');
  }
  if (!Number.isInteger(maxVisionBodyBytes) || maxVisionBodyBytes <= 0) {
    throw new TypeError('maxVisionBodyBytes 必须为正整数');
  }
  return async function handler(request, { supabase = null } = {}) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
    }
    const path = url.pathname;
    const dataRoute = resolveDataRoute(path, request.method);
    if (dataRoute) {
      if (dataRoute.methodNotAllowed) return dataMethodNotAllowed(dataRoute.allow);
      if (!dataRoute.kind) return errorResponse(404, SITE_FUNCTION_CODES.NOT_FOUND);
      return handleDataRequest({ request, supabase, route: dataRoute, now, randomUUID });
    }
    const stage = path.endsWith('/api/llm/rule-intent')
      ? 'ruleIntent'
      : path.endsWith('/api/llm/custom-rule-judgment')
        ? 'customRuleJudgment'
        : path.endsWith('/api/llm/behavior-analysis')
        ? 'behaviorAnalysis'
        : path.endsWith('/api/llm/result-explanation')
          ? 'resultExplanation'
          : path.endsWith('/api/llm/scenario-judgment')
            ? 'scenarioJudgment'
            : path.endsWith('/api/llm/import-recover')
              ? 'importRecover'
              : path.endsWith('/api/llm/import-vision')
                ? 'importVision'
                : path.endsWith('/api/llm/profile-summary')
                  ? 'profileSummary'
                  : path.endsWith('/api/llm/profile-fact')
                    ? 'profileFact'
                    : path.endsWith('/api/llm/qa-narrative')
                      ? 'qaNarrative'
                    : path.endsWith('/api/llm/intent')
                  ? 'intent'
                  : path.endsWith('/api/llm/restate')
                    ? 'restate'
                    : path.endsWith('/api/llm/rule')
                      ? 'rule'
                      : path.endsWith('/api/market/snapshot')
                        ? 'market'
                        : null;
    if (stage === null) return errorResponse(404, SITE_FUNCTION_CODES.NOT_FOUND);
    if (request.method !== 'POST') {
      return errorResponse(405, SITE_FUNCTION_CODES.METHOD, { Allow: 'POST' });
    }
    if (!parseContentType(request)) {
      return errorResponse(415, SITE_FUNCTION_CODES.CONTENT_TYPE);
    }

    const bodyLimit = stage === 'importVision' ? maxVisionBodyBytes : maxBodyBytes;
    let bodyText;
    try {
      bodyText = (await readBody(request, bodyLimit)).text;
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

    if (stage === 'market') {
      const validated = validateMarketBody(body);
      if (!validated.ok) return errorResponse(400, validated.code);
      const result = await callMarketTransport(marketTransport, validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      return jsonResponse(200, { ok: true, market: result.doc });
    }

    if (stage === 'behaviorAnalysis') {
      const validated = normalizeBehaviorFactsRequest(body);
      if (!validated.ok) return errorResponse(400, SITE_FUNCTION_CODES.BEHAVIOR_REQUEST_INVALID);
      const facts = buildBehaviorFacts(validated.request);
      let aiValue = null;
      let fallbackReason = null;
      if (transport === null) {
        fallbackReason = 'model_not_configured';
      } else if (typeof transport.behaviorAnalysis !== 'function') {
        fallbackReason = 'model_unavailable';
      } else {
        try {
          const result = await transport.behaviorAnalysis({ facts: behaviorFactsForAi(facts) });
          if (!isPlainObject(result) || typeof result.rawText !== 'string') {
            fallbackReason = 'model_response_invalid';
          } else {
            const checked = validateBehaviorAiResponse(result.rawText, facts);
            if (checked.ok) aiValue = checked.value;
            else fallbackReason = checked.reason;
          }
        } catch (error) {
          fallbackReason = error && error.code === SITE_FUNCTION_CODES.MODEL_TIMEOUT ? 'model_timeout' : 'model_unavailable';
        }
      }
      const analysis = aiValue
        ? buildAiBehaviorAnalysis(aiValue, facts)
        : buildBehaviorFallback(facts, fallbackReason ?? 'model_unavailable');
      return jsonResponse(200, { ok: true, analysis });
    }

    if (stage === 'profileSummary') {
      const validated = normalizeProfileSummaryRequest(body);
      if (!validated.ok) return errorResponse(400, SITE_FUNCTION_CODES.PROFILE_SUMMARY_REQUEST_INVALID);
      const sourceHash = await profileDigestHash(validated.digest);
      let summary = null;
      let fallbackReason = null;
      let fallbackDetail = null;
      if (transport === null) {
        fallbackReason = 'model_not_configured';
      } else if (typeof transport.profileSummary !== 'function') {
        fallbackReason = 'model_unavailable';
      } else {
        try {
          const result = await transport.profileSummary({ digest: validated.digest });
          if (!isPlainObject(result) || typeof result.rawText !== 'string') {
            fallbackReason = 'model_response_invalid';
            fallbackDetail = 'invalid_shape';
          } else {
            const checked = validateProfileSummaryResponse(result.rawText, validated.digest);
            if (checked.ok) summary = checked.value;
            else {
              fallbackReason = 'model_response_invalid';
              fallbackDetail = checked.detail ?? 'invalid_shape';
            }
          }
        } catch (error) {
          fallbackReason = error && error.code === SITE_FUNCTION_CODES.MODEL_TIMEOUT ? 'model_timeout' : 'model_unavailable';
        }
      }
      return jsonResponse(200, {
        ok: true,
        source: summary ? 'ai' : 'template',
        source_hash: sourceHash,
        summary: summary ?? buildProfileSummaryFallback(validated.digest),
        fallback_reason: summary ? null : fallbackReason,
        fallback_detail: summary ? null : fallbackDetail,
      });
    }

    if (stage === 'profileFact') {
      const validated = normalizeProfileFactRequest(body);
      if (!validated.ok) return errorResponse(400, SITE_FUNCTION_CODES.PROFILE_FACT_REQUEST_INVALID);
      const result = await callTransport(transport, 'profileFact', { message: validated.message });
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateProfileFactResponse(result.rawText, validated.message);
      if (!checked.ok) return errorResponse(502, SITE_FUNCTION_CODES.PROFILE_FACT_RESPONSE);
      return jsonResponse(200, { ok: true, facts: checked.facts });
    }

    if (stage === 'qaNarrative') {
      const validated = normalizeQaNarrativeRequest(body);
      if (!validated.ok) return errorResponse(400, SITE_FUNCTION_CODES.QA_NARRATIVE_REQUEST_INVALID);
      const result = await callTransport(transport, 'qaNarrative', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateQaNarrativeResponse(result.rawText, validated.request);
      if (!checked.ok) return errorResponse(502, SITE_FUNCTION_CODES.QA_NARRATIVE_RESPONSE);
      return jsonResponse(200, { rawText: JSON.stringify({ answer_text: checked.answer_text }) });
    }

    let requestBody;
    if (stage === 'ruleIntent') {
      const validated = normalizeRuleIntentRequest(body);
      if (!validated.ok) {
        return errorResponse(400, validated.code);
      }
      const result = await callTransport(transport, 'ruleIntent', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateRuleIntentResponse(
        result.rawText,
        validated.request.allowed_templates.map((t) => t.template_id),
      );
      if (!checked.ok) {
        return errorResponse(502, SITE_FUNCTION_CODES.RULE_INTENT_RESPONSE);
      }
      return jsonResponse(200, { rawText: JSON.stringify(checked.value) });
    }
    if (stage === 'resultExplanation') {
      const validated = normalizeResultExplanationRequest(body);
      if (!validated.ok) return errorResponse(400, validated.code);
      const result = await callTransport(transport, 'resultExplanation', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateResultExplanationResponse(result.rawText, validated.request);
      if (!checked.ok) {
        return errorResponse(502, SITE_FUNCTION_CODES.RESULT_EXPLANATION_RESPONSE);
      }
      const binding = {
        flow_id: validated.request.flow_id,
        request_id: validated.request.request_id,
        rule_version: validated.request.rule.version,
        rule_hash: validated.request.rule.hash,
        scope: validated.request.rule.scope,
        simulation_result_id: validated.request.simulation.result_id,
      };
      return jsonResponse(200, {
        rawText: JSON.stringify({ answer_text: checked.answer_text, binding }),
      });
    }
    if (stage === 'scenarioJudgment') {
      const validated = normalizeScenarioJudgmentRequest(body);
      if (!validated.ok) return errorResponse(400, validated.code);
      const result = await callTransport(transport, 'scenarioJudgment', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateScenarioJudgmentResponse(result.rawText);
      if (!checked.ok) return errorResponse(502, SITE_FUNCTION_CODES.SCENARIO_JUDGMENT_RESPONSE);
      const binding = {
        flow_id: validated.request.flow_id,
        request_id: validated.request.request_id,
        scenario_id: validated.request.scenario_id,
        rule_set_hash: validated.request.rule_set_hash,
      };
      return jsonResponse(200, {
        rawText: JSON.stringify({
          judgment: checked.judgment,
          answer_text: checked.answer_text,
          binding,
        }),
      });
    }
    if (stage === 'customRuleJudgment') {
      const validated = normalizeCustomRuleJudgmentRequest(body);
      if (!validated.ok) return errorResponse(400, validated.code);
      const result = await callTransport(transport, 'customRuleJudgment', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateCustomRuleJudgmentResponse(result.rawText);
      if (!checked.ok) return errorResponse(502, SITE_FUNCTION_CODES.CUSTOM_RULE_JUDGMENT_RESPONSE);
      const binding = {
        flow_id: validated.request.flow_id,
        request_id: validated.request.request_id,
        judgment_id: validated.request.judgment_id,
        rule_id: validated.request.rule.rule_id,
        rule_hash: validated.request.rule.hash,
        rule_version: validated.request.rule.version,
        rule_action: validated.request.rule.action,
        scenario_symbol: validated.request.scenario.symbol,
        scenario_requested_date: validated.request.scenario.requested_date,
        scenario_action: validated.request.scenario.action,
      };
      return jsonResponse(200, {
        rawText: JSON.stringify({
          verdict: checked.verdict,
          reason: checked.reason,
          used_data: checked.used_data,
          binding,
        }),
      });
    }
    if (stage === 'importRecover') {
      const validated = normalizeImportRecoverRequest(body);
      if (!validated.ok) {
        return errorResponse(400, SITE_FUNCTION_CODES.IMPORT_RECOVER_REQUEST_INVALID);
      }
      const result = await callTransport(transport, 'importRecover', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateImportRecoverResponse(result.rawText);
      if (!checked.ok) {
        return errorResponse(502, SITE_FUNCTION_CODES.IMPORT_RECOVER_RESPONSE);
      }
      return jsonResponse(200, { rawText: JSON.stringify(checked.value) });
    }
    if (stage === 'importVision') {
      const validated = normalizeImportVisionRequest(body);
      if (!validated.ok) {
        return errorResponse(400, SITE_FUNCTION_CODES.IMPORT_VISION_REQUEST_INVALID);
      }
      const result = await callTransport(transport, 'vision', validated.request);
      if (!result.ok) return errorResponse(result.status, result.code);
      const checked = validateImportVisionResponse(result.rawText);
      if (!checked.ok) {
        return errorResponse(502, SITE_FUNCTION_CODES.IMPORT_VISION_RESPONSE);
      }
      return jsonResponse(200, { rawText: JSON.stringify(checked.value) });
    }
    if (stage === 'rule') {
      if (!hasOnlyKeys(body, RULE_KEYS)) {
        return errorResponse(400, SITE_FUNCTION_CODES.UNKNOWN_FIELD);
      }
      if (typeof body.text !== 'string' || body.text.trim() === '' || [...body.text].length > RULE_TEXT_MAX_CHARS) {
        return errorResponse(400, SITE_FUNCTION_CODES.REQUEST_INVALID);
      }
      requestBody = { text: body.text };
    } else if (stage === 'intent') {
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
    if (stage === 'intent') {
      const checked = validateChatIntentResponse(result.rawText);
      if (!checked.ok) return errorResponse(502, SITE_FUNCTION_CODES.MODEL_RESPONSE);
      return jsonResponse(200, { rawText: JSON.stringify(checked.value) });
    }
    return jsonResponse(200, stage === 'rule'
      ? { rawText: result.rawText, protocol: RULE_INTENT_PROTOCOL }
      : { rawText: result.rawText });
  };
}
