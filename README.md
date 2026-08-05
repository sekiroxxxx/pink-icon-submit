# PinK Icon Submit

PinK 图标自动 Draft PR MVP 的独立编排服务。当前为阶段 2A：Fastify、SQLite、批次 API 和本地 worktree Worker。

## 边界

- 图标规则只调用 `pink-codicons/scripts/icon-batch.mjs`，不在服务端复制 mapping、alias 或 codepoint 规则。
- Worker 只在临时 worktree 生成本地 diff；不 commit、push 或创建 GitHub PR。
- React 是后续阶段 2B 的前端选择，本仓库当前不包含页面。

## 配置

```text
PINK_CODICONS_DIR=C:\path\to\pink-codicons
PINK_ICON_SUBMIT_DATA_DIR=C:\path\to\persistent-data   # 可选，默认 ./data
PINK_ICON_SUBMIT_HOST=127.0.0.1                           # 可选
PINK_ICON_SUBMIT_PORT=3000                                # 可选
```

`PINK_CODICONS_DIR` 必须是配置了 `upstream` remote 的本地克隆；Worker 每次执行都会 fetch `upstream` 并从 `upstream/main` 建立临时 worktree。

## 命令

```powershell
npm install
npm run check
npm test
npm run dev
```

当前 API：`GET /api/catalog`、`POST /api/batches`、`POST /api/batches/:id/items`、`POST /api/batches/:id/validate`、`POST /api/batches/:id/submit`、`GET /api/batches/:id`、`POST /api/batches/:id/retry`。
