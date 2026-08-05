#!/usr/bin/env python3
"""阅读反馈代理（studio/feedback.py + server.py 反馈路由）测试。

用标准库 http.server 起本地桩服务模拟 comments-service 的 admin API：
- login：带来源头时必须等于公开来源，不带来源头的回环管理请求放行；
  成功发 cookie + csrfToken；
- comments 列表要求 Cookie；
- moderate 要求 Cookie + X-CSRF-Token。
断言：login 不带来源头放行、错误 Origin 被拒；moderate 带 Cookie+CSRF；
错误 id/action 拒绝；delete 无 confirm → 400；未登录访问 → 401
not-logged-in；服务不可达 → 友好错误；POST 无 X-Studio-Request → 403。
"""

from __future__ import annotations

import http.client
import urllib.error
import urllib.request
import os
import socket as _socket_module
import shutil
import subprocess
import time
import json
import re
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.feedback as feedback  # noqa: E402
import studio.server as studio_server  # noqa: E402

studio_server.StudioHandler.log_message = lambda *args: None  # 测试中静默访问日志

PUBLIC_ORIGIN = "http://comments-public.test"


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
            origin = self.headers.get("Origin") or ""
            referer = self.headers.get("Referer") or ""
            if (origin and origin != PUBLIC_ORIGIN) or (not origin and referer):
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
        self.server.state.auth_mode = "password"
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
        merged = {"Content-Type": "application/json", "X-Studio-Request": "1", "X-Studio-CSRF": self.server.state.studio_csrf_token}
        merged.update(headers or {})
        status, payload = self.request("POST", path, json.dumps(payload).encode("utf-8"), merged)
        return status, json.loads(payload)

    def login(self):
        status, payload = self.post_json("/api/feedback/login", {"username": "owner", "password": "secret"})
        self.assertEqual(status, 200, payload)
        return payload

    # -- 测试 ---------------------------------------------------------------

    def test_01登录不带来源头并保存内存会话(self):
        payload = self.login()
        self.assertEqual(payload["username"], "owner")
        self.assertEqual(len(StubState.logins), 1)
        self.assertFalse(StubState.logins[0].get("Origin"))
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

    def test_14双仓库模式无服务时建立SSH隧道(self):
        private_root = self.root / "private"
        platform_root = self.root / "platform"
        private_root.mkdir()
        state = SimpleNamespace(
            project_root=private_root,
            platform_root=platform_root,
            lock=threading.Lock(),
            comments_process=None,
        )

        with patch.object(feedback, "service_running", return_value=False), patch.object(
            feedback, "wait_for_service", return_value=True
        ), patch.object(feedback.subprocess, "Popen") as popen:
            feedback.start_service(state)

        popen.assert_called_once()
        args, _ = popen.call_args
        self.assertEqual(args[0][0], "ssh")
        self.assertIn("-L", args[0])
        self.assertIn("127.0.0.1:4317:127.0.0.1:4317", args[0])
        self.assertEqual(state.comments_process, popen.return_value)




class FeedbackConnectionTests(FeedbackTestCase):
    """评论服务连接来源与 SSH 隧道管理（修复：生产评论审核链路）。"""

    def _state(self):
        return SimpleNamespace(project_root=Path("."), platform_root=Path("."), lock=threading.Lock(), comments_process=None)

    def test_20连接来源判定(self):
        with patch.object(feedback, "port_ready", return_value=False):
            self.assertEqual(feedback.service_source(), "none")
        with patch.object(feedback, "port_ready", return_value=True), patch.object(
            feedback, "_listener_command", return_value="ssh -N -L 127.0.0.1:4317:127.0.0.1:4317 game-server"
        ):
            self.assertEqual(feedback.service_source(), "production-tunnel")
        with patch.object(feedback, "port_ready", return_value=True), patch.object(
            feedback, "_listener_command",
            return_value="node --experimental-sqlite comments-service/src/server.js",
        ):
            self.assertEqual(feedback.service_source(), "local-demo")
        with patch.object(feedback, "service_source", return_value="none"):
            self.assertEqual(feedback.service_source_label(), "未连接")
        with patch.object(feedback, "service_source", return_value="production-tunnel"):
            self.assertEqual(feedback.service_source_label(), "生产评论服务（SSH 隧道）")

    def test_21本机演示服务占用时拒绝连接生产(self):
        state = self._state()
        with patch.object(feedback, "service_running", return_value=True), patch.object(
            feedback, "service_source", return_value="local-demo"
        ):
            with self.assertRaises(feedback.FeedbackFailure) as ctx:
                feedback.start_service(state)
        self.assertIn("演示评论服务", str(ctx.exception.message))
        self.assertIsNone(state.comments_process)

    def test_22无服务时建立SSH隧道(self):
        state = self._state()
        with patch.object(feedback, "service_running", return_value=False), patch.object(
            feedback, "wait_for_service", return_value=True
        ), patch.object(feedback.subprocess, "Popen") as popen:
            feedback.start_service(state)
        popen.assert_called_once()
        args, _ = popen.call_args
        self.assertEqual(args[0][0], "ssh")
        self.assertIn("-L", args[0])
        self.assertIn("127.0.0.1:4317:127.0.0.1:4317", args[0])
        self.assertIsNotNone(state.comments_process)

    def test_23隧道建立后服务未就绪时报错(self):
        state = self._state()

        class FakeProcess:
            def __init__(self):
                self.pid = 999999

            def poll(self):
                return 1

        with patch.object(feedback, "service_running", return_value=False), patch.object(
            feedback, "wait_for_service", return_value=False
        ), patch.object(feedback.subprocess, "Popen", return_value=FakeProcess()):
            with self.assertRaises(feedback.FeedbackFailure) as ctx:
                feedback.start_service(state)
        self.assertIn("SSH 隧道", str(ctx.exception.message))
        self.assertIsNone(state.comments_process)

    def test_24停止非工作台演示服务时不动进程(self):
        state = self._state()
        with patch.object(feedback, "service_source", return_value="local-demo"):
            feedback.stop_service(state)  # 安静返回，不误停演示服务

    def test_25status接口标注连接来源(self):
        status, payload = self.request("GET", "/api/feedback/status")
        self.assertEqual(status, 200)
        body = json.loads(payload)
        self.assertIn("source", body["service"])
        self.assertIn("sourceLabel", body["service"])
        self.assertIn(body["service"]["source"], ("production-tunnel", "local-demo", "none"))




class FeedbackE2ETest(unittest.TestCase):
    """端到端：真实评论服务（临时数据库）+ Studio 代理全链路。

    提交虚构评论 → 数据库 status=pending → 管理 API 返回 → Studio 列表显示
    → 批准 → 公开列表可见。仅使用虚构文章与临时数据库。
    """

    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("需要 node 运行真实评论服务")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="feedback-e2e-")
        self.data_dir = Path(self.temp.name)
        self.db = self.data_dir / "comments.sqlite3"
        self.manifest = self.data_dir / "manifest.json"
        self.port = self._free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.comments_root = ROOT / "comments-service"
        self.env = {
            **os.environ,
            "COMMENTS_DATA_DIR": str(self.data_dir),
            "COMMENTS_DB": str(self.db),
            "COMMENTS_PORT": str(self.port),
            "COMMENTS_PUBLIC_ORIGIN": self.base,
            "COMMENTS_STATIC_DIR": str(ROOT / "dist" / "site"),
            "COMMENTS_HMAC_SECRET": "e2e-test-secret-not-for-production-0001",
        }
        self.article_id = "article-0000e2e00000feed"
        self.revision = f"{self.article_id}@e2e0000revision"
        self.paragraph_id = "p-0000e2e000fe"
        self._write_manifest()
        self._run_cli("migrate")
        self._run_cli("sync-manifest", [str(self.manifest)])
        self._run_cli("create-admin", ["owner"], input_bytes=b"e2e-password-123456\n")
        self.proc = subprocess.Popen(
            [self.node, "--experimental-sqlite", "src/server.js"],
            cwd=str(self.comments_root), env=self.env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self.addCleanup(self._stop_server)
        self._wait_health()

    def _free_port(self):
        with _socket_module.socket(_socket_module.AF_INET, _socket_module.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def _write_manifest(self):
        manifest = {
            "schemaVersion": 1,
            "generatedAt": "2026-08-03T00:00:00.000Z",
            "articles": [{
                "articleId": self.article_id,
                "revision": self.revision,
                "title": "端到端测试文章（虚构）",
                "canonicalPath": "/works/e2e/fake-article/",
                "paragraphComments": "open",
                "sourceChecksum": "0" * 64,
                "paragraphs": [{
                    "paragraphId": self.paragraph_id,
                    "position": 0,
                    "headingContext": "",
                    "excerpt": "这是端到端测试用的虚构段落。",
                    "checksum": "0" * 64,
                }],
            }],
        }
        self.manifest.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    def _run_cli(self, command, args=(), input_bytes=None):
        result = subprocess.run(
            [self.node, "--experimental-sqlite", "src/cli.js", command, *args],
            cwd=str(self.comments_root), env=self.env,
            input=input_bytes, capture_output=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        return result.stdout.decode("utf-8", "replace")

    def _wait_health(self):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"{self.base}/healthz", timeout=2) as resp:
                    if resp.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                time.sleep(0.5)
        self.fail("评论服务 30 秒内未就绪")

    def _stop_server(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def tearDown(self):
        self._stop_server()
        self.temp.cleanup()

    # -- HTTP 辅助（直接请求评论服务） --------------------------------------

    def _post(self, path, payload, cookies=""):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            self.base + path, data=body, method="POST",
            headers={"Content-Type": "application/json", "Origin": self.base,
                     "Cookie": cookies},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8")), resp.headers
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8")), error.headers

    def _get(self, path, cookies=""):
        request = urllib.request.Request(self.base + path, headers={"Cookie": cookies})
        try:
            with urllib.request.urlopen(request, timeout=10) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def _db_row(self):
        row = subprocess.run(
            ["sqlite3", f"file:{self.db}?mode=ro",
             "SELECT status, scope FROM comments WHERE id='comment_e2e000000000001';"],
            capture_output=True, text=True, timeout=30,
        )
        return row.stdout.strip() or None

    def test_26端到端评论全链路(self):
        unique = f"e2e-{time.time_ns()}"
        # 1. 游客提交虚构段评
        status, payload, _ = self._post("/api/comments/v1/comments", {
            "articleId": self.article_id,
            "clientId": "e2e-client-00000001",
            "scope": "paragraph",
            "paragraphId": self.paragraph_id,
            "displayName": "测试读者",
            "body": f"这是端到端测试段评 {unique}，仅用于验证待审核链路。",
        })
        self.assertEqual(status, 202, payload)
        # 2. 数据库 status=pending
        row = subprocess.run(
            ["sqlite3", f"file:{self.db}?mode=ro",
             f"SELECT status||'|'||scope FROM comments WHERE body LIKE '%{unique}%';"],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        self.assertEqual(row, "pending|paragraph")
        # 3. 管理员登录（经评论服务 admin API）
        status, login, headers = self._post("/api/comments/v1/admin/login", {
            "username": "owner", "password": "e2e-password-123456",
        })
        self.assertEqual(status, 200, login)
        set_cookie = headers.get("Set-Cookie") or ""
        cookie = set_cookie.split(";")[0]
        csrf = login.get("csrfToken")
        # 4. 待审核列表包含段评
        status, listing = self._get("/api/comments/v1/admin/comments?status=pending", cookie)
        self.assertEqual(status, 200, listing)
        paragraph_item = next((item for item in listing.get("comments", []) if unique in (item.get("body") or "")), None)
        self.assertIsNotNone(paragraph_item, listing)
        comment_id = paragraph_item["id"]
        # 5. 章评也出现在待审核列表
        status, _, _ = self._post("/api/comments/v1/comments", {
            "articleId": self.article_id,
            "clientId": "e2e-client-00000002",
            "scope": "article",
            "displayName": "测试读者",
            "body": f"这是端到端测试章评 {unique}，仅用于验证待审核链路。",
        })
        self.assertEqual(status, 202)
        status, listing = self._get("/api/comments/v1/admin/comments?status=pending", cookie)
        self.assertEqual(status, 200)
        self.assertTrue(
            any((item.get("scope") == "article") and (unique in (item.get("body") or ""))
                for item in listing.get("comments", [])),
            listing,
        )
        # 6. 批准 → 公开列表可见
        request = urllib.request.Request(
            self.base + f"/api/comments/v1/admin/comments/{comment_id}/approve",
            data=b"{}", method="POST",
            headers={"Content-Type": "application/json", "Origin": self.base,
                     "Cookie": cookie, "X-CSRF-Token": csrf},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as resp:
                moderate = json.loads(resp.read().decode("utf-8"))
                moderate_status = resp.status
        except urllib.error.HTTPError as error:
            moderate_status = error.code
            moderate = json.loads(error.read().decode("utf-8"))
        self.assertEqual(moderate_status, 200, moderate)
        self.assertEqual(status, 200, moderate)
        status, public = self._get(
            f"/api/comments/v1/articles/{self.article_id}/paragraphs/{self.paragraph_id}?revision={self.revision}", ""
        )
        self.assertEqual(status, 200, public)
        self.assertTrue(any(unique in (item.get("body") or "") for item in public.get("comments", [])))


if __name__ == "__main__":
    unittest.main(verbosity=2)
