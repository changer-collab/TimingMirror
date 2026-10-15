# 用户 CSV 接线：adapter 接口修订意见（致组长 / 吴涵晶）

- 日期：2026-10-16
- 提出：尹辰（数据侧）；性质：**修订意见（【建议】，非接口冻结）**——实施归任务 A（吴涵晶），引擎侧如需扩展由我另走反馈 Issue
- 背景：组长 10/16 消息（对我部分）：报告页已接引擎（PR #7，fbe7fe4）；接用户 CSV 时将新增文本入口（同链路换输入源），请我对 `computeIndicators({trades, closes})` 调用约束、多标的 pool 语义、估值日传参提出修订建议；并确认缺价/不匹配阻断的最终文案与行为（与 `m0c2-signoff-package.md` §5.1 联动）
- 依据代码（已读，工作树 = main e0e50c9 + 本分支进展）：`src/demo/adapter.js`（PR #7 版）、`src/engine/indicators.js`、`src/agent/reviewPipeline.js`、`src/engine/marketCache.js`

---

## 1. 现状确认（与组长描述一致，附代码位置）

- `loadReportEngine(scenario)`（adapter.js:106）链路：fetch CSV 文本 → `parseCsvText`/`normalizeRows` → `createMarketCache(fromFixtures(...))` → `resolveValuation('2024-10-11')` → `checkLastTrade` → `resolvePrices` → `computeIndicators` → `buildProvenanceReport`。
- B4 组合扣发在当前实现：任一标的阻断 → `poolBlocked=true`（adapter.js:163-173）→ 计算后 `pool = poolBlocked ? null : report.portfolio`（:193）——即「组合不发布」由 **adapter 侧**实现（引擎不感知）。
- 合成缓存口径：range `2024-09-23..2024-10-11`、符号 `000000/888888/001234`（mock-daily-bars.json）；演示账单用其中的 `000000/888888`。

### computeIndicators({trades, closes}) 的实际约束（引擎侧，indicators.js:149-161）

| 约束 | 引擎行为 | 调用方责任 |
|---|---|---|
| trades 非空数组 | 空 → 抛 `TypeError` | 整批阻断时不得进入计算（现状已按此返回） |
| side ∈ 'buy'/'sell' | 其他 → 抛 `TypeError` | 只用 `csvNormalize` 标准化后的 trades |
| closes 覆盖 trades 中**全部**标的且为有限正数 | 缺任一 → 抛 `TypeError`（注释明示「缺价不回落 B4；调用方须先经行情缓存解析」） | 先 `resolvePrices`，由调用方决定喂哪些标的 |
| 排序 | `sortTrades` 引擎内完成（日期升序＋同日原始行号） | 调用方**不必**预排序；但 trades 需保留标准化时的 `source` 行信息（provenance 回源前提） |
| portfolio 语义 | `aggregate(per_stock)`——「传入 trades 涉及标的」的加总 | 无「账单全集」内在概念（见 §3） |

## 2. 文本入口与共享链路（建议实现形态）

- 【同意小组设计】`loadUserBillFromText(csvText, fileName)` 与 `loadReportEngine` 同链路换输入源。
- 建议实现为**单一共享内部函数**（如 `runBillChain({ csvText, fileName, scenarioMeta, dataMode })`），两个导出仅做参数包裹——否则 B4/阻断语义会有两份副本，日后必分叉（本次合并刚亲历 README/package 双份维护的代价）。
- 输入纪律：只吃文本（FileReader 结果）与文件名（仅作展示/错误定位）；**不 fetch、不上传**（R5）；`parseCsvText`/`normalizeRows` 直接复用（吃纯文本 ✓）；整批阻断 → `status:'blocked'` + errors 原样（现状 :135-139 模式保持）。
- `state.bill` 新字段【同意组长清单】并补充：`blockedSymbols[]`、`poolBlocked`、`valuation{requested_date,effective_date,blocked,code}`、`marketRange`、`snapshot`、`review`（见 §5）。`dataMode` 建议三值枚举：`synthetic_demo`（现状）/ `user_bill_synthetic_market`（任务 A 期间）/ `user_bill_real_cache`（清单签收后的接入 PR，勿提前使用）。

## 3. 多标的 pool 语义（组长问 2）

- 定义：**pool = 一次调用中 trades 涉及标的的联合加总**；「组合是否可信」＝「被纳入加总的每个标的是否都已取价成功」。
- 规则（与 B4 一致，用户路径必须保持）：任一标的阻断 → 该标的不发布 **且组合整体不发布**，禁止按剩余标的重算后冒充完整组合（现状 `poolBlocked` 已实现；共享函数落地后自动继承）。
- 两类阻断来源在 UI 必须可区分（文案拟案见 `m0c2-signoff-package.md` §5.1）：
  1. **不在支持范围**：标的 ∉ `cache.symbols`（调用前预检即可判定；合成期 = 000000/888888/001234 之外全部）；
  2. **在范围但当日缺价**：引擎返回 `E_PRICE_MISSING`（`no_fallback_used:true`，未回退）。
- 提示：合成缓存期，用户账单大概率因**日期**而非标的中断——账单末笔晚于 2024-10-11 会命中 `E_VALUATION_BEFORE_LAST_TRADE`。这是预期行为（缓存占位口径），文案需如实说明「合成演示缓存仅覆盖 2024-09-23..2024-10-11、合成代码」，避免被误读为 bug。

## 4. 估值日传参（组长问 3）

- 维持「数据集固定估值日」形态（F-3）：v1 **不开放 UI 任选日期**（asof_linkage 已收口——任意日期切换在范围外）。用户路径同传当前数据集估值日（合成期 = `2024-10-11`；签收后 = asOfDate `2025-12-31`）。
- 链路顺序固定为：`resolveValuation` →（阻断即返回）→ `checkLastTrade` →（阻断即返回）→ `resolvePrices`（现状 :147-164 顺序 ✓，勿调换）。
- 四类代码分别展示、不合并文案：`E_VALUATION_OUT_OF_RANGE`（超出缓存范围）/ `E_NO_EFFECTIVE_TRADING_DAY`（早于首个交易日）/ `E_VALUATION_BEFORE_LAST_TRADE`（早于账单末笔）/ `E_PRICE_MISSING`（当日缺价）。非交易日映射（不晚于请求日的最近交易日）属正常路径，不阻断（B3）；展示时保留 `requested_date` 与 `effective_date` 两者。

## 5. 【建议】发布门槛：用户路径消费 runReview（对齐 Issue #12 验收 #6）

- 现状缺口：报告页数字直接来自 `computeIndicators`（adapter :192-194），**未消费 runReview**；而 Issue #12 验收 #6 要求「报告只发布 runReview 允许的事实，阻断数字不得作为有效结论展示」。
- `runReview` 已就绪（src/agent/reviewPipeline.js:86）：输入 `{trades, closes, valuation, recompute, now}`；输出 `status('published'|'degraded'|'blocked')`、`published_facts[]`（含 `value/formula_id/display`——display 即引擎展示字符串）、`blocked_facts[]`（含 `reason_codes`）、`portfolio_published`、`blocked_symbols[]`、`recompute_log`、`verify_id`。
- 建议调用形态（推荐 A，B 为分步退路；两者都不改引擎、不改公式）：
  - **A（单一源头）**：adapter 把**全量 trades + 全量 closes（阻断标的 close = null）**交给 `runReview`：runReview 自行识别缺价 → `E_REVIEW_PORTFOLIO_WITHHELD` 扣发组合（reviewPipeline.js:257-260）、`portfolio_published=false`。adapter 的 `perStock/pool` 视图改由 `published_facts` 按 scope 分组生成（display 直取，不二次格式化）；`blocked_facts` → 不发布面板。resolvePrices 的结果仍用于「不在支持范围」预检与代码透出。
  - **B（最小改动分步）**：本轮先复用现状链交付文本入口；同 PR 内把 runReview 作为「复核状态」并列消费（报告页新增状态条），下一小步再把发布源头切到 runReview。
  - 无论 A/B：**pool 显示只信 `portfolio_published`（或 poolBlocked），不得展示 computeIndicators 的子集组合**。
- 输出契约增补建议：`review{ status, published_facts, blocked_facts, verify_id, recompute_log, portfolio_published }`；外层 `status('ok'|'partial'|'blocked'|'error')` 词汇保持不变（reportView 兼容），`blocked_symbols>0` 时映射 `partial`。

## 6. 边界与移交

- 本文件是修订意见（【建议】），接口冻结仍走 M0-C1 三方记录合并流程；实施归任务 A（吴涵晶）；如实施中发现引擎行为与本文不符，按「最小改动＋单测＋如实标注」处理并同步。
- 关联：`m0c2-signoff-package.md` §5.1（阻断文案拟案＋「草案·演示口径」标注）、`engine-wiring-handoff.md`（引擎 I/O 契约）、Issue #12 验收 2/5/6。
