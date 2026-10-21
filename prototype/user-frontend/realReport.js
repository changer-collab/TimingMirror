// 真实账单报告：只把 adapter 已复核的结果与补充分析映射到新前端样式；不重算行情或指标。
// 边界：组合结果未发布时，不渲染图表的结论；行为、标的自身涨幅、PGR/PLR 均标注为候选补充口径。
import { loadUserBillReport } from '../../src/demo/adapter.js';
import { renderGhostChart } from '../../src/ui/components/ghostChart.js';
import { buildRuleCandidates } from '../../src/engine/userProfile.js';
import { recordReportObservation, ruleStateOf } from './profileStore.js';
import { openRuleCandidate } from './ruleCandidates.js';

const cache = new Map();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function displayOf(fact) {
  if (!fact) return '—';
  if (fact.display !== undefined && fact.display !== null) return String(fact.display);
  if (fact.value !== undefined && fact.value !== null) return String(fact.value);
  return '—';
}

function statusText(bundle) {
  const review = bundle.review;
  if (!review) return '复核未运行';
  if (review.portfolio_published) return '组合结果已发布';
  if (review.status === 'degraded') return '部分事实已发布';
  return '结果未发布';
}

function sourceChips(bundle) {
  const chips = [];
  if (bundle.fileName) chips.push(`账单：${bundle.fileName}（本机，未上传）`);
  if (bundle.dataMode?.label) chips.push(bundle.dataMode.label);
  if (bundle.marketSource?.label) chips.push(bundle.marketSource.label);
  if (bundle.asOfDate) chips.push(`行情截止日：${bundle.asOfDate}`);
  if (bundle.valuation?.effective_date) chips.push(`估值日：${bundle.valuation.requested_date} → ${bundle.valuation.effective_date}`);
  if (bundle.review) chips.push(`复核：${statusText(bundle)}`);
  return chips.map((text) => `<span class="rp-chip">${esc(text)}</span>`).join('');
}

function blockedBlock(bundle) {
  const review = bundle.review;
  const errors = Array.isArray(bundle.errors) ? bundle.errors : [];
  const blocked = Array.isArray(review?.blocked_facts) ? review.blocked_facts : [];
  const rows = [
    ...errors.map((e) => `<li>${e.line ? `第 ${e.line} 行 · ` : ''}${esc(e.message || e.code)}</li>`),
    ...blocked.slice(0, 12).map((f) => `<li>${esc(f.fact_id || '')} · ${esc((f.reason_codes || []).join('、') || f.reason_summary || '未发布')}</li>`),
  ];
  if (!rows.length) rows.push('<li>当前没有可发布的真实结果。</li>');
  return `<section class="panel rp-blocked">
    <p class="mono-label">REAL REPORT / 阻断</p>
    <h2 class="rp-blocked-title">${esc(statusText(bundle))}</h2>
    <p class="rp-note">不会用示例数字补齐。请到导入页核对账单，或在报告页查看行情/复核原因。</p>
    <ul class="rp-blocked-list">${rows.join('')}</ul>
  </section>`;
}

function sectionHead(idx, title, note) {
  return `<div class="report-sec-head"><div class="rs-title"><span class="rs-idx">${idx}</span><h2>${esc(title)}</h2></div><p>${esc(note)}</p></div>`;
}

function unavailableSection(idx, title, reason, note = '不生成未经复核的结论') {
  return `<section class="report-section rp-insight">
    ${sectionHead(idx, title, note)}
    <div class="rp-unavailable"><p><strong>本次不生成：</strong>${esc(reason || '补充分析不可用')}</p></div>
  </section>`;
}

function stockSelfCard(insights) {
  const pack = insights?.stock_self ?? null;
  const data = pack?.data ?? null;
  const value = data?.display?.ret ?? '—';
  let coverage = pack?.reason || '补充口径不可用';
  if (data?.coverage) {
    const available = Array.isArray(data.per_symbol) ? data.per_symbol.filter((p) => p.available).length : 0;
    const total = Array.isArray(data.per_symbol) ? data.per_symbol.length : 0;
    coverage = `覆盖 ${available}/${total} 只标的 · 按买入成本加权`;
    if (data.status === 'partial') coverage += '（部分缺价，组合值不发布）';
  }
  return `<article class="metric-card"><p class="m-idx">04 / STOCK SELF</p><p class="m-label">标的自身涨幅（候选）</p><p class="m-value">${esc(value)}</p><p class="m-desc">首次买入日收盘 → 估值日收盘；${esc(coverage)}。这不是“买入不动”，也不属于已复核发布事实。</p></article>`;
}

function ghostSection(bundle) {
  const pack = bundle.insights?.portfolio;
  if (!pack?.available) return unavailableSection('01', '单笔幽灵线', pack?.reason);
  const cfs = Array.isArray(pack.counterfactuals) ? pack.counterfactuals : [];
  if (!cfs.length) {
    return unavailableSection('01', '单笔幽灵线', '当前账单没有可替换的卖出笔：单笔反事实不适用，不虚构曲线。');
  }
  const list = [...cfs].reverse();
  const defaultIndex = Math.max(0, list.findIndex((cf) => cf.series?.complete !== false));
  const options = list.map((cf, i) => `<option value="${i}"${i === defaultIndex ? ' selected' : ''}>${esc(cf.trade_date)} ${esc(cf.symbol)} · 卖出 ${esc(cf.quantity)} 股 @ ${esc(cf.price)}</option>`).join('');
  const errors = Array.isArray(pack.counterfactual_errors) ? pack.counterfactual_errors : [];
  const errorNote = errors.length
    ? `<details class="rp-details"><summary>${errors.length} 笔反事实未能生成</summary><ul class="rp-evidence">${errors.slice(0, 8).map((e) => `<li>${esc(e.symbol || '')} ${esc(e.trade_id || '')} · ${esc(e.message)}</li>`).join('')}</ul></details>`
    : '';
  return `<section class="report-section rp-insight">
    ${sectionHead('01', '单笔幽灵线', '假如这笔卖出没有发生')}
    <p class="rp-note">同一标的、同一段行情，只替换所选卖出笔；该标的其余成交不变。曲线为单标的候选补充口径，不是组合已复核发布事实。</p>
    <label class="rp-control"><span>选择要替换的卖出笔</span><select class="rp-select" data-role="cf-select">${options}</select></label>
    <div class="rp-chart" data-role="ghost-chart"></div>
    ${errorNote}
  </section>`;
}

function waterfallSection(bundle) {
  const w = bundle.insights?.portfolio?.waterfall;
  if (!w) return unavailableSection('02', '收益瀑布', '组合指标未生成，瀑布不生成。');
  const span = Math.max(w.scale.max - w.scale.min, Number.EPSILON);
  const rows = w.items.map((item) => {
    const start = Math.min(item.bar_start, item.bar_end);
    const width = Math.abs(item.bar_end - item.bar_start);
    const leftPct = ((start - w.scale.min) / span) * 100;
    const widthPct = width > 0 ? Math.max((width / span) * 100, 0.6) : 0;
    return `<div class="wf-row">
      <div class="wf-label"><span>${esc(item.label)}</span><small>${esc(item.note)}</small></div>
      <div class="wf-track"><span class="wf-bar wf-${esc(item.kind)}" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"></span></div>
      <div class="wf-value"><strong>${esc(item.display.amount)}</strong><small>${esc(item.display.ratio)}</small></div>
    </div>`;
  }).join('');
  const identity = w.checks?.identity_ok === true;
  return `<section class="report-section rp-insight">
    ${sectionHead('02', '收益瀑布', '本金 → 买入不动 → 择时损耗 → 实际')}
    <div class="rp-waterfall">${rows}</div>
    <p class="rp-note">恒等式：${esc(w.formula_text)} · ${identity ? '加总已核对' : '加总未通过，不据此下结论'}。瀑布只重排已复核的组合数字；标的自身涨幅是另一张卡，不混入本瀑布。</p>
  </section>`;
}

function rankingSection(bundle) {
  const d = bundle.insights?.portfolio?.decomposition;
  if (!d) return unavailableSection('03', '损耗归因', '损耗分解未生成，不展示排行。');
  if (d.blocked) {
    return `<section class="report-section rp-insight">
      ${sectionHead('03', '损耗归因', '逐笔卖出与标的聚合')}
      <div class="rp-unavailable rp-warn"><p><strong>本次不发布：</strong>分解校验未通过。${esc((d.errors || []).map((e) => e.message).join('；'))}</p></div>
    </section>`;
  }
  const symbols = [...(d.by_symbol || [])].sort((a, b) => b.dragMoney - a.dragMoney);
  const items = (d.items || []).slice(0, 20);
  const symbolRows = symbols.map((s) => `<tr>
    <td>${esc(s.symbol)}</td>
    <td class="num ${s.dragMoney < 0 ? 'rp-good' : ''}">${esc(s.display.dragMoney)}</td>
    <td class="num">${esc(s.display.share)}</td>
    <td class="num">${esc(s.line_count)}</td>
  </tr>`).join('');
  const itemRows = items.map((it) => `<tr>
    <td>${esc(it.trade_date)}</td>
    <td>${esc(it.symbol)}</td>
    <td class="mono">${esc(it.trade_id)}</td>
    <td class="num">${esc(it.quantity)}</td>
    <td class="num">${esc(it.price)}</td>
    <td class="num">${esc(it.close)}</td>
    <td class="num ${it.dragMoney < 0 ? 'rp-good' : ''}">${esc(it.display.dragMoney)}</td>
    <td class="num">${esc(it.display.share)}</td>
  </tr>`).join('');
  const more = (d.items || []).length > items.length ? `<p class="rp-note">仅展示前 ${items.length} 笔；完整明细保留在本地复核结果中。</p>` : '';
  return `<section class="report-section rp-insight">
    ${sectionHead('03', '损耗归因', '逐笔卖出与标的聚合')}
    <p class="rp-note">损耗只来自卖出笔：卖出数量 ×（估值日收盘 − 卖出价）。占比以组合总损耗为分母（带符号）；负值表示该笔卖出反而优于买入不动。展示序按金额降序，不等于因果结论。</p>
    <h3 class="rp-subtitle">按标的</h3>
    <div class="table-wrap"><table class="ledger"><thead><tr><th>标的</th><th class="num">损耗金额</th><th class="num">占比</th><th class="num">卖出笔数</th></tr></thead><tbody>${symbolRows || '<tr><td colspan="4">没有卖出笔</td></tr>'}</tbody></table></div>
    <h3 class="rp-subtitle">逐笔卖出</h3>
    <div class="table-wrap"><table class="ledger"><thead><tr><th>日期</th><th>标的</th><th>成交 ID</th><th class="num">数量</th><th class="num">卖出价</th><th class="num">估值收盘</th><th class="num">损耗</th><th class="num">占比</th></tr></thead><tbody>${itemRows || '<tr><td colspan="8">没有卖出笔</td></tr>'}</tbody></table></div>
    ${more}
  </section>`;
}

function behaviorSection(bundle) {
  const pack = bundle.insights?.behavior;
  if (!pack?.available || !pack.data) return unavailableSection('04', '行为发现', pack?.reason);
  const data = pack.data;
  const pattern = data.patterns?.[0] ?? null;
  if (!pattern) return unavailableSection('04', '行为发现', '行为发现没有返回可展示的模式。');
  const tone = pattern.status === '成立' ? 'loss' : pattern.status === '不成立' ? 'ok' : 'mode';
  const evidence = Array.isArray(pattern.evidence) ? pattern.evidence : [];
  const evidenceList = evidence.length
    ? `<ul class="rp-evidence">${evidence.slice(0, 8).map((e) => `<li><span class="mono">${esc(e.trade_id)}</span> · ${esc(e.trade_date)} ${esc(e.symbol)} · 窗口涨幅 ${esc(e.display?.rise ?? '—')}</li>`).join('')}</ul>`
    : '<p class="rp-note">没有命中样本。</p>';
  return `<section class="report-section rp-insight">
    ${sectionHead('04', '行为发现', '样本数 + 成交证据 + 检验方式')}
    <div class="rp-behavior">
      <div class="rp-behavior-top"><span class="rp-badge ${tone}">${esc(pattern.status)}</span><strong>${esc(pattern.name)}</strong><span class="rp-meta">命中 ${esc(pattern.sample_n)} / 已评估 ${esc(pattern.evaluated_n)} / 最小样本 ${esc(pattern.min_samples)}</span></div>
      <p class="rp-note">${esc(pattern.conclusion)}</p>
      <p class="rp-rule-line">判定口径：${esc(pattern.rule?.side ?? '')}；${esc(pattern.rule?.window ?? '')}涨幅 ${esc(pattern.rule?.comparator ?? '')} ${esc(pattern.rule?.threshold_display ?? '')}</p>
      <p class="rp-note">${esc(pattern.check_method)}</p>
      ${evidenceList}
      <p class="rp-caveat">阈值与窗口是候选配置（${esc(pattern.threshold_meta?.config_version ?? '—')}），待负责人确认后替换；${esc(pattern.threshold_meta?.source ?? '')}。</p>
    </div>
  </section>`;
}

function pgrSection(bundle) {
  const pack = bundle.insights?.pgr;
  if (!pack?.available || !pack.data) return unavailableSection('05', '卖出倾向 PGR / PLR', pack?.reason);
  const data = pack.data;
  if (data.status === 'blocked') {
    return `<section class="report-section rp-insight">
      ${sectionHead('05', '卖出倾向 PGR / PLR', '处置效应候选口径')}
      <div class="rp-unavailable rp-warn"><p><strong>本次不发布：</strong>${esc((data.errors || []).map((e) => e.message).join('；'))}</p></div>
    </section>`;
  }
  const rc = data.counts?.realized ?? {};
  const pc = data.counts?.paper ?? {};
  return `<section class="report-section rp-insight">
    ${sectionHead('05', '卖出倾向 PGR / PLR', '处置效应候选口径')}
    <div class="rp-pgr-grid">
      <div class="rp-pgr-card"><span>PGR（盈利卖出倾向）</span><strong>${esc(data.display?.pgr ?? '—')}</strong><small>已实现盈利 /（已实现盈利 + 纸面盈利）</small></div>
      <div class="rp-pgr-card"><span>PLR（亏损卖出倾向）</span><strong>${esc(data.display?.plr ?? '—')}</strong><small>已实现亏损 /（已实现亏损 + 纸面亏损）</small></div>
      <div class="rp-pgr-card"><span>DE = PGR − PLR</span><strong>${esc(data.display?.de ?? '—')}</strong><small>正值＝盈利卖出比例高于亏损卖出比例</small></div>
    </div>
    <div class="table-wrap"><table class="ledger"><thead><tr><th>计数</th><th class="num">盈利</th><th class="num">亏损</th><th class="num">零盈亏</th><th class="num">合计</th></tr></thead><tbody>
      <tr><td>已实现（卖出笔）</td><td class="num">${esc(rc.gain ?? 0)}</td><td class="num">${esc(rc.loss ?? 0)}</td><td class="num">${esc(rc.flat ?? 0)}</td><td class="num">${esc(rc.total ?? 0)}</td></tr>
      <tr><td>纸面（持仓数）</td><td class="num">${esc(pc.gain ?? 0)}</td><td class="num">${esc(pc.loss ?? 0)}</td><td class="num">${esc(pc.flat ?? 0)}</td><td class="num">${esc(pc.total ?? 0)}</td></tr>
    </tbody></table></div>
    <p class="rp-note">参考均值：${esc(data.benchmarks?.cn?.label ?? '—')}（${esc(data.benchmarks?.cn?.source ?? '')}）；${esc(data.benchmarks?.us?.label ?? '—')}（${esc(data.benchmarks?.us?.source ?? '')}）。</p>
    <p class="rp-caveat">${esc((data.notes || []).join(' '))}</p>
  </section>`;
}

function candidateSection(pack) {
  const c = pack?.candidates?.[0] ?? null;
  if (!c) {
    return `<section class="report-section rp-insight">
      ${sectionHead('06', '规则候选', '由报告证据映射到既有模板')}
      <p class="rp-note">${esc(pack?.notes?.[0] ?? '当前没有规则候选。')}</p>
      <a class="btn btn-outline" href="#/rules">打开规则页</a>
    </section>`;
  }
  const tone = c.status === 'available' ? 'loss' : c.status === 'active' ? 'ok' : 'mode';
  const action = c.status === 'available'
    ? '<button class="btn btn-primary" type="button" data-open-candidate>用这个阈值打开规则编辑</button>'
    : c.status === 'active'
      ? '<a class="btn btn-outline" href="#/rules">查看当前规则</a>'
      : c.status === 'dismissed'
        ? '<a class="btn btn-outline" href="#/rules">到规则页恢复候选</a>'
        : '';
  const evidence = (c.evidence || []).length
    ? `<ul class="rp-evidence">${c.evidence.map((e) => `<li><span class="mono">${esc(e.trade_id)}</span> · ${esc(e.line)}</li>`).join('')}</ul>`
    : '';
  return `<section class="report-section rp-insight">
    ${sectionHead('06', '规则候选', '由报告证据映射到既有模板')}
    <div class="rp-candidate">
      <div class="rp-candidate-top"><span class="rp-badge ${tone}">${esc(c.status_text)}</span><strong>${esc(c.template_name)}</strong></div>
      <p class="rp-candidate-text">${esc(c.text)}</p>
      <p class="rp-note">${esc(c.reason)}</p>
      <p class="rp-note">${esc(c.basis)}</p>
      ${evidence}
      <p class="rp-caveat">${esc(c.caveat)}</p>
      ${action}
    </div>
    <p class="rp-caveat">候选只来自当前账单的行为证据与本地规则记录；不来自 LLM，也不来自其他用户。保存前由你在规则页确认或改写。</p>
  </section>`;
}

function factsTable(bundle, idx) {
  const published = Array.isArray(bundle.review?.published_facts) ? bundle.review.published_facts : [];
  const scopes = new Map();
  for (const fact of published) {
    const scope = fact.scope || 'portfolio';
    if (!scopes.has(scope)) scopes.set(scope, []);
    scopes.get(scope).push(fact);
  }
  const parts = [];
  for (const [scope, facts] of scopes) {
    const rows = facts.map((f) => `<tr>
      <td>${esc(f.key || f.fact_id)}</td>
      <td class="num">${esc(displayOf(f))}</td>
      <td class="mono">${esc(f.formula_id || '—')}</td>
    </tr>`).join('');
    parts.push(`<details class="evidence-item" ${scope === 'portfolio' ? 'open' : ''}>
      <summary><span class="ev-idx">${scope === 'portfolio' ? '组合' : esc(scope)}</span><h3>已发布事实 ${facts.length} 项</h3><span class="ev-plus">+</span></summary>
      <div class="evidence-body table-wrap">
        <table class="ledger"><thead><tr><th>事实</th><th class="num">结果</th><th>公式</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </details>`);
  }
  return parts.length ? `<section class="report-section"><div class="report-sec-head"><div class="rs-title"><span class="rs-idx">${idx}</span><h2>已发布事实与证据</h2></div><p>只列复核通过的事实</p></div><div class="evidence-list">${parts.join('')}</div></section>` : '';
}

function observationLine(observation) {
  if (!observation) return '';
  if (observation.recorded) {
    return `<p class="rp-note rp-observed">本次观察已记入本地画像（累计 ${esc(observation.profile?.observations ?? 0)} 次）。画像只存派生统计，不含成交明细或文件名。</p>`;
  }
  return `<p class="rp-note">${esc(observation.reason || '本次未更新画像')}</p>`;
}

function renderBundle(host, bundle, ctx, bill) {
  const portfolio = bundle.factsByScope?.portfolio ?? {};
  const published = bundle.review?.portfolio_published === true;
  const errors = Array.isArray(bundle.errors) ? bundle.errors : [];
  const warnings = Array.isArray(bundle.warnings) ? bundle.warnings : [];
  const source = `<div class="rp-status rp-status-top">${sourceChips(bundle)}</div>`;
  if (!published) {
    host.innerHTML = `<div class="container report-body">${source}${blockedBlock(bundle)}</div>`;
    return;
  }

  const insights = bundle.insights ?? {};
  const ruleState = ruleStateOf(ctx?.state?.contracts?.versions);
  let observation = null;
  try {
    observation = recordReportObservation({ bundle, bill, ruleState });
  } catch (e) {
    observation = { recorded: false, reason: `画像未更新：${String(e && e.message ? e.message : e)}`, profile: null };
  }
  const profile = observation?.profile ?? null;
  let candidatePack = null;
  try {
    candidatePack = buildRuleCandidates({
      behavior: insights.behavior?.available ? insights.behavior.data : null,
      ruleState,
      profile,
    });
  } catch {
    candidatePack = { candidates: [], notes: ['规则候选生成失败：不生成候选。'] };
  }
  const candidate = candidatePack.candidates?.[0] ?? null;

  const actual = portfolio.actualRet;
  const ghost = portfolio.ghostRet;
  const drag = portfolio.drag;
  const dragMoney = portfolio.dragMoney;
  const issueBlock = errors.length || warnings.length
    ? `<section class="panel rp-issues">
        ${errors.length ? `<p><strong>阻断：</strong>${esc(errors.map((e) => e.message || e.code).join('；'))}</p>` : ''}
        ${warnings.length ? `<p class="rp-note">警告：${esc(warnings.map((w) => w.message || w.code).join('；'))}</p>` : ''}
      </section>` : '';

  host.innerHTML = `<div class="container report-body">
    ${source}${issueBlock}
    <section class="delta-card reveal" aria-labelledby="real-delta-title">
      <div class="delta-main">
        <p class="delta-eyebrow">REAL BILL / 同尺对比</p>
        <p class="delta-label" id="real-delta-title">实际结果与买入不动的对照</p>
        <p class="delta-number">${esc(displayOf(dragMoney))}</p>
        <p class="delta-note">金钱差额来自已复核事实；不使用示例数字。正值表示相对买入不动少赚，负值表示相对更好。</p>
      </div>
      <div class="delta-side">
        <div class="delta-stat"><span>实际收益</span><strong>${esc(displayOf(actual))}</strong><small>已复核</small></div>
        <div class="delta-stat"><span>买入不动</span><strong>${esc(displayOf(ghost))}</strong><small>对照路径</small></div>
        <div class="delta-stat"><span>择时损耗</span><strong class="orange">${esc(displayOf(drag))}</strong><small>${esc(displayOf(dragMoney))}</small></div>
      </div>
    </section>

    <div class="metric-grid">
      <article class="metric-card"><p class="m-idx">01 / ACTUAL</p><p class="m-label">实际收益</p><p class="m-value">${esc(displayOf(actual))}</p><p class="m-desc">来自已复核的本地账单结果</p></article>
      <article class="metric-card"><p class="m-idx">02 / BUY &amp; HOLD</p><p class="m-label">对照收益</p><p class="m-value">${esc(displayOf(ghost))}</p><p class="m-desc">买入后持有不动的对照路径</p></article>
      <article class="metric-card"><p class="m-idx">03 / TIMING GAP</p><p class="m-label">择时损耗</p><p class="m-value accent">${esc(displayOf(drag))}</p><p class="m-sub">${esc(displayOf(dragMoney))}</p><p class="m-desc">对照 − 实际；不评价单笔决定</p></article>
      ${stockSelfCard(insights)}
    </div>
    ${observationLine(observation)}

    ${ghostSection(bundle)}
    ${waterfallSection(bundle)}
    ${rankingSection(bundle)}
    ${behaviorSection(bundle)}
    ${pgrSection(bundle)}
    ${candidateSection(candidatePack)}
    ${factsTable(bundle, '07')}

    <div class="boundary" style="margin-top:24px">
      <h3>这份报告没有告诉你的事</h3>
      <div class="boundary-grid">
        <div><b>真实账单</b>本页只展示当前已确认账单的复核结果，不填充原型示例数字。</div>
        <div><b>候选补充口径</b>标的自身涨幅、单笔幽灵线、PGR/PLR 与行为发现是补充分析，未进入复核发布链路，不能当作已发布事实引用。</div>
        <div><b>画像与规则</b>画像只保存在当前浏览器；规则候选须由你确认或改写后才生效，系统不替你定规矩。</div>
        <div><b>不构成建议</b>这是对已发生交易的事后对照，不预测未来，也不替你决定。</div>
      </div>
    </div>
  </div>`;

  mountGhostChart(host, bundle);
  bindCandidateButton(host, ctx, candidate);
}

function mountGhostChart(host, bundle) {
  const chartHost = host.querySelector('[data-role="ghost-chart"]');
  const select = host.querySelector('[data-role="cf-select"]');
  const cfs = bundle.insights?.portfolio?.counterfactuals;
  if (!chartHost || !Array.isArray(cfs) || !cfs.length) return;
  const list = [...cfs].reverse();
  const draw = (index) => {
    const cf = list[index] ?? list[0];
    chartHost.replaceChildren();
    renderGhostChart(chartHost, {
      series: cf.series,
      markers: cf.markers,
      marketSource: { ...(bundle.marketSource ?? {}), dynamic: bundle.marketSource?.id === 'dynamic-tushare' },
    });
  };
  const defaultIndex = Math.max(0, list.findIndex((cf) => cf.series?.complete !== false));
  draw(defaultIndex);
  if (select) select.addEventListener('change', () => draw(Number(select.value)));
}

function bindCandidateButton(host, ctx, candidate) {
  const button = host.querySelector('[data-open-candidate]');
  if (!button || !candidate || !ctx) return;
  button.addEventListener('click', () => { openRuleCandidate(ctx, candidate); });
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
