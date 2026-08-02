#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
"$ROOT/scripts/start-studio.sh"
status=$?
if [[ $status -ne 0 ]]; then
  printf '\n作者工作台已退出（错误码 %s）。\n' "$status"
  read -r -p '按回车关闭窗口……' _
fi
exit "$status"
