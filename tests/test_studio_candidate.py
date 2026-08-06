"""候选 manifest、敏感扫描、结构化失效错误测试（v0.2.5）。

全部使用虚构数据（TEST_TOKEN_DO_NOT_USE / example.invalid / 203.0.113.10）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

from studio import candidate_manifest as cm  # noqa: E402
from studio import sensitive_scan as ss  # noqa: E402

import test_studio_publish_iso as iso_mod  # noqa: E402
from studio import publish_article as pa  # noqa: E402
from studio import publish_isolated as iso  # noqa: E402

SNAPSHOT_FIXTURE = {
    "snapshotId": "snap_1234567890abcdef",
    "articleId": "article-1111111111111111",
    "slug": "iso-target",
    "assetManifest": {
        "entries": [
            {"relativePath": "images/a.jpg", "sha256": "a" * 64, "size": 1,
             "mimeType": "", "referenceType": "referenced", "exists": True},
        ],
        "unreferenced": [],
        "manifestSha256": "m" * 64,
    },
}
BASELINE_FIXTURE = {
    "privateContentCommit": "abc123456789def0123456789abcdef012345678",
    "manifestSha256": "b" * 64,
    "manifest": {"articles": []},
}


class CandidateManifestTests(unittest.TestCase):
    def test_classify_target_and_derived(self):
        self.assertEqual(cm.classify_file("essays/x/index.html", "/essays/x/", set(), "d"), "target-article")
        self.assertEqual(cm.classify_file("essays/x/img/a.jpg", "/essays/x/", set(), "d"), "target-resource")
        self.assertEqual(cm.classify_file("works/a/b/index.html", "/works/a/b/", set(), "d"), "target-article")
        self.assertEqual(cm.classify_file("index.xml", "/essays/x/", set(), "d"), "derived-index")
        self.assertEqual(cm.classify_file("tags/t/index.html", "/essays/x/", set(), "d"), "derived-index")
        self.assertEqual(cm.classify_file("essays/index.html", "/essays/x/", set(), "d"), "derived-index")
        self.assertEqual(cm.classify_file("BUILD_INFO", "/essays/x/", set(), "d"), "build-metadata")
        self.assertEqual(cm.classify_file("css/main.css", "/essays/x/", set(), "d"), "build-metadata")
        self.assertEqual(cm.classify_file("foo/bar.html", "/essays/x/", set(), "d"), "unclassified")
        self.assertEqual(cm.classify_file("essays/other/index.html", "/essays/x/", set(), "d"), "baseline-content")
        self.assertEqual(cm.classify_file("essays/index.xml", "/essays/x/", set(), "d"), "derived-index")
        self.assertEqual(cm.classify_file("media/p/1/a.jpg", "/essays/x/", {"a" * 64}, "a" * 64), "target-resource")
        self.assertEqual(cm.classify_file("media/p/1/b.jpg", "/essays/x/", {"a" * 64}, "b" * 64), "unclassified")

    def test_manifest_deterministic_and_sha_recomputable(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "site"
            site.mkdir()
            (site / "index.html").write_text("<html>a</html>", encoding="utf-8")
            (site / "essays").mkdir()
            (site / "essays" / "x").mkdir()
            (site / "essays" / "x" / "index.html").write_text("<h1>x</h1>", encoding="utf-8")
            m1 = cm.build_candidate_manifest(site, BASELINE_FIXTURE, SNAPSHOT_FIXTURE, "/essays/x/")
            m2 = cm.build_candidate_manifest(site, BASELINE_FIXTURE, SNAPSHOT_FIXTURE, "/essays/x/")
            self.assertEqual(m1["candidateId"], m2["candidateId"])
            self.assertEqual(m1["files"], m2["files"])
            payload = {k: v for k, v in m1.items() if k != "manifestSha256"}
            recomputed = __import__("hashlib").sha256(
                json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            self.assertEqual(m1["manifestSha256"], recomputed)
            paths = [f["path"] for f in m1["files"]]
            self.assertEqual(paths, sorted(paths))
            for f in m1["files"]:
                self.assertNotIn(str(tmp), f["path"])

    def test_manifest_snapshot_change_breaks_candidate_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "site"
            site.mkdir()
            (site / "index.html").write_text("<html>a</html>", encoding="utf-8")
            m1 = cm.build_candidate_manifest(site, BASELINE_FIXTURE, SNAPSHOT_FIXTURE, "/essays/x/")
            other = dict(SNAPSHOT_FIXTURE, snapshotId="snap_999")
            m2 = cm.build_candidate_manifest(site, BASELINE_FIXTURE, other, "/essays/x/")
            self.assertNotEqual(m1["candidateId"], m2["candidateId"])

    def test_materialize_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "ws"
            (root / "dist" / "site").mkdir(parents=True)
            (root / "dist" / "site" / "index.html").write_text("x", encoding="utf-8")
            root.mkdir(exist_ok=True)
            r1 = cm.materialize_candidate(root, root / "dist" / "site", BASELINE_FIXTURE, SNAPSHOT_FIXTURE, "/essays/x/")
            r2 = cm.materialize_candidate(root, root / "dist" / "site", BASELINE_FIXTURE, SNAPSHOT_FIXTURE, "/essays/x/")
            self.assertEqual(r1["candidateId"], r2["candidateId"])
            self.assertEqual(r1["manifestSha256"], r2["manifestSha256"])
            loaded = cm.load_candidate_manifest(root, r1["candidateId"])
            self.assertEqual(loaded["candidateId"], r1["candidateId"])

    def test_materialize_blocks_unclassified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "ws"
            (root / "dist" / "site" / "mystery").mkdir(parents=True)
            (root / "dist" / "site" / "mystery" / "x.txt").write_text("?", encoding="utf-8")
            result = cm.materialize_candidate(root, root / "dist" / "site", BASELINE_FIXTURE, SNAPSHOT_FIXTURE, "/essays/x/")
            self.assertGreater(result["manifest"]["unclassifiedCount"], 0)
            self.assertIn("mystery/x.txt", result["manifest"]["unclassifiedPaths"])

    def test_load_rejects_bad_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(cm.CandidateError):
                cm.load_candidate_manifest(Path(tmp), "../etc/passwd")


class SensitiveScanTests(unittest.TestCase):
    def _candidate(self, files: dict[str, str | bytes]) -> Path:
        tmp = Path(tempfile.mkdtemp(prefix="scan-"))
        for rel, content in files.items():
            path = tmp / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                path.write_bytes(content)
            else:
                path.write_text(content, encoding="utf-8")
        return tmp

    def test_clean_candidate_passes(self):
        d = self._candidate({
            "index.html": "<html>ok</html>",
            "essays/x/index.html": "<h1>x</h1>",
            "BUILD_INFO": "version: 0.4.3\nsourceCommit: abc\n",
            "css/main.css": "body{}",
        })
        result = ss.scan_candidate(d)
        self.assertFalse(result["blocked"])
        self.assertEqual(result["findings"], [])

    def test_fictional_secrets_blocked_without_content(self):
        d = self._candidate({
            "index.html": "ghp_" + "A" * 40,
            ".env": "WRITING_SSH_TARGET=game-server\n",
            "backup.sqlite": b"\x00" * 8,
            "note.docx": b"\x00" * 8,
            "id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
        })
        result = ss.scan_candidate(d)
        self.assertTrue(result["blocked"])
        kinds = {f["kind"] for f in result["findings"]}
        self.assertIn("token-ghp", kinds)
        self.assertIn("env-file", kinds)
        self.assertIn("sqlite-db", kinds)
        self.assertIn("docx", kinds)
        self.assertIn("private-key-header", kinds)
        raw = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("BEGIN OPENSSH", raw)

    def test_private_abs_path_blocked(self):
        d = self._candidate({"index.html": "file:///Users/haminster/secret/x"})
        result = ss.scan_candidate(d)
        self.assertTrue(result["blocked"])
        self.assertIn("private-abs-path", {f["kind"] for f in result["findings"]})


class PreviewCandidateIntegrationTests(unittest.TestCase):
    """在 ISO 假工作区里验证预览集成：候选清单 + 敏感扫描 + 结构化失效错误。"""

    def setUp(self):
        self.ws = iso_mod.IsoWorkspace()
        self.state = iso_mod.FakeState(self.ws)

    def tearDown(self):
        self.ws.cleanup()

    def _preview_ok(self, target):
        self.ws.write_candidate_manifest(target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(result["ok"], f"预览应成功：{result.get('checks')}")
        return result

    def test_preview_produces_candidate_and_scan_pass(self):
        target = iso_mod._new_target(self.ws)
        result = self._preview_ok(target)
        candidate = result["candidate"]
        self.assertIsNotNone(candidate)
        self.assertFalse(candidate["blocked"])
        self.assertTrue(candidate["candidateId"].startswith("cand_"))
        self.assertEqual(len(candidate["manifestSha256"]), 64)
        checks = {c["name"]: c["status"] for c in result["checks"]}
        self.assertEqual(checks.get("candidate-manifest"), "PASS")
        self.assertEqual(checks.get("sensitive-scan"), "PASS")

    def test_sensitive_findings_block_candidate(self):
        target = iso_mod._new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        (self.ws.root / "dist" / "site" / "secrets.json").write_text(
            '{"token": "TEST_TOKEN_DO_NOT_USE"}', encoding="utf-8")
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertFalse(result["ok"])
        checks = {c["name"]: c["status"] for c in result["checks"]}
        self.assertEqual(checks.get("sensitive-scan"), "FAIL")
        self.assertEqual(checks.get("candidate-manifest"), "FAIL")
        raw = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("TEST_TOKEN_DO_NOT_USE", raw)  # 只报告类型与位置，不回显内容

    def test_stale_error_has_structured_fields(self):
        target = iso_mod._new_target(self.ws)
        result = self._preview_ok(target)
        # 预览后只改元数据（description），正文与 revision 不变 → SHA 守卫触发
        fm = dict(target["frontMatter"])
        fm["description"] = "改过的描述"
        target["file"].write_text(
            "---\n" + json.dumps(fm, ensure_ascii=False, indent=2) + "\n---\n\n"
            + target["body"], encoding="utf-8")
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": result["previewBuildId"],
                "snapshotId": result["snapshotId"],
                "idempotencyKey": "stale-test-0001",
            })
        self.assertEqual(ctx.exception.code, "preview-stale")
        self.assertIn("expectedSourceFileSha256", ctx.exception.fields)
        self.assertIn("actualSourceFileSha256", ctx.exception.fields)
        self.assertNotEqual(ctx.exception.fields["expectedSourceFileSha256"],
                            ctx.exception.fields["actualSourceFileSha256"])

    def test_wrong_snapshot_id_rejected_with_fields(self):
        target = iso_mod._new_target(self.ws)
        result = self._preview_ok(target)
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": result["previewBuildId"],
                "snapshotId": "snap_wrong",
                "idempotencyKey": "wrong-snap-0001",
            })
        self.assertEqual(ctx.exception.code, "preview-stale")
        self.assertEqual(ctx.exception.fields.get("expectedSnapshotId"), result["snapshotId"])
        self.assertEqual(ctx.exception.fields.get("actualSnapshotId"), "snap_wrong")

    def test_expired_preview_rejected(self):
        target = iso_mod._new_target(self.ws)
        result = self._preview_ok(target)
        self.state.article_preview["createdAt"] = time.time() - pa.PREVIEW_FRESH_SECONDS - 10
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": result["previewBuildId"],
                "snapshotId": result["snapshotId"],
                "idempotencyKey": "expired-000001",
            })
        self.assertEqual(ctx.exception.code, "preview-expired")

    def test_publish_ok_uses_same_candidate_and_scan(self):
        target = iso_mod._new_target(self.ws)
        result = self._preview_ok(target)
        self.assertEqual(self.state.article_preview["candidate"]["candidateId"],
                         result["candidate"]["candidateId"])
        pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": result["previewBuildId"],
            "snapshotId": result["snapshotId"],
            "idempotencyKey": "same-cand-0001",
        })
        deadline = time.time() + 30
        while time.time() < deadline and not (self.state.article_publish_result or {}).get("ok"):
            time.sleep(0.2)
        result = self.state.article_publish_result or {}
        self.assertTrue(result.get("ok"), f"发布应成功：{result}")
        self.assertTrue(result.get("candidateId", "").startswith("cand_"))
        self.assertEqual(len(result.get("candidateManifestSha256") or ""), 64)


import time  # noqa: E402


if __name__ == "__main__":
    unittest.main()
