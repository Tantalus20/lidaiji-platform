#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
VERSION="0.162.0"
EXPECTED="5e7d0447110fdddb23fc1bf586e4f27441c8d35be451a356190147830e716aeb"
URL="https://github.com/gohugoio/hugo/releases/download/v${VERSION}/hugo_${VERSION}_darwin-universal.pkg"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/writing-hugo.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

printf '正在下载 Hugo %s 官方构建包……\n' "$VERSION"
curl -fL --retry 3 -o "$TMP/hugo.pkg" "$URL"
ACTUAL="$(shasum -a 256 "$TMP/hugo.pkg" | awk '{print $1}')"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  printf '错误：Hugo 安装包校验失败。\n' >&2
  exit 1
fi

pkgutil --expand-full "$TMP/hugo.pkg" "$TMP/expanded"
install -m 755 "$TMP/expanded/Payload/hugo" "$ROOT/.hugo-local"
"$ROOT/.hugo-local" version
printf 'Hugo 已安装到项目本地，不会修改系统目录。\n'

