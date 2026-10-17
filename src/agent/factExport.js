// M1-C10 离线段 · 事实 JSON 导出器（确定性；接口候选，未冻结）
// 输入：reviewPipeline（M1-C7）实际输出（review.status / published_facts / blocked_facts / provenance / recompute_log / portfolio_published）。
// 规则：
//   · 只导出 review.published_facts；blocked / insufficient_evidence（blocked_facts、degraded 未通过项）一律不得进入；
//   · portfolio 事实仅当 review.portfolio_published === true 时导出（B4）；
//   · 不回退读取引擎原始结果绕过 reviewPipeline；不生成新计算、不复制公式；
//   · 同一输入重复导出，JSON 内容完全一致（无时间戳、无随机、顺序稳定）。
//   · blocked review（含 provenance 为 null 的合法阻断输出）→ status 'blocked'；已发布事实但 provenance 缺失/非法 → 'invalid'；
//   · 诊断消息不回显原始 fact_id / scope 原文（fact_id 仅以匿名句柄 `F-`+8hex 出现），避免 diagnostics 随出站时泄露标识。
// 出站白名单（基线 §2.1 F-6 / §3 R5）：value / unit / display / formula_ref / 匿名 source_ref / 必要的行为标签（须有证据引用）。
// 出站禁止：原始成交行、trade_id、文件名/行号等 source 明细、账户信息、订单编号、未通过复核的数字。
// 候选扩展（未冻结）：fact_ref / scope（匿名稳定句柄，如 portfolio / stock-1）/ key —— 供本地与对话上下文引用，
//   不含原始 fact_id、不含标的代码；是否最终进入出站 JSON 待接口评审。
// 边界：纯函数；无 DOM / localStorage / 网络 / 模型调用。
export const FACT_EXPORT_CODES = Object.freeze({
  INPUT_INVALID: 'E_FACT_INPUT_INVALID',
  REVIEW_NOT_PUBLISHED: 'E_FACT_NOT_PUBLISHED',
  INTENT_UNSUPPORTED: 'E_FACT_INTENT_UNSUPPORTED',
  SCOPE_UNAVAILABLE: 'E_FACT_SCOPE_UNAVAILABLE',
  PROVENANCE_MISSING: 'E_FACT_PROVENANCE_MISSING',
  PORTFOLIO_WITHHELD: 'W_FACT_PORTFOLIO_WITHHELD',
  BEHAVIOR_TAG_DROPPED: 'W_FACT_BEHAVIOR_TAG_DROPPED',
});

export const FACT_SET_VERSION = 'candidate-1';

// intent → 事实选择（候选）：仅覆盖 reviewPipeline 输出可支撑的意图；其余返回 unsupported（不猜测、不填造）。
const INTENT_SELECTION = Object.freeze({
  loss_overview: { mode: 'all' },
  worst_trade: { mode: 'keys', keys: ['dragMoney', 'drag'] }, // 逐笔分解属 decompose 模块（不在 review 已发布事实内），用 drag 类事实支撑
  meta_calc: { mode: 'all' }, // 含 formula_ref，供“怎么算的”路径解释
  meta_trust: { mode: 'all' },
  out_of_scope: { mode: 'none' }, // 合规模板：零事实
});

const UNSUPPORTED_INTENTS = Object.freeze([
  'pattern_explain', // 行为模式（behavior 模块）不在 reviewPipeline 输出内
  'profile',
  'what_if', // 单笔反事实（counterfactual 模块）不在本事实集
  'similar_context',
  'how_to_change',
  'contract_setup',
  'contract_status',
]);

function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

function factRef(factId) {
  return `F-${fnv1a64(factId).slice(0, 8)}`;
}

function scopeHandle(sortedStockScopes, scope) {
  return scope === 'portfolio' ? 'portfolio' : `stock-${sortedStockScopes.indexOf(scope) + 1}`;
}

/**
 * 导出允许出站的事实 JSON（候选接口）。
 * @param {object} input
 * @param {object} input.review runReview（M1-C7）的实际输出
 * @param {string|null} [input.intent] planner 的 F-8 意图之一（null＝全量已发布事实）
 * @param {string|null} [input.scope] 请求作用域（'portfolio' 或原始 fact 的 scope；null＝全部）
 * @param {Array|null} [input.behavior_tags] 行为标签候选 [{tag, evidence_ref}]（须有证据引用，否则丢弃并告警）
 */
export function exportFacts({ review, intent = null, scope = null, behavior_tags = null } = {}) {
  const diagnostics = [];
  const out = {
    status: 'invalid',
    fact_set_version: FACT_SET_VERSION,
    intent,
    facts: [],
    diagnostics,
    meta: { published_total: 0, blocked_total: 0, exported: 0, recompute_attempts: 0 },
  };

  /* —— 输入校验：必须是 reviewPipeline 的实际输出形状 —— */
  if (review === null || typeof review !== 'object'
    || !Array.isArray(review.published_facts) || !Array.isArray(review.blocked_facts)
    || review.meta === null || typeof review.meta !== 'object') {
    diagnostics.push({
      code: FACT_EXPORT_CODES.INPUT_INVALID,
      message: 'review 非法或缺失必需字段（published_facts / blocked_facts / meta）：不导出',
    });
    return out;
  }
  out.meta.published_total = review.published_facts.length;
  out.meta.blocked_total = review.blocked_facts.length;
  out.meta.recompute_attempts = Number.isFinite(review.meta.recompute_attempts) ? review.meta.recompute_attempts : 0;

  /* —— intent 选择 —— */
  let selection = { mode: 'all' };
  if (intent !== null) {
    if (UNSUPPORTED_INTENTS.includes(intent)) {
      out.status = 'unsupported';
      diagnostics.push({
        code: FACT_EXPORT_CODES.INTENT_UNSUPPORTED,
        message: `intent「${intent}」所需数据不在 reviewPipeline 输出内：离线导出不支持（不猜测、不填造）`,
      });
      return out;
    }
    const sel = INTENT_SELECTION[intent];
    if (!sel) {
      out.status = 'unsupported';
      diagnostics.push({
        code: FACT_EXPORT_CODES.INTENT_UNSUPPORTED,
        message: `intent「${intent}」不在离线导出支持集（loss_overview / worst_trade / meta_calc / meta_trust / out_of_scope）`,
      });
      return out;
    }
    selection = sel;
  }
  if (selection.mode === 'none') {
    out.status = 'ok'; // 越界/未匹配：合规模板，零事实
    return out;
  }

  /* —— 发布状态门槛（blocked review 含 provenance 可为 null 的合法阻断输出：先判状态，再要求 provenance） —— */
  if (review.status === 'blocked' || review.published_facts.length === 0) {
    out.status = 'blocked';
    diagnostics.push({
      code: FACT_EXPORT_CODES.REVIEW_NOT_PUBLISHED,
      message: 'review 无可发布事实：blocked / insufficient_evidence 的数字不得进入事实 JSON（不发布即不导出）',
    });
    return out;
  }
  if (review.provenance === null || typeof review.provenance !== 'object') {
    out.status = 'invalid';
    diagnostics.push({
      code: FACT_EXPORT_CODES.INPUT_INVALID,
      message: 'review 已发布事实但 provenance 缺失或非法：无法核验来源与单位，不导出（invalid）',
    });
    return out;
  }
  if (review.portfolio_published !== true) {
    diagnostics.push({
      code: FACT_EXPORT_CODES.PORTFOLIO_WITHHELD,
      message: '组合结论未发布（portfolio_published=false）：组合事实不导出（B4，不按剩余标的重算冒充完整组合）',
    });
  }

  /* —— 匿名作用域句柄（稳定：按原始 scope 排序） —— */
  const scopes = [...new Set(review.published_facts.map((f) => f.scope))].sort();
  const stockScopes = scopes.filter((s) => s !== 'portfolio');
  if (scope !== null && !scopes.includes(scope)) {
    out.status = 'needs_context';
    diagnostics.push({
      code: FACT_EXPORT_CODES.SCOPE_UNAVAILABLE,
      message: '请求作用域不在已发布事实集：需澄清（不猜测所占范围）',
    });
    return out;
  }

  /* —— 逐 fact 导出（仅 published；provenance 非阻断；匿名 source_ref） —— */
  const provItems = Array.isArray(review.provenance.items) ? review.provenance.items : [];
  const provByFact = new Map(provItems.map((i) => [i.fact_id, i]));
  for (const f of review.published_facts) {
    if (scope !== null && f.scope !== scope) continue;
    if (f.scope === 'portfolio' && review.portfolio_published !== true) continue;
    if (selection.mode === 'keys' && !selection.keys.includes(f.key)) continue;
    const provItem = provByFact.get(f.fact_id);
    if (!provItem || provItem.blocked) {
      diagnostics.push({
        code: FACT_EXPORT_CODES.PROVENANCE_MISSING,
        message: `fact「${factRef(f.fact_id)}」缺少非阻断 provenance：不导出（A.4 悬空引用阻断）`,
      });
      continue;
    }
    const srcCount = Array.isArray(provItem.source_refs) ? provItem.source_refs.length : 0;
    out.facts.push({
      fact_ref: factRef(f.fact_id),
      scope: scopeHandle(stockScopes, f.scope),
      key: f.key,
      value: f.value,
      unit: provItem.unit ?? null,
      display: f.display ?? null,
      formula_ref: f.formula_id ?? provItem.formula_id ?? null,
      source_ref: `src-${fnv1a64(`${f.fact_id}|${srcCount}`).slice(0, 8)}`,
    });
  }
  out.facts.sort((a, b) => (a.scope === b.scope ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.scope < b.scope ? -1 : 1));

  /* —— 行为标签（仅“已存在且有证据”的；候选语义） —— */
  if (Array.isArray(behavior_tags) && behavior_tags.length > 0) {
    const withEvidence = [];
    for (const t of behavior_tags) {
      if (t !== null && typeof t === 'object' && typeof t.tag === 'string' && typeof t.evidence_ref === 'string' && t.evidence_ref.length > 0) {
        withEvidence.push({ tag: t.tag, evidence_ref: t.evidence_ref });
      } else {
        diagnostics.push({
          code: FACT_EXPORT_CODES.BEHAVIOR_TAG_DROPPED,
          message: `行为标签「${String(t && t.tag)}」缺少证据引用：不导出（F-6 仅允许“已存在且有证据的”行为标签）`,
        });
      }
    }
    if (withEvidence.length > 0) out.behavior_tags = withEvidence;
  }

  out.status = 'ok';
  out.meta.exported = out.facts.length;
  return out;
}
