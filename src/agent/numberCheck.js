// M1-C10 离线段 · 回答数字子集校验器（确定性纯函数；接口候选，未冻结）
// 目的：回答文本中的可识别数字必须能匹配允许事实 JSON（factExport 输出）的 value / display 与 unit。
// 数字识别范围（候选）：¥金额（如 ¥1,000.00 / ¥-400.00）、±x.x%、±x.xpp、数值+单位（元 / 股 / 手 / 份）。
//   · `%、pp、¥` 类与引擎 display 精确字符串匹配（不换算、不舍入、不自动改数）；
//   · 数值+单位类与 fact 的 value（精确相等）与 unit（包含该单位字）匹配；
//   · 裸数字与“笔/次/天/行”等非金融频次不纳入识别（防止把年份、计数误判为事实数字；此为候选语义）。
// 规则：blocked / insufficient_evidence 事实集（status != ok）不得用于校验；失败须逐项给出数字与原因；
//   纯文字（无数字）回答通过；不联网、不调用模型、不修改输入。
export const NUMBER_CHECK_CODES = Object.freeze({
  INPUT_INVALID: 'E_NUMCHECK_INPUT_INVALID',
  NOT_IN_FACTS: 'E_NUMCHECK_NOT_IN_FACTS',
});

const MONEY_RE = /[+-]?¥[+-]?\d[\d,]*(?:\.\d+)?/g;
const PCT_RE = /[+-]?\d+(?:\.\d+)?%/g;
const PP_RE = /[+-]?\d+(?:\.\d+)?pp/gi;
const UNIT_RE = /[+-]?\d[\d,]*(?:\.\d+)?\s?(元|股|手|份)/g;

function collect(text, re, type, out) {
  for (const m of text.matchAll(re)) out.push({ raw: m[0], type });
}

function normalizeNumber(raw) {
  const n = Number(String(raw).replace(/[,＋+\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 校验回答文本中的可识别数字是否都在允许事实内（候选接口）。
 * @param {string} answerText 待校验的回答文本
 * @param {object} factExport exportFacts 的输出（要求 status === 'ok'）
 * @returns {{ ok: boolean, checked: number, matched: Array, failed: Array, diagnostics: Array }}
 */
export function checkNumbers(answerText, factExport) {
  const diagnostics = [];
  const out = { ok: false, checked: 0, matched: [], failed: [], diagnostics };

  if (typeof answerText !== 'string'
    || factExport === null || typeof factExport !== 'object'
    || factExport.status !== 'ok' || !Array.isArray(factExport.facts)) {
    diagnostics.push({
      code: NUMBER_CHECK_CODES.INPUT_INVALID,
      message: '入参非法：answerText 须为字符串；factExport 须为 status=ok 的事实 JSON（blocked / unsupported 事实集不得用于校验）',
    });
    return out;
  }

  const facts = factExport.facts;
  const displays = new Set(facts.map((f) => String(f.display)));

  const tokens = [];
  collect(answerText, MONEY_RE, 'money', tokens);
  collect(answerText, PCT_RE, 'pct', tokens);
  collect(answerText, PP_RE, 'pp', tokens);
  collect(answerText, UNIT_RE, 'unit', tokens);
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (seen.has(t.raw)) continue;
    seen.add(t.raw);
    unique.push(t);
  }
  out.checked = unique.length;

  for (const t of unique) {
    if (t.type === 'money' || t.type === 'pct' || t.type === 'pp') {
      if (displays.has(t.raw)) {
        out.matched.push({ raw: t.raw, fact_ref: facts.find((f) => String(f.display) === t.raw).fact_ref });
      } else {
        out.failed.push({
          raw: t.raw,
          code: NUMBER_CHECK_CODES.NOT_IN_FACTS,
          reason: `显示值「${t.raw}」不在允许事实的 display 集：不换算、不舍入、不自动改写数字`,
        });
      }
      continue;
    }
    // 数值 + 单位（元/股/手/份）
    const m = t.raw.match(/^([+-]?\d[\d,]*(?:\.\d+)?)\s?(元|股|手|份)$/);
    const num = normalizeNumber(m[1]);
    const unit = m[2];
    const hit = facts.find((f) => Number.isFinite(f.value) && f.value === num && String(f.unit ?? '').includes(unit));
    if (hit) {
      out.matched.push({ raw: t.raw, fact_ref: hit.fact_ref });
    } else {
      out.failed.push({
        raw: t.raw,
        code: NUMBER_CHECK_CODES.NOT_IN_FACTS,
        reason: `数值+单位「${t.raw}」未匹配到任何允许事实的 value/unit（不自行换算单位）`,
      });
    }
  }

  out.ok = out.failed.length === 0;
  return out;
}
