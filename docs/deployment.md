# 部署

先在干净 Git 状态运行 `npm run check` 和 `npm run build`，再生成带 SHA-256 与清单的发布包。
Nginx 与 systemd 示例位于 `deploy/`，其中 `example.com`、`/path/to/...`、
`YOUR_VALUE_HERE` 必须在服务器安全配置中替换。Studio 不部署到公网。

静态站应以新时间戳目录解压，验证后原子切换 `current` 软链接；评论服务只监听回环地址。
不要把 `.env`、SQLite、Cookie、私人内容或对象存储凭据放进源码发布包。
