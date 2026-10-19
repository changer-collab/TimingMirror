#!/usr/bin/env node
// TimingMirror 本地代理启动入口（仅回环；默认 model transport 禁用）
// 后续真实 transport 接入时，由用户手动在代理进程/函数计算环境设置
// DASHSCOPE_API_KEY，并在启动时通过 createProxyConfig({ apiKey }) 注入。
// 本轮不读取环境变量，也不创建任何密钥文件。
import { createProxyConfig, createProxyServer } from './proxyServer.mjs';

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const port = Number(portArg ? portArg.slice('--port='.length) : 5181);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('fc-proxy 端口非法：请使用 --port=<1-65535>');
  process.exit(1);
}

const config = createProxyConfig({});
const server = createProxyServer({ transport: null, config });
server.on('error', () => {
  console.error('fc-proxy 启动失败');
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`TimingMirror fc-proxy skeleton → http://127.0.0.1:${port}（model transport disabled）`);
});
