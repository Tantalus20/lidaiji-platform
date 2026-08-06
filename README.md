# Lidaiji Platform

一套为中文长篇写作设计的轻量出版平台。它把作者熟悉的 Word 与 Markdown 写作流程、
适合长文阅读的 Hugo 网站、段落级评论、本地作者工作台，以及可回滚的服务器发布流程
组合在一起。

公开仓库只包含平台代码和完全虚构的演示作品；真实文章、图片、作者评与私人配置放在
独立的私有内容仓库中。

> **不需要 Mac。** 《历代纪》的核心平台可以在 Windows、macOS 和 Linux 上运行。
> Windows 用户可以在本机导入 DOCX、使用作者工作台编辑作品、预览和构建网站，
> 并把发布包部署到自己的服务器。macOS 专用的一键应用只是可选便利功能，
> 不是使用前提。

> 平台发行版：**v0.2.1**
>
> 组件版本：site v0.4.3 · comments v0.5.1 · studio v0.2.6

## 平台支持

| 功能 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 作者工作台（Studio） | 支持 | 支持 | 支持 |
| DOCX 导入 | 支持 | 支持 | 支持 |
| Hugo 构建 | 支持 | 支持 | 支持 |
| 评论服务（本机） | 支持 | 支持 | 支持 |
| 桌面一键启动 | PowerShell 快捷方式 | `.app` | 脚本或桌面入口 |
| 登录自动启动 | 任务计划程序 | LaunchAgent | systemd 用户服务或桌面自启 |
| 完整服务器部署 | 实验性（Windows Server） | 不推荐 | 推荐 |

结构上是“跨平台核心 + 各系统可选启动工具”，而不是三套互相复制的核心逻辑：
Windows 使用 PowerShell 脚本（`scripts/windows/`），macOS 使用
LaunchAgent 与 `.app`（`scripts/macos/`），Linux 使用既有脚本；
通用 npm 命令（`npm run studio` / `npm run check` / `npm run build` /
`npm run dev` / `npm run package`）在三个平台均可用。

- Windows 用户指南：[docs/windows.md](docs/windows.md)
- WSL 是可选的开发方式，不是 Windows 支持的前提；原生 PowerShell 与 Node.js 流程即可完成全部工作。


## 适合谁

- 想长期维护个人文集、回忆录、连载或研究随笔的作者；
- 希望继续使用 Word 写作，但需要稳定网页出版流程的人；
- 需要“文章归 Git、评论归 SQLite”，不想部署大型 CMS 的个人站长；
- 想参考 Hugo、Node.js、SQLite 与本地作者工具如何协作的开发者。

它不是通用社区平台，也不打算替代 Word。它关注的是一件事：让作者安全地把长篇作品
整理、预览、发布、接受评论，并长期备份和维护。

## 可以展示什么

| 模块 | 已有能力 |
| --- | --- |
| 中文长文阅读站 | 作品集与章节、目录、阅读进度、字号记忆、深色模式、上下篇、搜索、时间线和响应式图片 |
| 段评与章评 | 游客可针对具体段落或整篇文章评论；支持人工审核、软删除和审核记录 |
| 作者评 | 作者可添加段落评与章评；草稿不会进入构建产物，已发布内容兼容严格 CSP |
| 本地作者 Studio | 仅监听回环地址；提供文章列表、Markdown 编辑、媒体管理、作者评、预览、Git 差异和发布检查 |
| Word 导入 | 采用 parse → plan → commit 三阶段流程，写入前预览变更并检查冲突 |
| 稳定内容标识 | 文章使用稳定 `articleId`，正文段落使用稳定锚点，标题和网址调整不必切断评论关联 |
| 公私双仓库 | 平台代码可以公开复用，真实作品保留在私人仓库；没有私人仓库时自动运行虚构演示内容 |
| 发布与运维 | 提供 Nginx、systemd、时间戳 release、回滚、SQLite 备份与异地备份模板 |
| 安全与测试 | Host 与本地会话防护、CSRF、Origin 校验、构建泄露检查、数据库迁移测试和持续集成 |

## 两种运行模式

### 演示模式

直接克隆本仓库，不创建任何私人配置。网站、Studio 和测试会使用 `examples/` 中的虚构
作品《云上邮局》，可以安全体验完整流程。

### 私人作者模式

把真实作品放在相邻的私人内容仓库，再复制 `.lidaiji-workspace.example.json` 为
`.lidaiji-workspace.json`。Studio、Word 导入器、Git 操作和构建工具会统一指向私人仓库，
不会把文章混入公开平台代码。

配置优先级：命令行参数 → 环境变量 → 本地工作区配置 → 内置演示内容。

## 系统组成

```text
Word ──→ 三阶段导入器 ──→ Markdown / Page Bundle
                              │
                              ├──→ 本地作者 Studio
                              │
                              └──→ Hugo 构建 ──→ 静态阅读站

游客评论 ──→ Node.js 评论服务 ──→ SQLite ──→ 人工审核 ──→ 前台显示

私人内容仓库 ──→ 临时构建工作区 ←── 公开平台仓库
```

平台代码是唯一代码来源，私人仓库是作品的唯一来源。构建过程不会要求把私人文章复制并
提交到公开仓库。

## 快速体验

环境要求：Node.js 22+、Python 3、Hugo Extended。

```bash
python3 -m venv .venv-importer
.venv-importer/bin/pip install -r importer/requirements.txt
npm --prefix comments-service install
npm run build
npm run studio
```

未配置私人工作区时，上述命令自动使用虚构演示内容。Studio 仅监听本机回环地址。

常用命令：

```bash
npm run studio                 # 启动本地作者工作台
./scripts/import-docx.sh       # Word parse/plan/commit 导入
npm run build                  # 构建 Hugo 网站
npm run comments:init          # 创建本地 SQLite 并执行迁移
npm run comments:create-admin  # 创建本地评论管理员
npm run dev                    # 启动本地网站与评论服务
npm run check                  # 执行完整检查
```

## macOS 作者工作台

在 Mac 上，可以把 Studio 变成类似普通应用的体验：登录后后台自动运行，不需要保留终端窗口。
整套方案只使用 macOS 自带的 `launchd` 与 `osacompile`，不依赖 Electron、Tauri 或 PM2。

首次安装（在平台项目目录执行一次）：

```bash
npm run studio:install
```

安装脚本会：

- 在本机生成 LaunchAgent（`~/Library/LaunchAgents/cn.lidaiji.studio.plist`）与运行配置
  （`~/Library/Application Support/LidaijiStudio/install.json`），这些文件都在仓库之外；
- 生成“历代纪作者工作台.app”到 `~/Applications/`；
- 立即启动后台服务，只监听 `127.0.0.1:4173`，不开放公网或局域网访问；
- 登录后自动运行；仅在异常退出时自动重启，正常停止后不会被立刻拉起。

平时打开：

```text
双击“历代纪作者工作台.app”（可拖入 Dock），浏览器会自动打开 http://127.0.0.1:4173/
```

常用命令：

```bash
npm run studio:status     # 查看运行状态
npm run studio:restart    # 重新启动
npm run studio:stop       # 停止（不卸载自动启动）
npm run studio:uninstall  # 卸载自动启动（不删除文章、仓库、数据库）
```

注意事项：

- `.app` 只是一个安全启动器：唤醒本机 Studio 并打开浏览器，它不是另一套网站；
- Studio 只监听本机回环地址，LaunchAgent 不上传任何数据；
- 日志位于 `~/Library/Logs/LidaijiStudio/`（单文件超过 10MB 自动轮转，保留最近 3 份）；
- 项目目录移动、Node/Python 路径变化、Mac 系统更新或升级 Node 后，重新执行一次
  `npm run studio:install` 即可刷新配置；
- 本机生成的文件（plist、install.json、日志、应用）全部位于仓库之外，不会进入公开仓库；
- 这些脚本只面向 macOS；Windows 和 Linux 不使用 LaunchAgent 与 `osacompile`。

## 内容与隐私边界

- 本仓库不应出现真实文章、真实图片、生产数据库、Cookie、密钥或生产 `.env`；
- `.lidaiji-workspace.json` 只保存在本机，并已被 Git 忽略；
- 演示内容使用虚构人物、事件和图片，不截取私人作品；
- Studio 默认只操作内容仓库，避免把平台代码和文章混入同一次提交；
- 原始作者评 YAML、草稿作者评和私人配置不会进入网站产物。

## 文档

- [快速开始](docs/quick-start.md)
- [私人内容仓库](docs/content-repository.md)
- [Studio 作者工作台](docs/studio.md)
- [评论服务](docs/comments.md)
- [部署](docs/deployment.md)
- [备份与恢复](docs/backup-and-restore.md)
- [升级](docs/upgrading.md)
- [安全说明](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)

部署模板位于 `deploy/`。生产参数必须通过服务器安全配置注入，不能提交到 Git。发布前应
备份 Markdown、作者评和 SQLite，并使用时间戳 release 与原子软链接切换保留回滚路径。

## 授权

平台代码采用 [0BSD](LICENSE)；`examples/` 中的虚构演示内容采用
[CC0](CONTENT-LICENSE.md)。私人作品不随本项目授权。
