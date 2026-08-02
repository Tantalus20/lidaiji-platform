#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" show --platform-root "$ROOT" --writable-demo)"
CONTENT_REPO_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRepoRoot"])' "$WORKSPACE_JSON")"
CONTENT_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRoot"])' "$WORKSPACE_JSON")"
export LIDAIJI_CONTENT_REPO_ROOT="$CONTENT_REPO_ROOT"
export LIDAIJI_CONTENT_ROOT="$CONTENT_ROOT"
export LIDAIJI_AUTHOR_NOTES_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["authorNotesRoot"])' "$WORKSPACE_JSON")"
export LIDAIJI_SITE_OVERRIDES_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["siteOverridesRoot"])' "$WORKSPACE_JSON")"

find_import_python() {
  local candidates=()
  [[ -n "${WRITING_IMPORT_PYTHON:-}" ]] && candidates+=("$WRITING_IMPORT_PYTHON")
  candidates+=("$ROOT/.venv-importer/bin/python3")
  command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]] && "$candidate" -c 'import docx, PIL, yaml, pypinyin' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  require_command python3
  python3 -m venv "$ROOT/.venv-importer"
  "$ROOT/.venv-importer/bin/python3" -m pip install \
    --disable-pip-version-check -r "$ROOT/importer/requirements.txt" >&2
  printf '%s\n' "$ROOT/.venv-importer/bin/python3"
}

load_inference() {
  title=""; section=""; collection=""; collection_slug=""; slug=""
  suggested_category=""; target=""; article_url=""; existing="False"
  while IFS=$'\t' read -r key value; do
    case "$key" in
      title) title="$value" ;;
      section) section="$value" ;;
      collection) collection="$value" ;;
      collection_slug) collection_slug="$value" ;;
      slug) slug="$value" ;;
      category) suggested_category="$value" ;;
      target) target="$value" ;;
      url) article_url="$value" ;;
      existing) existing="$value" ;;
    esac
  done < <(
    "$PYTHON" "$ROOT/importer/docx-assistant.py" "$INPUT" \
      --project-root "$CONTENT_REPO_ROOT" --format shell
  )
}

start_preview() {
  local pathname="${1:-/}"
  [[ "$pathname" == /* ]] || pathname="/$pathname"
  mkdir -p "$ROOT/.cache/hugo"
  local pidfile="$ROOT/.cache/gui-preview.pid"
  local logfile="$ROOT/.cache/gui-preview.log"
  if [[ -f "$pidfile" ]]; then
    local old_pid
    old_pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      printf 'URL\thttp://127.0.0.1:1313%s\n' "$pathname"
      return
    fi
  fi
  (
    cd "$ROOT"
    nohup "$ROOT/scripts/preview.sh" "/" \
      >"$logfile" 2>&1 </dev/null &
    printf '%s\n' "$!" >"$pidfile"
  )
  for _ in {1..80}; do
    if curl --silent --fail "http://127.0.0.1:1313/" >/dev/null 2>&1; then
      printf 'URL\thttp://127.0.0.1:1313%s\n' "$pathname"
      return
    fi
    sleep 0.1
  done
  printf '预览启动失败，请查看：%s\n' "$logfile" >&2
  return 1
}

stop_preview() {
  local pidfile="$ROOT/.cache/gui-preview.pid"
  if [[ ! -f "$pidfile" ]]; then
    printf '本地预览当前没有运行。\n'
    return
  fi
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
  fi
  rm -f "$pidfile"
  printf '本地预览已停止。\n'
}

save_settings() {
  local ssh_target="$1"
  local domain="$2"
  if [[ ! "$ssh_target" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]]; then
    printf '服务器格式不正确，应类似 user@example.com。\n' >&2
    return 2
  fi
  if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ ]]; then
    printf '域名格式不正确。\n' >&2
    return 2
  fi
  umask 077
  printf 'WRITING_SSH_TARGET=%s\nWRITING_DOMAIN=%s\n' "$ssh_target" "$domain" >"$ROOT/.author-settings"
  printf '发布设置已保存。\n'
}

load_settings() {
  WRITING_SSH_TARGET=""
  WRITING_DOMAIN=""
  [[ -f "$ROOT/.author-settings" ]] || return 1
  while IFS='=' read -r key value; do
    case "$key" in
      WRITING_SSH_TARGET) WRITING_SSH_TARGET="$value" ;;
      WRITING_DOMAIN) WRITING_DOMAIN="$value" ;;
    esac
  done <"$ROOT/.author-settings"
  [[ -n "$WRITING_SSH_TARGET" && -n "$WRITING_DOMAIN" ]]
}

ACTION="${1:-}"
case "$ACTION" in
  infer)
    INPUT="${2:?缺少Word文件}"
    PYTHON="$(find_import_python)"
    load_inference
    printf 'TITLE\t%s\n' "$title"
    printf 'LOCATION\t%s\n' "${collection:-$section}"
    printf 'SLUG\t%s\n' "$slug"
    printf 'CATEGORY\t%s\n' "$suggested_category"
    printf 'EXISTING\t%s\n' "$existing"
    printf 'URL\t%s\n' "$article_url"
    ;;
  import)
    INPUT="${2:?缺少Word文件}"
    PUBLIC="${3:-0}"
    REPLACE="${4:-0}"
    PYTHON="$(find_import_python)"
    load_inference
    draft_flag="--draft"
    [[ "$PUBLIC" == "1" ]] && draft_flag="--no-draft"
    args=(
      "$PYTHON" "$ROOT/importer/docx-importer.py" "$INPUT"
      --project-root "$CONTENT_REPO_ROOT" --section "$section"
      --title "$title" --slug "$slug" "$draft_flag"
    )
    if [[ "$section" == "works" ]]; then
      args+=(--collection "$collection" --collection-slug "$collection_slug")
    fi
    [[ -n "$suggested_category" ]] && args+=(--category "$suggested_category")
    if [[ -d "$target" ]]; then
      if [[ "$REPLACE" != "1" ]]; then
        printf '这篇文章已经存在，未覆盖旧稿。\n' >&2
        exit 3
      fi
      args+=(--force --backup-dir "${WRITING_IMPORT_BACKUP_DIR:-$HOME/Documents/历代纪文稿备份}")
    fi
    "${args[@]}"
    printf 'ARTICLE_URL\t%s\n' "$article_url"
    ;;
  preview) start_preview "${2:-/}" ;;
  stop-preview) stop_preview ;;
  summary) python3 "$ROOT/scripts/publish-summary.py" --project-root "$CONTENT_REPO_ROOT" --content-root "$CONTENT_ROOT" ;;
  backup)
    WRITING_BACKUP_DIR="${WRITING_BACKUP_DIR:-$HOME/Documents/历代纪网站备份}" \
      "$ROOT/scripts/backup.sh"
    ;;
  get-settings)
    if load_settings; then
      printf 'SSH\t%s\nDOMAIN\t%s\n' "$WRITING_SSH_TARGET" "$WRITING_DOMAIN"
    else
      exit 4
    fi
    ;;
  save-settings) save_settings "${2:-}" "${3:-}" ;;
  publish)
    load_settings || { printf '尚未设置服务器和域名。\n' >&2; exit 4; }
    WRITING_SSH_TARGET="$WRITING_SSH_TARGET" \
    WRITING_DOMAIN="$WRITING_DOMAIN" \
    WRITING_ASSUME_CONFIRM=1 \
    WRITING_BACKUP_DIR="${WRITING_BACKUP_DIR:-$HOME/Documents/历代纪网站备份}" \
      "$ROOT/scripts/publish.sh"
    ;;
  open-incoming) open "$ROOT/incoming" ;;
  *)
    printf '未知操作：%s\n' "$ACTION" >&2
    exit 2
    ;;
esac
