# 《历代纪》正式站 + 长文分享站逐篇浏览统计 V1 实施报告（2026-08-13）

## Git

```text
分支:      feat/share-qzone-long-images-v03
开始 HEAD: c82d2e6（tool(capture) qzone web 脚本）
结束 HEAD: 3d93929（feat(stats): per-article view stats V0.1）
基线清理:  78597a5（上一轮 qzone --diag 未提交改动，已单独提交）
```

## 修改文件

```text
新增:
  comments-service/migrations-stats/001-content-views.sql   统计库 schema（独立迁移）
  comments-service/src/stats.js                             统计模块（stats V0.1）
  comments-service/test/test-stats.test.js                  15 项统计测试
  themes/lidaiji/assets/js/view-stats.js                    正式站统计客户端
  share-site/assets/js/view-stats.js                        Share 统计客户端
  scripts/build-share-identity-manifest.py                 share 身份清单生成
  scripts/smoke-view-stats.mjs                              Chrome 验收
  scripts/smoke-view-stats-safari.mjs                       Safari 验收

修改:
  comments-service/src/app.js      路由（POST/GET/批量）+ bot 过滤 + 内存限流
  comments-service/src/server.js   打开 stats 库 + 加载 share 身份清单（草稿剔除）
  comments-service/src/config.js   statsDatabase / SHARE_MANIFEST / STATS_RATE_PER_MINUTE
  themes/lidaiji/...single.html    <article data-article-id> + byline「浏览 <span>—</span> 次」
  themes/lidaiji/...head.html      view-stats.js（minify+fingerprint+defer）
  share-site/...single.html        <article data-share-id> + byline 同款
  share-site/...head.html          view-stats.js
  studio/server.py                 GET /api/stats/views 只读代理（LIDAIJI_STATS_BASE）
  studio/app/home.mjs              作品列表「浏览 N」
  studio/app/share.mjs             Share 列表「浏览 N」
  studio/app/state.mjs             viewCounts 状态
  studio/static/app-bundle.js      重建前端包
  scripts/build-share.sh           构建后产出 share-identity-manifest.json(+sha256)
```

## 统计服务架构

```text
复用 comments service 进程（Node ≥22.12 + node:sqlite，无新常驻进程）。
理由：生产 2G 内存，comments 常驻 ≤160M；同进程增加一个只读统计模块即可；
      独立 stats.sqlite3（同 dataDir）→ 锁/事务与评论库完全隔离，互不影响；
      备份（backup-to-cos.sh 归档整个 COMMENTS_ROOT）自动覆盖统计库；
      无需新 systemd / 新端口 / 新 Nginx server。
隔离：comments 代码零改动；stats handler 自带 try/catch；统计失败不影响评论/正文。
```

## DB schema

```sql
-- stats.sqlite3（独立文件；迁移 migrations-stats/001-content-views.sql）
CREATE TABLE content_views (
  namespace  TEXT NOT NULL,          -- works | share
  content_id TEXT NOT NULL,          -- articleId | shareId
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, content_id)
);
-- WAL · busy_timeout=5000 · synchronous=FULL（与评论库一致）
```

## 身份

```text
works:  frontmatter articleId（article-<16hex>，创建时生成、永久稳定）——
        服务端校验源 = dist/site/comment-manifest.json（构建时草稿剔除，已核对与
        全站 8 篇 data-article-id 一一对应，无缺口）
share:  shareId（sh-YYYYMMDD-<6hex>，目录名即身份）——
        服务端校验源 = 新 share-identity-manifest.json（build-share.sh 产出，
        含 draft 标记；服务端加载时剔除草稿 → 草稿 404 不计数）
不得用标题/正文 hash/shareRevision/URL 作统计身份 ✓（任务书四）
```

## API

```text
POST /api/stats/views/<namespace>/<content_id>   有效浏览 +1（原子 UPSERT），返回最新数
GET  /api/stats/views/<namespace>/<content_id>   只读当前数（不 +1）
GET  /api/stats/views?namespace=works|share       批量 {items:{id:count}}（Studio 只读用）
404 = 内容不存在/未公开/非法 namespace/路径穿越（fail-closed，不建行）
429 = 单 IP 超过 STATS_RATE_PER_MINUTE（默认 120/分钟，内存滑动窗口，不落库）
所有响应 Cache-Control: no-store
```

## 原子并发测试

```text
UPSERT view_count+1（RETURNING），无 read→+1→write 竞态；
测试：100 并发 POST → 精确 +100（test-stats 第 7 项）；200 顺序 POST → +200（性能脚本）。
```

## Bot 过滤

```text
服务端 UA 瞬时判断（不落库）：googlebot/bingbot/baiduspider/duckduckbot、
bot/crawler/spider/preview/scanner、curl/wget、headless/selenium/puppeteer/
playwright、monitor/uptime/healthcheck/lighthouse、空 UA → 不计数（返回当前数）。
QQ 内置浏览器 UA（QQ/8.9.28 CFNetwork…）按真实读者计数（QQ 读者主入口，无法也不应
与链接预览区分——预览场景由「可见 + 1500ms 延迟」缓解）。Chrome 冒烟验证：headless
默认 UA 不计、真实 Chrome/Safari UA 计。
```

## 30 分钟浏览器去重

```text
localStorage 键（独立 namespace，不碰阅读位置/主题/字号）：
  lidaiji:views:works:<articleId>     /     lidaiji-share:views:<shareId>
值 = {lastCountedAt}；30 分钟内再次访问只 GET 当前数，不 POST。
流程：DOMContentLoaded → visibilityState==visible → 延迟 1500ms（常量）→ 去重判断 →
POST（或 GET）→ 渲染「浏览 N 次」。
```

## 正式站 UI

```text
byline：… · 浏览 <span data-view-count>—</span> 次（与日期/字数同区）
<article data-article-id>；view-stats.min.js 1.2KB（defer+fingerprint）
统计失败：显示「—」，不弹错、不阻塞正文/目录/评论/阅读位置
```

## Share UI

```text
与正式站同款；<article data-share-id>；不引入任何 comments JS/comment-manifest/
paragraph-id/articleId（回归验证：share 页无 comments 资源）
```

## Studio UI

```text
只读：作品列表卡片与 Share 列表行显示「浏览 N」（批量接口一次取全，不发逐篇请求）
无任何修改/重置/编辑接口
```

## 自动测试

```text
comments-service 全量：109/109（其中新增 stats 15 项：
  身份 6（合法 works/share/不存在 404/草稿 404/非法 ns/穿越）、
  计数 3（0→1→2、100 并发 +100、GET 不增）、
  双命名空间不串数、批量、bot 过滤（Chrome/Safari/QQ 计；Googlebot/curl/headless/空 不计）、
  限流 429、stats 库故障隔离、no-store/无 IP/UA）
npm run check：exit 0（含压力测试、敏感扫描、前端契约）
Chrome 验收：16/16（正式站 +1/刷新去重、Share +1/刷新去重、headless 不计、500 隔离、
  服务端核对、Googlebot 不计）→ scripts/smoke-view-stats.mjs
Safari 验收：11/11（真实 Safari：两站显示/一次 +1/刷新不重复/统计停用后正文可读且显示 —）
  → scripts/smoke-view-stats-safari.mjs
```

## 性能

```text
view-stats.min.js：1.2KB（正式站）/ 1.2KB（Share），异步 defer 不阻塞首屏
POST（本机回环，含 HTTP）：avg 1.7ms，p95 2.2ms
GET：avg 1.4ms，p95 1.7ms
无第三方 analytics（禁止项未引入）
```

## 失败隔离

```text
stats 库关闭 → 统计 API 500，评论接口与正文不受影响（测试验证）；
浏览器端 fetch 失败/500 → 保持「浏览 —」，无异常、正文完整（Chrome+Safari 双验证）。
```

## 备份接入设计（本轮未改生产）

```text
stats.sqlite3 位于 COMMENTS_ROOT（/var/lib/lidaiji-comments），backup-to-cos.sh
（v0.5.3，schemaVersion 2 清单）归档整个 COMMENTS_ROOT → 统计库自动进入备份；
部署轮需：备份脚本运行一次后核对 manifest 含 stats.sqlite3 的 SHA；恢复演练轮验证
恢复后统计仍在。生产备份未修改（候选阶段）。
```

## 敏感扫描

```text
git 已跟踪内容扫描：无 .env、无 sqlite/pem/key、无真实 Cookie/密钥；唯一 QQ 号
为 docs 中既有「测试号 2369520446」（历史文档，非本轮新增）；测试夹具全部虚构。
新增代码零敏感数据。
```

## 生产部署计划（本轮不执行）

```text
1) 备份：生产前先跑一次 backup-to-cos.sh，记录部署前 DB SHA
2) 代码：comments-service 更新 → 启动自动建 stats.sqlite3（schema_migrations 1）
3) 环境：新增 SHARE_MANIFEST=/opt/lidaiji-share/dist/share-identity-manifest.json
   （build-share.sh 已产出）；可调 STATS_RATE_PER_MINUTE
4) Nginx：writing-site.conf.template 增加
   location /api/stats/ { proxy_pass http://127.0.0.1:4317; }（与 comments 同 server）
5) 站点：build.sh 重建正式站（含 view-stats.js + data-article-id + byline）
   build-share.sh 重建 Share 站（含 share-identity-manifest.json）
6) 回滚：网页 JS/模板可整体回退到上一 release（当前原子切换机制）；
   schema 回滚：删除 stats.sqlite3 即回到无统计（统计失败不影响正文，无需回滚正文）
7) 公网验收：GET/POST/批量三接口 + 两站页面 + Safari 抽查
8) 统计起点：上线后才开始累计（V1 不回填历史）
```

## 逐项状态清单

```text
正式作品浏览统计：完成
Share 浏览统计：完成
逐篇统计：完成（works:<articleId> / share:<shareId>）
Studio 查询：完成（只读批量）
保存 IP：未执行（限流仅内存瞬时）
保存 QQ 身份：未执行
第三方 analytics：未引入
真实文章修改：未执行（仅模板/JS 新增）
生产数据库修改：未执行（本轮仅候选代码与本地验收）
生产部署：未执行（仅输出部署计划）
QQ 真实发送：未执行
```

## 结论等级

**B 级**：功能完成、并发准确、bot 有效、隔离通过、Chrome/Safari 双验收、
109/109 测试全绿、隐私边界与备份方案明确——但生产部署/公网验收尚未执行，
且统计起点（部署日期）未落库。按任务书不得部署，等待部署轮评审。
