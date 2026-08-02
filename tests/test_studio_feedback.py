#!/usr/bin/env python3
"""阅读反馈代理（studio/feedback.py + server.py 反馈路由）测试。

用标准库 http.server 起本地桩服务模拟 comments-service 的 admin API：
- login 校验 Origin 头、发 cookie + csrfToken；
- comments 列表要求 Cookie；
- moderate 要求 Cookie + X-CSRF-Token。
断言：login 带 Origin；moderate 带 Cookie+CSRF；错误 id/action 拒绝；
delete 无 confirm → 400；未登录访问 → 401 not-logged-in；服务不可达 →
友好错误；POST 无 X-Studio-Request → 403。
"""

from __future__ import annotations

import http.client
import json
import re
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.feedback as feedback  # noqa: E402
import studio.server as studio_server  # noqa: E402

studio_server.StudioHandler.log_message = lambda *args: None  # 测试中静默访问日志

COMMENT_ROW = {
    "id": "comment_abc123",
    "article_id": "art-1",
    "paragraph_id": "p-aaaa1111bbbb",
    "paragraph_excerpt": "提交时摘录",
    "current_excerpt": "提交时摘录",
    "display_name": "读者甲",
    "body": "写得好。",
    "status": "pending",
    "scope": "paragraph",
    "created_at": "2026-07-01T08:00:00.000Z",
    "title": "示例篇章",
    "canonical_path": "/works/demo-collection/chapter-one/",
}


class StubState:
    logins: list[dict] = []
    moderations: list[dict] = []
    lists: list[dict] = []


class StubHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, status: int, payload: dict, headers: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            return self._json(200, {"ok": True})
        if path == "/api/comments/v1/admin/comments":
            StubState.lists.append(dict(self.headers))
            cookie = self.headers.get("Cookie") or ""
            if "lidaiji_admin=test-token" not in cookie:
                return self._json(401, {"ok": False, "error": {"message": "未登录。"}})
            return self._json(
                200,
                {
                    "ok": True,
                    "page": 1,
                    "pages": 1,
                    "total": 1,
                    "stats": {"pending": 1},
                    "scopeStats": {"paragraph": 1},
                    "comments": [COMMENT_ROW],
                },
            )
        return self._json(404, {"ok": False})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        path = self.path.split("?", 1)[0]
        if path == "/api/comments/v1/admin/login":
            StubState.logins.append(dict(self.headers))
            if self.headers.get("Origin") != feedback.COMMENTS_BASE:
                return self._json(403, {"ok": False, "error": {"message": "请求来源不被接受。"}})
            payload = json.loads(body or b"{}")
            if payload.get("username") == "owner" and payload.get("password") == "secret":
                return self._json(
                    200,
                    {"ok": True, "username": "owner", "csrfToken": "csrf-abc"},
                    {"Set-Cookie": "lidaiji_admin=test-token; Path=/; HttpOnly; SameSite=Strict"},
                )
            return self._json(401, {"ok": False, "error": {"message": "用户名或密码不正确。"}})
        matched = re.match(
            r"^/api/comments/v1/admin/comments/(comment_[A-Za-z0-9_-]+)/(approve|reject|spam|hide|delete)$",
            path,
        )
        if matched:
            StubState.moderations.append({"path": path, "headers": dict(self.headers)})
            cookie = self.headers.get("Cookie") or ""
            if "lidaiji_admin=test-token" not in cookie or self.headers.get("X-CSRF-Token") != "csrf-abc":
                return self._json(401, {"ok": False, "error": {"message": "会话失效。"}})
            return self._json(200, {"ok": True, "id": matched.group(1), "status": "approved"})
        return self._json(404, {"ok": False})


class FeedbackTestCase(unittest.TestCase):
    def setUp(self):
        StubState.logins = []
        StubState.moderations = []
        StubState.lists = []
        self.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        self.stub_thread = threading.Thread(target=self.stub.serve_forever, daemon=True)
        self.stub_thread.start()
        self.original_base = feedback.COMMENTS_BASE
        feedback.COMMENTS_BASE = f"http://127.0.0.1:{self.stub.server_address[1]}"
        self.temp = tempfile.TemporaryDirectory(prefix="studio-feedback-test-")
        self.root = Path(self.temp.name)
        (self.root / "content" / "essays").mkdir(parents=True)
        self.server = studio_server.create_server(self.root, port=0)
        self.host, self.port = self.server.server_address[:2]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        feedback.COMMENTS_BASE = self.original_base
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.stub.shutdown()
        self.stub.server_close()
        self.stub_thread.join(timeout=5)
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

    def post_json(self, path: str, payload: dict, headers: dict | None = None):
        merged = {"Content-Type": "application/json", "X-Studio-Request": "1"}
        merged.update(headers or {})
        status, payload = self.request("POST", path, json.dumps(payload).encode("utf-8"), merged)
        return status, json.loads(payload)

    def login(self):
        status, payload = self.post_json("/api/feedback/login", {"username": "owner", "password": "secret"})
        self.assertEqual(status, 200, payload)
        return payload

    # -- 测试 ---------------------------------------------------------------

    def test_01登录带Origin头并保存内存会话(self):
        payload = self.login()
        self.assertEqual(payload["username"], "owner")
        self.assertEqual(len(StubState.logins), 1)
        self.assertEqual(StubState.logins[0].get("Origin"), feedback.COMMENTS_BASE)
        session = self.server.state.feedback_session
        self.assertEqual(session["cookie"], "test-token")
        self.assertEqual(session["csrf"], "csrf-abc")

    def test_02凭证错误与未运行服务的处理(self):
        status, payload = self.post_json("/api/feedback/login", {"username": "owner", "password": "wrong"})
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"]["code"], "login-failed")
        self.assertIsNone(self.server.state.feedback_session)
        # 服务不可达 → 友好错误
        feedback.COMMENTS_BASE = "http://127.0.0.1:1"
        status, payload = self.post_json("/api/feedback/login", {"username": "owner", "password": "secret"})
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"]["code"], "service-unavailable")

    def test_03未登录访问列表返回401(self):
        status, payload = self.request("GET", "/api/feedback/comments?status=pending")
        self.assertEqual(status, 401)
        body = json.loads(payload)
        self.assertEqual(body["error"]["code"], "not-logged-in")

    def test_04登录后列表透传并带Cookie(self):
        self.login()
        status, payload = self.request("GET", "/api/feedback/comments?status=pending&scope=paragraph")
        self.assertEqual(status, 200)
        body = json.loads(payload)
        self.assertTrue(body["ok"])
        self.assertEqual(body["comments"][0]["id"], "comment_abc123")
        self.assertIn("lidaiji_admin=test-token", StubState.lists[-1].get("Cookie") or "")

    def test_05审核动作带Cookie与CSRF(self):
        self.login()
        status, payload = self.post_json(
            "/api/feedback/moderate", {"id": "comment_abc123", "action": "approve", "reason": "好"}
        )
        self.assertEqual(status, 200, payload)
        sent = StubState.moderations[-1]
        self.assertIn("lidaiji_admin=test-token", sent["headers"].get("Cookie") or "")
        self.assertEqual(sent["headers"].get("X-Csrf-Token"), "csrf-abc")

    def test_06非法id与动作被拒(self):
        self.login()
        status, payload = self.post_json("/api/feedback/moderate", {"id": "../../etc", "action": "approve"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")
        status, payload = self.post_json("/api/feedback/moderate", {"id": "comment_abc123", "action": "nuke"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")

    def test_07删除必须显式确认(self):
        self.login()
        status, payload = self.post_json("/api/feedback/moderate", {"id": "comment_abc123", "action": "delete"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "confirmation-required")
        status, payload = self.post_json(
            "/api/feedback/moderate", {"id": "comment_abc123", "action": "delete", "confirm": True}
        )
        self.assertEqual(status, 200, payload)

    def test_08会话过期自动清理(self):
        self.login()
        self.server.state.feedback_session["cookie"] = "stale-token"
        status, payload = self.request("GET", "/api/feedback/comments")
        self.assertEqual(status, 401)
        body = json.loads(payload)
        self.assertEqual(body["error"]["code"], "not-logged-in")
        self.assertIsNone(self.server.state.feedback_session)

    def test_09状态接口形状(self):
        status, payload = self.request("GET", "/api/feedback/status")
        self.assertEqual(status, 200)
        body = json.loads(payload)
        self.assertTrue(body["ok"])
        self.assertIn("running", body["service"])
        self.assertEqual(body["service"]["url"], feedback.COMMENTS_BASE)
        # 未登录：即使服务在线也不附 stats
        self.assertFalse(body["loggedIn"])
        self.assertNotIn("stats", body)
        self.login()
        status, payload = self.request("GET", "/api/feedback/status")
        body = json.loads(payload)
        self.assertTrue(body["loggedIn"])
        self.assertEqual(body["username"], "owner")
        self.assertEqual(body["stats"]["paragraphPending"], 1)
        self.assertEqual(body["stats"]["articlePending"], 1)

    def test_10服务管理动作校验(self):
        status, payload = self.post_json("/api/feedback/service", {"action": "bogus"})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "bad-request")

    def test_11POST缺自定义头被403(self):
        status, payload = self.request(
            "POST",
            "/api/feedback/login",
            json.dumps({"username": "owner", "password": "secret"}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)
        status, _ = self.request(
            "POST",
            "/api/feedback/service",
            json.dumps({"action": "stop"}).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        self.assertEqual(status, 403)

    def test_12登出清理会话(self):
        self.login()
        status, payload = self.post_json("/api/feedback/logout", {})
        self.assertEqual(status, 200)
        self.assertIsNone(self.server.state.feedback_session)
        status, payload = self.request("GET", "/api/feedback/comments")
        self.assertEqual(status, 401)

    def test_13原文定位路径校验(self):
        status, payload = self.post_json(
            "/api/feedback/open-location", {"canonicalPath": "javascript:alert(1)", "scope": "article"}
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")
        status, payload = self.post_json(
            "/api/feedback/open-location",
            {"canonicalPath": "/works/demo-collection/chapter-one/", "scope": "paragraph", "paragraphId": "bad id"},
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
