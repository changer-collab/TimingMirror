// 个人中心云端区块：账单历史、对话事实、AI 画像解读。
// 云端失败不回退演示数据；本机画像、报告与规则继续可用。
import {
  buildProfileDigest, profileDigestHash, profileSummaryIsFresh,
} from '../../src/agent/profileDigest.js';
import {
  cloudProfileFromBills, normalizeCloudBills, normalizeCloudFacts, summaryFallbackText,
  summaryResponseView, validSummaryValue,
} from '../../src/agent/cloudProfileModel.js';
import { markCloudBillRemoved } from './cloudSync.js';

const CACHE_TTL_MS = 15000;
const FACT_KIND_LABELS = Object.freeze({
  goal: '目标',
  preference: '偏好',
  constraint: '约束',
  habit: '习惯',
  risk_tolerance: '风险承受',
});
const CONFIDENCE_LABELS = Object.freeze({ high: '较高', medium: '中等', low: '偏低' });

let cache = { status: 'idle', at: 0, data: null, error: null, promise: null };
let confirmTimer = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtAt(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function cloudErrorMessage(error) {
  const code = error?.upstreamCode ?? error?.code ?? '';
  if (code === 'database_unavailable') return '云端数据库暂未启用。';
  if (code === 'login_required' || code === 'invalid_user_context') return '当前没有云端身份。';
  if (code === 'not_found') return '这条云端记录已经不存在。';
  return '云端记录读取失败。';
}

export function invalidateCloudProfile() {
  cache = { status: 'idle', at: 0, data: null, error: null, promise: null };
}

function ensureData(ctx, { force = false } = {}) {
  if (force) invalidateCloudProfile();
  if (cache.status === 'ready' && Date.now() - cache.at < CACHE_TTL_MS) {
    return Promise.resolve(cache.data);
  }
  if (cache.status === 'loading' && cache.promise) return cache.promise;
  cache = { status: 'loading', at: Date.now(), data: null, error: null, promise: null };
  const promise = Promise.all([
    ctx.cloudDeps.listBills({ limit: 20 }),
    ctx.cloudDeps.getProfile(),
  ]).then(([billPayload, profilePayload]) => {
    const summary = validSummaryValue(profilePayload?.summary);
    const data = {
      bills: normalizeCloudBills(billPayload),
      facts: normalizeCloudFacts(profilePayload),
      summary,
      summary_source_hash: summary && typeof profilePayload?.summary_source_hash === 'string'
        ? profilePayload.summary_source_hash
        : null,
      summary_at: typeof profilePayload?.summary_at === 'string' ? profilePayload.summary_at : null,
    };
    cache = { status: 'ready', at: Date.now(), data, error: null, promise: null };
    return data;
  }).catch((error) => {
    cache = { status: 'error', at: Date.now(), data: null, error, promise: null };
    throw error;
  });
  cache.promise = promise;
  return promise;
}

function twoStep(button) {
  if (button.dataset.confirm === 'true') {
    clearTimeout(confirmTimer);
    return true;
  }
  button.dataset.confirm = 'true';
  button.dataset.label = button.textContent;
  button.textContent = '确认删除';
  button.classList.add('is-confirming');
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    if (!button.isConnected) return;
    button.dataset.confirm = 'false';
    button.textContent = button.dataset.label || '删除';
    button.classList.remove('is-confirming');
  }, 5000);
  return false;
}

function list(items, className = '') {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!values.length) return '';
  return `<ul class="${className}">${values.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`;
}

function summaryHTML(state) {
  if (state.loading && !state.data) {
    return `<p class="rp-cloud-loading">正在核对云端记录与画像摘要…</p>`;
  }
  if (!state.digest) {
    return `<p class="rp-note">完成一份已发布报告后，才能根据画像摘要生成解读。</p>`;
  }
  if (!state.summary) {
    const staleNote = state.data?.summary ? '<p class="rp-note">画像已更新，旧解读已隐藏；可重新生成。</p>' : '';
    return `<div class="rp-ai-empty">
      ${staleNote}
      <p class="rp-note">解读只使用画像摘要里的确定性统计与你主动选择记入的事实，不评价交易好坏。</p>
      <div class="rp-ai-actions">
        <button class="btn btn-outline btn-sm" type="button" data-cloud-action="summary" ${state.summaryBusy ? 'disabled' : ''}>${state.summaryBusy ? '正在生成…' : '生成 AI 解读'}</button>
        ${state.summaryError ? `<span class="rp-cloud-warn" role="alert">${esc(state.summaryError)}</span>` : ''}
      </div>
    </div>`;
  }
  const source = state.summarySource === 'ai'
    ? 'AI 生成'
    : state.summarySource === 'template'
      ? '本地模板'
      : '已保存解读';
  const sourceNote = state.summarySource === 'template'
    ? `<p class="rp-ai-fallback">本次由本地模板生成。${esc(summaryFallbackText(state.summaryFallback))}</p>`
    : '';
  const saveNote = state.summarySaved
    ? '已保存到云端'
    : state.summarySaveError
      ? state.summarySaveError
      : '';
  return `<div class="rp-ai-read">
    <div class="rp-ai-source"><span class="rp-badge mode">${esc(source)}</span><span>${esc(CONFIDENCE_LABELS[state.summary.confidence] ?? '偏低')}置信度</span></div>
    <h4 class="rp-ai-headline">${esc(state.summary.headline)}</h4>
    <p class="rp-ai-text">${esc(state.summary.summary)}</p>
    ${state.summary.strengths.length ? `<div class="rp-ai-group"><span>已经做得好的</span>${list(state.summary.strengths)}</div>` : ''}
    ${state.summary.blind_spots.length ? `<div class="rp-ai-group"><span>可能没注意的</span>${list(state.summary.blind_spots)}</div>` : ''}
    ${state.summary.next_actions.length ? `<div class="rp-ai-group"><span>可以试的下一步</span>${list(state.summary.next_actions)}</div>` : ''}
    ${state.summary.data_limits.length ? `<div class="rp-ai-group is-limits"><span>样本局限</span>${list(state.summary.data_limits)}</div>` : ''}
    ${sourceNote}
    <div class="rp-ai-foot">
      <span>${esc(saveNote || '解读数字来自画像摘要')}</span>
      <button class="text-link" type="button" data-cloud-action="summary" ${state.summaryBusy ? 'disabled' : ''}>${state.summaryBusy ? '正在生成…' : '重新生成'}</button>
    </div>
  </div>`;
}

function cloudSnapshotHTML(state, profile) {
  const cloudProfile = state.data ? cloudProfileFromBills(state.data.bills) : null;
  if (profile?.latest || !cloudProfile) return '';
  const snapshot = cloudProfile.latest;
  const dimensions = Array.isArray(snapshot.dimensions) ? snapshot.dimensions : [];
  const tags = Array.isArray(snapshot.tags) ? snapshot.tags : [];
  return `<div class="rp-cloud-snapshot">
    <p class="mono-label">CLOUD SNAPSHOT / 最近一次已发布报告</p>
    <p class="rp-note">本机没有画像记录；以下来自云端最近一次报告快照，只用于跨设备查看。</p>
    ${dimensions.length ? `<div class="rp-dim-grid">${dimensions.map((row) => `<article class="rp-dim" data-dim="${esc(row.key)}">
      <p class="rp-dim-label">${esc(row.label)}</p><p class="rp-dim-value">${esc(row.value)}</p><p class="rp-dim-note">${esc(row.note)}</p>
    </article>`).join('')}</div>` : ''}
    ${tags.length ? `<div class="rp-tag-list">${tags.map((tag) => `<span class="rp-tag" title="${esc(tag.evidence)}">${esc(tag.label)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function factsHTML(data) {
  const facts = Array.isArray(data?.facts) ? data.facts : [];
  if (!facts.length) {
    return `<p class="rp-note">还没有主动记入的画像事实。你可以在问答页的回答下选择“记入画像”，确认后再保存。</p>`;
  }
  const shown = facts.slice(0, 20);
  return `<div class="rp-cloud-fact-list">${shown.map((fact) => `<article class="rp-cloud-fact" data-fact-id="${esc(fact.id)}">
    <div class="rp-cloud-fact-top"><span class="rp-cloud-kind">${esc(FACT_KIND_LABELS[fact.kind] ?? '事实')}</span><p>${esc(fact.value)}</p></div>
    ${fact.evidence ? `<p class="rp-cloud-evidence">原话：${esc(fact.evidence)}</p>` : ''}
    <div class="rp-cloud-fact-foot"><span>${esc(fmtAt(fact.created_at))} · ${fact.source === 'manual' ? '手动记录' : '来自你的陈述'}</span><button type="button" class="rp-cloud-delete" data-cloud-action="delete-fact" data-id="${esc(fact.id)}">删除</button></div>
  </article>`).join('')}${facts.length > shown.length ? `<p class="rp-note">只显示最近 ${shown.length} 条，共 ${facts.length} 条。</p>` : ''}</div>`;
}

function billRange(bill) {
  const from = bill.metadata?.date_from;
  const to = bill.metadata?.date_to;
  if (from && to) return `${from} → ${to}`;
  return bill.effective_date ?? '—';
}

function billsHTML(data) {
  const bills = Array.isArray(data?.bills) ? data.bills : [];
  if (!bills.length) {
    return `<p class="rp-note">还没有云端账单。确认导入后，账单统计会自动同步；原始 CSV 与文件名不会上传。</p>`;
  }
  const rows = bills.map((bill) => {
    const mode = bill.payload_mode === 'full' ? '统计 + 明细' : '仅统计';
    const drag = bill.snapshot?.outcome?.display?.drag_money;
    const snapshot = bill.snapshot
      ? `<span class="rp-cloud-ok">已保存${drag ? ` · 择时差额 ${esc(drag)}` : ''}</span>`
      : '<span class="rp-cloud-muted">未生成</span>';
    return `<tr data-cloud-bill="${esc(bill.id)}">
      <td>${esc(fmtAt(bill.imported_at))}</td>
      <td>${esc(billRange(bill))}</td>
      <td class="num">${esc(bill.metadata?.trades_count ?? '—')}</td>
      <td>${esc(mode)}</td>
      <td>${snapshot}</td>
      <td class="num"><button type="button" class="rp-cloud-delete" data-cloud-action="delete-bill" data-id="${esc(bill.id)}">删除</button></td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="ledger rp-cloud-bill-table">
    <thead><tr><th>导入时间</th><th>成交区间</th><th class="num">成交</th><th>云端内容</th><th>报告快照</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="rp-note">删除只影响云端记录；本机报告、画像与规则不变。</p>`;
}

function cloudHTML(state, profile) {
  const data = state.data;
  const statusText = state.error
    ? '云端不可用'
    : state.loading && !data
      ? '读取中'
      : data
        ? `已连接 · ${data.bills.length} 份账单 / ${data.facts.length} 条事实`
        : '未连接';
  const statusState = state.error ? 'error' : state.loading && !data ? 'pending' : data ? 'ok' : 'idle';
  const errorBanner = state.error
    ? `<div class="rp-cloud-error" role="alert">
      <strong>云端记录暂不可用</strong>
      <p>${esc(cloudErrorMessage(state.error))} 本机画像、报告与问答不受影响。</p>
      <button class="btn btn-outline btn-sm" type="button" data-cloud-action="retry">重试</button>
    </div>`
    : '';
  const body = data
    ? `${cloudSnapshotHTML(state, profile)}
      <div class="rp-cloud-section">
        <div class="rp-cloud-section-head"><h4>画像解读</h4><span class="rp-cloud-muted">基于已发布报告与你主动记入的事实</span></div>
        ${summaryHTML(state)}
      </div>
      <div class="rp-cloud-section">
        <div class="rp-cloud-section-head"><h4>你主动记入的事实</h4><span class="rp-cloud-muted">${data.facts.length} 条</span></div>
        <p class="rp-note">这些只来自你的主动陈述，与报告推导的行为发现分开保存；可随时删除，删除后相关解读会一并隐藏。</p>
        ${factsHTML(data)}
      </div>
      <div class="rp-cloud-section">
        <div class="rp-cloud-section-head"><h4>云端账单</h4><span class="rp-cloud-muted">最近 ${data.bills.length} 份</span></div>
        ${billsHTML(data)}
      </div>`
    : state.loading
      ? '<p class="rp-cloud-loading">正在读取云端账单与画像…</p>'
      : '';
  return `<div class="rp-cloud-head">
      <div><p class="mono-label">CLOUD / 云端画像</p><h3>跨账单记录</h3></div>
      <span class="rp-cloud-status" data-state="${statusState}">${esc(statusText)}</span>
    </div>
    <p class="rp-note">云端保存账单统计、报告快照与你主动记入的画像事实；原始 CSV、文件名与成交明细默认不上传。</p>
    ${state.notice ? `<p class="rp-cloud-notice" role="status">${esc(state.notice)}</p>` : ''}
    ${errorBanner}
    ${body}`;
}

export function mountCloudProfile(root, ctx, { profile = null } = {}) {
  if (!root) return null;
  const deps = ctx?.cloudDeps;
  if (!deps || typeof deps.listBills !== 'function' || typeof deps.getProfile !== 'function') {
    root.innerHTML = '';
    return null;
  }
  const state = {
    loading: false,
    data: cache.status === 'ready' ? cache.data : null,
    error: cache.status === 'error' ? cache.error : null,
    digest: null,
    digestHash: null,
    summary: null,
    summarySource: null,
    summaryHash: null,
    summaryFallback: null,
    summaryBusy: false,
    summaryError: null,
    summarySaved: false,
    summarySaveError: null,
    generatedHash: null,
    notice: '',
  };
  const paint = () => {
    if (root.isConnected) root.innerHTML = cloudHTML(state, profile);
  };

  async function prepareSummaryState() {
    const cloudProfile = cloudProfileFromBills(state.data?.bills);
    const digestProfile = profile?.latest ? profile : cloudProfile;
    state.digest = digestProfile ? buildProfileDigest({ profile: digestProfile, facts: state.data?.facts }) : null;
    state.digestHash = state.digest ? await profileDigestHash(state.digest) : null;
    const cached = state.data?.summary && state.data?.summary_source_hash
      ? { summary: state.data.summary, summary_source_hash: state.data.summary_source_hash }
      : null;
    const cachedFresh = profileSummaryIsFresh(cached, state.digestHash);
    const generatedFresh = state.summary && state.generatedHash && state.generatedHash === state.digestHash;
    if (cachedFresh && !generatedFresh) {
      state.summary = state.data.summary;
      state.summarySource = 'cached';
      state.summaryHash = state.data.summary_source_hash;
      state.summaryFallback = null;
      state.generatedHash = state.digestHash;
    } else if (!generatedFresh) {
      state.summary = null;
      state.summarySource = null;
      state.summaryHash = null;
      state.summaryFallback = null;
      state.summarySaved = false;
      state.summarySaveError = null;
      state.generatedHash = null;
    }
  }

  async function refresh({ force = false } = {}) {
    if (force) state.data = null;
    state.loading = true;
    state.error = null;
    state.notice = '';
    paint();
    try {
      const data = await ensureData(ctx, { force });
      if (!root.isConnected) return;
      state.data = data;
      state.loading = false;
      await prepareSummaryState();
      paint();
    } catch (error) {
      if (!root.isConnected) return;
      state.loading = false;
      state.error = error;
      paint();
    }
  }

  async function generateSummary() {
    if (state.summaryBusy || !state.digest) return;
    state.summaryBusy = true;
    state.summaryError = null;
    state.summarySaveError = null;
    paint();
    try {
      const response = await deps.requestProfileSummary({ digest: state.digest });
      const view = summaryResponseView(response);
      if (!view) throw new Error('invalid-summary');
      state.summary = view.summary;
      state.summarySource = view.source;
      state.summaryFallback = view.fallback_reason;
      state.summaryHash = view.source_hash ?? state.digestHash;
      state.generatedHash = state.digestHash;
      state.summarySaved = false;
      try {
        const saved = await deps.saveProfileSummary({ digest: state.digest, summary: view.summary });
        state.summarySaved = true;
        if (saved?.source_hash) state.summaryHash = saved.source_hash;
        if (state.data) {
          state.data = { ...state.data, summary: view.summary, summary_source_hash: state.summaryHash };
          if (cache.status === 'ready') cache = { ...cache, data: state.data };
        }
      } catch {
        state.summarySaved = false;
        state.summarySaveError = '解读已生成，但未保存到云端。';
      }
    } catch {
      state.summaryError = '解读生成失败，请稍后重试。';
    } finally {
      state.summaryBusy = false;
      paint();
    }
  }

  async function deleteFact(id, button) {
    if (!twoStep(button)) return;
    button.disabled = true;
    button.textContent = '删除中…';
    try {
      await deps.deleteFact({ id });
      if (state.data) {
        state.data = { ...state.data, facts: state.data.facts.filter((fact) => fact.id !== id) };
        if (cache.status === 'ready') cache = { ...cache, data: state.data };
      }
      state.notice = '已从云端删除这条事实。';
      await prepareSummaryState();
      paint();
    } catch (error) {
      state.notice = `删除失败：${cloudErrorMessage(error)}`;
      paint();
    }
  }

  async function deleteBill(id, button) {
    if (!twoStep(button)) return;
    button.disabled = true;
    button.textContent = '删除中…';
    try {
      await deps.deleteBill({ id });
      markCloudBillRemoved(id);
      if (state.data) {
        state.data = { ...state.data, bills: state.data.bills.filter((bill) => bill.id !== id) };
        if (cache.status === 'ready') cache = { ...cache, data: state.data };
      }
      state.notice = '已删除云端账单记录；本机报告与画像不受影响。';
      await prepareSummaryState();
      paint();
    } catch (error) {
      state.notice = `删除失败：${cloudErrorMessage(error)}`;
      paint();
    }
  }

  root.onclick = (event) => {
    const button = event.target?.closest?.('[data-cloud-action]');
    if (!button || !root.contains(button)) return;
    const action = button.getAttribute('data-cloud-action');
    const id = button.getAttribute('data-id');
    if (action === 'retry') void refresh({ force: true });
    else if (action === 'summary') void generateSummary();
    else if (action === 'delete-fact' && id) void deleteFact(id, button);
    else if (action === 'delete-bill' && id) void deleteBill(id, button);
  };

  if (cache.status === 'ready' && cache.data) {
    state.loading = false;
    prepareSummaryState().then(() => paint());
  } else {
    void refresh();
  }
  paint();
  return { refresh, generateSummary };
}
