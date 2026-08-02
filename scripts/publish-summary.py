#!/usr/bin/env python3
"""列出相对上次成功发布发生变化的文章，不依赖Git状态。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


def page_info(index: Path, root: Path) -> dict:
    text = index.read_text(encoding="utf-8")
    header = text.split("---", 2)[1] if text.startswith("---") and text.count("---") >= 2 else ""
    title_match = re.search(r"(?m)^title:\s*[\"']?(.*?)[\"']?\s*$", header)
    draft_match = re.search(r"(?mi)^draft:\s*(true|false)\s*$", header)
    title = title_match.group(1).strip("\"' ") if title_match else index.parent.name
    draft = bool(draft_match and draft_match.group(1).lower() == "true")
    digest = hashlib.sha256()
    for file in sorted(index.parent.rglob("*")):
        if file.is_file() and not file.name.startswith("."):
            digest.update(file.relative_to(index.parent).as_posix().encode())
            digest.update(file.read_bytes())
    return {
        "path": index.relative_to(root).as_posix(),
        "title": title,
        "draft": draft,
        "digest": digest.hexdigest(),
    }


def scan(root: Path, content_root: Path) -> dict[str, dict]:
    pages = {}
    for index in sorted(content_root.glob("**/index.md")):
        info = page_info(index, root)
        pages[info["path"]] = info
    return pages


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--content-root", type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    root = args.project_root.resolve()
    content_root = (args.content_root or (root / "content")).resolve()
    if not content_root.is_dir():
        parser.error(f"内容目录不存在：{content_root}")
    manifest = root / ".cache" / "publish-manifest.json"
    current = scan(root, content_root)
    if args.write:
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已记录本次发布基线：{len(current)}篇文章。")
        return 0

    previous = {}
    if manifest.is_file():
        try:
            previous = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
    new = [value for key, value in current.items() if key not in previous]
    changed = [
        value
        for key, value in current.items()
        if key in previous and value["digest"] != previous[key].get("digest")
    ]
    deleted = [value for key, value in previous.items() if key not in current]

    print("\n【本次发布内容摘要】")
    if not previous:
        print("尚无本地发布基线；以下列出当前全部文章。")
        new = list(current.values())
    if not new and not changed and not deleted:
        print("文章内容与上次成功发布记录一致。")
    for label, values in (("新增", new), ("修改", changed)):
        for item in values:
            state = "草稿，不会公开" if item["draft"] else "将公开"
            print(f"- {label}：《{item['title']}》— {state}")
    for item in deleted:
        print(f"- 删除：《{item.get('title', item['path'])}》— 发布后将从网站移除")
    published = sum(1 for value in current.values() if not value["draft"])
    drafts = len(current) - published
    print(f"当前合计：{published}篇公开，{drafts}篇草稿。\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
