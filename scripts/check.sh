#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
node "$ROOT/tests/check-source.mjs"
node "$ROOT/tests/check-comment-button.mjs" "$ROOT"
node "$ROOT/tests/check-reading-ui.mjs" "$ROOT"
node "$ROOT/tests/check-reader-tools.mjs" "$ROOT"
node "$ROOT/tests/check-article-comments.mjs" "$ROOT"
node "$ROOT/tests/check-author-notes-build.mjs" "$ROOT"
node "$ROOT/tests/check-source-package.mjs" "$ROOT"
node "$ROOT/tests/check-scope-migration.mjs"
"$ROOT/tests/check-backup.sh"
"$SCRIPT_DIR/check-importer.sh"
"$SCRIPT_DIR/check-studio.sh"
npm --prefix "$ROOT/comments-service" run check
node "$ROOT/tests/comments-performance.mjs"
"$SCRIPT_DIR/build.sh"
"$ROOT/tests/check-comments-backup.sh"
"$ROOT/tests/check-long-site.sh"
printf '全部自动检查通过。\n'
