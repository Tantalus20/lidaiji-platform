#!/usr/bin/env bash
# macOS 作者工作台自动检查：
#   1. 脚本存在且 bash -n 语法通过；
#   2. plist 模板渲染后可被 plutil 校验，KeepAlive 只在异常退出时重启；
#   3. AppleScript 可编译；
#   4. 安装/卸载脚本在隔离目录中可重复执行（不触碰真实 LaunchAgent）；
#   5. 真实启动去重、打开与优雅停止（仅在 4173 空闲时执行）；
#   6. 新文件不含本机绝对路径与敏感字样。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

failures=0
fail() {
  printf '失败：%s\n' "$1" >&2
  failures=1
}

MACOS_DIR="$ROOT/scripts/macos"
TEMPLATE="$ROOT/packaging/macos/cn.lidaiji.studio.plist.template"
APPLESCRIPT="$MACOS_DIR/launcher.applescript"

# 1. 脚本存在且语法正确
for script in common.sh start-studio.sh stop-studio.sh restart-studio.sh \
              status-studio.sh open-studio.sh install-launch-agent.sh \
              uninstall-launch-agent.sh install-app.sh rotate-logs.sh; do
  [[ -f "$MACOS_DIR/$script" ]] || fail "缺少 $script"
  bash -n "$MACOS_DIR/$script" || fail "$script 语法错误"
done
bash -n "$ROOT/scripts/check-macos-studio.sh" || fail "check-macos-studio.sh 语法错误"
[[ -f "$TEMPLATE" ]] || fail "缺少 plist 模板"
[[ -f "$APPLESCRIPT" ]] || fail "缺少 AppleScript 源文件"

# 2. plist 模板：占位符完整、替换后可通过 plutil 校验
grep -q '__PROJECT_ROOT__' "$TEMPLATE" || fail "plist 模板缺少 __PROJECT_ROOT__"
grep -q '__LOG_DIR__' "$TEMPLATE" || fail "plist 模板缺少 __LOG_DIR__"
grep -q '__PATH_VALUE__' "$TEMPLATE" || fail "plist 模板缺少 __PATH_VALUE__"
grep -q 'RunAtLoad' "$TEMPLATE" || fail "plist 模板缺少 RunAtLoad"
grep -A3 '<key>KeepAlive</key>' "$TEMPLATE" | grep -q '<false/>' || fail "KeepAlive 不应是无条件 true"
if command -v plutil >/dev/null 2>&1; then
  TMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/lidaiji-plist.XXXXXX.plist")"
  sed \
    -e 's|__PROJECT_ROOT__|/tmp/lidaiji-dummy|g' \
    -e 's|__LOG_DIR__|/tmp/lidaiji-dummy/logs|g' \
    -e 's|__PATH_VALUE__|/usr/bin:/bin|g' \
    "$TEMPLATE" >"$TMP_PLIST"
  plutil -lint "$TMP_PLIST" >/dev/null || fail "渲染后的 plist 无法通过 plutil -lint"
  rm -f "$TMP_PLIST"
fi

# 3. AppleScript 可编译
if command -v osacompile >/dev/null 2>&1; then
  TMP_APP="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-scpt.XXXXXX")/test.app"
  if osacompile -o "$TMP_APP" "$APPLESCRIPT" >/dev/null 2>&1; then
    [[ -f "$TMP_APP/Contents/Resources/Scripts/main.scpt" ]] || fail "AppleScript 编译产物缺少 main.scpt"
  else
    fail "AppleScript 无法编译"
  fi
  rm -rf "$(dirname "$TMP_APP")"
fi

# 4. 新文件不含本机绝对路径与敏感字样
if grep -RInE --exclude='check-macos-studio.sh' \
    -e '/Users/[^ ]*' -e '/mnt/data' -e 'BEGIN .*PRIVATE KEY' -e 'password' \
    "$MACOS_DIR" "$ROOT/packaging/macos" 2>/dev/null; then
  fail "scripts/macos 或 packaging/macos 包含本机路径或敏感字样"
fi

# 5. 安装/卸载隔离重跑测试（全部写入临时目录，不触碰真实 LaunchAgent）
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-install-test.XXXXXX")"
cleanup() { rm -rf "$RUN_DIR"; }
trap cleanup EXIT

export LIDAIJI_LAUNCH_AGENT_DIR="$RUN_DIR/LaunchAgents"
export LIDAIJI_STATE_DIR="$RUN_DIR/State"
export LIDAIJI_LOG_DIR="$RUN_DIR/Logs"
export LIDAIJI_APP_DIR="$RUN_DIR/Applications"
export LIDAIJI_SKIP_LAUNCHCTL=1
export LIDAIJI_SKIP_START=1

install_run() {
  "$MACOS_DIR/install-launch-agent.sh" >"$RUN_DIR/install.out" 2>&1 || {
    cat "$RUN_DIR/install.out" >&2
    return 1
  }
}

install_run || fail "隔离安装失败（第一次）"
[[ -f "$RUN_DIR/LaunchAgents/cn.lidaiji.studio.plist" ]] || fail "隔离安装未生成 plist"
[[ -f "$RUN_DIR/State/install.json" ]] || fail "隔离安装未生成 install.json"
grep -q "$ROOT" "$RUN_DIR/State/install.json" || fail "install.json 未记录项目根目录"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$RUN_DIR/LaunchAgents/cn.lidaiji.studio.plist" >/dev/null || fail "隔离安装生成的 plist 校验失败"
fi
if command -v osacompile >/dev/null 2>&1; then
  [[ -d "$RUN_DIR/Applications/历代纪作者工作台.app" ]] || fail "隔离安装未生成 .app"
fi
install_run || fail "隔离安装失败（第二次，重跑应幂等）"
[[ -f "$RUN_DIR/LaunchAgents/cn.lidaiji.studio.plist" ]] || fail "重跑后 plist 缺失"

"$MACOS_DIR/uninstall-launch-agent.sh" >"$RUN_DIR/uninstall.out" 2>&1 || fail "隔离卸载失败"
[[ ! -f "$RUN_DIR/LaunchAgents/cn.lidaiji.studio.plist" ]] || fail "卸载后 plist 仍然存在"
"$MACOS_DIR/uninstall-launch-agent.sh" >"$RUN_DIR/uninstall2.out" 2>&1 || fail "重复卸载失败"

# 6. 运行时测试：真实启动一次，验证去重、打开、优雅停止（仅 4173 空闲时）
if ! lsof -nP -iTCP:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  export LIDAIJI_STATE_DIR="$RUN_DIR/State2"
  export LIDAIJI_LOG_DIR="$RUN_DIR/Logs2"

  (
    cd "$ROOT"
    "$MACOS_DIR/start-studio.sh" >>"$RUN_DIR/start.log" 2>&1 &
    printf '%s\n' "$!" >"$RUN_DIR/start.pid"
  )
  started=0
  for _ in $(seq 1 30); do
    if curl --silent --fail http://127.0.0.1:4173/ >/dev/null 2>&1; then
      started=1
      break
    fi
    sleep 0.5
  done
  if [[ "$started" != "1" ]]; then
    cat "$RUN_DIR/start.log" >&2
    fail "start-studio.sh 未能启动服务"
  else
    count_before="$(lsof -nP -iTCP:4173 -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ' || true)"
    if "$MACOS_DIR/start-studio.sh" >"$RUN_DIR/start2.log" 2>&1; then
      second_ok=1
    else
      second_ok=0
    fi
    count_after="$(lsof -nP -iTCP:4173 -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ' || true)"
    [[ "$second_ok" == "1" ]] || fail "已运行时不启动第二份（应返回成功）"
    [[ "$count_after" == "$count_before" ]] || fail "产生了重复进程"

    LIDAIJI_DRY_OPEN=1 "$MACOS_DIR/open-studio.sh" >"$RUN_DIR/open.log" 2>&1 || fail "open-studio.sh 已运行时失败"

    "$MACOS_DIR/stop-studio.sh" >"$RUN_DIR/stop.log" 2>&1 || fail "stop-studio.sh 失败"
    sleep 1
    if lsof -nP -iTCP:4173 -sTCP:LISTEN >/dev/null 2>&1; then
      fail "停止后端口仍被监听"
    else
      set +e
      LIDAIJI_DRY_OPEN=1 "$MACOS_DIR/open-studio.sh" >"$RUN_DIR/open2.log" 2>&1
      open_exit=$?
      set -e
      [[ "$open_exit" != "0" ]] || fail "服务未运行且无 LaunchAgent 时 open-studio.sh 应失败"
      grep -q "studio:install" "$RUN_DIR/open2.log" || fail "服务未运行时 open-studio.sh 未提示安装"
    fi
  fi
fi

if [[ "$failures" == "1" ]]; then
  printf 'macOS 作者工作台自动检查失败。\n' >&2
  exit 1
fi
printf 'macOS 作者工作台自动检查通过。\n'
