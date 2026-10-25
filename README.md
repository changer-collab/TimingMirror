# TimingMirror 择时镜子

> 面向个人投资者的交易行为分析应用：把实际收益与“买入后一直持有”放在同一把尺上，展示择时差额、逐笔证据与历史操作复盘。
>
> 生产前端位于 `prototype/user-frontend`，服务端函数位于 `server/site-functions`；线上通过 Qoder Sites 发布。本文描述仓库当前实际实现与验证边界；产品口径以 [`docs/implementation-baseline.md`](docs/implementation-baseline.md) 为权威来源。

## 1. 当前定位

- 金融数字与规则结论来自本机确定性计算、复核与既有规则引擎；模型只负责在允许范围内理解问题、改写表达或解释已核对事实。
- 不荐股、不预测涨跌、不承诺收益、不替用户保存未经确认的规则。
- 页面明确区分“本地确定性回答/页面帮助”和“用户主动触发的在线 AI 功能”。
- 已接入的能力与仍需单独验收的能力分别描述，不把 fake/mock 结果写成线上模型通过。

## 2. 在线入口与运行形态

- 站点：`https://timingmirror-85sdcc1aphk.qoder.website`（Qoder Sites，需登录；访问策略以平台当前设置为准）。
- 生产入口：`prototype/user-frontend/index.html`，启动脚本为 `prototype/user-frontend/app.js`。
- 根 `index.html` 只做跳转，不是业务页面。
- `src/main.js` 与 `src/ui/views/*` 是早期演示外壳/回归目标，当前站点入口不引用它们。
- 服务端函数：`server/site-functions`，与前端 `dist` 在同一个 Qoder Sites 发布动作中按同一提交发布。
- 运行时代码为浏览器原生 ES Modules；仓库没有 `dependencies`/`devDependencies` 与 lockfile，无需 `npm install` 才能运行页面或验证脚本。
- Node.js 用于本地静态服务器、测试与构建脚本；仓库未声明固定 Node 版本。

## 3. 页面与功能

页面使用 hash 路由；`#/contract` 是 `#/me` 的旧别名。

| 页面 | 当前行为 |
|---|---|
| 首页 `#/home` | 产品入口与流程说明；进入导入、示例报告或既有账单。 |
| 导入 `#/import` | 支持 CSV、TSV、Excel（首个工作表）、文本型 PDF、截图/扫描 PDF、图片与粘贴文字；`.xls` 不支持。文件优先本机解析；只有用户主动点击 AI 识别时才发送提取文字或所选压缩图片/PDF 页面。支持逐行编辑、手动新增成交行、勾选导入、删除、校验反馈、定位首条错误、重新导入；费用/税费可留空；识别次数与预算有上限。 |
| 报告 `#/report` | 展示实际收益、买入不动对照、择时差额、逐笔差额与操作归因、幽灵线/瀑布图、证据与计算路径、复核状态。用户账单只展示已复核发布的结果；示例场景明确标注非真实账户。报告页的 AI 解读只对已确认且非示例的用户账单开放，并按账单上下文绑定。 |
| 问答 `#/chat` | 先给本地确定性回答与证据；在线改写完成后再替换同一消息。问题中的断言数字先核对已发布事实；改写失败保留本地回答并给出具体原因与重试。 |
| 历史复盘 `#/scenario` | 自动加载当前账单的历史复盘，按真实成交逐笔对照当前已保存规则，区分违背、符合、无法确认、无此情境、未参与复核，并展示逐笔依据。复盘结果加载完成后才提供“让 AI 解释复盘结果”。 |
| 画像与规则 `#/me` | 画像摘要、关键词、跨账单记录；规则候选、当前规则、历史规则，以及新增、编辑、停用、恢复和版本记录。个人中心已移除单次“申报前自检”。 |

全局 AI 助手同时存在：页面帮助与 FAQ 在本机回答，不发送；只有用户主动点击明确的 AI 操作时，才按对应接口发送必要事实或内容。

### 近期整合的实际行为

- **#102**（merge `7ddf3ce`）：画像摘要失败返回脱敏原因并按瞬时错误单次重试；摘要新增关键词；画像事实改为回答后被动抽取并可在个人中心只读查看/撤销；规则候选迁到规则工作区。
- **#103**（原 PR 基于 #102 堆叠分支，未进入 main）：其问答改写修复由替代 PR #104（merge `6b4f241`）从 main 重建并合入。包含改写展示值归一、502 诊断、断言数字校验、问答可读性与用户视角评分卡/题库。
- **#95**（closed，未合入）：导入草稿校验反馈的核心行为已由 #96（merge `c5f4b8f`）实现并进入 main；未重新引入旧的同步实现。

## 4. 计算、行情与模型边界

- 确定性链路：`csvNormalize → marketCache → indicators / counterfactual / provenance → reviewPipeline`。报告数字来自该链路及复核结果，页面不自行重算或补造数字。
- 用户本地账单使用服务端获取的 Tushare 最新已收盘日线（非实时）；示例报告场景使用冻结的 Tushare 历史快照；合成夹具用于回归测试和无真实行情的演示分支，页面会明确标注。
- 规则保存、当前/历史版本、停用/恢复与历史复盘判定由本地规则引擎执行；模型不改变规则结论、不自动保存、不下单。
- 模型用于问题理解、规则草案理解、允许范围内的回答改写/解释。缺少 `DEEPSEEK_API_KEY`、`TUSHARE_TOKEN` 或云端身份时，相关功能应明确返回未配置/阻断，不静默使用替代数据。
- 真实模型、真实行情和浏览器交互需要单独验收；`npm run check`/`npm run smoke` 不替代这些验收。

## 5. 隐私与数据边界

- 原始 CSV、Excel、PDF、图片与文件名只在本机读取；产品不上传原始 CSV，也不把文件名写入云端账单/报告快照。
- 有云端身份时，确认后的**规范化成交明细**、派生统计与报告快照会同步到云端；历史账单可从云端恢复。规则在云端身份下保存；示例/无云端身份时保留本地演示记录。
- 用户主动触发图片/PDF 识别时，发送所选压缩截图或本地渲染页面图片给视觉模型；不发送原始文件。
- 其他 AI 功能按实际接口发送必要内容：问题、意图、页面已展示事实/证据、允许值清单，或改写所需的草稿/claims；不发送本地答案全文、原始 CSV、原始图片或文件名。
- 页面帮助与本地确定性回答在本机完成，不调用模型。
- 画像事实来自用户问答中的明确陈述，按现有保守 gate 被动抽取；个人中心提供只读依据与撤销入口。

## 6. 本地开发、构建与验证

```bash
npm run dev        # 零依赖本地静态服务器，默认 http://localhost:5180（可用 --port= 覆盖）
npm run check      # 离线夹具、引擎/Agent/UI/服务端契约与静态回归
npm run smoke      # Node 最小 DOM 桩的前端交互冒烟
npm run build:site # 生成 dist（根入口跳转到 prototype/user-frontend/index.html）
```

本地开发服务器会复用 `server/site-functions`：

- 未配置 `DEEPSEEK_API_KEY` 时使用开发用 fake 模型；配置后连接真实模型 transport。
- 未配置 `TUSHARE_TOKEN` 时行情能力明确不可用。
- 账单/画像等数据 API 在本地使用内存库与开发身份；重启即清空，不能当作线上存储。

验证边界：

- `npm run check` 与 `npm run smoke` 是离线/桩测试，不等于真实浏览器、真实行情或真实模型验收。
- `npm run build:site` 只做打包与路径校验，不发布。
- 仓库当前没有 `.github/workflows`，GitHub 上无 CI checks；不得把本地通过写成“CI 通过”。
- 合并 PR 不会自动发布；前端 `dist` 与服务端函数必须来自同一提交并由部署动作一起发布。

## 7. 仓库结构（摘要）

```
index.html                    根跳转页，不是业务入口
prototype/user-frontend/      生产用户端（入口 index.html、app.js 与页面适配）
server/site-functions/        Qoder Sites 服务端函数与数据 API
src/engine/                   确定性计算、行情、规则、复盘与导入草稿引擎
src/agent/                    问答、改写、画像、云端同步与边界校验
src/ui/                       共享 UI 组件与早期视图
src/demo/                     演示/示例场景适配与冻结行情
data/market-cache.json        行情缓存数据
m0/                           候选 schema、夹具与离线校验脚本
tests/                        引擎、Agent、服务端、UI 与冒烟回归
scripts/                      本地服务器、构建、QA 评分与拉数脚本
docs/                         实施基线、调研与验收记录
```

## 8. 部署与回滚

- 复用现有 Qoder Sites 站点与 projectId，不创建新站点。
- 发布输入：`webDirectory=dist`、`functionDirectory=server/site-functions`、`databaseAccess=read_write`；数据库依赖使用平台读取的 `schemaRef`，Secret 名称沿用现有 `DEEPSEEK_API_KEY`、`TUSHARE_TOKEN`。
- 未经明确授权不创建/执行数据库迁移，不修改表结构、Secrets、模型供应商、endpoint、超时或 thinking。
- 发布前记录当前 release/deployment/actionId/artifact SHA 作为回滚目标；发布后以 descriptor、冻结 artifact 与本地构建逐文件对账。
- 回滚优先恢复到上一个已知可用 release；平台不支持时从上一提交重新构建并以新 action 发布，不做破坏性数据库操作。

## 9. 贡献与协作

1. 从最新 `origin/main` 创建独立干净 worktree；不修改、不清理其他成员工作区与未提交内容。
2. 大功能单独分支、单独 PR；提交前运行 `npm run check`、`npm run smoke`、`npm run build:site`。
3. 按明确路径暂存，不使用 `git add .`；不提交 `dist`、临时文件、凭证或真实账单。
4. PR 描述写明改动、验证命令与结果、风险与回滚方式；合并前审阅实际 diff，避免混入无关改动。
5. 报告区分：计划 / 已确认事实 / 实际改动 / 验证结果 / 风险与未确认事项。本地检查、远程 CI、真实模型和人工验收分别报告。
6. 未经明确授权不操作浏览器、不调用真实模型、不修改 Secrets、不部署；不得用删除测试、跳过检查或降低阈值获得通过。
