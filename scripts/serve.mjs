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
import { createModelTransport } from '../server/site-functions/provider.mjs';
import { createTushareMarketTransport } from '../server/site-functions/market.mjs';
import { createLocalFakeImportModel } from './local-fake-import-model.mjs';
import { createDevUserContext, createMemorySupabase } from './dev-memory-supabase.mjs';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 5180);
const FUNCTION_PREFIX = '/functions/v1/app/';

// 凭证只从开发机环境变量读取，不写入文件或日志；未配置时对应接口明确返回 NOT_CONFIGURED。
// 本地未配置 DEEPSEEK_API_KEY 时用 fake 跑导入与助手链路（仅开发验证，线上入口不引用）；配置后直连 DeepSeek。
const tushareToken = (process.env.TUSHARE_TOKEN ?? '').trim();
const deepseekKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const deepseekModel = (process.env.DEEPSEEK_MODEL ?? '').trim();
const usingFakeModel = deepseekKey === '';
// 本地联调专用：账单/画像走内存库，身份头由本进程注入；重启即清空，不能当作线上存储。
const devUserId = (process.env.TM_DEV_USER_ID ?? '').trim() || 'dev-local-user';
const devSupabase = createMemorySupabase();
const devUserContext = createDevUserContext({ userId: devUserId });
const isDataPath = (pathname) => /\/api\/(?:bills|profile|rules|history)(?:\/|$)/u.test(pathname);
const appHandler = createHandler({
  transport: usingFakeModel
    ? createLocalFakeImportModel()
    : createModelTransport({ deepseekApiKey: deepseekKey, deepseekModel }),
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
      const headers = new Headers({ 'content-type': req.headers['content-type'] ?? '' });
      if (isDataPath(url.pathname)) headers.set('x-qoder-user-context', devUserContext);
      const request = new Request(`http://localhost:${PORT}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body,
      });
      const response = await appHandler(request, { supabase: devSupabase });
      if (usingFakeModel && (url.pathname.endsWith('/api/llm/import-recover') || url.pathname.endsWith('/api/llm/import-vision'))) {
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
  console.log(usingFakeModel
    ? '本地 fake 模型已启用：intent、restate、import-recover、import-vision、rule-intent、behavior-analysis、result-explanation、profile-summary、profile-fact（不调用真实模型；行情仍需 TUSHARE_TOKEN）'
    : '已读取开发机 DEEPSEEK_API_KEY，模型请求将调用 DeepSeek');
  if (tushareToken === '') console.log('行情未启用：未配置 TUSHARE_TOKEN');
  console.log(`账单/画像/规则：本地内存库（dev 用户 ${devUserId}，重启清空；线上以 Gateway 身份为准）`);
});
