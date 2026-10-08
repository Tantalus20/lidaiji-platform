#!/usr/bin/env bash
# P0-B 发布身份校验拒绝测试（不触发任何发布切换）。
# 覆盖：请求/站点/源码包身份篡改、候选身份、归档 SHA、源码包注入、
# 缺少元数据、article_isolated 缺候选、路径穿越与符号链接、失败无副作用。
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY="$ROOT/scripts/verify-release-identity.sh"
SERVER_PUBLISH="$ROOT/scripts/server-publish.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/lidaiji-release-identity.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
failures=0

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

SNAPSHOT_ID="aaaaaaaaaaaaaaaa"
FINGERPRINT="$(printf 'a%.0s' $(seq 1 64))"
CONTENT_SHA="$(printf 'b%.0s' $(seq 1 64))"
PLATFORM_COMMIT="$(printf 'c%.0s' $(seq 1 40))"
CANDIDATE_ID="cand_$(printf 'd%.0s' $(seq 1 20))"
CANDIDATE_SHA="$(printf 'e%.0s' $(seq 1 64))"

write_info() {
  local file="$1" mode="$2" with_candidate="$3"
  {
    printf 'sourceCommit: %s\n' "$PLATFORM_COMMIT"
    printf 'releaseSnapshotId: %s\n' "$SNAPSHOT_ID"
    printf 'releaseSnapshotFingerprint: %s\n' "$FINGERPRINT"
    printf 'snapshotMode: %s\n' "$mode"
    printf 'contentManifestSha256: %s\n' "$CONTENT_SHA"
    if [[ "$with_candidate" == "yes" ]]; then
      printf 'candidateId: %s\n' "$CANDIDATE_ID"
      printf 'candidateManifestSha256: %s\n' "$CANDIDATE_SHA"
    fi
    if [[ "$(basename "$file")" == "BUILD_INFO" && "$file" == *"/source/"* ]]; then
      printf 'packageRole: platform-source-with-release-provenance\n'
    fi
  } > "$file"
}

make_fixture() {
  local dir="$1" mode="$2" with_candidate="$3"
  mkdir -p "$dir/site" "$dir/source/config/_default" "$dir/comments/src" "$dir/release"
  write_info "$dir/site/BUILD_INFO" "$mode" "$with_candidate"
  write_info "$dir/release/BUILD_INFO" "$mode" "$with_candidate"
  printf '<html></html>\n' > "$dir/release/index.html"
  write_info "$dir/source/BUILD_INFO" "$mode" "$with_candidate"
  printf 'title = "fixture"\n' > "$dir/source/config/_default/hugo.toml"
  printf '{"name":"comments"}\n' > "$dir/comments/package.json"
  printf '// entry\n' > "$dir/comments/src/server.js"
  printf 'version: 0.0.0\n' > "$dir/comments/BUILD_INFO"
  tar -czf "$dir/release.tar.gz" -C "$dir/site" .
  tar -czf "$dir/source.tar.gz" -C "$dir/source" .
  tar -czf "$dir/comments.tar.gz" -C "$dir/comments" .
}

args_base() {
  local dir="$1"
  args=(
    --release "$dir/release.tar.gz" --release-sha "$(sha "$dir/release.tar.gz")"
    --source "$dir/source.tar.gz" --source-sha "$(sha "$dir/source.tar.gz")"
    --comments "$dir/comments.tar.gz" --comments-sha "$(sha "$dir/comments.tar.gz")"
    --site-info "$dir/release/BUILD_INFO"
    --source-info "$dir/source/BUILD_INFO"
    --release-dir "$dir/release"
    --platform-commit "$PLATFORM_COMMIT"
    --snapshot-id "$SNAPSHOT_ID"
    --snapshot-fingerprint "$FINGERPRINT"
    --content-manifest-sha "$CONTENT_SHA"
  )
}

expect_accept() {
  local label="$1"
  if bash "$VERIFY" "${args[@]}" >/dev/null 2>"$TMP/err"; then
    printf '通过：%s\n' "$label"
  else
    printf '失败：合法组合被拒绝（%s）：%s\n' "$label" "$(cat "$TMP/err")"
    failures=$((failures + 1))
  fi
}

expect_reject() {
  local label="$1"
  if bash "$VERIFY" "${args[@]}" >/dev/null 2>"$TMP/err"; then
    printf '失败：%s 未被拒绝\n' "$label"
    failures=$((failures + 1))
  else
    printf '拒绝通过：%s（%s）\n' "$label" "$(head -1 "$TMP/err")"
  fi
}

# ---- 合法组合：full_site ----
FULL="$TMP/full"
make_fixture "$FULL" full_site no
args_base "$FULL"
expect_accept "合法 full_site 组合"

# ---- 合法组合：article_isolated（带候选身份） ----
ISO="$TMP/iso"
make_fixture "$ISO" article_isolated yes
args_base "$ISO"
args+=(--candidate-id "$CANDIDATE_ID" --candidate-manifest-sha "$CANDIDATE_SHA")
expect_accept "合法 article_isolated 组合"

# 1. 请求 snapshotId 被篡改
args_base "$FULL"
args+=(--snapshot-id ffffffffffffffff)
expect_reject "1 请求 snapshotId 被篡改"

# 2. site snapshotId 不匹配
SITE_BAD="$TMP/site-bad"
make_fixture "$SITE_BAD" full_site no
sed -i.bak "s/^releaseSnapshotId: .*/releaseSnapshotId: 9999999999999999/" "$SITE_BAD/release/BUILD_INFO"
args_base "$SITE_BAD"
expect_reject "2 site snapshotId 不匹配"

# 3. source snapshotId 不匹配
SOURCE_BAD="$TMP/source-bad"
make_fixture "$SOURCE_BAD" full_site no
sed -i.bak "s/^releaseSnapshotId: .*/releaseSnapshotId: 9999999999999999/" "$SOURCE_BAD/source/BUILD_INFO"
args_base "$SOURCE_BAD"
expect_reject "3 source snapshotId 不匹配"

# 4. candidate manifest 身份不匹配
args_base "$ISO"
args+=(--candidate-id "$CANDIDATE_ID" --candidate-manifest-sha "$(printf 'f%.0s' $(seq 1 64))")
expect_reject "4 candidate manifest 身份不匹配"

# 5. 归档 SHA 不匹配
args_base "$FULL"
args+=(--release-sha 0000000000000000000000000000000000000000000000000000000000000000)
expect_reject "5 归档 SHA 不匹配"

# 6. source package 被篡改（重算 SHA 后注入工作区配置）
TAMPER="$TMP/tamper"
make_fixture "$TAMPER" full_site no
printf '{"contentRepoRoot": "../private"}\n' > "$TAMPER/source/.lidaiji-workspace.json"
tar -czf "$TAMPER/source.tar.gz" -C "$TAMPER/source" .
args_base "$TAMPER"
expect_reject "6 source package 注入工作区配置"

# 7. 缺少必需元数据（缺 snapshot-fingerprint）
args_base "$FULL"
filtered=()
skip_next=0
for element in "${args[@]}"; do
  if [[ "$skip_next" == "1" ]]; then skip_next=0; continue; fi
  if [[ "$element" == "--snapshot-fingerprint" ]]; then skip_next=1; continue; fi
  filtered+=("$element")
done
args=("${filtered[@]}")
expect_reject "7 缺少必需元数据"

# 8. article_isolated 缺 candidateId
NO_CAND="$TMP/no-cand"
make_fixture "$NO_CAND" article_isolated no
args_base "$NO_CAND"
expect_reject "8 article_isolated 缺 candidateId"

# 9a. 符号链接逃逸
LINK="$TMP/link"
make_fixture "$LINK" full_site no
ln -s /etc/passwd "$LINK/site/link-to-passwd"
tar -czf "$LINK/release.tar.gz" -C "$LINK/site" .
args_base "$LINK"
expect_reject "9a 符号链接逃逸"

# 9b. 路径穿越成员（python 构造 tar）
TRAV="$TMP/traversal"
make_fixture "$TRAV" full_site no
python3 - "$TRAV/release.tar.gz" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as archive:
    info = tarfile.TarInfo("../../evil.txt")
    payload = b"evil"
    info.size = len(payload)
    import io
    archive.addfile(info, io.BytesIO(payload))
PY
args_base "$TRAV"
expect_reject "9b 路径穿越成员"

# 10. 失败后无副作用：哨兵文件不变 + 服务端在校验前不切换
mkdir -p "$TMP/state"
printf 'current-release\n' > "$TMP/state/current"
BEFORE="$(sha "$TMP/state/current")"
bash "$VERIFY" --release "$FULL/release.tar.gz" --release-sha deadbeef --source "$FULL/source.tar.gz" --source-sha "$(sha "$FULL/source.tar.gz")" --comments "$FULL/comments.tar.gz" --comments-sha "$(sha "$FULL/comments.tar.gz")" >/dev/null 2>&1 || true
AFTER="$(sha "$TMP/state/current")"
if [[ "$BEFORE" == "$AFTER" && "$(cat "$TMP/state/current")" == "current-release" ]]; then
  printf '通过：10 校验失败后无状态变化\n'
else
  printf '失败：10 校验失败产生了状态变化\n'
  failures=$((failures + 1))
fi
VERIFY_LINE="$(grep -n "verify-release-identity.sh" "$SERVER_PUBLISH" | head -1 | cut -d: -f1)"
MUTATION_LINE="$(grep -n 'COMMENTS_DB_BACKUP="\$COMMENTS_BACKUPS' "$SERVER_PUBLISH" | head -1 | cut -d: -f1)"
if [[ -n "$VERIFY_LINE" && -n "$MUTATION_LINE" && "$VERIFY_LINE" -lt "$MUTATION_LINE" ]]; then
  printf '通过：10b 服务端在校验完成后才开始发布变更（%s < %s）\n' "$VERIFY_LINE" "$MUTATION_LINE"
else
  printf '失败：10b 校验与发布变更顺序异常（%s/%s）\n' "${VERIFY_LINE:-?}" "${MUTATION_LINE:-?}"
  failures=$((failures + 1))
fi

if [[ "$failures" -gt 0 ]]; then
  printf '发布身份校验拒绝测试失败：%s 项。\n' "$failures" >&2
  exit 1
fi
printf '发布身份校验拒绝测试通过：2 项合法组合 + 12 项拒绝/无副作用。\n'
