# PinK Icon Submit

PinK 图标自动 Draft PR MVP 的独立编排服务。当前为阶段 2A：Fastify、SQLite、批次 API 和本地 worktree Worker。

## 边界

- 图标规则只调用 `pink-codicons/scripts/icon-batch.mjs`，不在服务端复制 mapping、alias 或 codepoint 规则。
- Worker 只在临时 worktree 生成本地 diff；不 commit、push 或创建 GitHub PR。
- React 是后续阶段 2B 的前端选择，本仓库当前不包含页面。
- 批次状态依次为 `DRAFT → VALIDATING → READY → QUEUED → RUNNING → LOCAL_DIFF_READY`；验证、编辑和提交互斥。进程重启时遗留的 `VALIDATING` 批次会安全退回 `DRAFT`；遗留的 `RUNNING` job 会标记为 `FAILED/WORKER_INTERRUPTED`，可通过 retry 重新排队。

## 配置

```text
PINK_CODICONS_DIR=C:\path\to\pink-codicons
PINK_ICON_SUBMIT_DATA_DIR=C:\path\to\persistent-data   # 可选，默认 ./data
PINK_ICON_SUBMIT_HOST=127.0.0.1                           # 可选
PINK_ICON_SUBMIT_PORT=3000                                # 可选
```

`PINK_CODICONS_DIR` 必须是配置了 `upstream` remote 的本地克隆；Worker 每次执行都会 fetch `upstream` 并从 `upstream/main` 建立临时 worktree。

每个临时 worktree 首次运行 `icon-batch` 前，会使用该 worktree 中 `upstream/main` 的 `package-lock.json` 执行：

```text
npm ci --include=dev --ignore-scripts --no-audit --no-fund
```

这为阶段 1 的 `svgo` 依赖提供模块解析环境；`node_modules` 只位于临时 worktree，随其删除。运行服务的机器必须提供 Node.js、npm 和 npm registry 或本地 npm 缓存。

## 命令

```powershell
npm install
npm run check
npm test
npm run dev
```

用真实阶段 1 的 `pink-codicons` 源码验证依赖安装和 `svgo` 导入：

```powershell
$env:PINK_CODICONS_DIR = 'C:\path\to\pink-codicons'
npm.cmd run test:integration
```

当前 API：`GET /api/catalog`、`POST /api/batches`、`POST /api/batches/:id/items`、`POST /api/batches/:id/validate`、`POST /api/batches/:id/submit`、`GET /api/batches/:id`、`POST /api/batches/:id/retry`。
