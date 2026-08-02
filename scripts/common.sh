#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

find_hugo() {
  if [[ -n "${HUGO_BIN:-}" && -x "${HUGO_BIN}" ]]; then
    printf '%s\n' "$HUGO_BIN"
    return
  fi
  if [[ -x "$ROOT/.hugo-local" ]]; then
    printf '%s\n' "$ROOT/.hugo-local"
    return
  fi
  if command -v hugo >/dev/null 2>&1; then
    command -v hugo
    return
  fi
  printf '错误：未找到 Hugo。请先运行 scripts/install-hugo-macos.sh，或设置 HUGO_BIN。\n' >&2
  return 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '错误：缺少命令 %s。\n' "$1" >&2
    return 1
  fi
}

pause_on_error() {
  local code=$?
  if [[ $code -ne 0 && -t 0 ]]; then
    printf '\n操作失败，按回车键关闭窗口。'
    read -r _
  fi
  exit "$code"
}

