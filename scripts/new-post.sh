#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/common.sh"
WORKSPACE_JSON="$(python3 "$ROOT/tools/workspace.py" show --platform-root "$ROOT" --writable-demo)"
CONTENT_REPO_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRepoRoot"])' "$WORKSPACE_JSON")"
CONTENT_ROOT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["contentRoot"])' "$WORKSPACE_JSON")"
printf '写入目标：%s\n' "$CONTENT_REPO_ROOT"

printf '新建文章\n'
printf '1) 文集文章\n2) 随笔\n3) 资料文章\n'
read -r -p '请选择内容类型 [1-3]：' kind
case "$kind" in
  1) section="works"; read -r -p '文集目录slug（例如 sample-collection）：' collection_slug ;;
  2) section="essays"; collection_slug="" ;;
  3) section="archives"; collection_slug="" ;;
  *) printf '错误：无效的内容类型。\n' >&2; exit 1 ;;
esac

read -r -p '文章标题：' title
read -r -p '稳定slug（小写英文、数字和连字符）：' slug
read -r -p '所属文集显示名（可留空）：' collection_name
read -r -p '分类（可留空）：' category
read -r -p '是否保存为草稿？[Y/n]：' draft_answer

if [[ -z "$title" || ! "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  printf '错误：标题不能为空；slug只能包含小写英文、数字和单个连字符。\n' >&2
  exit 1
fi

if [[ "$section" == "works" ]]; then
  if [[ ! "$collection_slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    printf '错误：文集目录slug格式不正确。\n' >&2
    exit 1
  fi
  target="$CONTENT_ROOT/works/$collection_slug/$slug"
else
  target="$CONTENT_ROOT/$section/$slug"
fi
if [[ -e "$target" ]]; then
  printf '错误：目录已经存在：%s\n' "$target" >&2
  exit 1
fi

safe_title="${title//\"/\\\"}"
safe_collection="${collection_name//\"/\\\"}"
safe_category="${category//\"/\\\"}"
draft="true"
[[ "${draft_answer,,}" == "n" ]] && draft="false"
today="$(date +%F)"
article_id="$(python3 -c 'import secrets; print("article-" + secrets.token_hex(8))')"
comments_python="${WRITING_IMPORT_PYTHON:-$ROOT/.venv-importer/bin/python}"
[[ -x "$comments_python" ]] || comments_python="$(command -v python3)"
mkdir -p "$target"
{
  printf '%s\n' '---'
  printf 'title: "%s"\n' "$safe_title"
  printf '%s\n' 'subtitle: ""'
  printf 'date: %s\nlastmod: %s\n' "$today" "$today"
  printf 'slug: "%s"\n' "$slug"
  printf '%s\n' 'description: ""'
  printf 'articleId: "%s"\n' "$article_id"
  printf '%s\n' 'comments:' '  paragraph: true'
  printf 'draft: %s\nfeatured: false\nweight: 10\n' "$draft"
  printf '%s\n' 'volume: ""'
  if [[ -n "$safe_collection" ]]; then printf 'collections: ["%s"]\nseries: ["%s"]\n' "$safe_collection" "$safe_collection"; else printf 'collections: []\nseries: []\n'; fi
  if [[ -n "$safe_category" ]]; then printf 'categories: ["%s"]\n' "$safe_category"; else printf 'categories: []\n'; fi
  printf '%s\n' 'tags: []' 'period: []' 'people: []' 'places: []' 'aliases: []' '---' '' '在这里开始写作。'
} > "$target/index.md"
"$comments_python" "$ROOT/scripts/comments-prepare.py" --project-root "$CONTENT_REPO_ROOT" --write >/dev/null

printf '\n文章已创建：%s\n' "$target/index.md"
if [[ "$section" == "works" ]]; then
  printf '永久链接：/works/%s/%s/\n' "$collection_slug" "$slug"
else
  printf '永久链接：/%s/%s/\n' "$section" "$slug"
fi
