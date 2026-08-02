#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_command clang
require_command plutil

OUTPUT="${WRITING_APP_OUTPUT:-$ROOT/.author-app/历代纪写作.app}"
SOURCE="$ROOT/scripts/author-app.m"
EXECUTABLE_NAME="历代纪写作"
APP_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  printf 'VERSION格式不正确：%s\n' "$APP_VERSION" >&2
  exit 1
}

rm -rf "$OUTPUT"
mkdir -p "$OUTPUT/Contents/MacOS" "$OUTPUT/Contents/Resources"
mkdir -p "$ROOT/.cache/clang-modules"
clang -fobjc-arc -fblocks -O2 -framework AppKit -framework UniformTypeIdentifiers \
  -fmodules-cache-path="$ROOT/.cache/clang-modules" \
  "$SOURCE" -o "$OUTPUT/Contents/MacOS/$EXECUTABLE_NAME"
printf '%s\n' "$ROOT" >"$OUTPUT/Contents/Resources/root-path.txt"

PLIST="$OUTPUT/Contents/Info.plist"
plutil -create xml1 "$PLIST"
plutil -insert CFBundleName -string "历代纪写作" "$PLIST"
plutil -insert CFBundleDisplayName -string "历代纪写作" "$PLIST"
plutil -insert CFBundleIdentifier -string "cn.nsdynastygame.lidaiji.author" "$PLIST"
plutil -insert CFBundleExecutable -string "$EXECUTABLE_NAME" "$PLIST"
plutil -insert CFBundlePackageType -string "APPL" "$PLIST"
plutil -insert CFBundleShortVersionString -string "$APP_VERSION" "$PLIST"
plutil -insert CFBundleVersion -string "1" "$PLIST"
plutil -insert LSMinimumSystemVersion -string "13.0" "$PLIST"
plutil -insert NSHighResolutionCapable -bool true "$PLIST"

if command -v codesign >/dev/null 2>&1; then
  command -v xattr >/dev/null 2>&1 && xattr -cr "$OUTPUT"
  command -v xattr >/dev/null 2>&1 && xattr -d com.apple.FinderInfo "$OUTPUT" 2>/dev/null || true
  codesign --force --deep --sign - "$OUTPUT"
fi

printf 'Mac作者应用已生成：%s\n' "$OUTPUT"
