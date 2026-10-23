// DeepSeek 站点 Function transport（OpenAI 兼容 Chat Completions）。
// 只接收浏览器已校验的文本或 JPEG/PNG 页面图片；原始 PDF 不在服务端转图、也不会作为 image_url 发送。
// 不记录 question/facts/rawText/API Key，不向调用方回传供应商原始正文。
import { MODEL_PROMPTS, ModelTransportError } from './dashscope.mjs';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_BASE_URL}/chat/completions`;
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
export const DEEPSEEK_DEFAULT_TIMEOUT_MS = 15000;

export const DEEPSEEK_ERROR_CODES = Object.freeze({
  AUTH_FAILED: 'E_MODEL_AUTH_FAILED',
  FORBIDDEN: 'E_MODEL_FORBIDDEN',
  RATE_LIMITED: 'E_MODEL_RATE_LIMITED',
  UNAVAILABLE: 'E_MODEL_UNAVAILABLE',
  TIMEOUT: 'E_MODEL_TIMEOUT',
  RESPONSE: 'E_MODEL_RESPONSE_INVALID',
});

function fail(code) {
  return new ModelTransportError(code);
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('');
}

function statusError(status) {
  if (status === 401) return fail(DEEPSEEK_ERROR_CODES.AUTH_FAILED);
  if (status === 403) return fail(DEEPSEEK_ERROR_CODES.FORBIDDEN);
  if (status === 429) return fail(DEEPSEEK_ERROR_CODES.RATE_LIMITED);
  return fail(DEEPSEEK_ERROR_CODES.UNAVAILABLE);
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new TypeError('images 必须为非空数组');
  }
  return images.map((image, index) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new TypeError(`images[${index}] 必须为对象`);
    }
    if (typeof image.mime !== 'string' || !image.mime.startsWith('image/')) {
      throw new TypeError(`images[${index}] MIME 必须为 image/*`);
    }
    if (typeof image.data_base64 !== 'string' || image.data_base64.trim() === '') {
      throw new TypeError(`images[${index}] 缺少 Base64`);
    }
    return { mime: image.mime, data_base64: image.data_base64 };
  });
}

export function createDeepSeekTransport({
  apiKey,
  model = DEEPSEEK_DEFAULT_MODEL,
  timeoutMs = DEEPSEEK_DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  baseUrl = DEEPSEEK_BASE_URL,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new TypeError('apiKey 必须为非空字符串');
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('model 必须为非空字符串');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须为函数');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正整数');
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') throw new TypeError('baseUrl 必须为非空字符串');
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  async function request(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error && error.name === 'AbortError')) {
          throw fail(DEEPSEEK_ERROR_CODES.TIMEOUT);
        }
        throw fail(DEEPSEEK_ERROR_CODES.UNAVAILABLE);
      }
      if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') {
        throw fail(DEEPSEEK_ERROR_CODES.RESPONSE);
      }
      if (!response.ok) throw statusError(Number(response.status));
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted || (error && error.name === 'AbortError')) {
          throw fail(DEEPSEEK_ERROR_CODES.TIMEOUT);
        }
        throw fail(DEEPSEEK_ERROR_CODES.RESPONSE);
      }
      if (controller.signal.aborted) throw fail(DEEPSEEK_ERROR_CODES.TIMEOUT);
      const choices = payload?.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw fail(DEEPSEEK_ERROR_CODES.RESPONSE);
      }
      const message = choices[0]?.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw fail(DEEPSEEK_ERROR_CODES.RESPONSE);
      }
      const text = contentText(message.content);
      const rawText = stripCodeFence(text);
      if (rawText === '') throw fail(DEEPSEEK_ERROR_CODES.RESPONSE);
      return { rawText };
    } catch (error) {
      if (error instanceof ModelTransportError) throw error;
      if (controller.signal.aborted || (error && error.name === 'AbortError')) {
        throw fail(DEEPSEEK_ERROR_CODES.TIMEOUT);
      }
      throw fail(DEEPSEEK_ERROR_CODES.UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }

  function call(messages, overrides = {}) {
    return request({
      model,
      messages,
      ...overrides,
      response_format: { type: 'json_object' },
    });
  }

  function callVision(images) {
    const checked = validateImages(images);
    const content = [
      { type: 'text', text: MODEL_PROMPTS.importVisionUser },
      ...checked.map((image) => ({
        type: 'image_url',
        image_url: {
          url: `data:${image.mime};base64,${image.data_base64}`,
          detail: 'auto',
        },
      })),
    ];
    return request({
      model,
      messages: [
        { role: 'system', content: MODEL_PROMPTS.importVisionSystem },
        { role: 'user', content },
      ],
      response_format: { type: 'json_object' },
    });
  }

  return Object.freeze({
    intent({ question }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.intent },
        { role: 'user', content: question },
      ]);
    },
    restate({ question, facts }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.restate },
        { role: 'user', content: JSON.stringify({ question, facts }) },
      ], { temperature: 0.1 });
    },
    ruleIntent({ question, allowed_templates, context_summary }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.ruleIntent },
        { role: 'user', content: JSON.stringify({ question, allowed_templates, context_summary }) },
      ]);
    },
    behaviorAnalysis({ facts }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.behaviorAnalysis },
        { role: 'user', content: JSON.stringify(facts) },
      ], { temperature: 0.1 });
    },
    resultExplanation({ rule, simulation }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.resultExplanation },
        { role: 'user', content: JSON.stringify({ rule, simulation }) },
      ], { temperature: 0.1 });
    },
    scenarioJudgment({ scenario }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.scenarioJudgment },
        { role: 'user', content: JSON.stringify({ scenario }) },
      ], { temperature: 0.1 });
    },
    customRuleJudgment({ rule, scenario, data }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.customRuleJudgment },
        { role: 'user', content: JSON.stringify({ rule, scenario, data }) },
      ], { temperature: 0.1 });
    },
    importRecover({ content, source_kind }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.importRecover },
        { role: 'user', content: JSON.stringify({ source_kind, content }) },
      ]);
    },
    profileSummary({ digest }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.profileSummary },
        { role: 'user', content: JSON.stringify(digest) },
      ], { temperature: 0.2 });
    },
    profileFact({ message }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.profileFact },
        { role: 'user', content: JSON.stringify({ message }) },
      ], { temperature: 0 });
    },
    vision({ images }) {
      return callVision(images);
    },
    rule({ text }) {
      return call([
        { role: 'system', content: MODEL_PROMPTS.rule },
        { role: 'user', content: text },
      ]);
    },
  });
}
