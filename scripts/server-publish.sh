#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT=/opt/writing-site
BACKUPS=/var/backups/writing-site
DOMAIN=""
RELEASE_ARCHIVE=""
RELEASE_SHA=""
SOURCE_ARCHIVE=""
SOURCE_SHA=""
COMMENTS_ARCHIVE=""
COMMENTS_SHA=""
EXPECTED_COMMIT=""
VERIFY_COS_BACKUP=0

while [[ $# -gt 0 ]]; do
  ARGS_BEFORE=$#
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --release) RELEASE_ARCHIVE="$2"; shift 2 ;;
    --release-sha) RELEASE_SHA="$2"; shift 2 ;;
    --source) SOURCE_ARCHIVE="$2"; shift 2 ;;
    --source-sha) SOURCE_SHA="$2"; shift 2 ;;
    --comments) COMMENTS_ARCHIVE="$2"; shift 2 ;;
    --comments-sha) COMMENTS_SHA="$2"; shift 2 ;;
    --expected-commit) EXPECTED_COMMIT="$2"; shift 2 ;;
    --verify-cos-backup) VERIFY_COS_BACKUP=1; shift ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
  # 防御：任何分支若未消耗参数（漏写 shift），立即报错而非空转。
  if [[ $# -ge $ARGS_BEFORE ]]; then
    printf '参数解析异常：%s 未消耗参数，脚本中止。\n' "$1" >&2
    exit 2
  fi
done

[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { printf '域名格式不正确。\n' >&2; exit 2; }
[[ -f "$RELEASE_ARCHIVE" && -f "$SOURCE_ARCHIVE" && -f "$COMMENTS_ARCHIVE" ]] || { printf '发布包不存在。\n' >&2; exit 2; }
[[ "$(sha256sum "$RELEASE_ARCHIVE" | awk '{print $1}')" == "$RELEASE_SHA" ]] || { printf '静态发布包校验失败。\n' >&2; exit 2; }
[[ "$(sha256sum "$SOURCE_ARCHIVE" | awk '{print $1}')" == "$SOURCE_SHA" ]] || { printf '源码包校验失败。\n' >&2; exit 2; }
[[ "$(sha256sum "$COMMENTS_ARCHIVE" | awk '{print $1}')" == "$COMMENTS_SHA" ]] || { printf '段评服务包校验失败。\n' >&2; exit 2; }

# 候选包结构 preflight（v0.5.1）：
#   1) 候选不得包含绝对路径或失效符号链接；
#   2) 候选不得包含数据库或 .env；
#   3) BUILD_INFO 存在且版本/sourceCommit 正确（评论服务）。
COMMENTS_CHECK_DIR="$(mktemp -d)"
cleanup_check() { rm -rf "$COMMENTS_CHECK_DIR"; }
trap cleanup_check EXIT
tar -xzf "$COMMENTS_ARCHIVE" -C "$COMMENTS_CHECK_DIR"
if find "$COMMENTS_CHECK_DIR" -type l -print0 | xargs -0 -n1 readlink 2>/dev/null | grep -q '^/'; then
  printf '段评候选包含绝对路径符号链接，禁止发布。\n' >&2
  exit 2
fi
if find "$COMMENTS_CHECK_DIR" -type l -print0 2>/dev/null | while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    case "$target" in
      /*) continue ;;
    esac
    [ -e "$(dirname "$link")/$target" ] || printf '%s\n' "$link"
  done | grep -q .; then
  printf '段评候选包含失效符号链接，禁止发布。\n' >&2
  exit 2
fi
if find "$COMMENTS_CHECK_DIR" -type f \( -name '*.sqlite' -o -name '*.sqlite3' -o -name '.env' -o -name '*.env' \) | grep -q .; then
  printf '段评候选包含数据库或环境文件，禁止发布。\n' >&2
  exit 2
fi
[[ -f "$COMMENTS_CHECK_DIR/package.json" ]] || { printf '段评候选缺少package.json。\n' >&2; exit 2; }
[[ -f "$COMMENTS_CHECK_DIR/src/server.js" ]] || { printf '段评候选缺少入口文件src/server.js。\n' >&2; exit 2; }
[[ -f "$COMMENTS_CHECK_DIR/BUILD_INFO" ]] || { printf '段评候选缺少BUILD_INFO。\n' >&2; exit 2; }
[[ -f "$COMMENTS_CHECK_DIR/migrations/003-qq-source-notifications.sql" ]] || { printf '段评候选缺少migration 003。\n' >&2; exit 2; }
CANDIDATE_VERSION="$(python3 -c 'import json; print(json.load(open("'"$COMMENTS_CHECK_DIR"'/package.json"))["version"])')"
BUILD_INFO_COMMIT="$(awk -F': ' '/^sourceCommit:/{print $2}' "$COMMENTS_CHECK_DIR/BUILD_INFO")"
BUILD_INFO_VERSION="$(awk -F': ' '/^version:/{print $2}' "$COMMENTS_CHECK_DIR/BUILD_INFO")"
printf '段评候选版本：%s（BUILD_INFO：%s，sourceCommit：%s）\n' "$CANDIDATE_VERSION" "$BUILD_INFO_VERSION" "$BUILD_INFO_COMMIT"
if [[ "$CANDIDATE_VERSION" != "$BUILD_INFO_VERSION" ]]; then
  printf '段评候选package.json与BUILD_INFO版本不一致。\n' >&2
  exit 2
fi
if [[ -n "$EXPECTED_COMMIT" && "$BUILD_INFO_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  printf '段评候选sourceCommit与期望提交不一致：%s != %s\n' "$BUILD_INFO_COMMIT" "$EXPECTED_COMMIT" >&2
  exit 2
fi
if [[ -n "$EXPECTED_COMMIT" && "$BUILD_INFO_COMMIT" == "unknown" ]]; then
  printf '段评候选sourceCommit不可用。\n' >&2
  exit 2
fi

# 正式评论服务端口检查（v0.5.1）：4317 只能有一个监听者，且不存在root实例。
LISTEN_4317="$(ss -tlnp 2>/dev/null | grep -c ':4317' || true)"
if [[ "$LISTEN_4317" != "1" ]]; then
  printf '评论服务端口4317监听者数量异常：%s（应为1）\n' "$LISTEN_4317" >&2
  exit 2
fi
if ss -tlnp 2>/dev/null | grep ':4318' >/dev/null && ps aux 2>/dev/null | grep -E 'node .*src/server\.js' | grep -v grep | awk '{print $1}' | grep -q '^root$'; then
  printf '检测到以root运行的评论服务实例（4318），禁止发布，请先清理。\n' >&2
  exit 2
fi

# 可选：发布前执行一次完整异地备份（含COS远端校验）。
if [[ "$VERIFY_COS_BACKUP" == "1" ]]; then
  printf '执行发布前异地备份与COS校验……\n'
  /usr/local/sbin/backup-to-cos.sh || { printf '发布前异地备份失败，禁止发布。\n' >&2; exit 2; }
fi

# 任何文件替换前先验证运行环境，失败时旧站完全不受影响。
command -v nginx >/dev/null 2>&1 || { printf '未安装Nginx，禁止发布。\n' >&2; exit 2; }
command -v df >/dev/null 2>&1 || { printf '缺少df，无法检查磁盘空间。\n' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { printf '缺少Node.js，无法更新段评服务。\n' >&2; exit 2; }
[[ -f /etc/lidaiji-comments.env ]] || { printf '缺少/etc/lidaiji-comments.env，禁止发布。\n' >&2; exit 2; }
systemctl cat lidaiji-comments >/dev/null
printf '服务器磁盘空间：\n'
FS_CHECK="$ROOT"
[[ -e "$FS_CHECK" ]] || FS_CHECK="$(dirname "$ROOT")"
[[ -e "$FS_CHECK" ]] || FS_CHECK="/"
df -h "$FS_CHECK"
AVAILABLE_KB="$(df -Pk "$FS_CHECK" | awk 'NR==2 {print $4}')"
REQUIRED_KB="$(( ($(stat -c '%s' "$RELEASE_ARCHIVE") + $(stat -c '%s' "$SOURCE_ARCHIVE") + $(stat -c '%s' "$COMMENTS_ARCHIVE")) / 1024 * 3 + 102400 ))"
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ && "$AVAILABLE_KB" -ge "$REQUIRED_KB" ]] || {
  printf '磁盘可用空间不足，至少需要约%sKB。\n' "$REQUIRED_KB" >&2
  exit 2
}
nginx -t
if [[ -L "$ROOT/current" ]]; then
  test -f "$ROOT/current/index.html"
  test -f "$ROOT/current/404.html"
  test -f "$ROOT/current/search-index.json"
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
RELEASE="$ROOT/releases/$STAMP"
SOURCE_NEXT="$ROOT/source.next.$STAMP"
COMMENTS_ROOT=/opt/lidaiji-comments
COMMENTS_RELEASE="$COMMENTS_ROOT/releases/$STAMP"
COMMENTS_CURRENT_BEFORE=""
COMMENTS_SWITCHED=0
COMMENTS_DB_TOUCHED=0
COMMENTS_DB_BACKUP=""
CURRENT_BEFORE=""
if [[ -L "$ROOT/current" && -e "$ROOT/current" ]]; then
  CURRENT_BEFORE="$(readlink -e "$ROOT/current")"
fi
if [[ -L "$COMMENTS_ROOT/current" && -e "$COMMENTS_ROOT/current" ]]; then
  COMMENTS_CURRENT_BEFORE="$(readlink -e "$COMMENTS_ROOT/current")"
fi
SOURCE_BEFORE="$ROOT/source.before.$STAMP"
SWITCHED=0
SOURCE_SWITCHED=0
FINISHED=0
RELEASE_LIST=""
SOURCE_LIST=""

rollback() {
  local code=$?
  [[ -n "$RELEASE_LIST" ]] && rm -f "$RELEASE_LIST"
  [[ -n "$SOURCE_LIST" ]] && rm -f "$SOURCE_LIST"
  if [[ "$FINISHED" == 1 ]]; then return; fi
  printf '发布失败，保留旧站并回滚（exit=%s）。\n' "$code" >&2
  if [[ "$SWITCHED" == 1 ]]; then
    if [[ -n "$CURRENT_BEFORE" ]]; then
      ln -s "$CURRENT_BEFORE" "$ROOT/current.rollback"
      mv -Tf "$ROOT/current.rollback" "$ROOT/current"
    else
      rm -f "$ROOT/current"
    fi
  fi
  if [[ "$SOURCE_SWITCHED" == 1 && -d "$SOURCE_BEFORE" ]]; then
    rm -rf "$ROOT/source"
    mv "$SOURCE_BEFORE" "$ROOT/source"
  fi
  if [[ "$COMMENTS_SWITCHED" == 1 || "$COMMENTS_DB_TOUCHED" == 1 ]]; then
    systemctl stop lidaiji-comments || true
    if [[ "$COMMENTS_SWITCHED" == 1 ]]; then
      if [[ -n "$COMMENTS_CURRENT_BEFORE" ]]; then
        ln -s "$COMMENTS_CURRENT_BEFORE" "$COMMENTS_ROOT/current.rollback"
        mv -Tf "$COMMENTS_ROOT/current.rollback" "$COMMENTS_ROOT/current"
      else
        rm -f "$COMMENTS_ROOT/current"
      fi
    fi
    if [[ -n "$COMMENTS_DB_BACKUP" && -f "$COMMENTS_DB_BACKUP" ]]; then
      set -a
      # shellcheck disable=SC1091
      . /etc/lidaiji-comments.env
      set +a
      install -o lidaiji-comments -g lidaiji-comments -m 0600 "$COMMENTS_DB_BACKUP" "$COMMENTS_DB"
    fi
    systemctl start lidaiji-comments || true
  fi
  exit "$code"
}
trap rollback ERR

mkdir -p "$ROOT/releases" "$BACKUPS"
install -d -o root -g lidaiji-comments -m 0750 "$COMMENTS_ROOT/releases"
RELEASE_LIST="$(mktemp)"
SOURCE_LIST="$(mktemp)"
tar -tzf "$RELEASE_ARCHIVE" > "$RELEASE_LIST"
tar -tzf "$SOURCE_ARCHIVE" > "$SOURCE_LIST"
grep -qE '(^|/)index\.html$' "$RELEASE_LIST"
grep -qE '(^|/)config/_default/hugo\.toml$' "$SOURCE_LIST"
rm -f "$RELEASE_LIST" "$SOURCE_LIST"

mkdir -p "$RELEASE" "$SOURCE_NEXT"
tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE"
tar -xzf "$SOURCE_ARCHIVE" -C "$SOURCE_NEXT"
# mktemp生成的本地构建目录通常为0700；静态release必须允许Nginx只读遍历。
chmod -R a+rX "$RELEASE"
test -f "$RELEASE/index.html"
test -f "$RELEASE/404.html"
test -f "$RELEASE/search-index.json"
test -f "$RELEASE/comment-manifest.json"
test -f "$SOURCE_NEXT/config/_default/hugo.toml"
if find "$RELEASE" -type f \( -name '*.md' -o -name '*.sh' -o -name '.env' \) | grep -q .; then
  printf '静态发布目录包含不应公开的源码或脚本。\n' >&2
  exit 1
fi

# 评论数据库在静态release切换前完成一致性备份、迁移和manifest同步。
mkdir -p "$COMMENTS_RELEASE"
tar -xzf "$COMMENTS_ARCHIVE" -C "$COMMENTS_RELEASE"
chown -R root:lidaiji-comments "$COMMENTS_RELEASE"
chmod -R u=rwX,g=rX,o= "$COMMENTS_RELEASE"
set -a
# shellcheck disable=SC1091
. /etc/lidaiji-comments.env
set +a
COMMENTS_BACKUPS=/var/backups/lidaiji-comments
install -d -o lidaiji-comments -g lidaiji-comments -m 0700 "$COMMENTS_BACKUPS"
COMMENTS_DB_BACKUP="$COMMENTS_BACKUPS/pre-publish_$STAMP.sqlite3"
runuser -u lidaiji-comments --preserve-environment -- node --experimental-sqlite "$COMMENTS_RELEASE/src/cli.js" backup "$COMMENTS_DB_BACKUP" >/dev/null
chmod 0600 "$COMMENTS_DB_BACKUP"
COMMENTS_DB_TOUCHED=1
runuser -u lidaiji-comments --preserve-environment -- node --experimental-sqlite "$COMMENTS_RELEASE/src/cli.js" migrate
runuser -u lidaiji-comments --preserve-environment -- node --experimental-sqlite "$COMMENTS_RELEASE/src/cli.js" sync-manifest "$RELEASE/comment-manifest.json"
# v0.5.1：把本次release的完整manifest同步为服务启动时读取的权威清单，
# 避免服务重启后读到旧清单导致段落状态回退。
if [[ -n "${COMMENTS_MANIFEST:-}" ]]; then
  install -o lidaiji-comments -g lidaiji-comments -m 0600 "$RELEASE/comment-manifest.json" "$COMMENTS_MANIFEST"
fi
ln -s "$COMMENTS_RELEASE" "$COMMENTS_ROOT/current.next"
mv -Tf "$COMMENTS_ROOT/current.next" "$COMMENTS_ROOT/current"
COMMENTS_SWITCHED=1
systemctl restart lidaiji-comments
sleep 1
curl -fsS http://127.0.0.1:4317/healthz | grep -q '"ok":true'

if [[ -d "$ROOT/source" ]]; then
  tar -czf "$BACKUPS/source_pre_$STAMP.tar.gz" -C "$ROOT" source
  sha256sum "$BACKUPS/source_pre_$STAMP.tar.gz" > "$BACKUPS/source_pre_$STAMP.tar.gz.sha256"
  mv "$ROOT/source" "$SOURCE_BEFORE"
fi
mv "$SOURCE_NEXT" "$ROOT/source"
SOURCE_SWITCHED=1

ln -s "$RELEASE" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
SWITCHED=1

curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" >/dev/null
curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/search-index.json" >/dev/null

if [[ -d "$SOURCE_BEFORE" ]]; then rm -rf "$SOURCE_BEFORE"; fi
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | awk 'NR>5 {print $2}' | xargs -r rm -rf
find "$BACKUPS" -maxdepth 1 -type f -name 'source_pre_*.tar.gz' -printf '%T@ %p\n' \
  | sort -rn | awk 'NR>7 {print $2}' | while IFS= read -r old; do
      [[ -f "$old.keep" ]] || { rm -f "$old" "$old.sha256"; }
    done

find "$COMMENTS_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | awk 'NR>5 {print $2}' | xargs -r rm -rf
rm -f "$RELEASE_ARCHIVE" "$SOURCE_ARCHIVE" "$COMMENTS_ARCHIVE" /tmp/server-publish.sh
FINISHED=1
trap - ERR
printf 'PUBLISH_OK\nrelease=%s\nprevious=%s\n' "$RELEASE" "${CURRENT_BEFORE:-无}"
