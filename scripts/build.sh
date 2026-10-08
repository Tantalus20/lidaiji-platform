#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
HUGO="$(find_hugo)"
require_command node
require_command python3
COMMENTS_PYTHON="${WRITING_IMPORT_PYTHON:-$ROOT/.venv-importer/bin/python}"
[[ -x "$COMMENTS_PYTHON" ]] || COMMENTS_PYTHON="$(command -v python3)"

DIST="${LIDAIJI_DIST_ROOT:-$ROOT/dist}"
mkdir -p "$DIST"  # LIDAIJI_DIST_ROOT 可把构建产物指向独立临时目录（测试/验收）
STAGING="$(mktemp -d "$DIST/.site.XXXXXX")"
START="$(date +%s)"
CONTENT_STAGE=""
cleanup() {
  if [[ -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
  if [[ -n "$CONTENT_STAGE" && -d "$CONTENT_STAGE" ]]; then
    rm -rf "$CONTENT_STAGE"
  fi
}
trap cleanup EXIT

# P0-B：正式构建只消费不可变 release snapshot。
# - 外部（publish.sh / Studio 隔离发布）传入 LIDAIJI_RELEASE_SNAPSHOT 时复验并复用；
# - 独立运行 build.sh 时，先冻结平台提交与当前内容，再构建；
# - 构建期间不再读取可变工作树或私人内容仓库。
if [[ -n "${LIDAIJI_RELEASE_SNAPSHOT:-}" ]]; then
  SNAPSHOT_JSON="$(python3 "$ROOT/tools/release_snapshot.py" verify --snapshot "$LIDAIJI_RELEASE_SNAPSHOT")"
else
  WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" show --platform-root "$ROOT")"
  WORKSPACE_MODE="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["mode"])' <<<"$WORKSPACE_JSON")"
  if [[ "$WORKSPACE_MODE" != "private" ]]; then
    printf '警告：当前为演示内容构建（mode=%s），产物不得用于正式发布。\n' "$WORKSPACE_MODE" >&2
  fi
  CONTENT_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRoot"])' "$WORKSPACE_JSON")"
  SITE_OVERRIDES_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["siteOverridesRoot"])' "$WORKSPACE_JSON")"
  # 可选：注入虚构排版测试内容（仅当显式设置时；正式构建不设置即无影响）。
  # 注入发生在冻结之前，先转临时副本，绝不向私仓写入任何文件。
  if [[ -n "${LIDAIJI_LAYOUT_TEST_SOURCE:-}" && -d "$ROOT/$LIDAIJI_LAYOUT_TEST_SOURCE" ]]; then
    CONTENT_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-layout-content.XXXXXX")"
    mkdir -p "$CONTENT_STAGE/content"
    cp -R -L "$CONTENT_ROOT/." "$CONTENT_STAGE/content/"
    cp -R "$ROOT/$LIDAIJI_LAYOUT_TEST_SOURCE" "$CONTENT_STAGE/content/essays/layout-test"
    CONTENT_ROOT="$CONTENT_STAGE/content"
    printf '已注入虚构排版测试内容（冻结前临时副本）：%s\n' "$LIDAIJI_LAYOUT_TEST_SOURCE"
  fi
  SNAPSHOT_JSON="$(python3 "$ROOT/tools/release_snapshot.py" create \
    --platform-root "$ROOT" --mode full_site \
    --content-root "$CONTENT_ROOT" --site-overrides-root "$SITE_OVERRIDES_ROOT")"
fi
SNAPSHOT_FIELD() {
  python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get(sys.argv[2],""))' "$SNAPSHOT_JSON" "$1"
}
WORKSPACE="$(SNAPSHOT_FIELD tree)"
[[ -d "$WORKSPACE" ]] || { printf '发布快照缺少构建树。\n' >&2; exit 2; }

LIDAIJI_CONTENT_ROOT="$WORKSPACE/content" "$WORKSPACE/scripts/check-word-content.sh"
LIDAIJI_ACTIVE_WORKSPACE="$WORKSPACE" "$WORKSPACE/scripts/check-images.sh"
"$COMMENTS_PYTHON" "$WORKSPACE/scripts/comments-prepare.py" --project-root "$WORKSPACE"
mkdir -p "$ROOT/.cache/hugo"
cd "$WORKSPACE"
HUGO_ARGS=(--source "$WORKSPACE" --minify --gc --cleanDestinationDir --cacheDir "$ROOT/.cache/hugo" --destination "$STAGING")
if [[ -n "${SITE_BASE_URL:-}" ]]; then HUGO_ARGS+=(--baseURL "$SITE_BASE_URL"); fi
"$HUGO" "${HUGO_ARGS[@]}"
node "$WORKSPACE/scripts/build-comment-manifest.mjs" "$WORKSPACE" "$STAGING"
SITE_DIR="$STAGING" node "$WORKSPACE/tests/check-site.mjs"

if [[ -d "$DIST/site" ]]; then
  rm -rf "$DIST/site.previous"
  mv "$DIST/site" "$DIST/site.previous"
fi
mv "$STAGING" "$DIST/site"
# 品牌断言（v0.5.1）：构建产物必须使用快照内真实站点名，禁止演示品牌残留。
SITE_TITLE="$(python3 -c '
import tomllib
with open("'"$WORKSPACE"'/config/_default/hugo.toml","rb") as h:
    print(tomllib.load(h).get("title",""))
' 2>/dev/null || true)"
node "$WORKSPACE/tests/check-brand.mjs" "$DIST/site" "$SITE_TITLE"
# BUILD_INFO（P0-B）：记录同源快照身份，供服务端与源码包交叉校验；不含路径/凭据。
{
  printf 'version: %s\n' "$(cat "$WORKSPACE/VERSION")"
  printf 'sourceCommit: %s\n' "$(SNAPSHOT_FIELD platformCommit)"
  printf 'releaseSnapshotId: %s\n' "$(SNAPSHOT_FIELD snapshotId)"
  printf 'releaseSnapshotFingerprint: %s\n' "$(SNAPSHOT_FIELD snapshotFingerprint)"
  printf 'snapshotMode: %s\n' "$(SNAPSHOT_FIELD snapshotMode)"
  printf 'contentManifestSha256: %s\n' "$(SNAPSHOT_FIELD contentManifestSha256)"
  printf 'configFingerprint: %s\n' "$(SNAPSHOT_FIELD configFingerprint)"
  printf 'builderVersion: %s\n' "$(SNAPSHOT_FIELD builderVersion)"
  printf 'buildTimestamp: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'hugoVersion: %s\n' "$("$HUGO" version 2>/dev/null | awk '{print $2}' || echo unknown)"
  printf 'entrypoint: index.html\n'
  if [[ -n "${LIDAIJI_CANDIDATE_ID:-}" ]]; then
    printf 'candidateId: %s\n' "$LIDAIJI_CANDIDATE_ID"
    printf 'candidateManifestSha256: %s\n' "${LIDAIJI_CANDIDATE_MANIFEST_SHA256:-}"
  fi
} > "$DIST/site/BUILD_INFO"
SITE_DIR="$DIST/site" node "$WORKSPACE/tests/check-reading-ui.mjs" "$WORKSPACE"
SITE_DIR="$DIST/site" node "$WORKSPACE/tests/check-reader-tools.mjs" "$WORKSPACE"
SITE_DIR="$DIST/site" node "$WORKSPACE/tests/check-article-comments.mjs" "$WORKSPACE"
END="$(date +%s)"
SIZE="$(du -sh "$DIST/site" | awk '{print $1}')"
PAGES="$(find "$DIST/site" -name '*.html' | wc -l | tr -d ' ')"
printf '构建成功：%s 个HTML页面，目录大小 %s，耗时 %s 秒。\n' "$PAGES" "$SIZE" "$((END - START))"
printf '发布快照：%s（%s）\n' "$(SNAPSHOT_FIELD snapshotId)" "$(SNAPSHOT_FIELD snapshotMode)"
printf '输出目录：%s\n' "$DIST/site"
