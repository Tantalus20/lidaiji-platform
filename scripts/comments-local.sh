#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
"$ROOT/scripts/build.sh"
DATA="$ROOT/.cache/comments-local"
mkdir -p "$DATA"
export COMMENTS_DATA_DIR="$DATA"
export COMMENTS_DB="$DATA/comments.sqlite3"
export COMMENTS_PUBLIC_ORIGIN="${COMMENTS_PUBLIC_ORIGIN:-http://127.0.0.1:4317}"
export COMMENTS_STATIC_DIR="$ROOT/dist/site"
export COMMENTS_HMAC_SECRET="${COMMENTS_HMAC_SECRET:-local-development-secret-32-bytes-minimum}"
node --experimental-sqlite "$ROOT/comments-service/src/cli.js" sync-manifest "$ROOT/dist/site/comment-manifest.json"
printf '本地网站与段评服务：http://127.0.0.1:4317\n'
printf '首次建立站主：printf \"你的长密码\" | COMMENTS_DB=%q node --experimental-sqlite comments-service/src/cli.js create-admin owner\n' "$COMMENTS_DB"
node --experimental-sqlite "$ROOT/comments-service/src/server.js"
