// 证据包：把 ToolResult 汇总成可复核的事实/记录/公式/假设/边界/覆盖/排除。
// 边界：只整理工具已算出的值，不新增或改写数字；每个事实带来源工具与稳定 id。
export const EVIDENCE_VERSION = 'evidence-1';

function unique(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean).map((x) => String(x)))];
}

export function buildEvidenceBundle({
  results = [], assembled = null, excluded = [], extraFacts = [],
} = {}) {
  const facts = [];
  const records = [];
  const formulas = [];
  const assumptions = [];
  const boundaries = [];
  const missing = [];
  const sourceRefs = [];
  const exclusions = [...(Array.isArray(excluded) ? excluded : [])];
  let okTools = 0;

  for (const stepResult of results) {
    const result = stepResult?.result;
    if (!result || result.ok === false) {
      exclusions.push({
        tool: stepResult?.tool ?? null,
        reason: result?.missing?.[0] ?? '工具未返回可用结果',
      });
      continue;
    }
    okTools += 1;
    const ref = { tool: result.tool, version: result.version };
    for (const fact of result.facts ?? []) {
      facts.push({
        id: `F${facts.length + 1}`,
        key: fact.key ?? null,
        label: String(fact.label ?? ''),
        value: fact.value,
        tone: fact.tone ?? null,
        source_ref: ref,
      });
    }
    for (const record of result.records ?? []) {
      records.push({ id: `R${records.length + 1}`, ...record, source_ref: ref });
    }
    for (const formula of result.formulas ?? []) {
      formulas.push({
        id: `C${formulas.length + 1}`,
        formula_id: formula.id ?? null,
        text: String(formula.text ?? ''),
        source_ref: ref,
      });
    }
    assumptions.push(...(result.assumptions ?? []));
    boundaries.push(...(result.boundaries ?? []));
    missing.push(...(result.missing ?? []).map((item) => ({ tool: result.tool, detail: String(item) })));
    sourceRefs.push(...(result.source_refs ?? []));
  }

  for (const fact of extraFacts) {
    if (!fact) continue;
    facts.push({
      id: `F${facts.length + 1}`,
      key: fact.key ?? null,
      label: String(fact.label ?? ''),
      value: fact.value,
      tone: fact.tone ?? null,
      source_ref: fact.source_ref ?? null,
    });
  }

  const gate = assembled?.gate ?? {};
  return {
    version: EVIDENCE_VERSION,
    facts,
    records,
    formulas,
    assumptions: unique([...(assembled?.assumptions ?? []), ...assumptions]),
    boundaries: unique([...(assembled?.boundaries ?? []), ...boundaries]),
    coverage: {
      tools: Array.isArray(results) ? results.length : 0,
      ok_tools: okTools,
      facts: facts.length,
      records: records.length,
      formulas: formulas.length,
      published: gate.published === true,
      demo: gate.demo === true,
      bill_count: 1,
    },
    excluded: exclusions,
    missing,
    source_refs: sourceRefs,
  };
}

// 供复核层按 key 或来源定位事实；不参与文案生成。
export function findEvidenceFact(bundle, key) {
  return (bundle?.facts ?? []).find((fact) => fact.key === key) ?? null;
}
