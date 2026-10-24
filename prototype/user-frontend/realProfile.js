// 个人中心顶部：云端画像与画像解读；云端账单单独成段（非 Agent）。
// 画像从云端账单快照恢复，只含派生统计，不含成交明细或文件名。
import { loadRealReport, getRealReportBundle } from './realReport.js';
import {
  loadProfile, recordReportObservation, ruleStateOf, syncRuleUsage,
} from './profileStore.js';
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

function cloudBillsSection() {
  return `<section class="rp-profile rp-cloud-bills" aria-label="跨账单记录">
    <div class="rp-profile-head">
      <div>
        <p class="mono-label">CLOUD / 云端账单</p>
        <h2>跨账单记录</h2>
        <p class="rp-note">只显示云端账单；原始 CSV 与文件名不上传。</p>
      </div>
    </div>
    <div data-role="cloud-bills"></div>
  </section>`;
}

function emptyState(reason = '导入并确认一份账单，画像才会从已复核报告开始积累。') {
  return `<section class="rp-profile rp-profile-empty rp-main">
    <p class="mono-label">PROFILE / 云端画像</p>
    <h2>先有账单，再有画像。</h2>
    <p class="rp-note">${esc(reason)}</p>
    <p class="rp-note">没有账单时不会用示例数据填充；画像、账单与规则都保存在云端，本机不保存用户数据，也不会保存原始 CSV 与文件名。</p>
    <a class="btn btn-outline" href="#/import">去导入账单</a>
    <div data-role="cloud-summary"></div>
  </section>
  ${cloudBillsSection()}`;
}

function mountCloud(host, ctx, profile = null) {
  if (typeof ctx?.cloudDeps?.listBills !== 'function') return;
  mountCloudProfile({
    summary: host.querySelector('[data-role="cloud-summary"]'),
    bills: host.querySelector('[data-role="cloud-bills"]'),
  }, ctx, { profile });
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

function observationLine(observation, profile, published) {
  if (!published) return `<p class="rp-note rp-warn-line">${esc(observation?.reason || '当前账单组合结果未发布：本次不更新画像。')}</p>`;
  if (observation?.recorded) {
    return `<p class="rp-note rp-observed">本次观察已记入画像（累计 ${esc(profile?.observations ?? 0)} 次）。</p>`;
  }
  return `<p class="rp-note">${esc(observation?.reason || '本次报告已包含在画像中。')}</p>`;
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

  const banner = published
    ? ''
    : '<p class="rp-note rp-warn-line">当前账单组合结果未发布：本次不记入画像；以下为最近一次已发布观察形成的画像，不是当前账单的结论。</p>';

  host.innerHTML = `<section class="rp-profile rp-main">
    <div class="rp-profile-head">
      <div>
        <p class="mono-label">PROFILE / 云端画像</p>
        <h2>你的交易习惯，正在被连续记录。</h2>
        <p class="rp-note">每次进入页面都会从云端报告快照恢复画像；只含派生统计，不含原始 CSV 或文件名。</p>
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
    <div data-role="cloud-summary"></div>
  </section>
  ${cloudBillsSection()}`;

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
  host.innerHTML = `<section class="rp-profile rp-main">
    <p class="rp-loading">正在根据已确认账单生成画像…</p>
    <div data-role="cloud-summary"></div>
  </section>
  ${cloudBillsSection()}`;
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
      const inner = `<p class="mono-label">PROFILE / 云端画像</p><h2>画像暂不可用</h2><p class="rp-note">${esc(message)}</p><p class="rp-note">画像只从已复核报告派生，行情或复核失败时不会用示例数据补齐。</p>`;
      // 只替换本机画像位，保留已挂载的画像解读节点（避免重挂丢失自动生成的解读）。
      const section = target.querySelector('section.rp-profile.rp-main');
      const summaryHost = section?.querySelector('[data-role="cloud-summary"]');
      if (section && summaryHost) {
        section.innerHTML = inner;
        section.append(summaryHost);
        return;
      }
      target.innerHTML = `<section class="rp-profile rp-main">${inner}</section>${cloudBillsSection()}`;
      mountCloud(target, ctx, loadProfile());
    });
}
