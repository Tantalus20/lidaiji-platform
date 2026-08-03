#!/usr/bin/env python3
"""把以 Word“标题 1”分篇的长稿导入为一个 Hugo 文集。

默认把纯日期形式的“标题 1”视为上一篇的落款，避免把末尾日期误拆成文章。
转换完全在本地进行，不执行宏、不访问外部链接。
"""

from __future__ import annotations
# Windows 控制台默认 GBK/cp936 无法编码中文输出；统一强制 UTF-8（跨平台一致）。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
import argparse
import datetime as dt
import importlib.util
import os
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

import yaml
from docx import Document

HERE = Path(__file__).resolve().parent
IMPORTER_PATH = HERE / "docx-importer.py"
SPEC = importlib.util.spec_from_file_location("docx_importer", IMPORTER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("无法载入DOCX导入核心。")
CORE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CORE
SPEC.loader.exec_module(CORE)

DATE_HEADING = re.compile(r"^\d{4}年\d{1,2}月\d{1,2}日$")


def split_slugs(value: str) -> list[str]:
    return [CORE.validate_slug(item, "篇目slug") for item in value.split(",") if item.strip()]


def heading_level(paragraph) -> int | None:
    name = CORE.style_name(paragraph)
    matched = CORE.HEADING_STYLE.fullmatch(name.replace(" ", "")) or CORE.HEADING_STYLE.fullmatch(name)
    return int(matched.group(1)) if matched else None


def plain_blocks(document) -> list:
    return list(CORE.iter_blocks(document))


def split_parts(document) -> list[tuple[str, list]]:
    parts: list[tuple[str, list]] = []
    current_title = ""
    current_blocks: list = []
    for block in plain_blocks(document):
        if hasattr(block, "style"):
            title = CORE.plain_text(block.text)
            level = heading_level(block)
            if level == 1 and title and not DATE_HEADING.fullmatch(title):
                if current_title:
                    parts.append((current_title, current_blocks))
                current_title = title
                current_blocks = []
                continue
            if level == 1 and DATE_HEADING.fullmatch(title):
                # 日期在原稿中只是落款；保留文字，但不把它作为网页篇目。
                block.style = document.styles["Normal"]
        if current_title:
            current_blocks.append(block)
    if current_title:
        parts.append((current_title, current_blocks))
    return parts


def render_part(document, bundle: Path, blocks: list) -> tuple[str, str, str, int, list]:
    warnings: list = []
    images = CORE.ImageWriter(document, bundle, warnings)
    subtitles: list[str] = []
    output: list[str] = []
    description = ""
    all_text: list[str] = []
    empty_count = 0
    for block in blocks:
        if hasattr(block, "style"):
            raw = CORE.plain_text(block.text)
            level = heading_level(block)
            if level == 2 and raw and not output:
                subtitles.append(raw)
                continue
            rendered = CORE.render_paragraph(block, images)
            if not rendered:
                empty_count += 1
                continue
            output.append(rendered)
            if raw:
                all_text.append(raw)
                if not description and level is None:
                    description = CORE.truncate_description(raw)
        else:
            rendered = CORE.render_table(block, warnings)
            if rendered:
                output.append(rendered)
                all_text.extend(cell.text for row in block.rows for cell in row.cells)
    if empty_count:
        warnings.append(CORE.ImportWarning("empty-paragraph", f"忽略了{empty_count}个空段落。"))
    return (
        "\n\n".join(output).strip() + "\n",
        " · ".join(subtitles),
        description,
        CORE.visible_word_count("\n".join(all_text)),
        warnings,
    )


def front_matter(
    title: str,
    subtitle: str,
    description: str,
    slug: str,
    weight: int,
    date: str,
    existing: dict,
    body: str,
    collection_title: str,
) -> str:
    defaults = {
        "title": title,
        "subtitle": subtitle,
        "date": date,
        "lastmod": date,
        "slug": slug,
        "description": description,
        "hideDescription": True,
        "draft": False,
        "featured": False,
        "weight": weight,
        "collections": [collection_title],
        "categories": [],
        "tags": [],
        "series": [collection_title],
        "period": [],
        "people": [],
        "places": [],
        "aliases": [],
        "articleId": existing.get("articleId") or CORE.new_article_id(),
        "comments": existing.get("comments") or {"paragraph": True},
    }
    # 重新导入是正文更新，不是重新创建文章。既有文章的首次发布日期、
    # 分类、自定义字段和评论配置必须保留；只刷新由当前Word决定的字段。
    data = dict(existing)
    for key, value in defaults.items():
        data.setdefault(key, value)
    data.update(
        {
            "title": title,
            "subtitle": subtitle,
            "lastmod": date,
            "slug": slug,
            "description": description,
            "weight": weight,
            "articleId": existing.get("articleId") or defaults["articleId"],
            "comments": existing.get("comments") or defaults["comments"],
        }
    )
    data["articleRevision"] = CORE.revision_for(data["articleId"], body)
    return "---\n" + yaml.safe_dump(
        data,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=1000,
    ) + "---\n\n"


def validate_source(source: Path) -> None:
    if source.suffix.lower() != ".docx" or not source.is_file():
        raise CORE.ImportFailure("请选择有效的.docx文件。")
    if source.stat().st_size > 100 * 1024 * 1024:
        raise CORE.ImportFailure("Word文件超过100MB，已停止导入。")
    try:
        with zipfile.ZipFile(source) as archive:
            if any(name.casefold().endswith("vbaproject.bin") for name in archive.namelist()):
                raise CORE.ImportFailure("文档包含VBA宏项目，已拒绝导入。")
    except zipfile.BadZipFile as error:
        raise CORE.ImportFailure("文件不是有效的DOCX压缩包。") from error


def run(args: argparse.Namespace) -> None:
    source = args.input.resolve()
    validate_source(source)
    slugs = split_slugs(args.slugs)
    document = Document(source)
    parts = split_parts(document)
    if len(parts) != len(slugs):
        titles = "、".join(title for title, _ in parts)
        raise CORE.ImportFailure(f"识别到{len(parts)}篇（{titles}），但提供了{len(slugs)}个slug。")

    project_root = args.project_root.resolve()
    collection = project_root / "content" / "works" / args.collection_slug
    collection.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{args.collection_slug}.series-", dir=collection.parent))
    backup: Path | None = None
    try:
        date = args.date or dt.date.today().isoformat()
        total_words = 0
        all_warnings: list[str] = []
        for index, ((title, blocks), slug) in enumerate(zip(parts, slugs, strict=True), 1):
            bundle = temporary / slug
            bundle.mkdir()
            body, subtitle, description, words, warnings = render_part(document, bundle, blocks)
            existing_data, existing_body = CORE.parse_existing_markdown(collection / slug / "index.md")
            body, paragraph_report = CORE.assign_ids(body, existing_body)
            if paragraph_report.ambiguous:
                warnings.append(
                    CORE.ImportWarning(
                        "paragraph-match-review",
                        f"有{len(paragraph_report.ambiguous)}段无法高置信匹配旧锚点，已生成新ID。",
                    )
                )
            if paragraph_report.deleted:
                warnings.append(
                    CORE.ImportWarning(
                        "paragraphs-removed",
                        f"旧稿有{len(paragraph_report.deleted)}个段落已删除，历史段评不会删除。",
                    )
                )
            (bundle / "index.md").write_text(
                front_matter(
                    title, subtitle, description, slug, index * 10, date, existing_data, body,
                    args.collection_title,
                ) + body,
                encoding="utf-8",
            )
            total_words += words
            all_warnings.extend(f"{title}：{item.message}" for item in warnings)

        existing_collection, _ = CORE.parse_existing_markdown(collection / "_index.md")
        collection_defaults = {
            "title": args.collection_title,
            "subtitle": "",
            "description": "从Word导入的长篇文集。",
            "status": "已完结",
            "featured": True,
            "layout": "collection",
            "date": date,
            "lastmod": date,
            "startDate": date,
            "endDate": date,
        }
        collection_data = dict(existing_collection)
        for key, value in collection_defaults.items():
            collection_data.setdefault(key, value)
        collection_data["lastmod"] = date
        (temporary / "_index.md").write_text(
            "---\n"
            + yaml.safe_dump(collection_data, allow_unicode=True, sort_keys=False, width=1000)
            + "---\n",
            encoding="utf-8",
        )

        if collection.exists():
            backup_root = args.backup_dir.expanduser().resolve()
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = backup_root / f"{args.collection_slug}_{dt.datetime.now():%Y%m%d_%H%M%S}"
            shutil.copytree(collection, backup)
            previous = collection.with_name(f".{collection.name}.before-series-import")
            if previous.exists():
                shutil.rmtree(previous)
            os.replace(collection, previous)
            try:
                os.replace(temporary, collection)
            except Exception:
                os.replace(previous, collection)
                raise
            shutil.rmtree(previous)
        else:
            os.replace(temporary, collection)

        print(f"已导入文集：{args.collection_title}（{len(parts)}篇，约{total_words}字）")
        for index, ((title, _), slug) in enumerate(zip(parts, slugs, strict=True), 1):
            print(f"{index}. {title} -> /works/{args.collection_slug}/{slug}/")
        if backup:
            print(f"原文集备份：{backup}")
        if all_warnings:
            print(f"转换提示（{len(all_warnings)}项）：")
            for warning in all_warnings:
                print(f"- {warning}")
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="把标题1分篇的DOCX导入为Hugo文集。")
    result.add_argument("input", type=Path)
    result.add_argument("--project-root", type=Path, default=HERE.parent)
    result.add_argument("--collection-title", default="示例文集")
    result.add_argument("--collection-slug", default="sample-collection")
    result.add_argument(
        "--slugs",
        default="chapter-one,chapter-two",
    )
    result.add_argument("--date", default="")
    result.add_argument("--backup-dir", type=Path, default=Path.home() / "Documents" / "Lidaiji导入备份")
    return result


def main() -> int:
    try:
        run(parser().parse_args())
    except (CORE.ImportFailure, OSError, ValueError) as error:
        print(f"导入失败：{error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
