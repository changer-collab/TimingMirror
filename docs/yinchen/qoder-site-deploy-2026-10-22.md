# Qoder Site 部署接入说明（2026-10-22）

## 结论

- 前端请求已经走同源 `/functions/v1/app/...`，**不需要改 API base**。
- 站点函数 `app` 已存在，入口是 `server/site-functions/index.ts`，匿名访问、无数据库。
- 重新部署只需要：构建 `dist` → `prepare_site` → 配置两个 Secret → `publish_site`。
- 不能把仓库根目录当作 `webDirectory`，也不能只发布 `prototype/user-frontend`；否则 `/src`、`/m0`、`/data` 会 404。

## 构建产物

```bash
npm run build:site
```

产物固定在 `dist/`：

- `dist/index.html`：跳转到 `./prototype/user-frontend/index.html`
- `dist/src/`：运行时引擎、UI 样式、`vendor/pdfjs`
- `dist/prototype/`：用户端 SPA
- `dist/m0/`：示例 CSV 与合成行情 fixtures
- `dist/data/market-cache.json`：离线签收行情

`dist/` 已加入 `.gitignore`，不提交。函数目录不打进 `dist`，由 Qoder Sites 单独部署。

## prepare_site 参数

| 字段 | 值 |
|---|---|
| `projectRoot` | 仓库根目录 |
| `projectId` | 现有站点项目（更新时复用，不要 `createNewSite`） |
| `webDirectory` | `dist` |
| `functionDirectory` | `server/site-functions` |
| `secretNames` | `["DASHSCOPE_API_KEY", "TUSHARE_TOKEN"]` |
| `databaseAccess` | `none` |
| `createNewSite` | 省略 |
| `actionId` | 新 UUID；重试时保持不变，内容变化需要新 action |
| `spa` | 省略（hash 路由，不依赖服务器回退） |

Secret 只传名称，值在 Qoder Sites Settings 配置，不写进仓库：

- `DASHSCOPE_API_KEY`：AI 意图、复述、规则、行为分析
- `TUSHARE_TOKEN`：真实账单的动态行情

## 发布步骤

1. 在 Sites Settings 配置两个 Secret。
2. `prepare_site`，轮询 `get_publish_status` 直到 `canPublish`。
3. `publish_site`，继续轮询到 `published: true`。
4. 打开站点根路径，确认跳转到用户端。

## 验证

```bash
curl -X POST https://<站点域名>/functions/v1/app/api/llm/intent \
  -H 'content-type: application/json' \
  -d '{"question":"组合整体表现如何？"}'
```

- 没有 `DASHSCOPE_API_KEY` 时，函数可达但返回 `NOT_CONFIGURED`，属于预期降级，不是前端 404。
- 配好 Secret 后应返回意图 JSON。
- 浏览器 Network 里确认 `/functions/v1/app/...` 不是 404；示例账单走通“下载示例 CSV → 上传 → 报告 → 问答”。
- 真实账单行情依赖 `TUSHARE_TOKEN`；缺失时会阻断或降级，不会补造数字。

## 边界

- 不提交 `dist/`、真实 CSV、Secret 值。
- `server/site-functions` 自包含，不依赖 `src/`。
- 站点当前为 private，发布不会自动改变访问范围。
- 本次只新增构建脚本与本文档，未执行 `prepare_site` / `publish_site`，未读取 Secret 值。
