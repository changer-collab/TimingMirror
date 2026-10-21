// 本地 pdf.js 渲染（仅浏览器按需动态导入）；不触发模型、不上传 PDF。
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { bytesToBase64 } from './visionImage.js';

const VENDOR_BASE = new URL('../vendor/pdfjs/', import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR_BASE).href;
const CMAP_URL = new URL('cmaps/', VENDOR_BASE).href;
const STANDARD_FONT_URL = new URL('standard_fonts/', VENDOR_BASE).href;
const WASM_URL = new URL('wasm/', VENDOR_BASE).href;

async function openPdf(bytes) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_URL,
    wasmUrl: WASM_URL,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  return { doc, loadingTask };
}

export async function getPdfPageCount(bytes) {
  const { doc, loadingTask } = await openPdf(bytes);
  const count = doc.numPages;
  await loadingTask.destroy();
  return count;
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function renderPdfPages(bytes, pageNumbers, {
  maxLongEdge = 2400,
  maxBytes = 1_400_000,
  quality = 0.88,
} = {}) {
  const pages = [...new Set(pageNumbers)].sort((a, b) => a - b);
  if (pages.length === 0) throw new Error('没有选择页面');
  const { doc, loadingTask } = await openPdf(bytes);
  const images = [];
  try {
    for (const pageNumber of pages) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
        throw new Error(`页码超出范围：${pageNumber}`);
      }
      const page = await doc.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, maxLongEdge / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('本机画布不可用，无法渲染 PDF 页面');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, background: '#fff' }).promise;
      let blob = await canvasToBlob(canvas, quality);
      if (!blob) throw new Error('PDF 页面压缩失败');
      let data = new Uint8Array(await blob.arrayBuffer());
      if (data.byteLength > maxBytes) {
        blob = await canvasToBlob(canvas, 0.72);
        if (!blob) throw new Error('PDF 页面压缩失败');
        data = new Uint8Array(await blob.arrayBuffer());
      }
      if (data.byteLength > maxBytes) {
        throw new Error(`第 ${pageNumber} 页压缩后仍过大；请缩小页码范围或使用更清晰/更小的源文件`);
      }
      images.push({
        mime: 'image/jpeg',
        data_base64: bytesToBase64(data),
        bytes: data.byteLength,
        width: canvas.width,
        height: canvas.height,
        pageNumber,
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return images;
}
