#!/usr/bin/env bash
# 用系统自带 osacompile 生成“历代纪作者工作台.app”。
# 应用本身不承载 Studio 代码，只是一个安全启动器：唤醒 LaunchAgent 并打开浏览器。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '错误：缺少命令 %s。\n' "$1" >&2
    exit 1
  fi
}
require_command osacompile
require_command plutil

TEMP_APP="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-studio-app.XXXXXX")/历代纪作者工作台.app"
trap 'rm -rf "$(dirname "$TEMP_APP")"' EXIT

osacompile -o "$TEMP_APP" "$M_MACOS_DIR/launcher.applescript"

PLIST="$TEMP_APP/Contents/Info.plist"
plutil -replace CFBundleName -string "历代纪作者工作台" "$PLIST"
plutil -replace CFBundleDisplayName -string "历代纪作者工作台" "$PLIST"
plutil -replace CFBundleIdentifier -string "cn.lidaiji.studio.launcher" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$STUDIO_APP_VERSION" "$PLIST"
plutil -replace LSMinimumSystemVersion -string "13.0" "$PLIST"

# 启动器脚本随应用打包；install.json 指向真实项目根目录。
RESOURCES="$TEMP_APP/Contents/Resources"
mkdir -p "$RESOURCES"
cp "$M_MACOS_DIR/open-studio.sh" "$RESOURCES/open-studio.sh"
cp "$M_MACOS_DIR/common.sh" "$RESOURCES/common.sh"
chmod 0755 "$RESOURCES/open-studio.sh"

# 简单本地图标（PIL 绘制，不联网）；失败时保留系统默认图标，不阻塞安装。
if [[ "${LIDAIJI_SKIP_ICON:-}" != "1" ]] && command -v iconutil >/dev/null 2>&1; then
  ICON_PY="$(resolve_studio_python || true)"
  if [[ -n "$ICON_PY" ]]; then
    ICONSET_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-studio-icon.XXXXXX")"
    if "$ICON_PY" "$M_MACOS_DIR/icon.py" --out "$ICONSET_PARENT/AppIcon.iconset" >/dev/null 2>&1; then
      iconutil -c icns "$ICONSET_PARENT/AppIcon.iconset" -o "$RESOURCES/AppIcon.icns" 2>/dev/null && {
        plutil -replace CFBundleIconFile -string "AppIcon" "$PLIST"
      }
    fi
    rm -rf "$ICONSET_PARENT"
  fi
fi

# 安装到 ~/Applications；只覆盖本工具生成的应用（同名不同来源拒绝覆盖）。
APP_PARENT="$(dirname "$APP_PATH")"
mkdir -p "$APP_PARENT"
if [[ -d "$APP_PATH" ]]; then
  existing_id="$(plutil -extract CFBundleIdentifier raw "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_id" == "cn.lidaiji.studio.launcher" ]]; then
    rm -rf "$APP_PATH"
  else
    printf '错误：%s 已存在且不属于本工具（bundle id: %s），不会覆盖。\n' "$APP_PATH" "${existing_id:-未知}" >&2
    exit 1
  fi
fi
ditto "$TEMP_APP" "$APP_PATH"
xattr -cr "$APP_PATH" 2>/dev/null || true
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_PATH" 2>/dev/null || true
fi
printf '已生成应用：%s\n' "$APP_PATH"
