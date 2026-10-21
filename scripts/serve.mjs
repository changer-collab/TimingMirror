#!/usr/bin/env node
/**
 * TimingMirror 本地静态服务器（零依赖；仅开发用，非产品运行时）
 * 运行：npm run dev  或  node scripts/serve.mjs --port=5180
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { createHandler } from '../server/site-functions/handler.mjs';
import { createTushareMarketTransport } from '../server/site-functions/market.mjs';
import { createLocalFakeImportModel } from './local-fake-import-model.mjs';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 5180);
const FUNCTION_PREFIX = '/functions/v1/app/';

// 本地开发只用 fake 模型跑 import-recover 的真实 handler；不读取模型凭据，不调用真实模型。
// Tushare Token 只从开发机环境变量读取，不写入文件或日志；未配置时行情接口明确返回 E_MARKET_NOT_CONFIGURED。
const tushareToken = (process.env.TUSHARE_TOKEN ?? '').trim();
const appHandler = createHandler({
  transport: createLocalFakeImportModel(),
  marketTransport: tushareToken === '' ? null : createTushareMarketTransport({ token: tushareToken }),
});

function readRequestBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.icc': 'application/vnd.iccprofile',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith(FUNCTION_PREFIX)) {
      let body;
      try {
        body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRequestBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, code: 'E_FUNCTION_BODY_TOO_LARGE', message: '请求体超过大小限制' }));
        return;
      }
      const request = new Request(`http://localhost:${PORT}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body,
      });
      const response = await appHandler(request);
      if (url.pathname.endsWith('/api/llm/import-recover') || url.pathname.endsWith('/api/llm/import-vision')) {
        console.log(`[dev-fake] ${url.pathname.split('/').pop()} ${req.method} → ${response.status}`);
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
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
  console.log('本地 fake 模型已启用：import-recover、import-vision、rule-intent、restate（不调用真实模型；行情仍需 TUSHARE_TOKEN）');
});
