// Qoder Sites Edge Function 入口（logical name: app）。
// 浏览器同源调用：/functions/v1/app/api/llm/intent、/api/llm/restate、/api/llm/rule、/api/llm/rule-intent、/api/llm/result-explanation、/api/llm/scenario-judgment、/api/llm/custom-rule-judgment、/api/llm/import-recover、/api/llm/import-vision 与 /api/market/snapshot。
// Secret 由 Sites Settings 注入；未配置 DEEPSEEK_API_KEY 时文本/图片模型 transport 为 null，接口返回 E_MODEL_NOT_CONFIGURED。
// DashScope 适配器保留在 dashscope.mjs 供人工回滚；不会在 DeepSeek 缺失或失败时自动切换。
import { createHandler } from './handler.mjs';
import { createModelTransport } from './provider.mjs';
import { createTushareMarketTransport } from './market.mjs';

const transport = createModelTransport({
  deepseekApiKey: Deno.env.get('DEEPSEEK_API_KEY') ?? '',
  deepseekModel: Deno.env.get('DEEPSEEK_MODEL') ?? '',
});

const tushareToken = Deno.env.get('TUSHARE_TOKEN') ?? '';
const marketTransport = tushareToken.trim() === ''
  ? null
  : createTushareMarketTransport({ token: tushareToken });

Deno.serve(createHandler({ transport, marketTransport }));
