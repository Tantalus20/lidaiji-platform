# Nginx配置

模板位于 `deploy/nginx/writing-site.conf.template`。它使用占位符而不是硬编码假域名。

## 生成

```bash
./scripts/render-nginx-config.sh writing.example.com
```

生成文件默认在 `dist/writing-site.nginx.conf`。确认域名和证书路径后再复制到服务器。

## 启用

```bash
sudo cp dist/writing-site.nginx.conf /etc/nginx/sites-available/writing-site.conf
sudo ln -s /etc/nginx/sites-available/writing-site.conf /etc/nginx/sites-enabled/writing-site.conf
sudo nginx -t
sudo systemctl reload nginx
```

只有 `nginx -t` 成功才允许 reload。

## 禁用

```bash
sudo rm /etc/nginx/sites-enabled/writing-site.conf
sudo nginx -t
sudo systemctl reload nginx
```

配置特点：

- 独立 `server_name`，不影响游戏 WebSocket。
- 使用新版写法 `listen 443 ssl;` 配合 `http2 on;`，避免新版 Nginx 的旧语法警告。
- 目录形式永久链接和自定义 404。
- HTML不缓存；指纹 CSS/JS 长缓存；图片缓存30天。
- gzip、CSP、安全响应头、关闭目录列表。
- `/api/comments/` 与 `/admin/comments/` 只反向代理到本机 `127.0.0.1:4317`。
- Nginx覆盖可信的 `X-Real-IP`，但保留浏览器原始 `Origin`，使应用层同源校验有效。
- 管理后台禁止搜索引擎索引且不缓存；评论请求体限制为 40KB。
- Markdown、脚本、环境文件、备份和隐藏文件无法从公网读取。
- `00-default-reject.conf.template` 仅在服务器没有默认拒绝站点时使用，启用前必须审计现有 Nginx。

若服务器已有 Brotli 模块，可另行加入 `brotli on;`；本项目不强制安装额外模块。

本站配置只新增自己的 `server` 块和本域名评论路径，不修改游戏域名的反向代理
和 WebSocket `Upgrade` 配置。部署前后都先执行 `sudo nginx -t`；失败时不要
reload。发布脚本也会在写入 release 和切换软链接前检查磁盘、当前 release
与 Nginx 配置。
