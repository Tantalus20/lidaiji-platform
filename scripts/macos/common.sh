#!/usr/bin/env bash
# 《历代纪》作者工作台 macOS 启动器的公共函数。
#
# 所有目录都可被环境变量覆盖，便于自动化测试与隔离运行：
#   LIDAIJI_LAUNCH_AGENT_DIR  LaunchAgents 目录（默认 ~/Library/LaunchAgents）
#   LIDAIJI_STATE_DIR         状态与安装配置目录（默认 ~/Library/Application Support/LidaijiStudio）
#   LIDAIJI_LOG_DIR           日志目录（默认 ~/Library/Logs/LidaijiStudio）
#   LIDAIJI_APP_DIR           应用安装目录（默认 ~/Applications）
#
# 本文件不包含任何本机路径。实际本机配置由 install-launch-agent.sh 生成，
# 保存在 ~/Library/Application Support/LidaijiStudio/install.json（仓库之外）。

set -Eeuo pipefail

M_MACOS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

STUDIO_LABEL="cn.lidaiji.studio"
STUDIO_PORT="4173"
STUDIO_URL="http://127.0.0.1:4173/"
STUDIO_APP_NAME="历代纪作者工作台.app"
STUDIO_APP_VERSION="0.1.1"

LAUNCH_AGENT_DIR="${LIDAIJI_LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
STATE_DIR="${LIDAIJI_STATE_DIR:-$HOME/Library/Application Support/LidaijiStudio}"
LOG_DIR="${LIDAIJI_LOG_DIR:-$HOME/Library/Logs/LidaijiStudio}"
APP_DIR="${LIDAIJI_APP_DIR:-$HOME/Applications}"

PLIST_PATH="$LAUNCH_AGENT_DIR/$STUDIO_LABEL.plist"
INSTALL_JSON="$STATE_DIR/install.json"
PID_FILE="$STATE_DIR/studio.pid"
STDOUT_LOG="$LOG_DIR/studio.stdout.log"
STDERR_LOG="$LOG_DIR/studio.stderr.log"
LAUNCHER_LOG="$LOG_DIR/launcher.log"
APP_PATH="$APP_DIR/$STUDIO_APP_NAME"
LAUNCH_TARGET="gui/$(id -u)/$STUDIO_LABEL"

# 追加一条带时间戳的启动器日志；写失败不影响调用方。
lidaiji_log() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LAUNCHER_LOG" 2>/dev/null || true
}

# 定位项目根目录：优先使用安装时记录的仓库根，否则按脚本位置自定位。
find_project_root() {
  local root=""
  if [[ -f "$INSTALL_JSON" ]]; then
    root="$(python3 -c 'import json,sys
print(json.load(open(sys.argv[1])).get("projectRoot", ""))' "$INSTALL_JSON" 2>/dev/null || true)"
  fi
  if [[ -n "$root" && -d "$root" ]]; then
    printf '%s\n' "$root"
    return 0
  fi
  printf '%s\n' "$(cd -- "$M_MACOS_DIR/../.." && pwd)"
}

read_install_value() {
  [[ -f "$INSTALL_JSON" ]] || return 1
  python3 -c 'import json,sys
print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$INSTALL_JSON" "$1" 2>/dev/null || true
}

# 解析工作台运行环境：安装记录 → 项目虚拟环境 → PATH python3；
# 必须是能加载 docx/PIL/yaml/pypinyin 的解释器。
resolve_studio_python() {
  local candidates=() candidate recorded root
  root="${PROJECT_ROOT:-}"
  [[ -n "$root" ]] || root="$(find_project_root)"
  [[ -n "${LIDAIJI_STUDIO_PYTHON:-}" ]] && candidates+=("$LIDAIJI_STUDIO_PYTHON")
  recorded="$(read_install_value pythonPath || true)"
  [[ -n "$recorded" ]] && candidates+=("$recorded")
  candidates+=("$root/.venv-importer/bin/python3")
  command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -x "$candidate" ]] && "$candidate" -c 'import docx, PIL, yaml, pypinyin' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# 4173 端口的监听进程 PID（无则输出空；lsof 无匹配时退出码为 1，
# 加 || true 防止 pipefail + set -e 把脚本静默杀掉）。
port_listener_pid() {
  lsof -nP -iTCP:$STUDIO_PORT -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

# 校验进程命令行确实是本工作台（python -m studio --project-root ...），
# 避免把评论服务或其他 Node/Python 项目当成工作台。
command_matches_studio() {
  local command=""
  command="$(ps -p "$1" -o command= 2>/dev/null || true)"
  [[ -n "$command" && "$command" == *"-m studio"* && "$command" == *"--project-root"* ]]
}

# 通过端口 + 命令行双重校验，输出真正属于工作台的进程 PID。
studio_pid() {
  local pid
  pid="$(port_listener_pid)"
  if [[ -n "$pid" ]] && command_matches_studio "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

launchd_job_loaded() {
  launchctl print "$LAUNCH_TARGET" >/dev/null 2>&1
}

launchd_job_pid() {
  local out pid
  out="$(launchctl print "$LAUNCH_TARGET" 2>/dev/null || true)"
  pid="$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1)"
  [[ -n "$pid" ]] && printf '%s\n' "$pid" || true
}

studio_health_ok() {
  command -v curl >/dev/null 2>&1 || return 1
  curl --fail --silent --show-error --max-time 3 -o /dev/null "$STUDIO_URL" 2>/dev/null
}

wait_for_studio() {
  local deadline=$(( $(date +%s) + ${1:-15} ))
  while (( $(date +%s) < deadline )); do
    if studio_health_ok; then
      return 0
    fi
    sleep 0.5
  done
  studio_health_ok
}

write_pidfile() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  umask 077
  printf '%s\n' "$1" >"$PID_FILE" 2>/dev/null || true
}

clear_pidfile() {
  rm -f "$PID_FILE" 2>/dev/null || true
}

best_effort_rotate() {
  "$M_MACOS_DIR/rotate-logs.sh" >/dev/null 2>&1 || true
}
