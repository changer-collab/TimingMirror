# M0-C2 缓存签收收口包（任务 B / Issue #13）

- 版本：v2（2026-10-19 签收落档）· 原 v1 2026-10-15
- 提交人：尹辰（数据侧）
- 签收人：changer（负责人）；决策人：尹辰（经组长授权，方式一授权代行签收）
- 关联：Issue #13（任务 B）；`m0/market-cache/manifest.candidate.json`（已签收，frozen=true）；`m0/market-cache/schema.candidate.json`（候选接口；缓存清单已签收，八类接口整体仍未冻结）；`data/market-cache.json`（`artifact=market-cache-signed`）；涵晶 `docs/wuhanjing/m0c1-ui-interface-confirmation.md` §8.2 两项待确认
- 定位：把真实行情缓存的支持边界收口为「明确候选清单 + 验证依据 + 限制」三件套。**2026-10-19 已按 A1/B1/C1/D1/E1 签收**；本文件保留原始证据与决策记录。
- 注意：GitHub 上没有组长授权 A–E 的书面评论留痕；授权来源为用户 2026-10-19 转述，落档时在 `sign_off.authorization` 中如实记录。M0-C1 八类接口整体冻结仍未完成，缓存清单签收不等于接口冻结。

---

## 1. Issue #13 六项收口对照表

| # | #13 收口项 | 结论 | 依据 |
|---|---|---|---|
| ① | symbols / date_range / asOfDate 最终值 | 已签收：A1（维持三只）、B1（asOfDate=2025-12-31）、R4 date_range 不变 | §2 R1/R4/R7；`manifest.candidate.json` field_status |
| ② | data_source / calendar_source / pull_evidence 具名值 | 已具名（akshare 1.18.64 两个具体接口 + 运行记录文件与快照号） | §2 R2/R3/R5；`data/market-cache.pull-record.json` |
| ③ | adjustment_basis 实际值及核验记录 | 已记录（qfq 抓取时点快照口径 + 三项观测；核验记录含差异日数、一致段起点、跳变扫描） | §2 R6；pull-record `qfq_obs` / `adjustment_basis_obs` |
| ④ | 公司行为边界 + 生效日口径（登记日 vs 除权日） | 已签收：C1（v1 不实现事件检测，约定避让 + 如实标注）；D1（未来事件生效日锚定除权日） | §4-C/D；`schema.candidate.json` share_events.v1_support（B5） |
| ⑤ | 300750 2023-04-26 处置 | 已签收：A1 维持名单 + 演示账单避开跨越该日的持有区间（备选替换 300760 未采纳） | §2 R1 备注；pull-record 观测③；换标的扫描记录（666a24e） |
| ⑥ | 缺价语义最终文案 | 已签收：E1 采用 §5.1 三类文案（标的级/组合级/范围声明） | §5.1；引擎行为证据见 §5.1 附 |

状态四态标注（按 Issue #13 口径）：

| 维度 | 状态 |
|---|---|
| 材料已提供 | ✔（本文件 + manifest + pull-record + 拉数脚本，均已在仓库） |
| 数据已验证 | ✔（拉数脚本硬校验 PASS、结构核验并入 `npm run check`；复权口径按 R6 观测签收） |
| 负责人已签收 | ✔（2026-10-19，方式一授权代行；`sign_off.accepted_by=changer-collab`、`accepted_date=2026-10-19`） |
| 产品已接入 | ✘（签收已完成；产品接入须经 `assessCacheDoc` 签收门并按独立 PR 进行） |

---

## 2. 七字段签收表（R1–R7）

| 编号 | 字段 | 值 | 性质 | 依据 / 证据 |
|---|---|---|---|---|
| R1 | symbols | `["600519","300750","601318"]`（贵州茅台 / 宁德时代 / 中国平安） | 已签收（A1，2026-10-19） | 跨板块 3 只大市值示例（沪主板消费 / 创业板制造 / 沪主板金融）。300750 含 2023-04-26 送转量级跳变（不复权收盘 385.90→224.50，单日 −41.82%；前复权 192.89→204.40，+5.97%）——按 A1 维持名单，演示账单避开跨越该日的持有区间；用户账单跨事件风险如实披露（C1：v1 不检测）。 |
| R2 | data_source | `akshare 1.18.64 · stock_zh_a_hist（东方财富行情口径）` | 已核事实 | pull-record requests 12 条全部返回 727/727 行；脚本失败即停、不重试、不换源 |
| R3 | calendar_source | `akshare 1.18.64 · tool_trade_date_hist_sina（新浪交易日历口径）` | 已核事实 | pull-record calendar：全量 8797 行、区间内 727 行；逐标的 vs 日历缺失 0 日 |
| R4 | date_range | `2023-01-01 .. 2025-12-31`（实际首末交易日 2023-01-03..2025-12-31） | 已核事实 | 逐标的 727/727 行；`npm run check` 结构核验（两序列行数一致、日期集合相同、均在日历内） |
| R5 | pull_evidence | `data/market-cache.pull-record.json`（脚本 `scripts/pull-market.py`，抓取于 2026-10-13T09:54:02+08:00，硬校验 0 失败，verdict=PASS） | 已核事实 | pull-record hard_checks.passed=true；snapshot_id=pull-20261013-095402 |
| R6 | adjustment_basis | qfq 抓取时点快照口径；三项观测：① 2023–2025 区间两序列差异日数 727/727（三只均全差异）；② 近窗形态「最后一次除权除息前不同、其后与不复权逐日一致」（一致段起点 600519→2026-06-26、300750→2026-08-10、601318→2026-09-10）；③ 300750 送转量级跳变（≈×1.82） | 已核事实（观测项） | pull-record `qfq_obs`/`adjustment_basis_obs`；前复权值随抓取时点变化，早期展示必须标注快照口径（B6） |
| R7 | asOfDate | `2025-12-31` | 已签收（B1，2026-10-19） | = date_range.end；2025-12-31 为交易日（日历已核）。产品 v1 固定传此值（F-3） |

注：Issue #13 描述中「symbols/date_range/asOfDate 未提供」「data_source 等未填」的表述与仓库现状不符——七字段自 PR #5（2026-10-13）起已全部填写；该表述可能混淆了 `schema.candidate.json` 中拉数前留存的模板段（support_scope.manifest_fields，value:null「未提供」）。本包以 `manifest.candidate.json` 实际值为准。

---

## 3. 已知限制与边界（须随签收一并确认）

1. **公司行为检测未实现**：`src/engine/` 与 `tests/` 中不存在任何公司行为检测代码（§5.2 逐字证据）。v1 只支持「约定避让」——演示账单不得跨越含股数事件（送转/拆合股/配股）的持有区间；300750 的 2023-04-26 即属此类。
2. **前复权序列仅展示**：`bars_fwdadj` 只用于注明口径的走势展示；金额估值（actualValue/ghostValue）一律用不复权 `bars`；禁止拿前复权价格涨幅直接替代金额收益相减（B2）。
3. **缺价不回退**：effective_date 当日缺价即阻断该标的及依赖它的组合，不回落更早日期（B4）；引擎已按此实现（§5.1 证据）。
4. **R2 纪律**：缓存已于 2026-10-19 签收（`artifact=market-cache-signed`、`frozen=true`）；产品接入须经 `assessCacheDoc` 签收门并按独立 PR 进行。
5. **跳变扫描为启发式**：300760 等替换候选的「区间内无跳变」结论基于 |qfq/不复权比值日环比| ≥ 0.05 扫描（脚本内注释：送转量级；现金分红步长通常 <0.03 不触发）——为启发式核验，不声称穷尽全部事件。
6. **数据为公开行情**：不含任何账户/成交数据（R5）；近窗末行可能为盘中未收盘数据，未进入 2023–2025 缓存本体。

---

## 4. 决策项（A–E，2026-10-19 已签收）

| 编号 | 决策项 | 采纳结果 | 未采纳备选 | 影响 |
|---|---|---|---|---|
| A | symbols 最终值（300750 处置） | **A1**：维持三只名单 + 约定演示账单避开跨越 2023-04-26 的持有区间；用户账单跨事件风险按 C1 如实披露 | 替换 300750→300760（已扫描核验干净） | 演示账单设计；B5 阻断口径在演示中不触发（引擎无事件检测） |
| B | asOfDate 最终值 | **B1**：维持 2025-12-31（= date_range.end，交易日已核） | 其他日期（需重新核日历与账末日关系） | 产品 v1 固定估值日（F-3） |
| C | 公司行为边界落地方式 | **C1**：v1 维持「不支持 + 约定避让」，在页面/文档如实标注（现状） | 立即补事件清单 + 引擎阻断（建议 M3 后评估） | 演示约束强度；v1 无超出支持范围的自动判定能力 |
| D | 事件生效日口径（登记日 vs 除权日） | **D1**：未来事件检测锚定除权日（价格断层发生在除权日；避让判定以除权日为准） | 登记日（更保守，需事件数据源确认两种日期可得性） | 未来事件检测的口径定义（M3 未决项） |
| E | 缺价语义最终文案 | **E1**：采用 §5.1 定稿三类文案（标的级 + 组合级 + 范围声明） | 修改措辞后回 | 涵晶 UI 阻断提示接线；§8.2.2 回执 |

签收与授权记录：决策人尹辰（NanyuDeer），2026-10-19；授权来源为组长 changer 经用户转述授权 A–E 决策与代行签收（方式一），GitHub 无书面评论留痕，已在 `manifest.candidate.json` 的 `sign_off.authorization` 中如实记录。`accepted_by` 按方式一记为 `changer-collab`。

---

## 5. 回涵晶 §8.2 待确认两项

### 5.1 §8.2(2) 本地 CSV 标的与缓存不匹配的最终阻断语义 + 文案

引擎真实行为（2026-10-15 复跑留档）：以缓存为 `data/market-cache.json`、标的 `['600519','000001']`、估值日 `2025-12-31` 调用 `resolvePrices`：

```json
{
 "effective_date": "2025-12-31",
 "per_symbol": {
  "600519": { "blocked": false, "code": null, "close": 1377.18 },
  "000001": { "blocked": true, "code": "E_PRICE_MISSING", "close": null, "no_fallback_used": true }
 },
 "portfolio": { "blocked": true, "code": "E_PRICE_MISSING" }
}
```

要点：支持范围内标的正常取价；范围外标的按缺价阻断且 `no_fallback_used: true`（未回退其他日期）；依赖它的组合同样阻断，不按剩余标的（600519）重算后冒充完整组合。

UI 侧可区分两类情形（此前说明已提，此处定稿拟案）：

| 情形 | 判定方式 | 提示归类 |
|---|---|---|
| 标的**不在支持范围** | 请求标的 ∉ `cache.symbols`（可在调用前预检） | 「不在当前行情缓存支持范围」 |
| 标的在范围内但**当日缺价** | 引擎返回 `E_PRICE_MISSING` | 「数据缺失」 |

定稿文案（标的级，E1）：

> 该标的（{symbol}）不在当前行情缓存支持范围；其结果不可计算（未回退到其他日期取价）。

组合级：

> 组合结果因 {symbols} 不在支持范围/缺价被阻断，不按剩余标的重算。

范围声明（页面常驻/首次使用时展示）：

> 当前行情缓存支持 600519 / 300750 / 601318 三只标的、2023-01-01 至 2025-12-31；缓存为 2026-10-13 抓取快照（前复权 qfq 为抓取时点口径），清单已于 2026-10-19 签收（manifest-0.2）。

### 5.2 §8.2(3) 公司行为阻断实际返回字段/错误码

如实告知：**引擎当前不返回任何公司行为错误码**。逐字证据（2026-10-15 复跑）：

```
grep -rn "E_SHARE_EVENT" src/   → 无匹配
grep -rn "E_SHARE_EVENT" tests/ → 无匹配
grep -rln "E_SHARE_EVENT" m0/   → m0/market-cache/check-market-cache.mjs
                                  m0/market-cache/fixtures/scenarios.expected.json
                                  m0/market-cache/schema.candidate.json
```

即 `E_SHARE_EVENT_UNSUPPORTED` 仅存在于 m0 候选接口层（schema 候选错误码 + 合成夹具校验脚本），**产品引擎未实现**。UI 不得以该错误码为接线依据；300750 跨越 2023-04-26 也不会被自动阻断（v1 采用 C1：靠 §4-A 的演示约定避让 + 页面/文档如实标注）。该码在 M3 之前不会落地到引擎侧；若未来启用事件检测，按 D1 以除权日为生效日口径，并另行通知 UI。

---

## 6. 签收记录与后续

已执行（2026-10-19）：

1. `m0/market-cache/manifest.candidate.json`：`artifact=manifest-signed`、`frozen=true`、`version=manifest-0.2`；`sign_off.accepted_by=changer-collab`、`accepted_date=2026-10-19`、`mode=方式一：授权代行签收`；新增 `decisions` A1/B1/C1/D1/E1 与授权来源说明。
2. `data/market-cache.json`：升级为 `artifact=market-cache-signed`、`frozen=true`、`manifest_version=manifest-0.2`，内嵌同一 `sign_off`；行情数据本身未改动。
3. `m0/market-cache/schema.candidate.json`：support_scope 与 M1/M2/M3 指针同步签收状态（M3 为 D1/C1 口径）。
4. `m0/market-cache/check-market-cache.mjs`：原「未签收」断言改为签收态校验（frozen、sign_off、A–E 选择、data/manifest 一致性）。
5. `src/engine/marketCache.js`：新增 `assessCacheDoc` 签收门（`NOT_FROZEN`/`NOT_SIGNED`/`MALFORMED`），产品接入前必须通过；`tests/market-cache.test.mjs` 增补 6 项门禁测试。

后续：

- 产品接入（真实缓存替换合成夹具）走独立 PR；接入前联调继续沿用合成夹具（R2）。
- M0-C1 八类接口整体冻结仍未完成，缓存清单签收不等于接口冻结。
- 待办不受签收影响：R1/R2 浏览器演练（M2-C4）、行为参数候选-1 对齐、M2-C5 选型、M3 部署与材料；300750 演示账单避让需在演示脚本中落实（A1）。
