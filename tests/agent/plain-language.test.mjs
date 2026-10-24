#!/usr/bin/env node
/**
 * 白话三层（plainLanguage）—— 纯函数单测，不联网、不调用模型。
 *
 * 覆盖：headline 8–45 字；plain 1–3 条、单条 10–100 字、总计 40–300 字；
 *       只重排已有句子、不新增数字；术语来自 glossary；示例与云端边界不同。
 * 运行：node tests/agent/plain-language.test.mjs（或 npm run check）
 */
import {
  HEADLINE_MAX_CHARS,
  HEADLINE_MIN_CHARS,
  PLAIN_ITEM_MAX_CHARS,
  PLAIN_MAX_ITEMS,
  PLAIN_TOTAL_MAX_CHARS,
  buildPlainDraft,
  charLength,
  clipChars,
  fitHeadline,
} from '../../src/agent/plainLanguage.js';
import { glossaryEntry } from '../../src/agent/glossary.js';

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

const TEXT = '这笔交易的差额是 -¥1,200.00，来自卖出前后的价差对照。'
  + '它只说明这次操作的结果，不涉及对其他交易的判断。'
  + '如需复核，可以在报告页展开证据。';
const FACTS = [{ label: '差额', value: '-¥1,200.00' }];

/* ==== ① 三层结构与长度 ==== */
{
  const draft = buildPlainDraft({ intent: 'worst_trade', text: TEXT, facts: FACTS });
  const headlineLength = charLength(draft.headline);
  const itemLengths = draft.plain.map((item) => charLength(item.text));
  const total = itemLengths.reduce((sum, value) => sum + value, 0);

  check('三层：headline 在 8–45 字之间', headlineLength >= HEADLINE_MIN_CHARS
    && headlineLength <= HEADLINE_MAX_CHARS, `${headlineLength} ${draft.headline}`);
  check('三层：plain 1–3 条且单条 10–100 字', draft.plain.length >= 1
    && draft.plain.length <= PLAIN_MAX_ITEMS
    && itemLengths.every((value) => value >= 10 && value <= PLAIN_ITEM_MAX_CHARS), JSON.stringify(itemLengths));
  check('三层：plain 总长 40–300 字', total >= 40 && total <= PLAIN_TOTAL_MAX_CHARS, String(total));
  check('三层：meets_limits 与逐项长度一致', draft.meets_limits === true, JSON.stringify(draft));
  check('三层：plain 编号稳定', draft.plain.every((item, index) => item.id === `P${index + 1}`));
  check('三层：只重排已有句子，不新增数字', draft.plain.every((item) => TEXT.includes(item.text))
    && !/\d/u.test(draft.headline.replace(/¥?[\d,]+(?:\.\d+)?/gu, '')), JSON.stringify(draft.plain));
}

/* ==== ② headline 生成与截断 ==== */
{
  check('headline：意图标题带首条事实', fitHeadline('worst_trade', '差额 -¥1,200.00').startsWith('最错的一笔：'));
  const longDetail = '很长的说明'.repeat(20);
  const clipped = fitHeadline('loss_overview', longDetail);
  check('headline：超长被裁剪到上限', charLength(clipped) <= HEADLINE_MAX_CHARS, clipped);
  check('clipChars：按字符计数不截断代理对', clipChars('😀😀😀', 2) === '😀😀');
  check('clipChars：未超长原样返回', clipChars('差额', 10) === '差额');
}

/* ==== ③ 事实兜底、术语与边界 ==== */
{
  const noText = buildPlainDraft({ intent: 'best_trade', text: '', facts: FACTS });
  check('兜底：没有句子时用首条事实', noText.plain.length === 1
    && noText.plain[0].text.includes('-¥1,200.00'), JSON.stringify(noText.plain));
  check('兜底：meets_limits 如实为 false', noText.meets_limits === false, JSON.stringify(noText));

  const withTerm = buildPlainDraft({ intent: 'loss_overview', text: '这里的择时损耗是 -¥1,200.00。', facts: FACTS });
  const entry = glossaryEntry('择时损耗');
  check('术语：出现在文本中即登记并附定义', withTerm.terms.length === 1
    && withTerm.terms[0].term === '择时损耗'
    && withTerm.terms[0].definition === entry.definition, JSON.stringify(withTerm.terms));

  const cloud = buildPlainDraft({ intent: 'worst_trade', text: TEXT, facts: FACTS });
  const demo = buildPlainDraft({ intent: 'worst_trade', text: TEXT, facts: FACTS, demo: true });
  check('边界：云端提示已发布数字且不预测', cloud.boundaries.join('|') === '只使用当前账单已核对并发布的数字|事后对照，不预测涨跌');
  check('边界：示例提示非真实账户', demo.boundaries.join('|') === '示例数据，不是真实账户|事后对照，不预测涨跌');
  const custom = buildPlainDraft({ intent: 'worst_trade', text: TEXT, facts: FACTS, boundaries: [' 自定义边界 ', ''] });
  check('边界：显式边界优先并去空白', custom.boundaries.join('|') === '自定义边界', JSON.stringify(custom.boundaries));
}

/* ==== ④ 禁止建议/预测措辞只由上层校验，草稿不引入 ==== */
{
  const draft = buildPlainDraft({ intent: 'worst_trade', text: TEXT, facts: FACTS });
  const joined = [draft.headline, ...draft.plain.map((item) => item.text)].join(' ');
  check('草稿：不出现建议或预测措辞', !/(建议|推荐)(买入|卖出|加仓|减仓)/u.test(joined)
    && !/(预测|预计)后市/u.test(joined), joined);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + r.detail}`);
console.log(`\n== 合计 ${results.length} 项检查：通过 ${results.length - failed.length}，失败 ${failed.length} ==`);
process.exit(failed.length ? 1 : 0);
