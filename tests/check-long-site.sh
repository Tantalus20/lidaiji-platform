#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/writing-long-site.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

rsync -a \
  --exclude '.git' \
  --exclude '.cache' \
  --exclude '.hugo-local' \
  --exclude '.venv-importer' \
  --exclude '.lidaiji-workspace.json' \
  --exclude 'dist' \
  --exclude 'public' \
  "$ROOT/" "$TMP/"
cp -R "$TMP/examples/demo-content" "$TMP/content"
mkdir -p "$TMP/data"
cp -R "$TMP/examples/demo-author-notes" "$TMP/data/author-notes"
node "$TMP/scripts/create-demo-content.mjs"
node "$TMP/scripts/create-demo-assets.mjs"
PYTHON="${WRITING_IMPORT_PYTHON:-$ROOT/.venv-importer/bin/python3}"
"$PYTHON" "$TMP/scripts/comments-prepare.py" \
  --project-root "$TMP" --write
(
  cd "$TMP"
  REQUIRE_DEMO_FIXTURES=1 \
    HUGO_BIN="${HUGO_BIN:-$(command -v hugo)}" \
    WRITING_IMPORT_PYTHON="$PYTHON" \
    LIDAIJI_CONTENT_REPO_ROOT="$TMP" \
    LIDAIJI_CONTENT_ROOT="$TMP/content" \
    LIDAIJI_AUTHOR_NOTES_ROOT="$TMP/data/author-notes" \
    LIDAIJI_SITE_OVERRIDES_ROOT="$TMP/examples/demo-site-overrides" \
    "$TMP/scripts/build.sh"
)
printf '三万字与十万字临时站点压力测试通过，正式content保持无演示稿。\n'
