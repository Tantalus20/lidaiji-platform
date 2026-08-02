#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

CONTENT_ROOT="${LIDAIJI_CONTENT_ROOT:-$ROOT/content}"
unsafe=()
while IFS= read -r -d '' file; do unsafe+=("$file"); done < <(
  find "$CONTENT_ROOT" "$ROOT/static" -type f \
    \( -iname '*.docx' -o -iname '*.docm' -o -iname '*.dotx' -o -iname '*.dotm' \) \
    -print0 2>/dev/null
)
if (( ${#unsafe[@]} > 0 )); then
  printf '错误：Word原稿不得放入Hugo公开内容目录：\n' >&2
  printf '  %s\n' "${unsafe[@]}" >&2
  exit 1
fi

partials=()
while IFS= read -r -d '' directory; do partials+=("$directory"); done < <(
  find "$CONTENT_ROOT" -type d -name '.*.import-*' -print0 2>/dev/null
)
if (( ${#partials[@]} > 0 )); then
  printf '错误：发现未完成的Word导入临时目录：\n' >&2
  printf '  %s\n' "${partials[@]}" >&2
  exit 1
fi

count=0
if [[ -d "$ROOT/incoming" ]]; then
  count="$(find "$ROOT/incoming" -maxdepth 1 -type f -iname '*.docx' | wc -l | tr -d ' ')"
fi
printf 'Word内容检查通过：公开目录不含原稿；incoming保留 %s 份本地Word文件。\n' "$count"
