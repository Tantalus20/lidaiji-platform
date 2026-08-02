# 私人内容仓库

建议结构为 `content/`、`data/author-notes/`、`site-overrides/`。文章和图片使用 Hugo Page
Bundle；作者评按稳定 `articleId` 保存为 `data/author-notes/<articleId>.yaml`，不依赖标题、
slug 或 URL。`draft` 作者评在构建阶段完全过滤，原始 YAML 不进入静态产物。

本地 `.lidaiji-workspace.json` 不得提交。也可设置 `LIDAIJI_CONTENT_REPO_ROOT`、
`LIDAIJI_CONTENT_ROOT`、`LIDAIJI_AUTHOR_NOTES_ROOT` 和
`LIDAIJI_SITE_OVERRIDES_ROOT`。平台没有私人仓库时自动回退到完全虚构的 demo。
