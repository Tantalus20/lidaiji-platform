#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${LIDAIJI_COMMENTS_DATA:-$ROOT/.cache/comments-local}"
mkdir -p "$DATA"
export COMMENTS_DATA_DIR="$DATA"
export COMMENTS_DB="$DATA/comments.sqlite3"
export COMMENTS_HOST="127.0.0.1"
export COMMENTS_PORT="4317"
export COMMENTS_PUBLIC_ORIGIN="http://127.0.0.1:4317"
export COMMENTS_HMAC_SECRET="local-demo-secret-change-before-production-0001"
node --experimental-sqlite "$ROOT/comments-service/src/cli.js" migrate
printf '本地评论数据库已初始化：%s\n' "$COMMENTS_DB"
