# Qoder Site 部署指南：账单 / 画像数据库版（2026-10-23）

- 适用分支：`feat/profile-db-ai-2026-10-23`，PR [#64](https://github.com/changer-collab/TimingMirror/pull/64)。功能提交 `514e238`；部署时以 PR 合并后的 `main` 为准。
- 当前状态：**PR 未合并、站点未部署、数据库未启用、迁移未执行。**
- 执行部署前必须获得负责人明确授权。本文只描述步骤，不代表已经执行。

> 安全约束：不要读取、打印或提交任何 Secret 值；不要把 Key 写进 SQL、代码、文档或聊天；不要删除数据库表或业务数据。

---

## 1. 这次部署为什么和上次不同

| 变化 | 影响 |
|---|---|
| 函数新增数据库访问 | `/api/bills`、`/api/profile` 需要内置数据库；DB 未启用时这两个前缀返回 503，模型接口仍可用 |
| 新增迁移 | 需要创建并执行 `db/migrations/001_bills_profile.sql`，同时应用 `001_bills_profile.policies.json` |
| 函数访问级别 | 从 `database_access: none` 改为 `read_write`，并声明 `requiredSchemaVersion` |
| 模型 Secret | 文本与视觉统一使用 `DEEPSEEK_API_KEY`；`DASHSCOPE_API_KEY` 不再被新函数读取 |
| 前端产物 | `npm run build:site` 生成 `dist/`，包含云同步、账单历史、画像与问答改动 |
| 用户区分 | 仍由 Qoder Gateway 的 `x-qoder-user-context` 提供；已确认**不做**独立注册/密码登录 |
| 当前线上状态 | 函数 `database_access: none`；DB `disabled`、`schema_version 0`；本次发布切换为新版前端与函数 |

当前站点（只读核对，2026-10-23）：

- 站点：`TimingMirror 择时镜子`，`https://timingmirror-85sdcc1aphk.qoder.website`，private / selected；
- 后端能力：`functions`、`storage`，**没有 database**；
- 数据库：`disabled`，`schema_version = "0"`，无表；
- 函数 `app`：已发布、`database_access: none`、`required_schema_version: 0`；
- 已有 Secret 名称：`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY`、`TUSHARE_TOKEN`（值未读取）。

---

## 2. 部署前置条件

- [ ] PR #64 已由负责人合并到 `main`；本文所有步骤基于合并后的提交。
- [ ] 本地工作区干净，已拉取合并后的 `main`。
- [ ] `npm run check` 退出码 0；`npm run smoke` 303/303。
- [ ] 账号拥有该 Site 的部署权限。
- [ ] 已获得“启用数据库 + 执行迁移 + 发布”的明确授权。
- [ ] 已确认线上没有需要保留的旧表；如果有，先备份/导出，不要覆盖。
- [ ] 已确认 Gateway 身份头不可被浏览器伪造；应用层隔离依赖这一点。

---

## 3. 推荐部署顺序

> 顺序原则：**先数据库，后函数；先函数，后前端发布。** 不要把 `read_write` 函数发布到没有表的数据库上。

### 步骤 0：确认代码与构建

```bash
git checkout main
git pull
git log -1 --oneline          # 应为 PR #64 的合并提交
npm run check
npm run smoke
npm run build:site            # 产物在 dist/
```

`dist/` 不提交，构建后直接用于 `prepare_site`。

### 步骤 1：启用数据库能力

使用 Qoder Sites 工具（需授权，可能分配云资源）：

```text
ensure_backend(
  siteId = <现有站点 ID>,
  requestId = <新 UUID>,
  capabilities = ["database"]
)
```

轮询返回的 Operation，直到终态；然后分别读取：

```text
get_backend(siteId)
get_database(siteId)
```

预期：

- `backend.capabilities` 包含 `database`；
- `database.status` 变为可用；
- 记录当前的 `schema_version` 与 `schema_fingerprint`（当前初始值为 `"0"` 与空串）。

> 不要用 `get_backend` 的 functions 状态推断数据库已就绪；必须单独读 `get_database`。

### 步骤 2：创建迁移计划（不执行）

读取当前 schema 后，用迁移文件原文创建计划：

```text
create_database_migration(
  siteId = <现有站点 ID>,
  requestId = <新 UUID>,
  clientMigrationId = "bills-profile-001",
  displayName = "bills and profile facts",
  sql = <db/migrations/001_bills_profile.sql 原文>,
  accessPolicies = <db/migrations/001_bills_profile.policies.json 内容>,
  expectedSchemaVersion = <步骤 1 读到的 schema_version>,
  expectedSchemaFingerprint = <步骤 1 读到的 schema_fingerprint>
)
```

说明：

- SQL 只包含 `CREATE TABLE`、`CREATE INDEX`，符合受限 DDL；
- 三张表都要在 `app` schema；
- `accessPolicies` 是 **完整托管状态**，不是增量授权；不要漏表，也不要把 `template` 改成 `owner`（匿名 adapter 不适用）；
- 日期字段保持 `text`；不要尝试 `date`、`DEFAULT`、`CHECK`、外键；
- 不要放任何业务数据或 Secret。

创建后用以下工具复核：

```text
get_database_migration(migrationId, includeSql = true)
list_database_migrations(siteId)
```

核对：版本、指纹、SQL 哈希、三张表、三条策略。

### 步骤 3：执行迁移

使用步骤 2 返回的精确值，不要手填或复用旧值：

```text
apply_database_migration(
  migrationId = <步骤 2 返回>,
  requestId = <新 UUID>,
  expectedRevision = <步骤 2 返回>,
  expectedSchemaVersion = <步骤 2 返回>,
  expectedSchemaFingerprint = <步骤 2 返回>,
  sqlSha256 = <步骤 2 返回>,
  confirm = true
)
```

轮询 Operation 到终态。失败时不要自动重试或替换参数；保留原 `requestId`，先读错误与迁移状态。

成功后刷新目录并确认：

```text
refresh_database(siteId, requestId)
get_database(siteId)
list_database_tables(siteId, snapshotRevision)
```

预期：`bills`、`profile_facts`、`profiles` 三张表存在；`schema_version` 前进（以平台返回为准，通常为 `1`）。**后续 `prepare_site` 必须使用这个实际版本号。**

### 步骤 4：确认 Secret

新函数读取：

| Secret | 是否必需 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | **必需** | 意图、复述、规则、行为分析、画像解读、视觉 |
| `DEEPSEEK_MODEL` | 可选 | 覆盖模型名；不配置时默认 `deepseek-flash` |
| `TUSHARE_TOKEN` | 可选 | 真实账单动态行情；缺失时相关能力阻断/降级 |
| `DASHSCOPE_API_KEY` | 不再读取 | 仅保留 `dashscope.mjs` 供人工回滚；可保留旧 Secret，不影响运行 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 平台注入 | 不要手工写入代码或文档 |

如果平台要求声明 `DEEPSEEK_MODEL`，在 Sites Settings 中新增同名 Secret，值填 `deepseek-flash`（这不是密钥，但仍按 Secret 管理）；如果平台允许省略，则不必创建。

Secret 值只在 Sites Settings 配置，**不要**通过聊天、SQL、仓库文件传递。

### 步骤 5：准备草稿

```text
prepare_site(
  actionId = <新 UUID>,
  projectRoot = <仓库根目录>,
  projectId = <现有站点项目 ID>,
  webDirectory = "dist",
  functionDirectory = "server/site-functions",
  databaseAccess = "read_write",
  requiredSchemaVersion = <步骤 3 实际 schema_version>,
  secretNames = ["DEEPSEEK_API_KEY", "TUSHARE_TOKEN"]  // 已存在才列入
)
```

`secretNames` 只列**已经在 Sites Settings 存在**的名称；如果确需固定模型名，先在 Settings 创建 `DEEPSEEK_MODEL`，再加入列表。未配置 `DEEPSEEK_MODEL` 时函数默认使用 `deepseek-flash`，不影响运行。

注意：

- 复用现有 `projectId`，不要 `createNewSite`；
- `webDirectory` 必须是 `dist`，不能是仓库根或 `prototype/user-frontend`；
- 不要传 `spa`（hash 路由不需要服务器回退）；
- `actionId` 是本次草稿的身份；重试必须复用同一 `actionId` 与完全相同的输入；
- 内容变化（代码、Secret 名称、DB 访问级别、schema 版本）都需要新的 `actionId`。

轮询：

```text
get_publish_status(actionId)
```

直到 `canPublish: true`。若 `descriptorStatus` 为 `pending`，继续等待；若为 `failed`，修本地描述符绑定，不要新建站点。

### 步骤 6：发布

```text
publish_site(actionId)
```

继续轮询到 `published: true`，并确认 Release/Operation 一致。**`canPublish`、部署 `ready`、上传成功都不等于已发布。**

发布后用同一 `actionId` 打开确认预览：

```text
show_publish_confirmation(actionId)
```

---

## 4. 发布后验证清单

> 在已登录的浏览器中验证；未带会话的裸 `curl` 可能被平台登录拦截，不能据此判断函数 404。

### 4.1 函数与数据接口

- [ ] 打开站点根路径，能跳转到用户端。
- [ ] 浏览器 Network 中 `/functions/v1/app/api/...` 不是 404。
- [ ] `GET /api/bills?limit=20` 返回 200、`bills` 数组、`next_offset` 字段。
- [ ] `GET /api/profile` 返回 200、`facts: []`、`summary: null`（新用户）。
- [ ] 未带 Gateway 身份直接请求数据接口 → `401 login_required`（不是 500）。
- [ ] 数据库未启用/凭证缺失时，数据接口 → 503；模型接口仍可用（不要把这个当故障）。

### 4.2 账单导入与去重

- [ ] 下载示例 CSV → 上传 → 核对 → 生成报告。
- [ ] 导入后云同步状态从 `pending` → `synced`；个人中心显示 1 份账单。
- [ ] 再导入同一 CSV → 返回 duplicate，账单数不增加。
- [ ] 默认只同步统计；不勾选完整明细时，`GET /api/bills/:id` 不返回 `payload`。
- [ ] 勾选“同时云端保存完整成交明细”后重新导入或升级 → `payload_mode: full`，`GET /api/bills/:id` 才返回成交行。
- [ ] 删除云端账单 → 200；本机报告与画像仍可用；列表刷新后少一条。

### 4.3 画像

- [ ] 个人中心显示云端账单数、事实数。
- [ ] 点击“生成 AI 解读”：
  - 模型可用 → `source: ai`；
  - 模型不可用/超时/响应非法 → `source: template`，页面明确标注“模板生成”，不冒充 AI。
- [ ] 回退时页面只显示中文原因（如“模型响应超时”），不显示 `model_timeout` 等原始代码；响应里的 `fallback_detail` 只用于诊断，不含模型原文。
- [ ] 解读中的数字与 digest 一致；出现越界数字/日期/投资建议应被拒绝；合理舍入与常见格式（如 `-0.0798` → `-7.98%`、`-26044` → `-26,044`）不应被拒绝。
- [ ] 生成后刷新页面，摘要从云端缓存读取；digest 变化时旧解读隐藏。
- [ ] 连续导入 3 份账单（可用 `m0/csv-input/fixtures/profile-demo/`）验证自动更新：
  - 第 1 份报告后，Network 出现一次 `POST /api/llm/profile-summary`，个人中心出现解读；
  - 第 2 份报告后**没有**新的模型调用，旧解读因 digest 变化隐藏；
  - 第 3 份报告后再次出现一次调用，解读更新为 `high` 置信度；
  - 同一报告刷新、重复导入不重复调用。
- [ ] 自动更新遇到模型失败/模板兜底时，不把模板文案保存成云端解读；个人中心仍可手动生成。清除 `localStorage.tm.profile.autoSummary.v1` 可重新走首次触发。
- [ ] 在独立问答页输入明确陈述，例如“我最多能接受 15% 的回撤”：
  - 若被识别 → 显示“已记入画像”，个人中心出现事实与原文证据；
  - 若是问句/请求句 → 不记录（这是预期）。
- [ ] 删除事实 → 200；刷新后不再出现；旧摘要按 digest 变化隐藏。

### 4.4 意图与视觉

- [ ] 独立问答页输入 L1 未命中的问题（例如“我为什么总是在同一个地方栽跟头”）：
  - Network 出现 `POST /api/llm/intent`；
  - 200 且页面标注“在线意图”；
  - 请求体只有 `{ question }`，不含账单/成交。
- [ ] 输入含“止损/止盈”的状态问句（例如“我的止损规则还生效吗”）：
  - 不应路由到 `contract_setup`；
  - 应返回规则状态，不要求用户新建规则。
- [ ] 上传 JPEG/PNG 账单截图：
  - 请求 `POST /api/llm/import-vision` → 200；
  - 生成可编辑草稿，必须人工核对后才导入；
  - 超过 8 张、单图过大或总量过大时明确提示，不截断。
- [ ] 用真实 `DEEPSEEK_API_KEY` 至少跑一次文本和一次视觉，记录延迟与失败码；fake 模型的通过不算真实验收。

### 4.5 双用户隔离（应用层）

> 这是应用层验证，不是数据库级隔离证明。

- [ ] 账户 A 导入账单，记录账单 ID。
- [ ] 账户 B 登录：
  - `GET /api/bills` 只看到 B 的数据；
  - 用 A 的账单 ID 请求 `GET /api/bills/:id` → 404；
  - `DELETE` A 的账单 ID → 404；
  - `GET /api/profile` 不出现 A 的事实/摘要。
- [ ] 账户 B 的画像摘要不会覆盖 A（`profiles` 每人一行）。
- [ ] 无会话请求数据接口 → `401`；伪造 `x-qoder-user-context` 且无会话 → `401`；有会话时伪造头被 Gateway 覆盖，仍只返回本人数据（此项不需要第二个账号）。

### 4.6 降级行为

- [ ] 关闭数据库/移除 `SUPABASE_*` 时：
  - `/api/bills`、`/api/profile` → 503；
  - 本机导入、报告、规则、问答仍可用；
  - 前端显示“仅本机 · 云端未同步”，不阻塞主流程。
- [ ] 模型 Key 缺失时：
  - 意图/画像解读/视觉按接口返回明确错误或模板兜底；
  - 不伪造 AI 结果。

---

## 5. 回滚

### 5.1 前端/函数

- **发布前**记录当前在线 Release ID，保留旧版本信息。
- 新版本出现问题：
  1. 将仓库切回上一个已知可用提交；
  2. `npm run build:site`；
  3. 用**新的** `actionId` 重新 `prepare_site` + `publish_site`；
  4. 验证站点根路径、模型接口、数据接口。
- 若平台支持按 Release 恢复，优先恢复旧 Release；不要删除当前 Release 记录。

### 5.2 数据库

- **不要删除表、不要清空数据、不要尝试 `DROP`。**
- 本次迁移只新增表；回滚代码不需要回滚表结构。
- 如需临时停用云同步：
  - 发布一个 `databaseAccess: none` 的函数版本，或移除 `SUPABASE_*`；
  - 数据接口返回 503，本机功能继续可用；
  - 保留表与数据，等下一次修复。
- 如迁移本身失败：
  - 不要用新参数覆盖原迁移；
  - 读取失败 Operation，保留 `requestId`；
  - 在确认无数据写入后，再创建新的修正迁移（只加不删）。

### 5.3 Secret

- 不要删除 `DEEPSEEK_API_KEY` 来“关闭 AI”；这会让所有模型接口不可用。
- 需要停用模型时，优先在应用层返回明确降级，而不是删除 Secret。

---

## 6. 风险与注意事项

1. **应用层隔离**：数据库策略是匿名 public；如果 Gateway 入口可被绕过，`user_id` 过滤可被绕过。上线前必须确认平台入口不可绕过。
2. **数据库未启用时**：只有 `/api/bills`、`/api/profile` 返回 503；不要据此判断整个函数故障。
3. **真实模型未验收**：PR 的验证是本机 fake 模型 + 单测；部署后必须用真实 Key 跑文本、视觉、画像解读各一次。
4. **真实行情**：`TUSHARE_TOKEN` 缺失时动态行情阻断/降级，不会补造数字。
5. **无 CI**：仓库未配置 CI，PR 显示 `Checks 0`；合并前需人工看 `npm run check` / `npm run smoke` 日志。
6. **完整明细**：默认不上传成交行；用户勾选后才上传，需在隐私说明中保持明确。
7. **迁移 DDL 受限**：后续只能加表/加列/加索引；不要设计依赖 `DROP`、`DEFAULT`、`CHECK`、外键的变更。
8. **发布顺序**：先 DB + 迁移，再 `read_write` 函数，最后前端；顺序反了会出现数据接口 503 或前端云同步失败。

---

## 7. 相关文件

- 实现记录与差异表：[`db-profile-ai-implementation-2026-10-23.md`](./db-profile-ai-implementation-2026-10-23.md)
- 迁移：[`../../db/migrations/001_bills_profile.sql`](../../db/migrations/001_bills_profile.sql)
- 策略：[`../../db/migrations/001_bills_profile.policies.json`](../../db/migrations/001_bills_profile.policies.json)
- 函数入口：[`../../server/site-functions/index.ts`](../../server/site-functions/index.ts)
