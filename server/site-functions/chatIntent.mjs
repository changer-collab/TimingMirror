// 问答意图响应的服务端 schema 校验：只接受已定义意图类别、两个槽位与 [0,1] 置信度。
// 校验后只回传规范化 JSON，模型多写的字段不会进入客户端；不记录问题或模型正文。
export const CHAT_INTENT_CATEGORIES = Object.freeze([
  'worst_trade', 'best_trade', 'loss_overview', 'pattern_explain', 'profile', 'what_if', 'similar_context',
  'how_to_change', 'contract_setup', 'contract_status', 'meta_calc', 'meta_trust', 'out_of_scope',
]);

export const CHAT_INTENT_CODES = Object.freeze({
  RESPONSE: 'E_CHAT_INTENT_RESPONSE_INVALID',
});

const RESPONSE_KEYS = new Set(['intent', 'slots', 'confidence']);
const SLOT_KEYS = new Set(['symbol', 'trade_date']);
const SYMBOL_RE = /^\d{6}$/u;
const DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(message) {
  return { ok: false, code: CHAT_INTENT_CODES.RESPONSE, errors: [message] };
}

function normalizedDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(DATE_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function validateChatIntentResponse(rawText) {
  if (typeof rawText !== 'string') return fail('响应正文必须为字符串');
  const trimmed = rawText.trim().replace(/^\uFEFF/u, '');
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed;
  try {
    parsed = JSON.parse(fenced ? fenced[1].trim() : trimmed);
  } catch {
    return fail('响应不是合法 JSON');
  }
  if (!isObject(parsed)) return fail('响应必须为对象');
  const extra = Object.keys(parsed).filter((key) => !RESPONSE_KEYS.has(key));
  if (extra.length) return fail(`响应不允许字段：${extra.join(',')}`);
  if (!CHAT_INTENT_CATEGORIES.includes(parsed.intent)) return fail('intent 不在已定义类别内');
  if (typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence)
    || parsed.confidence < 0 || parsed.confidence > 1) {
    return fail('confidence 必须为 [0,1] 数值');
  }
  const slots = {};
  if (parsed.slots !== undefined && parsed.slots !== null) {
    if (!isObject(parsed.slots)) return fail('slots 必须为对象');
    const extraSlots = Object.keys(parsed.slots).filter((key) => !SLOT_KEYS.has(key));
    if (extraSlots.length) return fail(`slots 不允许字段：${extraSlots.join(',')}`);
    if (parsed.slots.symbol !== undefined && parsed.slots.symbol !== null) {
      if (typeof parsed.slots.symbol !== 'string' || !SYMBOL_RE.test(parsed.slots.symbol.trim())) {
        return fail('slots.symbol 必须为六位数字代码');
      }
      slots.symbol = parsed.slots.symbol.trim();
    }
    if (parsed.slots.trade_date !== undefined && parsed.slots.trade_date !== null) {
      const tradeDate = normalizedDate(parsed.slots.trade_date);
      if (!tradeDate) return fail('slots.trade_date 必须为有效日期');
      slots.trade_date = tradeDate;
    }
  }
  return { ok: true, value: { intent: parsed.intent, slots, confidence: parsed.confidence } };
}
