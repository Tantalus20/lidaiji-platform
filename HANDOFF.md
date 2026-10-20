# 《历代纪》项目交接与代码审计（2026-10-21 修复版）

> 本文档取代旧 `HANDOFF.md` 的版本描述，也纠正 `AGENTS.md` 中“`VERSION` 是唯一版本来源、`main` 是当前主线”的过时说法。
> 接手前先读完本文，再执行任何构建、发布或分支操作。

## 0. 30 秒结论

1. **线上主站**：<https://xn--mnqv6ix00c.cn/>（别名 <https://writing.nsdynastygame.cn/>，两域名都直接服务，不互相跳转）。
2. **线上代码不是当前 `main`**。生产代码在分支 `p0/production-features`，生产代码提交是 `c031efb`（Windows 适配移除；其后可能还有文档提交），线上 release 的 `sourceCommit` 是 `3105c66`（双域名修复）。这条分支比 `origin/main` 多 14 个提交，**已推送到 `origin/p0/production-features`，并已设为 GitHub 默认分支**。
3. 当前工作区 `/Users/haminster/Projects/writing-site` 在 `main` 上，`main` 与 `origin/main` 已分叉（本地独有 27 个提交，远端独有 98 个）。那套过期的登录改动已收进 `stash@{0}`，不要从这里发布或合并。
4. **阅读公开，评论需要登录**：站点没有全站登录门禁。文章、首页、搜索、时间线、RSS 公开；段评/章评要求澄清南北（CQNB）账号登录；已登录评论直接公开；未登录状态下评论服务返回 401。
5. **生产组件**：site `0.4.3`、comments `0.5.1`、studio `0.2.6`、platform `0.2.1`。`COMPONENTS.json` 已同步，并由 `check-source` 校验。
6. **别名域名评论 403 已修复并上线**（commit `3105c66`）：评论服务支持逗号分隔的多 Origin 白名单；两个正式域名现在都通过来源校验，未知来源仍返回 403。
7. **平台支持已收窄为 macOS + Linux**（commit `c031efb`）：Windows PowerShell 启动器、Windows CI、Windows 打包/发布分支和 `docs/windows.md` 已删除；生产行为不变，因此线上仍停在 `3105c66`，不需要为这次清理重新发布。

---

## 1. 生产事实（2026-10-21 修复后核对）

### 1.1 服务器与 release

| 项目 | 值 |
|---|---|
| 主机 | `game-server`（43.132.227.252） |
| 主站域名 | `xn--mnqv6ix00c.cn`（历代纪.cn） |
| 别名域名 | `writing.nsdynastygame.cn`（直接服务，不是跳转） |
| 当前 release | `/opt/writing-site/releases/20261021_002445` |
| 上一 release | `/opt/writing-site/releases/20261009_140244` |
| 生产源码快照 | `/opt/writing-site/source`（无 `.git`，是发布源码包） |
| Nginx 配置 | `/etc/nginx/conf.d/writing-site.conf`（手工维护，见 §8 P1-1） |
| 评论服务 | systemd `lidaiji-comments`，`127.0.0.1:4317`，active |
| 评论数据库 | `/var/lib/lidaiji-comments/comments.sqlite3` |
| 评论备份 | `/var/backups/lidaiji-comments/` |
| 静态备份 | `/var/backups/writing-site/` |

线上 `BUILD_INFO`（`/opt/writing-site/current/BUILD_INFO`）：

```text
version: 0.4.3
sourceCommit: 3105c66370a1a986e805887ff3883484bb64f903
releaseSnapshotId: 1ccd8e4c6de96da0
releaseSnapshotFingerprint: 1ccd8e4c6de96da0756c145565478256c9fa6358ca44dd408eb3ff1555206813
snapshotMode: full_site
contentManifestSha256: 90fcdf54865064b62dd0d28fd6169f96b710c2ce3e463f68912a2152884176ad
configFingerprint: 8933ac11636aae34932e44a60ef6b6c9ce367dba38b64b781e06c5633555da94
builderVersion: release-snapshot/1;site=0.4.3
buildTimestamp: 2026-10-20T16:24:36Z
hugoVersion: v0.162.0-076dfe13d0f789e3d9586b192f8f7f3329c26990
```

从 `p0/production-features` `3105c66` 用同一私仓构建，内容清单/配置指纹仍为 `90fcdf…` / `8933ac…`；快照 `1ccd8e4c…` 与线上一致。其后的 `c031efb` 只删除 Windows 脚本/文档/CI 并收窄平台声明，不改变站点产物，因此线上仍停在 `3105c66`。

### 1.2 线上评论服务

```json
{"ok":true,"version":"0.5.1","chapterReviewBot":{"configured":true,"state":"ENABLED"},
 "manifest":{"ok":true,"articles":8,"revisions":0,"paragraphs":3165,"omitted":0,"retiring":0}}
```

生产环境关键配置（值已脱敏，键名来自 `/etc/lidaiji-comments.env`）：

```text
COMMENTS_PUBLIC_ORIGIN=https://xn--mnqv6ix00c.cn,https://writing.nsdynastygame.cn
COMMENTS_IDENTITY_MODE=cqnb
COMMENTS_REQUIRE_LOGIN=true
COMMENTS_AUTO_APPROVE=true
COMMENTS_CQNB_SESSION_URL=http://127.0.0.1:3000/api/auth/session
```

同一文件还包含 `COMMENTS_HMAC_SECRET`、QQ 评论 pepper、章节审核 bot token、运维通知 token。**这些值不得复制进仓库、交接文档或聊天记录。**

线上评论库当前只有测试/验收数据：

```text
approved 2 · pending 1 · deleted 4
```

其中 pending 一条是 2026-08-20 的章评「恢复验收」。没有真实读者评论需要保护。

### 1.3 登录与评论来源已验证

用站长提供的测试账号（账号密码不写入仓库）实测：

```text
主域 POST /api/auth/login   → 200，返回 Set-Cookie
主域 GET  /api/auth/session → 200，返回测试用户
主域 POST /api/auth/logout  → 200

别名域 POST /api/auth/login  → 200
别名域 GET  /api/auth/session → 200
```

评论来源（未登录、有效 JSON、不写入）：

```text
Origin https://xn--mnqv6ix00c.cn            → 401 请先登录
Origin https://writing.nsdynastygame.cn     → 401 请先登录
Origin https://evil.example                 → 403 请求来源不被接受
```

别名域登录后提交一个不存在的 articleId，返回 400「这篇文章当前不接受新评论」——说明来源校验和 CQNB 身份校验都已通过，只是业务层拒绝。测试后已登出并删除临时 cookie 文件，没有写入评论。

### 1.4 分享站

- <https://read.xn--mnqv6ix00c.cn/> 仍在服务，HTTP 200。
- 当前 release：`/opt/lidaiji-share/releases/20260827_120639`，静态站，无 systemd 服务（`lidaiji-share` inactive）。
- 源码 `share-site/`、`share_publisher/` **只存在于旧 `main` 分支**；`p0/production-features` 不包含它们。
- 不要把主站发布链套到分享站上，也不要用 `p0` 覆盖 `/opt/lidaiji-share`。分享站目前是“线上可访问、源码不在生产分支、重建路径未验证”的独立遗留系统。

---

## 2. 代码到底在哪（最重要的一节）

### 2.1 仓库与分支

| 位置 | 内容 | 状态 |
|---|---|---|
| `/Users/haminster/Projects/writing-site` | 平台仓库，当前检出 `main` `39544c5` | **不是生产代码**；HANDOFF/AGENTS/.gitignore 有文档改动，旧登录改动在 stash |
| `p0/production-features` `c031efb` | 生产分支，线上代码是 `3105c66`（仅差 Windows 清理）；GitHub 默认分支 | **已推送到 `origin/p0/production-features`** |
| `origin/main` `d2183c2` | GitHub 远端主线 | 不含登录/身份策略/双域名修复/Windows 清理等 14 个生产提交 |
| `p0/workspace-snapshot` | 已推送到远端的 P0 分支 | 生产分支的祖先，不是生产 HEAD |
| `/Users/haminster/Projects/lidaiji-private` | 私人文章、图片、作者评、站点覆盖 | **Git 已恢复**，见 §2.3 |

分支关系统计（`git rev-list --left-right --count A...B`）：

```text
main vs origin/main:            本地独有 27，远端独有 98
p0 vs origin/main:              本地独有 14，远端独有 0
p0 vs main:                     p0 独有 112，main 独有 27
```

结论：`p0` 是 `origin/main` 的正常后继，`main` 是一条旧分叉。生产分支独有提交：

```text
c031efb 移除 Windows 适配（PowerShell/Windows CI/Windows 文档，macOS+Linux）
3105c66 修复双域名评论与登录契约（多 Origin 白名单、登录契约测试、发布自检、文档/版本）
1af1c33 docs(nginx): 记录生产双域名正式站，模板防覆盖提示
eef4dde refactor(theme): 登录评论直接公开，昵称自动取自澄清南北账号
12b89f2 test(long-site): keep platform login page in demo build
9de207a test(long-site): clear repo content before demo copy to avoid nesting
864bbfb style(theme): keep explicit strong/em semantic rules in calibrated css
bb53abe style(theme): keep align shortcode container rules in calibrated css
943cfe0 test(site): exempt reader login page from sensitive-field scan
69fb2f8 feat(theme): reader login page and comment login gating via CQNB identity adapter
fe284ff style(theme): calibrate visual to production values, keep poetry/endnote styles
0eb104e fix(comments): keep anonymous pending guarantee, auto-approve only for authenticated
400deda feat(snapshot): optional publish-author-notes flag for full_site
25d1bcd feat(comments): optional CQNB identity policy layer
```

### 2.2 生产工作树

生产工作树已恢复到 `/Users/haminster/Projects/worktrees/lidaiji-platform-p0`，HEAD 包含生产代码提交 `c031efb`（若之后有文档提交，HEAD 会再前进）。若目录再次丢失：

```bash
cd /Users/haminster/Projects/writing-site
git worktree prune
git worktree add /Users/haminster/Projects/worktrees/lidaiji-platform-p0 p0/production-features
cd /Users/haminster/Projects/worktrees/lidaiji-platform-p0
git log --oneline -3   # 应包含 c031efb
git status --short     # 必须干净
```

**不要**在 p0 工作树里创建 `.hugo-local` 或 `.venv-importer` 符号链接。`release_snapshot.py` 要求工作树完全干净（未跟踪文件也拒绝），符号链接会让构建直接失败。用环境变量：

```bash
export HUGO_BIN=/Users/haminster/Projects/writing-site/.hugo-local
export WRITING_IMPORT_PYTHON=/Users/haminster/Projects/writing-site/.venv-importer/bin/python
export LIDAIJI_CONTENT_REPO_ROOT=/Users/haminster/Projects/lidaiji-private
```

### 2.3 私人内容仓库

- 路径：`/Users/haminster/Projects/lidaiji-private`
- 8 篇公开文章，16 个 Markdown/内容文件，3165 个自然段。
- **Git 已恢复**：从 `lidaiji-content-git_20260826_162355.bundle` 恢复 `.git`，当前 `main` HEAD `736a76c`，工作区干净。
- `origin/main` 引用仍指向 `7106a0a`（2026-08 全卷 WPS 版，6 篇）；它与当前 8 篇内容不一致。为防止误 `git pull` 改掉文章，已解除 `main` 的 upstream 跟踪。**不要在没有逐篇核对的情况下切到 `7106a0a`。**
- 平台分支的 `.lidaiji-workspace.json` 记录 `contentCommit: 736a76c…`，但该文件不入库。
- 最新 bundle：`~/Documents/历代纪备份/lidaiji-content-git_20261021_002437.bundle`，包含 `main=736a76c` 和历史 `origin/main=7106a0a`。

### 2.4 备份与可恢复性

| 备份 | 路径 | 说明 |
|---|---|---|
| 本地平台最新备份 | `~/Documents/历代纪备份/lidaiji-platform_20261021_002437.tar.gz` | 源码目录快照 |
| 本地平台 Git bundle | `~/Documents/历代纪备份/lidaiji-platform-git_20261021_002437.bundle` | 含 `p0/production-features=3105c66`；远端已含更新的 `c031efb` |
| 本地内容备份 | `~/Documents/历代纪备份/lidaiji-content_20261021_002437.tar.gz` | 当前私仓内容 |
| 本地内容 bundle | `~/Documents/历代纪备份/lidaiji-content-git_20261021_002437.bundle` | `main=736a76c`，`origin/main=7106a0a` |
| 服务器源码包 | `/opt/writing-site/source` | 生产提交 `3105c66` 的源码，无 `.git` |
| 服务器评论库备份 | `/var/backups/lidaiji-comments/` | 发布前一致性备份 |
| 服务器旧 release | `/opt/writing-site/releases/` | 保留最近 5 个，可回滚 |

新 bundle 已包含 `3105c66`，`c031efb` 已推送到 `origin/p0/production-features`。生产分支现在有 GitHub 远端备份；本地 bundle 可再生成一次以包含最新提交。

---

## 3. 架构与请求流

### 3.1 站点与内容

```text
私人内容仓库 content/ ──┐
                        ├─ release snapshot（git archive 平台代码 + 冻结内容）
平台主题 themes/lidaiji ─┘        │
                                  ├─ Hugo 构建 → dist/site
                                  ├─ comment-manifest.json（文章/段落身份）
                                  ├─ BUILD_INFO（四方身份）
                                  └─ 发布包 → /opt/writing-site/releases/<时间戳>
```

正文权威来源是 Markdown Page Bundle；不要迁入数据库或 CMS。

### 3.2 登录

```text
浏览器 /login/?return=<站内路径>
  → 同源 POST /api/auth/login 或 /api/auth/register
  → Nginx location ^~ /api/auth/ 反代到 127.0.0.1:3000（澄清南北）
  → 澄清南北校验密码，下发 host-only Cookie cqnb_platform
  → 浏览器回到 return 指定的站内路径
```

- Cookie 是 **host-only**，没有 `Domain` 属性：`xn--mnqv6ix00c.cn` 和 `writing.nsdynastygame.cn` 各自独立会话，用户在一个域名登录不会自动登录另一个域名。
- 站点不保存密码；账号真源是澄清南北。
- 顶栏 `account.js` 调 `/api/auth/session`，显示昵称/退出，或“登录 / 注册”。
- 登录页只有登录/注册，没有“忘记密码”和账号设置入口；找回密码要去 `www.nsdynastygame.cn` 的账号体系。
- `/login/` 是公开页面，不挡阅读。

### 3.3 评论

```text
打开段评/章评
  → JS 先请求 /api/auth/session
  → 未登录：只显示登录引导，不显示可提交表单
  → 已登录：表单显示，昵称只读填入账号 displayName

提交
  → POST /api/comments/v1/comments
  → comments-service 校验 Origin、文章/段落、限流、蜜罐、重复
  → cqnbUser() 带 Cookie 请求 127.0.0.1:3000/api/auth/session
  → 服务端强制 displayName = 账号昵称（不信任前端）
  → 已登录 + AUTO_APPROVE=true → approved/public_at；否则 pending
```

- 匿名评论**不会**自动公开：代码里 `finalStatus` 只有在 `identity` 存在且 `autoApproveComments` 时才变为 approved。但在生产 `REQUIRE_LOGIN=true` 下，匿名请求在更早的 401 就被拒绝。
- `COMMENTS_PUBLIC_ORIGIN` 支持逗号分隔多个正式域名；生产已配置主域 + 别名域。未知 Origin 仍返回 403。
- 管理后台 `/admin/comments/` 使用评论服务自己的管理员账号，不是读者 CQNB 登录；两套身份不要混淆。
- 评论服务不可用时只影响评论区域，正文阅读不受影响。

### 3.4 构建与发布

```text
npm run check
  → scripts/check.sh（源码/前端契约/评论测试/Studio/导入器/构建/长文压力）

npm run publish
  → 生成 full_site release snapshot（要求平台工作树干净）
  → build.sh（从快照构建，不读可变工作树）
  → backup.sh
  → 打静态包、源码包、评论包（SHA-256）
  → scp 到 game-server
  → server-publish.sh：
       校验 SHA/身份
       解包 release 与源码
       备份并迁移评论数据库
       sync-manifest
       切 comments current，重启 lidaiji-comments，健康检查
       切主站 current，公网自检
       失败自动回滚
```

**发布脚本不会部署 Nginx 配置**。`publish.sh` 只执行 `nginx -t`，不渲染、不上传、不 reload。Nginx 是手工维护的，见 §8 P1-1。

---

## 4. 代码地图（`p0/production-features`）

| 路径 | 作用 | 备注 |
|---|---|---|
| `themes/lidaiji/layouts/` | Hugo 模板：首页、文集、文章、搜索、时间线、登录页、404 | `single.html` 含段评/章评表单；`auth.html` 是登录页 |
| `themes/lidaiji/assets/js/` | `site.js`、`account.js`、`auth.js`、`comments.js`、`article-comments.js`、`search.js` | 登录/评论门禁在前端做体验，服务端才是最终门禁 |
| `themes/lidaiji/assets/css/site.css` | 阅读站视觉、登录页、评论表单 | 约 2500 行 |
| `content/login/_index.md` | `/login/` 页面入口 | 公开页面 |
| `comments-service/src/app.js` | HTTP 路由、评论提交、审核、身份策略、限流 | 生产核心 |
| `comments-service/src/config.js` | 环境变量与默认值 | `IDENTITY_MODE`、`REQUIRE_LOGIN`、`AUTO_APPROVE` |
| `comments-service/src/db.js` / `migrations/` | SQLite schema 与迁移 | 段落身份、评论、审核记录 |
| `comments-service/test/` | 101 项服务测试 | 含 `identity-policy.test.js` |
| `studio/` | 本地作者工作台 v0.2.6，只监听 127.0.0.1 | 不部署公网；有 local-bootstrap 认证 |
| `importer/` | DOCX → Page Bundle 三阶段导入 | 真实写作流程入口 |
| `tools/workspace.py` | 解析平台/私人内容双仓库 | 私人模式 fail-closed |
| `tools/release_snapshot.py` | 不可变发布快照 | 要求平台 Git 干净 |
| `scripts/build.sh` | 快照 → Hugo → 检查 → BUILD_INFO | 正式构建唯一入口 |
| `scripts/publish.sh` | 快照 → 构建 → 备份 → 上传 | 不处理 Nginx |
| `scripts/server-publish.sh` | 服务端原子发布/回滚 | 只重启 `lidaiji-comments` |
| `scripts/check.sh` | 完整检查链 | CI 也调用 |
| `tests/` | 43 个测试文件 | 含发布身份、快照、阅读 UI、评论契约 |
| `.github/workflows/ci.yml` | macOS + Linux CI | 触发所有 push/PR；p0 已推送，可运行 CI |
| `share-site/`、`share_publisher/` | **不在 p0**，只在旧 `main` | 分享站遗留系统 |

代码规模约 5.5 万行（JS/MJS/Python/HTML/CSS，不含依赖），组件文件约 150 个，测试文件 48 个。

---

## 5. 内容与数据边界

必须保持：

- `articleId = article-<16 hex>`，由文章路径/身份决定；不要改生成规则。
- `articleRevision = articleId@<body sha12>`；正文变化会刷新 revision。
- `paragraph-id = p-<hash>`；评论和作者评都依赖它。
- 作者评在 `data/author-notes/<articleId>.yaml`；草稿不得进入构建。
- 评论库在 `/var/lib/lidaiji-comments/comments.sqlite3`，只在服务器；不要把生产库下载到 Studio 当审核源。
- 文章和图片是作者资产：不批量改写、不重排、不创作正文。改文章前必须得到明确范围和意图。
- `.lidaiji-workspace.json`、`.author-settings`、`.env`、备份、Word 原稿、SQLite 一律不入库。
- 平台仓库是公开 GitHub 仓库；私人文章只在 `lidaiji-private`。

---

## 6. 常用命令

### 6.1 环境

```bash
cd /Users/haminster/Projects/worktrees/lidaiji-platform-p0

export HUGO_BIN=/Users/haminster/Projects/writing-site/.hugo-local
export WRITING_IMPORT_PYTHON=/Users/haminster/Projects/writing-site/.venv-importer/bin/python
export LIDAIJI_CONTENT_REPO_ROOT=/Users/haminster/Projects/lidaiji-private
```

首次：

```bash
npm ci
npm --prefix comments-service ci
npm run comments:init   # 仅本地测试库
```

### 6.2 检查与构建

```bash
npm run check
SITE_BASE_URL=https://xn--mnqv6ix00c.cn/ npm run build
# 输出 dist/site；BUILD_INFO 含 sourceCommit / snapshot / 内容指纹
```

只跑关键检查（本轮审计用过的）：

```bash
node tests/check-source.mjs
node tests/check-comment-button.mjs .
node tests/check-article-comments.mjs .
npm --prefix comments-service run check
```

### 6.3 发布

```bash
WRITING_SSH_TARGET=game-server \
WRITING_DOMAIN=xn--mnqv6ix00c.cn \
WRITING_BACKUP_DIR="$HOME/Documents/历代纪备份" \
WRITING_ASSUME_CONFIRM=1 \
npm run publish
```

若 SSH 报 `Too many authentication failures`，用：

```bash
ssh -o IdentitiesOnly=yes -i ~/.ssh/tencent_lighthouse game-server
```

发布脚本要求平台工作树干净；未跟踪文件也会被拒绝。

首次启用双域名白名单时，必须按“先发布支持逗号分隔的评论代码，再改
`/etc/lidaiji-comments.env` 并 `systemctl restart lidaiji-comments`”的顺序；反过来会让旧代码
把整串逗号分隔值当成一个 Origin，导致两个域名都无法评论。当前生产 env 已是双域名。

### 6.4 回滚

```bash
ssh game-server sudo /opt/writing-site/source/scripts/server-rollback.sh \
  /opt/writing-site/releases/20261009_140244
```

回滚前确认目标 release 存在；评论库回滚由脚本按发布前备份处理，不要手工覆盖数据库。

### 6.5 Nginx（手工）

```bash
ssh game-server
cp -a /etc/nginx/conf.d/writing-site.conf \
      /etc/nginx/conf.d/writing-site.conf.bak-$(date +%Y%m%d_%H%M%S)
# 编辑配置
nginx -t && systemctl reload nginx
```

必须保留：

- 双域名两个完整 server 块（`xn--mnqv6ix00c.cn` 与 `writing.nsdynastygame.cn`，各有自己的证书）。
- `/api/auth/` 与 `/api/account` 反代到 `127.0.0.1:3000`。
- `/api/comments/` 与 `/admin/comments/` 反代到 `127.0.0.1:4317`。
- `/source/` 返回 404、敏感后缀拦截、CSP/安全头。

仓库里的 `deploy/nginx/writing-site.conf.template` 只是单域名参考模板，**不能直接覆盖生产配置**。

---

## 7. 当前功能口径

- 阅读：公开，无登录门禁。
- 登录：CQNB 账号，可在主域或别名域分别登录；会话 12 小时；Cookie host-only。
- 评论：必须登录；登录评论直接公开；昵称取账号 displayName；服务端强制覆盖前端昵称。
- 游客匿名：生产 `REQUIRE_LOGIN=true`，匿名提交返回 401；代码仍保留“匿名→pending”的降级路径，供 `IDENTITY_MODE=disabled` 的公共平台使用。
- 审核后台：`/admin/comments/`，管理员登录与读者登录分离；仍可隐藏/删除/标记垃圾。
- 限流：每分钟 3、每小时 15、每天 50（生产 env 可覆盖）；重复内容 30 分钟内拒绝；蜜罐命中标记 spam。
- 双域名：阅读、登录、退出、评论提交都工作；两个正式域名都在 `COMMENTS_PUBLIC_ORIGIN` 白名单中，未知来源仍 403。
- 分享站：独立静态站，不属于主站发布链，评论/登录不适用。

---

## 8. 审计发现

### P0-1 生产分支只在本地（已解决）

修复前：

- `git branch -r --contains p0/production-features` 为空。
- `origin/main` 是 `d2183c2`，生产分支比它多 13 个提交。
- 线上 `sourceCommit=3105c66`，只有本地分支、本地 bundle 和服务器 source 包包含它。

已处理：

1. 生产工作树已恢复（§2.2），包含生产代码提交 `c031efb`。
2. 分支已推送到 `origin/p0/production-features`；远端包含 `3105c66` 和 Windows 清理提交 `c031efb`。
3. 新 bundle `lidaiji-platform-git_20261021_002437.bundle` 包含 `3105c66`。
4. 不要用 `main` 合并/覆盖 p0；两者已分叉。

遗留注意：`origin/main` 仍不含这些提交。后续应以 `p0/production-features` 为准，或在获得用户确认后把该分支合并到 `main`；不要强推。

### P0-2 别名域名提交评论 403（已修复并上线）

修复前（2026-10-20 实测）：

```text
POST /api/comments/v1/comments  Origin: https://xn--mnqv6ix00c.cn        → 401 请先登录
POST /api/comments/v1/comments  Origin: https://writing.nsdynastygame.cn → 403 请求来源不被接受
```

原因：`config.publicOrigin` 只接受单个 Origin，生产 env 也只配置了主域；Nginx 让两个域名都直接服务。

修复（commit `3105c66`）：

- `COMMENTS_PUBLIC_ORIGIN` 支持逗号分隔多个 Origin，第一项作为规范 Origin（CQNB 会话校验使用）。
- `originAllowed()` 与 `adminOriginAllowed()` 改为集合匹配；直接构造 config 的旧调用仍回落到单个 `publicOrigin`。
- 新增多域名白名单测试：别名 Origin 登录评论被接受，未知 Origin 仍 403。
- 生产 env 已配置两个正式域名，评论服务已重启。

修复后实测：

```text
Origin https://xn--mnqv6ix00c.cn        → 401 请先登录
Origin https://writing.nsdynastygame.cn → 401 请先登录
Origin https://evil.example             → 403 请求来源不被接受
```

别名域登录后提交不存在的 articleId 返回 400（业务层拒绝），说明来源和 CQNB 身份校验均已通过；没有写入评论。

### P0-3 文档与运行时口径矛盾（已修复）

修复前：

- `README.md` 把评论描述为“游客可评论；支持人工审核”。
- 旧 `main` 的 README/comments README 写“所有评论先待审核”。
- `docs/comments.md` 没有 CQNB 身份策略说明。
- `COMPONENTS.json` 版本全部过期。

修复后：

- README 明确“CQNB 登录后评论、登录直接公开、匿名待审仅用于关闭身份策略的部署”。
- comments README 与 `docs/comments.md` 增加身份策略与多 Origin 说明。
- `.env.example` 展示双域名逗号分隔。
- `COMPONENTS.json` 更新为 platform 0.2.1 / site 0.4.3 / comments 0.5.1 / studio 0.2.6。
- `check-source.mjs` 新增断言，组件清单与各版本唯一来源不一致时直接失败。

### P1-1 Nginx 不在发布链内

`publish.sh` / `server-publish.sh` 只做 `nginx -t` 和站点/评论切换，不部署 `/etc/nginx/conf.d/writing-site.conf`。双域名配置、`/api/auth` 反代和证书都是手工维护。

风险：代码发布成功但认证路由缺失/被模板覆盖时，登录和评论会静默坏掉；下一次发布也不会修复。

处理：把生产 Nginx 配置纳入受控备份与变更记录；模板只作参考；任何覆盖前保留双域名结构和证书路径。

### P1-2 登录页/认证反代测试（部分修复）

生产分支现在有 **104 项评论服务测试**（含 `identity-policy.test.js`：匿名 pending、未登录 401、登录自动公开、显示名取身份、多域名白名单）。

本轮新增：

- `tests/check-login-page.mjs`：登录/注册页结构、本站 `/login/` 回跳、评论前会话检查、昵称身份、登录评论直接公开、Nginx auth/account 反代契约；已接入 `scripts/check.sh`。
- `server-publish.sh`：发布前校验 `/api/auth/session` 返回 401，切换后校验 `/login/` 返回 200。

仍然没有真正的浏览器 E2E（启动 Nginx + 模拟 CQNB + 填表登录 + 提交评论）。本轮用 curl 完成了主域/别名域登录、会话、来源校验和业务层拒绝验证，没有写入评论。CI 仍只在分支推送时运行；生产分支未推送，所以没有 CI 结果。

### P1-3 登录/账号体验缺口

- `/login/` 只有登录和注册；没有“忘记密码”。如需找回，只能去 `www.nsdynastygame.cn` 的账号体系。
- 顶栏登录后只显示昵称和“退出”，没有账号设置入口。
- 两个正式域名各自独立会话；用户在别名域登录后，主域仍是未登录。
- 登录页已在页面 head 加 `noindex, nofollow`，但 `sitemap.xml` 仍包含 `/login/`；如需彻底移除要改 sitemap 模板。
- 顶栏初始 HTML 永远渲染“登录 / 注册”，JS 加载后才替换为昵称，存在短暂闪烁。

这些不是阻断缺陷，但会影响读者体验；改前先和用户确认设计。

### P1-4 私人内容版本控制（已修复）

`lidaiji-private` 已从 `lidaiji-content-git_20260826_162355.bundle` 恢复 `.git`：

- `main` HEAD `736a76c`，工作区干净，与线上内容一致。
- `origin/main` 引用仍指向 `7106a0a`（2026-08 全卷 WPS 版，6 篇）；它和当前 8 篇内容不同。
- 已解除 `main` 的 upstream 跟踪，避免误 `git pull` 改文章。
- 最新 bundle `lidaiji-content-git_20261021_002437.bundle` 同时保存两个提交。

今后编辑文章应正常 `git add/commit`；不要在没有逐篇核对的情况下切到 `7106a0a`。

### P1-5 `main` 过期登录改动（已收起）

原先未提交的旧登录实现已收进：

```text
stash@{0}: On main: 2026-10-20: stale login work superseded by p0/production-features
```

包括旧 Nginx 模板、旧 `build.sh`、旧主题 JS/CSS/模板和未跟踪的 `content/login`、`auth.js`、`account.js`、`layouts/auth.html`、`layouts/login/list.html`。生产分支的版本已覆盖这些功能；旧 Nginx 模板还包含被 `check-source` 禁止的 `proxy_set_header Origin`，不要合并。

`main` 现在只保留 HANDOFF/AGENTS/.gitignore 的文档改动（未提交）。`.lidaiji-workspace.json` 已加入 `main` 的 `.gitignore`，不会再显示为未跟踪。

### P2 其他

- 已修复：`auth.js` / `account.js` 不再手动设置浏览器禁止的 `Origin` 请求头。
- 已修复：`?return=/login/` 会被拒绝，不再造成已登录用户重定向循环。
- 已修复：登录页加 `noindex, nofollow`。
- 未修复：`git archive` 生成的源码包不包含 `incoming/README.md`（`.gitattributes` 的 `export-ignore`），在源码包内跑 `check-source.mjs` 会失败；`BUILD_INFO` 的 `reproducibleSiteFromPackage:false` 已承认。
- 未修复：分享站源码不在 p0，重建路径未验证；不要把它当作主站的一部分。

---

## 9. 接手第一天任务清单

按顺序做，不要跳：

1. 读本文；确认不再以 `main` 为生产基线。
2. 确认 p0 工作树包含生产代码提交 `c031efb`、`git status` 干净（§2.2）。
3. 配置环境变量（§6.1），安装依赖。
4. 跑关键检查（§6.2）；如需完整验收再跑 `npm run check`。
5. 生产分支已推送到 `origin/p0/production-features`；后续推送前仍要确认不包含私密文件。
6. 如需再动评论来源，先确认两个正式域名都在 `COMMENTS_PUBLIC_ORIGIN` 白名单，改完分别验证：
   - 两域未登录评论 → 401；
   - 别名域登录后请求能通过来源与身份校验；
   - 未知 Origin → 403；
   - 阅读、登录、登出正常。
7. 任何发布前，先备份 Nginx 与评论库；发布脚本只切 release 和评论服务，不切 Nginx。

---

## 10. 本轮验证记录（2026-10-21）

- 线上 release：`20261021_002445`，`sourceCommit=3105c66`，`snapshot=1ccd8e4c6de96da0`。
- 评论服务：`0.5.1`，manifest 8 篇/3165 段，`:4317` 健康。
- 评论来源：主域 401、别名域 401、未知 Origin 403（均为未登录请求，不写库）。
- 别名域登录后提交不存在的 articleId → 400「这篇文章当前不接受新评论」，证明来源/身份校验通过；未写入评论。
- 登录页：两域均 200，`noindex, nofollow` 已生效；文章页显示「登录评论提交后直接公开」。
- 生产分支评论测试：`npm --prefix comments-service run check` → **104/104 pass**。
- 生产分支契约：`check-source`、`check-login-page`、`check-comment-button`、`check-article-comments` → 通过。
- 生产分支隔离构建：30 个 HTML，2.6M；内容指纹 `90fcdf…`、配置指纹 `8933ac…` 与线上一致。
- Windows 适配清理：删除 `scripts/windows/`、`docs/windows.md`、Windows CI job 与 Windows 打包/发布分支；`check-source` 断言 Windows 文件/文档/CI 不再存在；JS/Python 语法、评论测试、前端契约均通过。
- 生产分支 `c031efb` 已推送到 `origin/p0/production-features`（首次推送 `3105c66`，Windows 清理后再次推送成功）。
- 私仓：`.git` 已恢复，`main=736a76c`，工作区干净。
- `main`：旧登录改动已 `stash@{0}`；仅 HANDOFF/AGENTS/.gitignore 文档改动未提交。

未在本轮重跑完整 `npm run check`（Studio/长文压力/全量构建链）；生产分支的历史记录见
`/Users/haminster/Projects/lidaiji-audit-20261008/lidaiji-p0-cqnb-comment-login-form-20261009.md`，其中记录了 2026-10-09 完整 `./scripts/check.sh` 全部通过。

---

## 11. 关键参考

- 生产发布记录：`/Users/haminster/Projects/lidaiji-audit-20261008/lidaiji-p0-cqnb-comment-login-form-20261009.md`
- P0 合并部署记录：`/Users/haminster/Projects/lidaiji-audit-20261008/lidaiji-p0-ab-merge-and-deploy-20261009.md`
- 发布快照设计：`docs/release-snapshot.md`
- 工作台：`docs/studio.md`
- 评论服务：`docs/comments.md`、`comments-service/README.md`
- 部署：`docs/deployment.md`
- 服务器运维（私有）：`~/server-admin/AGENTS.md`

---

## 12. 禁止事项

- 不要从 `writing-site/main` 发布、合并或覆盖 p0。
- 不要 `git add .`；先逐项检查。
- 不要把 `.lidaiji-workspace.json`、`.author-settings`、`.env`、Cookie、密码、SQLite、Word 原稿、备份提交到仓库。
- 不要改 `articleId`、`articleRevision`、`paragraph-id` 的生成规则。
- 不要批量改写、重排或创作文章正文。
- 不要直接覆盖生产 Nginx 配置；不要丢失双域名结构和证书。
- 不要重启游戏、骰娘、澄清南北主服务；发布只重启 `lidaiji-comments`。
- 不要把生产评论库下载到 Studio；不要把私仓内容复制进公开平台仓库。
- 不要在未确认用户意图时改变“阅读公开、评论需登录、登录评论直接公开”的口径。
