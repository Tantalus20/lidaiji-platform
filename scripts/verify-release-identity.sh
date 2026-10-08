#!/usr/bin/env bash
# P0-B 发布身份校验（可独立调用；不执行任何发布切换）。
#
# 阶段一（归档）：对给定的发布包执行 SHA-256 校验与成员安全扫描
#   （绝对路径、.. 路径穿越、任意符号链接均拒绝）。
# 阶段二（身份，提供 --site-info 时）：站点 BUILD_INFO、源码包 BUILD_INFO
#   与发布请求三方完全一致；article_isolated 必须携带候选身份。
#
# 退出码：0 通过；2 校验失败。
set -Eeuo pipefail

RELEASE_ARCHIVE=""
RELEASE_SHA=""
SOURCE_ARCHIVE=""
SOURCE_SHA=""
COMMENTS_ARCHIVE=""
COMMENTS_SHA=""
SITE_INFO=""
SOURCE_INFO=""
RELEASE_DIR=""
PLATFORM_COMMIT=""
SNAPSHOT_ID=""
SNAPSHOT_FINGERPRINT=""
CONTENT_MANIFEST_SHA=""
CANDIDATE_ID=""
CANDIDATE_MANIFEST_SHA=""

while [[ $# -gt 0 ]]; do
  ARGS_BEFORE=$#
  case "$1" in
    --release) RELEASE_ARCHIVE="$2"; shift 2 ;;
    --release-sha) RELEASE_SHA="$2"; shift 2 ;;
    --source) SOURCE_ARCHIVE="$2"; shift 2 ;;
    --source-sha) SOURCE_SHA="$2"; shift 2 ;;
    --comments) COMMENTS_ARCHIVE="$2"; shift 2 ;;
    --comments-sha) COMMENTS_SHA="$2"; shift 2 ;;
    --site-info) SITE_INFO="$2"; shift 2 ;;
    --source-info) SOURCE_INFO="$2"; shift 2 ;;
    --release-dir) RELEASE_DIR="$2"; shift 2 ;;
    --platform-commit) PLATFORM_COMMIT="$2"; shift 2 ;;
    --snapshot-id) SNAPSHOT_ID="$2"; shift 2 ;;
    --snapshot-fingerprint) SNAPSHOT_FINGERPRINT="$2"; shift 2 ;;
    --content-manifest-sha) CONTENT_MANIFEST_SHA="$2"; shift 2 ;;
    --candidate-id) CANDIDATE_ID="$2"; shift 2 ;;
    --candidate-manifest-sha) CANDIDATE_MANIFEST_SHA="$2"; shift 2 ;;
    *) printf '校验脚本未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
  if [[ $# -ge $ARGS_BEFORE ]]; then
    printf '校验脚本参数解析异常：%s\n' "$1" >&2
    exit 2
  fi
done

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

_check_archive() {
  local file="$1" label="$2" expected="$3"
  [[ -n "$file" && -n "$expected" ]] || { printf '缺少%s包或其SHA。\n' "$label" >&2; exit 2; }
  [[ -f "$file" ]] || { printf '%s包不存在：%s\n' "$label" "$file" >&2; exit 2; }
  local actual
  actual="$(_sha256 "$file")"
  if [[ "$actual" != "$expected" ]]; then
    printf '%s包SHA-256校验失败。\n' "$label" >&2
    exit 2
  fi
  # 成员安全：拒绝绝对路径、.. 穿越与符号链接。
  if tar -tzf "$file" | awk -F/ '{for (i=1;i<=NF;i++) if ($i=="..") exit 1}'; then :; else
    printf '%s包包含路径穿越成员。\n' "$label" >&2
    exit 2
  fi
  if tar -tzf "$file" | grep -q '^/'; then
    printf '%s包包含绝对路径成员。\n' "$label" >&2
    exit 2
  fi
  if tar -tvzf "$file" | awk 'substr($1,1,1)=="l"{found=1} END{exit found?0:1}'; then
    printf '%s包包含符号链接，禁止发布。\n' "$label" >&2
    exit 2
  fi
}

if [[ -n "$RELEASE_ARCHIVE$SOURCE_ARCHIVE$COMMENTS_ARCHIVE" ]]; then
  _check_archive "$RELEASE_ARCHIVE" "静态发布" "$RELEASE_SHA"
  _check_archive "$SOURCE_ARCHIVE" "源码" "$SOURCE_SHA"
  _check_archive "$COMMENTS_ARCHIVE" "段评服务" "$COMMENTS_SHA"
fi

if [[ -n "$SITE_INFO" ]]; then
  [[ -n "$SOURCE_INFO" && -n "$RELEASE_DIR" ]] || { printf '身份校验缺少 --source-info/--release-dir。\n' >&2; exit 2; }
  [[ -n "$PLATFORM_COMMIT" && -n "$SNAPSHOT_ID" && -n "$SNAPSHOT_FINGERPRINT" && -n "$CONTENT_MANIFEST_SHA" ]] || {
    printf '缺少 release snapshot 身份参数，禁止发布。\n' >&2
    exit 2
  }
  [[ -f "$SITE_INFO" ]] || { printf '静态发布包缺少BUILD_INFO，禁止发布。\n' >&2; exit 2; }
  [[ -f "$SOURCE_INFO" ]] || { printf '源码包缺少BUILD_INFO，禁止发布。\n' >&2; exit 2; }

  read_info() { awk -F': ' -v key="$2" '$1==key{print $2; exit}' "$1"; }
  verify_identity() {
    local field="$1" expected="$2"
    local site_value source_value
    site_value="$(read_info "$SITE_INFO" "$field")"
    source_value="$(read_info "$SOURCE_INFO" "$field")"
    if [[ -z "$site_value" || "$site_value" != "$source_value" || "$site_value" != "$expected" ]]; then
      printf '发布身份不一致（%s）：站点=%s 源码包=%s 请求=%s\n' \
        "$field" "${site_value:-缺失}" "${source_value:-缺失}" "${expected:-缺失}" >&2
      exit 2
    fi
  }
  verify_identity releaseSnapshotId "$SNAPSHOT_ID"
  verify_identity releaseSnapshotFingerprint "$SNAPSHOT_FINGERPRINT"
  verify_identity contentManifestSha256 "$CONTENT_MANIFEST_SHA"
  verify_identity sourceCommit "$PLATFORM_COMMIT"

  if [[ "$(read_info "$SOURCE_INFO" packageRole)" != "platform-source-with-release-provenance" ]]; then
    printf '源码包角色标记缺失或不正确，禁止发布。\n' >&2
    exit 2
  fi

  SNAPSHOT_MODE="$(read_info "$SOURCE_INFO" snapshotMode)"
  if [[ "$SNAPSHOT_MODE" == "article_isolated" ]]; then
    if [[ -z "$CANDIDATE_ID" || -z "$CANDIDATE_MANIFEST_SHA" ]]; then
      printf 'article_isolated 快照缺少候选身份（candidateId/candidateManifestSha256），禁止发布。\n' >&2
      exit 2
    fi
    verify_identity candidateId "$CANDIDATE_ID"
    verify_identity candidateManifestSha256 "$CANDIDATE_MANIFEST_SHA"
  elif [[ "$SNAPSHOT_MODE" == "full_site" ]]; then
    if [[ -n "$CANDIDATE_ID" || -n "$CANDIDATE_MANIFEST_SHA" ]]; then
      printf 'full_site 快照不得携带候选身份，发布请求不一致。\n' >&2
      exit 2
    fi
  elif [[ -z "$SNAPSHOT_MODE" ]]; then
    printf '源码包缺少 snapshotMode。\n' >&2
    exit 2
  else
    printf '快照模式非法：%s\n' "$SNAPSHOT_MODE" >&2
    exit 2
  fi

  if [[ -n "$SOURCE_ARCHIVE" ]] && tar -tzf "$SOURCE_ARCHIVE" | grep -qE '(^|/)(author-notes|\.lidaiji-workspace\.json)(/|$)'; then
    printf '源码包混入作者评或工作区配置，禁止发布。\n' >&2
    exit 2
  fi
  if [[ -e "$RELEASE_DIR/data/author-notes" ]] || [[ -e "$RELEASE_DIR/.lidaiji-workspace.json" ]]; then
    printf '静态发布目录混入作者评或工作区配置，禁止发布。\n' >&2
    exit 2
  fi
fi

printf '发布身份校验通过：snapshot=%s 平台=%s\n' "${SNAPSHOT_ID:-archive-only}" "${PLATFORM_COMMIT:-n/a}"
