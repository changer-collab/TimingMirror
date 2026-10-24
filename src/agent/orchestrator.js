// 单轮问答编排：范围 → 意图 → 计划 → 工具/上下文 → 证据 → 草稿 → 重写 → 复核 → 完成。
// P1 只负责范围、意图与真实运行过程；回答仍交给 qaAnswer 的既有分支。
// Trace 是独立事件流，只用于回答上方的运行过程；不进入信封正文，不记录模型原文或内部 ID。
import { SCOPE_LABELS } from './scopeRouter.js';
import { INTENT_FALLBACK_LABELS } from './intentPolicy.js';

export const TRACE_STAGES = Object.freeze([
  'scope', 'intent', 'plan', 'tool', 'context', 'evidence', 'compose', 'rewrite', 'verify', 'done', 'degraded',
]);

export const TRACE_STATUSES = Object.freeze(['running', 'done', 'failed', 'skipped']);

export function createTrace({
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  onStage = null,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');
  const started = now();
  let last = started;
  const events = [];

  function emit(event) {
    if (typeof onStage === 'function') {
      try { onStage({ ...event }); } catch { /* 渲染回调失败不影响回答 */ }
    }
  }

  function push(stage, status, label, extra = {}) {
    if (!TRACE_STAGES.includes(stage)) throw new TypeError(`未知 trace 阶段：${stage}`);
    if (!TRACE_STATUSES.includes(status)) throw new TypeError(`未知 trace 状态：${status}`);
    const at = now();
    const event = { stage, status, label: String(label ?? '') };
    if (extra.detail) event.detail = String(extra.detail);
    if (extra.tool) event.tool = String(extra.tool);
    event.ms = Number.isFinite(extra.ms)
      ? Math.max(0, Math.round(extra.ms))
      : Math.max(0, Math.round(at - last));
    last = at;

    // 同阶段的 running 事件在完成时原位替换，避免运行过程出现两行同一步骤。
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].stage !== stage) continue;
      if (events[i].status === 'running' && status !== 'running') {
        event.ms = Math.max(0, events[i].ms + event.ms);
        events[i] = event;
        emit(event);
        return event;
      }
      break;
    }
    events.push(event);
    emit(event);
    return event;
  }

  return Object.freeze({
    push,
    events: () => events.map((event) => ({ ...event })),
    totalMs: () => Math.max(0, Math.round(now() - started)),
  });
}

function composeDetail(envelope) {
  if (!envelope) return '';
  if (envelope.source === 'online') return '在线复述，数字已在本机再校验';
  if (envelope.status === 'refusal') return '边界拒答，未读取账单';
  if (envelope.status === 'clarify') return '需要补充信息';
  if (envelope.status === 'registration') return '需要你确认后继续';
  if (envelope.status === 'unavailable') return '本次不发布数字';
  if (envelope.status === 'withheld') return '发布前复核未通过，未发布数字';
  if (envelope.status === 'error') return '本次未生成回答';
  return '本地已发布事实';
}

export function createOrchestrator({
  routeScope = null,
  intentPolicy = null,
  answer = null,
  verify = null,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  if (typeof routeScope !== 'function') throw new TypeError('routeScope 必须为函数');
  if (!intentPolicy || typeof intentPolicy.decide !== 'function') throw new TypeError('intentPolicy 必须提供 decide()');
  if (typeof answer !== 'function') throw new TypeError('answer 必须为函数');
  if (verify != null && typeof verify !== 'function') throw new TypeError('verify 必须为函数');

  async function runTurn({ question = '', bill = null, source = 'typed', onStage = null, context = {} } = {}) {
    const trace = createTrace({ now, onStage });
    const started = now();

    trace.push('scope', 'running', '判断问题范围');
    const scope = routeScope({ question, bill }) ?? { kind: 'bill' };
    trace.push('scope', 'done', '判断问题范围', { detail: SCOPE_LABELS[scope.kind] ?? '' });

    let decision = null;
    if (scope.kind === 'bill') {
      const chip = source === 'chip';
      trace.push('intent', 'running', chip ? '匹配本地芯片' : '模型分析意图');
      decision = await intentPolicy.decide({ question, source });
      const route = decision?.route ?? null;
      if (decision?.decided_by === 'reuse') {
        trace.push('intent', 'done', '沿用已有意图', { detail: '未重新判断' });
      } else if (!decision?.model_called) {
        trace.push('intent', 'done', '本地规则匹配', { detail: '未调用模型' });
      } else if (route?.layer === 'L2') {
        trace.push('intent', 'done', '模型分析意图', { detail: '已识别' });
      } else {
        trace.push('degraded', 'done', INTENT_FALLBACK_LABELS[decision.local_check] ?? '模型结果未采用，改用本地规则');
      }
      trace.push('plan', 'done', '确定回答步骤', {
        detail: decision?.intent ? '按意图生成本地回答' : '澄清，不猜测',
      });
    } else {
      trace.push('intent', 'skipped', '无需识别账单意图', { detail: '范围外问题 · 未调用模型' });
    }

    let envelope = await answer({
      question,
      bill,
      source,
      scope,
      decision,
      route: decision?.route ?? null,
      trace,
      started,
      context,
    });

    if (typeof verify === 'function') {
      trace.push('verify', 'running', '发布前复核');
      const checked = verify({ envelope, scope, bill, question });
      if (checked && checked.ok === false && checked.envelope) {
        envelope = checked.envelope;
        trace.push('verify', 'failed', '发布前复核', { detail: '数字或证据未通过' });
        trace.push('degraded', 'done', '本次不发布具体数字');
      } else {
        trace.push('verify', 'done', '发布前复核', { detail: '数字与证据一致' });
      }
    }

    trace.push(
      'compose',
      envelope?.status === 'error' ? 'failed' : 'done',
      '生成本地回答',
      { detail: composeDetail(envelope) },
    );
    const factCount = Array.isArray(envelope?.facts) ? envelope.facts.length : 0;
    trace.push('done', 'done', '完成回答', {
      detail: envelope?.status === 'refusal' || scope.kind !== 'bill' ? '未读取账单数字' : `${factCount} 条事实`,
    });

    return { trace: trace.events(), envelope };
  }

  return Object.freeze({ runTurn });
}
