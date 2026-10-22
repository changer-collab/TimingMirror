// 独立问答页的回答编排：意图 → 最小事实包 → 本地模板/在线复述 → 统一 AnswerEnvelope。
// 事实封闭：数字只来自当前账单已发布报告；在线只复述组合四事实，失败回退本地事实。
// 不操作 DOM；报告加载、在线复述与画像读取均由调用方注入。
import {
  buildLocalChipAnswer,
  buildLocalPortfolioAnswer,
  QA_CHIP_CODES,
} from '../../src/agent/qaChips.js';
import { chatFailureText, numberCheckDetail } from '../../src/agent/chatOnline.js';
import { buildRuleLedger } from '../../src/engine/ruleLedger.js';
import { contractRuleSet } from '../../src/demo/adapter.js';
import { fmtMoney, fmtPP } from '../../src/engine/display.js';
import {
  normalizeQuestion,
  createIntentRouter,
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
  'loss_overview', 'worst_trade', 'pattern_explain', 'profile',
  'how_to_change', 'what_if', 'meta_calc', 'meta_trust',
]);

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
  return { id: 'open-simulation', label: '先看历史情境', kind: 'simulation' };
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
  diagnostics = [], bill = null, elapsedMs = 0,
}) {
  const cleanFacts = facts.filter(Boolean).map((f) => ({
    label: String(f.label ?? ''),
    value: String(f.value ?? ''),
    tone: f.tone === 'loss' || f.tone === 'ok' ? f.tone : 'neutral',
  }));
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
    trace: {
      template_id: trace.template_id ?? null,
      plan_id: trace.plan_id ?? null,
      fact_count: cleanFacts.length,
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

function localEnvelope({ local, intent, route, bill, elapsedMs, actions = [], notice = null, evidence = null }) {
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
  return makeEnvelope({
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
    bill,
    elapsedMs,
  });
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
  const formulaIds = new Set(traceable.map((f) => f.formula_id ?? provById.get(f.fact_id)?.formula_id).filter(Boolean));
  const attempts = Number.isFinite(review?.meta?.recompute_attempts) ? review.meta.recompute_attempts : 0;
  const statusText = { published: '已发布', degraded: '降级发布', blocked: '未发布' }[review?.status] ?? String(review?.status ?? '未知');
  const ordered = [...traceable].sort((a, b) => (a.scope === 'portfolio' ? 0 : 1) - (b.scope === 'portfolio' ? 0 : 1));
  const evidence = ordered.slice(0, 4).map((f) => {
    const item = provById.get(f.fact_id);
    const refs = Array.isArray(item?.source_refs) ? item.source_refs.length : 0;
    return {
      label: `${f.scope}.${f.key}`,
      detail: `${item?.formula_id ?? f.formula_id ?? '—'} · ${item?.unit ?? '—'} · 回源 ${refs} 条`,
    };
  });
  const text = `这次答复里的数字只来自复核通过并已发布的 ${traceable.length} 条事实，涉及 ${formulaIds.size} 个公式。每条事实在计算路径里都有口径、批次与逐批回源步骤；复核状态为“${statusText}”，本次重算 ${attempts} 次。这里只展示索引，不重算数字。`;
  return makeEnvelope({
    status: 'local',
    intent: 'meta_calc',
    route,
    source: 'local',
    text,
    facts: [
      { label: '可回源事实', value: `${traceable.length} / ${published.length} 条` },
      { label: '公式', value: `${formulaIds.size} 个` },
      { label: '复核状态', value: statusText, tone: review?.status === 'published' ? 'ok' : 'neutral' },
      { label: '重算次数', value: `${attempts} 次` },
    ],
    evidence,
    actions: [reportAction('查看计算路径'), askAction('qa-trust', '这些数可信吗', '这些数可信吗？')],
    trace: { template_id: 'T-meta-calc' },
    notice: '证据只列公式、单位与回源条数；逐批明细与源行在报告页。',
    bill,
    elapsedMs,
  });
}

function answerMetaTrust({ route, bundle, bill, elapsedMs }) {
  const review = bundle.review;
  const degraded = Array.isArray(review.degraded) ? review.degraded : [];
  const blocked = Array.isArray(review.blocked_facts) ? review.blocked_facts : [];
  const blockedSymbols = Array.isArray(review.blocked_symbols) ? review.blocked_symbols : [];
  const attempts = Number.isFinite(review.meta?.recompute_attempts) ? review.meta.recompute_attempts : 0;
  const verifyText = review.meta?.verify_id ? '已生成复核标识' : '未生成复核标识';
  const statusText = { published: '已发布', degraded: '降级发布', blocked: '未发布' }[review.status] ?? String(review.status);
  const text = `这份报告的组合结果${review.portfolio_published === true ? '已通过独立复核并发布' : '未发布'}，复核状态为“${statusText}”。有 ${degraded.length} 条降级提示、${blocked.length} 条事实被扣发、${blockedSymbols.length} 个标的缺价或被阻断；${verifyText}，重算 ${attempts} 次。${degraded.length ? '降级项只影响对应作用域，已发布事实仍按原口径展示。' : '没有降级项。'}`;
  const evidence = degraded.slice(0, 4).map((d) => ({
    label: String(d.code ?? '复核提示'),
    detail: String(d.message ?? ''),
  }));
  return makeEnvelope({
    status: 'local',
    intent: 'meta_trust',
    route,
    source: 'local',
    text,
    facts: [
      { label: '复核状态', value: statusText, tone: statusText === '已发布' ? 'ok' : 'neutral' },
      { label: '组合发布', value: review.portfolio_published === true ? '已发布' : '未发布', tone: review.portfolio_published === true ? 'ok' : 'loss' },
      { label: '扣发事实', value: `${blocked.length} 条`, tone: blocked.length ? 'loss' : 'ok' },
      { label: '降级/缺价', value: `${degraded.length} 条 / ${blockedSymbols.length} 个`, tone: degraded.length || blockedSymbols.length ? 'loss' : 'ok' },
    ],
    evidence,
    actions: [reportAction('打开报告 · 证据')],
    trace: { template_id: 'T-meta-trust' },
    notice: '阻断事实不会进入回答；降级项与重算记录只用于说明复核过程。',
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
      text: '当前没有生效规则，所以还不能回放“守不守得住”。可以在规则工作区登记一条，保存与版本都由你确认；登记后我再用这份账单做历史情境复核。',
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
    text: '我不能替你定止损、止盈或买卖阈值——这是你的决定。你可以在规则工作区选一个模板，登记阈值与适用范围；保存、版本和停用都由你确认。登记后我可以用历史情境回放，看看它在这份账单上会触发几次。',
    actions: [rulesAction('去规则工作区'), simulationAction()],
    trace: { template_id: 'T-contract-setup' },
    notice: '不内联保存、不自动生成规则；保存必须由你在规则页确认。',
    bill,
    elapsedMs,
  });
}

function answerSimilarContext({ route, bill, elapsedMs }) {
  return makeEnvelope({
    status: 'unavailable',
    intent: 'similar_context',
    route,
    source: 'template',
    text: '相似情境检索还没有接入：当前没有历史行情检索，也没有跨账单的情境匹配。我不会用示例或别的账单补一个“类似情况”。可以先看这份账单的行为发现与单笔反事实。',
    actions: [askAction('qa-pattern', '为什么说我追高', SUGGESTION_ACTIONS.pattern.question), askAction('qa-what-if', '如果那笔卖出没发生', SUGGESTION_ACTIONS.whatIf.question), reportAction()],
    trace: { template_id: 'T-similar-context' },
    notice: '未接入的能力如实说明，不生成替代结论。',
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
    actions: sampleActions(['worst', 'pattern', 'contract']),
    trace: { template_id: 'T-out-of-scope' },
    notice: '未加载账单、未调用模型、0 条事实。',
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
  loadProfile = () => null,
  classifyIntent = null,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');
  const router = createIntentRouter({ classifyIntent });

  async function bundleOf(bill) {
    const cached = typeof getBundle === 'function' ? getBundle(bill) : null;
    if (cached) return cached;
    if (typeof loadBundle !== 'function') return null;
    return loadBundle(bill);
  }

  async function ask({ question = '', bill = null, ruleState = null, versions = [], preferOnline = false } = {}) {
    const started = now();
    const elapsed = () => now() - started;
    const normalized = normalizeQuestion(question);
    if (!normalized) {
      return makeEnvelope({
        status: 'error',
        text: '问题为空：没有发送任何内容。',
        actions: sampleActions(),
        diagnostics: [{ code: 'E_QA_EMPTY', message: '问题为空' }],
        bill,
        elapsedMs: elapsed(),
      });
    }
    const route = await router.route(normalized);
    if (!route.intent) {
      return clarifyEnvelope({ route, bill, elapsedMs: elapsed() });
    }
    const intent = route.intent;
    if (intent === 'out_of_scope') return answerOutOfScope({ route, bill, elapsedMs: elapsed() });
    if (intent === 'contract_setup') return answerContractSetup({ route, bill, elapsedMs: elapsed() });
    if (intent === 'similar_context') return answerSimilarContext({ route, bill, elapsedMs: elapsed() });

    let bundle = null;
    if (intent !== 'contract_status') {
      try {
        bundle = await bundleOf(bill);
      } catch (e) {
        return makeEnvelope({
          status: 'error',
          intent,
          route,
          source: 'local',
          text: `报告读取失败，本次不回答：${String(e && e.message ? e.message : e).slice(0, 180)}`,
          actions: [reportAction('先去报告页'), askAction('qa-retry', '重试', normalized)],
          diagnostics: [{ code: 'E_QA_BUNDLE_LOAD_FAILED', message: String(e && e.message ? e.message : e) }],
          trace: { template_id: null },
          bill,
          elapsedMs: elapsed(),
        });
      }
      if (!bundle) {
        return makeEnvelope({
          status: 'error',
          intent,
          route,
          source: 'local',
          text: '当前账单的已发布报告还没有载入，问答页不会为此重复请求行情。请先打开报告页，或重试。',
          actions: [reportAction('先去报告页'), askAction('qa-retry', '重试', normalized)],
          diagnostics: [{ code: 'E_QA_BUNDLE_UNAVAILABLE', message: '报告 bundle 未载入' }],
          trace: { template_id: null },
          bill,
          elapsedMs: elapsed(),
        });
      }
      if (PUBLISHED_INTENTS.has(intent)
        && (bundle.status === 'blocked' || bundle.review?.portfolio_published !== true)) {
        return makeEnvelope({
          status: 'error',
          intent,
          route,
          source: 'local',
          text: '当前账单的组合结果未发布（可能缺价、复核未通过或行情阻断）。这次不回答，也不用其他数字代替。',
          actions: [reportAction('打开报告 · 查看原因'), askAction('qa-retry', '重试', normalized)],
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

    if (intent === 'contract_status') {
      return answerContractStatus({ route, versions, bill, bundle: typeof getBundle === 'function' ? getBundle(bill) : null, elapsedMs: elapsed() });
    }

    if (intent === 'what_if') {
      return answerWhatIf({ route, bundle, bill, elapsedMs: elapsed() });
    }
    if (intent === 'meta_calc') {
      return answerMetaCalc({ route, bundle, bill, elapsedMs: elapsed() });
    }
    if (intent === 'meta_trust') {
      return answerMetaTrust({ route, bundle, bill, elapsedMs: elapsed() });
    }
    if (intent === 'loss_overview') {
      const local = buildLocalPortfolioAnswer({ bundle, bill });
      if (!local.ok) {
        return localFailureEnvelope({ failure: local, intent, route, bill, elapsedMs: elapsed(), question: normalized });
      }
      if (preferOnline) {
        return answerOnline({ local, question: normalized, bundle, bill, route, elapsedMs: elapsed(), askOnline });
      }
      const env = localEnvelope({
        local,
        intent,
        route,
        bill,
        elapsedMs: elapsed(),
        actions: [reportAction(), askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question)],
      });
      return env;
    }

    const chip = intent;
    if (!['worst_trade', 'pattern_explain', 'profile', 'how_to_change'].includes(chip)) {
      return clarifyEnvelope({ route, bill, elapsedMs: elapsed() });
    }
    let profile = null;
    if (chip === 'how_to_change' && typeof loadProfile === 'function') {
      try { profile = loadProfile(); } catch { profile = null; }
    }
    const local = buildLocalChipAnswer({
      chip,
      bundle,
      bill,
      ruleState: ruleStateFromVersions(versions, ruleState),
      profile,
      question: normalized,
    });
    if (!local.ok) {
      return localFailureEnvelope({ failure: local, intent, route, bill, elapsedMs: elapsed(), question: normalized });
    }
    const actions = chip === 'how_to_change'
      ? [rulesAction(), reportAction('打开报告 · 证据')]
      : [reportAction(), askAction('qa-meta-calc', '这些数字怎么算', SUGGESTION_ACTIONS.metaCalc.question)];
    return localEnvelope({ local, intent, route, bill, elapsedMs: elapsed(), actions });
  }

  return Object.freeze({ ask });
}
