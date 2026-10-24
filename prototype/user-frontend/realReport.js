// 真实账单报告：只把 adapter 已复核的结果与补充分析映射到新前端样式；不重算行情或指标。
// 边界：未成立的行为、不可用的规则候选与样本不足的 PGR/PLR 不进入用户视图；补充口径不冒充已发布事实。
import { loadUserBillReport } from '../../src/demo/adapter.js';
import { fmtMoney } from '../../src/engine/display.js';
import { renderGhostChart } from '../../src/ui/components/ghostChart.js';
import { buildRuleCandidates } from '../../src/engine/userProfile.js';
import { buildOperationAttribution } from '../../src/engine/operationAttribution.js';
import { pathRangeOf } from '../../src/engine/counterfactual.js';
import { buildReportSnapshot } from '../../src/agent/reportSnapshot.js';
import { recordReportObservation, ruleStateOf, syncBehaviorAnalysis } from './profileStore.js';
import { maybeAutoUpdateProfileSummary } from './profileAutoUpdate.js';
import { openRuleCandidateInAssistant } from './ruleCandidates.js';
import { billSyncStatus, cloudStatusText, cloudStatusTitle } from './cloudSync.js';
import {
  behaviorAnalysisKey,
  behaviorFallbackText,
  requestBehaviorAnalysis,
} from './behaviorAnalysis.js';

const cache = new Map();
const EMPTY_RULE_STATE = Object.freeze({ active_templates: [], active_count: 0, version_count: 0 });

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
  buyCost: '买入成本 = 买入价格 × 数量（逐笔加总）',
  sellProceeds: '卖出所得 = 卖出价格 × 数量（逐笔加总）',
  actualValue: '期末实际价值 = 持仓数量 × 估值日收盘价',
  ghostValue: '一直持有价值 = 不动持仓数量 × 估值日收盘价',
  actualRet: '实际收益 = 期末实际价值 ÷ 买入成本 − 1',
  ghostRet: '一直持有收益 = 一直持有价值 ÷ 买入成本 − 1',
  dragMoney: '择时差额 = 一直持有价值 − 期末实际价值',
  drag: '择时差 = 一直持有收益 − 实际收益',
});

const FACT_STEPS = Object.freeze({
  buyCost: ['逐笔取买入价格 × 数量', '把各笔买入成本加总', '金额按成交价计算，不含费用与税费'],
  sellProceeds: ['逐笔取卖出价格 × 数量', '把各笔卖出所得加总', '金额按成交价计算，不含费用与税费'],
  actualValue: ['取估值日收盘价；非交易日按最近交易日', '乘以期末持仓数量', '缺价时不改用其他日期或示例价格'],
  ghostValue: ['按买入不动的假设取得持仓数量', '乘以估值日收盘价', '缺价时不改用其他日期或示例价格'],
  actualRet: ['用期末实际价值 ÷ 买入成本', '再减 1，得到实际收益率', '收益按成交价与估值日收盘价计算'],
  ghostRet: ['用一直持有价值 ÷ 买入成本', '再减 1，得到买入不动收益率', '收益按成交价与估值日收盘价计算'],
  dragMoney: ['用一直持有价值减去期末实际价值', '正值表示少拿，负值表示少亏', '只做同一笔本金和同一段行情的事后对照'],
  drag: ['用一直持有收益减去实际收益', '正值表示相对损耗，负值表示实际优于对照', '不是预测，也不评价当时的决定'],
});

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function moneyText(value) {
  return String(value ?? '—').replace(/^¥-/, '-¥');
}

function moneyOf(value) {
  return Number.isFinite(value) ? moneyText(fmtMoney(value)) : '—';
}

function displayOf(fact) {
  if (!fact) return '—';
  if (fact.display !== undefined && fact.display !== null) return moneyText(fact.display);
  if (Number.isFinite(fact.value)) return moneyOf(fact.value);
  return '—';
}

export function factDisplay(fact) {
  if (fact?.key === 'heldShares' && Number.isFinite(fact.value)) return `${fact.value} 股`;
  return displayOf(fact);
}

export function factProvenance(bundle, fact) {
  if (!bundle || !fact) return null;
  const items = Array.isArray(bundle.provenance?.items)
    ? bundle.provenance.items
    : (Array.isArray(bundle.review?.provenance?.items) ? bundle.review.provenance.items : []);
  const factId = fact.provenance_fact_id ?? fact.fact_id;
  const item = items.find((x) => x && x.fact_id === factId);
  if (!item) return null;
  const verifyFacts = Array.isArray(bundle.review?.verify?.facts) ? bundle.review.verify.facts : [];
  const verifyFact = verifyFacts.find((x) => x && (x.fact_id === factId || x.fact_id === fact.fact_id)) ?? null;
  const verifyVerdict = verifyFact?.verdict ?? null;
  return {
    fact_id: item.fact_id,
    formula_id: item.formula_id ?? fact.formula_id ?? null,
    formula_text: item.formula_text ?? null,
    source_refs: Array.isArray(item.source_refs) ? item.source_refs : [],
    steps: Array.isArray(item.steps) ? item.steps.map((s) => ({ label: s.label, detail: s.detail })) : [],
    blocked: item.blocked === true || verifyVerdict === 'fail',
    verify_verdict: verifyVerdict,
    verify_reasons: Array.isArray(verifyFact?.reasons) ? verifyFact.reasons : [],
    verify_id: bundle.review?.meta?.verify_id ?? null,
  };
}

function isDemoBundle(bundle, bill) {
  return bundle?.demo === true || bill?.demo === true;
}

function sourceChips(bundle, demo, bill = null) {
  const chips = [];
  let cloudChip = '';
  if (demo) {
    chips.push(`示例场景 · ${bundle.demoScenario?.title || '示例报告'}`);
    chips.push('合成行情 · 非真实行情');
    if (bundle.asOfDate) chips.push(`估值日 ${bundle.asOfDate}`);
    chips.push('演示结果');
  } else {
    chips.push('原始 CSV 未上传');
    if (bill) {
      const sync = billSyncStatus(bill);
      cloudChip = `<span class="rp-chip tm-cloud-chip" data-role="cloud-sync" data-context="${esc(bill.contextId ?? '')}" data-state="${esc(sync.state)}" title="${esc(cloudStatusTitle(sync))}">${esc(cloudStatusText(sync))}</span>`;
    }
    if (bundle.marketSource?.shortLabel) chips.push(bundle.marketSource.shortLabel);
    if (bundle.asOfDate) chips.push(`行情截至 ${bundle.asOfDate}`);
    chips.push(bundle.review?.portfolio_published === true ? '已复核' : '部分发布');
  }
  return chips.map((text) => `<span class="rp-chip">${esc(text)}</span>`).join('') + cloudChip;
}

function sectionHead(title, note = '') {
  return `<div class="report-sec-head"><div class="rs-title"><h2>${esc(title)}</h2></div>${note ? `<p>${esc(note)}</p>` : ''}</div>`;
}

export function reportVisibility({ bundle = null, insights = null, candidatePack = null } = {}) {
  const source = insights ?? bundle?.insights ?? {};
  const portfolio = source.portfolio ?? {};
  const cfs = Array.isArray(portfolio.counterfactuals) ? portfolio.counterfactuals : [];
  const items = Array.isArray(portfolio.decomposition?.items) ? portfolio.decomposition.items : [];
  const allPatterns = Array.isArray(source.behavior?.data?.patterns) ? source.behavior.data.patterns : [];
  const patterns = allPatterns.filter((p) => p?.status === '成立' && (p.sample_n ?? 0) > 0);
  // 保持追高卡片作为 AI 观察的锚点；其余模式只在成立时进入报告。
  const pattern = allPatterns.find((p) => p.pattern_id === 'chase_high_buy') ?? allPatterns[0] ?? null;
  const pgr = source.pgr?.data ?? null;
  const counts = pgr?.counts ?? {};
  const candidates = (Array.isArray(candidatePack?.candidates) ? candidatePack.candidates : []).filter((c) => c?.status === 'available');
  const candidate = candidates[0] ?? null;
  const pgrReady = !!pgr && pgr.ok !== false
    && (counts.realized?.total ?? 0) >= 3
    && (counts.paper?.total ?? 0) >= 2
    && (pgr.pgr !== null || pgr.plr !== null);
  return {
    ghost: portfolio.available === true && cfs.length > 0,
    waterfall: portfolio.available === true && !!portfolio.waterfall && items.length > 0,
    attribution: portfolio.available === true && portfolio.decomposition?.blocked !== true && items.length > 0,
    behavior: patterns.length > 0,
    pgr: pgrReady,
    candidate: candidates.length > 0,
    stockSelf: source.stock_self?.available === true && items.length > 0,
    basis: (bundle?.review?.published_facts ?? []).some((fact) => (fact.scope || 'portfolio') === 'portfolio'),
    hasSells: items.length > 0,
    patterns,
    allPatterns,
    patternStats: {
      established: allPatterns.filter((p) => p?.status === '成立').length,
      rejected: allPatterns.filter((p) => p?.status === '不成立').length,
      insufficient: allPatterns.filter((p) => p?.status !== '成立' && p?.status !== '不成立').length,
    },
    pattern,
    pgrData: pgr,
    candidates,
    candidateData: candidate,
  };
}

function userErrorText(message, fallback = '这项数据未通过核对') {
  const text = String(message ?? '').replace(/\b[EW]_[A-Z0-9_]+\b/g, '').replace(/\s{2,}/g, ' ').trim();
  return text || fallback;
}

function blockedBlock(bundle, demo) {
  const errors = Array.isArray(bundle.errors) ? bundle.errors : [];
  const rows = errors.slice(0, 8).map((e) => `<li>${e.line ? `第 ${e.line} 行 · ` : ''}${esc(userErrorText(e.message))}</li>`);
  return `<section class="panel rp-blocked">
    <p class="mono-label">${demo ? 'EXAMPLE REPORT / 示例' : 'REPORT / 阻断'}</p>
    <h2 class="rp-blocked-title">这份账单暂时不能生成报告</h2>
    <p class="rp-note">${demo ? '示例数据未通过计算校验。' : '没有用示例数字补齐。请回到导入页核对账单或行情范围。'}</p>
    ${rows.length ? `<ul class="rp-blocked-list">${rows.join('')}</ul>` : ''}
    <div class="actions"><a class="btn btn-primary" href="#/import">返回导入页 <span class="arrow">→</span></a></div>
  </section>`;
}

function orderedCounterfactuals(cfs) {
  return [...(Array.isArray(cfs) ? cfs : [])].sort((a, b) => (
    Math.abs(b.replace?.recoveredMoney ?? 0) - Math.abs(a.replace?.recoveredMoney ?? 0)
  ));
}

function topDragItem(items) {
  return (Array.isArray(items) ? items : []).reduce((best, item) => (
    !best || Math.abs(item.dragMoney) > Math.abs(best.dragMoney) ? item : best
  ), null);
}

function deltaCard(bundle, bill, vis, demo) {
  const facts = bundle.factsByScope?.portfolio ?? {};
  const report = bundle.insights?.portfolio?.report?.portfolio ?? {};
  const dragMoney = Number.isFinite(facts.dragMoney?.value) ? facts.dragMoney.value : (report.dragMoney ?? 0);
  const direction = dragMoney > 0 ? 'loss' : dragMoney < 0 ? 'good' : 'flat';
  const headline = direction === 'loss' ? '择时损耗' : direction === 'good' ? '择时改善' : '与一直持有持平';
  const note = direction === 'loss'
    ? `如果这些卖出没有发生，按买入不动计算会多赚 ${moneyOf(dragMoney)}。`
    : direction === 'good'
      ? `如果这些卖出没有发生，按买入不动计算会多亏 ${moneyOf(-dragMoney)}。`
      : '这份账单没有卖出交易，所以没有单笔对照。';
  const top = topDragItem(bundle.insights?.portfolio?.decomposition?.items);
  const highlight = top ? `<p class="delta-highlight">绝对差额最大的一笔：${esc(top.trade_date)} 卖出 ${esc(top.symbol)} ${esc(top.quantity)} 股，${top.dragMoney >= 0 ? '少拿' : '少亏'} ${moneyOf(Math.abs(top.dragMoney))}</p>` : '';
  const tradeLabel = direction === 'loss' ? `少赚 ${moneyOf(dragMoney)}` : direction === 'good' ? `少亏 ${moneyOf(-dragMoney)}` : '持平';
  const stock = vis.stockSelf
    ? `<p class="delta-foot">标的自身涨幅 ${esc(bundle.insights.stock_self.data.display?.ret ?? '—')}（候选口径，不是买入不动）</p>`
    : '';
  return `<section class="delta-card reveal ${direction}" aria-labelledby="real-delta-title">
    <div class="delta-main">
      <p class="delta-eyebrow">${demo ? '示例场景 · 同尺对比' : bill?.cloudRestored ? '云端账单 · 同尺对比' : '本机账单 · 同尺对比'}</p>
      <p class="delta-label" id="real-delta-title">${headline}</p>
      <p class="delta-number">${dragMoney === 0 ? '¥0' : moneyOf(Math.abs(dragMoney))}</p>
      <p class="delta-note">${esc(note)}</p>
      ${highlight}
      ${stock}
    </div>
    <div class="delta-side${direction === 'flat' ? ' is-flat' : ''}">
      ${direction === 'flat'
        ? `<div class="delta-stat"><span>账户结果</span><strong>${esc(displayOf(facts.actualRet))}</strong><small>到手 ${esc(displayOf(facts.actualValue))}</small></div>`
        : `<div class="delta-stat"><span>实际收益</span><strong>${esc(displayOf(facts.actualRet))}</strong><small>到手 ${esc(displayOf(facts.actualValue))}</small></div>
      <div class="delta-stat"><span>一直持有</span><strong>${esc(displayOf(facts.ghostRet))}</strong><small>价值 ${esc(displayOf(facts.ghostValue))}</small></div>
      <div class="delta-stat"><span>择时差</span><strong class="orange">${esc(displayOf(facts.drag))}</strong><small>${esc(tradeLabel)}</small></div>`}
    </div>
  </section>`;
}

function gapText(gap) {
  if (!Number.isFinite(gap)) return '缺价';
  if (Math.abs(gap) < 0.005) return '基本持平';
  return gap > 0 ? `少拿 ${moneyOf(gap)}` : `少亏 ${moneyOf(-gap)}`;
}

// 只把已复核事实翻成一句人话，不引入新的计算或评价。
function methodDisclosure(bill, demo) {
  const trades = Array.isArray(bill?.trades) ? bill.trades : null;
  const buys = trades ? trades.filter((t) => t.side === 'buy').length : null;
  const sells = trades ? trades.filter((t) => t.side === 'sell').length : null;
  const source = trades
    ? `${trades.length} 笔成交（买入 ${buys} / 卖出 ${sells}），按成交价与数量入账。`
    : '账单里的成交，按成交价与数量入账。';
  return `<details class="rp-method" data-role="method">
    <summary>这个结论怎么来的</summary>
    <ol class="rp-method-list">
      <li><strong>读取账单</strong><p>${esc(source)}</p></li>
      <li><strong>确定性计算</strong><p>同一笔本金、同一段行情，计算实际收益、买入不动收益与每笔卖出差额。</p></li>
      <li><strong>发布前核对</strong><p>逐笔加总与总差额一致、每笔能回到原始成交行，报告才发布。</p></li>
      <li><strong>语言层只做复述</strong><p>模型只把已核对的事实换成一句话，不新增数字、不改结论。${demo ? '示例账单不进入在线复述。' : '在线复述不可用时，页面只用本地事实回答。'}</p></li>
    </ol>
  </details>`;
}

function interpretationSection(bundle, vis, demo, bill) {
  const facts = bundle.factsByScope?.portfolio ?? {};
  const report = bundle.insights?.portfolio?.report?.portfolio ?? {};
  const drag = Number.isFinite(facts.dragMoney?.value) ? facts.dragMoney.value : (report.dragMoney ?? 0);
  const items = bundle.insights?.portfolio?.decomposition?.items ?? [];
  const top = topDragItem(items);
  const rows = [];
  const result = drag > 0
    ? `按同一笔本金和同一段行情，你实际拿到 ${displayOf(facts.actualRet)}，买入不动是 ${displayOf(facts.ghostRet)}：这些卖出让你少赚 ${moneyOf(drag)}。`
    : drag < 0
      ? `按同一笔本金和同一段行情，你实际拿到 ${displayOf(facts.actualRet)}，买入不动是 ${displayOf(facts.ghostRet)}：这些卖出让你少亏 ${moneyOf(-drag)}。`
      : `按同一笔本金和同一段行情，实际收益 ${displayOf(facts.actualRet)}，与买入不动持平。`;
  rows.push({ key: '结果', text: result });
  if (top) {
    rows.push({
      key: '集中',
      text: `差额最大的一笔是 ${top.trade_date} 卖出 ${top.symbol} ${top.quantity} 股：${top.dragMoney >= 0 ? '少拿' : '少亏'} ${moneyOf(Math.abs(top.dragMoney))}。`,
    });
  }
  if (vis.patterns.length) {
    const p = vis.patterns[0];
    rows.push({ key: '重复', text: `同一份账单里还出现了「${p.name}」：${patternLead(p)}` });
  } else if (vis.allPatterns.length) {
    rows.push({ key: '重复', text: '行为假设都还没有达到成立条件，这份账单不写成结论。' });
  }
  rows.push({
    key: '下一步',
    text: vis.candidateData?.text
      ? `可以把「${vis.candidateData.text}」当作候选规则，由你确认、改写或拒绝。`
      : '可以打开下面每一笔卖出的对照，看看差额发生在哪一天。',
  });
  return `<section class="report-section rp-insight">
    ${sectionHead('这份账单说明了什么', demo ? '示例数据 · 只描述这份账单' : '三句话读完，每个数字都能往下展开')}
    <div class="rp-card rp-readout">
      ${rows.map((row) => `<div class="rp-readout-row"><span>${esc(row.key)}</span><p>${esc(row.text)}</p></div>`).join('')}
    </div>
    ${methodDisclosure(bill, demo)}
  </section>`;
}

function hypothesisLead(pattern) {
  if (pattern?.status === '成立') return patternLead(pattern);
  const sample = pattern?.sample_n ?? 0;
  if (pattern?.status === '不成立') {
    return sample > 0
      ? `检查了 ${esc(sample)} 次候选事件，没有达到成立条件。`
      : '这份账单里没有找到符合条件的成交。';
  }
  return `目前只有 ${esc(sample)} 次候选事件，暂不判定。`;
}

function hypothesisSection(vis) {
  const all = vis.allPatterns;
  if (all.length < 2) return '';
  const rows = all.map((pattern) => {
    const status = pattern?.status || '证据不足';
    const tone = status === '成立' ? 'ok' : status === '不成立' ? 'flat' : 'muted';
    return `<li class="rp-hyp-row">
      <span class="rp-hyp-status ${tone}">${esc(status)}</span>
      <strong>${esc(pattern?.name ?? '未命名假设')}</strong>
      <span class="rp-hyp-sample">候选 ${esc(pattern?.sample_n ?? 0)} 次</span>
      <p>${hypothesisLead(pattern)}</p>
    </li>`;
  }).join('');
  return `<section class="report-section rp-insight">
    ${sectionHead('哪些假设成立，哪些没有', `成立 ${vis.patternStats.established} · 不成立 ${vis.patternStats.rejected} · 证据不足 ${vis.patternStats.insufficient}`)}
    <div class="rp-card rp-hypothesis">
      <ul class="rp-hyp-list">${rows}</ul>
      <p class="rp-caption">同一套阈值逐条检查；不成立和证据不足也列出，不用别的说法补成结论。</p>
    </div>
  </section>`;
}

function ghostSection(bundle) {
  const portfolio = bundle.insights?.portfolio ?? {};
  const list = orderedCounterfactuals(portfolio.counterfactuals);
  const options = list.map((cf, index) => `<option value="${index}"${index === 0 ? ' selected' : ''}>${esc(cf.trade_date)} · ${esc(cf.symbol)} · 卖出 ${esc(cf.quantity)} 股</option>`).join('');
  const errors = Array.isArray(portfolio.counterfactual_errors) ? portfolio.counterfactual_errors : [];
  const errorNote = errors.length
    ? `<details class="rp-details"><summary>${errors.length} 笔对照暂不可用</summary><ul class="rp-evidence">${errors.slice(0, 6).map((e) => `<li>${esc(e.symbol || '')} ${esc(e.message)}</li>`).join('')}</ul></details>`
    : '';
  const points = list[0]?.series?.points ?? [];
  const range = points.length > 1 ? `${points[0].date} → ${points[points.length - 1].date}` : '只替换一笔，其余成交不变';
  return `<section class="report-section rp-insight">
    ${sectionHead('这笔卖出，如果没发生', range)}
    <div class="rp-card chart-card">
      <div class="rp-control-pair cf-controls">
        <label class="rp-control"><span>选择一笔卖出</span><select class="rp-select" data-role="cf-select">${options}</select></label>
        <label class="rp-control"><span>持有到</span><select class="rp-select rp-select-sm" data-role="cf-date"></select></label>
      </div>
      <p class="rp-cf-summary" data-role="cf-summary"></p>
      <p class="rp-cf-range" data-role="cf-range"></p>
      <div data-role="ghost-chart"></div>
      ${errorNote}
    </div>
  </section>`;
}

function waterfallSection(bundle) {
  const w = bundle.insights?.portfolio?.waterfall;
  const span = Math.max(w.scale.max - w.scale.min, Number.EPSILON);
  const cost = Math.abs(Number(w.items[0]?.amount)) || Math.max(w.scale.max, 1);
  const labels = { cost: 'COST', ghost_gain: 'BUY & HOLD', drag: 'TIMING GAP', actual: 'ACTUAL' };
  const fills = { cost: 'base', ghost_gain: 'ghost', drag: 'hatch', actual: 'actual' };
  const rows = w.items.map((item) => {
    const start = Math.min(item.bar_start, item.bar_end);
    const width = Math.abs(item.bar_end - item.bar_start);
    const leftPct = Math.max(0, ((start - w.scale.min) / span) * 100);
    const widthPct = width > 0 ? Math.max((width / span) * 100, 0.4) : 0;
    return `<div class="scale-row">
      <div class="scale-row-label"><strong>${esc(item.label)}</strong><span>${esc(labels[item.key] ?? '')}</span></div>
      <div class="track"><span class="fill ${esc(fills[item.key] ?? 'actual')}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"></span></div>
      <div class="scale-row-value">${esc(moneyText(item.display.amount))}<small>${esc(item.display.ratio)}</small></div>
    </div>`;
  }).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((r) => `<span>${Math.round(cost * r).toLocaleString('en-US')}</span>`).join('');
  const note = w.checks?.identity_ok === true
    ? '四段拼起来等于投入本金。差额为正表示相对少拿，为负表示相对少亏。'
    : '加总未通过，以下数字只作展示。';
  return `<section class="report-section rp-insight">
    ${sectionHead('差距是怎么来的', '同样的本金，同一把尺')}
    <div class="rp-card scale-card">
      <div class="scale-top"><span>条形长度 = 金额区间 · 刻度 0–${Math.round(cost).toLocaleString('en-US')}</span><span>EST. ${esc(bundle.asOfDate || '—')}</span></div>
      ${rows}
      <div class="scale-axis"><div></div><div class="axis-ticks">${ticks}</div><div></div></div>
      <div class="scale-legend">
        <span><i class="lg-base"></i>投入本金</span>
        <span><i class="lg-ghost"></i>买入不动收益</span>
        <span><i class="lg-hatch"></i>择时损耗</span>
        <span><i class="lg-actual"></i>实际到手收益</span>
      </div>
      <p class="scale-note">${esc(note)}</p>
    </div>
  </section>`;
}

function operationTypeSection(bundle) {
  const portfolio = bundle.insights?.portfolio ?? {};
  const items = Array.isArray(portfolio.decomposition?.items) ? portfolio.decomposition.items : [];
  if (!items.length) return '';
  const result = buildOperationAttribution({
    decomposition: portfolio.decomposition,
    behavior: bundle.insights?.behavior,
  });
  if (!result.ok) return '';
  const rows = result.buckets.map((bucket) => {
    const width = bucket.share === null ? 0 : Math.min(100, Math.abs(bucket.share) * 100);
    const tone = bucket.money > 0 ? 'loss' : bucket.money < 0 ? 'good' : 'flat';
    return `<div class="rp-optype-row" data-bucket="${esc(bucket.id)}" title="${esc(bucket.hint)}">
      <div class="rp-optype-main"><strong>${esc(bucket.label)}</strong><span>${esc(bucket.count)} 笔</span></div>
      <div class="rp-optype-bar tone-${tone}"><i style="width:${width.toFixed(1)}%"></i></div>
      <div class="rp-optype-value"><span>${esc(bucket.display.money)}</span><small>${esc(bucket.display.share)}</small></div>
    </div>`;
  }).join('');
  return `<section class="report-section rp-insight">
    ${sectionHead('按操作类型看差额', '同一笔卖出只归一类 · 金额以逐笔分解为准')}
    <div class="rp-card rp-optype">
      ${rows}
      <p class="rp-caption">${esc(result.basis)}</p>
    </div>
  </section>`;
}

function attributionSection(bundle) {
  const d = bundle.insights?.portfolio?.decomposition;
  const items = [...(d.items ?? [])].sort((a, b) => Math.abs(b.dragMoney) - Math.abs(a.dragMoney));
  const symbols = [...(d.by_symbol ?? [])]
    .filter((s) => Math.abs(s.dragMoney) > 0.004)
    .sort((a, b) => Math.abs(b.dragMoney) - Math.abs(a.dragMoney))
    .slice(0, 4);
  const qtyBySymbol = new Map();
  for (const item of items) {
    qtyBySymbol.set(item.symbol, (qtyBySymbol.get(item.symbol) ?? 0) + (Number(item.quantity) || 0));
  }
  const totalQty = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const totalDrag = symbols.reduce((sum, s) => sum + (Number(s.dragMoney) || 0), 0);
  const absTotal = symbols.reduce((sum, s) => sum + Math.abs(Number(s.dragMoney) || 0), 0) || 1;
  const symbolRows = symbols.map((s) => `<tr>
    <td><span class="sym">${esc(s.symbol)}</span></td>
    <td class="num">${qtyBySymbol.get(s.symbol) ?? 0} 股</td>
    <td class="num">${esc(moneyText(s.display.dragMoney))}</td>
    <td class="num">${Math.round((Math.abs(Number(s.dragMoney) || 0) / absTotal) * 100)}%</td>
  </tr>`).join('');
  const notes = [...items]
    .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
    .slice(0, 3)
    .map((item) => {
      const positive = item.dragMoney >= 0;
      return `<div class="sell-note">
        <p class="sn-date"><span>${esc(item.trade_date)} · SELL</span><span class="${positive ? 'sn-loss' : 'sn-good'}">差额 ${esc(moneyText(item.display.dragMoney))}</span></p>
        <strong>${esc(item.symbol)} × ${esc(item.quantity)}</strong>
        <p>卖出价 ${esc(Number(item.price).toFixed(2))}，估值日收盘 ${esc(Number(item.close).toFixed(2))}。</p>
      </div>`;
    }).join('');
  const title = (bundle.insights?.portfolio?.report?.portfolio?.dragMoney ?? 0) >= 0 ? '代价集中在哪几笔' : '改善来自哪几笔';
  const cfByTrade = new Map();
  for (const cf of (bundle.insights?.portfolio?.counterfactuals ?? [])) {
    const tradeId = cf?.trade_id ?? cf?.replace?.replaced?.trade_id;
    if (tradeId) cfByTrade.set(tradeId, cf);
  }
  const rangeRows = items.map((item) => {
    const range = sellGapRange(cfByTrade.get(item.trade_id));
    const rangeText = range
      ? `${gapText(range.low.gap)}（${range.low.date}）→ ${gapText(range.high.gap)}（${range.high.date}）`
      : '这笔对照暂不可用';
    return `<tr>
      <td>${esc(item.trade_date)}</td>
      <td><span class="sym">${esc(item.symbol)}</span></td>
      <td class="num">${esc(moneyText(item.display.dragMoney))}</td>
      <td>${esc(rangeText)}</td>
    </tr>`;
  }).join('');
  const rangeBlock = cfByTrade.size ? `<details class="rp-details rp-sell-ranges" data-role="sell-ranges">
    <summary>每笔卖出的路径区间</summary>
    <div class="table-wrap">
      <table class="ledger">
        <thead><tr><th>卖出日期</th><th>标的</th><th class="num">差额</th><th>路径区间</th></tr></thead>
        <tbody>${rangeRows}</tbody>
      </table>
    </div>
    <p class="scale-note">这是路径区间，不是概率预测：同一笔卖出持有到不同日期，差额会落在最低与最高之间。</p>
  </details>` : '';
  return `<section class="report-section rp-insight">
    ${sectionHead(title, '按卖出笔计算')}
    <div class="breakdown-grid">
      <div class="rp-card breakdown-table-card">
        <div class="table-wrap">
          <table class="ledger">
            <thead><tr><th>标的</th><th class="num">卖出股数</th><th class="num">差额</th><th class="num">占差额</th></tr></thead>
            <tbody>${symbolRows}</tbody>
            <tfoot><tr><td>合计</td><td class="num">${totalQty} 股</td><td class="num">${esc(`${totalDrag > 0 ? '+' : ''}${moneyText(fmtMoney(totalDrag))}`)}</td><td class="num">100%</td></tr></tfoot>
          </table>
        </div>
        <p class="scale-note">差额＝卖出数量 ×（估值日收盘 − 卖出价）。正值是少拿，负值是少亏。</p>
      </div>
      <aside class="sell-notes">${notes}</aside>
    </div>
    ${rangeBlock}
  </section>`;
}

function patternLead(pattern) {
  if (pattern.pattern_id === 'chase_high_buy') {
    return `买入前 ${esc(pattern.rule?.window?.replace('买入日前 ', '') || '5 个交易日')}涨幅 ≥ ${esc(pattern.rule?.threshold_display || '10.0%')} 的买入，出现了 ${esc(pattern.sample_n)} 次。`;
  }
  if (pattern.pattern_id === 'sell_rebuy_within_2d') {
    return `卖出后 ${esc(pattern.rule?.threshold_display || '2 个交易日')}内又买回同一只标的，出现了 ${esc(pattern.sample_n)} 次。`;
  }
  if (pattern.pattern_id === 'quick_flip') {
    return `买入后 ${esc(pattern.rule?.threshold_display || '3 个交易日')}内卖出同一只标的，出现了 ${esc(pattern.sample_n)} 次。`;
  }
  if (pattern.pattern_id === 'overtrading') {
    return `完成 ${esc(pattern.sample_n)} 次买入后卖出往返，达到高频候选阈值 ${esc(pattern.min_samples)} 次。`;
  }
  return `「${esc(pattern.name)}」出现了 ${esc(pattern.sample_n)} 次。`;
}

function behaviorPatternRow(pattern, primary) {
  const evidence = Array.isArray(pattern.evidence) ? pattern.evidence.slice(0, 4) : [];
  const sourceBadge = primary && pattern.pattern_id === 'chase_high_buy'
    ? '<span class="rp-badge mode" data-role="behavior-source">本机规则识别</span>'
    : '';
  const comment = primary && pattern.pattern_id === 'chase_high_buy'
    ? '<p class="rp-behavior-comment" data-role="behavior-comment" hidden></p>'
    : '';
  return `<div class="rp-behavior-row" data-pattern="${esc(pattern.pattern_id)}">
    <div class="rp-behavior-top"><span class="rp-badge loss">出现 ${esc(pattern.sample_n)} 次</span><strong>${esc(pattern.name)}</strong>${sourceBadge}</div>
    <p class="rp-behavior-lead">${patternLead(pattern)}</p>
    ${comment}
    <ul class="rp-evidence rp-evidence-grid">${evidence.map((e) => `<li><span>${esc(e.trade_date)}</span><span>${esc(e.symbol)}</span><strong>${esc(e.display?.rise ?? e.display?.gap_days ?? '—')}</strong></li>`).join('')}</ul>
  </div>`;
}

function behaviorSection(vis) {
  return `<section class="report-section rp-insight">
    ${sectionHead('重复出现的行为', '只描述这笔账单')}
    <div class="rp-card rp-behavior">
      ${vis.patterns.map((pattern, index) => behaviorPatternRow(pattern, index === 0)).join('')}
      <p class="rp-caption">按候选阈值识别，仅描述当前账单。</p>
    </div>
  </section>`;
}

function analysisCard(analysis, vis) {
  const tag = vis.candidate ? '不影响规则候选' : '暂无可执行规则';
  const observations = analysis.observations.map((item) => `<li class="rp-analysis-item">
    <p>${esc(item.text)}</p>
    <small>基于 ${esc(item.evidence_event_indexes.length)} 笔交易</small>
  </li>`).join('');
  return `<div class="rp-card rp-analysis">
    <div class="rp-analysis-head"><span class="rp-badge ai">AI 观察</span><span class="rp-analysis-tag">${esc(tag)}</span></div>
    ${!vis.behavior && analysis.pattern.comment ? `<p class="rp-analysis-text">${esc(analysis.pattern.comment)}</p>` : ''}
    ${observations ? `<ul class="rp-analysis-list">${observations}</ul>` : ''}
  </div>`;
}

function analysisUnavailableNote() {
  return '<p class="rp-analysis-note">在线观察暂不可用。<button class="rp-link-btn" type="button" data-retry-behavior>重试</button></p>';
}

function hydrateBehaviorAnalysis(host, { bill, bundle, vis, profileKey = null }) {
  const slot = host.querySelector('[data-role="behavior-analysis"]');
  if (!slot) return;
  const facts = bundle.behaviorFacts;
  const localPattern = vis.pattern;
  if (!facts || !localPattern) return;
  const sourceEl = host.querySelector('[data-role="behavior-source"]');
  const commentEl = host.querySelector('[data-role="behavior-comment"]');
  const request = {
    key: behaviorAnalysisKey({ bill, bundle }),
    facts,
    localPattern,
  };

  const apply = (result) => {
    if (!slot.isConnected) return;
    if (!result.ok) {
      if (vis.behavior) {
        slot.innerHTML = analysisUnavailableNote();
        bindRetry();
      }
      return;
    }
    const analysis = result.analysis;
    if (profileKey) {
      try { syncBehaviorAnalysis(analysis, { profileKey }); } catch { /* 画像同步失败不影响报告 */ }
    }
    if (analysis.source === 'ai') {
      if (sourceEl) {
        sourceEl.textContent = 'AI 观察';
        sourceEl.className = 'rp-badge ai';
        sourceEl.removeAttribute('title');
      }
      if (commentEl && analysis.pattern.comment) {
        commentEl.textContent = analysis.pattern.comment;
        commentEl.hidden = false;
      }
      const hasObservation = analysis.observations.length > 0;
      if (hasObservation || (!vis.behavior && analysis.pattern.comment)) {
        slot.innerHTML = analysisCard(analysis, vis);
      } else {
        slot.replaceChildren();
      }
      return;
    }
    if (sourceEl) {
      sourceEl.textContent = '本机规则补充';
      sourceEl.className = 'rp-badge fallback';
      sourceEl.title = behaviorFallbackText(analysis.fallback_reason);
    }
    slot.replaceChildren();
  };

  const bindRetry = () => {
    const button = slot.querySelector('[data-retry-behavior]');
    if (!button) return;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = '重试中…';
      try {
        apply(await requestBehaviorAnalysis({ ...request, force: true }));
      } catch {
        button.disabled = false;
        button.textContent = '重试';
      }
    });
  };

  requestBehaviorAnalysis(request).then(apply).catch(() => {
    if (!slot.isConnected || !vis.behavior) return;
    slot.innerHTML = analysisUnavailableNote();
    bindRetry();
  });
}

function sourceLineText(ref) {
  if (!ref) return '账单中暂未提供行号';
  const file = ref.file ? `${ref.file} ` : '';
  const line = Number.isFinite(ref.line) ? `第 ${ref.line} 行` : '行号未提供';
  return `${file}${line}`.trim();
}

export function factDetail(fact, bundle) {
  const label = FACT_LABELS[fact.key] ?? fact.key;
  const provenance = factProvenance(bundle, fact);
  if (!provenance) return '';
  const refs = provenance.source_refs;
  const shown = refs.slice(0, 8);
  const allSources = refs.length > shown.length
    ? `<details class="rp-more-sources"><summary>查看全部 ${refs.length} 笔来源</summary><ul>${refs.map((ref) => `<li>${esc(sourceLineText(ref))}</li>`).join('')}</ul></details>`
    : '';
  const formula = FACT_FORMULAS[fact.key] ?? provenance.formula_text ?? null;
  const userSteps = FACT_STEPS[fact.key] ?? [];
  const steps = userSteps.length
    ? `<details class="rp-fact-steps"><summary>计算步骤</summary><ol>${userSteps.map((step) => `<li>${esc(step)}</li>`).join('')}</ol></details>`
    : '';
  return `<details class="rp-fact-detail">
    <summary>${esc(label)} · 查看来源</summary>
    ${formula ? `<p><strong>公式含义</strong> ${esc(formula)}</p>` : ''}
    <p><strong>成交来源</strong> ${esc(shown.map(sourceLineText).join('；') || '暂未提供')}${refs.length > shown.length ? '（已显示前 8 笔）' : ''}</p>
    ${allSources}
    ${steps}
  </details>`;
}

function ratioPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';
}

function pgrSection(data) {
  let conclusion = '样本还不够，暂不比较两边。';
  if (data.pgr !== null && data.plr !== null) {
    const de = data.de ?? (data.pgr - data.plr);
    conclusion = de <= -0.05
      ? '亏损的持仓更容易被卖出。'
      : de >= 0.05 ? '盈利的持仓更容易被卖出。' : '两边卖出的倾向接近。';
  } else if (data.pgr !== null) {
    conclusion = '样本里没有亏损卖出，暂时只看到盈利时的卖出比例。';
  } else if (data.plr !== null) {
    conclusion = '样本里没有盈利卖出，暂时只看到亏损时的卖出比例。';
  }
  const counts = data.counts ?? {};
  return `<section class="report-section rp-insight">
    ${sectionHead('卖出习惯', `卖出 ${counts.realized?.total ?? '—'} 笔 · 持仓 ${counts.paper?.total ?? '—'} 只`)}
    <div class="rp-card rp-habit">
      <div class="panel-head"><span>先卖盈利还是先卖亏损</span><span>PROPORTION / 比例</span></div>
      <div class="rp-habit-grid">
        <div><span>盈利时卖出</span><strong>${esc(ratioPct(data.pgr))}</strong></div>
        <div><span>亏损时卖出</span><strong>${esc(ratioPct(data.plr))}</strong></div>
      </div>
      <p class="rp-habit-line">${esc(conclusion)}</p>
    </div>
  </section>`;
}

function candidateSection(candidates) {
  return `<section class="report-section rp-insight">
    ${sectionHead('要不要设一条规则？', '保存前由你确认或改写')}
    <div class="rp-card rp-candidate">
      <div class="panel-head"><span>候选规则 · 由你确认</span><span>不会自动生效</span></div>
      ${candidates.map((candidate) => `<div class="rp-candidate-row" data-candidate-id="${esc(candidate.candidate_id)}">
        <div class="rp-candidate-top"><span class="rp-badge mode">${esc(candidate.template_name)}</span></div>
        <p class="rp-candidate-text">“${esc(candidate.text)}”</p>
        <p class="rp-note">${esc(candidate.reason)}</p>
        <div class="rp-actions">
          <button class="btn btn-primary" type="button" data-open-candidate="${esc(candidate.candidate_id)}">用这条建规则</button>
        </div>
      </div>`).join('')}
      <p class="rp-caption">会打开助手并带入证据；候选不会自动生效。</p>
    </div>
  </section>`;
}

function basisSection(bundle, demo) {
  const published = (bundle.review?.published_facts ?? []).filter((fact) => (fact.scope || 'portfolio') === 'portfolio');
  const facts = published.filter((fact) => FACT_LABELS[fact.key]);
  if (!facts.length) return '';
  const rows = facts.map((fact) => `<div><dt>${esc(FACT_LABELS[fact.key])}</dt><dd>${esc(factDisplay(fact))}</dd></div>`).join('');
  const details = facts.map((fact) => factDetail(fact, bundle)).filter(Boolean).join('');
  return `<section class="report-section rp-basis-section">
    <details class="rp-basis">
      <summary><span>数字与来源</span><i class="rp-basis-plus" aria-hidden="true">+</i></summary>
      <dl class="rp-basis-grid">${rows}</dl>
      ${details ? `<div class="rp-provenance-list">${details}</div>` : ''}
      <p class="rp-caption">按成交价计算，不含费用与税费；数字由本机程序计算并核对。${demo ? '示例数据只用于演示。' : ''}</p>
    </details>
  </section>`;
}

function footnote(vis) {
  const supplemental = vis.behavior || vis.pgr || vis.candidate;
  return `<footer class="rp-footnote">
    <p>这是一次事后对照，不预测未来，也不构成投资建议。</p>
    ${supplemental ? '<p>补充图表和规则候选为候选口径，不进入报告数字。</p>' : ''}
    ${vis.candidate ? '' : '<p>想把下一次的决定写成规则？<a href="#/me">去个人中心看看现有模板</a>。</p>'}
  </footer>`;
}

function renderBundle(host, bundle, ctx, bill) {
  const demo = isDemoBundle(bundle, bill);
  const source = `<div class="rp-status rp-status-top">${sourceChips(bundle, demo, bill)}</div>`;
  const published = bundle.review?.portfolio_published === true;
  if (!published) {
    host.innerHTML = `<div class="container report-body">${source}${blockedBlock(bundle, demo)}</div>`;
    return;
  }

  const insights = bundle.insights ?? {};
  let profile = null;
  let profileKey = null;
  if (!demo) {
    try {
      const observation = recordReportObservation({ bundle, bill, ruleState: ruleStateOf(ctx?.state?.contracts?.versions) });
      profile = observation.profile;
      profileKey = observation.snapshot?.profile_key ?? null;
      const snapshot = buildReportSnapshot({ profile, bundle, reportKey: observation.key });
      if (snapshot && snapshot.profile_key === profileKey
        && typeof ctx?.cloudDeps?.syncSnapshot === 'function') {
        Promise.resolve(ctx.cloudDeps.syncSnapshot({ bill, snapshot }))
          .then((result) => { if (result?.ok) ctx.cloudDeps.invalidateCloudProfile?.(); })
          .catch(() => {});
      }
      if (observation.recorded) {
        void maybeAutoUpdateProfileSummary({ ctx, profile, bill, bundle });
      }
    } catch { /* 画像记录失败不阻断报告 */ }
  }
  if (!demo) void ctx?.prewarmScenario?.(bill);
  let candidatePack = null;
  try {
    candidatePack = buildRuleCandidates({
      behavior: insights.behavior?.available ? insights.behavior.data : null,
      ruleState: demo ? EMPTY_RULE_STATE : ruleStateOf(ctx?.state?.contracts?.versions),
      profile,
    });
  } catch {
    candidatePack = { candidates: [] };
  }
  const vis = reportVisibility({ bundle, insights, candidatePack });
  const warnings = Array.isArray(bundle.warnings) ? bundle.warnings : [];
  const warningNote = warnings.length
    ? `<p class="rp-caption">有 ${warnings.length} 条账单提示已按 0 或缺省口径处理，不影响报告数字的可回查性。</p>`
    : '';

  const behaviorBlock = vis.behavior ? behaviorSection(vis) : '';
  const pgrBlock = vis.pgr ? pgrSection(vis.pgrData) : '';
  const operationTypeBlock = operationTypeSection(bundle);
  const compactMods = vis.behavior && vis.pgr
    ? `<div class="mod-grid">${behaviorBlock}<div class="mod-col">${pgrBlock}</div></div>`
    : `${behaviorBlock}${pgrBlock}`;

  host.innerHTML = `<div class="container report-body real-report">
    ${source}
    ${deltaCard(bundle, bill, vis, demo)}
    ${interpretationSection(bundle, vis, demo, bill)}
    ${operationTypeBlock}
    ${vis.ghost ? ghostSection(bundle) : ''}
    ${vis.waterfall ? waterfallSection(bundle) : ''}
    ${vis.attribution ? attributionSection(bundle) : ''}
    ${compactMods}
    ${hypothesisSection(vis)}
    <div class="rp-analysis-slot" data-role="behavior-analysis"></div>
    ${vis.candidate ? candidateSection(vis.candidates) : ''}
    ${vis.basis ? basisSection(bundle, demo) : ''}
    ${warningNote}
    ${footnote(vis)}
  </div>`;

  indexReportSections(host);
  mountGhostChart(host, bundle);
  bindCandidateButtons(host, ctx, vis.candidates);
  hydrateBehaviorAnalysis(host, { bill, bundle, vis, profileKey });
}

function indexReportSections(host) {
  host.querySelectorAll('.real-report .report-section:not(.rp-basis-section)').forEach((section, index) => {
    const title = section.querySelector('.report-sec-head .rs-title');
    if (!title || title.querySelector('.rs-idx')) return;
    const badge = document.createElement('span');
    badge.className = 'rs-idx';
    badge.textContent = String(index + 1).padStart(2, '0');
    title.prepend(badge);
  });
}

// 反事实沙盒：复用 replaceSell 序列中逐日的 cf − actual；不引入新的价格假设。
function sandboxText(point) {
  if (!point || !Number.isFinite(point.cf) || !Number.isFinite(point.actual)) {
    return `${point?.date ?? '该日'}缺价：不估算差额。`;
  }
  const gap = point.cf - point.actual;
  if (Math.abs(gap) < 0.005) return `不卖这笔，到 ${point.date} 结果不变。`;
  return gap > 0
    ? `不卖这笔，到 ${point.date} 会多拿 ${moneyOf(gap)}。`
    : `不卖这笔，到 ${point.date} 会少拿 ${moneyOf(-gap)}。`;
}

function sandboxDates(cf) {
  const sellDate = cf?.replace?.replaced?.trade_date ?? cf?.series?.points?.[0]?.date ?? '';
  return (Array.isArray(cf?.series?.points) ? cf.series.points : [])
    .filter((p) => p.date >= sellDate && Number.isFinite(p.cf) && Number.isFinite(p.actual))
    .map((p) => p.date);
}

function sellGapRange(cf) {
  return pathRangeOf(cf);
}

function pathRangeText(cf) {
  const range = sellGapRange(cf);
  if (!range) return '';
  if (range.flat) return `路径区间：持有到不同日期，差额基本不变（${gapText(range.high.gap)}）。`;
  return `路径区间：同一笔卖出，持有到不同日期，差额落在 ${gapText(range.low.gap)}（${range.low.date}）到 ${gapText(range.high.gap)}（${range.high.date}）之间。这是路径区间，不是概率预测。`;
}

function mountGhostChart(host, bundle) {
  const chartHost = host.querySelector('[data-role="ghost-chart"]');
  const select = host.querySelector('[data-role="cf-select"]');
  const dateSelect = host.querySelector('[data-role="cf-date"]');
  const summary = host.querySelector('[data-role="cf-summary"]');
  const range = host.querySelector('[data-role="cf-range"]');
  const list = orderedCounterfactuals(bundle.insights?.portfolio?.counterfactuals);
  if (!chartHost || !list.length) return;
  let chartApi = null;
  let activeCf = list[0];
  const draw = (index) => {
    const cf = list[index] ?? list[0];
    activeCf = cf;
    chartHost.replaceChildren();
    chartApi = renderGhostChart(chartHost, {
      series: cf.series,
      markers: cf.markers,
      symbol: cf.symbol,
      marketSource: { ...(bundle.marketSource ?? {}), dynamic: bundle.marketSource?.id === 'dynamic-tushare' },
      compact: true,
      merged: true,
    });
    const dates = sandboxDates(cf);
    if (dateSelect) {
      dateSelect.innerHTML = dates.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      dateSelect.value = dates[dates.length - 1] ?? '';
    }
    const point = cf.series.points[cf.series.points.length - 1] ?? null;
    if (summary) summary.textContent = sandboxText(point);
    if (range) range.textContent = pathRangeText(cf);
    if (chartApi && point) chartApi.setIndex(cf.series.points.indexOf(point));
  };
  draw(0);
  if (select) select.addEventListener('change', () => draw(Number(select.value)));
  if (dateSelect) {
    dateSelect.addEventListener('change', () => {
      const i = activeCf.series.points.findIndex((p) => p.date === dateSelect.value);
      if (i < 0) return;
      if (summary) summary.textContent = sandboxText(activeCf.series.points[i]);
      if (chartApi) chartApi.setIndex(i);
    });
  }
}

function bindCandidateButtons(host, ctx, candidates) {
  host.querySelectorAll('[data-open-candidate]').forEach((button) => {
    const id = button.getAttribute('data-open-candidate');
    const candidate = candidates.find((c) => c.candidate_id === id);
    if (!button || !candidate || !ctx) return;
    button.addEventListener('click', () => { openRuleCandidateInAssistant(ctx, candidate); });
  });
}

function renderError(host) {
  host.innerHTML = '<div class="container report-body"><section class="panel rp-blocked"><strong>报告暂时无法生成</strong><p class="rp-note">请回到导入页核对账单，或稍后重试。</p></section></div>';
}

function ensureReport(bill) {
  const key = bill?.contextId || 'anonymous';
  const cached = cache.get(key);
  if (cached?.status === 'ready') return Promise.resolve(cached.bundle);
  if (cached?.status === 'error') return Promise.reject(new Error(cached.message));
  if (cached?.promise) return cached.promise;
  const promise = loadUserBillReport(bill)
    .then((bundle) => {
      cache.set(key, { status: 'ready', bundle });
      return bundle;
    })
    .catch((error) => {
      const message = String(error && error.message ? error.message : error);
      cache.set(key, { status: 'error', message });
      throw error;
    });
  cache.set(key, { status: 'loading', promise });
  return promise;
}

export function loadRealReport(bill) {
  return ensureReport(bill);
}

export function getRealReportBundle(bill) {
  const cached = cache.get(bill?.contextId || 'anonymous');
  return cached?.status === 'ready' ? cached.bundle : null;
}

export function getRealReportState(bill) {
  const cached = cache.get(bill?.contextId || 'anonymous');
  if (!cached) return { status: 'idle' };
  if (cached.status === 'ready') return { status: 'ready', bundle: cached.bundle };
  if (cached.status === 'loading') return { status: 'loading' };
  if (cached.status === 'error') return { status: 'error', message: cached.message };
  return { status: 'idle' };
}

export function renderRealReport(host, bill, ctx = null) {
  if (!host || !bill) return;
  const key = bill.contextId || 'anonymous';
  const cached = cache.get(key);
  if (cached?.status === 'ready') {
    renderBundle(host, cached.bundle, ctx, bill);
    return;
  }
  if (cached?.status === 'error') {
    renderError(host);
    return;
  }
  const liveHost = () => document.getElementById('tm-real-report');
  host.innerHTML = '<div class="container report-body"><p class="rp-loading">正在读取已确认账单的真实结果…</p></div>';
  ensureReport(bill)
    .then((bundle) => {
      const target = liveHost();
      if (!target) return;
      if (ctx && ctx.state?.bill?.contextId !== bill.contextId) return;
      renderBundle(target, bundle, ctx, bill);
      ctx?.refreshAssistant?.();
    })
    .catch(() => {
      const target = liveHost();
      if (target) renderError(target);
      ctx?.refreshAssistant?.();
    });
}

export function clearRealReportCache() { cache.clear(); }

// 云端报告快照直接作为本会话的已就绪报告；不重新取行情，也不改写快照内容。
export function seedRealReport(bill, bundle) {
  if (!bill?.contextId || !bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return false;
  cache.set(bill.contextId, { status: 'ready', bundle });
  return true;
}
