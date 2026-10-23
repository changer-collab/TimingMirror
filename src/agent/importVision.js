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
    return fail(`一次最多识别 ${IMPORT_VISION_MAX_IMAGES} 张图片；请减少截图或缩小截取范围后重试`);
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
    const normalizedImage = {
      mime: image.mime,
      data_base64: image.data_base64,
      bytes: Number.isFinite(image.bytes) ? image.bytes : null,
      width: Number.isFinite(image.width) ? image.width : null,
      height: Number.isFinite(image.height) ? image.height : null,
      pageNumber: Number.isInteger(image.pageNumber) ? image.pageNumber : null,
    };
    // 长截图分片信息只留在本机状态，用于展示和排序；请求体仍只发送 mime/data_base64。
    if (Number.isInteger(image.segmentIndex) && image.segmentIndex > 0) normalizedImage.segmentIndex = image.segmentIndex;
    if (Number.isInteger(image.segmentCount) && image.segmentCount > 0) normalizedImage.segmentCount = image.segmentCount;
    if (Number.isFinite(image.sourceY) && image.sourceY >= 0) normalizedImage.sourceY = image.sourceY;
    if (Number.isFinite(image.sourceHeight) && image.sourceHeight > 0) normalizedImage.sourceHeight = image.sourceHeight;
    if (Number.isInteger(image.sourceIndex) && image.sourceIndex >= 0) normalizedImage.sourceIndex = image.sourceIndex;
    if (Number.isInteger(image.sourceCount) && image.sourceCount > 0) normalizedImage.sourceCount = image.sourceCount;
    if (typeof image.id === 'string' && image.id.length <= 80) normalizedImage.id = image.id;
    normalized.push(normalizedImage);
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

function visionAfterRemovedImages(vision, images, sourceKind) {
  if (images.length === 0) {
    return {
      ...vision,
      images: [],
      totalBytes: 0,
      totalBase64Chars: 0,
      payloadBytes: 0,
      status: 'empty',
      error: null,
      notice: '已移除全部图片；请重新选择截图。',
    };
  }
  const checked = validateVisionInput({ images, sourceKind });
  const totalBytes = checked.ok
    ? checked.totalBytes
    : images.reduce((sum, image) => sum + (Number.isFinite(image.bytes) ? image.bytes : 0), 0);
  const totalBase64Chars = checked.ok
    ? checked.totalBase64Chars
    : images.reduce((sum, image) => sum + String(image.data_base64 ?? '').length, 0);
  return {
    ...vision,
    images: checked.ok ? checked.images : images,
    totalBytes,
    totalBase64Chars,
    payloadBytes: checked.ok ? checked.payloadBytes : 0,
    status: checked.ok ? 'ready' : 'error',
    error: checked.ok ? null : { code: checked.code, message: checked.message },
    notice: checked.ok
      ? `已在本机准备 ${images.length} 张图片；点击识别前不会发送。`
      : '剩余图片未通过校验；请重新选择截图。',
  };
}

/** 删除一张已准备的图片；纯状态迁移，不触碰模型预算或 sessionStorage。 */
export function removeVisionImage(vision, index, { sourceKind = vision?.kind } = {}) {
  if (!vision || !Array.isArray(vision.images) || !Number.isInteger(index)
    || index < 0 || index >= vision.images.length) {
    return null;
  }
  return visionAfterRemovedImages(vision, vision.images.filter((_, i) => i !== index), sourceKind);
}

/** 删除一张来源长图的全部片段；用于长截图右上角删除按钮，避免只删半张来源图。 */
export function removeVisionSource(vision, sourceIndex, { sourceKind = vision?.kind } = {}) {
  if (!vision || !Array.isArray(vision.images) || !Number.isInteger(sourceIndex) || sourceIndex < 0) {
    return null;
  }
  const targets = vision.images.filter((image) => image.sourceIndex === sourceIndex);
  if (targets.length === 0) return null;
  return visionAfterRemovedImages(
    vision,
    vision.images.filter((image) => image.sourceIndex !== sourceIndex),
    sourceKind,
  );
}

/** 标题只由真实状态决定，避免 images 为空时一直显示“正在准备”。 */
export function visionStatusTitle(vision) {
  const count = Array.isArray(vision?.images) ? vision.images.length : 0;
  const pdf = vision?.kind === 'pdf_scan';
  if (vision?.status === 'preparing') return pdf ? '正在准备 PDF 页面…' : '正在准备截图…';
  if (count > 0) {
    const segmented = vision.images.some((image) => Number.isInteger(image.segmentCount) && image.segmentCount > 1);
    if (pdf) return `PDF 已在本机渲染 ${count} 页。`;
    return segmented ? `已在本机准备 ${count} 个图片片段。` : `已在本机准备 ${count} 张截图。`;
  }
  if (vision?.status === 'error') return pdf ? 'PDF 页面准备失败。' : '图片准备失败。';
  if (vision?.status === 'empty') return pdf ? '请选择要识别的 PDF 页面。' : '请选择截图。';
  if (pdf) return '选择要识别的 PDF 页面。';
  return '请选择截图。';
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
