# 发布候选、试运行与回滚手册

本手册用于在接入正式图标仓库前冻结候选版本。正式仓库切换是最后一个独立步骤；候选验证期间只允许测试拓扑、功能分支和 Draft PR，不合并、不 force-push、不直接写默认分支。

## 1. 冻结候选

记录唯一候选 commit，并在新的干净 worktree 中执行：

```powershell
npm ci
npm run check
npm test
npm run build
npm run test:production
$env:PINK_ICON_STAGE1_SOURCE_DIR = 'C:\path\to\pink-codicons'
npm run test:integration
npm audit --omit=dev
git diff --check
```

验收要求：工作区干净；Server、Web、生产入口和真实 Stage 1 集成全部通过；production dependency audit 为 0；构建产物中不存在数据目录、Token、账号密码或测试凭据。

候选冻结后只接受阻断级修复。任何生产代码变化都会生成新的候选 commit，并重新执行本节全部门禁。

## 2. 测试仓库持续试运行

使用全新的 data root 和 icon clone，以生产构建的 `npm start` 启动单进程 API + Worker。Worker 必须从启动起保持 enabled，不采用人工切换 Worker 的体验流程。

启动前只读确认：

- target/push 仓库、remote URL、fork parent 和 `main` SHA 正确；
- 运行身份对 target 有读取/建 PR 权限，对 push fork 有非 force push 权限；
- data root 没有其他 RuntimeLease owner；
- Token 只进入服务子进程环境，不进入命令行、URL、Git config、日志或数据库。

还必须在与 Worker 相同的 clone 和子进程环境中完成 target `fetch` 与 push remote `ls-remote` 基础连通性检查。TLS、代理、DNS 或 GitHub 短暂失败应作为恢复场景记录，不能伪装成业务成功，也不能绕过 checkpoint 直接重放；应通过既有人工 retry 验证安全恢复和远程副作用唯一性。若同一操作持续失败、认证确定无效，或无法在不改变交付语义的前提下恢复，则停止试运行并修复宿主环境。Windows 部署需同时审计 system/global/local 的 `http.proxy`、`http.sslBackend` 和 credential helper；只允许在隔离 clone 中调整配置，不修改用户或系统全局配置来掩盖环境差异。

同一候选至少连续完成以下批次：

1. add 两批；
2. replace 两批；
3. delete 一批；
4. add + replace + delete 混合两批；
5. Stage 1 失败后返回编辑并重新提交一批；
6. 计划停止并重新启动服务后再提交两批。

无基础设施故障的批次应以 `attempt=1` 完成；故障注入或真实短暂基础设施失败允许通过既有门禁产生后续 attempt，但必须证明恢复没有重复 validate/plan/apply/commit/push 或 PR 创建。每批最终必须满足：`PR_CREATED/COMPLETED`、branch SHA = DB commit = PR head、exact-head Draft PR 数量为 1、每个 branch 非 force push 恰好一次、无临时 worktree 或 RUNNING/QUEUED 残留。服务重启前后首页、工作台、历史和错误指引必须由浏览器实际检查，不能只读数据库代替。

任何卡队列、重复 branch/PR、不可操作错误、凭据泄露或需要人工开关 Worker 的情况都会使候选失效；先修根因并生成新候选，不在原数据上堆补偿重试。

## 3. 上线前数据保护

服务保持停止，先用候选版本的维护入口对当前 data root 做迁移前备份：

```powershell
$env:PINK_ICON_SUBMIT_DATA_DIR = 'C:\path\to\persistent-data'
npm run data -- backup C:\path\to\immutable-pre-deploy-backup
npm run data -- verify C:\path\to\immutable-pre-deploy-backup
```

将备份复制到隔离位置并按 [停机备份与恢复验证](./data-backup.md) 完成恢复演练。只有账号、Session、批次、Job、失败历史、交付证据和 SVG 均可读取时才允许继续。

注意：候选会把数据库升级到当前 schema。旧程序会对更新后的 schema fail-closed；二进制回退必须同时恢复上线前备份，不能让旧程序直接打开已升级数据库。

## 4. 正式仓库切换门禁

正式仓库配置只在以上门禁全部通过后修改。切换任务必须单独审查：

- 移除测试拓扑专用 allowlist，替换为明确的正式 target/push 配置；
- 只读核对 target 默认分支、push fork parent、remote URL、权限和 branch protection；
- 保持 fork + `bot/` 分支 + Draft PR，不授予自动合并、force-push 或默认分支直写；
- 使用一个非破坏性 canary 批次验证唯一 branch 和唯一 Draft PR；
- canary 通过前不开放给全部设计师。

正式切换不得顺带修改 Stage 1、mapping、codepoint、SVG 规则或产品状态机。

## 5. 回滚

出现阻断问题时：

1. 停止服务，确认 Worker 已 drain 且进程退出；
2. 保存当前日志和 data root 的只读副本，不删除远程 branch 或 Draft PR；
3. 若数据库尚未迁移，可回到上一已知版本；若已迁移，恢复上线前完整备份后再启动旧版本；
4. 使用 `/api/health`、`/api/ready`、登录、首页和一个只读历史批次确认恢复；
5. 对已 push 或已建 PR 的批次按 checkpoint 证据人工判定，不自动重放 plan/apply/push。

回滚完成不代表候选可继续上线。必须记录触发条件、checkpoint、远程副作用和恢复证据，修复后从“冻结候选”重新开始。
