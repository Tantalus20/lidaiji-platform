#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/writing-backup-test.XXXXXX")"
SENSITIVE="$ROOT/.env.backup-test"
trap 'rm -rf "$TMP"; rm -f "$SENSITIVE"' EXIT
printf 'SHOULD_NOT_BE_BACKED_UP=1\n' > "$SENSITIVE"
LIDAIJI_WORKSPACE_MODE=demo \
  WRITING_BACKUP_DIR="$TMP" "$ROOT/scripts/backup.sh" >/dev/null
ARCHIVE="$(find "$TMP" -name 'lidaiji-platform_*.tar.gz' -print -quit)"
[[ -f "$ARCHIVE" ]]
LIST="$(tar -tzf "$ARCHIVE")"
grep -q 'examples/demo-content/' <<<"$LIST"
grep -q 'themes/' <<<"$LIST"
grep -q 'scripts/' <<<"$LIST"
grep -q 'docs/' <<<"$LIST"
grep -q 'importer/' <<<"$LIST"
grep -q 'comments-service/' <<<"$LIST"
grep -q 'backup-metadata.txt' <<<"$LIST"
if grep -Eq '(^|/)(\.env($|\.)|backups|node_modules|\.git|comments-service/data)(/|$)|\.sqlite3($|[-.])' <<<"$LIST"; then
  printf '错误：备份包含敏感或禁止目录。\n' >&2
  exit 1
fi
printf '备份隔离测试通过。\n'
