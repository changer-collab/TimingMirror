// 个人中心云端区块：账单历史、对话事实、AI 画像解读。
// 云端失败不回退本地旧数据；摘要缺失或过期时自动重算一次。
import {
  buildProfileDigest, profileDigestHash, profileSummaryIsFresh,
} from '../../src/agent/profileDigest.js';
import {
  PROFILE_FACT_KIND_LABELS, cloudProfileFromBills, normalizeCloudBills, normalizeCloudFacts,
  summaryFallbackText, summaryResponseView, validSummaryValue,
} from '../../src/agent/cloudProfileModel.js';
import { markCloudBillRemoved } from './cloudSync.js';

const CACHE_TTL_MS = 15000;
const AUTO_SUMMARY_RETRY_MS = 5 * 60 * 1000;
const CONFIDENCE_LABELS = Object.freeze({ high: '较高', medium: '中等', low: '偏低' });

let cache = { status: 'idle', at: 0, data: null, error: null, promise: null };
let confirmTimer = null;
// 同一 digest 只自动尝试一次；失败后隔一段时间才允许重试，避免每次进入页面都打模型。
const autoSummaryTried = new Map();
const autoSummaryInFlight = new Set();

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

// 问答页只读取已缓存的画像事实；缓存冷时由 loadCloudFacts 单独按需拉取，不触发账单列表请求。
export function getCachedCloudFacts() {
  if (cache.status === 'ready' && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data.facts;
  }
  return null;
}

export async function loadCloudFacts(ctx) {
  const cached = getCachedCloudFacts();
  if (cached) return cached;
  if (!ctx?.cloudDeps || typeof ctx.cloudDeps.getProfile !== 'function') return [];
  const payload = await ctx.cloudDeps.getProfile();
  const facts = normalizeCloudFacts(payload);
  if (cache.status === 'ready' && cache.data) {
    cache = { ...cache, at: Date.now(), data: { ...cache.data, facts } };
  }
  return facts;
}

export function appendCachedCloudFacts(facts) {
  if (cache.status !== 'ready' || !cache.data) return;
  const rows = Array.isArray(facts) ? facts.filter((fact) => fact && typeof fact.id === 'string') : [];
  if (!rows.length) return;
  const seen = new Set(cache.data.facts.map((fact) => fact.id));
  const merged = [...rows.filter((fact) => !seen.has(fact.id)), ...cache.data.facts];
  cache = { ...cache, at: Date.now(), data: { ...cache.data, facts: merged } };
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

function twoStep(button, confirmText = '确认删除') {
  if (button.dataset.confirm === 'true') {
    clearTimeout(confirmTimer);
    return true;
  }
  button.dataset.confirm = 'true';
  button.dataset.label = button.textContent;
  button.textContent = confirmText;
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

function keywordList(state) {
  const own = Array.isArray(state.summary?.keywords) ? state.summary.keywords.filter(Boolean) : [];
  if (own.length) return own.slice(0, 6);
  // 旧缓存没有 keywords 时，用同一份画像摘要里的行为标签兜底。
  const tags = Array.isArray(state.digest?.behavior?.tags) ? state.digest.behavior.tags : [];
  return tags.slice(0, 6).map((tag) => String(tag ?? '').trim().slice(0, 12)).filter(Boolean);
}

function keywordsHTML(state) {
  const rows = keywordList(state);
  if (!rows.length) return '';
  return `<div class="rp-ai-keywords" aria-label="画像关键词">${rows.map((word) => `<span class="rp-chip">${esc(word)}</span>`).join('')}</div>`;
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
      <p class="rp-note">解读只使用画像摘要里的确定性统计与系统自动记录的画像依据，不评价交易好坏。</p>
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
    ? `<p class="rp-ai-fallback">本次由本地模板生成。${esc(summaryFallbackText(state.summaryFallback, state.summaryFallbackDetail))}</p>`
    : '';
  const saveNote = state.summarySaved
    ? '已保存到云端'
    : state.summarySaveError
      ? state.summarySaveError
      : '';
  return `<div class="rp-ai-read">
    <div class="rp-ai-source"><span class="rp-badge mode">${esc(source)}</span><span>${esc(CONFIDENCE_LABELS[state.summary.confidence] ?? '偏低')}置信度</span></div>
    <h4 class="rp-ai-headline">${esc(state.summary.headline)}</h4>
    ${keywordsHTML(state)}
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
    <p class="rp-note">本会话还没有新的画像观察；以下来自云端最近一次已发布报告快照。</p>
    ${dimensions.length ? `<div class="rp-dim-grid">${dimensions.map((row) => `<article class="rp-dim" data-dim="${esc(row.key)}">
      <p class="rp-dim-label">${esc(row.label)}</p><p class="rp-dim-value">${esc(row.value)}</p><p class="rp-dim-note">${esc(row.note)}</p>
    </article>`).join('')}</div>` : ''}
    ${tags.length ? `<div class="rp-tag-list">${tags.map((tag) => `<span class="rp-tag" title="${esc(tag.evidence)}">${esc(tag.label)}</span>`).join('')}</div>` : ''}
  </div>`;
}

function basisHTML(data) {
  const facts = Array.isArray(data?.facts) ? data.facts : [];
  if (!facts.length) {
    return `<details class="rp-basis rp-cloud-basis" data-role="profile-basis">
      <summary>画像依据（0 条）</summary>
      <p class="rp-note">还没有画像依据。问答中明确说出长期目标、偏好或约束时，系统会自动记录。</p>
    </details>`;
  }
  const shown = facts.slice(0, 20);
  return `<details class="rp-basis rp-cloud-basis" data-role="profile-basis">
    <summary>画像依据（${facts.length} 条，可撤销）</summary>
    <p class="rp-note">系统从你明确说过的长期目标、偏好和约束中自动记录；撤销后画像解读会在下次进入时重算。</p>
    <div class="rp-cloud-fact-list">${shown.map((fact) => `<article class="rp-cloud-fact" data-fact-id="${esc(fact.id)}">
      <div class="rp-cloud-fact-top"><span class="rp-cloud-kind">${esc(PROFILE_FACT_KIND_LABELS[fact.kind] ?? '事实')}</span><p>${esc(fact.value)}</p></div>
      ${fact.evidence ? `<p class="rp-cloud-evidence">原话：${esc(fact.evidence)}</p>` : ''}
      <div class="rp-cloud-fact-foot"><span>${esc(fmtAt(fact.created_at))} · ${fact.source === 'manual' ? '旧版手动记录' : '自动记录'}</span><button type="button" class="rp-cloud-delete" data-cloud-action="delete-fact" data-id="${esc(fact.id)}">撤销</button></div>
    </article>`).join('')}${facts.length > shown.length ? `<p class="rp-note">只显示最近 ${shown.length} 条，共 ${facts.length} 条。</p>` : ''}</div>
  </details>`;
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
  <p class="rp-note">删除只影响这份云端账单记录。</p>`;
}

function cloudStatus(state) {
  const data = state.data;
  const text = state.error
    ? '云端不可用'
    : state.loading && !data
      ? '读取中'
      : data
        ? `已连接 · ${data.bills.length} 份账单 / ${data.facts.length} 条画像依据`
        : '未连接';
  const tone = state.error ? 'error' : state.loading && !data ? 'pending' : data ? 'ok' : 'idle';
  return { text, tone };
}

function errorBanner(state) {
  if (!state.error) return '';
  return `<div class="rp-cloud-error" role="alert">
    <strong>云端记录暂不可用</strong>
    <p>${esc(cloudErrorMessage(state.error))} 账单与画像都以云端为准，不会用本机旧数据代替。</p>
    <button class="btn btn-outline btn-sm" type="button" data-cloud-action="retry">重试</button>
  </div>`;
}

function summaryViewHTML(state, profile) {
  const status = cloudStatus(state);
  const data = state.data;
  const body = data
    ? `${cloudSnapshotHTML(state, profile)}
      <div class="rp-cloud-section">
        ${summaryHTML(state)}
        ${basisHTML(data)}
      </div>`
    : state.loading
      ? '<p class="rp-cloud-loading">正在读取云端账单与画像…</p>'
      : '';
  return `<div class="rp-cloud-section-head">
      <h4>画像解读</h4>
      <span class="rp-cloud-status" data-state="${status.tone}">${esc(status.text)}</span>
    </div>
    <p class="rp-note">云端保存成交明细、账单统计、报告快照与画像依据；原始 CSV 与文件名不上传。</p>
    ${state.notice ? `<p class="rp-cloud-notice" role="status">${esc(state.notice)}</p>` : ''}
    ${errorBanner(state)}
    ${body}`;
}

function billsViewHTML(state) {
  const data = state.data;
  if (!data) {
    return state.loading ? '<p class="rp-cloud-loading">正在读取云端账单…</p>' : '';
  }
  return `<div class="rp-cloud-section-head"><h4>云端账单</h4><span class="rp-cloud-muted">最近 ${data.bills.length} 份</span></div>
    ${billsHTML(data)}`;
}

export function mountCloudProfile(roots, ctx, { profile = null } = {}) {
  const summaryRoot = roots && typeof roots === 'object' && 'summary' in roots ? roots.summary : roots;
  const billsRoot = roots && typeof roots === 'object' && 'bills' in roots ? roots.bills : null;
  if (!summaryRoot && !billsRoot) return null;
  const deps = ctx?.cloudDeps;
  if (!deps || typeof deps.listBills !== 'function' || typeof deps.getProfile !== 'function') {
    if (summaryRoot) summaryRoot.innerHTML = '';
    if (billsRoot) billsRoot.innerHTML = '';
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
    summaryFallbackDetail: null,
    summaryBusy: false,
    summaryError: null,
    summarySaved: false,
    summarySaveError: null,
    generatedHash: null,
    notice: '',
  };
  const paint = () => {
    if (summaryRoot?.isConnected) summaryRoot.innerHTML = summaryViewHTML(state, profile);
    if (billsRoot?.isConnected) billsRoot.innerHTML = billsViewHTML(state);
  };
  const isMounted = () => summaryRoot?.isConnected || billsRoot?.isConnected;
  let autoRetryTimer = null;
  let autoRetryCount = 0;

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
      state.summaryFallbackDetail = null;
      state.generatedHash = state.digestHash;
    } else if (!generatedFresh) {
      state.summary = null;
      state.summarySource = null;
      state.summaryHash = null;
      state.summaryFallback = null;
      state.summaryFallbackDetail = null;
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
      if (!isMounted()) return;
      state.data = data;
      state.loading = false;
      await prepareSummaryState();
      paint();
      maybeAutoSummary();
    } catch (error) {
      if (!isMounted()) return;
      state.loading = false;
      state.error = error;
      paint();
    }
  }

  function maybeAutoSummary() {
    if (state.summaryBusy || !state.digest || !state.digestHash) return;
    if (state.summary && state.generatedHash === state.digestHash) return;
    if (autoSummaryInFlight.has(state.digestHash)) {
      // 旧挂载点（例如报告加载后被替换的节点）可能仍在请求；等它结束后由本挂载点重试。
      if (!autoRetryTimer && autoRetryCount < 20) {
        autoRetryTimer = setTimeout(() => {
          autoRetryTimer = null;
          autoRetryCount += 1;
          if (isMounted()) maybeAutoSummary();
        }, 1500);
      }
      return;
    }
    const last = autoSummaryTried.get(state.digestHash);
    if (last && Date.now() - last < AUTO_SUMMARY_RETRY_MS) return;
    if (typeof deps.requestProfileSummary !== 'function') return;
    autoRetryCount = 0;
    autoSummaryInFlight.add(state.digestHash);
    void generateSummary({ auto: true });
  }

  async function generateSummary({ auto = false } = {}) {
    const hash = state.digestHash;
    if (state.summaryBusy || !state.digest) {
      if (auto && hash) autoSummaryInFlight.delete(hash);
      return;
    }
    state.summaryBusy = true;
    state.summaryError = null;
    state.summarySaveError = null;
    paint();
    let finalSource = null;
    try {
      const response = await deps.requestProfileSummary({ digest: state.digest });
      const view = summaryResponseView(response);
      if (!view) throw new Error('invalid-summary');
      state.summary = view.summary;
      state.summarySource = view.source;
      state.summaryFallback = view.fallback_reason;
      state.summaryFallbackDetail = view.fallback_detail;
      state.summaryHash = view.source_hash ?? state.digestHash;
      state.generatedHash = state.digestHash;
      state.summarySaved = false;
      finalSource = view.source;
      // 模板兜底不写入云端，避免把兜底文案冒充为已保存的 AI 解读。
      if (view.source !== 'ai' || typeof deps.saveProfileSummary !== 'function') return;
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
      state.summaryError = auto ? '自动解读暂不可用，可稍后重试。' : '解读生成失败，请稍后重试。';
    } finally {
      if (auto && hash) {
        autoSummaryInFlight.delete(hash);
        if (finalSource === 'ai' && state.summary) autoSummaryTried.delete(hash);
        else autoSummaryTried.set(hash, Date.now());
      }
      state.summaryBusy = false;
      paint();
    }
  }

  async function deleteFact(id, button) {
    if (!twoStep(button, '确认撤销')) return;
    button.disabled = true;
    button.textContent = '撤销中…';
    try {
      await deps.deleteFact({ id });
      if (state.data) {
        state.data = { ...state.data, facts: state.data.facts.filter((fact) => fact.id !== id) };
        if (cache.status === 'ready') cache = { ...cache, data: state.data };
      }
      state.notice = '已撤销这条画像依据；画像解读会在下次进入时重算。';
      await prepareSummaryState();
      paint();
    } catch (error) {
      state.notice = `撤销失败：${cloudErrorMessage(error)}`;
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

  const onClick = (event) => {
    const button = event.target?.closest?.('[data-cloud-action]');
    if (!button || !event.currentTarget.contains(button)) return;
    const action = button.getAttribute('data-cloud-action');
    const id = button.getAttribute('data-id');
    if (action === 'retry') void refresh({ force: true });
    else if (action === 'summary') void generateSummary();
    else if (action === 'delete-fact' && id) void deleteFact(id, button);
    else if (action === 'delete-bill' && id) void deleteBill(id, button);
  };
  if (summaryRoot) summaryRoot.onclick = onClick;
  if (billsRoot) billsRoot.onclick = onClick;

  if (cache.status === 'ready' && cache.data) {
    state.loading = false;
    prepareSummaryState().then(() => { paint(); maybeAutoSummary(); });
  } else {
    void refresh();
  }
  paint();
  return { refresh, generateSummary };
}
