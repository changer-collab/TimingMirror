// M1-C11 · 分析问答最小在线复述接线（接口候选，未冻结）
// 链路：prepareAnswerFacts（仅 loss_overview + portfolio 四事实）
//   → exportFacts 取 F-6 事实（value/unit/display/formula_ref/source_ref）
//   → onlineBoundary.restate（站点同源函数，本地数字校验）
//   → 仅 ok 返回复述；失败只返回错误码与计数，不携带候选文本。
// 边界：不直接调用百炼、不读取凭证、不重算、不扩大到其他意图；无 DOM / localStorage。
import { createOnlineBoundary, ONLINE_BOUNDARY_CODES } from './onlineBoundary.js';
import {
  createHttpTransport,
  SAME_ORIGIN_BASE,
  SITE_FUNCTION_PATHS,
  HTTP_TRANSPORT_CODES,
} from './httpTransport.js';
import { prepareAnswerFacts, ANSWER_ALLOWED_KEYS, ANSWER_FACTS_CODES } from './answerFacts.js';
import { exportFacts } from './factExport.js';

export const CHAT_ONLINE_CODES = Object.freeze({
  REVIEW_INVALID: 'E_CHAT_REVIEW_INVALID',
  FACTS_UNAVAILABLE: 'W_CHAT_FACTS_UNAVAILABLE',
  UNEXPECTED: 'E_CHAT_UNEXPECTED',
});

// 本模块唯一支持的组合；其余不进入事实链。
export const CHAT_ONLINE_SCOPE = Object.freeze({ intent: 'loss_overview', scope: 'portfolio' });

export const CHAT_ONLINE_FALLBACK_TEXT = '本次未能展示在线复述：回答未通过本地校验，或在线链路当前不可用。为避免展示未经核对的内容，已停止输出；可在「报告 · 证据」页查看已复核的组合结论。';

const FAILURE_TEXT = Object.freeze({
  [CHAT_ONLINE_CODES.REVIEW_INVALID]: '账单复核结果不可用（需已确认的本地账单）',
  [CHAT_ONLINE_CODES.FACTS_UNAVAILABLE]: '组合四事实不可用（未发布或不完整）',
  [CHAT_ONLINE_CODES.UNEXPECTED]: '页面链路出现未预期错误',
  [ANSWER_FACTS_CODES.COMBO_UNSUPPORTED]: '当前问题不在已支持范围（仅 loss_overview · portfolio）',
  [ANSWER_FACTS_CODES.PORTFOLIO_WITHHELD]: '组合结论未发布（可能缺价或复核未通过），不能在线复述',
  [ANSWER_FACTS_CODES.EXPORT_NOT_OK]: '已复核事实导出未通过，不能在线复述',
  [ANSWER_FACTS_CODES.FACTS_INCOMPLETE]: '组合四事实不完整，不能在线复述',
  [ANSWER_FACTS_CODES.PREPARE_WITHHELD]: '本地事实快照未生成，不能在线复述',
  [ONLINE_BOUNDARY_CODES.TRANSPORT_TIMEOUT]: '在线请求超时',
  [ONLINE_BOUNDARY_CODES.TRANSPORT_NETWORK]: '无法连接在线服务',
  [ONLINE_BOUNDARY_CODES.TRANSPORT_FAILURE]: '在线服务调用失败',
  [ONLINE_BOUNDARY_CODES.TRANSPORT_RESPONSE]: '在线服务响应格式异常',
  [ONLINE_BOUNDARY_CODES.QUESTION_INVALID]: '问题文本无效',
  [ONLINE_BOUNDARY_CODES.QUESTION_BLOCKED]: '问题未通过本地策略',
  [ONLINE_BOUNDARY_CODES.QUESTION_POLICY_FAILED]: '本地问题策略执行失败',
  [ONLINE_BOUNDARY_CODES.REQUEST_INVALID]: '在线请求未通过本地校验',
  [ONLINE_BOUNDARY_CODES.FACT_INVALID]: '待复述事实格式非法',
  [ONLINE_BOUNDARY_CODES.FACT_FIELD_INVALID]: '待复述事实字段非法',
  [ONLINE_BOUNDARY_CODES.FACTS_EMPTY]: '待复述事实为空',
  [ONLINE_BOUNDARY_CODES.INTENT_JSON]: '意图响应不是合法 JSON',
  [ONLINE_BOUNDARY_CODES.INTENT_SCHEMA]: '意图响应格式不符合约定',
  [ONLINE_BOUNDARY_CODES.RESTATE_JSON]: '复述响应不是合法 JSON',
  [ONLINE_BOUNDARY_CODES.RESTATE_SCHEMA]: '复述响应格式不符合约定',
  [ONLINE_BOUNDARY_CODES.RESTATE_EMPTY]: '在线返回的复述为空',
  [ONLINE_BOUNDARY_CODES.NUMBERS_FAILED]: '复述中的可识别数字未通过本地校验',
  [HTTP_TRANSPORT_CODES.CONFIG]: '在线服务地址配置非法',
  [HTTP_TRANSPORT_CODES.NETWORK]: '无法连接在线服务',
  [HTTP_TRANSPORT_CODES.ABORTED]: '在线请求已取消',
  [HTTP_TRANSPORT_CODES.STATUS]: '在线服务当前不可用（函数未发布或未激活时会这样）',
  [HTTP_TRANSPORT_CODES.JSON]: '在线服务响应不是合法 JSON',
  [HTTP_TRANSPORT_CODES.RESPONSE]: '在线服务响应格式异常',
});

export function chatFailureText(code) {
  return FAILURE_TEXT[code] ?? `在线复述未通过（${String(code)}）`;
}

export function numberCheckDetail(numberCheck) {
  if (numberCheck === null || typeof numberCheck !== 'object') return '';
  const checked = Number.isFinite(numberCheck.checked) ? numberCheck.checked : 0;
  const matched = Number.isFinite(numberCheck.matched_count) ? numberCheck.matched_count : 0;
  const failed = Number.isFinite(numberCheck.failed_count) ? numberCheck.failed_count : 0;
  return `已核对 ${checked} 个可识别数字（匹配 ${matched}，未通过 ${failed}）`;
}

function failure(code, stage, { numberCheck = null, latencyMs = null } = {}) {
  return {
    ok: false,
    stage,
    code,
    number_check: numberCheck,
    latency_ms: latencyMs,
  };
}

/* 默认 transport：站点同源函数；本地开发与云草稿未激活时请求会失败并走兜底。 */
export function createChatOnline({ transport = null, timeoutMs = 8000, fetchImpl = undefined } = {}) {
  const activeTransport = transport ?? createHttpTransport({
    baseUrl: SAME_ORIGIN_BASE,
    paths: SITE_FUNCTION_PATHS,
    fetchImpl,
  });
  const boundary = createOnlineBoundary({ transport: activeTransport, timeoutMs });

  async function ask({ question, review } = {}) {
    if (review === null || typeof review !== 'object') {
      return failure(CHAT_ONLINE_CODES.REVIEW_INVALID, 'review');
    }
    const prepared = prepareAnswerFacts({ review, ...CHAT_ONLINE_SCOPE });
    if (prepared.status !== 'prepared') {
      return failure(prepared.diagnostics[0]?.code ?? ANSWER_FACTS_CODES.PREPARE_WITHHELD, 'prepare');
    }
    const exported = exportFacts({ review, ...CHAT_ONLINE_SCOPE });
    if (exported.status !== 'ok') {
      return failure(ANSWER_FACTS_CODES.EXPORT_NOT_OK, 'export');
    }
    const byKey = new Map();
    for (const fact of exported.facts) {
      if (fact.scope === CHAT_ONLINE_SCOPE.scope && ANSWER_ALLOWED_KEYS.includes(fact.key)) byKey.set(fact.key, fact);
    }
    if (byKey.size !== ANSWER_ALLOWED_KEYS.length) {
      return failure(CHAT_ONLINE_CODES.FACTS_UNAVAILABLE, 'export');
    }
    const facts = ANSWER_ALLOWED_KEYS.map((key) => byKey.get(key));
    const result = await boundary.restate({ question, facts });
    if (!result.ok) {
      return failure(result.code, result.stage, {
        numberCheck: result.data?.number_check ?? null,
        latencyMs: result.meta?.latency_ms ?? null,
      });
    }
    return {
      ok: true,
      stage: 'restate',
      code: null,
      text: result.data.draft,
      number_check: result.data.number_check,
      latency_ms: result.meta?.latency_ms ?? null,
    };
  }

  return Object.freeze({ ask });
}
