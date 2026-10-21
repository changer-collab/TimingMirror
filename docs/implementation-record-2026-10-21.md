# TimingMirror 非 Agent 缺口实现记录

> 日期：2026-10-21  
> 分支：`feat/user-gaps-2026-10-21`  
> 基线：`origin/main` `0295e76`（PR #39 合并后）  
> 范围：除 Agent 外的用户端缺口；未修改 `src/agent/`，未上传/提交任何原始 CSV 或账户数据。

---

## 0. 结论摘要

本分支把“有引擎、没用户入口”的部分接到了真实账单路径：

1. **真实报告补齐诊断主线**：单笔幽灵线、收益瀑布、损耗归因排行、行为发现、PGR/PLR、规则候选 CTA、已发布事实与复核状态。
2. **连续用户画像落地**：每次打开已发布真实报告记录一次派生观察；跨账单保留最多 12 条历史与趋势；只存本地、只存派生统计。
3. **规则候选由证据生成**：从当前账单的“追高买入”行为发现映射到既有契约模板；只做模板预填，保存仍由用户确认；支持打开、忽略、恢复。
4. **修复红测试**：`tests/import-recovery.test.mjs` 在 Node 25 下的会话存储串用问题；仅改测试，未动 Agent 源码。
5. **回归全绿**：合并最新 `origin/main`（`0f80555`，PR #40）后，`npm run check` exit 0；日志内 41 个汇总段合计 1676 项检查通过、0 失败；`npm run smoke` 316/316。

边界保持不变：规则不自动交易、不改变报告结论；历史情境测试不是盘中实时提醒；补充图表均为候选口径，不进入已复核发布事实。

---

## 1. 交付明细

### 1.1 报告补充分析数据层（`src/demo/adapter.js`）

`loadUserBillReport` 的输出新增 `insights`：

- `portfolio`：组合指标重算、损耗分解、收益瀑布、单笔卖出反事实序列与失败明细；
- `behavior`：`buildPatternList` 的追高模式结果；
- `stock_self`：标的自身涨幅（首次买入日收盘 → 估值日收盘，按买入成本加权）；
- `pgr`：PGR / PLR / DE（候选口径）；
- `review_summary`：复核状态、发布/阻断/降级数量、`verify_id`、来源摘要。

关键闸门：

- 只有 `review.portfolio_published === true` 才生成任何补充图表与画像结论；
- 未发布时整体返回带原因的 `emptyUserInsights`，页面逐段显示“本次不生成”，不用示例数字补齐；
- 单笔反事实最多生成 24 笔，单笔失败只记录 `counterfactual_errors`，不阻断其他笔；
- 复用 `runUserMarketStage` 的同一份行情实例，不二次取价。

### 1.2 真实报告用户界面（`prototype/user-frontend/realReport.js`）

在原有差额卡、四指标卡之上新增：

- **01 单笔幽灵线**：选择要替换的卖出笔，逐日对照曲线；默认选中最新一条“完整序列”；图下明确“同一标的、同一段行情，只替换所选卖出笔”，并标注单标的候选口径，不是组合已发布事实。
- **02 收益瀑布**：本金 → 买入不动 → 择时损耗 → 实际；校验恒等式，不通过时明确提示不据此下结论。
- **03 损耗归因**：按标的聚合 + 逐笔卖出明细（数量、卖出价、估值收盘、损耗、占比）；展示序不等于因果结论。
- **04 行为发现**：三态（成立 / 不成立 / 证据不足）、样本数、已评估数、最小样本、判定口径、成交证据、阈值来源与 caveat。
- **05 PGR / PLR**：实现盈亏与纸面盈亏计数、PGR/PLR/DE、参考均值与候选口径说明。
- **06 规则候选**：由当前账单追高证据生成；可用时“用这个阈值打开规则编辑”，已有同类规则时引导查看，已忽略时引导到规则页恢复。
- **07 已发布事实**：按范围折叠展示事实、展示值、公式 ID；顶部来源 chips 保留账单、行情来源、截止日、估值日与复核状态。
- 第四卡改为独立的“标的自身涨幅（候选）”，不再重复“买入不动”；覆盖不足或部分缺价时明确不发布组合值。

画像观察在本页记录：每份已发布报告记录一次派生统计；组合未发布时不记录，并显示原因。

### 1.3 连续用户画像

新增纯模块 `src/engine/userProfile.js`：

- 快照维度：交易样貌、结果差距、行为证据、卖出倾向、规则使用；
- `profile_key` 只保存哈希（由标的集合、首末日期、成交笔数派生），不落地原始成交、文件名或 CSV；
- `mergeProfile` 保留最多 12 条历史观察，生成与上一次观察的趋势差值；
- `withRuleState` 同步规则使用维度，不增加观察次数；
- `withCandidateEvent` 记录候选的 `opened / dismissed / restored` 状态。

新增前端存储 `prototype/user-frontend/profileStore.js`：

- localStorage 键：`tm.profile.v1`；只存派生统计与候选事件；
- 去重键：`profile_key | 估值日 | verify_id`；同一会话同一报告只记一次；
- 本地记录损坏时按空画像处理，不影响报告与规则页。

新增画像面板 `prototype/user-frontend/realProfile.js`：

- 无账单：显示“先有账单，再有画像”，不填充示例；
- 组合未发布：本次不记录，并说明原因；若已有历史画像，明确“以下为最近一次已发布观察，不是当前账单结论”；
- 有画像：展示五个维度、与上次的趋势、最近 12 条观察、规则候选及操作；
- 加载失败：展示原因，不用示例补齐。

### 1.4 规则候选与 CTA

新增纯函数 `buildRuleCandidates`（`src/engine/userProfile.js`）：

- 当前只接已实现的 `chase_high_buy`（追高买入）模式，不虚构其他模式；
- 模板：`no_buy_on_surge`，阈值 = `Math.round(pattern.rule.threshold * 100)`；
- 状态：`available`（可建立规则）、`active`（已有同类规则）、`dismissed`（已忽略）、`not_recommended`（不推荐）；
- 候选理由、证据行、阈值来源、caveat 全部展示；
- 明确写出“模板判定当天涨幅，行为发现使用前 5 个交易日回看窗口，两者不是同一口径”，阈值与文本可由用户改写。

新增前端桥接 `prototype/user-frontend/ruleCandidates.js`：

- 复用既有契约弹窗与 `contractTemplates()`，只预填模板字段；
- 写入 modal / draft / 导航到规则页，**不自动保存**；
- 打开前记录 `opened` 事件。

规则页顶部新增画像与候选区；报告页 CTA 与规则页 CTA 都进入同一个既有契约流程。保存、停用、版本记录仍由 `contractView` 负责，行为不变。

### 1.5 测试

新增：

- `tests/user-profile.test.mjs`：33 项（隐私边界、去重、历史上限、趋势展示、候选状态流转）；
- `tests/stock-self.test.mjs`：10 项；
- `tests/waterfall.test.mjs`：8 项；
- `tests/pgr.test.mjs`：9 项。

修改：

- `package.json` 的 `check` 脚本纳入以上 4 个套件；
- `tests/import-recovery.test.mjs`：5 处非持久化用例显式传 `storage: null`，并加一行原因注释；未改 Agent 源码。

---

## 2. 关键设计决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 标的自身涨幅口径 | 首次买入日收盘 → 估值日收盘，按买入成本加权 | 与“按用户实际买价持有”的买入不动区分；仍包含首次买入时点，页面如实说明；部分缺价时组合值不发布 |
| 补充图表发布闸门 | 只依赖 `review.portfolio_published` | 避免在复核阻断时展示未经复核的数字 |
| 幽灵线范围 | 单标的、同一段行情、只替换所选卖出笔 | 与现有 `replaceSell` 引擎能力一致；不冒充组合级反事实 |
| 幽灵线默认项 | 最新的一条完整序列 | 夹具中停牌日会产生缺 bar 警告；默认不落在不完整曲线上 |
| 画像存储 | localStorage、派生统计、12 条上限、哈希键 | 满足“连续画像”，同时不保存成交明细、文件名、CSV |
| 观察去重 | `profile_key + 估值日 + verify_id` | 报告页与规则页之间切换不会重复计数；同一报告的重复打开不膨胀历史 |
| 规则候选来源 | 仅当前账单行为发现，不接 LLM、不用其他用户 | 可解释、可回到成交证据；不越过“镜子不替你定规矩”的边界 |
| 候选保存 | 模板预填，用户确认后保存 | 复用既有契约流程，避免新增第二套规则写入路径 |
| PGR/PLR | 作为候选补充口径接入真实报告 | 引擎已存在；但阈值/基准仍需负责人确认，不进入已发布事实 |

---

## 3. 验证记录

### 3.1 自动测试

```text
npm run check   → exit 0
                  日志内 41 个汇总段合计 1676 项检查通过、0 失败
npm run smoke   → 316/316 通过

node tests/user-profile.test.mjs    → 33/33
node tests/stock-self.test.mjs      → 10/10
node tests/waterfall.test.mjs       → 8/8
node tests/pgr.test.mjs             → 9/9
node tests/import-recovery.test.mjs → 45/45
```

以上为合并 `origin/main` `0f80555`（PR #40：规则模拟闭环与主动结果解释）后的结果。合并仅冲突 `package.json` 的 `check` 脚本，已同时保留双方新增套件；`src/demo/adapter.js` 自动合并，回归全绿。

### 3.2 浏览器手工验证

环境：本地 `npm run dev`，`prototype/user-frontend/index.html`，动态行情使用浏览器内 mock 快照（非真实 Tushare token 全链路）。

已验证路径：

1. 导入并确认 `demo-bill.csv`，打开真实报告：差额卡、四卡、幽灵线、瀑布、排行、行为、PGR、事实表均渲染。
2. 重新加载后导入 `chase-high.csv`，mock 行情覆盖合约所需标的与日期范围，打开报告：
   - 实际 +0.0%，买入不动 +2.2%，损耗 ¥500 / +2.2pp；
   - 标的自身涨幅 +1.8%；
   - 行为发现“追高买入”成立 2/2，证据窗口涨幅 +12.0% / +10.8%；
   - PGR 0.00 / PLR 1.00 / DE -1.00；
   - 出现“可建立规则”的候选。
3. 点击“用这个阈值打开规则编辑”：进入规则页，契约弹窗预填“涨幅超阈值不买入”，阈值 10，文本为“当天涨幅超过 10% 的票，我绝不买入。”；未自动保存。
4. 用户保存后：画像规则维度变为“当前 1 条 / 版本 1 条”；候选变为“已有同类规则”；历史情境测试展示支持标的（300750、600519、601318、000000）与日期范围 2024-09-23 至 2024-10-11。
5. 停用当前规则：候选回到“可建立规则”，出现“打开模板确认 / 忽略这条候选”。
6. 忽略候选：显示“已忽略”与“恢复候选”；恢复后重新回到“可建立规则”。
7. 画像：2 次观察、趋势（损耗差额 -¥200、成交 -2、行为命中 +2、规则变化 0）、历史表均正确。
8. 无账单空态：直接渲染 `renderRealProfile`（空账单上下文）→ 显示“先有账单，再有画像”与导入链接，无示例数据。
9. 控制台无报错；`real-insights.css` 通过样式表加载，关键类计算样式生效。

### 3.3 未覆盖/限制

- 浏览器验证的行情为 mock 动态快照，未用真实 Tushare token 重放；真实行情链路由现有 market 服务端测试覆盖。
- 截图工具在当前内嵌浏览器返回 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，视觉验证以快照结构、文本与 computed style 为准，未做像素级比对。
- 未做多浏览器（Safari/Firefox）兼容测试；未做真实移动设备测试（内嵌视口 858×620 下已渲染）。

---

## 4. 过程中发现的新问题与处理

| 问题 | 根因 | 处理 |
|---|---|---|
| `tests/import-recovery.test.mjs` 基线失败：`resolveFirst is not a function` | Node v25 暴露全局 `sessionStorage`，未显式传 storage 的用例自动恢复了前面用例的 flow，预算已耗尽，transport 未被调用 | 仅测试修复：5 处非持久化用例传 `storage: null`，加注释说明；Agent 源码未动 |
| 幽灵线出现缺 bar 警告（000000 2024-10-10） | 测试夹具故意缺少该交易日 bar（停牌语义），默认选中该笔时序列不完整 | UI 默认改选最新的一条完整序列；文案从“同一份账单”改为“同一标的”，不再夸大范围 |
| 动态行情 mock 被 `MALFORMED (fetched_at)` 阻断 | 校验器要求 `fetched_at` 以 `Z` 结尾，mock 使用了 `+08:00` | 测试 mock 改为 UTC `Z`；真实 Tushare 生成逻辑不变 |
| 契约视图报 `MALFORMED (symbols.coverage)` | 本地账单合约范围包含演示标的 600519/300750/601318，fixture mock 只覆盖了账单标的 | 浏览器 mock 按请求的每个标的合成 bars；仅测试环境问题 |
| 已发布事实表中 `sellProceeds` 显示为 `"11000"` | 该事实没有 `display` 字段，当前 `displayOf` 回退到原始 `value` | **未修**，记录为遗留展示问题；需要事实层补展示值或按 key 做安全的货币格式映射 |
| 真实报告仍没有“每个数字回到成交行” | 当前事实表只有事实、展示值、公式 ID；逐笔 provenance 映射未实现 | **未做**，记录为剩余缺口；现有来源 chips + 复核状态 + 公式 ID 是最小版 |
| 演示报告第四卡仍为 +18.92%，与买入不动相同 | 演示页是静态示例，未接 `computeStockSelf` | **未改**，记录为待拍板：要么给演示页接入独立口径，要么改标题并说明是示例 |
| 浏览器自动化点击 shadow DOM 按钮报 “covered by another element” | 工具在 shadow root 内的命中判断限制；`root.elementFromPoint` 确认按钮实际位于最上层 | 功能验证改用页面内 `el.click()`；不是产品缺陷，未改样式 |
| 规则候选阈值口径差 | 行为发现用“买入日前 5 个交易日窗口”，模板用“申报当天涨幅” | UI 与纯函数均显式写出差异，允许用户改写；是否新增“回看窗口”模板需产品拍板 |
| 现有 `README` / `CAPABILITY` 与真实能力不一致 | 历史文档未随实现更新 | **未改**，避免与组长正在进行的 Agent 工作冲突；记录为剩余文档项 |

---

## 5. 仍未完成 / 需他人拍板

Agent 相关（按约定未动，留给组长）：

- 5 个对话芯片、“最错一笔 / 为什么追高 / 怎么改 / 我是谁”、对话内规则推荐、登记式应答；
- planner 12 意图接线、相似情境检索；
- 对话读取已保存规则。

非 Agent 但本次未做：

- 事实级“回到成交行”的 provenance 展开；
- 演示报告第四卡口径统一；
- 实时交易前提醒（当前只有历史情境模拟，需券商/行情通道，不建议在剩余时间内承诺）；
- README、CAPABILITY、Slogan/首屏文案等需负责人统一决策的材料；
- 事实表货币展示格式的通用修复（见上表）。

可交接给 Agent 的现成接口：

- `buildRuleCandidates(...)`：给定行为发现、规则状态与画像，返回候选及证据；
- `recordCandidateEvent(...)` / `loadProfile()`：画像与候选状态；
- 报告页 CTA 已可直接调用 `openRuleCandidate(ctx, candidate)`，Agent 后续只需生成/引用同样的候选结构。

---

## 6. 变更文件

新增：

- `src/engine/userProfile.js`
- `src/engine/stockSelf.js`
- `src/engine/waterfall.js`
- `src/engine/pgr.js`
- `tests/user-profile.test.mjs`
- `tests/stock-self.test.mjs`
- `tests/waterfall.test.mjs`
- `tests/pgr.test.mjs`
- `prototype/user-frontend/profileStore.js`
- `prototype/user-frontend/realProfile.js`
- `prototype/user-frontend/ruleCandidates.js`
- `prototype/user-frontend/real-insights.css`
- `docs/gap-analysis-2026-10-21.md`
- `docs/implementation-record-2026-10-21.md`（本文）

修改：

- `src/demo/adapter.js`
- `prototype/user-frontend/realReport.js`
- `prototype/user-frontend/app.js`
- `prototype/user-frontend/index.html`
- `package.json`
- `tests/import-recovery.test.mjs`（仅测试存储隔离）

未修改：`src/agent/`、`server/`、任何行情 token / 原始 CSV / 账户数据。

---

## 7. 复现

```bash
# 全量检查
npm run check
npm run smoke

# 新增套件
node tests/user-profile.test.mjs
node tests/stock-self.test.mjs
node tests/waterfall.test.mjs
node tests/pgr.test.mjs

# 本地前端
npm run dev
# 打开 http://localhost:5180/prototype/user-frontend/index.html
```

浏览器复现真实报告需要已确认的本地账单；动态行情依赖本地代理/服务端配置。本次手工验证使用浏览器内 mock 动态快照，未提交任何 mock 数据文件。

---

## 8. 提交状态

- 分支：`feat/user-gaps-2026-10-21`，基线 `0295e76`；
- 已合并最新 `origin/main` `0f80555`（PR #40），合并提交 `43e97a8`；
- 实现提交：`53500a2 feat: 补齐非 Agent 用户报告、画像与规则候选`（逐路径暂存，未使用 `git add .`）；
- 文档提交：`82b16e2 docs: 记录非 Agent 缺口实现的本地提交号`；
- 变更范围即本记录第 6 节列出的文件；未包含原始 CSV、账户数据或行情 token。

---

## 9. 追加：报告页 UX 与多场景示例（`feat/report-ux-2026-10-21`）

> 基线：`main` `c52c103`（PR #42 合并后）
> 范围：仅报告页展示逻辑、示例场景与前端样式；未修改 `src/agent/`、`server/`，未改动真实账单链路与行情校验。

### 9.1 修复的显示逻辑

| 问题 | 处理 |
|---|---|
| 行为发现“不成立/证据不足”仍出现在用户报告 | 只在 `status === '成立'` 且 `sample_n > 0` 时渲染；其余状态完全不显示，不显示内部状态词 |
| 规则候选“不推荐”仍出现在用户报告 | 只在 `status === 'available'` 时渲染；`active`、`dismissed`、`not_recommended` 均不进入报告 |
| 卖出习惯样本不足仍展示 PGR/PLR | 仅在已实现卖出 ≥3 笔、纸面持仓 ≥2 只且指标可计算时展示 |
| 没有卖出的账单出现单笔对照、瀑布、归因和空图 | `hasSells` 为假时全部隐藏，只保留差额卡与核对数据 |
| `reportVisibility` 的布尔值被同名对象覆盖 | 改为 `pgr`/`candidate` 布尔开关，数据放到 `pgrData`/`candidateData`；新增测试防回归 |
| 脚注提到当前账单没有显示的“行为发现/卖出习惯/规则候选” | 仅在对应区块实际展示时出现补充口径说明 |
| 持平场景同时显示“与一直持有持平”和“择时差 +0.0pp 持平” | 持平场景只保留一个“账户结果”统计，避免重复 |

### 9.2 四套示例场景

新增 `src/demo/reportScenarios.js`，使用冻结的合成行情（`demo-frozen`），示例账单的交易价与行情完全一致，不再出现“示例成交价 vs 动态 Tushare 价格”错配。

| 场景 | 账单行为 | 报告应显示 |
|---|---|---|
| `chase` 追高止损 | 追高买入后止损，行为成立 | 单笔对照、瀑布、归因、行为发现、卖出习惯、规则候选、核对数据 |
| `early` 卖得太早 | 卖出后继续上涨，但未达行为阈值 | 单笔对照、瀑布、归因；隐藏行为、卖出习惯、规则候选 |
| `stop` 及时止损 | 卖出后继续下跌，损耗为负 | 单笔对照、瀑布、“改善来自哪几笔”；隐藏行为、卖出习惯、规则候选 |
| `hold` 一直持有 | 只有买入、没有卖出 | 差额为 ¥0，只显示持平卡与核对数据；无图、无单笔对照 |

导入页提供四张场景卡，点击只下载对应 CSV；用户再走正常上传、逐行核对、确认流程。上传时会按交易内容（日期/标的/方向/数量）或文件名识别场景，并把行情固定到该场景的冻结合成快照。示例报告不写入用户画像（`recordReportObservation` 跳过），避免演示数据污染本地画像。真实账单仍走 `dynamic-tushare`，行为不变。

新增 `tests/report-scenarios.test.mjs`（37 项），覆盖四类账单的发布状态、区块显隐、损耗方向、候选状态、内部状态码泄漏，以及“下载 CSV → 本地解析 → 上传识别 → 报告展示”与直接示例结果一致的回归。`package.json` 的 `check` 已纳入该套件。

### 9.3 视觉与可读性

- 提升卡片对比度：`--gray`、`--faint`、边框与 `--loss` 加深；`.panel`、`.rp-card`、示例场景卡加入更明显的渐变和边界；行为/候选卡使用暖色底，瀑布使用深一档的轨道与柱色。
- 统一字号层级：正文说明 12.5px，卡片小字 11–12px，区块标题 `clamp(20px, 2.1vw, 25px)`，差额数字 `clamp(40px, 4.9vw, 64px)`；图表坐标轴 16px、图例 13px；移动端差额数字降为 38px。
- 收紧间距：报告区块 `clamp(30px, 3.6vw, 44px)`，区块头 padding 16px，卡片间距与内边距统一；1034px 视口无横向溢出。
- 图表数字格式化：坐标轴与提示框改用 `Intl.NumberFormat`，消除 `28560.000000000004`、`999999998` 一类浮点尾巴；负金额在 UI 层统一显示为 `-¥...`（`src/agent/numberCheck.js` 的旧格式未改）。
- 精简用户文案：归因表只默认展示前 3 笔，其余折叠；来源信息收进折叠区；删除重复的卖出笔数、空态说明与口径堆叠；报告底部只保留两行必要声明。

### 9.4 验证

```text
npm run check   → exit 0；42 个汇总段合计 1717 项通过、0 失败
npm run smoke   → 316/316
node tests/report-scenarios.test.mjs → 37/37
node tests/waterfall.test.mjs → 8/8
```

浏览器（本地 `npm run dev`，`index.html`，视口约 1034×620）逐场景验证：

- `chase`：6 个报告区块 + 核对数据，差额 ¥8,000；无“不成立/不推荐/证据不足”字样。
- `early`：仅 3 个区块；脚注不再提及隐藏区块；无行为/习惯/候选文案。
- `stop`：3 个区块，标题为“改善来自哪几笔”；差额 ¥2,400，方向为改善。
- `hold`：无报告区块与图表；差额 ¥0；仅一张“账户结果”统计；无横向溢出。
- 图表坐标轴显示 `33,600`、`13,370` 等格式化值；提示框金额为 `¥25,234.50`。
- 四个场景切换均无控制台报错。
- 下载并上传 `示例场景-追高止损.csv`：本地解析 6 行、显示“本地校验通过”；确认后报告标题为“示例场景 · 追高止损”，行情标签为“合成行情 · 非真实行情”，差额 ¥8,000，行为发现、卖出习惯与规则候选均正常出现。
- 下载按钮实测生成 7 行 CSV（表头 + 6 笔交易），文件名与场景一致；下载后卡片提示改为“拖回左侧导入”。

内嵌浏览器截图接口两次尝试均返回 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`（`visibilityState=hidden`），并已尝试 `bringToFront`；本次视觉验收以 DOM 结构、文本与计算样式为准，未做像素级比对。

### 9.5 本轮发现的新问题

| 问题 | 根因 | 处理/状态 |
|---|---|---|
| 旧示例报告用固定示例成交价，但行情走动态 Tushare | 示例账单不是同一市场快照生成 | 示例改为冻结行情 + 同源账单；真实账单仍用动态行情 |
| `reportVisibility` 返回值被同名对象覆盖 | 对象字面量后写键覆盖前写布尔值 | 已修复并加测试 |
| 幽灵线坐标轴/提示框出现超长浮点数 | 直接拼接原始浮点值 | 已用 `Intl.NumberFormat` 格式化 |
| 仅改 hash 时页面沿用旧 ES 模块实例 | 单页应用模块缓存 | 验收改用整页刷新；产品运行不受影响 |
| 持平账单右侧三栏与标题重复 | 固定三栏模板 | 持平场景改为单栏“账户结果” |
| 演示场景卡只描述剧情，不说明会看到哪些区块 | 场景元数据只有标题/标签 | 卡片保留简短标签；详细差异由报告本身呈现 |
| 示例场景卡片点击后绕过上传与核对 | 直接构造已确认账单进入报告 | 改为下载 CSV；上传后仍走本地解析、核对、确认，并保留示例行情标记 |
| PGR/行为/候选的显示阈值可能需要产品确认 | 当前采用“成立 / 可用 / 最小样本”三条硬门槛 | 已写入测试；阈值调整时需同步更新测试与文案 |

### 9.6 本轮变更文件

新增：

- `src/demo/reportScenarios.js`
- `tests/report-scenarios.test.mjs`

修改：

- `src/demo/adapter.js`
- `src/engine/waterfall.js`
- `src/ui/components/ghostChart.js`
- `prototype/user-frontend/app.js`
- `prototype/user-frontend/realImport.js`
- `prototype/user-frontend/realReport.js`
- `prototype/user-frontend/real-insights.css`
- `prototype/user-frontend/styles.css`
- `package.json`
- `tests/waterfall.test.mjs`

未修改：`src/agent/`、`server/`、任何行情 token、原始 CSV 或账户数据。

### 9.7 提交状态

- 分支：`feat/report-ux-2026-10-21`，基线 `c52c103`；
- 当前变更仍在工作区，未提交、未推送、未发布站点；
- 提交时按路径逐项暂存，不使用 `git add .`。
