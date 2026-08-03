#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
HUGO="$(find_hugo)"
require_command node
COMMENTS_PYTHON="${WRITING_IMPORT_PYTHON:-$ROOT/.venv-importer/bin/python}"
[[ -x "$COMMENTS_PYTHON" ]] || COMMENTS_PYTHON="$(command -v python3)"

DIST="$ROOT/dist"
mkdir -p "$DIST"
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
SITE_DIR="$DIST/site" node "$ROOT/tests/check-reading-ui.mjs" "$ROOT"
SITE_DIR="$DIST/site" node "$ROOT/tests/check-reader-tools.mjs" "$ROOT"
SITE_DIR="$DIST/site" node "$ROOT/tests/check-article-comments.mjs" "$ROOT"
END="$(date +%s)"
SIZE="$(du -sh "$DIST/site" | awk '{print $1}')"
PAGES="$(find "$DIST/site" -name '*.html' | wc -l | tr -d ' ')"
printf '构建成功：%s 个HTML页面，目录大小 %s，耗时 %s 秒。\n' "$PAGES" "$SIZE" "$((END - START))"
printf '输出目录：%s\n' "$DIST/site"
