// 真实账单报告：只把 adapter 已复核的结果与补充分析映射到新前端样式；不重算行情或指标。
// 边界：未成立的行为、不可用的规则候选与样本不足的 PGR/PLR 不进入用户视图；补充口径不冒充已发布事实。
import { loadUserBillReport } from '../../src/demo/adapter.js';
import { fmtMoney } from '../../src/engine/display.js';
import { renderGhostChart } from '../../src/ui/components/ghostChart.js';
import { buildRuleCandidates } from '../../src/engine/userProfile.js';
import { recordReportObservation, ruleStateOf, syncBehaviorAnalysis } from './profileStore.js';
import { openRuleCandidateInAssistant } from './ruleCandidates.js';
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

function sourceChips(bundle, demo) {
  const chips = [];
  if (demo) {
    chips.push(`示例场景 · ${bundle.demoScenario?.title || '示例报告'}`);
    chips.push('合成行情 · 非真实行情');
    if (bundle.asOfDate) chips.push(`估值日 ${bundle.asOfDate}`);
    chips.push('演示结果');
  } else {
    chips.push('本机账单 · 未上传');
    if (bundle.marketSource?.shortLabel) chips.push(bundle.marketSource.shortLabel);
    if (bundle.asOfDate) chips.push(`行情截至 ${bundle.asOfDate}`);
    chips.push(bundle.review?.portfolio_published === true ? '已复核' : '部分发布');
  }
  return chips.map((text) => `<span class="rp-chip">${esc(text)}</span>`).join('');
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
    pattern,
    pgrData: pgr,
    candidates,
    candidateData: candidate,
  };
}

function blockedBlock(bundle, demo) {
  const errors = Array.isArray(bundle.errors) ? bundle.errors : [];
  const rows = errors.slice(0, 8).map((e) => `<li>${e.line ? `第 ${e.line} 行 · ` : ''}${esc(e.message || e.code)}</li>`);
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
  const highlight = top ? `<p class="delta-highlight">最大的一笔：${esc(top.trade_date)} 卖出 ${esc(top.symbol)} ${esc(top.quantity)} 股，${top.dragMoney >= 0 ? '少拿' : '少亏'} ${moneyOf(Math.abs(top.dragMoney))}</p>` : '';
  const tradeLabel = direction === 'loss' ? `少赚 ${moneyOf(dragMoney)}` : direction === 'good' ? `少亏 ${moneyOf(-dragMoney)}` : '持平';
  const stock = vis.stockSelf
    ? `<p class="delta-foot">标的自身涨幅 ${esc(bundle.insights.stock_self.data.display?.ret ?? '—')}（候选口径，不是买入不动）</p>`
    : '';
  return `<section class="delta-card reveal ${direction}" aria-labelledby="real-delta-title">
    <div class="delta-main">
      <p class="delta-eyebrow">${demo ? '示例场景 · 同尺对比' : '本机账单 · 同尺对比'}</p>
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

function ghostSection(bundle) {
  const portfolio = bundle.insights?.portfolio ?? {};
  const list = orderedCounterfactuals(portfolio.counterfactuals);
  const options = list.map((cf, index) => `<option value="${index}"${index === 0 ? ' selected' : ''}>${esc(cf.trade_date)} · ${esc(cf.symbol)} · 卖出 ${esc(cf.quantity)} 股</option>`).join('');
  const errors = Array.isArray(portfolio.counterfactual_errors) ? portfolio.counterfactual_errors : [];
  const errorNote = errors.length
    ? `<details class="rp-details"><summary>${errors.length} 笔对照暂不可用</summary><ul class="rp-evidence">${errors.slice(0, 6).map((e) => `<li>${esc(e.symbol || '')} ${esc(e.message)}</li>`).join('')}</ul></details>`
    : '';
  const hasBenchmark = list.some((cf) => cf.series?.benchmark?.available !== false && cf.series?.benchmark);
  return `<section class="report-section rp-insight">
    ${sectionHead('这笔卖出，如果没发生', hasBenchmark ? '只替换一笔，其余成交不变 · 含沪深300同额对照' : '只替换一笔，其余成交不变')}
    <div class="rp-card">
      <div class="rp-control-pair">
        <label class="rp-control"><span>选择一笔卖出</span><select class="rp-select" data-role="cf-select">${options}</select></label>
        <label class="rp-control"><span>持有到</span><select class="rp-select rp-select-sm" data-role="cf-date"></select></label>
      </div>
      <p class="rp-cf-summary" data-role="cf-summary"></p>
      <div class="rp-chart" data-role="ghost-chart"></div>
      ${errorNote}
    </div>
  </section>`;
}

function waterfallSection(bundle) {
  const w = bundle.insights?.portfolio?.waterfall;
  const span = Math.max(w.scale.max - w.scale.min, Number.EPSILON);
  const notes = { cost: '买入成本', ghost_gain: '同样的钱一直拿着', drag: '和一直持有相比', actual: '你的实际结果' };
  const rows = w.items.map((item) => {
    const start = Math.min(item.bar_start, item.bar_end);
    const width = Math.abs(item.bar_end - item.bar_start);
    const leftPct = ((start - w.scale.min) / span) * 100;
    const widthPct = width > 0 ? Math.max((width / span) * 100, 0.6) : 0;
    return `<div class="wf-row">
      <div class="wf-label"><span>${esc(item.label)}</span><small>${esc(notes[item.key] ?? '')}</small></div>
      <div class="wf-track"><span class="wf-bar wf-${esc(item.kind)}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"></span></div>
      <div class="wf-value"><strong>${esc(moneyText(item.display.amount))}</strong><small>${esc(item.display.ratio)}</small></div>
    </div>`;
  }).join('');
  return `<section class="report-section rp-insight">
    ${sectionHead('差距是怎么来的', '同样的本金，三种结果')}
    <div class="rp-card">
      <div class="rp-waterfall">${rows}</div>
      <p class="rp-caption">${w.checks?.identity_ok === true ? '加总已核对。' : '加总未通过，以下数字只作展示。'}</p>
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
  const max = Math.max(...items.map((item) => Math.abs(item.dragMoney)), 1);
  const symbolRows = symbols.length > 1 ? `<div class="rp-attrib-list">${symbols.map((s) => `<div class="rp-attrib-row">
    <span class="rp-attrib-symbol">${esc(s.symbol)}</span>
    <span class="rp-attrib-track"><i class="rp-attrib-bar ${s.dragMoney >= 0 ? 'loss' : 'good'}" style="width:${Math.max((Math.abs(s.dragMoney) / max) * 100, 1).toFixed(1)}%"></i></span>
    <strong class="${s.dragMoney >= 0 ? 'loss' : 'good'}">${esc(moneyText(s.display.dragMoney))}</strong>
  </div>`).join('')}</div>` : '';
  const top = items.slice(0, 3);
  const topRows = `<ul class="rp-sell-list">${top.map((item) => `<li>
    <span class="rp-sell-date">${esc(item.trade_date)}</span>
    <span class="rp-sell-name">${esc(item.symbol)} · ${esc(item.quantity)} 股</span>
    <strong class="${item.dragMoney >= 0 ? 'loss' : 'good'}">${esc(moneyText(item.display.dragMoney))}</strong>
  </li>`).join('')}</ul>`;
  const allRows = items.map((item) => `<tr>
    <td>${esc(item.trade_date)}</td>
    <td>${esc(item.symbol)}</td>
    <td class="num">${esc(item.quantity)}</td>
    <td class="num">${esc(Number(item.price).toFixed(2))}</td>
    <td class="num">${esc(Number(item.close).toFixed(2))}</td>
    <td class="num ${item.dragMoney < 0 ? 'rp-good' : ''}">${esc(moneyText(item.display.dragMoney))}</td>
  </tr>`).join('');
  const more = items.length > top.length
    ? `<details class="rp-details"><summary>全部 ${items.length} 笔卖出</summary>
        <div class="table-wrap"><table class="ledger rp-table">
          <thead><tr><th>日期</th><th>标的</th><th class="num">数量</th><th class="num">卖出价</th><th class="num">估值日收盘</th><th class="num">差额</th></tr></thead>
          <tbody>${allRows}</tbody>
        </table></div>
      </details>`
    : '';
  const title = (bundle.insights?.portfolio?.report?.portfolio?.dragMoney ?? 0) >= 0 ? '代价集中在哪几笔' : '改善来自哪几笔';
  return `<section class="report-section rp-insight">
    ${sectionHead(title, '按卖出笔计算')}
    <div class="rp-card">
      ${symbolRows}
      ${topRows}
      ${more}
      <p class="rp-caption">差额＝卖出数量 ×（估值日收盘 − 卖出价）。正值是少拿，负值是少亏。</p>
    </div>
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
    ? '<span class="rp-badge mode" data-role="behavior-source">本地规则引擎</span>'
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
      sourceEl.textContent = '规则引擎兜底';
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
  if (!ref) return '源行不可定位';
  const row = Number.isFinite(ref.line) ? ` 第 ${ref.line} 行` : '';
  return `${ref.file ?? '源行不可定位'}${row}（${ref.key ?? '—'}）`;
}

export function factDetail(fact, bundle) {
  const label = FACT_LABELS[fact.key] ?? fact.key;
  const provenance = factProvenance(bundle, fact);
  if (!provenance) {
    return `<details class="rp-fact-detail"><summary>${esc(label)} · 查看来源</summary><p class="rp-caption">当前事实没有可展开的计算路径。</p></details>`;
  }
  const refs = provenance.source_refs;
  const shown = refs.slice(0, 8);
  const allSources = refs.length > shown.length
    ? `<details class="rp-more-sources"><summary>查看全部 ${refs.length} 笔来源</summary><ul>${refs.map((ref) => `<li>${esc(sourceLineText(ref))}</li>`).join('')}</ul></details>`
    : '';
  const review = `复核：${provenance.verify_verdict ?? '—'}${provenance.verify_id ? ` · ${provenance.verify_id}` : ''}${provenance.blocked ? ' · 路径被阻断' : ''}`;
  const reasons = provenance.verify_reasons.length
    ? `<p><strong>复核原因</strong> ${esc(provenance.verify_reasons.map((r) => `${r.code ?? '—'}：${r.message ?? r.kind ?? '—'}`).join('；'))}</p>`
    : '';
  const steps = provenance.steps.length
    ? `<details class="rp-fact-steps"><summary>计算步骤</summary><ol>${provenance.steps.map((s) => `<li><strong>${esc(s.label ?? '步骤')}</strong>：${esc(s.detail ?? '—')}</li>`).join('')}</ol></details>`
    : '';
  return `<details class="rp-fact-detail">
    <summary>${esc(label)} · 查看来源</summary>
    <p><strong>公式</strong> ${esc(provenance.formula_id ?? '—')}${provenance.formula_text ? `：${esc(provenance.formula_text)}` : ''}</p>
    <p><strong>成交行</strong> ${esc(shown.map(sourceLineText).join('；') || '未提供')}${refs.length > shown.length ? '（已显示前 8 笔）' : ''}</p>
    ${allSources}
    <p><strong>${esc(review)}</strong></p>
    ${reasons}
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
  const rows = facts.map((fact) => `<div><dt>${esc(FACT_LABELS[fact.key])}</dt><dd>${esc(factDisplay(fact))}</dd></div>`).join('');
  const details = facts.map((fact) => factDetail(fact, bundle)).join('');
  return `<section class="report-section rp-basis-section">
    <details class="rp-basis">
      <summary><span>核对数据</span><small>${published.length} 项已复核</small><i class="rp-basis-plus" aria-hidden="true">+</i></summary>
      <dl class="rp-basis-grid">${rows}</dl>
      <div class="rp-provenance-list">${details}</div>
      <p class="rp-caption">按成交价计算，不含费用与税费；数字由本地确定性引擎生成并复核。${demo ? '示例数据只用于演示。' : ''}</p>
    </details>
  </section>`;
}

function footnote(vis) {
  const supplemental = vis.behavior || vis.pgr || vis.candidate;
  return `<footer class="rp-footnote">
    <p>这是一次事后对照，不预测未来，也不构成投资建议。</p>
    ${supplemental ? '<p>补充图表和规则候选为候选口径，不进入已复核事实。</p>' : ''}
    ${vis.candidate ? '' : '<p>想把下一次的决定写成规则？<a href="#/me">去个人中心看看现有模板</a>。</p>'}
  </footer>`;
}

function renderBundle(host, bundle, ctx, bill) {
  const demo = isDemoBundle(bundle, bill);
  const source = `<div class="rp-status rp-status-top">${sourceChips(bundle, demo)}</div>`;
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
    } catch { /* 画像记录失败不阻断报告 */ }
  }
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
    ? `<p class="rp-caption">有 ${warnings.length} 条账单提示已按 0 或缺省口径处理，不影响已复核数字的可回查性。</p>`
    : '';

  host.innerHTML = `<div class="container report-body">
    ${source}
    ${deltaCard(bundle, bill, vis, demo)}
    ${vis.ghost ? ghostSection(bundle) : ''}
    ${vis.waterfall ? waterfallSection(bundle) : ''}
    ${vis.attribution ? attributionSection(bundle) : ''}
    ${vis.behavior ? behaviorSection(vis) : ''}
    <div class="rp-analysis-slot" data-role="behavior-analysis"></div>
    ${vis.pgr ? pgrSection(vis.pgrData) : ''}
    ${vis.candidate ? candidateSection(vis.candidates) : ''}
    ${vis.basis ? basisSection(bundle, demo) : ''}
    ${warningNote}
    ${footnote(vis)}
  </div>`;

  mountGhostChart(host, bundle);
  bindCandidateButtons(host, ctx, vis.candidates);
  hydrateBehaviorAnalysis(host, { bill, bundle, vis, profileKey });
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

function mountGhostChart(host, bundle) {
  const chartHost = host.querySelector('[data-role="ghost-chart"]');
  const select = host.querySelector('[data-role="cf-select"]');
  const dateSelect = host.querySelector('[data-role="cf-date"]');
  const summary = host.querySelector('[data-role="cf-summary"]');
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
      marketSource: { ...(bundle.marketSource ?? {}), dynamic: bundle.marketSource?.id === 'dynamic-tushare' },
      compact: true,
    });
    const dates = sandboxDates(cf);
    if (dateSelect) {
      dateSelect.innerHTML = dates.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
      dateSelect.value = dates[dates.length - 1] ?? '';
    }
    const point = cf.series.points[cf.series.points.length - 1] ?? null;
    if (summary) summary.textContent = sandboxText(point);
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

function renderError(host, message) {
  host.innerHTML = `<div class="container report-body"><section class="panel rp-blocked"><strong>报告加载失败</strong><p class="rp-note">${esc(message)}</p></section></div>`;
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

export function renderRealReport(host, bill, ctx = null) {
  if (!host || !bill) return;
  const key = bill.contextId || 'anonymous';
  const cached = cache.get(key);
  if (cached?.status === 'ready') {
    renderBundle(host, cached.bundle, ctx, bill);
    return;
  }
  if (cached?.status === 'error') {
    renderError(host, cached.message);
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
    })
    .catch((error) => {
      const message = String(error && error.message ? error.message : error);
      const target = liveHost();
      if (target) renderError(target, message);
    });
}

export function clearRealReportCache() { cache.clear(); }
