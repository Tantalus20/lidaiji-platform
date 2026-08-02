#!/usr/bin/env python3
"""根据 Word 文件名与现有内容推断导入信息。"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

import yaml
from pypinyin import Style, lazy_pinyin

SPECIAL_SECTIONS = {
    "随笔": "essays",
    "评论": "essays",
    "杂记": "essays",
    "资料": "archives",
    "档案": "archives",
}


def read_front_matter(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---"):
            return {}
        return yaml.safe_load(text.split("---", 2)[1]) or {}
    except (OSError, ValueError, yaml.YAMLError):
        return {}


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip()
    pieces = lazy_pinyin(normalized, style=Style.NORMAL, errors=lambda chars: list(chars))
    ascii_text = "-".join(pieces).lower()
    ascii_text = re.sub(r"[^a-z0-9]+", "-", ascii_text)
    return ascii_text.strip("-") or "article"


def collection_catalog(project_root: Path) -> dict[str, tuple[str, Path]]:
    result: dict[str, tuple[str, Path]] = {}
    for index in sorted((project_root / "content" / "works").glob("*/_index.md")):
        data = read_front_matter(index)
        title = str(data.get("title", "")).strip()
        if title:
            result[title] = (index.parent.name, index.parent)
    return result


def default_category(collection_path: Path | None) -> str:
    if collection_path is None:
        return ""
    categories: Counter[str] = Counter()
    for article in collection_path.glob("*/index.md"):
        data = read_front_matter(article)
        for category in data.get("categories") or []:
            if isinstance(category, str) and category.strip():
                categories[category.strip()] += 1
    return categories.most_common(1)[0][0] if categories else ""


def infer(input_path: Path, project_root: Path) -> dict:
    stem = input_path.stem.strip()
    if stem.startswith("《") and stem.endswith("》"):
        stem = stem[1:-1].strip()
    prefix, separator, title = stem.partition("·")
    if not separator:
        title = stem
        prefix = ""
    prefix = prefix.strip()
    title = title.strip() or stem

    catalog = collection_catalog(project_root)
    section = "essays"
    collection = ""
    collection_slug = ""
    collection_path: Path | None = None
    if prefix in SPECIAL_SECTIONS:
        section = SPECIAL_SECTIONS[prefix]
    elif prefix in catalog:
        section = "works"
        collection = prefix
        collection_slug, collection_path = catalog[prefix]
    elif prefix:
        section = "works"
        collection = prefix
        collection_slug = slugify(prefix)
        collection_path = project_root / "content" / "works" / collection_slug

    slug = slugify(title)
    if section == "works":
        target = project_root / "content" / "works" / collection_slug / slug
        url = f"/works/{collection_slug}/{slug}/"
    else:
        target = project_root / "content" / section / slug
        url = f"/{section}/{slug}/"
    return {
        "title": title,
        "section": section,
        "collection": collection,
        "collection_slug": collection_slug,
        "slug": slug,
        "category": default_category(collection_path),
        "target": str(target),
        "url": url,
        "existing": target.exists(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="推断DOCX导入信息")
    parser.add_argument("input", type=Path)
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--format", choices=("json", "shell"), default="json")
    args = parser.parse_args()
    result = infer(args.input, args.project_root.resolve())
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for key, value in result.items():
            clean = str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")
            print(f"{key}\t{clean}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
