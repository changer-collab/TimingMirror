# 引擎接线对接说明（致吴涵晶）——`src/engine/*` → 四页接线

> 版本：v1（2026-10-13，尹辰）· 状态：**对接说明，非接口冻结**（引擎候选口径 `frozen:false`；冻结后如有变更我在本文件与 PR 中同步）
> 定位：把已实现并已测的引擎纯函数接上四页，替换 `src/demo/adapter.js` 的夹具直读。**本文件只给数据链路与模块契约**；布局、状态机、持久化、交互归属你（吴涵晶）。
> 依据：各模块头注释与单测（`tests/*.test.mjs`）、`m0/` 候选接口、实现基线（F-2/F-3/F-7/F-9/R1/R2；Q1/Q2；B2/B3/B4）。R5 边界不变：解析与计算全在浏览器本地，CSV 不出设备；fetch 仅取本地静态资源（行情缓存/夹具）。

## 1. 模块清单（依赖顺序即接线顺序）

| 模块 | 职责 | 关键导出 | 单测 |
|---|---|---|---|
| `src/engine/csvNormalize.js` | CSV 文本解析与整批校验（O1–O3/Q4–Q8） | `parseCsvText` / `normalizeRows` / `CSV_HEADER` | tests/csv-normalize（59） |
| `src/engine/marketCache.js` | 估值日解析、取价、范围阻断（B2/B3/B4/R2） | `createMarketCache` / `fromPullDraft` / `fromFixtures` / `MARKET_CACHE_CODES` | tests/market-cache（25） |
| `src/engine/indicators.js` | 三指标（实际/对照/损耗）＋双路径＋display | `computeIndicators` / `sortTrades` / `CALC_FORMULAS` / `RESULT_LABELS` | tests/indicators（83） |
| `src/engine/counterfactual.js` | S1 单笔卖出替换＋逐日序列（T1-12） | `replaceSell` / `CF_FORMULA_IDS` | tests/counterfactual（30） |
| `src/engine/behavior.js` | 行为模式清单（追高）三态结论＋证据 | `buildPatternList` / `PATTERN_CONFIG` / `listPatternDefinitions` | tests/behavior（45） |
| `src/engine/contractMatch.js` | 契约模板解析/涨跌幅/命中判定（F-5/F-9） | `parseContract` / `dayChangePct` / `matchContract` / `CONTRACT_TEMPLATES` | tests/contract-match（47） |
| `src/engine/verify.js` | 自我复核（附A.2：独立重算＋双路径＋恒等式） | `buildVerifyReport` / `VERIFY_CODES` | tests/verify（28） |
| `src/engine/decompose.js` | 损耗分解占比（T1-13/OUTPUT01） | `buildDragDecomposition` / `DECOMPOSE_CODES` | tests/decompose（19） |
| `src/engine/provenance.js` | 计算路径四步留痕（T1-15/OUTPUT03＋附A.4） | `buildProvenance` / `buildProvenanceReport` / `listFactIds` | tests/provenance（22） |
| `src/engine/display.js` | F-2 展示格式（金额/收益率/pp） | `fmtMoney` / `fmtPct` / `fmtPP` | 随各模块断言 |

全部为零依赖 ES Modules、纯函数（不发起网络请求、不读账户数据）；`npm run check` 624 项 / `npm run smoke` 15 项为本地离线校验，抄用例直接看 `tests/`。

## 2. 端到端数据流（接线主链路）

```
CSV 文本（FileReader / 演示夹具 fetch）
  → parseCsvText(text)              → { header, rows }
  → normalizeRows(parsed, 文件名)    → { blocked, trades, warnings, errors }
      └ blocked=true：导入页展示 errors（含行号；整批阻断、无部分结果）——不要进后续步骤
  → 行情实例 market（见 §5 两条路径）
  → val = market.resolveValuation(asOfDate)      // 非交易日映射；范围外 → "不支持/数据缺失"
  → market.checkLastTrade(val.effective_date, 末笔成交日)   // 早于末笔 → 阻断
  → prices = market.resolvePrices(标的集, val.effective_date) // 缺价标的 → 阻断该标的（不回落）
  → closes = { [sym]: r.close }（仅未 blocked 的标的）
  → report = computeIndicators({ trades, closes })           // 报告页指标卡
  → verify   = buildVerifyReport({ report, trades, closes })   // 验算视图（OUTPUT04）
  → decomp   = buildDragDecomposition({ report, trades })      // 占比条（OUTPUT01）
  → prov     = buildProvenanceReport({ report, trades, closes, valuation: val }) // 计算路径（OUTPUT03）
  → cf       = replaceSell({ symbol, trades: <按 symbol 过滤>, tradeId, effectiveDate: val.effective_date,
                             closeOf: (d) => market.getClose(symbol, d), tradingDays: market.tradingDays }) // 幽灵线缺口（T1-12）
  → patterns = buildPatternList({ trades, market })            // 行为清单（F-10）
```

顺序要点：**先阻断判定、后计算**。CSV 层不通过不进行情层；行情层被阻断的标的不要塞给 `computeIndicators`（它会抛错，且不是用来吞错的）。

## 3. 各模块 I/O 契约（页面消费的关键字段）

### 3.1 csvNormalize
- `parseCsvText(text)`：接收完整文本字符串（BOM/CRLF/LF 已处理）→ `{header, rows:[{line, cells}]}`；空文件返回空 header/rows。
- `normalizeRows(parsed, sourceFile)` → `{schema_version:'candidate-3', source_file, blocked, trades, warnings, errors}`。
- trades 项：`{trade_id('T001'…), trade_date, symbol(6位字符串), side('buy'|'sell'), price, quantity, fee, tax, fee_missing, tax_missing, source:{file,line}}`。行序＝原始文件序（Q7；计算排序由引擎 sortTrades 做）。
- errors：`{line, code, message}`，code ∈ E_EMPTY / E_HEADER_MISSING / E_DATE_FORMAT / E_SYMBOL_FORMAT / E_SIDE_VALUE / E_PRICE_VALUE / E_PRICE_PRECISION / E_QTY_INTEGER / E_MONEY_VALUE / E_MONEY_PRECISION / E_QTY_EXCEEDS；warnings：`{line, code, message, column?}`，code ∈ W_FEE_COLUMN_MISSING / W_TAX_COLUMN_MISSING / W_UNKNOWN_COLUMN / W_FEE_MISSING_AS_ZERO / W_TAX_MISSING_AS_ZERO。
- blocked 时 trades 为空数组（O1 无部分结果）；缺失费用/税费按 0 且逐条标记（fee_missing/tax_missing=true），产品层须标注（F-4/Q6）。

### 3.2 marketCache
- 构造：`createMarketCache(fromPullDraft(cacheDoc))`（产品缓存文件）或 `createMarketCache(fromFixtures(calendarDoc, barsDoc))`（m0 合成夹具）。
- 实例：`{ range:{start,end}, symbols:[…], tradingDays:[…升序], snapshot, resolveValuation, getClose, resolvePrices, checkLastTrade }`。
- `resolveValuation(date)` → `{requested_date, effective_date|null, blocked, code|null}`；code ∈ E_VALUATION_OUT_OF_RANGE / E_NO_EFFECTIVE_TRADING_DAY。
- `getClose(symbol, date, seriesKey='unadj')` → number|null（缺价 null 不回落 B4；`seriesKey='fwdadj'` 仅供注明快照口径的走势展示，**不得参与金额相减** B2）。
- `resolvePrices(symbols[], effectiveDate)` → `{effective_date, per_symbol:{sym:{blocked, code, close, no_fallback_used}}, portfolio:{blocked, code}}`。
- `checkLastTrade(effectiveDate, lastTradeDate)` → `{blocked, code}`（E_VALUATION_BEFORE_LAST_TRADE）。
- 日期参数必须 `YYYY-MM-DD`（否则抛 TypeError）；错误码统一收在 `MARKET_CACHE_CODES`。

### 3.3 indicators
- `computeIndicators({trades, closes})` → `{per_stock:{sym: entry}, portfolio: entry}`；entry：`{buyCost, sellProceeds, heldShares(仅标的), actualValue, ghostValue, actualRet, ghostRet, dragMoney, drag, display:{…7项}, formula_ids, recorded:{fee_recorded_sum, tax_recorded_sum, fee_missing_lines, tax_missing_lines}, drag_lines:[{trade_id, trade_date, quantity, price, close, dragMoney}], dual_path:{dragMoney, ghostValue}}`。
- **展示数字一律用 `entry.display.*`**（F-2 已格式化；LLM/页面原样引用，不再自行 toFixed）。
- 抛错条件：trades 空 / side 非 buy|sell / 某成交标的缺 close（B4，先阻断再调用）/ 某标的 buyCost=0（无买入无法算收益率）。
- 口径常量：`RESULT_LABELS`（未计入费用、税费 / 分红未计入）——结果标注直接引用。

### 3.4 counterfactual
- `replaceSell({symbol, trades, tradeId, effectiveDate, closeOf, tradingDays})` → `{scope, replace:{replaced, buyCost, actualValue, actualRet, ghostValue, cf_sellProceeds, cf_heldShares, cfValue, cfRet, recoveredMoney, recoveredPP, remainingDragMoney, display:{cfValue, cfRet, recoveredPP, remainingDragMoney}, formula_ids}, series:{start, end, complete, missing_dates, points:[{date, close, actual, ghost, cf, gap}]}}`。
- **前置：trades 必须已过滤为单标的**（`trades.filter(t => t.symbol === symbol)`）；多标的输入直接抛错（补救%基数未定义，候选问题待定夺）。S3 买入侧、缺价、日历外、非法 tradeId 均抛错——照实展示，不兜底。
- gap＝红缺口＝cf−actual（正＝替换可挽回；**负＝该笔卖出本身优于持有**，双向归因，不是 bug）。
- 缺价日：points 对应项各值 null 并计入 missing_dates（画法由你定：断线/留空/标注）。

### 3.5 behavior
- `buildPatternList({trades, market})` → `{config_version('candidate-1'), config_source, scope:{trade_count, buy_count, sell_count}, patterns:[card], hypotheses:[…], notes:[…]}`。
- card：`{pattern_id, name, implemented, status('成立'|'不成立'|'证据不足'), sample_n, evaluated_n, min_samples, buy_count, conclusion, rule:{window, comparator, threshold, threshold_display}, check_method, threshold_meta, evidence:[{trade_id, trade_date, symbol, price, quantity, rise, display:{rise}, path, source}], evaluated_others:[…], unevaluated:[{trade_id, trade_date, symbol, code, message}]}`。
- **三态必须照实渲染**（不利结论不隐藏，T1-14）；unevaluated 不静默排除（R2/B4 原因列出）；对话解释引用 `pattern_id`＋成交 ID（F-10.4，清单是唯一事实出口 F-10.6）。
- 参数在 `PATTERN_CONFIG`（version candidate-1，占位）集中配置；`listPatternDefinitions()` 供方法说明页展示。

### 3.6 contractMatch
- `parseContract({template_id, fields})` → `{supported:true, template_id, template_name, kind, text, fields, condition, threshold:{unit,value,display}, reminder, canonical, hash, hash_algorithm}`；失败 → `{supported:false, code, message}`（自由文本不支持，F-5.3；保存前展示 text/threshold/reminder 供确认）。
- `dayChangePct(market, symbol, requestedDate)` → `{complete:true, effective_date, prev_date, close, prev_close, change_pct, display:{change_pct}, source_note}` 或 `{complete:false, code, message}`（前收越界/缺价不补造）。
- `matchContract(parsed, context)` → `{…, verdict:'triggered'|'not_triggered'|'missing_data', fact, message, warning|null}`；warning 含 `{rule_text, threshold_display, situation}` 供警告卡（F-9.4 展示规则、阈值与情境事实）。
- 哈希为**占位算法**（fnv1a64；算法随 M0 §4-7 冻结后替换）——R4 判据"刷新后哈希一致且仍触发"目前可用；状态层版本号/持久化归你。

### 3.7 verify / decompose / provenance（验算视图、占比条、计算路径）
- `buildVerifyReport({report, trades, closes})` → `{verify_id, facts[26项 {fact_id('000000.dragMoney'…'portfolio.drag'), key, value, path_a, path_b, diff, tol, formula_id, reasons[], verdict}], identity_checks[11项], provenance_complete, dangling_refs, data_source_notes, error_taxonomy, summary:{n_facts, pass, fail, identities_fail}}`。
- `buildDragDecomposition({report, trades})` → `{total:{value, display, formula_id, formula_text, line_count}, items[按 dragMoney 降序 {trade_id, symbol, dragMoney, display:{dragMoney, share}, share, source}], by_symbol, checks, blocked, errors, notes}`；`blocked`（悬空/加总破坏）→ 该视图不发布。
- `buildProvenanceReport({report, trades, closes, valuation})` → `{blocked, dangling_refs, items[26], summary:{n, blocked_n}}`；单项 `buildProvenance({…, fact_id})` → `{blocked, fact_id, formula_id, formula_text, unit, value, display, inputs, source_refs(匿名 {type:'trade', key, file, line}), steps[S1口径→S2批次→S3逐笔→S4排序], errors}`。
- 三类阻断语义：`blocked=true` → 对应视图显示阻断原因，不发布部分结果（附A.4 悬空引用阻断）。

## 4. 页面接线要点

建议保持 `src/demo/adapter.js` 作为**唯一数据出口**：函数名与返回结构尽量不变、内部换成引擎实现，页面组件（views）不用大改。各页：

- **导入·确认**：加载演示账单 → 改为 `fetch` 夹具文本 → `parseCsvText`＋`normalizeRows`；上传路径 FileReader 读文本 → 同链路。展示 warnings/errors（blocked 整批阻断）；「确认」→ 写 `state.bill`。
- **报告·证据**：`loadIndicators` 内部换 `computeIndicators`（closes 来自 §2 链路）；A/A′ 场景＝两份账单各自跑引擎。验算视图挂 `buildVerifyReport`；占比条挂 `buildDragDecomposition`；计算路径抽屉挂 `buildProvenance`（逐 fact 或全量报告）；幽灵线缺口挂 `replaceSell`（注意先过滤标的）。
- **对话**：在线走百炼（changer 侧）；事实 JSON 从 `report`/`patterns` 提取，只含 F-6 白名单字段（`value/unit/display/formula_ref/匿名 source_ref/行为标签`）；离线降级保持现状（不引用事实 JSON）。
- **契约**：候选卡换 `CONTRACT_TEMPLATES`＋`parseContract`（字段可编辑、保存前确认）；「历史情境模拟」＝ 选缓存支持的标的与历史日期 → `dayChangePct` → `matchContract`（禁用占位可撤）；双情境预置（触发/不触发）只填输入，共用同一判定链路（F-9.3）。状态机/版本记录/刷新恢复归你（R4）。
- **能力状态条**（`adapter.CAPABILITY`）：接线完成后把 `engine`/`marketCache`/`contractEngine` 的 `ready` 改 true、label 去掉"未接入"；`bailian` 仍 false（changer 侧未接入）。

## 5. 行情数据装载：两条路径

**（a）演示路径（现在就能接）**：`fromFixtures(m0/market-cache/fixtures/mock-calendar.json, mock-daily-bars.json)`——覆盖 000000/888888/001234（合成占位码），交易日历 2024-09-23 … 2024-10-11（10 天）。

**（b）真实路径（上传 CSV / 签收后）**：`fetch('/data/market-cache.json')` → `fromPullDraft`——600519/300750/601318，2023-01-03 … 2025-12-31，asOfDate=2025-12-31。**该文件是未签收草案**：签收前页面必须标注"草案范围·演示口径"，**不得声称真实支持范围（R2）**；演示账单避开 300750 跨越 2023-04-26（送转跳变，B5 未决）。

**重要：接线后演示数字会变化，不是 bug。** 现行报告页读的是 `m0/csv-input` 手算夹具（声明合成价 000000=125、888888=1560）；接上引擎＋合成缓存后，估值日用缓存夹具真实 close（**000000=108、888888=1580 @2024-10-11**），数字按下表重算（以下为真实运行输出，可作你的接线验收向量）：

| 指标 | 000000 | 888888 | 组合 |
|---|---|---|---|
| actualValue | ¥22,000.00 | ¥14,700.00 | ¥36,700.00 |
| ghostValue | ¥21,600.00 | ¥15,800.00 | ¥37,400.00 |
| actualRet | +10.0% | −2.0% | +4.9% |
| ghostRet | +8.0% | +5.3% | +6.9% |
| dragMoney | ¥−400.00 | ¥1,100.00 | ¥700.00 |
| drag | −2.0pp | +7.3pp | +2.0pp |

- 账单 A verify：26/26 通过、恒等式 0 失败。A′（000000 卖价 110→115）：000000 actualValue ¥23,000.00 / dragMoney ¥−1,400.00 / drag −7.0pp；组合 ¥37,700.00 / ¥−300.00 / −0.9pp；888888 不变（R1 允许）——**这就是 R1 可复算演示**（同 `docs/yinchen/m2c4-drill-prep.md` §1，数字以本表为准）。
- 损耗分解（A）：total ¥700.00；items：T005 ¥1,100.00（+157.1%）、T004 ¥−400.00（−57.1%，负项＝该笔实际优于对照，双层加总校验通过）。
- 单笔反事实（A，T004 替换；**先过滤 000000**）：cfValue ¥21,600.00、cfRet +8.0%、recoveredPP −2.0pp、remainingDragMoney ¥0.00；序列 9 个交易日完整，末日 {actual 22000, ghost 21600, cf 21600, gap −400}（负补救＝卖得比持有好，照实展示）。
- 行为清单（A，合成缓存）：**"证据不足" n=0**——三笔买入窗口均早于缓存起点（E_WINDOW_BEYOND_CACHE），不是"无追高"；如需"成立"演示样例，用 `tests/behavior.test.mjs` 场景 A 的 14 日 CSV（窗口设计已覆盖命中/未命中/边界）。
- 契约页示例（合成缓存）：`dayChangePct(market, '000000', '2024-09-30')` → +4.0%（前收 100→104）——阈值 3% 触发、5% 不触发（双情境）；`no_buy_back_within` days=3 @2024-10-10 → 触发（距 2024-10-08 卖出 2 个交易日）；`parseContract({template_id:'no_buy_back_within', fields:{days:3}}).hash` = `a30810dc469c071b`（占位算法，冻结后可能变化）。

## 6. 阻断与错误语义汇总（页面表现）

| 层 | 触发 | 期望表现 |
|---|---|---|
| CSV | `blocked=true` | 整批阻断、无部分结果；errors 全量列出（行号+code+message），warnings 并列展示 |
| 行情 | `E_VALUATION_OUT_OF_RANGE` / `E_NO_EFFECTIVE_TRADING_DAY` | 提示"不支持/数据缺失"（R2），不静默改期 |
| 行情 | `E_VALUATION_BEFORE_LAST_TRADE` | 阻断估值（估值日早于账单末笔成交） |
| 行情 | `E_PRICE_MISSING`（per_symbol / portfolio） | 阻断受影响结果（标的级与组合级），`no_fallback_used=true`；不回落其他日期 |
| 计算 | `computeIndicators` 抛错 | 调用前应先完成行情阻断判定；不要让 try/catch 吞错后继续渲染 |
| 反事实 | 非法 tradeId / 买入侧 / 缺价 / 日历外 / **多标的未过滤** | 照实提示，不猜测不兜底 |
| 复核/分解/路径 | `blocked=true` / `dangling_refs` | 该视图不发布，显示阻断原因（悬空引用阻断，附A.4） |
| 行为 | `unevaluated` / 三态 | 未评估笔列出原因；"不成立/证据不足"照实，不与"无模式"混同 |

## 7. 展示与标注（F-2 / F-7）

- 数字：只用引擎 `display` 字段（收益率/pp 1 位小数、金额 2 位＋千分位）；验算视图用原始数值（更高精度）。
- 结果标注：`RESULT_LABELS`（未计入费用、税费 Q1；分红未计入 Q2）＋"未计入滑点"待 C2 定夺后我才加入。
- F-7 两套标注文案与核对表见 `docs/yinchen/m2c4-drill-prep.md` §3（演示数据 / 用户上传；禁止"真实跑出"类表述）。

## 8. 已知未决与占位（勿当已完成）

| 项 | 现状 |
|---|---|
| 契约哈希算法 | fnv1a64 **占位**；冻结后替换——替换会使历史哈希变化，版本迁移策略在你侧 |
| replaceSell 作用域 | 仅单标的；多标的抛错（补救%基数候选问题） |
| S3 买入侧替换 | 未实现（C1 未定），抛错——备用演示页待负责人定夺后 |
| 序列缺价日 | points 值为 null；画法（断线/留空）由你定 |
| 复核容差 | 金额到分、收益率 1e-9 相对（**候选**）；别在 UI 硬编码其他容差 |
| 行情清单 | `data/market-cache.json` 未签收（R2 守则见 §5） |
| 行为参数 | PATTERN_CONFIG candidate-1（回看 5 日/阈值 10%/最小样本 2），待负责人确认按此替换 |
| 复核编排/重算回流 | 归 changer（M1-C7）；百炼链路归 changer（M1-C10）；对本文件标的 I/O 即接口 |

## 9. 验证与求助

- 本地：仓库根 `npm run dev`（端口 5180）→ 页内自测；`npm run check`（624 项）/ `npm run smoke`（15 项）。
- 每个模块的行为边界都有单测可抄：`tests/*.test.mjs`（自查用例时以这些断言为准）。
- 接线中如发现引擎行为与本说明不符：先跑对应单测定位；确认是引擎问题请把失败命令+输出发我（或开 issue），我按「最小改动＋单测＋如实标注」修复并同步本文件。
