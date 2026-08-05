"""文章级隔离发布测试（v0.2.3）：基线解析、目标快照、隔离候选、无关脏文件、发布。

测试模型：
- 假工作区 = 一个 git 仓库（同时充当内容仓库与平台根；内容路径被
  platform_clean_check 豁免，语义与真实双仓库一致）；
- 线上基线 manifest 由测试生成（LIDAIJI_PUBLISH_MANIFEST_FILE 覆盖）；
- 假 build.sh/publish.sh 可配置成功/失败/产出 manifest；
- 全程不触碰真实发布与真实仓库。
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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from studio import publish_article as pa  # noqa: E402
from studio import publish_isolated as iso  # noqa: E402

# 测试用 manifest 覆盖（模块导入后设置）
_TMP_MANIFEST = Path(tempfile.mkdtemp(prefix="iso-manifest-")) / "manifest.json"
os.environ["LIDAIJI_PUBLISH_MANIFEST_FILE"] = str(_TMP_MANIFEST)
os.environ.setdefault("LIDAIJI_PUBLISH_WORKSPACES_ROOT", str(Path(tempfile.mkdtemp(prefix="iso-workspaces-"))))

ANCHOR_RE = __import__("re").compile(r"<!-- paragraph-id:(p-[a-f0-9]{12}) -->")


def _revision_of(article_id: str, body: str) -> str:
    sys.path.insert(0, str(ROOT / "importer"))
    from paragraph_ids import assign_ids, revision_for  # type: ignore
    stabilized, _ = assign_ids(body, body)
    return revision_for(article_id, stabilized)


def _make_article_file(root: Path, slug: str, body: str, draft: bool, article_id: str | None = None) -> dict:
    today = "2026-08-05"
    article_id = article_id or f"article-{__import__('hashlib').sha256(slug.encode()).hexdigest()[:16]}"
    front = {
        "title": f"文章{slug}", "subtitle": "", "date": today, "lastmod": today, "slug": slug,
        "description": "", "draft": draft, "featured": False, "weight": 10,
        "collections": [], "categories": [], "tags": [], "series": [], "period": [],
        "people": [], "places": [], "aliases": [], "articleId": article_id,
        "comments": {"paragraph": True},
    }
    target = root / "content" / "essays" / slug / "index.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT / "importer"))
    from paragraph_ids import assign_ids, revision_for  # type: ignore
    stabilized, _ = assign_ids(body, body)
    front["articleRevision"] = revision_for(article_id, stabilized)
    markdown = "---\n" + json.dumps(front, ensure_ascii=False, indent=2) + "\n---\n\n" + stabilized
    target.write_text(markdown, encoding="utf-8")
    return {"path": f"content/essays/{slug}/index.md", "frontMatter": front, "body": body, "file": target}


def _git(root: Path, *args):
    return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
                          capture_output=True, text=True, cwd=root, timeout=30)


def _article_manifest_entry(file: Path) -> dict:
    text = file.read_text(encoding="utf-8")
    parts = text.split("---\n", 2)
    fm, body = parts[1], parts[2]
    aid = __import__("re").search(r'"?articleId"?\s*[:=]\s*"?(article-[a-f0-9]{16})', fm).group(1)
    rev = __import__("re").search(r'"?articleRevision"?\s*[:=]\s*"?(article-[a-f0-9]{16}@[0-9a-f]{12})', fm).group(1)
    paragraphs = []
    for i, pid in enumerate(ANCHOR_RE.findall(body)):
        paragraphs.append({"paragraphId": pid, "position": i, "headingContext": "",
                           "excerpt": f"摘录{i}", "checksum": "a" * 64})
    title = __import__("re").search(r'"?title"?\s*[:=]\s*"([^"]+)"', fm).group(1)
    title = __import__("re").search(r'"?title"?\s*[:=]\s*"([^"]+)"', fm).group(1)
    return {"articleId": aid, "revision": rev, "title": title,
            "canonicalPath": f"/essays/{file.parent.name}/", "paragraphComments": "open",
            "sourceChecksum": "b" * 64, "paragraphs": paragraphs}
class IsoWorkspace:
    """假工作区：git 内容仓库 + 平台脚本 + 线上基线 manifest + 假构建/发布。"""

    def __init__(self, fail_publish: bool = False, fail_build: bool = False):
        self.root = Path(tempfile.mkdtemp(prefix="studio-iso-test-"))
        (self.root / "content" / "works").mkdir(parents=True)
        (self.root / "content" / "essays").mkdir(parents=True)
        (self.root / "data" / "author-notes").mkdir(parents=True)
        (self.root / "site-overrides").mkdir(parents=True)
        (self.root / "data" / "author-notes" / ".gitkeep").write_text("", encoding="utf-8")
        (self.root / "site-overrides" / "site.yaml").write_text("title: test\n", encoding="utf-8")
        (self.root / "scripts").mkdir(parents=True)
        (self.root / ".author-settings").write_text(
            "WRITING_SSH_TARGET=test-target\nWRITING_DOMAIN=example.test\n", encoding="utf-8")
        _git(self.root, "init", "-q")
        # 基线文章（已提交 = 线上版本）
        self.baseline_article = _make_article_file(self.root, "baseline-article",
                                                   "基线文章正文第一段。\n\n基线文章正文第二段。", draft=False)
        _git(self.root, "add", "-A")
        _git(self.root, "commit", "-qm", "baseline")
        # 线上基线 manifest（= 已提交状态）
        self.baseline_manifest = {
            "schemaVersion": 1,
            "generatedAt": "2026-08-05T00:00:00.000Z",
            "articles": [_article_manifest_entry(self.baseline_article["file"])],
        }
        _TMP_MANIFEST.write_text(json.dumps(self.baseline_manifest), encoding="utf-8")
        # 假脚本
        if fail_build:
            build = "#!/usr/bin/env bash\necho '构建失败（模拟）' >&2\nexit 1\n"
        else:
            build = "#!/usr/bin/env bash\nexit 0\n"
        (self.root / "scripts" / "build.sh").write_text(build, encoding="utf-8")
        (self.root / "scripts" / "check.sh").write_text(build, encoding="utf-8")
        if fail_publish:
            publish = "#!/usr/bin/env bash\necho '发布失败（模拟）' >&2\nexit 1\n"
        else:
            publish = "#!/usr/bin/env bash\necho 'PUBLISH_OK\\nrelease=/tmp/iso-release-001'\nexit 0\n"
        (self.root / "scripts" / "publish.sh").write_text(publish, encoding="utf-8")
        for script in ("build.sh", "check.sh", "publish.sh"):
            (self.root / "scripts" / script).chmod(0o755)

        _git(self.root, "add", "-A")
        _git(self.root, "commit", "-qm", "scripts")
    def write_candidate_manifest(self, target_article: dict):
        """模拟隔离构建产物 manifest（基线 + 目标文章）。"""
        self.write_candidate_manifest_for(None, target_article)

    def write_candidate_manifest_for(self, _baseline, target_article: dict):
        out = self.root / "dist" / "site"
        out.mkdir(parents=True, exist_ok=True)
        entries = [dict(a) for a in self.baseline_manifest["articles"]]
        entries.append(_article_manifest_entry(target_article["file"]))
        (out / "comment-manifest.json").write_text(
            json.dumps({"schemaVersion": 1, "articles": entries}), encoding="utf-8")

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class FakeState:
    def __init__(self, workspace: IsoWorkspace):
        self.project_root = str(workspace.root)
        self.platform_root = str(workspace.root)
        self.lock = threading.Lock()
        self.workspace_environment = {}
        self.article_preview = None
        self.publish_lock_info = None
        self.article_publish_result = None


def _new_target(ws: IsoWorkspace, slug="iso-target", draft=False, body="目标文章正文第一段。\n\n目标文章正文第二段。") -> dict:
    return _make_article_file(ws.root, slug, body, draft)


class IsoPublishTests(unittest.TestCase):
    def setUp(self):
        self.ws = IsoWorkspace()
        self.state = FakeState(self.ws)

    def tearDown(self):
        self.ws.cleanup()

    # ---- 基线解析 ----

    def test_ISO_BASE_01_正确读取线上发布基线(self):
        baseline = iso.resolve_published_baseline(self.state, "example.test")
        self.assertEqual(baseline["verifiedArticles"], 1)
        self.assertTrue(baseline["privateContentCommit"])

    def test_ISO_BASE_02_基线不一致时拒绝(self):
        # 修改基线文章并提交 → 线上 manifest 仍是旧版本 → 不一致
        baseline_article = self.ws.baseline_article["file"]
        new_body = "改后正文第一段。\n\n改后正文第二段。"
        new_entry = _make_article_file(self.ws.root, "baseline-article", new_body, False,
                                       article_id=self.ws.baseline_article["frontMatter"]["articleId"])
        _git(self.ws.root, "add", "-A")
        _git(self.ws.root, "commit", "-qm", "changed baseline")
        self.ws.baseline_article = new_entry
        with self.assertRaises(iso.IsolationError) as ctx:
            iso.resolve_published_baseline(self.state, "example.test")
        self.assertEqual(ctx.exception.code, "baseline-mismatch")

    def test_ISO_BASE_03_manifest不可达时拒绝(self):
        os.environ["LIDAIJI_PUBLISH_MANIFEST_FILE"] = str(Path(tempfile.mkdtemp()) / "missing.json")
        try:
            with self.assertRaises(iso.IsolationError) as ctx:
                iso.resolve_published_baseline(self.state, "example.test")
            self.assertEqual(ctx.exception.code, "baseline-unavailable")
        finally:
            os.environ["LIDAIJI_PUBLISH_MANIFEST_FILE"] = str(_TMP_MANIFEST)

    # ---- 无关脏文件 ----

    def test_ISO_DIRTY_01_其他文章未提交修改不阻止预览(self):
        target = _new_target(self.ws)
        # 其他文章脏（未提交修改 + 未跟踪新文章）
        other = self.ws.baseline_article["file"]
        other.write_text(other.read_text(encoding="utf-8") + "未提交修改。", encoding="utf-8")
        _make_article_file(self.ws.root, "untracked-article", "未跟踪文章正文。", draft=True)
        self.ws.write_candidate_manifest(target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(result["ok"], [c for c in result["checks"] if c["status"] == "FAIL"])
        self.assertGreater(result["unrelatedDirty"]["count"], 0, "应展示无关脏文件数量（不阻止）")
        dirty = [c for c in result["checks"] if c["name"] == "unrelated-dirty"]
        self.assertTrue(dirty and dirty[0]["status"] == "WARNING")

    def test_ISO_DIRTY_02_平台代码脏修改阻止预览(self):
        target = _new_target(self.ws)
        (self.ws.root / "scripts" / "server-publish.sh").write_text("# 未提交的平台脚本修改", encoding="utf-8")
        result = pa.article_publish_preview(self.state, target["path"])
        names = [c["name"] for c in result["checks"] if c["status"] == "FAIL"]
        self.assertIn("platform-clean", names)

    def test_ISO_DIRTY_03_Hugo配置脏修改阻止预览(self):
        target = _new_target(self.ws)
        (self.ws.root / "config" / "_default").mkdir(parents=True, exist_ok=True)
        (self.ws.root / "config" / "_default" / "hugo.toml").write_text("baseURL = \"https://x\"", encoding="utf-8")
        result = pa.article_publish_preview(self.state, target["path"])
        names = [c["name"] for c in result["checks"] if c["status"] == "FAIL"]
        self.assertIn("platform-clean", names)

    # ---- 目标快照 ----

    def test_ISO_SNAP_01_已保存revision创建快照(self):
        target = _new_target(self.ws)
        snapshot = iso.create_target_snapshot(self.state, target["path"], target["frontMatter"]["articleRevision"])
        self.assertTrue(snapshot["snapshotId"])
        self.assertEqual(snapshot["sourceFileSha256"], sha256_of(target["file"]))

    def test_ISO_SNAP_02_文件与revision不一致拒绝(self):
        target = _new_target(self.ws)
        target["file"].write_text(target["file"].read_text(encoding="utf-8") + "新内容", encoding="utf-8")
        with self.assertRaises(iso.IsolationError) as ctx:
            iso.create_target_snapshot(self.state, target["path"], target["frontMatter"]["articleRevision"])
        self.assertEqual(ctx.exception.code, "conflict")

    def test_ISO_SNAP_03_路径穿越与符号链接拒绝(self):
        with self.assertRaises(iso.IsolationError):
            iso._resolve_target(self.state, "content/../../etc/passwd")
        target = _new_target(self.ws)
        link = target["file"].parent / "evil-link"
        link.symlink_to("/tmp")
        try:
            with self.assertRaises(iso.IsolationError) as ctx:
                iso._resolve_target(self.state, target["path"])
            self.assertEqual(ctx.exception.code, "validation-failed")
        finally:
            link.unlink(missing_ok=True)

    # ---- 资源 ----

    def test_ISO_ASSET_01_引用图片纳入_未引用不纳入(self):
        target = _new_target(self.ws, body="目标文章正文。\n\n![图](images/used.png)")
        img_dir = target["file"].parent / "images"
        img_dir.mkdir(exist_ok=True)
        (img_dir / "used.png").write_bytes(b"PNGDATA")
        (img_dir / "unused.png").write_bytes(b"PNGDATA2")
        snapshot = iso.create_target_snapshot(self.state, target["path"], target["frontMatter"]["articleRevision"])
        self.assertEqual([e["relativePath"] for e in snapshot["assetManifest"]["entries"]], ["images/used.png"])
        self.assertIn("images/unused.png", snapshot["assetManifest"]["unreferenced"])

    def test_ISO_ASSET_02_资源变化阻止(self):
        target = _new_target(self.ws, body="目标文章正文。\n\n![图](images/used.png)")
        img_dir = target["file"].parent / "images"
        img_dir.mkdir(exist_ok=True)
        img = img_dir / "used.png"
        img.write_bytes(b"PNGDATA")
        snapshot = iso.create_target_snapshot(self.state, target["path"], target["frontMatter"]["articleRevision"])
        img.write_bytes(b"CHANGED")
        with self.assertRaises(iso.IsolationError) as ctx:
            iso.build_merged_content(self.state, iso._resolve_target(self.state, target["path"]), snapshot)
        self.assertEqual(ctx.exception.code, "conflict")

    # ---- 隔离候选 ----

    def test_ISO_DIFF_01_只变化目标文章(self):
        target = _new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(result["ok"], [c for c in result["checks"] if c["status"] == "FAIL"])
        self.assertEqual(result["candidate"]["unrelatedChangedCount"], 0)
        self.assertTrue(result["candidate"]["targetPresent"])

    def test_ISO_DIFF_02_无关文章差异立即FAIL(self):
        target = _new_target(self.ws)
        # 候选 manifest 中基线文章被改成别的 revision（模拟隔离构建混入无关变化）
        self.ws.write_candidate_manifest(target)
        manifest_path = self.ws.root / "dist" / "site" / "comment-manifest.json"
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        data["articles"][0]["revision"] = data["articles"][0]["revision"][:-1] + "0"
        manifest_path.write_text(json.dumps(data), encoding="utf-8")
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertFalse(result["ok"])
        names = [c["name"] for c in result["checks"] if c["status"] == "FAIL"]
        self.assertIn("candidate-diff", names)

    # ---- 发布 ----

    def test_ISO_PUB_01_无关文章脏时目标文章可预览与发布(self):
        target = _new_target(self.ws)
        other = self.ws.baseline_article["file"]
        other.write_text(other.read_text(encoding="utf-8") + "未提交修改。", encoding="utf-8")
        self.ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(preview["ok"], preview["checks"])
        snapshot_id = preview["snapshotId"]
        task = pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "snapshotId": snapshot_id,
            "idempotencyKey": "iso-pub-00000001",
        })
        self.assertTrue(task["ok"])
        deadline = time.time() + 15
        while time.time() < deadline:
            status = pa.article_publish_status(self.state, target["path"])
            if not (status["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        result = pa.article_publish_status(self.state, target["path"])["result"]
        self.assertTrue(result and result["ok"], result)
        self.assertEqual(pa.article_publish_status(self.state, target["path"])["publishedRevision"],
                         target["frontMatter"]["articleRevision"])

    def test_ISO_PUB_02_发布后无关工作区diff不变(self):
        target = _new_target(self.ws)
        other = self.ws.baseline_article["file"]
        other.write_text(other.read_text(encoding="utf-8") + "未提交修改。", encoding="utf-8")
        before_bytes = other.read_bytes()
        self.ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(self.state, target["path"])
        pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "snapshotId": preview["snapshotId"],
            "idempotencyKey": "iso-pub-00000002",
        })
        deadline = time.time() + 15
        while time.time() < deadline:
            status = pa.article_publish_status(self.state, target["path"])
            if not (status["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        self.assertEqual(other.read_bytes(), before_bytes, "无关文件字节不得因发布改变")
        diff_before = _git(self.ws.root, "diff", "--stat").stdout
        self.assertIn("baseline-article", diff_before)

    def test_ISO_PUB_03_幂等键不重复发布(self):
        target = _new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(self.state, target["path"])
        key = "iso-pub-00000003"
        pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "snapshotId": preview["snapshotId"],
            "idempotencyKey": key,
        })
        deadline = time.time() + 15
        while time.time() < deadline:
            if not (pa.article_publish_status(self.state, target["path"])["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        duplicate = pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": "x" * 20,
            "snapshotId": "x" * 20,
            "idempotencyKey": key,
        })
        self.assertTrue(duplicate.get("duplicated"))
        entries = pa.read_ledger(self.ws.root)
        self.assertEqual(sum(1 for e in entries if e.get("idempotencyKey") == key), 1)

    def test_ISO_PUB_04_平台脏时发布拒绝(self):
        target = _new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(self.state, target["path"])
        (self.ws.root / "scripts" / "server-publish.sh").write_text("# 脏", encoding="utf-8")
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": preview["previewBuildId"],
                "snapshotId": preview["snapshotId"],
                "idempotencyKey": "iso-pub-00000004",
            })
        self.assertEqual(ctx.exception.code, "conflict")

    def test_ISO_PUB_05_发布失败记录与锁释放(self):
        fail_ws = IsoWorkspace(fail_publish=True)
        fail_state = FakeState(fail_ws)
        target = _new_target(fail_ws)
        fail_ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(fail_state, target["path"])
        self.assertTrue(preview["ok"], preview["checks"])
        pa.article_publish(fail_state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": preview["previewBuildId"],
            "snapshotId": preview["snapshotId"],
            "idempotencyKey": "iso-pub-00000005",
        })
        deadline = time.time() + 15
        while time.time() < deadline:
            status = pa.article_publish_status(fail_state, target["path"])
            if not (status["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        result = pa.article_publish_status(fail_state, target["path"])["result"]
        self.assertTrue(result and not result["ok"])
        entries = pa.read_ledger(fail_ws.root)
        self.assertEqual(entries[-1]["status"], "failed_publish")
        fail_ws.cleanup()

    def test_ISO_PUB_06_发布中修改目标文章不混入当前快照(self):
        target = _new_target(self.ws)
        self.ws.write_candidate_manifest(target)
        preview = pa.article_publish_preview(self.state, target["path"])
        snapshot_id = preview["snapshotId"]
        # 预览后修改目标文章 → 快照校验失败，发布被拒
        target["file"].write_text(target["file"].read_text(encoding="utf-8") + "修改", encoding="utf-8")
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": preview["previewBuildId"],
                "snapshotId": snapshot_id,
                "idempotencyKey": "iso-pub-00000006",
            })
        self.assertEqual(ctx.exception.code, "conflict")


def sha256_of(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()


class WorksPathTests(unittest.TestCase):
    """works 文章（含文集层级）路径回归：content/works/<文集>/<slug>/index.md。"""

    def setUp(self):
        self.ws = IsoWorkspace()
        self.state = FakeState(self.ws)

    def tearDown(self):
        self.ws.cleanup()

    def _make_works_article(self, slug="kao-shi-ji-qi", body="作品正文第一段。\n\n作品正文第二段。"):
        target_dir = self.ws.root / "content" / "works" / "lidai-ji" / slug
        target_dir.mkdir(parents=True, exist_ok=True)
        article_id = f"article-{__import__('hashlib').sha256(slug.encode()).hexdigest()[:16]}"
        front = {
            "title": f"作品{slug}", "subtitle": "", "date": "2026-08-05", "lastmod": "2026-08-05",
            "slug": slug, "description": "", "draft": False, "featured": False, "weight": 10,
            "collections": ["历代纪"], "categories": [], "tags": [], "series": ["历代纪"],
            "period": [], "people": [], "places": [], "aliases": [], "articleId": article_id,
            "comments": {"paragraph": True},
        }
        import sys as _sys
        _sys.path.insert(0, str(ROOT / "importer"))
        from paragraph_ids import assign_ids, revision_for  # type: ignore
        stabilized, _ = assign_ids(body, body)
        front["articleRevision"] = revision_for(article_id, stabilized)
        index = target_dir / "index.md"
        index.write_text("---\n" + json.dumps(front, ensure_ascii=False, indent=2) + "\n---\n\n" + stabilized, encoding="utf-8")
        return {"path": f"content/works/lidai-ji/{slug}/index.md", "frontMatter": front,
                "body": stabilized, "file": index}

    def test_ISO_WORKS_01_works文章可快照与隔离预览(self):
        target = self._make_works_article()
        snapshot = iso.create_target_snapshot(self.state, target["path"], target["frontMatter"]["articleRevision"])
        self.assertTrue(snapshot["snapshotId"])
        resolved = iso._resolve_target(self.state, target["path"])
        self.assertEqual(resolved["relBundlePath"], "content/works/lidai-ji/kao-shi-ji-qi")
        self.ws.write_candidate_manifest_for(self.ws.baseline_article, target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(result["ok"], [c for c in result["checks"] if c["status"] == "FAIL"])
        self.assertEqual(result["canonicalUrl"], "/works/lidai-ji/kao-shi-ji-qi/")

    def test_ISO_WORKS_02_隔离合并保留文集层级(self):
        target = self._make_works_article()
        snapshot = iso.create_target_snapshot(self.state, target["path"], target["frontMatter"]["articleRevision"])
        merged = iso.build_merged_content(self.state, iso._resolve_target(self.state, target["path"]), snapshot)
        try:
            overlaid = merged["contentRoot"] / "works" / "lidai-ji" / "kao-shi-ji-qi" / "index.md"
            self.assertTrue(overlaid.is_file(), "works文章必须覆盖到文集层级路径")
            self.assertEqual(hashlib256(overlaid), snapshot["sourceFileSha256"])
        finally:
            iso.cleanup_merged_content(merged)


def hashlib256(path):
    import hashlib
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class LargeRetireGateTests(unittest.TestCase):
    """大规模段落失效门禁：线上锚点集 vs 目标快照差异 > 100 时 gate-only 预览+显式确认。"""

    def setUp(self):
        self.ws = IsoWorkspace()
        self.state = FakeState(self.ws)

    def tearDown(self):
        self.ws.cleanup()

    def _online_manifest_with_many_paragraphs(self):
        """构造线上状态：目标文章已提交（线上revision），线上段落集为120个旧锚点。"""
        target = _make_article_file(self.ws.root, "gate-target", "线上版本正文第一段。\n\n线上版本正文第二段。", False)
        _git(self.ws.root, "add", "-A")
        _git(self.ws.root, "commit", "-qm", "gate target online")
        self.committed_target = target
        entry = _article_manifest_entry(target["file"])
        entry["paragraphs"] = [
            {"paragraphId": f"p-{i:012d}", "position": i, "headingContext": "",
             "excerpt": f"e{i}", "checksum": "a" * 64}
            for i in range(120)
        ]
        manifest = {"schemaVersion": 1, "articles": [dict(a) for a in self.ws.baseline_manifest["articles"]]}
        manifest["articles"].append(entry)
        _TMP_MANIFEST.write_text(json.dumps(manifest), encoding="utf-8")
        # 作者保存新版本（revision 变化，段落大幅调整）
        updated = _make_article_file(self.ws.root, "gate-target", "新版正文第一段。\n\n新版正文第二段。", False,
                                     article_id=target["frontMatter"]["articleId"])
        return updated

    def test_ISO_GATE_01_线上锚点集对比触发门禁且可显式确认发布(self):
        target = self._online_manifest_with_many_paragraphs()
        self.ws.write_candidate_manifest(target)
        result = pa.article_publish_preview(self.state, target["path"])
        self.assertFalse(result["ok"])
        self.assertTrue(result["gateOnly"], "仅门禁FAIL时应允许继续到确认")
        self.assertGreater(result["anchor"]["deleted"], 100)
        # 未确认 → 拒绝
        with self.assertRaises(pa.ArticlePublishError) as ctx:
            pa.article_publish(self.state, target["path"], {
                "draftRevision": target["frontMatter"]["articleRevision"],
                "previewBuildId": result["previewBuildId"],
                "snapshotId": result["snapshotId"],
                "idempotencyKey": "gate-0000000001",
            })
        self.assertEqual(ctx.exception.code, "confirmation-required")
        # 显式确认 → 允许发布（env 放行由 work() 设置）
        self.state.article_preview = None
        re_preview = pa.article_publish_preview(self.state, target["path"])
        self.assertTrue(re_preview["gateOnly"])
        task = pa.article_publish(self.state, target["path"], {
            "draftRevision": target["frontMatter"]["articleRevision"],
            "previewBuildId": re_preview["previewBuildId"],
            "snapshotId": re_preview["snapshotId"],
            "idempotencyKey": "gate-0000000002",
            "allowLargeRetire": True,
        })
        self.assertTrue(task["ok"])
        deadline = time.time() + 15
        while time.time() < deadline:
            status = pa.article_publish_status(self.state, target["path"])
            if not (status["lock"] or {}).get("inFlight"):
                break
            time.sleep(0.1)
        result2 = pa.article_publish_status(self.state, target["path"])["result"]
        self.assertTrue(result2 and result2["ok"], result2)

class PublishScriptForwardingTests(unittest.TestCase):
    """发布确认标志必须完整传递到服务器端 sync-manifest。"""

    def test_publish_sh_forwards_allow_large_retire(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "publish.sh"
        text = script.read_text(encoding="utf-8")
        self.assertIn("--allow-large-retire", text)
        self.assertIn('${COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE:+--allow-large-retire}', text)

    def test_server_publish_script_exports_flag_before_sync_manifest(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "server-publish.sh"
        text = script.read_text(encoding="utf-8")
        self.assertIn("--allow-large-retire) ALLOW_LARGE_RETIRE=1", text)
        sync = text.index("sync-manifest")
        self.assertIn("export COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE=1", text[:sync])
        self.assertLess(text.index("export COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE=1"), sync)

    def test_iso_publish_thread_sets_env_when_confirmed(self):
        source = Path(__file__).resolve().parents[1] / "studio" / "publish_article.py"
        text = source.read_text(encoding="utf-8")
        self.assertIn('iso_env["COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE"] = "1"', text)
        self.assertIn("if allow_large_retire:", text)

    def test_center_propagates_workspace_environment_to_publish(self):
        source = Path(__file__).resolve().parents[1] / "studio" / "publish_center.py"
        text = source.read_text(encoding="utf-8")
        self.assertIn("env.update(workspace_environment or {})", text)


if __name__ == "__main__":
    unittest.main()

class PublishLogPersistenceTests(unittest.TestCase):
    """发布完整日志持久化与下载标识校验。"""

    def test_log_id_format_rejects_unsafe_input(self):
        self.assertTrue(pa._PUBLISH_LOG_ID_RE.match("pub_1a2b3c4d5e6f"))
        self.assertIsNone(pa._PUBLISH_LOG_ID_RE.match("pub_../../etc/passwd"))
        self.assertIsNone(pa._PUBLISH_LOG_ID_RE.match("../pub_1a2b3c4d5e6f"))
        self.assertIsNone(pa._PUBLISH_LOG_ID_RE.match("pub_1a2b3c4d5e6f/../x"))
        self.assertIsNone(pa._PUBLISH_LOG_ID_RE.match("pub_1a2b3c4d5e6f.log"))
        self.assertIsNone(pa._PUBLISH_LOG_ID_RE.match(""))

    def test_persist_publish_log_writes_file_and_returns_url(self):
        with tempfile.TemporaryDirectory() as root:
            url = pa._persist_publish_log(root, "pub_1a2b3c4d5e6f", "line1\nline2\n")
            self.assertEqual(url, "/api/article/publish-log?id=pub_1a2b3c4d5e6f")
            log_path = Path(root) / ".cache" / "studio" / "publish-logs" / "pub_1a2b3c4d5e6f.log"
            self.assertEqual(log_path.read_text(encoding="utf-8"), "line1\nline2\n")

    def test_persist_publish_log_empty_output_skips(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(pa._persist_publish_log(root, "pub_1a2b3c4d5e6f", ""), "")
            self.assertFalse((Path(root) / ".cache" / "studio" / "publish-logs").exists())


if __name__ == "__main__":
    unittest.main()
