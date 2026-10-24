// 交易规则（契约）：当前生效规则（每种类型最多一条）→ 历史规则（折叠）→ 新增 / 修改弹窗；历史操作复盘在 #/scenario。
// 边界：当前 / 历史划分、版本状态机、解析与判定全部由 adapter 提供（adapter 内部调用引擎）；本页只渲染返回的文本与 display。
import { el, chip } from '../components.js';
import * as adapter from '../../demo/adapter.js';
import { buildRuleCandidates } from '../../engine/userProfile.js';
import { renderScenarioReview } from './scenarioReviewView.js';
import { saveContractsDemo, defaultContracts } from '../../state.js';

const ACTION_LABEL = Object.freeze({ buy: '买入提醒', sell: '卖出提醒' });
const INTRO = '设置在操作复盘中用于提醒自己的交易规则。规则仅用于提醒，不会自动交易或阻止交易。';
const PRIVACY = '不会自动交易，也不会改变分析报告结论。操作复盘只使用当前生效规则。';
// const AGENT_NOTE = '操作复盘只使用当前生效规则。';
const CURRENT_NOTE = '不同类型或不同股票范围的规则可以同时生效；同一类型、同一范围只保留一条当前规则，保存新参数后旧规则进入历史规则。';
const REPLACE_NOTE = '保存后，新规则会立即生效；当前同类型规则会进入历史记录，不再参与测试。';
const STOP_NOTE = '停用后，该规则进入历史规则，不再参与之后的操作复盘；可随时恢复为当前规则。';
const RECONFIRM_NOTE = '这条规则的保存内容与当前校验标识不一致。为避免误用，它暂不参与测试。请核对后用“新增规则”重新保存，或停用该规则。';
const EMPTY_NOTE = '暂无当前生效的规则，测试时不会产生规则提醒。点击“新增规则”开始设置。';

const HISTORY_NOTE = '被新规则替代、手动停用的规则和旧演示记录都保留在这里，不参与测试；版本记录只追加、不删除。';
const HISTORY_TAG = Object.freeze({ replaced: '已被替代', superseded: '已被替代', stopped: '已停用' });
const NL_INTRO = '用一句话描述你想遵守的交易规则，系统会识别并生成规则预览；识别与关键词检查只是辅助，请对照原话核对。你确认后才会保存并启用，取消或修改描述都不会生效。';
const NL_PRIVACY = '识别时只把下方输入框里的这段文字发送到站点服务端，由站点模型服务理解意图；不发送 CSV、交易记录、账户信息或已保存的规则。规则是否合法、能否执行、测试时是否命中，均由本地程序按规则模板确定性判定，不执行模型生成的任何代码。';
const NL_CHECK_WARNING = '关键词和模型检查只能覆盖常见表达，不能保证发现所有股票名称、附加条件或隐含限定；系统不承诺“绝不遗漏”，请务必逐字对照原话核对。';
const NL_FALLBACK = '已有规则、模板新增与操作复盘不受影响；也可以改选具体模板直接填写参数。';
const CUSTOM_TEMPLATE = '__custom__';
const SCOPE_UI_LABEL = Object.freeze({ all: '全部股票', symbol: '单个股票' });
const NL_STATUS = Object.freeze({
  supported: { text: '当前系统支持执行', kind: 'ok' },
  unsupported: { text: '暂不支持', kind: 'warn' },
  unclear: { text: '需要补充', kind: 'mode' },
  invalid: { text: '参数无效', kind: 'warn' },
  error: { text: '识别未完成', kind: 'warn' },
});

const safe = (x) => (x === null || x === undefined || x === '' ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
const fmtAt = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? safe(at) : d.toLocaleString('zh-CN'); };
const displayMarket = (label) => String(label || '').replace('（m0 夹具，非真实行情）', '（非真实行情）');
const displayTradeSource = (source) => (source && source.kind === 'demo_bill_a' ? '演示账单 A（合成）' : source ? source.label : '');

// 自定义规则哈希计算（与 adapter.js computeCustomHash 保持一致）
function computeCustomHashForSave(text, action, scope) {
  const canonical = {
    schema: 'custom-v1',
    kind: 'custom',
    text: String(text ?? '').trim(),
    action: action ?? 'unconfirmed',
    scope: scope && scope.kind === 'symbol' ? { kind: 'symbol', symbol: scope.symbol } : { kind: 'all' },
  };
  return adapter.CONTRACT_CUSTOM_HASH(canonical);
}

let nlToken = null;
let focusedModal = null;
let closeActiveModal = null;
let escBound = false;

// Esc 关闭弹窗：document 级只绑定一次，关闭动作指向最近一次渲染的弹窗
function bindEsc() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closeActiveModal) closeActiveModal(); });
}

function scopeDraftOf(scope) {
  return scope && scope.kind === 'symbol' ? { kind: 'symbol', symbol: scope.symbol } : { kind: 'all', symbol: '' };
}

function draftFor(tpl, fromRule = null) {
  const fields = {};
  for (const f of tpl.fields) {
    const saved = fromRule ? fromRule.fields?.[f.key] : undefined;
    fields[f.key] = String(saved === undefined ? f.default : saved);
  }
  return { template_id: tpl.template_id, fields, note: fromRule ? fromRule.latest_note : '', scope: scopeDraftOf(fromRule ? fromRule.scope : null) };
}

// 页面草稿 → 引擎入参：只去掉代码两端空白，格式由引擎校验（不补零、不纠正）
const scopeArgOf = (draft) => (draft && draft.scope && draft.scope.kind === 'symbol' ? { kind: 'symbol', symbol: String(draft.scope.symbol ?? '').trim() } : { kind: 'all' });

// 替代时的范围变化：须勾选确认才能保存 / 恢复；确认绑定到具体的变化说明，参数改动后需重新确认
function scopeChangeBox(change, acked, onToggle, role) {
  if (!change) return null;
  if (!change.requires_ack) return el('div', { class: 'muted small cv-scope-same' }, [change.message]);
  const box = el('input', { type: 'checkbox', 'data-role': role, checked: acked ? '' : null });
  box.addEventListener('change', (e) => onToggle(!!e.target.checked));
  return el('div', { class: 'cv-scope-change', 'data-scope-change': change.kind }, [
    el('div', { class: 'calc-line' }, [`适用范围变化：${change.from} → ${change.to}`]),
    el('div', { class: 'cv-nl-warn' }, [change.message]),
    el('label', { class: 'cv-nl-ack' }, [box, el('span', {}, ['我已知晓适用范围的变化，确认替代当前规则。'])]),
  ]);
}

// 触发条件只拼接引擎解析返回的阈值 display（不重新格式化数字）
function conditionText(rule) {
  const d = rule.parsed?.threshold?.display;
  if (!d) return null;
  if (rule.kind === 'change_pct_threshold') return `触发条件：申报买入当天涨幅超过 ${d}`;
  if (rule.kind === 'sell_buyback_window') return `触发条件：卖出后 ${d}内再次买入同一标的`;
  if (rule.kind === 'buy_sell_window') return `触发条件：买入后 ${d}内卖出同一标的（不含买入当天，同日买入不计）`;
  return null;
}

// 自定义规则的"规则理解"转为"触发条件"时，去掉末尾的动作性表述（提醒不要买入/卖出等）
function customTriggerText(understanding) {
  if (!understanding) return null;
  const cleaned = understanding
    .replace(/，?提醒不要买(入|股)[。.]?$/u, '')
    .replace(/，?提醒不要卖(出|股)[。.]?$/u, '')
    .replace(/，?则不买[。.]?$/u, '')
    .replace(/，?则不卖[。.]?$/u, '')
    .replace(/，?提醒我[。.]?$/u, '')
    .trim();
  return cleaned ? `触发条件：${cleaned}` : null;
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
  const confirmations = { 'day_unit:trading_day': '“天”按交易日计', 'comparator:gt': '按超过阈值判定（不含等于）' };
  const choices = Object.entries(rule.origin_confirmations ?? {});
  return el('details', { class: 'cv-tech-note', 'data-role': 'rule-detail' }, [
    el('summary', {}, ['查看详情']),
    rule.origin_text ? el('div', { class: 'muted small' }, [`用户原话：${safe(rule.origin_text)}`]) : null,
    rule.is_custom && rule.text ? el('div', { class: 'muted small' }, [`用户原话：${safe(rule.text)}`]) : null,
    rule.understanding ? el('div', { class: 'muted small' }, [`规则理解：${safe(rule.understanding)}`]) : null,
    choices.length ? el('div', { class: 'muted small' }, [`保存时确认：${choices.map(([k, v]) => confirmations[`${k}:${v}`] ?? '已确认').join('；')}`]) : null,
    rule.timing ? el('div', { class: 'muted small' }, [`时间口径：${safe(rule.timing)}`]) : null,
    ...(rule.notes ?? []).map((note) => el('div', { class: 'muted small' }, [`备注：${safe(note)}`])),
    rule.integrity && !rule.integrity.ok ? el('div', { class: 'muted small' }, [`校验结果：${safe(rule.integrity.message)}`]) : null,
    ...(rule.records ?? []).map((record) => el('div', { class: 'muted small' }, [`版本 v${safe(record.v)} · ${safe(record.status)}${record.via ? ` · ${safe(record.via)}` : ''} · ${fmtAt(record.at)}`])),
    rule.decision_statement ? el('div', { class: 'cv-decision' }, [`决策说明：${safe(rule.decision_statement.text)}`]) : null,
  ]);
}

export function renderContract(root, ctx, { section = 'rules' } = {}) {
  if (section === 'scenario') {
    renderScenarioReview(root, ctx);
    return;
  }
  const { state, set } = ctx;
  state.contracts = { ...defaultContracts(), ...state.contracts };
  const c = state.contracts;
  const templates = adapter.contractTemplates();
  const ruleSet = adapter.contractRuleSet(c.versions);
  const slotOf = (template_id) => ruleSet.slots.find((s) => s.template_id === template_id) ?? null;

  function commitAll(recs, extra = {}) {
    if (!recs || !recs.length) return;
    const versions = [...c.versions, ...recs];
    set({ contracts: { versions, simContext: null, sim: { ...c.sim, result: null, running: false, runId: null, fallback: null }, ...extra } });
    const saveRules = ctx?.cloudDeps?.saveRules;
    if (typeof saveRules === 'function') {
      Promise.resolve(saveRules({ versions })).catch(() => {});
      return;
    }
    saveContractsDemo();
  }
  function openEditor(mode, { rule = null, template_id = null, action = null } = {}) {
    if (mode === 'edit' && rule?.is_custom) {
      const result = { status: 'supported', is_custom: true, rule_id: rule.rule_id, text: rule.text, action: rule.action, scope: rule.scope, scope_text: rule.scope_text, understanding: rule.understanding, checks: [] };
      set({ contracts: { modal: { mode, targetHash: rule.hash, targetRuleId: rule.rule_id, actionFilter: null }, draft: { template_id: CUSTOM_TEMPLATE, fields: {}, note: rule.latest_note, scope: scopeDraftOf(rule.scope) }, nl: { ...emptyNl(), text: rule.text, status: 'done', result, actionChoice: rule.action } } });
      return;
    }
    const wanted = rule ? rule.template_id : template_id;
    const filtered = action ? templates.filter((t) => t.action === action) : templates;
    const pool = filtered.length ? filtered : templates;
    const fewestTpl = [...pool].sort((a, b) => (slotOf(a.template_id)?.current ? 1 : 0) - (slotOf(b.template_id)?.current ? 1 : 0))[0];
    const tpl = templates.find((t) => t.template_id === wanted) ?? fewestTpl ?? pool[0];
    set({ contracts: { modal: { mode, targetHash: rule ? rule.hash : null, actionFilter: action }, draft: draftFor(tpl, rule) } });
  }
  const closeEditor = () => {
    nlToken = null;
    set({
      contracts: { modal: null, nl: null },
      assistant: state.assistant.pendingConfirmationFlowId
        ? { ...state.assistant, pendingConfirmationFlowId: null }
        : state.assistant,
    });
  };
  const emptyNl = () => ({ text: '', status: 'idle', result: null, choices: {}, ack: false, actionChoice: null, flowId: null, modelCalls: 0, budgetMax: 2 });

  const page = el('div', { class: 'stack cv-page' });

  /* —— 页头 —— */
  page.append(el('div', { class: 'card cv-head' }, [
    el('div', { class: 'cv-head-main' }, [
      el('h2', { class: 'cv-title' }, ['交易规则']),
      el('div', { class: 'cv-intro' }, [INTRO]),
      el('div', { class: 'cv-privacy' }, [PRIVACY]),
      // el('div', { class: 'muted small cv-agent-note' }, [AGENT_NOTE]),
    ]),
  ]));

  /* —— 当前生效规则：按类型，每种类型最多一条（由 adapter 派生）—— */
  const currentBox = el('div', { class: 'card cv-current' });
  let pendingStop = null;
  const stop = (hash, rule_id) => commitAll(adapter.contractStopRecords(c.versions, { hash, rule_id }));

  /* —— 规则候选：只来自本账单证据，放在当前生效规则上方 —— */
  const candidateBox = el('div', { class: 'card cv-candidates', 'data-role': 'rule-candidates' });
  let candidateToken = 0;
  const CANDIDATE_TITLE = '规则候选（来自本账单证据）';
  const CANDIDATE_NOTE = '候选只做模板预填；保存前由你确认或改写，系统不会自动启用。';

  function candidateEmpty(message) {
    candidateBox.replaceChildren(
      el('div', { class: 'section-title' }, [CANDIDATE_TITLE]),
      el('div', { class: 'muted small' }, [message]),
    );
  }

  function markCandidate(candidate, status) {
    try {
      ctx.qaDeps?.recordCandidateEvent?.(candidate.candidate_id, status);
    } catch { /* 本地画像记录失败不阻断候选区重绘 */ }
    void paintCandidates();
  }

  function openCandidate(candidate) {
    if (typeof ctx.qaDeps?.openRuleCandidate === 'function') ctx.qaDeps.openRuleCandidate(ctx, candidate);
  }

  function candidateCard(candidate) {
    const tone = candidate.status === 'available' ? 'warn' : candidate.status === 'active' ? 'ok' : 'mode';
    const actions = [];
    if (candidate.status === 'available') {
      actions.push(el('button', { class: 'btn small', 'data-role': 'candidate-open', onclick: () => openCandidate(candidate) }, ['打开模板确认']));
      actions.push(el('button', { class: 'btn small', 'data-role': 'candidate-dismiss', onclick: () => markCandidate(candidate, 'dismissed') }, ['忽略这条候选']));
    } else if (candidate.status === 'dismissed') {
      actions.push(el('button', { class: 'btn small', 'data-role': 'candidate-restore', onclick: () => markCandidate(candidate, 'restored') }, ['恢复候选']));
    }
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.slice(0, 6) : [];
    return el('div', { class: 'cv-candidate', 'data-candidate-id': candidate.candidate_id, 'data-status': candidate.status }, [
      el('div', { class: 'row cv-candidate-head' }, [
        chip(candidate.status_text, tone),
        el('span', { class: 'cv-candidate-name' }, [safe(candidate.template_name)]),
      ]),
      el('div', { class: 'cv-rule-text' }, [safe(candidate.text)]),
      el('div', { class: 'muted small' }, [safe(candidate.reason)]),
      el('div', { class: 'muted small' }, [safe(candidate.basis)]),
      evidence.length
        ? el('ul', { class: 'cv-candidate-evidence' }, evidence.map((item) => el('li', {}, [`${safe(item.trade_id)} · ${safe(item.line)}`])))
        : null,
      el('div', { class: 'muted small cv-candidate-caveat' }, [safe(candidate.caveat)]),
      actions.length ? el('div', { class: 'row cv-candidate-actions' }, actions) : null,
    ]);
  }

  async function paintCandidates() {
    const token = ++candidateToken;
    const bill = state.bill;
    const usable = bill && bill.status === 'confirmed' && bill.sourceType === 'local' && bill.demo !== true;
    if (!usable) {
      candidateBox.hidden = true;
      return;
    }
    candidateBox.hidden = false;
    candidateEmpty('正在读取本账单证据…');

    let bundle = null;
    try {
      bundle = ctx.qaDeps?.getReportBundle?.(bill) ?? null;
      if (!bundle && typeof ctx.qaDeps?.loadReportBundle === 'function') bundle = await ctx.qaDeps.loadReportBundle(bill);
    } catch (error) {
      if (token !== candidateToken || !candidateBox.isConnected) return;
      candidateEmpty(`本次没有读取到规则候选：${safe(error && error.message ? error.message : error)}`);
      return;
    }
    if (token !== candidateToken || !candidateBox.isConnected) return;
    if (state.bill?.contextId !== bill.contextId) return;

    const published = bundle?.review?.portfolio_published === true;
    const behavior = published && bundle?.insights?.behavior?.available ? bundle.insights.behavior.data : null;
    if (!published) {
      candidateEmpty('当前账单组合结果未发布：暂不生成规则候选。');
      return;
    }
    if (!behavior) {
      candidateEmpty('本账单的行为发现暂不可用：暂不生成规则候选。');
      return;
    }

    let pack = null;
    try {
      pack = buildRuleCandidates({
        behavior,
        ruleState: typeof ctx.qaDeps?.ruleStateOf === 'function' ? ctx.qaDeps.ruleStateOf(c.versions) : null,
        profile: typeof ctx.qaDeps?.loadProfile === 'function' ? ctx.qaDeps.loadProfile() : null,
      });
    } catch {
      pack = null;
    }
    const candidates = Array.isArray(pack?.candidates) ? pack.candidates : [];
    if (!candidates.length) {
      candidateEmpty('当前没有可建立的规则候选。');
      return;
    }

    const visible = candidates.filter((item) => item.status !== 'not_recommended');
    const notRecommended = candidates.filter((item) => item.status === 'not_recommended');
    const nodes = [
      el('div', { class: 'section-title' }, [CANDIDATE_TITLE]),
      el('div', { class: 'muted small' }, [CANDIDATE_NOTE]),
    ];
    if (visible.length) nodes.push(...visible.map(candidateCard));
    else nodes.push(el('div', { class: 'muted cv-empty' }, ['当前没有可建立的规则候选。']));
    if (notRecommended.length) {
      nodes.push(el('details', { class: 'cv-candidate-more', 'data-role': 'not-recommended' }, [
        el('summary', {}, [`${notRecommended.length} 条行为模式尚未达到可建规则的条件`]),
        ...notRecommended.map(candidateCard),
      ]));
    }
    candidateBox.replaceChildren(...nodes);
  }


  function currentCard(rule) {
    const stopKey = `${rule.rule_id ?? ''}:${rule.hash}`;
    const confirming = pendingStop === stopKey;
    const isCustom = rule.is_custom === true;
    const cond = isCustom ? customTriggerText(rule.understanding) : conditionText(rule);
    return el('div', { class: `cv-rule on${isCustom ? ' cv-rule-custom' : ''}`, 'data-hash': rule.hash }, [
      el('div', { class: 'row cv-rule-head' }, [
        chip('已启用', 'ok'),
        el('span', { class: 'cv-rule-name' }, [isCustom ? '自定义规则' : null]),
        el('span', { class: 'cv-rule-ver' }, [`版本 v${safe(rule.v)}`]),
        el('span', { class: 'cv-rule-actions' }, [
          confirming ? null : el('button', { class: 'btn small', 'data-role': 'edit', onclick: () => openEditor('edit', { rule }) }, ['编辑']),
          confirming ? null : el('button', { class: 'btn small danger', 'data-role': 'stop', onclick: () => { pendingStop = stopKey; paintCurrent(); } }, ['停用']),
        ]),
      ]),
      el('div', { class: 'cv-rule-text' }, [safe(rule.text)]),
      rule.decision_statement ? el('div', { class: 'cv-decision cv-decision-current' }, [`决定自述：${safe(rule.decision_statement.text)}`]) : null,
      el('div', { class: 'cv-rule-scope', 'data-scope': rule.scope && rule.scope.kind === 'symbol' ? rule.scope.symbol : 'all' }, [`适用范围：${safe(rule.scope_text)}`]),
      cond ? el('div', { class: 'cv-rule-cond' }, [cond]) : null,
      confirming ? el('div', { class: 'cv-confirm' }, [
        el('div', { class: 'calc-line' }, [`确认停用\u201c${safe(rule.text)}\u201d？`]),
        el('div', { class: 'muted small' }, [STOP_NOTE]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn small danger', 'data-role': 'stop-confirm', onclick: () => stop(rule.hash, rule.rule_id) }, ['确认停用']),
          el('button', { class: 'btn small', 'data-role': 'stop-cancel', onclick: () => { pendingStop = null; paintCurrent(); } }, ['取消']),
        ]),
      ]) : null,
      ruleDetail(rule),
    ]);
  }

  function paintCurrent() {
    const actionGroups = new Map();
    const unknownActionSlots = [];
    // 模板规则按 action 分组；同一模板的不同范围可能同时生效。
    for (const s of ruleSet.slots) {
      const tplAction = adapter.contractTemplates().find((t) => t.template_id === s.template_id)?.action ?? null;
      const action = (s.current ? s.current.action : null) ?? tplAction;
      if (!action) {
        unknownActionSlots.push(s);
        continue;
      }
      if (!actionGroups.has(action)) actionGroups.set(action, []);
      actionGroups.get(action).push(s);
    }
    // 自定义规则按 action 分组（both 出现在两组）
    const customByAction = new Map();
    for (const r of ruleSet.customCurrent ?? []) {
      if (!r.integrity.ok) continue;
      const actions = r.action === 'both' ? ['buy', 'sell'] : r.action ? [r.action] : [];
      if (!actions.length) {
        if (!customByAction.has('unknown')) customByAction.set('unknown', []);
        customByAction.get('unknown').push(r);
        continue;
      }
      for (const a of actions) {
        if (!customByAction.has(a)) customByAction.set(a, []);
        customByAction.get(a).push(r);
      }
    }
    const actionOrder = ['buy', 'sell'];
    const totalCount = ruleSet.current.length + (ruleSet.customCurrent ?? []).length;
    const nodes = [
      el('div', { class: 'section-title' }, [`当前生效规则（${totalCount}）`]),
      el('div', { class: 'muted small' }, [CURRENT_NOTE]),
    ];
    if (totalCount === 0 && !unknownActionSlots.length && !customByAction.has('unknown')) nodes.push(el('div', { class: 'muted cv-empty' }, [EMPTY_NOTE]));
    for (const action of actionOrder) {
      const slots = actionGroups.get(action);
      const customs = customByAction.get(action);
      const hasRules = (slots && slots.some((s) => s.current)) || (customs && customs.length);
      if (!hasRules) {
        // 该分类无规则：显示空状态 + 新增按钮
        nodes.push(el('div', { class: 'cv-action-group', 'data-action': action }, [
          el('div', { class: 'cv-action-title-row' }, [
            el('div', { class: 'cv-action-title' }, [ACTION_LABEL[action] ?? action]),
            el('button', { class: 'btn small', 'data-role': `add-rule-${action}`, onclick: () => openEditor('add', { action }) }, ['新增规则']),
          ]),
          el('div', { class: 'muted small cv-action-empty' }, [`暂无${ACTION_LABEL[action] ?? action}，点击"新增规则"开始设置。`]),
        ]));
        continue;
      }
      const groupNodes = [];
      if (slots) {
        for (const s of slots) {
          if (!s.current) continue;
          const slotChildren = [];
          for (const rule of s.currents) slotChildren.push(currentCard(rule));
          groupNodes.push(el('div', { class: 'cv-slot', 'data-template': s.template_id, 'data-action': action }, slotChildren));
        }
      }
      if (customs) {
        groupNodes.push(...customs.map((r) => el('div', { class: 'cv-slot cv-slot-custom', 'data-rule-id': r.rule_id, 'data-action': action }, [
          currentCard(r),
        ])));
      }
      nodes.push(el('div', { class: 'cv-action-group', 'data-action': action }, [
        el('div', { class: 'cv-action-title-row' }, [
          el('div', { class: 'cv-action-title' }, [ACTION_LABEL[action] ?? action]),
          el('button', { class: 'btn small', 'data-role': `add-rule-${action}`, onclick: () => openEditor('add', { action }) }, ['新增规则']),
        ]),
        ...groupNodes,
      ]));
    }
    // 动作待确认区域
    const unknownCustoms = customByAction.get('unknown') ?? [];
    if (unknownActionSlots.length || unknownCustoms.length) {
      const unknownNodes = [];
      if (unknownActionSlots.length) {
        for (const s of unknownActionSlots) {
          const slotChildren = [];
          for (const rule of s.currents) slotChildren.push(currentCard(rule));
          unknownNodes.push(el('div', { class: 'cv-slot', 'data-template': s.template_id, 'data-action': 'unknown' }, slotChildren));
        }
      }
      if (unknownCustoms.length) {
        unknownNodes.push(...unknownCustoms.map((r) => el('div', { class: 'cv-slot cv-slot-custom', 'data-rule-id': r.rule_id, 'data-action': 'unknown' }, [
          el('div', { class: 'cv-group-title' }, ['自定义规则（动作待确认）']),
          currentCard(r),
        ])));
      }
      nodes.push(el('div', { class: 'cv-action-group cv-action-unknown', 'data-action': 'unknown' }, [
        el('div', { class: 'cv-action-title' }, ['动作待确认']),
        el('div', { class: 'muted small cv-action-note' }, ['以下规则的提醒动作无法确定，请核对后修改或停用。']),
        ...unknownNodes,
      ]));
    }
    currentBox.replaceChildren(...nodes);
  }
  paintCurrent();
  page.append(candidateBox, currentBox);

  /* —— 待重新确认（异常）：不计入当前规则、不参与测试 —— */
  if (ruleSet.needsReconfirm.length) {
    page.append(el('div', { class: 'card cv-reconfirm-box' }, [
      el('div', { class: 'cv-group-title' }, [`待重新确认的规则（${ruleSet.needsReconfirm.length}）`]),
      el('div', { class: 'muted small' }, ['以下规则不计入当前生效规则，也不参与操作复盘。']),
      ...ruleSet.needsReconfirm.map((r) => el('div', { class: 'cv-rule reconfirm', 'data-hash': r.hash }, [
        el('div', { class: 'row cv-rule-head' }, [
          chip('待重新确认', 'warn'),
          el('span', { class: 'cv-rule-name' }, [safe(r.template_name)]),
          el('span', { class: 'cv-rule-ver' }, [`版本 v${safe(r.v)}`]),
          el('span', { class: 'cv-rule-actions' }, [el('button', { class: 'btn small danger', 'data-role': 'stop', onclick: () => stop(r.hash, r.rule_id) }, ['停用'])]),
        ]),
        el('div', { class: 'cv-rule-text' }, [safe(r.text)]),
        el('div', { class: 'cv-reconfirm-why' }, [RECONFIRM_NOTE]),
        ruleDetail(r),
      ])),
    ]));
  }

  /* —— 历史规则（默认折叠）：被替代 / 手动停用 / 旧演示记录 —— */
  function historyItem(rule) {
    const preview = adapter.contractRestoreState(c.versions, { hash: rule.hash, rule_id: rule.rule_id });
    const pending = c.restorePending === rule.hash;
    const restore = () => {
      if (preview.scope_change?.requires_ack && !pending) { set({ contracts: { restorePending: rule.hash } }); return; }
      commitAll(adapter.contractRestoreRecords(c.versions, { hash: rule.hash, rule_id: rule.rule_id, confirmScopeChange: pending }), { restorePending: null });
    };
    return el('div', { class: `cv-hist ${rule.state}`, 'data-hash': rule.hash, 'data-state': rule.state }, [
      el('div', { class: 'row cv-rule-head' }, [
        chip(HISTORY_TAG[rule.state] ?? '历史', 'mode'),
        el('span', { class: 'cv-rule-name' }, [safe(rule.template_name)]),
        el('span', { class: 'cv-rule-ver' }, [`版本 v${safe(rule.v)}`]),
        preview.restorable
          ? el('span', { class: 'cv-rule-actions' }, [el('button', { class: 'btn small', 'data-role': 'restore', onclick: restore }, [pending ? '确认恢复' : '恢复为当前规则'])])
          : null,
      ]),
      el('div', { class: 'cv-rule-text' }, [safe(rule.text)]),
      el('div', { class: 'cv-rule-scope' }, [`适用范围：${safe(rule.scope_text)}`]),
      pending && preview.scope_change ? el('div', { class: 'cv-confirm' }, [el('div', {}, [preview.scope_change.message]), el('button', { class: 'btn small', onclick: () => set({ contracts: { restorePending: null } }) }, ['取消恢复'])]) : null,
      preview.conflict ? el('div', { class: 'muted small' }, ['该范围已有其他生效规则，请先处理后再恢复。']) : null,
      el('div', { class: 'cv-hist-reason' }, [historyReason(rule)]),
      rule.restorable ? el('div', { class: 'muted small' }, ['恢复后，该规则重新参与操作复盘；其余规则不受影响。']) : null,
      ruleDetail(rule),
    ]);
  }
  const legacyItem = (rec) => el('div', { class: 'cv-hist legacy' }, [
    el('div', { class: 'row cv-rule-head' }, [chip('旧演示记录', 'mode'), el('span', { class: 'cv-rule-text' }, [safe(rec.text)])]),
    el('div', { class: 'muted small' }, [`旧版本 v${safe(rec.v)} · ${safe(rec.status)}`]),
    el('div', { class: 'cv-hist-reason' }, ['未经规则引擎解析：不参与测试，不能恢复。']),
  ]);
  const histCount = ruleSet.history.length + ruleSet.legacy.length;
  page.append(el('details', { class: 'card cv-history', 'data-role': 'history', open: c.restorePending ? '' : null }, [
    el('summary', {}, [`历史规则（${histCount}）`]),
    el('div', { class: 'muted small' }, [HISTORY_NOTE]),
    histCount ? null : el('div', { class: 'muted small' }, ['暂无历史规则。']),
    ...ruleSet.history.map(historyItem),
    ...ruleSet.legacy.map(legacyItem),
  ]));

  /* —— 新增 / 修改弹窗：背景不可操作；Esc / 关闭 / 取消均不写记录 —— */
  const backdrop = c.modal ? renderModal() : null;
  closeActiveModal = c.modal ? closeEditor : null;
  if (c.modal) {
    bindEsc();
    page.setAttribute('inert', '');
    page.setAttribute('aria-hidden', 'true');
  }

  function renderModal() {
    const custom = c.draft.template_id === CUSTOM_TEMPLATE;
    const tpl = custom ? null : templates.find((t) => t.template_id === c.draft.template_id) ?? templates[0];
    const preview = () => adapter.previewContract({ template_id: c.draft.template_id, fields: c.draft.fields, scope: scopeArgOf(c.draft) });
    const isEdit = c.modal?.mode === 'edit';
    const dialog = el('div', { class: 'cv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cv-modal-title', tabindex: '-1', 'data-role': 'rule-modal' });
    dialog.append(el('div', { class: 'cv-modal-head' }, [
      el('h3', { id: 'cv-modal-title', class: 'cv-modal-title' }, [isEdit ? '编辑交易规则' : '新增交易规则']),
      el('button', { class: 'cv-modal-close', type: 'button', 'aria-label': '关闭', 'data-role': 'modal-close', onclick: closeEditor }, ['×']),
    ]));
    dialog.append(el('label', { class: 'cv-field' }, [
        el('span', { class: 'muted small' }, ['规则模板']),
        el('select', {
          class: 'input', 'data-role': 'template', disabled: isEdit ? '' : null,
          onchange: (e) => {
            nlToken = null;
            if (e.target.value === CUSTOM_TEMPLATE) {
              const defaultAction = c.modal?.actionFilter ?? null;
              set({ contracts: { draft: { template_id: CUSTOM_TEMPLATE, fields: {}, note: c.draft.note, scope: c.draft.scope ?? scopeDraftOf(null) }, nl: { ...emptyNl(), actionChoice: defaultAction } } });
              return;
            }
            const next = templates.find((t) => t.template_id === e.target.value);
            if (next) set({ contracts: { draft: { ...draftFor(next), note: c.draft.note, scope: c.draft.scope ?? scopeDraftOf(null) }, nl: null } });
          },
        }, [
          ...templates.filter((t) => !c.modal?.actionFilter || t.action === c.modal.actionFilter).map((t) => el('option', { value: t.template_id, selected: t.template_id === c.draft.template_id ? 'selected' : null }, [t.name])),
          el('option', { value: CUSTOM_TEMPLATE, selected: custom ? 'selected' : null }, ['自定义规则（用一句话描述）']),
        ]),
      ]));
    if (custom) {
      dialog.append(renderNlEditor());
      return el('div', { class: 'cv-modal-backdrop', 'data-role': 'modal-backdrop' }, [dialog]);
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
    const scopeDraft = c.draft.scope ?? scopeDraftOf(null);
    c.draft.scope = scopeDraft;
    const scopeSelect = el('select', {
      class: 'input cv-scope-select', 'data-role': 'scope-kind',
      onchange: (e) => {
        const kind = e.target.value;
        const current = c.draft.scope ?? scopeDraftOf(null);
        if (kind !== current.kind) set({ contracts: { draft: { ...c.draft, scope: { kind, symbol: current.symbol ?? '' } } } });
      },
    }, adapter.CONTRACT_SCOPE_OPTIONS.map((o) => el('option', { value: o.kind, selected: o.kind === scopeDraft.kind ? 'selected' : null }, [SCOPE_UI_LABEL[o.kind] ?? o.label])));
    const scopeNodes = [el('span', { class: 'muted small' }, ['适用范围']), scopeSelect];
    if (scopeDraft.kind === 'symbol') {
      const symInput = el('input', { class: 'input cv-input', type: 'text', inputmode: 'numeric', maxlength: '6', 'data-role': 'scope-symbol-input', placeholder: '例如 600519', value: scopeDraft.symbol ?? '' });
      symInput.addEventListener('input', (e) => { c.draft.scope = { kind: 'symbol', symbol: e.target.value }; paintLive(); });
      scopeNodes.push(symInput, el('div', { class: 'muted small' }, [adapter.CONTRACT_SCOPE_OPTIONS.find((o) => o.kind === 'symbol').note]));
    }
    dialog.append(el('div', { class: 'cv-field cv-scope-field' }, scopeNodes));
    const note = el('textarea', { class: 'input', rows: '2', 'data-role': 'note', placeholder: '可选：写下你为什么立下这条规则（保存后随版本冻结，不可改写）' });
    note.value = c.draft.note ?? '';
    note.addEventListener('input', (e) => { c.draft.note = e.target.value; });
    dialog.append(el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['决定自述（保存时随版本冻结；不参与判定，不进入哈希）']), note]));

    const live = el('div', { class: 'cv-live' });
    const hint = el('div', { class: 'muted small cv-hint' });
    const dupNote = el('div', { class: 'cv-replace-note' });
    let dupAcked = false;
    let scopeAckKey = null;
    const targetHash = isEdit ? c.modal?.targetHash : null;
    const editorState = (parsed) => adapter.contractEditorState(c.versions, parsed, { targetHash });
    const scopeChangeKey = (parsed, d) => {
      if (!targetHash || !parsed.supported || !d.current) return null;
      const old = d.current.scope ?? { kind: 'all' };
      const next = parsed.scope ?? { kind: 'all' };
      return old.kind === next.kind && (old.symbol ?? '') === (next.symbol ?? '') ? null : JSON.stringify(next);
    };
    const saveBtn = el('button', {
      class: 'btn primary', 'data-role': 'modal-save',
      onclick: () => {
        const parsed = preview();
        const d = editorState(parsed);
        const scopeKey = scopeChangeKey(parsed, d);
        if (scopeKey && scopeAckKey !== scopeKey) return;
        commitAll(adapter.contractSaveRecords(c.versions, {
          parsed,
          targetHash,
          note: c.draft.note,
          forceDuplicate: d.action === 'duplicate' ? dupAcked : false,
          assistantFlowId: c.modal?.assistantFlowId ?? null,
        }), { modal: null });
      },
    }, ['保存并启用']);
    dialog.append(live, el('div', { class: 'cv-modal-foot' }, [
      hint,
      dupNote,
      el('div', { class: 'row cv-modal-actions' }, [
        el('button', { class: 'btn', 'data-role': 'modal-cancel', onclick: closeEditor }, ['取消']),
        saveBtn,
      ]),
    ]));

    function paintLive() {
      const parsed = preview();
      const d = editorState(parsed);
      const nodes = [el('div', { class: 'section-title' }, ['规则预览'])];
      if (!parsed.supported) {
        nodes.push(el('div', { class: 'cv-error' }, [
          el('div', { class: 'error' }, ['参数无效']),
          el('div', { class: 'calc-line' }, [parsed.message]),
          el('div', { class: 'muted small' }, ['未生成规则：不猜测、不自动纠正；修正参数后才可保存。']),
        ]));
      } else {
        nodes.push(el('div', { class: 'rule-text' }, [parsed.text]));
        nodes.push(el('div', { class: 'calc-line' }, [`提醒动作：${ACTION_LABEL[parsed.action] ?? parsed.action ?? '—'}`]));
        nodes.push(el('div', { class: 'calc-line' }, [`适用范围：${parsed.scope_text}`]));
        nodes.push(el('div', { class: 'calc-line' }, [`阈值：${parsed.threshold.display}`]));
        nodes.push(el('div', { class: 'calc-line' }, [`提醒：${parsed.reminder}`]));
        nodes.push(el('div', { class: 'muted small' }, [`时间口径：${parsed.timing}`]));
      }
      live.replaceChildren(...nodes);
      if (d.action !== 'duplicate') dupAcked = false;
      const isDup = d.action === 'duplicate';
      const scopeKey = scopeChangeKey(parsed, d);
      if (scopeAckKey !== scopeKey) scopeAckKey = null;
      saveBtn.disabled = !d.canSave || (isDup && !dupAcked) || !!(scopeKey && scopeAckKey !== scopeKey);
      const hintText = {
        invalid: '参数无效：请先修正参数，保存不可用。',
        unchanged: '与当前规则相同：同一规则不会重复保存；决策说明不参与判定，不能单独形成新规则。',
        duplicate: '已存在完全相同的当前规则。',
        restore: `与历史版本 v${safe(d.same && d.same.v)} 相同：保存后将恢复该版本为当前规则，不新增版本号。`,
        blocked: '目标规则已变化，或该内容对应已有规则；请核对后重新操作。',
        new: `保存后生成版本 v${d.next_version}，成为当前规则。`,
        edit: `保存后生成版本 v${d.next_version}，当前版本 v${safe(d.current && d.current.v)} 将进入历史规则。`,
      }[d.action];
      hint.replaceChildren(el('span', {}, [hintText]));
      dupNote.replaceChildren(...(isDup ? [
        el('label', { class: 'cv-dup-confirm' }, [
          el('input', { type: 'checkbox', 'data-role': 'dup-ack', checked: dupAcked ? '' : null, onchange: (e) => { dupAcked = e.target.checked; paintLive(); } }),
          el('span', { class: 'muted small' }, ['确认新增：已知存在完全相同的规则，仍要保存。']),
        ]),
      ] : scopeKey ? [el('label', { class: 'cv-dup-confirm' }, [
        el('input', { type: 'checkbox', 'data-role': 'edit-scope-ack', checked: scopeAckKey === scopeKey ? '' : null, onchange: (e) => { scopeAckKey = e.target.checked ? scopeKey : null; paintLive(); } }),
        el('span', { class: 'muted small' }, ['确认修改适用范围：原范围的规则将进入历史。']),
      ])] : []));
    }
    paintLive();
    return el('div', { class: 'cv-modal-backdrop', 'data-role': 'modal-backdrop' }, [dialog]);
  }

  /* —— 自定义规则（嵌入新增弹窗）：识别 → 程序校验后的预览 → 用户确认才保存；修改描述即作废预览 —— */
  function renderNlEditor() {
    const nl = c.nl ?? emptyNl();
    c.nl = nl;
    const nlClient = ctx.ruleAssistantClient ?? null;
    const loading = nl.status === 'loading';
    const panel = el('div', { class: 'cv-nl-embedded', 'data-role': 'nl-panel' });
    panel.append(el('div', { class: 'section-title' }, ['用一句话描述规则']));
    panel.append(el('div', { class: 'muted small' }, [NL_INTRO]));
    panel.append(el('div', { class: 'cv-nl-privacy' }, [NL_PRIVACY]));
    panel.append(el('div', { class: 'muted small' }, [`目前可执行的规则类型示例：${adapter.CONTRACT_NL_EXAMPLES.map((x) => `“${x}”`).join('；')}。`]));

    const counter = el('span', { class: 'muted small cv-nl-count' });
    const stillCustom = () => ['add', 'edit'].includes(state.contracts.modal?.mode) && state.contracts.draft?.template_id === CUSTOM_TEMPLATE;
    const recognizeBtn = el('button', {
      class: 'btn primary', 'data-role': 'nl-recognize',
      onclick: async () => {
        const text = c.nl.text;
        if (nlClient && c.modal?.assistantFlowId && state.assistant.pending) {
          c.nl = { ...c.nl, status: 'done', result: { status: 'error', message: '助手请求进行中，请稍后再试。' } };
          set({ contracts: { nl: c.nl } });
          paintNl();
          return;
        }
        let flowId = c.modal?.assistantFlowId ?? c.nl.flowId ?? null;
        if (nlClient) {
          if (!flowId) {
            const started = nlClient.beginExternalFlow({ stage: 'rule_nl' });
            flowId = started.flow_id;
            c.nl = { ...c.nl, flowId, modelCalls: started.model_calls, budgetMax: started.budget_max };
          }
          const flow = nlClient.getFlow(flowId);
          if (!flow || flow.model_calls >= flow.budget_max) {
            c.nl = {
              ...c.nl,
              flowId,
              modelCalls: flow?.model_calls ?? c.nl.modelCalls ?? 0,
              budgetMax: flow?.budget_max ?? c.nl.budgetMax ?? 2,
              status: 'done',
              result: { status: 'error', message: '本次 AI 识别次数已用完；请新开独立任务或改用模板编辑。' },
            };
            set({ contracts: { nl: c.nl } });
            paintNl();
            return;
          }
        }
        const token = {};
        nlToken = token;
        c.nl = {
          ...c.nl,
          text,
          flowId,
          status: 'loading',
          result: null,
          choices: {},
          ack: false,
          actionChoice: null,
        };
        set({ contracts: { nl: c.nl } });
        let result = await adapter.recognizeContractText(text);
        if (c.modal?.targetRuleId && result.status === 'supported' && !result.is_custom) result = { status: 'error', message: '修改后的描述识别为模板规则，无法直接替换自定义规则；请调整描述或另行新增模板规则。' };
        let flowCounts = null;
        if (nlClient && flowId && result.stage !== 'precheck') {
          const recorded = nlClient.recordExternalModelCall({
            flowId,
            stage: 'rule_nl',
            status: result.status === 'error' ? 'failed' : 'ok',
            code: result.code ?? null,
          });
          if (recorded.ok) {
            const flow = recorded.flow;
            flowCounts = { modelCalls: flow.model_calls, budgetMax: flow.budget_max };
            if (c.modal?.assistantFlowId === flowId && state.assistant.flowId === flowId) {
              set({
                assistant: {
                  ...state.assistant,
                  modelCalls: flow.model_calls,
                  budgetMax: flow.budget_max,
                  trace: flow.trace,
                  outbound: flow.outbound,
                },
              });
            }
          }
        }
        if (nlToken !== token || !stillCustom()) return;
        nlToken = null;
        if (flowCounts) c.nl = { ...c.nl, ...flowCounts };
        const defaultAction = result.is_custom && (result.action === 'buy' || result.action === 'sell' || result.action === 'both') ? result.action : null;
        c.nl = { ...c.nl, text, flowId, status: 'done', result, choices: {}, ack: true, actionChoice: defaultAction };
        set({ contracts: { nl: c.nl } });
      },
    }, [loading ? '识别中…' : '识别规则']);
    const resultBox = el('div', { class: 'cv-nl-result' });
    const actions = el('div', { class: 'row cv-modal-actions' });
    const input = el('textarea', {
      class: 'input', rows: '3', 'data-role': 'nl-text', maxlength: String(adapter.CONTRACT_NL_MAX_CHARS),
      placeholder: '例如：当天涨幅超过 5% 的股票我不买', disabled: loading ? '' : null,
    });
    input.value = nl.text;
    input.addEventListener('input', (e) => {
      const changed = c.nl.status !== 'idle';
      c.nl = { ...c.nl, text: e.target.value, status: 'idle', result: null, choices: {}, ack: false, actionChoice: null };
      if (changed) nlToken = null;
      paintNl();
    });
    panel.append(el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['规则描述（只发送这段文字）']), input]));
    panel.append(el('div', { class: 'row cv-nl-bar' }, [recognizeBtn, counter]));
    panel.append(resultBox, el('div', { class: 'cv-modal-foot' }, [actions]));

    function paintNl() {
      const cur = c.nl;
      counter.replaceChildren(el('span', {}, [`${[...cur.text.trim()].length} / ${adapter.CONTRACT_NL_MAX_CHARS} 字`]));
      recognizeBtn.disabled = cur.status === 'loading' || cur.text.trim() === '';
      const r = cur.status === 'done' ? cur.result : null;
      resultBox.replaceChildren(...(cur.status === 'loading'
        ? [el('div', { class: 'muted' }, ['正在识别…（只发送规则文字）'])]
        : r ? nlResult(r) : []));
      const btns = [el('button', { class: 'btn', 'data-role': 'nl-cancel', onclick: closeEditor }, ['取消'])];
      if (r && r.status === 'supported') {
        if (r.is_custom) {
          // 自定义规则：需要用户确认动作后才能保存
          const actionConfirmed = !!c.nl.actionChoice;
          btns.push(el('button', {
            class: 'btn primary', 'data-role': 'nl-save', disabled: (c.nl.ack && actionConfirmed) ? null : '',
            onclick: () => {
              if (!c.nl.ack || !c.nl.actionChoice) return;
              nlToken = null;
              const rule_id = c.modal?.targetRuleId ?? r.rule_id;
              const action = c.nl.actionChoice;
              const scope = r.scope ?? { kind: 'all' };
              const hash = computeCustomHashForSave(r.text, action, scope);
              commitAll(adapter.contractSaveCustomRecords(c.versions, {
                rule_id,
                text: r.text,
                action,
                scope,
                understanding: r.understanding ?? null,
                hash,
                note: null,
                assistantFlowId: c.modal?.assistantFlowId ?? null,
              }), { modal: null, nl: null });
            },
          }, ['确认保存并启用']));
        } else {
          const ss = adapter.contractNlSaveState(c.versions, r, { choices: cur.choices, ack: cur.ack, dupAck: cur.dupAck });
          btns.push(el('button', {
            class: 'btn', 'data-role': 'nl-to-template',
            onclick: () => {
              nlToken = null;
              const fields = Object.fromEntries(Object.entries(r.parsed.fields).map(([k, v]) => [k, String(v)]));
              set({ contracts: { modal: { mode: 'add', targetHash: null, assistantFlowId: c.modal?.assistantFlowId ?? null }, nl: null, draft: { template_id: r.parsed.template_id, fields, note: '', scope: scopeDraftOf(r.parsed.scope) } } });
            },
          }, ['在模板中调整参数']));
          btns.push(el('button', {
            class: 'btn primary', 'data-role': 'nl-save', disabled: ss.canSave ? null : '',
            onclick: () => {
              const now = adapter.contractNlSaveState(c.versions, r, { choices: c.nl.choices, ack: c.nl.ack, dupAck: c.nl.dupAck });
              if (!now.canSave) return;
              nlToken = null;
              commitAll(adapter.contractSaveRecords(c.versions, {
                parsed: r.parsed,
                note: null,
                origin: { text: r.text, confirmations: c.nl.choices },
                forceDuplicate: now.editor.action === 'duplicate',
                assistantFlowId: c.modal?.assistantFlowId ?? null,
              }), { modal: null, nl: null });
            },
          }, ['确认保存并启用']));
        }
      }
      actions.replaceChildren(...btns);
    }

    function confirmBlock(item) {
      const chosen = c.nl.choices[item.key];
      const picked = item.options.find((o) => o.id === chosen) ?? null;
      return el('div', { class: 'cv-nl-confirm', 'data-confirm': item.key }, [
        el('div', { class: 'calc-line' }, [item.question]),
        el('div', { class: 'rp-seg' }, item.options.map((o) => el('button', {
          class: chosen === o.id ? 'active' : '', type: 'button', 'data-role': `nl-choice-${item.key}-${o.id}`,
          onclick: () => { c.nl = { ...c.nl, choices: { ...c.nl.choices, [item.key]: o.id } }; paintNl(); },
        }, [o.label]))),
        picked && !picked.supported ? el('div', { class: 'cv-nl-warn' }, [`暂不支持：${picked.message} 未生成可启用的规则。`]) : null,
        picked ? null : el('div', { class: 'muted small' }, ['未选择前不能保存。']),
      ]);
    }

    function nlResult(r) {
      const isCustom = r.is_custom === true;
      const pending = r.status === 'supported' && !isCustom && !adapter.contractNlSaveState(c.versions, r, { choices: c.nl.choices, ack: true }).confirm.ok;
      const s = pending ? { text: '待你确认', kind: 'mode' } : NL_STATUS[r.status] ?? NL_STATUS.error;
      const nodes = [el('div', { class: 'row' }, [el('span', { class: `chip ${s.kind}`, 'data-role': 'nl-status' }, [s.text])])];
      const understanding = r.understanding
        ? el('div', { class: 'muted small' }, [`规则理解（仅供核对，不参与判定）：${r.understanding}`])
        : null;
      if (r.status === 'supported') {
        if (isCustom) {
          // 自定义规则预览
          nodes.push(el('div', { class: 'section-title' }, ['规则预览']));
          nodes.push(el('div', { class: 'cv-nl-preview' }, [
            el('div', { class: 'rule-text' }, [r.text]),
            el('div', { class: 'calc-line' }, [`规则类型：自定义规则`]),
            el('div', { class: 'calc-line', 'data-role': 'nl-scope' }, [`适用范围：${r.scope_text}`]),
            understanding,
          ]));
          // 动作确认
          const actionChoice = c.nl.actionChoice;
          const suggestedAction = r.action;
          nodes.push(el('div', { class: 'cv-nl-confirm', 'data-confirm': 'action' }, [
            el('div', { class: 'calc-line' }, ['请确认这条规则的提醒动作：']),
            el('div', { class: 'rp-seg' }, [
              el('button', {
                class: actionChoice === 'buy' ? 'active' : '', type: 'button', 'data-role': 'nl-action-buy',
                onclick: () => { c.nl = { ...c.nl, actionChoice: 'buy' }; paintNl(); },
              }, ['买入提醒']),
              el('button', {
                class: actionChoice === 'sell' ? 'active' : '', type: 'button', 'data-role': 'nl-action-sell',
                onclick: () => { c.nl = { ...c.nl, actionChoice: 'sell' }; paintNl(); },
              }, ['卖出提醒']),
              el('button', {
                class: actionChoice === 'both' ? 'active' : '', type: 'button', 'data-role': 'nl-action-both',
                onclick: () => { c.nl = { ...c.nl, actionChoice: 'both' }; paintNl(); },
              }, ['买入 + 卖出提醒']),
            ]),
            suggestedAction && !actionChoice ? el('div', { class: 'muted small' }, [`识别服务建议：${suggestedAction === 'both' ? '买入 + 卖出提醒' : ACTION_LABEL[suggestedAction] ?? suggestedAction}`]) : null,
            !actionChoice ? el('div', { class: 'muted small' }, ['请选择提醒动作后才能保存。']) : null,
          ]));
          // 程序检查
          nodes.push(el('div', { class: 'cv-nl-checks' }, [
            el('div', { class: 'muted small' }, ['程序检查：']),
            el('ul', { class: 'cv-nl-list' }, (r.checks ?? []).map((x) => el('li', {}, [x]))),
          ]));
          // 核对确认
          const ack = el('input', { type: 'checkbox', 'data-role': 'nl-ack', checked: c.nl.ack ? '' : null });
          ack.addEventListener('change', (e) => { c.nl = { ...c.nl, ack: !!e.target.checked }; paintNl(); });
          nodes.push(el('div', { class: 'cv-nl-warn' }, [NL_CHECK_WARNING]));
          nodes.push(el('label', { class: 'cv-nl-ack' }, [ack, el('span', {}, ['我已逐字对照原话核对：上面的预览与我的本意一致。'])]));
          nodes.push(el('div', { class: 'muted small' }, ['保存后将按你确认的动作与适用范围生成规则。']));
          const canSave = c.nl.ack && !!c.nl.actionChoice;
          if (!canSave) {
            const reasons = [];
            if (!c.nl.actionChoice) reasons.push('请选择提醒动作');
            if (!c.nl.ack) reasons.push('请勾选核对确认');
            nodes.push(el('div', { class: 'muted small cv-hint' }, [`保存前需要：${reasons.join('、')}。`]));
          } else {
            nodes.push(el('div', { class: 'muted small cv-hint' }, [`确认后生成版本 v${adapter.contractRuleSet(c.versions).next_version}。`]));
          }
          return nodes;
        }
        // 模板规则预览（原有逻辑）
        const ss = adapter.contractNlSaveState(c.versions, r, { choices: c.nl.choices, ack: c.nl.ack, dupAck: c.nl.dupAck });
        const d = ss.editor;
        nodes.push(el('div', { class: 'section-title' }, ['规则预览']));
        nodes.push(el('div', { class: 'cv-nl-preview' }, [
          el('div', { class: 'rule-text' }, [r.parsed.text]),
          el('div', { class: 'calc-line' }, [`提醒动作：${ACTION_LABEL[r.parsed.action] ?? r.parsed.action ?? '—'}`]),
          el('div', { class: 'calc-line' }, [`规则类型：${r.template_name}`]),
          el('div', { class: 'calc-line', 'data-role': 'nl-scope' }, [`适用范围：${r.scope_text}`]),
          el('div', { class: 'calc-line' }, [`触发条件：${r.condition}`]),
          understanding,
        ]));
        nodes.push(el('div', { class: 'cv-nl-checks' }, [
          el('div', { class: 'muted small' }, ['程序检查（按原文判定，与识别结果无关）：']),
          el('ul', { class: 'cv-nl-list' }, r.checks.map((x) => el('li', {}, [x]))),
        ]));
        for (const item of r.confirmations) nodes.push(confirmBlock(item));
        const ack = el('input', { type: 'checkbox', 'data-role': 'nl-ack', checked: c.nl.ack ? '' : null });
        ack.addEventListener('change', (e) => { c.nl = { ...c.nl, ack: !!e.target.checked }; paintNl(); });
        nodes.push(el('div', { class: 'cv-nl-warn' }, [NL_CHECK_WARNING]));
        nodes.push(el('label', { class: 'cv-nl-ack' }, [ack, el('span', {}, ['我已逐字对照原话核对：上面的预览与我的本意一致；我理解程序检查不能保证发现所有股票名称、附加条件或隐含限定。'])]));
        nodes.push(el('div', { class: 'muted small' }, ['最终保存与参与测试的是程序生成的规则文本与参数，而不是你的原话或识别的理解；如与本意不符，请修改描述后重新识别，或在模板中调整参数。']));
        const hint = {
          choice_pending: '还有待确认的理解，确认前不能保存。',
          choice_unsupported: '你选择的理解当前系统不支持，不能保存。',
          ack_pending: '请先勾选核对确认，才能保存。',
          dup_pending: '已存在完全相同的当前规则，请先勾选确认后再保存。',
          editor_unchanged: '与当前规则完全相同：无需重复保存。',
          editor_restore: null,
          editor_blocked: '该参数对应的历史记录内容与校验标识不一致，不能保存；请换用其他参数。',
        }[ss.reason] ?? (d.action === 'restore'
          ? `与历史版本 v${safe(d.same && d.same.v)} 相同：确认后恢复该版本为当前规则，不新增版本号。`
          : `确认后生成版本 v${d.next_version}，立即参与操作复盘。`);
        nodes.push(el('div', { class: 'muted small cv-hint' }, [hint]));
        if (d.action === 'duplicate' && d.canSave) {
          const dup = el('input', { type: 'checkbox', 'data-role': 'nl-dup-ack', checked: c.nl.dupAck ? '' : null });
          dup.addEventListener('change', (e) => { c.nl = { ...c.nl, dupAck: !!e.target.checked }; paintNl(); });
          nodes.push(el('label', { class: 'cv-dup-confirm' }, [dup, el('span', {}, ['已存在相同规则，仍要保存一条重复记录。'])]));
        }
        return nodes;
      }
      if (r.status === 'unsupported') {
        nodes.push(el('div', { class: 'calc-line' }, [`你的原话：「${safe(r.text)}」`]));
        nodes.push(el('div', { class: 'calc-line' }, ['这条规则当前系统还不能完整执行：未生成规则，也不会保存或启用；检测到只有部分内容受支持时，不会只截取那部分启用。原因：']));
        nodes.push(el('ul', { class: 'cv-nl-list' }, [...r.needs.map((n) => el('li', {}, [n.message])), ...r.detail.map((x) => el('li', {}, [x]))]));
        if (understanding) nodes.push(understanding);
        nodes.push(el('div', { class: 'muted small' }, [`可以改写为当前支持的规则，例如：${r.examples.map((x) => `“${x}”`).join('；')}。`]));
        return nodes;
      }
      if (r.status === 'unclear') {
        nodes.push(el('div', { class: 'calc-line' }, [`你的原话：「${safe(r.text)}」`]));
        nodes.push(el('div', { class: 'calc-line' }, ['描述还不够明确，未生成规则。请补充后重新识别：']));
        nodes.push(el('ul', { class: 'cv-nl-list' }, r.questions.map((q) => el('li', {}, [q]))));
        if (understanding) nodes.push(understanding);
        return nodes;
      }
      if (r.status === 'invalid') {
        nodes.push(el('div', { class: 'cv-error' }, [
          el('div', { class: 'calc-line' }, [`参数未通过规则引擎校验：${safe(r.message)}`]),
          el('div', { class: 'muted small' }, ['未生成规则：不猜测、不自动纠正。请修改描述后重新识别。']),
        ]));
        return nodes;
      }
      nodes.push(el('div', { class: 'cv-error' }, [
        el('div', { class: 'calc-line' }, [`原因：${safe(r.message)}`]),
        el('div', { class: 'muted small' }, [NL_FALLBACK]),
      ]));
      return nodes;
    }

    paintNl();
    return panel;
  }

  root.append(page);
  void paintCandidates();
  const mountModal = typeof ctx.setRuleModal === 'function' ? ctx.setRuleModal : null;
  if (backdrop) {
    if (mountModal) mountModal(backdrop);
    else root.append(backdrop);
    if (focusedModal !== c.modal) {
      focusedModal = c.modal;
      backdrop.children[0].focus();
    }
  } else {
    if (mountModal) mountModal(null);
    focusedModal = null;
  }
}
