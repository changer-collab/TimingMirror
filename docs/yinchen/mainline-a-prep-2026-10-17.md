# 主线 A 预备设计：缓存接入／300750／契约哈希／行为参数（2026-10-17）

> 性质：技术预案（【建议】），**非接口冻结、非交接记录、未实施**。所有决策仍以 Issue #13（主线 A）、#8 及负责人签收为准。
> 依据：#13「当前可独立开展（不等待签收）」三项；`docs/yinchen/m0c2-signoff-package.md` §4–§5；`docs/wuhanjing/m0c1-ui-interface-confirmation.md` §3.1/§3.3/§4.1。
> 纪律：R2——签收前 `data/market-cache.json`（`artifact=market-cache-pull-draft`、`frozen=false`、无 `sign_off`）不得被产品作为真实支持范围引用；本包不触碰产品接入、不改变演示链路。
> 验证基线（2026-10-17 同步 main `268074e` 后）：`npm run check` 798/798（17 脚本）、`npm run smoke` 52/52；远程无 CI（no checks reported，未配置）。

## 0. 一页结论

| 预备项 | 引擎侧现状 | 产品侧缺口 | 签收后的动作 |
|---|---|---|---|
| 真实缓存接入 | `createMarketCache` 与 `fromPullDraft` 已具备；草案缓存的范围/节假日/三标的取价/快照/越界已在 check 中（7 项） | 签收门、数据源参数化、模式与文案、支持范围字段 | 独立「缓存接入」PR（A 侧引擎门＋B 侧 adapter/UI 联动），不混入其他任务 |
| 300750 处置 | 无公司行为检测（`E_SHARE_EVENT_UNSUPPORTED` 仅存 m0 候选层） | 方案未定（A 避让 / B 替换 300760） | 按签收结论执行：A 约束演示账单＋披露用户账单风险；B 重新拉数＋改 11 处引用 |
| 契约哈希 | `fnv1a64-placeholder`，覆盖固定 canonical；替换点单一 | 算法与覆盖未冻结；UI 持久化缺 canonical | M0 §4-7 冻结后替换实现、升 canonical 版本、迁移存储 |
| 行为参数 | `PATTERN_CONFIG`（candidate-1）＋ `buildPatternList(config)` 注入 seam | PRD 阈值未到位；UI 未接线 | 确认后改默认值/版本/测试/UI 标注（无历史持久化迁移） |

建议顺序：等 A–E → 缓存接入独立 PR（先 A 侧门与测试，再 B 侧 adapter/UI）→ 契约哈希按 M0 冻结 → 行为参数按 PRD 确认。三项均不必等对方先动工的部分已完成到「可直接执行」粒度。

---

## 1. 缓存接入前置设计

### 1.1 现状与接缝（逐字定位）

| 现状 | 位置 | 说明 |
|---|---|---|
| 合成市场单例 | `src/demo/adapter.js:79-88` | `demoMarket()` 只加载 m0 夹具并缓存 Promise |
| 硬编码估值日 | `src/demo/adapter.js:30`、`:92` | `DEMO_VALUATION_DATE = '2024-10-11'` 被三条链路共用 |
| 共享市场段 | `src/demo/adapter.js:90-113` | `runSyntheticMarketStage` 依次 `resolveValuation → checkLastTrade → resolvePrices`，被演示、用户账单、反事实三处调用 |
| 合成文案硬编码 | `src/demo/adapter.js:108-110` | 范围外提示写死「合成行情缓存」；真实模式直接复用会错标来源 |
| 真实数据适配器 | `src/engine/marketCache.js:83-86` | `fromPullDraft(doc)` 已把 `data/market-cache.json` 映射为 `createMarketCache` 输入 |
| 真实数据文件 | `data/market-cache.json` | `artifact=market-cache-pull-draft`、`frozen=false`，**文件内无 `sign_off`** |
| 签收记录 | `m0/market-cache/manifest.candidate.json` | `sign_off.accepted_by/accepted_date` 均为 `null`；与产品加载文件分离 |
| 取价与阻断 | `src/engine/marketCache.js:40-78` | 范围外/到期无有效日/末笔晚于估值/缺价；缺价 `no_fallback_used:true` |
| 数据模式与能力 | `src/demo/adapter.js:33-45`、`:130-134` | `CAPABILITY.marketCache.ready=false`；两种模式均标注合成行情 |
| UI 行情文案 | `src/ui/views/reportView.js:178`、`:331`；`:186` | 写死「m0 合成夹具（非真实行情）」；演示页另有「行情清单未签收·草案口径」 |
| 草案引擎测试 | `tests/market-cache.test.mjs:82-113` | asOfDate、节假日映射、首日前、首个交易日、三标的取价、快照分离、越界，共 7 项 |
| 用户账单链路 | `src/demo/adapter.js:252-322` | 全量标的 closes（缺价置 null）→ `runReview` → 发布门槛 |
| 反事实链路 | `src/demo/adapter.js:337-398` | 单标的过滤后复用同一市场段，缺价 → `E_CF_PRICE_MISSING` |

结论：**引擎数据面已就绪，缺的是产品侧「可否使用」的门、来源参数化与展示口径**。不需要改计算规则。

### 1.2 签收门（R2，必须先于任何接入）

现状问题：产品要加载的 `data/market-cache.json` 内没有签收字段，签收只在 `m0/.../manifest.candidate.json`。浏览器若同时读两份文件再拼装，会多一个失败点，也容易出现「文件换了、签收没跟上」的错配。

建议（技术打包要求，供签收时采纳）：签收时产出一份**自描述的真实缓存件**，把治理信息嵌入文件本体：

```json
{
  "artifact": "market-cache-signed",
  "frozen": true,
  "manifest_version": "manifest-0.2",
  "sign_off": { "accepted_by": "<changer>", "accepted_date": "YYYY-MM-DD" },
  "manifest": { "symbols": [], "date_range": {}, "asOfDate": "" },
  "snapshot": {},
  "calendar": {},
  "symbols": {}
}
```

加载门（纯函数，建议放 `src/engine/marketCache.js`，供 adapter 与测试共用）：

```
assessCacheDoc(doc) →
  1) doc.frozen === true                    否 → { usable:false, reason:'NOT_FROZEN' }
  2) doc.sign_off.accepted_by 非空          否 → { usable:false, reason:'NOT_SIGNED' }
  3) manifest.symbols/date_range/asOfDate、calendar.trading_days、symbols 形状齐全
                                            否 → { usable:false, reason:'MALFORMED' }
  4) → { usable:true, signed:true, manifest_version, accepted_by, accepted_date }
```

行为约束：
- `usable:false` 时真实源不可用；**不得静默回退**到合成行情或另一个文件。用户若显式选择真实源，应显示阻断原因；未签收时产品仍只提供合成模式。
- 测试必须使用**独立的小型 signed 测试夹具**，不得在本仓库的 `data/market-cache.json` 上伪造签收字段。
- 签收前 `CAPABILITY.marketCache.ready` 保持 `false`；签收后由接入 PR 改为 `true`。

### 1.3 数据源与市场实例

建议 adapter 内部改为「来源选择 + 单一市场段」，不新增第二套编排：

- `syntheticMarket()`：现有 `demoMarket()` 更名或保留，返回合成夹具实例。
- `realMarket()`：懒加载 `/data/market-cache.json` → `assessCacheDoc` → `createMarketCache(fromPullDraft(doc))`；失败抛出可展示错误（含 HTTP/校验原因），不缓存失败结果以外不做特殊重试。
- `runMarketStage(trades, { market, valuationDate, source })`：由 `runSyntheticMarketStage` 参数化而来，替换掉写死的 `DEMO_VALUATION_DATE` 与「合成行情缓存」文案；来源标签来自 `source`（如「合成夹具」「真实缓存（已签收）」）。
- 公共入口增加可选参数（【建议】显式参数，避免隐式全局开关）：
  `loadReportEngine(scenario, { marketSource })`、`loadUserBillReport(bill, { marketSource })`、`loadSellCounterfactual({ ..., marketSource })`。
- 真实源加载失败/校验失败：仅返回阻断错误；**不自动切换到合成源**（否则用户会把合成数字误读为真实结果）。
- 反事实与主报告必须使用同一来源与同一估值日，避免同页两套行情。

### 1.4 估值日

- v1 仍为**固定数据集估值日**，不开放 UI 任选（F-3；`adapter-user-csv-opinions.md` ③）。
- 真实源候选估值日＝`manifest.asOfDate`（当前草案建议 2025-12-31，待 A–E 决策 B）。合成源继续 2024-10-11。
- 用户账单末笔晚于估值日 → 既有 `E_VALUATION_BEFORE_LAST_TRADE` 阻断；估值日早于账单首笔或账单日期超出缓存范围，同样按现有链路阻断，不回退。
- 估值日字段应从来源配置读取一次，禁止在多个函数里重复常量；B 决策若改日期，只改一处＋测试。

### 1.5 建议输出字段（供 UI，不复制引擎公式）

现有字段保留（`valuation`、`marketRange`、`snapshot`、`prices`、`blockedSymbols`、`poolBlocked`）。为文案分类与范围展示，建议增补：

| 字段 | 形状 | 用途 |
|---|---|---|
| `marketSource` | `{ id:'synthetic-fixture'|'real-cache', label, signed:boolean, artifact, manifestVersion, snapshotId, fetchTime }` | 状态条与数据模式标注 |
| `supportScope` | `{ symbols:string[], range:{start,end}, snapshot:{...}, signed:boolean }` | 范围声明；供 UI 预检标的是否在范围内 |
| `marketSymbols` | `string[]`（可由 `supportScope.symbols` 替代） | 区分「不在支持范围」vs「范围内当日缺价」 |
| `errors[].kind` / `errors[].symbol` | 可选枚举：`OUT_OF_SUPPORT` / `MISSING_PRICE` / `VALUATION_OUT_OF_RANGE` / `NO_EFFECTIVE_DAY` / `BEFORE_LAST_TRADE` | UI 不再解析中文消息做分类 |

最小要求：**UI 必须能拿到支持标的列表**；当前输出没有该字段，只能从 `errors` 文本推断，不适合做稳定接线。

### 1.6 阻断语义与文案映射（与涵晶 §3.1 对齐）

| 情形 | 判定 | UI 必显 | 拟用文案 | 依据 |
|---|---|---|---|---|
| 估值日越界 / 范围内无有效交易日 | `E_VALUATION_OUT_OF_RANGE` / `E_NO_EFFECTIVE_TRADING_DAY` | 中止受影响结果，显示请求日与代码 | 「数据不在当前支持范围或无法确定有效交易日」 | 涵晶 §3.1 |
| 估值日早于账单末笔 | `E_VALUATION_BEFORE_LAST_TRADE` | 中止，不回退演示或改日期 | 「估值日早于账单最后一笔交易，无法估值」 | 涵晶 §3.1 |
| 标的在支持范围、当日缺价 | 标的 ∈ `marketSymbols` 且 `per_symbol.blocked`，代码 `E_PRICE_MISSING` | 该标的与组合均不发布 | 「该标的（{symbol}）在估值日 {effective_date} 缺收盘价；其结果不可计算（未回退到其他日期取价）。」 | 收口包 §5.1「数据缺失」细化 |
| 标的不在支持范围 | 标的 ∉ `marketSymbols`；引擎仍返回 `E_PRICE_MISSING` | 该标的与组合均不发布 | 「该标的（{symbol}）不在当前行情缓存支持范围；其结果不可计算（未回退到其他日期取价）。」 | 收口包 §5.1 原文 |
| 组合被阻断 | 上述任一标的阻断 | 组合结果不发布 | 「组合结果因 {symbols} 不在支持范围/缺价被阻断，不按剩余标的重算。」 | 收口包 §5.1 原文 |
| 公司行为 | **引擎无错误码** | 不得显示 `E_SHARE_EVENT_UNSUPPORTED`；300750 跨越 2023-04-26 不会被自动阻断 | 维持现状，等待 C/D 决策 | 收口包 §5.2 |

备注：
- 「不在支持范围」可在调用前预检，但**预检只用于文案归类**；发布与否仍以引擎结果为唯一门槛，避免 UI 与引擎两套判定分叉。
- 现有 `runSyntheticMarketStage` 的范围外消息写死「合成行情缓存」（`src/demo/adapter.js:110`），真实模式必须改为来源参数，否则会把真实支持的标的错标成合成夹具。
- 范围声明（签收后把「草案·演示口径」替换为已签收字样）：
  「当前行情缓存支持 600519 / 300750 / 601318，2023-01-01 至 2025-12-31；快照为 2026-10-13 抓取（已签收 {accepted_date}）。」
  签收前仍显示：「……（草案·演示口径，未签收）。」

### 1.7 数据模式标注（保持三模式可区分）

| 模式 id（建议） | 账单 | 行情 | 建议 label | 可用时点 |
|---|---|---|---|---|
| `synthetic_demo`（现有） | 演示账单 | 合成夹具 | 合成演示数据 | 现在 |
| `user_bill_synthetic_market`（现有） | 用户本地 CSV | 合成夹具 | 用户本地账单 + 合成演示行情 | 现在 |
| `user_bill_real_cache`（新增） | 用户本地 CSV | 签收后的真实缓存 | 用户本地账单 + 真实行情缓存（已签收） | 签收后 |

- 「演示账单 + 真实缓存」是否作为第四模式或替换演示源，属产品口径决定，本预案不假设；若需要，复用同一 `marketSource` 参数即可。
- 页面状态条、来源说明、范围声明必须由 `dataMode/marketSource/supportScope` 驱动，删除写死的「m0 合成夹具」；未签收字样只在 `signed=false` 时出现。

### 1.8 改动清单与归属（签收后执行）

| 文件/区域 | 变更 | 归属 | 备注 |
|---|---|---|---|
| `src/engine/marketCache.js` | `assessCacheDoc`（可选放新文件）；`fromPullDraft` 返回治理元数据 | 主线 A | 纯函数＋单测；不读网络 |
| `tests/market-cache.test.mjs` | signed/unsigned/malformed 门测试 | 主线 A | 使用独立 signed 小夹具 |
| `src/demo/adapter.js` | 来源参数、真实加载器、共享市场段参数化、输出字段、模式 | 主线 B | 跨区：先给接口建议再改，或由 B 实施 |
| `src/ui/views/reportView.js` / `styles.css` | 状态条与范围声明按字段渲染 | 主线 B | 删除写死合成文案 |
| `scripts/smoke-frontend.mjs` | 签收后真实模式 smoke（用 signed 夹具） | 主线 B（共享文件先通气） | 签收前不改现有断言 |
| `data/market-cache.json` | 签收时写入 `frozen:true` 与 `sign_off` | 主线 A＋changer | 不得在签收前伪造 |
| `m0/market-cache/manifest.candidate.json` | `sign_off` 落档、版本递增 | changer | 治理记录 |
| `package.json` | 预计无需改动 | — | 若新增测试脚本需在 #13/#17 说明 |

接入为**独立 PR**（#13 要求），不与 300750 数据变更、契约或行为参数替换混改。

### 1.9 验证计划

1. 引擎测试（A 侧）：
   - 未冻结 → `NOT_FROZEN`；无 `accepted_by` → `NOT_SIGNED`；缺字段 → `MALFORMED`；完整 signed 夹具 → `usable:true`。
   - 现有草案 7 项测试保持通过（证明数据形状与取价不变）。
2. adapter/smoke（B 侧，签收后）：
   - signed 测试夹具 + 用户账单：三标的正常发布；范围外标的→「不在支持范围」且组合阻断；范围内缺价日→「数据缺失」且不回退；末笔晚于估值日阻断；无静默回退。
   - 草案/签收两种范围声明字样正确；合成模式断言不回退。
   - `npm run check`、`npm run smoke` 全过；远程无 CI 时如实记录「no checks reported」。
3. 浏览器联测（B 侧执行，主线 A 提供数据与预期）：模式切换、状态条、范围声明、四类阻断、组合不出部分结果。
4. 验收证据分开记录：实现 / 测试通过 / 页面接入 / 最终验收（#8 规则）。

### 1.10 风险与未决

- **A–E 全部未决**：B 影响估值日，C/D 影响公司行为与用户账单风险，E 影响文案；本预案已按候选口径写死待替换点，不替代决策。
- **用户账单跨 300750 事件的风险**：即使缓存签收，v1 也不会检测股数事件；若用户账单的 300750 持仓跨越 2023-04-26，结果可能失真。A 方案下这是披露/界面提示问题（B 侧），C 方案若采纳「立即补检测」则由 A 侧实现。该风险不能靠真实缓存接入自动消除。
- **签收元数据打包**：若仍把 `sign_off` 只留在 m0 manifest，产品门需要跨文件校验；建议按 §1.2 嵌入缓存件，需签收方确认。
- **共享文件**：`scripts/smoke-frontend.mjs`、`package.json` 的改动需按 #8 先在对应 Issue/PR 说明范围。

---

## 2. 300750 两方案技术预案（等 A/C 决策执行）

### 2.1 事实基础

- 300750（宁德时代）在 2023-04-26 出现送转量级复权跳变：前复权比值 0.4998→0.9105（≈×1.8215）；不复权收盘 385.90→224.50（≈×1.72）——远超现金分红步长，疑似送转类股数事件；事件性质与识别依据为 M3 未决项（`manifest.candidate.json` `adjustment_basis`、`data/market-cache.pull-record.json`）。
- 引擎 v1 **不支持**送转/拆合股（B5）；无 `E_SHARE_EVENT_UNSUPPORTED` 产品实现（收口包 §5.2 逐字证据）。持有区间跨越该事件不会被自动阻断。
- 300760（迈瑞医疗）已扫描为 2023–2025 无 ≥0.05 跳变的候选（manifest `field_status` R1 备选）。
- 当前演示账单为合成代码（000000/888888），不受影响；风险集中在真实缓存签收后的真实标的账单/示例。

### 2.2 方案 A：维持三只名单 + 演示避让

技术约束（精确规则）：
- 300750 的任一持仓区间不得覆盖 2023-04-26（含该日）。等价可执行规则：**300750 的全部交易日期均 ≥ 2023-04-26（买入发生在事件后）**，或全部交易均 ≤ 2023-04-25 且估值日也在事件前（当前 asOfDate 2025-12-31 不满足后者）；前者是本数据集下的唯一简便安全形态。
- 真实缓存演示账单/示例：300750 首笔买入必须是 2023-04-26 或之后；不得存在事件前买入、事件后卖出的持仓。
- 用户本地 CSV：无法强制。v1 若无检测，必须如实披露「跨 2023-04-26 的 300750 持仓超出支持范围」，且不能自动给出可信结果；建议（需 C 决策）至少在 UI 增加静态提示或阻断，依据已知事件清单，而非猜测价格。
- 若 C 决策改为「立即补事件检测」：事件清单、字段与错误码按 m0 schema 候选实现；本预案不预设实现。

实施清单（A 方案）：
1. 在演示/示例账单说明中写明避让约束（负责演示数据的人执行）。
2. UI 支持范围声明维持三只标的；公司行为限制条款展示（现有 §3 限制第 3 条）。
3. （建议）真实模式下对 300750 交易区间做**静态事件提示**，文案标注「已知股数事件，当前版本不校正」；是否阻断由 C 决策。
4. 验证：构造一笔 2023-04-26 后买入的 300750 演示账单 → 正常；构造跨越事件的反例 → 按最终 C 决策表现为「提示」或「阻断」，不得静默算出结果。
5. 回滚：仅文档/文案，无数据变更。

风险：用户账单的跨事件场景仍可能失真；需要明示限制。

### 2.3 方案 B：替换 300750 → 300760

实施步骤：
1. 修改 `scripts/pull-market.py:34-35`（`SYMBOLS`/`SYMBOL_NAMES`），重新拉数（akshare 本机环境；失败即停、不换源）。抓取时间将变化，`snapshot_id/fetch_time` 随之更新。
2. 重跑硬校验与跳变扫描：727/727 行、日历内缺失 0、序列日期一致、OHLC 包络；确认 300760 无 ≥0.05 复权跳变（重点验证候选结论）。
3. 更新 `data/market-cache.json`、`data/market-cache.pull-record.json`、`m0/market-cache/manifest.candidate.json`（symbols/names/adjustment_basis 观测③/caveats/field_status/evidence_summary；manifest 版本递增，签收状态重新归零待签）。
4. 更新引用（全仓 300750 共 11 个文件，2026-10-17 检索）：
   - 数据与脚本：`data/market-cache.json`、`data/market-cache.pull-record.json`、`scripts/pull-market.py`
   - 测试：`tests/market-cache.test.mjs:103-105`
   - 文档：`m0/market-cache/manifest.candidate.json`、`docs/yinchen/m0c2-signoff-package.md`、`docs/yinchen/engine-wiring-handoff.md`、`docs/yinchen/m0c1-interface-opinions.md`、`docs/yinchen/m2c4-drill-prep.md`、`docs/yinchen/yinchen-task-plan.md`、`docs/wuhanjing/m0c1-ui-interface-confirmation.md`
   - 页面范围文案（B 侧）：支持标的列表与范围声明。
5. 验证：`npm run check`（含真实缓存结构核验与三标的取价直读）；`npm run smoke`；签收件重新复跑证据（混合标的阻断、快照）；`300750` 残留检索为 0（历史留档文件除外需说明）。
6. 回滚：整包回退数据与 manifest 版本（数据文件已入库）。

风险：新快照与旧签收材料需重新签收；300760 的现金分红/其他事件仍需按同一口径披露；文档引用多，遗漏会造成口径不一致。

### 2.4 对比与建议

| 维度 | A 避让 | B 替换 300760 |
|---|---|---|
| 数据重拉 | 不需要 | 需要（新快照、重签） |
| 引擎改动 | 无（除非 C 采纳检测） | 无 |
| 改动面 | 演示约束＋文案/披露；可能 1 处 UI 提示 | 11 个文件（数据、脚本、测试、文档、UI 范围） |
| 已知事件风险 | 保留，依赖避让与披露 | 对 300750 消除；需重新核验 300760 |
| 用户账单安全性 | 仍可能遇到跨事件失真 | 支持范围内不再有该标的 |
| 工期 | 低 | 中（拉数＋全量回归＋重签） |

不替负责人选择。工程视角补充：若目标是演示稳定且签收最快，A 成本最低；若目标是降低用户账单失真风险、彻底移除已知不支持场景，B 更干净，但需要重新签收。

---

## 3. 契约哈希占位替换预案

### 3.1 现状

- 算法：`HASH_ALGORITHM = 'fnv1a64-placeholder'`（`src/engine/contractMatch.js:25`），实现为同步 FNV-1a 64 位（`:52-63`）。
- 覆盖：`contract-canonical-1` ＝ `{schema, template_id, kind, comparator, threshold, window_days, text}`（`:135-143`），哈希＝固定字段序 JSON 的 FNV-1a，16 位十六进制（`:155-156`）。
- 消费：`parseContract` 返回 `hash/hash_algorithm`；`matchContract` 回显 `contract_hash`；测试断言占位算法名、16 位格式、确定性、参数变化、R4 往返（`tests/contract-match.test.mjs:36,44,85-93,120`）。
- UI：契约页仍是演示级，版本记录写死 `hash:'未接入'`（`src/ui/views/contractView.js:25,73`），未消费引擎哈希；`state.js` 仅持久化演示版本记录。
- 基线要求：R4「立约→刷新→恢复且哈希一致→匹配仍触发」；契约状态接口要求 `{文本, 阈值, 哈希, 版本, 状态机, 申报记录}`（`docs/implementation-baseline.md:160,173`）。**算法与覆盖字段未冻结**（M0 §4-7）。

### 3.2 冻结后替换步骤

1. **确认冻结内容**：算法名/实现、覆盖字段、编码与规范化规则、版本字段、是否跨算法可比较。
2. **接缝改造**：把哈希计算收敛为单一函数 `computeContractHash(canonical)`（同步优先）。若冻结算法只有 `crypto.subtle`（异步）且仓库坚持零依赖，需要：
   - 优先纯 JS 同步实现，保持 `parseContract` 同步 API；或
   - 若只能异步，新增异步入口并迁移调用方——这属于 API 变更，必须在 #13/#8 说明，不能悄悄改签名。
3. **canonical 版本管理**：
   - 覆盖不变 → 保持 `contract-canonical-1`，仅换算法；旧哈希不宣称与新哈希相等。
   - 覆盖变化 → 升 `contract-canonical-2`，明确不跨版本比较；哈希结果附 `canonical_version`。
4. **存储与迁移**（与 B 侧 UI 接线一起）：
   - 持久化必须保存 `{template_id, fields, canonical, hash, hash_algorithm, canonical_version, version, status, at}`；只存哈希无法在新算法下复核。
   - 升级时对可解析的旧记录保留原算法标签，标记「旧算法/需复核」；不得静默改写为正式哈希。
5. **展示**：冻结前继续标注「候选哈希（fnv1a64-placeholder）」；冻结后显示正式算法名与 canonical 版本。契约页不得把占位哈希显示为正式版。
6. **匹配语义不变**：`matchContract` 只回显哈希，替换不得改变触发判定、阈值或文案。

### 3.3 测试影响与验收

- 必改：算法名断言、格式断言（若新哈希非 16 hex）、R4 往返测试。
- 必留：同内容确定性、参数变化敏感、不同模板不同哈希、匹配仍触发。
- 新增：跨算法隔离（旧哈希＋新算法不判等）；canonical 版本不同不比较；存储往返用 canonical 重算一致。
- 验收：`npm run check` 全过；UI 版本记录展示的算法状态与引擎返回一致；R4 场景（立约→刷新→恢复→匹配触发）有留档。未冻结前不实施。

---

## 4. 行为参数 candidate-1 转正预案

### 4.1 现状

- `PATTERN_CONFIG`（`src/engine/behavior.js:19-32`）：`version='candidate-1'`；追高买入 `lookback_days=5`、`rise_threshold=0.1`、`min_samples=2`；source 明示「候选占位，PRD 未到位」。
- `buildPatternList({ trades, market, config })` 已支持完整 config 注入（`:86`）；测试覆盖覆盖生效与三态联动（`tests/behavior.test.mjs:145-157`）。
- 输出携带 `config_version/config_source/threshold_meta`；notes 明示候选；UI 尚未接线（全仓无 `PATTERN_CONFIG` 的页面消费）。
- 口径要求：涵晶 §4.1 要求页面标注「参数版本 candidate-1，候选配置，直至负责人确认」。

### 4.2 转正步骤

1. 等负责人给出 PRD 确认值（回看窗口、阈值、最小样本、比较符）与正式版本号命名。
2. 仅改 `PATTERN_CONFIG` 的 `version`、`source`、三项参数；保留注入 seam 与 `listPatternDefinitions` 结构。
3. 更新测试：
   - 固定断言当前 candidate-1/5/10%/2 的用例改为正式值；
   - 保留 test-override 注入用例（证明无需改代码即可换参数）；
   - 新增边界用例：涨幅恰好等于阈值（`≥` 命中）、`evaluated_n` 与 `min_samples` 三态、窗口端点缺价→未评估、窗口早于缓存→未评估。
4. UI（B 侧）：把「候选配置」标签改为正式版本；历史结论若开始持久化，必须保存并展示 `config_version/threshold_meta`，不得用新参数静默重标旧结论。
5. 文档：更新 `engine-wiring-handoff.md` §3.5 与限制说明；`notes` 中删除「候选占位」措辞。
6. 验收：check 全过；同一组交易在旧/新配置下的差异可复算、可解释；页面标注与引擎 `config_version` 一致。

### 4.3 边界

- 只替换已确认参数，不新增其他行为模式（PRD 模式清单未到位）。
- 升版本后不改变三态语义与「不利结论照实」原则。
- 无历史持久化数据，当前无迁移负担；一旦 UI 开始存储，按 4.2-4 执行。

---

## 5. 证据索引

| 证据 | 位置/命令 |
|---|---|
| 草案缓存引擎测试（7 项） | `tests/market-cache.test.mjs:82-113`；`npm run check` |
| 草案签收状态 | `m0/market-cache/manifest.candidate.json`（`sign_off` 全 null）；`data/market-cache.json`（`frozen=false`，无 `sign_off`） |
| 真实数据形状适配 | `src/engine/marketCache.js:83-86`；草案范围/取价/快照由 `tests/market-cache.test.mjs:82-113` 覆盖 |
| 300750 事件观测 | `m0/market-cache/manifest.candidate.json` `adjustment_basis`；`data/market-cache.pull-record.json` |
| 契约哈希占位 | `src/engine/contractMatch.js:25,52-63,135-156`；`tests/contract-match.test.mjs:36,44,85-93` |
| 契约 UI 占位 | `src/ui/views/contractView.js:25,73` |
| 行为 config 注入 | `src/engine/behavior.js:19-32,86`；`tests/behavior.test.mjs:145-157` |
| 文案与限制（草案） | `docs/yinchen/m0c2-signoff-package.md` §4、§5.1、§5.2 |
| 本次验证 | `npm run check` 798/798（17 脚本）；`npm run smoke` 52/52；远程 no checks reported（未配置） |

---

## 6. 与 #13 三项对照

| #13「当前可独立开展」 | 本文对应 | 状态 |
|---|---|---|
| 缓存接入 PR 前置设计与文案联动对齐（阻断三类文案、范围展示字段——与涵晶 §3.1 对齐） | §1（1.1–1.10） | 完成（设计） |
| 契约哈希冻结后的占位替换方案、行为参数（candidate-1）转正后的替换预案（仅准备） | §3、§4 | 完成（设计） |
| 300750 两方案（避让/替换 300760）技术预案（等签收决定执行） | §2 | 完成（设计） |

本文件不实施任何未确认口径；待 A–E、M0-C1 冻结或 PRD 参数到位后，按上述清单在独立 PR 中执行。
