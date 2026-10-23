#!/usr/bin/env node
/**
 * 对话画像信号测试（纯模块；fake transport；不联网）
 *
 * 覆盖：触发门槛（明确陈述 vs 问题/请求）、候选事实清洗、证据原文校验，
 * 以及 transport 异常时绝不抛错、不阻塞问答。
 */
import {
  createProfileFactRecorder,
  extractProfileFacts,
  normalizeFactCandidates,
  shouldExtractProfileFacts,
} from '../../src/agent/profileSignals.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const MESSAGE = '我希望把仓位控制在五成以内，也不做短线交易。';

check('门槛：明确陈述触发', shouldExtractProfileFacts(MESSAGE) === true);
check('门槛：明确目标触发', shouldExtractProfileFacts('我的目标是长期持有宽基指数基金。') === true);
check('门槛：疑问句不触发', shouldExtractProfileFacts('我希望把仓位控制在五成以内，对吗？') === false);
check('门槛：请求不触发', shouldExtractProfileFacts('帮我分析一下我的基金收益。') === false);
check('门槛：非投资内容不触发', shouldExtractProfileFacts('我一般周末去爬山放松。') === false);
check('门槛：过短不触发', shouldExtractProfileFacts('我买基金') === false);
check('门槛：无第一人称不触发', shouldExtractProfileFacts('投资者通常长期持有宽基指数基金。') === false);
check('门槛：非字符串不触发', shouldExtractProfileFacts(null) === false && shouldExtractProfileFacts(42) === false);

const CANDIDATES = [
  { kind: 'constraint', key: 'max_position', value: '仓位控制在五成以内', evidence: '把仓位控制在五成以内' },
  { kind: 'habit', key: 'avoid_short_term', value: '不做短线交易', evidence: '也不做短线交易' },
];

{
  const facts = normalizeFactCandidates(CANDIDATES, MESSAGE);
  check('候选：合法事实保留并去重', facts.length === 2
    && facts[0].evidence === '把仓位控制在五成以内'
    && facts[1].kind === 'habit', JSON.stringify(facts));
  check('候选：重复事实去重', normalizeFactCandidates([CANDIDATES[0], { ...CANDIDATES[0] }], MESSAGE).length === 1);
  check('候选：证据必须为原文', normalizeFactCandidates([{ ...CANDIDATES[0], evidence: '仓位控制在三成以内' }], MESSAGE).length === 0);
  check('候选：未知类型丢弃', normalizeFactCandidates([{ ...CANDIDATES[0], kind: 'unknown' }], MESSAGE).length === 0);
  check('候选：非法 key 丢弃', normalizeFactCandidates([{ ...CANDIDATES[0], key: '仓位' }], MESSAGE).length === 0);
  check('候选：空 value 丢弃', normalizeFactCandidates([{ ...CANDIDATES[0], value: ' ' }], MESSAGE).length === 0);
  check('候选：超长 value 丢弃', normalizeFactCandidates([{ ...CANDIDATES[0], value: '长'.repeat(241) }], MESSAGE).length === 0);
  check('候选：最多 3 条', normalizeFactCandidates([
    { kind: 'goal', key: 'a', value: '控制仓位', evidence: '把仓位控制' },
    { kind: 'goal', key: 'b', value: '控制仓位', evidence: '把仓位控制' },
    { kind: 'goal', key: 'c', value: '控制仓位', evidence: '把仓位控制' },
    { kind: 'goal', key: 'd', value: '控制仓位', evidence: '把仓位控制' },
  ], MESSAGE).length === 3);
  check('候选：非数组返回空', normalizeFactCandidates(null, MESSAGE).length === 0);
}

/* transport */
{
  const noTransport = await extractProfileFacts({ message: MESSAGE });
  check('调用：无 transport 不抛错', noTransport.ok === false
    && noTransport.code === 'E_PROFILE_FACT_UNAVAILABLE'
    && noTransport.facts.length === 0, JSON.stringify(noTransport));

  const structured = await extractProfileFacts({
    message: MESSAGE,
    transport: { async profileFact(request) { return { facts: request.message === MESSAGE ? CANDIDATES : [] }; } },
  });
  check('调用：结构化响应清洗后返回', structured.ok === true && structured.facts.length === 2, JSON.stringify(structured));

  const raw = await extractProfileFacts({
    message: MESSAGE,
    transport: { async profileFact() { return { rawText: JSON.stringify({ facts: CANDIDATES }) }; } },
  });
  check('调用：支持 rawText JSON', raw.ok === true && raw.facts.length === 2, JSON.stringify(raw));

  const garbage = await extractProfileFacts({
    message: MESSAGE,
    transport: { async profileFact() { return { rawText: 'not-json' }; } },
  });
  check('调用：非法响应返回 E_PROFILE_FACT_RESPONSE', garbage.ok === false
    && garbage.code === 'E_PROFILE_FACT_RESPONSE' && garbage.facts.length === 0, JSON.stringify(garbage));

  const throwing = await extractProfileFacts({
    message: MESSAGE,
    transport: { async profileFact() { const error = new Error('timeout'); error.code = 'E_HTTP_ABORTED'; throw error; } },
  });
  check('调用：transport 异常不向上抛', throwing.ok === false
    && throwing.code === 'E_HTTP_ABORTED' && throwing.facts.length === 0, JSON.stringify(throwing));
}

/* recorder：只记录明确陈述，落库失败不影响回答 */
{
  check('记录器：缺少 saveFacts 时返回 null', createProfileFactRecorder({ transport: {} }) === null);

  let extracted = 0;
  let saved = null;
  const recorder = createProfileFactRecorder({
    transport: { async profileFact() { extracted += 1; return { rawText: JSON.stringify({ facts: CANDIDATES }) }; } },
    saveFacts: async (request) => { saved = request; return { ok: true, added: request.facts.length, duplicates: [] }; },
  });

  const skipped = await recorder.record({ message: '帮我分析一下我的基金收益。', contextId: 'bill-1' });
  check('记录器：问题/请求不触发模型与落库', skipped.ok === false
    && skipped.code === 'E_PROFILE_FACT_NOT_EXPLICIT'
    && extracted === 0 && saved === null, JSON.stringify(skipped));

  const recorded = await recorder.record({ message: MESSAGE, contextId: 'bill-1' });
  check('记录器：明确陈述落库并带来源', recorded.ok === true && recorded.saved === true
    && extracted === 1
    && saved.facts.length === 2
    && saved.facts.every((fact) => fact.source === 'chat' && fact.source_ref === 'bill-1'), JSON.stringify(recorded));

  const noContext = await recorder.record({ message: MESSAGE });
  check('记录器：无账单上下文时不带 source_ref', noContext.ok === true
    && saved.facts.every((fact) => !('source_ref' in fact)), JSON.stringify(noContext));

  const extractionFailed = createProfileFactRecorder({
    transport: { async profileFact() { return { rawText: 'not-json' }; } },
    saveFacts: async () => { throw new Error('不应调用'); },
  });
  const failed = await extractionFailed.record({ message: MESSAGE });
  check('记录器：抽取失败时跳过落库', failed.ok === false && failed.code === 'E_PROFILE_FACT_RESPONSE' && failed.saved === false, JSON.stringify(failed));

  const saveFailed = createProfileFactRecorder({
    transport: { async profileFact() { return { rawText: JSON.stringify({ facts: CANDIDATES }) }; } },
    saveFacts: async () => { const error = new Error('db down'); error.code = 'E_DATA_STATUS'; throw error; },
  });
  const saveFailure = await saveFailed.record({ message: MESSAGE });
  check('记录器：落库失败不向上抛', saveFailure.ok === false
    && saveFailure.code === 'E_DATA_STATUS'
    && saveFailure.saved === false
    && saveFailure.facts.length === 2, JSON.stringify(saveFailure));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
