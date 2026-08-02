#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ARCHIVE="${1:-}"
CONFIRM="${2:-}"
[[ -f "$ARCHIVE" ]] || { printf '用法：%s 备份.tar.gz --confirm\n' "$0" >&2; exit 2; }
[[ "$CONFIRM" == "--confirm" ]] || { printf '恢复会替换当前评论数据库；请追加 --confirm。\n' >&2; exit 2; }
COMMENTS_ROOT="${COMMENTS_ROOT:-/opt/lidaiji-comments/current}"
COMMENTS_DB="${COMMENTS_DB:-/var/lib/lidaiji-comments/comments.sqlite3}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-comments-restore.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP"
[[ -f "$TMP/comments.sqlite3" ]] || { printf '备份缺少SQLite数据库。\n' >&2; exit 1; }
COMMENTS_DB="$TMP/comments.sqlite3" node --experimental-sqlite "$COMMENTS_ROOT/src/cli.js" migrate >/dev/null
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('pragma integrity_check').get();if(r.integrity_check!=='ok')process.exit(1);d.close()" "$TMP/comments.sqlite3"
"$ROOT/scripts/comments-backup.sh"
if command -v systemctl >/dev/null 2>&1; then systemctl stop lidaiji-comments; fi
install -m 0600 -o "${COMMENTS_USER:-lidaiji-comments}" -g "${COMMENTS_GROUP:-lidaiji-comments}" "$TMP/comments.sqlite3" "$COMMENTS_DB"
if command -v systemctl >/dev/null 2>&1; then systemctl start lidaiji-comments; fi
printf '段评数据库已恢复，并已在替换前创建安全备份。\n'
