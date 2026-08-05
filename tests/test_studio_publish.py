"""文章发布闭环测试（v0.2.2）：状态、预览、发布锁、幂等、账本。

使用临时工作区 + 假 build.sh/publish.sh（成功或按需失败），不触碰真实发布。
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
from studio import server as studio_server  # noqa: E402


def _fake_workspace(fail_publish: bool = False) -> Path:
    root = Path(tempfile.mkdtemp(prefix="studio-pub-test-"))
    (root / "content" / "works").mkdir(parents=True)
    (root / "content" / "essays").mkdir(parents=True)
    (root / "scripts").mkdir(parents=True)
    (root / ".author-settings").write_text(
        "WRITING_SSH_TARGET=test-target\nWRITING_DOMAIN=example.test\n", encoding="utf-8"
    )
    build = "#!/usr/bin/env bash\nexit 0\n"
    (root / "scripts" / "build.sh").write_text(build, encoding="utf-8")
    (root / "scripts" / "check.sh").write_text(build, encoding="utf-8")
    if fail_publish:
        publish = "#!/usr/bin/env bash\necho '发布失败（模拟）' >&2\nexit 1\n"
    else:
        publish = "#!/usr/bin/env bash\necho 'PUBLISH_OK\\nrelease=/tmp/fake-release-001'\nexit 0\n"
    (root / "scripts" / "publish.sh").write_text(publish, encoding="utf-8")
    for script in ("build.sh", "check.sh", "publish.sh"):
        (root / "scripts" / script).chmod(0o755)
    return root


def _make_article(root: Path, slug: str = "test-article", draft: bool = True, body: str = "测试正文。") -> dict:
    today = "2026-08-05"
    front = {
        "title": "测试文章", "subtitle": "", "date": today, "lastmod": today, "slug": slug,
        "description": "", "draft": draft, "featured": False, "weight": 10,
        "collections": [], "categories": [], "tags": [], "series": [], "period": [], "people": [],
        "places": [], "aliases": [], "articleId": f"article-{slug[:8]:0<16}",
        "comments": {"paragraph": True},
    }
    target = root / "content" / "essays" / slug / "index.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    stabilized, _ = __import__("importer.paragraph_ids", fromlist=["assign_ids"]).assign_ids(body, "")
    front["articleRevision"] = __import__("importer.paragraph_ids", fromlist=["revision_for"]).revision_for(
        front["articleId"], stabilized
    )
    markdown = "---\n" + json.dumps(front, ensure_ascii=False, indent=2) + "\n---\n\n" + stabilized
    target.write_text(markdown, encoding="utf-8")
    return {"path": f"content/essays/{slug}/index.md", "frontMatter": front, "body": stabilized}


class FakeState:
    def __init__(self, project_root: Path):
        self.project_root = str(project_root)
        self.platform_root = str(project_root)
        self.lock = threading.Lock()
        self.workspace_environment = {}
        self.article_preview = None
        self.publish_lock_info = None
        self.article_publish_result = None


class ArticlePublishTests(unittest.TestCase):
    def test_状态_草稿与未发布(self):
        root = _fake_workspace()
        article = _make_article(root)
        state = FakeState(root)
        status = pa.article_publish_status(state, article["path"])
        self.assertTrue(status["draft"])
        self.assertEqual(status["publishedRevision"], "")
        self.assertFalse(status["previewFresh"])
        self.assertEqual(status["canonicalUrl"], "/essays/test-article/")

    def test_状态_已发布但存在未发布修改(self):
        root = _fake_workspace()
        article = _make_article(root)
        state = FakeState(root)
        pa.record_publish(root, {
            "id": "pub_1", "kind": "article", "articleId": article["frontMatter"]["articleId"],
            "revision": "old-revision-000000000000", "status": "ok",
            "createdAt": "2026-08-05T10:00:00+0800", "completedAt": "2026-08-05T10:00:05+0800",
            "releaseId": "20260805_100000", "anchors": [], "slug": "test-article",
        })
        status = pa.article_publish_status(state, article["path"])
        self.assertEqual(status["publishedRevision"], "old-revision-000000000000")
        self.assertNotEqual(status["revision"], status["publishedRevision"], "草稿已变=已发布但存在未发布修改")
        self.assertEqual(len(status["history"]), 1)

    def test_预览_通过(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False, body="第一段。\n\n第二段。")
        state = FakeState(root)
        result = pa.article_publish_preview(state, article["path"])
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["previewBuildId"])
        self.assertEqual(result["canonicalUrl"], "/essays/test-article/")
        self.assertEqual(result["anchor"]["retained"] + result["anchor"]["created"], 2)
        status = pa.article_publish_status(state, article["path"])
        self.assertTrue(status["previewFresh"])

    def test_预览_正文为空失败(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False, body="")
        state = FakeState(root)
        result = pa.article_publish_preview(state, article["path"])
        self.assertFalse(result["ok"])
        names = [c["name"] for c in result["checks"] if c["status"] == "FAIL"]
        self.assertIn("body-nonempty", names)

    def test_预览_锚点预演基于上次发布记录(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False, body="第一段。\n\n第二段。")
        article_id = article["frontMatter"]["articleId"]
        # 上次发布只有 p-111111111111（本次已不存在的锚点）→ deleted=1
        pa.record_publish(root, {
            "id": "pub_0", "kind": "article", "articleId": article_id,
            "revision": "rev-old", "status": "ok", "createdAt": "x", "completedAt": "x",
            "releaseId": "r0", "slug": "test-article", "anchors": ["p-111111111111"],
        })
        state = FakeState(root)
        result = pa.article_publish_preview(state, article["path"])
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["anchor"]["deleted"], 1)
        self.assertGreaterEqual(result["anchor"]["retained"], 0)

    def test_发布_revision变化拒绝(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False)
        state = FakeState(root)
        pa.article_publish_preview(state, article["path"])
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(state, article["path"], {
                "draftRevision": "wrong-revision", "previewBuildId": "x" * 20,
                "idempotencyKey": "idem-0000000001",
            })
        self.assertEqual(ctx.exception.code, "conflict")

    def test_发布_预览标识无效拒绝(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False)
        state = FakeState(root)
        revision = article["frontMatter"]["articleRevision"]
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(state, article["path"], {
                "draftRevision": revision, "previewBuildId": "bad" * 7,
                "idempotencyKey": "idem-0000000002",
            })
        self.assertEqual(ctx.exception.code, "preflight-required")

    def test_发布_草稿状态拒绝(self):
        root = _fake_workspace()
        article = _make_article(root, draft=True)
        state = FakeState(root)
        preview = pa.article_publish_preview(state, article["path"])
        self.assertTrue(preview["ok"], "草稿允许生成发布预览（预览不修改任何状态）")
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(state, article["path"], {
                "draftRevision": article["frontMatter"]["articleRevision"],
                "previewBuildId": preview["previewBuildId"], "idempotencyKey": "idem-0000000003",
            })
        self.assertEqual(ctx.exception.code, "validation-failed")

    def test_发布_正常完成(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False)
        state = FakeState(root)
        preview = pa.article_publish_preview(state, article["path"])
        self.assertTrue(preview["ok"])
        task = pa.article_publish(state, article["path"], {
            "draftRevision": article["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "idempotencyKey": "idem-0000000004",
        })
        self.assertTrue(task["ok"])
        # 轮询直到完成（假脚本立即成功）
        deadline = time.time() + 15
        while time.time() < deadline:
            status = pa.article_publish_status(state, article["path"])
            if not (status["lock"] and status["lock"]["inFlight"]):
                break
            time.sleep(0.1)
        result = pa.article_publish_status(state, article["path"])["result"]
        self.assertTrue(result and result["ok"])
        self.assertEqual(result["releaseId"], "/tmp/fake-release-001")
        status = pa.article_publish_status(state, article["path"])
        self.assertEqual(status["publishedRevision"], article["frontMatter"]["articleRevision"])
        self.assertTrue(status["history"][-1]["status"] == "ok")

    def test_发布_幂等重复(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False)
        state = FakeState(root)
        preview = pa.article_publish_preview(state, article["path"])
        pa.article_publish(state, article["path"], {
            "draftRevision": article["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "idempotencyKey": "idem-0000000005",
        })
        deadline = time.time() + 15
        while time.time() < deadline:
            if not (pa.article_publish_status(state, article["path"])["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        pa.article_publish_preview(state, article["path"])
        duplicate = pa.article_publish(state, article["path"], {
            "draftRevision": article["frontMatter"]["articleRevision"],
            "previewBuildId": pa.article_publish_status(state, article["path"]) and "x" * 20,
            "idempotencyKey": "idem-0000000005",
        })
        self.assertTrue(duplicate.get("duplicated"), "相同幂等键应返回原结果")
        entries = pa.read_ledger(root)
        self.assertEqual(sum(1 for e in entries if e.get("idempotencyKey") == "idem-0000000005"), 1, "不得重复发布")

    def test_发布_并发锁(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False)
        state = FakeState(root)
        # 模拟另一个发布任务正在运行（不同幂等键）
        state.article_preview = {
            "articleId": article["frontMatter"]["articleId"],
            "revision": article["frontMatter"]["articleRevision"],
            "buildId": "a" * 20, "createdAt": time.time(),
        }
        state.publish_lock_info = {
            "inFlight": True, "stage": "building", "startedAt": time.time(),
            "articleId": "other", "kind": "site", "status": "running",
            "idempotencyKey": "other-000000001",
        }
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(state, article["path"], {
                "draftRevision": article["frontMatter"]["articleRevision"],
                "previewBuildId": "a" * 20, "idempotencyKey": "idem-0000000007",
            })
        self.assertEqual(ctx.exception.code, "conflict")
        state.publish_lock_info = None

    def test_发布_失败记录与锁释放(self):
        root = _fake_workspace(fail_publish=True)
        article = _make_article(root, draft=False)
        state = FakeState(root)
        preview = pa.article_publish_preview(state, article["path"])
        pa.article_publish(state, article["path"], {
            "draftRevision": article["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "idempotencyKey": "idem-0000000008",
        })
        deadline = time.time() + 15
        while time.time() < deadline:
            status = pa.article_publish_status(state, article["path"])
            if not (status["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        result = pa.article_publish_status(state, article["path"])["result"]
        self.assertTrue(result and not result["ok"])
        entries = pa.read_ledger(root)
        self.assertEqual(entries[-1]["status"], "failed_publish")
        self.assertIsNone(pa.article_publish_status(state, article["path"])["lock"], "失败后锁必须释放")

    def test_发布_陈旧锁恢复(self):
        root = _fake_workspace()
        article = _make_article(root, draft=False)
        state = FakeState(root)
        state.publish_lock_info = {
            "inFlight": True, "stage": "building", "startedAt": time.time() - 2000,
            "articleId": article["frontMatter"]["articleId"], "kind": "article",
            "status": "running", "idempotencyKey": "stale-000000001",
        }
        status = pa.article_publish_status(state, article["path"])
        self.assertEqual(status["lock"]["status"], "failed_recovery", "超过超时+余量的锁标记为需人工核验")
        preview = pa.article_publish_preview(state, article["path"])
        self.assertTrue(preview["ok"])
        task = pa.article_publish(state, article["path"], {
            "draftRevision": article["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "idempotencyKey": "idem-0000000009",
        })
        self.assertTrue(task["ok"], "陈旧锁应被接管后允许新发布")


if __name__ == "__main__":
    unittest.main()


class UnrelatedChangesTests(unittest.TestCase):
    def _state_with_unrelated(self, fail_publish=False):
        root = _fake_workspace(fail_publish)
        article = _make_article(root, draft=False)
        # 模拟与本文无关的未提交修改
        unrelated = root / "content" / "essays" / "other-article" / "index.md"
        unrelated.parent.mkdir(parents=True, exist_ok=True)
        unrelated.write_text("---\ntitle: other\n---\n内容", encoding="utf-8")
        os.system(f"cd {root} && git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init && echo edit >> {unrelated} && git add {unrelated} && git -c user.email=t@t -c user.name=t commit -qm wip && echo more >> {unrelated}")
        return root, article

    def test_预览_存在无关未提交修改时FAIL并列出(self):
        root, article = self._state_with_unrelated()
        state = FakeState(root)
        result = pa.article_publish_preview(state, article["path"])
        names = [c["name"] for c in result["checks"] if c["status"] == "FAIL"]
        self.assertIn("workspace-clean", names)
        detail = next(c["detail"] for c in result["checks"] if c["name"] == "workspace-clean")
        self.assertIn("other-article", detail)

    def test_发布_存在无关未提交修改时拒绝(self):
        root, article = self._state_with_unrelated()
        state = FakeState(root)
        # 直接构造通过预览的假状态
        state.article_preview = {
            "articleId": article["frontMatter"]["articleId"],
            "revision": article["frontMatter"]["articleRevision"],
            "buildId": "a" * 20, "createdAt": time.time(),
        }
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(state, article["path"], {
                "draftRevision": article["frontMatter"]["articleRevision"],
                "previewBuildId": "a" * 20, "idempotencyKey": "idem-0000000010",
            })
        self.assertEqual(ctx.exception.code, "conflict")
        self.assertIn("other-article", ctx.exception.message)
