#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-}"
COMPONENT="${2:-site}"

[[ -n "$OUTPUT" ]] || { printf '用法：%s 输出.tar.gz [site|comments]\n' "$0" >&2; exit 2; }
case "$COMPONENT" in
  site)
    TREEISH=HEAD
    VERIFY_REF='HEAD^{tree}'
    ;;
  comments)
    TREEISH=HEAD:comments-service
    VERIFY_REF=HEAD:comments-service
    ;;
  *) printf '组件只能是site或comments。\n' >&2; exit 2 ;;
esac

command -v git >/dev/null
command -v gzip >/dev/null
command -v shasum >/dev/null
git -C "$ROOT" rev-parse --verify "$VERIFY_REF" >/dev/null

OUTPUT="$(cd -- "$(dirname -- "$OUTPUT")" && pwd)/$(basename -- "$OUTPUT")"
[[ "$OUTPUT" == *.tar.gz ]] || { printf '输出文件必须以.tar.gz结尾。\n' >&2; exit 2; }
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-source-package.XXXXXX")"
TEMP_TAR="$TEMP_DIR/source.tar"
cleanup() {
  rm -f "$TEMP_TAR"
  rmdir "$TEMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# 内容严格来自Git对象；--worktree-attributes让本轮新增的export-ignore在提交前也可测试。
git -C "$ROOT" archive --worktree-attributes --format=tar --output="$TEMP_TAR" "$TREEISH"
gzip -n -c "$TEMP_TAR" > "$OUTPUT"
tar -tzf "$OUTPUT" > "$OUTPUT.manifest.txt"
shasum -a 256 "$OUTPUT" | awk -v name="$(basename -- "$OUTPUT")" '{print $1 "  " name}' > "$OUTPUT.sha256"

printf '源码包：%s\n清单：%s\nSHA-256：%s\n' "$OUTPUT" "$OUTPUT.manifest.txt" "$OUTPUT.sha256"
