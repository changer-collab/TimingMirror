# 账单 / 画像 / 意图与视觉接入：方案与实现记录（2026-10-23）

- 状态：**已实现并提交 PR；未合并、未部署；内置数据库未启用、迁移未执行。**
- 分支：`feat/profile-db-ai-2026-10-23`
- 功能提交：`514e238`（`feat: 打通账单与画像的云端数据链路`）；本文档随后续文档提交更新
- PR：[#64](https://github.com/changer-collab/TimingMirror/pull/64)（Open；功能提交 `514e238` 为 1 commit、46 files、+5605 / −29；本文档提交后文件数会增加；无冲突；仓库未配置 CI，GitHub 显示 `Checks 0`）
- 本文取代旧版“本轮只做方案设计、不改代码”的草案；旧稿中的 4 PR 拆分、接口命名、画像 schema、意图上下文和视觉双通道均按实际实现改写，差异见 §9。

> 口径说明：本文的“已实现”指代码、自动化测试和本机 fake 模型浏览器链路已接通；不等于真实 DeepSeek、真实 Tushare、双用户隔离或线上部署已经验收。原始 CSV 仍不上传，默认只同步统计与内容指纹。

---

## 0. 一页结论

| 工作项 | 实际交付 | 当前状态 |
|---|---|---|
| 用户画像持续构建 | 确定性账单统计 + 用户明确陈述的事实 + AI 解读；画像数据落内置数据库 | 代码与测试完成；DB 未启用 |
| 多账单与云同步 | 追加式账单、内容哈希去重、默认仅统计、完整明细需显式勾选、可删除 | 本机内存 Supabase 验证通过 |
| 后端数据接口 | `/api/bills`、`/api/profile` 及其子路由；Gateway 身份 + 应用层 `user_id` 过滤 | 代码完成；线上函数仍是旧版 |
| AI 画像 | `/api/llm/profile-summary`、`/api/llm/profile-fact`，严格 JSON schema + 模板兜底 | fake 模型验证；真实 Key 未在本机跑 |
| 意图识别 | L1/L2/L3；`contract_setup` 误判修复；服务端 12 类意图严格校验 | 25 条固定合成用例，本地 fake 评测 |
| 视觉识别 | 统一 `deepseek-flash` 多模态（`image_url` + `json_object`） | fake 模型 200；真实视觉未在本机跑 |
| 交付 | 单个 PR #64 | 未合并、未部署 |

---

## 1. 目标与边界

### 1.1 目标

1. **用户画像持续构建**：用户多次导入账单后，系统把可复核的统计结果与用户明确陈述长期保留下来，供 AI 形成稳定画像，而不是每次从零解释。
2. **意图识别与模型接入**：检查问答意图路由；把 DeepSeek 文本与视觉模型接入既有问答和图片导入链路。
3. **前端数据库接入**：前端完成账单保存、历史读取、画像展示、对话事实写入与云同步状态展示。

### 1.2 本轮不做

- 不修改计算引擎、真实 CSV 解析和行情缓存口径。
- 不修改悬浮助手，不修改吴涵晶负责的未匹配 AI 兜底逻辑。
- 不上传原始 CSV 文件、文件名或账户信息。
- 不部署、不启用线上数据库、不执行线上迁移。
- 不提交真实账户或成交数据；验证只用合成账单与冻结行情。

### 1.3 UI 范围

只改独立问答页 `#/chat`、头像个人中心的规则/画像区域、复盘页相关入口；不动悬浮助手。

---

## 2. 已拍板决策

| 决策 | 结论 |
|---|---|
| 画像口径 | **确定性事实 + AI 完善**。数字和标签先由本地引擎确定，AI 只做易懂的解释，不生成新数字。 |
| 存储 | 比赛演示使用 **Qoder 内置数据库**；官方 adapter 为匿名模式。 |
| 多账单 | 账单可追加，不覆盖；默认存元数据 + 派生快照。完整成交明细默认不上传，需用户显式勾选。 |
| 去重 | 客户端与服务端用同一内容哈希；同一用户重复导入同一份账单返回 duplicate，不新增记录。 |
| 对话补画像 | 只记录用户**明确陈述**的目标、偏好、约束、习惯、风险承受度；必须保留原文短证据。 |
| 视觉模型 | 统一使用 **`deepseek-flash`**；DashScope 仅保留人工回滚，不自动切换。 |
| 意图输出 | 服务端严格 schema：12 类意图、仅 `symbol` / `trade_date` 槽位、置信度 `[0,1]`。 |
| 交付 | 一个 PR；本轮不部署；真实模型与部署需单独授权。 |
| 用户区分 | 当前由 Qoder Gateway 身份提供 `user_id`；自定义“用户名 + 密码”登录为**待评审方案**，本轮未实现，详见 §12。 |
| 数据隔离 | 依赖 Gateway 注入的身份头 + 应用层 `user_id` 过滤；**不宣称数据库级隔离**。 |

---

## 3. 数据库设计

### 3.1 内置数据库约束

Qoder 内置数据库的迁移只接受受限 DDL：

- 支持 `CREATE TABLE app.<table>`、`ALTER TABLE ... ADD COLUMN`、普通 `CREATE INDEX`；
- 类型仅 `boolean / integer / bigint / text / uuid / timestamptz / jsonb`；
- 不支持 `date`、`DEFAULT`、`CHECK`、外键、生成列。

因此实际迁移中：

- 业务日期统一用 `text`（`YYYY-MM-DD`），由应用层校验；
- 时间戳用 `timestamptz`，值由应用写入，不依赖数据库默认值；
- 唯一性主要靠应用层校验 + 数据库唯一索引（`bill_key`、`fact_hash`）；
- 表位于 `app` schema。

### 3.2 表结构

迁移文件：[`db/migrations/001_bills_profile.sql`](../../db/migrations/001_bills_profile.sql)

#### `app.bills`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` PK | 账单 ID |
| `user_id` | `text` | Gateway 身份，应用层隔离键 |
| `bill_key` | `text` UNIQUE | `sha256(user_id + "\n" + content_hash)`，用于同用户去重 |
| `content_hash` | `text` | 成交内容哈希（客户端/服务端一致） |
| `context_id` | `text` | 前端账单上下文 ID，可为空 |
| `status` | `text` | 当前固定 `confirmed` |
| `source_type` | `text` | 当前固定 `local` |
| `effective_date` | `text` | 最后一笔交易日，可为空 |
| `imported_at` | `timestamptz` | 导入时间 |
| `payload_mode` | `text` | `summary` 或 `full` |
| `metadata_json` | `jsonb` | 统计元数据（笔数、日期范围、标的数、数据模式、警告数） |
| `payload_json` | `jsonb` | 成交明细；`summary` 模式为 `null` |
| `snapshot_json` | `jsonb` | 该账单对应的报告快照 |
| `snapshot_hash` | `text` | 快照内容哈希，用于幂等 |
| `snapshot_at` | `timestamptz` | 快照写入时间 |
| `created_at` / `updated_at` | `timestamptz` | 应用写入 |

索引：`bills_user_idx (user_id)`。

#### `app.profile_facts`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` PK | 事实 ID |
| `user_id` | `text` | 应用层隔离键 |
| `kind` | `text` | `goal / preference / constraint / habit / risk_tolerance` |
| `fact_key` | `text` | 短 slug，例如 `max_drawdown` |
| `fact_value` | `text` | 事实内容，≤240 字符 |
| `evidence` | `text` | 用户原话连续片段，≤120 字符；`source=chat` 时必填 |
| `source` | `text` | `chat` 或 `manual` |
| `source_ref` | `text` | 对话/账单上下文 ID |
| `confidence` | `integer` | 当前固定 100（只存明确陈述） |
| `fact_hash` | `text` UNIQUE | `sha256(user_id + kind + key + value)` |
| `created_at` / `updated_at` | `timestamptz` | 应用写入 |

索引：`profile_facts_user_idx (user_id)`。

#### `app.profiles`

| 字段 | 类型 | 说明 |
|---|---|---|
| `user_id` | `text` PK | 每用户一行 |
| `summary_json` | `jsonb` | AI 解读缓存（已通过 schema 校验） |
| `summary_source_hash` | `text` | 生成解读所用 digest 的 SHA-256 |
| `summary_at` | `timestamptz` | 生成时间 |
| `summary_version` | `integer` | 当前为 1 |
| `created_at` / `updated_at` | `timestamptz` | 应用写入 |

### 3.3 访问策略

策略文件：[`db/migrations/001_bills_profile.policies.json`](../../db/migrations/001_bills_profile.policies.json)

| 表 | principal | actions | template |
|---|---|---|---|
| `bills` | `anonymous` | select / insert / update / delete | `public` |
| `profile_facts` | `anonymous` | select / insert / delete | `public` |
| `profiles` | `anonymous` | select / insert / update | `public` |

这是匿名 adapter 的要求，不是“每用户行级隔离”。真正的隔离靠：

1. Gateway 注入 `x-qoder-user-context`；
2. `requireUser(request)` 解析 `user_id`；
3. 所有查询 `.eq('user_id', user.user_id)`；
4. 请求体不接受任何 owner 字段。

### 3.4 数据上限

| 项 | 上限 |
|---|---|
| 单账单成交笔数 | 2000 |
| 账单请求体 | 1 MB + 64 KB |
| 元数据 | 16 KB |
| 报告快照 | 512 KB |
| 单次事实写入 | 10 条 |
| 事实请求体 | 32 KB |
| 画像摘要请求体 | 64 KB |
| 账单列表 | 默认 20，最大 50 |

### 3.5 内容哈希与去重

客户端 [`src/agent/billSync.js`](../../src/agent/billSync.js) 与服务端 [`server/site-functions/dataApi.mjs`](../../server/site-functions/dataApi.mjs) 使用完全相同的算法：

1. 每笔成交取 `trade_date / symbol / side / price / quantity / fee / tax`；
2. 数字用 `String(number)`；`fee` / `tax` 为 `null` 时取空串；
3. 字段用 `\t` 连接；
4. 所有行排序后用 `\n` 连接；
5. 计算 SHA-256 小写十六进制。

补充口径：

- 成交顺序、`trade_id`、文件名不参与哈希，因此同一份账单换顺序重导仍判重；
- `bill_key = sha256(user_id + "\n" + content_hash)`，不同用户导入同一份数据互不影响；
- 已存在 `summary` 记录时，再次以 `full` 导入会补写 `payload_json` 并升级 `payload_mode`，不新增行；
- 账单快照按账单 ID 保存，快照内容哈希相同则返回 duplicate；
- 删除账单只删云端记录，本机报告与画像不受影响。

---

## 4. API 与身份

### 4.1 数据接口

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/api/bills?limit=&offset=` | 当前用户账单列表，按 `imported_at` 倒序 |
| `POST` | `/api/bills` | 新增账单；重复返回 `200 { duplicate: true }` |
| `GET` | `/api/bills/:id` | 单份账单；仅 `payload_mode=full` 时返回 `payload` |
| `DELETE` | `/api/bills/:id` | 删除当前用户账单 |
| `POST` | `/api/bills/:id/snapshot` | 写入报告快照，按内容哈希幂等 |
| `GET` | `/api/profile` | 返回最近 100 条事实 + 画像摘要缓存 |
| `POST` | `/api/profile/facts` | 追加对话/手动事实；重复返回 `duplicates` |
| `DELETE` | `/api/profile/facts/:id` | 删除当前用户的一条事实 |
| `POST` | `/api/profile/summary` | 保存已校验的 AI 解读缓存 |

### 4.2 模型接口

| 方法 | 路径 | 行为 |
|---|---|---|
| `POST` | `/api/llm/profile-summary` | 输入确定性 digest，输出 8 字段解读；模型不可用时返回模板兜底 |
| `POST` | `/api/llm/profile-fact` | 输入用户单条消息，输出最多 3 条明确陈述的事实 |
| `POST` | `/api/llm/intent` | 12 类意图识别，服务端严格校验后只返回规范化 JSON |
| `POST` | `/api/llm/import-vision` | DeepSeek 多模态识别账单截图/扫描 PDF 页面 |

### 4.3 身份与隔离

[`server/site-functions/auth.mjs`](../../server/site-functions/auth.mjs)：

- 读取 Gateway 注入的 `x-qoder-user-context`；
- 校验 base64url 编码、字段形状、长度、会话过期时间；
- 校验 `user_id / site_id / host_id` 必填，`name / picture / org_id` 可选；
- 只做形状校验，**不验证签名**；隔离依赖平台入口不可绕过。

失败语义：

- 缺少身份头 → `401 login_required`；
- 身份头格式/过期非法 → `403 invalid_user_context`；
- 数据库未启用或缺少 `SUPABASE_*` → 数据接口 `503 database_unavailable`；
- 模型接口不受数据库状态影响，仍可单独工作。

[`server/site-functions/adapter.mjs`](../../server/site-functions/adapter.mjs) 是传输守卫：

- 要求 `x-instance-id` 为 UUID；
- 校验 `SUPABASE_URL` 为纯 origin，`SUPABASE_ANON_KEY` 非空；
- 只允许访问 `/rest/v1`，拒绝重定向、cookie、非数据库 origin；
- 移除浏览器的 `x-instance-id / x-qsites-origin / authorization / cookie` 后交给业务；
- **不是数据库授权层**，业务所有权必须在 handler 里按 `user_id` 过滤。

---

## 5. 画像：确定性 + AI 完善

### 5.1 确定性 digest

[`src/agent/profileDigest.js`](../../src/agent/profileDigest.js) 生成、服务端 [`profileSummary.mjs`](../../server/site-functions/profileSummary.mjs) 复核的 digest 固定为：

```js
{
  profile_key,              // 8 位十六进制
  bills: { count, date_from, date_to },
  metrics: {
    actual_return, benchmark_return, drag_pp, drag_amount,
    trade_count, win_rate, pgr, plr
  },
  behavior: { tags[], patterns[] },
  rules: { total, kept, warned },
  facts: [{ kind, key, value }],
  limits: []
}
```

约束：

- 服务端只接受上述字段，禁止额外字段；
- `facts` 最多 20 条，按 `kind + key + value` 去重；
- digest 总体不超过 16 KB；
- 客户端与服务端对同一 digest 的 SHA-256 必须一致，用于判断缓存是否过期；
- AI 只拿 digest，不拿成交明细、文件名、账户或原始对话。

### 5.2 AI 解读 schema

服务端固定输出：

```js
{
  schema_version: 1,
  headline: string,        // ≤24 字
  summary: string,         // ≤240 字
  strengths: string[],     // ≤3 条，每条 ≤60 字
  blind_spots: string[],   // ≤3 条，每条 ≤60 字
  next_actions: string[],  // ≤3 条，每条 ≤60 字
  confidence: "low" | "medium" | "high",
  data_limits: string[]    // ≤3 条，每条 ≤80 字
}
```

校验规则：

- 顶层字段必须**恰好**是以上 8 个，不能多也不能少；
- 文本中出现的数字必须来自 digest（含百分比换算、日期年份）；
- 日期必须是 digest 提供的起止日期，否则拒绝；
- 拒绝 URL、成交明细、账户/银行卡/身份证/手机号等越界内容；
- 拒绝“建议买入/卖出、荐股、目标价、保证收益、稳赚、必涨/必跌”等投资建议；
- `confidence` 按样本封顶：
  - 账单 ≥3 份且交易 ≥20 笔 → `high`
  - 账单 ≥1 份 → `medium`
  - 无账单 → `low`
- 模型未配置、超时、响应非法时，返回**模板兜底**（`source: template`），前端明确标注，不把模板说成 AI；
- 解读可缓存：`summary_source_hash` 与当前 digest 哈希一致才视为新鲜。

### 5.3 对话事实 schema

[`profileFact.mjs`](../../server/site-functions/profileFact.mjs) 固定输出：

```js
{ facts: [{ kind, key, value, evidence }] }
```

约束：

- 最多 3 条；
- `kind` 仅 5 类；
- `value` ≤240 字符，`evidence` ≤120 字符；
- `evidence` 必须是用户原话的**连续子串**；
- 拒绝手机号/身份证/银行卡/密码/验证码、URL；
- 证据必须包含投资相关词；
- 前端还有一层前置门：第一人称 + 陈述句式 + 金融词，且排除问句和“帮我/告诉我”等请求句；
- 落库按 `kind + key + value` 去重；重复只返回 `duplicates`，不新增；
- 问答回答已展示后，画像写入失败不回滚回答，只显示提示。

### 5.4 前端行为

- 导入页默认只同步统计与内容指纹；勾选“同时云端保存完整成交明细”才上传成交行。
- 云同步状态：`pending`（同步中）、`synced`（已同步）、`failed`（仅本机）、`local`（不可同步）、`demo`（示例账单不参与）。
- 同步失败不阻断本机报告与问答；状态可就地重绘。
- 个人中心画像区域展示：云端账单数、事实数、画像解读、事实原文证据、删除入口。
- 画像解读由用户点击“生成 AI 解读”触发，生成后保存缓存；digest 变化时旧解读隐藏并提示重新生成。
- 所有删除为两步确认，避免误触。

---

## 6. 意图识别

### 6.1 三层路由

[`prototype/user-frontend/qaIntent.js`](../../prototype/user-frontend/qaIntent.js)：

1. **L1 确定性规则**：命中即返回，不调模型；
2. **L2 在线意图**：仅 L1 未命中时调用 `/api/llm/intent`；
3. **L3 澄清**：模型未就绪、置信度不足、意图不在支持范围或槽位不足时，明确说“不知道”，不猜。

参数：

- `MIN_L2_CONFIDENCE = 0.5`；
- 12 类意图：`worst_trade, loss_overview, pattern_explain, profile, what_if, similar_context, how_to_change, contract_setup, contract_status, meta_calc, meta_trust, out_of_scope`；
- L2 只发送 `{ question }`，不发送账单、成交、事实或文件名；
- 前端会把模型槽位与本地槽位合并，本地已识别的代码/日期优先。

### 6.2 已修复的误路由

“止损/止盈”相关问句原先会被 `contract_setup` 吃掉，例如“我的止损规则还生效吗”。现在：

- `contract_setup` 增加排除条件：规则/止损/止盈/提醒 + 守得住/生效/触发/违反/状态/表现；
- 这类问句落到 `contract_status`，由本地规则账本回答；
- 对应单测已加入 `qa-intent`（48/48）。

### 6.3 服务端严格 schema

[`chatIntent.mjs`](../../server/site-functions/chatIntent.mjs)：

- 顶层只允许 `intent / slots / confidence`；
- `slots` 只允许 `symbol / trade_date`；
- `symbol` 必须六位数字；
- `trade_date` 必须是合法日期并规范化为 `YYYY-MM-DD`；
- `confidence` 必须是 `[0,1]` 数值；
- 允许模型返回带 ```json 围栏的 JSON；
- 非法响应 → `502 E_MODEL_RESPONSE_INVALID`，只返回错误码，不泄露模型正文；
- 校验通过后只回传规范化 JSON，模型多写的字段被丢弃。

### 6.4 评测现状

- 固定合成用例：**25 条**（[`tests/agent/intent-eval-cases.mjs`](../../tests/agent/intent-eval-cases.mjs)），覆盖 12 类意图与槽位；
- 另有 `qa-intent` 48 条路由/边界单测；
- 本地 fake 模型评测：25/25 strict，25/25 accepted，1/1 槽位，0 请求失败；
- **真实 DeepSeek 未在本机评测**（无 `DEEPSEEK_API_KEY`）。

---

## 7. 视觉识别

### 7.1 模型与请求

- 统一使用 `deepseek-flash`（[`provider.mjs`](../../server/site-functions/provider.mjs) / [`deepseek.mjs`](../../server/site-functions/deepseek.mjs)）；
- Chat Completions + `image_url` data URL；
- `response_format: { type: 'json_object' }`；
- `DEEPSEEK_MODEL` 可覆盖模型，缺省即 `deepseek-flash`；
- DashScope 适配器保留在 `dashscope.mjs`，**仅人工回滚**，DeepSeek 缺失或失败时不自动切换，也没有模型切换 UI。

### 7.2 客户端约束

[`src/agent/importVision.js`](../../src/agent/importVision.js)：

- 单请求最多 8 张；
- 单图 Base64 ≤2,000,000 字符；
- 总 Base64 ≤7,000,000 字符；
- JSON 请求体 ≤7,500,000 字节；
- 仅 JPEG/PNG；
- 超出时要求缩小范围，不静默截断；
- 本机先压缩，再上传。

### 7.3 人工校验

- 视觉结果只生成**可编辑草稿**，不直接入库；
- 用户必须逐行核对后点击导入；
- 导入失败可重试，fake 模型覆盖失败/重试路径。

---

## 8. 实际交付与验证

### 8.1 代码范围

| 区域 | 主要文件 |
|---|---|
| 数据库迁移 | `db/migrations/001_bills_profile.sql`、`001_bills_profile.policies.json` |
| 函数入口与适配 | `server/site-functions/index.ts`、`adapter.mjs`、`auth.mjs` |
| 数据 API | `server/site-functions/dataApi.mjs`、`handler.mjs` |
| 画像 AI | `server/site-functions/profileSummary.mjs`、`profileFact.mjs`、`deepseek.mjs`、`provider.mjs` |
| 意图校验 | `server/site-functions/chatIntent.mjs`、`dashscope.mjs`（提示词） |
| 前端数据层 | `src/agent/dataClient.js`、`billSync.js`、`profileDigest.js`、`profileSignals.js`、`cloudProfileModel.js`、`httpTransport.js` |
| 前端页面 | `prototype/user-frontend/cloudSync.js`、`cloudProfile.js`、`qaIntent.js`、`realImport.js`、`realProfile.js`、`realChat.js`、`realBridge.js`、`app.js` 及样式 |
| 本机开发 | `scripts/serve.mjs`、`scripts/dev-memory-supabase.mjs`、`scripts/local-fake-import-model.mjs` |
| 测试 | `tests/server/data-api.test.mjs`、`profile-ai.test.mjs`；`tests/agent/bill-sync.test.mjs`、`cloud-profile-model.test.mjs`、`cloud-sync.test.mjs`、`data-client.test.mjs`、`profile-digest.test.mjs`、`profile-signals.test.mjs`；以及 `http-transport`、`local-dev-import`、`site-function`、`qa-intent` 的增量用例 |

### 8.2 自动化验证

执行时间：2026-10-23（提交 `514e238`，工作区干净）。

```text
npm run check
CHECK_EXIT=0
```

- 各套件汇总均为“失败 0”；
- 日志中 `PASS` 行共 2586 条（包含用例名与汇总行）；
- 新增相关套件：`data-api` 64/64、`profile-ai` 52/52、`site-function` 117/117、`qa-intent` 48/48、`deepseek` 34/34。

```text
npm run smoke
== 合计 303 项检查：通过 303，失败 0 ==
SMOKE_EXIT=0
```

### 8.3 本机浏览器验收

环境：`http://localhost:5191`，本机 dev server，fake 模型，dev-only 内存 Supabase；账户与账单均为合成数据。

- 导入合成 CSV（6 笔交易，2025-03-20 → 2025-04-16，2 个标的）→ 报告生成；示例场景识别正常。
- 独立问答页输入“我为什么总是在同一个地方栽跟头”：
  - L1 未命中；
  - `POST /functions/v1/app/api/llm/intent` → `200`；
  - 页面显示“追高解释 / 在线意图 / 3 条事实 已校验”；
  - 未发送账单或成交明细。
- 视觉导入：
  - 上传标准 JPEG，本机压缩到约 6.0 KB；
  - `POST /functions/v1/app/api/llm/import-vision` → `200`；
  - 页面生成 1 行可编辑草稿，未自动入库。
- 云同步：
  - 导入后默认同步统计，状态从 `pending` → `synced`；
  - 重复导入同一账单返回 duplicate，列表不增加；
  - 删除云端账单后本机报告仍可用；
  - 刷新后画像/账单历史可重新读取。

### 8.4 未验证

- **真实 DeepSeek 文本与视觉**：本机无 `DEEPSEEK_API_KEY`，未跑真实请求；请求构造、超时、错误映射由单测覆盖。
- **真实 Tushare 行情**：本机无 `TUSHARE_TOKEN`；动态行情依赖部署环境。
- **双用户隔离**：只有 fake/内存实现与跨用户单测，未在真实 Gateway + 真实数据库上做 A/B。
- **线上数据库迁移、函数部署、站点发布**：均未执行。
- **CI**：仓库未配置，PR 显示 `Checks 0`，不能表述为“CI 通过”。

---

## 9. 与原方案的差异（设计 vs 实际）

| # | 项目 | 原方案 | 实际实现 | 原因 / 影响 |
|---|---|---|---|---|
| 1 | 交付方式 | 本轮只做方案设计，不改代码 | 已完成实现并提交 PR #64 | 负责人后续明确要求落地；本轮仍不部署 |
| 2 | PR 拆分 | 拆 4 个 PR | **1 个 PR**（46 files） | 负责人要求单 PR 交付；评审面较大，但回滚以整体 PR 为单位 |
| 3 | 前端数据层 | 新增 `prototype/user-frontend/siteApi.js` | `src/agent/dataClient.js` + `prototype/user-frontend/cloudSync.js` + `cloudProfile.js`，并拆出 `billSync.js` / `profileDigest.js` / `profileSignals.js` | 数据客户端放在 `src/agent` 便于复用与单测；页面层只负责状态与渲染 |
| 4 | 画像接口 | `/api/profile/summarize` | AI 解读：`/api/llm/profile-summary`；缓存保存：`/api/profile/summary`；对话事实：`/api/llm/profile-fact` + `/api/profile/facts` | 模型调用与数据写入分开：模型接口无数据库依赖，数据接口在 DB 未启用时只影响云端保存 |
| 5 | 意图上下文 | L2 发送 `{ question, last_intent, last_slots }` | **只发送 `{ question }`**；多轮槽位由前端本地合并 | 减少隐私面与契约复杂度；代价是模型看不到上一轮意图，指代型追问仍依赖本地槽位 |
| 6 | 意图评测集 | 40 条固定用例 | **25 条**固定用例 + 48 条 L1/边界单测 + 服务端 schema 单测 | 先覆盖 12 类与关键误判；真实模型尚未评测，后续应补足 40 条并在真实 Key 上跑 |
| 7 | 视觉通道 | 双 provider + 自动回退 | 统一 `deepseek-flash`；DashScope 仅**人工回滚**，不自动切换、无 UI 切换 | 避免模型失败时静默换模型导致口径不一致；DeepSeek 不可用即明确报错/降级 |
| 8 | 画像 AI schema | `{ summary, highlights, caveats }` | 8 字段：`schema_version / headline / summary / strengths / blind_spots / next_actions / confidence / data_limits` | 前端需要结构化展示“做得好的 / 可能没注意的 / 下一步 / 样本局限”；校验更严格 |
| 9 | 数据库落地 | 只做表设计 | 迁移 SQL + 策略 JSON + 代码 + 测试均已提交；**线上 DB 仍 disabled、schema_version 0、函数 database_access none** | 部署需单独授权；当前数据接口在线上会 503，模型接口不受影响 |
| 10 | 日期字段 | 设计使用 `date` | 全部用 `text`（`YYYY-MM-DD`） | 内置数据库 DDL 不支持 `date`、`DEFAULT`、`CHECK`，只能应用层校验 |
| 11 | 隔离层级 | 原方案已提示隔离限制 | 官方 adapter 为匿名模式，只能应用层 `user_id` 过滤 | 不能宣称数据库级隔离；安全边界依赖 Gateway 不可绕过 |
| 12 | 画像生成时机 | 设计未明确自动/手动 | 用户点击“生成 AI 解读”；结果按 digest 哈希缓存 | 避免每次导入都产生模型调用与费用；用户可主动刷新 |
| 13 | 事实来源 | 设计包含对话补画像 | 只记录明确陈述；问句、请求句、AI 推断不记录 | 防止把模型猜测写进用户画像；证据必须原文连续子串 |
| 14 | 完整明细 | 设计为显式开关 | 默认 `summary`；勾选后 `full`；已存在 `summary` 时可升级为 `full` | 降低隐私与存储风险；重复导入不新增行 |

---

## 10. 风险与未决事项

1. **应用层隔离风险**：数据库策略是匿名 public；若 Gateway 入口被绕过或身份头可伪造，隔离失效。上线前必须确认平台入口不可绕过。
2. **真实模型未验收**：当前所有“在线意图 / 视觉 / 画像解读”结果均来自 fake 模型或单测；真实 DeepSeek 的准确率、延迟、限流、视觉质量未知。
3. **真实行情未验收**：Tushare token 只在部署环境配置；本机报告使用冻结示例行情。
4. **评测集偏小**：25 条固定用例不足以证明真实模型覆盖；尤其指代型追问、混合意图、低置信度边界。
5. **L2 无多轮上下文**：模型只看到当前问题；如果本地 L1/槽位没有识别出指代，可能落到澄清。
6. **完整明细上传**：一旦用户勾选，成交行会上传云端；虽然可删除，但需在隐私说明中持续明确。
7. **并发写**：账单靠唯一索引兜底重复；事实写入逐条插入，部分成功会返回已添加项；前端需能接受部分成功。
8. **无 CI**：所有验证为本地执行；PR 合并前需人工复核测试日志。
9. **数据库迁移不可用 `DROP`/复杂 DDL**：后续 schema 变更只能加列/加表/加索引；设计时需预留。
10. **部署顺序**：必须先启用数据库、执行迁移，再发布 `databaseAccess: read_write` 的函数；否则新前端的数据接口会 503。
11. **自定义登录未实现**：当前用户区分完全依赖 Qoder Gateway；如果脱离 Qoder 环境，必须补账号体系，不能把 `user_id` 交给前端自报。§12 只是设计，代码、迁移和测试均未落地。

---

## 11. 后续建议（均需单独授权）

1. 在部署环境配置真实 `DEEPSEEK_API_KEY`，跑 25 条意图评测 + 视觉/画像解读端到端。
2. 用两个真实账户做 A/B：A 导入账单，B 不可见；B 直接访问 A 的账单 ID 返回 404。
3. 补足 40 条意图用例，覆盖多轮指代、混合意图、低置信度和越界问题。
4. 评估是否把 `last_intent / last_slots` 加入 L2；若加入，需同步更新服务端 schema 与隐私说明。
5. 合并 PR #64 后按 [`qoder-site-deploy-2026-10-23.md`](./qoder-site-deploy-2026-10-23.md) 部署。
6. 部署后观察 `/api/bills`、`/api/profile` 的 503/401/写失败比例，再决定是否扩大完整明细同步范围。
7. 先确认比赛现场是否允许所有评委/测试者使用 Qoder 账号登录；只有“必须使用独立账号”时才进入 §12 的本地账号实现。

---

## 12. 用户区分与注册 / 密码登录设计（提案，未实现）

> 本节只是设计，不包含代码、迁移、接口或 UI 改动，也不在 PR #64 范围内。当前线上用户区分仍由 Qoder Gateway 完成。

### 12.1 现在怎么区分用户

Qoder Site 的 Gateway 会在每个函数请求上注入 `x-qoder-user-context`，其中包含 `user_id`。服务端 [`auth.mjs`](../../server/site-functions/auth.mjs) 校验形状后，所有账单/画像查询都按这个 `user_id` 过滤：

```text
浏览器 → Qoder Gateway（登录态） → x-qoder-user-context → requireUser → user_id → 数据库按 user_id 过滤
```

因此：

- **同一个 Qoder 账号**在不同设备/浏览器看到同一份云端数据；
- **不同 Qoder 账号**互相不可见；
- 前端不能自报 `user_id`，请求体里也没有 owner 字段；
- 这套隔离是**应用层**的，不是数据库行级安全（RLS）。

如果比赛现场所有评委/测试者都能用 Qoder 账号登录，**不需要再做注册/密码登录**；自建账号只会增加密码泄露、撞库、会话固定和找回密码的风险。

### 12.2 什么时候才需要自建账号

满足以下任一条件时，才考虑本地账号：

1. 评委/测试者没有 Qoder 账号，且不能临时注册；
2. 需要脱离 Qoder Site 独立部署；
3. 产品明确要求用户名展示、账号找回或账号注销；
4. 需要把“演示账号”和“真实 Qoder 账号”分开管理。

### 12.3 三种方案对比

| 方案 | 用户来源 | 密码处理 | 隔离 | 风险 | 适用 |
|---|---|---|---|---|---|
| **A. 继续用 Gateway（推荐）** | Qoder 登录态 | 平台负责，本项目不接触密码 | 应用层 `user_id` 过滤 | 依赖平台入口不可绕过 | 现有比赛站点 |
| **B. 纯本地账号** | 自建 `users` 表 | 本项目负责哈希、会话、找回 | 应用层 `user_id` 过滤 | 密码/会话/限流/CSRF 全部自己承担 | 独立部署、无平台身份 |
| **C. 混合模式** | Gateway 优先，本地账号兜底 | 仅本地账号需要处理密码 | 用前缀区分身份命名空间 | 两套身份可能混淆，必须禁止同请求双身份 | 比赛现场需要独立测试账号 |

**建议**：

- 当前比赛站点选 **A**，不实现注册/密码登录；
- 如果必须给无 Qoder 账号的评委发独立账号，选 **C**，并只在演示环境开启；
- 不建议在当前“匿名 adapter + public 策略”的内置数据库上做纯 **B** 的生产级账号系统。

### 12.4 身份命名空间

现有三张业务表的 `user_id` 都是 `text`，无需改表：

- Gateway 用户：保持 Gateway 返回的原值；
- 本地用户：`local:<uuid>`；
- 禁止把两者混用；同一请求只能有一个身份来源；
- 如果 Gateway 头和本地会话同时存在且指向不同用户，直接拒绝（`409 identity_conflict`），不做“自动合并”。

不自动做账号绑定：Gateway 用户和本地用户是两条独立数据线；未来若要做绑定，必须走独立的“证明所有权”流程，不能凭用户名相同合并。

### 12.5 数据模型（设计，迁移 `002_auth_local.sql`）

> 内置数据库只支持受限 DDL；以下字段需按实际约束调整（日期用 `text` 或 `timestamptz`，不使用 `DEFAULT` / `CHECK`）。

#### `app.users`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` PK | 本地用户 ID；对外 `user_id = 'local:' + id` |
| `username` | `text` UNIQUE | 原始输入，仅用于展示 |
| `username_norm` | `text` UNIQUE | 小写规范化后的登录名 |
| `password_hash` | `text` | PHC 字符串：`pbkdf2_sha256$iterations$salt$hash` |
| `status` | `text` | `active` / `disabled` |
| `failed_attempts` | `integer` | 连续失败次数 |
| `locked_until` | `timestamptz` | 锁定截止时间，可空 |
| `recovery_hash` | `text` | 一次性恢复码的哈希，可空 |
| `created_at` / `updated_at` | `timestamptz` | 应用写入 |
| `last_login_at` | `timestamptz` | 最近登录，可空 |

#### `app.sessions`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` PK | 会话 ID |
| `user_id` | `text` | `local:<uuid>` |
| `token_hash` | `text` UNIQUE | 会话令牌的 SHA-256；不存明文 |
| `csrf_hash` | `text` | CSRF token 的 SHA-256 |
| `created_at` | `timestamptz` | 创建时间 |
| `expires_at` | `timestamptz` | 绝对过期（7 天） |
| `idle_expires_at` | `timestamptz` | 空闲过期（24 小时） |
| `last_seen_at` | `timestamptz` | 最近访问 |
| `revoked_at` | `timestamptz` | 注销/撤销时间，可空 |

#### `app.auth_attempts`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `uuid` PK | 记录 ID |
| `key_hash` | `text` | `sha256(username_norm + '\n' + ip_hash)`，不存原始 IP |
| `attempted_at` | `timestamptz` | 尝试时间 |
| `success` | `boolean` | 是否成功 |

索引：`auth_attempts_key_idx (key_hash, attempted_at)`。

**策略限制**：当前 adapter 使用匿名 anon key，`app.users` / `app.sessions` 若要让函数访问，策略只能是匿名可读写；这等于把保护全部压在函数代码上，**不是数据库级安全**。因此：

- 比赛演示可以接受，但必须限制函数只暴露最小查询；
- 生产环境应改用平台身份、Service Role + RLS，或独立认证服务；
- 不要把 `users` / `sessions` 的查询开放成通用 REST 代理。

### 12.6 接口与流程（设计）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 用户名 + 密码注册；成功后直接建立会话 |
| `POST` | `/api/auth/login` | 用户名 + 密码登录 |
| `POST` | `/api/auth/logout` | 撤销当前会话并清 Cookie |
| `GET` | `/api/auth/me` | 返回当前用户、CSRF token、会话过期时间 |

注册流程：

1. 校验用户名/密码格式；
2. 规范化用户名，查重；
3. 生成随机盐，PBKDF2 哈希；
4. 插入 `users`；
5. 创建会话，Set-Cookie；
6. 返回 `201` 和脱敏用户信息（绝不返回密码哈希）。

登录流程：

1. 按 `username_norm` 查用户；
2. 检查锁定与失败次数；
3. 用户不存在时也对一个固定 dummy hash 做一次校验，避免时序泄露；
4. 校验成功 → 清零失败计数、更新 `last_login_at`、创建新会话；
5. 校验失败 → 记录失败、必要时锁定，返回统一的“用户名或密码错误”；
6. 会话令牌轮换，旧会话不继承。

会话解析顺序（混合模式）：

```text
1. 有 Gateway 身份头 → 使用 Gateway user_id；
2. 没有 Gateway 头 → 校验本地会话 Cookie；
3. 两者都有且不一致 → 409 identity_conflict，拒绝请求；
4. 都没有 → 401 login_required。
```

### 12.7 密码、会话与防滥用规则

**用户名**

- 3–32 字符；
- 允许 `a-z 0-9 _ . -`，统一转小写；
- 不能全是数字，不能是保留名（`admin`、`root`、`support` 等）；
- 不做“用户名即邮箱”的假设。

**密码**

- 12–128 字符；允许空格和 Unicode；
- 不做强制大小写/符号组合，长度优先；
- 拒绝常见弱密码（内置小名单即可，不引入外部依赖）；
- 服务端校验，客户端确认框只做体验；
- 不在日志、错误信息、模型提示词中出现密码。

**哈希**

- 首选 Argon2id；当前 Deno Web Crypto 可直接用 PBKDF2-HMAC-SHA-256；
- PBKDF2 建议 210,000 次迭代、16 字节随机盐、32 字节输出；
- 存储算法、迭代次数、盐和哈希；登录时若参数过旧则重新哈希；
- 恒定时间比较，不能普通字符串比较。

**会话**

- 32 字节随机令牌，base64url；
- 数据库只存 SHA-256；
- Cookie 名 `tm_session`，`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`；
- 绝对过期 7 天，空闲过期 24 小时；
- 登录成功轮换会话；修改密码/注销全部会话时撤销所有旧会话；
- 前端不把令牌写入 `localStorage`。

**防滥用**

- 登录失败按“用户名 + IP 哈希”限流：15 分钟内 5 次失败 → 锁定 15 分钟；
- 注册按 IP 限流，防止批量建号；
- 登录错误统一文案，不暴露用户是否存在；
- 所有写操作检查 `Origin`/`Referer`，并要求 `X-TM-CSRF` 与当前会话的 CSRF token 匹配；
- 认证接口不返回堆栈、SQL、上游错误；
- 记录安全事件时不记录密码、令牌、完整 IP。

**找回密码**

- 不依赖邮箱：注册时生成一次性恢复码，只展示一次，数据库存哈希；
- 忘记密码时用“用户名 + 恢复码”重置；
- 没有恢复码则只能由管理员重置；
- 不使用“安全问题”。

### 12.8 前端与页面（设计）

- 新增 `#/login`、`#/register`；
- 未登录访问导入/报告/问答/个人中心 → 跳转登录，并保留原目标路由；
- 顶部账户菜单显示用户名、退出登录、删除账号（若产品需要）；
- 退出登录清空按用户缓存的画像、账单列表、会话内存态；
- 登录失败显示统一错误，不区分“用户名不存在/密码错误”；
- 密码输入框支持显示/隐藏；不允许把密码放进 URL 或 `localStorage`；
- 收到 `401` 清会话并回登录页；收到 `403 identity_conflict` 提示重新登录，不自动切换身份。

### 12.9 服务端接入点（设计，未实现）

当前 [`adapter.mjs`](../../server/site-functions/adapter.mjs) 会在交给 handler 前删除 `cookie` 头，防止浏览器 Cookie 被转发到数据库。接入本地会话时需要：

1. 在进入 adapter 前解析 `tm_session`，校验会话并得到 `local:<uuid>`；
2. 用服务端生成的内部身份对象传给 handler，**不能信任客户端自报的 `x-tm-user-id`**；
3. 仍然在转发 Supabase 前删除 `cookie`；
4. 数据接口继续只认 `requireUser` 解析出的 `user_id`，不新增 owner 参数；
5. 认证接口本身也要经过同一套限流、CSRF、错误脱敏。

可以给 `createHandler` 增加 `identity` 选项，或新增一个 `withLocalAuth` 包装层；具体实现需单独评审，不能在本轮文档改动里顺手改代码。

### 12.10 共存、迁移与回滚

- 现有 Gateway 用户数据完全不动；
- 本地用户从空表开始，`user_id` 前缀避免碰撞；
- 不自动把 Gateway 用户迁移成本地账号；
- 默认 `AUTH_MODE=gateway`；`local` / `hybrid` 必须显式配置，且只在授权环境开启；
- 回滚：关闭本地登录路由、撤销全部 `sessions`、保留 `users` 表；不要删除表或用户数据；
- 如果本地账号方案被否决，`002_auth_local.sql` 不创建，业务表无需改动。

### 12.11 验收用例（实现时必须补齐）

- 注册：合法用户名/密码成功；重复用户名失败；弱密码失败；超长输入失败；
- 登录：正确密码成功；错误密码统一错误；不存在用户与错误密码耗时接近；
- 锁定：连续失败达到阈值后锁定；锁定期间正确密码也拒绝；到期解锁；
- 会话：Cookie 含 `HttpOnly/Secure/SameSite`；过期/撤销后 401；登录轮换令牌；旧令牌失效；
- CSRF：缺少/错误 `X-TM-CSRF` 的写请求拒绝；跨 Origin 拒绝；
- 隔离：A 的账单/画像/事实 B 不可见；B 用 A 的 ID 请求 404；
- 泄露：响应、日志、错误页不含密码、令牌、哈希、完整 IP；
- 恢复码：一次性使用；错误恢复码不泄露用户是否存在；
- 混合模式：Gateway 与本地身份冲突时 409；不自动合并。

### 12.12 仍需负责人拍板

1. 比赛现场是否所有评委/测试者都能使用 Qoder 账号？
   - 能 → 选 A，不做注册/密码登录；
   - 不能 → 是否接受“演示级本地账号”的风险，选 C。
2. 是否需要账号找回/注销？没有邮箱时用恢复码还是管理员重置？
3. 本地账号是独立 PR 还是并入后续版本？本轮 PR #64 不包含。

---

## 附录：验证命令

```bash
npm run check
npm run smoke
npm run dev          # 本机 5191，fake 模型 + 内存 Supabase
```

本机浏览器验证时，开发服务器会注入 dev 身份头；线上由 Gateway 注入真实身份，二者不能混为一谈。
