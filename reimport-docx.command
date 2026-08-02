#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
printf '重新导入会先把旧版Markdown和图片保存到“历代纪文稿备份”。\n'
"$ROOT/scripts/import-docx.sh"
status=$?
if [[ $status -ne 0 ]]; then read -r -p '按回车关闭窗口……' _; fi
exit "$status"
