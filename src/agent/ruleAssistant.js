// 首版规则助手（主线 C；接口候选，未冻结）
// 链路：用户主动点击 → 本地预检 → 受限规则 intent（注入 transport）
//       → 本地 schema/模板/字段校验 → 受限计划 → 草案（不保存）
//       → 用户在规则页确认/保存 → 历史模拟（复用现有 adapter/规则页）
//       → 一致性检查与本地证据摘要 → 四类 trace。
// 边界：不直接调用模型/网络；不计算金额；不保存规则；不决定复核通过；
//       不发送原始 CSV/成交行/账户信息；预算、重试与超时均在本模块内计数。
import { hashQuestion } from './planner.js';
import { CONTRACT_TEMPLATES, parseContract } from '../engine/contractMatch.js';
import { exportTraceJsonl } from './traceAudit.js';

export const RULE_ASSISTANT_STAGE = 'draft_rule';
export const RULE_ASSISTANT_MAX_MODEL_CALLS = 2;
export const RULE_ASSISTANT_TIMEOUT_MS = 8000;
export const RULE_ASSISTANT_MIN_CONFIDENCE = 0.5;

export const RULE_ASSISTANT_ALLOWED_INTENTS = Object.freeze(['contract_setup']);
export const RULE_ASSISTANT_ALLOWED_TEMPLATES = Object.freeze(['no_buy_on_surge', 'no_buy_back_within']);
export const RULE_ASSISTANT_ALLOWED_TOOLS = Object.freeze(['contract.parse', 'contract.match']);

export const RULE_ASSISTANT_CODES = Object.freeze({
  INPUT_INVALID: 'E_RULE_ASSISTANT_INPUT_INVALID',
  LOCAL_BLOCKED: 'W_RULE_ASSISTANT_LOCAL_BLOCKED',
  MODEL_TIMEOUT: 'W_RULE_ASSISTANT_MODEL_TIMEOUT',
  MODEL_UNAVAILABLE: 'W_RULE_ASSISTANT_MODEL_UNAVAILABLE',
  MODEL_RESPONSE: 'E_RULE_ASSISTANT_MODEL_RESPONSE',
  CLARIFY: 'W_RULE_ASSISTANT_CLARIFY',
  UNSUPPORTED: 'W_RULE_ASSISTANT_UNSUPPORTED',
  BUDGET_EXHAUSTED: 'W_RULE_ASSISTANT_BUDGET_EXHAUSTED',
  NOT_CONFIRMED: 'W_RULE_ASSISTANT_NOT_CONFIRMED',
  NOT_EXECUTED: 'W_RULE_ASSISTANT_NOT_EXECUTED',
  CONSISTENCY_MISMATCH: 'E_RULE_ASSISTANT_CONSISTENCY_MISMATCH',
});

const LOCAL_BLOCKED_PATTERNS = Object.freeze([
  /(csv|原始账单|成交明细|交易记录|账户号|银行卡|身份证|手机号|api[_ -]?key|apikey|token|密码|凭据|credential|authorization)/i,
  /(预测|荐股|止损|止盈|自动交易|明天|会涨|会跌|涨吗|跌吗|买入建议|卖出建议)/,
  /(S3|S4|V2|买入侧|全部卖出|再投资|一直持有|持有到估值日|如果当时没有卖|当时没卖|不卖会怎样)/i,
]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isSymbol = (v) => typeof v === 'string' && /^\d{6}$/.test(v);
const isShortString = (v, max = 64) => typeof v === 'string' && v.length > 0 && v.length <= max;
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

function failure(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function localGate(question) {
  if (typeof question !== 'string' || question.trim() === '') {
    return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '规则表达不能为空');
  }
  if (question.length > 1000) {
    return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '规则表达过长（上限 1000 字符）');
  }
  if (LOCAL_BLOCKED_PATTERNS.some((re) => re.test(question))) {
    return failure(RULE_ASSISTANT_CODES.LOCAL_BLOCKED, '本地预检拒绝：该请求涉及原始数据/隐私、未批准规则或未定义场景；未发送模型请求');
  }
  return { ok: true };
}

function sanitizeContextSummary(raw = {}) {
  const out = { object_type: 'rule' };
  if (isSymbol(raw.symbol)) out.symbol = raw.symbol;
  if (isDate(raw.as_of_date)) out.as_of_date = raw.as_of_date;
  if (Array.isArray(raw.confirmed_rule_versions)) {
    const versions = raw.confirmed_rule_versions.filter((v) => isShortString(v)).slice(0, 20);
    if (versions.length > 0) out.confirmed_rule_versions = versions;
  }
  if (isShortString(raw.data_snapshot_id)) out.data_snapshot_id = raw.data_snapshot_id;
  return out;
}

export function buildRuleIntentRequest({ question, contextSummary = {} } = {}) {
  return {
    question,
    stage: RULE_ASSISTANT_STAGE,
    allowed_intents: [...RULE_ASSISTANT_ALLOWED_INTENTS],
    allowed_templates: [...RULE_ASSISTANT_ALLOWED_TEMPLATES],
    allowed_tools: [...RULE_ASSISTANT_ALLOWED_TOOLS],
    context_summary: sanitizeContextSummary(contextSummary),
  };
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function sameFields(a, b) {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return keys.size === Object.keys(left).length
    && keys.size === Object.keys(right).length
    && [...keys].every((key) => toNumber(left[key]) === toNumber(right[key]));
}

export function validateRuleIntentResponse(rawText) {
  if (typeof rawText !== 'string') return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, '模型响应不是字符串');
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, '模型响应不是合法 JSON');
  }
  if (!isObject(parsed)) return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, '模型响应必须为对象');
  const allowedKeys = new Set(['intent', 'confidence', 'slots', 'template_id', 'fields', 'clarify', 'unsupported']);
  const extra = Object.keys(parsed).filter((k) => !allowedKeys.has(k));
  if (extra.length > 0) return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, `模型响应包含不允许字段：${extra.join(',')}`);
  if (parsed.intent !== 'contract_setup') return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, 'intent 必须为 contract_setup');
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)
    || parsed.confidence < 0 || parsed.confidence > 1) {
    return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, 'confidence 必须为 [0,1] 数值');
  }
  const clarify = typeof parsed.clarify === 'string' && parsed.clarify.trim() !== '' ? parsed.clarify.trim() : null;
  const unsupported = typeof parsed.unsupported === 'string' && parsed.unsupported.trim() !== '' ? parsed.unsupported.trim() : null;
  if (clarify !== null && unsupported !== null) return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, 'clarify 与 unsupported 不能同时存在');
  if (clarify !== null) return { ok: true, kind: 'clarify', confidence: parsed.confidence, message: clarify };
  if (unsupported !== null) return { ok: true, kind: 'unsupported', confidence: parsed.confidence, message: unsupported };
  if (parsed.confidence < RULE_ASSISTANT_MIN_CONFIDENCE) {
    return { ok: true, kind: 'clarify', confidence: parsed.confidence, message: '模型置信度不足；请补充规则模板或数值后再试' };
  }
  if (typeof parsed.template_id !== 'string' || !RULE_ASSISTANT_ALLOWED_TEMPLATES.includes(parsed.template_id)) {
    return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, 'template_id 不在允许范围');
  }
  if (!isObject(parsed.fields)) return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, 'fields 必须为对象');
  const template = CONTRACT_TEMPLATES[parsed.template_id];
  const expected = Object.keys(template.fields);
  const actual = Object.keys(parsed.fields);
  if (actual.length !== expected.length || expected.some((k) => !actual.includes(k))) {
    return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, 'fields 必须恰好包含模板字段，不套默认值');
  }
  const fields = {};
  for (const key of expected) {
    const spec = template.fields[key];
    const value = toNumber(parsed.fields[key]);
    if (value === null) return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, `字段 ${key} 必须为数字`);
    if (value < spec.min || (spec.integer && !Number.isInteger(value))) {
      return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, `字段 ${key} 取值非法`);
    }
    fields[key] = value;
  }
  const parsedContract = parseContract({ template_id: parsed.template_id, fields });
  if (!parsedContract.supported) {
    return failure(RULE_ASSISTANT_CODES.MODEL_RESPONSE, parsedContract.message ?? '规则模板解析失败');
  }
  return {
    ok: true,
    kind: 'draft',
    confidence: parsed.confidence,
    draft: {
      template_id: parsed.template_id,
      template_name: template.name,
      fields,
      text: parsedContract.text,
      threshold: parsedContract.threshold ?? null,
      reminder: parsedContract.reminder,
      hash: parsedContract.hash,
      hash_algorithm: parsedContract.hash_algorithm,
    },
  };
}

function planForDraft(question, draft) {
  const planId = `plan-${hashQuestion(JSON.stringify({ question, template_id: draft.template_id, fields: draft.fields })).slice(0, 12)}`;
  return {
    plan_id: planId,
    intent: 'contract_setup',
    template_id: draft.template_id,
    composition_reason: '规则模板解析→用户确认→历史模拟',
    status: 'needs_confirmation',
    executed: false,
    steps: [
      { tool: 'contract.parse', status: 'ready', params_keys: ['template_id', 'fields'], missing: [] },
      { tool: 'contract.match', status: 'pending_confirmation', params_keys: ['symbol', 'date', 'trades', 'tradingDays'], missing: [] },
    ],
  };
}

function summarizeSimulation(simulation) {
  if (!isObject(simulation)) return null;
  const results = Array.isArray(simulation.results) ? simulation.results.map((r) => ({
    ok: r && r.ok === true,
    verdict: r && typeof r.verdict === 'string' ? r.verdict : null,
    rule_hash: r && r.rule && typeof r.rule.hash === 'string' ? r.rule.hash : null,
    template_id: r && r.rule && typeof r.rule.template_id === 'string' ? r.rule.template_id : null,
  })) : [];
  const summary = isObject(simulation.summary) ? {
    triggered: simulation.summary.triggered ?? 0,
    not_triggered: simulation.summary.not_triggered ?? 0,
    missing_data: simulation.summary.missing_data ?? 0,
    error: simulation.summary.error ?? 0,
  } : { triggered: 0, not_triggered: 0, missing_data: 0, error: 0 };
  return { ok: simulation.ok === true, summary, results };
}

function normalizeSavedRule(raw, label = '规则') {
  if (!isObject(raw) || typeof raw.template_id !== 'string'
    || !isObject(raw.fields) || typeof raw.hash !== 'string') {
    return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, `${label}缺少 template_id/fields/hash`);
  }
  const parsed = parseContract({ template_id: raw.template_id, fields: raw.fields });
  if (!parsed.supported) {
    return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, parsed.message ?? `${label}无法被引擎解析`);
  }
  if (raw.hash !== parsed.hash) {
    return failure(RULE_ASSISTANT_CODES.CONSISTENCY_MISMATCH, '保存记录哈希与引擎重新解析结果不一致');
  }
  return {
    ok: true,
    rule: {
      template_id: parsed.template_id,
      fields: { ...parsed.fields },
      text: parsed.text,
      hash: parsed.hash,
      version: Number.isFinite(raw.v) ? raw.v : (Number.isFinite(raw.version) ? raw.version : null),
    },
  };
}

const ruleText = (rule) => String(rule?.text ?? '').replace(/。$/, '');
const ruleVersion = (rule) => (rule?.version === null || rule?.version === undefined ? '' : `v${rule.version}`);

function simulationLine(simulation) {
  const s = simulation.summary;
  const ctx = simulation.context;
  const ctxText = ctx ? `模拟对象：${ctx.symbol} · ${ctx.date}。` : '';
  return `${ctxText}本次模拟：触发 ${s.triggered} 条、未触发 ${s.not_triggered} 条、数据不足 ${s.missing_data} 条、错误 ${s.error} 条。`;
}

function localExplanation(flow) {
  if (!flow.draft) return '';
  const draftText = ruleText(flow.draft);
  const semantic = flow.semantic_confirmation;
  if (!semantic) {
    return `规则建议（尚未保存）：${draftText}。历史模拟尚未执行；保存后才会用于模拟。`;
  }
  const saved = semantic.saved_rule;
  const savedVersion = ruleVersion(saved);
  const savedLine = `你保存的规则：${ruleText(saved)}${savedVersion ? `（${savedVersion}）` : ''}${semantic.draft_modified ? '（你在 AI 建议基础上修改后保存）' : ''}。`;
  const drift = flow.rule_drift;
  const simulation = flow.simulation;
  if (drift) {
    if (drift.status === 'removed') {
      return `${savedLine}当前规则已停用。${simulation ? '此前的模拟结果已失效，需要重新模拟。' : ''}未做独立复核。`;
    }
    const current = flow.current_rule;
    const currentVersion = ruleVersion(current);
    const currentLine = current
      ? `当前生效规则：${ruleText(current)}${currentVersion ? `（${currentVersion}）` : ''}。`
      : '当前没有生效规则。';
    if (simulation && simulation.stale !== true) {
      return `${savedLine}${currentLine}${simulationLine(simulation)}这次模拟对应当前生效规则；此前保存的记录不覆盖这条新规则。未做独立复核。`;
    }
    if (simulation) {
      return `${savedLine}${currentLine}此前的模拟结果已失效，需要重新模拟，不能作为当前规则的验证。未做独立复核。`;
    }
    return `${savedLine}${currentLine}尚未执行历史模拟，需要重新模拟。未做独立复核。`;
  }
  if (!simulation) {
    return `${savedLine}历史模拟尚未执行：需要数据、标的和日期。未做独立复核。`;
  }
  return `${savedLine}${simulationLine(simulation)}仅引用你保存的规则和实际模拟汇总；未做独立复核，不能据此推断收益或因果。`;
}

function traceFor(flow) {
  const parseStatus = flow.draft ? 'ok' : 'not_executed';
  const matchStatus = flow.simulation ? 'executed' : 'not_executed';
  return {
    trace_version: 'candidate-1',
    trace_id: `trace-${flow.flow_id}`,
    sample_kind: 'runtime',
    llm_mode: 'unknown',
    messages: [
      {
        type: 'question',
        flow_id: flow.flow_id,
        question_hash: flow.question_hash,
        stage: RULE_ASSISTANT_STAGE,
        outbound: flow.outbound === true,
        gate: flow.gate,
        request_ids: flow.requests.map((r) => r.request_id),
        model_calls: flow.model_calls,
        budget_max: flow.budget_max,
      },
      {
        type: 'plan',
        flow_id: flow.flow_id,
        plan_id: flow.plan ? flow.plan.plan_id : null,
        template_id: flow.plan ? flow.plan.template_id : null,
        final_template_id: flow.plan ? (flow.plan.final_template_id ?? null) : null,
        final_hash: flow.plan ? (flow.plan.final_hash ?? null) : null,
        executed_hash: flow.plan ? (flow.plan.executed_hash ?? null) : null,
        executed_version: flow.plan ? (flow.plan.executed_version ?? null) : null,
        draft_modified: flow.plan ? (flow.plan.draft_modified ?? null) : null,
        status: flow.plan ? flow.plan.status : 'not_used',
        executed: flow.simulation ? true : false,
        steps: flow.plan ? flow.plan.steps.map((s) => ({
          tool: s.tool,
          status: s.tool === 'contract.match' && flow.simulation ? 'executed' : s.status,
          params_keys: [...s.params_keys],
          missing: [...s.missing],
        })) : [],
      },
      {
        type: 'tool_execution',
        flow_id: flow.flow_id,
        steps: [
          { tool: 'contract.parse', status: parseStatus },
          {
            tool: 'contract.match',
            status: matchStatus,
            ...(flow.simulation ? {
              source: flow.simulation.source,
              rule_hash: flow.simulation.rule_hash ?? null,
              rule_version: flow.simulation.rule_version ?? null,
              semantic_confirmation_covers_rule: flow.simulation.semantic_confirmation_covers_rule !== false,
              stale: flow.simulation.stale === true,
              context: { ...flow.simulation.context },
              summary: { ...flow.simulation.summary },
            } : {}),
          },
        ],
      },
      {
        type: 'review_result',
        flow_id: flow.flow_id,
        review: { available: false, reason: 'independent_review_not_run' },
        semantic_confirmation: flow.semantic_confirmation ?? { status: 'pending' },
        consistency_check: flow.consistency ?? { status: 'not_run', independent_review: false },
        current_rule: flow.current_rule ?? null,
        rule_drift: flow.rule_drift ?? null,
        final: {
          status: flow.status,
          explanation: flow.explanation ?? '',
          duration_ms: flow.ended_at ? flow.ended_at - flow.created_at : null,
        },
      },
    ],
  };
}

function invokeWithTimeout(fn, request, timeoutMs) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const started = Date.now();
    let timer;
    const timeoutPromise = new Promise((resolveTimeout) => {
      timer = setTimeout(() => {
        controller.abort();
        resolveTimeout({
          ok: false,
          code: RULE_ASSISTANT_CODES.MODEL_TIMEOUT,
          latencyMs: Date.now() - started,
        });
      }, timeoutMs);
    });
    const callPromise = Promise.resolve()
      .then(() => fn({ ...request, signal: controller.signal }))
      .then((response) => ({ ok: true, response, latencyMs: Date.now() - started }))
      .catch((error) => ({
        ok: false,
        code: controller.signal.aborted || (error && (error.name === 'AbortError' || error.code === 'E_MODEL_TIMEOUT'))
          ? RULE_ASSISTANT_CODES.MODEL_TIMEOUT
          : RULE_ASSISTANT_CODES.MODEL_UNAVAILABLE,
        latencyMs: Date.now() - started,
      }));
    Promise.race([callPromise, timeoutPromise])
      .then((result) => resolve(result))
      .finally(() => { if (timer !== undefined) clearTimeout(timer); });
  });
}

export function createRuleAssistant({
  transport,
  timeoutMs = RULE_ASSISTANT_TIMEOUT_MS,
  maxModelCalls = RULE_ASSISTANT_MAX_MODEL_CALLS,
  now = () => Date.now(),
} = {}) {
  if (!transport || typeof transport.ruleIntent !== 'function') {
    throw new TypeError('transport 必须提供 ruleIntent()');
  }
  if (!Number.isInteger(maxModelCalls) || maxModelCalls <= 0) throw new TypeError('maxModelCalls 必须为正整数');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正数');

  const flows = new Map();
  let seq = 0;

  function nextRequestId(flowId, attempt) {
    return `req-${flowId}-${attempt}`;
  }

  function terminal(flow, status, code, message, extra = {}) {
    flow.status = status;
    flow.code = code;
    flow.message = message;
    flow.ended_at = now();
    flow.explanation = localExplanation(flow);
    flow.trace = traceFor(flow);
    return { ok: status === 'draft' || status === 'confirmed' || status === 'simulated', status, code, message, flow: clone(flow), ...extra };
  }

  function addRequest(flow, requestId, attempt, result) {
    flow.requests.push({
      request_id: requestId,
      attempt,
      stage: 'rule_intent',
      latency_ms: result.latencyMs ?? null,
      status: result.ok ? 'ok' : 'failed',
      code: result.ok ? null : result.code,
    });
  }

  async function startFlow({ question, contextSummary = {}, requestId = null } = {}) {
    const gate = localGate(question);
    const flowId = `flow-${String(++seq).padStart(3, '0')}-${hashQuestion(question).slice(0, 6)}`;
    const flow = {
      flow_id: flowId,
      question_hash: hashQuestion(question),
      context_summary: sanitizeContextSummary(contextSummary),
      status: 'new',
      code: null,
      message: null,
      gate: gate.ok ? 'local_accepted' : 'local_rejected',
      outbound: false,
      model_calls: 0,
      budget_max: maxModelCalls,
      requests: [],
      draft: null,
      plan: null,
      current_rule: null,
      rule_drift: null,
      simulation: null,
      semantic_confirmation: null,
      consistency: null,
      explanation: '',
      created_at: now(),
      ended_at: null,
    };
    flows.set(flowId, flow);
    if (!gate.ok) {
      return terminal(flow, gate.code === RULE_ASSISTANT_CODES.INPUT_INVALID ? 'invalid' : 'unsupported', gate.code, gate.message);
    }

    const request = buildRuleIntentRequest({ question, contextSummary });
    for (let attempt = 1; attempt <= maxModelCalls; attempt++) {
      if (flow.model_calls >= maxModelCalls) {
        return terminal(flow, 'budget_exhausted', RULE_ASSISTANT_CODES.BUDGET_EXHAUSTED,
          '模型请求预算已用尽；改用本地证据摘要，不再请求解释模型');
      }
      const rid = (attempt === 1 && typeof requestId === 'string' && requestId !== '')
        ? requestId
        : nextRequestId(flowId, attempt);
      flow.model_calls += 1;
      flow.outbound = true;
      const call = await invokeWithTimeout(transport.ruleIntent, { ...request, request_id: rid }, timeoutMs);
      addRequest(flow, rid, attempt, call);
      if (!call.ok) {
        return terminal(flow, call.code === RULE_ASSISTANT_CODES.MODEL_TIMEOUT ? 'timeout' : 'unavailable',
          call.code, call.code === RULE_ASSISTANT_CODES.MODEL_TIMEOUT
            ? '模型请求超时；未生成草案，未执行工具'
            : '模型请求不可用；未生成草案，未执行工具');
      }
      const checked = validateRuleIntentResponse(call.response && call.response.rawText);
      if (!checked.ok) {
        if (attempt < maxModelCalls) continue;
        return terminal(flow, 'clarify', checked.code, '模型输出未通过本地模板/字段校验；请补充规则模板或数值');
      }
      if (checked.kind === 'clarify') {
        return terminal(flow, 'clarify', RULE_ASSISTANT_CODES.CLARIFY, checked.message);
      }
      if (checked.kind === 'unsupported') {
        return terminal(flow, 'unsupported', RULE_ASSISTANT_CODES.UNSUPPORTED, checked.message);
      }
      flow.draft = { ...checked.draft, flow_id: flowId };
      flow.plan = planForDraft(question, flow.draft);
      flow.status = 'draft';
      flow.code = null;
      flow.message = '规则草案已生成；尚未保存，需用户在规则页确认';
      flow.explanation = localExplanation(flow);
      flow.trace = traceFor(flow);
      return { ok: true, status: 'draft', code: null, message: flow.message, flow: clone(flow) };
    }
    return terminal(flow, 'budget_exhausted', RULE_ASSISTANT_CODES.BUDGET_EXHAUSTED,
      '模型请求预算已用尽；未生成草案');
  }

  function getFlow(flowId) {
    const flow = flows.get(flowId);
    return flow ? clone(flow) : null;
  }

  function recordSemanticConfirmation({ flowId, savedRule } = {}) {
    const flow = flows.get(flowId);
    if (!flow) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'flowId 不存在');
    if (!flow.draft) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '当前任务还没有规则草案');
    const normalized = normalizeSavedRule(savedRule, 'savedRule');
    if (!normalized.ok) return normalized;
    const finalRule = normalized.rule;
    const draft = flow.draft;
    const modified = draft.template_id !== finalRule.template_id
      || draft.hash !== finalRule.hash
      || !sameFields(draft.fields, finalRule.fields);
    flow.semantic_confirmation = {
      status: 'user_confirmed',
      source: 'rule_page_save',
      draft_rule: {
        template_id: draft.template_id,
        fields: { ...draft.fields },
        text: draft.text,
        hash: draft.hash,
      },
      saved_rule: finalRule,
      draft_modified: modified,
      note: modified
        ? '用户在规则页修改了 AI 草案并确认；确认对象是最终规则，原 AI 建议仅作对照；语义正确性仍需独立验收。'
        : '用户确认了最终规则；语义正确性仍需独立验收，不以哈希一致代替；未独立复核。',
    };
    if (flow.plan) {
      flow.plan.status = 'confirmed';
      flow.plan.final_template_id = finalRule.template_id;
      flow.plan.final_hash = finalRule.hash;
      flow.plan.executed_hash = null;
      flow.plan.executed_version = null;
      flow.plan.draft_modified = modified;
    }
    flow.current_rule = finalRule;
    flow.rule_drift = null;
    flow.status = 'confirmed';
    flow.simulation = null;
    flow.consistency = null;
    flow.ended_at = null;
    flow.explanation = localExplanation(flow);
    flow.trace = traceFor(flow);
    return { ok: true, flow: clone(flow) };
  }

  function recordRuleState({ flowId, currentRule = null } = {}) {
    const flow = flows.get(flowId);
    if (!flow) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'flowId 不存在');
    const confirmed = flow.semantic_confirmation?.saved_rule ?? null;
    if (!confirmed) {
      return failure(RULE_ASSISTANT_CODES.NOT_CONFIRMED, '当前任务还没有用户确认的保存规则');
    }
    let current = null;
    if (currentRule !== null && currentRule !== undefined) {
      const normalized = normalizeSavedRule(currentRule, 'currentRule');
      if (!normalized.ok) return normalized;
      current = normalized.rule;
    }
    const same = !!current && current.template_id === confirmed.template_id
      && current.hash === confirmed.hash
      && sameFields(current.fields, confirmed.fields);
    flow.current_rule = current;
    flow.rule_drift = same ? null : current ? {
      status: 'changed',
      base_hash: confirmed.hash,
      base_version: confirmed.version ?? null,
      current_hash: current.hash,
      current_version: current.version ?? null,
      note: '语义确认仍对应此前保存的规则；当前生效规则需要重新模拟。',
    } : {
      status: 'removed',
      base_hash: confirmed.hash,
      base_version: confirmed.version ?? null,
      current_hash: null,
      current_version: null,
      note: '此前保存的规则已不再生效；此前的模拟结果不能作为当前规则的验证。',
    };
    if (flow.simulation) {
      const simulationHash = flow.simulation.rule_hash ?? null;
      const stale = simulationHash !== (current ? current.hash : null);
      flow.simulation = {
        ...flow.simulation,
        stale,
        stale_reason: stale ? 'saved_rule_changed' : null,
      };
    }
    if (flow.consistency) {
      flow.consistency = flow.rule_drift
        ? { ...flow.consistency, stale: true, stale_reason: 'saved_rule_changed' }
        : { ...flow.consistency, stale: false, stale_reason: null };
    }
    if (!flow.ended_at) flow.ended_at = now();
    flow.explanation = localExplanation(flow);
    flow.trace = traceFor(flow);
    return { ok: true, flow: clone(flow) };
  }

  function recordSimulation({ flowId, simulation, source = 'unknown', context = null } = {}) {
    const flow = flows.get(flowId);
    if (!flow) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'flowId 不存在');
    if (!flow.draft) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '当前任务还没有规则草案');
    if (!flow.semantic_confirmation) {
      return failure(RULE_ASSISTANT_CODES.NOT_CONFIRMED, '历史模拟必须绑定用户最终确认的规则');
    }
    if (!isObject(simulation)) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'simulation 非法');
    if (!isObject(context) || !isSymbol(context.symbol) || !isDate(context.date)) {
      return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '模拟上下文缺少标的或日期');
    }
    if (simulation.symbol && simulation.symbol !== context.symbol) {
      return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '模拟标的与上下文不一致');
    }
    if (simulation.requested_date && simulation.requested_date !== context.date) {
      return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '模拟日期与上下文不一致');
    }
    if (simulation.marketSourceId && context.market_source_id
      && simulation.marketSourceId !== context.market_source_id) {
      return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, '模拟行情来源与上下文不一致');
    }
    const binding = flow.current_rule
      ?? (flow.rule_drift ? null : flow.semantic_confirmation.saved_rule);
    if (!binding) {
      return failure(RULE_ASSISTANT_CODES.NOT_CONFIRMED, '当前没有生效的已保存规则；不记录历史模拟');
    }
    const matching = Array.isArray(simulation.results)
      ? simulation.results.filter((r) => r && r.rule && r.rule.hash === binding.hash)
      : [];
    if (matching.length === 0) {
      return failure(RULE_ASSISTANT_CODES.CONSISTENCY_MISMATCH, '模拟结果不包含当前生效的已保存规则');
    }
    const summary = { triggered: 0, not_triggered: 0, missing_data: 0, error: 0 };
    for (const r of matching) summary[r.ok ? r.verdict : 'error'] += 1;
    const filtered = { ok: simulation.ok === true, summary, results: matching };
    flow.simulation = {
      ...summarizeSimulation(filtered),
      rule_hash: binding.hash,
      rule_version: binding.version ?? null,
      semantic_confirmation_covers_rule: !flow.rule_drift
        && binding.hash === flow.semantic_confirmation.saved_rule.hash,
      stale: false,
      stale_reason: null,
      source: typeof source === 'string' ? source : 'unknown',
      context: {
        symbol: context.symbol,
        date: context.date,
        market_source_id: isShortString(context.market_source_id) ? context.market_source_id : null,
        data_snapshot_id: isShortString(context.data_snapshot_id) ? context.data_snapshot_id : null,
      },
    };
    flow.status = 'simulated';
    if (flow.plan) {
      flow.plan.status = 'executed';
      flow.plan.executed = true;
      flow.plan.executed_hash = binding.hash;
      flow.plan.executed_version = binding.version ?? null;
    }
    if (!flow.ended_at) flow.ended_at = now();
    flow.explanation = localExplanation(flow);
    flow.trace = traceFor(flow);
    return { ok: true, flow: clone(flow) };
  }

  function checkConsistency({ flowId, executionRule } = {}) {
    const flow = flows.get(flowId);
    if (!flow) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'flowId 不存在');
    const confirmed = flow.semantic_confirmation && flow.semantic_confirmation.saved_rule;
    if (!confirmed) {
      flow.consistency = { status: 'not_confirmed', independent_review: false, mismatches: ['尚未记录用户确认的规则'] };
      flow.trace = traceFor(flow);
      return { ok: false, code: RULE_ASSISTANT_CODES.NOT_CONFIRMED, consistency: { ...flow.consistency } };
    }
    if (flow.rule_drift?.status === 'removed') {
      flow.consistency = { status: 'not_executed', independent_review: false, mismatches: ['当前没有生效的已保存规则'] };
      flow.trace = traceFor(flow);
      return { ok: false, code: RULE_ASSISTANT_CODES.NOT_EXECUTED, consistency: { ...flow.consistency } };
    }
    if (!isObject(executionRule)) {
      flow.consistency = { status: 'not_executed', independent_review: false, mismatches: ['尚未执行历史模拟'] };
      flow.trace = traceFor(flow);
      return { ok: false, code: RULE_ASSISTANT_CODES.NOT_EXECUTED, consistency: { ...flow.consistency } };
    }
    const baseline = flow.current_rule ?? confirmed;
    const mismatches = [];
    if (executionRule.template_id !== baseline.template_id) mismatches.push('template_id 不一致');
    const keys = new Set([...Object.keys(baseline.fields ?? {}), ...Object.keys(executionRule.fields ?? {})]);
    for (const key of keys) {
      if (toNumber(baseline.fields?.[key]) !== toNumber(executionRule.fields?.[key])) mismatches.push(`fields.${key} 不一致`);
    }
    if (typeof executionRule.hash === 'string' && executionRule.hash !== baseline.hash) mismatches.push('hash 不一致');
    if (executionRule.v !== undefined && baseline.version !== null && executionRule.v !== baseline.version) mismatches.push('version 不一致');
    const ok = mismatches.length === 0;
    if (!flow.ended_at) flow.ended_at = now();
    flow.consistency = {
      status: ok ? 'consistent' : 'mismatch',
      kind: 'consistency_check',
      binding: flow.current_rule ? 'current_saved_rule' : 'semantic_confirmation_saved_rule',
      semantic_confirmation_covers_rule: !flow.rule_drift && baseline.hash === confirmed.hash,
      independent_review: false,
      mismatches,
      note: '同输入重跑、版本/哈希一致仅为一致性检查，不是独立复核，也不证明用户原表达语义正确。',
    };
    flow.trace = traceFor(flow);
    return {
      ok,
      code: ok ? null : RULE_ASSISTANT_CODES.CONSISTENCY_MISMATCH,
      consistency: { ...flow.consistency },
      flow: clone(flow),
    };
  }

  function checkSimulationRerun({ first, rerun } = {}) {
    if (!isObject(first) || !isObject(rerun)) {
      return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'first/rerun 必须为对象');
    }
    const a = summarizeSimulation(first);
    const b = summarizeSimulation(rerun);
    const mismatches = [];
    for (const key of ['triggered', 'not_triggered', 'missing_data', 'error']) {
      if (a.summary[key] !== b.summary[key]) mismatches.push(`summary.${key} 不一致`);
    }
    if (a.results.length !== b.results.length) mismatches.push('结果条数不一致');
    const n = Math.min(a.results.length, b.results.length);
    for (let i = 0; i < n; i++) {
      if (a.results[i].verdict !== b.results[i].verdict) mismatches.push(`results[${i}].verdict 不一致`);
      if (a.results[i].rule_hash !== b.results[i].rule_hash) mismatches.push(`results[${i}].rule_hash 不一致`);
    }
    return {
      ok: mismatches.length === 0,
      kind: 'consistency_check',
      independent_review: false,
      mismatches,
      note: '同输入重跑与版本/哈希一致仅为一致性检查，不是独立复核。',
    };
  }

  function getTrace(flowId) {
    const flow = flows.get(flowId);
    return flow ? traceFor(flow) : null;
  }

  function exportTrace(flowId) {
    const trace = getTrace(flowId);
    if (!trace) return failure(RULE_ASSISTANT_CODES.INPUT_INVALID, 'flowId 不存在');
    return exportTraceJsonl({ ...trace, ok: true });
  }

  return Object.freeze({
    startFlow,
    getFlow,
    recordSemanticConfirmation,
    recordRuleState,
    recordSimulation,
    checkConsistency,
    checkSimulationRerun,
    getTrace,
    exportTrace,
  });
}
