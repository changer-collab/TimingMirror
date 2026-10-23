#!/usr/bin/env node
/**
 * 长截图分片几何回归（纯计算；不创建 canvas、不联网）。
 * 覆盖：普通截图单张、长图保持宽度并按重叠切片、顺序/覆盖、8 张上限、过窄长图提示。
 * 运行：node tests/vision-image-segments.test.mjs
 */
import { planImageSegments } from '../src/engine/visionImage.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

{
  const plan = planImageSegments(1080, 2400);
  check('普通手机截图：单张、保持宽度', plan.length === 1
    && plan[0].outWidth === 1080 && plan[0].outHeight === 2400
    && plan[0].sourceY === 0 && plan[0].sourceHeight === 2400, JSON.stringify(plan));
}

{
  const plan = planImageSegments(1080, 10000);
  const ordered = plan.every((segment, index) => segment.index === index && segment.count === plan.length);
  const ascending = plan.every((segment, index) => index === 0 || segment.sourceY > plan[index - 1].sourceY);
  const overlap = plan.every((segment, index) => index === 0
    || plan[index - 1].sourceY + plan[index - 1].sourceHeight > segment.sourceY);
  const covers = plan[plan.length - 1].sourceY + plan[plan.length - 1].sourceHeight >= 10000;
  check('长截图：不超过 8 片且宽度保持 1080', plan.length <= 8 && plan.every((segment) => segment.outWidth === 1080), JSON.stringify(plan));
  check('长截图：顺序、重叠、覆盖到底', ordered && ascending && overlap && covers, JSON.stringify(plan));
  check('长截图：每片高度不超过 2400 且总和覆盖', plan.every((segment) => segment.outHeight <= 2400 && segment.sourceHeight > 0), JSON.stringify(plan));
  check('长截图：首片从顶部开始', plan[0].sourceY === 0, JSON.stringify(plan[0]));
}

{
  let error = null;
  try {
    planImageSegments(1080, 20000);
  } catch (caught) {
    error = caught;
  }
  check('超长截图：超过 8 片时给出明确提示', error && /超过本次最多 8 张/.test(error.message), error?.message);
}

{
  let error = null;
  try {
    planImageSegments(1080, 10000, { maxSegments: 2 });
  } catch (caught) {
    error = caught;
  }
  check('自定义上限：超过 2 片时拒绝', error && /最多 2 张/.test(error.message), error?.message);
}

{
  const plan = planImageSegments(3000, 4000);
  check('宽图：限制最大宽度 1600、不误触发分片', plan.length === 1
    && plan[0].outWidth === 1600 && plan[0].outHeight <= 2400, JSON.stringify(plan));
}

{
  let error = null;
  try {
    planImageSegments(0, 100);
  } catch (caught) {
    error = caught;
  }
  check('非法尺寸：拒绝', error && /尺寸无效/.test(error.message), error?.message);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
