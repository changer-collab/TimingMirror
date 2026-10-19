// Qoder Sites Edge Function 入口（logical name: app）。
// 浏览器同源调用：/functions/v1/app/api/llm/intent 与 /functions/v1/app/api/llm/restate。
// Secret 由 Sites Settings 注入；未配置时 transport 为 null，接口返回 E_MODEL_NOT_CONFIGURED。
import { createHandler } from './handler.mjs';
import { createDashScopeTransport } from './dashscope.mjs';

const apiKey = Deno.env.get('DASHSCOPE_API_KEY') ?? '';
const transport = apiKey.trim() === ''
  ? null
  : createDashScopeTransport({ apiKey, model: 'qwen-plus', region: 'cn-beijing' });

Deno.serve(createHandler({ transport }));
