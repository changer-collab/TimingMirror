// 视觉输入的本地图片准备：解码/缩放/JPEG 压缩/Base64；不触发模型、不上传。
export const VISION_IMAGE_MAX_LONG_EDGE = 2400;
export const VISION_IMAGE_MAX_BYTES = 1_400_000;
export const VISION_IMAGE_QUALITY = 0.88;

// 长截图分片：保留手机截图的原始宽度，按固定高度和重叠切片，避免整图压成长边 2400 的窄条。
export const VISION_IMAGE_MAX_SEGMENTS = 8;
export const VISION_IMAGE_SEGMENT_MAX_WIDTH = 1600;
export const VISION_IMAGE_SEGMENT_TRIGGER_HEIGHT = 3000;
export const VISION_IMAGE_SEGMENT_BASE_HEIGHT = 1600;
export const VISION_IMAGE_SEGMENT_OVERLAP = 160;
export const VISION_IMAGE_SEGMENT_QUALITY = 0.92;

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file, { imageOrientation: 'from-image' });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解码图片')); };
    image.src = url;
  });
}

/** 纯计算：给定图片尺寸，返回需要发送的单张/分片几何信息；不触碰 DOM。 */
export function planImageSegments(width, height, {
  maxLongEdge = VISION_IMAGE_MAX_LONG_EDGE,
  maxWidth = VISION_IMAGE_SEGMENT_MAX_WIDTH,
  triggerHeight = VISION_IMAGE_SEGMENT_TRIGGER_HEIGHT,
  baseHeight = VISION_IMAGE_SEGMENT_BASE_HEIGHT,
  overlap = VISION_IMAGE_SEGMENT_OVERLAP,
  maxSegments = VISION_IMAGE_MAX_SEGMENTS,
} = {}) {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('图片尺寸无效');
  }
  if (!Number.isInteger(maxSegments) || maxSegments <= 0) throw new Error('分片数量上限必须为正整数');
  const widthScale = Math.min(1, maxWidth / width);
  const outWidth = Math.max(1, Math.round(width * widthScale));
  const scaledHeight = Math.max(1, Math.round(height * widthScale));
  if (scaledHeight <= triggerHeight) {
    const longEdgeScale = Math.min(1, maxLongEdge / Math.max(outWidth, scaledHeight));
    return [{
      index: 0,
      count: 1,
      outWidth: Math.max(1, Math.round(outWidth * longEdgeScale)),
      outHeight: Math.max(1, Math.round(scaledHeight * longEdgeScale)),
      sourceY: 0,
      sourceHeight: height,
    }];
  }
  const overlapOut = Math.min(Math.max(1, overlap), Math.floor(baseHeight / 3));
  let segmentHeight = Math.max(baseHeight, Math.ceil((scaledHeight + (maxSegments - 1) * overlapOut) / maxSegments));
  segmentHeight = Math.min(segmentHeight, maxLongEdge);
  const step = Math.max(1, segmentHeight - overlapOut);
  const count = Math.max(1, Math.ceil((scaledHeight - overlapOut) / step));
  if (count > maxSegments) {
    throw new Error(`长截图分片后需要 ${count} 张，超过本次最多 ${maxSegments} 张；请缩小截图范围或分次导入`);
  }
  const scale = outWidth / width;
  const maxY = Math.max(0, scaledHeight - segmentHeight);
  const segments = [];
  for (let i = 0; i < count; i += 1) {
    const y = Math.min(i * step, maxY);
    const h = Math.min(segmentHeight, scaledHeight - y);
    const sourceY = Math.min(height - 1, Math.round(y / scale));
    const sourceHeight = Math.min(height - sourceY, Math.max(1, Math.round(h / scale)));
    segments.push({
      index: i,
      count,
      outWidth,
      outHeight: h,
      sourceY,
      sourceHeight,
    });
  }
  return segments;
}

async function encodeCanvas(canvas, { quality, maxBytes }) {
  let blob = await canvasToBlob(canvas, quality);
  if (!blob) throw new Error('图片压缩失败');
  let bytes = new Uint8Array(await blob.arrayBuffer());
  for (const fallbackQuality of [0.8, 0.72]) {
    if (bytes.byteLength <= maxBytes) break;
    blob = await canvasToBlob(canvas, fallbackQuality);
    if (!blob) throw new Error('图片压缩失败');
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`图片片段压缩后仍超过 ${Math.round(maxBytes / 1024 / 1024 * 10) / 10}MB；请缩小截图范围`);
  }
  return bytes;
}

/** 读取一张图片，按需分片；保持原始上下顺序，片段之间保留重叠。 */
export async function prepareImageSegments(file, {
  maxLongEdge = VISION_IMAGE_MAX_LONG_EDGE,
  maxWidth = VISION_IMAGE_SEGMENT_MAX_WIDTH,
  triggerHeight = VISION_IMAGE_SEGMENT_TRIGGER_HEIGHT,
  baseHeight = VISION_IMAGE_SEGMENT_BASE_HEIGHT,
  overlap = VISION_IMAGE_SEGMENT_OVERLAP,
  quality = VISION_IMAGE_SEGMENT_QUALITY,
  maxBytes = VISION_IMAGE_MAX_BYTES,
  maxSegments = VISION_IMAGE_MAX_SEGMENTS,
} = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('图片文件无效');
  let image;
  try {
    image = await loadImage(file);
  } catch {
    throw new Error('无法解码图片；请换一张 JPG/PNG 截图');
  }
  try {
    const width = image.width ?? image.naturalWidth;
    const height = image.height ?? image.naturalHeight;
    const plan = planImageSegments(width, height, {
      maxLongEdge,
      maxWidth,
      triggerHeight,
      baseHeight,
      overlap,
      maxSegments,
    });
    const images = [];
    for (const segment of plan) {
      const canvas = document.createElement('canvas');
      canvas.width = segment.outWidth;
      canvas.height = segment.outHeight;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('本机画布不可用，无法压缩图片');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, segment.outWidth, segment.outHeight);
      ctx.drawImage(
        image,
        0,
        segment.sourceY,
        width,
        segment.sourceHeight,
        0,
        0,
        segment.outWidth,
        segment.outHeight,
      );
      const bytes = await encodeCanvas(canvas, { quality, maxBytes });
      images.push({
        mime: 'image/jpeg',
        data_base64: bytesToBase64(bytes),
        bytes: bytes.byteLength,
        width: segment.outWidth,
        height: segment.outHeight,
        pageNumber: null,
        segmentIndex: segment.index + 1,
        segmentCount: segment.count,
        sourceY: segment.sourceY,
        sourceHeight: segment.sourceHeight,
      });
    }
    return images;
  } finally {
    if (typeof image.close === 'function') image.close();
  }
}

/** 多文件入口：按选择顺序展开分片，并保证总数不超过上限。 */
export async function prepareImageFiles(files, {
  maxImages = VISION_IMAGE_MAX_SEGMENTS,
  ...options
} = {}) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('请选择至少一张图片');
  if (!Number.isInteger(maxImages) || maxImages <= 0) throw new Error('图片数量上限必须为正整数');
  if (files.length > maxImages) {
    throw new Error(`一次最多处理 ${maxImages} 张图片；请减少截图数量或分次导入`);
  }
  const images = [];
  const sourceCount = files.length;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const remaining = maxImages - images.length;
    if (remaining <= 0) {
      throw new Error(`图片分片后共超过 ${maxImages} 张；请减少图片或缩小截图范围`);
    }
    const segments = await prepareImageSegments(files[fileIndex], { ...options, maxSegments: remaining });
    if (images.length + segments.length > maxImages) {
      throw new Error(`图片分片后共 ${images.length + segments.length} 张，超过一次最多 ${maxImages} 张；请减少图片或缩小截图范围`);
    }
    // 同一张来源长图的多个片段共享 sourceIndex；删除按钮按来源图片整组删除。
    segments.forEach((segment) => {
      segment.sourceIndex = fileIndex;
      segment.sourceCount = sourceCount;
    });
    images.push(...segments);
  }
  return images;
}

export async function prepareImageFile(file, {
  maxLongEdge = VISION_IMAGE_MAX_LONG_EDGE,
  maxBytes = VISION_IMAGE_MAX_BYTES,
  quality = VISION_IMAGE_QUALITY,
} = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('图片文件无效');
  let image;
  try {
    image = await loadImage(file);
  } catch {
    throw new Error('无法解码图片；请换一张 JPG/PNG 截图');
  }
  const width = image.width ?? image.naturalWidth;
  const height = image.height ?? image.naturalHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    if (typeof image.close === 'function') image.close();
    throw new Error('图片尺寸无效');
  }
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    if (typeof image.close === 'function') image.close();
    throw new Error('本机画布不可用，无法压缩图片');
  }
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.drawImage(image, 0, 0, outWidth, outHeight);
  if (typeof image.close === 'function') image.close();

  let blob = await canvasToBlob(canvas, quality);
  if (!blob) throw new Error('图片压缩失败');
  let bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    blob = await canvasToBlob(canvas, 0.72);
    if (!blob) throw new Error('图片压缩失败');
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`图片压缩后仍超过 ${Math.round(maxBytes / 1024 / 1024 * 10) / 10}MB；请裁剪或换一张更小的截图`);
  }
  return {
    mime: 'image/jpeg',
    data_base64: bytesToBase64(bytes),
    bytes: bytes.byteLength,
    width: outWidth,
    height: outHeight,
  };
}
