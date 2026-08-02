#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
export WRITING_BACKUP_DIR="${WRITING_BACKUP_DIR:-$HOME/Documents/历代纪备份}"
"$ROOT/scripts/backup.sh"
status=$?
if [[ $status -eq 0 ]]; then printf '\n备份已保存到：%s\n' "$WRITING_BACKUP_DIR"; else printf '\n备份失败（错误码 %s）。\n' "$status"; fi
read -r -p '按回车关闭窗口……' _
exit "$status"
