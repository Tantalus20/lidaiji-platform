#!/usr/bin/env python3
"""把本地 DOCX 转换为 Hugo Page Bundle。

本工具只解析 DOCX 压缩包中的文档内容，不运行宏、不访问外部链接，也不上传文件。
内部走 import_stages 的 parse → plan → commit 三阶段管线；命令行参数、输出与
退出码与旧版完全一致。docx-series-importer.py 依赖的函数也从这里转发。
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

# Windows 控制台默认 GBK/cp936 无法编码中文输出；统一强制 UTF-8，
# 保证 DOCX 导入在 Windows、macOS、Linux 行为一致。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from import_stages import (  # noqa: E402,F401 部分名字供 docx-series-importer 转发使用
    HEADING_STYLE,
    IMAGE_CONTENT_TYPES,
    QUOTE_STYLES,
    TITLE_STYLES,
    VALID_SLUG,
    ImageCollector,
    ImageWriter,
    ImportFailure,
    ImportOptions,
    ImportWarning,
    assign_ids,
    commit_import,
    iter_blocks,
    new_article_id,
    parse_docx,
    parse_existing_markdown,
    plan_import,
    plain_text,
    render_paragraph,
    render_table,
    revision_for,
    split_values,
    style_name,
    truncate_description,
    validate_slug,
    visible_word_count,
)

VERSION = "0.2.0"


@dataclass
class ImportResult:
    source: str
    output: str
    markdown: str
    title: str
    slug: str
    section: str
    word_count: int
    image_count: int
    backup: str
    warnings: list[ImportWarning]

    def json_dict(self) -> dict:
        data = asdict(self)
        data["warnings"] = [asdict(item) for item in self.warnings]
        return data


def options_from_args(args: argparse.Namespace) -> ImportOptions:
    return ImportOptions(
        title=args.title,
        subtitle=args.subtitle,
        slug=args.slug,
        section=args.section,
        collections=split_values(args.collection),
        collection_slug=args.collection_slug,
        categories=split_values(args.category),
        tags=split_values(args.tag),
        series=split_values(args.series),
        period=split_values(args.period),
        people=split_values(args.people),
        places=split_values(args.places),
        description=args.description,
        date=args.date,
        weight=args.weight,
        draft=bool(args.draft),
        article_id=getattr(args, "article_id", "") or "",
    )


def import_docx(args: argparse.Namespace) -> ImportResult:
    parsed = parse_docx(args.input)
    plan = plan_import(parsed, options_from_args(args), args.project_root)
    committed = commit_import(plan, parsed, args.project_root, force=args.force, backup_dir=args.backup_dir)
    return ImportResult(
        source=parsed.source.filename,
        output=committed.output,
        markdown=committed.markdown,
        title=committed.title,
        slug=committed.slug,
        section=committed.section,
        word_count=committed.word_count,
        image_count=committed.image_count,
        backup=committed.backup,
        warnings=committed.warnings,
    )


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="将本地DOCX转换为Hugo Page Bundle。")
    result.add_argument("input", type=Path, help="DOCX文件")
    result.add_argument("--project-root", type=Path, default=Path(__file__).resolve().parents[1])
    result.add_argument("--section", choices=("works", "essays", "archives"), required=True)
    result.add_argument("--title", required=True)
    result.add_argument("--subtitle", default="")
    result.add_argument("--slug", required=True)
    result.add_argument("--collection", action="append", default=[])
    result.add_argument("--collection-slug", default="")
    result.add_argument("--category", action="append", default=[])
    result.add_argument("--tag", action="append", default=[])
    result.add_argument("--series", action="append", default=[])
    result.add_argument("--period", action="append", default=[])
    result.add_argument("--people", action="append", default=[])
    result.add_argument("--places", action="append", default=[])
    result.add_argument("--description", default="")
    result.add_argument("--date", default="")
    result.add_argument("--weight", type=int, default=10)
    result.add_argument("--draft", action=argparse.BooleanOptionalAction, default=True)
    result.add_argument("--article-id", default="", help="显式指定articleId（缺省沿用旧稿或自动生成）")
    result.add_argument("--force", action="store_true")
    result.add_argument(
        "--backup-dir",
        type=Path,
        default=Path.home() / "Documents" / "历代纪导入备份",
        help="覆盖旧Page Bundle前保存旧稿的位置",
    )
    result.add_argument("--json", action="store_true", help="输出JSON结果")
    result.add_argument("--version", action="version", version=VERSION)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        result = import_docx(args)
    except (ImportFailure, ValueError, OSError) as error:
        print(f"导入失败：{error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"导入失败：无法解析Word文档（{type(error).__name__}）。", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result.json_dict(), ensure_ascii=False, indent=2))
    else:
        print(f"导入成功：{result.title}")
        print(f"生成目录：{result.output}")
        print(f"正文统计：约{result.word_count}字，{result.image_count}张图片")
        if result.backup:
            print(f"旧稿备份：{result.backup}")
        if result.warnings:
            print(f"需要检查（{len(result.warnings)}项）：")
            for index, warning in enumerate(result.warnings, 1):
                print(f"  {index}. {warning.message}")
        else:
            print("未发现需要人工检查的问题。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
