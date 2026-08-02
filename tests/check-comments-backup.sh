#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-comments-recovery.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

export COMMENTS_ROOT="$ROOT/comments-service"
export COMMENTS_DB="$TMP/data/comments.sqlite3"
export COMMENTS_BACKUP_DIR="$TMP/backups"
export COMMENTS_MANIFEST="$ROOT/dist/site/comment-manifest.json"
export COMMENTS_IP_SECRET="recovery-test-ip-secret-with-32-bytes"
export COMMENTS_SESSION_SECRET="recovery-test-session-secret-32-bytes"
export COMMENTS_PUBLIC_ORIGIN="http://127.0.0.1:4317"
export COMMENTS_USER="$(id -un)"
export COMMENTS_GROUP="$(id -gn)"

node "$COMMENTS_ROOT/src/cli.js" migrate >/dev/null
node "$COMMENTS_ROOT/src/cli.js" sync-manifest "$COMMENTS_MANIFEST" >/dev/null

node - "$COMMENTS_DB" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
const article = db.prepare("SELECT article_id,current_revision FROM articles ORDER BY article_id LIMIT 1").get();
const paragraph = db.prepare("SELECT paragraph_id,text_excerpt FROM paragraphs WHERE article_id=? AND revision=? ORDER BY position LIMIT 1").get(article.article_id, article.current_revision);
const now = new Date().toISOString();
db.prepare(`INSERT INTO comments(
  id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,
  source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,approved_at,public_at
) VALUES(?,?,?,?,?,?,?,'approved','recovery','browser',0,'recovery-hash',?,?,?,?)`).run(
  "comment_recovery", article.article_id, article.current_revision, paragraph.paragraph_id,
  paragraph.text_excerpt, "恢复测试", "这是一条用于备份恢复演练的段评。", now, now, now, now,
);
db.close();
NODE

backup_output="$("$ROOT/scripts/comments-backup.sh")"
archive="${backup_output##*：}"
[[ -f "$archive" && -f "$archive.sha256" ]]
archive_mode="$(stat -f '%Lp' "$archive" 2>/dev/null || stat -c '%a' "$archive")"
[[ "$archive_mode" == "600" ]] || {
  printf '评论备份包权限不安全：%s（期望600）。\n' "$archive_mode" >&2
  exit 1
}

node - "$COMMENTS_DB" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
db.prepare("DELETE FROM comments WHERE id='comment_recovery'").run();
db.close();
NODE

"$ROOT/scripts/comments-restore.sh" "$archive" --confirm >/dev/null

node - "$COMMENTS_DB" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const restored = db.prepare("SELECT status,body FROM comments WHERE id='comment_recovery'").get();
if (integrity !== "ok" || restored?.status !== "approved" || !restored.body.includes("恢复演练")) process.exit(1);
db.close();
NODE

export_dir="$TMP/export"
"$ROOT/scripts/comments-export.sh" "$export_dir" >/dev/null
json="$export_dir/comments.json"
markdown="$export_dir/comments.md"
rg -q '"id": "comment_recovery"' "$json"
rg -q '恢复测试' "$markdown"
if rg -q 'source_fingerprint|browser_fingerprint|password_hash|session_hash' "$json" "$markdown"; then
  printf '公开导出包含内部安全字段。\n' >&2
  exit 1
fi

if tar -tzf "$archive" | rg -q '(^|/)(\.env|id_rsa|id_ed25519|node_modules|public)(/|$)'; then
  printf '段评备份包含不应进入备份包的内容。\n' >&2
  exit 1
fi

printf '段评备份、完整性恢复、JSON与Markdown导出演练通过。\n'
