#!/usr/bin/env node
/**
 * TimingMirror 本地静态服务器（零依赖；仅开发用，非产品运行时）
 * 运行：npm run dev  或  node scripts/serve.mjs --port=5180
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    // 不公开服务端目录与点文件（含 .env）；静态服务仅面向浏览器资源。
    const segments = p.replace(/^\/+/, '').replace(/\\/g, '/').split('/');
    if (segments.some((s) => s.toLowerCase() === 'server' || s.startsWith('.'))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const filePath = normalize(join(ROOT, p));
    if (!filePath.startsWith(ROOT + sep)) { res.writeHead(403); res.end('403 Forbidden'); return; }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`TimingMirror dev server → http://localhost:${PORT}`);
});
