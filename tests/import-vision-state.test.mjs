#!/usr/bin/env node
/**
 * 视觉图片本地状态回归（纯函数；不联网、不触发模型）。
 * 覆盖：单图删除、空状态、总量重算、标题状态、分片元数据保留。
 * 运行：node tests/import-vision-state.test.mjs
 */
import {
  removeVisionImage,
  removeVisionSource,
  visionStatusTitle,
  validateVisionInput,
} from '../src/agent/importVision.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function image(base64, extra = {}) {
  return {
    mime: 'image/jpeg',
    data_base64: base64,
    bytes: base64.length,
    width: 1080,
    height: 1600,
    ...extra,
  };
}

const vision = {
  kind: 'image',
  fileName: '截图识别',
  pageCount: 0,
  startPage: 0,
  endPage: 0,
  images: [
    image('AAAA', { segmentIndex: 1, segmentCount: 2, sourceIndex: 0, sourceCount: 1, sourceY: 0, sourceHeight: 1600 }),
    image('AAAAAAAA', { segmentIndex: 2, segmentCount: 2, sourceIndex: 0, sourceCount: 1, sourceY: 1440, sourceHeight: 1600 }),
  ],
  totalBytes: 12,
  totalBase64Chars: 12,
  payloadBytes: 200,
  status: 'ready',
  error: null,
  notice: '',
};

{
  const next = removeVisionImage(vision, 0);
  check('删除一张：保留剩余图片与分片元数据', next && next.images.length === 1
    && next.images[0].segmentIndex === 2 && next.images[0].segmentCount === 2
    && next.status === 'ready' && next.error === null, JSON.stringify(next));
  check('删除一张：总量与请求体大小重新计算', next.totalBytes === 8
    && next.totalBase64Chars === 8
    && next.payloadBytes > 0 && next.payloadBytes < vision.payloadBytes,
  JSON.stringify({ totalBytes: next.totalBytes, totalBase64Chars: next.totalBase64Chars, payloadBytes: next.payloadBytes }));
  check('删除一张：提示数量更新', /1 张图片/.test(next.notice), next.notice);
}

{
  const next = removeVisionImage({ ...vision, images: [vision.images[0]] }, 0);
  check('删除最后一张：进入明确空状态', next && next.images.length === 0
    && next.status === 'empty' && next.totalBytes === 0 && next.totalBase64Chars === 0 && next.payloadBytes === 0,
  JSON.stringify(next));
  check('删除最后一张：不再显示“正在准备”', visionStatusTitle(next) === '请选择截图。' && !/正在准备/.test(visionStatusTitle(next)),
    visionStatusTitle(next));
}

{
  const multiSource = {
    ...vision,
    images: [
      image('AAAA', { segmentIndex: 1, segmentCount: 2, sourceIndex: 0, sourceCount: 2, sourceY: 0, sourceHeight: 1600 }),
      image('AAAAAAAA', { segmentIndex: 2, segmentCount: 2, sourceIndex: 0, sourceCount: 2, sourceY: 1440, sourceHeight: 1600 }),
      image('AAAA', { segmentIndex: 1, segmentCount: 1, sourceIndex: 1, sourceCount: 2, sourceY: 0, sourceHeight: 1600 }),
    ],
  };
  const next = removeVisionSource(multiSource, 0);
  check('删除来源长图：整组片段一起移除，不留下半张图', next && next.images.length === 1
    && next.images[0].sourceIndex === 1 && next.status === 'ready', JSON.stringify(next));
  check('删除来源长图：剩余片段重新计算总量', next.totalBytes === 4 && next.totalBase64Chars === 4,
    JSON.stringify({ totalBytes: next.totalBytes, totalBase64Chars: next.totalBase64Chars }));
  const emptySource = removeVisionSource(next, 1);
  check('删除最后一张来源图：进入空状态', emptySource && emptySource.images.length === 0
    && emptySource.status === 'empty', JSON.stringify(emptySource));
  check('删除不存在的来源图：不清空状态', removeVisionSource(multiSource, 9) === null);
}

{
  check('非法索引：返回 null，不破坏原状态', removeVisionImage(vision, -1) === null
    && removeVisionImage(vision, 9) === null && vision.images.length === 2);
  const checked = validateVisionInput({ images: vision.images, sourceKind: 'image' });
  check('校验保留分片元数据、不改变服务端请求字段', checked.ok === true
    && checked.images[0].segmentIndex === 1 && checked.images[1].sourceY === 1440
    && !('fileName' in checked.images[0]), JSON.stringify(checked.images[0]));
}

{
  check('标题：preparing 才显示“正在准备”', visionStatusTitle({ ...vision, images: [], status: 'preparing' }) === '正在准备截图…');
  check('标题：已准备显示张数', visionStatusTitle({ ...vision, images: [image('AAAA')] }) === '已在本机准备 1 张截图。');
  check('标题：分片显示片段数', visionStatusTitle(vision) === '已在本机准备 2 个图片片段。');
  check('标题：准备失败显示失败', visionStatusTitle({ ...vision, images: [], status: 'error' }) === '图片准备失败。');
  check('标题：PDF 选择页', visionStatusTitle({ kind: 'pdf_scan', images: [], status: 'selecting' }) === '选择要识别的 PDF 页面。');
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
