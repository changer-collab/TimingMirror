// 测试辅助：可注入 transport 的 fake 实现；不发起网络请求。
import { TransportError } from '../../src/agent/onlineBoundary.js';

export function jsonResponse(value) {
  return { rawText: JSON.stringify(value) };
}

export function rawResponse(rawText) {
  return { rawText };
}

export function networkFailure() {
  throw new TransportError('E_TRANSPORT_NETWORK');
}

export function hangingResponse({ signal } = {}) {
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => {});
  }
  return new Promise(() => {});
}

export function createFakeTransport({
  intent = () => jsonResponse({ intent: 'loss_overview', slots: {}, confidence: 1 }),
  restate = () => jsonResponse({ answer_text: 'ok' }),
} = {}) {
  const calls = [];
  return {
    calls,
    async intent({ signal, ...request }) {
      calls.push({ stage: 'intent', request, signal });
      return intent({ ...request, signal });
    },
    async restate({ signal, ...request }) {
      calls.push({ stage: 'restate', request, signal });
      return restate({ ...request, signal });
    },
  };
}
