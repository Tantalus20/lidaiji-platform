#!/usr/bin/env bash
# 安装《历代纪》作者工作台 LaunchAgent 与“历代纪作者工作台.app”。
# 本机实际配置（项目根、Python/Node 绝对路径等）生成到仓库之外：
#   ~/Library/LaunchAgents/cn.lidaiji.studio.plist
#   ~/Library/Application Support/LidaijiStudio/install.json
# 可重复执行；项目目录移动、Node/Python 路径变化或系统更新后重跑即可刷新。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PROJECT_ROOT="$(cd -- "$M_MACOS_DIR/../.." && pwd)"
TEMPLATE="$PROJECT_ROOT/packaging/macos/$STUDIO_LABEL.plist.template"
if [[ ! -f "$TEMPLATE" ]]; then
  printf '错误：找不到 plist 模板：%s\n' "$TEMPLATE" >&2
  exit 1
fi

PYTHON="$(resolve_studio_python || true)"
if [[ -z "$PYTHON" ]]; then
  printf '错误：找不到作者工作台运行环境。请先运行 import-docx.command 完成首次环境初始化。\n' >&2
  exit 1
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
NODE_BIN_DIR="$(dirname "$NODE_BIN" 2>/dev/null || true)"
PATH_VALUE="${NODE_BIN_DIR:+$NODE_BIN_DIR:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$LAUNCH_AGENT_DIR" "$APP_DIR"

# 1. 写入本机安装配置（含绝对路径，仅存本机，绝不进入公开仓库）。
INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$INSTALL_JSON.tmp" "$PROJECT_ROOT" "$PYTHON" "$NODE_BIN" "$NPM_BIN" "$NODE_BIN_DIR" "$STUDIO_PORT" "$STUDIO_LABEL" "$INSTALLED_AT" <<'PY' >/dev/null
import json
import sys

path, root, python, node, npm, node_dir, port, label, installed_at = sys.argv[1:]
data = {
    "projectRoot": root,
    "pythonPath": python,
    "nodePath": node,
    "npmPath": npm,
    "nodeBinDir": node_dir,
    "port": int(port),
    "label": label,
    "installedAt": installed_at,
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
mv "$INSTALL_JSON.tmp" "$INSTALL_JSON"
chmod 0600 "$INSTALL_JSON"

# 2. 从模板渲染 plist，先校验再覆盖安装。
sed \
  -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__PATH_VALUE__|$PATH_VALUE|g" \
  "$TEMPLATE" >"$PLIST_PATH.tmp"
if ! plutil -lint "$PLIST_PATH.tmp" >/dev/null 2>&1; then
  printf '错误：渲染后的 plist 未通过 plutil 校验，安装已中止。\n' >&2
  rm -f "$PLIST_PATH.tmp"
  exit 1
fi
if [[ -f "$PLIST_PATH" ]]; then
  cp "$PLIST_PATH" "$STATE_DIR/plist.backup" 2>/dev/null || true
fi
mv "$PLIST_PATH.tmp" "$PLIST_PATH"
chmod 0644 "$PLIST_PATH"

# 3. 加载 launchd 任务：先 bootout 旧任务，再 bootstrap 新配置。
#    失败时尽量恢复原 plist（不破坏原有可用配置）。
if [[ "${LIDAIJI_SKIP_LAUNCHCTL:-}" != "1" ]]; then
  launchctl enable "$LAUNCH_TARGET" 2>/dev/null || true
  if launchd_job_loaded; then
    lidaiji_log "install: bootout 旧任务"
    launchctl bootout "$LAUNCH_TARGET" 2>/dev/null || true
  fi
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"; then
    printf '错误：launchctl bootstrap 失败，尝试恢复原有配置。\n' >&2
    if [[ -f "$STATE_DIR/plist.backup" ]]; then
      cp "$STATE_DIR/plist.backup" "$PLIST_PATH"
      launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || true
    fi
    exit 1
  fi
  launchd_job_loaded || {
    printf '错误：任务加载后未出现在 launchctl 中。\n' >&2
    exit 1
  }
  lidaiji_log "install: 已 bootstrap $LAUNCH_TARGET"
fi

# 4. 生成“历代纪作者工作台.app”（系统自带 osacompile；失败不阻塞 LaunchAgent）。
if [[ "${LIDAIJI_SKIP_APP:-}" != "1" ]]; then
  "$M_MACOS_DIR/install-app.sh" || {
    printf '警告：应用入口生成失败（不影响 LaunchAgent）。可稍后重跑 npm run studio:install。\n' >&2
  }
fi

# 5. 立即启动并等待健康检查（RunAtLoad 可能已启动；kickstart 幂等）。
if [[ "${LIDAIJI_SKIP_START:-}" != "1" && "${LIDAIJI_SKIP_LAUNCHCTL:-}" != "1" ]]; then
  launchctl kickstart "$LAUNCH_TARGET" 2>/dev/null || true
  if wait_for_studio 30; then
    printf '作者工作台已启动：%s\n' "$STUDIO_URL"
  else
    printf '警告：服务已安装，但健康检查未通过。请查看：%s\n' "$LOG_DIR" >&2
  fi
fi

printf '已安装 LaunchAgent：%s\n' "$PLIST_PATH"
printf '应用入口：%s\n' "$APP_PATH"
printf '日志目录：%s\n' "$LOG_DIR"
printf '日常使用：双击“历代纪作者工作台”，或直接访问 %s\n' "$STUDIO_URL"
printf '卸载：npm run studio:uninstall（不删除文章、仓库、数据库）\n'
