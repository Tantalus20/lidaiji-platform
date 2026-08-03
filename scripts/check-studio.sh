#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

candidates=()
[[ -n "${WRITING_IMPORT_PYTHON:-}" ]] && candidates+=("$WRITING_IMPORT_PYTHON")
candidates+=("$ROOT/.venv-importer/bin/python3")
command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")

PYTHON=""
for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]] && "$candidate" -c 'import docx, PIL, yaml, pypinyin' >/dev/null 2>&1; then
        PYTHON="$candidate"
        break
    fi
done
if [[ -z "$PYTHON" ]]; then
  printf '错误：缺少作者工作台测试依赖。请先双击import-docx.command完成首次环境初始化。\n' >&2
  exit 1
fi

"$PYTHON" "$ROOT/tests/test_studio.py"
"$PYTHON" "$ROOT/tests/test_studio_articles.py"
"$PYTHON" "$ROOT/tests/test_studio_versions.py"
"$PYTHON" "$ROOT/tests/test_studio_media.py"
"$PYTHON" "$ROOT/tests/test_studio_feedback.py"
"$PYTHON" "$ROOT/tests/test_studio_notes.py"
"$PYTHON" "$ROOT/tests/test_preview_render.py"
printf '作者工作台自动测试通过。\n'
