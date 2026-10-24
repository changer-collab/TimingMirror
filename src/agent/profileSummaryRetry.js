// 画像解读重试：只对限流 / 临时不可用 / 未知瞬时错误补一次；
// 鉴权、权限、请求配置、超时和内容校验问题直接返回原因，避免掩盖真实故障。
export const PROFILE_SUMMARY_RETRY_DELAY_MS = 800;

const RETRY_DETAILS = new Set(['upstream_rate_limited', 'upstream_unavailable', 'upstream_unknown']);

export function shouldRetryProfileSummary(response) {
  return response?.ok === true
    && response.source === 'template'
    && RETRY_DETAILS.has(response.fallback_detail);
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function requestProfileSummaryWithRetry({
  request,
  digest,
  signal,
  retryDelayMs = PROFILE_SUMMARY_RETRY_DELAY_MS,
  sleep = defaultSleep,
} = {}) {
  if (typeof request !== 'function') throw new TypeError('request must be a function');
  let first;
  try {
    first = await request({ digest, signal });
  } catch {
    await sleep(retryDelayMs);
    return request({ digest, signal });
  }
  if (!shouldRetryProfileSummary(first)) return first;
  await sleep(retryDelayMs);
  try {
    return await request({ digest, signal });
  } catch {
    return first;
  }
}
