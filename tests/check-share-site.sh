#!/usr/bin/env bash
# 分享站长文站临时构建检查：复制仓库到临时目录 → 生成演示分享内容 →
# 完整构建 → 输出契约 + 阅读工具 + git 隔离验证。
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/writing-share-site.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

rsync -a \
  --exclude '.git' \
  --exclude '.cache' \
  --exclude '.hugo-local' \
  --exclude '.venv-importer' \
  --exclude '.author-settings' \
  --exclude '.author-app' \
  --exclude 'dist' \
  --exclude 'public' \
  --exclude 'backups' \
  --exclude 'incoming' \
  --exclude 'resources' \
  --exclude 'node_modules' \
  --exclude 'packaging' \
  "$ROOT/" "$TMP/repo/"
cp "$ROOT/.hugo-local" "$TMP/repo/.hugo-local"
ln -s "$ROOT/.venv-importer" "$TMP/repo/.venv-importer"

"$ROOT/.venv-importer/bin/python" "$TMP/repo/scripts/create-share-demo-content.py" \
  --root "$TMP/share-private"

LIDAIJI_SHARE_CONTENT_ROOT="$TMP/share-private" \
  WRITING_IMPORT_PYTHON="$ROOT/.venv-importer/bin/python" \
  SHARE_OUT="$TMP/dist" \
  "$TMP/repo/scripts/build-share.sh"

# 分享内容绝不进入公开仓库：内容根在仓库外，git 无法跟踪
if [[ -d "$TMP/repo/.git" ]]; then
  if git -C "$TMP/repo" status --porcelain | grep -q .; then
    printf '错误：临时构建不应改动仓库工作区。\n' >&2
    exit 1
  fi
  if git -C "$TMP/repo" ls-files | grep -q 'lidaiji-share-private\|items/sh-'; then
    printf '错误：分享内容出现在 git 跟踪列表中。\n' >&2
    exit 1
  fi
fi
if find "$TMP/repo" -path '*/items/sh-*' | grep -q .; then
  printf '错误：分享内容目录出现在仓库内部。\n' >&2
  exit 1
fi

node "$ROOT/tests/check-share-reading.mjs" "$ROOT"
printf '分享站临时构建检查通过。\n'
