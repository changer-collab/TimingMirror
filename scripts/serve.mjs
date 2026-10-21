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
import { createDashScopeTransport } from '../server/site-functions/dashscope.mjs';
import { createTushareMarketTransport } from '../server/site-functions/market.mjs';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 5180);
const MARKET_PATH = '/functions/v1/app/api/market/snapshot';
const RULE_PATH = '/functions/v1/app/api/llm/rule';
const FUNCTION_PATHS = new Set([MARKET_PATH, RULE_PATH]);

// 凭证只从开发机环境变量读取，不写入文件或日志；未配置时接口明确返回 E_MARKET_NOT_CONFIGURED / E_MODEL_NOT_CONFIGURED。
const tushareToken = (process.env.TUSHARE_TOKEN ?? '').trim();
const dashscopeKey = (process.env.DASHSCOPE_API_KEY ?? '').trim();
const appHandler = createHandler({
  transport: dashscopeKey === '' ? null : createDashScopeTransport({ apiKey: dashscopeKey }),
  marketTransport: tushareToken === '' ? null : createTushareMarketTransport({ token: tushareToken }),
});

function readRequestBody(req, limit = 256 * 1024) {
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
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (FUNCTION_PATHS.has(url.pathname)) {
      let body;
      try {
        body = await readRequestBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, code: 'E_FUNCTION_BODY_TOO_LARGE', message: '请求体超过大小限制' }));
        return;
      }
      const request = new Request(`http://localhost:${PORT}${url.pathname}`, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: req.method === 'POST' ? body : undefined,
      });
      const response = await appHandler(request);
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
});
