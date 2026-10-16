// 主线 C（首项任务）· 本地两阶段事实快照与回答数字检查（确定性纯函数；接口候选，未冻结）
// 阶段一 prepareAnswerFacts：复用 factExport（M1-C10）从 reviewPipeline（M1-C7）实际输出离线导出，
//   要求组合结论已发布（portfolio_published === true）且导出 status='ok'，
//   仅复制并冻结组合级四事实（actualRet / ghostRet / drag / dragMoney）；缺任一项 → withheld。
//   本阶段唯一支持 intent='loss_overview' + scope='portfolio'，其余组合一律 withheld（不猜测、不回退）。
// 阶段二 checkPreparedAnswer：只使用该快照复用 checkNumbers（M1-C10）校验回答中的可识别数字；
//   不重新读取 review、不重新导出、不重算或改写数字。
// 返回语义：
//   · numbers_passed 仅表示可识别数字子集检查通过——不表示事实含义正确、不表示已发布、不表示在线链路完成；
//   · 失败返回 withheld + 固定无数字文字，不复用原候选回答；最小本地检查记录只含计数与错误码（不含失败数字原文）；
//   · 本阶段 llm_mode='offline_fallback'（无模型调用，离线桩）、source='offline_stub'，不伪造 plan_id / 延迟 / 代理调用记录；
//   · prepared 只用于本地检查，不作为网络请求体。
// 已知限制（如实保留，未解决）：中文数字不纳入识别；数字子集通过不检查语义错配。
// 边界：纯函数；无 DOM / localStorage / 网络 / 模型调用；不持久化、不记录原始交易。
import { exportFacts } from './factExport.js';
import { checkNumbers } from './numberCheck.js';

export const ANSWER_FACTS_CODES = Object.freeze({
  COMBO_UNSUPPORTED: 'W_ANSWER_COMBO_UNSUPPORTED',
  INPUT_INVALID: 'E_ANSWER_INPUT_INVALID',
  PORTFOLIO_WITHHELD: 'W_ANSWER_PORTFOLIO_WITHHELD',
  EXPORT_NOT_OK: 'W_ANSWER_EXPORT_NOT_OK',
  FACTS_INCOMPLETE: 'W_ANSWER_FACTS_INCOMPLETE',
  PREPARE_WITHHELD: 'W_ANSWER_PREPARE_WITHHELD',
  PREPARED_INVALID: 'E_ANSWER_PREPARED_INVALID',
  NUMBERS_FAILED: 'W_ANSWER_NUMBERS_FAILED',
});

export const ANSWER_FACTS_WITHHELD_TEXT = '本次回答未通过本地数字校验，已暂停展示；离线模式不提供替代结论。';

export const ANSWER_ALLOWED_KEYS = Object.freeze(['actualRet', 'ghostRet', 'drag', 'dragMoney']);

export const ANSWER_LLM_MODE = 'offline_fallback';
export const ANSWER_SOURCE = 'offline_stub';

const SUPPORTED_ANSWER_INTENT = 'loss_overview';
const SUPPORTED_ANSWER_SCOPE = 'portfolio';

function withheldPrepared(code, message) {
  return Object.freeze({
    status: 'withheld',
    diagnostics: Object.freeze([Object.freeze({ code, message })]),
  });
}

/**
 * 阶段一：复制并冻结组合四事实快照（候选接口）。
 * @param {object} input
 * @param {object} input.review runReview（M1-C7）的实际输出
 * @param {string} input.intent 仅支持 'loss_overview'
 * @param {string} input.scope 仅支持 'portfolio'
 * @returns {{status:'prepared', intent, scope, fact_set_version, facts: Array, diagnostics: Array}|{status:'withheld', diagnostics: Array}}
 */
export function prepareAnswerFacts({ review, intent, scope } = {}) {
  if (intent !== SUPPORTED_ANSWER_INTENT || scope !== SUPPORTED_ANSWER_SCOPE) {
    return withheldPrepared(
      ANSWER_FACTS_CODES.COMBO_UNSUPPORTED,
      '本阶段仅支持 intent=loss_overview 且 scope=portfolio 的组合：其余组合不生成快照（不猜测、不回退）',
    );
  }
  if (review === null || typeof review !== 'object') {
    return withheldPrepared(ANSWER_FACTS_CODES.INPUT_INVALID, 'review 非法或缺失：不生成快照');
  }
  if (review.portfolio_published !== true) {
    return withheldPrepared(
      ANSWER_FACTS_CODES.PORTFOLIO_WITHHELD,
      '组合结论未发布（portfolio_published 非 true）：四事实快照不生成（不按剩余标的冒充完整组合）',
    );
  }
  const exported = exportFacts({ review, intent, scope });
  if (exported.status !== 'ok') {
    return withheldPrepared(
      ANSWER_FACTS_CODES.EXPORT_NOT_OK,
      `事实导出未通过（status=${exported.status}）：不生成快照（blocked / invalid / unsupported 的数字不得进入）`,
    );
  }
  const byKey = new Map();
  for (const f of exported.facts) if (f.scope === SUPPORTED_ANSWER_SCOPE) byKey.set(f.key, f);
  const missing = ANSWER_ALLOWED_KEYS.filter((k) => !byKey.has(k));
  if (missing.length > 0) {
    return withheldPrepared(
      ANSWER_FACTS_CODES.FACTS_INCOMPLETE,
      `组合四事实不齐（缺少：${missing.join('、')}）：不生成快照`,
    );
  }
  const facts = Object.freeze(ANSWER_ALLOWED_KEYS.map((k) => {
    const f = byKey.get(k);
    return Object.freeze({
      fact_ref: f.fact_ref,
      key: f.key,
      value: f.value,
      unit: f.unit ?? null,
      display: f.display ?? null,
    });
  }));
  return Object.freeze({
    status: 'prepared',
    intent: SUPPORTED_ANSWER_INTENT,
    scope: SUPPORTED_ANSWER_SCOPE,
    fact_set_version: exported.fact_set_version,
    facts,
    diagnostics: Object.freeze([]),
  });
}

function freezeRecord(checked, matchedCount, failedCount, failedCodes) {
  return Object.freeze({
    checked,
    matched_count: matchedCount,
    failed_count: failedCount,
    failed_codes: Object.freeze([...failedCodes]),
  });
}

function withheldAnswer(code, message, record) {
  return Object.freeze({
    status: 'withheld',
    text: ANSWER_FACTS_WITHHELD_TEXT,
    llm_mode: ANSWER_LLM_MODE,
    source: ANSWER_SOURCE,
    check_record: record,
    diagnostics: Object.freeze([Object.freeze({ code, message })]),
  });
}

function snapshotShapeOk(prepared) {
  if (prepared === null || typeof prepared !== 'object' || prepared.status !== 'prepared') return false;
  if (!Array.isArray(prepared.facts) || prepared.facts.length !== ANSWER_ALLOWED_KEYS.length) return false;
  return ANSWER_ALLOWED_KEYS.every((key) => {
    const f = prepared.facts.find((x) => x !== null && typeof x === 'object' && x.key === key);
    return f !== undefined
      && typeof f.fact_ref === 'string'
      && typeof f.value === 'number'
      && (f.display === null || typeof f.display === 'string')
      && (f.unit === null || f.unit === undefined || typeof f.unit === 'string');
  });
}

/**
 * 阶段二：只据快照校验回答中的可识别数字（候选接口）。
 * @param {object} input
 * @param {object} input.prepared prepareAnswerFacts 的输出（withheld 或非法形状 → 整体 withheld）
 * @param {string} input.answerText 待校验的候选回答文本
 * @returns {{status:'numbers_passed', verification_scope, note, llm_mode, source, check_record, diagnostics: Array}|{status:'withheld', text, llm_mode, source, check_record, diagnostics: Array}}
 */
export function checkPreparedAnswer({ prepared, answerText } = {}) {
  const zeros = freezeRecord(0, 0, 0, []);
  if (prepared !== null && typeof prepared === 'object' && prepared.status === 'withheld') {
    return withheldAnswer(
      ANSWER_FACTS_CODES.PREPARE_WITHHELD,
      '上游事实快照未生成（withheld）：回答不输出（不用原候选回答兜底）',
      zeros,
    );
  }
  if (!snapshotShapeOk(prepared)) {
    return withheldAnswer(
      ANSWER_FACTS_CODES.PREPARED_INVALID,
      'prepared 非法或形状不符（应恰为组合四事实的已冻结快照）：回答不输出',
      zeros,
    );
  }
  if (typeof answerText !== 'string') {
    return withheldAnswer(ANSWER_FACTS_CODES.INPUT_INVALID, 'answerText 非法（须为字符串）：回答不输出', zeros);
  }
  const num = checkNumbers(answerText, { status: 'ok', facts: prepared.facts });
  if (!num.ok) {
    return withheldAnswer(
      ANSWER_FACTS_CODES.NUMBERS_FAILED,
      '回答中的可识别数字未全部通过校验：停止输出（不换算、不舍入、不回退原候选回答）',
      freezeRecord(num.checked, num.matched.length, num.failed.length, [...new Set(num.failed.map((f) => f.code))]),
    );
  }
  return Object.freeze({
    status: 'numbers_passed',
    verification_scope: 'recognizable_numbers_subset',
    note: '仅表示可识别数字子集检查通过：不表示事实含义正确、不表示已发布、不表示在线链路完成',
    llm_mode: ANSWER_LLM_MODE,
    source: ANSWER_SOURCE,
    check_record: freezeRecord(num.checked, num.matched.length, 0, []),
    diagnostics: Object.freeze([]),
  });
}
