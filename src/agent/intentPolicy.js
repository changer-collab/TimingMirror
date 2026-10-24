// 意图策略：芯片点击走本地规则；自由输入先由模型判断，再做本地交叉核对。
// 模型只给意图与槽位，不参与回答；超时/失败/低置信度一律回落到本地 L1，不猜测。
import { INTENTS } from './planner.js';

export const INTENT_TIMEOUT_MS = 2500;
export const INTENT_MIN_CONFIDENCE = 0.6;
export const INTENT_AGREEMENT_CONFIDENCE = 0.8;

const SLOT_SYMBOL_RE = /^\d{6}$/u;
const SLOT_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u;

export const INTENT_FALLBACK_LABELS = Object.freeze({
  chip: '芯片点击，未调用模型',
  local: '本地规则命中',
  timeout: '模型分析超时，改用本地规则',
  unavailable: '模型接口不可用，改用本地规则',
  invalid: '模型输出不合规，改用本地规则',
  low_confidence: '模型置信度不足，改用本地规则',
  conflict: '模型与本地规则冲突，以本地规则为准',
});

export function normalizeIntentSlots(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  if (typeof raw.symbol === 'string' && SLOT_SYMBOL_RE.test(raw.symbol.trim())) out.symbol = raw.symbol.trim();
  if (typeof raw.trade_date === 'string') {
    const match = raw.trade_date.trim().match(SLOT_DATE_RE);
    if (match) {
      out.trade_date = `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
    }
  }
  return out;
}

function routeFromLocal(local, intent) {
  return {
    intent,
    slots: local?.slots ?? {},
    layer: intent ? 'L1' : 'L3',
    source: intent ? 'L1' : 'L3',
    confidence: intent ? (Number.isFinite(local?.confidence) ? local.confidence : 1) : null,
    matchedBy: local?.matchedBy ?? 'rule',
    ...(local?.chip_id ? { chip_id: local.chip_id } : {}),
    ...(local?.ambiguousTrade ? { ambiguousTrade: true } : {}),
  };
}

function routeFromModel(model, local, slots, question) {
  const route = {
    intent: model.intent,
    slots,
    layer: 'L2',
    source: 'L2',
    confidence: model.confidence,
    matchedBy: 'online',
  };
  if (model.intent === 'what_if' && !slots.symbol && !slots.trade_date && /(那笔|这笔|那次|这次)/u.test(question)) {
    route.ambiguousTrade = true;
  }
  if (local?.ambiguousTrade) route.ambiguousTrade = true;
  return route;
}

function localDecision({ local, source, modelCalled, localCheck, latencyMs, modelIntent = null, notice = null }) {
  const intent = local?.intent ?? null;
  const route = routeFromLocal(local, intent);
  if (!intent && notice) route.notice = notice;
  if (!intent && local?.notice) route.notice = local.notice;
  return {
    ok: !!intent,
    intent,
    slots: intent ? { ...(local?.slots ?? {}) } : {},
    confidence: intent ? route.confidence : null,
    source,
    decided_by: intent ? 'local' : 'none',
    model_called: modelCalled,
    local_check: localCheck,
    model_intent: modelIntent,
    latency_ms: Math.max(0, Math.round(latencyMs)),
    ambiguous: !intent,
    route,
  };
}

function parseModelIntent(result) {
  if (!result || result.ok !== true) return null;
  const json = result.intentJson ?? result.data?.intentJson ?? null;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (!INTENTS.includes(json.intent)) return null;
  const confidence = json.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { intent: json.intent, slots: normalizeIntentSlots(json.slots), confidence };
}

function waitWithTimeout(task, timeoutMs, controller) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch { /* 已取消时忽略 */ }
      resolve({ __timeout: true });
    }, timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

export function createIntentPolicy({
  classifyLocal = () => null,
  classifyIntent = null,
  timeoutMs = INTENT_TIMEOUT_MS,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  if (typeof classifyLocal !== 'function') throw new TypeError('classifyLocal 必须为函数');
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : INTENT_TIMEOUT_MS;

  async function decide({ question = '', source = 'typed' } = {}) {
    const local = classifyLocal(question) ?? null;
    if (source === 'chip') {
      return localDecision({ local, source: 'chip', modelCalled: false, localCheck: 'chip', latencyMs: 0 });
    }
    if (typeof classifyIntent !== 'function') {
      return localDecision({
        local,
        source: 'typed',
        modelCalled: false,
        localCheck: 'unavailable',
        latencyMs: 0,
        notice: local?.intent ? null : '这次没能理解问法：问题文本未能匹配，账单与事实没有发送。',
      });
    }

    const started = typeof now === 'function' ? now() : Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let result = null;
    let timedOut = false;
    try {
      result = await waitWithTimeout(
        Promise.resolve().then(() => classifyIntent({ question, signal: controller?.signal })),
        timeout,
        controller,
      );
      if (result && result.__timeout === true) {
        timedOut = true;
        result = null;
      }
    } catch {
      result = null;
    }
    const latency = Math.max(0, (typeof now === 'function' ? now() : Date.now()) - started);

    if (timedOut) {
      return localDecision({
        local,
        source: 'typed',
        modelCalled: true,
        localCheck: 'timeout',
        latencyMs: latency,
        notice: local?.intent ? null : '意图分析超时，这次没有据此猜测；账单与事实没有发送。',
      });
    }
    if (!result || result.ok !== true) {
      return localDecision({
        local,
        source: 'typed',
        modelCalled: true,
        localCheck: 'unavailable',
        latencyMs: latency,
        notice: local?.intent ? null : '这次没能理解问法：问题文本未能匹配，账单与事实没有发送。',
      });
    }

    const model = parseModelIntent(result);
    if (!model) {
      return localDecision({
        local,
        source: 'typed',
        modelCalled: true,
        localCheck: 'invalid',
        latencyMs: latency,
        notice: local?.intent ? null : '这次没能确定你的问法，没有据此猜测；账单与事实没有发送。',
      });
    }
    if (model.confidence < INTENT_MIN_CONFIDENCE) {
      return localDecision({
        local,
        source: 'typed',
        modelCalled: true,
        localCheck: 'low_confidence',
        latencyMs: latency,
        modelIntent: model.intent,
        notice: local?.intent ? null : '这次没能确定你的问法，没有据此猜测；账单与事实没有发送。',
      });
    }

    if (local?.intent) {
      if (local.intent !== model.intent) {
        return localDecision({
          local,
          source: 'typed',
          modelCalled: true,
          localCheck: 'conflict',
          latencyMs: latency,
          modelIntent: model.intent,
        });
      }
      const slots = { ...model.slots, ...(local.slots ?? {}) };
      return {
        ok: true,
        intent: model.intent,
        slots,
        confidence: model.confidence,
        source: 'typed',
        decided_by: 'model',
        model_called: true,
        local_check: model.confidence >= INTENT_AGREEMENT_CONFIDENCE ? 'agree' : 'agree_low',
        model_intent: model.intent,
        latency_ms: latency,
        ambiguous: false,
        route: routeFromModel(model, local, slots, question),
      };
    }

    const modelRoute = routeFromModel(model, local, model.slots, question);
    return {
      ok: true,
      intent: model.intent,
      slots: model.slots,
      confidence: model.confidence,
      source: 'typed',
      decided_by: 'model',
      model_called: true,
      local_check: 'model_only',
      model_intent: model.intent,
      latency_ms: latency,
      ambiguous: false,
      route: modelRoute,
    };
  }

  return Object.freeze({ decide });
}
