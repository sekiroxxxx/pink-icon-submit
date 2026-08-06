# PinK Icon Submit

PinK 图标自动 Draft PR MVP 的独立编排服务。当前包含 Fastify、SQLite、批次 API、本地 worktree Worker 和 React/Vite 设计提交页；Stage 1 v2 目前只接入本地开发闭环。

## 边界

- 新增名称、最终目标、mapping、alias 与 codepoint 规则只调用 `pink-codicons/scripts/icon-batch.mjs`；服务端不自行分配 codepoint。
- 设计提交页的图标目录直接读取 `@pink/codicons@beta` 的 npm tarball：只解析 `src/template/mapping.json` 和 `src/icons/*.svg`，验证 npm 的 sha512 SRI，并按 integrity 的 SHA-256 缓存解析后的不可变快照和原始 `.tgz`。不会安装该包、执行包脚本或本地构建设计目录。
- 创建批次时会冻结 npm 的 `catalogBaseline`（包名、tag、精确版本、SRI、来源仓库和 commit）及目标仓库；后续校验、plan 和 apply 始终使用该批次对应的缓存 tarball。
- 目录展示基于 npm 发布物；名称预览、最终校验和本地 diff 基于目标 Git ref。`local` 模式只解析本地 ref，绝不执行 `git fetch`；本地 Stage 1 源码只提供 CLI 实现，不能替代 npm catalog 基线。
- Worker 只在临时 worktree 生成本地 diff；不 commit、push 或创建 GitHub PR。
- 前端只负责批次表单、SVG 预览、目录选择和状态展示；不解析 mapping、不分配 codepoint、不持有 GitHub Token。
- 批次状态依次为 `DRAFT → VALIDATING → READY → QUEUED → RUNNING → LOCAL_DIFF_READY`；验证、编辑和提交互斥。进程重启时遗留的 `VALIDATING` 批次会安全退回 `DRAFT`；遗留的 `RUNNING` job 会标记为 `FAILED/WORKER_INTERRUPTED`，可通过 retry 重新排队。

## 配置

```text
PINK_ICON_EXECUTION_MODE=local                              # 必填；本轮唯一支持的运行方式
PINK_CODICONS_DIR=C:\path\to\isolated-target-clone         # 目标 Git 工作区，不是 Stage 1 源码目录
PINK_ICON_STAGE1_SOURCE_DIR=C:\path\to\pink-codicons       # 含 Stage 1 v2 代码和 node_modules
PINK_ICON_LOCAL_TARGET_REF=main                              # 必填；从此本地 ref 创建临时 worktree
PINK_ICON_TARGET_REPOSITORY=sekiroxxxx/sekiroxxxx-pink-codicons-automation-test # 必填
PINK_ICON_TARGET_BRANCH=main                                 # 可选，当前协议仅允许 main
PINK_ICON_SUBMIT_DATA_DIR=C:\path\to\persistent-data   # 可选，默认 ./data
PINK_ICON_SUBMIT_HOST=127.0.0.1                           # 可选
PINK_ICON_SUBMIT_PORT=3000                                # 可选
PINK_ICON_CATALOG_PACKAGE=@pink/codicons                   # 可选，默认 @pink/codicons
PINK_ICON_CATALOG_TAG=beta                                 # 可选，默认 beta
PINK_ICON_CATALOG_REGISTRY=http://creator-npm.cocos.org:7001 # 可选，默认 PinK @pink registry
PINK_ICON_CATALOG_AUTH_TOKEN=...                           # 私有 registry 需要时由部署环境注入
PINK_ICON_CATALOG_SOURCE_REPOSITORY=sud-global/pink-codicons # 可选
PINK_ICON_CATALOG_REFRESH_MS=60000                         # 可选，默认 60 秒
```

`local` 模式的 `PINK_CODICONS_DIR` 应是隔离的本地目标仓库 clone。Worker 从 `PINK_ICON_LOCAL_TARGET_REF` 创建临时 detached worktree，生成、应用和读取 diff 后删除该 worktree；不会 fetch、commit、push 或创建 PR。`PINK_ICON_STAGE1_SOURCE_DIR` 是当前 `codex/icon-automation-v2` 工作区，只用来执行 `scripts/icon-batch.mjs`；服务不会在其中安装依赖或修改文件。

npm registry 暂时不可用时，服务会尝试使用本地已验证的 tag 解析记录、integrity 快照和原始 tarball；没有可验证的本地数据时，目录 API 或新批次创建会返回明确错误。迁移前创建、没有 `catalogBaseline` 与目标仓库上下文的旧批次不能用于 v2，必须重新创建。

本地 Stage 1 源码必须先由开发者准备依赖：

```text
cd C:\path\to\pink-codicons
npm ci
```

这是 Stage 1 的 `svgo` 模块解析环境。local Worker 不会在目标 worktree 或 Stage 1 源码目录自动运行 `npm ci`，避免隐式修改开发目录。运行服务的机器必须提供 Node.js、npm 和 npm registry 或本地 npm 缓存。

## 尚未接入正式环境

- 不使用 R2、R3 或 R0 的远程 main，不验证 GitHub 权限，不连接机器人 fork。
- 不 push、不创建 Draft PR，也不做 npm 发布、构建或自动合并。
- `remote` 配置分支仅为后续迁移预留；在 Stage 1 v2 通过人工 PR 合入目标仓库 main 前，不得作为运行方式使用。
- 正式迁移时，旧批次必须以当时的 npm tarball 与目标 main 重新校验、重新生成 plan，不能复用本地 diff。

## 命令

```powershell
npm install
npm run check
npm test
npm run dev
npm run web:dev
```

开发时先在一个终端运行 `npm run dev`，再在另一个终端运行 `npm run web:dev`。Vite 页面默认在 `http://127.0.0.1:5173` 提供，并代理 `/api` 到 `http://127.0.0.1:3000`；可用 `PINK_ICON_SUBMIT_API_URL` 修改代理目标。生产静态托管与 Docker 部署留在阶段 4。

用真实阶段 1 v2 的本地 `pink-codicons` 源码验证 cached tarball、validate、plan、apply 和本地 diff：

```powershell
$env:PINK_ICON_STAGE1_SOURCE_DIR = 'C:\path\to\pink-codicons'
npm.cmd run test:integration
```

当前 API：`GET /api/catalog`、`GET /api/catalog/page`、`GET /api/catalog/icons/:name/svg`、`GET /api/names/preview`、`POST /api/batches`、`POST /api/batches/:id/items`、`PUT /api/batches/:id/items/:itemId`、`DELETE /api/batches/:id/items/:itemId`、`POST /api/batches/:id/validate`、`POST /api/batches/:id/submit`、`POST /api/batches/:id/warnings/acknowledge`、`GET /api/batches/:id`、`POST /api/batches/:id/retry`。
