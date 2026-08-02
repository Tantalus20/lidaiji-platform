#!/usr/bin/env python3
"""作者工作台第三阶段：Git 集成（studio/versions.py）与发布中心（publish_center）测试。

临时目录 ``git init`` 后建仓（临时仓库内允许 commit），覆盖：
status/log/diff 读取、git 缺失与非仓库错误码、commit 校验与成功路径、
ref 注入拒绝、preflight 参数与超时、发布闸门（confirm/preflight/缺配置）、
配置值不泄露、新 POST 接口 CSRF 回归。
"""

from __future__ import annotations

import http.client
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import studio.publish_center as publish_center  # noqa: E402
import studio.server as studio_server  # noqa: E402
import studio.versions as versions  # noqa: E402

studio_server.StudioHandler.log_message = lambda *args: None  # 测试中静默访问日志

FRONT_MATTER = """---
title: 测试文章
slug: ce-shi
date: 2026-07-01
draft: true
articleId: article-test-versions
articleRevision: article-test-versions@000000000000
---

第一段正文。
"""


def git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


def init_repo(root: Path) -> None:
    git(root, "init")
    git(root, "config", "user.name", "测试")
    git(root, "config", "user.email", "test@example.com")


ARTICLE_REL = "content/essays/ce-shi/index.md"


class StudioVersionsTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="studio-versions-test-")
        self.root = Path(self.temp.name)
        article = self.root / ARTICLE_REL
        article.parent.mkdir(parents=True)
        article.write_text(FRONT_MATTER, encoding="utf-8")
        init_repo(self.root)
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", "初始提交")
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

    def rewrite_article(self, extra: str = "\n新增的一行。\n") -> None:
        path = self.root / ARTICLE_REL
        path.write_text(path.read_text(encoding="utf-8") + extra, encoding="utf-8")

    # -- Git 只读 ------------------------------------------------------------

    def test_01干净仓库状态(self):
        status, payload = self.get_json("/api/git/status")
        self.assertEqual(status, 200)
        self.assertTrue(payload["status"]["clean"])
        self.assertTrue(payload["status"]["branch"])
        self.assertEqual(payload["status"]["files"], [])
        self.assertEqual(payload["status"]["suggestion"], "")

    def test_02未提交文件与建议文案(self):
        self.rewrite_article()
        (self.root / "content" / "essays" / "note.txt").write_text("未跟踪", encoding="utf-8")
        status, payload = self.get_json("/api/git/status")
        self.assertEqual(status, 200)
        files = {item["path"]: item for item in payload["status"]["files"]}
        self.assertFalse(payload["status"]["clean"])
        self.assertEqual(files[ARTICLE_REL]["status"], "M")
        self.assertTrue(files[ARTICLE_REL]["mtime"])
        self.assertEqual(files["content/essays/note.txt"]["status"], "?")
        self.assertIn("测试文章", payload["status"]["suggestion"])

    def test_03文章提交历史(self):
        status, payload = self.get_json(f"/api/git/log?path={ARTICLE_REL}")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["commits"]), 1)
        self.assertEqual(payload["commits"][0]["subject"], "初始提交")
        self.rewrite_article()
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", "第二次提交")
        status, payload = self.get_json(f"/api/git/log?path={ARTICLE_REL}&limit=10")
        self.assertEqual(status, 200)
        self.assertEqual([c["subject"] for c in payload["commits"]], ["第二次提交", "初始提交"])

    def test_04工作树与指定提交diff(self):
        self.rewrite_article()
        status, payload = self.get_json(f"/api/git/diff?path={ARTICLE_REL}")
        self.assertEqual(status, 200)
        self.assertIn("diff --git", payload["result"]["diff"])
        self.assertIn("+新增的一行。", payload["result"]["diff"])
        self.assertFalse(payload["result"]["truncated"])
        # 指定提交：初始提交包含整个新文件
        first = git(self.root, "rev-list", "--max-parents=0", "HEAD").stdout.strip()
        status, payload = self.get_json(f"/api/git/diff?path={ARTICLE_REL}&ref={first}")
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["commit"]["subject"], "初始提交")
        self.assertIn("+第一段正文。", payload["result"]["diff"])

    def test_05未跟踪文件diff提示(self):
        new_rel = "content/essays/new-article.md"
        (self.root / new_rel).write_text("全新文件", encoding="utf-8")
        status, payload = self.get_json(f"/api/git/diff?path={new_rel}")
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["diff"], "")
        self.assertIn("尚未纳入版本管理", payload["result"]["note"])

    def test_06git缺失返回git_unavailable(self):
        with mock.patch.object(versions.subprocess, "run", side_effect=FileNotFoundError):
            status, payload = self.get_json("/api/git/status")
        self.assertEqual(status, 500)
        self.assertEqual(payload["error"]["code"], "git-unavailable")

    def test_07非git目录返回not_a_repo(self):
        plain = tempfile.TemporaryDirectory(prefix="studio-plain-")
        self.addCleanup(plain.cleanup)
        plain_root = Path(plain.name)
        (plain_root / "content").mkdir()
        server = studio_server.create_server(plain_root, port=0)
        host, port = server.server_address[:2]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(host, port, timeout=30)
            connection.request(
                "GET",
                "/api/git/status",
                headers={
                    "Cookie": f"{studio_server.STUDIO_SESSION_COOKIE}={server.state.studio_session_token}"
                },
            )
            payload = json.loads(connection.getresponse().read())
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        self.assertEqual(payload["error"]["code"], "not-a-repo")

    # -- Git 提交（唯一写入口） ---------------------------------------------

    def test_08commit参数校验(self):
        self.rewrite_article()
        bad_calls = [
            ({"files": [ARTICLE_REL], "message": ""}, "提交信息不能为空"),
            ({"files": [ARTICLE_REL], "message": "   "}, "提交信息不能为空"),
            ({"files": [], "message": "x"}, "请先勾选要提交的文件"),
            ({"files": ["--help"], "message": "x"}, "非法"),
            ({"files": ["-c"], "message": "x"}, "非法"),
            ({"files": ["../x"], "message": "x"}, "非法片段"),
            ({"files": ["/etc/passwd"], "message": "x"}, "相对路径"),
            ({"files": ["content/essays/not-changed.md"], "message": "x"}, "未提交列表"),
        ]
        for body, hint in bad_calls:
            status, payload = self.post_json("/api/git/commit", body)
            self.assertEqual(status, 400, f"{body} 应 400")
            self.assertIn(hint, payload["error"]["message"], f"{body} 提示应含 {hint}")
        status, payload = self.post_json("/api/git/commit", {"files": [ARTICLE_REL], "message": "长" * 501})
        self.assertEqual(status, 400)

    def test_09commit成功后log可见(self):
        self.rewrite_article()
        status, payload = self.post_json(
            "/api/git/commit", {"files": [ARTICLE_REL], "message": "工作站提交测试"}
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["commit"]["subject"], "工作站提交测试")
        self.assertEqual(len(payload["commit"]["hash"]), 40)
        status, payload = self.get_json(f"/api/git/log?path={ARTICLE_REL}")
        self.assertEqual(payload["commits"][0]["subject"], "工作站提交测试")
        status, payload = self.get_json("/api/git/status")
        self.assertTrue(payload["status"]["clean"])

    def test_10ref注入一律拒绝(self):
        for ref in [";rm -rf /", "--all", "HEAD~1 && echo", "abcd"]:
            status, payload = self.get_json(f"/api/git/diff?ref={ref.replace(' ', '%20')}")
            self.assertEqual(status, 400, f"应拒绝 ref={ref}")
            self.assertEqual(payload["error"]["code"], "validation-failed")

    # -- 发布中心 ------------------------------------------------------------

    def test_11publish_status不泄露配置值(self):
        (self.root / ".author-settings").write_text(
            "WRITING_SSH_TARGET=root@203.0.113.9\nWRITING_DOMAIN=secret-domain.example.com\nOTHER_KEY=x\n",
            encoding="utf-8",
        )
        (self.root / "VERSION").write_text("9.9.9\n", encoding="utf-8")
        (self.root / "CHANGELOG.md").write_text(
            "# 更新记录\n\n## V9.9.9 测试版本\n\n- 条目一\n\n## V9.9.8 旧版本\n",
            encoding="utf-8",
        )
        status, payload = self.get_json("/api/publish/status")
        self.assertEqual(status, 200)
        body = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("203.0.113.9", body)
        self.assertNotIn("secret-domain.example.com", body)
        settings = payload["status"]["settings"]
        self.assertTrue(settings["configured"])
        self.assertTrue(settings["filePresent"])
        self.assertEqual(payload["status"]["version"], "9.9.9")
        self.assertEqual(payload["status"]["changelog"][0]["version"], "V9.9.9")
        self.assertEqual(payload["status"]["changelog"][0]["title"], "测试版本")
        self.assertTrue(payload["status"]["commits"])  # git log 摘要

    def test_12preflight跑的是build与check脚本(self):
        (self.root / "scripts").mkdir(exist_ok=True)
        (self.root / "scripts" / "build.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        (self.root / "scripts" / "check.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        calls = []

        class Result:
            returncode = 0
            stdout = "构建成功\n"
            stderr = ""

        def fake_run(args, **kwargs):
            calls.append(args)
            return Result()

        with mock.patch.object(publish_center.subprocess, "run", side_effect=fake_run):
            status, payload = self.post_json("/api/publish/preflight", {"full": False})
            self.assertEqual(status, 200)
            self.assertTrue(payload["preflight"]["success"])
            self.assertEqual(calls[-1], ["bash", "scripts/build.sh"])
            self.assertGreater(self.server.state.preflight_ok_at, 0)
            status, payload = self.post_json("/api/publish/preflight", {"full": True})
            self.assertEqual(calls[-1], ["bash", "scripts/check.sh"])

    def test_13发布闸_confirm与preflight(self):
        # 缺 confirm → 400
        status, payload = self.post_json("/api/publish/run", {})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "confirmation-required")
        # 有 confirm 但本会话没有成功 preflight → 409
        status, payload = self.post_json("/api/publish/run", {"confirm": True})
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"]["code"], "preflight-required")
        # preflight 过期（31 分钟前）→ 409
        self.server.state.preflight_ok_at = time.time() - 31 * 60
        status, payload = self.post_json("/api/publish/run", {"confirm": True})
        self.assertEqual(status, 409)

    def test_14发布缺配置不启动(self):
        self.server.state.preflight_ok_at = time.time()
        (self.root / "scripts").mkdir(exist_ok=True)
        (self.root / "scripts" / "publish.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        (self.root / ".author-settings").write_text("WRITING_SSH_TARGET=root@x\n", encoding="utf-8")
        with mock.patch.object(publish_center.subprocess, "Popen") as popen:
            status, payload = self.post_json("/api/publish/run", {"confirm": True})
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "validation-failed")
        self.assertIn("WRITING_DOMAIN", payload["error"]["message"])
        popen.assert_not_called()  # 缺配置直接报错，不启动发布脚本

    def test_15发布子进程环境与非交互(self):
        self.server.state.preflight_ok_at = time.time()
        (self.root / "scripts").mkdir(exist_ok=True)
        (self.root / "scripts" / "publish.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        (self.root / ".author-settings").write_text(
            "WRITING_SSH_TARGET=root@x\nWRITING_DOMAIN=example.com\nOTHER_KEY=不应该出现\n",
            encoding="utf-8",
        )
        captured = {}

        class FakeProcess:
            returncode = 0

            def communicate(self, timeout=None):
                return "发布完成\n", None

        def fake_popen(args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return FakeProcess()

        with mock.patch.object(publish_center.subprocess, "Popen", side_effect=fake_popen):
            status, payload = self.post_json("/api/publish/run", {"confirm": True})
        self.assertEqual(status, 200)
        self.assertTrue(payload["publish"]["success"])
        self.assertEqual(captured["args"], ["bash", "scripts/publish.sh"])
        env = captured["kwargs"]["env"]
        self.assertEqual(env["WRITING_SSH_TARGET"], "root@x")
        self.assertEqual(env["WRITING_DOMAIN"], "example.com")
        self.assertEqual(env["WRITING_ASSUME_CONFIRM"], "1")  # 界面已二次确认，跳过脚本内交互
        self.assertNotIn("OTHER_KEY", env)  # 只取 WRITING_ 前缀键
        self.assertEqual(captured["kwargs"]["stdin"], publish_center.subprocess.DEVNULL)

    # -- 安全回归 ------------------------------------------------------------

    def test_16新POST接口缺自定义头一律403(self):
        for path, body in [
            ("/api/git/commit", {"files": ["x"], "message": "x"}),
            ("/api/publish/preflight", {"full": False}),
            ("/api/publish/run", {"confirm": True}),
            ("/api/media/delete", {"path": "x"}),
        ]:
            status, _ = self.request(
                "POST", path, json.dumps(body).encode("utf-8"), {"Content-Type": "application/json"}
            )
            self.assertEqual(status, 403, f"{path} 应 403")


if __name__ == "__main__":
    unittest.main(verbosity=2)
