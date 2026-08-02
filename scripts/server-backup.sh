#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/writing-site
BACKUPS=/var/backups/writing-site
mkdir -p "$BACKUPS"
test -d "$ROOT/source"
BEFORE="$(find "$BACKUPS" -maxdepth 1 -name 'writing-site-source_*.tar.gz' -print 2>/dev/null | sort | tail -1)"
WRITING_BACKUP_DIR="$BACKUPS" \
WRITING_CURRENT_RELEASE="$(readlink -f "$ROOT/current" 2>/dev/null || true)" \
  "$ROOT/source/scripts/backup.sh"
ARCHIVE="$(find "$BACKUPS" -maxdepth 1 -name 'writing-site-source_*.tar.gz' -print | sort | tail -1)"
[[ -n "$ARCHIVE" && "$ARCHIVE" != "$BEFORE" ]]
touch "$ARCHIVE.keep"
printf '服务器手动备份完成：%s\n' "$ARCHIVE"
