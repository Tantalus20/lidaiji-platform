#!/usr/bin/env bash
# 历代纪每日异地备份（v0.5.3 —— 归档缺陷修复候选）
#
# v0.5.3 修复（对应隔离恢复演练结论 C）：
#   1. 根因：v0.5.1 以 `tar -C <root> current` 归档符号链接本身（未解引用），
#      site/comments 归档只包含 current 链接；文件级 SHA 清单却从在线目录生成，
#      造成"清单正确、归档错误"。本版改为：
#        a. 备份开始时解析并锁定 current 的真实 release（目录校验 + 白名单 + fail closed）；
#        b. 复制受控快照（snapshot/）后只对快照打包与生成清单；
#        c. 上传前对归档解压复验：从解压内容重新生成清单并与快照清单逐文件比较。
#   2. 快照内出现任何符号链接 → fail closed（release 现状内部零符号链接）。
#   3. 清单升级为 JSON schemaVersion 2，archivePayloadVerified=true 表示
#      该归档已通过解压逐文件复验；旧 schema v1 备份不得视为完整。
#   4. 原子生成（*.tmp → mv）、单实例锁（原子 mkdir + PID 陈旧检测）、状态机日志。
#
# 兼容：所有生产路径可用环境变量覆盖（默认生产值），测试用虚构目录运行。
set -Eeuo pipefail

umask 077

COSCLI="${COSCLI:-/usr/local/bin/coscli}"
COS_CONFIG="${COS_CONFIG:-/root/.cos.yaml}"
LOCK_FILE="${LOCK_FILE:-/run/lock/lidaiji-cos-backup.lock}"
STATE_DIR="${STATE_DIR:-/var/lib/lidaiji-monitor/backup-state}"
FAILURE_MARKER="${STATE_DIR}/backup-failure.marker"
LAST_SUCCESS="${STATE_DIR}/backup-last-success"
LAST_VERIFY="${STATE_DIR}/backup-last-verify.json"

SITE_ROOT="${SITE_ROOT:-/opt/writing-site}"
COMMENTS_ROOT="${COMMENTS_ROOT:-/opt/lidaiji-comments}"
COMMENTS_DATA_DIR="${COMMENTS_DATA_DIR:-/var/lib/lidaiji-comments}"
SRC_ROOT="${SRC_ROOT:-${SITE_ROOT}}"
WORKDIR_BASE="${WORKDIR_BASE:-/var/tmp}"
BACKUP_KEEP_DIR="${BACKUP_KEEP_DIR:-}"
# 测试专用延迟钩子（生产默认 0）：分别位于 快照完成/清单完成/归档生成 之后。
TEST_HOOK_SNAPSHOT="${BACKUP_TEST_HOOK_DELAY_S:-0}"
TEST_HOOK_MANIFEST="${BACKUP_TEST_HOOK_DELAY_2_S:-0}"
TEST_HOOK_ARCHIVE="${BACKUP_TEST_HOOK_DELAY_3_S:-0}"

SCRIPT_VERSION="backup-to-cos-v0.5.3"
RELEASE_ID_RE='^[0-9]{8}_[0-9]{6}$'

# GNU/BSD 可移植封装（服务器为 GNU coreutils，本机构建环境可为 BSD）
date_iso() { date -Is 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S%z'; }
# timeout 为 GNU coreutils 命令；无 timeout 的环境（如 macOS 构建机）直接执行。
run_timeout() {
    local secs="$1"
    shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$secs" "$@"
    else
        "$@"
    fi
}
stat_perms() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
stat_size() { stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1"; }

# ---------------------------------------------------------------------------
# 状态机与错误处理
# ---------------------------------------------------------------------------

STATE_LOG="${STATE_DIR}/backup-state.log"
log_state() {
    echo "[$(date_iso)] STATE=${1}${2:+ ${2}}" | tee -a "$STATE_LOG"
}

log_msg() {
    echo "[$(date_iso)] $1" | tee -a "$STATE_LOG"
}

RUN_MODE="${RUN_MODE:-full}"

fail_with_marker() {
    local stage="${1:-unknown}"
    local code="${2:-$?}"
    local upload_performed="false"
    if [ "$RUN_MODE" = "full" ] && [ -f "$WORKDIR/upload-started.marker" ]; then
        upload_performed="true"
    fi
    log_msg "备份失败：阶段=${stage} 错误码=${code} mode=${RUN_MODE}"
    cat > "$FAILURE_MARKER" <<EOF
{"task":"lidaiji-backup","status":"failed","stage":"${stage}","errorCode":"${code}","time":"$(date_iso)","mode":"${RUN_MODE}","failedStage":"${stage}","remoteUploadPerformed":${upload_performed}}
EOF
    chmod 0600 "$FAILURE_MARKER"
    if [ "$RUN_MODE" = "validate-only" ]; then
        log_state "VALIDATE_ONLY_FAILED" "stage=${stage}"
    elif [ "$RUN_MODE" = "verify-only" ]; then
        log_state "VERIFY_ONLY_FAILED" "stage=${stage}"
    else
        log_state "BACKUP_FAILED" "stage=${stage}"
    fi
    exit "$code"
}

# ---------------------------------------------------------------------------
# current 解析与 release 校验（fail closed）
# ---------------------------------------------------------------------------

resolve_current() {
    # $1 = 根目录（SITE_ROOT / COMMENTS_ROOT）  $2 = 名称（site/comments）
    local root="$1" name="$2"
    local link="$root/current"
    local real
    if [ ! -L "$link" ] && [ ! -d "$link" ]; then
        fail_with_marker "current-missing-${name}" 2
    fi
    real="$(readlink -f "$link" 2>/dev/null || true)"
    if [ -z "$real" ] || [ ! -d "$real" ]; then
        fail_with_marker "current-broken-${name}" 2
    fi
    local releases_root
    releases_root="$(readlink -f "$root/releases" 2>/dev/null || true)"
    if [ -z "$releases_root" ]; then
        fail_with_marker "releases-missing-${name}" 2
    fi
    case "$real" in
        "$releases_root"/*) : ;;
        *) fail_with_marker "current-outside-${name}" 2 ;;
    esac
    local rel
    rel="${real#"$releases_root"/}"
    case "$rel" in
        */*|*/) fail_with_marker "current-depth-${name}" 2 ;;
    esac
    if ! [[ "$rel" =~ $RELEASE_ID_RE ]]; then
        fail_with_marker "current-format-${name}" 2
    fi
    printf '%s' "$rel"
}

# ---------------------------------------------------------------------------
# 辅助：快照文件清单
# ---------------------------------------------------------------------------

make_file_manifest() {
    # $1 = 快照目录（site/comments）  $2 = 输出清单路径
    local dir="$1" out="$2"
    (cd "$dir" && find . -type f -exec sha256sum {} + 2>/dev/null) | LC_ALL=C sort > "$out"
}

count_files() {
    wc -l < "$1" | tr -d ' '
}

total_bytes() {
    local dir="$1" f total=0
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        total=$((total + $(stat_size "$f" 2>/dev/null || echo 0)))
    done < <(find "$dir" -type f 2>/dev/null)
    printf '%s' "$total"
}

scan_symlinks() {
    find "$1" -type l 2>/dev/null | wc -l | tr -d ' '
}

required_files_present() {
    # $1 = 快照目录（site 或 comments）；返回缺失数
    local dir="$1" missing=0
    [ -f "$dir/BUILD_INFO" ] || missing=$((missing + 1))
    [ -f "$dir/index.html" ] || missing=$((missing + 1))
    [ -f "$dir/index.xml" ] || missing=$((missing + 1))
    [ -f "$dir/sitemap.xml" ] || missing=$((missing + 1))
    [ -f "$dir/comment-manifest.json" ] || missing=$((missing + 1))
    [ -d "$dir/archives" ] || missing=$((missing + 1))
    if [ "$(find "$dir/essays" "$dir/works" -name 'index.html' -type f 2>/dev/null | wc -l | tr -d ' ')" -eq 0 ]; then
        missing=$((missing + 1))
    fi
    printf '%s' "$missing"
}

# ---------------------------------------------------------------------------
# 独立验证模式：对已有归档执行解压复验（不创建新备份、不需要 COS 配置）
# 用法：BACKUP_VERIFY_ONLY=<归档路径> deploy/backup/backup-to-cos.sh
# ---------------------------------------------------------------------------

verify_existing_archive() {
    local archive="$1"
    local vdir code=0
    RUN_MODE="verify-only"
    log_state "VERIFY_ONLY_STARTED"
    vdir="$(mktemp -d "$WORKDIR_BASE/cos-verify.XXXXXX")"
    if [ ! -s "$archive" ]; then
        echo "归档不存在或为空：$archive" >&2
        code=1
    elif tar -tzf "$archive" | grep -qE '(^|/)\.\.(/|$)|^/'; then
        echo "归档成员含绝对路径或路径穿越" >&2
        code=1
    elif ! tar -xzf "$archive" -C "$vdir" 2>/dev/null; then
        echo "归档解压失败" >&2
        code=1
    else
        if [ ! -f "$vdir/manifests/site-files.sha256" ] || [ ! -f "$vdir/manifests/comments-files.sha256" ]; then
            echo "归档缺少文件清单（非 v0.5.3 完整备份？）" >&2
            code=1
        else
            make_file_manifest "$vdir/snapshot/site" "$vdir/verify-site.sha256"
            make_file_manifest "$vdir/snapshot/comments" "$vdir/verify-comments.sha256"
            if ! diff -q "$vdir/manifests/site-files.sha256" "$vdir/verify-site.sha256" >/dev/null 2>&1; then
                echo "站点清单与归档内容不一致" >&2
                code=1
            fi
            if ! diff -q "$vdir/manifests/comments-files.sha256" "$vdir/verify-comments.sha256" >/dev/null 2>&1; then
                echo "评论清单与归档内容不一致" >&2
                code=1
            fi
            if [ "$(required_files_present "$vdir/snapshot/site")" -gt 0 ]; then
                echo "站点缺少必要文件" >&2
                code=1
            fi
            if [ -f "$vdir/manifests/backup-manifest.json" ]; then
                python3 - "$vdir/manifests/backup-manifest.json" <<'PYEOT' || code=1
import json, sys
m = json.load(open(sys.argv[1]))
assert m.get("schemaVersion") == 2, "schemaVersion 必须为 2"
assert m.get("archivePayloadVerified") is True, "archivePayloadVerified 必须为 true"
PYEOT
            else
                echo "归档缺少 backup-manifest.json（旧版备份，不得视为完整）" >&2
                code=1
            fi
        fi
    fi
    rm -rf -- "$vdir"
    if [ "$code" -eq 0 ]; then
        echo "VERIFY_OK"
        log_state "VERIFY_ONLY_DONE"
    else
        echo "VERIFY_FAILED" >&2
    fi
    exit "$code"
}

if [ -n "${BACKUP_VERIFY_ONLY:-}" ]; then
    verify_existing_archive "$BACKUP_VERIFY_ONLY"
fi

# ---------------------------------------------------------------------------
# 备份主流程
# ---------------------------------------------------------------------------

[ -x "$COSCLI" ] || { echo "未找到可执行的 COSCLI：$COSCLI" >&2; exit 1; }
[ -r "$COS_CONFIG" ] || { echo "COS 配置不存在或不可读：$COS_CONFIG" >&2; exit 1; }
[ "$(stat_perms "$COS_CONFIG")" = "600" ] || { echo "COS 配置权限必须为 600：$COS_CONFIG" >&2; exit 1; }

# 单实例锁（可移植：原子 mkdir + PID 记录；陈旧锁按活动进程检测清理）
LOCK_DIR="${LOCK_FILE}.d"

acquire_lock() {
    local attempts=0 pid=""
    while [ "$attempts" -lt 3 ]; do
        if mkdir "$LOCK_DIR" 2>/dev/null; then
            echo "$$ $(date_iso)" > "$LOCK_DIR/info" 2>/dev/null || true
            return 0
        fi
        pid=""
        if [ -f "$LOCK_DIR/info" ]; then
            pid="$(cut -d' ' -f1 "$LOCK_DIR/info" 2>/dev/null || true)"
        fi
        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
            rm -rf "$LOCK_DIR" 2>/dev/null || true
            attempts=$((attempts + 1))
            continue
        fi
        echo "已有 COS 备份任务正在运行（pid=${pid:-unknown}）" >&2
        exit 1
    done
    echo "锁获取重试失败（陈旧锁无法清理）" >&2
    exit 1
}

release_lock() {
    rm -rf "$LOCK_DIR" 2>/dev/null || true
}

HOST="$(hostname -s)"
STAMP="$(date '+%Y%m%d-%H%M%S')"
YEAR_MONTH="$(date '+%Y/%m')"
DAY_OF_MONTH="$(date '+%d')"
BACKUP_ID="${HOST}-${STAMP}"

WORKDIR="$(mktemp -d "$WORKDIR_BASE/cos-backup.XXXXXX")"
ARCHIVE="${WORKDIR}/${BACKUP_ID}.tar.gz"
CHECKSUM="${ARCHIVE}.sha256"
SNAPSHOT="${WORKDIR}/snapshot"
VERIFY_DIR="${WORKDIR}/verify"
mkdir -p "$SNAPSHOT" "$VERIFY_DIR"

cleanup() {
    case "$WORKDIR" in
        "$WORKDIR_BASE"/cos-backup.*) rm -rf -- "$WORKDIR" ;;
        *) echo "拒绝清理非预期路径：$WORKDIR" >&2 ;;
    esac
    release_lock
}
trap cleanup EXIT

mkdir -p "$STATE_DIR"
acquire_lock

log_msg "开始生成备份 backupId=${BACKUP_ID}"

# -- 1) 解析并锁定 current（一次锁定，全程使用） -------------------------
SITE_RELEASE="$(resolve_current "$SITE_ROOT" site)"
COMMENTS_RELEASE="$(resolve_current "$COMMENTS_ROOT" comments)"
log_msg "锁定 release：site=${SITE_RELEASE} comments=${COMMENTS_RELEASE}"

# -- 2) SQLite 一致性备份（沿用 v0.5.1 已有效实现） ----------------------
mkdir -p "${WORKDIR}/sqlite-backups"
DB_FILES=()
while IFS= read -r -d '' DB; do
    DB_FILES+=("$DB")
done < <(
    find "$COMMENTS_DATA_DIR" -type f \
        \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) \
        ! -name '*-wal' ! -name '*-shm' ! -name '*.bak' \
        -print0
)
[ "${#DB_FILES[@]}" -gt 0 ] || fail_with_marker "database-scan" 2
for DB in "${DB_FILES[@]}"; do
    SAFE_NAME="$(printf '%s' "${DB#/}" | tr '/' '_')"
    DEST="${WORKDIR}/sqlite-backups/${SAFE_NAME}"
    log_msg "备份 SQLite：${DB}"
    sqlite3 "$DB" ".timeout 10000" ".backup '${DEST}'" || fail_with_marker "database-backup" $?
    INTEGRITY_RESULT="$(sqlite3 "$DEST" "PRAGMA integrity_check;")"
    [ "$INTEGRITY_RESULT" = "ok" ] || fail_with_marker "database-integrity" 2
    FK_RESULT="$(sqlite3 "$DEST" "PRAGMA foreign_key_check;")" || true
    if [ -n "$FK_RESULT" ]; then
        log_msg "外键检查存在异常行（记录到清单，不阻断备份）"
    fi
    echo "$FK_RESULT" | wc -l | tr -d ' ' > "${DEST}.fk-lines"
    sha256sum "$DEST" > "${DEST}.sha256"
done

# -- 3) 受控快照（只从锁定 release 复制，随后只对快照打包与校验） --------
log_state "SNAPSHOT_START"
cp -a "$SITE_ROOT/releases/$SITE_RELEASE/." "$SNAPSHOT/site/"
cp -a "$COMMENTS_ROOT/releases/$COMMENTS_RELEASE/." "$SNAPSHOT/comments/"

# 内部符号链接策略：release 现状内部零符号链接 → 出现任何链接即 fail closed。
if [ "$(scan_symlinks "$SNAPSHOT")" -gt 0 ]; then
    log_msg "快照内发现符号链接，拒绝备份（release 内部不允许符号链接）"
    fail_with_marker "snapshot-symlink" 2
fi

[ "$TEST_HOOK_SNAPSHOT" -gt 0 ] 2>/dev/null && sleep "$TEST_HOOK_SNAPSHOT"
log_state "SNAPSHOT_CREATED" "site=${SITE_RELEASE} comments=${COMMENTS_RELEASE}"

# -- 4) 快照清单（清单必须来自快照，而非在线目录） ------------------------
make_file_manifest "$SNAPSHOT/site" "${WORKDIR}/site-files.sha256"
make_file_manifest "$SNAPSHOT/comments" "${WORKDIR}/comments-files.sha256"
SITE_COUNT="$(count_files "${WORKDIR}/site-files.sha256")"
COMMENTS_COUNT="$(count_files "${WORKDIR}/comments-files.sha256")"
SITE_BYTES="$(total_bytes "$SNAPSHOT/site")"
COMMENTS_BYTES="$(total_bytes "$SNAPSHOT/comments")"

if [ "$(required_files_present "$SNAPSHOT/site")" -gt 0 ]; then
    fail_with_marker "site-required-files" 2
fi
COMMENTS_REQUIRED_MISSING=0
for f in package.json src/server.js BUILD_INFO; do
    [ -f "$SNAPSHOT/comments/$f" ] || COMMENTS_REQUIRED_MISSING=$((COMMENTS_REQUIRED_MISSING + 1))
done
[ -d "$SNAPSHOT/comments/migrations" ] || COMMENTS_REQUIRED_MISSING=$((COMMENTS_REQUIRED_MISSING + 1))
if [ "$COMMENTS_REQUIRED_MISSING" -gt 0 ]; then
    fail_with_marker "comments-required-files" 2
fi

SITE_VERSION="$(grep -m1 '^version:' "$SNAPSHOT/site/BUILD_INFO" 2>/dev/null | awk '{print $2}' || echo unknown)"
SITE_SOURCE_COMMIT="$(grep -m1 '^sourceCommit:' "$SNAPSHOT/site/BUILD_INFO" 2>/dev/null | awk '{print $2}' || echo unknown)"
COMMENTS_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","unknown"))' "$SNAPSHOT/comments/package.json" 2>/dev/null || echo unknown)"
SCRIPT_GIT_SHA="$(git -C "$SRC_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

# 安全摘要：路径本身不上传，仅记录摘要用于审计一致性。
SITE_PATH_SHA="$(printf '%s' "$SITE_ROOT/releases/$SITE_RELEASE" | sha256sum | cut -d' ' -f1)"
COMMENTS_PATH_SHA="$(printf '%s' "$COMMENTS_ROOT/releases/$COMMENTS_RELEASE" | sha256sum | cut -d' ' -f1)"

MANIFEST="${WORKDIR}/backup-manifest.json"
{
    echo "{"
    echo "  \"schemaVersion\": 2,"
    echo "  \"archivePayloadVerified\": true,"
    # 归档内 mode 在快照时即确定；远端完成真相以状态记录
    # （STATE_DIR/backup-last-verify.json）为准——full 模式的远端字段在快照时未知，不写入。
    if [ "${COS_BACKUP_VALIDATE_ONLY:-0}" = "1" ]; then
        echo "  \"mode\": \"validate-only\","
        echo "  \"remoteUploadPerformed\": false,"
        echo "  \"remoteVerified\": false,"
        echo "  \"backupComplete\": false,"
    else
        echo "  \"mode\": \"full\","
    fi
    echo "  \"backupId\": \"${BACKUP_ID}\","
    echo "  \"createdAt\": \"$(date_iso)\","
    echo "  \"host\": \"${HOST}\","
    echo "  \"scriptVersion\": \"${SCRIPT_VERSION}\","
    echo "  \"scriptGitSha\": \"${SCRIPT_GIT_SHA}\","
    echo "  \"siteReleaseId\": \"${SITE_RELEASE}\","
    echo "  \"commentsReleaseId\": \"${COMMENTS_RELEASE}\","
    echo "  \"siteSourceRealpathSha\": \"${SITE_PATH_SHA}\","
    echo "  \"commentsSourceRealpathSha\": \"${COMMENTS_PATH_SHA}\","
    echo "  \"siteVersion\": \"${SITE_VERSION}\","
    echo "  \"siteSourceCommit\": \"${SITE_SOURCE_COMMIT}\","
    echo "  \"commentsVersion\": \"${COMMENTS_VERSION}\","
    echo "  \"siteFilesCount\": ${SITE_COUNT},"
    echo "  \"commentsFilesCount\": ${COMMENTS_COUNT},"
    echo "  \"siteUncompressedBytes\": ${SITE_BYTES},"
    echo "  \"commentsUncompressedBytes\": ${COMMENTS_BYTES},"
    echo "  \"siteFilesManifestSha256\": \"$(sha256sum "${WORKDIR}/site-files.sha256" | cut -d' ' -f1)\","
    echo "  \"commentsFilesManifestSha256\": \"$(sha256sum "${WORKDIR}/comments-files.sha256" | cut -d' ' -f1)\","
    echo "  \"archiveSha256\": \"pending\","
    echo "  \"archiveSize\": 0,"
    echo "  \"backupDuringSwitch\": false,"
    echo "  \"databases\": ["
    FIRST_DB=1
    for DB_BACKUP in "${WORKDIR}"/sqlite-backups/*.sqlite3; do
        [ -e "$DB_BACKUP" ] || continue
        [ "$FIRST_DB" = "1" ] || echo ","
        FIRST_DB=0
        FK_LINES="$(cat "${DB_BACKUP}.fk-lines" 2>/dev/null || echo 0)"
        MIGRATIONS="$(sqlite3 "$DB_BACKUP" 'SELECT group_concat(version) FROM schema_migrations;' 2>/dev/null || echo unknown)"
        echo "    {\"name\": \"$(basename "$DB_BACKUP")\", \"schemaMigrations\": \"${MIGRATIONS}\", \"fkViolations\": ${FK_LINES}, \"sha256\": \"$(cut -d' ' -f1 "${DB_BACKUP}.sha256")\"}"
    done
    echo "  ]"
    echo "}"
} > "$MANIFEST"

[ "$TEST_HOOK_MANIFEST" -gt 0 ] 2>/dev/null && sleep "$TEST_HOOK_MANIFEST"
log_state "MANIFEST_CREATED"

# -- 5) 外层归档（内容=快照 + DB + 系统配置白名单；成员名相对、无绝对路径） -
mkdir -p "${WORKDIR}/manifests"
cp "$MANIFEST" "${WORKDIR}/manifests/backup-manifest.json"
cp "${WORKDIR}/site-files.sha256" "${WORKDIR}/manifests/site-files.sha256"
cp "${WORKDIR}/comments-files.sha256" "${WORKDIR}/manifests/comments-files.sha256"

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
    [ -e "/${ITEM}" ] && INCLUDE_PATHS+=("${ITEM}")
done
[ "${#INCLUDE_PATHS[@]}" -gt 0 ] || fail_with_marker "candidates" 2

# draft 内容检查（沿用）
if grep -RIlE '^[[:space:]]*draft[[:space:]]*[:=][[:space:]]*true' "$SRC_ROOT/content" >/dev/null 2>&1; then
    log_msg "检测到 draft=true 内容，拒绝上传以避免泄露未发布稿"
    fail_with_marker "draft-content" 2
fi

log_state "ARCHIVE_START"
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
    --exclude='.env' --exclude='*/.env' \
    --exclude='*.pem' --exclude='*.key' \
    --exclude='._*' --exclude='*/._*' \
    -czf "${ARCHIVE}.tmp" \
    -C / "${INCLUDE_PATHS[@]}" \
    -C "$WORKDIR" snapshot sqlite-backups manifests

if tar -tzf "${ARCHIVE}.tmp" | grep -Eq '(^|/)(ssh_host_.*_key|\.env|incoming)(/|$)'; then
    log_msg "备份包安全检查失败：包含禁止上传的敏感路径"
    fail_with_marker "security-scan" 2
fi

[ "$TEST_HOOK_ARCHIVE" -gt 0 ] 2>/dev/null && sleep "$TEST_HOOK_ARCHIVE"
log_state "ARCHIVE_CREATED" "archive=${ARCHIVE}.tmp"

# -- 6) 上传前强制自验证：解压复验（清单与归档逐文件一致） -----------------
log_state "LOCAL_VERIFY_START"
[ -s "${ARCHIVE}.tmp" ] || fail_with_marker "archive-empty" 2
if tar -tzf "${ARCHIVE}.tmp" | grep -qE '(^|/)\.\.(/|$)|^/'; then
    log_msg "归档成员含绝对路径或路径穿越"
    fail_with_marker "archive-path-safety" 2
fi
tar -xzf "${ARCHIVE}.tmp" -C "$VERIFY_DIR" || fail_with_marker "archive-extract" $?

make_file_manifest "$VERIFY_DIR/snapshot/site" "${WORKDIR}/verify-site-files.sha256"
make_file_manifest "$VERIFY_DIR/snapshot/comments" "${WORKDIR}/verify-comments-files.sha256"
if ! diff -q "${WORKDIR}/site-files.sha256" "${WORKDIR}/verify-site-files.sha256" >/dev/null 2>&1; then
    fail_with_marker "archive-verify-mismatch" 2
fi
if ! diff -q "${WORKDIR}/comments-files.sha256" "${WORKDIR}/verify-comments-files.sha256" >/dev/null 2>&1; then
    fail_with_marker "archive-verify-mismatch" 2
fi
if [ "$(required_files_present "$VERIFY_DIR/snapshot/site")" -gt 0 ]; then
    fail_with_marker "verify-site-required" 2
fi
for DB_VERIFY in "$VERIFY_DIR"/sqlite-backups/*.sqlite3; do
    [ -e "$DB_VERIFY" ] || continue
    V_INTEGRITY="$(sqlite3 "$DB_VERIFY" "PRAGMA integrity_check;" 2>/dev/null || echo fail)"
    [ "$V_INTEGRITY" = "ok" ] || fail_with_marker "verify-db-integrity" 2
done

# 归档 SHA 与大小；原子改名：验证全部通过后才出现正式名称
ARCHIVE_SHA="$(sha256sum "${ARCHIVE}.tmp" | cut -d' ' -f1)"
ARCHIVE_SIZE="$(stat_size "${ARCHIVE}.tmp")"
mv "${ARCHIVE}.tmp" "$ARCHIVE"
( cd "$WORKDIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$CHECKSUM")" )
LOCAL_SHA="$(cut -d' ' -f1 "$CHECKSUM")"

cat > "$LAST_VERIFY" <<EOF
{"backupId":"${BACKUP_ID}","archiveSha256":"${LOCAL_SHA}","archiveSize":${ARCHIVE_SIZE},"filesCompared":"${SITE_COUNT}+${COMMENTS_COUNT}","verifiedAt":"$(date_iso)","ok":true}
EOF
chmod 0600 "$LAST_VERIFY"
log_state "LOCAL_VERIFY_DONE" "sha256=${LOCAL_SHA:0:16}"

# 保留本地副本（若配置）
if [ -n "$BACKUP_KEEP_DIR" ]; then
    mkdir -p "$BACKUP_KEEP_DIR"
    cp "$ARCHIVE" "$BACKUP_KEEP_DIR/"
    cp "$CHECKSUM" "$BACKUP_KEEP_DIR/"
    cp "$MANIFEST" "$BACKUP_KEEP_DIR/backup-manifest.json"
    log_msg "本地保留副本：$BACKUP_KEEP_DIR/$(basename "$ARCHIVE")"
fi

# 备份期间 current 是否切换（仅记录，不改变本次来源；验证模式下同样执行）
record_switch_check() {
    local now_site now_comments
    now_site="$(readlink -f "$SITE_ROOT/current" 2>/dev/null || true)"
    now_comments="$(readlink -f "$COMMENTS_ROOT/current" 2>/dev/null || true)"
    if [ "$now_site" != "$SITE_ROOT/releases/$SITE_RELEASE" ] \
        || [ "$now_comments" != "$COMMENTS_ROOT/releases/$COMMENTS_RELEASE" ]; then
        log_msg "备份期间 current 发生变化（本次备份仍使用锁定 release：site=${SITE_RELEASE} comments=${COMMENTS_RELEASE}）"
        echo "[$(date_iso)] backup-during-switch: true" >> "$STATE_DIR/backup-switch-notes.log" 2>/dev/null || true
    fi
}

if [ "${COS_BACKUP_VALIDATE_ONLY:-0}" = "1" ]; then
    RUN_MODE="validate-only"
    record_switch_check
    # 结构化状态记录：validate-only 不更新正式最近成功时间、远端索引与通知
    cat > "$LAST_VERIFY" <<EOF
{"backupId":"${BACKUP_ID}","archiveSha256":"${LOCAL_SHA}","archiveSize":${ARCHIVE_SIZE},"filesCompared":"${SITE_COUNT}+${COMMENTS_COUNT}","verifiedAt":"$(date_iso)","ok":true,"mode":"validate-only","remoteUploadPerformed":false,"remoteVerified":false,"backupComplete":false,"archivePayloadVerified":true}
EOF
    chmod 0600 "$LAST_VERIFY"
    echo "[$(date_iso)] 本地生成与复验完成（验证模式，不上传 COS）"
    echo "archive-sha256: $LOCAL_SHA"
    echo "archive-size: $ARCHIVE_SIZE"
    log_state "VALIDATE_ONLY_COMPLETE"
    exit 0
fi

# -- 7) 上传 + 远端校验（沿用 v0.5.1/0.5.2 已有效实现） ---------------------
DAILY_DEST="cos://backup/server-backups/daily/${YEAR_MONTH}"
COS_HEAD_TIMEOUT=30
COS_UPLOAD_TIMEOUT=60
COS_DOWNLOAD_TIMEOUT="$(python3 -c "
import sys
mb = ${ARCHIVE_SIZE:-0} / (1024*1024)
print(min(240, 30 + int(mb) * 10))
" 2>/dev/null || echo 240)"
COS_VERIFY_DEADLINE="$(( $(date +%s) + 300 ))"

RUN_MODE="full"
log_state "UPLOAD_STARTED"
: > "${WORKDIR}/upload-started.marker"
run_timeout "$COS_UPLOAD_TIMEOUT" "$COSCLI" cp "$ARCHIVE" "${DAILY_DEST}/$(basename "$ARCHIVE")" >/dev/null 2>&1 \
    || fail_with_marker "cos-upload" $?
run_timeout "$COS_UPLOAD_TIMEOUT" "$COSCLI" cp "$CHECKSUM" "${DAILY_DEST}/$(basename "$CHECKSUM")" >/dev/null 2>&1 \
    || fail_with_marker "cos-upload-checksum" $?
log_state "UPLOAD_DONE"

REMOTE_LISTING="$(run_timeout "$COS_HEAD_TIMEOUT" "$COSCLI" ls "${DAILY_DEST}/$(basename "$ARCHIVE")" 2>/dev/null || true)"
if [ -z "$REMOTE_LISTING" ]; then
    fail_with_marker "cos-object-missing" 3
fi
REMOTE_CHECK="$(run_timeout "$COS_DOWNLOAD_TIMEOUT" "$COSCLI" cp "${DAILY_DEST}/$(basename "$CHECKSUM")" "${WORKDIR}/remote.sha256" >/dev/null 2>&1 \
    && cut -d' ' -f1 "${WORKDIR}/remote.sha256")"
if [ "$REMOTE_CHECK" != "$LOCAL_SHA" ]; then
    fail_with_marker "cos-checksum-mismatch" 3
fi
REMOTE_ARCHIVE="${WORKDIR}/remote.tar.gz"
run_timeout "$COS_DOWNLOAD_TIMEOUT" "$COSCLI" cp "${DAILY_DEST}/$(basename "$ARCHIVE")" "$REMOTE_ARCHIVE" >/dev/null 2>&1 \
    || fail_with_marker "cos-download" $?
REMOTE_SHA="$(sha256sum "$REMOTE_ARCHIVE" | cut -d' ' -f1)"
REMOTE_SIZE="$(stat_size "$REMOTE_ARCHIVE")"
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
    fail_with_marker "cos-content-mismatch" 3
fi
if [ "$REMOTE_SIZE" != "$ARCHIVE_SIZE" ]; then
    fail_with_marker "cos-size-mismatch" 3
fi
if [ "$(date +%s)" -gt "$COS_VERIFY_DEADLINE" ]; then
    fail_with_marker "cos-verify-timeout" 3
fi
log_state "REMOTE_VERIFY_DONE" "sha256=${LOCAL_SHA:0:16}"

# 月备份（每月 1 日）
if [ "$DAY_OF_MONTH" = "01" ]; then
    MONTHLY_DEST="cos://backup/server-backups/monthly/$(date '+%Y')"
    run_timeout "$COS_UPLOAD_TIMEOUT" "$COSCLI" cp "$ARCHIVE" "${MONTHLY_DEST}/$(basename "$ARCHIVE")" >/dev/null 2>&1 \
        || fail_with_marker "cos-upload-monthly" $?
    run_timeout "$COS_UPLOAD_TIMEOUT" "$COSCLI" cp "$CHECKSUM" "${MONTHLY_DEST}/$(basename "$CHECKSUM")" >/dev/null 2>&1 \
        || fail_with_marker "cos-upload-monthly-checksum" $?
fi

record_switch_check

cat > "$LAST_VERIFY" <<EOF
{"backupId":"${BACKUP_ID}","archiveSha256":"${LOCAL_SHA}","archiveSize":${ARCHIVE_SIZE},"filesCompared":"${SITE_COUNT}+${COMMENTS_COUNT}","verifiedAt":"$(date_iso)","ok":true,"mode":"full","remoteUploadPerformed":true,"remoteVerified":true,"backupComplete":true,"archivePayloadVerified":true}
EOF
chmod 0600 "$LAST_VERIFY"
rm -f "$FAILURE_MARKER"
echo "$(date_iso)" > "$LAST_SUCCESS"
chmod 0600 "$LAST_SUCCESS"
log_state "BACKUP_COMPLETE"
echo "[$(date_iso)] 备份完成：$(basename "$ARCHIVE")"
