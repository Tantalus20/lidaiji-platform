"""文章发布闭环测试（v0.2.3 语义）：状态、发布锁、幂等、账本。

隔离发布模型（基线+快照）的完整行为由 test_studio_publish_iso.py 覆盖；
本文件保留与模型无关的通用行为测试（状态展示、锁生命周期、幂等、恢复）。
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from studio import publish_article as pa  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="pub-ledger-test-"))


class FakeState:
    def __init__(self, project_root: Path):
        self.project_root = str(project_root)
        self.platform_root = str(project_root)
        self.lock = threading.Lock()
        self.workspace_environment = {}
        self.article_preview = None
        self.publish_lock_info = None
        self.article_publish_result = None


class ArticlePublishStateTests(unittest.TestCase):
    def test_发布锁_正常生命周期(self):
        root = Path(tempfile.mkdtemp())
        state = FakeState(root)
        lock = pa.acquire_publish_lock(state, "idem-0000000001")
        self.assertTrue(lock["inFlight"])
        self.assertEqual(pa.publish_lock_status(state)["stage"], "validating")
        pa.update_publish_stage(state, "building")
        self.assertEqual(pa.publish_lock_status(state)["stage"], "building")
        pa.release_publish_lock(state)
        self.assertIsNone(pa.publish_lock_status(state))

    def test_发布锁_陈旧锁标记需人工核验(self):
        root = Path(tempfile.mkdtemp())
        state = FakeState(root)
        state.publish_lock_info = {
            "inFlight": True, "stage": "building", "startedAt": time.time() - 2000,
            "articleId": "", "kind": "site", "status": "running", "idempotencyKey": "stale-000000001",
        }
        status = pa.publish_lock_status(state)
        self.assertEqual(status["status"], "failed_recovery")

    def test_幂等_账本查重(self):
        root = Path(tempfile.mkdtemp())
        pa.record_publish(root, {
            "id": "pub_1", "kind": "article", "articleId": "article-abcdef0000000001",
            "revision": "r1", "status": "ok", "idempotencyKey": "idem-0000000002",
            "createdAt": "x", "completedAt": "y", "releaseId": "R1", "slug": "s",
        })
        prior = pa.record_by_idempotency(root, "idem-0000000002")
        self.assertIsNotNone(prior)
        self.assertIsNone(pa.record_by_idempotency(root, "idem-0000000003"))

    def test_账本_不保存全文与秘密(self):
        root = Path(tempfile.mkdtemp())
        pa.record_publish(root, {
            "id": "pub_2", "kind": "article", "articleId": "article-abcdef0000000002",
            "revision": "r2", "status": "ok", "idempotencyKey": "idem-0000000004",
            "createdAt": "x", "completedAt": "y", "releaseId": "R2", "slug": "s",
            "anchors": ["p-111111111111"],
        })
        raw = (root / ".cache" / "studio" / "publish-history.json").read_text(encoding="utf-8")
        self.assertNotIn("正文", raw)
        self.assertNotIn("password", raw)
        self.assertNotIn("token", raw)

    def test_发布参数_缺snapshotId拒绝(self):
        root = Path(tempfile.mkdtemp())
        state = FakeState(root)
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(state, "content/essays/x/index.md", {
                "draftRevision": "r", "previewBuildId": "b", "idempotencyKey": "idem-0000000005",
            })
        self.assertEqual(ctx.exception.code, "validation-failed")


if __name__ == "__main__":
    unittest.main()


class SweepCacheTests(unittest.TestCase):
    """会话清扫必须保留持久状态（账本/候选/发布日志），只清会话临时目录。"""

    def setUp(self):
        self.root = Path(TMP)
        (self.root / "persist-test").mkdir(parents=True, exist_ok=True)

    def test_sweep_preserves_persistent_entries(self):
        import studio.server as srv
        base = self.root / "persist-test"
        (base / "candidates").mkdir()
        (base / "publish-logs").mkdir()
        (base / "backups").mkdir()
        (base / "publish-history.json").write_text("[]", encoding="utf-8")
        (base / "session-tmp").mkdir()
        (base / "session-tmp" / "x.bin").write_bytes(b"x")
        srv.sweep_cache(base)
        self.assertTrue((base / "candidates").is_dir())
        self.assertTrue((base / "publish-logs").is_dir())
        self.assertTrue((base / "backups").is_dir())
        self.assertTrue((base / "publish-history.json").is_file())
        self.assertFalse((base / "session-tmp").exists())
