// 交易规则（契约）：当前生效规则（每种类型最多一条）→ 历史规则（折叠）→ 新增 / 修改弹窗 → 当前规则的操作复盘（本地账单与示例：Tushare 动态 / 合成回归）
// 边界：当前 / 历史划分、版本状态机、解析与判定全部由 adapter 提供（adapter 内部调用引擎）；本页只渲染返回的文本与 display。
import { el, chip } from '../components.js';
import * as adapter from '../../demo/adapter.js';
import { renderScenarioReview } from './scenarioReviewView.js';
import { saveContractsDemo, defaultContracts } from '../../state.js';
import { createHttpTransport, SAME_ORIGIN_BASE, SITE_FUNCTION_PATHS } from '../../agent/httpTransport.js';
import { createRuleFallback, pickScenarioForJudgment, ruleSetHash } from '../../agent/ruleFallback.js';
import { createCustomRuleJudgment, CUSTOM_RULE_JUDGMENT_CODES } from '../../agent/customRuleJudgment.js';

const VERDICT = {
  triggered: { text: '命中', kind: 'warn' },
  not_triggered: { text: '未命中', kind: 'ok' },
  missing_data: { text: '数据不足', kind: 'mode' },
  unable: { text: '无法判断', kind: 'mode' },
  custom_pending: { text: '判定中…', kind: 'mode' },
};
// 买入后卖出提醒：账单没有“历史买入完整”依据，找不到窗口内买入时一律不显示“未命中”。
const UNCONFIRMED_BUY_CODES = new Set(['E_BUY_HISTORY_UNCONFIRMED', 'E_BUY_OUTSIDE_WINDOW_UNCONFIRMED', 'E_SAME_DAY_BUY_UNCONFIRMED']);
const BUY_SELL_MISSING_NOTE = Object.freeze({
  E_BUY_HISTORY_UNCONFIRMED: '数据不足：账单中没有该标的在申报日前的买入记录，也没有“历史买入完整”的可靠依据；不能当成“从未买入”，本次不显示“未命中”。',
  E_BUY_OUTSIDE_WINDOW_UNCONFIRMED: '数据不足：当前账单里可见的最近买入已超出窗口，但可能存在未导出的窗口内买入；本次不显示“未命中”，也不作命中判定。',
  E_SAME_DAY_BUY_UNCONFIRMED: '数据不足：当前账单只有同日买入，成交先后顺序未知，且可能存在未导出的更早或窗口内买入；本次不显示“未命中”，也不作命中判定。',
});
const SUMMARY = [['triggered', '命中', 'warn'], ['not_triggered', '未命中', 'ok'], ['missing_data', '数据不足', 'mode'], ['not_applicable', '不适用', 'mode'], ['unable', '无法判断', 'mode'], ['error', '无法判定', 'warn']];
const SIM_CANDIDATE_LINE = '候选口径（待冻结）：规则只用于提醒，不自动交易，也不改变报告结论。';
const ACTION_LABEL = Object.freeze({ buy: '买入提醒', sell: '卖出提醒' });
// 自定义规则判定：与页面其他说明一致地写明发送内容；判定失败或数据不足时显示“无法判断”，不显示“未命中”。
const CUSTOM_PENDING_NOTE = '正在结合本次情境数据判定这条自定义规则…';
const CUSTOM_UNABLE_NOTE = '无法判断：本次不显示“未命中”，也不作命中判定。';
const CUSTOM_DISCLOSURE = '这条自定义规则参与测试时，会把规则原文、提醒动作、适用范围、情境标的与日期、当日涨跌幅（如有）、该标的的买入与卖出日期和相关交易日历发送到站点服务端，由模型辅助理解后给出判定；不发送原始账单、CSV 文件、价格金额或其他标的的交易记录。判定只用于提醒，不下单、不阻止交易。';
const CUSTOM_USED_DATA_LABEL = Object.freeze({ change_pct: '当日涨跌幅', buys: '买入日期', sells: '卖出日期', calendar: '交易日历' });
const INTRO = '设置在操作复盘中用于提醒自己的交易规则。规则仅用于提醒，不会自动交易或阻止交易。';
const PRIVACY = '不会自动交易，也不会改变分析报告结论。操作复盘只使用当前生效规则。';
// const AGENT_NOTE = '操作复盘只使用当前生效规则。';
const CURRENT_NOTE = '不同类型或不同股票范围的规则可以同时生效；同一类型、同一范围只保留一条当前规则，保存新参数后旧规则进入历史规则。';
const REPLACE_NOTE = '保存后，新规则会立即生效；当前同类型规则会进入历史记录，不再参与测试。';
const STOP_NOTE = '停用后，该规则进入历史规则，不再参与之后的操作复盘；可随时恢复为当前规则。';
const RECONFIRM_NOTE = '这条规则的保存内容与当前校验标识不一致。为避免误用，它暂不参与测试。请核对后用“新增规则”重新保存，或停用该规则。';
const EMPTY_NOTE = '暂无当前生效的规则，测试时不会产生规则提醒。点击“新增规则”开始设置。';

function ledgerEventRow(e) {
  const kind = e.outcome === 'violated' ? 'warn' : e.outcome === 'compliant' ? 'ok' : 'mode';
  return el('div', { class: 'cv-ledger-event', 'data-outcome': e.outcome }, [
    el('span', { class: 'cv-ledger-date' }, [safe(e.at)]),
    el('span', { class: 'cv-ledger-sym' }, [`${safe(e.symbol)} · ${safe(e.side_label)}`]),
    chip(e.outcome_label, kind),
    el('span', { class: 'cv-ledger-msg' }, [safe(e.message)]),
  ]);
}

function ledgerCard(ledger) {
  const s = ledger.summary;
  const box = el('div', { class: 'cv-ledger', 'data-role': 'rule-ledger' }, [
    el('div', { class: 'cv-ledger-head' }, [
      el('div', { class: 'section-title' }, ['守约账本']),
      el('span', { class: 'muted small' }, [`按当前生效规则复核账单中的 ${safe(ledger.trades_n)} 笔交易${ledger.as_of ? `（截至 ${safe(ledger.as_of)}）` : ''}`]),
    ]),
    el('div', { class: 'cv-ledger-stats' }, [
      chip(`复核 ${s.reviewed_n} 笔`, 'mode'),
      chip(`违反 ${s.violated_n} 笔`, s.violated_n ? 'warn' : 'mode'),
      chip(`已提醒 ${s.warned_n} 笔`, 'mode'),
      chip(`数据不足 ${s.missing_n} 笔`, 'mode'),
    ]),
  ]);
  if (!ledger.rules.length) {
    box.append(el('div', { class: 'muted small' }, ['暂无当前生效规则：账本没有可复核的规则。']));
  } else {
    box.append(el('div', { class: 'cv-ledger-rules' }, ledger.rules.map((r) => el('div', { class: 'cv-ledger-row', 'data-hash': r.hash }, [
      el('div', { class: 'cv-ledger-row-head' }, [
        el('span', { class: 'cv-ledger-name' }, [safe(r.template_name)]),
        chip(r.enforcement_label, r.enforcement === 'remind' ? 'mode' : 'warn'),
        el('span', { class: 'muted small' }, [safe(r.scope_text)]),
      ]),
      el('div', { class: 'cv-ledger-status' }, [safe(r.status_text)]),
      r.missing_codes.length ? el('div', { class: 'muted small' }, [`数据不足原因：${r.missing_codes.map((c) => `${c.code}×${c.n}`).join('、')}`]) : null,
    ]))));
  }
  if (ledger.events.length) {
    box.append(el('div', { class: 'cv-ledger-subtitle' }, ['最近事件']));
    box.append(el('div', { class: 'cv-ledger-events' }, ledger.events.map(ledgerEventRow)));
  }
  box.append(el('details', { class: 'cv-tech-note' }, [
    el('summary', {}, ['账本口径']),
    ...ledger.notes.map((n) => el('div', { class: 'muted small' }, [n])),
  ]));
  return box;
}

let fallbackClient = null;
function getFallbackClient() {
  if (!fallbackClient) {
    fallbackClient = createRuleFallback({
      transport: createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS }),
    });
  }
  return fallbackClient;
}
let customJudgeClient = null;
function getCustomJudgeClient() {
  if (!customJudgeClient) {
    customJudgeClient = createCustomRuleJudgment({
      transport: createHttpTransport({ baseUrl: SAME_ORIGIN_BASE, paths: SITE_FUNCTION_PATHS }),
    });
  }
  return customJudgeClient;
}
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

let simContextLoadingKey = null;
let simToken = null;
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
  const standalone = section === 'selfcheck';
  state.contracts = { ...defaultContracts(), ...state.contracts };
  const c = state.contracts;
  const templates = adapter.contractTemplates();
  const ruleSet = adapter.contractRuleSet(c.versions);
  const slotOf = (template_id) => ruleSet.slots.find((s) => s.template_id === template_id) ?? null;

  function commitAll(recs, extra = {}) {
    if (!recs || !recs.length) return;
    simToken = null;
    simContextLoadingKey = null;
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
  if (!standalone) page.append(el('div', { class: 'card cv-head' }, [
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
  if (!standalone) page.append(currentBox);

  /* —— 待重新确认（异常）：不计入当前规则、不参与测试 —— */
  if (!standalone && ruleSet.needsReconfirm.length) {
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
  if (!standalone) page.append(el('details', { class: 'card cv-history', 'data-role': 'history', open: c.restorePending ? '' : null }, [
    el('summary', {}, [`历史规则（${histCount}）`]),
    el('div', { class: 'muted small' }, [HISTORY_NOTE]),
    histCount ? null : el('div', { class: 'muted small' }, ['暂无历史规则。']),
    ...ruleSet.history.map(historyItem),
    ...ruleSet.legacy.map(legacyItem),
  ]));

  /* —— 操作复盘：所有当前规则逐条判定；交易来源由 adapter 按账单状态决定 —— */
  let simBtn = null;
  let simResultBox = null;

  function buildSimulation() {
  const current = ruleSet.current;
  const hasBuyback = current.some((r) => r.kind === 'sell_buyback_window');
  const hasBuySell = current.some((r) => r.kind === 'buy_sell_window');
  const hasTrades = hasBuyback || hasBuySell;
  const hasSurge = current.some((r) => r.kind === 'change_pct_threshold');
  const demoFrozen = adapter.isDemoFrozenBill(state.bill);
  const localBill = !demoFrozen && !!(state.bill && state.bill.status === 'confirmed' && state.bill.sourceType === 'local');
  const demoSimulationAllowed = ctx.allowDemoSimulation !== false;
  const marketSource = demoFrozen
    ? 'demo-frozen'
    : localBill ? adapter.DEFAULT_MARKET_SOURCE : (c.marketSource === 'synthetic-fixture' ? 'synthetic-fixture' : adapter.DEFAULT_MARKET_SOURCE);
  const sim = el('div', { class: 'card', 'data-role': 'sim-section' });
  simResultBox = el('div', { class: 'cv-sim-out' });
  if (!localBill && !demoFrozen && !demoSimulationAllowed) {
    sim.append(el('div', { class: 'section-title' }, ['申报前自检']));
    sim.append(el('div', { class: 'cv-sim-empty' }, [
      el('div', { class: 'muted' }, ['导入并确认一份账单后，可用当前规则做申报前自检。没有账单时不会自动加载行情，也不会用示例数据代替。']),
      el('a', { class: 'btn small', href: '#/import' }, ['去导入账单']),
    ]));
  } else {
  sim.append(el('div', { class: 'section-title' }, [demoFrozen
    ? '申报前自检（示例行情 · 历史模拟）'
    : marketSource === 'synthetic-fixture'
      ? '申报前自检（合成行情）'
      : '申报前自检（Tushare 动态行情）']));
  sim.append(el('div', { class: 'muted small cv-selfcheck-note' }, ['这是历史模拟，不是实时提醒；不会下单，也不会阻止交易。']));
  // 示例场景账单固定使用冻结行情（无行情来源切换）；其他示例账单可切换 Tushare 动态 / 合成回归。
  if (!localBill && !demoFrozen) {
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
          set({ contracts: { marketSource: o.id, simContext: null, sim: { ...state.contracts.sim, result: null, running: false, runId: null, fallback: null } } });
        },
      }, [o.label]));
    }
    srcGroup.append(srcSeg);
    sim.append(srcGroup);
    const labels = adapter.contractSimLabels(marketSource);
    sim.append(el('div', { class: 'row' }, [chip(labels.label, 'mode'), chip(labels.scopeNote, 'mode')]));
  }
  const src = adapter.contractTradeSource(state.bill, marketSource);
  if (c.simContext && c.simContext.sourceKey !== src.key) {
    simToken = null;
    c.simContext = null;
    c.sim = { ...c.sim, result: null, running: false, runId: null };
  }
  const sc = c.simContext;
  const marketLabel = sc?.marketSource?.label ?? src.market_label;
  if (localBill || demoFrozen) {
    sim.append(el('div', { class: 'row' }, [chip(`${marketLabel} · 非实时行情 · 不构成投资建议`, 'mode')]));
    sim.append(el('div', { class: 'muted small' }, [SIM_CANDIDATE_LINE]));
  }
  // 交易来源明细按当前规则的模板类型显示：不追回读取卖出记录，买入后卖出提醒读取买入记录，涨幅只读行情。
  const tradeUse = hasBuyback && hasBuySell
    ? '不追回读取卖出记录，买入后卖出提醒读取买入记录'
    : hasBuySell
      ? '买入后卖出提醒只读取同一标的的买入记录'
      : '不追回读取卖出记录';
  const otherUse = hasBuySell
    ? '交易类规则只用交易日历和账单交易，不读取价格'
    : '涨幅规则不读取账单交易；交易类规则只用交易日历和账单交易，不读取价格';
  const srcNote = localBill
    ? (hasTrades && hasSurge
      ? `（仅${tradeUse}；${otherUse}）`
      : hasTrades
        ? `（${tradeUse}；只用交易日历和账单交易，不读取价格）`
        : hasSurge
          ? `（涨幅规则只读取${marketLabel}，不使用账单交易）`
          : '')
    : (hasTrades && hasSurge
      ? `（仅${tradeUse}；涨幅规则不读取账单交易）`
      : hasTrades
        ? `（${tradeUse}）`
        : hasSurge
          ? '（涨幅规则只读取行情，不使用账单交易）'
          : '');
  sim.append(el('div', { class: `calc-line cv-source ${src.kind}` }, [
    `交易来源：${displayTradeSource(src)} · ${localBill && hasTrades && !hasSurge ? '交易日历来源' : '行情'}：${displayMarket(marketLabel)}`,
    srcNote,
  ]));
  if (localBill && sc?.supportScope) sim.append(el('div', { class: 'muted small cv-market-scope' }, [
    `支持标的：${sc.supportScope.symbols.join('、')}；支持日期范围：${sc.supportScope.range.start} 至 ${sc.supportScope.range.end}；asOfDate：${sc.asOfDate}；快照：${sc.marketSource.snapshotId ?? '无'}；拉取时间：${sc.marketSource.fetchedAt ? fmtAt(sc.marketSource.fetchedAt) : '无'}。`,
  ]));
  if (!sc) {
    sim.append(el('div', { class: 'muted' }, [demoFrozen
      ? '正在读取示例账单与历史行情快照…'
      : localBill
        ? '正在获取 Tushare 动态行情与交易来源…'
        : `正在加载${marketSource === 'synthetic-fixture' ? '合成回归' : 'Tushare 动态'}行情与交易来源…`]));
    if (simContextLoadingKey !== src.key) {
      simContextLoadingKey = src.key;
      adapter.contractSimContext({ bill: state.bill, marketSource, versions: c.versions })
        .then((d) => {
          if (d.error) return { simContext: d, sim: { ...state.contracts.sim, result: null, running: false, runId: null, fallback: null } };
          const cur = state.contracts.sim;
          const symbol = d.symbols.some((s) => s.symbol === cur.symbol) ? cur.symbol : d.symbols[0]?.symbol ?? '';
          return { simContext: d, sim: { ...cur, symbol, date: cur.date && cur.date >= d.range.start && cur.date <= d.range.end ? cur.date : d.asOfDate, result: null, runId: null, fallback: null } };
        })
        .catch((e) => ({ simContext: { error: String(e && e.message ? e.message : e), sourceKey: src.key } }))
        .then((patch) => {
          if (simContextLoadingKey !== src.key || adapter.contractTradeSource(state.bill, marketSource).key !== src.key) return;
          simContextLoadingKey = null;
          set({ contracts: patch });
        });
    }
  } else if (sc.error) {
    sim.append(el('div', { class: 'error' }, [`${localBill || demoFrozen ? '自检阻断' : '行情加载失败'}：${sc.error}`]));
  } else {
    const simAction = c.sim.action === 'sell' ? 'sell' : 'buy';
    sim.append(el('div', { class: 'muted small' }, [
      `用当前生效的规则（${current.length} 条，每种类型一条）分别判定“假如在该日${simAction === 'sell' ? '卖出' : '买入'}该标的”；历史规则不参与。行情范围 ${sc.range.start} ~ ${sc.range.end}，共 ${sc.tradingDays.length} 个交易日；缺价、超范围不补造、不回退。`,
    ]));
    if (sc.marketSource && sc.marketSource.dynamic) {
      sim.append(el('div', { class: 'muted small' }, [
        `行情拉取：${fmtAt(sc.marketSource.fetchedAt)} · 最新交易日 ${sc.marketSource.latestTradeDate ?? sc.marketSource.asOfDate}${sc.marketSource.snapshotId ? ` · 快照 ${sc.marketSource.snapshotId}` : ''}${sc.marketSource.checksum ? ` · 校验 ${sc.marketSource.checksum.slice(0, 12)}…` : ''}（服务端获取，非实时）`,
      ]));
    }
    const actGroup = el('div', { class: 'rp-control-group' });
    actGroup.append(el('span', { class: 'rp-control-label' }, ['情境动作']));
    const actSeg = el('div', { class: 'rp-seg' });
    for (const o of [{ id: 'buy', label: '假如买入' }, { id: 'sell', label: '假如卖出' }]) {
      actSeg.append(el('button', {
        type: 'button',
        class: simAction === o.id ? 'active' : '',
        'data-role': `sim-action-${o.id}`,
        onclick: () => {
          if (simAction === o.id) return;
          simToken = null;
          set({ contracts: { sim: { ...state.contracts.sim, action: o.id, result: null, running: false, runId: null, fallback: null } } });
        },
      }, [o.label]));
    }
    actGroup.append(actSeg);
    sim.append(actGroup);
    sim.append(el('div', { class: 'muted small cv-action-note' }, [
      '买入提醒类规则只在“假如买入”情境判定，卖出提醒类规则只在“假如卖出”情境判定。规则只做历史复盘提醒，不下单、不阻止交易，也不是实时监控。',
    ]));
    const symSelect = el('select', {
      class: 'input', 'data-role': 'sim-symbol',
      onchange: (e) => { simToken = null; c.sim = { ...c.sim, symbol: e.target.value, result: null, running: false, runId: null, fallback: null }; paintSim(); },
    }, sc.symbols.map((s) => el('option', { value: s.symbol, selected: s.symbol === c.sim.symbol ? 'selected' : null }, [
      `${s.symbol}${s.in_bill && src.kind === 'user_bill' ? '（账单标的）' : ''}${s.in_market_cache ? '' : '（不在本次行情）'}`,
    ])));
    const dateInput = el('input', { class: 'input cv-input', type: 'date', 'data-role': 'sim-date', value: c.sim.date });
    dateInput.addEventListener('input', (e) => { simToken = null; c.sim = { ...c.sim, date: e.target.value, result: null, running: false, runId: null, fallback: null }; paintSim(); });
    simBtn = el('button', {
      class: 'btn primary',
      onclick: async () => {
        const req = { versions: c.versions, symbol: c.sim.symbol, date: c.sim.date, bill: state.bill, marketSource, action: simAction };
        const token = {};
        simToken = token;
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set({ contracts: { sim: { ...state.contracts.sim, running: true, result: null, runId, fallback: null } } });
        const result = await adapter.simulateContracts(req);
        const applied = simToken === token && adapter.contractTradeSource(state.bill, marketSource).key === src.key;
        if (applied) {
          set({ contracts: { sim: { ...state.contracts.sim, running: false, result, runId, fallback: null } } });
          runUnmatchedFallback({ result, versions: c.versions, runId, set, state });
          runCustomJudgment({ result, runId, set, state });
        }
      },
    }, [c.sim.running ? '测试中…' : `测试该日${simAction === 'sell' ? '卖出' : '买入'}是否触发规则`]);
    sim.append(el('div', { class: 'row' }, [
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, [demoFrozen ? '标的（示例账单标的 + 示例行情标的）' : localBill ? '标的（账单标的 + 本次行情标的）' : '标的（账单标的 + 示例标的）']), symSelect]),
      el('label', { class: 'cv-field' }, [el('span', { class: 'muted small' }, ['申报日期']), dateInput]),
      simBtn,
    ]));
    if (hasBuyback) {
      const sells = sc.sells.map((s) => `${s.trade_id} ${s.symbol} ${s.trade_date}`).join('；') || '无';
      sim.append(el('div', { class: 'muted small cv-sells' }, [`卖出记录来源：${displayTradeSource(sc.tradesSource)}——卖出：${sells}`]));
    }
    if (hasBuySell) {
      const buys = sc.buys.map((b) => `${b.trade_id} ${b.symbol} ${b.trade_date}`).join('；') || '无';
      sim.append(el('div', { class: 'muted small cv-buys' }, [`买入记录来源：${displayTradeSource(sc.tradesSource)}——买入：${buys}`]));
    }
  }
  }
  sim.append(simResultBox);
  if (c.simContext && !c.simContext.error && c.simContext.ledger) sim.append(ledgerCard(c.simContext.ledger));
  return sim;
  }

  function paintSim() {
    if (simBtn) simBtn.disabled = !!c.sim.running;
    simResultBox.replaceChildren(...(c.sim.result ? [simBatch(c.sim.result, c.sim.fallback)] : []));
  }
  if (standalone) {
    page.append(el('div', { class: 'card cv-selfcheck-head' }, [
      el('h2', { class: 'cv-title' }, ['申报前自检']),
      el('div', { class: 'cv-intro' }, ['用当前生效规则重放历史行情，看看某个标的在某个日期会触发哪条规则。这是历史模拟，不是实时提醒；不会下单，也不会阻止交易。']),
    ]));
    page.append(buildSimulation());
    paintSim();
  }

  /* —— 新增 / 修改弹窗：背景不可操作；Esc / 关闭 / 取消均不写记录 —— */
  const backdrop = !standalone && c.modal ? renderModal() : null;
  closeActiveModal = !standalone && c.modal ? closeEditor : null;
  if (!standalone && c.modal) {
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

function setFallback(set, state, runId, fallback) {
  if (state.contracts.sim.runId !== runId) return;
  set({ contracts: { sim: { ...state.contracts.sim, fallback } } });
}

/* —— 自定义规则判定：范围/动作适用的自定义规则逐条请求模型辅助判定；失败一律“无法判断”，不显示“未命中”；
      结果按规则分别回填（互不覆盖），只有绑定（运行标识 + 规则哈希/版本 + 情境）完全一致时才采用 —— */
function resummarize(results) {
  const summary = { triggered: 0, not_triggered: 0, missing_data: 0, not_applicable: 0, error: 0, unable: 0, custom_pending: 0 };
  for (const r of results) summary[r.display_verdict] = (summary[r.display_verdict] ?? 0) + 1;
  return summary;
}

function patchSimResult({ runId, set, state }, entry, patch) {
  if (state.contracts.sim.runId !== runId) return;
  const cur = state.contracts.sim.result;
  if (!cur || !Array.isArray(cur.results)) return;
  const i = cur.results.indexOf(entry);
  if (i < 0) return;
  const results = cur.results.slice();
  results[i] = { ...entry, ...patch };
  set({ contracts: { sim: { ...state.contracts.sim, result: { ...cur, results, summary: resummarize(results) } } } });
}

function runCustomJudgment({ result, runId, set, state }) {
  if (!result || !Array.isArray(result.results)) return;
  const pendings = result.results.filter((r) => r.display_verdict === 'custom_pending' && r.custom);
  if (!pendings.length) return;
  const judge = getCustomJudgeClient();
  for (const entry of pendings) {
    judge.judgeRule({ entry, runId })
      .then((judged) => {
        if (state.contracts.sim.runId !== runId) return;
        if (judged.ok) {
          const verdict = judged.verdict === 'triggered' ? 'triggered' : judged.verdict === 'not_triggered' ? 'not_triggered' : 'unable';
          patchSimResult({ runId, set, state }, entry, {
            verdict, display_verdict: verdict, code: null, message: judged.reason,
            custom: { ...entry.custom, status: 'judged', judgment: { reason: judged.reason, used_data: judged.used_data } },
          });
        } else {
          patchSimResult({ runId, set, state }, entry, {
            verdict: 'unable', display_verdict: 'unable', code: judged.code, message: judged.message,
            custom: { ...entry.custom, status: 'failed', failure: { code: judged.code, message: judged.message } },
          });
        }
      })
      .catch(() => {
        patchSimResult({ runId, set, state }, entry, {
          verdict: 'unable', display_verdict: 'unable',
          code: CUSTOM_RULE_JUDGMENT_CODES.UNAVAILABLE, message: '自定义规则判定服务不可用',
          custom: { ...entry.custom, status: 'failed', failure: { code: CUSTOM_RULE_JUDGMENT_CODES.UNAVAILABLE, message: '自定义规则判定服务不可用' } },
        });
      });
  }
}

function runUnmatchedFallback({ result, versions, runId, set, state }) {
  if (!result) return;
  if (result.marketSourceId !== 'dynamic-tushare') {
    setFallback(set, state, runId, { status: 'skipped', reason: 'non_dynamic_market', message: '当前不是动态行情情境：不调用 AI 判断' });
    return;
  }
  const current = adapter.contractRuleSet(versions).current;
  const picked = pickScenarioForJudgment({ simulation: result, currentRules: current });
  if (!picked.ok) {
    setFallback(set, state, runId, { status: 'skipped', reason: picked.code, message: picked.message });
    return;
  }
  const expectedRuleSetHash = ruleSetHash(current.map((r) => r.hash));
  setFallback(set, state, runId, {
    status: 'pending',
    rule_count: current.length,
    scenario_id: `scenario-${runId}`,
    rule_set_hash: expectedRuleSetHash,
  });
  getFallbackClient().judgeScenario({ simulation: result, currentRules: current, runId })
    .then((judged) => {
      if (state.contracts.sim.runId !== runId) return;
      const currentNow = adapter.contractRuleSet(state.contracts.versions).current;
      if (ruleSetHash(currentNow.map((r) => r.hash)) !== expectedRuleSetHash) {
        setFallback(set, state, runId, { status: 'skipped', reason: 'rule_changed', message: '规则已变化：本次 AI 判断已丢弃' });
        return;
      }
      setFallback(set, state, runId, judged.ok
        ? {
          status: 'ok',
          rule_count: current.length,
          scenario_id: judged.binding.scenario_id,
          rule_set_hash: judged.binding.rule_set_hash,
          judgment: judged.judgment,
          answer_text: judged.answer_text,
          request_id: judged.binding.request_id,
        }
        : {
          status: 'failed',
          rule_count: current.length,
          scenario_id: `scenario-${runId}`,
          rule_set_hash: expectedRuleSetHash,
          code: judged.code,
          message: judged.message,
        });
    })
    .catch(() => {
      setFallback(set, state, runId, {
        status: 'failed',
        rule_count: current.length,
        scenario_id: `scenario-${runId}`,
        rule_set_hash: expectedRuleSetHash,
        code: 'W_RULE_FALLBACK_UNAVAILABLE',
        message: 'AI 判断不可用；规则结果仍以本地判定为准',
      });
    });
}

function fallbackBlock(fallback) {
  if (!fallback) return null;
  if (fallback.status === 'pending') {
    return el('div', { class: 'cv-ai-fallback' }, [
      el('div', { class: 'cv-ai-fallback-head' }, ['AI 判断（未匹配已锁定规则）']),
      el('div', { class: 'muted small' }, ['正在请求 AI 判断理由…已有规则命中时不会调用。']),
    ]);
  }
  if (fallback.status === 'ok') {
    return el('div', { class: 'cv-ai-fallback' }, [
      el('div', { class: 'cv-ai-fallback-head' }, ['AI 判断（未匹配已锁定规则）']),
      el('div', { class: 'calc-line' }, [safe(fallback.answer_text)]),
      el('div', { class: 'muted small' }, ['AI 只解释未匹配原因；不改写规则、不自动保存，也不覆盖本地规则判定。']),
    ]);
  }
  if (fallback.status === 'failed') {
    return el('div', { class: 'cv-ai-fallback' }, [
      el('div', { class: 'cv-ai-fallback-head' }, ['AI 判断未生成']),
      el('div', { class: 'calc-line' }, ['规则结果仍以本地判定为准，不会用 AI 结论覆盖。']),
    ]);
  }
  return null;
}

function simBatch(b, fallback = null) {
  const box = el('div', { class: 'cv-sim-batch' });
  box.append(el('div', { class: 'row' }, [el('strong', {}, [`${safe(b.symbol)} · 申报日 ${safe(b.requested_date)} · ${b.scenario_action === 'sell' ? '假如卖出' : '假如买入'}`])]));
  const reconfirmNote = b.needs_reconfirm_n
    ? el('div', { class: 'muted small cv-reconfirm-note' }, [`另有 ${b.needs_reconfirm_n} 条规则因内容与候选哈希不一致未参与本次判定（见“待重新确认的规则”），不会自动修正。`])
    : null;
  if (b.empty) {
    box.append(el('div', { class: 'cv-sim-empty' }, ['本次没有当前生效的规则参与判定，不会产生规则提醒（不等于“未命中”）。']));
    const emptyFallback = fallbackBlock(fallback);
    if (emptyFallback) box.append(emptyFallback);
    if (reconfirmNote) box.append(reconfirmNote);
    return box;
  }
  box.append(el('div', { class: 'row cv-sim-summary' }, SUMMARY.filter(([k]) => (b.summary[k] ?? 0) > 0).map(([k, label, kind]) => el('span', { class: `chip ${kind}`, 'data-verdict': k }, [`${label} ${b.summary[k]} 条`]))));
  const aiFallback = fallbackBlock(fallback);
  if (aiFallback) box.append(aiFallback);
  if (reconfirmNote) box.append(reconfirmNote);
  for (const r of b.results) {
    // 范围 / 动作不适用的规则不进入结果列表（只计入上方汇总），避免与参与判定的规则混排。
    if (r.ok && r.verdict === 'not_applicable') continue;
    box.append(simResult(r));
  }
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
  if (fact.last_buy) lines.push(`最近买入：${fact.last_buy.trade_id} · ${fact.last_buy.trade_date}`);
  if (fact.distance_trading_days !== undefined) {
    lines.push(fact.last_buy
      ? `距最近买入：${fact.distance_trading_days} 个交易日（窗口 ${fact.window_days} 个交易日）`
      : `距最近卖出：${fact.distance_trading_days} 个交易日（窗口 ${fact.window_days} 个交易日）`);
  }
  if (fact.same_day_buy_count) lines.push(`同日买入 ${fact.same_day_buy_count} 笔：账单没有成交时刻，先后顺序未知，不计为“买入后”`);
  if (fact.result_basis === 'imported_records') lines.push('结果依据：当前导入账单中的可见买入记录');
  if (fact.history_completeness === 'unconfirmed') lines.push('账单完整性：未确认');
  return lines;
}

function simResult(r) {
  const verdict = r.display_verdict ?? (r.ok ? r.verdict : 'error');
  const v = verdict === 'missing_data' && UNCONFIRMED_BUY_CODES.has(r.code)
    ? { text: '无法确认', kind: 'mode' }
    : VERDICT[verdict] ?? { text: '无法判定', kind: 'warn' };
  const box = el('div', { class: `cv-sim-result ${verdict}`, 'data-hash': r.rule.hash });
  box.append(el('div', { class: 'row' }, [
    el('span', { class: `chip cv-verdict ${v.kind}` }, [v.text]),
    chip(`版本 v${safe(r.rule.v)}`, 'mode'),
    chip(`适用：${safe(r.rule.scope_text)}`, 'mode'),
    chip(r.scenario_action === 'sell' ? '情境：卖出' : '情境：买入', 'mode'),
    el('strong', {}, [safe(r.rule.text)]),
  ]));
  if (r.date_mapping) box.append(el('div', { class: 'calc-line cv-date-mapping' }, [`申报日 ${r.date_mapping.requested_date} → ${r.date_mapping.has_price ? '实际使用交易日' : '映射交易日'} ${r.date_mapping.effective_date}：${r.date_mapping.message}`]));
  // 自定义规则：判定中 / 命中 / 未命中 / 无法判断，展示与确定性判断一致（不标注“AI 辅助分析”）；
  // 显示判断依据与实际使用的数据，并写明发送到服务端的内容。
  if (r.custom) {
    const j = r.custom.judgment;
    if (r.custom.status === 'pending') {
      box.append(el('div', { class: 'calc-line' }, [CUSTOM_PENDING_NOTE]));
    } else if (r.custom.status === 'judged' && j) {
      if (verdict === 'triggered') {
        box.append(el('div', { class: 'cv-warning' }, [
          el('strong', {}, ['规则提醒：此情境命中你确认的规则']),
          el('div', { class: 'calc-line' }, [`规则：${safe(r.rule.text)}`]),
          el('div', { class: 'calc-line' }, [`判断依据：${safe(j.reason)}`]),
          el('div', { class: 'muted small' }, ['提醒：此提醒只用于复盘对照，不下单、不阻止交易。']),
        ]));
      } else if (verdict === 'not_triggered') {
        box.append(el('div', { class: 'calc-line' }, [`判断依据：${safe(j.reason)}`]));
      } else {
        box.append(el('div', { class: 'calc-line' }, [`原因：${safe(j.reason)}`]));
        box.append(el('div', { class: 'muted small' }, [CUSTOM_UNABLE_NOTE]));
      }
      box.append(el('div', { class: 'calc-line cv-custom-used' }, [`使用的数据：${j.used_data.length ? j.used_data.map((u) => CUSTOM_USED_DATA_LABEL[u] ?? u).join('、') : '仅规则原文与情境信息'}`]));
    } else {
      box.append(el('div', { class: 'calc-line' }, [safe(r.message) || '未提供具体原因']));
      box.append(el('div', { class: 'muted small' }, [CUSTOM_UNABLE_NOTE]));
    }
    const data = r.custom.data ?? {};
    box.append(el('div', { class: 'muted small cv-custom-data' }, [
      `本次判定可用数据：${safe(data.market_label)}（当日涨跌幅${data.change_pct !== null && data.change_pct !== undefined ? '可用' : '暂缺'}）；该标的账单记录：买入 ${(data.buys ?? []).length} 笔、卖出 ${(data.sells ?? []).length} 笔（只使用日期）；交易日历 ${(data.trading_days ?? []).length} 天${data.calendar_truncated ? '（超出部分未发送）' : ''}。`,
    ]));
    box.append(el('div', { class: 'muted small cv-custom-disclosure' }, [CUSTOM_DISCLOSURE]));
    return box;
  }
  if (verdict === 'error') {
    box.append(el('div', { class: 'cv-error' }, [
      el('div', { class: 'error' }, ['无法判定']),
      el('div', { class: 'calc-line' }, [safe(r.message) || '未提供具体原因']),
    ]));
  } else if (verdict === 'missing_data') {
    box.append(el('div', { class: 'calc-line' }, [`引擎原因：${r.change && !r.change.complete ? r.change.message : safe(r.message)}`]));
    if (r.rule.kind === 'buy_sell_window' && r.match && r.match.fact) {
      box.append(el('div', { class: 'calc-line' }, [`情境事实：${factLines(r.match.fact, r.change).join('；')}`]));
    }
    const buySellNote = r.rule.kind === 'buy_sell_window'
      ? (BUY_SELL_MISSING_NOTE[r.code] ?? '数据不足：无法计算买入后的交易日窗口，不猜测；本次不显示“未命中”，也不作命中判定。')
      : null;
    box.append(el('div', { class: 'muted small' }, [buySellNote
      ?? '数据不足：不补造数值，缺价时不改用其他日期的价格，本次不作命中判定。']));
  } else {
    const m = r.match;
    box.append(el('div', { class: 'calc-line' }, [safe(r.message)]));
    if (m.warning) {
      box.append(el('div', { class: 'cv-warning' }, [
        el('strong', {}, ['规则提醒：此情境命中你确认的规则']),
        el('div', { class: 'calc-line' }, [`规则：${m.warning.rule_text}`]),
        el('div', { class: 'calc-line' }, [`阈值：${m.warning.threshold_display}`]),
        el('div', { class: 'calc-line' }, [`情境事实：${factLines(m.warning.situation, r.change).join('；')}`]),
        el('div', { class: 'muted small' }, [`提醒：${m.reminder}`]),
      ]));
    } else {
      box.append(el('div', { class: 'calc-line' }, [`情境事实：${factLines(m.fact, r.change).join('；')}`]));
    }
  }
  if (r.in_market_cache === false) {
    const tradeOnly = r.rule.kind === 'buy_sell_window'
      ? '买入后卖出提醒只使用交易日历与账单交易，不读取价格'
      : '不追回判定只使用交易日历与账单交易，不读取价格';
    box.append(el('div', { class: 'muted small' }, [r.tradesSource && r.tradesSource.kind === 'user_bill'
      ? `标的 ${safe(r.symbol)} 不在本次行情支持范围：${r.uses_trades ? tradeOnly : '无法读取涨跌幅'}；不替换标的、不回退演示账单。`
      : `标的 ${safe(r.symbol)} 不在本次行情支持范围：${r.uses_trades ? tradeOnly : '无法读取涨跌幅'}；不替换标的、不回退其他行情来源。`]));
  }
  return box;
}
