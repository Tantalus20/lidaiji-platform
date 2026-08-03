#!/usr/bin/env bash
# 查看《历代纪》作者工作台状态（只读，不修改任何内容）。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

printf '历代纪作者工作台状态\n'
printf '  服务标识：%s\n' "$STUDIO_LABEL"

job="未安装"
if [[ -f "$PLIST_PATH" ]]; then
  if launchd_job_loaded; then
    job="已安装（launchd 已加载）"
  else
    job="已安装（launchd 未加载）"
  fi
fi
printf '  自动启动：%s\n' "$job"

state="未运行"
if PID="$(studio_pid || true)" && [[ -n "$PID" ]]; then
  state="运行中"
  printf '  进程 PID：%s\n' "$PID"
  if launchd_job_loaded && [[ "$(launchd_job_pid)" == "$PID" ]]; then
    printf '  进程来源：launchd 管理\n'
  else
    printf '  进程来源：非 launchd 启动（如终端）\n'
  fi
else
  printf '  进程 PID：（无）\n'
fi

if studio_health_ok; then
  printf '  健康检查：通过（%s）\n' "$STUDIO_URL"
else
  printf '  健康检查：未通过\n'
fi

printf '  监听地址：仅 127.0.0.1:%s（不对外网或局域网开放）\n' "$STUDIO_PORT"
printf '  日志目录：%s\n' "$LOG_DIR"
printf '  状态目录：%s\n' "$STATE_DIR"
if [[ -d "$APP_PATH" ]]; then
  printf '  应用入口：%s\n' "$APP_PATH"
else
  printf '  应用入口：未安装\n'
fi
printf '  状态：%s\n' "$state"
exit 0
