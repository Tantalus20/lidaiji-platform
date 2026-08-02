#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${LIDAIJI_COMMENTS_DATA:-$ROOT/.cache/comments-local}"
export COMMENTS_DATA_DIR="$DATA"
export COMMENTS_DB="$DATA/comments.sqlite3"
export COMMENTS_HOST="127.0.0.1"
export COMMENTS_PORT="4317"
export COMMENTS_PUBLIC_ORIGIN="http://127.0.0.1:4317"
export COMMENTS_HMAC_SECRET="local-demo-secret-change-before-production-0001"
read -r -s -p '输入本地测试管理员密码：' password
printf '\n'
[[ ${#password} -ge 12 ]] || { printf '密码至少12个字符。\n' >&2; exit 2; }
printf '%s\n' "$password" | node --experimental-sqlite "$ROOT/comments-service/src/cli.js" create-admin "${1:-demo-admin}"
