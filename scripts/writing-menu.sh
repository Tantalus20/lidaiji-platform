#!/usr/bin/env bash
set -u
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

while true; do
  printf '\n'
  printf '==============================\n'
  printf '       历代纪 · 作者工具\n'
  printf '==============================\n'
  printf '1. 打开Word来稿箱\n'
  printf '2. 快速导入Word（推荐）\n'
  printf '3. 高级导入Word\n'
  printf '4. 重新导入Word并备份旧稿\n'
  printf '5. 预览网站\n'
  printf '6. 发布网站\n'
  printf '7. 备份网站与原稿\n'
  printf '8. 新建Markdown文章\n'
  printf '9. 安装桌面快捷方式\n'
  printf '0. 退出\n'
  read -r -p '请选择：' choice
  case "$choice" in
    1)
      if command -v open >/dev/null 2>&1; then open "$ROOT/incoming"; else printf '来稿箱：%s\n' "$ROOT/incoming"; fi
      ;;
    2) "$ROOT/scripts/import-docx.sh"; exit $? ;;
    3) WRITING_ADVANCED_IMPORT=1 "$ROOT/scripts/import-docx.sh"; exit $? ;;
    4)
      printf '请选择原Word文件。识别到已有文章后，会先备份旧稿再重新导入。\n'
      "$ROOT/scripts/import-docx.sh"
      exit $?
      ;;
    5) "$ROOT/scripts/preview.sh"; exit $? ;;
    6) "$ROOT/scripts/publish.sh"; exit $? ;;
    7) "$ROOT/scripts/backup.sh"; exit $? ;;
    8) "$ROOT/scripts/new-post.sh"; exit $? ;;
    9) "$ROOT/scripts/install-desktop-shortcuts.sh" ;;
    0) exit 0 ;;
    *) printf '请输入0到9之间的数字。\n' ;;
  esac
done
