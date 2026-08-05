# Studio

Studio 仅监听回环地址，并精确校验 Host、内存会话 Cookie、Origin 与写请求头。私人模式下，
文章、媒体、作者评、Word 导入、备份和 Git 操作都指向内容仓库；平台脚本只负责预览、
检查和发布。页面顶部持续显示当前模式与提交目标。

Word 导入保持 parse（零写入）→ plan（零写入）→ commit（冲突检查后提交）的边界。
演示模式写入 `.cache/studio-demo-workspace`，不会把真实 Word 导入公开 Git。

## v0.2.1 本地免登录（local-bootstrap）

默认 `STUDIO_AUTH_MODE=local-bootstrap`：启动工作台即授权，不再需要账号密码登录。

- **首次设置**：`npm run studio:setup` 把评论服务管理员凭据写入 macOS Keychain
  （其他平台写入仅当前用户可读的 600 文件）。凭据不回显、不进日志、不进前端。
- 之后启动工作台：浏览器打开 `http://127.0.0.1:4173/` 即自动建立本地会话，
  网关服务端用本机凭据自动登录上游评论服务；浏览器只持有本地 HttpOnly 会话，
  不接触管理员密码/上游会话/CSRF。
- 安全边界（与评论服务无关，均未削弱）：
  - 只监听 127.0.0.1/::1，非回环地址启动直接拒绝（退出码 2）；
  - Host 精确校验、POST 要求 X-Studio-Request + X-Studio-CSRF + 同源端口 Origin；
  - 本地会话仅内存、HttpOnly、SameSite=Strict、最长 8 小时、进程退出即失效；
  - 上游会话过期时网关自动重新登录并重试一次（仅认证失败路径，网络错误不重试）；
  - 凭据缺失/为空一律 fail-closed，绝不降级为匿名管理。
- **锁定工作台**：阅读反馈页“锁定工作台”→ 本地会话与上游会话立即撤销；
  重新授权 = 重新打开页面（复用本机凭据，无需再输入密码）。
- **password 模式**：`STUDIO_AUTH_MODE=password` 保留原账号密码登录流程
  （故障排查/特殊部署）。
