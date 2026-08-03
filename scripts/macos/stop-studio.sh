#!/usr/bin/env bash
# 停止《历代纪》作者工作台：先 SIGTERM，等待合理时间后仍未退出，
# 再次校验 PID 与命令行（防 PID 复用）后 SIGKILL。
# 只处理命令行与项目匹配的工作台进程，绝不使用 pkill/killall。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PROJECT_ROOT="$(find_project_root)"

PID="$(studio_pid || true)"
if [[ -z "$PID" ]]; then
  clear_pidfile
  lidaiji_log "stop: 未发现运行中的工作台"
  printf '作者工作台当前没有运行。\n'
  exit 0
fi

# 双保险：命令行必须匹配工作台，避免误停评论服务或其他 Node/Python 项目。
if ! command_matches_studio "$PID"; then
  printf '错误：进程 %s 的命令行与作者工作台不匹配，拒绝停止。\n' "$PID" >&2
  exit 1
fi

lidaiji_log "stop: 向 pid=$PID 发送 SIGTERM"
if launchd_job_loaded; then
  launchctl kill SIGTERM "$LAUNCH_TARGET" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
else
  kill -TERM "$PID" 2>/dev/null || true
fi

stopped=0
for _ in $(seq 1 60); do
  if ! studio_pid >/dev/null 2>&1; then
    stopped=1
    break
  fi
  sleep 0.5
done

if [[ "$stopped" == "1" ]]; then
  clear_pidfile
  lidaiji_log "stop: 已正常停止"
  printf '作者工作台已停止。\n'
  exit 0
fi

# SIGTERM 超时：再次校验 PID 与命令行后 SIGKILL。
if command_matches_studio "$PID" && kill -0 "$PID" 2>/dev/null; then
  lidaiji_log "stop: SIGTERM 超时，SIGKILL pid=$PID（launchd 可能视为异常退出并按配置重新拉起）"
  kill -KILL "$PID" 2>/dev/null || true
  sleep 1
fi
printf '作者工作台已强制停止。\n'
exit 0
