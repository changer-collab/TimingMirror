// Qoder Sites Edge Function 入口（logical name: app）。
// 浏览器同源调用：/functions/v1/app/api/llm/intent、/api/llm/restate、/api/llm/rule、/api/llm/rule-intent、/api/llm/import-recover、/api/llm/import-vision 与 /api/market/snapshot。
// Secret 由 Sites Settings 注入；未配置时对应 transport 为 null，接口返回 E_MODEL_NOT_CONFIGURED / E_MARKET_NOT_CONFIGURED。
import { createHandler } from './handler.mjs';
import { createDashScopeTransport } from './dashscope.mjs';
import { createTushareMarketTransport } from './market.mjs';

const apiKey = Deno.env.get('DASHSCOPE_API_KEY') ?? '';
const transport = apiKey.trim() === ''
  ? null
  : createDashScopeTransport({ apiKey, model: 'qwen-plus', region: 'cn-beijing' });

const tushareToken = Deno.env.get('TUSHARE_TOKEN') ?? '';
const marketTransport = tushareToken.trim() === ''
  ? null
  : createTushareMarketTransport({ token: tushareToken });

Deno.serve(createHandler({ transport, marketTransport }));
