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
        # C 的作者评（私人）
        (self.root / "data" / "author-notes" /
         f"{self.article_c['frontMatter']['articleId']}-notes.yaml").write_text(
            "id: n-c\nstatus: published\nbody: 私人作者评正文。\n", encoding="utf-8")
        # A（公开 baseline-article）的公开作者评
        (self.root / "data" / "author-notes" /
         f"{self.baseline_article['frontMatter']['articleId']}-notes.yaml").write_text(
            "id: n-a\nstatus: published\nbody: 公开作者评正文。\n", encoding="utf-8")
        # 状态缺失的作者评（文件名不含任何 articleId）
        (self.root / "data" / "author-notes" / "notes-2026.yaml").write_text(
            "id: n-x\nstatus: published\nbody: 状态缺失作者评正文。\n", encoding="utf-8")
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
            notes = [n.name for n in merged["authorNotesRoot"].glob("*.yaml")]
            public_id = self.ws.baseline_article["frontMatter"]["articleId"]
            self.assertEqual(notes, [f"{public_id}-notes.yaml"])  # 仅公开评进入；C/状态缺失/伪造评不进
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

    def _preview_for(self, slug, body="测试正文第一段。\n\n第二段。"):
        target = iso_mod._make_article_file(self.ws.root, slug, body, False)
        self.ws.write_candidate_manifest(target)
        page = self.ws.root / "dist" / "site" / "essays" / slug
        page.mkdir(parents=True, exist_ok=True)
        (page / "index.html").write_text(f"<h1>{slug}</h1>", encoding="utf-8")
        return target, pa.article_publish_preview(self.state, target["path"])

    def _publish_and_wait(self, target, preview, key):
        pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "snapshotId": preview["snapshotId"],
            "idempotencyKey": key,
        })
        deadline = time.time() + 30
        while time.time() < deadline and not (self.state.article_publish_result or {}).get("ok") is not None \
                and not (self.state.article_publish_result or {}).get("error"):
            time.sleep(0.2)
        return self.state.article_publish_result or {}

    def test_legal_slugs_not_blocked(self):
        """五个合法 slug 无显式测试身份时可通过生产门禁（slug 启发式已移除）。"""
        for slug in ("acc-history", "iso-standard", "ce-shi-ren-sheng",
                     "layout-testimony", "fixture-of-memory"):
            target, preview = self._preview_for(slug)
            self.assertTrue(preview["ok"], f"{slug} 预览应成功：{preview.get('checks')}")
            self.assertEqual(preview["candidate"]["buildMode"], "production")
            checks = {c["name"]: c["status"] for c in preview["checks"]}
            self.assertEqual(checks.get("build-mode"), "PASS")
            self.assertNotIn("test-marker", checks)  # 无 slug 门禁检查

    def test_normal_slug_test_candidate_rejected_by_identity(self):
        """普通 slug 测试候选（显式身份 buildMode=test）→ 正式发布拒绝。"""
        os.environ["LIDAIJI_TEST_MODE"] = "1"
        os.environ["LIDAIJI_TEST_RUN_ID"] = "audit-run-1"
        try:
            target, preview = self._preview_for("my-life-story")
            self.assertTrue(preview["ok"])
            self.assertEqual(preview["candidate"]["buildMode"], "test")
            result = self._publish_and_wait(target, preview, "identity-gate-01")
            self.assertFalse(result.get("ok"))
            self.assertIn("测试候选禁止正式发布", result.get("error", ""))
            self.assertIn("audit-run-1", result.get("error", ""))
        finally:
            os.environ.pop("LIDAIJI_TEST_MODE", None)
            os.environ.pop("LIDAIJI_TEST_RUN_ID", None)

    def test_request_params_cannot_forge_test_identity(self):
        """浏览器请求参数 fixture=true/buildMode=test 不能伪造测试身份。"""
        target = iso_mod._make_article_file(self.ws.root, "chapter-one",
                                            "正文第一段。\n\n第二段。", False)
        self.ws.write_candidate_manifest(target)
        page = self.ws.root / "dist" / "site" / "essays" / "chapter-one"
        page.mkdir(parents=True, exist_ok=True)
        (page / "index.html").write_text("<h1>chapter-one</h1>", encoding="utf-8")
        preview = pa.article_publish_preview(self.state, target["path"])
        # 服务端状态存 identity；预览函数不接受请求参数——直接断言候选身份恒为 production
        identity = cm.load_candidate_manifest(self.ws.root, preview["candidate"]["candidateId"])["testIdentity"]
        self.assertEqual(identity["buildMode"], "production")
        self.assertFalse(identity["fixture"])
        # 请求参数被忽略（publish 载荷中的伪造字段不改变身份）
        self.assertNotIn("fixture", pa.article_publish.__code__.co_varnames)

    def test_identity_tampering_breaks_verification(self):
        """删除测试身份 / 把 test 改 production / 复制候选重写 manifest 均破坏完整性。"""
        os.environ["LIDAIJI_TEST_MODE"] = "1"
        try:
            target, preview = self._preview_for("winter-notes")
            self.assertEqual(preview["candidate"]["buildMode"], "test")
            candidate_dir = cm._candidates_root(self.ws.root) / preview["candidate"]["candidateId"]
            manifest_path = candidate_dir / "candidate-manifest.json"
            # 删除身份
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            del manifest["testIdentity"]
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            violations = cm.verify_candidate(candidate_dir, manifest)
            self.assertTrue(any("testIdentity 缺失" in v for v in violations))
            baseline = self.baseline_for(target)
            snapshot = self.snapshot_for(target)
            # 把 test 改成 production（改回再测）
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["testIdentity"] = {"buildMode": "production", "fixture": False}
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            violations = cm.verify_candidate(candidate_dir, manifest, baseline, snapshot)
            self.assertTrue(any("manifestSha256 不匹配" in v for v in violations))
            self.assertTrue(any("candidateId 与内容不匹配" in v for v in violations))
            # 复制候选文件后重写 manifest → 复用路径拒绝（identity 参与 candidateId）
            with self.assertRaises(cm.CandidateError):
                cm.materialize_candidate(self.ws.root, self.ws.root / "dist" / "site",
                                         self.baseline_for(target), self.snapshot_for(target),
                                         "/essays/winter-notes/",
                                         test_identity=cm.build_test_identity())
        finally:
            os.environ.pop("LIDAIJI_TEST_MODE", None)

    def baseline_for(self, target):
        return iso.resolve_published_baseline(self.state, "example.test")

    def snapshot_for(self, target):
        return iso.create_target_snapshot(self.state, target["path"],
                                          target["frontMatter"]["articleRevision"])

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


class PublicNotesBaselineTests(unittest.TestCase):
    """公开作者评正向/排除/保留测试（虚构夹具）。"""

    def setUp(self):
        self.ws = PublicBaselineWorkspace()
        self.state = iso_mod.FakeState(self.ws)
        self.baseline = iso.resolve_published_baseline(self.state, "example.test")

    def tearDown(self):
        self.ws.cleanup()

    def test_public_notes_enter_isolated_baseline(self):
        target = iso_mod._new_target(self.ws)
        snapshot = iso.create_target_snapshot(self.state, target["path"],
                                              target["frontMatter"]["articleRevision"])
        merged = iso.build_merged_content(self.state, iso._resolve_target(self.state, target["path"]),
                                          snapshot, self.baseline)
        try:
            notes = {n.name for n in merged["authorNotesRoot"].glob("*.yaml")}
            public_id = self.ws.baseline_article["frontMatter"]["articleId"]
            self.assertIn(f"{public_id}-notes.yaml", notes)  # 公开作者评进入可信基线
            self.assertNotIn("notes-2026.yaml", notes)       # 状态缺失评默认排除
            self.assertNotIn(f"{self.ws.article_c['frontMatter']['articleId']}-notes.yaml", notes)
        finally:
            iso.cleanup_merged_content(merged)

    def test_unrelated_public_note_kept_when_publishing_other_article(self):
        target = iso_mod._new_target(self.ws)
        snapshot = iso.create_target_snapshot(self.state, target["path"],
                                              target["frontMatter"]["articleRevision"])
        merged = iso.build_merged_content(self.state, iso._resolve_target(self.state, target["path"]),
                                          snapshot, self.baseline)
        try:
            notes = {n.name for n in merged["authorNotesRoot"].glob("*.yaml")}
            public_id = self.ws.baseline_article["frontMatter"]["articleId"]
            self.assertIn(f"{public_id}-notes.yaml", notes)  # 无关公开评不被遗漏/不被工作区版本覆盖
            content = (merged["authorNotesRoot"] / f"{public_id}-notes.yaml").read_text(encoding="utf-8")
            self.assertIn("公开作者评正文", content)
        finally:
            iso.cleanup_merged_content(merged)

    def test_forged_and_status_missing_notes_excluded(self):
        # 伪造：把私人 C 的评改名为普通名（仍不含公开 id）→ 不进入
        (self.ws.root / "data" / "author-notes" / "notes-2026.yaml").write_text(
            "id: n-x\nstatus: published\nbody: 伪造作者评正文。\n", encoding="utf-8")
        target = iso_mod._new_target(self.ws)
        snapshot = iso.create_target_snapshot(self.state, target["path"],
                                              target["frontMatter"]["articleRevision"])
        merged = iso.build_merged_content(self.state, iso._resolve_target(self.state, target["path"]),
                                          snapshot, self.baseline)
        try:
            notes = {n.name for n in merged["authorNotesRoot"].glob("*.yaml")}
            self.assertNotIn("notes-2026.yaml", notes)
            # 伪造的 D：工作区元数据（正文/标题）不能把非公开评带入基线
            combined = "".join(n.read_text(encoding="utf-8") for n in merged["authorNotesRoot"].glob("*.yaml"))
            self.assertNotIn("伪造作者评正文", combined)
            self.assertNotIn("私人作者评正文", combined)
        finally:
            iso.cleanup_merged_content(merged)

    def test_notes_body_not_in_logs_and_not_in_candidate(self):
        target = iso_mod._new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(result["ok"], result["checks"])
        output = result.get("buildOutput") or ""
        self.assertNotIn("公开作者评正文", output)
        self.assertNotIn("私人作者评正文", output)
        self.assertNotIn("状态缺失作者评正文", output)
        manifest = cm.load_candidate_manifest(self.ws.root, result["candidate"]["candidateId"])
        paths = "\n".join(f["path"] for f in manifest["files"])
        self.assertNotIn("notes.yaml", paths)
        self.assertNotIn("author-notes", paths)


class SweepFailureLogTests(unittest.TestCase):
    """候选清理失败安全日志。"""

    def setUp(self):
        self.ws = iso_mod.IsoWorkspace()
        self.state = iso_mod.FakeState(self.ws)
        # 每个测试独立工作区根（避免共享候选根互相污染）
        self._prev_workspace_root = os.environ.get("LIDAIJI_PUBLISH_WORKSPACES_ROOT", "")
        self._ws_root = Path(tempfile.mkdtemp(prefix="sweep-root-"))
        os.environ["LIDAIJI_PUBLISH_WORKSPACES_ROOT"] = str(self._ws_root)
        self.root = cm._candidates_root(self.ws.root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log_path = self.ws.root / ".cache" / "studio" / "publish-logs" / "sweep-failures.log"
        self._old_created = "2026-07-20T00:00:00+0800"  # 30+ 天前（必过期）

    def _make_candidate(self, cid, files=None, blocked=False, created=None):
        node = self.root / cid
        (node / "site").mkdir(parents=True)
        (node / "site" / "index.html").write_text("x", encoding="utf-8")
        identity = {"buildMode": "test" if blocked else "production", "fixture": blocked}
        manifest = {
            "schemaVersion": 1, "candidateId": cid, "baselineId": "b", "snapshotId": "s",
            "targetArticleId": "a", "targetSlug": "s", "builderVersion": "candidate-manifest-1",
            "testIdentity": identity,
            "runtime": {"createdAt": created or self._old_created, "previewBuildId": "", "targetUrlPrefix": "/x/"},
            "files": [{"path": "index.html", "size": 1, "sha256": "d", "classification": "derived-index"}],
            "unclassifiedCount": 0, "reproducible": True,
        }
        (node / "candidate-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        return node

    def tearDown(self):
        import subprocess as _sp
        for node in self.root.glob("cand_*"):
            for f in node.rglob("*"):
                try:
                    _sp.run(["chflags", "nouchg", str(f)], capture_output=True)
                except Exception:
                    pass
        self.ws.cleanup()
        if self._prev_workspace_root:
            os.environ["LIDAIJI_PUBLISH_WORKSPACES_ROOT"] = self._prev_workspace_root
        else:
            os.environ.pop("LIDAIJI_PUBLISH_WORKSPACES_ROOT", None)
        shutil.rmtree(self._ws_root, ignore_errors=True)

    def test_failure_logged_redacted_and_retried(self):
        old = self._make_candidate("cand_" + "a" * 20)
        # 制造不可删文件（chflags uchg，macOS 只读标志）
        blocker = old / "site" / "blocked.html"
        blocker.write_text("body", encoding="utf-8")
        subprocess.run(["chflags", "uchg", str(blocker)], check=True, capture_output=True)
        keep = self._make_candidate("cand_" + "b" * 20)
        result = cm.sweep_candidates(self.ws.root, keep_id="cand_" + "b" * 20)
        self.assertIn("cand_" + "a" * 20, result["failed"][0])
        self.assertTrue(self.log_path.is_file())
        entry = json.loads(self.log_path.read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(entry["candidateId"], "cand_" + "a" * 20)
        self.assertIn(entry["stage"], ("remove", "evaluate"))
        self.assertTrue(entry["message"])
        raw = self.log_path.read_text(encoding="utf-8")
        self.assertNotIn("body", raw)          # 不记录文件内容
        self.assertNotIn(self.ws.root.as_posix(), raw)  # 不记录绝对路径
        # 正在使用候选保留
        self.assertTrue((self.root / ("cand_" + "b" * 20)).exists())
        # 解除只读 → 下次清理重试成功
        subprocess.run(["chflags", "nouchg", str(blocker)], check=True, capture_output=True)
        result2 = cm.sweep_candidates(self.ws.root, keep_id="cand_" + "b" * 20)
        self.assertFalse((self.root / ("cand_" + "a" * 20)).exists())
        self.assertTrue(any("cand_" + "a" * 20 in r for r in result2["removed"]))  # 含 repair 后缀

    def test_symlink_candidate_not_followed(self):
        target = self.ws.root / "outside-dir"
        target.mkdir()
        (target / "keep.txt").write_text("keep", encoding="utf-8")
        os.symlink(target, self.root / ("cand_" + "c" * 20))
        result = cm.sweep_candidates(self.ws.root)
        self.assertTrue(result["failed"])  # rmtree 对符号链接报错 → 记录
        self.assertTrue((target / "keep.txt").is_file())  # 未跟随删除
        self.assertTrue(self.log_path.is_file())

    def test_log_dir_unwritable_no_crash(self):
        self._make_candidate("cand_" + "d" * 20)
        log_dir = self.log_path.parent
        log_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(log_dir, 0o000)
        try:
            result = cm.sweep_candidates(self.ws.root)  # 不应崩溃
            self.assertIsInstance(result, dict)
        finally:
            os.chmod(log_dir, 0o700)

    def test_failure_summary_discoverable_in_status(self):
        self._make_candidate("cand_" + "e" * 20)
        blocker = self.root / ("cand_" + "e" * 20) / "site" / "index.html"
        subprocess.run(["chflags", "uchg", str(blocker)], check=True, capture_output=True)
        cm.sweep_candidates(self.ws.root)
        target = iso_mod._new_target(self.ws)
        status = pa.article_publish_status(self.state, target["path"])
        sweep = status.get("candidateSweep") or {}
        self.assertGreaterEqual(sweep.get("count", 0), 1)
        self.assertEqual(sweep["recent"][-1]["candidateId"], "cand_" + "e" * 20)
