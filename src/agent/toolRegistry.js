// M1-C6 · 工具注册表（离线最小实现；接口候选，未冻结——依据 implementation-baseline 附A.1）
// 边界：只登记当前仓库已能确定性调用的引擎能力（src/engine/*，只调用不修改）；
//       **未接入能力不注册、不可调用**（百炼在线意图、实时/分钟级行情、部分页面接线），仅在 UNAVAILABLE_CAPABILITIES 中如实说明。
// 纯函数/纯数据；不操作 DOM / localStorage / 网络。
import { normalizeRows } from '../engine/csvNormalize.js';
import { createMarketCache, fromFixtures, fromPullDraft } from '../engine/marketCache.js';
import { computeIndicators } from '../engine/indicators.js';
import { replaceSell } from '../engine/counterfactual.js';
import { buildPatternList } from '../engine/behavior.js';
import { parseContract, dayChangePct, matchContract } from '../engine/contractMatch.js';
import { buildVerifyReport } from '../engine/verify.js';
import { buildDragDecomposition } from '../engine/decompose.js';
import { buildProvenanceReport } from '../engine/provenance.js';

// 如实登记“未接入能力”（不可调用；供页面/日志与交接说明引用）
export const UNAVAILABLE_CAPABILITIES = Object.freeze([
  { id: 'bailian.online_intent', note: '百炼在线意图分类：未接入（M1-C10 / 代理未连通）；离线桩见 offlineIntent.js' },
  { id: 'market.realtime', note: '实时/分钟级行情：未接入（产品使用 Tushare 最新已收盘日线，服务端获取、非实时）' },
  { id: 'page.import_wiring', note: '导入页用户 CSV 闭链：未接入（FileReader/Papa Parse 待定）' },
  { id: 'page.chat_wiring', note: '对话页 planner 消费：未接入（本模块仅产出 plan，不接线页面）' },
]);

const TOOL_DEFS = [
  {
    id: 'market.fromFixtures',
    status: 'offline_available',
    description: '由 m0 合成夹具（日历 + 日线）构建行情实例（非真实行情）',
    params: { required: ['calendar', 'bars'], optional: [] },
    invoke: ({ calendar, bars }) => createMarketCache(fromFixtures(calendar, bars)),
  },
  {
    id: 'market.fromPullDraft',
    status: 'offline_available',
    description: '由行情缓存结构（已签收静态件或 Tushare 动态响应）构建行情实例；可用性门槛由调用方校验',
    params: { required: ['doc'], optional: [] },
    invoke: ({ doc }) => createMarketCache(fromPullDraft(doc)),
  },
  {
    id: 'csv.normalize',
    status: 'offline_available',
    description: 'CSV 解析结果 → 标准化交易 + warnings/errors/blocked（本地纯函数，不上传）',
    params: { required: ['parsed', 'source_file'], optional: [] },
    invoke: ({ parsed, source_file }) => normalizeRows(parsed, source_file),
  },
  {
    id: 'indicators.compute',
    status: 'offline_available',
    description: '三指标（实际/对照/损耗）＋双路径＋display（需先完成行情阻断判定）',
    params: { required: ['trades', 'closes'], optional: [] },
    invoke: ({ trades, closes }) => computeIndicators({ trades, closes }),
  },
  {
    id: 'counterfactual.replaceSell',
    status: 'offline_available',
    description: 'S1 单笔卖出替换＋逐日序列（仅单标的；多标的/买入侧抛错）',
    params: { required: ['symbol', 'trades', 'tradeId', 'effectiveDate', 'closeOf', 'tradingDays'], optional: [] },
    invoke: ({ symbol, trades, tradeId, effectiveDate, closeOf, tradingDays }) => replaceSell({ symbol, trades, tradeId, effectiveDate, closeOf, tradingDays }),
  },
  {
    id: 'behavior.patternList',
    status: 'offline_available',
    description: '行为模式清单（当前仅“追高买入”；三态结论＋证据；参数 candidate-1）',
    params: { required: ['trades', 'market'], optional: [] },
    invoke: ({ trades, market }) => buildPatternList({ trades, market }),
  },
  {
    id: 'contract.parse',
    status: 'offline_available',
    description: '契约模板解析（模板＋可编辑字段；自由文本不支持；哈希为占位算法）',
    params: { required: ['template_id', 'fields'], optional: [] },
    invoke: ({ template_id, fields }) => parseContract({ template_id, fields }),
  },
  {
    id: 'contract.dayChange',
    status: 'offline_available',
    description: '历史情境涨跌幅（缓存范围内；缺价/越界不补造）',
    params: { required: ['market', 'symbol', 'requested_date'], optional: [] },
    invoke: ({ market, symbol, requested_date }) => dayChangePct(market, symbol, requested_date),
  },
  {
    id: 'contract.match',
    status: 'offline_available',
    description: '契约命中判定（triggered / not_triggered / missing_data 三态）',
    params: { required: ['parsed', 'contract_context'], optional: [] },
    invoke: ({ parsed, contract_context }) => matchContract(parsed, contract_context),
  },
  {
    id: 'verify.report',
    status: 'offline_available',
    description: '自我复核（独立重算＋双路径＋恒等式；fail 不发布）',
    params: { required: ['report', 'trades', 'closes'], optional: [] },
    invoke: ({ report, trades, closes }) => buildVerifyReport({ report, trades, closes }),
  },
  {
    id: 'decompose.drag',
    status: 'offline_available',
    description: '损耗分解（逐笔可加总；blocked 时不发布）',
    params: { required: ['report', 'trades'], optional: [] },
    invoke: ({ report, trades }) => buildDragDecomposition({ report, trades }),
  },
  {
    id: 'provenance.report',
    status: 'offline_available',
    description: '计算路径四步留痕（formula/inputs/steps；悬空引用阻断）',
    params: { required: ['report', 'trades', 'closes', 'valuation'], optional: [] },
    invoke: ({ report, trades, closes, valuation }) => buildProvenanceReport({ report, trades, closes, valuation }),
  },
];

export const TOOL_REGISTRY = new Map(TOOL_DEFS.map((t) => [t.id, t]));

export function getTool(id) {
  return TOOL_REGISTRY.get(id) ?? null;
}

export function listTools() {
  return TOOL_DEFS.map((t) => ({
    id: t.id,
    status: t.status,
    description: t.description,
    params: { required: [...t.params.required], optional: [...t.params.optional] },
  }));
}

// 参数校验：required 键必须存在且非 null/undefined（函数类型参数如 closeOf/market 仅校验存在）
export function validateToolParams(tool, params) {
  const p = params !== null && typeof params === 'object' ? params : {};
  const missing = tool.params.required.filter((k) => p[k] === undefined || p[k] === null);
  return { ok: missing.length === 0, missing };
}
