# 《历代纪》Windows 作者端

本文面向完全没有 Mac 的 Windows 用户。你可以只使用 Windows 电脑完成安装、写作、
DOCX 导入、编辑、预览、构建、评论与发布包生成。macOS 专用的一键应用只是可选便利
功能，不是使用前提。

## 1. 适用场景

Windows 用户可以完成：

- 写作与文章管理（所见即所得编辑器：加粗、斜体、左/中/右对齐、诗歌块、尾注块）
- DOCX 导入（Word 稿件 → 网站草稿）
- 本地预览与 Hugo 构建
- 本机运行评论服务（段评/章评审核）
- 生成标准发布包，并部署到自己的服务器

## 2. 环境要求

| 软件 | 说明 |
| --- | --- |
| Windows 10 或 11 | 原生 PowerShell 流程，不需要 WSL |
| Node.js LTS（22+） | https://nodejs.org |
| npm | 随 Node.js 安装 |
| Hugo Extended（v0.162.0+） | https://gohugo.io，选择 Windows 版并加入 PATH |
| Python 3.11+ | https://python.org；用于 DOCX 导入依赖 |
| Git for Windows | https://git-scm.com |
| 现代浏览器 | 打开作者工作台 |

## 3. 安装

```powershell
git clone <你的公开仓库地址>
cd lidaiji-platform
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
```

`setup.ps1` 会检查环境、提示缺失软件、安装项目 npm 依赖并做基础自检。
如果执行策略阻止脚本，**不要**永久关闭安全策略，请使用只对当前进程生效的方式：

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows\setup.ps1
```

或先执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

然后运行 `.\scripts\windows\setup.ps1`。

### DOCX 导入依赖（Python 环境）

工作台需要 Python 的 DOCX 解析依赖。在项目目录执行：

```powershell
python -m venv .venv-importer
.venv-importer\Scripts\pip install -r importer\requirements.txt
```

`setup.ps1` 也会检测此环境是否就绪。

## 4. 打开工作台

双击桌面/开始菜单的“历代纪作者工作台”（由 `create-shortcut.ps1` 创建），
或直接运行：

```powershell
.\scripts\windows\open-studio.ps1
```

脚本会后台启动 Studio 并打开默认浏览器：

```text
http://127.0.0.1:4173
```

### 登录自动启动（可选）

```powershell
npm run studio:install      # 注册“LidaijiStudio”任务计划程序（登录时启动）
npm run studio:uninstall    # 卸载自动启动（不删除文章、仓库、数据库）
```

### 状态与停止

```powershell
npm run studio:status
npm run studio:stop
npm run studio:restart
```

日志与运行状态位于 `%LOCALAPPDATA%\LidaijiStudio\`（含 `Logs\` 与 `studio.pid`），
不会写入 Git 仓库。

## 5. 导入 DOCX

1. 打开工作台，进入“Word 导入”向导；
2. 选择 `.docx` 文件（不超过 100MB），逐项查看解析报告；
3. 填写元数据（标题、栏目、slug、是否草稿），预览后确认写入。

注意事项：

- 支持段落、标题、引用、列表、表格、图片、加粗/斜体，以及 Word 的居中/右对齐段落；
- 合并单元格、文本框、脚注等复杂 Word 功能可能丢失或变形，导入报告中会有警告；
- 导入后请在工作台打开文章核对排版；
- **原 DOCX 应继续保留**，作为不可替代的原始备份。

## 6. 构建公开网站

```powershell
npm run build
```

构建产物输出到 `dist/site`。也可以先构建再本地预览：

```powershell
npm run dev
```

（`dev` 会启动本地网站与段评服务，地址与端口见输出。）

## 7. 发布到服务器

### 路线 A（推荐）：Windows 作者电脑 + Linux 服务器

Windows 负责写作、编辑、构建、上传；Linux 服务器负责公开网站、评论服务、HTTPS 与
长期在线。Windows 用户不需要 Mac。

1. 生成标准发布包：

```powershell
npm run package
```

产物位于 `dist\releases\<时间戳>\`，包含静态站包、源码包与各自 SHA-256。

2. 上传：使用 `scp`（Windows 10+ 自带 OpenSSH）、WinSCP 或服务器控制台上传发布包；

3. 在服务器执行既有部署脚本完成发布（部署细节见 `docs/deployment.md` 方案一）。

SSH 配置由你自己的 `%USERPROFILE%\.ssh\config` 管理，脚本不保存任何密码或私钥。

### 路线 B：完整部署在 Windows Server

可以使用 Windows Server + Node.js + SQLite + Caddy/IIS + 任务计划程序，但**该路线
目前标记为实验性/社区验证中**：HTTPS、服务自启、SQLite 权限、备份、升级、回滚、
防火墙与日志轮转尚未在真实 Windows Server 上完成全套验证。完整公网部署请优先
使用 Linux 服务器。

## 8. 常见问题

| 问题 | 处理 |
| --- | --- |
| PowerShell 脚本被阻止 | 使用 `powershell.exe -ExecutionPolicy Bypass -File ...` 或 `Set-ExecutionPolicy -Scope Process Bypass`；不要永久关闭安全策略 |
| 端口 4173 被占用 | 找到占用进程并结束，或确认是否已有工作台实例在运行 |
| `node` 命令找不到 | 安装 Node.js LTS 后**重新打开终端** |
| `hugo` 命令找不到 | 安装 Hugo Extended 并把其目录加入 PATH（需要 v0.162.0+） |
| `python` 命令名称不同 | 本机可能是 `py`（Windows 启动器）；脚本会自动尝试 `py -3` / `python` / `python3` |
| 路径含中文或空格 | 脚本使用 `%LOCALAPPDATA%` 与项目相对路径，支持中文和空格目录；不要在路径里使用无法解析的符号 |
| 防火墙提示 | 工作台只监听 `127.0.0.1`，不需要放行任何入站端口 |
| Studio 无法关闭 | 运行 `npm run studio:stop`；如仍异常，查看 `%LOCALAPPDATA%\LidaijiStudio\Logs` |
| 桌面快捷方式失效 | 项目移动后重新运行 `.\scripts\windows\create-shortcut.ps1` |
| 项目移动后自动启动失效 | 重新运行 `npm run studio:install`（任务计划程序记录的是旧路径） |
| 评论服务本地运行 | `npm run comments:init` 初始化本地 SQLite，`npm run dev` 可同源托管整站与评论服务 |
