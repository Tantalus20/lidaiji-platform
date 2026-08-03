#!/usr/bin/env bash
# 重新启动《历代纪》作者工作台（launchd 任务存在时 kickstart -k）。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if ! launchd_job_loaded; then
  printf '错误：LaunchAgent 未安装。请先运行 npm run studio:install。\n' >&2
  exit 1
fi

lidaiji_log "restart: kickstart -k $LAUNCH_TARGET"
launchctl kickstart -k "$LAUNCH_TARGET"

if wait_for_studio 30; then
  lidaiji_log "restart: 已恢复 $STUDIO_URL"
  printf '作者工作台已重新启动：%s\n' "$STUDIO_URL"
  exit 0
fi

lidaiji_log "restart: 健康检查超时"
printf '错误：作者工作台未能恢复。请查看日志目录：%s\n' "$LOG_DIR" >&2
exit 1
