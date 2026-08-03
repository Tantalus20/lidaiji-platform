#!/usr/bin/env python3
"""Add/validate stable comment identities in Hugo article sources."""

from __future__ import annotations
# Windows 控制台默认 GBK/cp936 无法编码中文输出；统一强制 UTF-8（跨平台一致）。
import sys
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
import argparse
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "importer"))
from paragraph_ids import assign_ids, new_article_id, revision_for  # noqa: E402


def split_source(source: str) -> tuple[dict, str]:
    if not source.startswith("---\n"):
        raise ValueError("文章缺少YAML Front Matter")
    _, raw, body = source.split("---", 2)
    return yaml.safe_load(raw) or {}, body.lstrip("\n")


def render(data: dict, body: str) -> str:
    return "---\n" + yaml.safe_dump(
        data, allow_unicode=True, sort_keys=False, width=1000
    ) + "---\n\n" + body


def article_files(root: Path):
    for path in sorted((root / "content").glob("**/index.md")):
        if "/works/" in path.as_posix() or "/essays/" in path.as_posix() or "/archives/" in path.as_posix():
            yield path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=ROOT)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    seen: dict[str, Path] = {}
    failures: list[str] = []
    changed = 0
    paragraphs = 0
    for path in article_files(args.project_root.resolve()):
        original = path.read_text(encoding="utf-8")
        try:
            data, body = split_source(original)
        except ValueError as error:
            failures.append(f"{path}: {error}")
            continue
        article_id = str(data.get("articleId") or "").strip()
        comments = data.get("comments")
        enabled = comments is not None and (
            comments is True or (isinstance(comments, dict) and comments.get("paragraph") in (True, "locked"))
        )
        if not article_id and args.write:
            article_id = new_article_id()
            data["articleId"] = article_id
            data.setdefault("comments", {"paragraph": True})
            enabled = True
        if not article_id:
            failures.append(f"{path}: 缺少articleId")
            continue
        if article_id in seen:
            failures.append(f"{path}: articleId与{seen[article_id]}重复：{article_id}")
        seen[article_id] = path
        stabilized, report = assign_ids(body, body)
        paragraphs += report.retained + report.created
        if enabled and report.created and not args.write:
            failures.append(f"{path}: 有{report.created}个自然段缺少稳定ID")
        data["articleRevision"] = revision_for(article_id, stabilized)
        updated = render(data, stabilized)
        if updated != original:
            if args.write:
                path.write_text(updated, encoding="utf-8")
                changed += 1
            else:
                failures.append(f"{path}: 身份或revision需要更新")
    if failures:
        print("段评身份检查失败：", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(f"段评身份检查通过：{len(seen)}篇文章，{paragraphs}个自然段，更新{changed}篇。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
