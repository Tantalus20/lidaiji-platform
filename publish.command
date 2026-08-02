#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
"$ROOT/scripts/publish.sh"
status=$?
if [[ $status -eq 0 ]]; then printf '\n发布流程已完成。\n'; else printf '\n发布失败（错误码 %s），旧站未被替换或已自动回滚。\n' "$status"; fi
read -r -p '按回车关闭窗口……' _
exit "$status"
