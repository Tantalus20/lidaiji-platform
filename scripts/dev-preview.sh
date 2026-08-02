#!/usr/bin/env bash
# Kimi Work 本地预览入口：构建静态站后，由段评服务同源托管整站与段评 API。
# 通过 npm run dev -- --port 7100 --host 127.0.0.1 调用，转发 host/port 参数。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

HOST="127.0.0.1"
PORT="7100"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] || { printf '端口格式不正确。\n' >&2; exit 2; }

"$ROOT/scripts/build.sh"

DATA="$ROOT/.cache/comments-local"
mkdir -p "$DATA"
export COMMENTS_DATA_DIR="$DATA"
export COMMENTS_DB="$DATA/comments.sqlite3"
export COMMENTS_HOST="$HOST"
export COMMENTS_PORT="$PORT"
export COMMENTS_PUBLIC_ORIGIN="http://$HOST:$PORT"
export COMMENTS_STATIC_DIR="$ROOT/dist/site"
export COMMENTS_HMAC_SECRET="${COMMENTS_HMAC_SECRET:-local-development-secret-32-bytes-minimum}"
node --experimental-sqlite "$ROOT/comments-service/src/cli.js" sync-manifest "$ROOT/dist/site/comment-manifest.json"
printf '本地预览（含段评服务）：http://%s:%s\n' "$HOST" "$PORT"
exec node --experimental-sqlite "$ROOT/comments-service/src/server.js"
