// 独立问答页的回答编排：意图 → 最小事实包 → 本地模板/在线复述 → 统一 AnswerEnvelope。
// 事实封闭：数字只来自当前账单已发布报告；在线只复述组合四事实，失败回退本地事实。
// 不操作 DOM；报告加载、在线复述与画像读取均由调用方注入。
import {
  buildBestTradeAnswer,
  buildLocalChipAnswer,
  buildLocalPortfolioAnswer,
  buildSimilarContextAnswer,
  QA_CHIP_CODES,
} from '../../src/agent/qaChips.js';
import { chatFailureText, numberCheckDetail } from '../../src/agent/chatOnline.js';
import { buildRuleLedger } from '../../src/engine/ruleLedger.js';
import { contractRuleSet } from '../../src/demo/adapter.js';
import { fmtMoney, fmtPP } from '../../src/engine/display.js';
import { createOrchestrator, createTrace } from '../../src/agent/orchestrator.js';
import { createIntentPolicy } from '../../src/agent/intentPolicy.js';
import { routeScope } from '../../src/agent/scopeRouter.js';
import { glossaryTermOf } from '../../src/agent/glossary.js';
import { buildPageHelpAnswer } from '../../src/agent/pageHelp.js';
import { runPlan } from '../../src/agent/planner.js';
import { planForTurn } from '../../src/agent/planPolicy.js';
import { assembleContext, contextStillCurrent } from '../../src/agent/contextAssembler.js';
import { buildEvidenceBundle } from '../../src/agent/evidenceBundle.js';
import { buildClaims, composeLocalAnswer, COMPOSED_INTENTS } from '../../src/agent/answerComposer.js';
import { buildPlainDraft } from '../../src/agent/plainLanguage.js';
import { createAnswerRewriter, REWRITE_TIMEOUT_MS } from '../../src/agent/answerRewriter.js';
import { verifyAnswer } from '../../src/agent/answerVerifier.js';
import { establishedPatternsOf } from '../../src/agent/historyIndex.js';
import { localAnswerFromResults } from '../../src/agent/crossBillAnswer.js';
import { getDemoHistoryIndex } from '../../src/demo/demoHistory.js';
import {
  normalizeQuestion,
  classifyLocal,
  QA_INTENT_LABELS,
  QA_LAYER_LABELS,
  QA_SUGGESTIONS,
} from './qaIntent.js';

const UNAVAILABLE_CODES = new Set([
  QA_CHIP_CODES.DECOMPOSITION_UNAVAILABLE,
  QA_CHIP_CODES.DECOMPOSITION_BLOCKED,
  QA_CHIP_CODES.BEHAVIOR_UNAVAILABLE,
]);

const PUBLISHED_INTENTS = new Set([
  'loss_overview', 'worst_trade', 'best_trade', 'pattern_explain', 'profile',
  'how_to_change', 'what_if', 'meta_calc', 'meta_trust', 'similar_context',
]);

const REWRITE_INTENTS = new Set([
  'loss_overview', 'worst_trade', 'best_trade', 'pattern_explain',
  'similar_context', 'cross_bill', 'what_if', 'meta_calc', 'meta_trust',
  'profile', 'how_to_change', 'contract_status',
]);

const TOOL_LABELS = Object.freeze({
  'indicators.compute': '计算组合收益',
  'decompose.drag': '拆解逐笔差额',
  'decompose.tradeRank': '排序逐笔差额',
  'behavior.patternList': '检查行为模式',
  'behavior.similarSameBill': '匹配相似情境',
  'behavior.operationAttribution': '按操作类型归因',
  'counterfactual.replaceSell': '替换一笔卖出重算',
  'counterfactual.pathRange': '查看路径区间',
  'provenance.report': '整理计算路径',
  'verify.report': '独立复核数字',
  'contract.parse': '解析规则模板',
  'rule.current': '读取当前规则',
  'rule.ledger': '回放规则命中',
  'rule.candidates': '生成规则候选',
  'profile.signals': '派生画像信号',
  'history.crossBillIndex': '检索本人历史账单',
  'history.similarAcrossBills': '列出历史账单中的同类操作',
});

const FACT_LABELS = Object.freeze({
  buyCost: '买入成本',
  sellProceeds: '卖出所得',
  actualValue: '期末实际价值',
  ghostValue: '一直持有价值',
  actualRet: '实际收益',
  ghostRet: '一直持有收益',
  dragMoney: '择时差额',
  drag: '择时差',
});

const FACT_FORMULAS = Object.freeze({
  buyCost: '买入成本 = 每笔买入价格 × 数量后加总',
  sellProceeds: '卖出所得 = 每笔卖出价格 × 数量后加总',
  actualValue: '期末实际价值 = 持仓数量 × 估值日收盘价',
  ghostValue: '一直持有价值 = 不动持仓数量 × 估值日收盘价',
  actualRet: '实际收益 = 期末实际价值 ÷ 买入成本 − 1',
  ghostRet: '一直持有收益 = 一直持有价值 ÷ 买入成本 − 1',
  dragMoney: '择时差额 = 一直持有价值 − 期末实际价值',
  drag: '择时差 = 一直持有收益 − 实际收益',
});

const SUGGESTION_ACTIONS = Object.freeze({
  worst: QA_SUGGESTIONS.find((s) => s.id === 'worst_trade'),
  pattern: QA_SUGGESTIONS.find((s) => s.id === 'pattern_explain'),
  change: QA_SUGGESTIONS.find((s) => s.id === 'how_to_change'),
  profile: QA_SUGGESTIONS.find((s) => s.id === 'profile'),
  portfolio: QA_SUGGESTIONS.find((s) => s.id === 'portfolio'),
  whatIf: QA_SUGGESTIONS.find((s) => s.id === 'what_if'),
  metaCalc: QA_SUGGESTIONS.find((s) => s.id === 'meta_calc'),
  contract: QA_SUGGESTIONS.find((s) => s.id === 'contract_status'),
});

function askAction(id, label, question) {
  return { id, label, kind: 'ask', question };
}

function sampleActions(ids = ['worst', 'pattern', 'change']) {
  return ids.map((id) => SUGGESTION_ACTIONS[id]).filter(Boolean)
    .map((item) => askAction(`ask-${item.id}`, item.label, item.question));
}

function reportAction(label = '打开报告 · 证据') {
  return { id: 'open-report', label, kind: 'navigate', href: '#/report' };
}

function rulesAction(label = '去规则工作区') {
  return { id: 'open-rules', label, kind: 'navigate', href: '#/me' };
}

function simulationAction() {
  return { id: 'open-simulation', label: '先看操作复盘', kind: 'simulation' };
}

function intentLabelOf(intent) {
  return QA_INTENT_LABELS[intent] ?? '事实问答';
}

function layerLabelOf(route) {
  return QA_LAYER_LABELS[route?.layer] ?? QA_LAYER_LABELS.L3;
}

function factTone(label, fallback = 'neutral') {
  return /(差额|损耗|代价|少赚|违反|扣发|缺价|降级)/u.test(String(label ?? '')) ? 'loss' : fallback;
}

function signedMoney(value) {
  return `${value < 0 ? '−' : '+'}${fmtMoney(Math.abs(value))}`;
}

function evidenceItem(text) {
  const detail = String(text ?? '').trim();
  if (!detail) return null;
  if (detail.startsWith('公式：')) return { label: '公式', detail: detail.slice(3) };
  if (/第 \d+ 行/u.test(detail)) return { label: '回源', detail };
  return { label: '成交证据', detail };
}

function makeEnvelope({
  status, intent = null, route = null, source = 'local', text = '', facts = [],
  evidence = [], actions = [], trace = {}, candidate = null, notice = null,
  diagnostics = [], bill = null, elapsedMs = 0, savedFacts = [], savedFactTotal = 0,
}) {
  const cleanFacts = facts.filter(Boolean).map((f) => ({
    label: String(f.label ?? ''),
    value: String(f.value ?? ''),
    tone: f.tone === 'loss' || f.tone === 'ok' ? f.tone : 'neutral',
  }));
  const cleanSavedFacts = (Array.isArray(savedFacts) ? savedFacts : []).filter(Boolean).map((f) => ({
    kind: String(f.kind ?? ''),
    label: String(f.label ?? ''),
    value: String(f.value ?? ''),
    evidence: f.evidence ? String(f.evidence) : null,
    source: f.source === 'manual' ? 'manual' : 'chat',
    created_at: f.created_at ? String(f.created_at) : null,
  }));
  const total = Number.isFinite(savedFactTotal) && savedFactTotal > 0
    ? Math.max(cleanSavedFacts.length, Math.round(savedFactTotal))
    : cleanSavedFacts.length;
  return {
    status,
    intent,
    route: {
      layer: route?.layer ?? 'L3',
      confidence: Number.isFinite(route?.confidence) ? route.confidence : null,
    },
    source,
    text: String(text ?? ''),
    facts: cleanFacts,
    evidence: evidence.filter(Boolean),
    actions: actions.filter(Boolean),
    narrative_policy: status === 'local' && REWRITE_INTENTS.has(intent) && cleanFacts.length > 0
      ? 'auto'
      : 'none',
    saved_facts: cleanSavedFacts,
    saved_fact_total: total,
    trace: {
      template_id: trace.template_id ?? null,
      plan_id: trace.plan_id ?? null,
      fact_count: cleanFacts.length,
      saved_fact_count: cleanSavedFacts.length,
      number_check: trace.number_check ?? null,
      elapsed_ms: Math.max(0, Math.round(elapsedMs)),
      intent_code: intent ?? 'clarify',
      layer_label: layerLabelOf(route),
    },
    candidate,
    notice,
    diagnostics: diagnostics.filter(Boolean),
    bill_context_id: bill?.contextId ?? null,
  };
}

function clarifyEnvelope({ route, bill, elapsedMs, notice = null, text = null }) {
  return makeEnvelope({
    status: 'clarify',
    intent: null,
    route,
    source: 'template',
    text: text ?? '我没能把这个问法对应到已实现的事实问题。换一种问法，或从下面的示例开始；这次没有读取账单，也没有用未核对的内容作答。',
    actions: sampleActions(),
    notice: notice ?? route?.notice ?? null,
    trace: { template_id: 'T-clarify' },
    bill,
    elapsedMs,
  });
}

function localFailureEnvelope({ failure, intent, route, bill, elapsedMs, question }) {
  const status = UNAVAILABLE_CODES.has(failure.code) ? 'unavailable' : 'error';
  return makeEnvelope({
    status,
    intent,
    route,
    source: 'local',
    text: failure.message,
    actions: status === 'error'
      ? [reportAction('先去报告页'), askAction('qa-retry', '重试', question)]
      : [reportAction('打开报告 · 证据'), askAction('qa-meta-trust', '这些数可信吗', '这些数可信吗？')],
    notice: status === 'unavailable' ? '这次没有回答，也没有用其他数字代替。' : '报告未就绪或组合结果未发布时，问答页不生成回答。',
    diagnostics: [{ code: failure.code, message: failure.message }],
    bill,
    elapsedMs,
  });
}

function localEnvelope({
  local, intent, route, bill, elapsedMs, actions = [], notice = null, evidence = null,
  claims = null, evidenceBundle = null,
}) {
  const facts = (Array.isArray(local.facts) ? local.facts : []).map((f) => ({
    label: f.label,
    value: f.value,
    tone: factTone(f.label),
  }));
  const mappedEvidence = Array.isArray(evidence)
    ? evidence
    : (Array.isArray(local.evidence) ? local.evidence.map(evidenceItem).filter(Boolean) : []);
  const mergedActions = [...actions];
  if (local.candidate?.status === 'available') {
    mergedActions.unshift({
      id: 'open-candidate',
      label: '打开规则模板（需你确认）',
      kind: 'candidate',
      candidate: local.candidate,
    });
  }
  const envelope = makeEnvelope({
    status: 'local',
    intent,
    route,
    source: 'local',
    text: local.text,
    facts,
    evidence: mappedEvidence,
    actions: mergedActions,
    trace: {
      template_id: local.template_id ?? null,
      plan_id: local.plan_id ?? null,
    },
    candidate: local.candidate ?? null,
    notice: notice ?? local.notice ?? null,
    savedFacts: Array.isArray(local.saved_facts) ? local.saved_facts : [],
    savedFactTotal: local.saved_fact_total ?? 0,
    bill,
    elapsedMs,
  });
  if (Array.isArray(claims)) envelope.claims = claims;
  if (evidenceBundle) envelope.evidence_bundle = evidenceBundle;
  return envelope;
}

function ruleStateFromVersions(versions, ruleState) {
  if (ruleState && typeof ruleState === 'object') return ruleState;
  try {
    const current = contractRuleSet(versions).current;
    return { active_templates: current.map((r) => r.template_id), active_count: current.length, version_count: Array.isArray(versions) ? versions.length : 0 };
  } catch {
    return { active_templates: [], active_count: 0, version_count: Array.isArray(versions) ? versions.length : 0 };
  }
}

function orderedCounterfactuals(bundle) {
  const list = bundle?.insights?.portfolio?.counterfactuals;
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => (
    Math.abs(b.replace?.recoveredMoney ?? 0) - Math.abs(a.replace?.recoveredMoney ?? 0)
  ));
}

function counterfactualQuestion(cf) {
  return `如果 ${cf.trade_date} 那笔卖出没发生会怎样？`;
}

function answerWhatIf({ route, bundle, bill, elapsedMs }) {
  const all = orderedCounterfactuals(bundle);
  if (!all.length) {
    return makeEnvelope({
      status: 'unavailable',
      intent: 'what_if',
      route,
      source: 'local',
      text: '当前账单没有可用的单笔反事实结果（可能需要卖出笔、有效估值日与完整行情）。这次不假设一个不存在的结果。',
      actions: [reportAction(), askAction('qa-worst', '我最错的一笔是哪个', SUGGESTION_ACTIONS.worst.question)],
      notice: '单笔反事实只覆盖卖出侧；买入侧与多笔替换未实现。',
      trace: { template_id: 'T-what-if' },
      bill,
      elapsedMs,
    });
  }
  const { symbol, trade_date: tradeDate } = route.slots ?? {};
  if (!symbol && !tradeDate && route.ambiguousTrade) {
    const choices = all.slice(0, 3).map((cf) => askAction(
      `cf-${cf.trade_id}`,
      `${cf.trade_date} · ${cf.symbol}`,
      counterfactualQuestion(cf),
    ));
    return makeEnvelope({
      status: 'clarify',
      intent: 'what_if',
      route,
      source: 'local',
      text: `“那笔”指哪一笔还不明确。当前账单有 ${all.length} 笔卖出做了反事实对照，先选一笔：`,
      actions: [...choices, reportAction('打开报告 · 沙盒')],
      notice: '只替换你选中的那一笔卖出；不会猜测指代。',
      trace: { template_id: 'T-what-if' },
      bill,
      elapsedMs,
    });
  }
  let matched = all;
  if (symbol) matched = matched.filter((cf) => cf.symbol === symbol);
  if (tradeDate) matched = matched.filter((cf) => cf.trade_date === tradeDate);
  if (!matched.length) {
    const choices = all.slice(0, 3).map((cf) => askAction(
      `cf-${cf.trade_id}`,
      `${cf.trade_date} · ${cf.symbol}`,
      counterfactualQuestion(cf),
    ));
    return makeEnvelope({
      status: 'clarify',
      intent: 'what_if',
      route,
      source: 'local',
      text: `当前账单里没有找到${tradeDate ? ` ${tradeDate} ` : ''}${symbol ? ` ${symbol} ` : ''}对应的卖出反事实。先选一笔已有的：`,
      actions: [...choices, reportAction('打开报告 · 沙盒')],
      notice: '没有匹配到就不生成假设结果。',
      trace: { template_id: 'T-what-if' },
      bill,
      elapsedMs,
    });
  }
  const cf = matched[0];
  const replace = cf.replace ?? {};
  if (!Number.isFinite(replace.recoveredMoney) || !Number.isFinite(replace.recoveredPP)) {
    return makeEnvelope({
      status: 'unavailable',
      intent: 'what_if',
      route,
      source: 'local',
      text: '这笔反事实结果缺少可展示的差额或收益率，未生成回答。',
      actions: [reportAction()],
      trace: { template_id: 'T-what-if' },
      bill,
      elapsedMs,
    });
  }
  const direction = replace.recoveredMoney >= 0 ? '多' : '少';
  const exact = Boolean(symbol || tradeDate) ? '' : '（未指定具体成交，按绝对差额最高的一笔展示）';
  const text = `按当前账单的单笔反事实，${cf.trade_date} 卖出 ${cf.symbol} ${cf.quantity} 股若没有发生${exact}（按估值日收盘价重算，只替换这一笔），对照结果会比实际${direction} ${fmtMoney(Math.abs(replace.recoveredMoney))}，折合 ${fmtPP(replace.recoveredPP)}。这是事后假设，不是建议，也不代表当时应该那样做。`;
  const facts = [
    { label: '成交', value: `${cf.trade_date} · 卖出 ${cf.symbol} × ${cf.quantity}` },
    { label: '差额', value: signedMoney(replace.recoveredMoney), tone: replace.recoveredMoney >= 0 ? 'loss' : 'ok' },
    { label: '收益率差', value: fmtPP(replace.recoveredPP) },
    { label: '估值日', value: bundle.valuation?.effective_date ?? bundle.asOfDate ?? '—' },
  ];
  const evidence = [];
  if (Number.isFinite(replace.cfValue) && Number.isFinite(replace.actualValue)) {
    evidence.push({
      label: '公式',
      detail: `${fmtMoney(replace.cfValue)} − ${fmtMoney(replace.actualValue)} = ${signedMoney(replace.recoveredMoney)}（不含费用、税费与分红；估值日不复权收盘）`,
    });
  }
  evidence.push({ label: '口径', detail: '只替换这一笔卖出；其余成交与持仓不变。' });
  const others = all.filter((item) => item.trade_id !== cf.trade_id).slice(0, 1);
  const actions = [
    ...others.map((item) => askAction(`cf-${item.trade_id}`, `看 ${item.trade_date} 那笔`, counterfactualQuestion(item))),
    reportAction('打开报告 · 沙盒'),
  ];
  return makeEnvelope({
    status: 'local',
    intent: 'what_if',
    route,
    source: 'local',
    text,
    facts,
    evidence,
    actions,
    trace: { template_id: 'T-what-if' },
    notice: '单笔反事实只覆盖卖出侧；买入侧替换与多笔替换未实现。',
    bill,
    elapsedMs,
  });
}

function answerMetaCalc({ route, bundle, bill, elapsedMs }) {
  const review = bundle.review;
  const provenance = review?.provenance ?? bundle.provenance ?? null;
  const items = Array.isArray(provenance?.items) ? provenance.items : [];
  if (!items.length) {
    return makeEnvelope({
      status: 'unavailable',
      intent: 'meta_calc',
      route,
      source: 'local',
      text: '当前报告没有可用的计算路径索引，无法说明这些数字怎么来的。这次不生成解释。',
      actions: [reportAction(), askAction('qa-trust', '这些数可信吗', '这些数可信吗？')],
      trace: { template_id: 'T-meta-calc' },
      bill,
      elapsedMs,
    });
  }
  const published = Array.isArray(review?.published_facts) ? review.published_facts : [];
  const provById = new Map(items.map((item) => [item.fact_id, item]));
  const traceable = published.filter((f) => {
    const item = provById.get(f.fact_id);
    return item && item.blocked !== true;
  });
  const ordered = [...traceable].sort((a, b) => (a.scope === 'portfolio' ? 0 : 1) - (b.scope === 'portfolio' ? 0 : 1));
  const evidence = ordered.slice(0, 4).map((f) => ({
    label: f.symbol
      ? `${f.symbol} · ${FACT_LABELS[f.key] ?? '数字'}`
      : (FACT_LABELS[f.key] ?? '数字'),
    detail: FACT_FORMULAS[f.key]
      ? `公式：${FACT_FORMULAS[f.key]}`
      : '来源：报告页的计算路径',
  }));
  const missing = published.length - traceable.length;
  const text = `这次回答只使用当前报告中已核对并发布的 ${traceable.length} 条数字；没有重新计算。每条数字都能在报告页展开到公式和成交来源。${missing ? `另有 ${missing} 条数字本次未纳入回答。` : ''}`;
  return makeEnvelope({
    status: 'local',
    intent: 'meta_calc',
    route,
    source: 'local',
    text,
    facts: [
      { label: '可用数字', value: `${traceable.length} 条` },
      ...(missing ? [{ label: '未纳入本次回答', value: `${missing} 条`, tone: 'loss' }] : []),
    ],
    evidence,
    actions: [reportAction('查看计算路径'), askAction('qa-trust', '这些数可信吗', '这些数可信吗？')],
    trace: { template_id: 'T-meta-calc' },
    notice: '完整成交行和逐批明细在报告页。',
    bill,
    elapsedMs,
  });
}

function answerMetaTrust({ route, bundle, bill, elapsedMs }) {
  const review = bundle.review;
  const degraded = Array.isArray(review.degraded) ? review.degraded : [];
  const blocked = Array.isArray(review.blocked_facts) ? review.blocked_facts : [];
  const blockedSymbols = Array.isArray(review.blocked_symbols) ? review.blocked_symbols : [];
  const published = review.portfolio_published === true;
  const text = `这份报告的组合结果${published ? '已发布' : '尚未发布'}。${blocked.length ? `有 ${blocked.length} 条数字未纳入回答；` : ''}${degraded.length ? `有 ${degraded.length} 条数据提示；` : ''}${blockedSymbols.length ? `${blockedSymbols.length} 个标的缺价。` : ''}${degraded.length ? '数据提示只说明缺口，已发布的数字仍按原口径展示。' : '当前没有数据提示。'}`;
  const evidence = degraded.slice(0, 4).map((d) => ({
    label: '数据提示',
    detail: String(d.message ?? ''),
  }));
  return makeEnvelope({
    status: 'local',
    intent: 'meta_trust',
    route,
    source: 'local',
    text,
    facts: [
      { label: '组合结果', value: published ? '已发布' : '未发布', tone: published ? 'ok' : 'loss' },
      { label: '未纳入回答', value: `${blocked.length} 条`, tone: blocked.length ? 'loss' : 'ok' },
      { label: '数据提示/缺价', value: `${degraded.length} 条 / ${blockedSymbols.length} 个`, tone: degraded.length || blockedSymbols.length ? 'loss' : 'ok' },
    ],
    evidence,
    actions: [reportAction('打开报告 · 证据')],
    trace: { template_id: 'T-meta-trust' },
    notice: '未纳入回答的数字不会用替代数据补齐；数据提示只说明缺口。',
    bill,
    elapsedMs,
  });
}

function answerContractStatus({ route, versions, bill, bundle, elapsedMs }) {
  let ruleSet;
  try {
    ruleSet = contractRuleSet(versions);
  } catch (e) {
    return makeEnvelope({
      status: 'unavailable',
      intent: 'contract_status',
      route,
      source: 'local',
      text: '规则记录读取失败，无法回放当前规则。这次不推测规则状态。',
      actions: [rulesAction()],
      diagnostics: [{ code: 'E_QA_RULES_UNAVAILABLE', message: String(e && e.message ? e.message : e) }],
      trace: { template_id: 'T-contract-status' },
      bill,
      elapsedMs,
    });
  }
  if (!ruleSet.current.length) {
    return makeEnvelope({
      status: 'local',
      intent: 'contract_status',
      route,
      source: 'local',
      text: '当前没有生效规则，所以还不能回放“守不守得住”。可以在规则工作区登记一条，保存与版本都由你确认；登记后我再用这份账单做操作复盘。',
      facts: [{ label: '生效规则', value: '0 条' }],
      actions: [rulesAction(), simulationAction()],
      trace: { template_id: 'T-contract-status' },
      notice: '规则只做提醒，不下单、不阻止交易。',
      bill,
      elapsedMs,
    });
  }
  let ledger;
  try {
    ledger = buildRuleLedger({
      rules: ruleSet.current,
      trades: Array.isArray(bill?.trades) ? bill.trades : [],
      market: bundle?.market ?? null,
      max_events: 3,
    });
  } catch (e) {
    return makeEnvelope({
      status: 'unavailable',
      intent: 'contract_status',
      route,
      source: 'local',
      text: '守约账本生成失败，这次不展示命中或违反次数。',
      actions: [rulesAction()],
      diagnostics: [{ code: 'E_QA_LEDGER_FAILED', message: String(e && e.message ? e.message : e) }],
      trace: { template_id: 'T-contract-status' },
      bill,
      elapsedMs,
    });
  }
  const s = ledger.summary;
  const text = s.reviewed_n === 0
    ? `当前有 ${s.rules_n} 条生效规则，但这份账单里没有它们范围内的记录可复核。没有命中不代表规则无效。`
    : `按当前生效的 ${s.rules_n} 条规则回放这份账单的 ${s.reviewed_n} 笔记录：命中 ${s.triggered_n} 笔（违反 ${s.violated_n} / 已提醒 ${s.warned_n}），守约 ${s.compliant_n} 笔，数据不足 ${s.missing_n} 笔。这是历史复盘，不是实时监控。`;
  const evidence = ledger.events.map((e) => ({
    label: `${e.at} · ${e.template_name}`,
    detail: `${e.symbol} ${e.side_label} · ${e.outcome_label}${e.message ? ` · ${e.message}` : ''}`,
  }));
  return makeEnvelope({
    status: 'local',
    intent: 'contract_status',
    route,
    source: 'local',
    text,
    facts: [
      { label: '生效规则', value: `${s.rules_n} 条` },
      { label: '复核记录', value: `${s.reviewed_n} 笔` },
      { label: '命中', value: `${s.triggered_n} 笔`, tone: s.triggered_n ? 'loss' : 'neutral' },
      { label: '数据不足', value: `${s.missing_n} 笔`, tone: s.missing_n ? 'loss' : 'ok' },
    ],
    evidence,
    actions: [rulesAction(), simulationAction()],
    trace: { template_id: 'T-contract-status' },
    notice: ledger.notes[0] ?? '规则只做提醒，不下单、不阻止交易。',
    bill,
    elapsedMs,
  });
}

function answerContractSetup({ route, bill, elapsedMs }) {
  return makeEnvelope({
    status: 'registration',
    intent: 'contract_setup',
    route,
    source: 'template',
    text: '我不能替你定止损、止盈或买卖阈值——这是你的决定。你可以在规则工作区选一个模板，登记阈值与适用范围；保存、版本和停用都由你确认。登记后我可以用操作复盘，看看它在这份账单上会触发几次。',
    actions: [rulesAction('去规则工作区'), simulationAction()],
    trace: { template_id: 'T-contract-setup' },
    notice: '不内联保存、不自动生成规则；保存必须由你在规则页确认。',
    bill,
    elapsedMs,
  });
}

function answerOutOfScope({ route, bill, elapsedMs }) {
  return makeEnvelope({
    status: 'refusal',
    intent: 'out_of_scope',
    route,
    source: 'template',
    text: '这个问题越过边界了：我只回答这份账单里已经发生的事实，不荐股、不预测涨跌、不替你决定买卖。可以改问已经发生的事，例如最错的一笔、为什么追高、规则守不守得住。',
    actions: sampleActions(['worst', 'pattern']),
    trace: { template_id: 'T-out-of-scope' },
    notice: '未加载账单、未调用模型、0 条事实。',
    bill,
    elapsedMs,
  });
}

function answerScope({ scope, question, bill, elapsedMs }) {
  const route = { layer: 'L3', confidence: null };
  if (scope.kind === 'refusal') {
    return answerOutOfScope({ route: { layer: 'L1', confidence: 1 }, bill, elapsedMs });
  }
  if (scope.kind === 'product_help') {
    const help = buildPageHelpAnswer();
    return makeEnvelope({
      status: help.status,
      intent: 'product_help',
      route: help.route,
      source: 'template',
      text: help.text,
      actions: help.actions,
      trace: {},
      bill,
      elapsedMs,
    });
  }
  if (scope.kind === 'general_finance') {
    const entry = glossaryTermOf(question);
    if (entry) {
      return makeEnvelope({
        status: 'local',
        intent: 'general_finance',
        route,
        source: 'template',
        text: `${entry.term}：${entry.definition}`,
        actions: [askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question), reportAction()],
        trace: { template_id: 'T-glossary' },
        notice: '只解释术语，没有读取这份账单的数字；未调用模型。',
        bill,
        elapsedMs,
      });
    }
  }
  if (scope.kind === 'small_talk') {
    return makeEnvelope({
      status: 'local',
      intent: 'small_talk',
      route,
      source: 'template',
      text: '我在。你可以问这份账单里已经发生的事，例如最错的一笔、为什么追高、规则守不守得住；我不荐股、不预测涨跌。',
      actions: sampleActions(['worst', 'pattern']),
      trace: { template_id: 'T-small-talk' },
      notice: '未读取账单、未调用模型。',
      bill,
      elapsedMs,
    });
  }
  return makeEnvelope({
    status: 'local',
    intent: 'unrelated',
    route,
    source: 'template',
    text: '这件事超出我的范围：我只用这份账单里已经核对过的事实回答，不做其他任务。可以改问这份账单的表现、最错的一笔或规则守不守得住。',
    actions: sampleActions(['worst', 'pattern']),
    trace: { template_id: 'T-unrelated' },
    notice: '未读取账单、未调用模型。',
    bill,
    elapsedMs,
  });
}

async function answerOnline({ local, question, bundle, bill, route, elapsedMs, askOnline }) {
  if (bill?.demo === true) {
    const localEnv = localEnvelope({
      local,
      intent: 'loss_overview',
      route,
      bill,
      elapsedMs,
      actions: [reportAction(), askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question)],
      notice: '示例账单不参与在线复述；以下为本地已发布事实。',
    });
    return localEnv;
  }
  if (typeof askOnline !== 'function') {
    const localEnv = localEnvelope({
      local,
      intent: 'loss_overview',
      route,
      bill,
      elapsedMs,
      actions: [reportAction()],
      notice: '在线复述接口不可用；以下为本地已发布事实。',
    });
    localEnv.diagnostics.push({ code: QA_CHIP_CODES.ONLINE_UNAVAILABLE, message: 'askOnline 未注入' });
    return localEnv;
  }
  let result;
  try {
    result = await askOnline({ question, review: bundle.review, bundle });
  } catch (e) {
    result = { ok: false, code: QA_CHIP_CODES.ONLINE_FAILED, message: String(e && e.message ? e.message : e) };
  }
  if (!result?.ok) {
    const code = result?.code ?? QA_CHIP_CODES.ONLINE_FAILED;
    const localEnv = localEnvelope({
      local,
      intent: 'loss_overview',
      route,
      bill,
      elapsedMs,
      actions: [reportAction(), askAction('qa-meta-trust', '这些数可信吗', '这些数可信吗？')],
      notice: `在线复述未完成，已改为本地已发布事实：${chatFailureText(code)}。`,
    });
    localEnv.diagnostics.push({ code, message: chatFailureText(code) });
    if (result?.number_check) localEnv.trace.number_check = numberCheckDetail(result.number_check);
    return localEnv;
  }
  const localFacts = (Array.isArray(local.facts) ? local.facts : []).map((f) => ({
    label: f.label,
    value: f.value,
    tone: factTone(f.label),
  }));
  const check = result.number_check ?? null;
  return makeEnvelope({
    status: 'online',
    intent: 'loss_overview',
    route,
    source: 'online',
    text: result.text,
    facts: localFacts,
    evidence: check ? [{ label: '数字校验', detail: numberCheckDetail(check) }] : [],
    actions: [reportAction(), askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question)],
    trace: {
      template_id: local.template_id ?? 'T-loss-overview',
      plan_id: local.plan_id ?? null,
      number_check: check ? numberCheckDetail(check) : null,
    },
    notice: '在线只复述已发布四事实；文本里的数字已在本机再校验。',
    bill,
    elapsedMs,
  });
}

export function createQaAnswerService({
  getBundle = () => null,
  loadBundle = null,
  askOnline = null,
  askRewrite = null,
  rewriteTimeoutMs = REWRITE_TIMEOUT_MS,
  getSavedFacts = null,
  loadSavedFacts = null,
  loadProfile = () => null,
  loadHistoryIndex = null,
  classifyIntent = null,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');
  const intentPolicy = createIntentPolicy({ classifyLocal, classifyIntent, now });
  const rewriter = createAnswerRewriter({
    transport: typeof askRewrite === 'function' ? { rewrite: askRewrite } : null,
    timeoutMs: rewriteTimeoutMs,
    now,
  });

  async function bundleOf(bill) {
    const cached = typeof getBundle === 'function' ? getBundle(bill) : null;
    if (cached) return cached;
    if (typeof loadBundle !== 'function') return null;
    return loadBundle(bill);
  }

  function composedLocalAnswer({ intent, bundle, bill, question, ruleState, versions }) {
    if (intent === 'similar_context') return buildSimilarContextAnswer({ bundle, bill, question });
    if (intent === 'best_trade') return buildBestTradeAnswer({ bundle, bill, question });
    if (intent === 'loss_overview') return buildLocalPortfolioAnswer({ bundle, bill });
    return buildLocalChipAnswer({
      chip: intent,
      bundle,
      bill,
      ruleState: ruleStateFromVersions(versions, ruleState),
      question,
    });
  }

  function composedActions(intent) {
    if (intent === 'similar_context') {
      return [
        reportAction(),
        askAction('qa-pattern', '为什么说我追高', SUGGESTION_ACTIONS.pattern.question),
        askAction('qa-what-if', '如果那笔卖出没发生', SUGGESTION_ACTIONS.whatIf.question),
      ];
    }
    return [reportAction(), askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question)];
  }

  // 计划 → 工具 → 证据 → 本地草稿 + claims。任一步不可用就回退原有本地分支。
  async function answerComposed({
    intent, local = null, question, bill, bundle, route, ruleState, versions,
    actions, preferOnline, askOnline, trace, elapsed, now,
    extras = {}, localFromResults = null,
  }) {
    const assembled = assembleContext({
      bill, bundle, versions, ruleState, question, extras,
    });
    const plan = planForTurn({
    question,
    intent,
    slots: route?.slots ?? {},
    scope: { kind: 'bill' },
    context: assembled.toolContext,
    availability: intent === 'cross_bill' ? null : { published: assembled.gate.published },
  });
  if (plan.status !== 'ready') {
    trace.push('degraded', 'done', '计算步骤不可用，沿用报告已发布事实');
    return null;
  }

  const run = runPlan({ plan, now });
  const byStep = new Map(run.results.map((result) => [result.step_id, result]));
  for (const step of plan.steps) {
    const result = byStep.get(step.id);
    const label = TOOL_LABELS[step.tool] ?? '执行计算';
    if (result) {
      trace.push('tool', 'done', label, { tool: step.tool, detail: step.reason, ms: result.ms });
    } else {
      trace.push('tool', 'failed', label, { tool: step.tool, detail: '本次跳过' });
    }
  }
  if (run.degraded.length > 0) {
    trace.push('degraded', 'done', '部分计算步骤降级，沿用已发布事实');
  }

  const evidence = buildEvidenceBundle({ results: run.results, assembled });
  trace.push('evidence', 'done', '整理证据', {
    detail: `${evidence.facts.length} 条事实 · ${evidence.formulas.length} 条公式`,
  });

  if (!contextStillCurrent(bill, assembled)) {
    trace.push('degraded', 'done', '账单已变化，本次结果作废');
    return null;
  }

  const answerLocal = localFromResults
    ? localFromResults({ results: run.results, evidence, assembled })
    : local;
  if (!answerLocal || answerLocal.ok === false) {
    trace.push('degraded', 'done', '本次计算结果不可用，不生成结论');
    return null;
  }
  answerLocal.plan_id = plan.plan_id;
  answerLocal.template_id = plan.template_id;

  if (intent === 'loss_overview' && preferOnline) {
    const online = await answerOnline({ local: answerLocal, question, bundle, bill, route, elapsedMs: elapsed(), askOnline });
    online.claims = buildClaims({ text: online.text, facts: online.facts, evidence });
    online.evidence_bundle = evidence;
    return online;
  }

  const composed = composeLocalAnswer({ intent, local: answerLocal, evidence, gate: assembled.gate });
  return localEnvelope({
    local: answerLocal,
    intent,
    route,
    bill,
    elapsedMs: elapsed(),
    actions,
    claims: composed.claims,
    evidenceBundle: evidence,
  });
}

// 反事实槽位 → 工具参数；指代不唯一时不猜，交给澄清分支。
function whatIfExtras({ bill, bundle, route }) {
  const list = bundle?.insights?.portfolio?.counterfactuals;
  if (!Array.isArray(list) || !list.length) return {};
  const slots = route?.slots ?? {};
  let pick = null;
  if (slots.trade_date) {
    pick = list.find((item) => item.trade_date === slots.trade_date) ?? null;
  } else if (slots.symbol) {
    const matches = list.filter((item) => item.symbol === slots.symbol);
    if (matches.length === 1) pick = matches[0];
  } else if (list.length === 1) {
    pick = list[0];
  }
  if (!pick) return {};
  const market = bundle?.market;
  return {
    symbol: pick.symbol,
    trades: (Array.isArray(bill?.trades) ? bill.trades : []).filter((item) => item.symbol === pick.symbol),
    tradeId: pick.trade_id,
    effectiveDate: bundle?.valuation?.effective_date ?? null,
    closeOf: typeof market?.getClose === 'function' ? (date) => market.getClose(pick.symbol, date) : null,
    tradingDays: Array.isArray(market?.tradingDays) ? market.tradingDays : null,
  };
}

// 已生成好的本地信封（clarify/unavailable 之外）再走计划与证据，补上工具轨迹与 claim。
async function composeBuiltEnvelope({
  built, intent, question, bill, bundle, route, ruleState, versions,
  preferOnline, askOnline, trace, elapsed, now, extras = {},
}) {
  if (!built || built.status !== 'local') return built;
  const local = {
    ok: true,
    text: built.text,
    facts: built.facts,
    evidence: built.evidence,
    notice: built.notice,
    template_id: built.trace?.template_id ?? null,
  };
  const composed = await answerComposed({
    intent,
    local,
    question,
    bill,
    bundle,
    route,
    ruleState,
    versions,
    actions: built.actions,
    preferOnline,
    askOnline,
    trace,
    elapsed,
    now,
    extras,
  });
  if (!composed) return built;
  // 这些意图的证据已是用户可读文案，不再走成交级映射。
  composed.evidence = Array.isArray(built.evidence) ? built.evidence : [];
  return composed;
}

async function answerLegacy({ question, bill, ruleState, versions, preferOnline, route, trace, elapsed, now, askOnline }) {
    const intent = route?.intent ?? null;
    if (!intent) {
      trace.push('degraded', 'done', '没有匹配到已实现的事实问题');
      return clarifyEnvelope({ route, bill, elapsedMs: elapsed() });
    }
    if (intent === 'out_of_scope') return answerOutOfScope({ route, bill, elapsedMs: elapsed() });
    if (intent === 'contract_setup') return answerContractSetup({ route, bill, elapsedMs: elapsed() });

    let bundle = null;
    if (intent !== 'contract_status') {
      trace.push('context', 'running', '读取已发布报告');
      try {
        bundle = await bundleOf(bill);
      } catch (e) {
        trace.push('context', 'failed', '报告读取失败');
        return makeEnvelope({
          status: 'error',
          intent,
          route,
          source: 'local',
          text: `报告读取失败，本次不回答：${String(e && e.message ? e.message : e).slice(0, 180)}`,
          actions: [reportAction('先去报告页'), askAction('qa-retry', '重试', question)],
          diagnostics: [{ code: 'E_QA_BUNDLE_LOAD_FAILED', message: String(e && e.message ? e.message : e) }],
          trace: { template_id: null },
          bill,
          elapsedMs: elapsed(),
        });
      }
      if (!bundle) {
        trace.push('context', 'failed', '报告尚未载入');
        return makeEnvelope({
          status: 'error',
          intent,
          route,
          source: 'local',
          text: '当前账单的已发布报告还没有载入，问答页不会为此重复请求行情。请先打开报告页，或重试。',
          actions: [reportAction('先去报告页'), askAction('qa-retry', '重试', question)],
          diagnostics: [{ code: 'E_QA_BUNDLE_UNAVAILABLE', message: '报告 bundle 未载入' }],
          trace: { template_id: null },
          bill,
          elapsedMs: elapsed(),
        });
      }
      trace.push('context', 'done', '已读取已发布报告');
      if (PUBLISHED_INTENTS.has(intent)
        && (bundle.status === 'blocked' || bundle.review?.portfolio_published !== true)) {
        trace.push('degraded', 'done', '组合结果未发布，本次不回答');
        return makeEnvelope({
          status: 'error',
          intent,
          route,
          source: 'local',
          text: '当前账单的组合结果未发布（可能缺价、复核未通过或行情阻断）。这次不回答，也不用其他数字代替。',
          actions: [reportAction('打开报告 · 查看原因'), askAction('qa-retry', '重试', question)],
          diagnostics: [{
            code: 'E_QA_REPORT_WITHHELD',
            message: bundle.review?.blocked_symbols?.map((b) => b.symbol).join('、') || '组合结果未发布',
          }],
          trace: { template_id: null },
          bill,
          elapsedMs: elapsed(),
        });
      }
    }

    const failLocal = (local) => {
      trace.push('degraded', 'done', '数据不足，本次不发布数字');
      return localFailureEnvelope({ failure: local, intent, route, bill, elapsedMs: elapsed(), question });
    };

    if (intent === 'cross_bill') {
      const unavailable = () => makeEnvelope({
        status: 'unavailable',
        intent: 'cross_bill',
        route,
        source: 'local',
        text: '这次读不到你自己保存的账单索引（可能未登录或云端暂不可用），所以不做跨账单比较，也不把单账单结果说成跨账单结论。',
        actions: [
          askAction('qa-similar', '先看这份账单里的类似情况', '这份账单里有没有类似的情况？'),
          reportAction(),
        ],
        notice: '没有读取其他账单、没有调用模型、0 条跨账单事实。',
        trace: { template_id: 'T-cross-bill' },
        bill,
        elapsedMs: elapsed(),
      });

      trace.push('context', 'running', '读取本人已保存账单');
      let historyIndex = null;
      try {
        historyIndex = typeof loadHistoryIndex === 'function' ? await loadHistoryIndex({ bill }) : null;
      } catch {
        historyIndex = null;
      }
      if (!historyIndex && bill?.demo === true) historyIndex = getDemoHistoryIndex();
      if (!historyIndex) {
        trace.push('context', 'failed', '历史账单索引不可用');
        return unavailable();
      }
      trace.push('context', 'done', '已读取历史账单索引', {
        detail: `${historyIndex.coverage?.bills_included ?? 0} 份可比对`,
      });

      const crossBill = await answerComposed({
        intent,
        local: null,
        question,
        bill,
        bundle,
        route,
        ruleState,
        versions,
        actions: [
          askAction('qa-similar', '先看这份账单里的类似情况', '这份账单里有没有类似的情况？'),
          reportAction(),
        ],
        preferOnline: false,
        askOnline,
        trace,
        elapsed,
        now,
        extras: {
          historyIndex,
          patterns: establishedPatternsOf(bundle?.insights?.behavior?.data?.patterns ?? []),
          symbol: route?.slots?.symbol ?? null,
        },
        localFromResults: ({ results }) => localAnswerFromResults({ results, question }),
      });
      if (crossBill) return crossBill;
      return unavailable();
    }

    if (COMPOSED_INTENTS.includes(intent)) {
      const local = composedLocalAnswer({ intent, bundle, bill, question, ruleState, versions });
      if (!local.ok) return failLocal(local);
      const composed = await answerComposed({
        intent,
        local,
        question,
        bill,
        bundle,
        route,
        ruleState,
        versions,
        actions: composedActions(intent),
        preferOnline,
        askOnline,
        trace,
        elapsed,
        now,
      });
      if (composed) return composed;
    }

    if (intent === 'contract_status') {
      return answerContractStatus({ route, versions, bill, bundle: typeof getBundle === 'function' ? getBundle(bill) : null, elapsedMs: elapsed() });
    }

    if (intent === 'what_if') {
      return composeBuiltEnvelope({
        built: answerWhatIf({ route, bundle, bill, elapsedMs: elapsed() }),
        intent, question, bill, bundle, route, ruleState, versions, preferOnline, askOnline, trace, elapsed, now,
        extras: whatIfExtras({ bill, bundle, route }),
      });
    }
    if (intent === 'meta_calc') {
      return composeBuiltEnvelope({
        built: answerMetaCalc({ route, bundle, bill, elapsedMs: elapsed() }),
        intent, question, bill, bundle, route, ruleState, versions, preferOnline, askOnline, trace, elapsed, now,
      });
    }
    if (intent === 'meta_trust') {
      return composeBuiltEnvelope({
        built: answerMetaTrust({ route, bundle, bill, elapsedMs: elapsed() }),
        intent, question, bill, bundle, route, ruleState, versions, preferOnline, askOnline, trace, elapsed, now,
      });
    }
    const chip = intent;
    if (!['worst_trade', 'pattern_explain', 'profile', 'how_to_change'].includes(chip)) {
      trace.push('degraded', 'done', '没有匹配到已实现的事实问题');
      return clarifyEnvelope({ route, bill, elapsedMs: elapsed() });
    }
    let profile = null;
    if (chip === 'how_to_change' && typeof loadProfile === 'function') {
      try { profile = loadProfile(); } catch { profile = null; }
    }
    let savedFacts = [];
    let savedFactsUnavailable = false;
    if ((chip === 'profile' || chip === 'how_to_change')
      && bill?.status === 'confirmed' && bill?.sourceType === 'local' && bill?.demo !== true) {
      try {
        let loaded = typeof getSavedFacts === 'function' ? getSavedFacts() : null;
        if ((!loaded || (Array.isArray(loaded) && loaded.length === 0)) && typeof loadSavedFacts === 'function') {
          loaded = await loadSavedFacts();
        }
        savedFacts = Array.isArray(loaded?.facts) ? loaded.facts : (Array.isArray(loaded) ? loaded : []);
      } catch {
        savedFacts = [];
        savedFactsUnavailable = true;
      }
    }
    const local = buildLocalChipAnswer({
      chip,
      bundle,
      bill,
      ruleState: ruleStateFromVersions(versions, ruleState),
      profile,
      question,
      savedFacts,
    });
    if (!local.ok) return failLocal(local);
    const actions = chip === 'how_to_change'
      ? [rulesAction(), reportAction('打开报告 · 证据')]
      : [reportAction(), askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question)];
    const notice = savedFactsUnavailable
      ? `${local.notice ? `${local.notice} ` : ''}云端画像暂不可用，本次只列本账单行为。`
      : null;
    const composed = await answerComposed({
      intent: chip,
      local,
      question,
      bill,
      bundle,
      route,
      ruleState,
      versions,
      actions,
      preferOnline,
      askOnline,
      trace,
      elapsed,
      now,
    });
    if (composed) {
      if (notice) composed.notice = notice;
      return composed;
    }
    return localEnvelope({ local, intent, route, bill, elapsedMs: elapsed(), actions, notice });
  }

  function rewriteEligible(answer) {
    return Boolean(answer)
      && answer.status === 'local'
      && answer.source !== 'online'
      && REWRITE_INTENTS.has(answer.intent)
      && Array.isArray(answer.facts)
      && answer.facts.length > 0;
  }

  function rewriteDraftOf(answer, bill) {
    return buildPlainDraft({
      intent: answer.intent,
      text: answer.text,
      facts: answer.facts,
      boundaries: answer.evidence_bundle?.boundaries ?? [],
      demo: bill?.demo === true,
    });
  }

  function rewriteClaimsOf(answer) {
    if (Array.isArray(answer.claims) && answer.claims.length > 0) return answer.claims.slice(0, 12);
    return buildClaims({
      text: answer.text,
      facts: answer.facts,
      evidence: answer.evidence_bundle ?? null,
    }).slice(0, 12);
  }

  async function autoRewrite({ answer, question, bill, trace }) {
    if (!rewriteEligible(answer)) {
      if (answer) answer.narrative_policy = 'none';
      return answer;
    }
    const draft = rewriteDraftOf(answer, bill);
    const claims = rewriteClaimsOf(answer);
    if (!Array.isArray(answer.claims) || answer.claims.length === 0) answer.claims = claims;
    trace.push('rewrite', 'running', 'AI 转成白话');
    const result = await rewriter.rewrite({
      question,
      intent: answer.intent,
      scope: { kind: 'bill', synthetic: bill?.demo === true },
      draft,
      claims,
      facts: answer.facts,
      evidence: answer.evidence,
      userKey: bill?.contextId ?? '',
    });
    answer.rewrite = result.rewrite;
    answer.rewrite_meta = result.meta;
    answer.narrative_policy = 'auto';
    trace.push('rewrite', result.ok ? 'done' : 'skipped', 'AI 转成白话', {
      detail: result.ok
        ? (result.meta.cached ? '使用缓存表述' : '已绑定 claim')
        : '本次改用本地表述',
    });
    return answer;
  }

  async function ask({
    question = '', bill = null, ruleState = null, versions = [],
    preferOnline = false, source = 'typed', onStage = null,
    reuseIntent = null, reuseRoute = null,
  } = {}) {
    const started = now();
    const elapsed = () => now() - started;
    const normalized = normalizeQuestion(question);
    if (!normalized) {
      const trace = createTrace({ now, onStage });
      trace.push('degraded', 'done', '问题为空，未发送');
      const envelope = makeEnvelope({
        status: 'error',
        text: '问题为空：没有发送任何内容。',
        actions: sampleActions(),
        diagnostics: [{ code: 'E_QA_EMPTY', message: '问题为空' }],
        bill,
        elapsedMs: elapsed(),
      });
      return { trace: trace.events(), envelope };
    }

    // 在线复述等后续动作沿用当前回答的意图，避免为同一个问题再次请求意图模型。
    const reusePolicy = reuseIntent
      ? Object.freeze({
        decide: async () => ({
          ok: true,
          intent: reuseIntent,
          slots: {},
          confidence: Number.isFinite(reuseRoute?.confidence) ? reuseRoute.confidence : null,
          source: 'typed',
          decided_by: 'reuse',
          model_called: false,
          local_check: 'reuse',
          model_intent: null,
          latency_ms: 0,
          ambiguous: false,
          route: {
            intent: reuseIntent,
            slots: {},
            layer: reuseRoute?.layer ?? 'L1',
            source: reuseRoute?.layer ?? 'L1',
            confidence: Number.isFinite(reuseRoute?.confidence) ? reuseRoute.confidence : null,
            matchedBy: 'reuse',
          },
        }),
      })
      : null;

    const orchestrator = createOrchestrator({
      routeScope,
      intentPolicy: reusePolicy ?? intentPolicy,
      answer: async ({ question: current, bill: currentBill, scope, decision, trace }) => {
        try {
          const envelope = scope.kind !== 'bill'
            ? answerScope({ scope, question: current, bill: currentBill, elapsedMs: elapsed() })
            : await answerLegacy({
              question: current,
              bill: currentBill,
              ruleState,
              versions,
              preferOnline,
              route: decision?.route ?? null,
              trace,
              elapsed,
              now,
              askOnline,
            });
          return await autoRewrite({ answer: envelope, question: current, bill: currentBill, trace });
        } catch (e) {
          return makeEnvelope({
            status: 'error',
            intent: decision?.intent ?? null,
            route: decision?.route ?? null,
            source: 'local',
            text: '问答链路出现未预期错误，本次没有回答。可以重试；数字与结论都不改变。',
            actions: [reportAction('先去报告页'), askAction('qa-retry', '重试', current)],
            diagnostics: [{ code: 'E_QA_UNEXPECTED', message: String(e && e.message ? e.message : e).slice(0, 180) }],
            bill: currentBill,
            elapsedMs: elapsed(),
          });
        }
      },
      verify: ({ envelope, scope: currentScope, bill: currentBill }) => verifyAnswer({
        envelope, scope: currentScope, bill: currentBill,
      }),
      now,
    });

    return orchestrator.runTurn({ question: normalized, bill, source, onStage });
  }

  async function rewrite({ question = '', answer = null, bill = null, force = false } = {}) {
    if (!rewriteEligible(answer)) {
      return { ok: false, code: 'E_QA_REWRITE_NOT_ALLOWED', message: '这条回答不提供白话改写。' };
    }
    if (answer.bill_context_id && bill?.contextId && answer.bill_context_id !== bill.contextId) {
      return { ok: false, code: 'E_QA_REWRITE_STALE', message: '账单已变化，请重新提问后再改写。' };
    }
    if (typeof askRewrite !== 'function') {
      return { ok: false, code: 'E_QA_REWRITE_UNAVAILABLE', message: '白话改写接口不可用。' };
    }
    try {
      const claims = Array.isArray(answer.claims) && answer.claims.length > 0
        ? answer.claims
        : rewriteClaimsOf(answer);
      const result = await rewriter.rewrite({
        question,
        intent: answer.intent,
        scope: { kind: 'bill', synthetic: bill?.demo === true },
        draft: rewriteDraftOf(answer, bill),
        claims,
        facts: answer.facts,
        evidence: answer.evidence,
        userKey: bill?.contextId ?? '',
        force: force === true,
      });
      const verified = verifyAnswer({
        envelope: {
          ...answer, claims, rewrite: result.rewrite, rewrite_meta: result.meta,
        },
        scope: { kind: 'bill', synthetic: bill?.demo === true },
        bill,
      });
      if (!verified.ok) {
        return { ok: false, code: 'E_QA_REWRITE_WITHHELD', message: '这次改写没有通过数字复核，已保留原表述。' };
      }
      return { ...result, rewrite_meta: result.meta };
    } catch {
      return { ok: false, code: 'E_QA_REWRITE_UNAVAILABLE', message: '在线改写服务暂时不可用。' };
    }
  }

  return Object.freeze({ ask, rewrite });
}
