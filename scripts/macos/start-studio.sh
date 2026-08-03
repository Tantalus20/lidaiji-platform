#!/usr/bin/env bash
# 启动《历代纪》作者工作台（只监听 127.0.0.1:4173）。
# 供 LaunchAgent、studio:restart 与 open-studio.sh 调用；
# 已运行时直接成功退出，绝不启动第二份。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PROJECT_ROOT="$(find_project_root)"

if studio_pid >/dev/null 2>&1; then
  lidaiji_log "start: 已在运行，跳过启动"
  printf '作者工作台已在运行：%s\n' "$STUDIO_URL"
  exit 0
fi

existing="$(port_listener_pid)"
if [[ -n "$existing" ]]; then
  lidaiji_log "start: 端口 $STUDIO_PORT 被其他程序占用（pid=$existing），拒绝启动"
  printf '错误：端口 %s 已被其他程序占用（pid=%s），不会启动第二份。\n' "$STUDIO_PORT" "$existing" >&2
  exit 1
fi

PYTHON="$(resolve_studio_python)" || {
  printf '错误：找不到作者工作台运行环境。请先运行 import-docx.command 完成首次环境初始化，再执行 npm run studio:install。\n' >&2
  exit 1
}
lidaiji_log "start: 使用 $PYTHON"

mkdir -p "$LOG_DIR" "$STATE_DIR"
best_effort_rotate
write_pidfile "$$"

cd "$PROJECT_ROOT"

# 最小且明确的 PATH：node 目录（评论服务子进程）→ Homebrew（hugo 等）→ 系统工具。
node_bin_dir="$(read_install_value nodeBinDir || true)"
export PATH="${node_bin_dir:+$node_bin_dir:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="zh_CN.UTF-8"
export LC_ALL="zh_CN.UTF-8"

# exec 保持 PID 不变，SIGTERM/SIGINT 直达 Python（工作台能优雅退出并清理）。
# stderr 经 sed 过滤会话 token，避免敏感参数进入日志。
exec "$PYTHON" -m studio --project-root "$PROJECT_ROOT" --no-browser \
  >>"$STDOUT_LOG" 2> >(exec sed -E 's/token=[0-9a-f]{32}/token=***/g' >>"$STDERR_LOG")
