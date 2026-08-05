# 评论服务

评论服务使用 Node.js 22+ 与 SQLite，支持段评、章评、人工审核、CSRF、Origin 校验、软删除
和审核审计。`npm run comments:init` 在 `.cache/comments-local/` 创建空库并执行 migration；
`npm run comments:create-admin` 从终端隐藏输入密码，不把密码写入仓库。

生产数据库必须由独立服务用户持有，目录 0700、数据库/WAL/SHM 0600，并定期使用 SQLite
一致性备份。不要把生产数据库复制到客户端或私人内容仓库。

## v0.5.1 段落同步语义与Bot鉴权

- manifest 每篇文章可声明 `paragraphsMode`：
  - `authoritative`：按完整段落列表同步（构建产物自动携带）；
  - `omitted`（缺省且无段落数据时）：跳过段落 reconciliation，状态不变。
- 大规模失效门禁：一次同步将超过 100 个或现有 current 段落 20% 转为 historical 时
  默认拒绝；确需放行时设置 `COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE=1`（受控操作）。
- 章评 Bot 端点（`/api/bot/chapter-reviews`）：`LIDAIJI_CHAPTER_REVIEW_BOT_TOKEN`
  未配置时端点返回 503（DISABLED）；缺失/空/错误 Bearer 一律 401。
- 健康接口报告真实版本（package.json）、`chapterReviewBot` 状态与 manifest 同步结果。
