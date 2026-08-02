#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
COMMENTS_ROOT="${COMMENTS_ROOT:-/opt/lidaiji-comments/current}"
OUTPUT="${1:-$ROOT/dist/comments-export}"
MODE="${2:-public}"
mkdir -p "$OUTPUT"
if [[ "$MODE" == "audit" ]]; then
  node --experimental-sqlite "$COMMENTS_ROOT/src/cli.js" export-json "$OUTPUT/comments.json" --audit
  node --experimental-sqlite "$COMMENTS_ROOT/src/cli.js" export-markdown "$OUTPUT/comments.md" --audit
else
  node --experimental-sqlite "$COMMENTS_ROOT/src/cli.js" export-json "$OUTPUT/comments.json"
  node --experimental-sqlite "$COMMENTS_ROOT/src/cli.js" export-markdown "$OUTPUT/comments.md"
fi
printf '段评导出完成：%s\n' "$OUTPUT"
