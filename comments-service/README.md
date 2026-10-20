# 历代纪段评服务

这是与 Hugo 静态站分离的轻量 Node.js + SQLite 服务。正文仍来自
Markdown；本服务保存自然段/整篇文章身份、读者评论和审核记录。

本地启动见 `../docs/段评系统.md`。正式服务只监听 `127.0.0.1:4317`，
数据库位于 `/var/lib/lidaiji-comments`，不得复制进 Hugo `public/` 或 Git。

## 身份策略

生产启用 `COMMENTS_IDENTITY_MODE=cqnb`，通过 `cqnb_platform` Cookie 向澄清南北
`/api/auth/session` 校验读者身份：

- `COMMENTS_REQUIRE_LOGIN=true`：未登录提交返回 401；
- `COMMENTS_AUTO_APPROVE=true`：已登录评论直接公开；
- 显示名强制取账号 `displayName`/`username`，不信任前端昵称；
- 匿名投稿保持 `pending` 的降级路径只在 `IDENTITY_MODE=disabled` 或允许匿名时使用。

`COMMENTS_PUBLIC_ORIGIN` 支持逗号分隔的多个正式域名，第一个作为规范 Origin：

```text
COMMENTS_PUBLIC_ORIGIN=https://example.com,https://writing.example.com
```

双域名部署必须同时配置，否则别名域提交会被 403 拒绝。

服务不执行 Word 宏、不接收图片、不渲染评论 HTML、不依赖第三方验证码或
远程 API。Node 22.12 及以上可直接使用内置 SQLite，无需 npm 运行时依赖。
