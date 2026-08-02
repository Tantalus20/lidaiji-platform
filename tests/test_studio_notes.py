#!/usr/bin/env python3
"""作者批注（studio/notes.py）测试：临时项目根 + 真实 index.md。

覆盖：read 空/坏 YAML；save 新建（id 生成、created/updated）；save 更新
（id 不变、updated 变）；paragraphId 必须存在于当前锚点；事务写
（os.replace 抛错 → 无残留 tmp、原文件不变）；备份生成；delete；
notes_summary 计数；index.md sha256 全程不变；路径穿越拒绝。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

from studio import notes as notes_module  # noqa: E402

REL_PATH = "content/essays/note-test/index.md"
BODY = """---
title: 批注测试
draft: true
articleId: article-note-test
---

<!-- paragraph-id:p-aaaa1111bbbb -->
第一段正文内容。

<!-- paragraph-id:p-cccc2222dddd -->
第二段正文内容。
"""

OLD_NOTES = """version: 1
notes:
  - id: note-aaaa1111bbbb
    scope: paragraph
    paragraphId: p-aaaa1111bbbb
    body: 旧批注
    status: draft
    created: '2000-01-01'
    updated: '2000-01-01'
"""


class NotesTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-notes-test-")
        self.root = Path(self.temp.name)
        bundle = self.root / "content" / "essays" / "note-test"
        bundle.mkdir(parents=True)
        self.index = bundle / "index.md"
        self.index.write_text(BODY, encoding="utf-8")
        self.index_sha = hashlib.sha256(self.index.read_bytes()).hexdigest()
        self.yaml_path = self.root / "data" / "author-notes" / "article-note-test.yaml"
        self.yaml_path.parent.mkdir(parents=True)
        self.legacy_path = bundle / "author-notes.yaml"

    def tearDown(self):
        self.temp.cleanup()

    def assert_index_untouched(self):
        self.assertEqual(hashlib.sha256(self.index.read_bytes()).hexdigest(), self.index_sha)

    def read_yaml(self) -> dict:
        return yaml.safe_load(self.yaml_path.read_text(encoding="utf-8"))

    # -- 读取 ---------------------------------------------------------------

    def test_01文件不存在返回空列表(self):
        self.assertEqual(notes_module.read_notes(self.root, REL_PATH), [])
        self.assert_index_untouched()

    def test_02坏YAML被拒绝(self):
        self.yaml_path.write_text("notes: [unclosed", encoding="utf-8")
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.read_notes(self.root, REL_PATH)
        self.assertEqual(caught.exception.code, "validation-failed")
        # 结构不合法同样拒绝
        self.yaml_path.write_text("version: 2\nnotes: []\n", encoding="utf-8")
        with self.assertRaises(notes_module.NoteFailure):
            notes_module.read_notes(self.root, REL_PATH)

    def test_03路径穿越拒绝(self):
        for bad in ("../index.md", "/etc/passwd", "content/essays/note-test", "content/evil/x/index.md"):
            with self.assertRaises(notes_module.NoteFailure):
                notes_module.read_notes(self.root, bad)
            with self.assertRaises(notes_module.NoteFailure):
                notes_module.save_note(self.root, bad, {"scope": "article", "body": "x"})

    # -- 新建与更新 -----------------------------------------------------------

    def test_04新建段落评(self):
        result = notes_module.save_note(
            self.root,
            REL_PATH,
            {"scope": "paragraph", "paragraphId": "p-aaaa1111bbbb", "body": "这段要再润色。"},
        )
        note = result["note"]
        self.assertRegex(note["id"], r"^note-[0-9a-f]{12}$")
        today = dt.date.today().isoformat()
        self.assertEqual(note["created"], today)
        self.assertEqual(note["updated"], today)
        self.assertEqual(note["status"], "draft")  # 默认草稿
        data = self.read_yaml()
        self.assertEqual(data["version"], 1)
        self.assertEqual(len(data["notes"]), 1)
        self.assertEqual(data["notes"][0]["body"], "这段要再润色。")
        self.assert_index_untouched()

    def test_05段落锚点必须存在(self):
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.save_note(
                self.root,
                REL_PATH,
                {"scope": "paragraph", "paragraphId": "p-000000000000", "body": "挂不上"},
            )
        self.assertEqual(caught.exception.code, "validation-failed")
        self.assertFalse(self.yaml_path.exists())
        # 格式不合法同样拒绝
        with self.assertRaises(notes_module.NoteFailure):
            notes_module.save_note(
                self.root, REL_PATH, {"scope": "paragraph", "paragraphId": "whatever", "body": "挂不上"}
            )
        self.assert_index_untouched()

    def test_06更新保持id并更新updated(self):
        self.yaml_path.write_text(OLD_NOTES, encoding="utf-8")
        result = notes_module.save_note(
            self.root,
            REL_PATH,
            {"id": "note-aaaa1111bbbb", "body": "改写后的批注", "status": "published"},
        )
        note = result["note"]
        self.assertEqual(note["id"], "note-aaaa1111bbbb")
        self.assertEqual(note["created"], "2000-01-01")
        self.assertEqual(note["updated"], dt.date.today().isoformat())
        self.assertEqual(note["status"], "published")
        self.assertEqual(note["scope"], "paragraph")
        self.assertEqual(note["paragraphId"], "p-aaaa1111bbbb")
        data = self.read_yaml()
        self.assertEqual(len(data["notes"]), 1)
        # scope 不可改
        with self.assertRaises(notes_module.NoteFailure):
            notes_module.save_note(self.root, REL_PATH, {"id": "note-aaaa1111bbbb", "scope": "article"})
        # 不存在的 id
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.save_note(self.root, REL_PATH, {"id": "note-ffffffffffff", "body": "x"})
        self.assertEqual(caught.exception.code, "not-found")
        self.assert_index_untouched()

    def test_07篇章评不带段落锚点(self):
        result = notes_module.save_note(self.root, REL_PATH, {"scope": "article", "body": "全篇总评。"})
        self.assertIsNone(result["note"]["paragraphId"])
        with self.assertRaises(notes_module.NoteFailure):
            notes_module.save_note(
                self.root,
                REL_PATH,
                {"id": result["note"]["id"], "paragraphId": "p-aaaa1111bbbb"},
            )
        self.assert_index_untouched()

    def test_08正文长度与空正文校验(self):
        with self.assertRaises(notes_module.NoteFailure):
            notes_module.save_note(self.root, REL_PATH, {"scope": "article", "body": "  "})
        with self.assertRaises(notes_module.NoteFailure):
            notes_module.save_note(self.root, REL_PATH, {"scope": "article", "body": "x" * 5001})
        self.assertFalse(self.yaml_path.exists())

    # -- 事务与备份 -----------------------------------------------------------

    def test_09写入失败无残留且原文件不变(self):
        self.yaml_path.write_text(OLD_NOTES, encoding="utf-8")
        before = self.yaml_path.read_bytes()
        with mock.patch.object(notes_module.os, "replace", side_effect=OSError("磁盘写失败")):
            with self.assertRaises(OSError):
                notes_module.save_note(
                    self.root, REL_PATH, {"id": "note-aaaa1111bbbb", "body": "不会写入"}
                )
        self.assertEqual(self.yaml_path.read_bytes(), before)
        self.assertEqual(list(self.yaml_path.parent.glob(".author-notes-*.tmp")), [])
        self.assert_index_untouched()

    def test_10写入前生成备份(self):
        self.yaml_path.write_text(OLD_NOTES, encoding="utf-8")
        notes_module.save_note(self.root, REL_PATH, {"id": "note-aaaa1111bbbb", "body": "第二版"})
        backups = list((self.root / ".cache" / "studio" / "backups" / "essays-note-test").glob("notes-*.yaml"))
        self.assertEqual(len(backups), 1)
        self.assertIn("旧批注", backups[0].read_text(encoding="utf-8"))

    def test_11删除批注(self):
        self.yaml_path.write_text(OLD_NOTES, encoding="utf-8")
        remaining = notes_module.delete_note(self.root, REL_PATH, "note-aaaa1111bbbb")
        self.assertEqual(remaining, [])
        self.assertFalse(self.yaml_path.exists())  # 删空后移除文件
        # 删除前有备份兜底
        backups = list((self.root / ".cache" / "studio" / "backups" / "essays-note-test").glob("notes-*.yaml"))
        self.assertEqual(len(backups), 1)
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.delete_note(self.root, REL_PATH, "note-aaaa1111bbbb")
        self.assertEqual(caught.exception.code, "not-found")
        self.assert_index_untouched()

    # -- 汇总 ---------------------------------------------------------------

    def test_12汇总统计(self):
        notes_module.save_note(self.root, REL_PATH, {"scope": "article", "body": "草稿一"})
        notes_module.save_note(
            self.root,
            REL_PATH,
            {"scope": "paragraph", "paragraphId": "p-cccc2222dddd", "body": "发布一", "status": "published"},
        )
        summary = notes_module.notes_summary(self.root)
        self.assertEqual(summary["totalDraft"], 1)
        self.assertEqual(summary["totalPublished"], 1)
        entry = next(item for item in summary["articles"] if item["path"] == REL_PATH)
        self.assertEqual(entry["draft"], 1)
        self.assertEqual(entry["published"], 1)
        self.assertFalse(entry["error"])
        self.assert_index_untouched()

    def test_13段落摘录列表(self):
        paragraphs = notes_module.list_paragraphs(self.root, REL_PATH)
        self.assertEqual([item["paragraphId"] for item in paragraphs], ["p-aaaa1111bbbb", "p-cccc2222dddd"])
        self.assertIn("第一段", paragraphs[0]["excerpt"])
        self.assert_index_untouched()

    # -- 附带小修：新建路径的对称校验 -----------------------------------------

    def test_14新建篇章评带段落锚点被拒(self):
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.save_note(
                self.root,
                REL_PATH,
                {"scope": "article", "paragraphId": "p-aaaa1111bbbb", "body": "不该带锚点"},
            )
        self.assertEqual(caught.exception.code, "validation-failed")
        self.assertFalse(self.yaml_path.exists())
        self.assert_index_untouched()

    def test_15非字符串正文文案区分(self):
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.save_note(self.root, REL_PATH, {"scope": "article", "body": 123})
        self.assertIn("必须是字符串", str(caught.exception))
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.save_note(self.root, REL_PATH, {"scope": "article", "body": "  "})
        self.assertIn("不能为空", str(caught.exception))
        self.assertFalse(self.yaml_path.exists())

    # -- 失效锚点检测与发布阻断 -------------------------------------------------

    def test_16失效批注检测(self):
        notes_module.save_note(
            self.root,
            REL_PATH,
            {"scope": "paragraph", "paragraphId": "p-aaaa1111bbbb", "body": "挂在第一段", "status": "published"},
        )
        self.assertEqual(notes_module.broken_notes(self.root), [])
        # 草稿批注即使锚点失效也不算（不公开）
        notes_module.save_note(
            self.root,
            REL_PATH,
            {"scope": "paragraph", "paragraphId": "p-cccc2222dddd", "body": "挂在第二段"},
        )
        # 正文删掉两个锚点（模拟删除段落）
        self.index.write_text(BODY.replace("<!-- paragraph-id:p-aaaa1111bbbb -->\n", "").replace("<!-- paragraph-id:p-cccc2222dddd -->\n", ""), encoding="utf-8")
        broken = notes_module.broken_notes(self.root)
        self.assertEqual(len(broken), 1)
        self.assertEqual(broken[0]["paragraphId"], "p-aaaa1111bbbb")
        self.assertEqual(broken[0]["path"], REL_PATH)
        self.assertIn("挂在第一段", broken[0]["excerpt"])
        summary = notes_module.notes_summary(self.root)
        self.assertEqual(summary["brokenPublished"], 1)
        self.assertEqual(len(summary["broken"]), 1)
        # 改回草稿后不再失效
        notes_module.save_note(self.root, REL_PATH, {"id": summary["broken"][0]["id"], "status": "draft"})
        self.assertEqual(notes_module.broken_notes(self.root), [])

    def test_17发布前检查被失效批注阻断(self):
        from studio import publish_center

        (self.root / "scripts").mkdir(exist_ok=True)
        (self.root / "scripts" / "build.sh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        notes_module.save_note(
            self.root,
            REL_PATH,
            {"scope": "paragraph", "paragraphId": "p-aaaa1111bbbb", "body": "挂在第一段", "status": "published"},
        )
        self.index.write_text(BODY.replace("<!-- paragraph-id:p-aaaa1111bbbb -->\n", ""), encoding="utf-8")
        called = []

        def fake_run_script(project_root, script, timeout, env=None):
            called.append(script)
            return {"success": True, "output": "ok", "duration": 0.1, "timedOut": False, "script": script}

        with mock.patch.object(publish_center, "_run_script", side_effect=fake_run_script):
            result = publish_center.run_preflight(self.root, False)
            self.assertFalse(result["success"])
            self.assertEqual(called, [])  # 脚本未被运行
            self.assertIn("p-aaaa1111bbbb", result["output"])
            self.assertIn("挂在第一段", result["output"])
            # 删除失效批注后 preflight 恢复可跑通
            summary = notes_module.notes_summary(self.root)
            notes_module.delete_note(self.root, REL_PATH, summary["broken"][0]["id"])
            result = publish_center.run_preflight(self.root, False)
            self.assertTrue(result["success"])
            self.assertEqual(called, ["scripts/build.sh"])

    def test_18旧Bundle作者评幂等迁移到data目录(self):
        self.legacy_path.write_text(OLD_NOTES, encoding="utf-8")
        loaded = notes_module.read_notes(self.root, REL_PATH)
        self.assertEqual(loaded[0]["body"], "旧批注")
        self.assertTrue(self.yaml_path.is_file())
        self.assertFalse(self.legacy_path.exists())
        # 再读不会重置、复制或改变新文件。
        before = self.yaml_path.read_bytes()
        self.assertEqual(notes_module.read_notes(self.root, REL_PATH), loaded)
        self.assertEqual(self.yaml_path.read_bytes(), before)

    def test_19旧新作者评冲突时不覆盖也不删除(self):
        self.legacy_path.write_text(OLD_NOTES, encoding="utf-8")
        self.yaml_path.write_text(OLD_NOTES.replace("旧批注", "新位置批注"), encoding="utf-8")
        old_before = self.legacy_path.read_bytes()
        new_before = self.yaml_path.read_bytes()
        with self.assertRaises(notes_module.NoteFailure) as caught:
            notes_module.read_notes(self.root, REL_PATH)
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(self.legacy_path.read_bytes(), old_before)
        self.assertEqual(self.yaml_path.read_bytes(), new_before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
