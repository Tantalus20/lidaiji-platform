#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_command tar

BACKUP_DIR="${WRITING_BACKUP_DIR:-/var/backups/writing-site}"
STAMP="$(date +%Y%m%d_%H%M%S)"
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [[ ! -d "$BACKUP_DIR" || ! -w "$BACKUP_DIR" ]]; then
  printf '错误：备份目录不可写：%s\n可在Mac上设置 WRITING_BACKUP_DIR="$HOME/Documents/历代纪备份" 后重试。\n' "$BACKUP_DIR" >&2
  exit 1
fi
PLATFORM_ARCHIVE="$BACKUP_DIR/lidaiji-platform_$STAMP.tar.gz"
CONTENT_ARCHIVE="$BACKUP_DIR/lidaiji-content_$STAMP.tar.gz"

METADATA="$(mktemp -d "${TMPDIR:-/tmp}/writing-backup.XXXXXX")"
trap 'rm -rf "$METADATA"' EXIT
printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$METADATA/backup-metadata.txt"
if [[ -n "${WRITING_CURRENT_RELEASE:-}" ]]; then
  printf 'current_release=%s\n' "$WRITING_CURRENT_RELEASE" >> "$METADATA/backup-metadata.txt"
elif [[ -L "$ROOT/current" ]]; then
  printf 'current_release=%s\n' "$(readlink "$ROOT/current")" >> "$METADATA/backup-metadata.txt"
elif [[ -f "$ROOT/CURRENT_RELEASE" ]]; then
  printf 'current_release=%s\n' "$(cat "$ROOT/CURRENT_RELEASE")" >> "$METADATA/backup-metadata.txt"
else
  printf 'current_release=local-source\n' >> "$METADATA/backup-metadata.txt"
fi

INCLUDES=(config themes scripts docs archetypes static deploy importer incoming comments-service studio tools tests examples package.json package-lock.json README.md CHANGELOG.md VERSION PLATFORM_VERSION COMPONENTS.json LICENSE CONTENT-LICENSE.md SECURITY.md CONTRIBUTING.md)
EXISTING=()
for item in "${INCLUDES[@]}"; do
  [[ -e "$ROOT/$item" ]] && EXISTING+=("$item")
done
tar -czf "$PLATFORM_ARCHIVE" \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='*/node_modules' \
  --exclude='comments-service/data' \
  --exclude='*.sqlite3' \
  --exclude='*.sqlite3-*' \
  --exclude='*.docx' \
  --exclude='*.docm' \
  --exclude='*/.venv-importer' \
  --exclude='*/.DS_Store' \
  --exclude='*/id_rsa' \
  --exclude='*/id_ed25519' \
  --exclude='*.pem' \
  -C "$ROOT" "${EXISTING[@]}" -C "$METADATA" backup-metadata.txt
shasum -a 256 "$PLATFORM_ARCHIVE" > "$PLATFORM_ARCHIVE.sha256"

WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" show --platform-root "$ROOT")"
CONTENT_REPO_ROOT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["contentRepoRoot"])' <<<"$WORKSPACE_JSON")"
WORKSPACE_MODE="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["mode"])' <<<"$WORKSPACE_JSON")"
if [[ "$WORKSPACE_MODE" == "private" ]]; then
  CONTENT_INCLUDES=()
  for item in content data/author-notes site-overrides PRIVATE_CONTENT_VERSION README.md; do
    [[ -e "$CONTENT_REPO_ROOT/$item" ]] && CONTENT_INCLUDES+=("$item")
  done
  tar -czf "$CONTENT_ARCHIVE" \
    --exclude='*/.env' --exclude='*/.env.*' --exclude='*.sqlite3' --exclude='*.sqlite3-*' \
    --exclude='*.docx' --exclude='*.docm' --exclude='*/.DS_Store' --exclude='*/._*' \
    -C "$CONTENT_REPO_ROOT" "${CONTENT_INCLUDES[@]}"
  shasum -a 256 "$CONTENT_ARCHIVE" > "$CONTENT_ARCHIVE.sha256"
fi

if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" bundle create "$BACKUP_DIR/lidaiji-platform-git_$STAMP.bundle" --all
  git -C "$ROOT" rev-parse HEAD > "$BACKUP_DIR/lidaiji-platform-git_$STAMP.commit"
fi
if [[ "$WORKSPACE_MODE" == "private" ]] && git -C "$CONTENT_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$CONTENT_REPO_ROOT" bundle create "$BACKUP_DIR/lidaiji-content-git_$STAMP.bundle" --all
  git -C "$CONTENT_REPO_ROOT" rev-parse HEAD > "$BACKUP_DIR/lidaiji-content-git_$STAMP.commit"
fi

printf '平台源码备份完成：%s\n' "$PLATFORM_ARCHIVE"
printf '校验文件：%s.sha256\n' "$PLATFORM_ARCHIVE"
if [[ "$WORKSPACE_MODE" == "private" ]]; then
  printf '私人内容备份完成：%s\n' "$CONTENT_ARCHIVE"
  printf '校验文件：%s.sha256\n' "$CONTENT_ARCHIVE"
fi
