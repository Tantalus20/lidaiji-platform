#!/usr/bin/env bash
# 分享站长文站构建：build → candidate → 敏感扫描 → manifest → verify →
# 不可变 release → current 原子切换。
# 与正式作品站（scripts/build.sh → dist/site）完全独立，互不触发。
#
# 环境变量：
#   LIDAIJI_SHARE_CONTENT_ROOT  分享私有内容根（缺省为仓库上一级 lidaiji-share-private）
#   SHARE_BASE_URL              站点 baseURL（缺省 http://localhost:1314/）
#   SHARE_OUT                   输出根（缺省 $ROOT/dist）
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
HUGO="$(find_hugo)"
require_command python3

candidates=()
[[ -n "${WRITING_IMPORT_PYTHON:-}" ]] && candidates+=("$WRITING_IMPORT_PYTHON")
candidates+=("$ROOT/.venv-importer/bin/python3")
command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")
PYTHON=""
for candidate in "${candidates[@]}"; do
  if [[ -x "$candidate" ]] && "$candidate" -c 'import yaml' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  printf '错误：缺少 Python（需要 yaml）。\n' >&2
  exit 1
fi

BASE_URL="${SHARE_BASE_URL:-http://localhost:1314/}"
OUT="${SHARE_OUT:-$ROOT/dist}"
CAND_DIR="$OUT/share-candidates"
CURRENT="$OUT/share"
PREVIOUS="$OUT/share.previous"
START="$(date +%s)"

# 私有内容根安全校验 + 全部分享项 schema/身份校验（任一失败即停止）
"$PYTHON" "$ROOT/scripts/check-share-content.py" "$ROOT"

mkdir -p "$CAND_DIR"
CANDIDATE="$(mktemp -d "$CAND_DIR/candidate.XXXXXX")"
cleanup() {
  if [[ -d "$CANDIDATE" ]]; then
    rm -rf "$CANDIDATE"
  fi
}
trap cleanup EXIT

mkdir -p "$ROOT/.cache/hugo-share"
CONTENT_DIR="$("$PYTHON" -c '
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from studio import share
root = share.share_root(Path(sys.argv[1]))
print(root / "items")
' "$ROOT")"
"$HUGO" --source "$ROOT/share-site" --contentDir "$CONTENT_DIR" --minify --gc --cleanDestinationDir \
  --cacheDir "$ROOT/.cache/hugo-share" --baseURL "$BASE_URL" \
  --destination "$CANDIDATE/site"

# 候选清单（逐文件 SHA-256 + 可重现 candidateId）+ 敏感扫描（复用正式站工具）
"$PYTHON" - "$ROOT" "$CANDIDATE/site" "$CANDIDATE" "$BASE_URL" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from share_publisher.candidate import build_share_candidate_manifest, write_candidate_manifest, verify_share_candidate
from studio.sensitive_scan import scan_candidate

site_dir = Path(sys.argv[2])
candidate_dir = Path(sys.argv[3])
base_url = sys.argv[4]

manifest = build_share_candidate_manifest(site_dir, base_url)
scan = scan_candidate(candidate_dir)
if scan["blocked"]:
    print(f"敏感扫描阻断：{scan['findingCount']} 项（只报告类型与位置，不回显内容）。", file=sys.stderr)
    for finding in scan["findings"][:10]:
        print(f"- {finding}", file=sys.stderr)
    sys.exit(1)
errors = verify_share_candidate(candidate_dir, manifest)
if errors:
    for message in errors:
        print(f"候选校验失败：{message}", file=sys.stderr)
    sys.exit(1)
_, digest = write_candidate_manifest(candidate_dir, manifest)
print(f"候选 manifest 已生成（candidateId={manifest['candidateId']}，{manifest['fileCount']} 个文件）。")
print(f"SHA256：{digest}")
PY

SITE_DIR="$CANDIDATE/site" node "$ROOT/tests/check-share-site.mjs" "$ROOT"

# 浏览统计身份清单（V1）：items/<shareId>/index.md → shareId/slug/title/draft，
# 草稿剔除；供 stats 服务校验 share 身份（存在即 published）。
"$PYTHON" "$ROOT/scripts/build-share-identity-manifest.py" "$ROOT" "$OUT/share-identity-manifest.json"

# 原子切换：current → previous，candidate → current（均为符号链接，指向不可变候选）
if [[ -L "$CURRENT" ]]; then
  rm -f "$PREVIOUS"
  ln -s "$(readlink "$CURRENT")" "$PREVIOUS"
fi
ln -sfn "$CANDIDATE/site" "$CURRENT"
cp "$CANDIDATE/manifest.json" "$OUT/share-manifest.json"
cp "$CANDIDATE/manifest.sha256" "$OUT/share-manifest.sha256"
trap - EXIT

END="$(date +%s)"
SIZE="$(du -sh "$CANDIDATE/site" | awk '{print $1}')"
PAGES="$(find "$CANDIDATE/site" -name '*.html' | wc -l | tr -d ' ')"
printf '分享站构建成功：%s 个HTML页面，目录大小 %s，耗时 %s 秒。\n' "$PAGES" "$SIZE" "$((END - START))"
printf '候选：%s\n' "$CANDIDATE/site"
printf 'manifest：%s\n' "$CANDIDATE/manifest.json"
printf 'SHA256：%s\n' "$(awk '{print $1}' "$CANDIDATE/manifest.sha256")"
printf 'current：%s → %s\n' "$CURRENT" "$(readlink "$CURRENT")"
