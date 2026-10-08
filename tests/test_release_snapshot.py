#!/usr/bin/env python3
"""不可变 release snapshot 契约（P0-B）：clean 门禁、内容冻结、作者评隔离、复用复验。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools import release_snapshot as rs  # noqa: E402


class ReleaseSnapshotTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = Path(self._tmp.name)
        self.platform = base / "platform"
        self.private = base / "private"
        (self.platform / "config" / "_default").mkdir(parents=True)
        (self.platform / "themes" / "demo").mkdir(parents=True)
        (self.platform / "data" / "author-notes").mkdir(parents=True)
        (self.platform / "VERSION").write_text("0.4.3\n", encoding="utf-8")
        (self.platform / ".gitignore").write_text(".cache/\ndist/\n", encoding="utf-8")
        (self.platform / ".gitattributes").write_text("/.lidaiji-workspace.json export-ignore\n", encoding="utf-8")
        (self.platform / ".lidaiji-workspace.json").write_text(
            '{"contentRepoRoot": "../private"}\n', encoding="utf-8"
        )
        (self.platform / "config" / "_default" / "hugo.toml").write_text(
            'title = "示例文集"\nlocale = "zh-CN"\n', encoding="utf-8"
        )
        (self.platform / "config" / "_default" / "params.toml").write_text(
            'siteName = "示例文集"\n', encoding="utf-8"
        )
        (self.platform / "themes" / "demo" / "theme.toml").write_text("name = \"demo\"\n", encoding="utf-8")
        (self.platform / "data" / "author-notes" / "article-1.yaml").write_text(
            "notes: []\n", encoding="utf-8"
        )
        self.content = self.private / "content"
        (self.content / "essays" / "one").mkdir(parents=True)
        (self.content / "essays" / "one" / "index.md").write_text("# 一\n正文\n", encoding="utf-8")
        self.overrides = self.private / "site-overrides"
        self.overrides.mkdir(parents=True)
        (self.overrides / "site.yaml").write_text('title: "私人文集"\n', encoding="utf-8")
        self._git("init")
        self._git("config", "user.name", "快照测试")
        self._git("config", "user.email", "snapshot-test@example.invalid")
        self._git("add", "--all")
        self._git("commit", "-m", "fixture")
        self.addCleanup(self._tmp.cleanup)

    def _git(self, *args):
        subprocess.run(["git", "-C", str(self.platform), *args], check=True, capture_output=True)

    def _create(self, **kwargs):
        params = {
            "platform_root": self.platform,
            "content_root": self.content,
            "site_overrides_root": self.overrides,
            "mode": "full_site",
        }
        params.update(kwargs)
        return rs.create_snapshot(**params)

    def test_create_freezes_content_and_excludes_author_notes(self):
        result = self._create()
        tree = Path(result["tree"])
        self.assertTrue((tree / "content" / "essays" / "one" / "index.md").is_file())
        self.assertFalse(any((tree / "data" / "author-notes").iterdir()), "快照不得包含作者评")
        snapshot_text = (Path(result["snapshotDir"]) / "snapshot.json").read_text(encoding="utf-8")
        self.assertNotIn("author-notes", snapshot_text)
        manifest = json.loads((Path(result["snapshotDir"]) / "content-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([entry["path"] for entry in manifest["entries"]],
                         ["content/essays/one/index.md", "site-overrides/site.yaml"])
        self.assertIn("私人文集", (tree / "config" / "_default" / "hugo.toml").read_text(encoding="utf-8"))

    def test_workspace_config_not_in_snapshot_tree(self):
        result = self._create()
        tree = Path(result["tree"])
        self.assertFalse((tree / ".lidaiji-workspace.json").exists(), "快照不得包含工作区配置")
        snapshot_text = (Path(result["snapshotDir"]) / "snapshot.json").read_text(encoding="utf-8")
        self.assertNotIn("lidaiji-workspace", snapshot_text)

    def test_full_site_excludes_drafts_and_author_notes(self):
        (self.content / "essays" / "draft-one").mkdir(parents=True)
        (self.content / "essays" / "draft-one" / "index.md").write_text(
            '---\ntitle: "未公开草稿"\ndraft: true\n---\n未公开正文\n', encoding="utf-8"
        )
        result = self._create()
        tree = Path(result["tree"])
        self.assertTrue((tree / "content" / "essays" / "one" / "index.md").is_file())
        self.assertFalse((tree / "content" / "essays" / "draft-one" / "index.md").exists(),
                         "full_site 快照不得包含未公开草稿")
        manifest = json.loads((Path(result["snapshotDir"]) / "content-manifest.json").read_text(encoding="utf-8"))
        paths = [entry["path"] for entry in manifest["entries"]]
        self.assertNotIn("content/essays/draft-one/index.md", paths)
        self.assertFalse(any((tree / "data" / "author-notes").iterdir()), "快照不得包含作者评")

    def test_same_inputs_reuse_and_verify(self):
        first = self._create()
        second = self._create()
        self.assertEqual(first["snapshotId"], second["snapshotId"])
        self.assertEqual(first["snapshotFingerprint"], second["snapshotFingerprint"])
        self.assertTrue(second["reused"])

    def test_content_change_changes_snapshot_id(self):
        first = self._create()
        (self.content / "essays" / "one" / "index.md").write_text("# 一\n改过的正文\n", encoding="utf-8")
        second = self._create()
        self.assertNotEqual(first["snapshotId"], second["snapshotId"])

    def test_override_change_changes_snapshot_id(self):
        first = self._create()
        (self.overrides / "site.yaml").write_text('title: "另一个名字"\n', encoding="utf-8")
        second = self._create()
        self.assertNotEqual(first["snapshotId"], second["snapshotId"])

    def test_dirty_platform_tracked_file_rejected(self):
        (self.platform / "VERSION").write_text("0.4.4\n", encoding="utf-8")
        with self.assertRaises(rs.SnapshotError):
            self._create()

    def test_untracked_platform_file_rejected(self):
        (self.platform / "sneaky.py").write_text("print('x')\n", encoding="utf-8")
        with self.assertRaises(rs.SnapshotError):
            self._create()

    def test_tampered_snapshot_fails_verify(self):
        result = self._create()
        target = Path(result["tree"]) / "content" / "essays" / "one" / "index.md"
        target.write_text("# 被篡改\n", encoding="utf-8")
        with self.assertRaises(rs.SnapshotError):
            rs.verify_snapshot(result["snapshotDir"])

    def test_symlinked_content_rejected(self):
        link = self.content / "essays" / "link.md"
        link.symlink_to(self.content / "essays" / "one" / "index.md")
        with self.assertRaises(rs.SnapshotError):
            self._create()

    def test_extra_override_files_ignored_and_absolute_path_rejected(self):
        (self.overrides / "extra.yaml").write_text("secret: yes\n", encoding="utf-8")
        result = self._create()
        self.assertFalse((Path(result["tree"]) / "site-overrides" / "extra.yaml").exists())
        (self.overrides / "site.yaml").write_text('title: "/Users/someone/private"\n', encoding="utf-8")
        with self.assertRaises(rs.SnapshotError):
            self._create()

    def test_article_isolated_requires_baseline(self):
        with self.assertRaises(rs.SnapshotError):
            self._create(mode="article_isolated")
        result = self._create(
            mode="article_isolated",
            baseline_release_id="rel-20260101",
            target_article_sha256="a" * 64,
        )
        metadata = json.loads((Path(result["snapshotDir"]) / "snapshot.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["baselineReleaseId"], "rel-20260101")
        self.assertEqual(metadata["targetArticleSha256"], "a" * 64)

    def test_platform_commit_mismatch_rejected(self):
        with self.assertRaises(rs.SnapshotError):
            self._create(requested_commit="0" * 40)


if __name__ == "__main__":
    unittest.main()
