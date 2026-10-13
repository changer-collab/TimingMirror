#!/usr/bin/env node
/**
 * M1-C5 行为发现引擎（src/engine/behavior.js）—— 产品侧单元测试 v1
 *
 * 定位：模式卡断言（模式名/状态/n/成交 ID/阈值与检验方式/证据路径）、"证据不足"用例（F-10.3 / PRD:234：
 *       样本 < 最小样本不下确定结论）、情境窗口边界（阈值等于、非交易日映射、窗口超范围、端点缺价）、
 *       配置候选占位标注（F-5.1）、CSV 标准化 → 行为发现链路。
 * 边界：清单 UI 呈现与对话引用属页面侧（F-10.4/F-10.6 已在本模块 notes 声明）；其余 PRD 模式未实现（不虚构）。
 * 运行：node tests/behavior.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PATTERN_CONFIG, BEHAVIOR_CODES, buildPatternList, listPatternDefinitions } from '../src/engine/behavior.js';
import { createMarketCache, fromFixtures } from '../src/engine/marketCache.js';
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
const normalize = (text, file) => normalizeRows(parseCsvText(text), file);

/* ---- 场景 A 市场：14 个合成交易日；000000 收盘价按窗口设计（含 08-06 缺 bar） ---- */
const CAL_A = ['2024-08-01', '2024-08-02', '2024-08-05', '2024-08-06', '2024-08-07', '2024-08-08', '2024-08-09', '2024-08-12', '2024-08-13', '2024-08-14', '2024-08-15', '2024-08-16', '2024-08-19', '2024-08-20'];
const CLOSES_A = [90, 100, 98, undefined /* 08-06 缺 bar */, 99, 100, 110, 110, 105, 106, 116, 117, 118, 120];
const BARS_A = CAL_A.map((date, i) => ({ date, close: CLOSES_A[i] })).filter((b) => b.close !== undefined);
const marketA = () => createMarketCache({
  tradingDays: CAL_A,
  range: { start: CAL_A[0], end: CAL_A[CAL_A.length - 1] },
  symbols: { '000000': { bars: BARS_A } },
});

/* 场景 A 账单（行序故意混排；Q7 允许）：
 * T001 08-12 买入（窗口 10.0% 恰等阈值 → 命中）；T002 08-16 买入（16.0% → 命中）；
 * T003 08-20 买入（7.27% → 不命中）；T004 08-10 非交易买入（映射 08-09；11.11% → 命中）；
 * T005 08-14 买入（窗口端点 08-06 缺价 → 未评估）；T006 08-06 买入（窗口早于缓存起点 → 未评估）；T007 卖出（忽略）。 */
const CSV_A = [
  '日期,标的,方向,价格,数量,费用,税费',
  '2024-08-12,000000,买入,112.00,100,5.00,0.00',
  '2024-08-16,000000,买入,116.00,100,5.00,0.00',
  '2024-08-20,000000,买入,120.00,100,5.00,0.00',
  '2024-08-10,000000,买入,110.00,100,5.00,0.00',
  '2024-08-14,000000,买入,116.00,100,5.00,0.00',
  '2024-08-06,000000,买入,100.00,100,5.00,0.00',
  '2024-08-19,000000,卖出,119.00,100,5.00,5.00',
].join('\n');

/* ---- 配置与定义表（F-5.1：集中配置＋版本＋候选标注） ---- */
{
  check('配置：版本 = candidate-1 且 source 标注候选占位（PRD 未到位）', PATTERN_CONFIG.version === 'candidate-1' && PATTERN_CONFIG.source.includes('候选') && PATTERN_CONFIG.source.includes('PRD'), PATTERN_CONFIG.source);
  const p = PATTERN_CONFIG.patterns.chase_high_buy;
  check('配置：追高买入参数（回看 5 个交易日 / 阈值 10% / 最小样本 2 / 买入侧）', p.name === '追高买入' && p.side === 'buy' && p.lookback_days === 5 && p.rise_threshold === 0.1 && p.min_samples === 2, JSON.stringify(p));
  check('配置：对象已冻结（防运行时改参）', Object.isFrozen(PATTERN_CONFIG) && Object.isFrozen(PATTERN_CONFIG.patterns) && Object.isFrozen(p), '');
  const defs = listPatternDefinitions();
  check('定义表：方法说明可列出模式（id/名/参数）与版本', defs.config_version === 'candidate-1' && defs.patterns.length === 1 && defs.patterns[0].pattern_id === 'chase_high_buy', JSON.stringify(defs));
}

/* ---- 场景 A：成立（n=3）＋窗口边界＋证据路径 ---- */
{
  const norm = normalize(CSV_A, 'scenario-a.csv');
  check('场景A：标准化通过（7 条交易，无错误）', !norm.blocked && norm.trades.length === 7, JSON.stringify(norm.errors));
  const list = buildPatternList({ trades: norm.trades, market: marketA() });
  check('场景A：清单 config_version/config_source 与 notes 声明 F-10.4/F-10.6', list.config_version === 'candidate-1' && list.notes.length === 3 && list.notes.some((s) => s.includes('F-10.6')) && list.notes.some((s) => s.includes('F-10.4')), JSON.stringify(list.notes));
  check('场景A：scope 计数（7 笔 = 6 买 + 1 卖）', list.scope.trade_count === 7 && list.scope.buy_count === 6 && list.scope.sell_count === 1, JSON.stringify(list.scope));

  const card = list.patterns[0];
  check('场景A：卡字段（模式名/实现状态/状态/样本数/最小样本）', card.pattern_id === 'chase_high_buy' && card.name === '追高买入' && card.implemented === true && card.status === '成立' && card.sample_n === 3 && card.min_samples === 2, JSON.stringify({ s: card.status, n: card.sample_n }));
  check('场景A：阈值与检验方式（规则展示 1 位小数；comparator ≥）', card.rule.window === '买入日前 5 个交易日' && card.rule.comparator === '≥' && card.rule.threshold === 0.1 && card.rule.threshold_display === '10.0%' && card.check_method.includes('情境切分'), JSON.stringify(card.rule));
  check('场景A：threshold_meta 记录配置版本与候选来源', card.threshold_meta.config_version === 'candidate-1' && card.threshold_meta.source.includes('候选'), JSON.stringify(card.threshold_meta));
  check('场景A：结论含“不宣称阈值普适”（F-5.1）', card.conclusion.includes('不宣称阈值'), card.conclusion);

  check('场景A：证据成交 ID 有序（按日期） = [T004, T001, T002]', eqArr(card.evidence.map((e) => e.trade_id), ['T004', 'T001', 'T002']), JSON.stringify(card.evidence.map((e) => e.trade_id)));
  const e4 = card.evidence[0];
  check('场景A：T004（非交易日 08-10 → 生效日 08-09）：rise = 100/90−1 = +11.1%', e4.trade_date === '2024-08-10' && e4.path.effective_date === '2024-08-09' && near(e4.rise, 100 / 90 - 1) && e4.display.rise === '+11.1%', JSON.stringify({ eff: e4.path.effective_date, rise: e4.rise }));
  check('场景A：T004 证据含 成交 ID/标的/价格/数量/source（可点回成交）', e4.symbol === '000000' && e4.price === 110 && e4.quantity === 100 && e4.source.file === 'scenario-a.csv' && e4.source.line === 5, JSON.stringify(e4.source));
  const e1 = card.evidence[1];
  check('场景A：T001 恰等阈值（110/100−1 = 10.0%）计入样本（≥ 含等于）', near(e1.rise, 0.1) && e1.display.rise === '+10.0%' && e1.path.window.start_date === '2024-08-02' && e1.path.window.start_close === 100 && e1.path.window.prev_date === '2024-08-09' && e1.path.window.prev_close === 110, JSON.stringify(e1.path.window));
  check('场景A：T001 路径含判定方法文字（不复权 B2 / 非交易日 B3）', e1.path.method.includes('B2') && e1.path.method.includes('B3'), e1.path.method);
  const e2 = card.evidence[2];
  check('场景A：T002 rise = 116/100−1 = +16.0%', near(e2.rise, 0.16) && e2.display.rise === '+16.0%', e2.display.rise);

  check('场景A：T003 已评估未命中（7.27% < 10%），列于 evaluated_others', card.evaluated_others.length === 1 && card.evaluated_others[0].trade_id === 'T003' && near(card.evaluated_others[0].rise, 118 / 110 - 1), JSON.stringify(card.evaluated_others));
  check('场景A：未评估 2 笔（不静默排除）：T006 窗口超范围、T005 端点缺价', eqArr(card.unevaluated.map((u) => u.trade_id), ['T006', 'T005']), JSON.stringify(card.unevaluated));
  check('场景A：T006 码 = E_WINDOW_BEYOND_CACHE（R2 不静默外推）', card.unevaluated[0].code === BEHAVIOR_CODES.WINDOW_BEYOND_CACHE && card.unevaluated[0].message.includes('R2'), card.unevaluated[0].message);
  check('场景A：T005 码 = E_PRICE_MISSING（B4 不回落）且注明缺价日期', card.unevaluated[1].code === BEHAVIOR_CODES.PRICE_MISSING && card.unevaluated[1].message.includes('2024-08-06'), card.unevaluated[1].message);
  check('场景A：卖出不进入证据/未评估（模式为买入侧）', !JSON.stringify(card).includes('"T007"'), '');

  const list2 = buildPatternList({ trades: norm.trades, market: marketA() });
  check('场景A：同一输入两次构建结果一致（确定性）', JSON.stringify(list) === JSON.stringify(list2), '');
}

/* ---- 场景 B：证据不足（n=0，demo-bill + m0 合成缓存链路） ---- */
{
  const norm = normalize(readText('m0/csv-input/fixtures/demo-bill.csv'), 'demo-bill.csv');
  const market = createMarketCache(fromFixtures(load('m0/market-cache/fixtures/mock-calendar.json'), load('m0/market-cache/fixtures/mock-daily-bars.json')));
  const card = buildPatternList({ trades: norm.trades, market }).patterns[0];
  check('场景B：合成缓存交易日不足回看窗口 → n=0、状态“证据不足”', card.status === '证据不足' && card.sample_n === 0, JSON.stringify({ s: card.status, n: card.sample_n }));
  check('场景B：不下确定结论（F-10.3 / PRD:234）', card.conclusion.includes('证据不足') && card.conclusion.includes('PRD:234'), card.conclusion);
  check('场景B：3 笔买入全部列为未评估（窗口早于 2024-09-23 缓存起点）', eqArr(card.unevaluated.map((u) => u.trade_id), ['T001', 'T002', 'T003']) && card.unevaluated.every((u) => u.code === BEHAVIOR_CODES.WINDOW_BEYOND_CACHE), JSON.stringify(card.unevaluated.map((u) => u.code)));
  check('场景B：卖出（T004/T005）不列为证据或未评估', card.evidence.length === 0 && card.evaluated_others.length === 0, '');
}

/* ---- 场景 C：证据不足（n=1 < 最小样本 2 —— 单次出现不构成“重复模式”） ---- */
{
  const csv = [
    '日期,标的,方向,价格,数量,费用,税费',
    '2024-08-12,000000,买入,112.00,100,5.00,0.00',
    '2024-08-06,000000,买入,100.00,100,5.00,0.00',
  ].join('\n');
  const norm = normalize(csv, 'scenario-c.csv');
  const card = buildPatternList({ trades: norm.trades, market: marketA() }).patterns[0];
  check('场景C：n=1 < 2 → 状态“证据不足”', card.status === '证据不足' && card.sample_n === 1, JSON.stringify({ s: card.status, n: card.sample_n }));
  check('场景C：命中笔仍列出（T001，10.0%），证据与结论分层', eqArr(card.evidence.map((e) => e.trade_id), ['T001']) && card.evidence[0].display.rise === '+10.0%', '');
  check('场景C：未评估 1 笔（T002 窗口超范围）', eqArr(card.unevaluated.map((u) => u.trade_id), ['T002']), '');
}

/* ---- 参数化：config 覆盖生效（供 M0 冻结阈值后替换；不改代码） ---- */
{
  const norm = normalize(CSV_A, 'scenario-a.csv');
  const config = {
    version: 'test-override',
    source: '测试覆盖',
    patterns: { chase_high_buy: { ...PATTERN_CONFIG.patterns.chase_high_buy, lookback_days: 3 } },
  };
  const card = buildPatternList({ trades: norm.trades, market: marketA(), config }).patterns[0];
  check('参数化：lookback=3 时结果变化（T003 = 118/106−1 = 11.32% 转为命中）', card.sample_n === 1 && eqArr(card.evidence.map((e) => e.trade_id), ['T003']) && near(card.evidence[0].rise, 118 / 106 - 1), JSON.stringify(card.evidence.map((e) => e.trade_id)));
  check('参数化：lookback=3 时 T001 窗口端点 08-06 缺价 → 未评估（窗口平移不改语义）', card.unevaluated.some((u) => u.trade_id === 'T001' && u.code === BEHAVIOR_CODES.PRICE_MISSING), JSON.stringify(card.unevaluated));
  check('参数化：卡内 threshold_meta 记录覆盖版本（test-override）', card.threshold_meta.config_version === 'test-override', card.threshold_meta.config_version);
}

/* ---- 边界与入参校验 ---- */
{
  check('边界：trades 为空 → 抛错', throws(() => buildPatternList({ trades: [], market: marketA() })), '');
  check('边界：market 非缓存实例 → 抛错', throws(() => buildPatternList({ trades: [{ trade_id: 'T001', trade_date: '2024-08-12', symbol: '000000', side: 'buy', price: 1, quantity: 1 }], market: {} })), '');
  const onlySell = [{ trade_id: 'T001', trade_date: '2024-08-19', symbol: '000000', side: 'sell', price: 119, quantity: 100, fee: 5, tax: 5, fee_missing: false, tax_missing: false, source: { file: 'sell-only.csv', line: 2 } }];
  const card = buildPatternList({ trades: onlySell, market: marketA() }).patterns[0];
  check('边界：纯卖出交易数组（构造输入）→ n=0、证据不足、不抛错（buy_count=0）', card.status === '证据不足' && card.buy_count === 0, JSON.stringify({ s: card.status, b: card.buy_count }));
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
