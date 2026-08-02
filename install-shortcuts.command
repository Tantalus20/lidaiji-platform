#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"
"$ROOT/scripts/install-desktop-shortcuts.sh"
status=$?
read -r -p '按回车关闭窗口……' _
exit "$status"
