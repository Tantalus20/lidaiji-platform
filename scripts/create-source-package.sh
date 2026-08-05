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
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# 内容严格来自Git对象；--worktree-attributes让本轮新增的export-ignore在提交前也可测试。
git -C "$ROOT" archive --worktree-attributes --format=tar --output="$TEMP_TAR" "$TREEISH"
mkdir -p "$TEMP_DIR/unpack"
tar -xf "$TEMP_TAR" -C "$TEMP_DIR/unpack"

# BUILD_INFO（v0.5.1）：记录版本、sourceCommit、构建环境与组件元数据。
# 不含用户名、本机绝对路径、Token 或数据库路径。
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
COMPONENT_VERSION=""
ENTRYPOINT=""
MIGRATIONS=""
LOCKFILE_HASH=""
case "$COMPONENT" in
  site)
    COMPONENT_VERSION="$(cat "$ROOT/VERSION")"
    ENTRYPOINT="index.html"
    MIGRATIONS="-"
    LOCKFILE_HASH="$(git -C "$ROOT" rev-parse HEAD:package-lock.json 2>/dev/null || echo none)"
    ;;
  comments)
    COMPONENT_VERSION="$(python3 -c 'import json; print(json.load(open("'"$ROOT"'/comments-service/package.json"))["version"])')"
    ENTRYPOINT="src/server.js"
    MIGRATIONS="$(ls "$ROOT/comments-service/migrations" | grep -E '^[0-9]+.*\.sql$' | sort | tr '\n' ',' | sed 's/,$//')"
    LOCKFILE_HASH="$(git -C "$ROOT" rev-parse HEAD:comments-service/package-lock.json 2>/dev/null || echo none)"
    ;;
esac
{
  printf 'version: %s\n' "$COMPONENT_VERSION"
  printf 'sourceCommit: %s\n' "$SOURCE_COMMIT"
  printf 'buildTimestamp: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'nodeVersion: %s\n' "$(node --version 2>/dev/null || echo unknown)"
  printf 'packageManager: npm\n'
  printf 'lockfileHash: %s\n' "$LOCKFILE_HASH"
  printf 'entrypoint: %s\n' "$ENTRYPOINT"
  printf 'migrationVersions: %s\n' "$MIGRATIONS"
} > "$TEMP_DIR/unpack/BUILD_INFO"

# 打包前自检：候选不得包含绝对路径符号链接、失效符号链接、数据库或 .env。
if [[ "$COMPONENT" == "comments" ]]; then
  if find "$TEMP_DIR/unpack" -type l -print0 | xargs -0 -n1 readlink 2>/dev/null | grep -q '^/'; then
    printf '候选包含绝对路径符号链接。\n' >&2
    exit 2
  fi
  if find "$TEMP_DIR/unpack" -type l -print0 2>/dev/null | while IFS= read -r -d '' link; do
      target="$(readlink "$link")"
      case "$target" in
        /*) continue ;;
      esac
      [ -e "$(dirname "$link")/$target" ] || printf '%s\n' "$link"
    done | grep -q .; then
    printf '候选包含失效符号链接。\n' >&2
    exit 2
  fi
  if find "$TEMP_DIR/unpack" -type f \( -name '*.sqlite' -o -name '*.sqlite3' -o -name '.env' -o -name '*.env' \) | grep -q .; then
    printf '候选包含数据库或环境文件。\n' >&2
    exit 2
  fi
fi

# 重新打包（BUILD_INFO 已注入）；dotglob 使 * 覆盖隐藏文件，
# 条目不带 ./ 前缀，保持与 git archive 一致的结构。
(
  cd "$TEMP_DIR/unpack"
  shopt -s nullglob dotglob
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUTPUT" *
)
tar -tzf "$OUTPUT" > "$OUTPUT.manifest.txt"
shasum -a 256 "$OUTPUT" | awk -v name="$(basename -- "$OUTPUT")" '{print $1 "  " name}' > "$OUTPUT.sha256"

printf '源码包：%s\n清单：%s\nSHA-256：%s\n' "$OUTPUT" "$OUTPUT.manifest.txt" "$OUTPUT.sha256"
