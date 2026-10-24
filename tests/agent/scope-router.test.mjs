#!/usr/bin/env node
/**
 * 问答范围判断 —— 离线单测（纯函数；不读取账单、不调用模型/网络）
 *
 * 覆盖：六类范围、荐股/预测先于概念解释、示例账单标记、账单数量、
 *       无术语线索时留在账单范围。
 * 运行：node tests/agent/scope-router.test.mjs（或 npm run check）
 */
import {
  routeScope,
  isRefusalQuestion,
  SCOPE_KINDS,
  SCOPE_LABELS,
} from '../../src/agent/scopeRouter.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const BILL = { status: 'confirmed', sourceType: 'local', contextId: 'bill-scope-1' };

/* ==== ① 六类范围代表问法 ==== */
{
  const cases = [
    ['我最错的一笔是哪个？', 'bill'],
    ['原始 CSV 会上传吗？', 'product_help'],
    ['什么是择时损耗？', 'general_finance'],
    ['你好', 'small_talk'],
    ['明天买什么？', 'refusal'],
    ['帮我写代码', 'unrelated'],
  ];
  for (const [question, kind] of cases) {
    const scope = routeScope({ question, bill: BILL });
    check(`范围：${question} → ${kind}`, scope.kind === kind, JSON.stringify(scope));
  }
  check('范围类别：六类都有中文短标签',
    SCOPE_KINDS.length === 6 && SCOPE_KINDS.every((kind) => typeof SCOPE_LABELS[kind] === 'string' && SCOPE_LABELS[kind].length > 0),
    JSON.stringify(SCOPE_LABELS));
}

/* ==== ② 优先级：越界先于术语解释，术语线索必需 ==== */
{
  check('优先：越界请求先于术语解释', routeScope({ question: '什么是估值日？顺便推荐一只股票', bill: BILL }).kind === 'refusal');
  check('优先：预测类问法直接拒绝', isRefusalQuestion('明天会涨吗？') && isRefusalQuestion('帮我抄底') && !isRefusalQuestion('这些数可信吗？'));
  check('术语：有线索才解释', routeScope({ question: '择时损耗是什么意思？', bill: BILL }).kind === 'general_finance'
    && routeScope({ question: '解释一下反事实', bill: BILL }).kind === 'general_finance');
  check('术语：只出现术语没有解释线索时留在账单范围', routeScope({ question: '择时损耗', bill: BILL }).kind === 'bill');
  check('术语：未收录的词不当概念解释', routeScope({ question: '什么是市盈率？', bill: BILL }).kind === 'bill');
}

/* ==== ③ 空问题、示例账单与账单数量 ==== */
{
  const empty = routeScope({ question: '   ', bill: BILL });
  check('空问题：留在账单范围，交给空问题守卫', empty.kind === 'bill' && empty.bill_count === 1, JSON.stringify(empty));
  const demo = routeScope({ question: '我最错的一笔是哪个？', bill: { ...BILL, demo: true } });
  check('示例账单：synthetic 标记为 true', demo.kind === 'bill' && demo.synthetic === true, JSON.stringify(demo));
  const cloud = routeScope({ question: '我最错的一笔是哪个？', bill: BILL });
  check('云端账单：synthetic 为 false', cloud.synthetic === false && cloud.bill_count === 1, JSON.stringify(cloud));
  const multi = routeScope({ question: '跨账单看看', bill: BILL, billCount: 4 });
  check('账单数量：显式数量优先，跨账单仍是账单范围', multi.kind === 'bill' && multi.bill_count === 4, JSON.stringify(multi));
  const none = routeScope({ question: '跨账单看看', bill: null });
  check('无账单：bill_count 为 0', none.bill_count === 0, JSON.stringify(none));
}

/* ==== ④ 纯函数边界：不读取账单明细 ==== */
{
  const trap = {
    contextId: 'bill-trap',
    get trades() { throw new Error('范围判断不应读取成交'); },
    get sourceType() { throw new Error('范围判断不应读取来源'); },
  };
  const scope = routeScope({ question: '我最错的一笔是哪个？', bill: trap });
  check('纯函数：只读取 demo 标记，不触碰成交/来源', scope.kind === 'bill' && scope.bill_count === 1, JSON.stringify(scope));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
