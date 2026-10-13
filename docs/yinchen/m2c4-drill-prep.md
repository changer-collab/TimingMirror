# M2-C4 演练准备（数据侧）——R1/R2 演示脚本、留档模板与 F-7 数据口径核对表

> 版本：v1（2026-10-13，尹辰）· 依据：`docs/implementation-baseline.md`（M2-C4 卡：R1-R5＋F-7 标注核对，三人；R1/R2 判据见 §3；F-7 §2.3）
> 分工：演练本体（真实运行环境逐条走查）由三人执行；本文件为尹辰数据侧准备材料——R1/R2 演示脚本与留档模板、F-7 中数据口径部分核对表。
> 状态：准备材料已就绪；CLI 基线证据已产出（真实输出见 §1.3/§2.3，2026-10-13）。**不替代演练**：演练记录须在页面真实运行环境产出。

## 1. R1 可复算演示脚本（受影响指标按预期变化）

### 1.1 判据原文（§3 R1，2026-10-10 修订）

合规 CSV 改动后，受影响指标应按预期变化（**不受影响指标允许不变**）；不承诺全部指标变化。

### 1.2 演示步骤

1. 导入 A 账单（`m0/csv-input/fixtures/demo-bill.csv`）→ 展示四指标卡（实际/对照/损耗 pp+元）。
2. 导入 A′ 账单（`m0/csv-input/fixtures/demo-bill-aprime.csv`；**唯一改动：000000 卖出价 110.00 → 115.00**，其余逐字节相同）→ 对比指标。
3. 打开验算视图（自我复核 verify report）：A 与 A′ 均 26/26 事实通过、恒等式 0 失败。
4. 现场手算核对（与展示值对照）：
   - 受影响：000000 卖出金额 Δ = (115−110)×200 = **+1,000** → actualValue +1,000、dragMoney −1,000、drag 0.15→0.10（变化 −5.0pp）；
   - 不受影响（允许不变）：888888 全部指标不变；buyCost 两账单不变。
5. 留档：按 §4 模板记录命令/输出/日期/操作人。

### 1.3 CLI 基线证据（2026-10-13 实际运行输出）

命令（仓库根目录）：

```bash
node --input-type=module -e "
import {readFileSync} from 'node:fs';
import {computeIndicators} from './src/engine/indicators.js';
import {buildVerifyReport} from './src/engine/verify.js';
import {parseCsvText, normalizeRows} from './src/engine/csvNormalize.js';
const A = normalizeRows(parseCsvText(readFileSync('m0/csv-input/fixtures/demo-bill.csv','utf8')), 'demo-bill.csv').trades;
const Ap = normalizeRows(parseCsvText(readFileSync('m0/csv-input/fixtures/demo-bill-aprime.csv','utf8')), 'demo-bill-aprime.csv').trades;
const closes = {'000000':125.0,'888888':1560.0};
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
000000    actualValue 22000 -> 23000 | dragMoney 3000 -> 2000 | drag 0.150000 -> 0.100000
888888    actualValue 14700 -> 14700 | dragMoney 900 -> 900 | drag 0.060000 -> 0.060000
portfolio actualValue 36700 -> 37700 | dragMoney 3900 -> 2900 | drag 0.111429 -> 0.082857
verify A: {"n_facts":26,"pass":26,"fail":0,"identities_fail":0} | verify Ap: {"n_facts":26,"pass":26,"fail":0,"identities_fail":0}
```

判读：000000 与组合按手算预期变化（actualValue +1,000 / dragMoney −1,000 / drag 变化 −5.0pp）；888888 不变（允许）；A、A′ 双路径复核全过。备注：closes 为演示口径合成收盘价（000000=125.00、888888=1,560.00）；页面演练时以页面实际加载的行情来源为准并按 F-7 标注。

### 1.4 页面演练要点（待全链路就绪）

- 对比须来自**同一系统两次真实运行**（A 与 A′ 各导入一次），不制作静态对照图。
- 受影响指标变化的截图/录屏注明：数据来源、行情截止日（asOfDate）、计算口径（F-7.4）。
- 停止条件：导入链路或报告页未就绪 → 本项演练延期，不以 CLI 证据替代。

## 2. R2 缓存范围提示演示脚本（声明＋范围外不静默外推）

### 2.1 声明内容（签收前按"草案范围"标注；签收后替换为签收件）

| 声明项 | 值（草案，待签收） |
|---|---|
| symbols | 600519 贵州茅台 / 300750 宁德时代 / 601318 中国平安 |
| 起止日期 | 2023-01-01 .. 2025-12-31（实际首末交易日 2023-01-03 .. 2025-12-31） |
| 前复权口径 | 抓取时点 qfq 快照；**仅走势展示**，不参与金额相减（B2） |
| 缺失日期处理 | 逐标的 727/727 行、日历内缺失 0；缺价一律阻断不回落（B4） |
| asOfDate | 2025-12-31（固定，产品运行时不可改，F-3） |

来源：`m0/market-cache/manifest.candidate.json`（草案，`frozen: false`）、`data/market-cache.json`。
守则：**签收前产品不得声称真实支持范围（R2）**——演示时必须标注"草案范围·演示口径"。

### 2.2 演示用例

1. 非交易日请求 → 映射最近交易日：2025-10-01（国庆休市）→ 2025-09-30；
2. 范围外日期 → 阻断提示"不支持/数据缺失"：2022-06-01、2026-01-05 → `E_VALUATION_OUT_OF_RANGE`；
3. 范围外标的 → 阻断：000001 → `E_PRICE_MISSING` 且 `no_fallback_used: true`；
4. 估值日早于账单末笔成交 → 阻断：估值 2024-10-01 早于末笔 2024-10-08 → `E_VALUATION_BEFORE_LAST_TRADE`；
5. 区间内缺价 → 阻断不回落（B4；真实缓存缺失 0 日，用合成夹具演示机制）：合成夹具 2024-10-10 的 888888 缺 bar → blocked。

### 2.3 CLI 基线证据（2026-10-13 实际运行输出）

命令（仓库根目录；用例 1–4 用真实拉数草案，用例 5 用合成夹具）：

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

### 2.4 页面演练要点（待全链路就绪）

- 提示须在**页面状态条/输入处可见**（吴涵晶侧接线字段沿用引擎码），不只看控制台。
- 相关守则：演示账单避开 300750 跨越 2023-04-26（送转跳变，B5 未决）；未签收前所有范围展示标注"草案·演示口径"。

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

- 演练本体前置：导入与报告链路就绪（吴涵晶侧）、verify/验算视图可打开；R2 声称真实范围需清单签收（E）在先。
- 未就绪时的替代：仅保留本文件的 CLI 基线证据，**不宣称 R1/R2 演练通过**。
- 已知偏差风险：演示口径 closes（§1.3）与页面实际行情来源可能不同 → 以页面来源为准重算留档。
