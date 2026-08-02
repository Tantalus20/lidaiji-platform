#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" -eq 0 ]] || { printf '请使用sudo运行。\n' >&2; exit 1; }
SOURCE="${1:-/opt/writing-site/source}"
id lidaiji-comments >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin lidaiji-comments
install -d -o root -g lidaiji-comments -m 0750 /opt/lidaiji-comments/releases
install -d -o lidaiji-comments -g lidaiji-comments -m 0700 /var/lib/lidaiji-comments /var/backups/lidaiji-comments
install -o root -g root -m 0644 "$SOURCE/deploy/systemd/lidaiji-comments.service" /etc/systemd/system/lidaiji-comments.service
ENV_TEMPLATE="$SOURCE/comments-service/.env.example"
[[ -s "$ENV_TEMPLATE" ]] || {
  printf '缺少段评服务环境变量模板：%s\n' "$ENV_TEMPLATE" >&2
  exit 1
}
ENV_VALID=0
if [[ -s /etc/lidaiji-comments.env ]] \
  && grep -q '^COMMENTS_PUBLIC_ORIGIN=https://' /etc/lidaiji-comments.env \
  && awk -F= '/^COMMENTS_HMAC_SECRET=/{if (length(substr($0,index($0,"=")+1)) >= 32) ok=1} END{exit ok?0:1}' /etc/lidaiji-comments.env; then
  ENV_VALID=1
fi
if [[ "$ENV_VALID" != 1 ]]; then
  secret="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
  env_tmp="$(mktemp)"
  sed \
    -e "s|COMMENTS_PUBLIC_ORIGIN=https://example.invalid|COMMENTS_PUBLIC_ORIGIN=https://${WRITING_DOMAIN:?请设置WRITING_DOMAIN}|" \
    -e "s|replace-with-at-least-32-random-bytes|$secret|" \
    "$ENV_TEMPLATE" > "$env_tmp"
  install -o root -g root -m 0600 "$env_tmp" /etc/lidaiji-comments.env
  rm -f "$env_tmp"
fi
systemctl daemon-reload
printf '基础目录、独立用户和systemd单元已安装。\n'
printf '下一步：把 comments-locations.conf.template 内容加入文章站HTTPS server块，运行nginx -t后再发布。\n'
