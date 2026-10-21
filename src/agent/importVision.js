// 视觉识别请求的客户端约束（截图或本地渲染后的扫描 PDF 页面）。
// 模型官方支持多图，但本项目受本地内存、清晰度、Base64 总请求体、部署网关与上下文 token 约束，
// 采用产品上限：单请求最多 8 张，单图 Base64 2,000,000 字符，总 Base64 7,000,000 字符，
// JSON 请求体不超过 7,500,000 字节；超过时要求用户缩小范围，不静默截断。
export const IMPORT_VISION_STAGE = 'bill_extract_vision';
export const IMPORT_VISION_MAX_IMAGES = 8;
export const IMPORT_VISION_MAX_IMAGE_BASE64_CHARS = 2_000_000;
export const IMPORT_VISION_MAX_TOTAL_BASE64_CHARS = 7_000_000;
export const IMPORT_VISION_MAX_PAYLOAD_BYTES = 7_500_000;
export const IMPORT_VISION_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png']);
export const IMPORT_VISION_SOURCE_KINDS = Object.freeze(['image', 'pdf_scan']);

export const IMPORT_VISION_CODES = Object.freeze({
  INPUT_INVALID: 'E_IMPORT_VISION_INPUT_INVALID',
});

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(message) {
  return { ok: false, code: IMPORT_VISION_CODES.INPUT_INVALID, message };
}

export function validateVisionInput({ images, sourceKind } = {}) {
  if (!IMPORT_VISION_SOURCE_KINDS.includes(sourceKind)) {
    return fail('视觉识别来源类型非法');
  }
  if (!Array.isArray(images) || images.length === 0) {
    return fail('请选择至少一张图片');
  }
  if (images.length > IMPORT_VISION_MAX_IMAGES) {
    return fail(`一次最多识别 ${IMPORT_VISION_MAX_IMAGES} 张图片；请缩小页码范围或减少截图后重试`);
  }
  let totalBase64 = 0;
  const normalized = [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (!image || typeof image !== 'object' || !IMPORT_VISION_MIME_TYPES.includes(image.mime)
      || typeof image.data_base64 !== 'string' || image.data_base64 === ''
      || !BASE64_RE.test(image.data_base64)) {
      return fail(`第 ${i + 1} 张图片格式非法；只支持 JPEG/PNG 的 Base64`);
    }
    if (image.data_base64.length > IMPORT_VISION_MAX_IMAGE_BASE64_CHARS) {
      return fail(`第 ${i + 1} 张图片过大；请降低清晰度或缩小截取范围`);
    }
    totalBase64 += image.data_base64.length;
    if (totalBase64 > IMPORT_VISION_MAX_TOTAL_BASE64_CHARS) {
      return fail(`图片总量过大；请减少图片数量或降低清晰度（当前上限约 ${Math.round(IMPORT_VISION_MAX_TOTAL_BASE64_CHARS / 1024 / 1024)}MB）`);
    }
    normalized.push({
      mime: image.mime,
      data_base64: image.data_base64,
      bytes: Number.isFinite(image.bytes) ? image.bytes : null,
      width: Number.isFinite(image.width) ? image.width : null,
      height: Number.isFinite(image.height) ? image.height : null,
      pageNumber: Number.isInteger(image.pageNumber) ? image.pageNumber : null,
    });
  }
  const payloadBytes = visionPayloadBytes({ images: normalized, sourceKind });
  if (payloadBytes > IMPORT_VISION_MAX_PAYLOAD_BYTES) {
    return fail(`图片请求体过大；请减少图片数量或降低清晰度（当前上限约 ${Math.round(IMPORT_VISION_MAX_PAYLOAD_BYTES / 1024 / 1024)}MB）`);
  }
  return {
    ok: true,
    images: normalized,
    totalBase64Chars: totalBase64,
    totalBytes: normalized.reduce((sum, image) => sum + (image.bytes ?? 0), 0),
    payloadBytes,
  };
}

export function visionPayloadBytes({ images, sourceKind, flowId = null, requestId = null } = {}) {
  const payload = {
    images: images.map((image) => ({ mime: image.mime, data_base64: image.data_base64 })),
    stage: IMPORT_VISION_STAGE,
    source_kind: sourceKind,
    ...(flowId ? { flow_id: flowId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}
