# Studio

Studio 仅监听回环地址，并精确校验 Host、内存会话 Cookie、Origin 与写请求头。私人模式下，
文章、媒体、作者评、Word 导入、备份和 Git 操作都指向内容仓库；平台脚本只负责预览、
检查和发布。页面顶部持续显示当前模式与提交目标。

Word 导入保持 parse（零写入）→ plan（零写入）→ commit（冲突检查后提交）的边界。
演示模式写入 `.cache/studio-demo-workspace`，不会把真实 Word 导入公开 Git。
