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
