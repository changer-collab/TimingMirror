# M0-C1 接口冻结——吴涵晶 UI 消费接口意见

> 版本：v1（2026-10-15）  
> 提交方：吴涵晶（前端 UI / 交互）  
> 状态：**UI 侧确认草案，待 wcz 汇总三方意见并冻结**。本文确认前端消费字段、页面状态与不可静默隐藏的异常；不改变已批准口径，也不将任何 `candidate` 接口视为已冻结。

## 1. 确认范围与依据

本确认覆盖四页接线所需的 UI 消费接口：CSV 导入、行情与报告、证据/复核、契约。

- 引擎 I/O 依据：`docs/yinchen/engine-wiring-handoff.md` v1。
- 数据与计算候选依据：`m0/csv-input/schema.candidate.json`、`m0/market-cache/schema.candidate.json`、`m0/calc-baseline/schema.candidate.json`。
- 页面实现边界：页面只消费引擎返回值和状态；不在 UI 中重复 CSV 校验、行情取价、收益计算、反事实计算或契约匹配。
- 现有页面保留演示模式；在真实接线完成前，所有演示数字均继续标注为合成夹具，不得表述为用户账单的实时计算结果。

### 1.1 接线层归属与数据模式确认

前端确认采用“页面只调用适配层（`src/demo/adapter.js`），适配层内部调用引擎”的接线方式。这样四个 `views` 不需要分别了解缓存加载、计算顺序或演示夹具细节；真实数据接通后，只替换适配层内部实现并保持页面消费结构稳定。

页面必须区分并显式标注以下三种数据模式：

| 数据模式 | 数据来源与用途 | 页面必须显示的状态 |
|---|---|---|
| 合成演示 | `m0/market-cache/fixtures/` 与演示账单；用于功能走查 | “合成演示数据 / 非真实账户、非真实行情” |
| 用户本地账单 + 已签收缓存 | 本地 CSV + 已签收的静态行情缓存；正式主链路目标 | 文件名、估值日、支持范围、口径标签 |
| 用户本地账单 + 未签收缓存草案 | 本地 CSV + `data/market-cache.json` 草案；仅接线测试 | 行情清单草案·演示口径 |

确认：每次引擎接口或候选口径变更时，由尹辰在交接文档/PR 中同步；UI 接线需记录使用的接口版本和验证命令，不能静默依赖未说明的字段变化。

## 2. CSV 导入接口与页面确认

### 2.1 前端确认消费的结果结构

前端确认消费 `normalizeRows(parsed, sourceFile)` 的结果：

```js
{
  schema_version,
  source_file,
  blocked,
  trades,
  warnings,
  errors
}
```

交易列表至少展示 `trade_id`、`trade_date`、`symbol`、`side`、`price`、`quantity`、`fee`、`tax`、`fee_missing`、`tax_missing` 及 `source.{file,line}`。交易在导入预览中按原始文件行序展示；计算排序由引擎负责，页面不改写 `trade_id` 或 `source`。

### 2.2 页面状态与不可静默隐藏项

| 引擎条件 | 页面表现 | 是否允许进入报告 |
|---|---|---|
| `blocked === true` | 显示全部 `errors`（行号、错误码、说明）；保留 `warnings`；不显示部分交易结果 | 否 |
| `warnings.length > 0` 且未阻断 | 显示警告汇总与逐行标识；费用/税费缺失按 0 的事实必须可见 | 是，用户确认后 |
| `E_EMPTY` / `E_HEADER_MISSING` | 显示文件为空或必需列缺失的修正指引 | 否 |
| 精度、日期、方向、数量、超卖错误 | 显示所有可检测错误，不自动四舍五入、不静默修正 | 否 |

确认：CSV 原文只经浏览器 `FileReader` 读取并在本机解析；页面不上传原始文件或成交行。

## 3. 行情、报告与反事实接口确认

### 3.1 行情状态

前端确认消费 `market.resolveValuation`、`market.checkLastTrade`、`market.resolvePrices` 的以下字段：

- `requested_date`、`effective_date`、`blocked`、`code`；
- 缓存支持范围 `range.{start,end}`、支持标的 `symbols`、快照元数据 `snapshot`；
- 标的级 `per_symbol[symbol].{blocked,code,close,no_fallback_used}` 与组合级 `portfolio.{blocked,code}`。

以下条件必须中止受影响结果的展示，不能改用旧数字、其他日期或“剩余标的组合”冒充完整结果：

| 错误码/状态 | 必须展示的用户可见状态 |
|---|---|
| `E_VALUATION_OUT_OF_RANGE` / `E_NO_EFFECTIVE_TRADING_DAY` | 数据不在当前支持范围或无法确定有效交易日 |
| `E_VALUATION_BEFORE_LAST_TRADE` | 估值日早于账单最后一笔交易，无法估值 |
| `E_PRICE_MISSING` | 受影响标的及组合结果不可计算；明确“未回退到其他日期” |
| 未支持公司行为 | 受影响持有区间不可计算；不得以未校正价格继续输出 |

非交易日映射时，页面同时显示请求日期和实际采用的 `effective_date`。前复权序列仅用于走势展示，金额指标只使用不复权价格。

### 3.2 报告结果

前端确认消费 `computeIndicators({ trades, closes })` 的 `per_stock` 与 `portfolio` 结果。每个结果项至少使用：

```js
{
  buyCost, sellProceeds, heldShares,
  actualValue, ghostValue, actualRet, ghostRet,
  dragMoney, drag,
  display, formula_ids, recorded, drag_lines, dual_path
}
```

确认事项：

1. 指标卡、报告正文与对话可引用的展示数字一律使用 `display`，不由页面重新格式化或自行舍入。
2. `RESULT_LABELS` 的“未计入费用、税费”“分红未计入”等口径标注必须靠近结果可见。
3. “股票本身涨幅”口径尚未定义时，页面显示“口径未定义/—”，不临时计算或猜测。
4. 报告页应显示数据来源状态：合成演示夹具、用户本地 CSV、或“行情清单草案·演示口径”。未签收的行情清单不得表述为正式真实支持范围。

### 3.3 单笔反事实与图表

前端确认消费 `replaceSell` 返回的 `replace` 与 `series` 字段。图表仅接收单标的过滤后的交易数据；多标的输入、非法交易 ID、买入侧替换、缺价或日历外日期均应显示为无法计算，不能用猜测值填充。

确认的图表规则：

- `gap = cf - actual`，红色缺口为正表示该笔替换可挽回；负值表示该笔实际卖出优于持有，必须照实呈现。
- `points` 中的 `null` 缺价日采用断线/留空并附“缺少价格数据”说明；不得视觉上连成连续路径。
- 图表标题和图例应标注 S1“单笔卖出替换”口径，不能与其他反事实场景拼接为区间。

## 4. 行为、证据、复核与计算路径确认

### 4.1 行为发现

前端确认消费 `buildPatternList` 的 `patterns`、`hypotheses`、`notes`，并保留：模式名、`status`、`sample_n`、`evaluated_n`、阈值、检验方式、成交证据和 `unevaluated` 原因。

- “成立”“不成立”“证据不足”三态必须原样展示。
- 未评估成交必须列出数据不足/范围外等原因，不能静默排除。
- 当前仅“追高买入”模式已实现，其他模式不创建看似可用的空结果。
- 参数版本为 `candidate-1`，页面标注为候选配置，直至负责人确认。

### 4.2 复核、分解与路径

| 接口 | UI 消费字段 | 不可静默隐藏项 |
|---|---|---|
| `buildVerifyReport` | `summary`、`facts`、`identity_checks`、`provenance_complete`、`dangling_refs`、`error_taxonomy` | 任一 `fail`、恒等式失败、来源不完整 |
| `buildDragDecomposition` | `total`、`items`、`by_symbol`、`checks`、`blocked`、`errors` | `blocked`、加总不一致、悬空来源 |
| `buildProvenanceReport` / `buildProvenance` | `blocked`、`items`、公式、输入、`source_refs`、四步 `steps` | `blocked`、`dangling_refs`、无法回源 |

确认：对应视图为 `blocked` 时，页面显示原因并停止发布该视图结论；不展示部分结果为完整复核/完整分解/完整计算路径。

## 5. 契约接口与交互确认

前端确认采用“模板 + 可编辑字段”的受控流程，消费以下接口：

- `CONTRACT_TEMPLATES`：候选模板来源；
- `parseContract({ template_id, fields })`：保存前展示规则文本、阈值、提醒文案、规范化内容与哈希；
- `dayChangePct(market, symbol, requestedDate)`：展示实际采用日期、前收/收盘价与涨跌幅，或数据不可用原因；
- `matchContract(parsed, context)`：展示 `triggered`、`not_triggered`、`missing_data` 三态及事实说明。

页面确认事项：

1. 自由文本或字段拼写错误时明确提示不支持，不猜测规则或静默采用默认阈值。
2. 用户确认、改写、拒绝是 UI 状态机；版本号、状态、契约文本、规范化内容、哈希、申报记录均在本地持久化，并在刷新后恢复。
3. “历史情境模拟”仅允许在缓存支持的标的与日期内执行；数据不可用时显示原因。
4. 警告只陈述“你的规则在当前情境下命中/未命中”，不构成买卖建议。
5. 当前 `fnv1a64` 为候选哈希算法；页面在冻结前标注“候选哈希”，不得宣传为正式哈希存证。哈希算法变更时需要版本迁移方案。

## 6. 能力状态条确认

接线完成并经页面验证后，`CAPABILITY` 状态按真实能力更新：

- 计算引擎：仅在导入→计算→报告真实链路可用后才标记为 ready；
- 行情缓存：仅在页面已正确展示范围/阻断状态后才标记为 ready；
- 契约引擎：仅在模板解析、匹配与状态恢复均接通后才标记为 ready；
- 百炼：保持“未接入（离线）”，直至 wcz 的在线/降级链路完成并验证。

任何未接入能力不得通过视觉文案或演示数据暗示为已完成。

## 7. 待决策项


### 7.1 wcz 决策

1. 将本文和尹辰的 `m0c1-interface-opinions.md` 与 wcz 意见合并为 M0-C1 三方确认记录，并明确“冻结 / 保持候选 / 退回修订”的结论。
2. 确认 Papa Parse 的引入方式（本地 vendor 文件或其他经批准方式），避免 UI 自行引入依赖。
3. 明确 adapter 的最终职责边界：是否由其统一承载引擎、缓存和演示模式切换；确认后作为页面接线的稳定入口。
4. 在百炼/planner 接入前，提供对话页所需的事实 JSON 白名单、在线/离线状态和“查看证据”回跳约定；UI 不自行构造可发送的账户/成交数据。
5. 确认何时可以把能力状态条从“未接入”改为 ready，以及浏览器端端到端验收的留档格式。
6. 行情支持清单与 300750 公司行为的演示处置。
7. 契约正式哈希算法、版本迁移规则，以及“同日先卖后买”的判定口径。
8. 股票本身涨幅、滑点标注、复核容差、S3 买入侧反事实的最终取舍。
9. 行为发现候选参数是否转为正式产品规则。

### 7.2 尹辰确认或提供

1. 确认 UI 接线所依赖的引擎模块、导出函数和字段在合入前的稳定版本；若发生破坏性变更，明确迁移说明。
2. 提供或确认演示路径与真实缓存路径的加载入口、缓存文件格式以及浏览器加载方式，特别是本地 CSV 标的与缓存支持标的不匹配时的阻断文案和行为。
3. 确认公司行为阻断在当前引擎中的实际返回字段/错误码，避免 UI 依据文档假设未落地字段。
4. 确认 `replaceSell` 缺价日 `null` 点、负缺口和异常抛错的推荐测试样例；UI 以这些样例完成图表验收。
5. 确认 A/A′ 的验收向量、预期数值及 `npm run check` 的实际通过项数，以运行输出为准，不在 UI 文档中固化可能变化的计数。

