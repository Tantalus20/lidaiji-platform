#!/usr/bin/env bash
# 简单日志轮转：单个文件超过 10MB 时归档，保留最近 3 份。
# 轮转失败不影响服务（调用方以 best-effort 方式调用）。
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

MAX_BYTES=10485760
KEEP=3

rotate_one() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  local size
  size="$(stat -f '%z' "$file" 2>/dev/null || printf '0')"
  (( size < MAX_BYTES )) && return 0
  local i
  for (( i = KEEP; i > 1; i-- )); do
    if [[ -f "$file.$((i - 1))" ]]; then
      mv -f "$file.$((i - 1))" "$file.$i" 2>/dev/null || true
    fi
  done
  mv -f "$file" "$file.1" 2>/dev/null || true
}

mkdir -p "$LOG_DIR"
rotate_one "$STDOUT_LOG"
rotate_one "$STDERR_LOG"
rotate_one "$LAUNCHER_LOG"
exit 0
