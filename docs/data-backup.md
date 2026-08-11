# 停机备份与恢复验证

本方案只支持停机一致备份。它不提供在线备份、自动恢复或源数据清理。

## 备份前提

1. 停止 PinK Icon Submit API 与 Worker，并确认进程已退出。
2. 使用与服务相同的 `PINK_ICON_SUBMIT_DATA_DIR` 作为 `dataRoot`。
3. 选择一个不存在、且不位于 `dataRoot` 内的目标目录。

`createBackup(dataRoot, destination)` 会先取得服务使用的 RuntimeLease；服务仍在运行时会立即拒绝。持有 lease 期间，它会：

1. 对 `pink-icon-submit.sqlite` 执行 WAL checkpoint 和 `integrity_check`；
2. 关闭数据库连接；
3. 复制整个 data root，但排除 runtime-lock 数据库及其 WAL/SHM 等 sidecar；
4. 在备份根生成 `manifest.json`，记录 `data/` 下每个文件的大小与 SHA-256。

任何失败都会删除本次尚未完成的目标目录，不修改或删除源数据。

生产构建后可使用同一入口创建并立即验证备份：

```powershell
$env:PINK_ICON_SUBMIT_DATA_DIR = 'C:\path\to\persistent-data'
npm run data -- backup C:\path\to\new-backup-directory
npm run data -- verify C:\path\to\new-backup-directory
```

## 验证

`verifyBackup(destination)` 会拒绝：

- 清单缺失、格式错误、重复路径、路径逃逸或清单外文件；
- 文件缺失、大小变化或 SHA-256 不匹配；
- SQLite `integrity_check` 失败；
- 数据库 schema 高于当前程序支持版本；
- `items.source_file` 指向的 SVG 不存在。

备份完成后必须立即运行验证，并将整个备份目录作为一个不可拆分的单元保存。

## 隔离恢复演练

1. 保持生产服务停止，不要覆盖原 data root。
2. 将备份中的 `data/` 复制到一个全新的隔离目录。
3. 保留原备份并再次运行 `verifyBackup`。
4. 使用当前版本程序指向隔离目录，确认账号、批次、Job、失败历史和上传 SVG 可读取。
5. 仅在人工确认恢复内容与版本兼容后，按部署运行手册切换 data root。

恢复动作有意不由本模块自动执行，避免误覆盖现有数据。数据库降级也不受支持；schema 高于当前程序版本时必须改用匹配或更新的程序验证。

## 残余边界

- RuntimeLease 只能协调遵守同一锁约定的服务进程，不能阻止其他工具直接修改 data root。
- 备份期间需保证磁盘空间充足，目标存储本身的持久性与加密由部署环境负责。
- 当前 schema 上限与数据库 migration 版本需同步维护。
