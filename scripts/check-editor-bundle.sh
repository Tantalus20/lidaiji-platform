#!/usr/bin/env bash
# 检查前端包是否与源码一致（编辑器 studio/editor + 工作台 studio/app），
# 防止提交过期产物。本机缺少 esbuild（未 npm install）时自动跳过。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [[ ! -x "$ROOT/node_modules/.bin/esbuild" ]]; then
  printf '跳过前端包新鲜度检查（缺少 esbuild；如已安装根依赖请重新运行 npm run check）。\n'
  exit 0
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-frontend-bundle.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

check_one() {
  local label="$1"
  local build_script="$2"
  local output_env="$3"
  local committed="$4"
  env "$output_env=$TMP_DIR/out.js" node "$ROOT/$build_script" >/dev/null
  if ! cmp -s "$TMP_DIR/out.js" "$ROOT/$committed"; then
    printf '%s 与源码不一致，请先运行对应构建命令并提交新产物。\n' "$label" >&2
    exit 1
  fi
  printf '%s 与源码一致。\n' "$label"
}

check_one "编辑器前端包" "scripts/build-editor-bundle.mjs" "LIDAIJI_EDITOR_OUTPUT" "studio/static/vendor/prosemirror-bundle.js"
check_one "工作台前端包" "scripts/build-studio-app.mjs" "LIDAIJI_APP_OUTPUT" "studio/static/app-bundle.js"
