#!/usr/bin/env python3
"""作者工作台长文分享（studio 路由 + share_publisher 服务层）端到端测试。

覆盖：列表/新建/读取/保存往返、段评锚点剥离、路径安全、
发布任务创建（网页阶段在无 Hugo 环境下降级为失败但不丢任务）、
取消任务、发布状态（QQ 默认关闭）。
"""

from __future__ import annotations

import http.client
import json
import os
import re
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.server as studio_server  # noqa: E402

studio_server.StudioHandler.log_message = lambda *args: None

ANCHOR = re.compile(r"<!--\s*paragraph-id:[\w-]+\s*-->")


class ShareStudioTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-studio-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(Path(self.temp.name) / "share-private")
        self.server = studio_server.create_server(self.root, port=0)
        self.host, self.port = self.server.server_address[:2]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://{self.host}:{self.port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        os.environ.pop("LIDAIJI_SHARE_CONTENT_ROOT", None)
        self.temp.cleanup()

    def _headers(self) -> dict:
        return {
            "Host": f"127.0.0.1:{self.port}",
            "Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={self.server.state.studio_session_token}",
            "X-Studio-Request": "1",
            "X-Studio-CSRF": self.server.state.studio_csrf_token,
            "Content-Type": "application/json",
        }

    def request(self, method: str, path: str, body: dict | None = None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=60)
        payload = json.dumps(body or {}).encode("utf-8") if body is not None else None
        connection.request(method, path, body=payload, headers=self._headers())
        response = connection.getresponse()
        data = response.read().decode("utf-8")
        connection.close()
        return response.status, json.loads(data)

    def get(self, path: str):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=60)
        headers = {
            "Host": f"127.0.0.1:{self.port}",
            "Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={self.server.state.studio_session_token}",
        }
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        data = response.read().decode("utf-8")
        connection.close()
        return response.status, json.loads(data)

    def create_share(self, title="测试分享", author="站主"):
        status, payload = self.request(
            "POST", "/api/share/item/new", {"title": title, "author": author}
        )
        self.assertEqual(status, 200, payload)
        return payload["share"]

    def test_items_list_empty(self):
        status, payload = self.get("/api/share/items")
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"], [])

    def test_new_read_save_roundtrip(self):
        entry = self.create_share()
        path = entry["path"]
        self.assertTrue(entry["draft"])
        status, payload = self.request(
            "POST", "/api/share/item/save",
            {"path": path, "frontMatter": {"title": "测试分享", "author": "站主"}, "body": "第一段正文。\n\n第二段正文。"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["share"]["shareRevision"][: len(entry["shareId"]) + 1], f"{entry['shareId']}@")
        status, read = self.get(f"/api/share/item?path={path}")
        self.assertEqual(status, 200)
        self.assertEqual(read["share"]["body"], "第一段正文。\n\n第二段正文。\n")
        self.assertIsNone(ANCHOR.search(read["share"]["body"]))
        self.assertNotIn("articleId", read["share"]["frontMatter"])

    def test_save_strips_anchors(self):
        entry = self.create_share()
        status, payload = self.request(
            "POST", "/api/share/item/save",
            {
                "path": entry["path"],
                "frontMatter": {"title": "测试分享", "author": "站主"},
                "body": "<!-- paragraph-id:p-aaaaaaaaaaaa -->\n\n正文段落。",
            },
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["anchorsStripped"])
        self.assertIsNone(ANCHOR.search(payload["body"]))

    def test_path_traversal_rejected(self):
        status, payload = self.request(
            "POST", "/api/share/item/save",
            {"path": "../escape/index.md", "frontMatter": {}, "body": "x"},
        )
        self.assertEqual(status, 400)
        self.assertIn("非法", payload["error"]["message"])

    def test_publication_create_and_status(self):
        entry = self.create_share()
        path = entry["path"]
        self.request(
            "POST", "/api/share/item/save",
            {"path": path, "frontMatter": {"title": "测试分享", "author": "站主"}, "body": "正文内容。"},
        )
        status, payload = self.request(
            "POST", "/api/share/publication",
            {
                "path": path,
                "finalText": "摘要\n\n阅读全文：\nhttps://read.example.com/test/",
                "scheduledAt": "2026-08-08T10:00:00+08:00",
            },
        )
        self.assertEqual(status, 200, payload)
        pub = payload["publication"]
        self.assertRegex(pub["publication_id"], r"^pub-[0-9a-f]{12}$")
        self.assertEqual(pub["share_id"], entry["shareId"])
        self.assertEqual(pub["qzone_status"], "scheduled")
        self.assertEqual(pub["idempotency_key"], pub["publication_id"])
        self.assertEqual(pub["canonical_url"], payload["url"])
        self.assertTrue(pub["canonical_url"].startswith("http://localhost:1314/"))
        self.assertTrue(pub["canonical_url"].endswith("/"))
        # 网页阶段：测试环境没有 Hugo，构建降级失败但任务仍保留
        self.assertEqual(pub["web_status"], "failed")
        self.assertIn("web-build-failed", pub["error_code"])

    def test_publication_too_long_rejected(self):
        entry = self.create_share()
        status, payload = self.request(
            "POST", "/api/share/publication",
            {"path": entry["path"], "finalText": "长" * 3000, "scheduledAt": "2026-08-08T10:00:00+08:00"},
        )
        self.assertEqual(status, 400)
        self.assertIn("过长", payload["error"]["message"])

    def test_publication_cancel(self):
        entry = self.create_share()
        _, created = self.request(
            "POST", "/api/share/publication",
            {"path": entry["path"], "finalText": "摘要", "scheduledAt": "2026-08-08T10:00:00+08:00"},
        )
        publication_id = created["publication"]["publication_id"]
        status, payload = self.request("POST", "/api/share/publication/cancel", {"publicationId": publication_id})
        self.assertEqual(status, 200, payload)
        status, _ = self.request("POST", "/api/share/publication/cancel", {"publicationId": publication_id})
        self.assertEqual(status, 400)

    def test_publications_list(self):
        status, payload = self.get("/api/share/publications")
        self.assertEqual(status, 200)
        self.assertIsInstance(payload["publications"], list)

    def test_publish_status_qzone_disabled_by_default(self):
        status, payload = self.get("/api/share/publish-status")
        self.assertEqual(status, 200)
        self.assertFalse(payload["status"]["qzoneEnabled"])

    def test_missing_item_save_rejected(self):
        status, payload = self.request(
            "POST", "/api/share/item/save",
            {"path": "items/sh-20991231-ffffff/index.md", "frontMatter": {}, "body": "x"},
        )
        self.assertEqual(status, 404)

    def test_post_requires_csrf(self):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=30)
        headers = {
            "Host": f"127.0.0.1:{self.port}",
            "Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={self.server.state.studio_session_token}",
            "Content-Type": "application/json",
        }
        connection.request("POST", "/api/share/item/new", json.dumps({"title": "x", "author": "y"}).encode(), headers)
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        connection.close()


if __name__ == "__main__":
    unittest.main()
