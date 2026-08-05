# 更新日志

## Studio v0.2.4（2026-08-06，大规模段落失效门禁放行链路）

- 修复《考试机器》发布失败根因：v0.5.1 大规模段落失效门禁（一次将超过 100 个或
  现有 current 20% 转为 historical 时默认拒绝）在服务器端拦截并回滚；此前预览的
  锚点预演在无发布账本记录的文章上回退为“文件自身对比”（deleted=0），门禁检查形同虚设；
- 预演基准改为线上 comment-manifest 段落集：无账本记录的文章也能真实对比
  （《考试机器》实测转历史 335 与服务器端 sync-manifest 报告完全一致）；
- 仅门禁 FAIL 时预览放行为 gate-only：仍签发快照与预览标识、允许进入确认对话框，
  其余检查 FAIL 仍拒绝发布；
- 确认对话框新增红色警告与“我确认这是一次有意的段落结构调整”勾选；
  未勾选发布即被拒绝（confirmation-required）；
- 放行标志完整传递到服务器端：publish.sh 透传 --allow-large-retire，
  server-publish.sh 在 sync-manifest 前 export COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE=1
  （runuser --preserve-environment 仅保留 exported 变量）；
- 前端 api() 不再把 gate-only 预览误判为错误（新增 apiRaw 通道）；
- 发布失败结果附带输出尾部，便于查看服务器日志；
- 新增门禁回归测试（ISO-GATE-*）与发布脚本标志传递链测试。

## Studio v0.2.3（2026-08-05，文章级隔离发布）

- 发布模型从“整个私人仓库必须干净”改为“已发布基线 + 目标文章快照 = 隔离候选”；
- 线上基线解析：生产 comment-manifest 与私人仓库 HEAD 树逐篇校验（8/8 一致），
  不一致时 fail-closed，不使用脏工作区；
- 隔离内容仓库：git archive HEAD 树 + 目标文章快照覆盖（revision/SHA 校验、
  引用资源清单 assetManifest、未引用资源不纳入、符号链接/路径穿越拒绝）；
- 无关文章未提交修改：允许存在、展示数量、绝不进入候选（任务十六升级）；
  平台代码/发布工具/Hugo 配置脏时仍阻止发布；
- 候选差异校验：构建后无关文章 manifest 与线上逐篇一致，否则 FAIL；
- 快照不可变：预览与发布共用 snapshotId，文件/资源变化立即拒绝；
- 确认对话框明确“仅发布此文章”；预览展示基线/无关脏文件/无关差异数量；
- 新增 19 项隔离发布测试（ISO-*）。

## Studio v0.2.2（2026-08-05，文章发布闭环）

- 编辑页新增固定发布操作区：保存草稿 / 预览发布版本 / 确认发布；
- 草稿状态面板：草稿/已发布/已发布但存在未发布修改、最后保存时间、
  未保存修改提示、预览是否最新、线上版本与发布历史；
- 发布预览：front matter/slug/正文校验、锚点迁移预演（保持/新增/转历史）、
  受影响段评统计（经本地网关只读查询）、Hugo 构建验证；
- 确认发布：自定义对话框（标题/网址/线上与草稿时间/段落摘要），非原生 confirm；
  异步发布+阶段轮询（校验/构建/备份/上传/切换/验证）、全局发布锁、
  幂等键、revision 与预览标识校验、账本发布历史（.cache/studio/publish-history.json）；
- 发布成功后显示正式网址/release/版本并可复制；失败区分阶段；
- 陈旧发布锁自动标记需人工核验；刷新后可恢复状态；
- 草稿保存不自动提交 Git（沿用工作树内容源策略）；新增 13 项发布闭环测试。

## Studio v0.2.1（2026-08-05，本地免登录）

- 新增 local-bootstrap 认证模式（默认）：启动即授权，无账号密码登录框；
  `npm run studio:setup` 一次性写入凭据（macOS Keychain / 600 文件），
  凭据不进浏览器、不进日志；
- 本地网关服务端自动登录上游评论服务；上游会话过期自动重建（仅认证失败路径重试）；
- 新增进程绑定 X-Studio-CSRF 令牌与同源端口 Origin 校验；本地会话 HttpOnly /
  SameSite=Strict / Max-Age 8 小时 / 进程退出失效；
- 新增“锁定工作台”（撤销本地+上游会话）与重新授权；
- 修复 SSH 隧道生命周期：ssh 不再 -f 后台化，隧道随工作台停止/退出可靠关闭；
- password 模式保留原登录流程；新增 37 项认证测试（LOOP/AUTH/CSRF/UP/ADMIN）。

## Platform v0.2.1（2026-08-05，生产修复 v0.5.1）

- 评论服务 v0.5.1：段落同步引入 `paragraphsMode`（omitted/authoritative）语义，
  未提供或非权威空数组不再清空段落；新增大规模失效门禁
  （>100 或 >20% current 段落转 historical 时默认拒绝）；
  新增受控段落恢复工具 `comments-service/src/repair-paragraphs.js`。
- 评论服务 v0.5.1：章评 Bot 端点 fail-closed——token 未配置时 503，
  缺失/空/错误 Bearer 一律 401；`constantTimeEqual` 不再把空值视为认证成功。
- 站点品牌修复：工作区覆盖合并进 Hugo 真实读取的 `hugo.toml`/`params.toml`
  （原 `zz-workspace.toml` 被 Hugo 静默忽略）；构建断言防演示品牌残留。
- 版本单一来源：移除 check-source 硬编码 0.4.1；healthz 报告 package.json 版本。
- 备份体系：发布快照改为白名单归档+SHA 清单；COS 上传远端校验；
  备份失败标记 + 监控 `CHECK_BACKUP` 邮件告警。
- 部署门禁：候选 preflight（符号链接/敏感文件/BUILD_INFO/sourceCommit/
  端口唯一/无 root 实例）；发布后同步权威 manifest；`/source/` 不再公开。
- 组件版本：site v0.4.3、comments v0.5.1、studio v0.2.0。

## Platform v0.2.0

- 新增 Windows 原生作者工作台流程（PowerShell 启动/停止/状态/重启/打开脚本）。
- 新增 Windows 桌面快捷方式（scripts/windows/create-shortcut.ps1）。
- 新增任务计划程序登录自动启动（install/uninstall-startup-task.ps1）。
- 核心 npm 脚本跨平台化：npm run studio / check / build / dev / package / publish /
  comments:init / comments:create-admin 现在都是 Node 跨平台入口；
  macOS/Linux 行为不变，Windows 使用原生 PowerShell 与 Node 流程（无需 WSL）。
- 新增跨平台发布包生成（npm run package：静态站包 + 源码包 + SHA-256）。
- 新增 Windows CI（GitHub Actions windows-latest：核心检查、Hugo 构建、
  Python 测试、PowerShell 语法、中文+空格路径、Studio 后台启动冒烟）。
- 新增 Linux CI（ubuntu-latest：核心检查、构建、部署脚本语法）。
- 新增 docs/windows.md 与部署方案分层（Windows 作者机 + Linux 服务器为推荐路线；
  Windows Server 完整部署标记为实验性）。
- README 平台支持表与“不需要 Mac”表述更新。
- 组件版本：studio v0.2.0；site v0.4.2、comments v0.4.0 不变。

## Site v0.4.2


- 新增文章段落左/中/右对齐（`{{< align left|center|right >}}`，未知参数安全降级为左对齐）。
- 新增诗歌块（`{{< poetry >}}`：整体居中、诗句内部左对齐、行距略紧）。
- 新增尾注块（`{{< endnote >}}`：右对齐、字号约 0.92em、上方留白）。
- 支持块内加粗与斜体（继续走标准 Markdown 语义）。
- 支持 DOCX 居中与右对齐段落导入映射。
- 本版本未修改任何真实文章内容。

## Platform v0.1.0


- 将平台代码与私人内容拆分为两个独立 Git 仓库。
- 提供完全虚构的 demo 内容、作者评与插图。
- 增加统一工作区配置，支持 Studio、Word 导入、Hugo 构建和内容 Git 操作。
- 保留 site v0.4.1、comments v0.4.0、studio v0.1.1 的组件版本。
- 增加评论数据库从零初始化、公开部署模板、隐私检查和 CI。

## Comments v0.4.1

- 修复作者工作台经 SSH 隧道登录管理接口返回 403：管理端点接受"无 Origin
  且无 Referer 且连接来源为回环地址"的请求（SSH 隧道 / CLI / curl）；
  带 Origin 的请求仍必须等于公开来源；错误 Origin 即使来自回环也拒绝。
- 管理登录/登出 Cookie 的 `Secure` 属性按实际传输条件决定：经 HTTPS
  （X-Forwarded-Proto 或 https Origin）才设置，HTTP 回环隧道不设置，
  使浏览器能保存隧道会话 Cookie；`HttpOnly`、`SameSite=Strict`、Path
  与登出清理语义不变。
- 作者工作台（studio）登录不再伪造本地 Origin。
- 公开评论提交接口的来源检查保持严格，不受本轮修改影响。
- 本次不修改数据库结构，无迁移。
