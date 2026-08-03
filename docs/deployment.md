# 部署

先在干净 Git 状态运行 `npm run check` 和 `npm run build`，再生成带 SHA-256 与清单的发布包。
Nginx 与 systemd 示例位于 `deploy/`，其中 `example.com`、`/path/to/...`、
`YOUR_VALUE_HERE` 必须在服务器安全配置中替换。Studio 不部署到公网。

静态站应以新时间戳目录解压，验证后原子切换 `current` 软链接；评论服务只监听回环地址。
不要把 `.env`、SQLite、Cookie、私人内容或对象存储凭据放进源码发布包。

《历代纪》支持多种部署组合。推荐路线是“Windows/macOS 作者电脑 + Linux 服务器”。

## 方案一：Windows 作者电脑 + Linux 服务器（推荐）

Windows 作者负责写作、编辑、构建与上传；Linux 服务器负责公开网站、评论服务、
HTTPS 与长期在线。不需要 Mac。

工具：Windows Terminal、PowerShell、VS Code、WinSCP/OpenSSH `scp`。

1. 在 Windows 项目目录完成写作与检查：

   ```powershell
   npm run check
   npm run build
   ```

2. 生成标准发布包（静态站包 + 源码包 + SHA-256）：

   ```powershell
   npm run package
   ```

   产物位于 `dist\releases\<时间戳>\`。

3. 上传发布包到 Linux 服务器（scp / WinSCP / 服务器控制台）。

4. 在服务器按既有流程执行部署脚本：静态站解压到新时间戳目录、校验、原子切换
   `current` 软链接；评论服务按需要单独发布。具体命令以 `scripts/publish.sh`、
   `scripts/server-publish.sh` 与运维文档为准。

## 方案二：macOS 作者电脑 + Linux 服务器

与方案一相同，只是作者端使用 macOS。`npm run package` 生成发布包后，
`npm run publish`（配置 `WRITING_SSH_TARGET` 与 `WRITING_DOMAIN`）可完成
构建、上传、服务器校验与原子切换的完整自动发布。

## 方案三：Linux 本机与服务器

在 Linux 本机直接使用 `npm run studio`、`npm run build`；发布与方案二相同。
服务器端 Nginx 静态托管 `/opt/writing-site/current`，评论服务以 systemd 运行。

## 方案四：Windows Server 完整部署（实验性）

可以使用 Windows Server + Node.js + SQLite + Caddy/IIS + 任务计划程序部署完整站点，
但以下项目尚未在真实 Windows Server 完成全套验证，因此该路线标记为**实验性 /
社区验证中**，请不要声称已生产验证：

- HTTPS 证书与自动续期
- 服务自动启动与崩溃恢复
- SQLite 文件权限与并发
- 评论服务恢复与升级
- 静态文件服务性能
- 备份、升级、回滚
- 防火墙与日志轮转

生产公网部署请优先使用方案一或方案三（Linux 服务器）。
