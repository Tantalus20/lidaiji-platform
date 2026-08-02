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
