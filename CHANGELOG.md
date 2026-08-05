# 更新日志

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
