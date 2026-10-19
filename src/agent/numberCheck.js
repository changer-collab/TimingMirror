// M1-C10 离线段 · 回答数字子集校验器（确定性纯函数；接口候选，未冻结）
// 目的：回答文本中的可识别数字必须能匹配允许事实 JSON（factExport 输出）的 value / display 与 unit。
// 数字识别范围（候选）：¥金额（如 ¥1,000.00 / ¥-400.00）、±x.x%、±x.xpp、数值+单位（元 / 股 / 手 / 份）。
//   · 先对全角/异体符号做等长归一（０-９ ％ ＋ － − ￥ ． ，）；匹配用归一形式，命中/失败项 raw 保留原字符；
//   · `%、pp、¥` 类与引擎 display 精确字符串匹配（不换算、不舍入、不自动改数）；
//   · 数值+单位类与 fact 的 value（精确相等）与 unit（包含该单位字）匹配；
//   · 裸数字与“笔/次/天/行”等非金融频次不纳入识别（防止把年份、计数误判为事实数字；此为候选语义）。
// 规则：blocked / insufficient_evidence 事实集（status != ok）不得用于校验；失败须逐项给出数字与原因；
//   失败项含 suspected_blocked_fact：null＝调用方未提供本地被阻断数字清单（无法判定）、true/false＝按 blockedDisplays 判定；
//   blockedDisplays 仅用于本地校验，不随出站事实 JSON 发送（出站不含未通过复核的数字）；纯文字回答通过；不联网、不调用模型、不修改输入。
export const NUMBER_CHECK_CODES = Object.freeze({
  INPUT_INVALID: 'E_NUMCHECK_INPUT_INVALID',
  NOT_IN_FACTS: 'E_NUMCHECK_NOT_IN_FACTS',
});

const MONEY_PATTERN = '[+-]?¥[+-]?\\d[\\d,]*(?:\\.\\d+)?';
const PCT_PATTERN = '[+-]?\\d+(?:\\.\\d+)?%';
const PP_PATTERN = '[+-]?\\d+(?:\\.\\d+)?pp';
const MONEY_RE = new RegExp(MONEY_PATTERN, 'g');
const PCT_RE = new RegExp(PCT_PATTERN, 'g');
const PP_RE = new RegExp(PP_PATTERN, 'gi');
const UNIT_RE = /[+-]?\d[\d,]*(?:\.\d+)?\s?(元|股|手|份)/g;
const UNIT_PARSE_RE = /^([+-]?\d[\d,]*(?:\.\d+)?)\s?(元|股|手|份)$/;
const DISPLAY_EXACT_RES = Object.freeze([
  new RegExp(`^(?:${MONEY_PATTERN})$`),
  new RegExp(`^(?:${PCT_PATTERN})$`),
  new RegExp(`^(?:${PP_PATTERN})$`, 'i'),
]);
const MAX_DISPLAY_LENGTH = 64;

/* 全角/异体符号 → ASCII 等长映射（1 字符 ↔ 1 字符：归一文本与原文同长，可按索引取回原文片段） */
const CANON_MAP = Object.freeze((() => {
  const m = { '％': '%', '＋': '+', '－': '-', '−': '-', '￥': '¥', '．': '.', '，': ',' };
  for (let d = 0; d < 10; d++) m[String.fromCharCode(0xff10 + d)] = String(d);
  return m;
})());
const CANON_RE = /[％＋－−￥．，０-９]/g;

function canonText(text) {
  return text.replace(CANON_RE, (ch) => CANON_MAP[ch]);
}

function collect(text, canon, re, type, out) {
  for (const m of canon.matchAll(re)) out.push({ raw: text.slice(m.index, m.index + m[0].length), cmp: m[0], type });
}

function normalizeNumber(raw) {
  const n = Number(String(raw).replace(/[,＋+\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/* 出站 display 内容契约：复用下面的百分比/pp/人民币展示语法，要求整串匹配且长度受限。 */
export function isSupportedDisplay(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DISPLAY_LENGTH) return false;
  const canon = canonText(value);
  if (canon !== canon.trim()) return false;
  return DISPLAY_EXACT_RES.some((re) => re.test(canon));
}

/**
 * 校验回答文本中的可识别数字是否都在允许事实内（候选接口）。
 * @param {string} answerText 待校验的回答文本
 * @param {object} factExport exportFacts 的输出（要求 status === 'ok'）
 * @param {object} [options]
 * @param {Array|null} [options.blockedDisplays] 本地被阻断数字的 display 原文清单（仅本地传入，不随出站 JSON；未提供时 suspected_blocked_fact=null）
 * @returns {{ ok: boolean, checked: number, matched: Array, failed: Array, diagnostics: Array }} failed[].suspected_blocked_fact: true|false|null
 */
export function checkNumbers(answerText, factExport, { blockedDisplays = null } = {}) {
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
  const blockedSet = Array.isArray(blockedDisplays) ? new Set(blockedDisplays.map((d) => canonText(String(d)))) : null;
  const suspected = (cmp) => (blockedSet === null ? null : blockedSet.has(cmp));

  const canon = canonText(answerText); // 与 answerText 等长，可按索引取回原文
  const tokens = [];
  collect(answerText, canon, MONEY_RE, 'money', tokens);
  collect(answerText, canon, PCT_RE, 'pct', tokens);
  collect(answerText, canon, PP_RE, 'pp', tokens);
  collect(answerText, canon, UNIT_RE, 'unit', tokens);
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (seen.has(t.cmp)) continue;
    seen.add(t.cmp);
    unique.push(t);
  }
  out.checked = unique.length;

  for (const t of unique) {
    if (t.type === 'money' || t.type === 'pct' || t.type === 'pp') {
      if (displays.has(t.cmp)) {
        out.matched.push({ raw: t.raw, fact_ref: facts.find((f) => String(f.display) === t.cmp).fact_ref });
      } else {
        out.failed.push({
          raw: t.raw,
          code: NUMBER_CHECK_CODES.NOT_IN_FACTS,
          reason: `显示值「${t.raw}」不在允许事实的 display 集：不换算、不舍入、不自动改写数字`,
          suspected_blocked_fact: suspected(t.cmp),
        });
      }
      continue;
    }
    // 数值 + 单位（元/股/手/份）
    const m = t.cmp.match(UNIT_PARSE_RE);
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
        suspected_blocked_fact: suspected(t.cmp),
      });
    }
  }

  out.ok = out.failed.length === 0;
  return out;
}
