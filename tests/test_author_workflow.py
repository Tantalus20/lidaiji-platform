#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSISTANT = ROOT / "importer" / "docx-assistant.py"
SUMMARY = ROOT / "scripts" / "publish-summary.py"


class AuthorWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="writing-author-test-")
        self.root = Path(self.temp.name)
        collection = self.root / "content" / "works" / "sample-collection"
        collection.mkdir(parents=True)
        (collection / "_index.md").write_text(
            '---\ntitle: "示例文集"\n---\n', encoding="utf-8"
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_01中文文件名自动识别文集标题和拼音slug(self):
        source = self.root / "《示例文集·第一章》.docx"
        source.touch()
        completed = subprocess.run(
            [
                sys.executable,
                str(ASSISTANT),
                str(source),
                "--project-root",
                str(self.root),
            ],
            text=True,
            capture_output=True,
            check=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["section"], "works")
        self.assertEqual(result["collection"], "示例文集")
        self.assertEqual(result["collection_slug"], "sample-collection")
        self.assertEqual(result["title"], "第一章")
        self.assertEqual(result["slug"], "di-yi-zhang")
        self.assertEqual(result["url"], "/works/sample-collection/di-yi-zhang/")

    def test_02随笔文件名自动进入随笔栏目(self):
        source = self.root / "《随笔·夏日杂感》.docx"
        source.touch()
        output = subprocess.check_output(
            [
                sys.executable,
                str(ASSISTANT),
                str(source),
                "--project-root",
                str(self.root),
            ],
            text=True,
        )
        result = json.loads(output)
        self.assertEqual(result["section"], "essays")
        self.assertEqual(result["slug"], "xia-ri-za-gan")

    def test_03发布摘要区分公开稿和草稿(self):
        public = self.root / "content" / "essays" / "public"
        draft = self.root / "content" / "essays" / "draft"
        public.mkdir(parents=True)
        draft.mkdir(parents=True)
        (public / "index.md").write_text(
            '---\ntitle: "公开文章"\ndraft: false\n---\n正文\n', encoding="utf-8"
        )
        (draft / "index.md").write_text(
            '---\ntitle: "草稿文章"\ndraft: true\n---\n正文\n', encoding="utf-8"
        )
        command = [sys.executable, str(SUMMARY), "--project-root", str(self.root)]
        output = subprocess.check_output(command, text=True)
        self.assertIn("《公开文章》— 将公开", output)
        self.assertIn("《草稿文章》— 草稿，不会公开", output)
        subprocess.run([*command, "--write"], check=True, capture_output=True)
        unchanged = subprocess.check_output(command, text=True)
        self.assertIn("文章内容与上次成功发布记录一致", unchanged)

    def test_04桌面快捷方式安装不覆盖同名文件(self):
        desktop = self.root / "Desktop"
        applications = self.root / "Applications"
        env = os.environ.copy()
        env["WRITING_DESKTOP_DIR"] = str(desktop)
        env["WRITING_APPLICATIONS_DIR"] = str(applications)
        subprocess.run(
            [str(ROOT / "scripts" / "install-desktop-shortcuts.sh")],
            check=True,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertTrue((desktop / "历代纪来稿箱").is_symlink())
        app_output = applications / "历代纪写作.app"
        self.assertTrue(app_output.is_dir())
        self.assertTrue((app_output / "Contents" / "Info.plist").is_file())
        self.assertTrue((app_output / "Contents" / "Resources" / "root-path.txt").is_file())
        self.assertTrue((desktop / "历代纪写作").is_file())
        self.assertFalse((desktop / "历代纪写作.app").exists())
        self.assertFalse((desktop / "历代纪写作.command").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
