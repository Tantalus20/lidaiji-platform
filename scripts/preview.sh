#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
HUGO="$(find_hugo)"
PATHNAME="${1:-/}"
[[ "$PATHNAME" == /* ]] || PATHNAME="/$PATHNAME"
URL="http://127.0.0.1:1313$PATHNAME"

printf '正在启动本地预览：%s\n' "$URL"
printf '包含草稿；按 Control+C 停止。\n'
WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-preview-workspace.XXXXXX")"
python3 "$ROOT/tools/workspace.py" materialize --platform-root "$ROOT" --destination "$WORKSPACE" >/dev/null
cd "$WORKSPACE"
mkdir -p "$ROOT/.cache/hugo"
"$HUGO" server --source "$WORKSPACE" --buildDrafts --bind 127.0.0.1 --port 1313 \
  --disableFastRender --cacheDir "$ROOT/.cache/hugo" &
SERVER_PID=$!
cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -d "$WORKSPACE" ]]; then rm -rf "$WORKSPACE"; fi
}
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  for _ in {1..60}; do
    if curl --silent --fail "http://127.0.0.1:1313/" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
fi
if command -v open >/dev/null 2>&1; then
  open "$URL"
else
  printf '请在浏览器打开：%s\n' "$URL"
fi
wait "$SERVER_PID"
