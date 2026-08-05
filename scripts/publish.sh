#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
require_command scp
require_command ssh
require_command tar
require_command df
require_command python3
require_command git
require_command gzip

: "${WRITING_SSH_TARGET:?请设置 WRITING_SSH_TARGET，例如 root@服务器IP}"
: "${WRITING_DOMAIN:?请设置 WRITING_DOMAIN，例如 writing.example.com}"
if [[ ! "$WRITING_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf '错误：域名格式不正确。\n' >&2
  exit 1
fi

export SITE_BASE_URL="https://$WRITING_DOMAIN/"
WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" show --platform-root "$ROOT")"
CONTENT_REPO_ROOT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["contentRepoRoot"])' <<<"$WORKSPACE_JSON")"
CONTENT_ROOT="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["contentRoot"])' <<<"$WORKSPACE_JSON")"
python3 "$ROOT/scripts/publish-summary.py" --project-root "$CONTENT_REPO_ROOT" --content-root "$CONTENT_ROOT"
printf '本地磁盘空间：\n'
df -h "$ROOT"
"$ROOT/scripts/build.sh"
"$ROOT/scripts/backup.sh"

STAMP="$(date +%Y%m%d_%H%M%S)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/writing-publish.XXXXXX")"
RELEASE_ARCHIVE="$TMP/writing-release_$STAMP.tar.gz"
SOURCE_ARCHIVE="$TMP/writing-source_$STAMP.tar.gz"
COMMENTS_ARCHIVE="$TMP/lidaiji-comments_$STAMP.tar.gz"
cleanup() {
  rm -f "$RELEASE_ARCHIVE" "$SOURCE_ARCHIVE" "$COMMENTS_ARCHIVE" \
    "$SOURCE_ARCHIVE.manifest.txt" "$SOURCE_ARCHIVE.sha256" \
    "$COMMENTS_ARCHIVE.manifest.txt" "$COMMENTS_ARCHIVE.sha256"
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

# macOS bsdtar 默认会把扩展属性编码成 AppleDouble（._*）条目；正式静态包
# 必须明确关闭，避免把本机元数据带到 Linux release。
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$RELEASE_ARCHIVE" -C "$ROOT/dist/site" .
"$ROOT/scripts/create-source-package.sh" "$SOURCE_ARCHIVE" site
"$ROOT/scripts/create-source-package.sh" "$COMMENTS_ARCHIVE" comments
RELEASE_SHA="$(shasum -a 256 "$RELEASE_ARCHIVE" | awk '{print $1}')"
SOURCE_SHA="$(awk '{print $1}' "$SOURCE_ARCHIVE.sha256")"
COMMENTS_SHA="$(awk '{print $1}' "$COMMENTS_ARCHIVE.sha256")"

printf '即将发布到 %s，域名 %s。\n' "$WRITING_SSH_TARGET" "$WRITING_DOMAIN"
printf '不会重启或终止任何 Node、游戏、骰娘进程。\n'
if [[ "${WRITING_ASSUME_CONFIRM:-0}" != "1" ]]; then
  read -r -p '输入“发布”继续：' answer
  if [[ "$answer" != "发布" ]]; then
    printf '已取消。\n'
    exit 0
  fi
fi

printf '执行服务器发布前检查（磁盘、Nginx、当前release）……\n'
ssh "$WRITING_SSH_TARGET" \
  "df -h /opt /var 2>/dev/null || df -h /; sudo nginx -t; if [ -L /opt/writing-site/current ]; then test -f /opt/writing-site/current/index.html && test -f /opt/writing-site/current/404.html && test -f /opt/writing-site/current/search-index.json; fi"
scp "$RELEASE_ARCHIVE" "$SOURCE_ARCHIVE" "$COMMENTS_ARCHIVE" "$ROOT/scripts/server-publish.sh" "$WRITING_SSH_TARGET:/tmp/"
ssh "$WRITING_SSH_TARGET" sudo bash /tmp/server-publish.sh \
  --domain "$WRITING_DOMAIN" \
  --release "/tmp/$(basename "$RELEASE_ARCHIVE")" \
  --release-sha "$RELEASE_SHA" \
  --source "/tmp/$(basename "$SOURCE_ARCHIVE")" \
  --source-sha "$SOURCE_SHA" \
  --comments "/tmp/$(basename "$COMMENTS_ARCHIVE")" \
  --comments-sha "$COMMENTS_SHA" \
  --expected-commit "$(git rev-parse HEAD)" \
  ${WRITING_VERIFY_COS_BACKUP:+--verify-cos-backup} \
  ${COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE:+--allow-large-retire}

if ! python3 "$ROOT/scripts/publish-summary.py" --project-root "$CONTENT_REPO_ROOT" --content-root "$CONTENT_ROOT" --write; then
  printf '警告：网站已经发布，但本地发布摘要基线记录失败；下次会再次列出相关文章。\n' >&2
fi
printf '发布完成：https://%s/\n' "$WRITING_DOMAIN"
printf '若需回滚：ssh %s sudo /opt/writing-site/source/scripts/server-rollback.sh /opt/writing-site/releases/目标版本\n' "$WRITING_SSH_TARGET"
