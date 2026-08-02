# 历代纪段评服务

这是与 Hugo 静态站分离的轻量 Node.js + SQLite 服务。正文仍来自
Markdown；本服务只保存自然段身份、游客段评和审核记录。

本地启动见 `../docs/段评系统.md`。正式服务只监听 `127.0.0.1:4317`，
数据库位于 `/var/lib/lidaiji-comments`，不得复制进 Hugo `public/` 或 Git。

服务不执行 Word 宏、不接收图片、不渲染评论 HTML、不依赖第三方验证码或
远程 API。Node 22.12 及以上可直接使用内置 SQLite，无需 npm 运行时依赖。
