// 交易规则（契约）：当前生效规则（每种类型最多一条）→ 历史规则（折叠）→ 新增 / 修改弹窗 → 当前规则的历史情境测试（Tushare 动态行情 / 合成回归）
// 边界：当前 / 历史划分、版本状态机、解析与判定全部由 adapter 提供（adapter 内部调用引擎）；本页只渲染返回的文本与 display。
import { el, chip } from '../components.js';
import * as adapter from '../../demo/adapter.js';
import { saveContractsDemo, defaultContracts } from '../../state.js';

const VERDICT = {
  triggered: { text: '命中', kind: 'warn' },
  not_triggered: { text: '未命中', kind: 'ok' },
  missing_data: { text: '数据不足', kind: 'mode' },
};
const SUMMARY = [['triggered', '命中', 'warn'], ['not_triggered', '未命中', 'ok'], ['missing_data', '数据不足', 'mode'], ['error', '无法判定', 'warn']];
const KIND_LABEL = Object.freeze({ change_pct_threshold: '买入限制', sell_buyback_window: '卖出后限制' });
const INTRO = '设置在历史情境测试中用于提醒自己的交易规则。';
const PRIVACY = '规则仅保存在当前浏览器；不会自动交易，也不会改变分析报告结论。';
const CURRENT_NOTE = '不同类型的规则可以同时生效；每种类型只保留一条当前规则，保存新参数后会自动替代旧规则，旧规则进入历史规则。';
const REPLACE_NOTE = '保存后，新规则会立即生效；当前同类型规则会进入历史记录，不再参与测试。';
const STOP_NOTE = '停用后，该规则进入历史规则，不再参与之后的历史情境测试；可随时恢复为当前规则。';
const RECONFIRM_NOTE = '这条规则的保存内容与当前校验标识不一致。为避免误用，它暂不参与测试。请核对后用“新增规则”重新保存，或停用该规则。';
const EMPTY_NOTE = '暂无当前生效的规则，测试时不会产生契约提醒。点击“新增规则”开始设置。';
const HISTORY_NOTE = '被新规则替代、手动停用的规则和旧演示记录都保留在这里，不参与测试；版本记录只追加、不删除。';
const HISTORY_TAG = Object.freeze({ replaced: '已被替代', superseded: '已被替代', stopped: '已停用' });
const VIA_TEXT = Object.freeze({
  替代: (r) => `被同类型规则 v${safe(r.replaced_by_v)} 替代`,
  整理: (r) => `整理同类规则时停用，保留 v${safe(r.kept_v)}`,
  停用: () => '手动停用',
  重新启用: () => '重新启用',
  恢复: () => '恢复为当前规则',
});

const safe = (x) => (x === null || x === undefined || x === '' ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
const fmtAt = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? safe(at) : d.toLocaleString('zh-CN'); };

let simContextLoadingKey = null;
let simToken = null;
let focusedModal = null;
let closeActiveModal = null;
let escBound = false;

// Esc 关闭弹窗：document 级只绑定一次，关闭动作指向最近一次渲染的弹窗
function bindEsc() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closeActiveModal) closeActiveModal(); });
}

function draftFor(tpl, fromRule = null) {
  const fields = {};
  for (const f of tpl.fields) {
    const saved = fromRule ? fromRule.fields?.[f.key] : undefined;
    fields[f.key] = String(saved === undefined ? f.default : saved);
  }
  return { template_id: tpl.template_id, fields, note: fromRule ? fromRule.latest_note : '' };
}

const decisionText = (r) => [
  `v${safe(r.v)} · ${safe(r.status)}`,
  r.via ? `（${VIA_TEXT[r.via] ? VIA_TEXT[r.via](r) : safe(r.via)}，未新增版本）` : r.transition_from ? '（状态变更，未新增版本）' : '',
  r.from_v ? `（改写自 v${r.from_v}）` : '',
  Array.isArray(r.replaces_v) && r.replaces_v.length ? `（替代同类型 v${r.replaces_v.join('、v')}）` : '',
  Array.isArray(r.kept_parallel_with) && r.kept_parallel_with.length ? `（与同类 v${r.kept_parallel_with.join('、v')} 同时保留）` : '',
  ` · ${fmtAt(r.at)}`,
].join('');

// 触发条件只拼接引擎解析返回的阈值 display（不重新格式化数字）
function conditionText(rule) {
  const d = rule.parsed?.threshold?.display;
  if (!d) return null;
  if (rule.kind === 'change_pct_threshold') return `触发条件：申报买入当天涨幅超过 ${d}`;
  if (rule.kind === 'sell_buyback_window') return `触发条件：卖出后 ${d}内再次买入同一标的`;
  return null;
}

function historyReason(rule) {
  if (rule.state === 'superseded') return '已被较新的同类型规则替代，不参与后续测试。';
  if (rule.state === 'replaced') {
    const by = rule.replaced_by;
    return by && by.is_current ? '已被当前规则替代，不参与后续测试。' : `已被新规则（版本 v${safe(by && by.v)}）替代，不参与后续测试。`;
  }
  return rule.integrity.ok ? '已停用，不参与后续测试。' : '已停用；保存内容与校验标识不一致，不能恢复。';
}

function ruleDetail(rule) {
  const cond = conditionText(rule);
  return el('details', { class: 'cv-rule-detail' }, [
    el('summary', {}, ['查看详情']),
    el('div', { class: 'muted small' }, [`版本 v${safe(rule.v)} · ${safe(rule.template_name)} · ${rule.fields_text}`]),
    cond ? el('div', { class: 'muted small' }, [cond]) : null,
    el('div', { class: 'muted small cv-hash cv-hash-full' }, [`${adapter.CONTRACT_HASH_NOTE}：${rule.hash}`]),
    el('div', { class: 'muted small' }, [`哈希算法：${safe(rule.hash_algorithm)}（候选占位算法，待 M0-C1 冻结后可能替换）`]),
    el('div', { class: 'muted small' }, [`创建时间：${fmtAt(rule.records[0].at)} · 最近状态变更：${fmtAt(rule.latest.at)}`]),
    ...(rule.notes.length
      ? rule.notes.map((n) => el('div', { class: 'muted small' }, [`备注（不参与规则判定）：${safe(n)}`]))
      : [el('div', { class: 'muted small' }, ['备注：无'])]),
    rule.integrity.ok ? null : el('div', { class: 'muted small' }, [`校验结果：${rule.integrity.code} · ${rule.integrity.message}`]),
    rule.duplicates.length
      ? el('div', { class: 'muted small' }, [`早期重复记录：同一候选哈希曾被重复保存为 ${rule.duplicates.map((v) => `v${safe(v)}`).join('、')}；此处按哈希合并展示，本地数据未删除。`])
      : null,
    el('div', { class: 'muted small' }, ['历史状态变更：']),
    ...rule.records.map((r) => el('div', { class: 'muted small' }, [decisionText(r)])),
  ]);
}

export function renderContract(root, ctx) {
  const { state, set } = ctx;
  state.contracts = { ...defaultContracts(), ...state.contracts };
  const c = state.contracts;
  const templates = adapter.contractTemplates();
  const ruleSet = adapter.contractRuleSet(c.versions);
  const slotOf = (template_id) => ruleSet.slots.find((s) => s.template_id === template_id) ?? null;

  function commitAll(recs, extra = {}) {
    if (!recs || !recs.length) return;
    simToken = null;
    set({ contracts: { versions: [...c.versions, ...recs], sim: { ...c.sim, result: null, running: false }, ...extra } });
    saveContractsDemo();
  }
  function openEditor(mode, { rule = null, template_id = null } = {}) {
    const wanted = rule ? rule.template_id : template_id;
    const tpl = templates.find((t) => t.template_id === wanted) ?? templates.find((t) => !slotOf(t.template_id)?.current) ?? templates[0];
    set({ contracts: { modal: { mode, targetHash: rule ? rule.hash : null }, draft: draftFor(tpl, rule) } });
  }
  const closeEditor = () => set({ contracts: { modal: null } });

  const page = el('div', { class: 'stack cv-page' });

  /* —— 页头 —— */
  page.append(el('div', { class: 'card cv-head' }, [
    el('div', { class: 'cv-head-main' }, [
      el('h2', { class: 'cv-title' }, ['交易规则']),
      el('div', { class: 'cv-intro' }, [INTRO]),
      el('div', { class: 'cv-privacy' }, [PRIVACY]),
      el('details', { class: 'cv-tech-note' }, [
        el('summary', {}, ['技术说明（候选口径）']),
        el('div', { class: 'muted small' }, [`规则只能由引擎模板（${templates.length} 个）＋可编辑数值字段生成，自由文本不作为可执行规则；哈希为候选占位算法，待 M0-C1 冻结；历史情境可切换 Tushare 动态日线（服务端获取，非实时）或合成回归行情。`]),
      ]),
    ]),
    el('button', { class: 'btn primary cv-add', 'data-role': 'add-rule', onclick: () => openEditor('add') }, ['新增规则']),
  ]));

  /* —— 当前生效规则：按类型，每种类型最多一条（由 adapter 派生）—— */
  const currentBox = el('div', { class: 'card cv-current' });
  let pendingStop = null;
  const stop = (hash) => commitAll(adapter.contractStopRecords(c.versions, { hash }));

  function currentCard(rule) {
    const confirming = pendingStop === rule.hash;
    const cond = conditionText(rule);
    return el('div', { class: 'cv-rule on', 'data-hash': rule.hash }, [
      el('div', { class: 'row cv-rule-head' }, [
        chip('已启用', 'ok'),
        el('span', { class: 'cv-rule-name' }, [safe(rule.template_name)]),
        el('span', { class: 'cv-rule-ver' }, [`版本 v${safe(rule.v)}`]),
        el('span', { class: 'cv-rule-actions' }, [
          el('button', { class: 'btn small', 'data-role': 'edit', onclick: () => openEditor('edit', { rule }) }, ['修改']),
          confirming ? null : el('button', { class: 'btn small danger', 'data-role': 'stop', onclick: () => { pendingStop = rule.hash; paintCurrent(); } }, ['停用']),
        ]),
      ]),
      el('div', { class: 'cv-rule-text' }, [safe(rule.text)]),
      cond ? el('div', { class: 'cv-rule-cond' }, [cond]) : null,
      confirming ? el('div', { class: 'cv-confirm' }, [
        el('div', { class: 'calc-line' }, [`确认停用“${safe(rule.text)}”？`]),
        el('div', { class: 'muted small' }, [STOP_NOTE]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small danger', 'data-role': 'stop-confirm', onclick: () => stop(rule.hash) }, ['确认停用']),
          el('button', { class: 'btn small', 'data-role': 'stop-cancel', onclick: () => { pendingStop = null; paintCurrent(); } }, ['取消']),
        ]),
      ]) : null,
      ruleDetail(rule),
    ]);
  }

  function paintCurrent() {
    const nodes = [
      el('div', { class: 'section-title' }, [`当前生效规则（${ruleSet.current.length}）`]),
      el('div', { class: 'muted small' }, [CURRENT_NOTE]),
    ];
    if (!ruleSet.current.length) nodes.push(el('div', { class: 'muted cv-empty' }, [EMPTY_NOTE]));
    for (const s of ruleSet.slots) {
      nodes.push(el('div', { class: 'cv-slot', 'data-template': s.template_id, 'data-kind': s.kind }, [
        el('div', { class: 'cv-group-title' }, [KIND_LABEL[s.kind] ?? s.template_name]),
        s.current ? currentCard(s.current) : el('div', { class: 'cv-slot-empty' }, [
          el('span', { class: 'muted small' }, [`暂未设置「${s.template_name}」规则`]),
          el('button', { class: 'btn small', 'data-role': 'add-slot', onclick: () => openEditor('add', { template_id: s.template_id }) }, ['新增此类规则']),
        ]),
      ]));
    }
    currentBox.replaceChildren(...nodes);
  }
  paintCurrent();
  page.append(currentBox);

  /* —— 待重新确认（异常）：不计入当前规则、不参与测试 —— */
  if (ruleSet.needsReconfirm.length) {
    page.append(el('div', { class: 'card cv-reconfirm-box' }, [
      el('div', { class: 'cv-group-title' }, [`待重新确认的规则（${ruleSet.needsReconfirm.length}）`]),
      el('div', { class: 'muted small' }, ['以下规则不计入当前生效规则，也不参与历史情境测试。']),
      ...ruleSet.needsReconfirm.map((r) => el('div', { class: 'cv-rule reconfirm', 'data-hash': r.hash }, [
        el('div', { class: 'row cv-rule-head' }, [
          chip('待重新确认', 'warn'),
          el('span', { class: 'cv-rule-name' }, [safe(r.template_name)]),
          el('span', { class: 'cv-rule-ver' }, [`版本 v${safe(r.v)}`]),
          el('span', { class: 'cv-rule-actions' }, [el('button', { class: 'btn small danger', 'data-role': 'stop', onclick: () => stop(r.hash) }, ['停用'])]),
        ]),
        el('div', { class: 'cv-rule-text' }, [safe(r.text)]),
        el('div', { class: 'cv-reconfirm-why' }, [RECONFIRM_NOTE]),
        ruleDetail(r),
      ])),
    ]));
  }

  /* —— 历史规则（默认折叠）：被替代 / 手动停用 / 旧演示记录 —— */
  function historyItem(rule) {
    const slotCur = slotOf(rule.template_id)?.current ?? null;
    return el('div', { class: `cv-hist ${rule.state}`, 'data-hash': rule.hash, 'data-state': rule.state }, [
      el('div', { class: 'row cv-rule-head' }, [
        chip(HISTORY_TAG[rule.state] ?? '历史', 'mode'),
        el('span', { class: 'cv-rule-name' }, [safe(rule.template_name)]),
        el('span', { class: 'cv-rule-ver' }, [`版本 v${safe(rule.v)}`]),
        rule.restorable
          ? el('span', { class: 'cv-rule-actions' }, [el('button', { class: 'btn small', 'data-role': 'restore', onclick: () => commitAll(adapter.contractRestoreRecords(c.versions, { hash: rule.hash })) }, ['恢复为当前规则'])])
          : null,
      ]),
      el('div', { class: 'cv-rule-text' }, [safe(rule.text)]),
      el('div', { class: 'cv-hist-reason' }, [historyReason(rule)]),
      rule.restorable && slotCur ? el('div', { class: 'muted small' }, [`恢复后，当前同类型规则（版本 v${safe(slotCur.v)}）会进入历史规则。`]) : null,
      ruleDetail(rule),
    ]);
  }
  const legacyItem = (rec) => el('div', { class: 'cv-hist legacy' }, [
    el('div', { class: 'row cv-rule-head' }, [chip('旧演示记录', 'mode'), el('span', { class: 'cv-rule-text' }, [safe(rec.text)])]),
    el('div', { class: 'muted small' }, [`v${safe(rec.v)} · ${safe(rec.status)} · ${safe(rec.candidateId)} · ${safe(rec.at)}`]),
    el('div', { class: 'cv-hist-reason' }, ['未经契约引擎解析：不参与测试，不能恢复。']),
  ]);
  const histCount = ruleSet.history.length + ruleSet.legacy.length;
  page.append(el('details', { class: 'card cv-history', 'data-role': 'history' }, [
    el('summary', {}, [`历史规则（${histCount}）`]),
    el('div', { class: 'muted small' }, [HISTORY_NOTE]),
    histCount ? null : el('div', { class: 'muted small' }, ['暂无历史规则。']),
    ...ruleSet.history.map(historyItem),
    ...ruleSet.legacy.map(legacyItem),
  ]));

  /* —— 历史情境测试：只用每种类型唯一的当前规则；交易来源由 adapter 按账单状态决定 —— */
  const current = ruleSet.current;
  const hasBuyback = current.some((r) => r.uses_trades);
  const hasSurge = current.some((r) => r.kind === 'change_pct_threshold');
  const marketSource = c.marketSource === 'synthetic-fixture' ? 'synthetic-fixture' : adapter.DEFAULT_MARKET_SOURCE;
  const labels = adapter.contractSimLabels(marketSource);
  const sim = el('div', { class: 'card' });
  sim.append(el('div', { class: 'section-title' }, [marketSource === 'synthetic-fixture'
    ? '历史情境测试（合成行情）'
    : '历史情境测试（Tushare 动态行情）']));
  const srcGroup = el('div', { class: 'rp-control-group' });
  srcGroup.append(el('span', { class: 'rp-control-label' }, ['行情来源']));
  const srcSeg = el('div', { class: 'rp-seg' });
  for (const o of adapter.CONTRACT_MARKET_OPTIONS) {
    srcSeg.append(el('button', {
      class: marketSource === o.id ? 'active' : '',
      onclick: () => {
        if (marketSource === o.id) return;
        simToken = null;
        simContextLoadingKey = null;
        set({ contracts: { marketSource: o.id, simContext: null, sim: { ...state.contracts.sim, result: null, running: false } } });
      },
    }, [o.label]));
  }
  srcGroup.append(srcSeg);
  sim.append(srcGroup);
  sim.append(el('div', { class: 'row' }, [chip(labels.label, 'mode'), chip(labels.scopeNote, 'mode')]));
  const src = adapter.contractTradeSource(state.bill, marketSource);
  // 交易来源明细按当前规则的模板类型显示：不追回读取卖出记录，涨幅只读行情。
  const srcNote = hasBuyback && hasSurge
    ? '（仅不追回规则读取这些交易，涨幅规则不读取账单交易）'
    : hasBuyback
      ? '（不追回规则使用该来源的卖出记录）'
      : hasSurge
        ? '（涨幅规则只读取行情，不使用账单交易）'
        : '';
  sim.append(el('div', { class: `calc-line cv-source ${src.kind}` }, [
    `交易来源：${src.label} · 行情：${src.market_label}`,
    srcNote,
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
    sim.append(el('div', { class: 'muted' }, [`正在加载${marketSource === 'synthetic-fixture' ? '合成回归' : 'Tushare 动态'}行情与交易来源…`]));
    if (simContextLoadingKey !== src.key) {
      simContextLoadingKey = src.key;
      adapter.contractSimContext({ bill: state.bill, marketSource })
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
    sim.append(el('div', { class: 'error' }, [`行情加载失败：${sc.error}`]));
  } else {
    sim.append(el('div', { class: 'muted small' }, [
      `用当前生效的规则（${current.length} 条，每种类型一条）分别判定“假如在该日申报买入该标的”；历史规则不参与。行情范围 ${sc.range.start} ~ ${sc.range.end}，共 ${sc.tradingDays.length} 个交易日；缺价、超范围不补造、不回退。`,
    ]));
    if (sc.marketSource && sc.marketSource.dynamic) {
      sim.append(el('div', { class: 'muted small' }, [
        `行情拉取：${fmtAt(sc.marketSource.fetchedAt)} · 最新交易日 ${sc.marketSource.latestTradeDate ?? sc.marketSource.asOfDate}${sc.marketSource.snapshotId ? ` · 快照 ${sc.marketSource.snapshotId}` : ''}${sc.marketSource.checksum ? ` · 校验 ${sc.marketSource.checksum.slice(0, 12)}…` : ''}（服务端获取，非实时）`,
      ]));
    }
    const symSelect = el('select', {
      class: 'input', 'data-role': 'sim-symbol',
      onchange: (e) => { simToken = null; c.sim = { ...c.sim, symbol: e.target.value, result: null, running: false }; paintSim(); },
    }, sc.symbols.map((s) => el('option', { value: s.symbol, selected: s.symbol === c.sim.symbol ? 'selected' : null }, [
      `${s.symbol}${s.in_bill && src.kind === 'user_bill' ? '（账单标的）' : ''}${s.in_market_cache ? '' : '（不在本次行情）'}`,
    ])));
    const dateInput = el('input', { class: 'input cv-input', type: 'date', 'data-role': 'sim-date', value: c.sim.date });
    dateInput.addEventListener('input', (e) => { simToken = null; c.sim = { ...c.sim, date: e.target.value, result: null, running: false }; paintSim(); });
    simBtn = el('button', {
      class: 'btn primary',
      onclick: async () => {
        const req = { versions: c.versions, symbol: c.sim.symbol, date: c.sim.date, bill: state.bill, marketSource };
        const token = {};
        simToken = token;
        set({ contracts: { sim: { ...state.contracts.sim, running: true, result: null } } });
        const result = await adapter.simulateContracts(req);
        const applied = simToken === token;
        set({ contracts: { sim: { ...state.contracts.sim, running: false, result: applied ? result : null } } });
      },
    }, [c.sim.running ? '测试中…' : '测试该日买入是否触发规则']);
    sim.append(el('div', { class: 'row' }, [
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['标的（账单标的 + 示例标的）']), symSelect]),
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['申报日期']), dateInput]),
      simBtn,
    ]));
    if (hasBuyback) {
      const sells = sc.sells.map((s) => `${s.trade_id} ${s.symbol} ${s.trade_date}`).join('；') || '无';
      sim.append(el('div', { class: 'muted small cv-sells' }, [`卖出记录来源：${sc.tradesSource.label}——卖出：${sells}`]));
    }
  }
  sim.append(simResultBox);
  page.append(sim);

  function paintSim() {
    if (simBtn) simBtn.disabled = !!c.sim.running;
    simResultBox.replaceChildren(...(c.sim.result ? [simBatch(c.sim.result)] : []));
  }
  paintSim();

  /* —— 新增 / 修改弹窗：背景不可操作；Esc / 关闭 / 取消均不写记录 —— */
  const backdrop = c.modal ? renderModal() : null;
  closeActiveModal = c.modal ? closeEditor : null;
  if (c.modal) {
    bindEsc();
    page.setAttribute('inert', '');
    page.setAttribute('aria-hidden', 'true');
  }

  function renderModal() {
    const edit = c.modal.mode === 'edit';
    const target = edit ? ruleSet.current.find((r) => r.hash === c.modal.targetHash) ?? null : null;
    const tpl = templates.find((t) => t.template_id === c.draft.template_id) ?? templates[0];
    const preview = () => adapter.previewContract({ template_id: c.draft.template_id, fields: c.draft.fields });
    const dialog = el('div', { class: 'cv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cv-modal-title', tabindex: '-1', 'data-role': 'rule-modal' });
    dialog.append(el('div', { class: 'cv-modal-head' }, [
      el('h3', { id: 'cv-modal-title', class: 'cv-modal-title' }, [edit ? '修改交易规则' : '新增交易规则']),
      el('button', { class: 'cv-modal-close', type: 'button', 'aria-label': '关闭', 'data-role': 'modal-close', onclick: closeEditor }, ['×']),
    ]));
    if (target) {
      dialog.append(el('div', { class: 'cv-modal-note' }, [`正在修改当前规则「${target.text}」（版本 v${target.v}）。保存会生成一条新规则替换它；历史版本保持原样，不会被改写。`]));
    }
    if (edit) {
      dialog.append(el('div', { class: 'cv-field' }, [
        el('span', { class: 'muted small' }, ['规则模板（修改时不能更换类型）']),
        el('div', { class: 'cv-tpl-fixed' }, [tpl.name]),
      ]));
    } else {
      dialog.append(el('label', { class: 'cv-field' }, [
        el('span', { class: 'muted small' }, ['规则模板']),
        el('select', {
          class: 'input', 'data-role': 'template',
          onchange: (e) => {
            const next = templates.find((t) => t.template_id === e.target.value);
            if (next) set({ contracts: { draft: { ...draftFor(next), note: c.draft.note } } });
          },
        }, templates.map((t) => el('option', { value: t.template_id, selected: t.template_id === tpl.template_id ? 'selected' : null }, [t.name]))),
      ]));
    }
    dialog.append(el('div', { class: 'muted small' }, [`模板文本：${tpl.text_template}`]));
    const fieldRow = el('div', { class: 'row' });
    for (const f of tpl.fields) {
      const input = el('input', { class: 'input cv-input', type: 'text', inputmode: 'decimal', 'data-field': f.key, value: c.draft.fields[f.key] ?? '' });
      input.addEventListener('input', (e) => { c.draft.fields = { ...c.draft.fields, [f.key]: e.target.value }; paintLive(); });
      const rule = f.integer ? `整数，≥ ${f.min}` : `数字，≥ ${f.min}`;
      fieldRow.append(el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, [`${f.label}（${rule}；默认 ${f.default}）`]), input]));
    }
    dialog.append(fieldRow);
    const note = el('textarea', { class: 'input', rows: '2', 'data-role': 'note', placeholder: '可选：写下你为什么想要这条规则' });
    note.value = c.draft.note ?? '';
    note.addEventListener('input', (e) => { c.draft.note = e.target.value; });
    dialog.append(el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['备注（仅备注，不参与规则判定，不进入哈希）']), note]));

    const live = el('div', { class: 'cv-live' });
    const hint = el('div', { class: 'muted small cv-hint' });
    const replaceNote = el('div', { class: 'cv-replace-note' });
    const saveBtn = el('button', {
      class: 'btn primary', 'data-role': 'modal-save',
      onclick: () => commitAll(adapter.contractSaveRecords(c.versions, { parsed: preview(), note: c.draft.note }), { modal: null }),
    }, [edit ? '保存并替换当前规则' : '保存并启用']);
    dialog.append(live, el('div', { class: 'cv-modal-foot' }, [
      hint,
      replaceNote,
      el('div', { class: 'row cv-modal-actions' }, [
        el('button', { class: 'btn', 'data-role': 'modal-cancel', onclick: closeEditor }, ['取消']),
        saveBtn,
      ]),
    ]));

    function paintLive() {
      const parsed = preview();
      const d = adapter.contractEditorState(c.versions, parsed);
      const nodes = [el('div', { class: 'section-title' }, ['规则预览'])];
      if (!parsed.supported) {
        nodes.push(el('div', { class: 'cv-error' }, [
          el('div', { class: 'error' }, [`参数无效 · ${parsed.code}`]),
          el('div', { class: 'calc-line' }, [parsed.message]),
          el('div', { class: 'muted small' }, ['未生成规则：不猜测、不自动纠正；修正参数后才可保存。']),
        ]));
      } else {
        nodes.push(el('div', { class: 'rule-text' }, [parsed.text]));
        nodes.push(el('div', { class: 'calc-line' }, [`阈值：${parsed.threshold.display}`]));
        nodes.push(el('div', { class: 'calc-line' }, [`提醒：${parsed.reminder}`]));
        nodes.push(el('details', { class: 'cv-tech-note' }, [
          el('summary', {}, ['技术信息（候选哈希）']),
          el('div', { class: 'muted small cv-hash' }, [`${adapter.CONTRACT_HASH_NOTE}：${parsed.hash}`]),
          el('div', { class: 'muted small' }, [`哈希算法：${parsed.hash_algorithm}（占位算法，冻结后可能替换；覆盖模板、条件、参数与规则文本，不含备注）`]),
        ]));
      }
      live.replaceChildren(...nodes);
      saveBtn.disabled = !d.canSave;
      const hintText = {
        invalid: '参数无效：请先修正参数，保存不可用。',
        unchanged: '与当前规则相同：同一规则不会重复保存；备注不参与判定，不能单独形成新规则。',
        restore: `与历史版本 v${safe(d.same && d.same.v)} 相同：保存后将恢复该版本为当前规则，不新增版本号。`,
        blocked: '该参数对应的历史记录内容与校验标识不一致，不能保存；请换用其他参数。',
        new: `保存后生成版本 v${d.next_version}，立即参与历史情境测试。`,
      }[d.action];
      hint.replaceChildren(el('span', {}, [hintText]));
      const replacing = edit || (d.current && d.canSave);
      replaceNote.replaceChildren(...(replacing ? [el('span', {}, [d.current && !edit ? `已有同类型当前规则（版本 v${d.current.v}）。${REPLACE_NOTE}` : REPLACE_NOTE])] : []));
    }
    paintLive();
    return el('div', { class: 'cv-modal-backdrop', 'data-role': 'modal-backdrop' }, [dialog]);
  }

  root.append(page);
  if (backdrop) {
    root.append(backdrop);
    if (focusedModal !== c.modal) {
      focusedModal = c.modal;
      backdrop.children[0].focus();
    }
  } else {
    focusedModal = null;
  }
}

function simBatch(b) {
  const box = el('div', { class: 'cv-sim-batch' });
  box.append(el('div', { class: 'row' }, [el('strong', {}, [`${safe(b.symbol)} · 申报日 ${safe(b.requested_date)}`])]));
  const reconfirmNote = b.needs_reconfirm_n
    ? el('div', { class: 'muted small cv-reconfirm-note' }, [`另有 ${b.needs_reconfirm_n} 条规则因内容与候选哈希不一致未参与本次判定（见“待重新确认的规则”），不会自动修正。`])
    : null;
  if (b.empty) {
    box.append(el('div', { class: 'cv-sim-empty' }, ['本次没有当前生效的规则参与判定，不会产生契约提醒（不等于“未命中”）。']));
    if (reconfirmNote) box.append(reconfirmNote);
    box.append(el('div', { class: 'muted small' }, [`${b.label} · ${b.scopeNote}`]));
    return box;
  }
  const s = b.summary;
  box.append(el('div', { class: 'cv-sim-headline' }, [
    `本次测试：${b.rules_n} 条规则中，命中 ${s.triggered} 条 / 未命中 ${s.not_triggered} 条 / 数据不足 ${s.missing_data} 条${s.error ? ` / 无法判定 ${s.error} 条` : ''}`,
  ]));
  box.append(el('div', { class: 'cv-sim-used' }, [
    `本次测试使用的规则：${b.rules_used.map((r) => `${safe(r.template_name)}「${safe(r.text)}」（版本 v${safe(r.v)}）`).join('；')}`,
  ]));
  box.append(el('div', { class: 'row cv-sim-summary' }, SUMMARY.map(([k, label, kind]) => el('span', { class: `chip ${kind}`, 'data-verdict': k }, [`${label} ${b.summary[k]} 条`]))));
  box.append(el('div', { class: 'muted small' }, ['每种类型的当前规则在同一情境下分别判定，结果互不覆盖；历史规则不参与。涨幅规则只用行情，不追回规则才读取账单交易。']));
  if (reconfirmNote) box.append(reconfirmNote);
  for (const r of b.results) box.append(simResult(r));
  return box;
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
  const v = r.ok ? VERDICT[r.verdict] ?? { text: safe(r.verdict), kind: 'mode' } : { text: '无法判定', kind: 'warn' };
  const box = el('div', { class: `cv-sim-result ${r.ok ? r.verdict : 'error'}`, 'data-hash': r.rule.hash });
  box.append(el('div', { class: 'row' }, [
    el('span', { class: `chip cv-verdict ${v.kind}` }, [v.text]),
    chip(`版本 v${safe(r.rule.v)}`, 'mode'),
    el('strong', {}, [safe(r.rule.text)]),
  ]));
  box.append(el('div', { class: 'muted small' }, [`${safe(r.symbol)} · 申报日 ${safe(r.requested_date)} · ${safe(r.rule.template_name)} · ${r.rule.fields_text}`]));
  if (!r.ok) {
    box.append(el('div', { class: 'cv-error' }, [
      el('div', { class: 'error' }, [`无法判定 · ${safe(r.code)}`]),
      el('div', { class: 'calc-line' }, [safe(r.message)]),
    ]));
  } else if (r.verdict === 'missing_data') {
    box.append(el('div', { class: 'calc-line' }, [`原因码：${safe(r.code)}`]));
    box.append(el('div', { class: 'calc-line' }, [`引擎原因：${r.change && !r.change.complete ? r.change.message : safe(r.message)}`]));
    box.append(el('div', { class: 'muted small' }, ['数据不足：不补造数值、不回退其他日期，本次不作命中判定。']));
  } else {
    const m = r.match;
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
    box.append(el('div', { class: 'muted small' }, [`标的 ${safe(r.symbol)} 不在本次行情支持范围：${r.uses_trades ? '不追回判定只使用交易日历与账单交易，不读取价格' : '无法读取涨跌幅'}；不替换标的、不回退其他行情来源。`]));
  }
  box.append(el('div', { class: 'muted small cv-hash' }, [`判定所用规则：${safe(r.match ? r.match.contract_text : r.rule.text)} · ${adapter.CONTRACT_HASH_NOTE}：${safe(r.match ? r.match.contract_hash : r.rule.hash)}`]));
  box.append(el('div', { class: 'muted small' }, [`${r.label} · ${r.scopeNote}`]));
  return box;
}
