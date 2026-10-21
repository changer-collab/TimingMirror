// 视觉输入的本地图片准备：解码/缩放/JPEG 压缩/Base64；不触发模型、不上传。
export const VISION_IMAGE_MAX_LONG_EDGE = 2400;
export const VISION_IMAGE_MAX_BYTES = 1_400_000;
export const VISION_IMAGE_QUALITY = 0.88;

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
