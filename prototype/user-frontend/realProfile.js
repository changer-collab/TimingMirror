// 个人中心顶部：本地用户画像 + 规则候选（非 Agent）。
// 画像只从已复核报告、行为发现与规则使用记录派生；只存本地、不含成交明细或文件名。
import { buildRuleCandidates } from '../../src/engine/userProfile.js';
import { loadRealReport, getRealReportBundle } from './realReport.js';
import {
  loadProfile, recordReportObservation, recordCandidateEvent, ruleStateOf, syncRuleUsage,
} from './profileStore.js';
import { openRuleCandidate } from './ruleCandidates.js';
import { mountCloudProfile } from './cloudProfile.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtAt(at) {
  if (!at) return '—';
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? String(at) : d.toLocaleString('zh-CN');
}

function fmtDelta(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v}`;
}

function emptyState(reason = '先导入并确认一份本地账单，画像才会从已复核报告开始积累。') {
  return `<section class="rp-profile rp-profile-empty">
    <p class="mono-label">PROFILE / 本地画像</p>
    <h2>先有账单，再有画像。</h2>
    <p class="rp-note">${esc(reason)}</p>
    <p class="rp-note">没有账单时不会用示例数据填充；本地画像只保存在当前浏览器，云端只保存账单统计、报告快照与你主动选择记入的画像事实。</p>
    <a class="btn btn-outline" href="#/import">去导入账单</a>
  </section>`;
}

function mountCloud(host, ctx, profile = null) {
  if (typeof ctx?.cloudDeps?.listBills !== 'function') return;
  const section = document.createElement('section');
  section.className = 'rp-profile rp-cloud-profile';
  section.setAttribute('aria-label', '云端画像');
  const inner = document.createElement('div');
  inner.setAttribute('data-role', 'cloud-profile');
  section.append(inner);
  host.append(section);
  mountCloudProfile(inner, ctx, { profile });
}

function dimensionCards(snapshot) {
  const rows = Array.isArray(snapshot?.dimensions) ? snapshot.dimensions : [];
  return `<div class="rp-dim-grid">${rows.map((d) => `<article class="rp-dim" data-dim="${esc(d.key)}">
    <p class="rp-dim-label">${esc(d.label)}</p>
    <p class="rp-dim-value">${esc(d.value)}</p>
    <p class="rp-dim-note">${esc(d.note)}</p>
  </article>`).join('')}</div>`;
}

function tagsBlock(snapshot) {
  const tags = Array.isArray(snapshot?.tags) ? snapshot.tags : [];
  if (!tags.length) return '';
  return `<div class="rp-profile-tags">
    <span class="rp-subtitle">画像标签</span>
    <div class="rp-tag-list">${tags.map((t) => `<span class="rp-tag" data-tag="${esc(t.tag_id)}" title="${esc(t.evidence)}">${esc(t.label)}</span>`).join('')}</div>
    <p class="rp-note">标签由行为发现和处置倾向自动派生，只描述模式，不评价交易好坏。</p>
  </div>`;
}

function historyBlock(profile) {
  const history = Array.isArray(profile?.history) ? profile.history : [];
  if (!history.length) return '<p class="rp-note">还没有历史观察。每打开一次已发布的真实报告，会记录一次派生统计。</p>';
  const rows = [...history].slice(-6).reverse().map((h) => `<tr>
    <td>${esc(fmtAt(h.at))}</td>
    <td class="num">${esc(h.trade_count)}</td>
    <td class="num">${esc(h.display?.drag_money ?? '—')}</td>
    <td class="num">${esc(h.display?.actual_ret ?? '—')}</td>
    <td class="num">${esc(h.display?.ghost_ret ?? '—')}</td>
    <td class="num">${esc(h.behavior_n ?? '—')}</td>
    <td class="num">${esc(h.rule_count ?? 0)}</td>
  </tr>`).join('');
  return `<div class="rp-profile-history">
    <h3 class="rp-subtitle">最近观察（${history.length} 条，最多保留 12 条）</h3>
    <div class="table-wrap"><table class="ledger"><thead><tr><th>观察时间</th><th class="num">成交</th><th class="num">损耗金额</th><th class="num">实际收益</th><th class="num">买入不动</th><th class="num">行为命中</th><th class="num">规则</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}

function trendBlock(profile) {
  const t = profile?.trend;
  if (!t) return '';
  const items = [
    ['择时损耗差额', t.drag_money_delta_display ?? '—'],
    ['成交笔数变化', fmtDelta(t.trade_count_delta)],
    ['行为命中样本变化', fmtDelta(t.behavior_n_delta)],
    ['生效规则变化', fmtDelta(t.rule_count_delta)],
  ];
  return `<div class="rp-trend"><span class="rp-trend-title">与上一次观察相比</span>${items.map(([k, v]) => `<span class="rp-trend-item"><small>${esc(k)}</small><strong>${esc(v)}</strong></span>`).join('')}</div>`;
}

function candidateCard(c) {
  const tone = c.status === 'available' ? 'loss' : c.status === 'active' ? 'ok' : 'mode';
  const actions = [];
  if (c.status === 'available') {
    actions.push(`<button class="btn btn-primary" type="button" data-candidate-action="open" data-candidate-id="${esc(c.candidate_id)}">打开模板确认</button>`);
    actions.push(`<button class="btn btn-ghost" type="button" data-candidate-action="dismiss" data-candidate-id="${esc(c.candidate_id)}">忽略这条候选</button>`);
  } else if (c.status === 'dismissed') {
    actions.push(`<button class="btn btn-outline" type="button" data-candidate-action="restore" data-candidate-id="${esc(c.candidate_id)}">恢复候选</button>`);
  } else if (c.status === 'active') {
    actions.push('<button class="btn btn-outline" type="button" data-scroll-rules>查看当前规则</button>');
  }
  const evidence = (c.evidence || []).length
    ? `<ul class="rp-evidence">${c.evidence.map((e) => `<li><span class="mono">${esc(e.trade_id)}</span> · ${esc(e.line)}</li>`).join('')}</ul>`
    : '';
  return `<article class="rp-candidate" data-candidate-id="${esc(c.candidate_id)}">
    <div class="rp-candidate-top"><span class="rp-badge ${tone}">${esc(c.status_text)}</span><strong>${esc(c.template_name)}</strong></div>
    <p class="rp-candidate-text">${esc(c.text)}</p>
    <p class="rp-note">${esc(c.reason)}</p>
    <p class="rp-note">${esc(c.basis)}</p>
    ${evidence}
    <p class="rp-caveat">${esc(c.caveat)}</p>
    ${actions.length ? `<div class="rp-actions">${actions.join('')}</div>` : ''}
  </article>`;
}

function candidatesBlock(pack) {
  const candidates = Array.isArray(pack?.candidates) ? pack.candidates : [];
  const notes = Array.isArray(pack?.notes) ? pack.notes : [];
  const visible = candidates.filter((c) => c.status !== 'not_recommended');
  const notRecommended = candidates.filter((c) => c.status === 'not_recommended');
  return `<div class="rp-profile-candidates">
    <h3 class="rp-subtitle">规则候选（来自本账单证据）</h3>
    <p class="rp-note">候选只做模板预填；保存前由你确认或改写，系统不替你定规矩。${notes[0] ? ` ${notes[0]}` : ''}</p>
    ${visible.length ? visible.map(candidateCard).join('') : '<p class="rp-note">当前没有可建立的规则候选。</p>'}
    ${notRecommended.length ? `<details class="rp-details" data-role="not-recommended">
      <summary>${notRecommended.length} 条行为模式尚未达到可建规则的条件</summary>
      ${notRecommended.map(candidateCard).join('')}
    </details>` : ''}
  </div>`;
}

function observationLine(observation, profile, published) {
  if (!published) return `<p class="rp-note rp-warn-line">${esc(observation?.reason || '当前账单组合结果未发布：本次不更新画像。')}</p>`;
  if (observation?.recorded) {
    return `<p class="rp-note rp-observed">本次观察已记入画像（累计 ${esc(profile?.observations ?? 0)} 次）。</p>`;
  }
  return `<p class="rp-note">${esc(observation?.reason || '本次报告已包含在画像中。')}</p>`;
}

function bindActions(host, ctx, candidates, refresh) {
  host.querySelectorAll('[data-candidate-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-candidate-id');
      const action = button.getAttribute('data-candidate-action');
      const candidate = candidates.find((c) => c.candidate_id === id);
      if (!candidate) return;
      if (action === 'open') {
        openRuleCandidate(ctx, candidate);
        return;
      }
      if (action === 'dismiss') recordCandidateEvent(id, 'dismissed');
      if (action === 'restore') recordCandidateEvent(id, 'restored');
      refresh();
    });
  });
  host.querySelectorAll('[data-scroll-rules]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = document.getElementById('tm-real-rules');
      if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderProfile(host, ctx, bundle, bill) {
  const ruleState = ruleStateOf(ctx?.state?.contracts?.versions);
  let observation = null;
  try {
    observation = recordReportObservation({ bundle, bill, ruleState });
  } catch (e) {
    observation = { profile: loadProfile(), snapshot: null, recorded: false, reason: `画像未更新：${String(e && e.message ? e.message : e)}` };
  }
  let profile = observation.profile ?? loadProfile();
  try {
    profile = syncRuleUsage(ruleState);
  } catch { /* 规则同步失败不阻断规则页 */ }

  const published = bundle.review?.portfolio_published === true;
  const snapshot = observation.snapshot;
  const viewSnapshot = profile.latest && snapshot && profile.latest.profile_key === snapshot.profile_key
    ? profile.latest
    : snapshot;
  const shown = published && viewSnapshot ? viewSnapshot : profile.latest;

  if (!shown) {
    host.innerHTML = emptyState(published
      ? '本次报告没有可用于画像的统计。'
      : '当前账单组合结果未发布，还没有可展示的历史画像；修复账单并打开报告页后才会记录。');
    mountCloud(host, ctx);
    return;
  }

  let pack = null;
  try {
    pack = buildRuleCandidates({
      behavior: published && bundle.insights?.behavior?.available ? bundle.insights.behavior.data : null,
      ruleState,
      profile,
    });
  } catch {
    pack = { candidates: [], notes: ['这次暂时没有可生成的规则候选。'] };
  }
  const candidates = pack.candidates ?? [];
  const banner = published
    ? ''
    : '<p class="rp-note rp-warn-line">当前账单组合结果未发布：本次不记入画像；以下为最近一次已发布观察形成的画像，不是当前账单的结论。</p>';

  host.innerHTML = `<section class="rp-profile">
    <div class="rp-profile-head">
      <div>
        <p class="mono-label">PROFILE / 本地画像</p>
        <h2>你的交易习惯，正在被连续记录。</h2>
        <p class="rp-note">只从已复核报告、行为发现与规则使用记录派生；本地画像不含成交明细、文件名或 CSV。云端只保存账单统计、报告快照与你主动记入的画像事实。</p>
      </div>
      <div class="rp-profile-stat"><strong>${esc(profile.observations ?? 0)}</strong><span>次观察</span></div>
    </div>
    ${banner}
    ${observationLine(observation, profile, published)}
    <p class="rp-note rp-profile-meta">画像更新于：${esc(fmtAt(shown.at))} · 账单覆盖 ${esc(shown.bill?.trade_count ?? '—')} 笔 / ${esc(shown.bill?.symbol_count ?? '—')} 只标的</p>
    ${dimensionCards(shown)}
    ${tagsBlock(shown)}
    ${trendBlock(profile)}
    ${historyBlock(profile)}
    ${candidatesBlock(pack)}
  </section>`;

  bindActions(host, ctx, candidates, () => renderProfile(host, ctx, bundle, bill));
  mountCloud(host, ctx, profile);
}

export function renderRealProfile(host, ctx) {
  if (!host) return;
  const bill = ctx?.state?.bill;
  if (!bill || bill.status !== 'confirmed' || bill.sourceType !== 'local') {
    host.innerHTML = emptyState();
    mountCloud(host, ctx);
    return;
  }
  if (bill.demo === true) {
    host.innerHTML = emptyState('示例场景只用于演示，不写入画像；导入并确认自己的账单后才会开始记录。');
    mountCloud(host, ctx);
    return;
  }
  const cached = getRealReportBundle(bill);
  if (cached) {
    renderProfile(host, ctx, cached, bill);
    return;
  }
  host.innerHTML = '<section class="rp-profile"><p class="rp-loading">正在根据已确认账单生成画像…</p></section>';
  mountCloud(host, ctx, loadProfile());
  loadRealReport(bill)
    .then((bundle) => {
      const target = document.getElementById('tm-real-profile');
      if (!target || ctx?.state?.bill?.contextId !== bill.contextId) return;
      renderProfile(target, ctx, bundle, bill);
    })
    .catch((error) => {
      const target = document.getElementById('tm-real-profile');
      if (!target) return;
      const message = String(error && error.message ? error.message : error);
      target.innerHTML = `<section class="rp-profile"><p class="mono-label">PROFILE / 本地画像</p><h2>画像暂不可用</h2><p class="rp-note">${esc(message)}</p><p class="rp-note">画像只从已复核报告派生，行情或复核失败时不会用示例数据补齐。</p></section>`;
      mountCloud(target, ctx, loadProfile());
    });
}
