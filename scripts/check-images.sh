#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
command -v node >/dev/null 2>&1 || { printf '错误：图片检查需要Node.js。\n' >&2; exit 1; }
PROJECT_ROOT="${LIDAIJI_ACTIVE_WORKSPACE:-$ROOT}" node "$ROOT/tests/check-images.mjs"
