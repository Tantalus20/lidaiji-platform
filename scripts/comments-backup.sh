#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_command node
require_command tar

COMMENTS_ROOT="${COMMENTS_ROOT:-/opt/lidaiji-comments/current}"
COMMENTS_BACKUP_DIR="${COMMENTS_BACKUP_DIR:-/var/backups/lidaiji-comments}"
COMMENTS_MANIFEST="${COMMENTS_MANIFEST:-/opt/writing-site/current/comment-manifest.json}"
mkdir -p "$COMMENTS_BACKUP_DIR"
[[ -w "$COMMENTS_BACKUP_DIR" ]] || { printf '评论备份目录不可写：%s\n' "$COMMENTS_BACKUP_DIR" >&2; exit 1; }
STAMP="$(date +%Y%m%d_%H%M%S)"
APP_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-comments-backup.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

node --experimental-sqlite "$COMMENTS_ROOT/src/cli.js" backup "$TMP/comments.sqlite3" >/dev/null
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('select max(version) version from schema_migrations').get();require('node:fs').writeFileSync(process.argv[2],JSON.stringify({schemaVersion:r.version,appVersion:process.argv[3],createdAt:new Date().toISOString()},null,2));d.close()" \
  "$TMP/comments.sqlite3" "$TMP/backup-metadata.json" "$APP_VERSION"
[[ -f "$COMMENTS_MANIFEST" ]] && cp "$COMMENTS_MANIFEST" "$TMP/comment-manifest.json"
cp "$ROOT/.env.example" "$TMP/config-template.env"
ARCHIVE="$COMMENTS_BACKUP_DIR/lidaiji-comments_v${APP_VERSION}_$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$TMP" .
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"; else shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"; fi
printf '段评备份完成：%s\n' "$ARCHIVE"
