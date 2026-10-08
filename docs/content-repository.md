# 私人内容仓库

建议结构为 `content/`、`data/author-notes/`、`site-overrides/`。文章和图片使用 Hugo Page
Bundle；作者评按稳定 `articleId` 保存为 `data/author-notes/<articleId>.yaml`，不依赖标题、
slug 或 URL。`draft` 作者评在构建阶段完全过滤，原始 YAML 不进入静态产物。

本地 `.lidaiji-workspace.json` 不得提交。也可设置 `LIDAIJI_CONTENT_REPO_ROOT`、
`LIDAIJI_CONTENT_ROOT`、`LIDAIJI_AUTHOR_NOTES_ROOT`、
`LIDAIJI_SITE_OVERRIDES_ROOT` 和 `LIDAIJI_DIST_ROOT`（构建产物根，默认 `dist/`）。
工作区配置文件只应记录相对路径；绝对私人路径请用环境变量或命令行传入。

工作区模式由 `LIDAIJI_WORKSPACE_MODE` 或 Studio 的 `--mode` 控制：

- `auto`（默认）：找到工作区配置就按 `private` 解析；没有配置则使用 demo。
- `private`：必须有合法工作区；缺失或无效时直接失败，绝不回退到平台仓库 `content/`。
  作者机器建议显式使用该模式。
- `demo`：显式使用完全虚构的演示内容；公开克隆与 CI 使用。

Studio 会把解析结果作为显式契约暴露在 `/api/system/status`：
`platformRoot`、`contentRepoRoot`、`contentRoot`、`authorNotesRoot`、`outputRoot`。
`contentRepoRoot` 是文章、作者评与媒体写入的唯一落点。
