#!/usr/bin/env bash
# 备份/COS 外部命令超时与参数循环防御测试（v0.5.2）
# 1) 永久挂起的假 COS 命令必须被 timeout 终止并返回明确失败；
# 2) server-publish.sh 参数循环对“未消耗参数”的分支必须报错退出而非空转。
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/backup-timeout-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# 可移植超时垫片：服务器用 GNU timeout；本机（macOS）无 timeout 时用此语义
# 等价实现（超过秒数后 TERM 子进程，宽限后 SIGKILL，返回 124）。
shim_timeout() {
  local seconds="$1"
  shift
  "$@" &
  local pid=$!
  local loops=$((seconds * 2))
  for _ in $(seq 1 "$loops"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    sleep 0.5
  done
  kill -TERM "$pid" 2>/dev/null
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null
  fi
  wait "$pid" 2>/dev/null || true
  return 124
}
if command -v timeout >/dev/null 2>&1; then
  RUN_TIMEOUT=timeout
else
  RUN_TIMEOUT=shim_timeout
fi

# ---- 1) 挂起假 COS 命令 ---------------------------------------------------
FAKE="$TMP/fake-coscli"
cat > "$FAKE" << 'EOF'
#!/usr/bin/env bash
# 模拟永久挂起的 COS CLI：exec 使进程自身成为 sleep，TERM 可直达。
exec sleep 1000
EOF
chmod +x "$FAKE"

# 与 backup-to-cos.sh 相同的调用形态：timeout N COSCLI ... || 失败
START="$(date +%s)"
set +e
"$RUN_TIMEOUT" 5 "$FAKE" cp a b >/dev/null 2>&1
CODE=$?
set -e
ELAPSED="$(( $(date +%s) - START ))"
if [ "$ELAPSED" -gt 10 ]; then
  fail "挂起的假COS命令未被超时终止（耗时 ${ELAPSED}s）"
fi
[ "$CODE" -ne 0 ] || fail "挂起的假COS命令应返回非零"
echo "PASS 挂起假COS命令在 ${ELAPSED}s 内被终止（退出码 ${CODE}）"

# ---- 2) server-publish.sh 参数循环防御 ------------------------------------
# 用缺文件的方式让脚本在参数解析后立刻失败：若参数循环空转会超时退出。
START="$(date +%s)"
set +e
"$RUN_TIMEOUT" 10 bash "$ROOT/scripts/server-publish.sh" \
  --domain example.com \
  --release /nonexistent-a \
  --release-sha x \
  --source /nonexistent-b \
  --source-sha x \
  --comments /nonexistent-c \
  --comments-sha x \
  --verify-cos-backup >/dev/null 2>&1
CODE=$?
set -e
ELAPSED="$(( $(date +%s) - START ))"
if [ "$ELAPSED" -gt 10 ]; then
  fail "server-publish.sh 参数循环疑似空转（耗时 ${ELAPSED}s）"
fi
if [ "$CODE" -eq 124 ]; then
  fail "server-publish.sh 参数循环空转被 timeout 杀掉（124）"
fi
[ "$CODE" -ne 0 ] || fail "server-publish.sh 应因发布包不存在而失败"
echo "PASS server-publish.sh 参数解析在 ${ELAPSED}s 内完成（退出码 ${CODE}，非空转）"

echo "全部通过。"
