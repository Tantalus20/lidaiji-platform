#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
HUGO="$(find_hugo)"
require_command node
COMMENTS_PYTHON="${WRITING_IMPORT_PYTHON:-$ROOT/.venv-importer/bin/python}"
[[ -x "$COMMENTS_PYTHON" ]] || COMMENTS_PYTHON="$(command -v python3)"

DIST="${LIDAIJI_DIST_ROOT:-$ROOT/dist}"
mkdir -p "$DIST"  # LIDAIJI_DIST_ROOT 可把构建产物指向独立临时目录（测试/验收）
STAGING="$(mktemp -d "$DIST/.site.XXXXXX")"
WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-build-workspace.XXXXXX")"
START="$(date +%s)"
cleanup() {
  if [[ -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
  if [[ -d "$WORKSPACE" ]]; then
    rm -rf "$WORKSPACE"
  fi
}
trap cleanup EXIT

WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" materialize --platform-root "$ROOT" --destination "$WORKSPACE")"
CONTENT_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRoot"])' "$WORKSPACE_JSON")"
# 可选：注入虚构排版测试内容（仅当显式设置时；正式构建不设置即无影响）。
# 用于验证版 release 的线上排版验证，最终正式构建不使用。
# materialize 后的 content 是私仓符号链接；注入前先转为临时只读副本，
# 绝不向私仓写入任何文件。
if [[ -n "${LIDAIJI_LAYOUT_TEST_SOURCE:-}" && -d "$ROOT/$LIDAIJI_LAYOUT_TEST_SOURCE" ]]; then
  rm -f "$WORKSPACE/content"
  mkdir -p "$WORKSPACE/content"
  cp -R -L "$CONTENT_ROOT/." "$WORKSPACE/content/"
  cp -R "$ROOT/$LIDAIJI_LAYOUT_TEST_SOURCE" "$WORKSPACE/content/essays/layout-test"
  printf '已注入虚构排版测试内容（内容目录已转为临时副本）：%s\n' "$LIDAIJI_LAYOUT_TEST_SOURCE"
fi
LIDAIJI_CONTENT_ROOT="$CONTENT_ROOT" "$ROOT/scripts/check-word-content.sh"
LIDAIJI_ACTIVE_WORKSPACE="$WORKSPACE" "$ROOT/scripts/check-images.sh"
"$COMMENTS_PYTHON" "$ROOT/scripts/comments-prepare.py" --project-root "$WORKSPACE"
mkdir -p "$ROOT/.cache/hugo"
cd "$WORKSPACE"
HUGO_ARGS=(--source "$WORKSPACE" --minify --gc --cleanDestinationDir --cacheDir "$ROOT/.cache/hugo" --destination "$STAGING")
if [[ -n "${SITE_BASE_URL:-}" ]]; then HUGO_ARGS+=(--baseURL "$SITE_BASE_URL"); fi
"$HUGO" "${HUGO_ARGS[@]}"
node "$ROOT/scripts/build-comment-manifest.mjs" "$WORKSPACE" "$STAGING"
SITE_DIR="$STAGING" node "$ROOT/tests/check-site.mjs"

if [[ -d "$DIST/site" ]]; then
  rm -rf "$DIST/site.previous"
  mv "$DIST/site" "$DIST/site.previous"
fi
mv "$STAGING" "$DIST/site"
# 品牌断言（v0.5.1）：构建产物必须使用工作区真实站点名，禁止演示品牌残留。
WORKSPACE_MODE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["mode"])' "$WORKSPACE/workspace.json")"
SITE_TITLE="$(python3 -c '
import tomllib
with open("'"$WORKSPACE"'/config/_default/hugo.toml","rb") as h:
    print(tomllib.load(h).get("title",""))
' 2>/dev/null || true)"
node "$ROOT/tests/check-brand.mjs" "$DIST/site" "$SITE_TITLE"
# BUILD_INFO（v0.5.1）：站点发布包记录版本与sourceCommit（不含路径/凭据）。
{
  printf 'version: %s\n' "$(cat "$ROOT/VERSION")"
  printf 'sourceCommit: %s\n' "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  printf 'buildTimestamp: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'hugoVersion: %s\n' "$("$HUGO" version 2>/dev/null | awk '{print $2}' || echo unknown)"
  printf 'entrypoint: index.html\n'
} > "$DIST/site/BUILD_INFO"
SITE_DIR="$DIST/site" node "$ROOT/tests/check-reading-ui.mjs" "$ROOT"
SITE_DIR="$DIST/site" node "$ROOT/tests/check-reader-tools.mjs" "$ROOT"
SITE_DIR="$DIST/site" node "$ROOT/tests/check-article-comments.mjs" "$ROOT"
END="$(date +%s)"
SIZE="$(du -sh "$DIST/site" | awk '{print $1}')"
PAGES="$(find "$DIST/site" -name '*.html' | wc -l | tr -d ' ')"
printf '构建成功：%s 个HTML页面，目录大小 %s，耗时 %s 秒。\n' "$PAGES" "$SIZE" "$((END - START))"
printf '输出目录：%s\n' "$DIST/site"
