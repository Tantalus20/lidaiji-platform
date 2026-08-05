"""作者工作台 local-bootstrap 认证测试（v0.2.1）。

测试拓扑：
  浏览器(测试客户端) → Studio(127.0.0.1:随机端口) → 本地测试上游 comments-service(127.0.0.1:4319)
上游为真实 comments-service 代码（Node 子进程 + 临时SQLite），管理员凭据来自
测试进程环境变量（Keychain/600文件来源在测试中被屏蔽，保证确定性）。

覆盖：LOOP-* / AUTH-* / CSRF-* / UP-* / ADMIN-* 系列。
不对生产评论服务做任何请求。
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from studio import credentials as credentials_module  # noqa: E402
from studio import feedback as feedback_module  # noqa: E402
from studio import server as studio_server  # noqa: E402

UPSTREAM_PORT = 4319
UPSTREAM_DIR = Path(tempfile.mkdtemp(prefix="studio-upstream-"))
UPSTREAM_DB = UPSTREAM_DIR / "comments.sqlite3"
UPSTREAM_PID: int | None = None
UPSTREAM_ARTICLE = "article-abcdef1234567890"
UPSTREAM_P1 = "p-111111111111"

# 记录原环境值，setUpModule 注入、tearDownModule 还原，
# 避免与其它测试模块（同进程）互相干扰。
_PREV_ENV = {key: os.environ.get(key) for key in (
    "LIDAIJI_COMMENTS_BASE",
    "LIDAIJI_COMMENTS_ADMIN_USERNAME",
    "LIDAIJI_COMMENTS_ADMIN_PASSWORD",
)}


def _node_bin() -> str:
    return os.environ.get("NODE_BIN", "node")


def setUpModule():
    global UPSTREAM_PID
    os.environ["LIDAIJI_COMMENTS_BASE"] = f"http://127.0.0.1:{UPSTREAM_PORT}"
    os.environ["LIDAIJI_COMMENTS_ADMIN_USERNAME"] = "test-owner"
    os.environ["LIDAIJI_COMMENTS_ADMIN_PASSWORD"] = "test-upstream-password-0123456789"
    feedback_module.COMMENTS_BASE = f"http://127.0.0.1:{UPSTREAM_PORT}"
    service_dir = ROOT / "comments-service"
    env = dict(os.environ)
    env.update({
        "COMMENTS_DATA_DIR": str(UPSTREAM_DIR),
        "COMMENTS_DB": str(UPSTREAM_DB),
        "COMMENTS_PORT": str(UPSTREAM_PORT),
        "COMMENTS_HOST": "127.0.0.1",
        "COMMENTS_HMAC_SECRET": "test-upstream-hmac-secret-0123456789abcdef",
        "COMMENTS_PUBLIC_ORIGIN": "http://127.0.0.1:1313",
        "COMMENTS_TRUST_LOOPBACK_PROXY": "false",
        "COMMENTS_LOGIN_RATE": "100",  # 测试上游放宽登录限流（同源IP共享配额）
        "LIDAIJI_QQ_COMMENT_PEPPER": "test-pepper",
    })
    admin = subprocess.run(
        [_node_bin(), "--experimental-sqlite", "src/cli.js", "create-admin", "test-owner"],
        input=b"test-upstream-password-0123456789\n",
        capture_output=True,
        cwd=service_dir,
        env=env,
        timeout=60,
    )
    if admin.returncode != 0:
        raise RuntimeError(f"上游管理员创建失败：{admin.stderr.decode(errors='replace')}")
    UPSTREAM_PID = subprocess.Popen(
        [_node_bin(), "--experimental-sqlite", "src/server.js"],
        cwd=service_dir,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).pid
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", UPSTREAM_PORT), timeout=1):
                break
        except OSError:
            time.sleep(0.3)
    else:
        raise RuntimeError("上游评论服务未就绪。")
    _seed_upstream()


def _seed_upstream():
    con = sqlite3.connect(UPSTREAM_DB, timeout=10)
    try:
        now = "2026-08-05T00:00:00.000Z"
        con.execute(
            "INSERT OR IGNORE INTO articles(article_id,current_revision,title,canonical_path,paragraph_comments_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (UPSTREAM_ARTICLE, f"{UPSTREAM_ARTICLE}@rev1", "测试文章", "/essays/test/", "open", now, now),
        )
        con.execute(
            "INSERT OR IGNORE INTO paragraphs(article_id,revision,paragraph_id,position,heading_context,text_excerpt,text_checksum,status) VALUES(?,?,?,?,?,?,?,?)",
            (UPSTREAM_ARTICLE, f"{UPSTREAM_ARTICLE}@rev1", UPSTREAM_P1, 0, "", "第一段", "a" * 64, "current"),
        )
        for i, (cid, status, scope, pid) in enumerate([
            ("comment_test_pending_1", "pending", "paragraph", UPSTREAM_P1),
            ("comment_test_pending_2", "pending", "article", ""),
            ("comment_test_approved_1", "approved", "article", ""),
            ("comment_test_deleted_1", "deleted", "article", ""),
        ]):
            con.execute(
                "INSERT OR IGNORE INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,"
                "source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope,source_type) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, UPSTREAM_ARTICLE, f"{UPSTREAM_ARTICLE}@rev1", pid, "摘录" if pid else "",
                 f"测试者{i}", f"这是第{i}条测试评论正文。", status,
                 "s", "b", 0, "h", now, now, scope, "website"),
            )
        con.commit()
    finally:
        con.close()


def tearDownModule():
    if UPSTREAM_PID:
        try:
            os.kill(UPSTREAM_PID, 15)
        except ProcessLookupError:
            pass
        time.sleep(0.5)
    shutil.rmtree(UPSTREAM_DIR, ignore_errors=True)
    feedback_module.COMMENTS_BASE = "http://127.0.0.1:4317"
    for key, value in _PREV_ENV.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


class StudioAuthTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-auth-test-")
        self.root = Path(self.temp.name)
        (self.root / "content" / "works").mkdir(parents=True)
        (self.root / "content" / "essays").mkdir(parents=True)
        # 屏蔽 Keychain 与本机文件来源，保证只走环境变量（确定性）。
        patchers = [
            mock.patch.object(credentials_module, "_read_keychain_credentials", return_value=None),
            mock.patch.object(credentials_module, "_read_file_credentials", return_value=None),
        ]
        for patcher in patchers:
            patcher.start()
        self.addCleanup(lambda: [p.stop() for p in patchers])
        self.server = studio_server.create_server(self.root, port=0)
        self.server.state.auth_mode = "local-bootstrap"
        self.host, self.port = self.server.server_address[:2]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temp.cleanup()

    # -- 请求辅助 -----------------------------------------------------------

    def raw_request(self, method, path, body=b"", headers=None, skip_host=False, include_session=True):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=30)
        merged = {}
        if include_session:
            merged["Cookie"] = f"{studio_server.STUDIO_SESSION_COOKIE}={self.server.state.studio_session_token}"
        merged.update(headers or {})
        if skip_host:
            connection.putrequest(method, path, skip_host=True)
            for name, value in merged.items():
                connection.putheader(name, value)
            if body:
                connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body)
        else:
            connection.request(method, path, body, merged)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, response.getheaders(), payload

    def get_json(self, path, **kwargs):
        status, headers, payload = self.raw_request("GET", path, **kwargs)
        return status, headers, json.loads(payload or b"{}")

    def post_json(self, path, data, **kwargs):
        headers = {"Content-Type": "application/json", "X-Studio-Request": "1",
                   "X-Studio-CSRF": self.server.state.studio_csrf_token}
        headers.update(kwargs.pop("headers", {}))
        status, resp_headers, payload = self.raw_request("POST", path, json.dumps(data).encode("utf-8"),
                                                         headers=headers, **kwargs)
        return status, resp_headers, json.loads(payload or b"{}")

    # -- LOOP-* 监听安全 -----------------------------------------------------

    def test_LOOP_01_127回环允许启动(self):
        server = studio_server.create_server(self.root, host="127.0.0.1", port=0)
        self.assertEqual(server.server_address[0], "127.0.0.1")
        server.server_close()

    def test_LOOP_02_ipv6回环允许(self):
        self.assertTrue(studio_server.is_loopback("::1"))

    def test_LOOP_03_0000拒绝(self):
        with self.assertRaises(ValueError):
            studio_server.create_server(self.root, host="0.0.0.0", port=0)

    def test_LOOP_04_局域网与公网拒绝(self):
        for host in ("192.168.1.10", "10.0.0.1", "172.16.0.1", "8.8.8.8"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                studio_server.create_server(self.root, host=host, port=0)

    def test_LOOP_05_异常Host拒绝(self):
        status, _, _ = self.raw_request("GET", "/", headers={"Host": f"evil.example:{self.port}"})
        self.assertEqual(status, 403)
        status, _, _ = self.raw_request("GET", "/", skip_host=True, headers=[])
        self.assertEqual(status, 403)

    # -- AUTH-* 本地会话 -----------------------------------------------------

    def test_AUTH_01_启动后自动授权(self):
        status, headers, _ = self.raw_request("GET", "/")
        self.assertEqual(status, 200)
        cookies = [v for k, v in headers if k.lower() == "set-cookie"]
        self.assertTrue(any(studio_server.STUDIO_SESSION_COOKIE in c for c in cookies), "首页必须签发本地会话")
        status, _, payload = self.get_json("/api/system/status")
        self.assertEqual(status, 200)
        self.assertEqual(payload["auth"]["mode"], "local-bootstrap")

    def test_AUTH_02_local_bootstrap无登录表单且拒绝密码登录(self):
        status, _, _ = self.post_json("/api/feedback/login", {"username": "x", "password": "y"})
        self.assertEqual(status, 403, "local-bootstrap 下必须拒绝浏览器提交账号密码")

    def test_AUTH_03_Session_Cookie为HttpOnly(self):
        _, headers, _ = self.raw_request("GET", "/")
        cookie = next(v for k, v in headers if k.lower() == "set-cookie" and studio_server.STUDIO_SESSION_COOKIE in v)
        self.assertIn("HttpOnly", cookie)

    def test_AUTH_04_SameSite_Strict(self):
        _, headers, _ = self.raw_request("GET", "/")
        cookie = next(v for k, v in headers if k.lower() == "set-cookie" and studio_server.STUDIO_SESSION_COOKIE in v)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Max-Age=28800", cookie)

    def test_AUTH_05_进程重启旧Session失效(self):
        _, headers, _ = self.raw_request("GET", "/")
        old_token = self.server.state.studio_session_token
        self.server.state.rotate_local_auth()
        status, _, _ = self.raw_request("GET", "/api/system/status", headers={"Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={old_token}"})
        self.assertEqual(status, 403, "重启（轮换）后旧会话必须失效")

    def test_AUTH_06_锁定后Session失效且显示锁定(self):
        status, _, payload = self.post_json("/api/system/lock", {})
        self.assertEqual(status, 200)
        self.assertTrue(payload["locked"])
        old_token = self.server.state.studio_session_token
        status, _, _ = self.raw_request("GET", "/api/system/status", headers={"Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={old_token}"})
        self.assertEqual(status, 403, "锁定后旧本地会话必须失效")
        # 顶层重新导航 = 重新授权
        status, _, _ = self.raw_request("GET", "/")
        self.assertEqual(status, 200)
        self.assertFalse(self.server.state.locked)

    def test_AUTH_07_会话与CSRF不写入浏览器存储(self):
        bundle = (ROOT / "studio" / "static" / "app-bundle.js").read_text(encoding="utf-8")
        self.assertNotIn(studio_server.STUDIO_SESSION_COOKIE, bundle, "Session Cookie名不得出现在前端包")
        for line in bundle.splitlines():
            if "localStorage" in line or "sessionStorage" in line or "indexedDB" in line.lower():
                self.assertNotIn("csrf", line.lower(), "浏览器存储不得保存CSRF/会话材料")
                self.assertNotIn("token", line.lower(), "浏览器存储不得保存会话令牌")

    # -- BOOT-*：方案A（本地网关自动授权），不使用一次性bootstrap token ----

    def test_BOOT_00_方案A无bootstrap端点(self):
        status, _, _ = self.raw_request("GET", "/api/system/bootstrap", include_session=False)
        self.assertIn(status, (403, 404))

    # -- CSRF-* --------------------------------------------------------------

    def test_CSRF_01_正确请求成功(self):
        status, _, payload = self.post_json("/api/system/preview", {"action": "stop"})
        self.assertEqual(status, 200)

    def test_CSRF_02_无CSRF拒绝(self):
        status, _, _ = self.raw_request(
            "POST", "/api/system/preview", json.dumps({"action": "stop"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Studio-Request": "1"},
        )
        self.assertEqual(status, 403)

    def test_CSRF_03_错误CSRF拒绝(self):
        status, _, _ = self.post_json("/api/system/preview", {"action": "stop"},
                                      headers={"X-Studio-CSRF": "wrong" * 4})
        self.assertEqual(status, 403)

    def test_CSRF_04_错误Origin拒绝(self):
        status, _, _ = self.post_json("/api/system/preview", {"action": "stop"},
                                      headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)

    def test_CSRF_05_跨端口Origin拒绝(self):
        status, _, _ = self.post_json("/api/system/preview", {"action": "stop"},
                                      headers={"Origin": f"http://127.0.0.1:{self.port + 1}"})
        self.assertEqual(status, 403)

    def test_CSRF_06_恶意网页表单POST拒绝(self):
        # 表单POST只有表单Content-Type，无自定义头 → 403
        status, _, _ = self.raw_request(
            "POST", "/api/feedback/logout", b"a=b",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        self.assertEqual(status, 403)

    def test_CSRF_07_iframe加载拒绝(self):
        _, headers, _ = self.raw_request("GET", "/")
        joined = "\n".join(f"{k}: {v}" for k, v in headers)
        self.assertIn("frame-ancestors 'none'", joined)
        self.assertIn("X-Frame-Options: DENY", joined)
        self.assertIn("Referrer-Policy: no-referrer", joined)

    # -- UP-* 上游认证 ---------------------------------------------------------

    def test_UP_01_本机凭据存在时自动登录(self):
        status, _, payload = self.get_json("/api/feedback/status")
        self.assertEqual(status, 200)
        self.assertTrue(payload["upstream"]["credentialsConfigured"])
        self.assertTrue(payload["loggedIn"], "凭据存在时网关必须自动登录上游")
        self.assertEqual(payload["username"], "test-owner")

    def test_UP_02_凭据缺失时不降级(self):
        with mock.patch.dict(os.environ, {"LIDAIJI_COMMENTS_ADMIN_USERNAME": "", "LIDAIJI_COMMENTS_ADMIN_PASSWORD": ""}):
            status, _, payload = self.get_json("/api/feedback/status")
        self.assertEqual(status, 200)
        self.assertFalse(payload["loggedIn"])
        self.assertFalse(payload["upstream"]["credentialsConfigured"])
        self.assertIn("npm run studio:setup", payload.get("upstreamError", ""), "缺失凭据应提示设置命令")

    def test_UP_03_错误凭据不降级(self):
        with mock.patch.dict(os.environ, {"LIDAIJI_COMMENTS_ADMIN_USERNAME": "test-owner", "LIDAIJI_COMMENTS_ADMIN_PASSWORD": "wrong-password"}):
            status, _, payload = self.get_json("/api/feedback/status")
        self.assertEqual(status, 200)
        self.assertFalse(payload["loggedIn"])
        self.assertTrue(payload.get("upstreamError"), "错误凭据必须报告上游认证失败")

    def test_UP_04_上游401自动重建会话(self):
        status, _, payload = self.get_json("/api/feedback/status")
        self.assertTrue(payload["loggedIn"])
        con = sqlite3.connect(UPSTREAM_DB, timeout=10)
        con.execute("DELETE FROM sessions")
        con.commit()
        con.close()
        # 会话被撤销后，一次列表请求应触发网关自动重新登录并成功
        status, _, payload = self.get_json("/api/feedback/comments?status=pending")
        self.assertEqual(status, 200)
        self.assertGreater(payload.get("total", 0), 0, "401后应自动重新登录并成功读取")

    def test_UP_05_上游403明确报错(self):
        # 真实会话 + 错误CSRF → 上游拒绝审核操作（403），不得静默重试或降级
        feedback_module.ensure_upstream_session(self.server.state)
        real_cookie = self.server.state.feedback_session["cookie"]
        with mock.patch.object(feedback_module, "_auth_headers",
                               return_value={"Cookie": f"lidaiji_admin={real_cookie}", "X-CSRF-Token": "wrong-csrf"}):
            with self.assertRaises(feedback_module.FeedbackFailure) as ctx:
                feedback_module.moderate(self.server.state, "comment_test_approved_1", "delete", "403测试")
        self.assertEqual(ctx.exception.code, "service-error")

    def test_UP_06_空凭据fail_closed(self):
        with mock.patch.dict(os.environ, {"LIDAIJI_COMMENTS_ADMIN_USERNAME": "x", "LIDAIJI_COMMENTS_ADMIN_PASSWORD": "   "}):
            with self.assertRaises(credentials_module.CredentialError):
                credentials_module.read_comments_credentials()

    def test_UP_07_凭据不进入浏览器(self):
        _, _, payload = self.get_json("/api/feedback/status")
        raw = json.dumps(payload)
        self.assertNotIn("test-upstream-password-0123456789", raw)
        self.assertNotIn("password", raw)

    # -- ADMIN-* 管理功能回归 --------------------------------------------------

    def test_ADMIN_01_评论列表(self):
        status, _, payload = self.get_json("/api/feedback/comments?status=pending")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload.get("total", 0), 2)

    def test_ADMIN_02_scope筛选(self):
        status, _, payload = self.get_json("/api/feedback/comments?status=pending&scope=paragraph")
        self.assertEqual(status, 200)
        for comment in payload.get("comments", []):
            self.assertEqual(comment["scope"], "paragraph")

    def test_ADMIN_03_source筛选(self):
        status, _, payload = self.get_json("/api/feedback/comments?status=pending&source=website")
        self.assertEqual(status, 200)
        for comment in payload.get("comments", []):
            self.assertEqual(comment["source_type"], "website")

    def test_ADMIN_04_批准(self):
        status, _, payload = self.post_json("/api/feedback/moderate", {"id": "comment_test_pending_2", "action": "approve", "reason": "测试"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "approved")

    def test_ADMIN_05_拒绝(self):
        status, _, payload = self.post_json("/api/feedback/moderate", {"id": "comment_test_pending_1", "action": "reject", "reason": "测试"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "rejected")

    def test_ADMIN_06_删除需确认(self):
        status, _, _ = self.post_json("/api/feedback/moderate", {"id": "comment_test_pending_1", "action": "delete"})
        self.assertEqual(status, 400, "删除必须显式确认")
        status, _, payload = self.post_json("/api/feedback/moderate", {"id": "comment_test_pending_1", "action": "delete", "confirm": True})
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "deleted")

    def test_ADMIN_07_pending不公开(self):
        con = sqlite3.connect(UPSTREAM_DB, timeout=10)
        con.execute("INSERT OR IGNORE INTO comments(id,article_id,article_revision,paragraph_id,paragraph_excerpt,display_name,body,status,source_fingerprint,browser_fingerprint,contains_link,duplicate_hash,created_at,updated_at,scope,source_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("comment_pub_pending", UPSTREAM_ARTICLE, f"{UPSTREAM_ARTICLE}@rev1", UPSTREAM_P1, "摘录", "公开测试", "待审核公开测试正文", "pending", "s", "b", 0, "h", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z", "paragraph", "website"))
        con.commit()
        con.close()
        status, _, payload = self.get_json("/api/feedback/comments?status=pending&scope=paragraph")
        self.assertTrue(any(c["id"] == "comment_pub_pending" for c in payload.get("comments", [])), "管理端可见")
        public = json.loads(self._upstream_public(f"/api/comments/v1/articles/{UPSTREAM_ARTICLE}/paragraphs/{UPSTREAM_P1}"))
        self.assertFalse(any(c["id"] == "comment_pub_pending" for c in public.get("comments", [])), "公开接口不可见pending")

    def test_ADMIN_08_approved公开(self):
        public = json.loads(self._upstream_public("/api/comments/v1/articles/{}/article-comments?limit=20".format(UPSTREAM_ARTICLE)))
        self.assertTrue(any(c["id"] == "comment_test_approved_1" for c in public.get("comments", [])), "approved必须公开")

    def test_ADMIN_09_deleted不公开(self):
        public = json.loads(self._upstream_public("/api/comments/v1/articles/{}/article-comments?limit=20".format(UPSTREAM_ARTICLE)))
        self.assertFalse(any(c["id"] == "comment_test_deleted_1" for c in public.get("comments", [])), "deleted不得公开")

    def test_ADMIN_10_网络失败不重复操作(self):
        with mock.patch.object(feedback_module, "COMMENTS_BASE", "http://127.0.0.1:1"):
            with self.assertRaises(feedback_module.FeedbackFailure) as ctx:
                feedback_module.moderate(self.server.state, "comment_test_pending_1", "approve", "网络失败测试")
        self.assertEqual(ctx.exception.code, "service-unavailable")
        con = sqlite3.connect(UPSTREAM_DB, timeout=10)
        row = con.execute("SELECT status FROM comments WHERE id='comment_test_pending_1'").fetchone()
        con.close()
        self.assertEqual(row[0], "deleted", "网络失败后评论状态必须保持原状（不重复执行）")

    def _upstream_public(self, path: str) -> bytes:
        connection = http.client.HTTPConnection("127.0.0.1", UPSTREAM_PORT, timeout=10)
        connection.request("GET", path, headers={"Origin": "http://127.0.0.1:1313"})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return payload


if __name__ == "__main__":
    unittest.main()
