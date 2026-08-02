#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
"$ROOT/scripts/build.sh"
status=$?
if [[ $status -eq 0 ]]; then printf '\n网站构建完成。\n'; else printf '\n网站构建失败（错误码 %s）。\n' "$status"; fi
read -r -p '按回车关闭窗口……' _
exit "$status"
