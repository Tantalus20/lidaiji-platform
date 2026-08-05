#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# 真实构建测试统一通过 HUGO_BIN 取用 Hugo。开发机通常使用仓库内的
# .hugo-local，持续集成环境则由安装动作把 hugo 放入 PATH。
if [[ -z "${HUGO_BIN:-}" ]]; then
  if [[ -x "$ROOT/.hugo-local" ]]; then
    export HUGO_BIN="$ROOT/.hugo-local"
  elif command -v hugo >/dev/null 2>&1; then
    HUGO_BIN="$(command -v hugo)"
    export HUGO_BIN
  fi
fi

node "$ROOT/tests/check-source.mjs"
node "$ROOT/tests/check-comment-button.mjs" "$ROOT"
node "$ROOT/tests/check-reading-ui.mjs" "$ROOT"
node "$ROOT/tests/check-reader-tools.mjs" "$ROOT"
node "$ROOT/tests/check-article-comments.mjs" "$ROOT"
node "$ROOT/tests/check-author-notes-build.mjs" "$ROOT"
node "$ROOT/tests/check-source-package.mjs" "$ROOT"
node "$ROOT/tests/check-scope-migration.mjs"
"$ROOT/tests/check-backup.sh"
"$ROOT/tests/check-backup-timeout.sh"
"$SCRIPT_DIR/check-importer.sh"
"$SCRIPT_DIR/check-studio.sh"
"$SCRIPT_DIR/check-macos-studio.sh"
"$SCRIPT_DIR/check-editor-bundle.sh"
node "$ROOT/tests/check-editor-markdown.mjs"
node "$ROOT/tests/check-editor-format.mjs"
node "$ROOT/scripts/smoke-studio.mjs" auto --edit "content/works/cloud-post-office/first-letter/index.md"
npm --prefix "$ROOT/comments-service" run check
node "$ROOT/tests/comments-performance.mjs"
"$SCRIPT_DIR/build.sh"
"$ROOT/tests/check-comments-backup.sh"
"$ROOT/tests/check-long-site.sh"
printf '全部自动检查通过。\n'
