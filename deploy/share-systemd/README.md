# 长文分享 QQ 发布器 systemd 候选（本轮不启用）

本目录只提供候选单元文件，**未安装、未启用、未部署生产**。生产启用属于
后续 V0.1 生产部署轮，必须先经过测试 QQ 验收。

## 文件

- `lidaiji-share-publisher.service` — oneshot：唤醒 → `run-once` → 退出。
  - 幂等：任务原子认领；失败即停止，`Restart=no`，绝不自动重试。
  - 环境从 `/etc/lidaiji-share/publisher.env` 读取（私有文件，示例见下）。
- `lidaiji-share-publisher.timer` — 每分钟触发一次；无到期任务时立即退出，
  空闲常驻内存接近 0。

## 部署轮需要的环境文件（/etc/lidaiji-share/publisher.env）

```ini
LIDAIJI_SHARE_CONTENT_ROOT=/var/lib/lidaiji-share/content
SHARE_BASE_URL=https://read.历代纪.cn/
SHARE_DIST=/opt/lidaiji-share/dist
QZONE_PUBLISH_ENABLED=false
NAPCAT_HTTP_URL=http://127.0.0.1:3000
NAPCAT_QQ=
```

`QZONE_PUBLISH_ENABLED` 只在测试 QQ 验收完成、用户明确批准后改为 `true`。

## 启用命令（仅在部署轮执行）

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lidaiji-share-publisher.timer
journalctl -u lidaiji-share-publisher.service -e
```
