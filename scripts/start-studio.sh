#!/usr/bin/env bash
# 启动《历代纪》本地作者工作台（Word 导入中心），只监听 127.0.0.1。
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
    printf '错误：缺少作者工作台运行环境。请先双击import-docx.command完成首次环境初始化。\n' >&2
    exit 1
fi

cd "$ROOT"
exec "$PYTHON" -m studio --project-root "$ROOT" "$@"
