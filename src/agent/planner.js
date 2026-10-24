// M1-C6 · 确定性 planner（离线最小实现；接口候选，未冻结——依据 implementation-baseline 附A.1 与 F-8）
// 职责：意图 JSON + 工具注册表 → 确定性 plan；不调用模型、不操作 DOM / localStorage / 网络。
// 语义（候选）：
//   · 复用 F-8 既定意图（含 best_trade），不新增工具；越界/未匹配 → 零工具调用合规模板；
//   · 意图 JSON 非法 → 允许调用方重试 1 次（写入 retryIntentJson）→ 仍非法则兜底管线（零工具调用）；
//   · 步骤参数由调用方上下文按名提供（不引入跨步骤隐式数据流）；缺参 → needs_context（澄清，不猜测）；
//   · 工具异常/未知工具/参数非法 → 中止该步并记录降级，不吞错继续。
import { TOOL_REGISTRY } from './toolRegistry.js';

export const INTENTS = Object.freeze([
  'worst_trade', 'best_trade', 'loss_overview', 'pattern_explain', 'profile', 'what_if', 'similar_context',
  'cross_bill', 'how_to_change', 'contract_setup', 'contract_status', 'meta_calc', 'meta_trust', 'out_of_scope',
]);

// 计划模板（候选：工具序列与理由；参数在 buildPlan 时按 context 解析）
export const PLAN_TEMPLATES = Object.freeze({
  worst_trade: { template_id: 'T-worst-trade', steps: ['decompose.drag'], composition_reason: '最错一笔＝逐笔损耗分解降序取首（report 由调用方上下文提供）' },
  best_trade: { template_id: 'T-best-trade', steps: ['decompose.drag'], composition_reason: '最赚一笔＝逐笔损耗分解升序取首（负损耗最大）' },
  loss_overview: { template_id: 'T-loss-overview', steps: ['indicators.compute', 'decompose.drag'], composition_reason: '整体表现：三指标＋逐笔损耗分解' },
  pattern_explain: { template_id: 'T-pattern-explain', steps: ['behavior.patternList'], composition_reason: '行为模式清单（当前仅“追高买入”实现；三态照实）' },
  profile: { template_id: 'T-profile', steps: ['behavior.patternList'], composition_reason: '画像四标签为 T3 暂缓；当前以行为清单为可用证据' },
  what_if: { template_id: 'T-what-if', steps: ['counterfactual.replaceSell'], composition_reason: 'S1 单笔卖出替换（仅单标的；买入侧未实现）' },
  similar_context: { template_id: 'T-similar-context', steps: ['behavior.similarSameBill'], composition_reason: '同一账单内的行为重复（不做跨账单/行情相似度检索）' },
  cross_bill: { template_id: 'T-cross-bill', steps: ['history.crossBillIndex'], composition_reason: '本人已保存账单的同类操作次数（只报次数与覆盖）' },
  how_to_change: { template_id: 'T-how-to-change', steps: ['behavior.patternList'], composition_reason: '改法与规则共建归契约/UI；当前仅提供行为清单证据' },
  contract_setup: { template_id: 'T-contract-setup', steps: ['contract.parse'], composition_reason: '模板＋字段解析（保存、状态机与持久化归 UI，R4）' },
  contract_status: { template_id: 'T-contract-status', steps: [], composition_reason: '契约状态与持久化在 UI 侧，planner 无引擎工具可调', unavailable: true },
  meta_calc: { template_id: 'T-meta-calc', steps: ['provenance.report'], composition_reason: '计算路径与公式引用（OUTPUT03）' },
  meta_trust: { template_id: 'T-meta-trust', steps: ['verify.report'], composition_reason: '自我复核报告（失败项不发布）' },
  out_of_scope: { template_id: 'T-out-of-scope', steps: [], composition_reason: '越界/未匹配：零工具调用（F-8 合规模板）' },
});

/* 占位级确定性哈希（同族 fnv1a64 风格；非正式哈希，随接口冻结统一） */
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

export function hashQuestion(question) {
  return fnv1a64(String(question ?? ''));
}

/* 意图 JSON 形状校验：{ intent ∈ INTENTS, slots: object, confidence: 0..1 } */
export function validateIntentJson(v) {
  const errors = [];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, errors: ['意图 JSON 必须为对象'] };
  if (!INTENTS.includes(v.intent)) errors.push(`intent 非法：${String(v.intent)}（须为已定义意图之一）`);
  if (v.slots === null || typeof v.slots !== 'object' || Array.isArray(v.slots)) errors.push('slots 必须为对象');
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) errors.push('confidence 必须为 [0,1] 数值');
  return { ok: errors.length === 0, errors };
}

function finalizePlan(plan) {
  const canonical = JSON.stringify({
    question_hash: plan.question_hash,
    intent: plan.intent,
    template_id: plan.template_id,
    tools: plan.steps.map((s) => s.tool),
  });
  plan.plan_id = `plan-${fnv1a64(canonical)}`;
  return plan;
}

export function buildPlan({ question, intentJson, retryIntentJson, context = {}, registry = TOOL_REGISTRY }) {
  const plan = {
    plan_id: null,
    question_hash: hashQuestion(question),
    intent: null,
    confidence: null,
    template_id: null,
    composition_reason: '',
    steps: [],
    fallback_used: false,
    status: 'ready',
    pending_params: [],
    reasons: [],
  };

  if (String(question ?? '').trim() === '') {
    plan.status = 'fallback';
    plan.fallback_used = true;
    plan.reasons.push('问题为空：兜底管线（零工具调用）');
    return finalizePlan(plan);
  }

  let ij = intentJson;
  let retried = false;
  let v = validateIntentJson(ij);
  if (!v.ok && retryIntentJson !== undefined) {
    ij = retryIntentJson;
    retried = true;
    v = validateIntentJson(ij);
  }
  if (!v.ok) {
    plan.status = 'fallback';
    plan.fallback_used = true;
    plan.intent = 'out_of_scope';
    plan.reasons.push(`${retried ? '意图 JSON 非法（已重试 1 次）' : '意图 JSON 非法'}：${v.errors.join('；')}——兜底管线（零工具调用）`);
    plan.template_id = PLAN_TEMPLATES.out_of_scope.template_id;
    plan.composition_reason = PLAN_TEMPLATES.out_of_scope.composition_reason;
    return finalizePlan(plan);
  }

  plan.intent = ij.intent;
  plan.confidence = ij.confidence;
  const tpl = PLAN_TEMPLATES[ij.intent];
  if (!tpl) {
    plan.status = 'fallback';
    plan.fallback_used = true;
    plan.reasons.push('无模板（schema 校验失败）——兜底管线（零工具调用）');
    return finalizePlan(plan);
  }
  plan.template_id = tpl.template_id;
  plan.composition_reason = tpl.composition_reason;

  if (ij.intent === 'out_of_scope') {
    plan.status = 'fallback';
    plan.fallback_used = true;
    plan.reasons.push('越界/未匹配：零工具调用（F-8 合规模板）');
    return finalizePlan(plan);
  }
  if (tpl.unavailable || tpl.steps.length === 0) {
    plan.status = 'unsupported';
    plan.reasons.push(`已识别的意图「${ij.intent}」当前无可用工具：${tpl.composition_reason}`);
    return finalizePlan(plan);
  }

  const pending = [];
  for (const toolId of tpl.steps) {
    const tool = typeof registry.get === 'function' ? registry.get(toolId) : null;
    if (!tool) {
      plan.steps.push({ tool: toolId, params: {}, params_keys: [], status: 'tool_unregistered', missing: [] });
      plan.reasons.push(`工具未注册：${toolId}（模板与注册表不一致）`);
      continue;
    }
    const keys = [...tool.params.required, ...tool.params.optional];
    const params = {};
    const params_keys = [];
    const missing = [];
    for (const k of keys) {
      if (context[k] === undefined || context[k] === null) {
        if (tool.params.required.includes(k)) missing.push(k);
        continue;
      }
      params[k] = context[k];
      params_keys.push(k);
    }
    plan.steps.push({ tool: toolId, params, params_keys, status: missing.length ? 'missing_params' : 'ready', missing });
    if (missing.length) pending.push({ tool: toolId, missing });
  }

  if (plan.steps.some((s) => s.status === 'tool_unregistered')) {
    plan.status = 'fallback';
    plan.fallback_used = true;
  } else if (pending.length > 0) {
    plan.status = 'needs_context';
    plan.pending_params = pending;
    plan.reasons.push('缺少上下文参数：先澄清/补齐上下文，不猜测取值');
  }
  return finalizePlan(plan);
}

/* 跨步骤参数：字符串 "$S1.field.path" 从已成功步骤的输出取值；未命中保持 undefined（由参数校验拦截）。 */
function resolveParamValue(value, results) {
  if (Array.isArray(value)) return value.map((item) => resolveParamValue(item, results));
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    const match = value.match(/^\$([^.]+)\.(.+)$/u);
    if (!match) return value;
    const [, stepId, path] = match;
    const source = results.find((r) => r.ok && (r.step_id === stepId || r.tool === stepId));
    if (!source) return undefined;
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), source.output);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveParamValue(v, results)]));
}

/* 最小执行器：顺序调用注册表工具；必要步骤失败 → 中止后续并记录降级；可选步骤失败 → 记录降级后继续。 */
export function runPlan({
  plan, registry = TOOL_REGISTRY,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
}) {
  const results = [];
  const degraded = [];
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    return { results, aborted: false, degraded, executed: 0 };
  }
  let aborted = false;
  for (const step of plan.steps) {
    const stepId = step.id ?? null;
    if (aborted) {
      degraded.push({ tool: step.tool, step_id: stepId, code: 'E_STEP_SKIPPED', message: '前序步骤失败：中止后续步骤（降级记录）' });
      continue;
    }
    const tool = typeof registry.get === 'function' ? registry.get(step.tool) : null;
    if (!tool || typeof tool.invoke !== 'function') {
      degraded.push({ tool: step.tool, step_id: stepId, code: 'E_TOOL_UNKNOWN', message: '工具未注册：中止该步' });
      aborted = true;
      continue;
    }
    const dependsOn = Array.isArray(step.depends_on) ? step.depends_on : [];
    const missingDeps = dependsOn.filter((id) => !results.some((r) => r.ok && r.step_id === id));
    if (missingDeps.length) {
      degraded.push({ tool: step.tool, step_id: stepId, code: 'E_STEP_DEPENDENCY', missing: missingDeps, message: '依赖步骤未完成：跳过该步' });
      if (!step.optional) aborted = true;
      continue;
    }
    const params = resolveParamValue(step.params ?? {}, results);
    const check = validateToolParamsLite(tool, params);
    if (!check.ok) {
      degraded.push({ tool: step.tool, step_id: stepId, code: 'E_PARAM_INVALID', missing: check.missing, message: '参数不满足工具要求：中止该步' });
      if (!step.optional) aborted = true;
      continue;
    }
    const startedAt = now();
    try {
      const output = tool.invoke(params);
      const result = typeof tool.toResult === 'function' ? tool.toResult({ output, params }) : null;
      results.push({
        tool: step.tool, step_id: stepId, ok: true, output, result,
        ms: Math.max(0, Math.round(now() - startedAt)),
      });
    } catch (e) {
      degraded.push({
        tool: step.tool, step_id: stepId, code: 'E_TOOL_FAILED', message: String((e && e.message) || e),
        ms: Math.max(0, Math.round(now() - startedAt)),
      });
      if (!step.optional) aborted = true;
    }
  }
  return { results, aborted, degraded, executed: results.length };
}

/* 与 toolRegistry.validateToolParams 同语义（本地化避免循环依赖；保持一致实现） */
function validateToolParamsLite(tool, params) {
  const p = params !== null && typeof params === 'object' ? params : {};
  const missing = tool.params.required.filter((k) => p[k] === undefined || p[k] === null);
  return { ok: missing.length === 0, missing };
}

/* JSONL 日志结构（附A.1；ts/ms 由调用方提供，未提供则为 null） */
export function toLogLine(plan, { ts = null, stepResults = [] } = {}) {
  const msByTool = new Map(stepResults.map((r) => [r.tool, r.ms ?? null]));
  return {
    ts,
    plan_id: plan.plan_id,
    question_hash: plan.question_hash,
    intent: plan.intent,
    confidence: plan.confidence,
    template: plan.template_id,
    composition: plan.composition_reason,
    steps: plan.steps.map((s) => ({ tool: s.tool, params_digest: fnv1a64(JSON.stringify(s.params_keys)), status: s.status, ms: msByTool.get(s.tool) ?? null })),
    fallback_used: plan.fallback_used,
    outcome: plan.status,
    reasons: [...plan.reasons],
  };
}
