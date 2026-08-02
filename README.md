# Lidaiji Platform

一个面向中文长文出版的轻量平台：Hugo 阅读站、Node.js/SQLite 评论服务、仅本机运行的
作者 Studio，以及三阶段 Word 导入器。平台发行版为 **v0.1.0**；组件版本分别为
site v0.4.1、comments v0.4.0、studio v0.1.1。

平台代码与私人作品严格分仓：本仓库是唯一的平台代码来源，只含虚构 demo；真实文章、
Page Bundle 图片、作者评和品牌覆盖配置应放在独立私有内容仓库。

## 五分钟启动 demo

```bash
python3 -m venv .venv-importer
.venv-importer/bin/pip install -r importer/requirements.txt
npm --prefix comments-service install
npm run build
npm run studio
```

未配置私人工作区时，构建与 Studio 自动使用 `examples/` 的虚构内容。`npm run dev`
会构建站点并在回环地址启动本地评论服务。

## 连接私人内容仓库

复制 `.lidaiji-workspace.example.json` 为 `.lidaiji-workspace.json`，把路径指向相邻私有仓库。
真实配置文件已被 `.gitignore` 排除。配置优先级为：命令行参数 → 环境变量 → 本地 JSON
→ demo。Studio 顶部会持续显示“演示内容”或实际内容仓库名称，文章 Git 提交只发生在
`contentRepoRoot`，不会夹带平台代码。

## 常用命令

```bash
npm run studio                 # 作者工作台（仅127.0.0.1）
./scripts/import-docx.sh       # Word parse/plan/commit 导入
npm run build                  # Hugo构建
npm run comments:init          # 新建本地SQLite并执行migration 001/002
npm run comments:create-admin  # 创建本地测试管理员
npm run dev                    # 本地站点+评论服务
npm run check                  # 全部检查
```

部署模板位于 `deploy/`，生产参数必须通过服务器安全配置注入，不能提交到 Git。升级前先备份
Markdown、作者评和 SQLite；发布使用时间戳 release 与原子软链接切换，回滚不修改私人仓库。

详细说明见 [快速开始](docs/quick-start.md)、[内容仓库](docs/content-repository.md)、
[评论服务](docs/comments.md)、[Studio](docs/studio.md)、[部署](docs/deployment.md)、
[备份恢复](docs/backup-and-restore.md)及[升级](docs/upgrading.md)。

代码使用 0BSD；`examples/` 虚构内容使用 CC0。私人作品不随本项目授权。
