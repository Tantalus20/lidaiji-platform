#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DOMAIN="${1:-}"
OUTPUT="${2:-$ROOT/dist/writing-site.nginx.conf}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { printf '用法：%s writing.example.com [输出文件]\n' "$0" >&2; exit 2; }
mkdir -p "$(dirname "$OUTPUT")"
sed \
  -e "s/__WRITING_DOMAIN__/$DOMAIN/g" \
  -e "s|__CERT_FULLCHAIN__|/etc/letsencrypt/live/$DOMAIN/fullchain.pem|g" \
  -e "s|__CERT_KEY__|/etc/letsencrypt/live/$DOMAIN/privkey.pem|g" \
  "$ROOT/deploy/nginx/writing-site.conf.template" > "$OUTPUT"
printf 'Nginx配置已生成：%s\n' "$OUTPUT"

