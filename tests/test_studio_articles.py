#!/usr/bin/env python3
"""作者工作台文章管理（studio/articles.py + 新路由）的端到端测试。

临时项目骨架：works 文集 + 1 篇、essays 1 篇（含锚点注释的真实格式）。
覆盖：扫描只读、读取分离、事务保存（锚点保留/revision/白名单/备份）、
失败回滚、路径安全、新建文章、搜索、URL 计算、open-page 预览联动。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import http.client
import json
import re
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.articles as studio_articles  # noqa: E402
import studio.server as studio_server  # noqa: E402

studio_server.StudioHandler.log_message = lambda *args: None  # 测试中静默访问日志

ANCHOR = re.compile(r"<!-- paragraph-id:(p-[a-f0-9]{12}) -->")

BODY = """<!-- paragraph-id:p-aaaaaaaaaaaa -->

第一段正文内容，用于工作台文章管理测试。

<!-- paragraph-id:p-bbbbbbbbbbbb -->

第二段正文内容，江湖夜雨十年灯。
"""


def render_markdown(data: dict, body: str) -> str:
    return "---\n" + yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=1000) + "---\n\n" + body


def write_article(root: Path, rel: str, data: dict, body: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_markdown(data, body), encoding="utf-8")
    return path


class StudioArticlesTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-articles-test-")
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "scripts" / "preview.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        works_fm = {
            "title": "测试文章一",
            "subtitle": "副标题",
            "date": "2026-07-01",
            "lastmod": "2026-07-01",
            "slug": "ce-shi-yi",
            "description": "",
            "draft": False,
            "featured": False,
            "weight": 10,
            "collections": ["测试文集"],
            "categories": [],
            "tags": [],
            "series": [],
            "period": [],
            "people": [],
            "places": [],
            "aliases": [],
            "articleId": "article-test0001works",
            "comments": {"paragraph": True},
            "articleRevision": "article-test0001works@000000000000",
            "customNote": "保留我",  # 未知 YAML 键：保存后必须原样保留
        }
        essays_fm = {
            "title": "测试文章二",
            "subtitle": "",
            "date": "2026-07-02",
            "lastmod": "2026-07-02",
            "slug": "ce-shi-er",
            "description": "",
            "draft": True,
            "featured": False,
            "weight": 10,
            "collections": [],
            "categories": [],
            "tags": ["江湖", "夜雨"],
            "series": [],
            "period": [],
            "people": [],
            "places": [],
            "aliases": [],
            "articleId": "article-test0002essay",
            "comments": {"paragraph": True},
            "articleRevision": "article-test0002essay@000000000000",
        }
        self.works_path = write_article(self.root, "content/works/ce-shi-wen-ji/ce-shi-yi/index.md", works_fm, BODY)
        self.essays_path = write_article(self.root, "content/essays/ce-shi-er/index.md", essays_fm, BODY)
        write_article(
            self.root,
            "content/works/ce-shi-wen-ji/_index.md",
            {"title": "测试文集", "description": "", "status": "连载中"},
            "",
        )
        self.works_rel = "content/works/ce-shi-wen-ji/ce-shi-yi/index.md"
        self.essays_rel = "content/essays/ce-shi-er/index.md"
        self.server = studio_server.create_server(self.root, port=0)
        self.host, self.port = self.server.server_address[:2]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.state.preview_process = None  # 防止测试替身进程进入清理逻辑
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    # -- 请求辅助 -----------------------------------------------------------

    def request(self, method: str, path: str, body: bytes = b"", headers: dict | None = None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=30)
        merged = {"Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={self.server.state.studio_session_token}"}
        merged.update(headers or {})
        connection.request(method, path, body, merged)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, payload

    def get_json(self, path: str):
        status, payload = self.request("GET", path)
        return status, json.loads(payload)

    def post_json(self, path: str, payload: dict, headers: dict | None = None):
        merged = {"Content-Type": "application/json", "X-Studio-Request": "1"}
        merged.update(headers or {})
        status, payload = self.request("POST", path, json.dumps(payload).encode("utf-8"), merged)
        return status, json.loads(payload)

    def content_hashes(self):
        result = {}
        for item in sorted((self.root / "content").rglob("*")):
            if item.is_file():
                result[str(item.relative_to(self.root))] = hashlib.sha256(item.read_bytes()).hexdigest()
        return result

    def read_disk(self, rel: str) -> tuple[dict, str]:
        return studio_articles.split_source((self.root / rel).read_text(encoding="utf-8"))

    # -- 测试 ---------------------------------------------------------------

    def test_01扫描字段正确且扫描前后文件不变(self):
        before = self.content_hashes()
        status, payload = self.get_json("/api/articles")
        self.assertEqual(status, 200)
        articles = {item["path"]: item for item in payload["articles"]}
        self.assertEqual(set(articles), {self.works_rel, self.essays_rel})
        works = articles[self.works_rel]
        self.assertEqual(works["title"], "测试文章一")
        self.assertEqual(works["subtitle"], "副标题")
        self.assertEqual(works["section"], "works")
        self.assertEqual(works["collectionSlug"], "ce-shi-wen-ji")
        self.assertEqual(works["collectionTitle"], "测试文集")
        self.assertEqual(works["slug"], "ce-shi-yi")
        self.assertFalse(works["draft"])
        self.assertGreater(works["wordCount"], 0)
        self.assertEqual(works["articleId"], "article-test0001works")
        self.assertEqual(works["missingAnchors"], 0)
        self.assertTrue(articles[self.essays_rel]["draft"])
        self.assertEqual(self.content_hashes(), before)  # 扫描不写盘
        # 搜索同样只读
        status, payload = self.get_json("/api/articles/search?q=" + urllib.parse.quote("江湖"))
        self.assertEqual(status, 200)
        self.assertEqual(self.content_hashes(), before)

    def test_02读取文章完整分离frontmatter与正文(self):
        status, payload = self.get_json(f"/api/article?path={self.works_rel}")
        self.assertEqual(status, 200)
        article = payload["article"]
        self.assertEqual(article["frontMatter"]["title"], "测试文章一")
        self.assertEqual(article["frontMatter"]["articleId"], "article-test0001works")
        self.assertIn("<!-- paragraph-id:p-aaaaaaaaaaaa -->", article["body"])
        self.assertEqual(article["missingAnchors"], 0)
        self.assertEqual(article["url"], "/works/ce-shi-wen-ji/ce-shi-yi/")

    def test_03保存成功且锚点保留白名单生效(self):
        original_bytes = self.essays_path.read_bytes()
        new_body = BODY + "\n第三段是全新内容，保存时应获得新锚点。\n"
        status, payload = self.post_json(
            "/api/article/save",
            {
                "path": self.essays_rel,
                "frontMatter": {
                    "title": "改过的标题",
                    "tags": ["新标签"],
                    "slug": "tampered-slug",  # 白名单外：必须被忽略
                    "articleId": "tampered-id",  # 白名单外：必须被忽略
                },
                "body": new_body,
            },
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["anchors"]["created"], 1)
        self.assertEqual(payload["anchors"]["retained"], 2)
        data, body = self.read_disk(self.essays_rel)
        # 白名单字段生效
        self.assertEqual(data["title"], "改过的标题")
        self.assertEqual(data["tags"], ["新标签"])
        # 白名单外字段保持磁盘原值
        self.assertEqual(data["slug"], "ce-shi-er")
        self.assertEqual(data["articleId"], "article-test0002essay")
        # 未知 YAML 键保留（works 那篇没动；给 essays 也补一个验证）
        self.assertNotIn("customNote", data)
        # 已有锚点逐字节保留，新段落获得新锚点
        self.assertIn("<!-- paragraph-id:p-aaaaaaaaaaaa -->", body)
        self.assertIn("<!-- paragraph-id:p-bbbbbbbbbbbb -->", body)
        anchors = ANCHOR.findall(body)
        self.assertEqual(len(anchors), 3)
        self.assertEqual(len(set(anchors)), 3)
        # articleRevision 与 lastmod 更新
        self.assertTrue(data["articleRevision"].startswith("article-test0002essay@"))
        self.assertNotEqual(data["articleRevision"], "article-test0002essay@000000000000")
        self.assertEqual(str(data["lastmod"]), dt.date.today().isoformat())
        # 返回的稳定化正文与磁盘一致
        self.assertEqual(payload["body"], body)
        # 备份文件生成（内容是保存前的磁盘原文）
        backups = list((self.root / ".cache" / "studio" / "backups" / "essays-ce-shi-er").glob("*-index.md"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original_bytes)
        # works 那篇保存时未知键保留
        status, payload = self.post_json(
            "/api/article/save",
            {"path": self.works_rel, "frontMatter": {"subtitle": "新副标题"}, "body": BODY},
        )
        self.assertEqual(status, 200, payload)
        data, _ = self.read_disk(self.works_rel)
        self.assertEqual(data["customNote"], "保留我")
        self.assertEqual(data["subtitle"], "新副标题")

    def test_04保存失败回滚磁盘原文件不变(self):
        original_bytes = self.essays_path.read_bytes()
        with mock.patch.object(
            studio_articles.tempfile, "mkstemp", side_effect=OSError("模拟磁盘已满")
        ):
            status, payload = self.post_json(
                "/api/article/save",
                {"path": self.essays_rel, "frontMatter": {"title": "不应落盘"}, "body": BODY + "\n新段落。\n"},
            )
        self.assertEqual(status, 500)
        self.assertEqual(self.essays_path.read_bytes(), original_bytes)
        self.assertEqual(list(self.essays_path.parent.glob("*.tmp")), [])
        self.assertEqual(list(self.essays_path.parent.glob(".index-*")), [])

    def test_05路径安全一律拒绝(self):
        bad_paths = [
            "../etc/passwd",
            "content/../../../etc/passwd",
            "/etc/passwd",
            "/tmp/outside/index.md",
            "content/works/ce-shi-wen-ji/_index.md",
            "content/essays/ce-shi-er",
            "content/essays/ce-shi-er/note.md",
            "content/other/ce-shi-er/index.md",
            "",
        ]
        for bad in bad_paths:
            status, payload = self.get_json(f"/api/article?path={bad}")
            self.assertEqual(status, 400, f"应拒绝：{bad}")
            status, payload = self.post_json("/api/article/save", {"path": bad, "frontMatter": {}, "body": "x"})
            self.assertEqual(status, 400, f"保存应拒绝：{bad}")
        # 项目外绝对路径（构造一个真实存在的文件也不放行）
        outside = self.root.parent / "outside-index.md"
        status, _ = self.get_json(f"/api/article?path={outside}")
        self.assertEqual(status, 400)

    def test_06新建文章与冲突校验(self):
        status, payload = self.post_json(
            "/api/article/new",
            {
                "title": "全新篇章",
                "subtitle": "",
                "section": "works",
                "slug": "quan-xin-pian-zhang",
                "collectionSlug": "xin-wen-ji",
                "collectionTitle": "新文集",
            },
        )
        self.assertEqual(status, 200, payload)
        bundle = self.root / "content" / "works" / "xin-wen-ji" / "quan-xin-pian-zhang"
        data, body = self.read_disk("content/works/xin-wen-ji/quan-xin-pian-zhang/index.md")
        self.assertTrue(bundle.is_dir())
        self.assertTrue(data["draft"])  # 新文章默认草稿
        self.assertTrue(data["articleId"])
        self.assertEqual(data["collections"], ["新文集"])
        self.assertIn("volume", data)  # archetype 字段
        self.assertTrue(ANCHOR.search(body))  # 首段有锚点
        self.assertTrue(data["articleRevision"].startswith(f"{data['articleId']}@"))
        collection_data, _ = self.read_disk("content/works/xin-wen-ji/_index.md")
        self.assertEqual(collection_data["title"], "新文集")
        self.assertEqual(collection_data["status"], "连载中")
        # 重复 slug → 409
        status, payload = self.post_json(
            "/api/article/new",
            {
                "title": "再来一次",
                "section": "works",
                "slug": "quan-xin-pian-zhang",
                "collectionSlug": "xin-wen-ji",
            },
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"]["code"], "conflict")
        # 非法 slug → 400
        status, payload = self.post_json(
            "/api/article/new",
            {"title": "坏 slug", "section": "essays", "slug": "Bad Slug"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")
        # 加入既有文集（不必填 collectionTitle）
        status, payload = self.post_json(
            "/api/article/new",
            {"title": "随笔新篇", "section": "essays", "slug": "sui-bi-xin-pian"},
        )
        self.assertEqual(status, 200, payload)
        data, _ = self.read_disk("content/essays/sui-bi-xin-pian/index.md")
        self.assertTrue(data["draft"])

    def test_07搜索命中与snippet(self):
        status, payload = self.get_json("/api/articles/search?q=" + urllib.parse.quote("测试文章一"))
        self.assertEqual(status, 200)
        self.assertEqual([item["path"] for item in payload["results"]], [self.works_rel])
        status, payload = self.get_json("/api/articles/search?q=" + urllib.parse.quote("江湖"))
        self.assertEqual(status, 200)
        paths = {item["path"] for item in payload["results"]}
        self.assertIn(self.essays_rel, paths)
        status, payload = self.get_json("/api/articles/search?q=" + urllib.parse.quote("十年灯"))
        self.assertEqual(status, 200)
        hit = [item for item in payload["results"] if item["path"] == self.essays_rel][0]
        self.assertIn("十年灯", hit["snippet"])
        self.assertNotIn("paragraph-id", hit["snippet"])
        status, payload = self.get_json("/api/articles/search?q=")
        self.assertEqual(status, 200)
        self.assertEqual(payload["results"], [])

    def test_08URL计算两种栏目(self):
        status, payload = self.get_json(f"/api/article?path={self.works_rel}")
        self.assertEqual(payload["article"]["url"], "/works/ce-shi-wen-ji/ce-shi-yi/")
        status, payload = self.get_json(f"/api/article?path={self.essays_rel}")
        self.assertEqual(payload["article"]["url"], "/essays/ce-shi-er/")

    def test_09open_page未启动预览时会启动预览进程(self):
        popen_calls = []
        run_calls = []

        class FakeProcess:
            pid = 2**22  # 不存在的 pid，清理时 killpg 抛 ProcessLookupError 被吞掉

            def poll(self):
                return None

        def fake_popen(args, **kwargs):
            popen_calls.append((args, kwargs))
            return FakeProcess()

        def fake_run(args, **kwargs):
            run_calls.append(args)

            class Result:
                returncode = 0

            return Result()

        with mock.patch.object(studio_server.subprocess, "Popen", side_effect=fake_popen), \
            mock.patch.object(studio_server.subprocess, "run", side_effect=fake_run), \
            mock.patch.object(studio_server, "port_ready", return_value=False), \
            mock.patch.object(studio_server, "wait_for_port", return_value=True):
            status, payload = self.post_json("/api/article/open-page", {"path": self.works_rel})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["url"], "/works/ce-shi-wen-ji/ce-shi-yi/")
        self.assertEqual(len(popen_calls), 1)
        args, kwargs = popen_calls[0]
        self.assertEqual(args, ["bash", "scripts/preview.sh"])
        self.assertTrue(kwargs.get("start_new_session"))
        self.assertEqual(run_calls, [["open", "http://127.0.0.1:1313/works/ce-shi-wen-ji/ce-shi-yi/"]])

    def test_10render接口与保存接口CSRF(self):
        status, payload = self.post_json(
            "/api/render",
            {"markdown": "<!-- paragraph-id:p-aaaaaaaaaaaa -->\n\n**粗体** 普通"},
        )
        self.assertEqual(status, 200)
        self.assertIn("<strong>粗体</strong>", payload["html"])
        self.assertIn('data-paragraph-id="p-aaaaaaaaaaaa"', payload["html"])
        self.assertNotIn("<!-- paragraph-id", payload["html"])
        # 缺自定义头 → 403
        status, _ = self.request(
            "POST",
            "/api/article/save",
            json.dumps({"path": self.essays_rel, "frontMatter": {}, "body": "x"}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)

    def test_11open_folder接受文章路径(self):
        run_calls = []

        def fake_run(args, **kwargs):
            run_calls.append(args)

            class Result:
                returncode = 0

            return Result()

        with mock.patch.object(studio_server.subprocess, "run", side_effect=fake_run):
            status, payload = self.post_json("/api/system/open-folder", {"path": self.essays_rel})
        self.assertEqual(status, 200, payload)
        self.assertEqual(run_calls, [["open", str(self.essays_path.parent.resolve())]])
        # 坏路径仍然被拒
        with mock.patch.object(studio_server.subprocess, "run", side_effect=fake_run):
            status, _ = self.post_json("/api/system/open-folder", {"path": "../../etc"})
        self.assertEqual(status, 400)

    def test_12slug拼音建议(self):
        status, payload = self.get_json("/api/articles/suggest-slug?title=" + urllib.parse.quote("测试文章"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["slug"], "ce-shi-wen-zhang")


if __name__ == "__main__":
    unittest.main(verbosity=2)
