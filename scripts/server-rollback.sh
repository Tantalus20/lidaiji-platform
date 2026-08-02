#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/writing-site
COMMENTS_ROOT=/opt/lidaiji-comments
TARGET="${1:-}"
DOMAIN="${WRITING_DOMAIN:-}"
[[ -d "$TARGET" && "$TARGET" == "$ROOT/releases/"* ]] || {
  printf '用法：WRITING_DOMAIN=域名 %s /opt/writing-site/releases/时间戳\n' "$0" >&2
  exit 2
}
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { printf '请设置 WRITING_DOMAIN。\n' >&2; exit 2; }
[[ -f "$TARGET/index.html" && -f "$TARGET/comment-manifest.json" ]] || {
  printf '目标release不完整，缺少首页或段评清单。\n' >&2
  exit 2
}
[[ -f /etc/lidaiji-comments.env ]] || {
  printf '缺少/etc/lidaiji-comments.env，无法保证段评一致性。\n' >&2
  exit 2
}

[[ -L "$ROOT/current" && -e "$ROOT/current" ]] || { printf '当前静态release不存在。\n' >&2; exit 2; }
[[ -L "$COMMENTS_ROOT/current" && -e "$COMMENTS_ROOT/current" ]] || { printf '当前段评服务release不存在。\n' >&2; exit 2; }
CURRENT_BEFORE="$(readlink -f "$ROOT/current")"
COMMENTS_CURRENT_BEFORE="$(readlink -f "$COMMENTS_ROOT/current")"
TARGET_NAME="$(basename "$TARGET")"
COMMENTS_TARGET="$COMMENTS_ROOT/releases/$TARGET_NAME"
[[ -f "$COMMENTS_TARGET/src/cli.js" ]] || {
  printf '找不到与目标静态release对应的段评服务：%s\n' "$COMMENTS_TARGET" >&2
  exit 2
}

set -a
# shellcheck disable=SC1091
. /etc/lidaiji-comments.env
set +a
ROLLBACK_BACKUP="/var/backups/lidaiji-comments/pre-rollback_$(date +%Y%m%d_%H%M%S).sqlite3"
install -d -o lidaiji-comments -g lidaiji-comments -m 0700 "$(dirname "$ROLLBACK_BACKUP")"
runuser -u lidaiji-comments --preserve-environment -- \
  node --experimental-sqlite "$COMMENTS_CURRENT_BEFORE/src/cli.js" backup "$ROLLBACK_BACKUP" >/dev/null
chmod 0600 "$ROLLBACK_BACKUP"

restore_previous() {
  trap - ERR
  systemctl stop lidaiji-comments || true
  install -o lidaiji-comments -g lidaiji-comments -m 0600 "$ROLLBACK_BACKUP" "$COMMENTS_DB"
  ln -s "$COMMENTS_CURRENT_BEFORE" "$COMMENTS_ROOT/current.rollback"
  mv -Tf "$COMMENTS_ROOT/current.rollback" "$COMMENTS_ROOT/current"
  ln -s "$CURRENT_BEFORE" "$ROOT/current.rollback"
  mv -Tf "$ROOT/current.rollback" "$ROOT/current"
  systemctl start lidaiji-comments || true
}

rollback_on_error() {
  local code=$?
  restore_previous
  printf '回滚未完成，静态站、段评服务和数据库均已恢复。\n' >&2
  exit "$code"
}
trap rollback_on_error ERR

systemctl stop lidaiji-comments
runuser -u lidaiji-comments --preserve-environment -- \
  node --experimental-sqlite "$COMMENTS_TARGET/src/cli.js" migrate
runuser -u lidaiji-comments --preserve-environment -- \
  node --experimental-sqlite "$COMMENTS_TARGET/src/cli.js" sync-manifest "$TARGET/comment-manifest.json"
ln -s "$COMMENTS_TARGET" "$COMMENTS_ROOT/current.rollback"
mv -Tf "$COMMENTS_ROOT/current.rollback" "$COMMENTS_ROOT/current"
ln -s "$TARGET" "$ROOT/current.rollback"
mv -Tf "$ROOT/current.rollback" "$ROOT/current"
systemctl start lidaiji-comments
if ! curl -fsS http://127.0.0.1:4317/healthz | grep -q '"ok":true' \
  || ! curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" >/dev/null; then
  restore_previous
  printf '回滚目标健康检查失败，静态站、段评服务和数据库均已恢复。\n' >&2
  exit 1
fi
trap - ERR
printf '已一致回滚到：%s\n段评数据库安全备份：%s\n' "$TARGET" "$ROLLBACK_BACKUP"
