#!/usr/bin/env node
/**
 * P5 · 发布前复核 V1–V9 —— 离线单测（合成信封；不读账单、不调模型）
 *
 * 覆盖：发布门槛、数字回源、claim 绑定、公式重算、边界措辞、
 *       示例来源、术语解释、改写兜底、字段与内部 ID。
 * 运行：node tests/agent/answer-verifier.test.mjs（或 npm run check）
 */
import { verifyAnswer, withholdEnvelope } from '../../src/agent/answerVerifier.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const reasonOf = (out) => (out.reasons ?? []).join(',');
const has = (out, expected) => out.ok === false && (out.reasons ?? []).includes(expected);
const clone = (value) => JSON.parse(JSON.stringify(value));

const BILL = { status: 'confirmed', contextId: 'bill-verify-1', demo: false };

function baseEnvelope(over = {}) {
  const envelope = {
    status: 'local',
    intent: 'worst_trade',
    text: '这笔卖出的差额是 ¥100.00，对应 2024-09-27 卖出 000000 100 股。',
    facts: [{ label: '差额', value: '¥100.00' }, { label: '卖出笔数', value: '2 笔' }],
    evidence: [],
    claims: [
      { id: 'Q1', text: '这笔卖出的差额是 ¥100.00。', evidence_ids: ['F1'] },
      { id: 'Q2', text: '2024-09-27 卖出 000000 100 股。', evidence_ids: ['R1'] },
    ],
    narrative_policy: 'auto',
    evidence_bundle: {
      version: 'evidence-1',
      facts: [{ id: 'F1', label: '差额', value: '¥100.00' }, { id: 'F2', label: '卖出笔数', value: '2 笔' }],
      records: [{ id: 'R1', trade_date: '2024-09-27', symbol: '000000', quantity: 100, price: 11, close: 12 }],
      formulas: [{ id: 'C1', formula_id: 'CALC_DRAG_MONEY_V1', text: '差额 = 100 × (12 − 11) = 100' }],
      assumptions: ['按估值日不复权收盘价计算'],
      boundaries: ['只使用当前账单已核对并发布的数字', '不跨用户、不读取其他账单', '事后对照，不预测涨跌'],
      coverage: { tools: 1, ok_tools: 1, facts: 2, records: 1, formulas: 1, published: true, demo: false, bill_count: 1 },
      excluded: [],
      missing: [],
      source_refs: [{ trade_date: '2024-09-27', symbol: '000000' }],
    },
    rewrite: {
      status: 'ok',
      source: 'model',
      headline: '这笔卖出比持有不动少赚差额',
      plain: [{
        id: 'P1',
        text: '这笔卖出的差额是已经核对过的数字，按账单原始口径展示，不新增金额，也不改变单位。',
        claim_ids: ['Q1'],
      }],
      terms: [],
      claim_map: [{ claim_id: 'Q1', plain_ids: ['P1'] }],
      boundaries: [],
      claims: [],
    },
    rewrite_meta: { status: 'ok', model_called: true, cached: false },
    actions: [
      { id: 'open-report', label: '打开报告 · 证据', kind: 'navigate', href: '#/report' },
      { id: 'qa-meta-calc', label: '这些数字怎么算', kind: 'ask', question: '这些数字是怎么算出来的？' },
    ],
  };
  return { ...envelope, ...over };
}

/* ==== ① 正常信封全部通过 ==== */
{
  const out = verifyAnswer({ envelope: baseEnvelope(), scope: { kind: 'bill' }, bill: BILL });
  check('通过：状态 pass 且九项全部通过', out.ok === true && out.status === 'pass'
    && out.checks.length === 9 && out.checks.every((item) => item.ok === true), JSON.stringify(out.checks));
  check('通过：不改写原信封', out.envelope.facts.length === 2 && out.envelope.claims.length === 2
    && out.envelope.rewrite.status === 'ok', JSON.stringify(out.envelope.facts));
  check('通过：检查项按 V1–V9 顺序输出', out.checks.map((item) => item.id).join(',')
    === 'publish_gate,numbers_sourced,claims_bound,recompute,boundaries,synthetic_source,terms_explained,rewrite_fallback,fields',
  out.checks.map((item) => item.id).join(','));

  const demo = verifyAnswer({ envelope: baseEnvelope(), scope: { kind: 'demo_group' }, bill: { demo: true } });
  check('通过：示例账单不要求 confirmed', demo.ok === true, reasonOf(demo));
}

/* ==== ② V1 发布门槛 ==== */
{
  const unpublished = verifyAnswer({ envelope: baseEnvelope(), scope: { kind: 'bill' }, bill: { status: 'draft' } });
  check('V1：未确认账单 → 拦截', has(unpublished, 'publish_gate:BILL_NOT_PUBLISHED'), reasonOf(unpublished));

  const noFacts = verifyAnswer({ envelope: baseEnvelope({ facts: [] }), scope: { kind: 'bill' }, bill: BILL });
  check('V1：已确认但零事实 → 拦截', has(noFacts, 'publish_gate:NO_FACTS'), reasonOf(noFacts));

  const nonBill = verifyAnswer({ envelope: baseEnvelope(), scope: { kind: 'product_help' }, bill: BILL });
  check('V1：非账单范围跳过复核', nonBill.ok === true && nonBill.status === 'skipped', JSON.stringify(nonBill));

  const online = verifyAnswer({ envelope: baseEnvelope({ status: 'online' }), scope: { kind: 'bill' }, bill: BILL });
  check('V1：在线复述信封不重复复核', online.ok === true && online.status === 'skipped', JSON.stringify(online));
}

/* ==== ③ V2 数字回源 ==== */
{
  const localBad = baseEnvelope({ text: '这笔卖出的差额是 ¥999.00。' });
  const out = verifyAnswer({ envelope: localBad, scope: { kind: 'bill' }, bill: BILL });
  check('V2：本地草稿出现未提供金额 → 拦截', has(out, 'numbers_sourced:LOCAL_TEXT_NUMBERS'), reasonOf(out));

  const modelBad = clone(baseEnvelope());
  modelBad.rewrite.plain[0].text = '这笔卖出的差额是 ¥999.00，按账单原始口径展示，不新增金额，也不改变单位。';
  const model = verifyAnswer({ envelope: modelBad, scope: { kind: 'bill' }, bill: BILL });
  check('V2：模型改写新增数字 → 拦截', has(model, 'numbers_sourced:MODEL_TEXT_NUMBERS'), reasonOf(model));

  const unitOk = baseEnvelope({
    text: '这笔卖出的差额是 ¥100.00，100 股按卖出价 11.00 计算，对应 2024-09-27 的 000000。',
  });
  const units = verifyAnswer({ envelope: unitOk, scope: { kind: 'bill' }, bill: BILL });
  check('V2：单位与计数按同一数值放行', units.ok === true, reasonOf(units));

  const rowRef = baseEnvelope({ text: '这笔卖出的差额是 ¥100.00（第 2 行），按账单口径展示。' });
  const rows = verifyAnswer({ envelope: rowRef, scope: { kind: 'bill' }, bill: BILL });
  check('V2：行号引用不计入数字结论', rows.ok === true, reasonOf(rows));

  const dateBad = baseEnvelope({ text: '这笔卖出的差额是 ¥100.00，发生在 2024-09-28。' });
  const dates = verifyAnswer({ envelope: dateBad, scope: { kind: 'bill' }, bill: BILL });
  check('V2：未提供的日期 → 拦截', has(dates, 'numbers_sourced:LOCAL_TEXT_NUMBERS'), reasonOf(dates));
}

/* ==== ④ V3 结论挂 claim ==== */
{
  const missing = verifyAnswer({ envelope: baseEnvelope({ claims: [] }), scope: { kind: 'bill' }, bill: BILL });
  check('V3：没有 claim → 拦截', has(missing, 'claims_bound:CLAIMS_MISSING'), reasonOf(missing));

  const forged = clone(baseEnvelope());
  forged.claims[0].evidence_ids = ['F99'];
  const out = verifyAnswer({ envelope: forged, scope: { kind: 'bill' }, bill: BILL });
  check('V3：证据 id 不在证据包 → 拦截', has(out, 'claims_bound:CLAIM_UNKNOWN_RECORD'), reasonOf(out));

  const stripped = clone(baseEnvelope());
  stripped.claims[0].evidence_ids = [];
  const noBind = verifyAnswer({ envelope: stripped, scope: { kind: 'bill' }, bill: BILL });
  check('V3：复述事实却不绑定证据 → 拦截', has(noBind, 'claims_bound:CLAIM_WITHOUT_RECORD'), reasonOf(noBind));

  const duplicate = clone(baseEnvelope());
  duplicate.claims[1].id = 'Q1';
  const dup = verifyAnswer({ envelope: duplicate, scope: { kind: 'bill' }, bill: BILL });
  check('V3：claim 编号重复 → 拦截', has(dup, 'claims_bound:CLAIM_ID_INVALID'), reasonOf(dup));

  const plainBad = clone(baseEnvelope());
  plainBad.rewrite.plain[0].claim_ids = [];
  const noPlain = verifyAnswer({ envelope: plainBad, scope: { kind: 'bill' }, bill: BILL });
  check('V3：白话未挂 claim → 拦截', has(noPlain, 'claims_bound:PLAIN_WITHOUT_CLAIM'), reasonOf(noPlain));

  const mapBad = clone(baseEnvelope());
  mapBad.rewrite.claim_map = [{ claim_id: 'Q2', plain_ids: ['P1'] }];
  const map = verifyAnswer({ envelope: mapBad, scope: { kind: 'bill' }, bill: BILL });
  check('V3：claim_map 与白话不一致 → 拦截', has(map, 'claims_bound:CLAIM_MAP_MISMATCH'), reasonOf(map));
}

/* ==== ⑤ V4 独立重算 ==== */
{
  const bad = clone(baseEnvelope());
  bad.evidence_bundle.formulas[0].text = '100 + 1 = 102';
  const out = verifyAnswer({ envelope: bad, scope: { kind: 'bill' }, bill: BILL });
  check('V4：公式结果不一致 → 拦截', has(out, 'recompute:FORMULA_MISMATCH'), reasonOf(out));

  const good = clone(baseEnvelope());
  good.evidence_bundle.formulas[0].text = '100 * 1.001 = 100.1';
  const ok = verifyAnswer({ envelope: good, scope: { kind: 'bill' }, bill: BILL });
  check('V4：可重算且一致 → 放行', ok.ok === true, reasonOf(ok));
}

/* ==== ⑥ V5 边界措辞 ==== */
{
  const cases = [
    ['其他用户的账单里也有这种情况。', 'boundaries:CROSS_USER'],
    ['按实时行情看这笔卖出更差。', 'boundaries:REALTIME'],
    ['这笔卖出再次发生的概率很高。', 'boundaries:PROBABILITY'],
    ['整体是 63% 对 22% 对 15% 的结构。', 'boundaries:SPLIT_63_22_15'],
  ];
  for (const [text, expected] of cases) {
    const out = verifyAnswer({ envelope: baseEnvelope({ text }), scope: { kind: 'bill' }, bill: BILL });
    check(`V5：${expected} → 拦截`, has(out, expected), reasonOf(out));
  }
  const negative = baseEnvelope({
    text: '这笔卖出的差额是 ¥100.00；不比较其他账单，不看实时行情，也不给概率。',
  });
  const out = verifyAnswer({ envelope: negative, scope: { kind: 'bill' }, bill: BILL });
  check('V5：否定式边界说明不算违规', out.ok === true, reasonOf(out));
}

/* ==== ⑦ V6 示例来源 ==== */
{
  const demo = baseEnvelope({ text: '这笔卖出的差额是 ¥100.00，来自云端账单。' });
  const demoOut = verifyAnswer({ envelope: demo, scope: { kind: 'demo_group' }, bill: { demo: true } });
  check('V6：示例账单冒充云端 → 拦截', has(demoOut, 'synthetic_source:DEMO_AS_CLOUD'), reasonOf(demoOut));

  const cloud = baseEnvelope({ text: '这笔卖出的差额是 ¥100.00，来自示例账单。' });
  const cloudOut = verifyAnswer({ envelope: cloud, scope: { kind: 'bill' }, bill: BILL });
  check('V6：真实账单冒充示例 → 拦截', has(cloudOut, 'synthetic_source:CLOUD_AS_DEMO'), reasonOf(cloudOut));
}

/* ==== ⑧ V7 术语解释 ==== */
{
  const unexplained = clone(baseEnvelope());
  unexplained.rewrite.plain[0].text = '这里的反事实只是事后假设，按账单原始口径展示，不新增金额，也不改变单位，更不构成任何投资建议。';
  const out = verifyAnswer({ envelope: unexplained, scope: { kind: 'bill' }, bill: BILL });
  check('V7：术语出现但未登记解释 → 拦截', has(out, 'terms_explained:TERM_NOT_EXPLAINED'), reasonOf(out));

  const explained = clone(unexplained);
  explained.rewrite.terms = [{ term: '反事实', definition: '假设某一笔卖出没有发生时的结果。' }];
  const ok = verifyAnswer({ envelope: explained, scope: { kind: 'bill' }, bill: BILL });
  check('V7：术语登记解释后放行', ok.ok === true, reasonOf(ok));
}

/* ==== ⑨ V8 改写兜底 ==== */
{
  const fallback = clone(baseEnvelope());
  fallback.rewrite = {
    status: 'local_fallback',
    source: 'local',
    headline: '这笔卖出少赚差额',
    plain: [{ id: 'P1', text: '这笔卖出的差额按账单原始口径展示，不新增金额，也不改变单位。', claim_ids: [] }],
    terms: [],
    claim_map: [],
    boundaries: [],
    claims: [],
  };
  fallback.rewrite_meta = { status: 'local_fallback', model_called: false, cached: false };
  const ok = verifyAnswer({ envelope: fallback, scope: { kind: 'bill' }, bill: BILL });
  check('V8：本地兜底完整可读 → 放行', ok.ok === true, reasonOf(ok));

  const noMeta = clone(fallback);
  noMeta.rewrite_meta = { status: 'ok' };
  const metaOut = verifyAnswer({ envelope: noMeta, scope: { kind: 'bill' }, bill: BILL });
  check('V8：兜底缺少状态标记 → 拦截', has(metaOut, 'rewrite_fallback:FALLBACK_META_MISSING'), reasonOf(metaOut));

  const claimed = clone(fallback);
  claimed.rewrite.plain[0].claim_ids = ['Q1'];
  const claimedOut = verifyAnswer({ envelope: claimed, scope: { kind: 'bill' }, bill: BILL });
  check('V8：本地兜底冒挂 claim → 拦截', has(claimedOut, 'rewrite_fallback:FALLBACK_HAS_CLAIMS'), reasonOf(claimedOut));
}

/* ==== ⑩ V9 字段与内部 ID ==== */
{
  const uuid = baseEnvelope({ text: '这笔卖出的差额是 ¥100.00，账单 3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b。' });
  const uuidOut = verifyAnswer({ envelope: uuid, scope: { kind: 'bill' }, bill: BILL });
  check('V9：正文出现 UUID → 拦截', has(uuidOut, 'fields:INTERNAL_ID_VISIBLE'), reasonOf(uuidOut));

  const code = baseEnvelope({ text: '这笔卖出的差额是 ¥100.00（E_QA_SAMPLE）。' });
  const codeOut = verifyAnswer({ envelope: code, scope: { kind: 'bill' }, bill: BILL });
  check('V9：正文出现错误码 → 拦截', has(codeOut, 'fields:INTERNAL_ID_VISIBLE'), reasonOf(codeOut));

  const short = clone(baseEnvelope());
  short.rewrite.headline = '差额';
  const shortOut = verifyAnswer({ envelope: short, scope: { kind: 'bill' }, bill: BILL });
  check('V9：headline 过短 → 拦截', has(shortOut, 'fields:HEADLINE_LENGTH'), reasonOf(shortOut));

  const noTerms = clone(baseEnvelope());
  noTerms.rewrite.terms = null;
  const termsOut = verifyAnswer({ envelope: noTerms, scope: { kind: 'bill' }, bill: BILL });
  check('V9：缺少 terms 字段 → 拦截', has(termsOut, 'fields:TERMS_MISSING'), reasonOf(termsOut));

  const noText = baseEnvelope();
  delete noText.text;
  const textOut = verifyAnswer({ envelope: noText, scope: { kind: 'bill' }, bill: BILL });
  check('V9：缺少正文 → 拦截', has(textOut, 'fields:TEXT_MISSING'), reasonOf(textOut));
}

/* ==== ⑪ 不发布信封 ==== */
{
  const envelope = baseEnvelope();
  const held = withholdEnvelope(envelope, ['numbers_sourced:LOCAL_TEXT_NUMBERS', 'claims_bound:CLAIM_WITHOUT_RECORD']);
  check('withheld：状态与固定文案', held.status === 'withheld'
    && held.text.includes('没有通过发布前复核')
    && held.text.includes('不展示具体数字'), held.text);
  check('withheld：不保留事实/证据/claims/改写', held.facts.length === 0 && held.evidence.length === 0
    && held.claims.length === 0 && held.rewrite === null && held.narrative_policy === 'none', JSON.stringify(held));
  check('withheld：保留可行动作且不暴露内部码', held.actions.length <= 2
    && !/E_[A-Z0-9_]+/u.test(JSON.stringify(held))
    && held.verification.status === 'withheld'
    && held.verification.failed_checks.length === 2, JSON.stringify(held.verification));
  check('withheld：notice 说明本次不发布', held.notice.includes('不发布'), held.notice);

  const verified = verifyAnswer({ envelope: baseEnvelope(), scope: { kind: 'bill' }, bill: { status: 'draft' } });
  check('withheld：由复核直接产出且不带事实', verified.envelope.status === 'withheld'
    && verified.envelope.facts.length === 0
    && verified.envelope.verification.failed_checks.includes('publish_gate:BILL_NOT_PUBLISHED'),
  JSON.stringify(verified.envelope.verification));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
