"""v0.2.5 部署阻断项收口测试：

- 可信基线构造：公开文章基线、未公开/私密文章与作者评绝不进入隔离输入；
- 候选完整性重验（CANDIDATE_TAMPERED）篡改矩阵；
- .cache 受控豁免白名单；
- LIDAIJI_DIST_ROOT 构建输出隔离；
- 测试 fixture 标记门禁与开发模式服务端门禁。
全部使用虚构数据与临时仓库。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

from studio import candidate_manifest as cm  # noqa: E402
from studio import publish_article as pa  # noqa: E402
from studio import publish_isolated as iso  # noqa: E402

import test_studio_publish_iso as iso_mod  # noqa: E402


class PublicBaselineWorkspace(iso_mod.IsoWorkspace):
    """扩展夹具：公开 A/B + 已提交未公开 C + 私密 D + 作者评 + 资源 + 私密 md。"""

    def __init__(self):
        super().__init__()
        # C：已提交但从未公开（articleId 不在 manifest）
        self.article_c = iso_mod._make_article_file(self.root, "iso-unpublished",
                                                    "未公开文章正文第一段。\n\n未公开正文第二段。", False)
        # D：已提交的私密作品（works 文集内）
        d_dir = self.root / "content" / "works" / "lidai-ji" / "iso-private"
        d_dir.mkdir(parents=True, exist_ok=True)
        self.article_d = iso_mod._make_article_file(self.root, "iso-private",
                                                    "私密作品正文第一段。\n\n私密正文第二段。", False)
        # C/D 资源
        for art, name in ((self.article_c, "c-secret.png"), (self.article_d, "d-secret.png")):
            img = art["file"].parent / "images"
            img.mkdir(exist_ok=True)
            (img / name).write_bytes(b"SECRETIMG")
        # C 的作者评
        (self.root / "data" / "author-notes" /
         f"{self.article_c['frontMatter']['articleId']}-notes.yaml").write_text(
            "id: n-c\nstatus: published\n", encoding="utf-8")
        # 普通命名的私密 Markdown（非 index.md）
        (self.root / "content" / "essays" / "secret-notes.md").write_text(
            "# 私密草稿\n\n绝不公开。", encoding="utf-8")
        # A 未提交修改（脏）
        a_file = self.baseline_article["file"]
        a_file.write_text(a_file.read_text(encoding="utf-8") + "\n甲文章未提交修改。\n", encoding="utf-8")
        # 提交 C/D/资源/作者评/私密md（基线 HEAD 含未公开内容）
        _git = lambda *args: subprocess.run(  # noqa: E731
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
            capture_output=True, text=True, cwd=self.root, timeout=30)
        _git("add", "-A")
        _git("commit", "-qm", "commit unpublished content")
        # 重新把 A 变脏（在提交之后）
        a_file.write_text(a_file.read_text(encoding="utf-8") + "\n甲文章再次修改。\n", encoding="utf-8")


class BaselineIsolationTests(unittest.TestCase):
    def setUp(self):
        self.ws = PublicBaselineWorkspace()
        self.state = iso_mod.FakeState(self.ws)
        self.baseline = iso.resolve_published_baseline(self.state, "example.test")

    def tearDown(self):
        self.ws.cleanup()

    def test_baseline_lists_only_public_bundles(self):
        bundles = self.baseline["publicArticleBundles"]
        self.assertEqual(len(bundles), 1)  # 仅 baseline-article（公开）
        self.assertEqual(list(bundles.values())[0], "content/essays/baseline-article")

    def test_isolated_input_excludes_unpublished_and_private(self):
        target = iso_mod._new_target(self.ws)
        snapshot = iso.create_target_snapshot(self.state, target["path"],
                                              target["frontMatter"]["articleRevision"])
        merged = iso.build_merged_content(self.state, iso._resolve_target(self.state, target["path"]),
                                          snapshot, self.baseline)
        try:
            content = merged["contentRoot"]
            self.assertTrue((content / "essays" / "baseline-article" / "index.md").is_file())
            self.assertTrue((content / "essays" / "iso-target" / "index.md").is_file())
            # C/D/资源/私密 md/作者评从未进入隔离输入
            self.assertFalse((content / "essays" / "iso-unpublished").exists())
            self.assertFalse((content / "works" / "lidai-ji" / "iso-private").exists())
            self.assertFalse((content / "essays" / "secret-notes.md").exists())
            notes = list(merged["authorNotesRoot"].glob("*.yaml"))
            self.assertEqual(notes, [])
        finally:
            iso.cleanup_merged_content(merged)

    def test_preview_candidate_excludes_unpublished(self):
        target = iso_mod._new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(result["ok"], result["checks"])
        manifest = cm.load_candidate_manifest(self.ws.root, result["candidate"]["candidateId"])
        paths = {f["path"] for f in manifest["files"]}
        self.assertFalse(any("iso-unpublished" in p or "iso-private" in p for p in paths))
        candidate_dir = cm._candidates_root(self.ws.root) / result["candidate"]["candidateId"]
        sitemap = (candidate_dir / "sitemap.xml").read_text(encoding="utf-8", errors="replace") \
            if (candidate_dir / "sitemap.xml").is_file() else ""
        self.assertNotIn("iso-unpublished", sitemap)
        self.assertNotIn("iso-private", sitemap)
        # 日志不含 C/D 正文
        output = result.get("buildOutput") or ""
        self.assertNotIn("未公开文章正文", output)
        self.assertNotIn("私密作品正文", output)

    def test_fail_closed_when_baseline_unconstructable(self):
        # 线上 manifest 增加一篇 HEAD 中不存在的文章 → 无法构造公开基线
        manifest = json.loads(Path(os.environ["LIDAIJI_PUBLISH_MANIFEST_FILE"]).read_text(encoding="utf-8"))
        ghost = dict(manifest["articles"][0])
        ghost["articleId"] = "article-ffffffffffffffff"
        manifest["articles"].append(ghost)
        Path(os.environ["LIDAIJI_PUBLISH_MANIFEST_FILE"]).write_text(json.dumps(manifest), encoding="utf-8")
        try:
            with self.assertRaises(iso.IsolationError) as ctx:
                iso.resolve_published_baseline(self.state, "example.test")
            self.assertEqual(ctx.exception.code, "baseline-mismatch")
        finally:
            self.ws._restore_manifest() if hasattr(self.ws, "_restore_manifest") else None
            # 恢复原始 manifest
            from test_studio_publish_iso import _TMP_MANIFEST
            _TMP_MANIFEST.write_text(json.dumps(self.ws.baseline_manifest), encoding="utf-8")


class CandidateTamperTests(unittest.TestCase):
    def setUp(self):
        self.ws = iso_mod.IsoWorkspace()
        self.state = iso_mod.FakeState(self.ws)
        self.baseline = iso.resolve_published_baseline(self.state, "example.test")
        self.target = iso_mod._new_target(self.ws)
        self.snapshot = iso.create_target_snapshot(
            self.state, self.target["path"], self.target["frontMatter"]["articleRevision"])
        site = self.ws.root / "dist" / "site"
        site.mkdir(parents=True, exist_ok=True)
        (site / "index.html").write_text("<html>ok</html>", encoding="utf-8")
        (site / "essays").mkdir()
        (site / "essays" / "iso-target").mkdir()
        (site / "essays" / "iso-target" / "index.html").write_text("<h1>目标</h1>", encoding="utf-8")
        self.result = cm.materialize_candidate(self.ws.root, site, self.baseline, self.snapshot, "/essays/iso-target/")
        self.candidate_dir = Path(self.result["candidateDir"])
        self.manifest_path = self.candidate_dir / "candidate-manifest.json"

    def tearDown(self):
        self.ws.cleanup()

    def _manifest(self):
        return json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def test_modify_html_character_detected(self):
        html = self.candidate_dir / "essays" / "iso-target" / "index.html"
        html.write_text(html.read_text(encoding="utf-8") + "X", encoding="utf-8")
        violations = cm.verify_candidate(self.candidate_dir, self._manifest())
        self.assertTrue(any("SHA-256 不符" in v for v in violations))

    def test_extra_file_detected(self):
        (self.candidate_dir / "rogue.txt").write_text("x", encoding="utf-8")
        violations = cm.verify_candidate(self.candidate_dir, self._manifest())
        self.assertTrue(any("额外文件" in v for v in violations))

    def test_missing_file_detected(self):
        (self.candidate_dir / "index.html").unlink()
        violations = cm.verify_candidate(self.candidate_dir, self._manifest())
        self.assertTrue(any("缺失文件" in v for v in violations))

    def test_symlink_detected(self):
        (self.candidate_dir / "essays" / "iso-target" / "index.html").unlink()
        os.symlink("/etc/hosts", self.candidate_dir / "essays" / "iso-target" / "index.html")
        violations = cm.verify_candidate(self.candidate_dir, self._manifest())
        self.assertTrue(any("符号链接" in v for v in violations))

    def test_manifest_modified_without_candidate_id_change(self):
        manifest = self._manifest()
        manifest["files"][0]["sha256"] = "0" * 64
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        violations = cm.verify_candidate(self.candidate_dir, self._manifest())
        self.assertTrue(any("manifestSha256 不匹配" in v for v in violations))

    def test_candidate_id_modified(self):
        manifest = self._manifest()
        manifest["candidateId"] = "cand_" + "1" * 20
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        violations = cm.verify_candidate(self.candidate_dir, self._manifest())
        self.assertTrue(any("manifestSha256 不匹配" in v for v in violations))

    def test_reuse_half_finished_candidate_blocked(self):
        # 半成品：候选目录存在但清单缺失 → 复用路径必须阻断
        self.manifest_path.unlink()
        with self.assertRaises(cm.CandidateError) as ctx:
            cm.materialize_candidate(self.ws.root, self.ws.root / "dist" / "site",
                                     self.baseline, self.snapshot, "/essays/iso-target/")
        self.assertEqual(ctx.exception.code, "candidate-tampered")

    def test_materialize_reuse_rejects_tampered(self):
        html = self.candidate_dir / "essays" / "iso-target" / "index.html"
        html.write_text(html.read_text(encoding="utf-8") + "T", encoding="utf-8")
        with self.assertRaises(cm.CandidateError) as ctx:
            cm.materialize_candidate(self.ws.root, self.ws.root / "dist" / "site",
                                     self.baseline, self.snapshot, "/essays/iso-target/")
        self.assertEqual(ctx.exception.code, "candidate-tampered")


class CacheGateTests(unittest.TestCase):
    def setUp(self):
        self.ws = iso_mod.IsoWorkspace()
        self.state = iso_mod.FakeState(self.ws)

    def tearDown(self):
        self.ws.cleanup()

    def _dirty(self, rel: str, content: str = "x"):
        node = self.ws.root / rel
        node.parent.mkdir(parents=True, exist_ok=True)
        node.write_text(content, encoding="utf-8")
        subprocess.run(["git", "add", "-A"], capture_output=True, cwd=self.ws.root, timeout=30)

    def test_unknown_cache_entry_blocks(self):
        self._dirty(".cache/studio/weird-file.txt")
        blocked = iso.platform_clean_check(self.ws.root)
        self.assertTrue(any("未知 .cache 条目" in b for b in blocked))

    def test_controlled_entries_pass(self):
        self._dirty(".cache/studio/publish-history.json", "[]")
        (self.ws.root / ".cache" / "studio" / "publish-logs").mkdir(parents=True)
        (self.ws.root / ".cache" / "studio" / "publish-logs" / "pub_000000000000.log").write_text("log", encoding="utf-8")
        (self.ws.root / ".cache" / "studio" / "locks").mkdir(parents=True)
        (self.ws.root / ".cache" / "studio" / "locks" / "pub_000000000000.lock").write_text("{}", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], capture_output=True, cwd=self.ws.root, timeout=30)
        blocked = iso.platform_clean_check(self.ws.root)
        self.assertEqual(blocked, [])

    def test_cache_symlink_blocked(self):
        target = self.ws.root / "outside-target"
        target.mkdir()
        (target / "x").write_text("x", encoding="utf-8")
        (self.ws.root / ".cache" / "studio").mkdir(parents=True)
        os.symlink(target, self.ws.root / ".cache" / "studio" / "publish-history.json")
        subprocess.run(["git", "add", "-A"], capture_output=True, cwd=self.ws.root, timeout=30)
        blocked = iso.platform_clean_check(self.ws.root)
        self.assertTrue(any("符号链接" in b for b in blocked))


class OutputIsolationAndGatesTests(unittest.TestCase):
    def setUp(self):
        self.ws = iso_mod.IsoWorkspace()
        self.state = iso_mod.FakeState(self.ws)

    def tearDown(self):
        self.ws.cleanup()
        os.environ.pop("LIDAIJI_DIST_ROOT", None)
        os.environ.pop("STUDIO_DISABLE_PRODUCTION_PUBLISH", None)

    def test_site_output_dir_honors_env(self):
        from studio import publish_center
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["LIDAIJI_DIST_ROOT"] = tmp
            self.assertEqual(publish_center.site_output_dir(self.ws.root), Path(tmp).resolve() / "site")
        os.environ.pop("LIDAIJI_DIST_ROOT", None)
        self.assertEqual(publish_center.site_output_dir(self.ws.root),
                         (self.ws.root / "dist" / "site").resolve())

    def test_dist_override_keeps_real_dist_untouched(self):
        from studio import publish_center
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["LIDAIJI_DIST_ROOT"] = tmp
            target = iso_mod._new_target(self.ws)
            (Path(tmp) / "site").mkdir(parents=True)
            (Path(tmp) / "site" / "comment-manifest.json").write_text(
                json.dumps({"schemaVersion": 1, "articles": [
                    dict(a) for a in self.ws.baseline_manifest["articles"]] +
                    [iso_mod._article_manifest_entry(target["file"])]}), encoding="utf-8")
            result = pa.article_publish_preview(self.state, target["path"])
            self.assertTrue(result["ok"], result["checks"])
            self.assertFalse((self.ws.root / "dist" / "site").exists())

    def test_test_marker_slug_blocks_production_publish(self):
        target = iso_mod._make_article_file(self.ws.root, "acc-browser",
                                            "验收文章正文。\n\n第二段。", False)
        self.ws.write_candidate_manifest(target)
        page = self.ws.root / "dist" / "site" / "essays" / "acc-browser"
        page.mkdir(parents=True, exist_ok=True)
        (page / "index.html").write_text("<h1>验收</h1>", encoding="utf-8")
        result = pa.article_publish_preview(self.state, target["path"])
        checks = {c["name"]: c["status"] for c in result["checks"]}
        self.assertEqual(checks.get("test-marker"), "WARNING")
        self.assertTrue(result["ok"])  # 本地预览允许（候选不部署）
        # 生产发布被标记门禁阻断
        pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": result["previewBuildId"],
            "snapshotId": result["snapshotId"],
            "idempotencyKey": "marker-gate-001",
        })
        deadline = time.time() + 30
        while time.time() < deadline and not (self.state.article_publish_result or {}).get("error"):
            time.sleep(0.2)
        result = self.state.article_publish_result or {}
        self.assertFalse(result.get("ok"))
        self.assertIn("测试 fixture 标记", result.get("error", ""))

    def test_deploy_disabled_server_gate(self):
        target = iso_mod._new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(preview["ok"])
        os.environ["STUDIO_DISABLE_PRODUCTION_PUBLISH"] = "1"
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": preview["previewBuildId"],
                "snapshotId": preview["snapshotId"],
                "idempotencyKey": "devmode-000001",
            })
        self.assertEqual(ctx.exception.code, "forbidden")


if __name__ == "__main__":
    unittest.main()
