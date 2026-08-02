# DOCX 导入器

这个目录是“作者输入层”，不参与网站运行。工具仅在作者导入 Word 时启动，
将 `.docx` 转换为 `content/` 下的 Hugo Page Bundle，完成后立即退出。

依赖和完整用法见 [Word写作流程](../docs/Word写作流程.md)。

安全边界：

- 只接受 `.docx`，拒绝 `.docm`；
- 不执行宏；
- 不访问外部链接或下载远程图片；
- 不上传文件；
- 默认拒绝覆盖已有文章；
- 原始 Word 保留在 `incoming/`，不会被 Hugo 发布。
