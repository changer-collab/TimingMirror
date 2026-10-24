// Provider selection: DeepSeek is the production model path.
// The DashScope adapter remains in dashscope.mjs for manual rollback only;
// it is never selected automatically when DeepSeek is missing or failing.
import { createDeepSeekTransport, DEEPSEEK_DEFAULT_MODEL } from './deepseek.mjs';

export function createModelTransport({
  deepseekApiKey = '',
  deepseekModel = '',
  timeoutMs,
  visionTimeoutMs,
  fetchImpl,
} = {}) {
  if (typeof deepseekApiKey !== 'string' || deepseekApiKey.trim() === '') return null;
  const model = typeof deepseekModel === 'string' && deepseekModel.trim() !== ''
    ? deepseekModel.trim()
    : DEEPSEEK_DEFAULT_MODEL;
  return createDeepSeekTransport({
    apiKey: deepseekApiKey,
    model,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(visionTimeoutMs === undefined ? {} : { visionTimeoutMs }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}
