#!/usr/bin/env bash
# 分享站长文站本地预览（Hugo server，含草稿），只监听 127.0.0.1:1314。
# 与正式作品站预览（scripts/preview.sh，1313 端口）完全独立。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
HUGO="$(find_hugo)"
PATHNAME="${1:-/}"
[[ "$PATHNAME" == /* ]] || PATHNAME="/$PATHNAME"
URL="http://127.0.0.1:1314$PATHNAME"

printf '正在启动分享站本地预览：%s\n' "$URL"
printf '包含草稿；按 Control+C 停止。\n'

PYTHON=""
if [[ -n "${WRITING_IMPORT_PYTHON:-}" && -x "${WRITING_IMPORT_PYTHON}" ]]; then
  PYTHON="${WRITING_IMPORT_PYTHON}"
elif [[ -x "$ROOT/.venv-importer/bin/python" ]]; then
  PYTHON="$ROOT/.venv-importer/bin/python"
else
  PYTHON="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON" ]]; then
  printf '错误：缺少 Python。\n' >&2
  exit 1
fi
CONTENT_DIR="$("$PYTHON" -c '
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from studio import share
root = share.share_root(Path(sys.argv[1]))
print(root / "items")
' "$ROOT")"

cd "$ROOT"
mkdir -p "$ROOT/.cache/hugo-share"
"$HUGO" server --source "$ROOT/share-site" --contentDir "$CONTENT_DIR" \
  --buildDrafts --bind 127.0.0.1 --port 1314 \
  --disableFastRender --cacheDir "$ROOT/.cache/hugo-share" &
SERVER_PID=$!
cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  for _ in {1..60}; do
    if curl --silent --fail "http://127.0.0.1:1314/" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
fi
if command -v open >/dev/null 2>&1; then
  open "$URL"
else
  printf '请在浏览器打开：%s\n' "$URL"
fi
wait "$SERVER_PID"
