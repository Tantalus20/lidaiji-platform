#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"

find_import_python() {
  local candidates=()
  [[ -n "${WRITING_IMPORT_PYTHON:-}" ]] && candidates+=("$WRITING_IMPORT_PYTHON")
  candidates+=("$ROOT/.venv-importer/bin/python3")
  command -v python3 >/dev/null 2>&1 && candidates+=("$(command -v python3)")

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]] && "$candidate" -c 'import docx, PIL, yaml, pypinyin' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  require_command python3
  printf '首次使用：正在建立本地Word导入环境（只需一次）……\n' >&2
  python3 -m venv "$ROOT/.venv-importer"
  "$ROOT/.venv-importer/bin/python3" -m pip install \
    --disable-pip-version-check \
    -r "$ROOT/importer/requirements.txt" >&2
  printf '%s\n' "$ROOT/.venv-importer/bin/python3"
}

choose_input() {
  shopt -s nullglob
  local files=("$ROOT"/incoming/*.docx)
  local unsafe=("$ROOT"/incoming/*.docm)
  if (( ${#unsafe[@]} > 0 )); then
    printf '错误：来稿箱中发现.docm文件。为避免宏风险，本工具只接受.docx：\n' >&2
    printf '  %s\n' "${unsafe[@]}" >&2
    return 2
  fi
  if (( ${#files[@]} == 0 )); then
    printf '来稿箱里还没有Word文件。\n请把.docx拖入：%s\n' "$ROOT/incoming"
    return 1
  fi
  if (( ${#files[@]} == 1 )); then
    input="${files[0]}"
    printf '找到Word来稿：%s\n' "$(basename "$input")"
    return
  fi
  printf '请选择要导入的Word文件：\n'
  select input in "${files[@]}"; do
    [[ -n "${input:-}" ]] && return
    printf '请输入列表中的数字。\n'
  done
}

load_suggestion() {
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
    "$PYTHON" "$ROOT/importer/docx-assistant.py" "$input" \
      --project-root "$CONTENT_REPO_ROOT" --format shell
  )
}

advanced_questions() {
  local value=""
  read -r -p "文章标题 [$title]：" value
  title="${value:-$title}"
  printf '内容类型：1.文集文章  2.随笔  3.资料与档案\n'
  case "$section" in works) value=1 ;; essays) value=2 ;; archives) value=3 ;; esac
  read -r -p "请选择 [$value]：" section_choice
  section_choice="${section_choice:-$value}"
  case "$section_choice" in
    1)
      section="works"
      read -r -p "所属文集 [$collection]：" value
      collection="${value:-$collection}"
      read -r -p "文集slug [$collection_slug]：" value
      collection_slug="${value:-$collection_slug}"
      ;;
    2) section="essays"; collection=""; collection_slug="" ;;
    3) section="archives"; collection=""; collection_slug="" ;;
    *) printf '错误：内容类型无效。\n' >&2; return 2 ;;
  esac
  read -r -p "文章slug [$slug]：" value
  slug="${value:-$slug}"
  read -r -p "分类 [$suggested_category]：" value
  categories="${value:-$suggested_category}"
  read -r -p '标签（多个用逗号分隔，可留空）：' tags
}

choose_input
PYTHON="$(find_import_python)"
WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" show --platform-root "$ROOT" --writable-demo)"
CONTENT_REPO_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRepoRoot"])' "$WORKSPACE_JSON")"
CONTENT_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRoot"])' "$WORKSPACE_JSON")"
export LIDAIJI_CONTENT_REPO_ROOT="$CONTENT_REPO_ROOT"
export LIDAIJI_CONTENT_ROOT="$CONTENT_ROOT"
export LIDAIJI_AUTHOR_NOTES_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["authorNotesRoot"])' "$WORKSPACE_JSON")"
export LIDAIJI_SITE_OVERRIDES_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["siteOverridesRoot"])' "$WORKSPACE_JSON")"
printf '导入目标内容仓库：%s\n' "$CONTENT_REPO_ROOT"

title=""
section=""
collection=""
collection_slug=""
slug=""
suggested_category=""
target=""
article_url=""
existing="False"
load_suggestion

printf '\n已自动识别：\n'
printf '  标题：%s\n' "$title"
if [[ "$section" == "works" ]]; then
  printf '  文集：%s\n' "$collection"
elif [[ "$section" == "essays" ]]; then
  printf '  栏目：随笔\n'
else
  printf '  栏目：资料与档案\n'
fi
printf '  链接：%s\n\n' "$article_url"

categories="$suggested_category"
tags=""
if [[ "${WRITING_ADVANCED_IMPORT:-0}" == "1" ]]; then
  advanced_questions
else
  categories="$suggested_category"
fi

read -r -p '现在就公开发布这篇文章？[y/N]：' publish_answer
draft_flag="--draft"
if [[ "${publish_answer:-N}" =~ ^[Yy]$ ]]; then draft_flag="--no-draft"; fi

# 高级模式可能改变路径，重新计算URL与目标。
if [[ "$section" == "works" ]]; then
  target="$CONTENT_ROOT/works/$collection_slug/$slug"
  article_url="/works/$collection_slug/$slug/"
else
  target="$CONTENT_ROOT/$section/$slug"
  article_url="/$section/$slug/"
fi

force_reimport=0
import_backup_dir=""
if [[ -d "$target" ]]; then
  printf '\n检测到这篇文章已经导入过：%s\n' "$target"
  read -r -p '重新导入，并在“文稿备份”中保留旧版？[y/N]：' replace_answer
  if [[ ! "${replace_answer:-N}" =~ ^[Yy]$ ]]; then
    printf '已取消，旧文章没有变化。\n'
    exit 0
  fi
  force_reimport=1
  import_backup_dir="${WRITING_IMPORT_BACKUP_DIR:-$HOME/Documents/Lidaiji文稿备份}"
fi

args=(
  "$PYTHON" "$ROOT/importer/docx-importer.py" "$input"
  --project-root "$CONTENT_REPO_ROOT"
  --section "$section"
  --title "$title"
  --slug "$slug"
  "$draft_flag"
)
if [[ "$force_reimport" == "1" ]]; then
  args+=(--force --backup-dir "$import_backup_dir")
fi
if [[ "$section" == "works" ]]; then
  args+=(--collection "$collection" --collection-slug "$collection_slug")
fi
[[ -n "$categories" ]] && args+=(--category "$categories")
[[ -n "$tags" ]] && args+=(--tag "$tags")

"${args[@]}"
printf '\nWord原稿仍保留在：%s\n' "$input"
printf '新文章地址：http://127.0.0.1:1313%s\n' "$article_url"

if [[ "${WRITING_SKIP_PREVIEW:-0}" != "1" ]]; then
  printf '正在打开新文章预览。关闭窗口或按 Control+C 可停止预览。\n'
  exec "$ROOT/scripts/preview.sh" "$article_url"
fi
