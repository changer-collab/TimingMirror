# AI 问答页「对话账本」实现记录

- 日期：2026-10-22
- 分支：`feat/qa-ledger-2026-10-22`（基于 `feat/behavior-ai-fallback-2026-10-21` / PR #48）
- 范围：`prototype/user-frontend/` 前端页面与编排、测试、记录；同日追加方案 A 固定底栏与 Qoder Site 构建脚本
- 边界：未修改 `src/agent/`、未修改服务端、未调用真实模型、未使用真实账户数据
- 回归：`npm run check` 退出码 0（2124 项 PASS，全部套件 0 失败）；`npm run smoke` 324/324 通过
- 浏览器：in-app Browser 视口固定 740×620；截图接口不可用（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），改用 DOM 快照、网络请求清单、计算样式与同源 iframe 探针完成验收

> 说明：本文的“已实现”指代码链路、自动化测试和本地浏览器结构验收已接通，不等于真实模型质量、真实 token 配额或真实行情环境已经端到端验收。

---

## 1. 本轮交付

独立问答页从“只认组合表现的一条窄聊天”升级为**对话账本**：

1. 任意问法先过三层路由：L1 本地规则 → L2 在线意图（仅 L1 未命中）→ L3 澄清；
2. 12 类意图都能识别，其中 9 类可本地回答，登记 / 未接入 / 越界 / 澄清各有明确卡面；
3. 所有数字只来自当前账单已复核报告；在线复述只发组合四事实，且返回文本必须通过本机数字校验；
4. 回答按 01/02/03 编号落在灰底工作区的白色卡片里，事实、证据、追踪分层展示；
5. 拒绝、登记、未接入不加载账单、不调模型；示例账单不参与在线复述。

不改 `src/agent/` 的原因：组长正在该目录改悬浮助手与编排；本轮只在 `prototype/user-frontend/` 建前端编排，接口按“可平移到 `src/agent/answerOrchestrator.js`”设计，平移由王昌泽侧后续收口。

---

## 2. 视觉与结构

- 工作区：`linear-gradient(180deg,#edf1ef 0%,#e9eeec 100%)`，与白色条目形成明确底色差。
- 条目：白卡、`1px solid rgba(21,25,28,.22)`、8px 圆角、轻阴影；编号在右上角，用 CSS counter 生成。
- 边界类卡面（拒绝 / 登记 / 未接入）左侧 2px ink/灰线，不使用损耗红，避免与事实卡抢层级。
- 事实：桌面最多 4 列，移动 2 列；值用 mono，标签 11px。
- 证据与「如何得出」默认收起，键盘可展开；正文是纯文本 + 换行，不拼 innerHTML。
- 页首：`STEP 03 / ASK · 事实问答`、“问它为什么，别问它买什么。”、`04 / QA`。
- 上下文条：账单类型 + 文件名/场景名 + 报告状态 + 规则版本与生效条数 + 原始 CSV 仅本机。
- 空状态只有一句：“还没有提问。示例问法只是入口，不是全部。”
- **布局（方案 A，2026-10-22 修订）**：整页锁定视口高度；页首与账本在 `.tm-qa-scroll` 内独立滚动，输入框与示例芯片固定在底部 `.tm-qa-dock`。发送后只滚动账本，不带动页面。
- 移动端：为固定底部导航预留 62px + safe-area，输入区位于导航上方；芯片单行横向滚动，不换行堆高。
- body 布局类改名为 `tm-qa-standalone`，避开卡片内“路由行”已有的 `.tm-qa-route`，避免 body 被套上 9px 外边距与 flex 布局。

样式统一用 `tm-qa-*` 前缀，避免与悬浮助手已有的 `.qa-*` 冲突。

---

## 3. 意图覆盖矩阵

| intent | 本轮处理 | 状态 | 数据/在线 |
|---|---|---|---|
| `loss_overview` | 本地已发布四事实；精确芯片且非示例账单时走在线复述 | `local` / `online` | 本地先算，在线仅复述 |
| `worst_trade` | 报告逐笔损耗分解，取代价最高一笔 | `local` | 本地 |
| `pattern_explain` | 行为发现与命中交易 | `local` | 本地 |
| `profile` | 只描述这份账单的可验证行为，不贴人格标签 | `local` | 本地 |
| `how_to_change` | 行为证据 + 候选模板预填，保存仍由用户确认 | `local` | 本地 |
| `what_if` | 单笔反事实；无指代先澄清；无对照则未接入 | `local` / `clarify` / `unavailable` | 本地 |
| `contract_status` | 生效规则数、复核交易数、命中/数据不足；无规则如实说 | `local` | 只读缓存 bundle |
| `contract_setup` | 登记式应答，不替用户定阈值 | `registration` | 不加载 bundle |
| `meta_calc` | 可回源事实数、公式数、复核状态、重算次数 | `local` | 本地 |
| `meta_trust` | 复核状态、降级项、扣发/阻断事实、缺价标的 | `local` | 本地 |
| `similar_context` | 明确“未接入”，不给替代数字 | `unavailable` | 不加载 bundle |
| `out_of_scope` | 荐股/预测/买卖建议边界拒绝 | `refusal` | 不加载 bundle、不调模型 |
| （无法判断） | 澄清 + 示例问法；L2 失败时说明未发送账单/事实 | `clarify` | 不猜 |

本轮**不宣称“12 类全部能答”**：`similar_context` 只说明未接入，`what_if` 只支持日期/代码指代，非组合意图没有在线复述。

---

## 4. 文件清单

新增：

- `prototype/user-frontend/qaIntent.js`：问题归一化、L1 规则、槽位、L2 包装、示例问法；导出 `QA_SUGGESTIONS`、`QA_INTENT_LABELS`、`QA_LAYER_LABELS`、`normalizeQuestion`、`extractSlots`、`routeQuestion`、`createIntentRouter`。
- `prototype/user-frontend/qaAnswer.js`：按 intent 取最小事实包、调用既有 builder/在线复述、统一 AnswerEnvelope；导出 `createQaAnswerService`。
- `tests/ui/qa-intent.test.mjs`：12 类路由、优先级、槽位、L2 命中/低置信度/失败/不越权调用，41 项。
- `tests/ui/qa-answer.test.mjs`：9 类回答、登记/未接入/拒绝/澄清、在线成功与回退、隐私断言，39 项。
- `scripts/build-site.mjs`：`npm run build:site` 生成专用 `dist/`（复制 `src`、`prototype`、`m0`、`data/market-cache.json`，根入口跳转用户端）；`dist/` 已 gitignore。
- `docs/yinchen/qa-ledger-implementation-2026-10-22.md`：本文。
- `docs/yinchen/qoder-site-deploy-2026-10-22.md`：Qoder Site 重新部署参数与 Secret 配置说明。

修改：

- `prototype/user-frontend/realChat.js`：整页重写为对话账本；页首与账本进滚动区，芯片与输入进底部 dock；保留 `renderRealChat(host, ctx)` 导出。
- `prototype/user-frontend/app.js`：`realChatPage()` 改为返回挂载点，页头移入 QA 页；未确认账单仍走 pending 页；真实/已确认问答页给 body 加 `tm-qa-standalone`。
- `prototype/user-frontend/realBridge.js`：新增 QA 客户端懒加载单例与 `qaDeps.askQuestion`；沿用既有报告 bundle、在线复述、规则状态、画像依赖。
- `prototype/user-frontend/real-views.css`：文件末尾追加 `tm-qa-*` 视觉与响应式规则，不覆盖既有样式；补充全高 flex、独立滚动、底部 dock、移动端导航避让与 body 高度链。
- `scripts/smoke-frontend.mjs`：假 DOM 增加 `innerHTML`/closest/contains/属性选择器/requestSubmit 等最小能力；对话段改为账本断言 + 出站白名单 + L2 用例；新增“表单/账本挂载在 dock/scroller 内”的结构断言。
- `package.json`：`check` 链在 `qa-chips` 前插入 `qa-intent` 与 `qa-answer`；新增 `build:site`。
- `.gitignore`：新增 `dist/`。

只读复用（未改）：`src/agent/qaChips.js`、`src/agent/chatOnline.js`、`src/agent/chatScope.js`、`src/agent/offlineIntent.js`、`src/agent/onlineBoundary.js`、`src/engine/ruleLedger.js`、`src/engine/display.js`、`src/demo/adapter.js`。

---

## 5. AnswerEnvelope 契约（当前实现）

```js
{
  status: 'local' | 'online' | 'registration' | 'refusal' | 'unavailable' | 'clarify' | 'error',
  intent: 'loss_overview' | 'worst_trade' | ... | null,
  route: { layer: 'L1' | 'L2' | 'L3', confidence: number | null },
  source: 'local' | 'online' | 'template',
  text: string,
  facts: [{ label, value, tone: 'loss' | 'neutral' | 'ok' }],
  evidence: [{ label, detail }],
  actions: [{ id, label, kind: 'ask' | 'navigate' | 'candidate' | 'simulation', question?, href?, candidate? }],
  trace: {
    template_id, plan_id, fact_count, number_check,
    elapsed_ms, intent_code, layer_label
  },
  candidate: object | null,
  notice: string | null,
  diagnostics: [{ code, message }],
  bill_context_id: string | null
}
```

UI 消息：

```js
{ id, role: 'user' | 'assistant', kind: 'qa-user' | 'qa', text, answer?, bill_context_id, rule_state_key? }
```

`rule_state_key` 用于规则版本变化后隐藏失效候选，避免旧候选继续可点。

---

## 6. 路由与在线策略

三层顺序：

1. **L1**：先跑既有 `classifyOffline` 精确芯片；再按拒绝 → 登记 → 假设 → 规则 → 口径 → 归因顺序匹配。拒绝类优先，例如“明天买什么”不会被归因类截走；“怎么避免追高”落到 `how_to_change`，不是 `pattern_explain`。
2. **L2**：仅 L1 未命中才调用既有 `/api/llm/intent`，只发送 `{ question }`。兼容 `onlineBoundary` 的 `data.intentJson` 与注入方的扁平形状；置信度 `< 0.5`、端点未发布、响应非法或抛错都转澄清，不阻断页面。
3. **L3**：澄清，不加载账单、不发账单内容。

在线复述只发生在：`loss_overview` + 点击“组合表现”精确芯片（`preferOnline: true`）+ 账单非示例。成功条件是传输成功且本机数字校验通过；失败、超时、503、数字校验失败都回退本地已发布四事实，并在 `notice` 与 `diagnostics` 说明原因，页面不出现候选模型文本或失败数字。

---

## 7. 隐私与出站边界

- 出站只允许：问题文本（L2 意图或在线复述）与组合四事实的 `value/unit/display/formula_ref/source_ref`。
- 不发送：原始 CSV、文件名、成交行、账户信息、规则草稿、选中的交易明细。
- 示例账单（`bill.demo === true`）不发起在线复述；本轮浏览器验收正是示例账单，卡面显示“示例账单不参与在线复述”。
- 拒绝 / 登记 / 未接入：不加载 bundle、不调用在线；卡面写明“未加载账单、未调用模型、0 条事实。”
- 规则只做提醒与历史回放，不下单、不阻止交易；登记式应答不替用户决定阈值。

smoke 中已断言：在线复述出站 body 只有 `question` 与 4 条 F-6 事实，不含文件名、成交、provenance、Key；L2 出站只有 `{"question":"帮我看看这个账户"}`。

---

## 8. 验证记录

### 8.1 自动化

| 命令 | 结果 |
|---|---|
| `npm run check` | 退出码 0；输出 2124 行 PASS，全部套件 0 失败 |
| `node tests/ui/qa-intent.test.mjs` | 41/41 通过 |
| `node tests/ui/qa-answer.test.mjs` | 39/39 通过 |
| `npm run smoke` | 324/324 通过 |

smoke 对话段覆盖：

- 页首、空状态、8 个芯片（1 个在线）、上下文条；
- `worst_trade` 本地回答、4 条事实、证据、已发布状态；
- 越界拒绝 0 事实、0 站点调用、0 行情调用；
- 登记式应答与“去规则工作区”；
- `meta_calc` 的可回源事实/公式断言，不含文件名与成交行；
- `what_if` 无指代澄清 + 带日期动作；
- `contract_status` 无规则时的如实说明；
- 组合芯片在线成功：文本一致、数字校验 4 个、出站仅 `question` + 4 事实；
- 数字失败（99.9）与 503：回退本地，页面与状态不出现候选文本/失败数字；
- 同名重导入、换账单期间旧响应隔离；
- L2：返回意图 JSON 后命中 `loss_overview`，层显示在线意图，出站只有问题文本。

### 8.2 浏览器结构验收

环境：本地 `http://localhost:5180/prototype/user-frontend/index.html`，粘贴追高止损示例 CSV（识别为示例账单），生成已发布报告后进入 `#/chat`。

已验证：

- 上下文条：`示例账单 / 追高止损 / 报告 已发布 / 规则 v0 · 生效 0 条 / 原始 CSV 仅本机 / 换个场景`；
- 8 个芯片，`组合表现` 标记在线；空状态一句；
- 9 类回答逐一落到明确卡面：`worst_trade`、`loss_overview`、`pattern_explain`、`profile`、`how_to_change`、`what_if`、`contract_status`、`meta_calc`、`meta_trust`；
- 越界“明天买什么？”→ `refusal`，0 事实，网络清单无 `/functions/v1` 请求；
- “帮我定个止损。”→ `registration`，动作“去规则工作区 / 先看历史情境”，提示不内联保存；
- “如果那笔卖出没发生，会怎样？”→ `clarify`，3 个带日期动作；点击 `2025-03-20 · 900001` 后得到该笔反事实（+¥6,300.00、+23.6pp）；
- “我的规则守得住吗？”→ 生效规则 0 条，如实说明不能回放；
- “历史上类似情况？”→ `unavailable`，不用别的账单补数；
- 示例账单点击在线芯片 → `local` + “示例账单不参与在线复述”，网络清单无函数请求；
- 证据 `<details>` 可展开，显示公式 `100 × (168.00 − 105.00) = ¥6,300.00`；
- Enter 提交成功；Shift+Enter 未触发提交（代码只拦截无 Shift 的 Enter，保留 textarea 默认换行；浏览器桥接未能观察到换行插入，这是验收工具限制，不是逻辑分支）；
- 清空：13 条 → 0 条，恢复空状态，上下文保留，清空按钮隐藏；
- 拒绝、登记、`meta_calc`、`what_if`、`contract_status`、示例账单在线芯片全程未产生函数请求（网络清单只有静态资源与字体）。

布局测量（2026-10-22 方案 A 复测；同源 iframe 探针；in-app Browser 主视口固定 599×620，探针内重新粘贴追高止损示例 CSV 并进入 `#/chat`）：

| 指标 | 1440×900 | 390×844 |
|---|---|---|
| 文档横向溢出 | 无（scrollWidth 1440） | 无（scrollWidth 390） |
| footer | 隐藏 | 隐藏 |
| 主区高度 | 824（topbar 77） | 780（topbar 65） |
| 上下文条高度 | 40px | 81px（换行） |
| 账本滚动区 | 630px 高，独立滚动 | 315px 高，独立滚动 |
| 底部 dock | 154px，贴视口底（1px 取整） | 182px，底部为导航预留 62px |
| 表单 | 94px；发送按钮在 dock 内 | 73px；发送按钮底 775，导航顶 797 |
| 固定底部导航 | 不显示 | 固定，47px 高，与表单间隔 14px |
| 芯片行数 | 1 行 | 1 行，横向滚动（641 / 362px） |
| 事实网格 | 4 列 | 2 列（153.1px × 2） |
| 空状态 | 贴近 dock 上方 | 贴近 dock 上方 |
| ask meta | 显示 | 隐藏（节省高度） |
| 页面底色 | 灰渐变 | 灰渐变 |

补充：

- 发送 5 条回答后，账本 `scrollHeight` 2222 > `clientHeight` 630，页面高度不变、dock 位置不变，确认滚动被限制在账本内。
- Enter 提交成功；证据 `<details>` 可展开。Shift+Enter 的“不提交”由代码分支保证，浏览器探针在重渲染后引用旧 textarea，未能有效观察换行插入，记为工具限制。
- 自动滚动：代码在追加消息后对账本调用 `scrollTo({behavior:'smooth'})`；in-app Browser 文档处于 `visibilityState=hidden`，平滑滚动动画不推进，探针读到的 `scrollTop` 仍为 0。直接设置 `scrollTop` 可到 2017/2017，确认容器可滚动；真实可见窗口下的自动滚动仍需一次人工目视确认。
- 截图不可用（`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`），因此没有 `docs/yinchen/evidence/qa-ledger-2026-10-22/` 截图；以上为 DOM/计算样式实测值，可复跑。

> 旧版（输入卡在页首、芯片 3 行）的测量已废弃。本轮把表单与芯片移入底部 dock，账本改为独立滚动区；桌面/移动端均无横向溢出。

### 8.3 未在浏览器覆盖

- **在线成功/失败**：示例账单按设计不发在线；开发服务器未配置真实模型 Key。该路径由 smoke 的假 transport 覆盖（成功、99.9 数字失败、503）。
- **L2 真实端点**：浏览器端未触发；smoke 用队列响应覆盖命中与出站白名单。
- **非零规则下的候选失效**：代码以 `rule_state_key` 比对，浏览器本次为 0 条规则，未做交互验收。

---

## 9. 已知缺口

1. `similar_context` 的历史行情/情境检索尚未接入，只如实说明。
2. `what_if` 只支持日期或代码指代，不支持“三月那笔”“最伤的那笔”等自然指代，也不支持多笔同时替换。
3. 非 `loss_overview` 意图没有在线复述，全部本地模板回答。
4. L2 依赖 `/api/llm/intent`；端点未发布时最多等 5s 后转澄清。
5. 登记式应答不内联保存，也不生成草稿；保存必须由用户在规则页确认。
6. 编排仍在 `prototype/user-frontend/`，尚未平移为 `src/agent/intentRouter.js` / `factBundles.js` / `answerOrchestrator.js`，悬浮助手与独立页还未共用同一套编排（王昌泽侧）。
7. 无自动视觉回归；截图接口不可用，本次只有计算样式与结构快照。
8. 真实 token、真实行情下的端到端问答未验证。

---

## 10. 风险与回滚

- 旧 smoke 对话断言已随 DOM/消息形状同 PR 更新，不保留旧渲染分支。
- 首次读取报告可能触发行情请求：pending 卡明示“正在核对/请求”，不在进页时自动请求；`contract_status` 只读缓存 bundle。
- L2 端点不可用时最多等待 5s，不阻断本地回答。
- 规则候选随规则版本失效：消息保存 `rule_state_key`，渲染时与当前值比较，失效则隐藏候选并提示账单事实仍有效。
- body 布局类与卡片路由类同名会互相污染：本轮已从 `tm-qa-route` 改为 `tm-qa-standalone`，二者不再共用选择器。
- 回滚：本轮不改 `src/agent/`、不改服务端；前端改动集中在 `qaIntent.js` / `qaAnswer.js` / `realChat.js` / `realBridge.js` / `real-views.css` / `app.js`，可按提交整体回滚。

---

## 11. 后续协同

- 将 `qaIntent.js` / `qaAnswer.js` 平移为 `src/agent/` 下的共享编排，让悬浮助手与独立页复用同一套路由与事实包。
- 在 `factExport` / `onlineBoundary` 扩展非组合意图的单位与事实映射，再评估在线复述范围。
- 接入 `similar_context` 的历史检索前，继续保持“未接入”而不是用别的账单补数。
- 补充 `what_if` 的自然语言指代与多笔替换。
- 有真实模型与行情环境后，补一次独立问答页的真实在线复述与失败回退 E2E。
- Qoder Site 重新部署使用独立的 `dist/` 构建产物（`npm run build:site`），部署参数与 Secret 配置见 `docs/yinchen/qoder-site-deploy-2026-10-22.md`；本轮未执行 prepare/publish、未读取 Secret。
