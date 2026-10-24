// Qoder Sites Edge Function 入口（logical name: app）。
// 浏览器同源调用：/functions/v1/app/api/llm/... 与 /api/market/snapshot；账单/画像/规则/历史索引接口为 /api/bills、/api/profile、/api/rules、/api/history/index。
// 文本与视觉 Secret 由 Sites Settings 注入；未配置 DEEPSEEK_API_KEY 时模型 transport 为 null。
// DashScope 适配器保留在 dashscope.mjs 供人工回滚；不会在 DeepSeek 缺失或失败时自动切换。
// 数据库未启用或未注入 SUPABASE_* 时，只有 /api/bills、/api/profile 返回 503，模型接口不受影响。
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { serveSite } from './adapter.mjs';
import { createHandler } from './handler.mjs';
import { createModelTransport } from './provider.mjs';
import { createTushareMarketTransport } from './market.mjs';

const visionTimeoutRaw = Number(Deno.env.get('DEEPSEEK_VISION_TIMEOUT_MS') ?? '');
const visionTimeoutMs = Number.isInteger(visionTimeoutRaw) && visionTimeoutRaw > 0
  ? visionTimeoutRaw
  : undefined;

const transport = createModelTransport({
  deepseekApiKey: Deno.env.get('DEEPSEEK_API_KEY') ?? '',
  deepseekModel: Deno.env.get('DEEPSEEK_MODEL') ?? '',
  visionTimeoutMs,
});

const tushareToken = Deno.env.get('TUSHARE_TOKEN') ?? '';
const marketTransport = tushareToken.trim() === ''
  ? null
  : createTushareMarketTransport({ token: tushareToken });

const appHandler = createHandler({ transport, marketTransport });
const dbHandler = serveSite(
  ({ request, supabase }: { request: Request; supabase: unknown }) => appHandler(request, { supabase }),
  {
    createClient,
    env: (name: string) => Deno.env.get(name),
  },
);
const isDataPath = (url: string) => /\/api\/(?:bills|profile|rules|history)(?:\/|$)/u.test(new URL(url).pathname);

Deno.serve((request) => (isDataPath(request.url) ? dbHandler(request) : appHandler(request)));
