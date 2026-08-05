#!/usr/bin/env bash
# 历代纪每日异地备份（v0.5.1）
#
# 变更说明（相对 v0.5.0 之前的版本）：
#   1. 发布快照不再使用跟随符号链接的整目录复制（会对失效链接失败），
#      改为 tar 归档（不跟随符号链接）+ 文件级 SHA-256 校验清单；
#   2. SQLite 一致性备份增加 foreign_key_check 与 SHA-256；
#   3. COS 上传后执行远端校验：对象存在、大小一致、下载比对 SHA-256；
#   4. 成功/失败状态写入 /var/lib/lidaiji-monitor/backup-state/，
#      由 lidaiji_monitor.py 的 CHECK_BACKUP 检查并邮件告警；
#   5. 检测 release 中的绝对路径符号链接，记录到备份清单。
set -Eeuo pipefail

umask 077

COSCLI="/usr/local/bin/coscli"
COS_CONFIG="/root/.cos.yaml"
LOCK_FILE="/run/lock/lidaiji-cos-backup.lock"
STATE_DIR="/var/lib/lidaiji-monitor/backup-state"
FAILURE_MARKER="${STATE_DIR}/backup-failure.marker"
LAST_SUCCESS="${STATE_DIR}/backup-last-success"

[ -x "$COSCLI" ] || {
    echo "未找到可执行的 COSCLI：$COSCLI" >&2
    exit 1
}

[ -r "$COS_CONFIG" ] || {
    echo "COS 配置不存在或不可读：$COS_CONFIG" >&2
    exit 1
}

[ "$(stat -c '%a' "$COS_CONFIG")" = "600" ] || {
    echo "COS 配置权限必须为 600：$COS_CONFIG" >&2
    exit 1
}

exec 9>"$LOCK_FILE"
flock -n 9 || {
    echo "已有 COS 备份任务正在运行" >&2
    exit 1
}

HOST="$(hostname -s)"
STAMP="$(date '+%Y%m%d-%H%M%S')"
YEAR_MONTH="$(date '+%Y/%m')"
DAY_OF_MONTH="$(date '+%d')"

WORKDIR="$(mktemp -d /var/tmp/cos-backup.XXXXXX)"
ARCHIVE="${WORKDIR}/${HOST}-${STAMP}.tar.gz"
CHECKSUM="${ARCHIVE}.sha256"

cleanup() {
    case "$WORKDIR" in
        /var/tmp/cos-backup.*) rm -rf -- "$WORKDIR" ;;
        *) echo "拒绝清理非预期路径：$WORKDIR" >&2 ;;
    esac
}
trap cleanup EXIT

mkdir -p "$STATE_DIR"

fail_with_marker() {
    local stage="${1:-unknown}"
    local code="${2:-$?}"
    echo "[$(date -Is)] 备份失败：阶段=${stage} 错误码=${code}" >&2
    cat > "$FAILURE_MARKER" <<EOF
{"task":"lidaiji-backup","status":"failed","stage":"${stage}","errorCode":"${code}","time":"$(date -Is)"}
EOF
    chmod 0600 "$FAILURE_MARKER"
    exit "$code"
}

echo "[$(date -Is)] 开始生成备份"

mkdir -p "${WORKDIR}/sqlite-backups"

# 1) SQLite 一致性备份（.backup / VACUUM INTO 语义）+ 完整性 + 校验值。
mapfile -d '' DB_FILES < <(
    find /var/lib/lidaiji-comments -type f \
    \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) \
    ! -name '*-wal' ! -name '*-shm' ! -name '*.bak' \
    -print0
)

[ "${#DB_FILES[@]}" -gt 0 ] || {
    echo "没有找到需要备份的 SQLite 数据库" >&2
    fail_with_marker "database-scan" 2
}

for DB in "${DB_FILES[@]}"; do
    SAFE_NAME="$(printf '%s' "${DB#/}" | tr '/' '_')"
    DEST="${WORKDIR}/sqlite-backups/${SAFE_NAME}"

    echo "[$(date -Is)] 备份 SQLite：${DB}"
    sqlite3 "$DB" ".timeout 10000" ".backup '${DEST}'" || fail_with_marker "database-backup" $?
    INTEGRITY_RESULT="$(sqlite3 "$DEST" "PRAGMA integrity_check;")"
    [ "$INTEGRITY_RESULT" = "ok" ] || {
        echo "SQLite 一致性检查失败：${DB}" >&2
        fail_with_marker "database-integrity" 2
    }
    FK_RESULT="$(sqlite3 "$DEST" "PRAGMA foreign_key_check;")"
    if [ -n "$FK_RESULT" ]; then
        echo "SQLite 外键检查存在异常行（记录到清单，不阻断备份）：" >&2
        echo "$FK_RESULT" | head -5 >&2
    fi
    echo "$FK_RESULT" | wc -l | tr -d ' ' > "${DEST}.fk-lines"
    sha256sum "$DEST" > "${DEST}.sha256"
    echo "[$(date -Is)] PRAGMA integrity_check = ok：${DB}"
done

# 2) 发布快照：tar 归档（不跟随符号链接）+ 文件级校验清单。
#    仅归档与校验清单，绝不跟随符号链接；失效/绝对路径符号链接不再导致失败。
mkdir -p "${WORKDIR}/published-site" "${WORKDIR}/comments-release"
tar -czf "${WORKDIR}/published-site/site-current.tar.gz" -C /opt/writing-site current 2>/dev/null \
    || echo "警告：静态站快照生成不完整" >&2
tar -czf "${WORKDIR}/comments-release/comments-current.tar.gz" -C /opt/lidaiji-comments current 2>/dev/null \
    || echo "警告：评论服务快照生成不完整" >&2

# 文件级校验清单（不跟随符号链接；符号链接本身以文本记录）。
(cd /opt/writing-site/current && find . -type f -exec sha256sum {} + 2>/dev/null) \
    > "${WORKDIR}/published-site/site-files.sha256" || true
(cd /opt/writing-site/current && find . -type l -printf '%p -> %l\n' 2>/dev/null) \
    > "${WORKDIR}/published-site/site-symlinks.txt" || true
(cd /opt/lidaiji-comments/current && find . -type f -exec sha256sum {} + 2>/dev/null) \
    > "${WORKDIR}/comments-release/comments-files.sha256" || true
(cd /opt/lidaiji-comments/current && find . -type l -printf '%p -> %l\n' 2>/dev/null) \
    > "${WORKDIR}/comments-release/comments-symlinks.txt" || true

# 3) 绝对路径符号链接检测（记录，不阻断备份）。
ABS_LINKS=0
while IFS= read -r line; do
    case "$line" in
        *"-> /"*) ABS_LINKS=$((ABS_LINKS + 1)) ;;
    esac
done < "${WORKDIR}/published-site/site-symlinks.txt"
if [ "$ABS_LINKS" -gt 0 ]; then
    echo "警告：静态站 release 存在 $ABS_LINKS 个绝对路径符号链接（应修复，见 v0.5.1 修复记录）" >&2
fi

# incoming 只能存放未发布材料；content 中如出现 draft=true，也拒绝上传。
if find /opt/writing-site/source/incoming -type f ! -name '.DS_Store' ! -name '._*' -print -quit 2>/dev/null | grep -q .; then
    echo "检测到未发布 incoming 文件；该目录将被排除" >&2
fi

if grep -RIlE '^[[:space:]]*draft[[:space:]]*[:=][[:space:]]*true' /opt/writing-site/source/content >/dev/null 2>&1; then
    echo "检测到标记为 draft=true 的内容，拒绝上传以避免泄露未发布稿" >&2
    fail_with_marker "draft-content" 2
fi

# 4) 部署清单（版本、release 路径、migration 版本、快照校验值）。
MANIFEST="${WORKDIR}/backup-manifest.txt"
{
    echo "backup-created: $(date -Is)"
    echo "host: ${HOST}"
    echo "script-version: backup-to-cos-v0.5.1"
    if [ -e /opt/writing-site/current ]; then
        echo "site-release: $(readlink /opt/writing-site/current || true)"
    fi
    if [ -e /opt/lidaiji-comments/current ]; then
        echo "comments-release: $(readlink /opt/lidaiji-comments/current || true)"
    fi
    if [ -f /opt/writing-site/source/VERSION ]; then
        echo "site-version: $(head -n 1 /opt/writing-site/source/VERSION)"
    fi
    if [ -f /opt/lidaiji-comments/current/package.json ]; then
        echo "comments-version: $(jq -r .version /opt/lidaiji-comments/current/package.json 2>/dev/null || echo unknown)"
    fi
    if [ -f "${WORKDIR}/published-site/site-files.sha256" ]; then
        echo "site-files: $(wc -l < "${WORKDIR}/published-site/site-files.sha256") 个文件"
        echo "site-files.sha256: $(sha256sum "${WORKDIR}/published-site/site-files.sha256" | cut -d' ' -f1)"
    fi
    if [ -f "${WORKDIR}/comments-release/comments-files.sha256" ]; then
        echo "comments-files: $(wc -l < "${WORKDIR}/comments-release/comments-files.sha256") 个文件"
        echo "comments-files.sha256: $(sha256sum "${WORKDIR}/comments-release/comments-files.sha256" | cut -d' ' -f1)"
    fi
    for DB_BACKUP in "${WORKDIR}"/sqlite-backups/*.sqlite3; do
        [ -e "$DB_BACKUP" ] || continue
        FK_LINES="$(cat "${DB_BACKUP}.fk-lines" 2>/dev/null || echo 0)"
        echo "sqlite: $(basename "$DB_BACKUP") schema-migrations: $(sqlite3 "$DB_BACKUP" 'SELECT group_concat(version) FROM schema_migrations;' 2>/dev/null || echo unknown) fk-violations: ${FK_LINES} sha256: $(cut -d' ' -f1 "${DB_BACKUP}.sha256")"
    done
} > "$MANIFEST"

# 5) 只加入实际存在的路径（配置/unit/源树，明确白名单）。
CANDIDATES=(
    "opt/writing-site/source"
    "etc/nginx/conf.d/writing-site.conf"
    "etc/systemd/system/lidaiji-comments.service"
    "etc/systemd/system/cos-backup.service"
    "etc/systemd/system/cos-backup.timer"
    "etc/ssh/sshd_config"
    "etc/pam.d/sshd"
    "usr/local/sbin/backup-to-cos.sh"
)

INCLUDE_PATHS=()

for ITEM in "${CANDIDATES[@]}"; do
    if [ -e "/${ITEM}" ]; then
        INCLUDE_PATHS+=("${ITEM}")
    fi
done

if [ "${#INCLUDE_PATHS[@]}" -eq 0 ]; then
    echo "没有找到可备份目录" >&2
    fail_with_marker "candidates" 2
fi

tar \
    --exclude='opt/writing-site/source/incoming' \
    --exclude='opt/writing-site/source/.git' \
    --exclude='opt/writing-site/source/node_modules' \
    --exclude='opt/writing-site/source/.venv-importer' \
    --exclude='opt/writing-site/source/public' \
    --exclude='opt/writing-site/source/resources' \
    --exclude='opt/writing-site/source/.cache' \
    --exclude='opt/writing-site/source/.author-settings' \
    --exclude='opt/writing-site/source/.author-settings.*' \
    --exclude='.env' \
    --exclude='*/.env' \
    --exclude='*.pem' \
    --exclude='*.key' \
    --exclude='._*' \
    --exclude='*/._*' \
    -czf "$ARCHIVE" \
    -C / "${INCLUDE_PATHS[@]}" \
    -C "$WORKDIR" sqlite-backups published-site comments-release backup-manifest.txt

tar -tzf "$ARCHIVE" >/dev/null || fail_with_marker "archive-verify" 2

if tar -tzf "$ARCHIVE" | grep -Eq '(^|/)(ssh_host_.*_key|\.env|incoming)(/|$)'; then
    echo "备份包安全检查失败：包含禁止上传的敏感路径" >&2
    fail_with_marker "security-scan" 2
fi

(
    cd "$WORKDIR"
    sha256sum "$(basename "$ARCHIVE")" > "$(basename "$CHECKSUM")"
)

LOCAL_SHA="$(cut -d' ' -f1 "$CHECKSUM")"
ARCHIVE_SIZE="$(stat -c '%s' "$ARCHIVE")"

if [ "${COS_BACKUP_VALIDATE_ONLY:-0}" = "1" ]; then
    echo "[$(date -Is)] 本地生成与安全校验完成（验证模式，不上传 COS）"
    echo "archive-sha256: $LOCAL_SHA"
    echo "archive-size: $ARCHIVE_SIZE"
    exit 0
fi

DAILY_DEST="cos://backup/server-backups/daily/${YEAR_MONTH}"

echo "[$(date -Is)] 上传日备份"
"$COSCLI" cp "$ARCHIVE" "${DAILY_DEST}/$(basename "$ARCHIVE")" || fail_with_marker "cos-upload" $?
"$COSCLI" cp "$CHECKSUM" "${DAILY_DEST}/$(basename "$CHECKSUM")" || fail_with_marker "cos-upload-checksum" $?

# 6) 远端校验：对象存在、大小一致、下载比对 SHA-256。
echo "[$(date -Is)] 远端校验开始"
REMOTE_LISTING="$("$COSCLI" ls "${DAILY_DEST}/$(basename "$ARCHIVE")" 2>/dev/null || true)"
if [ -z "$REMOTE_LISTING" ]; then
    echo "远端对象不存在：${DAILY_DEST}/$(basename "$ARCHIVE")" >&2
    fail_with_marker "cos-object-missing" 3
fi
REMOTE_CHECK="$("$COSCLI" cp "${DAILY_DEST}/$(basename "$CHECKSUM")" "${WORKDIR}/remote.sha256" >/dev/null 2>&1 && cut -d' ' -f1 "${WORKDIR}/remote.sha256")"
if [ "$REMOTE_CHECK" != "$LOCAL_SHA" ]; then
    echo "远端校验值不一致：$REMOTE_CHECK vs $LOCAL_SHA" >&2
    fail_with_marker "cos-checksum-mismatch" 3
fi
REMOTE_ARCHIVE="${WORKDIR}/remote.tar.gz"
"$COSCLI" cp "${DAILY_DEST}/$(basename "$ARCHIVE")" "$REMOTE_ARCHIVE" || fail_with_marker "cos-download" $?
REMOTE_SHA="$(sha256sum "$REMOTE_ARCHIVE" | cut -d' ' -f1)"
REMOTE_SIZE="$(stat -c '%s' "$REMOTE_ARCHIVE")"
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
    echo "远端下载内容不一致：$REMOTE_SHA vs $LOCAL_SHA" >&2
    fail_with_marker "cos-content-mismatch" 3
fi
if [ "$REMOTE_SIZE" != "$ARCHIVE_SIZE" ]; then
    echo "远端大小不一致：$REMOTE_SIZE vs $ARCHIVE_SIZE" >&2
    fail_with_marker "cos-size-mismatch" 3
fi
echo "[$(date -Is)] 远端校验成功：大小=${ARCHIVE_SIZE} sha256=${LOCAL_SHA}"

# 每月1日额外保留一份月备份。
if [ "$DAY_OF_MONTH" = "01" ]; then
    MONTHLY_DEST="cos://backup/server-backups/monthly/$(date '+%Y')"

    echo "[$(date -Is)] 上传月备份"
    "$COSCLI" cp "$ARCHIVE" "${MONTHLY_DEST}/$(basename "$ARCHIVE")" || fail_with_marker "cos-upload-monthly" $?
    "$COSCLI" cp "$CHECKSUM" "${MONTHLY_DEST}/$(basename "$CHECKSUM")" || fail_with_marker "cos-upload-monthly-checksum" $?
    echo "[$(date -Is)] 月备份上传成功"
fi

# 7) 成功状态：清理失败标记，记录最近成功时间。
rm -f "$FAILURE_MARKER"
echo "$(date -Is)" > "$LAST_SUCCESS"
chmod 0600 "$LAST_SUCCESS"

echo "[$(date -Is)] 备份完成：$(basename "$ARCHIVE")"
