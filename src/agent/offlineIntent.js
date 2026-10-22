// M1-C6 · 离线意图桩（确定性；接口候选，未冻结）
// 边界：仅映射 F-8 既定的 5 个预置芯片 → 12 类意图；其余问题一律 out_of_scope（不猜测、不扩类别）。
// 在线意图分类（百炼）未接入（M1-C10）；本桩仅为离线链路提供确定性输入，不冒充模型输出。
export const OFFLINE_CHIP_INTENTS = Object.freeze({
  '我最错的一笔是哪个？': 'worst_trade',
  '为什么说我追高？': 'pattern_explain',
  '我该怎么改？': 'how_to_change',
  '我是谁？': 'profile',
  '组合整体表现如何？': 'loss_overview',
});

export const OFFLINE_INTENT_SOURCE = 'offline_stub';

export function classifyOffline(question) {
  const q = String(question ?? '').trim();
  const intent = OFFLINE_CHIP_INTENTS[q];
  if (intent) {
    return { intent, slots: {}, confidence: 1, source: OFFLINE_INTENT_SOURCE };
  }
  return {
    intent: 'out_of_scope',
    slots: {},
    confidence: 1,
    source: OFFLINE_INTENT_SOURCE,
    reason: '未匹配预置芯片（离线桩：不猜测意图）',
  };
}
