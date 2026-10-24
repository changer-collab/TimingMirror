// 视觉识别阶段（DeepSeek 多模态图片批次；DashScope 仅保留人工回滚）· 服务端无状态校验。
// 只接受 JPEG/PNG Base64 图片；不接受文件名、URL、账单正文或 flow 状态。
// flow_id/request_id 仅用于审计透传；本函数不计数、不强制配额。
import { validateImportRecoverResponse } from './importRecover.mjs';

export const IMPORT_VISION_STAGE = 'bill_extract_vision';
export const IMPORT_VISION_MAX_IMAGES = 8;
export const IMPORT_VISION_MAX_IMAGE_BASE64_CHARS = 2_000_000;
export const IMPORT_VISION_MAX_TOTAL_BASE64_CHARS = 7_000_000;
export const IMPORT_VISION_SOURCE_KINDS = Object.freeze(['image', 'pdf_scan']);
export const IMPORT_VISION_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png']);

export const IMPORT_VISION_CODES = Object.freeze({
  REQUEST_INVALID: 'E_IMPORT_VISION_REQUEST_INVALID',
  RESPONSE: 'E_IMPORT_VISION_RESPONSE_INVALID',
});

const REQUEST_KEYS = new Set(['images', 'stage', 'source_kind', 'flow_id', 'request_id']);
const IMAGE_KEYS = new Set(['mime', 'data_base64']);
const TRACE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(code, message) {
  return { ok: false, code, errors: [message] };
}

export function normalizeImportVisionRequest(body) {
  if (!isObject(body)) return fail(IMPORT_VISION_CODES.REQUEST_INVALID, '请求体必须为对象');
  for (const key of Object.keys(body)) {
    if (!REQUEST_KEYS.has(key)) return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `不允许字段：${key}`);
  }
  if (body.stage !== IMPORT_VISION_STAGE) {
    return fail(IMPORT_VISION_CODES.REQUEST_INVALID, 'stage 必须为 bill_extract_vision');
  }
  if (!IMPORT_VISION_SOURCE_KINDS.includes(body.source_kind)) {
    return fail(IMPORT_VISION_CODES.REQUEST_INVALID, 'source_kind 不在允许范围');
  }
  if (!Array.isArray(body.images) || body.images.length === 0 || body.images.length > IMPORT_VISION_MAX_IMAGES) {
    return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `images 必须为 1-${IMPORT_VISION_MAX_IMAGES} 张`);
  }
  const images = [];
  let totalBase64 = 0;
  for (let i = 0; i < body.images.length; i++) {
    const image = body.images[i];
    if (!isObject(image)) return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `images[${i}] 必须为对象`);
    for (const key of Object.keys(image)) {
      if (!IMAGE_KEYS.has(key)) return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `images[${i}] 包含不允许字段`);
    }
    if (!IMPORT_VISION_MIME_TYPES.includes(image.mime)
      || typeof image.data_base64 !== 'string' || image.data_base64 === ''
      || !BASE64_RE.test(image.data_base64)) {
      return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `images[${i}] 必须为 JPEG/PNG Base64`);
    }
    if (image.data_base64.length > IMPORT_VISION_MAX_IMAGE_BASE64_CHARS) {
      return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `images[${i}] 超过单图大小限制`);
    }
    totalBase64 += image.data_base64.length;
    if (totalBase64 > IMPORT_VISION_MAX_TOTAL_BASE64_CHARS) {
      return fail(IMPORT_VISION_CODES.REQUEST_INVALID, '图片总量超过请求体限制');
    }
    images.push({ mime: image.mime, data_base64: image.data_base64 });
  }
  for (const key of ['flow_id', 'request_id']) {
    if (body[key] !== undefined && body[key] !== null && (typeof body[key] !== 'string' || !TRACE_ID_RE.test(body[key]))) {
      return fail(IMPORT_VISION_CODES.REQUEST_INVALID, `${key} 格式非法`);
    }
  }
  return {
    ok: true,
    request: {
      images,
      stage: IMPORT_VISION_STAGE,
      source_kind: body.source_kind,
      flow_id: body.flow_id ?? null,
      request_id: body.request_id ?? null,
    },
  };
}

// 视觉模型可能把行号输出为严格数字字符串；row 仅用于展示，视觉入口无损归一化，文字导入保持严格。
export function validateImportVisionResponse(rawText) {
  return validateImportRecoverResponse(rawText, { normalizeVisionRow: true });
}
