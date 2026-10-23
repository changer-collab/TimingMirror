// 对话画像信号：只有用户明确陈述的内容才进入画像；问题和请求不触发抽取。
// 服务端仍会校验证据是否为原文片段，这里的前置判断用于省掉无意义的模型调用。
export const PROFILE_FACT_KINDS = Object.freeze(['goal', 'preference', 'constraint', 'habit', 'risk_tolerance']);

const FIRST_PERSON_RE = /(我|本人|自己)/u;
const DECLARATIVE_RE = /(我希望|我想要|我的目标|我计划|我打算|我准备|我一般|我通常|我习惯|我总是|我从不|我不碰|我不能接受|我只做|我最多|我可以承受|我能承受|我偏好|我喜欢|我更倾向|我要求|我给自己|目标是|希望|计划|打算)/u;
const REQUEST_RE = /(帮我|告诉我|请(?:你)?|你能|你可以|给我|分析一下|解释一下|说说)/u;
const FINANCE_RE = /(投资|交易|股票|基金|仓位|回撤|风险|收益|亏损|止损|止盈|持有|买入|卖出|理财|资金|纪律|长期|短期|目标|计划|赚|亏)/u;
const QUESTION_RE = /[？?]\s*$/u;
const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export function shouldExtractProfileFacts(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text.length < 6 || text.length > 1200) return false;
  if (!FINANCE_RE.test(text)) return false;
  if (!FIRST_PERSON_RE.test(text)) return false;
  if (REQUEST_RE.test(text)) return false;
  if (QUESTION_RE.test(text)) return false;
  return DECLARATIVE_RE.test(text);
}

function bounded(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || CONTROL_RE.test(text) || [...text].length > max) return null;
  return text;
}

export function normalizeFactCandidates(rawFacts, message) {
  if (!Array.isArray(rawFacts)) return [];
  const source = typeof message === 'string' ? message : '';
  const seen = new Set();
  const facts = [];
  for (const item of rawFacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!PROFILE_FACT_KINDS.includes(item.kind)) continue;
    if (typeof item.key !== 'string' || !SLUG_RE.test(item.key)) continue;
    const value = bounded(item.value, 240);
    const evidence = bounded(item.evidence, 120);
    if (!value || !evidence || !source.includes(evidence)) continue;
    const dedupe = `${item.kind}\n${item.key}\n${value}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    facts.push({ kind: item.kind, key: item.key, value, evidence });
    if (facts.length >= 3) break;
  }
  return facts;
}

function parseFacts(result) {
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result.facts)) return result.facts;
  if (typeof result.rawText !== 'string') return null;
  try {
    const parsed = JSON.parse(result.rawText);
    return Array.isArray(parsed?.facts) ? parsed.facts : null;
  } catch {
    return null;
  }
}

export async function extractProfileFacts({ transport, message, signal } = {}) {
  if (typeof transport?.profileFact !== 'function') {
    return { ok: false, code: 'E_PROFILE_FACT_UNAVAILABLE', facts: [] };
  }
  try {
    const result = await transport.profileFact({ message, signal });
    const rawFacts = parseFacts(result);
    if (!rawFacts) return { ok: false, code: 'E_PROFILE_FACT_RESPONSE', facts: [] };
    return { ok: true, facts: normalizeFactCandidates(rawFacts, message) };
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_PROFILE_FACT_UNAVAILABLE', facts: [] };
  }
}

// 抽取与保存分开：先由用户授权发送并查看候选，再单独确认保存。
export function createProfileFactRecorder({ transport = null, saveFacts = null } = {}) {
  if (typeof saveFacts !== 'function') return null;
  return Object.freeze({
    async extract({ message, signal } = {}) {
      return extractProfileFacts({ transport, message, signal });
    },
    async save({ facts, contextId = null, signal } = {}) {
      if (!Array.isArray(facts) || facts.length === 0) {
        return { ok: false, code: 'E_PROFILE_FACT_EMPTY', facts: [], saved: false };
      }
      const prepared = facts.map((fact) => ({
        kind: fact.kind,
        key: fact.key,
        value: fact.value,
        evidence: fact.evidence,
        source: 'chat',
        ...(contextId ? { source_ref: contextId } : {}),
      }));
      try {
        const result = await saveFacts({ facts: prepared, signal });
        return { ok: true, facts: prepared, saved: true, result };
      } catch (error) {
        return { ok: false, code: error?.code ?? 'E_PROFILE_FACT_SAVE_FAILED', facts: prepared, saved: false };
      }
    },
  });
}
