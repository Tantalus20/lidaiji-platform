# 逐篇浏览统计 V1 — 生产部署轮报告（2026-08-14）

## Git

```text
分支:    prod/view-stats-works-v1（基于 origin/main，与 QZone/V0.3 完全隔离）
提交:    eb26ef4  stats V1 works 生产候选（main 基）
         788142d  备份测试：stats.sqlite3 自动纳入自然备份链
         e7c5a0b  nginx 模板：/api/stats/ 路由
开始 HEAD: e11daef（origin/main）→ 生产部署 20260814_015435
```

## 分支污染核查与拆分

```text
origin/main..HEAD 全量核对：stats 提交依赖的 Share 系统（studio/share.py、
share_publisher、share-site、build-share.sh）均不在 main → 按任务书拆分：
  - 生产：works stats（comments 模块 + 正式站 UI + Studio 作品列表 + 备份）
  - 保留：stats 后端 share namespace 能力（无 SHARE_MANIFEST → fail-closed 404）
  - 延期：Share 统计 UI/身份清单 —— 随 Share 系统后续部署轮
生产确认：Share 未上线（无 /opt/lidaiji-share、无 share 站点路由）→ 本轮不提前部署 Share/QZone ✓
```

## 生产基线（部署前记录）

```text
site current:      /opt/writing-site/releases/20260806_001057（0.4.3，sourceCommit 254cde1）
comments current:  /opt/lidaiji-comments/releases/20260806_001057（0.5.1）
comments 服务:     MainPID=1754147 · NRestarts=0 · ActiveState=active
comments DB:       SHA 067f0f5a…（6,287,360 B + WAL）
stats DB:          不存在（初始状态）✓
nginx:             writing-site.conf SHA fdc1b64f… · nginx -t 通过
COS daily:         1 个对象（前一日归档）
Share:             未部署
```

## Nginx 路由（生产变更，已备份可回滚）

```text
变更:  writing-site.conf 增加 location /api/stats/ → 127.0.0.1:4317
      （X-Real-IP 由 nginx 设为本机真实客户端地址；no-store；X-Robots-Tag）
备份:  /var/backups/writing-site/writing-site.conf.pre-stats-20260814_015358
部署后: SHA baf6ab0c… · nginx -t 成功 · reload 完成
模板:  deploy/nginx/comments-locations.conf.template 同步更新（e7c5a0b）
限流语义: 服务仅监听 127.0.0.1；仅回环连接信任 X-Real-IP（外部直连无法伪造）；
        测试验证不同 X-Real-IP 独立分桶、非回环直连伪造被忽略（17/17）。
```

## 发布

```text
流程:  scripts/publish.sh（本地 build+备份+打包 → server-publish.sh 原子发布，
       含 --verify-cos-backup：发布前完整异地备份 + COS 远端校验）
release:  site/comments 同步切换 → 20260814_015435（previous 20260806_001057）
comments: 0.5.1 新 release，stats 迁移自动执行（schema_migrations=1），
         MainPID=1213023 · NRestarts=0 · ActiveState=active
manifest: 站点 release 的 comment-manifest.json 与 comments 服务在同一原子窗口
         同步（server-publish 内建 sync-manifest）→ 无「网页已 POST、后端 404」窗口
```

## 首次启用统计起点

```text
浏览统计开始时间: 2026-08-14T01:55:00+08:00（已记录 /var/lib/lidaiji-comments/stats-enabled.notes）
历史浏览量: 不回填（全部文章从 0 开始）
```

## 生产验收（真实公开文章：暴君困境 article-3ced25ad46dcf039）

```text
部署前（初始）:  GET = 0
bot UA POST:     仍 0（Googlebot/curl 不计）
真实浏览器首次:  浏览 1 ✓
同浏览器刷新:    浏览 1（30 分钟 localStorage 去重，仅 GET）✓
隔离浏览器:      浏览 2 ✓
GET（最终）:     2，不增加 ✓
bot POST（最终）: 2，不增加 ✓
批量接口:        /api/stats/views?namespace=works 单请求返回全量（Studio 无 N+1）✓
页面:            data-article-id / view-stats.min.js / 浏览 span 均在 release 中 ✓
paragraph-id:    标记完整（p-a17a2661e877 等）✓ · 评论区域正常 ✓
```

## 上线后自然备份（远端验证）

```text
备份:  VM-0-3-opencloudos-20260814-015626.tar.gz（COS daily/2026/08/，5.73MB，
       本地生成+解压复验+远端校验全通过，backupId 状态 BACKUP_COMPLETE）
归档含: comments.sqlite3（schemaMigrations 1,2,3）
        stats.sqlite3（schemaMigrations 1，SHA c8a751cb…）
        site/comments release 快照 + backup-manifest.json（schemaVersion 2）
stats 恢复抽查: 解压 stats.sqlite3 → content_views 行（article-3ced25ad46dcf039=2）完整 ✓
```

## 最终验收清单

```text
正式作品正文正常          ✓（生产浏览器访问）
paragraph-id 正常         ✓
评论正常                  ✓（页面评论区域 + 4317 服务健康）
阅读位置正常              ✓（未触碰既有阅读记录存储）
浏览次数正常              ✓（0→1→1→2，GET/bot 不增）
comments DB 未意外变化    仅部署轮 sync-manifest 的预期同步（SHA 067f0f5a→8327db91，无异常）
QZone 网络调用 = 0        ✓（生产无 napcat/share_publisher/qzone 进程）
QQ 发帖 = 0               ✓
Share/QZone 未额外部署     ✓（无 share 路径/路由）
```

## 回滚设计（分别可撤，stats.sqlite3 永不删除）

```text
页面统计 JS:      server-rollback.sh /opt/writing-site/releases/20260806_001057（原子切回旧 release）
stats API:        server-rollback.sh（comments release 切回 20260806_001057）
Nginx 路由:       cp /var/backups/writing-site/writing-site.conf.pre-stats-* → nginx -t → reload
生产数据:          stats.sqlite3 是真实浏览数据，任何回滚都不删除；新 release 再次部署后继续累计
```

## 遗留说明

```text
1) 备份 manifest 中 fkViolations=1（comments 与 stats 均为既有 non-blocking 记录，
   非 stats 引入；comments DB 在统计上线前即如此）
2) Share 统计（share-identity-manifest + Share 页 UI + share ns 启用）随 Share 系统
   后续部署轮完成；当前生产 share 命名空间 fail-closed（404）
3) 统计起点与首个自然备份已落盘；后续每日备份自动包含 stats 数据
```

## 结论

**A 级达标**：分支隔离完成（works stats 独立于 QZone/V0.3 上线）、限流身份生产语义
正确、stats 进入既有自然备份链（远端验证 + 恢复抽查）、原子一致性窗口部署、
生产验收全序列通过、回滚可分别撤除且保留生产数据。
