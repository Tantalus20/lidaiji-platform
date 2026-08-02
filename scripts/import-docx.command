#!/bin/bash
set -u
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
"$ROOT/import-docx.command"
