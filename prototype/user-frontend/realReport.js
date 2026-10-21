// 真实账单报告：只把 adapter 已复核的结果映射到新前端样式；不重算行情或指标。
import { loadUserBillReport } from '../../src/demo/adapter.js';

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
  return `<section class="panel" style="padding:18px;border-left:3px solid var(--loss)">
    <p class="mono-label">REAL REPORT / 阻断</p>
    <h2 style="margin:8px 0 6px">${esc(statusText(bundle))}</h2>
    <p class="muted">不会用示例数字补齐。请到导入页核对账单，或在报告页查看行情/复核原因。</p>
    <ul style="margin:12px 0 0 18px;color:var(--ink-soft)">${rows.join('')}</ul>
  </section>`;
}

function factsTable(bundle) {
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
  return parts.length ? `<section class="report-section"><div class="report-sec-head"><div class="rs-title"><span class="rs-idx">03</span><h2>已发布事实与证据</h2></div><p>只列复核通过的事实</p></div><div class="evidence-list">${parts.join('')}</div></section>` : '';
}

function renderBundle(host, bundle) {
  const portfolio = bundle.factsByScope?.portfolio ?? {};
  const published = bundle.review?.portfolio_published === true;
  const errors = Array.isArray(bundle.errors) ? bundle.errors : [];
  const warnings = Array.isArray(bundle.warnings) ? bundle.warnings : [];
  const source = `<div class="rp-status" style="margin:0 0 18px">${sourceChips(bundle)}</div>`;
  if (!published) {
    host.innerHTML = `<div class="container report-body">${source}${blockedBlock(bundle)}</div>`;
    return;
  }
  const actual = portfolio.actualRet;
  const ghost = portfolio.ghostRet;
  const drag = portfolio.drag;
  const dragMoney = portfolio.dragMoney;
  const issueBlock = errors.length || warnings.length
    ? `<section class="panel" style="padding:16px 18px;margin-bottom:18px">
        ${errors.length ? `<p><strong>阻断：</strong>${esc(errors.map((e) => e.message || e.code).join('；'))}</p>` : ''}
        ${warnings.length ? `<p class="muted">警告：${esc(warnings.map((w) => w.message || w.code).join('；'))}</p>` : ''}
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
      <article class="metric-card"><p class="m-idx">04 / COST</p><p class="m-label">买入成本</p><p class="m-value">${esc(displayOf(portfolio.buyCost))}</p><p class="m-desc">已复核事实；费用税费口径见下方证据</p></article>
    </div>

    ${factsTable(bundle)}

    <div class="boundary" style="margin-top:24px">
      <h3>这份报告没有告诉你的事</h3>
      <div class="boundary-grid">
        <div><b>真实账单</b>本页只展示当前已确认账单的复核结果，不填充原型示例数字。</div>
        <div><b>未展示的视图</b>示例图表、分时走势和未生成口径不在这里补造；需要时会在后续版本补齐。</div>
        <div><b>不构成建议</b>这是对已发生交易的事后对照，不预测未来，也不替你决定。</div>
      </div>
    </div>
  </div>`;
}

export function renderRealReport(host, bill) {
  if (!host || !bill) return;
  const key = bill.contextId || 'anonymous';
  const cached = cache.get(key);
  if (cached?.status === 'ready') {
    renderBundle(host, cached.bundle);
    return;
  }
  if (cached?.status === 'error') {
    host.innerHTML = `<div class="container report-body"><section class="panel" style="padding:18px"><strong>报告加载失败</strong><p class="muted">${esc(cached.message)}</p></section></div>`;
    return;
  }
  if (cached?.status === 'loading') {
    host.innerHTML = '<div class="container report-body"><p class="rp-loading">正在读取已确认账单的真实结果…</p></div>';
    return;
  }
  const liveHost = () => document.getElementById('tm-real-report');
  cache.set(key, { status: 'loading' });
  host.innerHTML = '<div class="container report-body"><p class="rp-loading">正在读取已确认账单的真实结果…</p></div>';
  loadUserBillReport(bill)
    .then((bundle) => {
      cache.set(key, { status: 'ready', bundle });
      const target = liveHost();
      if (target) renderBundle(target, bundle);
    })
    .catch((error) => {
      const message = String(error && error.message ? error.message : error);
      cache.set(key, { status: 'error', message });
      const target = liveHost();
      if (target) {
        target.innerHTML = `<div class="container report-body"><section class="panel" style="padding:18px"><strong>报告加载失败</strong><p class="muted">${esc(message)}</p></section></div>`;
      }
    });
}

export function clearRealReportCache() { cache.clear(); }
