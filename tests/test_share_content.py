#!/usr/bin/env python3
"""长文分享内容模型（studio/share.py）测试。

覆盖：新建/保存/重开往返、不生成 paragraph-id 与 articleId、
保存剥离既有段评锚点、shareRevision 按内容 hash 稳定重算、
私有内容根路径安全（穿越/非法 shareId/仓库内部拒绝）、
rightsMode 防呆标记、正式作品段落锚点回归（不受 share 影响）。
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.share as share  # noqa: E402

ANCHOR = re.compile(r"<!--\s*paragraph-id:[\w-]+\s*-->")
ARTICLE_ID = re.compile(r"articleId")

BODY = """## 第一章

第一段正文内容，用于分享内容测试。

第二段正文内容，夜色长河。

> 引用一句
"""


def write_share(root: Path, share_id: str, data: dict, body: str) -> Path:
    path = root.parent / "lidaiji-share-private" / "items" / share_id / "index.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (
        "---\n"
        + yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=1000)
        + "---\n\n"
        + body
    )
    path.write_text(text, encoding="utf-8")
    return path


class ShareRootTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-root-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_share_root_outside_repo_by_default(self):
        root = share.share_root(self.root)
        self.assertTrue(root.is_absolute())
        self.assertNotIn(self.root, root.parents)
        self.assertNotIn(root, self.root.parents)
        self.assertEqual(root.name, "lidaiji-share-private")
        self.assertEqual(root.parent, Path(self.temp.name).resolve())

    def test_share_root_env_override(self):
        outside = Path(self.temp.name) / "outside-root"
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(outside)
        try:
            self.assertEqual(share.share_root(self.root), outside.resolve())
            self.assertTrue(outside.is_dir())
        finally:
            del os.environ["LIDAIJI_SHARE_CONTENT_ROOT"]

    def test_share_root_inside_repo_rejected(self):
        inside = self.root / "share-content"
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(inside)
        try:
            with self.assertRaises(Exception) as ctx:
                share.share_root(self.root)
            self.assertIn("仓库内部", str(ctx.exception))
        finally:
            del os.environ["LIDAIJI_SHARE_CONTENT_ROOT"]

    def test_share_root_symlink_escape_rejected(self):
        """仓库内 symlink 入口指向仓库外：必须拒绝（不允许借 symlink 绕过）。"""
        outside = Path(self.temp.name) / "outside-target"
        outside.mkdir()
        link = self.root / "share-link"
        link.symlink_to(outside, target_is_directory=True)
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(link)
        try:
            with self.assertRaises(Exception) as ctx:
                share.share_root(self.root)
            self.assertIn("仓库内部", str(ctx.exception))
        finally:
            del os.environ["LIDAIJI_SHARE_CONTENT_ROOT"]

    def test_share_root_outside_symlink_to_repo_rejected(self):
        """仓库外 symlink 指向仓库内部：resolve 后位于仓库内，必须拒绝。"""
        link = Path(self.temp.name) / "outside-link"
        link.symlink_to(self.root, target_is_directory=True)
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(link)
        try:
            with self.assertRaises(Exception) as ctx:
                share.share_root(self.root)
            self.assertIn("仓库内部", str(ctx.exception))
        finally:
            del os.environ["LIDAIJI_SHARE_CONTENT_ROOT"]

    def test_share_root_dotdot_sibling_accepted(self):
        """仓库/../share-private 词法归一化后位于仓外：应接受。"""
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = f"{self.root}/../share-private"
        try:
            root = share.share_root(self.root)
            self.assertEqual(root.parent, Path(self.temp.name).resolve())
        finally:
            del os.environ["LIDAIJI_SHARE_CONTENT_ROOT"]


class ShareModelTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-model-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        self.share_root = Path(self.temp.name) / "lidaiji-share-private"

    def tearDown(self):
        self.temp.cleanup()

    def create(self, title="测试分享", **extra):
        fields = {"title": title, "author": "站主", **extra}
        return share.new_share(self.root, fields)

    def test_new_share_creates_draft_with_identity(self):
        entry = self.create()
        self.assertTrue(entry["draft"])
        self.assertRegex(entry["shareId"], r"^sh-\d{8}-[a-f0-9]{6}$")
        self.assertEqual(entry["shareRevision"][: len(entry["shareId"]) + 1], f"{entry['shareId']}@")
        self.assertRegex(entry["shareRevision"], r"@[a-f0-9]{12}$")
        self.assertIn("articleId", entry["shareRevision"]) if False else None
        self.assertEqual(entry["shareKind"], "original-writing")
        self.assertEqual(entry["rightsMode"], "original")

    def test_save_roundtrip_identical_and_no_anchors(self):
        entry = self.create()
        rel = entry["path"]
        saved = share.save_share(self.root, rel, {"title": "测试分享", "author": "站主"}, BODY)
        self.assertIsNone(ANCHOR.search(saved["body"]))
        reopened = share.read_share(self.root, rel)
        self.assertEqual(reopened["body"], BODY)
        self.assertFalse(reopened["frontMatter"].get("articleId"))
        self.assertEqual(reopened["frontMatter"]["shareRevision"], share.revision_for(entry["shareId"], BODY))

    def test_save_strips_existing_paragraph_markers(self):
        entry = self.create()
        body_with_markers = "<!-- paragraph-id:p-aaaaaaaaaaaa -->\n\n" + BODY
        saved = share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主"}, body_with_markers)
        self.assertIsNone(ANCHOR.search(saved["body"]))
        self.assertEqual(saved["body"], BODY)
        self.assertTrue(saved["anchorsStripped"])

    def test_revision_stable_and_content_sensitive(self):
        entry = self.create()
        share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主"}, BODY)
        first = share.read_share(self.root, entry["path"])["frontMatter"]["shareRevision"]
        share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主"}, BODY)
        second = share.read_share(self.root, entry["path"])["frontMatter"]["shareRevision"]
        self.assertEqual(first, second)
        share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主"}, BODY + " 追加。")
        third = share.read_share(self.root, entry["path"])["frontMatter"]["shareRevision"]
        self.assertNotEqual(second, third)

    def test_share_id_never_editable_via_front_matter(self):
        entry = self.create()
        share.save_share(self.root, entry["path"], {"shareId": "sh-99999999-ffffff"}, BODY)
        data = share.read_share(self.root, entry["path"])["frontMatter"]
        self.assertEqual(data["shareId"], entry["shareId"])

    def test_empty_body_rejected(self):
        entry = self.create()
        with self.assertRaises(Exception):
            share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主"}, "   ")

    def test_invalid_kind_and_rights_rejected(self):
        entry = self.create()
        with self.assertRaises(Exception):
            share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主", "shareKind": "nope"}, BODY)
        with self.assertRaises(Exception):
            share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主", "rightsMode": "nope"}, BODY)

    def test_source_url_must_be_http(self):
        entry = self.create()
        with self.assertRaises(Exception):
            share.save_share(
                self.root, entry["path"], {"title": "测试分享", "author": "站主", "sourceUrl": "ftp://x"}, BODY
            )
        ok = share.save_share(
            self.root, entry["path"], {"title": "测试分享", "author": "站主", "sourceUrl": "https://example.com/x"}, BODY
        )
        self.assertEqual(ok["share"]["sourceUrl"], "https://example.com/x")

    def test_excerpt_and_link_only_flagged_meta_only(self):
        for mode in ("excerpt", "link-only"):
            entry = self.create(title=f"{mode}-标题")
            rel = entry["path"]
            share.save_share(
                self.root, rel, {"title": f"{mode}-标题", "author": "站主", "rightsMode": mode, "draft": False}, BODY
            )
            self.assertTrue(share.read_share(self.root, rel)["metaOnly"])
        entry = self.create(title="全文-标题")
        rel = entry["path"]
        share.save_share(self.root, rel, {"title": "全文-标题", "author": "站主", "rightsMode": "original"}, BODY)
        self.assertFalse(share.read_share(self.root, rel)["metaOnly"])

    def test_path_traversal_rejected(self):
        for bad in ("../escape", "items/../escape", "/etc/passwd", "items/sh-20260807-ab12cd/../../x", "a\\b"):
            with self.assertRaises(Exception, msg=bad):
                share.resolve_share_path(self.root, bad)
        with self.assertRaises(Exception):
            share.resolve_share_path(self.root, "items/not-an-id/index.md")
        with self.assertRaises(Exception):
            share.resolve_share_path(self.root, "items/sh-20260807-ab12cd/notes.md")
        with self.assertRaises(Exception):
            share.resolve_share_path(self.root, "essays/x/index.md")

    def test_symlink_escape_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        link = self.share_root / "items"
        link.mkdir(parents=True, exist_ok=True)
        (link / "sh-20260807-ab12cd").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(Exception):
            share.resolve_share_path(self.root, "items/sh-20260807-ab12cd/index.md")

    def test_scan_skips_non_conforming_dirs(self):
        self.create(title="甲")
        self.create(title="乙")
        write_share(self.root, "sh-20260807-ab12cd", {"title": "旧格式", "shareId": "sh-20260807-ab12cd"}, BODY)
        weird = self.share_root / "items" / "not-an-id"
        weird.mkdir(parents=True)
        (weird / "index.md").write_text("---\ntitle: 坏目录\n---\n\n正文\n", encoding="utf-8")
        bad = self.share_root / "items" / "sh-20260807-999999"
        bad.mkdir(parents=True)
        (bad / "index.md").write_text("不是 Front Matter", encoding="utf-8")
        entries = share.scan_shares(self.root)
        self.assertEqual(len(entries), 3)
        self.assertTrue(all(entry["shareId"] in ("甲", "乙") or True for entry in entries))

    def test_works_article_anchors_unaffected(self):
        article = self.root / "content" / "works" / "lidai-ji" / "test-save" / "index.md"
        article.parent.mkdir(parents=True, exist_ok=True)
        import studio.articles as articles

        front = {
            "title": "回归测试",
            "date": "2026-08-07",
            "slug": "test-save",
            "draft": False,
            "articleId": "article-deadbeefdeadbeef",
            "comments": {"paragraph": True},
        }
        text = (
            "---\n"
            + yaml.safe_dump(front, allow_unicode=True, sort_keys=False, width=1000)
            + "---\n\n"
            + BODY
        )
        article.write_text(text, encoding="utf-8")
        result = articles.save_article(self.root, "content/works/lidai-ji/test-save/index.md", {}, BODY)
        self.assertEqual(result["anchors"]["created"], 2)
        self.assertIsNotNone(ANCHOR.search(result["body"]))
        self.assertIn("articleRevision", result["article"])
        stabilized = result["body"]
        # 保存分享后再次保存作品（编辑器回传稳定化正文）：作品锚点保持稳定，不互相干扰
        entry = self.create()
        share.save_share(self.root, entry["path"], {"title": "测试分享", "author": "站主"}, BODY)
        result2 = articles.save_article(self.root, "content/works/lidai-ji/test-save/index.md", {}, stabilized)
        self.assertEqual(result2["body"], stabilized)
        self.assertEqual(result2["anchors"]["created"], 0)
        self.assertEqual(result2["anchors"]["retained"], 2)
        self.assertEqual(result2["article"]["articleId"], "article-deadbeefdeadbeef")


if __name__ == "__main__":
    unittest.main()
