# M2-C4 演练准备（数据侧）——R1/R2 演示脚本、留档模板与 F-7 数据口径核对表

> 版本：v4（2026-10-19 页面预走查后更新，尹辰；v3 2026-10-19 签收后，v2 2026-10-17，v1 2026-10-13）· 依据：`docs/implementation-baseline.md`（M2-C4 卡：R1-R5＋F-7 标注核对，三人；R1/R2 判据见 §3；F-7 §2.3）
> 分工：演练本体（真实运行环境逐条走查）由三人执行；本文件为尹辰数据侧准备材料——R1/R2 演示脚本与留档模板、F-7 中数据口径部分核对表。
> 状态：数据侧证据已**脚本化复跑**（`node scripts/drill-data-evidence.mjs`，20/20 通过，2026-10-19）；导入/报告主链路已接线（合成夹具口径，见 §0）。2026-10-19 已完成**数据侧页面预走查**（§0.1，R1 主链路通过；R2 阻断机制通过、真实签收范围声明未上线）。**不替代演练**：正式演练记录仍须三人按 §4 模板在页面真实运行环境签认。

## 0. 复跑记录（2026-10-17）

命令（仓库根目录）：

```bash
node scripts/drill-data-evidence.mjs
```

结果摘要：

```
PASS  R1 估值日=合成夹具末日 2024-10-11
PASS  R1 估值日不早于账单末笔 2024-10-10
PASS  R1 估值日不复权 close 与文档一致（108 / 1580 / 57）
PASS  R1 000000 actualValue 22000→23000（+1,000）
PASS  R1 000000 dragMoney -400→-1400（-1,000）
PASS  R1 000000 drag -2.0pp→-7.0pp
PASS  R1 888888 不受影响（actualValue 14700、dragMoney 1100、drag 7.33%）
PASS  R1 组合 actualValue 36700→37700
PASS  R1 组合 dragMoney +700→-300
PASS  R1 组合 drag +2.0pp→-0.9pp
PASS  R1 A 验算 26/26、恒等式 0 失败
PASS  R1 A′ 验算 26/26、恒等式 0 失败
PASS  R2 签收门：data/market-cache.json 通过（signed、manifest-0.2）
PASS  R2 签收范围 2023-01-01..2025-12-31、727 个交易日、首末 2023-01-03..2025-12-31
PASS  R2 非交易日 2025-10-01 → 2025-09-30
PASS  R2 范围外日期 2022-06-01 → E_VALUATION_OUT_OF_RANGE
PASS  R2 范围外日期 2026-01-05 → E_VALUATION_OUT_OF_RANGE
PASS  R2 范围外标的 000001 → E_PRICE_MISSING 且 no_fallback_used、组合阻断
PASS  R2 估值日 2024-10-01 早于末笔 2024-10-08 → E_VALUATION_BEFORE_LAST_TRADE
PASS  R2 合成夹具 2024-10-10：888888 缺价阻断、000000/001234 正常、组合阻断

== M2-C4 数据侧证据：合计 20 项，通过 20，失败 0（不替代页面演练）==
```

说明：
- 脚本仅用本地合成夹具与已签收行情缓存，不联网、不读账户数据；同时覆盖 R1（12 项）与 R2（8 项，含签收门），与 §1.3/§2.3 的命令输出一致（2026-10-19 复跑 20/20；签收仅改元数据，727 行行情数据未改动）。
- 断言失败时先核对是否口径/夹具变化，再同步本文件；不得直接放宽断言。该脚本为演练与 Plan B 数据部分的复跑入口，**不进入 `npm run check`**（避免未来把页面/数据口径变更误判为引擎回归）。
- 主链路状态（2026-10-19 本地证据）：`npm run check` 1060/1060（24 脚本）、`npm run smoke` 180/180；导入与报告链路已接线（PR #16），S1 幽灵线图已并入（PR #22）。演练本体仍待三人按 §4 模板留档。

### 0.1 数据侧页面预走查记录（2026-10-19，非三人正式签认）

环境：Windows 10.0.26200 · 提交 `767b026`（分支 `yinchen`）· `npm run dev` → `http://localhost:5180` · 浏览器自动化逐条操作 · 合成夹具行情（估值日 2024-10-11）· 操作人：尹辰（数据侧）。截图存于 `docs/yinchen/evidence/m2c4-2026-10-19/`；全程仅合成账单/合成行情，未上传真实账户数据（R5）。

**R1 页面主链路（同一系统两次运行：A → A′）**

| 观察项 | A | A′ | 预期/判读 |
|---|---|---|---|
| 组合 actualRet / ghostRet | +4.9% / +6.9% | +7.7% / +6.9% | ghostRet 不变（允许） |
| 组合 drag / dragMoney | +2.0pp / ¥700.00 | −0.9pp / ¥−300.00 | 与 CLI 基线一致 |
| 000000 actualRet / ghostRet | —（页面切换前基线 +10.0% / +8.0%） | +15.0% / +8.0% | ghostRet 不变 |
| 000000 drag / dragMoney | −2.0pp / ¥−400.00 | −7.0pp / ¥−1,400.00 | 与手算 −1,000 一致 |
| 888888 九项指标 | −2.0% / +5.3% / +7.3pp / ¥1,100.00 | 相同（差异表显示「无字段变化」） | 不受影响允许不变 |
| buyCost | ¥35,000（组合） | ¥35,000（组合） | 不变（允许） |

- A′ 差异表逐项可见：组合 actualValue ¥36,700→¥37,700、actualRet +4.9%→+7.7%、dragMoney ¥700→¥−300、drag +2.0pp→−0.9pp；000000 actualValue ¥22,000→¥23,000、actualRet +10.0%→+15.0%、dragMoney ¥−400→¥−1,400、drag −2.0pp→−7.0pp；保持不变字段逐一列出。
- 单笔反事实（S1）：000000/T004（2024-10-08 卖出 115×200）假设价值 ¥21,600、假设收益 +8.0%、相对改善 −7.0pp、剩余损耗 ¥0.00；888888/T005（2024-10-10 卖出）显示「序列不完整：缺 2024-10-10，路径断开；缺价不回退（B4）」及「底缘标记不表示价格为零」。
- 计算路径：9 项 fact 均带 `CALC_*_V1`；展开 `CALC_DRAG_MONEY_V1` 可见公式 `dragMoney = ghostValue − actualValue`、输入成交 T002/T005、源行 `demo-bill-aprime.csv` 第 3/6 行、S1–S4 步骤、双路径 P-A=P-B=1100（diff 0）。页面注明「演示计算路径，未经过复核发布流程」。
- 验算视图：演示账单路径不运行 `runReview`；将 A/A′ **原字节**经用户上传路径各导入一次后，页面「复核与发布记录」显示 A `V-beb6e687`、A′ `V-03b62534`，两者均 **26/26 事实通过、11/11 恒等式通过、计算路径完整、悬空引用无**。该复现方式已记入偏差，正式演练可按此操作或由 B 侧把演示路径接入 runReview。
- 截图：`r1-portfolio-a.jpg`、`r1-portfolio-aprime.jpg`、`r1-888888-unchanged-aprime.jpg`、`r1-verify-26of26-a-user-csv.jpg`、`r1-verify-26of26-aprime-user-csv.jpg`。

**R2 页面提示（合成夹具范围；真实签收范围未接入页面）**

| 用例 | 页面操作 | 页面可见结果 |
|---|---|---|
| 非交易日映射 | 契约页选 000000，申报日 2024-09-28（周六） | 有效交易日 2024-09-27，涨幅 +1.0%，标注「非交易日按不晚于请求日最近交易日 B3」 |
| 范围外日期 | 契约页申报日 2025-10-01 | `E_VALUATION_OUT_OF_RANGE`；「不补造数值、不回退其他日期」 |
| 缺价日 | 契约页选 888888，申报日 2024-10-10 | `E_CHANGE_PCT_MISSING`；「缺价不补造 B4」 |
| 范围外标的 | 用户 CSV 仅 000001（两笔） | 报告页阻断：`E_PRICE_MISSING`（不在合成缓存范围＋估值日缺价）；组合不发布、无任何数字；「不按剩余标的重新计算组合（B4）」 |
| 估值日早于末笔 | 用户 CSV 末笔 2024-10-14（估值日 2024-10-11） | `E_VALUATION_BEFORE_LAST_TRADE`；「不回退演示数据」 |

- 截图：`r2-nontrading-map-contract.jpg`、`r2-out-of-range-contract.jpg`、`r2-missing-price-contract.jpg`、`r2-unknown-symbol-user-csv.jpg`、`r2-before-last-trade-user-csv.jpg`。
- 偏差（B 侧接线）：页面仍显示「行情缓存·合成夹具（草案·演示口径）」「行情清单未签收·草案口径」，而缓存已于 2026-10-19 签收（manifest-0.2）。真实签收范围的四要素声明、真实缓存非交易日映射（2025-10-01→2025-09-30）在页面**尚不可演示**；须完成 `adapter` 真实缓存接入（任务 #33，跨区独立 PR）并更新标注后才能签认 R2。

**预走查结论**

- R1：页面主链路（数字、差异表、反事实、计算路径、26/26 验算）与 §1.3/§0 CLI 基线逐项一致 → **数据侧证据齐全**；正式演练仍需三人按 §4 签认。
- R2：五类阻断提示在页面均可见且无静默外推 → **机制通过**；真实签收范围声明未上线 → **R2 暂不能宣称通过**，待 B 侧接入后重跑本表。

## 1. R1 可复算演示脚本（受影响指标按预期变化）

### 1.1 判据原文（§3 R1，2026-10-10 修订）

合规 CSV 改动后，受影响指标应按预期变化（**不受影响指标允许不变**）；不承诺全部指标变化。

### 1.2 演示步骤

1. 导入 A 账单（`m0/csv-input/fixtures/demo-bill.csv`）→ 展示四指标卡（实际/对照/损耗 pp+元）。
2. 导入 A′ 账单（`m0/csv-input/fixtures/demo-bill-aprime.csv`；**唯一改动：000000 卖出价 110.00 → 115.00**，其余逐字节相同）→ 对比指标。
3. 打开验算视图（自我复核 verify report）：A 与 A′ 均 26/26 事实通过、恒等式 0 失败。
4. 现场手算核对（与展示值对照）：
   - 受影响：000000 卖出金额 Δ = (115−110)×200 = **+1,000** → actualValue +1,000、dragMoney −1,000、drag −2.0pp→−7.0pp（变化 −5.0pp）；组合 dragMoney +700→−300、drag +2.0pp→−0.9pp；
   - 不受影响（允许不变）：888888 全部指标不变；buyCost 两账单不变。
5. 留档：按 §4 模板记录命令/输出/日期/操作人。

### 1.3 CLI 基线证据（历史留档：2026-10-13；可复跑入口见 §0）

命令（仓库根目录；估值日＝合成缓存夹具末日，与接线后演示路径同源——`marketCache.fromFixtures`）：

```bash
node --input-type=module -e "
import {readFileSync} from 'node:fs';
import {createMarketCache, fromFixtures} from './src/engine/marketCache.js';
import {parseCsvText, normalizeRows} from './src/engine/csvNormalize.js';
import {computeIndicators} from './src/engine/indicators.js';
import {buildVerifyReport} from './src/engine/verify.js';
const mc = createMarketCache(fromFixtures(JSON.parse(readFileSync('m0/market-cache/fixtures/mock-calendar.json','utf8')), JSON.parse(readFileSync('m0/market-cache/fixtures/mock-daily-bars.json','utf8'))));
const A = normalizeRows(parseCsvText(readFileSync('m0/csv-input/fixtures/demo-bill.csv','utf8')), 'demo-bill.csv').trades;
const Ap = normalizeRows(parseCsvText(readFileSync('m0/csv-input/fixtures/demo-bill-aprime.csv','utf8')), 'demo-bill-aprime.csv').trades;
const effectiveDate = mc.tradingDays.at(-1);
console.log('checkLastTrade', JSON.stringify(mc.checkLastTrade(effectiveDate, '2024-10-10')));
const closes = Object.fromEntries(mc.symbols.map(s => [s, mc.getClose(s, effectiveDate)]));
console.log('effective_date', effectiveDate, '| closes', JSON.stringify(closes));
const rA = computeIndicators({trades:A, closes}); const rAp = computeIndicators({trades:Ap, closes});
for (const sc of ['000000','888888','portfolio']) {
  const a = sc==='portfolio'? rA.portfolio : rA.per_stock[sc];
  const b = sc==='portfolio'? rAp.portfolio : rAp.per_stock[sc];
  console.log(sc, 'actualValue', a.actualValue, '->', b.actualValue, '| dragMoney', a.dragMoney, '->', b.dragMoney, '| drag', a.drag.toFixed(6), '->', b.drag.toFixed(6));
}
const vA = buildVerifyReport({report:rA,trades:A,closes}); const vB = buildVerifyReport({report:rAp,trades:Ap,closes});
console.log('verify A:', JSON.stringify(vA.summary), '| verify Ap:', JSON.stringify(vB.summary));
"
```

实际输出（原样摘录）：

```
checkLastTrade {"blocked":false,"code":null}
effective_date 2024-10-11 | closes {"888888":1580,"000000":108,"001234":57}
000000 actualValue 22000 -> 23000 | dragMoney -400 -> -1400 | drag -0.020000 -> -0.070000
888888 actualValue 14700 -> 14700 | dragMoney 1100 -> 1100 | drag 0.073333 -> 0.073333
portfolio actualValue 36700 -> 37700 | dragMoney 700 -> -300 | drag 0.020000 -> -0.008571
verify A: {"n_facts":26,"pass":26,"fail":0,"identities_fail":0} | verify Ap: {"n_facts":26,"pass":26,"fail":0,"identities_fail":0}
```

判读：000000 与组合按手算预期变化（000000：actualValue +1,000 / dragMoney −1,000 / drag −2.0pp→−7.0pp，变化 −5.0pp；组合：dragMoney +700→−300 / drag +2.0pp→−0.9pp）；888888 不变（允许）；checkLastTrade 通过（估值日不早于末笔 2024-10-10）；A、A′ 双路径复核全过。备注：closes 为合成缓存夹具在估值日 2024-10-11（＝夹具末日）的不复权 close（000000=108.00、888888=1,580.00），与接线后演示路径同源（`marketCache.fromFixtures`）；页面演练时以页面实际加载的行情来源为准并按 F-7 标注。

### 1.4 页面演练要点（链路已接线，2026-10-17；页面预走查 2026-10-19）

- 对比须来自**同一系统两次真实运行**（A 与 A′ 各导入一次），不制作静态对照图。
- 受影响指标变化的截图/录屏注明：数据来源、行情截止日（asOfDate）、计算口径（F-7.4）。
- 验算视图：演示账单路径当前不运行 `runReview`，页面直接展开只有「演示计算路径」；如需页面内出现 26/26 复核记录，请按 §0.1 将 A/A′ 原字节经用户上传路径各导入一次（已实测可复现）。此偏差不影响 CLI 验算证据（§1.3）。
- 停止条件：导入链路或报告页未就绪 → 本项演练延期，不以 CLI 证据替代。

## 2. R2 缓存范围提示演示脚本（声明＋范围外不静默外推）

### 2.1 声明内容（2026-10-19 已签收，按签收件标注）

| 声明项 | 值（已签收，manifest-0.2） |
|---|---|
| symbols | 600519 贵州茅台 / 300750 宁德时代 / 601318 中国平安 |
| 起止日期 | 2023-01-01 .. 2025-12-31（实际首末交易日 2023-01-03 .. 2025-12-31） |
| 前复权口径 | 抓取时点 qfq 快照；**仅走势展示**，不参与金额相减（B2） |
| 缺失日期处理 | 逐标的 727/727 行、日历内缺失 0；缺价一律阻断不回落（B4） |
| asOfDate | 2025-12-31（固定，产品运行时不可改，F-3） |

来源：`m0/market-cache/manifest.candidate.json`（`artifact=manifest-signed`、`frozen: true`、`version=manifest-0.2`）、`data/market-cache.json`（`artifact=market-cache-signed`）。
守则：缓存清单已签收，页面可声明上述正式支持范围；产品接入仍须经 `assessCacheDoc` 签收门与独立 PR。范围外日期/标的仍按 E1 文案阻断，不静默外推。

### 2.2 演示用例

1. 非交易日请求 → 映射最近交易日：2025-10-01（国庆休市）→ 2025-09-30；
2. 范围外日期 → 阻断提示"不支持/数据缺失"：2022-06-01、2026-01-05 → `E_VALUATION_OUT_OF_RANGE`；
3. 范围外标的 → 阻断：000001 → `E_PRICE_MISSING` 且 `no_fallback_used: true`；
4. 估值日早于账单末笔成交 → 阻断：估值 2024-10-01 早于末笔 2024-10-08 → `E_VALUATION_BEFORE_LAST_TRADE`；
5. 区间内缺价 → 阻断不回落（B4；真实缓存缺失 0 日，用合成夹具演示机制）：合成夹具 2024-10-10 的 888888 缺 bar → blocked。

### 2.3 CLI 基线证据（历史留档：2026-10-13；可复跑入口见 §0）

命令（仓库根目录；用例 1–4 用真实缓存，用例 5 用合成夹具）。注：下方输出为 2026-10-13 留档，当时缓存文件为草案；2026-10-19 签收仅改元数据（artifact/frozen/sign_off/manifest_version），727 行行情数据未改动，复跑结果不变：

```bash
node --input-type=module -e "
import {readFileSync} from 'node:fs';
import {createMarketCache, fromPullDraft, fromFixtures} from './src/engine/marketCache.js';
const mc = createMarketCache(fromPullDraft(JSON.parse(readFileSync('data/market-cache.json','utf8'))));
console.log('range', JSON.stringify(mc.range), '| tradingDays', mc.tradingDays.length, mc.tradingDays[0], '..', mc.tradingDays[mc.tradingDays.length-1]);
console.log('non-trading 2025-10-01 ->', JSON.stringify(mc.resolveValuation('2025-10-01')));
console.log('out-of-range 2022-06-01 ->', JSON.stringify(mc.resolveValuation('2022-06-01')));
console.log('out-of-range 2026-01-05 ->', JSON.stringify(mc.resolveValuation('2026-01-05')));
console.log('unknown symbol 000001 ->', JSON.stringify(mc.resolvePrices(['000001'], '2025-12-31')));
console.log('before-last-trade ->', JSON.stringify(mc.checkLastTrade('2024-10-01','2024-10-08')));
const mfx = createMarketCache(fromFixtures(JSON.parse(readFileSync('m0/market-cache/fixtures/mock-calendar.json','utf8')), JSON.parse(readFileSync('m0/market-cache/fixtures/mock-daily-bars.json','utf8'))));
console.log('fixture missing-price 2024-10-10 ->', JSON.stringify(mfx.resolvePrices(mfx.symbols, '2024-10-10').per_symbol));
"
```

实际输出（原样摘录）：

```
range {"start":"2023-01-01","end":"2025-12-31"} | tradingDays 727 2023-01-03 .. 2025-12-31
non-trading 2025-10-01 -> {"requested_date":"2025-10-01","effective_date":"2025-09-30","blocked":false,"code":null}
out-of-range 2022-06-01 -> {"requested_date":"2022-06-01","effective_date":null,"blocked":true,"code":"E_VALUATION_OUT_OF_RANGE"}
out-of-range 2026-01-05 -> {"requested_date":"2026-01-05","effective_date":null,"blocked":true,"code":"E_VALUATION_OUT_OF_RANGE"}
unknown symbol 000001 -> {"effective_date":"2025-12-31","per_symbol":{"000001":{"blocked":true,"code":"E_PRICE_MISSING","close":null,"no_fallback_used":true}},"portfolio":{"blocked":true,"code":"E_PRICE_MISSING"}}
before-last-trade -> {"blocked":true,"code":"E_VALUATION_BEFORE_LAST_TRADE"}
fixture missing-price 2024-10-10 -> {"888888":{"blocked":true,"code":"E_PRICE_MISSING","close":null,"no_fallback_used":true},"000000":{"blocked":false,"code":null,"close":107},"001234":{"blocked":false,"code":null,"close":56}}
```

判读：五类提示齐全（映射/范围外日期/范围外标的/早于末笔/缺价不回落），无静默外推。

### 2.4 页面演练要点（链路已接线，2026-10-17；页面预走查 2026-10-19）

- 提示须在**页面状态条/输入处可见**（吴涵晶侧接线字段沿用引擎码），不只看控制台。§0.1 已实测五类提示均在页面可见（契约页原因码/有效交易日/情境事实；用户账单页阻断摘要与发布记录）。
- **真实范围声明当前未上线**：页面仍标注「合成夹具（草案·演示口径）」「行情清单未签收·草案口径」，与 2026-10-19 签收件不一致；真实缓存接入为独立 PR（任务 #33），完成前不得在页面声称 manifest-0.2 的正式支持范围，也不得把 R2 记为通过。
- 相关守则：演示账单避开 300750 跨越 2023-04-26（A1 签收约定；送转跳变）；用户账单若跨该事件按 C1 如实披露「v1 不做公司行为检测」；范围展示按签收件标注（manifest-0.2，2026-10-19）。

## 3. F-7 标注核对表（数据口径部分）

| # | 场景 | 必需标注 | 数据侧核对点 |
|---|---|---|---|
| 1 | 预置演示账单运行结果 | "演示数据·基于公开历史行情与演示账单计算"＋"非真实账户交易结果，不构成投资建议" | 数据来源（manifest.data_source）、行情截止日（asOfDate 2025-12-31）、计算口径三项（不复权估值 B2／未计入费用税费 Q1／分红未计入 Q2；"未计入滑点"待 C2 定夺后补） |
| 2 | 用户上传 CSV 运行结果 | "基于当前上传交易记录与可用历史行情计算"＋"计算结果仅反映输入数据，不构成投资建议" | 同上口径标注；缺失费用/税费按 0 并逐条标注（Q6） |
| 3 | 统一禁止项 | 禁止"真实跑出/真实用户收益"表述；**禁止将演示账单冒充真实账户收益**；"实际运行计算"须标明数据与口径、来源、截止日 | 演示账单行含前导零代码（000000）时不得表述为真实标的 |
| 4 | 数字层（F-2） | LLM 只原样引用 display；收益率 1 位小数、金额 2 位小数＋千分位；验算视图更高精度 | display 由确定性层生成；复核不比"屏幕显示相同"（金额到分、收益率另设容差） |
| 5 | 前复权展示 | 走势图快照口径标注（B6）；前复权不参与金额相减（B2） | 页面若展示前复权线，须标"快照口径" |

## 4. 留档模板

演练时逐条填写（R1/R2 各一份），随 M3 提交材料归档：

| 项 | 内容 |
|---|---|
| 验收项 | R1 可复算 / R2 缓存范围提示 |
| 日期·操作人 |  |
| 环境 | 部署 URL 或本地运行方式＋提交号 |
| 步骤 | （按 §1.2/§2.2 编号记录实际执行步骤与偏差） |
| 证据 | 截图/录屏路径＋命令与输出（若同时跑 CLI） |
| 判读 | 判据逐字对照（R1：受影响按预期变化、不受影响允许不变｜R2：声明四要素＋范围外"不支持/数据缺失"＋无静默外推） |
| 结论 | 通过 / 不通过（附差异） |

## 5. 前置条件与停止条件

- 演练本体前置：导入与报告链路已接线（PR #16；S1 图表已并入 PR #22）；数据侧页面预走查已完成（§0.1）。R2 声称真实范围的签收条件已满足（2026-10-19，manifest-0.2）；产品页面接入真实缓存仍需独立 PR（跨区，任务 #33）。
- 当前缺口：① 演示账单路径未接 `runReview`（§0.1；可用用户上传路径复现 26/26，或由 B 侧接入）；② 页面行情标注未随签收更新，真实范围声明不可演示（B 侧）；③ 三人正式演练尚未签认。
- 未就绪时的替代：仅保留本文件的 CLI 基线证据与 §0.1 预走查记录，**不宣称 R1/R2 演练通过**。
- 已知偏差风险：§1.3 CLI 证据采用合成缓存夹具（估值日 2024-10-11，与接线后演示路径同源）；页面演练若加载其他行情来源（如已签收真实缓存），数字会不同 → 以页面实际来源为准重算留档。
