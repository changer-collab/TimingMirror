#!/usr/bin/env node
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
const ENTRY = 'prototype/user-frontend/index.html';

const required = [
  'src',
  'prototype',
  'm0',
  'data/market-cache.json',
  ENTRY,
  'server/site-functions/index.ts',
];

for (const rel of required) {
  const info = await stat(join(ROOT, rel)).catch(() => null);
  if (!info) throw new Error(`构建缺少必需路径：${rel}`);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const rel of ['src', 'prototype', 'm0']) {
  await cp(join(ROOT, rel), join(OUT, rel), { recursive: true });
}

await mkdir(join(OUT, 'data'), { recursive: true });
await cp(join(ROOT, 'data/market-cache.json'), join(OUT, 'data/market-cache.json'));

await writeFile(join(OUT, 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=./${ENTRY}">
  <title>择时镜子 TimingMirror</title>
</head>
<body>
  <p>正在进入择时镜子…如果浏览器没有自动跳转，请<a href="./${ENTRY}">点这里</a>。</p>
  <script>location.replace('./${ENTRY}');</script>
</body>
</html>
`, 'utf8');

console.log(`站点构建完成：${OUT}`);
console.log(`入口：/${ENTRY}`);
console.log('函数目录：server/site-functions（由 Qoder Sites 单独部署，不在 dist 内）');
