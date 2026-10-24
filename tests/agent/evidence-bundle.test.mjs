#!/usr/bin/env node
/**
 * P2 · 证据包 —— 离线单测（合成 ToolResult；零网络）
 *
 * 覆盖：事实/记录/公式的稳定 id、失败工具进入 excluded、假设/边界去重、
 *       覆盖计数、附加事实、按 key 定位事实、确定性。
 * 运行：node tests/agent/evidence-bundle.test.mjs（或 npm run check）
 */
import { buildEvidenceBundle, findEvidenceFact, EVIDENCE_VERSION } from '../../src/agent/evidenceBundle.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const OK_RESULT = {
  tool: 'indicators.compute', version: 'indicators-1', ok: true,
  facts: [
    { key: 'actualRet', label: '实际收益', value: '+10.0%' },
    { key: 'drag', label: '择时损耗', value: '-1.0pp', tone: 'loss' },
  ],
  records: [{ symbol: '000000', dragMoney: 100 }],
  formulas: [{ id: 'CALC_DRAG_V1', text: '实际收益 = 期末实际价值 ÷ 买入成本 − 1' }],
  assumptions: ['未计入费用、税费与分红'],
  boundaries: ['事后对照，不构成投资建议'],
  missing: [],
  source_refs: [{ symbol: '000000' }],
};
const FAIL_RESULT = {
  tool: 'behavior.patternList', version: 'behavior-1', ok: false,
  facts: [], records: [], formulas: [], assumptions: [], boundaries: [],
  missing: ['没有可对照的重复情境'], source_refs: [],
};

const RESULTS = [
  { tool: 'indicators.compute', ok: true, result: OK_RESULT },
  { tool: 'behavior.patternList', ok: false, result: FAIL_RESULT },
];
const ASSEMBLED = {
  gate: { published: true, demo: false },
  assumptions: ['按估值日不复权收盘价计算', '未计入费用、税费与分红'],
  boundaries: ['只使用当前账单已核对并发布的数字'],
};

/* ==== ① 汇总与稳定 id ==== */
{
  const bundle = buildEvidenceBundle({ results: RESULTS, assembled: ASSEMBLED });
  check('证据包：版本与事实稳定 id', bundle.version === EVIDENCE_VERSION
    && bundle.facts.map((f) => f.id).join(',') === 'F1,F2'
    && bundle.records.map((r) => r.id).join(',') === 'R1'
    && bundle.formulas.map((f) => f.id).join(',') === 'C1', JSON.stringify({ f: bundle.facts.map((x) => x.id), r: bundle.records.map((x) => x.id), c: bundle.formulas.map((x) => x.id) }));
  check('证据包：事实保留 key/value/tone 与来源工具', bundle.facts[1].key === 'drag'
    && bundle.facts[1].value === '-1.0pp' && bundle.facts[1].tone === 'loss'
    && bundle.facts[1].source_ref.tool === 'indicators.compute' && bundle.facts[1].source_ref.version === 'indicators-1', JSON.stringify(bundle.facts[1]));
  check('证据包：公式保留 formula_id 与用户可读文本', bundle.formulas[0].formula_id === 'CALC_DRAG_V1'
    && bundle.formulas[0].text.includes('×') === false && bundle.formulas[0].text.includes('÷'), JSON.stringify(bundle.formulas[0]));
}

/* ==== ② 失败工具进入 excluded，不虚报覆盖 ==== */
{
  const bundle = buildEvidenceBundle({ results: RESULTS, assembled: ASSEMBLED });
  check('证据包：失败工具列入 excluded 且带原因', bundle.excluded.length === 1
    && bundle.excluded[0].tool === 'behavior.patternList'
    && bundle.excluded[0].reason === '没有可对照的重复情境', JSON.stringify(bundle.excluded));
  check('证据包：覆盖计数如实', bundle.coverage.tools === 2 && bundle.coverage.ok_tools === 1
    && bundle.coverage.facts === 2 && bundle.coverage.records === 1 && bundle.coverage.formulas === 1
    && bundle.coverage.published === true && bundle.coverage.demo === false && bundle.coverage.bill_count === 1, JSON.stringify(bundle.coverage));
  check('证据包：缺省信息带工具名', bundle.missing.length === 0, JSON.stringify(bundle.missing));
}

/* ==== ③ 假设/边界去重与来源汇总 ==== */
{
  const bundle = buildEvidenceBundle({ results: RESULTS, assembled: ASSEMBLED });
  check('证据包：假设去重合并（上下文＋工具）', bundle.assumptions.length === 2
    && bundle.assumptions.includes('按估值日不复权收盘价计算')
    && bundle.assumptions.includes('未计入费用、税费与分红'), JSON.stringify(bundle.assumptions));
  check('证据包：边界合并上下文与工具', bundle.boundaries.includes('只使用当前账单已核对并发布的数字')
    && bundle.boundaries.includes('事后对照，不构成投资建议'), JSON.stringify(bundle.boundaries));
  check('证据包：来源引用按工具透传', bundle.source_refs.length === 1 && bundle.source_refs[0].symbol === '000000');
}

/* ==== ④ 附加事实与按 key 定位 ==== */
{
  const bundle = buildEvidenceBundle({
    results: RESULTS, assembled: ASSEMBLED,
    extraFacts: [{ key: 'reportState', label: '报告状态', value: '已发布' }, null],
  });
  check('附加事实：追加在工具事实之后', bundle.facts.length === 3
    && bundle.facts[2].id === 'F3' && bundle.facts[2].key === 'reportState'
    && bundle.facts[2].source_ref === null, JSON.stringify(bundle.facts[2]));
  check('按 key 定位：命中返回事实、未命中返回 null', findEvidenceFact(bundle, 'reportState')?.value === '已发布'
    && findEvidenceFact(bundle, 'nope') === null);
}

/* ==== ⑤ 确定性 ==== */
{
  const a = buildEvidenceBundle({ results: RESULTS, assembled: ASSEMBLED });
  const b = buildEvidenceBundle({ results: RESULTS, assembled: ASSEMBLED });
  check('确定性：同输入两次输出一致', JSON.stringify(a) === JSON.stringify(b));
  const empty = buildEvidenceBundle({});
  check('空输入：零事实但结构完整', empty.facts.length === 0
    && empty.coverage.ok_tools === 0 && empty.coverage.published === false && Array.isArray(empty.excluded));
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
