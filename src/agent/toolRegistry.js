// M1-C6 · 工具注册表（离线最小实现；接口候选，未冻结——依据 implementation-baseline 附A.1）
// 边界：只登记当前仓库已能确定性调用的引擎能力（src/engine/*、src/demo/*，只调用不修改）；
//       **未接入能力不注册、不可调用**（实时/分钟级行情），在 UNAVAILABLE_CAPABILITIES 中如实说明。
// 每个工具有稳定 version；toResult 把引擎输出投影为统一 ToolResult（facts/records/formulas/…）。
// 纯函数/纯数据；不操作 DOM / localStorage / 网络。
import { normalizeRows } from '../engine/csvNormalize.js';
import { createMarketCache, fromFixtures, fromPullDraft } from '../engine/marketCache.js';
import { computeIndicators } from '../engine/indicators.js';
import { replaceSell, pathRangeOf } from '../engine/counterfactual.js';
import { buildPatternList } from '../engine/behavior.js';
import { parseContract, dayChangePct, matchContract } from '../engine/contractMatch.js';
import { buildVerifyReport } from '../engine/verify.js';
import { buildDragDecomposition } from '../engine/decompose.js';
import { buildProvenanceReport } from '../engine/provenance.js';
import { buildOperationAttribution } from '../engine/operationAttribution.js';
import { buildRuleLedger } from '../engine/ruleLedger.js';
import { buildRuleCandidates, buildBehaviorTags } from '../engine/userProfile.js';
import { contractRuleSet } from '../demo/adapter.js';
import { selectSimilarPattern, similarEvidenceOf } from './similarSelection.js';
import { matchCrossBill, criteriaText } from './crossBillAnswer.js';

// 如实登记“未接入能力”（不可调用；供页面/日志与交接说明引用）
export const UNAVAILABLE_CAPABILITIES = Object.freeze([
  { id: 'market.realtime', note: '实时/分钟级行情：未接入（产品使用 Tushare 最新已收盘日线，服务端获取、非实时）' },
]);

export const TOOL_RESULT_VERSION = 'tool-result-1';

export function toolResult({
  tool, version = 'v1', ok = true,
  facts = [], records = [], formulas = [], assumptions = [], boundaries = [],
  missing = [], coverage = null, source_refs = [],
} = {}) {
  const list = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
  return {
    tool: String(tool ?? ''),
    version: String(version ?? 'v1'),
    result_version: TOOL_RESULT_VERSION,
    ok: ok !== false,
    facts: list(facts),
    records: list(records),
    formulas: list(formulas),
    assumptions: list(assumptions),
    boundaries: list(boundaries),
    missing: list(missing),
    coverage: coverage ?? null,
    source_refs: list(source_refs),
  };
}

const ASSUMPTION_NO_FEES = '未计入费用、税费与分红';
const BOUNDARY_NOT_ADVICE = '事后对照，不评价当时的决定，也不构成投资建议';

function crossBillFacts(match) {
  const counts = match?.counts ?? {};
  return [
    { key: 'bills_total', label: '可比对账单', value: `${counts.bills_total ?? 0} 份` },
    { key: 'bills_matched', label: '匹配账单', value: `${counts.bills_matched ?? 0} 份` },
    ...(Number.isFinite(counts.occurrences)
      ? [{ key: 'occurrences', label: '同类操作', value: `${counts.occurrences} 次` }]
      : []),
    { key: 'bills_excluded', label: '未纳入', value: `${counts.bills_excluded ?? 0} 份` },
    { key: 'criteria', label: '匹配口径', value: criteriaText(match?.criteria ?? {}) },
  ];
}

function crossBillRecords(match) {
  return (Array.isArray(match?.matched) ? match.matched : []).map((row) => ({
    effective_date: row.effective_date ?? null,
    trade_count: row.trade_count ?? 0,
    patterns: row.patterns.map((pattern) => pattern.name),
    occurrences: row.occurrences,
  }));
}

function portfolioFacts(portfolio) {
  const d = portfolio?.display ?? {};
  return [
    { key: 'actualRet', label: '实际收益', value: d.actualRet ?? '—' },
    { key: 'ghostRet', label: '对照收益', value: d.ghostRet ?? '—' },
    { key: 'drag', label: '择时损耗', value: d.drag ?? '—' },
    { key: 'dragMoney', label: '损耗金额', value: d.dragMoney ?? '—' },
  ];
}

const TOOL_DEFS = [
  {
    id: 'market.fromFixtures',
    version: 'market-cache-1',
    status: 'offline_available',
    description: '由 m0 合成夹具（日历 + 日线）构建行情实例（非真实行情）',
    params: { required: ['calendar', 'bars'], optional: [] },
    invoke: ({ calendar, bars }) => createMarketCache(fromFixtures(calendar, bars)),
  },
  {
    id: 'market.fromPullDraft',
    version: 'market-cache-1',
    status: 'offline_available',
    description: '由行情缓存结构（合成夹具或 Tushare 动态响应）构建行情实例；可用性门槛由调用方校验',
    params: { required: ['doc'], optional: [] },
    invoke: ({ doc }) => createMarketCache(fromPullDraft(doc)),
  },
  {
    id: 'csv.normalize',
    version: 'csv-normalize-1',
    status: 'offline_available',
    description: 'CSV 解析结果 → 标准化交易 + warnings/errors/blocked（本地纯函数，不上传）',
    params: { required: ['parsed', 'source_file'], optional: [] },
    invoke: ({ parsed, source_file }) => normalizeRows(parsed, source_file),
  },
  {
    id: 'indicators.compute',
    version: 'indicators-1',
    status: 'offline_available',
    description: '三指标（实际/对照/损耗）＋双路径＋display（需先完成行情阻断判定）',
    params: { required: ['trades', 'closes'], optional: [] },
    invoke: ({ trades, closes }) => computeIndicators({ trades, closes }),
    toResult: ({ output }) => toolResult({
      tool: 'indicators.compute', version: 'indicators-1',
      facts: portfolioFacts(output.portfolio),
      records: Object.entries(output.per_stock ?? {}).map(([symbol, entry]) => ({
        symbol,
        actualRet: entry.display?.actualRet ?? null,
        ghostRet: entry.display?.ghostRet ?? null,
        dragMoney: entry.display?.dragMoney ?? null,
      })),
      formulas: [
        { id: 'CALC_RET_V1', text: '实际收益 = 期末实际价值 ÷ 买入成本 − 1；对照收益 = 一直持有价值 ÷ 买入成本 − 1' },
        { id: 'CALC_DRAG_MONEY_V1', text: '损耗金额 = 一直持有价值 − 期末实际价值' },
      ],
      assumptions: [ASSUMPTION_NO_FEES],
      boundaries: ['按估值日不复权收盘价计算', BOUNDARY_NOT_ADVICE],
      coverage: { scope: 'portfolio', symbols: Object.keys(output.per_stock ?? {}).length },
    }),
  },
  {
    id: 'counterfactual.replaceSell',
    version: 'counterfactual-1',
    status: 'offline_available',
    description: 'S1 单笔卖出替换＋逐日序列（仅单标的；多标的/买入侧抛错）',
    params: { required: ['symbol', 'trades', 'tradeId', 'effectiveDate', 'closeOf', 'tradingDays'], optional: [] },
    invoke: ({ symbol, trades, tradeId, effectiveDate, closeOf, tradingDays }) => replaceSell({ symbol, trades, tradeId, effectiveDate, closeOf, tradingDays }),
    toResult: ({ output }) => toolResult({
      tool: 'counterfactual.replaceSell', version: 'counterfactual-1',
      facts: [
        { key: 'recoveredMoney', label: '差额', value: output.replace?.recoveredMoney ?? null },
        { key: 'recoveredPP', label: '收益率差', value: output.replace?.display?.recoveredPP ?? null },
      ],
      records: [{ ...output.replace?.replaced }],
      formulas: [{ id: 'CALC_CF_REPLACE_SELL_V1', text: '只替换这一笔卖出，其余成交与持仓不变' }],
      assumptions: ['按估值日收盘价重算'],
      boundaries: ['只覆盖卖出侧单笔', BOUNDARY_NOT_ADVICE],
      coverage: { scope: output.scope, series_complete: output.series?.complete === true },
    }),
  },
  {
    id: 'counterfactual.pathRange',
    version: 'counterfactual-1',
    status: 'offline_available',
    description: '单笔卖出的路径区间（持有到不同日期的差额最低/最高落点；非概率预测）',
    params: { required: ['counterfactual'], optional: [] },
    invoke: ({ counterfactual }) => pathRangeOf(counterfactual),
    toResult: ({ output }) => toolResult({
      tool: 'counterfactual.pathRange', version: 'counterfactual-1',
      ok: output !== null,
      facts: output ? [
        { key: 'low', label: '区间低位', value: output.low?.gap ?? null },
        { key: 'high', label: '区间高位', value: output.high?.gap ?? null },
      ] : [],
      boundaries: ['这是路径区间，不是概率预测'],
      missing: output === null ? ['可用交易日不足 2 天'] : [],
      coverage: output ? { points: output.points } : null,
    }),
  },
  {
    id: 'behavior.patternList',
    version: 'behavior-1',
    status: 'offline_available',
    description: '行为模式清单（追高买入 / 卖出后两日内买回 / 买入后三日内卖出 / 交易频率偏高；三态结论＋证据）',
    params: { required: ['trades', 'market'], optional: [] },
    invoke: ({ trades, market }) => buildPatternList({ trades, market }),
    toResult: ({ output }) => toolResult({
      tool: 'behavior.patternList', version: 'behavior-1',
      facts: (output.patterns ?? []).map((p) => ({
        key: p.pattern_id, label: p.name, value: `${p.status} · 命中 ${p.sample_n} 笔 / 已评估 ${p.evaluated_n} 笔`,
      })),
      records: (output.patterns ?? []).map((p) => ({
        pattern_id: p.pattern_id, status: p.status, sample_n: p.sample_n, evaluated_n: p.evaluated_n,
      })),
      boundaries: ['回看窗口与阈值是候选参数，不是普适标准', '不对当时的动机下判断'],
      coverage: { trade_count: output.scope?.trade_count ?? null, pattern_count: output.scope?.pattern_count ?? null },
    }),
  },
  {
    id: 'behavior.similarSameBill',
    version: 'behavior-1',
    status: 'offline_available',
    description: '同一账单内的相似操作匹配（按模式/标的；不做跨账单与行情形态相似度）',
    params: { required: ['trades', 'market'], optional: ['question'] },
    invoke: ({ trades, market, question }) => {
      const data = buildPatternList({ trades, market });
      const selection = selectSimilarPattern({ patterns: data.patterns, question });
      return {
        ...selection,
        patterns: data.patterns,
        scope: data.scope,
        evidence: similarEvidenceOf({ focus: selection.focus, symbol: selection.symbol }),
      };
    },
    toResult: ({ output }) => toolResult({
      tool: 'behavior.similarSameBill', version: 'behavior-1',
      facts: output.focus ? [
        { key: 'pattern', label: '情境', value: output.focus.name },
        { key: 'hits', label: '命中', value: `${output.evidence.length} 次` },
        { key: 'status', label: '判定', value: output.focus.status },
      ] : [],
      records: (output.evidence ?? []).map((e) => ({
        trade_date: e.trade_date ?? null, symbol: e.symbol ?? null, side: e.side ?? null,
      })),
      boundaries: ['只在这份账单内比较；不做跨账单检索，也不比较行情形态', '不是概率预测'],
      missing: output.focus ? [] : ['没有可对照的重复情境'],
      coverage: { scope: 'same_bill', hits: output.evidence?.length ?? 0 },
    }),
  },
  {
    id: 'behavior.operationAttribution',
    version: 'operation-attribution-1',
    status: 'offline_available',
    description: '按行为证据把逐笔差额归到回补/快进快出/其他三类（金额只取自逐笔分解）',
    params: { required: ['decomposition', 'behavior'], optional: [] },
    invoke: ({ decomposition, behavior }) => buildOperationAttribution({ decomposition, behavior }),
    toResult: ({ output }) => toolResult({
      tool: 'behavior.operationAttribution', version: 'operation-attribution-1',
      ok: output?.ok === true,
      facts: output?.ok ? (output.buckets ?? []).map((b) => ({
        key: b.id, label: b.label, value: `${b.display?.money ?? '—'} · ${b.count} 笔`,
      })) : [],
      records: output?.ok ? (output.buckets ?? []).map((b) => ({ bucket: b.id, count: b.count, share: b.share })) : [],
      boundaries: ['按行为证据归类；不是对动机的判断'],
      missing: output?.ok ? [] : [output?.reason ?? '归因不可用'],
      coverage: output?.ok ? { total: output.total?.value ?? null } : null,
    }),
  },
  {
    id: 'decompose.drag',
    version: 'decompose-1',
    status: 'offline_available',
    description: '损耗分解（逐笔可加总；blocked 时不发布）',
    params: { required: ['report', 'trades'], optional: [] },
    invoke: ({ report, trades }) => buildDragDecomposition({ report, trades }),
    toResult: ({ output }) => toolResult({
      tool: 'decompose.drag', version: 'decompose-1',
      ok: output.blocked !== true,
      facts: [
        { key: 'total', label: '逐笔差额合计', value: output.total?.display ?? '—' },
        { key: 'items', label: '卖出笔数', value: `${output.items?.length ?? 0} 笔` },
        ...(output.items ?? []).map((item) => ({
          key: `item:${item.trade_id ?? `${item.trade_date}:${item.symbol}`}`,
          label: `${item.trade_date} · ${item.symbol} 差额`,
          value: item.display?.dragMoney ?? null,
        })),
      ],
      records: (output.items ?? []).map((item) => ({
        trade_date: item.trade_date, symbol: item.symbol, quantity: item.quantity,
        price: item.price, close: item.close, dragMoney: item.dragMoney, share: item.display?.share ?? null,
      })),
      formulas: [{ id: 'CALC_DRAG_MONEY_V1', text: '差额 = 卖出数量 ×（估值日收盘 − 卖出价）' }],
      assumptions: [ASSUMPTION_NO_FEES],
      boundaries: [BOUNDARY_NOT_ADVICE],
      missing: output.blocked === true ? ['逐笔加总或回源校验未通过'] : [],
      coverage: { items: output.items?.length ?? 0 },
      source_refs: (output.items ?? []).map((item) => ({ trade_date: item.trade_date, symbol: item.symbol })),
    }),
  },
  {
    id: 'decompose.tradeRank',
    version: 'decompose-1',
    status: 'offline_available',
    description: '逐笔差额排序（最错/最赚/绝对值最大；只排序不重算金额）',
    params: { required: ['report', 'trades'], optional: ['mode'] },
    invoke: ({ report, trades, mode = 'worst' }) => {
      const decomposition = buildDragDecomposition({ report, trades });
      const items = Array.isArray(decomposition.items) ? decomposition.items : [];
      const top = mode === 'best'
        ? items.reduce((a, b) => (Number(b.dragMoney) < Number(a.dragMoney) ? b : a), items[0] ?? null)
        : mode === 'maxAbs'
          ? items.reduce((a, b) => (Math.abs(Number(b.dragMoney) || 0) > Math.abs(Number(a.dragMoney) || 0) ? b : a), items[0] ?? null)
          : items[0] ?? null;
      return { mode, top, items, total: decomposition.total, blocked: decomposition.blocked === true };
    },
    toResult: ({ output }) => toolResult({
      tool: 'decompose.tradeRank', version: 'decompose-1',
      ok: output.blocked !== true,
      facts: output.top ? [
        { key: 'top', label: '排首位', value: `${output.top.trade_date} · ${output.top.symbol} × ${output.top.quantity}` },
        { key: 'dragMoney', label: '差额', value: output.top.display?.dragMoney ?? null },
        { key: 'total', label: '逐笔差额合计', value: output.total?.display ?? '—' },
      ] : [],
      records: (output.items ?? []).map((item) => ({
        trade_date: item.trade_date, symbol: item.symbol, dragMoney: item.dragMoney,
      })),
      assumptions: [ASSUMPTION_NO_FEES],
      boundaries: [BOUNDARY_NOT_ADVICE],
      missing: output.blocked === true ? ['逐笔分解未通过校验'] : [],
      coverage: { mode: output.mode, items: output.items?.length ?? 0 },
    }),
  },
  {
    id: 'history.crossBillIndex',
    version: 'history-index-1',
    status: 'offline_available',
    description: '本人已保存账单的同类操作聚合（按模式/标的/持有天数桶；只报次数与覆盖）',
    params: { required: ['historyIndex'], optional: ['patterns', 'symbol', 'holding_bucket'] },
    invoke: ({ historyIndex, patterns = null, symbol = null, holding_bucket = null }) => matchCrossBill({
      index: historyIndex, patterns, symbol, holdingBucket: holding_bucket,
    }),
    toResult: ({ output }) => toolResult({
      tool: 'history.crossBillIndex', version: 'history-index-1',
      ok: output?.ok === true,
      facts: output?.ok ? crossBillFacts(output) : [],
      records: crossBillRecords(output),
      boundaries: output?.boundaries ?? [],
      missing: output?.missing ?? [],
      coverage: output?.counts ?? null,
    }),
  },
  {
    id: 'history.similarAcrossBills',
    version: 'history-index-1',
    status: 'offline_available',
    description: '列出同类操作出现在哪些已保存账单（只报日期与次数，不展示金额）',
    params: { required: ['historyIndex'], optional: ['patterns', 'symbol', 'holding_bucket'] },
    invoke: ({ historyIndex, patterns = null, symbol = null, holding_bucket = null }) => matchCrossBill({
      index: historyIndex, patterns, symbol, holdingBucket: holding_bucket,
    }),
    toResult: ({ output }) => toolResult({
      tool: 'history.similarAcrossBills', version: 'history-index-1',
      ok: output?.ok === true,
      facts: output?.ok ? [
        { key: 'bills_matched', label: '出现账单', value: `${output.counts?.bills_matched ?? 0} 份` },
        ...(output.matched ?? []).slice(0, 5).map((row) => ({
          key: `bill:${row.effective_date ?? row.ref}`,
          label: row.effective_date ?? '日期未知',
          value: `${row.occurrences ?? 0} 次`,
        })),
      ] : [],
      records: crossBillRecords(output),
      boundaries: output?.boundaries ?? [],
      missing: output?.missing ?? [],
      coverage: output?.counts ?? null,
    }),
  },
  {
    id: 'contract.parse',
    version: 'contract-1',
    status: 'offline_available',
    description: '契约模板解析（模板＋可编辑字段；自由文本不支持；哈希为占位算法）',
    params: { required: ['template_id', 'fields'], optional: [] },
    invoke: ({ template_id, fields }) => parseContract({ template_id, fields }),
    toResult: ({ output }) => toolResult({
      tool: 'contract.parse', version: 'contract-1',
      ok: output?.supported !== false,
      facts: output?.supported ? [{ key: 'template', label: '规则模板', value: output.template_name ?? output.template_id }] : [],
      missing: output?.supported ? [] : ['该模板暂不支持'],
      boundaries: ['保存与版本由用户确认；不自动生成规则'],
    }),
  },
  {
    id: 'contract.dayChange',
    version: 'contract-1',
    status: 'offline_available',
    description: '历史情境涨跌幅（缓存范围内；缺价/越界不补造）',
    params: { required: ['market', 'symbol', 'requested_date'], optional: [] },
    invoke: ({ market, symbol, requested_date }) => dayChangePct(market, symbol, requested_date),
  },
  {
    id: 'contract.match',
    version: 'contract-1',
    status: 'offline_available',
    description: '契约命中判定（triggered / not_triggered / missing_data 三态）',
    params: { required: ['parsed', 'contract_context'], optional: [] },
    invoke: ({ parsed, contract_context }) => matchContract(parsed, contract_context),
  },
  {
    id: 'rule.current',
    version: 'rule-ledger-1',
    status: 'offline_available',
    description: '当前生效规则（模板＋自定义；只读规则记录）',
    params: { required: ['versions'], optional: [] },
    invoke: ({ versions }) => contractRuleSet(versions),
    toResult: ({ output }) => toolResult({
      tool: 'rule.current', version: 'rule-ledger-1',
      facts: [{ key: 'active_count', label: '生效规则', value: `${output.current?.length ?? 0} 条` }],
      records: (output.executable ?? []).map((r) => ({
        template_id: r.template_id ?? null, template_name: r.template_name ?? null, scope_text: r.scope_text ?? null,
      })),
      boundaries: ['规则只做提醒，不下单、不阻止交易'],
      coverage: { rules: output.current?.length ?? 0, custom: output.customCurrent?.length ?? 0 },
    }),
  },
  {
    id: 'rule.ledger',
    version: 'rule-ledger-1',
    status: 'offline_available',
    description: '守约账本（按当前规则回放账单；三态命中/守约/数据不足）',
    params: { required: ['rules', 'trades'], optional: ['market', 'max_events'] },
    invoke: ({ rules, trades, market = null, max_events = 3 }) => buildRuleLedger({ rules, trades, market, max_events }),
    toResult: ({ output }) => toolResult({
      tool: 'rule.ledger', version: 'rule-ledger-1',
      facts: [
        { key: 'reviewed', label: '复核记录', value: `${output.summary?.reviewed_n ?? 0} 笔` },
        { key: 'triggered', label: '命中', value: `${output.summary?.triggered_n ?? 0} 笔` },
        { key: 'missing', label: '数据不足', value: `${output.summary?.missing_n ?? 0} 笔` },
      ],
      records: (output.events ?? []).map((e) => ({
        at: e.at, template_name: e.template_name, symbol: e.symbol, outcome: e.outcome_label,
      })),
      boundaries: ['历史复盘，不是实时监控；规则只做提醒'],
      coverage: { rules: output.summary?.rules_n ?? 0 },
    }),
  },
  {
    id: 'rule.candidates',
    version: 'candidate-2',
    status: 'offline_available',
    description: '规则候选（来自行为证据；不保存、不改写规则）',
    params: { required: ['behavior'], optional: ['ruleState', 'profile'] },
    invoke: ({ behavior, ruleState = null, profile = null }) => buildRuleCandidates({ behavior, ruleState, profile }),
    toResult: ({ output }) => toolResult({
      tool: 'rule.candidates', version: 'candidate-2',
      facts: (output.candidates ?? []).map((c) => ({
        key: c.candidate_id, label: c.template_name, value: c.status_text,
      })),
      records: (output.candidates ?? []).map((c) => ({
        candidate_id: c.candidate_id, status: c.status, template_id: c.template_id,
      })),
      boundaries: ['候选只做模板预填；保存前由你确认或改写'],
      coverage: { candidates: output.candidates?.length ?? 0 },
    }),
  },
  {
    id: 'profile.signals',
    version: 'profile-1',
    status: 'offline_available',
    description: '画像确定性信号（只由成立模式与处置倾向派生；不生成人格标签）',
    params: { required: [], optional: ['behavior', 'pgr'] },
    invoke: ({ behavior = null, pgr = null }) => buildBehaviorTags({ behavior, pgr }),
    toResult: ({ output }) => toolResult({
      tool: 'profile.signals', version: 'profile-1',
      facts: (output ?? []).map((tag) => ({ key: tag.tag_id, label: tag.label, value: tag.evidence })),
      records: (output ?? []).map((tag) => ({ tag_id: tag.tag_id, kind: tag.kind })),
      boundaries: ['只用本账单可验证的行为；不生成性格、风险偏好等未经实现的标签'],
      coverage: { tags: output?.length ?? 0 },
    }),
  },
  {
    id: 'verify.report',
    version: 'verify-1',
    status: 'offline_available',
    description: '自我复核（独立重算＋双路径＋恒等式；fail 不发布）',
    params: { required: ['report', 'trades', 'closes'], optional: [] },
    invoke: ({ report, trades, closes }) => buildVerifyReport({ report, trades, closes }),
    toResult: ({ output }) => toolResult({
      tool: 'verify.report', version: 'verify-1',
      ok: output.summary?.fail === 0 && output.summary?.identities_fail === 0,
      facts: [
        { key: 'facts', label: '复核数字', value: `${output.summary?.n_facts ?? 0} 条` },
        { key: 'fail', label: '未通过', value: `${output.summary?.fail ?? 0} 条` },
      ],
      boundaries: ['复核未通过的数字不发布'],
      missing: output.summary?.fail ? ['存在未通过复核的数字'] : [],
      coverage: { n_facts: output.summary?.n_facts ?? 0 },
    }),
  },
  {
    id: 'provenance.report',
    version: 'provenance-1',
    status: 'offline_available',
    description: '计算路径四步留痕（formula/inputs/steps；悬空引用阻断）',
    params: { required: ['report', 'trades', 'closes', 'valuation'], optional: [] },
    invoke: ({ report, trades, closes, valuation }) => buildProvenanceReport({ report, trades, closes, valuation }),
    toResult: ({ output }) => toolResult({
      tool: 'provenance.report', version: 'provenance-1',
      facts: [{ key: 'items', label: '可回源数字', value: `${output.items?.length ?? 0} 条` }],
      records: (output.items ?? []).map((item) => ({ fact_id: item.fact_id, scope: item.scope, key: item.key })),
      boundaries: ['数字只来自当前报告；不重新计算'],
      coverage: { items: output.items?.length ?? 0 },
    }),
  },
];

export const TOOL_REGISTRY = new Map(TOOL_DEFS.map((t) => [t.id, t]));

export function getTool(id) {
  return TOOL_REGISTRY.get(id) ?? null;
}

export function listTools() {
  return TOOL_DEFS.map((t) => ({
    id: t.id,
    version: t.version,
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
