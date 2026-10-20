# 部署

先在干净 Git 状态运行 `npm run check` 和 `npm run build`，再生成带 SHA-256 与清单的发布包。
发布输入由不可变 release snapshot 固定（见 [发布快照](release-snapshot.md)）：平台代码必须来自
已提交 commit，私人内容会先冻结为快照；站点、源码包与服务器校验共享同一快照身份。
Nginx 与 systemd 示例位于 `deploy/`，其中 `example.com`、`/path/to/...`、
`YOUR_VALUE_HERE` 必须在服务器安全配置中替换。Studio 不部署到公网。

静态站应以新时间戳目录解压，验证后原子切换 `current` 软链接；评论服务只监听回环地址。
不要把 `.env`、SQLite、Cookie、私人内容或对象存储凭据放进源码发布包。

《历代纪》的作者端支持 macOS 与 Linux，服务器端使用 Linux。

## 方案一：macOS 作者电脑 + Linux 服务器（推荐）

macOS 负责写作、编辑、构建与上传；Linux 服务器负责公开网站、评论服务、HTTPS 与长期在线。

1. 在 macOS 项目目录完成写作与检查：

   ```bash
   npm run check
   npm run build
   ```

2. 生成标准发布包（静态站包 + 源码包 + SHA-256）：

   ```bash
   npm run package
   ```

   产物位于 `dist/releases/<时间戳>/`。

3. 配置 `WRITING_SSH_TARGET` 与 `WRITING_DOMAIN` 后，执行完整自动发布：

   ```bash
   npm run publish
   ```

   发布脚本会完成构建、上传、服务器校验与原子切换。

## 方案二：Linux 本机与服务器

在 Linux 本机直接使用 `npm run studio`、`npm run build`；发布与方案一相同。
服务器端 Nginx 静态托管 `/opt/writing-site/current`，评论服务以 systemd 运行。

## 方案三：手动上传

如果网络或权限不允许自动发布，可在本地执行 `npm run package`，把发布包上传到 Linux
服务器，再按既有流程解压到新时间戳目录、校验、原子切换 `current` 软链接；评论服务按需要
单独发布。具体命令以 `scripts/publish.sh`、`scripts/server-publish.sh` 与运维文档为准。
