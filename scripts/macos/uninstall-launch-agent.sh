#!/usr/bin/env bash
# 卸载《历代纪》作者工作台 LaunchAgent。
# 只移除本项目（cn.lidaiji.studio）的 LaunchAgent，不删除文章、仓库、数据库；
# 不删除 .app 与日志（保留在 ~/Applications 与 ~/Library/Logs，便于重新安装）。
# 可重复执行。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ "${LIDAIJI_SKIP_LAUNCHCTL:-}" != "1" ]]; then
  if launchd_job_loaded; then
    lidaiji_log "uninstall: bootout $LAUNCH_TARGET"
    launchctl bootout "$LAUNCH_TARGET" 2>/dev/null || true
  fi
fi

removed=0
if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
  removed=1
fi
rm -f "$PID_FILE"

if [[ "$removed" == "1" ]]; then
  printf '已移除 LaunchAgent：%s\n' "$PLIST_PATH"
else
  printf 'LaunchAgent 不存在（可能之前已经卸载）。\n'
fi
printf '已停止登录自动启动；文章、仓库、数据库与配置未受影响。\n'
printf '工作台应用与日志保留在：\n  %s\n  %s\n' "$APP_PATH" "$LOG_DIR"
printf '如需彻底删除这些文件，请手动移到废纸篓；重新安装只需 npm run studio:install。\n'
