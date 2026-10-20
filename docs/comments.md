# 评论服务

评论服务使用 Node.js 22+ 与 SQLite，支持段评、章评、人工审核、CSRF、Origin 校验、软删除
和审核审计。`npm run comments:init` 在 `.cache/comments-local/` 创建空库并执行 migration；
`npm run comments:create-admin` 从终端隐藏输入密码，不把密码写入仓库。

生产数据库必须由独立服务用户持有，目录 0700、数据库/WAL/SHM 0600，并定期使用 SQLite
一致性备份。不要把生产数据库复制到客户端或私人内容仓库。

## 身份策略与多域名

生产使用 `COMMENTS_IDENTITY_MODE=cqnb` 接入澄清南北账号：

```text
COMMENTS_IDENTITY_MODE=cqnb
COMMENTS_REQUIRE_LOGIN=true
COMMENTS_AUTO_APPROVE=true
COMMENTS_CQNB_SESSION_URL=http://127.0.0.1:3000/api/auth/session
COMMENTS_PUBLIC_ORIGIN=https://xn--mnqv6ix00c.cn,https://writing.nsdynastygame.cn
```

- 未登录提交返回 401；已登录评论直接公开。
- 显示名由服务端取账号身份，前端只读昵称不参与最终写入。
- `COMMENTS_PUBLIC_ORIGIN` 支持逗号分隔多个正式域名，第一个是规范 Origin（CQNB
  会话校验使用）。只配置一个域名时，另一个正式域名的提交会被 403 拒绝。
- 匿名投稿保持 `pending` 的降级逻辑只在 `IDENTITY_MODE=disabled` 或
  `COMMENTS_REQUIRE_LOGIN=false` 时使用，不是生产默认。

## v0.5.1 段落同步语义与Bot鉴权

- manifest 每篇文章可声明 `paragraphsMode`：
  - `authoritative`：按完整段落列表同步（构建产物自动携带）；
  - `omitted`（缺省且无段落数据时）：跳过段落 reconciliation，状态不变。
- 大规模失效门禁：一次同步将超过 100 个或现有 current 段落 20% 转为 historical 时
  默认拒绝；确需放行时设置 `COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE=1`（受控操作）。
- 章评 Bot 端点（`/api/bot/chapter-reviews`）：`LIDAIJI_CHAPTER_REVIEW_BOT_TOKEN`
  未配置时端点返回 503（DISABLED）；缺失/空/错误 Bearer 一律 401。
- 健康接口报告真实版本（package.json）、`chapterReviewBot` 状态与 manifest 同步结果。
