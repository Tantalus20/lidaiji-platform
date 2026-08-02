#!/usr/bin/env python3
"""作者工作台第三阶段：媒体库（studio/media.py + 新路由）端到端测试。

临时项目骨架：两篇随笔，一篇带已引用图片 + images/original 原图。
覆盖：扫描（original 标记）、上传成功（image-NN + 原图副本 + markdown）、
伪装/超大/非法格式拒绝、路径穿越拒绝、被引用删除拒绝、回收站删除、
图片字节接口、CSRF 回归。
"""

from __future__ import annotations

import http.client
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.media as studio_media  # noqa: E402
import studio.server as studio_server  # noqa: E402

studio_server.StudioHandler.log_message = lambda *args: None  # 测试中静默访问日志

BOUNDARY = "----studio-media-test"

ARTICLE_A = "content/essays/ce-shi-a/index.md"
ARTICLE_B = "content/essays/ce-shi-b/index.md"

ARTICLE_TEMPLATE = """---
title: {title}
slug: {slug}
date: 2026-07-01
draft: true
---

{body}
"""


def png_bytes(size=(64, 48), color="#9a4d3a") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, "PNG")
    return buffer.getvalue()


class StudioMediaTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-media-test-")
        self.root = Path(self.temp.name)
        # 文章 A：已引用 image-01.jpg + images/original 原图
        bundle_a = self.root / ARTICLE_A
        bundle_a.parent.mkdir(parents=True)
        bundle_a.write_text(
            ARTICLE_TEMPLATE.format(title="文章甲", slug="ce-shi-a", body="正文。\n\n![旧图](image-01.jpg)\n"),
            encoding="utf-8",
        )
        (bundle_a.parent / "image-01.jpg").write_bytes(png_bytes())
        original_dir = bundle_a.parent / "images" / "original"
        original_dir.mkdir(parents=True)
        (original_dir / "image-01.jpg").write_bytes(png_bytes((32, 32)))
        # 文章 B：无图片，用于上传
        bundle_b = self.root / ARTICLE_B
        bundle_b.parent.mkdir(parents=True)
        bundle_b.write_text(
            ARTICLE_TEMPLATE.format(title="文章乙", slug="ce-shi-b", body="正文。"),
            encoding="utf-8",
        )
        self.server = studio_server.create_server(self.root, port=0)
        self.host, self.port = self.server.server_address[:2]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
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

    def upload(self, filename: str, data: bytes, article_path: str = ARTICLE_B, headers: dict | None = None):
        body = (
            f"--{BOUNDARY}\r\n".encode()
            + f'Content-Disposition: form-data; name="articlePath"\r\n\r\n{article_path}\r\n'.encode()
            + f"--{BOUNDARY}\r\n".encode()
            + f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode()
            + b"Content-Type: application/octet-stream\r\n\r\n"
            + data
            + b"\r\n"
            + f"--{BOUNDARY}--\r\n".encode()
        )
        merged = {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}", "X-Studio-Request": "1"}
        merged.update(headers or {})
        status, payload = self.request("POST", "/api/media/upload", body, merged)
        return status, json.loads(payload)

    # -- 扫描 ----------------------------------------------------------------

    def test_01扫描含原图标记与所属文章(self):
        status, payload = self.get_json("/api/media")
        self.assertEqual(status, 200)
        items = {item["relPath"]: item for item in payload["media"]}
        main = items["content/essays/ce-shi-a/image-01.jpg"]
        self.assertEqual(main["articlePath"], ARTICLE_A)
        self.assertEqual(main["articleTitle"], "文章甲")
        self.assertFalse(main["isOriginal"])
        self.assertFalse(main["isCover"])
        self.assertEqual(main["width"], 64)
        self.assertEqual(main["height"], 48)
        self.assertGreater(main["size"], 0)
        original = items["content/essays/ce-shi-a/images/original/image-01.jpg"]
        self.assertTrue(original["isOriginal"])
        self.assertEqual(original["articlePath"], ARTICLE_A)

    def test_02图片字节接口与路径校验(self):
        status, payload = self.request("GET", "/api/media/file?path=" + urllib.parse.quote("content/essays/ce-shi-a/image-01.jpg"))
        self.assertEqual(status, 200)
        self.assertEqual(payload, (self.root / "content/essays/ce-shi-a/image-01.jpg").read_bytes())
        status, payload = self.get_json("/api/media/file?path=../secret.jpg")
        self.assertEqual(status, 400)
        status, payload = self.get_json("/api/media/file?path=" + urllib.parse.quote(ARTICLE_A))
        self.assertEqual(status, 400)  # index.md 不是图片
        status, payload = self.get_json("/api/media/file?path=" + urllib.parse.quote("content/essays/ce-shi-a/none.jpg"))
        self.assertEqual(status, 404)

    # -- 上传 ----------------------------------------------------------------

    def test_03上传成功且保留原图副本(self):
        status, payload = self.upload("题图.png", png_bytes((100, 80)))
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["image"]["name"], "image-01.png")
        bundle = self.root / "content/essays/ce-shi-b"
        self.assertTrue((bundle / "image-01.png").is_file())
        self.assertTrue((bundle / "images" / "original" / "image-01.png").is_file())
        self.assertEqual(payload["markdown"], "![题图](image-01.png)")
        self.assertEqual(payload["image"]["width"], 100)
        self.assertEqual(payload["image"]["height"], 80)
        # 再传一张：序号递增，不覆盖
        status, payload = self.upload("第二.png", png_bytes())
        self.assertEqual(status, 200)
        self.assertEqual(payload["image"]["name"], "image-02.png")

    def test_04超长边缩到2400(self):
        status, payload = self.upload("大图.jpg", png_bytes((3000, 1500)))
        self.assertEqual(status, 200, payload)
        self.assertLessEqual(max(payload["image"]["width"], payload["image"]["height"]), 2400)
        with Image.open(self.root / "content/essays/ce-shi-b" / payload["image"]["name"]) as opened:
            self.assertLessEqual(max(opened.size), 2400)

    def test_05伪装图片与非白名单格式拒绝(self):
        status, payload = self.upload("fake.jpg", "这其实是一个文本文件".encode("utf-8"))
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")
        for name in ["x.bmp", "x.svg", "x.exe", "x.txt"]:
            status, payload = self.upload(name, png_bytes())
            self.assertEqual(status, 400, f"{name} 应拒绝")

    def test_06超大图片拒绝(self):
        status, payload = self.upload("big.png", b"\x89PNG" + b"0" * (20 * 1024 * 1024 + 1))
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "payload-too-large")

    def test_07articlePath穿越拒绝(self):
        for bad in ["../x/index.md", "/etc/index.md", "content/essays/none/index.md"]:
            status, payload = self.upload("x.png", png_bytes(), article_path=bad)
            self.assertIn(status, (400, 404), f"{bad} 应拒绝")
        bundle = self.root / "content/essays/ce-shi-b"
        self.assertEqual(list(bundle.glob("image-*")), [])  # 没有半成品

    # -- 删除（回收站） -------------------------------------------------------

    def test_08被引用图片删除拒绝(self):
        status, payload = self.post_json("/api/media/delete", {"path": "content/essays/ce-shi-a/image-01.jpg"})
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"]["code"], "conflict")
        self.assertIn("引用", payload["error"]["message"])
        self.assertTrue((self.root / "content/essays/ce-shi-a/image-01.jpg").is_file())

    def test_09未被引用删除进回收站(self):
        rel = "content/essays/ce-shi-a/images/original/image-01.jpg"
        status, payload = self.post_json("/api/media/delete", {"path": rel})
        self.assertEqual(status, 200, payload)
        self.assertFalse((self.root / rel).exists())
        trash = self.root / payload["trashPath"]
        self.assertTrue(trash.is_file())
        self.assertIn(".cache/studio/trash/", payload["trashPath"])
        # 回收站不会被会话清扫吞掉
        studio_server.sweep_cache(self.root / ".cache" / "studio")
        self.assertTrue(trash.is_file())

    def test_10删除路径校验(self):
        for bad in ["../x.jpg", "/etc/x.jpg", ARTICLE_A, "content/essays/ce-shi-a/none.jpg"]:
            status, payload = self.post_json("/api/media/delete", {"path": bad})
            self.assertIn(status, (400, 404), f"{bad} 应拒绝")

    # -- 安全回归 ------------------------------------------------------------

    def test_11媒体POST缺自定义头一律403(self):
        body = (
            f"--{BOUNDARY}\r\n".encode()
            + f'Content-Disposition: form-data; name="file"; filename="x.png"\r\n\r\n'.encode()
            + png_bytes()
            + f"\r\n--{BOUNDARY}--\r\n".encode()
        )
        status, _ = self.request(
            "POST", "/api/media/upload", body,
            {"Content-Type": f"multipart/form-data; boundary={BOUNDARY}"},
        )
        self.assertEqual(status, 403)
        status, _ = self.request(
            "POST", "/api/media/delete",
            json.dumps({"path": "content/essays/ce-shi-a/image-01.jpg"}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
