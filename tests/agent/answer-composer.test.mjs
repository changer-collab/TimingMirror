#!/usr/bin/env node
/**
 * P2 · 回答合成与 claim 绑定 —— 离线单测（合成文本/证据；零网络）
 *
 * 覆盖：分句、claim 与证据事实的绑定（只按逐字数值匹配）、无证据句保留空绑定、
 *       本地草稿原样透传、示例/真实账单边界。
 * 运行：node tests/agent/answer-composer.test.mjs（或 npm run check）
 */
import {
  splitSentences, buildClaims, composeLocalAnswer, COMPOSE_VERSION, COMPOSED_INTENTS,
} from '../../src/agent/answerComposer.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const EVIDENCE = {
  facts: [
    { id: 'F1', key: 'actualRet', label: '实际收益', value: '+10.0%' },
    { id: 'F2', key: 'ghostRet', label: '对照收益', value: '+20.0%' },
    { id: 'F3', key: 'dragMoney', label: '损耗金额', value: '¥1,100.00', tone: 'loss' },
  ],
};
const TEXT = '实际收益 +10.0%，对照收益 +20.0%，择时损耗 −10.0pp。择时差额合计 ¥1,100.00。这是事后对照，不是当时该怎么做。';

/* ==== ① 分句 ==== */
{
  const sentences = splitSentences('一。二；三');
  check('分句：句号与分号都切分且保留句尾', sentences.join('|') === '一。|二；|三', sentences.join('|'));
  check('分句：空输入返回空数组', splitSentences('').length === 0 && splitSentences(null).length === 0);
}

/* ==== ② claim 与证据绑定 ==== */
{
  const claims = buildClaims({ text: TEXT, facts: [], evidence: EVIDENCE });
  check('claim：逐句编号 Q1..Q3', claims.map((c) => c.id).join(',') === 'Q1,Q2,Q3', claims.map((c) => c.id).join(','));
  check('claim：含金额的句子绑定对应事实', claims[0].evidence_ids.includes('F1')
    && claims[0].evidence_ids.includes('F2') && claims[1].evidence_ids.includes('F3'), JSON.stringify(claims.map((c) => c.evidence_ids)));
  check('claim：纯说明句不绑定证据', claims[2].evidence_ids.length === 0, JSON.stringify(claims[2]));
  check('claim：文本保留原句', claims[2].text.includes('事后对照'), claims[2].text);

  const noEvidence = buildClaims({ text: TEXT });
  check('claim：无证据包时全部空绑定', noEvidence.every((c) => c.evidence_ids.length === 0) && noEvidence.length === 3);
  const localFacts = buildClaims({ text: TEXT, facts: [{ label: '实际收益', value: '+10.0%' }], evidence: EVIDENCE });
  check('claim：本地事实按值回指证据 id，不凭标签猜测', localFacts[0].evidence_ids.includes('F1')
    && !localFacts[0].evidence_ids.includes('F3'), JSON.stringify(localFacts[0]));
  const blank = buildClaims({});
  check('claim：空文本返回空列表', Array.isArray(blank) && blank.length === 0);
}

/* ==== ③ 本地草稿原样透传 ==== */
{
  const local = {
    text: TEXT,
    facts: [{ label: '实际收益', value: '+10.0%' }, { label: '损耗金额', value: '¥1,100.00', tone: 'loss' }],
    evidence: [{ label: '公式', detail: '公式：实际收益 = 期末实际价值 ÷ 买入成本 − 1' }],
  };
  const real = composeLocalAnswer({ intent: 'loss_overview', local, evidence: EVIDENCE, gate: { published: true, demo: false } });
  check('合成：版本/意图/状态', real.version === COMPOSE_VERSION && real.intent === 'loss_overview' && real.status === 'local');
  check('合成：文字、事实、证据不改写', real.text === local.text
    && real.facts[0].value === '+10.0%' && real.evidence[0].detail.includes('÷'), JSON.stringify(real));
  check('合成：claims 与证据包同时产出', real.claims.length === 3 && real.evidence_bundle === EVIDENCE);
  check('合成：真实账单边界', real.boundaries.includes('只使用当前账单已核对并发布的数字')
    && real.boundaries.includes('事后对照，不预测涨跌'), JSON.stringify(real.boundaries));

  const demo = composeLocalAnswer({ intent: 'loss_overview', local, evidence: EVIDENCE, gate: { demo: true } });
  check('合成：示例账单边界替换为示例口径', demo.boundaries[0] === '示例数据，不是真实账户'
    && !demo.boundaries.includes('只使用当前账单已核对并发布的数字'), JSON.stringify(demo.boundaries));
  check('合成：已迁移意图清单固定 5 类', COMPOSED_INTENTS.join(',') === 'loss_overview,worst_trade,best_trade,pattern_explain,similar_context');
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
