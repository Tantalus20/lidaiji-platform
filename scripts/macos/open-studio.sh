#!/usr/bin/env bash
# 打开《历代纪》作者工作台：未运行时唤醒 LaunchAgent，就绪后打开浏览器。
# 供“历代纪作者工作台.app”与 npm run studio:open 调用；已运行时立即打开。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ ! -f "$INSTALL_JSON" ]]; then
  lidaiji_log "open: 未安装（缺少 install.json）"
  printf '错误：还没有安装本机作者工作台。请先在项目目录运行 npm run studio:install。\n' >&2
  exit 1
fi
PROJECT_ROOT="$(find_project_root)"

if studio_health_ok; then
  lidaiji_log "open: 已在运行，直接打开 $STUDIO_URL"
  if [[ "${LIDAIJI_DRY_OPEN:-}" != "1" ]]; then
    open "$STUDIO_URL"
  else
    printf '%s\n' "$STUDIO_URL"
  fi
  exit 0
fi

if launchd_job_loaded; then
  lidaiji_log "open: 未运行，唤醒 LaunchAgent"
  launchctl kickstart "$LAUNCH_TARGET" 2>/dev/null || true
else
  lidaiji_log "open: LaunchAgent 未加载"
  printf '错误：自动启动服务未加载。请先运行 npm run studio:install。\n' >&2
  exit 1
fi

if ! wait_for_studio 8; then
  lidaiji_log "open: 等待启动超时"
  printf '错误：作者工作台未能启动。请检查日志目录：%s\n' "$LOG_DIR" >&2
  exit 1
fi

lidaiji_log "open: 已就绪，打开 $STUDIO_URL"
if [[ "${LIDAIJI_DRY_OPEN:-}" != "1" ]]; then
  open "$STUDIO_URL"
else
  printf '%s\n' "$STUDIO_URL"
fi
exit 0
