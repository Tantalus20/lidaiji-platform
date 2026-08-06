# 备份与恢复

分别备份私人内容仓库和评论 SQLite。SQLite 必须用 `.backup` 或 Node SQLite backup API，随后
执行 `PRAGMA integrity_check`，生成 SHA-256，并完成“上传→重新下载→校验→解压→读表”演练。
恢复演练只能使用新临时目录，不能覆盖生产数据库。

日备份、月备份和发布前备份应有不同前缀与保留策略；对象存储密钥只放权限 0600 的服务器
配置文件中。

## v0.5.1 备份语义与恢复要点

- 每日异地备份（`deploy/backup/backup-to-cos.sh`，服务器 `/usr/local/sbin/`）：
  - 发布快照为白名单归档 + 文件级 SHA-256 清单，**不跟随符号链接**；
  - SQLite 使用 `.backup` 一致性备份，附带 integrity_check / foreign_key_check / SHA-256；
  - COS 上传后远端校验（对象存在、大小一致、下载比对 SHA-256）；
  - 失败写 `/var/lib/lidaiji-monitor/backup-state/backup-failure.marker`，
    监控 `CHECK_BACKUP=1` 时经既有邮件通道告警；超过 26 小时无成功也告警。
- 段评状态恢复：若段落被误标为 historical，使用权威清单恢复——
  `node --experimental-sqlite comments-service/src/repair-paragraphs.js --database <副本> --manifest <release/comment-manifest.json> --dry-run|--apply [--report <路径>]`。
  默认 `--dry-run`；`--apply` 只恢复（historical→current），绝不把段落改为 historical。
- v0.5.1 起服务启动时若清单未声明 `paragraphsMode: authoritative`，段落状态保持不变，
  不会再因精简清单而整体失效。

## v0.5.3 归档缺陷修复（候选）与恢复要点

- **根因**：v0.5.1 以 `tar -C <root> current` 归档符号链接本身（未解引用），
  site/comments 归档只包含 `current` 链接；文件级 SHA 清单却从在线目录生成，
  造成"清单正确、归档错误"（隔离恢复演练结论 C 证实）。
- **修复**（`deploy/backup/backup-to-cos.sh` v0.5.3）：
  - 备份开始时解析并锁定 current 的真实 release（目录/白名单/命名校验，fail closed）；
  - 复制受控快照后只对快照打包与生成清单；快照内出现任何符号链接即失败；
  - 上传前对归档解压复验：从解压内容重新生成清单并与快照清单逐文件比较；
  - 原子生成（`*.tmp` → mv）、单实例锁（原子 mkdir + PID 陈旧检测）、状态机日志；
  - 清单升级为 JSON `schemaVersion: 2` 且 `archivePayloadVerified: true`
    （表示该归档已通过解压逐文件复验）；**旧 v1 备份不得视为完整恢复源**。
- **历史备份状态**（演练结论，不得改写为"完整恢复已验证"）：
  - `site-current.tar.gz`：归档不完整（仅符号链接）；`comments-current.tar.gz`：归档不完整；
  - 数据库备份：经演练有效；平台源码副本：经演练有效；整站灾难恢复：未打通（待 v0.5.3 部署后重演）。
- **独立验证模式**：`BACKUP_VERIFY_ONLY=<归档> deploy/backup/backup-to-cos.sh`
  对已有归档执行解压复验（VERIFY_OK / VERIFY_FAILED），供恢复前抽查。
- **本地保留副本**：设置 `BACKUP_KEEP_DIR=<目录>` 时，验证通过后归档/校验和/清单
  复制到该目录（运维自查与恢复演练用）。
- **状态语义（v0.5.3 收口）**：
  - 普通真实备份终止状态：`SNAPSHOT_CREATED → MANIFEST_CREATED → ARCHIVE_CREATED →
    LOCAL_VERIFY_DONE → UPLOAD_STARTED → UPLOAD_DONE → REMOTE_VERIFY_DONE → BACKUP_COMPLETE`；
    `BACKUP_COMPLETE` 仅在远端完整性验证通过后出现；
  - `COS_BACKUP_VALIDATE_ONLY=1`：`… → LOCAL_VERIFY_DONE → VALIDATE_ONLY_COMPLETE`
    （不写 BACKUP_COMPLETE、不更新最近成功时间、不触发通知/清理）；
  - `BACKUP_VERIFY_ONLY=<归档>`：`VERIFY_ONLY_STARTED → VERIFY_ONLY_DONE`；
  - 结构化状态记录 `STATE_DIR/backup-last-verify.json`：
    `{mode, remoteUploadPerformed, remoteVerified, backupComplete, archivePayloadVerified}`；
    失败 marker 附带 `mode/failedStage/remoteUploadPerformed`；
  - 归档内 manifest 携带 `mode`（validate-only 另含三个远端 false 字段；full 的
    远端真相以状态记录为准，快照时未知故不写入）。
- **测试**：`tests/test_backup_to_cos.py`（27 项，全部虚构目录，覆盖 current 解析/
  切换/断裂/越界、空 release、内部符号链接逃逸、归档损坏、清单不一致、缺文件、
  并发锁、临时残留、空格路径、秘密不进日志、模式状态机、上传门控与成功时间语义）。
