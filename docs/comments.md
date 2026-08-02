# 评论服务

评论服务使用 Node.js 22+ 与 SQLite，支持段评、章评、人工审核、CSRF、Origin 校验、软删除
和审核审计。`npm run comments:init` 在 `.cache/comments-local/` 创建空库并执行 migration；
`npm run comments:create-admin` 从终端隐藏输入密码，不把密码写入仓库。

生产数据库必须由独立服务用户持有，目录 0700、数据库/WAL/SHM 0600，并定期使用 SQLite
一致性备份。不要把生产数据库复制到客户端或私人内容仓库。
