// 计划策略：意图 + 槽位 + 范围 + 数据可用性 → 确定性计划。
// 边界：不调用模型、不读 DOM/网络；未注册工具直接拒绝；步骤带 reason/optional/depends_on/fallbacks。
import { INTENTS, PLAN_TEMPLATES, buildPlan } from './planner.js';
import { TOOL_REGISTRY } from './toolRegistry.js';

export const PLAN_POLICY_VERSION = 'plan-policy-1';

const STEP_POLICY = Object.freeze({
  'indicators.compute': {
    reason: '按账单重算组合收益指标',
    fallbacks: ['复用报告中的已发布四事实'],
  },
  'decompose.drag': {
    reason: '把差额拆到每笔卖出',
    fallbacks: ['逐笔分解不可用时不评选极端笔'],
  },
  'decompose.tradeRank': {
    reason: '按差额排序取极端笔',
    fallbacks: ['排序不可用时如实说明'],
  },
  'behavior.patternList': {
    reason: '检查本账单的行为模式',
    fallbacks: ['行为发现不可用时不解释模式'],
  },
  'behavior.similarSameBill': {
    reason: '在同一账单内匹配相似操作',
    fallbacks: ['没有证据时不生成相似结论'],
  },
  'behavior.operationAttribution': {
    reason: '按行为证据归到操作类型',
    optional: true,
    fallbacks: ['归因不可用时仍展示逐笔差额'],
  },
  'counterfactual.replaceSell': {
    reason: '只替换一笔卖出重算',
    fallbacks: ['反事实不可用时不假设结果'],
  },
  'counterfactual.pathRange': {
    reason: '查看差额的路径区间',
    optional: true,
    fallbacks: ['可用交易日不足时不给区间'],
  },
  'provenance.report': {
    reason: '列出数字的计算路径',
    fallbacks: ['路径不可用时不解释来源'],
  },
  'verify.report': {
    reason: '独立复核已发布数字',
    fallbacks: ['复核失败时不发布'],
  },
  'contract.parse': {
    reason: '解析规则模板字段',
    fallbacks: ['模板不支持时转规则工作区'],
  },
  'rule.current': {
    reason: '读取当前生效规则',
    fallbacks: ['规则读取失败时不推测状态'],
  },
  'rule.ledger': {
    reason: '按规则回放账单',
    fallbacks: ['回放失败时不展示命中次数'],
  },
  'rule.candidates': {
    reason: '从行为证据生成候选',
    fallbacks: ['没有证据时不生成候选'],
  },
  'profile.signals': {
    reason: '派生确定性画像信号',
    optional: true,
    fallbacks: ['没有信号时不生成标签'],
  },
  'history.crossBillIndex': {
    reason: '读取本人已保存账单的同类操作',
    fallbacks: ['没有历史账单时如实说明'],
  },
  'history.similarAcrossBills': {
    reason: '列出同类操作出现的账单',
    optional: true,
    fallbacks: ['没有匹配账单时如实说明'],
  },
});

function decorateSteps(plan) {
  plan.steps.forEach((step, index) => {
    const policy = STEP_POLICY[step.tool] ?? {};
    step.id = `S${index + 1}`;
    step.reason = policy.reason ?? '按意图执行确定性计算';
    step.optional = policy.optional === true;
    step.depends_on = index > 0 ? [`S${index}`] : [];
    step.fallbacks = Array.isArray(policy.fallbacks) ? [...policy.fallbacks] : [];
  });
  return plan;
}

function reject(reason) {
  return {
    plan_id: null,
    policy_version: PLAN_POLICY_VERSION,
    status: 'rejected',
    fallback_used: false,
    template_id: null,
    composition_reason: '',
    steps: [],
    reasons: [reason],
    pending_params: [],
  };
}

/**
 * @param {object} p
 * @param {string} p.question 用户问题
 * @param {string} p.intent 已识别意图
 * @param {object} [p.slots] 意图槽位（不猜测；缺省不用）
 * @param {object|null} [p.scope] 范围判断结果（仅 bill 生成工具计划）
 * @param {object} [p.context] 工具参数上下文（trades/report/closes/market/…）
 * @param {Map} [p.registry] 工具注册表
 * @param {{bundle?:boolean,published?:boolean,market?:boolean}|null} [p.availability]
 */
export function planForTurn({
  question = '', intent = null, slots = {}, scope = null, context = {},
  registry = TOOL_REGISTRY, availability = null,
} = {}) {
  if (scope && scope.kind && scope.kind !== 'bill') {
    return {
      ...reject('范围外问题不生成工具计划'), status: 'scope', scope_kind: scope.kind,
    };
  }
  if (!INTENTS.includes(intent)) return reject(`未定义的意图：${String(intent)}`);
  const template = PLAN_TEMPLATES[intent];
  if (!template) return reject(`没有计划模板：${String(intent)}`);
  const unregistered = template.steps.filter((id) => !(typeof registry.get === 'function' ? registry.get(id) : null));
  if (unregistered.length) return reject(`工具未注册：${unregistered.join('、')}`);
  if (availability && availability.bundle === false) {
    return {
      ...reject('当前账单没有已发布报告：不生成事实计划'),
      status: 'needs_context',
      pending_params: [{ reason: 'report_bundle_missing' }],
    };
  }

  const plan = buildPlan({
    question,
    intentJson: { intent, slots, confidence: 1 },
    context,
    registry,
  });
  decorateSteps(plan);
  plan.policy_version = PLAN_POLICY_VERSION;
  if (availability && availability.published === false) {
    plan.status = 'blocked';
    plan.blocked_reason = '组合结果未发布';
    plan.reasons.push('组合结果未发布：本次不生成事实回答');
  }
  return plan;
}
