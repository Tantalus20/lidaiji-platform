#!/usr/bin/env python3
"""为分享站临时构建检查生成确定性的演示内容（写入临时私有根，不碰真实内容）。

用法：create-share-demo-content.py --root <私有内容根>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

from studio import share  # noqa: E402


def item(share_id: str, title: str, author: str, slug: str, day: str, kind: str, rights_mode: str,
         body: str, draft: bool = False, categories: list[str] | None = None,
         source_name: str = "", source_url: str = "", qq_summary: str = "", description: str = "") -> tuple[dict, str]:
    body = body.rstrip("\n") + "\n"
    data = {
        "title": title,
        "author": author,
        "date": day,
        "lastmod": day,
        "slug": slug,
        "draft": draft,
        "shareKind": kind,
        "rightsMode": rights_mode,
        "sourceName": source_name,
        "sourceUrl": source_url,
        "description": description,
        "qqSummary": qq_summary,
        "categories": categories or [],
        "shareId": share_id,
        "shareRevision": share.revision_for(share_id, body),
    }
    return data, body


def long_body(seed: str) -> str:
    lines = [
        "## 缘起",
        "",
        "长文分享站的第一篇演示文章，用于验证目录、字号、阅读位置与上下篇导航。",
        "",
        "正文使用 Markdown 书写，段落之间以空行分隔，和正式作品站保持同一套写法。",
        "",
        "## 过程",
        "",
        "演示内容只写入临时私有根目录，绝不进入公开代码仓库，也不会出现在正式内容里。",
        "",
        "## 结尾",
        "",
        "验证完成之后，这篇演示文章会随临时目录一起删除。",
        "",
    ]
    chunk = seed
    for index in range(1, 10):
        lines.append(f"第 {index} 节：{chunk}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    items_dir = root / "items"
    items_dir.mkdir(parents=True, exist_ok=True)

    chunk = "演示段落内容用于验证分享站的正文排版、目录生成与阅读进度记忆功能是否正常工作。"
    items = [
        ("sh-20260701-a1b2c3", item("sh-20260701-a1b2c3", "夜航船记", "站主", "ye-hang-chuan-ji", "2026-07-01", "original-writing", "original",
             long_body(chunk), categories=["随笔"],
             qq_summary="一篇记录夜航船见闻的长文，点开阅读全文。",
             description="在夜航船上记下的见闻与思绪。")),
        ("sh-20260705-a1b2c4", item("sh-20260705-a1b2c4", "春去秋来", "佚名", "chun-qu-qiu-lai", "2026-07-05", "fiction", "original",
             "短篇小说节选。\n\n第一段：故事从秋天开始。\n\n第二段：落叶满阶，无人打扫。\n",
             categories=["小说"])),
        ("sh-20260710-a1b2c5", item("sh-20260710-a1b2c5", "论文摘录：论时间的形状", "研究者", "lun-wen-zhai-lu", "2026-07-10", "paper", "excerpt",
             "这是不应出现在公开页面的完整论文正文，任何构建输出都不得包含这句话。",
             categories=["论文"], source_name="某学报 2026 年第 3 期",
             source_url="https://example.com/paper/123",
             qq_summary="一篇关于时间形状的论文摘录。", description="论文摘要与介绍，全文见原文链接。")),
        ("sh-20260712-a1b2c6", item("sh-20260712-a1b2c6", "一则新闻速递", "编辑", "xin-wen-zhi-lian", "2026-07-12", "news", "link-only",
             "这条新闻的完整正文只存在于原网站，本站仅提供链接。",
             categories=["新闻"], source_name="某新闻网",
             source_url="https://example.com/news/456", qq_summary="看新闻点这里。")),
        ("sh-20260715-a1b2c7", item("sh-20260715-a1b2c7", "未完成的手稿", "站主", "wei-wan-cheng-shou-gao", "2026-07-15", "other", "cc",
             "这是一篇草稿，构建输出中不得出现它的页面。", draft=True, categories=["草稿"])),
    ]
    for share_id, (data, body) in items:
        target = items_dir / share_id / "index.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(share.render_source(data, body), encoding="utf-8")
    print(f"分享演示内容已生成：{len(items)} 项（根目录：{root}）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
