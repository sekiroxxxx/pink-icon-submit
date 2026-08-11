# PinK Icon Submit

PinK 图标自动 Draft PR MVP 的独立编排服务。当前包含 Fastify、SQLite、批次 API、worktree Worker 和 React/Vite 设计提交页；remote 模式从 R2 worktree 调用 Stage 1 v2，local 模式可显式指定本地 Stage 1 源码。

## 边界

- 新增名称、最终目标、mapping、alias 与 codepoint 规则只调用 `pink-codicons/scripts/icon-batch.mjs`；服务端不自行分配 codepoint。
- 设计提交页的图标目录直接读取 `@pink/codicons@beta` 的 npm tarball：只解析 `src/template/mapping.json` 和 `src/icons/*.svg`，验证 npm 的 sha512 SRI，并按 integrity 的 SHA-256 缓存解析后的不可变快照和原始 `.tgz`。不会安装该包、执行包脚本或本地构建设计目录。
- 创建批次时会冻结 npm 的 `catalogBaseline`（包名、tag、精确版本、SRI、来源仓库和 commit）及目标仓库；后续校验、plan 和 apply 始终使用该批次对应的缓存 tarball。
- 目录展示基于 npm 发布物；名称预览、最终校验和本地 diff 基于目标 Git ref。`local` 模式只解析本地 ref，绝不执行 `git fetch`；本地 Stage 1 源码只提供 CLI 实现，不能替代 npm catalog 基线。
- local Worker 只在临时 worktree 生成本地 diff；remote Worker 会在 R3 创建一个 `bot/<batchId>` commit、普通 push，并向 R2/main 创建一个 GitHub Draft PR。
- 前端只负责批次表单、SVG 预览、目录选择和状态展示；不解析 mapping、不分配 codepoint、不持有 GitHub Token。
- 服务使用内部预置账号和 HttpOnly、SameSite=Lax 会话 Cookie。除健康检查和登录外，所有 catalog 与批次 API 都要求登录；批次、历史和唯一活动批次均按 `owner_id` 在服务端隔离。浏览器不再用 localStorage 决定账号或活动批次，只保留无安全含义的界面状态。
- 这是内部 MVP，不提供注册、找回密码、角色、团队共享或管理员界面。每个账号只能有一个非终态活动批次；该约束由创建和基于旧批次新建的数据库事务执行。
- 升级前已有的匿名批次不会删除：migration 会将其归入 `legacy-bootstrap@internal.invalid`。它默认不可登录，避免自动暴露给新账号；如需查看或处理保留历史，运维可显式用该账号名配置 bootstrap 密码以启用该唯一历史账号。
- 本地批次状态为 `DRAFT → VALIDATING → READY → QUEUED → RUNNING → LOCAL_DIFF_READY`。远程交付依次经过 `COMMIT_PREPARED → BRANCH_PUSHED → PR_CREATING → PR_CREATED`；`PR_CREATED` 为开发接管终态，平台不再 push 或修改该分支。进程重启时遗留的 `VALIDATING` 批次会安全退回 `DRAFT`；仅在 Worker 显式启用时，遗留的 `RUNNING` job 才会标记为 `FAILED/WORKER_INTERRUPTED`，且已 `PR_CREATED` 的交接不会被降级或重试。

## 配置

本地开发模式：

```text
PINK_ICON_EXECUTION_MODE=local                              # 必填
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
PINK_ICON_WORKER_ENABLED=false                              # 可选，默认 false；仅 true 执行队列任务
PINK_ICON_BOOTSTRAP_USERNAME=designer@example.invalid       # 启动时预置内部账号；与密码成对配置
PINK_ICON_BOOTSTRAP_PASSWORD=<deployment-secret>            # 仅环境注入，不写入数据库明文或日志
```

P3 开发期远程模式（创建 R3 的 `bot/<batchId>` 分支和 R2 的 Draft PR）：

```text
PINK_ICON_EXECUTION_MODE=remote
PINK_CODICONS_DIR=C:\path\to\pink-codicons-automation-test
PINK_ICON_TARGET_REPOSITORY=sekiroxxxx/sekiroxxxx-pink-codicons-automation-test
PINK_ICON_TARGET_BRANCH=main
PINK_ICON_TARGET_REMOTE=upstream
PINK_ICON_PUSH_REPOSITORY=sud-icon-bot/sekiroxxxx-pink-codicons-automation-test
PINK_ICON_PUSH_REMOTE=origin
PINK_ICON_PUSH_BRANCH_PREFIX=bot/
PINK_ICON_REMOTE_DELIVERY_PHASE=pull_request
PINK_ICON_GITHUB_TOKEN=<deployment-secret>
PINK_ICON_GIT_COMMITTER_NAME=PinK Icon Bot
PINK_ICON_GIT_COMMITTER_EMAIL=<approved-bot-email>
PINK_ICON_WORKER_ENABLED=false
PINK_ICON_BOOTSTRAP_USERNAME=designer@example.invalid
PINK_ICON_BOOTSTRAP_PASSWORD=<deployment-secret>
```

`PINK_ICON_BOOTSTRAP_USERNAME` 与 `PINK_ICON_BOOTSTRAP_PASSWORD` 要么同时省略，要么同时配置；用户名必须是邮箱形式。服务只在账号不存在时创建它，不会在每次启动时轮换既有账号密码。唯一例外是 migration 自动创建的 `legacy-bootstrap@internal.invalid`：它初始为禁用占位账号，只有明确用同名 bootstrap 配置启动时才会写入现代密码哈希并可登录查看保留的旧数据。

远程模式只允许上述 R2/R3 配对，启动时验证 target/push remote URL、R3 的直接 fork parent 和 `bot/` 前缀。Token 只用于后端 GitHub API Authorization header 和临时 `GIT_ASKPASS` 子进程；不写入 remote URL、数据库、前端、命令参数或错误消息。

`local` 模式的 `PINK_CODICONS_DIR` 应是隔离的本地目标仓库 clone。Worker 从 `PINK_ICON_LOCAL_TARGET_REF` 创建临时 detached worktree，生成、应用和读取 diff 后删除该 worktree；不会 fetch、commit、push 或创建 PR。`PINK_ICON_STAGE1_SOURCE_DIR` 是当前 `codex/icon-automation-v2` 工作区，只用来执行 `scripts/icon-batch.mjs`；服务不会在其中安装依赖或修改文件。

### Worker 启动开关

服务默认以 API/UI-only 模式启动：`PINK_ICON_WORKER_ENABLED` 未设置或为 `false` 时，仍会恢复中断的 `VALIDATING` 批次，但不会执行 remote topology preflight、恢复或领取交付 job、构造 local/remote Worker，或启动轮询。只有显式设置为 `true` 才会执行这些操作。启动日志会显示 Worker 为 enabled 或 disabled，且不会输出 Token 或其他敏感配置。

`PINK_ICON_EXECUTION_MODE=local` 只决定本地交付的实现方式，不是禁用 Worker 的开关；`PINK_ICON_REMOTE_DELIVERY_PHASE=branch` 只在安全 push 后停止创建 Draft PR，也不是禁用 Worker 的开关。`PINK_ICON_WORKER_POLL_MS` 只控制已启用 Worker 的轮询间隔，不能用 `0` 关闭 Worker。

npm registry 暂时不可用时，服务会尝试使用本地已验证的 tag 解析记录、integrity 快照和原始 tarball；没有可验证的本地数据时，目录 API 或新批次创建会返回明确错误。迁移前创建、没有 `catalogBaseline` 与目标仓库上下文的旧批次不能用于 v2，必须重新创建。

本地 Stage 1 源码必须先由开发者准备依赖：

```text
cd C:\path\to\pink-codicons
npm ci
```

这是 Stage 1 的 `svgo` 模块解析环境。local Worker 不会在目标 worktree 或 Stage 1 源码目录自动运行 `npm ci`，避免隐式修改开发目录。运行服务的机器必须提供 Node.js、npm 和 npm registry 或本地 npm 缓存。

## 尚未接入正式环境

- P3 不做 npm 发布、构建或自动合并；工作线 C 的真实 R2/R3 验收尚未开始。
- R2/R3 的真实 push 和 Draft PR 仅由工作线 C 验收；当前仓库测试只使用本地 bare Git remote 和 GitHub API fake。
- R0/R1 不接入、不读取为目标、更不写入。
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

当前 API：公开的 `GET /api/health`、`POST /api/auth/login`；受会话保护的 `POST /api/auth/logout`、`GET /api/auth/me`、`GET /api/catalog`、`GET /api/catalog/page`、`GET /api/catalog/icons/:name/svg`、`GET /api/names/preview`、`GET /api/batches?limit=20`、`GET /api/batches/active`、`POST /api/batches`、`PUT /api/batches/:id`、`POST /api/batches/:id/items`、`PUT /api/batches/:id/items/:itemId`、`DELETE /api/batches/:id/items/:itemId`、`POST /api/batches/:id/validate`、`POST /api/batches/:id/submit`、`POST /api/batches/:id/return-to-edit`、`POST /api/batches/:id/clone`、`GET /api/batches/:id`、`POST /api/batches/:id/retry`。
