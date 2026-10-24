#!/usr/bin/env node
/**
 * 问题内断言数字：只核对用户问题里的收益/金额断言；日期与代码准确定位不算断言。
 * 运行：node tests/agent/qa-asserted-numbers.test.mjs
 */
import { findAssertedNumbers, checkAssertedNumbers } from '../../src/agent/assertedNumbers.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const PUBLISHED = ['-1.9%', '-8.0%', '-6.1pp', '¥-26,044.00', '¥428,482.00', '2025-12-30', '600519'];

/* ==== ① 与已发布事实一致：通过 ==== */
{
  const ok = checkAssertedNumbers('我实际亏了 1.9%，择时损耗 6.1 个百分点，对吧？', PUBLISHED);
  check('一致：亏损表述补负号后命中百分比与个百分点', ok.ok === true && ok.unknown.length === 0, JSON.stringify(ok));

  const wrongDirection = checkAssertedNumbers('我实际赚了 1.9%，对吧？', PUBLISHED);
  check('方向：赚 1.9% 与已发布 -1.9% 不一致，仍拦截', wrongDirection.ok === false
    && wrongDirection.unknown.length === 1, JSON.stringify(wrongDirection));

  const withMoney = checkAssertedNumbers('损耗金额是 ¥26044 吗？', PUBLISHED);
  check('一致：金额写法归一（¥26044 vs ¥-26,044.00 不同号，不正确）', withMoney.ok === false
    && withMoney.unknown.length === 1, JSON.stringify(withMoney));

  const negativeMoney = checkAssertedNumbers('损耗金额是 -26044 元吗？', PUBLISHED);
  check('一致：负号与千分位归一', negativeMoney.ok === true, JSON.stringify(negativeMoney));
}

/* ==== ② 不一致：拦截且保留原文供说明 ==== */
{
  const pct = checkAssertedNumbers('我上次赚了 99%，你确认一下', PUBLISHED);
  check('不一致：99% 被识别为未知断言', pct.ok === false
    && pct.unknown.length === 1 && pct.unknown[0].raw.includes('99'), JSON.stringify(pct));

  const chinese = checkAssertedNumbers('我上次赚了百分之七点五，对吧？', PUBLISHED);
  check('不一致：百分之七点五 归一为 7.5%', chinese.ok === false
    && chinese.asserted[0].variants.includes('7.5%'), JSON.stringify(chinese));

  const cheng = checkAssertedNumbers('我大概九成的操作都追高', PUBLISHED);
  check('不一致：九成 归一为 90%', cheng.ok === false
    && cheng.asserted[0].variants.includes('90%'), JSON.stringify(cheng));

  const money = checkAssertedNumbers('我赚了 40 万', PUBLISHED);
  check('不一致：万 换算为金额', money.ok === false
    && money.asserted[0].variants.includes('¥400000'), JSON.stringify(money));

  const points = checkAssertedNumbers('损耗大概是 5 个点', PUBLISHED);
  check('不一致：个点按百分数核对', points.ok === false
    && points.asserted[0].variants.includes('5%'), JSON.stringify(points));
}

/* ==== ③ 日期、代码、数量不作收益断言 ==== */
{
  const dated = checkAssertedNumbers('如果 2025-12-30 那笔 600519 卖出没发生会怎样？', PUBLISHED);
  check('定位：日期与六位代码不当作断言', dated.ok === true && dated.asserted.length === 0, JSON.stringify(dated));

  const quantity = checkAssertedNumbers('那笔 200 股的卖出呢？', PUBLISHED);
  check('定位：股数不当作收益断言', quantity.ok === true && quantity.asserted.length === 0, JSON.stringify(quantity));
}

/* ==== ③b 计划/偏好里的数字不是对已发生事实的断言 ==== */
{
  const plan = checkAssertedNumbers('我希望把仓位控制在五成以内，也不做短线交易。', PUBLISHED);
  check('计划：仓位“五成以内”不触发断言核对', plan.ok === true
    && plan.skipped === true && plan.asserted.length === 0, JSON.stringify(plan));

  const goal = checkAssertedNumbers('我打算以后亏损不超过 5%', PUBLISHED);
  check('计划：目标阈值不当作已发生收益', goal.ok === true && goal.skipped === true, JSON.stringify(goal));
}

/* ==== ④ 无已发布数字时：任何断言都无法核对 ==== */
{
  const empty = checkAssertedNumbers('我赚了 3.7%', []);
  check('无发布事实：断言视为未知，不默认通过', empty.ok === false && empty.unknown.length === 1, JSON.stringify(empty));

  const none = checkAssertedNumbers('我最错的一笔是哪个？', PUBLISHED);
  check('无断言：直接通过且不产生未知项', none.ok === true && none.asserted.length === 0 && none.unknown.length === 0, JSON.stringify(none));
}

/* ==== ⑤ 断言抽取：去重且不改写问题 ==== */
{
  const question = '我赚了 3.7%，又说 3.7%？';
  const found = findAssertedNumbers(question);
  check('抽取：同一数字只保留一次', found.length === 1 && question === '我赚了 3.7%，又说 3.7%？', JSON.stringify(found));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
