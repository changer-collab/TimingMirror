#!/usr/bin/env node
/**
 * M1-C10 离线段 · 回答数字子集校验器 —— 离线单测（合成数据；零依赖）
 *
 * 覆盖：合法 display/数值+单位通过；不存在的数字失败；blocked/insufficient_evidence 数字不能通过；
 *       无数字回答通过；裸数字/非金融频次不纳入（候选语义）；不换算不舍入；
 *       失败含数字与原因；输入非法失败状态；重复数字去重；不修改输入；重复校验确定性。
 * 边界：纯函数测试；通过仅证明校验器语义与单测一致，不证明在线链路或产品端到端验收通过。
 * 运行：node tests/agent/number-check.test.mjs（或 npm run check）
 */
import { runReview } from '../../src/agent/reviewPipeline.js';
import { exportFacts } from '../../src/agent/factExport.js';
import { checkNumbers, NUMBER_CHECK_CODES } from '../../src/agent/numberCheck.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const VAL = { requested_date: '2024-10-11', effective_date: '2024-10-11' };
const mk = (id, date, symbol, side, price, quantity, src = true) => ({
  trade_id: id, trade_date: date, symbol, side, price, quantity,
  fee: 0, tax: 0, fee_missing: false, tax_missing: false,
  ...(src ? { source: { file: 'mini.csv', line: 2 } } : {}),
});
const A_CLEAN = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100), mk('T002', '2024-09-27', '000000', 'sell', 11, 100)];
const A_DIRTY = () => [mk('T001', '2024-09-24', '000000', 'buy', 10, 100, false), mk('T002', '2024-09-27', '000000', 'sell', 11, 100, false)];
const B_CLEAN = () => [mk('B101', '2024-09-25', '888888', 'buy', 100, 10), mk('B102', '2024-09-30', '888888', 'sell', 105, 10)];

const pub = exportFacts({ review: runReview({ trades: A_CLEAN(), closes: { '000000': 12 }, valuation: VAL }) });
const full = exportFacts({ review: runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12, '888888': 110 }, valuation: VAL }) });
const degraded = exportFacts({ review: runReview({ trades: [...A_CLEAN(), ...B_CLEAN()], closes: { '000000': 12 }, valuation: VAL }) });
const blockedEx = exportFacts({ review: runReview({ trades: A_DIRTY(), closes: { '000000': 12 } }) });

/* ==== ⑦ 合法 display / 数值+单位 通过 ==== */
{
  const r = checkNumbers('实际收益 +10.0%，对照收益 +20.0%，择时损耗 +10.0pp，损耗金额 ¥100.00。', pub);
  check('合法：四个 display 数字全部通过（checked=4）', r.ok === true && r.checked === 4 && r.matched.length === 4 && r.failed.length === 0, JSON.stringify(r));
  const r2 = checkNumbers('买入成本 1,000 元，期末持仓 0 股。', pub);
  check('合法：数值+单位（1,000 元 / 0 股）通过', r2.ok === true && r2.checked === 2, JSON.stringify(r2));
  const r3 = checkNumbers('复述：+10.0% 与 +10.0% 一致。', pub);
  check('合法：重复数字去重（同值只计 1）', r3.ok === true && r3.checked === 1, JSON.stringify(r3));
}

/* ==== ⑧ 不存在的数字 → 失败（含数字与原因） ==== */
{
  const r = checkNumbers('收益率达到了 +99.9%。', pub);
  check('失败：+99.9% 不在允许事实 → ok=false + 原因', r.ok === false && r.failed.length === 1 && r.failed[0].raw === '+99.9%' && r.failed[0].code === NUMBER_CHECK_CODES.NOT_IN_FACTS && typeof r.failed[0].reason === 'string', JSON.stringify(r.failed));
  const r2 = checkNumbers('金额约 ¥999.00。', pub);
  check('失败：¥999.00 不在允许事实 → 失败', r2.ok === false && r2.failed[0].raw === '¥999.00', JSON.stringify(r2.failed));
  const mixed = checkNumbers('实际收益 +10.0%，另有人说是 +99.9%。', pub);
  check('混合：合法 1 项 matched、非法 1 项 failed', mixed.ok === false && mixed.matched.length === 1 && mixed.failed.length === 1, JSON.stringify(mixed));
}

/* ==== ⑨ blocked / insufficient_evidence 数字不能通过 ==== */
{
  const fullHasB = JSON.stringify(full).includes('+5.0%');
  const degradedHasB = JSON.stringify(degraded).includes('+5.0%');
  check('前提核对：+5.0% 是 888888 的真实 display（全量含、缺价降级后不含）', fullHasB === true && degradedHasB === false);
  const r = checkNumbers('该标的的实际收益为 +5.0%。', degraded);
  check('阻断：未发布（888888 缺价）的 display 数字不能通过校验', r.ok === false && r.failed.some((f) => f.raw === '+5.0%'), JSON.stringify(r.failed));
  const r2 = checkNumbers('+10.0%', blockedEx);
  check('阻断：blocked 状态的事实集不得用于校验（输入非法）', r2.ok === false && r2.diagnostics.some((d) => d.code === NUMBER_CHECK_CODES.INPUT_INVALID), JSON.stringify(r2.diagnostics));
}

/* ==== ⑩ 无数字回答通过 + 裸数字/频次不纳入（候选语义） ==== */
{
  const r = checkNumbers('本次结论仅基于已通过复核的事实，未通过的不发布。', pub);
  check('无数字：纯文字回答通过（checked=0）', r.ok === true && r.checked === 0 && r.failed.length === 0);
  const r2 = checkNumbers('共 2 笔，2024 年 9 月，第 3 条记录。', pub);
  check('候选语义：裸数字/年份/计数不纳入识别（checked=0 且通过）', r2.ok === true && r2.checked === 0, JSON.stringify(r2));
}

/* ==== 不换算、不舍入 ==== */
{
  const r = checkNumbers('金额 ¥100。', pub);
  check('不换算：¥100（缺小数位）不匹配 ¥100.00 → 失败', r.ok === false && r.failed[0].raw === '¥100', JSON.stringify(r.failed));
  const r2 = checkNumbers('收益率 10%。', pub);
  check('不舍入：10%（缺符号与小数）不匹配 +10.0% → 失败', r2.ok === false && r2.failed[0].raw === '10%', JSON.stringify(r2.failed));
}

/* ==== 输入非法明确失败状态 ==== */
{
  const r1 = checkNumbers(123, pub);
  const r2 = checkNumbers('+10.0%', { status: 'unsupported', facts: [] });
  const r3 = checkNumbers('+10.0%', null);
  check('非法输入：answerText 非字符串 → INPUT_INVALID', r1.ok === false && r1.diagnostics.some((d) => d.code === NUMBER_CHECK_CODES.INPUT_INVALID));
  check('非法输入：factExport 非 ok 状态 → INPUT_INVALID', r2.ok === false && r2.diagnostics.some((d) => d.code === NUMBER_CHECK_CODES.INPUT_INVALID));
  check('非法输入：factExport 为 null → INPUT_INVALID', r3.ok === false && r3.diagnostics.some((d) => d.code === NUMBER_CHECK_CODES.INPUT_INVALID));
}

/* ==== 不修改输入 + 重复校验确定性 ==== */
{
  const text = '实际收益 +10.0%，损耗 ¥100.00。';
  const textBefore = String(text);
  const factsBefore = JSON.stringify(pub);
  const r1 = checkNumbers(text, pub);
  const r2 = checkNumbers(text, pub);
  check('纯净：不修改输入（文本与事实集原样）', String(text) === textBefore && JSON.stringify(pub) === factsBefore);
  check('确定性：两次校验结果完全一致', JSON.stringify(r1) === JSON.stringify(r2) && r1.ok === true && r1.checked === 2);
}

/* —— 输出 —— */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
