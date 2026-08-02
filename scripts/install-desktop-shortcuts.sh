#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

DESKTOP="${WRITING_DESKTOP_DIR:-$HOME/Desktop}"
APPLICATIONS_DIR="${WRITING_APPLICATIONS_DIR:-$HOME/Applications}"
mkdir -p "$DESKTOP"
mkdir -p "$APPLICATIONS_DIR"

install_link() {
  local target="$1"
  local link="$2"
  if [[ -L "$link" ]]; then
    if [[ "$(readlink "$link")" == "$target" ]]; then
      printf '已存在：%s\n' "$link"
      return
    fi
    printf '错误：同名快捷方式已经指向其他位置：%s\n' "$link" >&2
    return 1
  fi
  if [[ -e "$link" ]]; then
    printf '错误：桌面已有同名文件，不会覆盖：%s\n' "$link" >&2
    return 1
  fi
  ln -s "$target" "$link"
  printf '已建立：%s\n' "$link"
}

install_link "$ROOT/incoming" "$DESKTOP/历代纪来稿箱"
TEMP_APP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-author-app.XXXXXX")"
trap 'rm -rf "$TEMP_APP_DIR"' EXIT
BUILT_APP="$TEMP_APP_DIR/历代纪写作.app"
WRITING_APP_OUTPUT="$BUILT_APP" "$ROOT/scripts/build-mac-app.sh"

old_command="$DESKTOP/历代纪写作.command"
if [[ -L "$old_command" && "$(readlink "$old_command")" == "$ROOT/writing-site.command" ]]; then
  rm -f "$old_command"
fi

installed_app="$APPLICATIONS_DIR/历代纪写作.app"
if [[ -d "$installed_app" ]]; then
  bundle_id="$(plutil -extract CFBundleIdentifier raw "$installed_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$bundle_id" == "cn.nsdynastygame.lidaiji.author" ]]; then
    rm -rf "$installed_app"
  else
    printf '错误：应用程序文件夹已有同名应用，不会覆盖：%s\n' "$installed_app" >&2
    exit 1
  fi
elif [[ -e "$installed_app" ]]; then
  printf '错误：应用程序文件夹已有同名文件，不会覆盖：%s\n' "$installed_app" >&2
  exit 1
fi

ditto "$BUILT_APP" "$installed_app"
xattr -cr "$installed_app"
codesign --force --deep --sign - "$installed_app"
codesign --verify --deep --strict "$installed_app"
printf '已安装应用：%s\n' "$installed_app"

desktop_app="$DESKTOP/历代纪写作.app"
if [[ -d "$desktop_app" ]]; then
  bundle_id="$(plutil -extract CFBundleIdentifier raw "$desktop_app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$bundle_id" == "cn.nsdynastygame.lidaiji.author" ]]; then
    rm -rf "$desktop_app"
  else
    printf '错误：桌面已有同名应用，不会覆盖：%s\n' "$desktop_app" >&2
    exit 1
  fi
elif [[ -L "$desktop_app" ]]; then
  rm -f "$desktop_app"
fi

desktop_alias="$DESKTOP/历代纪写作"
if [[ -e "$desktop_alias" || -L "$desktop_alias" ]]; then
  printf '错误：桌面已有“历代纪写作”，不会覆盖。请先确认该文件是否可以移走。\n' >&2
  exit 1
fi
ALIAS_TOOL="$TEMP_APP_DIR/create-finder-alias"
clang -fobjc-arc -framework Foundation "$ROOT/scripts/create-finder-alias.m" -o "$ALIAS_TOOL"
"$ALIAS_TOOL" "$installed_app" "$desktop_alias"
printf '已建立桌面别名：%s\n' "$desktop_alias"
printf '\n以后只需打开“历代纪来稿箱”放入Word，再双击“历代纪写作”应用。\n'
