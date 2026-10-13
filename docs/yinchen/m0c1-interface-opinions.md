# M0-C1 接口冻结 —— 尹辰方书面意见（行情缓存 / CSV 输入 / 计算结果）

> 状态：【三方确认材料 · 2026-10-13】尹辰（数据与确定性计算）对三类接口候选的**覆盖确认与修订意见**；供 changer 主持的三方确认记录引用；不改变任何已确认口径（Q 组/B 组不动），新增细化均标注【候选·待审校】。
> 说明：market-cache 候选本注明“尹辰、吴涵晶对本版新增内容的覆盖确认未提供”；本文件提供尹辰方部分（吴涵晶方仍待补）。
> 验证证据：`npm run check` 623 项全过、`npm run smoke` 15/15（2026-10-13 本地；远程无 CI）。

## 1. 行情缓存接口（`m0/market-cache/schema.candidate.json`，candidate-1.1）

**确认**：B1–B7 语义我方全部确认。已按候选落地 `src/engine/marketCache.js`（resolveValuation / getClose / resolvePrices / checkLastTrade）＋ `tests/market-cache.test.mjs` 25 项断言（S1–S5 场景语义移植）。

**修订意见（2 项新增候选，请纳入三方审校）**：

1. **E_NO_EFFECTIVE_TRADING_DAY**（我方 M1-C1 实现提出，已入 schema failure_codes 并标 candidate）：请求日位于缓存区间内、但早于首个交易日 → 本次计算全部阻断。依据 B3 语义的必要补充（否则请求日无可取的有效交易日，逻辑上无定义）。实现与单测已覆盖。
2. **M3（股数事件来源/生效日口径）实操含义请明确**：我方按 B5 实现“涉及未支持事件的持有区间 → 阻断”，但真实事件识别依据未提供（schema 已注明“不得默认已核验无事件”）。演示侧的对应处置见 M1 清单签收待办：300750 在 2023-04-26 存在送转量级复权跳变（≈×1.82，观测于 `data/market-cache.pull-record.json`），建议维持名单并约定演示账单避让该日（或替换 300760）——请负责人签收时一并定夺。

**我方产出指针**（B1/B6 履行）：`m0/market-cache/manifest.candidate.json`（清单草案，symbols 与 asOfDate=2025-12-31 为【建议】）、`data/market-cache.json`（727/727 行）、`data/market-cache.pull-record.json`（前复权基准核验初稿）、`scripts/pull-market.py`。

## 2. CSV 输入接口（`m0/csv-input/schema.candidate.json`，candidate-3）

**确认**：Q1–Q9、O1–O3 语义逐条确认（与 `src/engine/csvNormalize.js` 实现一致；`tests/csv-normalize.test.mjs` 59 项、A/A′ 全字段一致＋标准化→计算引擎联测）。

**修订意见（2 项新增错误码，请纳入下一版本）**：

1. `E_EMPTY`：空文件/仅表头 → 整批阻断（m0 离线脚本未含；产品纯函数补齐）。
2. `E_HEADER_MISSING`：缺必需列 → 整批阻断（同上）。
   两者语义与 O1（错误汇总+整批阻断、不产生部分结果）一致，仅为枚举补全。

**提醒**：Q9（“股票本身涨幅”）未定义（C3），我方未在 CSV 侧实现；「changer 转述确认、原始签收记录未提供」项建议归档时补齐凭证。

## 3. 计算结果接口（`m0/calc-baseline/schema.candidate.json`）

**确认**：公式表 9 条＋恒等式①–④＋双路径（P-A 逐批重放 / P-B 聚合公式）我方全部确认。落地：`src/engine/indicators.js`（83 项）＋`src/engine/counterfactual.js`（29 项）＋复核 `src/engine/verify.js`（28 项）；场景 S1（SIG-3）为当前唯一已定义反事实口径。

**三项【建议】表态**：

| 建议项 | 我方意见 | 依据 |
|---|---|---|
| S1 滑点不建模 + 标注“未计入滑点”（C2） | 同意；请负责人确认纳入 `result_labelling` | 与实现一致（无滑点字段/无假设价） |
| S2 信号定义＝成交事件驱动（无价格触发） | 同意 | 与实现一致（实际路径按 CSV 执行；对照忽略全部卖出） |
| S3 执行时点＝trade_date 当日以 CSV 价执行，不建模盘中/T+1 | 同意 | 与实现一致（B3/B4 估值） |

**C1（S3 买入侧/早卖替换假设执行价）我方【建议】**：v1 维持不实现（`replaceSell` 对买入笔显式抛错、不猜测）；若后续启用备用演示页，建议假设口径取“替换为 effective_date 当日不复权 close 买入”——该价为本接口已使用估值价、不新增行情假设来源。**仅建议**；且提示（见 `docs/yinchen/m2c5-bound-relations.md`）：S3 与 S1/S2 之间无可证界关系，任何 S3 数值须独立标注口径、不得与其他场景拼接区间。

**其余未决**：C3 不在本方扩展（待定义）；C4 正式复核容差——我方实现用候选值（金额统一舍入到分；收益率相对 1e-9），随 M0 冻结替换；C5 三方覆盖确认待 changer 主持（本文件提供尹辰方）。

## 4. 附：本次新增产出与复核证据（供确认记录引用）

- M2-C1 数据侧主体：verify（附A.2）/ 分解 OUTPUT01 / 假设检验 OUTPUT02 / 计算路径 OUTPUT03——`src/engine/verify.js`、`decompose.js`、`behavior.js`（三态扩展）、`provenance.js` 及对应单测（61e0f7a、7929f8c）。
- M2-C5 区间界关系：报告＋测试（ac6c7c1）——无条件区间不可证，条件式区间可证，并列展示为默认安全方案。
- 全部计数以 `npm run check` 实际输出为准（当前 623 项）；无 CI，报告以本地输出留档。
