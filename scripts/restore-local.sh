#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE="${1:-}"
[[ -f "$ARCHIVE" ]] || { printf '用法：%s 源码备份.tar.gz\n' "$0" >&2; exit 2; }
if [[ -f "$ARCHIVE.sha256" ]]; then
  (cd "$(dirname "$ARCHIVE")" && shasum -a 256 -c "$(basename "$ARCHIVE").sha256")
fi
TARGET="${2:-restored-writing-site}"
[[ ! -e "$TARGET" ]] || { printf '恢复目标已存在：%s\n' "$TARGET" >&2; exit 1; }
mkdir -p "$TARGET"
tar -xzf "$ARCHIVE" -C "$TARGET"
test -f "$TARGET/config/_default/hugo.toml"
printf '恢复完成：%s\n' "$TARGET"

