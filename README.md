# PinK Icon Submit

PinK 图标自动 Draft PR MVP 的独立编排服务。当前为阶段 2B：Fastify、SQLite、批次 API、本地 worktree Worker 和 React/Vite 设计提交页。

## 边界

- 新增名称、最终目标、mapping、alias 与 codepoint 规则只调用 `pink-codicons/scripts/icon-batch.mjs`；服务端不自行分配 codepoint。
- 设计提交页的图标目录直接读取 `@pink/codicons@beta` 的 npm tarball：只解析 `src/template/mapping.json` 和 `src/icons/*.svg`，验证 npm 的 sha512 SRI，并按 integrity 的 SHA-256 缓存解析后的不可变快照。不会安装该包、执行包脚本或本地构建设计目录。
- 目录展示基于 npm 发布物；名称预览、最终校验和本地 diff 仍基于目标 Git 分支。开发期默认目标为本地 `origin/main`（`sekiroxxxx/pink-codicons`），可用环境变量覆盖。
- Worker 只在临时 worktree 生成本地 diff；不 commit、push 或创建 GitHub PR。
- 前端只负责批次表单、SVG 预览、目录选择和状态展示；不解析 mapping、不分配 codepoint、不持有 GitHub Token。
- 批次状态依次为 `DRAFT → VALIDATING → READY → QUEUED → RUNNING → LOCAL_DIFF_READY`；验证、编辑和提交互斥。进程重启时遗留的 `VALIDATING` 批次会安全退回 `DRAFT`；遗留的 `RUNNING` job 会标记为 `FAILED/WORKER_INTERRUPTED`，可通过 retry 重新排队。

## 配置

```text
PINK_CODICONS_DIR=C:\path\to\pink-codicons
PINK_ICON_SUBMIT_DATA_DIR=C:\path\to\persistent-data   # 可选，默认 ./data
PINK_ICON_SUBMIT_HOST=127.0.0.1                           # 可选
PINK_ICON_SUBMIT_PORT=3000                                # 可选
PINK_ICON_UPSTREAM_REMOTE=origin                           # 可选，开发期默认 origin
PINK_ICON_UPSTREAM_BRANCH=main                             # 可选，默认 main
PINK_ICON_CATALOG_PACKAGE=@pink/codicons                   # 可选，默认 @pink/codicons
PINK_ICON_CATALOG_TAG=beta                                 # 可选，默认 beta
PINK_ICON_CATALOG_REGISTRY=http://creator-npm.cocos.org:7001 # 可选，默认 PinK @pink registry
PINK_ICON_CATALOG_AUTH_TOKEN=...                           # 私有 registry 需要时由部署环境注入
PINK_ICON_CATALOG_SOURCE_REPOSITORY=sud-global/pink-codicons # 可选
PINK_ICON_CATALOG_REFRESH_MS=60000                         # 可选，默认 60 秒
```

`PINK_CODICONS_DIR` 必须是配置了目标 remote 的本地克隆；Worker 每次执行都会 fetch 配置的 remote，并从该 remote 的 `main` 建立临时 worktree。开发期默认 remote 是 `origin`，即 `sekiroxxxx/pink-codicons`；完成开发、迁移到正式仓库时再显式改为 `upstream`（`SUD-GLOBAL/pink-codicons`）。

npm registry 暂时不可用时，服务会尝试使用本地已验证的 tag 解析记录和 integrity 快照；没有可验证的本地快照时，目录 API 会返回明确错误。当前阶段尚未把 npm baseline 持久化到批次，后续双基线协议落库后会在创建批次时固定版本和 integrity。

每个临时 worktree 首次运行 `icon-batch` 前，会使用目标分支 worktree 中的 `package-lock.json` 执行：

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
npm run web:dev
```

开发时先在一个终端运行 `npm run dev`，再在另一个终端运行 `npm run web:dev`。Vite 页面默认在 `http://127.0.0.1:5173` 提供，并代理 `/api` 到 `http://127.0.0.1:3000`；可用 `PINK_ICON_SUBMIT_API_URL` 修改代理目标。生产静态托管与 Docker 部署留在阶段 4。

用真实阶段 1 的 `pink-codicons` 源码验证依赖安装和 `svgo` 导入：

```powershell
$env:PINK_CODICONS_DIR = 'C:\path\to\pink-codicons'
npm.cmd run test:integration
```

当前 API：`GET /api/catalog`、`GET /api/catalog/page`、`GET /api/catalog/icons/:name/svg`、`GET /api/names/preview`、`POST /api/batches`、`POST /api/batches/:id/items`、`PUT /api/batches/:id/items/:itemId`、`DELETE /api/batches/:id/items/:itemId`、`POST /api/batches/:id/validate`、`POST /api/batches/:id/submit`、`POST /api/batches/:id/warnings/acknowledge`、`GET /api/batches/:id`、`POST /api/batches/:id/retry`。
