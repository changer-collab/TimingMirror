#!/usr/bin/env node
/**
 * M1-C11 契约匹配纯函数（src/engine/contractMatch.js）—— 产品侧单元测试 v1
 *
 * 定位：模板解析＋字段归一化（'3'≡3、非法字段明确报错不静默套默认）＋自由文本明确不支持（F-5.3）、
 *       内容哈希确定性（R4：同内容同哈希、改参数换哈希、存储往返后哈希一致且仍触发）、
 *       涨跌幅读取（dayChangePct：不复权 B2/非交易日 B3/范围外与缺价不补造 R2/B4）、
 *       命中/未命中/缺失行情三态与边界（恰等阈值不触发——“超过”为严格大于；追回窗口 distance ≤ N）。
 * 边界：契约状态机/版本号/持久化为状态层（吴涵晶）；预设案例与用户操作共用本判定链路（F-9.3，纯函数保证）。
 * 运行：node tests/contract-match.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONTRACT_TEMPLATES, CONTRACT_CODES, HASH_ALGORITHM, parseContract, dayChangePct, matchContract } from '../src/engine/contractMatch.js';
import { createMarketCache, fromFixtures, MARKET_CACHE_CODES } from '../src/engine/marketCache.js';
import { parseCsvText, normalizeRows } from '../src/engine/csvNormalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const load = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const readText = (rel) => readFileSync(join(REPO, rel), 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
const eqArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const market = createMarketCache(fromFixtures(load('m0/market-cache/fixtures/mock-calendar.json'), load('m0/market-cache/fixtures/mock-daily-bars.json')));
const demoTrades = normalizeRows(parseCsvText(readText('m0/csv-input/fixtures/demo-bill.csv')), 'demo-bill.csv').trades;

/* ---- 模板注册表 ---- */
{
  check('注册表：2 个模板（涨幅阈值 / 卖出后追回），且已冻结', Object.keys(CONTRACT_TEMPLATES).length === 2 && eqArr(Object.keys(CONTRACT_TEMPLATES), ['no_buy_on_surge', 'no_buy_back_within']) && Object.isFrozen(CONTRACT_TEMPLATES) && Object.isFrozen(CONTRACT_TEMPLATES.no_buy_on_surge.fields), '');
  check('注册表：哈希算法为占位标注（待 M0 §4-7 冻结后替换）', HASH_ALGORITHM === 'fnv1a64-placeholder', HASH_ALGORITHM);
}

/* ---- 解析与归一化（模板＋可编辑字段；保存前展示解析结果） ---- */
{
  const p = parseContract({ template_id: 'no_buy_on_surge' });
  check('解析：默认字段 → 阈值 5%（0.05）、文本渲染“超过 5%”', p.supported === true && near(p.threshold.value, 0.05) && p.threshold.display === '5.0%' && p.text === '当天涨幅超过 5% 的票，我绝不买入。', JSON.stringify(p.threshold));
  check('解析：条件含比较符（严格大于——“超过”不含恰等）', p.condition.kind === 'change_pct_threshold' && p.condition.comparator === '>' && near(p.condition.threshold, 0.05), JSON.stringify(p.condition));
  check('解析：哈希为 16 位十六进制且算法名随结果返回', /^[0-9a-f]{16}$/.test(p.hash) && p.hash_algorithm === HASH_ALGORITHM, p.hash);
  check('解析：canonical 键序固定（schema→template_id→kind→comparator→threshold→window_days→text）', eqArr(Object.keys(p.canonical), ['schema', 'template_id', 'kind', 'comparator', 'threshold', 'window_days', 'text']), JSON.stringify(Object.keys(p.canonical)));

  const pStr = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: '3' } });
  const pNum = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  check('归一化：字符串 "3" ≡ 数字 3（同哈希、同阈值 0.03、同文本）', near(pStr.threshold.value, 0.03) && pStr.hash === pNum.hash && pStr.text === pNum.text && pStr.text === '当天涨幅超过 3% 的票，我绝不买入。', `${pStr.hash}/${pNum.hash}`);

  const pB = parseContract({ template_id: 'no_buy_back_within' });
  check('解析：追回模板默认 3 个交易日，阈值单位 = trading_days', pB.supported === true && pB.condition.window_days === 3 && pB.threshold.unit === 'trading_days' && pB.threshold.display === '3 个交易日' && pB.text === '卖出后 3 个交易日内不追回同一只票。', JSON.stringify(pB.threshold));
  const pB7 = parseContract({ template_id: 'no_buy_back_within', fields: { days: '7' } });
  check('解析：追回模板字段可编辑（7 个交易日）且哈希随参数变化', pB7.condition.window_days === 7 && pB7.hash !== pB.hash, pB7.hash);
}

/* ---- 自由文本与字段错误：不猜测、不静默套默认（F-5.3） ---- */
{
  const free = parseContract({ text: '低买高卖，见好就收。' });
  check('自由文本：明确不支持（不猜测语义、不套默认阈值）', free.supported === false && free.code === CONTRACT_CODES.UNSUPPORTED_TEXT && free.message.includes('不猜测') && free.message.includes('不静默'), free.message);
  check('自由文本：无 template_id 同样明确提示', parseContract().code === CONTRACT_CODES.UNSUPPORTED_TEXT && parseContract().supported === false, '');
  const unknown = parseContract({ template_id: 'freeform_rule', fields: {} });
  check('未知模板：明确报错并列出可选模板', unknown.supported === false && unknown.code === CONTRACT_CODES.TEMPLATE_UNKNOWN && unknown.message.includes('no_buy_on_surge'), unknown.message);
  const typo = parseContract({ template_id: 'no_buy_on_surge', fields: { thershold_pct: 3 } });
  check('未知字段（拼写错误）：报错而非静默套默认值', typo.supported === false && typo.code === CONTRACT_CODES.FIELD_UNKNOWN && typo.field === 'thershold_pct' && typo.message.includes('不猜测'), typo.message);
  const cases = [
    [{ threshold_pct: 'abc' }, '非数字'],
    [{ threshold_pct: '3%' }, '含 % 符号不剥离'],
    [{ threshold_pct: -1 }, '负阈值'],
    [{ days: 2.5 }, '非整数日'],
    [{ days: 0 }, '小于最小 1 的日数'],
  ];
  for (const [fields, label] of cases) {
    const id = fields.days === undefined ? 'no_buy_on_surge' : 'no_buy_back_within';
    const r = parseContract({ template_id: id, fields });
    check(`字段非法（${label}）→ E_CONTRACT_FIELD_INVALID 且注明字段`, r.supported === false && r.code === CONTRACT_CODES.FIELD_INVALID && r.field === Object.keys(fields)[0], JSON.stringify(r));
  }
}

/* ---- 哈希与 R4（同内容同哈希；存储往返后哈希一致且仍触发） ---- */
{
  const a1 = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  const a2 = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  const a3 = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  check('哈希：同内容两次解析哈希一致（确定性）', a1.hash === a2.hash, `${a1.hash}/${a2.hash}`);
  check('哈希：改阈值（5→3）哈希变化（版本区分依据）', a1.hash !== a3.hash, '');
  check('哈希：不同模板不同哈希', a1.hash !== parseContract({ template_id: 'no_buy_back_within' }).hash, '');

  const stored = JSON.stringify({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });
  const reloaded = parseContract(JSON.parse(stored));
  check('R4（引擎侧）：存储往返后哈希一致', reloaded.hash === a3.hash, `${reloaded.hash}/${a3.hash}`);
  const r = matchContract(reloaded, { symbol: '000000', date: '2024-09-30', changePct: 0.052 });
  check('R4（引擎侧）：恢复后匹配仍触发（5.2% > 3%）', r.verdict === 'triggered' && r.contract_hash === a3.hash, JSON.stringify({ v: r.verdict, h: r.contract_hash }));
}

/* ---- dayChangePct：涨跌幅读取（B2/B3/R2/B4） ---- */
{
  const d1 = dayChangePct(market, '000000', '2024-09-30');
  check('dayChangePct：09-30 收盘 104 / 前收 09-27 100 → +4.0%', d1.complete === true && d1.effective_date === '2024-09-30' && d1.prev_date === '2024-09-27' && near(d1.change_pct, 0.04) && d1.display.change_pct === '+4.0%', JSON.stringify(d1));
  check('dayChangePct：source_note 含日期/收盘与不复权口径（F-9.1 数据来源）', d1.source_note.includes('2024-09-30') && d1.source_note.includes('不复权') && d1.source_note.includes('B2'), d1.source_note);
  const d2 = dayChangePct(market, '000000', '2024-10-03');
  check('dayChangePct：非交易日（10-03）→ 不晚于请求日最近交易日 09-30（B3，不改期）', d2.complete === true && d2.effective_date === '2024-09-30' && near(d2.change_pct, 0.04), JSON.stringify(d2));
  const d3 = dayChangePct(market, '000000', '2024-09-23');
  check('dayChangePct：首个交易日无前收 → 明确缺失（不补造 R2）', d3.complete === false && d3.code === CONTRACT_CODES.PREV_DAY_BEYOND_CACHE, JSON.stringify(d3));
  const d4 = dayChangePct(market, '000000', '2024-09-20');
  check('dayChangePct：范围外（09-20）→ 缓存引擎 E_VALUATION_OUT_OF_RANGE', d4.complete === false && d4.code === MARKET_CACHE_CODES.OUT_OF_RANGE, JSON.stringify(d4));
  const d5 = dayChangePct(market, '888888', '2024-10-10');
  check('dayChangePct：当日缺价（888888 @ 10-10）→ 明确缺失不回落（B4）', d5.complete === false && d5.code === CONTRACT_CODES.CHANGE_PCT_MISSING && d5.message.includes('2024-10-10'), JSON.stringify(d5));
  const d6 = dayChangePct(market, '999999', '2024-09-30');
  check('dayChangePct：标的不在支持范围 → 明确缺失（R2 提示）', d6.complete === false && d6.code === CONTRACT_CODES.CHANGE_PCT_MISSING && d6.message.includes('R2'), JSON.stringify(d6));
}

/* ---- matchContract：涨跌幅模板（触发/不触发/缺失 + 恰等边界） ---- */
{
  const p5 = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 5 } });
  const p3 = parseContract({ template_id: 'no_buy_on_surge', fields: { threshold_pct: 3 } });

  const d = dayChangePct(market, '000000', '2024-09-30');
  const rNo = matchContract(p5, { symbol: '000000', date: '2024-09-30', changePct: d.change_pct });
  check('同一判定链路：09-30 +4.0% 未超过 5% → 未触发（预设与用户操作共用纯函数 F-9.3）', rNo.verdict === 'not_triggered' && rNo.fact.display.change_pct === '+4.0%' && rNo.warning === null && rNo.contract_hash === p5.hash, JSON.stringify({ v: rNo.verdict }));
  const rYes = matchContract(p3, { symbol: '000000', date: '2024-09-30', changePct: d.change_pct });
  check('同一判定链路：同情境换 3% 阈值 → 触发（双情境由参数产生，非固定弹窗）', rYes.verdict === 'triggered' && rYes.warning.rule_text === p3.text && rYes.warning.threshold_display === '3.0%' && rYes.message.includes('命中'), JSON.stringify({ v: rYes.verdict }));
  check('命中警告含 规则/阈值/情境事实（F-9.4）', rYes.warning.situation.symbol === '000000' && rYes.warning.situation.display.change_pct === '+4.0%', JSON.stringify(rYes.warning.situation));

  const rEq = matchContract(p5, { symbol: '000000', date: '2024-09-30', changePct: 0.05 });
  check('边界：恰等阈值（5.0%）= 未触发——“超过”为严格大于', rEq.verdict === 'not_triggered', rEq.verdict);
  const rAbove = matchContract(p5, { symbol: '000000', date: '2024-09-30', changePct: 0.0500001 });
  check('边界：略超阈值 → 触发', rAbove.verdict === 'triggered', rAbove.verdict);

  const rMiss = matchContract(p5, { symbol: '888888', date: '2024-10-10', changePct: null });
  check('缺失行情：明确提示、不补造数值（F-9.2），不判触发/未触发', rMiss.verdict === 'missing_data' && rMiss.code === CONTRACT_CODES.CHANGE_PCT_MISSING && rMiss.message.includes('不补造') && rMiss.warning === null, JSON.stringify({ v: rMiss.verdict }));
  const rMissR = matchContract(p5, { symbol: '000000', date: '2024-09-20', changePct: null, reason_code: MARKET_CACHE_CODES.OUT_OF_RANGE });
  check('缺失行情：可透传具体原因码（如范围外）', rMissR.verdict === 'missing_data' && rMissR.code === MARKET_CACHE_CODES.OUT_OF_RANGE, rMissR.code);

  check('误用：非解析结果（自由文本）→ 抛错（不猜测）', throws(() => matchContract({ supported: false }, {})), '');
}

/* ---- matchContract：卖出后追回模板（窗口距离 ≤ N；同日排除；缺失与越界） ---- */
{
  const pB = parseContract({ template_id: 'no_buy_back_within' }); // 3 个交易日
  const pB1 = parseContract({ template_id: 'no_buy_back_within', fields: { days: 1 } });
  const days = market.tradingDays;

  const t1 = matchContract(pB, { symbol: '000000', date: '2024-10-11', trades: demoTrades, tradingDays: days });
  check('追回：000000 于 10-11 申报，最近卖出 10-08 → 距 3 个交易日 ≤ 3 → 触发（含等于）', t1.verdict === 'triggered' && t1.fact.distance_trading_days === 3 && t1.fact.last_sell.trade_id === 'T004' && t1.fact.last_sell.trade_date === '2024-10-08', JSON.stringify(t1.fact));
  const t2 = matchContract(pB, { symbol: '000000', date: '2024-10-10', trades: demoTrades, tradingDays: days });
  check('追回：10-10 申报 → 距 2 个交易日 → 触发', t2.verdict === 'triggered' && t2.fact.distance_trading_days === 2, JSON.stringify(t2.fact));
  const t3 = matchContract(pB, { symbol: '888888', date: '2024-10-11', trades: demoTrades, tradingDays: days });
  check('追回：888888 于 10-11 申报，最近卖出 10-10 → 距 1 个交易日 → 触发（按标的隔离）', t3.verdict === 'triggered' && t3.fact.last_sell.trade_id === 'T005' && t3.fact.distance_trading_days === 1, JSON.stringify(t3.fact));
  const t4 = matchContract(pB1, { symbol: '000000', date: '2024-10-11', trades: demoTrades, tradingDays: days });
  check('追回：窗口收窄到 1 日 → 距 3 超出 → 未触发', t4.verdict === 'not_triggered' && t4.fact.distance_trading_days === 3 && t4.message.includes('超出'), t4.message);
  const t5 = matchContract(pB, { symbol: '888888', date: '2024-09-25', trades: demoTrades, tradingDays: days });
  check('追回：此前无卖出记录 → 未触发（无相似情境）', t5.verdict === 'not_triggered' && t5.fact.last_sell === null && t5.message.includes('无卖出记录'), t5.message);
  const t6 = matchContract(pB, { symbol: '000000', date: '2024-10-08', trades: demoTrades, tradingDays: days });
  check('追回：同日先卖后买不视为“卖出后”（v1 候选口径）→ 未触发', t6.verdict === 'not_triggered' && t6.fact.last_sell === null, JSON.stringify(t6.fact));
  const t7 = matchContract(pB, { symbol: '000000', date: '2024-10-03', trades: demoTrades, tradingDays: days });
  check('追回：申报日不在交易日历 → 缺失行情（不猜测交易日距离）', t7.verdict === 'missing_data' && t7.code === CONTRACT_CODES.DATE_NOT_IN_CALENDAR, t7.code);
  const weird = [{ trade_id: 'X1', trade_date: '2024-10-01', symbol: '000000', side: 'sell', price: 1, quantity: 1 }];
  const t8 = matchContract(pB, { symbol: '000000', date: '2024-10-11', trades: weird, tradingDays: days });
  check('追回：卖出日不在交易日历 → 缺失行情（不猜测）', t8.verdict === 'missing_data' && t8.code === CONTRACT_CODES.SELL_DAY_NOT_IN_CALENDAR, t8.code);
  check('追回：未提供 trades/tradingDays → 抛错（调用方须显式提供上下文）', throws(() => matchContract(pB, { symbol: '000000', date: '2024-10-11' })), '');
}

/* ---- 汇总 ---- */
let pass = 0;
let fail = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS  ${r.name}`); }
  else { fail += 1; console.log(`FAIL  ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`); }
}
console.log(`\n== 合计 ${results.length} 项检查：通过 ${pass}，失败 ${fail} ==`);
process.exit(fail === 0 ? 0 : 1);
