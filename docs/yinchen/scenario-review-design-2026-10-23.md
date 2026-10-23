# 操作复盘（原「历史情境测试」）设计说明

- 状态：方向已由负责人确认（2026-10-23），PR #58 已合并；站点待部署。
- 基线分支：`feat/user-scenario-banner-2026-10-22`（`65bffc5`，独立情境页 + 已确认账单横幅）。
- 实现分支：`feat/scenario-review-2026-10-23`（隔离 worktree，避免碰当前分支未提交的 QA 改动）。
- 命名：页面标题为「操作复盘」，顶部桌面/移动导航入口为「复盘」；路由保留 `#/scenario`，不迁移旧链接。

## 1. 为什么改

旧页面让用户先选「标的 + 日期」，再假设一笔买入/卖出是否触发规则。它回答的是「如果当时这样做」，不是「我实际做了什么、是否符合自己的规则」。

用户确认的新方向：

1. 复盘单元必须是账单里的一笔真实操作（或一次完整账单），不是虚构的标的/日期情境。
2. 每笔操作先回答「是否符合当前生效规则」，让用户看清自己的实际行为。
3. 用户画像作为互补视角，只描述交易习惯与偏好，不参与合规裁决；两者可以互相印证，但不能混为一谈。

## 2. 新模型

```
一笔真实操作（trade_id）
├─ 规则（尺子）：当前生效规则逐条给出 违反 / 符合 / 无法确认 / 无此情境
└─ 画像（镜子）：这笔操作命中了哪个已成立的行为模式（如 卖出后回补 ×2）
```

- 「无此情境」≠「符合」：例如买入前账单里没有同一标的的卖出记录，不能算“守住了不追回规则”，只能算“没有这个情境”。
- 「无法确认」≠「符合」：缺行情、缺交易日历、账单完整性不足时单独标注。
- 提醒类规则命中记「已提醒」，不计违反。
- 画像仅展示 `status === '成立'` 的模式；样本不足的模式不贴到单笔操作上。
- 画像口径与规则口径可能不同，页面必须分开标注：
  - 追高：画像看买入前 5 个交易日涨幅（≥10%）；规则看买入当日涨幅（阈值由用户设置）。
  - 卖出后回补：画像窗口固定 2 个交易日；规则窗口以用户设置的天数为准。
  - 买入后卖出：画像窗口固定 3 个交易日；规则为提醒类，窗口以用户设置为准。

## 3. 数据与引擎

### 3.1 新增 `src/engine/tradeReview.js`

纯函数，输入 `{ trades, ledger, patterns, market }`，输出：

```js
{
  version: 'trade-review-1',
  as_of,
  summary: {
    trades_n, rules_n, violated_n, warned_n, missing_n, compliant_n,
    not_applicable_n, no_rule_n, habits_n
  },
  operations: [{
    trade_id, trade_date, symbol, side, side_label, price, quantity,
    outcome, outcome_label,
    events: [{ rule_hash, template_id, template_name, rule_text, enforcement,
               outcome, outcome_label, message, code, fact }],
    habits: [{ pattern_id, name, sample_n, min_samples, gap_days, rise,
               prior_trade_id, prior_trade_date, display }]
  }],
  rules: [{ hash, template_id, template_name, rule_text, enforcement,
            enforcement_label, scope_text, applies_n, violated_n, warned_n,
            missing_n, compliant_n, not_applicable_n }],
  habits: [{ pattern_id, name, status, sample_n, min_samples, trade_ids }],
  notes: [...]
}
```

口径：

- 按 `trade_id` 把 `ledger.rules[].events` 聚合到操作；不使用被 `max_events` 截断的顶层事件列表。
- 操作结论优先级：`violated > warned > missing > compliant > not_applicable > no_rule`。
- `not_applicable` 判定：`no_buy_back_within` 规则的买入事件，若 `event.fact.last_sell === null`，把账本里的 `compliant` 改判为「无此情境」。账本本身保持现有语义，不改 `ruleLedger.js` 的既有统计。
- 汇总按**唯一操作**计数，不按规则事件计数。
- 习惯只挂到 `buildPatternList` 中 `status === '成立'` 且包含该 `trade_id` 的模式；`overtrading` 不逐笔挂，只在习惯条展示。
- 重复 `trade_id`、同日同标的买卖顺序未知等情况沿用账本/行为引擎的现有保守口径，不猜测。

### 3.2 `src/demo/adapter.js`

`contractSimContext` 在已有 `ledger` 之外增加：

```js
patterns: trades.length ? buildPatternList({ trades, market }) : null,
review: buildTradeReview({ trades, ledger, patterns, market })
```

`buildPatternList` 对空交易会抛错，必须显式判空；空账单传 `null`，复盘引擎按“无画像”处理。其他异常继续走现有 `error` 返回，不静默回退。

### 3.3 UI

新增 `src/ui/views/scenarioReviewView.js`，由 `renderContract(root, ctx, { section: 'scenario' })` 在入口处委托：

- 页头沿用 `#/scenario` 外壳；intro 精简为「按账单里的每一笔真实操作，逐笔对照当前规则。画像只描述交易习惯，不参与判定」。
- 账单条：操作数 / 标的数 / 日期范围；「历史复盘，非实时」只在顶部工具条出现一次，避免重复标签。
- 结果先行：一句「N 笔操作，M 笔违背了规则」+ 操作/违背/符合/无法确认四格统计；有「已提醒」「无此情境」时补充说明。
- 习惯条：展示已成立画像模式（如「卖出后回补 ×2」），明确标注「画像口径，不是合规结论」，链接 `#/me`。
- 操作时间线：按日期升序；每笔为可展开卡片，默认展开第一笔违规；卡片内展示规则事件、情节（卖出 → N 个交易日 → 买入）和画像习惯。
- 规则汇总：每条规则显示「N 笔违背 / M 笔复核」，并单列「无此情境」「无法确认」。
- 数据与口径折叠：历史复盘非实时、无成交时刻、日线行情、数据不足不等于符合、画像与规则口径差异。
- 状态：加载中 / 账单或行情错误 / 无生效规则（CTA 去 `#/me`）/ 无交易。
- 保留示例账单的行情来源切换（Tushare 动态 / 合成回归）；本地已确认账单固定 Tushare 动态；未确认账单且不允许示例时不显示无效的行情切换。
- 删除 scenario 页面上的「假设买入/卖出」表单；假设测试不再出现在该页。

### 3.4 样式

- 新增 review 样式到 `src/ui/styles.css`（shadow root 已注入），沿用现有设计令牌：`--loss` 违背、`--good` 符合、`--gray/--faint` 无法确认、`--line` 分隔，克制留白。
- 不复用旧的 `cv-sim-*` 表单样式；操作卡片与规则汇总使用 `tr-*` 命名，避免与规则页样式冲突。
- 移动端：统计四格 2×2，操作卡片单列，规则事件换行不横向滚动。

## 4. 验收

必须全部由真实运行结果支撑：

1. `node tests/trade-review.test.mjs`：覆盖一笔卖出后 2 日回补 → 违反；无前置卖出的买入 → 无此情境；缺行情 → 无法确认；汇总按唯一操作计数；画像证据只挂成立模式。
2. `node tests/ui/user-scenario-page.test.mjs`：更新为检查 scenario 委托到 review 视图、页面文案与旧假设表单已移除。
3. `node tests/ui/scenario-review.test.mjs`：静态检查汇总、习惯条、时间线、数据与口径文案存在。
4. `npm run check`、`npm run smoke` 全量通过。
5. 本地浏览器打开 `#/scenario`（示例账单 + 本地账单各一次）：加载、筛选、展开、移动端布局、错误/空状态；截图留证。

## 5. 非目标

- 不改 `ruleLedger.js` 的既有统计语义（避免影响规则页/其他测试）。
- 不改规则保存、版本、AI 兜底、评分或问答链路。
- 不做实时监控、券商拦截或自动交易。
- 不新增依赖、不引入构建步骤。
- 不在本分支重新设计个人画像页；只加交叉链接。

## 6. 风险与待确认

- 命名已确认：「操作复盘」页面标题，「复盘」导航入口；`#/scenario` 路由保持不变。
- 示例账单 `sell_rebuy` 的画像「卖出后回补 ×2」与规则违规恰好重合，是演示上的互相印证，不代表所有画像模式都与规则结论一致。
- 动态行情依赖站点函数与 Tushare 可用性；失败时页面显示错误，不回落示例数据。
- 账单没有成交时刻：同日买卖顺序未知，相关结论必须保持「无法确认」。
