# 升级与回滚

升级顺序：备份私人仓库与数据库 → 阅读 CHANGELOG → 在副本执行 migration → 完整测试 →
生成清单和 SHA-256 → 部署新 release → healthz 与页面验收。数据库 migration 失败时不得切换
站点。回滚静态站使用上一 release；涉及数据库 schema 时使用升级前一致性备份并再次校验。
