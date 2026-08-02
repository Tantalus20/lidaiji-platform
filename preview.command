#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
"$ROOT/scripts/preview.sh"
status=$?
if [[ $status -ne 0 ]]; then printf '\n预览启动失败（错误码 %s）。\n' "$status"; read -r -p '按回车关闭窗口……' _; fi
exit "$status"
