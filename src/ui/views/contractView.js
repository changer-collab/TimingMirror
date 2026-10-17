// 契约：引擎模板＋可编辑字段 → 解析预览 → 确认/拒绝（按候选哈希的版本状态机，本地持久化）→ 历史情境模拟（合成行情）
// 边界：解析、涨跌幅、交易日距离与命中判定全部经 adapter 调用引擎；本页只渲染引擎返回的文本与 display。
import { el, chip } from '../components.js';
import * as adapter from '../../demo/adapter.js';
import { saveContractsDemo, defaultContracts } from '../../state.js';

const RECORD_SCHEMA = 'contract-v1';
const STATUS_KIND = { 已确认: 'ok', 已改写: 'mode', 已拒绝: 'warn' };
const VERDICT = {
  triggered: { text: '命中', kind: 'warn' },
  not_triggered: { text: '未命中', kind: 'ok' },
  missing_data: { text: '数据不足', kind: 'mode' },
};

const isNewRecord = (r) => !!r && r.schema === RECORD_SCHEMA;
const safe = (x) => (x === null || x === undefined || x === '' ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
const fmtAt = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? safe(at) : d.toLocaleString('zh-CN'); };

let simContextLoadingKey = null;
let simToken = null;

function draftFor(tpl, fromRecord = null) {
  const fields = {};
  for (const f of tpl.fields) {
    const saved = fromRecord && fromRecord.template_id === tpl.template_id ? fromRecord.fields?.[f.key] : undefined;
    fields[f.key] = String(saved === undefined ? f.default : saved);
  }
  return { template_id: tpl.template_id, fields, note: '' };
}

function fieldsText(templates, rec) {
  const tpl = templates.find((t) => t.template_id === rec.template_id);
  return Object.entries(rec.fields ?? {})
    .map(([k, v]) => `${tpl?.fields.find((f) => f.key === k)?.label ?? k}：${safe(v)}`)
    .join('；');
}

// 版本＝引擎候选哈希：同一哈希的记录合并为一个版本（版本号取最早一条），状态取最新一条决策；记录只追加不删除。
const ACCEPTED = new Set(['已确认', '已改写']);

function groupVersions(versions) {
  const groups = new Map();
  versions.forEach((r, idx) => {
    if (!isNewRecord(r) || typeof r.hash !== 'string') return;
    let g = groups.get(r.hash);
    if (!g) { g = { hash: r.hash, v: null, records: [] }; groups.set(r.hash, g); }
    g.records.push(r);
    if (Number.isFinite(r.v) && (g.v === null || r.v < g.v)) g.v = r.v;
    g.latest = r;
    g.order = idx;
  });
  return [...groups.values()].map((g) => {
    const vs = [...new Set(g.records.map((r) => r.v))];
    return { ...g, v: g.v ?? safe(g.records[0].v), status: g.latest.status, duplicates: vs.filter((v) => v !== g.v) };
  });
}

function nextVersion(versions) {
  return versions.reduce((m, r) => (Number.isFinite(r.v) ? Math.max(m, r.v) : m), 0) + 1;
}

function decide(versions, parsed) {
  const groups = groupVersions(versions);
  const active = groups.filter((g) => ACCEPTED.has(g.status)).sort((a, b) => b.order - a.order)[0] ?? null;
  const fresh = { groups, active, current: null, confirmLabel: active ? '确认改写为新版本' : '确认' };
  if (!parsed || !parsed.supported) return { ...fresh, canConfirm: false, canReject: false };
  const current = groups.find((g) => g.hash === parsed.hash) ?? null;
  if (!current) return { ...fresh, canConfirm: true, canReject: true };
  return { groups, active, current, confirmLabel: '确认', canConfirm: !ACCEPTED.has(current.status), canReject: current.status !== '已拒绝' };
}

function actionHint(d, parsed, versions) {
  if (!parsed.supported) return '参数无效：确认与拒绝均不可用。';
  const g = d.current;
  if (g && ACCEPTED.has(g.status)) return `当前规则即 ${g.status} v${g.v}（同一候选哈希不再生成新版本；备注不参与哈希，不能单独产生新版本）。可拒绝该版本，或修改模板 / 参数后另存新版本。`;
  if (g) return `当前规则即 已拒绝 v${g.v}（同一候选哈希不再生成新版本）。可重新确认该版本（仍为 v${g.v}），或修改模板 / 参数。`;
  if (d.active) return `已在 ${d.active.status} v${d.active.v} 基础上修改模板或参数：确认后保存为新版本 v${nextVersion(versions)}；拒绝也会记录为新版本。`;
  return `确认或拒绝都会保存为版本 v${nextVersion(versions)}（备注不参与哈希）。`;
}

function versionCard(g, templates, tag, featured) {
  const first = g.records[0];
  const notes = [...new Set(g.records.map((r) => r.note).filter(Boolean))];
  const decisionText = (r) => [
    `v${safe(r.v)} · ${safe(r.status)}`,
    r.transition_from ? `（由 ${r.transition_from} 变更，未新增版本）` : '',
    r.from_v ? `（改写自 v${r.from_v}）` : '',
    ` · ${fmtAt(r.at)}`,
  ].join('');
  return el('div', { class: `card cv-rec${featured ? ' featured' : ''}`, 'data-hash': g.hash }, [
    el('div', { class: 'row' }, [
      chip(`${g.status} v${g.v}`, STATUS_KIND[g.status] ?? 'mode'),
      tag ? el('span', { class: 'chip cv-tag' }, [tag]) : null,
      g.duplicates.length ? el('span', { class: 'chip cv-dup' }, [`早期重复记录 ${g.duplicates.length} 条`]) : null,
    ]),
    el('div', { class: 'calc-line cv-rec-text' }, [safe(first.text)]),
    el('div', { class: 'muted small' }, [`${safe(first.template_name)} · ${fieldsText(templates, first)} · ${fmtAt(g.latest.at)}`]),
    el('details', { class: 'cv-rec-detail' }, [
      el('summary', {}, ['详情（候选哈希、备注、决策记录）']),
      el('div', { class: 'muted small cv-hash' }, [`${adapter.CONTRACT_HASH_NOTE}：${g.hash} · ${safe(first.hash_algorithm)}`]),
      ...notes.map((n) => el('div', { class: 'muted small' }, [`备注（仅备注，不参与规则判定）：${safe(n)}`])),
      el('div', { class: 'muted small' }, ['决策记录：']),
      ...g.records.map((r) => el('div', { class: 'muted small' }, [decisionText(r)])),
      g.duplicates.length
        ? el('div', { class: 'muted small' }, [`早期重复记录：同一候选哈希曾被重复保存为 ${g.duplicates.map((v) => `v${safe(v)}`).join('、')}；此处按哈希合并展示，本地数据未删除。`])
        : null,
    ]),
  ]);
}

export function renderContract(root, ctx) {
  const { state, set } = ctx;
  state.contracts = { ...defaultContracts(), ...state.contracts };
  const c = state.contracts;
  const templates = adapter.contractTemplates();
  const versions = c.versions;
  const lastNew = () => [...versions].reverse().find(isNewRecord) ?? null;
  if (!c.draft || !templates.some((t) => t.template_id === c.draft.template_id)) {
    const last = lastNew();
    c.draft = draftFor(templates.find((t) => t.template_id === last?.template_id) ?? templates[0], last);
  }
  const tpl = templates.find((t) => t.template_id === c.draft.template_id);
  const preview = () => adapter.previewContract({ template_id: c.draft.template_id, fields: c.draft.fields });

  const wrap = el('div', { class: 'stack' });
  wrap.append(el('div', { class: 'banner' }, [
    el('strong', {}, ['契约组件（候选口径）']),
    `规则只能由引擎模板（${templates.length} 个）＋可编辑数值字段生成，自由文本不作为可执行规则；哈希为候选占位算法，待 M0-C1 冻结；历史情境使用合成行情。`,
  ]));

  /* —— 规则编辑 —— */
  const editor = el('div', { class: 'card' });
  editor.append(el('div', { class: 'section-title' }, ['选择规则模板']));
  const tplSelect = el('select', {
    class: 'input',
    'data-role': 'template',
    onchange: (e) => {
      const next = templates.find((t) => t.template_id === e.target.value);
      if (!next) return;
      simToken = null;
      set({ contracts: { draft: { ...draftFor(next), note: c.draft.note }, sim: { ...c.sim, result: null, running: false } } });
    },
  }, templates.map((t) => el('option', { value: t.template_id, selected: t.template_id === tpl.template_id ? 'selected' : null }, [t.name])));
  editor.append(el('div', { class: 'row' }, [tplSelect]));
  editor.append(el('div', { class: 'muted small' }, [`模板文本：${tpl.text_template}`]));

  const fieldRow = el('div', { class: 'row' });
  for (const f of tpl.fields) {
    const input = el('input', {
      class: 'input cv-input', type: 'text', inputmode: 'decimal', 'data-field': f.key, value: c.draft.fields[f.key] ?? '',
    });
    input.addEventListener('input', (e) => {
      c.draft.fields = { ...c.draft.fields, [f.key]: e.target.value };
      simToken = null;
      c.sim = { ...c.sim, result: null, running: false };
      paint();
    });
    const rule = f.integer ? `整数，≥ ${f.min}` : `数字，≥ ${f.min}`;
    fieldRow.append(el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, [`${f.label}（${rule}；默认 ${f.default}）`]), input]));
  }
  editor.append(fieldRow);

  const note = el('textarea', { class: 'input', rows: '2', 'data-role': 'note', placeholder: '可选：写下你为什么想要这条规则' });
  note.value = c.draft.note ?? '';
  note.addEventListener('input', (e) => { c.draft.note = e.target.value; });
  editor.append(el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['备注（仅备注，不参与规则判定，不进入哈希）']), note]));

  const live = el('div', { class: 'cv-live' });
  editor.append(live);
  wrap.append(editor);

  function applyAction(action) {
    const parsed = preview();
    if (!parsed.supported) return;
    const d = decide(versions, parsed);
    if (action === 'confirm' ? !d.canConfirm : !d.canReject) return;
    const base = {
      schema: RECORD_SCHEMA,
      template_id: parsed.template_id,
      template_name: parsed.template_name,
      fields: { ...parsed.fields },
      text: parsed.text,
      threshold_display: parsed.threshold.display,
      hash: parsed.hash,
      hash_algorithm: parsed.hash_algorithm,
      at: new Date().toISOString(),
      note: (c.draft.note ?? '').trim() || null,
    };
    const rec = d.current
      ? { ...base, v: d.current.v, status: action === 'confirm' ? '已确认' : '已拒绝', transition_from: d.current.status }
      : {
        ...base,
        v: nextVersion(versions),
        status: action === 'reject' ? '已拒绝' : d.active ? '已改写' : '已确认',
        from_v: action === 'confirm' && d.active ? d.active.v : null,
      };
    set({ contracts: { versions: [...versions, rec] } });
    saveContractsDemo();
  }

  function paintLive() {
    const parsed = preview();
    const d = decide(versions, parsed);
    const nodes = [el('div', { class: 'section-title' }, ['规则预览（引擎解析）'])];
    if (!parsed.supported) {
      nodes.push(el('div', { class: 'cv-error' }, [
        el('div', { class: 'error' }, [`参数无效 · ${parsed.code}`]),
        el('div', { class: 'calc-line' }, [parsed.message]),
        el('div', { class: 'muted small' }, ['未生成规则：不猜测、不自动纠正；修正参数后才可确认或拒绝。']),
      ]));
    } else {
      const status = d.current ? { text: `${d.current.status} v${d.current.v}`, kind: STATUS_KIND[d.current.status] ?? 'mode' } : { text: '候选（未保存）', kind: 'mode' };
      nodes.push(el('div', { class: 'row' }, [el('span', { class: `chip cv-status ${status.kind}`.trim() }, [status.text]), el('span', { class: 'muted small' }, [parsed.template_name])]));
      nodes.push(el('div', { class: 'rule-text' }, [parsed.text]));
      nodes.push(el('div', { class: 'calc-line' }, [`阈值：${parsed.threshold.display}`]));
      nodes.push(el('div', { class: 'calc-line' }, [`提醒：${parsed.reminder}`]));
      nodes.push(el('div', { class: 'calc-line cv-hash' }, [`${adapter.CONTRACT_HASH_NOTE}：${parsed.hash}`]));
      nodes.push(el('div', { class: 'muted small' }, [`哈希算法：${parsed.hash_algorithm}（占位算法，冻结后可能替换；覆盖模板、条件、参数与规则文本，不含备注）`]));
    }

    const confirmBtn = el('button', { class: 'btn primary', onclick: () => applyAction('confirm') }, [d.confirmLabel]);
    const rejectBtn = el('button', { class: 'btn danger', onclick: () => applyAction('reject') }, ['拒绝']);
    confirmBtn.disabled = !d.canConfirm;
    rejectBtn.disabled = !d.canReject;
    nodes.push(el('div', { class: 'row' }, [confirmBtn, rejectBtn]));
    nodes.push(el('div', { class: 'muted small cv-hint' }, [actionHint(d, parsed, versions)]));
    live.replaceChildren(...nodes);
  }

  /* —— 版本记录（按候选哈希合并；本地数据只追加、不删除）—— */
  wrap.append(el('div', { class: 'section-title' }, ['契约版本记录（本地持久化 · 按候选哈希合并）']));
  const recordsBox = el('div', { class: 'stack cv-records' });
  wrap.append(recordsBox);

  function paintRecords() {
    const parsed = preview();
    const d = decide(versions, parsed);
    const legacy = versions.filter((r) => !isNewRecord(r));
    const nodes = [];
    if (!d.groups.length && !legacy.length) {
      nodes.push(el('div', { class: 'muted' }, ['暂无记录。确认或拒绝后会在此生成版本记录（含模板、参数、规则文本、候选哈希、状态与时间）。']));
    }
    if (d.groups.length) {
      const byRecent = [...d.groups].sort((a, b) => b.order - a.order);
      const featured = d.current ?? d.active ?? byRecent[0];
      const tag = featured === d.current ? '当前候选对应版本' : featured === d.active ? '最新有效版本' : '最新版本';
      nodes.push(versionCard(featured, templates, tag, true));
      const rest = byRecent.filter((g) => g !== featured);
      if (rest.length) {
        nodes.push(el('details', { class: 'cv-history' }, [
          el('summary', {}, [`查看历史版本（${rest.length}）`]),
          ...rest.map((g) => versionCard(g, templates, '', false)),
        ]));
      }
    }
    if (legacy.length) {
      nodes.push(el('details', { class: 'cv-history legacy' }, [
        el('summary', {}, [`旧演示记录（未经引擎解析）（${legacy.length}）`]),
        ...legacy.map((rec) => el('div', { class: 'card cv-rec legacy' }, [
          el('div', { class: 'row' }, [chip('旧演示记录', 'mode'), el('span', { class: 'muted small' }, [`v${safe(rec.v)} · ${safe(rec.status)} · ${safe(rec.candidateId)} · ${safe(rec.at)}`])]),
          el('div', { class: 'calc-line' }, [safe(rec.text)]),
          el('div', { class: 'muted small' }, ['未经契约引擎解析：不参与规则判定，无候选哈希。']),
        ])),
      ]));
    }
    recordsBox.replaceChildren(...nodes);
  }

  /* —— 历史情境模拟（交易来源由 adapter 按账单状态决定）—— */
  const sim = el('div', { class: 'card' });
  sim.append(el('div', { class: 'section-title' }, ['历史情境模拟（合成行情）']));
  sim.append(el('div', { class: 'row' }, [chip(adapter.CONTRACT_SIM_LABEL, 'mode'), chip(adapter.CONTRACT_SIM_SCOPE_NOTE, 'mode')]));
  const src = adapter.contractTradeSource(state.bill);
  const usesTrades = tpl.kind === 'sell_buyback_window';
  sim.append(el('div', { class: `calc-line cv-source ${src.kind}` }, [
    `交易来源：${src.label} · 行情：${src.market_label}`,
    usesTrades ? '' : '（涨幅模板只读取合成行情，不使用账单交易）',
  ]));
  const simResultBox = el('div', { class: 'cv-sim-out' });
  let simBtn = null;
  if (c.simContext && c.simContext.sourceKey !== src.key) {
    simToken = null;
    c.simContext = null;
    c.sim = { ...c.sim, result: null, running: false };
  }
  const sc = c.simContext;
  if (!sc) {
    sim.append(el('div', { class: 'muted' }, ['正在加载合成行情缓存与交易来源…']));
    if (simContextLoadingKey !== src.key) {
      simContextLoadingKey = src.key;
      adapter.contractSimContext({ bill: state.bill })
        .then((d) => {
          const cur = state.contracts.sim;
          const symbol = d.symbols.some((s) => s.symbol === cur.symbol) ? cur.symbol : d.symbols[0]?.symbol ?? '';
          return { simContext: d, sim: { ...cur, symbol, date: cur.date || d.range.end } };
        })
        .catch((e) => ({ simContext: { error: String(e && e.message ? e.message : e), sourceKey: src.key } }))
        .then((patch) => {
          if (simContextLoadingKey !== src.key) return;
          simContextLoadingKey = null;
          set({ contracts: patch });
        });
    }
  } else if (sc.error) {
    sim.append(el('div', { class: 'error' }, [`合成行情缓存加载失败：${sc.error}`]));
  } else {
    sim.append(el('div', { class: 'muted small' }, [`用上方当前候选规则判定“假如在该日申报买入该标的”；缓存范围 ${sc.range.start} ~ ${sc.range.end}，共 ${sc.tradingDays.length} 个交易日；缺价、超范围不补造、不回退。`]));
    const symSelect = el('select', {
      class: 'input', 'data-role': 'sim-symbol',
      onchange: (e) => { simToken = null; c.sim = { ...c.sim, symbol: e.target.value, result: null, running: false }; paint(); },
    }, sc.symbols.map((s) => el('option', { value: s.symbol, selected: s.symbol === c.sim.symbol ? 'selected' : null }, [
      `${s.symbol}${s.in_bill && src.kind === 'user_bill' ? '（账单标的）' : ''}${s.in_market_cache ? '' : '（不在合成行情缓存）'}`,
    ])));
    const dateInput = el('input', { class: 'input cv-input', type: 'date', 'data-role': 'sim-date', value: c.sim.date });
    dateInput.addEventListener('input', (e) => { simToken = null; c.sim = { ...c.sim, date: e.target.value, result: null, running: false }; paint(); });
    simBtn = el('button', {
      class: 'btn primary',
      onclick: async () => {
        const req = { template_id: c.draft.template_id, fields: { ...c.draft.fields }, symbol: c.sim.symbol, date: c.sim.date, bill: state.bill };
        const token = {};
        simToken = token;
        set({ contracts: { sim: { ...state.contracts.sim, running: true, result: null } } });
        const result = await adapter.simulateContract(req);
        const applied = simToken === token;
        set({ contracts: { sim: { ...state.contracts.sim, running: false, result: applied ? result : null } } });
      },
    }, [c.sim.running ? '判定中…' : '模拟申报买入']);
    sim.append(el('div', { class: 'row' }, [
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['标的（账单标的 + 合成行情缓存标的）']), symSelect]),
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['申报日期']), dateInput]),
      simBtn,
    ]));
    if (usesTrades) {
      const sells = sc.sells.map((s) => `${s.trade_id} ${s.symbol} ${s.trade_date}`).join('；') || '无';
      sim.append(el('div', { class: 'muted small' }, [`卖出记录来源：${sc.tradesSource.label}——卖出：${sells}`]));
    }
  }
  sim.append(simResultBox);
  wrap.append(sim);

  function paintSim() {
    if (simBtn) simBtn.disabled = !!c.sim.running || !preview().supported;
    simResultBox.replaceChildren(...(c.sim.result ? [simResult(c.sim.result)] : []));
  }

  function paint() { paintLive(); paintRecords(); paintSim(); }
  paint();
  root.append(wrap);
}

function factLines(fact, change) {
  const lines = [`标的：${safe(fact.symbol)}`];
  if (change && change.complete) {
    lines.push(`有效交易日：${change.effective_date}（前收日 ${change.prev_date}）`);
    lines.push(`当日涨跌幅：${change.display.change_pct}`);
  } else if (fact.display && fact.display.change_pct) {
    lines.push(`当日涨跌幅：${fact.display.change_pct}`);
  } else {
    lines.push(`申报日：${safe(fact.date)}`);
  }
  if (fact.last_sell) lines.push(`最近卖出：${fact.last_sell.trade_id} · ${fact.last_sell.trade_date}`);
  if (fact.distance_trading_days !== undefined) lines.push(`距最近卖出：${fact.distance_trading_days} 个交易日（窗口 ${fact.window_days} 个交易日）`);
  return lines;
}

function simResult(r) {
  const box = el('div', { class: 'cv-sim-result' });
  if (!r.ok) {
    box.append(el('div', { class: 'cv-error' }, [
      el('div', { class: 'error' }, [`无法判定 · ${safe(r.code)}`]),
      el('div', { class: 'calc-line' }, [safe(r.message)]),
    ]));
    box.append(el('div', { class: 'muted small' }, [`${r.label} · ${r.scopeNote}`]));
    return box;
  }
  const v = VERDICT[r.verdict] ?? { text: safe(r.verdict), kind: 'mode' };
  const m = r.match;
  box.className = `cv-sim-result ${r.verdict}`;
  box.append(el('div', { class: 'row' }, [
    el('span', { class: `chip cv-verdict ${v.kind}` }, [v.text]),
    el('strong', {}, [`${safe(r.symbol)} · 申报日 ${safe(r.requested_date)}`]),
  ]));
  if (r.verdict === 'missing_data') {
    box.append(el('div', { class: 'calc-line' }, [`原因码：${safe(r.code)}`]));
    box.append(el('div', { class: 'calc-line' }, [`引擎原因：${r.change && !r.change.complete ? r.change.message : safe(r.message)}`]));
    box.append(el('div', { class: 'muted small' }, ['数据不足：不补造数值、不回退其他日期，本次不作命中判定。']));
  } else {
    box.append(el('div', { class: 'calc-line' }, [safe(r.message)]));
    if (m.warning) {
      box.append(el('div', { class: 'cv-warning' }, [
        el('strong', {}, ['契约提醒：此情境命中你确认的规则']),
        el('div', { class: 'calc-line' }, [`规则：${m.warning.rule_text}`]),
        el('div', { class: 'calc-line' }, [`阈值：${m.warning.threshold_display}`]),
        el('div', { class: 'calc-line' }, [`情境事实：${factLines(m.warning.situation, r.change).join('；')}`]),
        el('div', { class: 'muted small' }, [`提醒：${m.reminder}`]),
      ]));
    } else {
      box.append(el('div', { class: 'calc-line' }, [`情境事实：${factLines(m.fact, r.change).join('；')}`]));
    }
    if (r.change && r.change.complete) box.append(el('div', { class: 'muted small' }, [r.change.source_note]));
  }
  box.append(el('div', { class: 'muted small cv-source' }, [
    r.uses_trades ? `交易来源：${r.tradesSource.label} · 行情：${r.tradesSource.market_label}` : `行情：${r.tradesSource.market_label}（涨幅模板不使用账单交易）`,
  ]));
  if (r.in_market_cache === false) {
    box.append(el('div', { class: 'muted small' }, [`标的 ${safe(r.symbol)} 不在合成行情缓存支持范围：${r.uses_trades ? '不追回判定只使用交易日历与账单交易，不读取价格' : '无法读取涨跌幅'}；不替换标的、不回退演示账单。`]));
  }
  box.append(el('div', { class: 'muted small cv-hash' }, [`判定所用规则：${safe(m.contract_text)} · ${adapter.CONTRACT_HASH_NOTE}：${safe(m.contract_hash)}`]));
  box.append(el('div', { class: 'muted small' }, [`${r.label} · ${r.scopeNote}`]));
  return box;
}
