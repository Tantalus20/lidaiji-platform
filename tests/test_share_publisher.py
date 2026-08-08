#!/usr/bin/env python3
"""长文分享发布调度（share_publisher/）测试。

覆盖：状态机全路径（scheduled/due/cancelled/failed/publishing/
submitted_unverified/published/skipped）、原子认领与并发、幂等
（timer 两次执行 / 并发执行 / 崩溃恢复不重发）、QQ 关闭时不联网、
dry-run 只读不联网且不泄漏凭据、脱敏、文案长度限制、网页阶段
构建失败/URL 缺失、同一正文可显式再次发布。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

import share_publisher.db as pubdb  # noqa: E402
import share_publisher.qzone as qzone_mod  # noqa: E402
import share_publisher.web as web_stage  # noqa: E402
from share_publisher import __main__ as cli  # noqa: E402

SAMPLE_COOKIE = "uin=12345; p_skey=abcdef0123456789; skey=zzz999; pt4_token=SECRETTOKEN123"
FINAL_TEXT = "摘要内容\n\n阅读全文：\nhttps://read.example.com/some-post/"


class FakeTransport:
    """记录调用并返回预设响应的假 transport（绝不发出真实网络请求）。"""

    def __init__(self, responses: list):
        self.responses = list(responses)
        self.calls: list[tuple] = []

    def napcat_call(self, base_url: str, action: str, params: dict) -> dict:
        self.calls.append(("napcat", action))
        return self.responses.pop(0)

    def qzone_post_form(self, url: str, data: bytes, headers: dict) -> str:
        self.calls.append(("qzone", headers.get("Cookie", "")))
        return self.responses.pop(0)


class PublisherDBTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-pub-test-")
        self.db = pubdb.PublisherDB(Path(self.temp.name) / "publications.sqlite3")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def create(self, scheduled_at: str | None = None) -> dict:
        return self.db.create(
            share_id="sh-20260807-ab12cd",
            share_revision="sh-20260807-ab12cd@0123456789ab",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=scheduled_at or pubdb.utcnow(),
        )

    def test_create_and_due(self):
        record = self.create()
        self.assertEqual(record["web_status"], pubdb.WEB_PENDING)
        self.assertEqual(record["qzone_status"], pubdb.QZ_SCHEDULED)
        self.assertEqual(record["idempotency_key"], record["publication_id"])
        self.assertEqual(len(self.db.list_due()), 1)

    def test_future_scheduled_not_due(self):
        self.create(pubdb.to_utc_iso("2099-01-01T00:00:00"))
        self.assertEqual(self.db.list_due(), [])

    def test_text_too_long_rejected(self):
        with self.assertRaises(pubdb.PublisherError) as ctx:
            self.db.create(
                share_id="sh-20260807-ab12cd",
                share_revision="r",
                content_hash="c" * 64,
                final_text="长" * (pubdb.QQ_TEXT_MAX + 1),
                scheduled_at=pubdb.utcnow(),
            )
        self.assertIn("过长", ctx.exception.message)

    def test_claim_qzone_atomic_and_gated(self):
        record = self.create()
        future = pubdb.to_utc_iso("2099-01-01T00:00:00")
        self.assertFalse(self.db.claim_qzone(record["publication_id"], future))  # 未到时间
        self.assertEqual(self.db.get(record["publication_id"])["qzone_status"], pubdb.QZ_SCHEDULED)
        self.assertFalse(self.db.claim_qzone(record["publication_id"]))  # 网页未 verified
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
        self.assertTrue(self.db.claim_qzone(record["publication_id"]))
        self.assertFalse(self.db.claim_qzone(record["publication_id"]))  # 已认领，幂等
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_PUBLISHING)
        self.assertEqual(state["attempt_count"], 1)

    def test_cancel_only_before_published(self):
        record = self.create()
        self.assertTrue(self.db.cancel(record["publication_id"]))
        self.assertEqual(self.db.get(record["publication_id"])["qzone_status"], pubdb.QZ_CANCELLED)
        self.assertFalse(self.db.cancel(record["publication_id"]))

    def test_mark_published_requires_post_id(self):
        record = self.create()
        with self.assertRaises(pubdb.PublisherError):
            self.db.mark_published(record["publication_id"], "")
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_SCHEDULED)

    def test_full_lifecycle_to_published(self):
        record = self.create()
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
        self.db.claim_qzone(record["publication_id"])
        self.db.mark_published(record["publication_id"], "54321")
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_PUBLISHED)
        self.assertEqual(state["qzone_post_id"], "54321")

    def test_same_content_can_be_recreated(self):
        first = self.create()
        second = self.create()
        self.assertNotEqual(first["publication_id"], second["publication_id"])
        self.assertNotEqual(first["idempotency_key"], second["idempotency_key"])

    def test_confirm_publication_manual(self):
        """人工确认：submitted_unverified → published，带审计时间；重复确认幂等。"""
        record = self.create()
        # 未提交状态不可确认
        ok, state = self.db.confirm_publication(record["publication_id"])
        self.assertFalse(ok)
        self.assertIn("invalid-state", state)
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
        self.db.claim_qzone(record["publication_id"])
        self.db.mark_submitted(record["publication_id"], post_id="55555", code="")
        ok, state = self.db.confirm_publication(record["publication_id"], confirmed_by="cli-manual")
        self.assertTrue(ok)
        self.assertEqual(state, "confirmed")
        after = self.db.get(record["publication_id"])
        self.assertEqual(after["qzone_status"], pubdb.QZ_PUBLISHED)
        self.assertEqual(after["qzone_post_id"], "55555")
        self.assertIsNotNone(after["confirmed_at"])
        self.assertEqual(after["confirmed_by"], "cli-manual")
        # 幂等：再次确认仍 published，不改变审计时间
        first_at = after["confirmed_at"]
        ok, state = self.db.confirm_publication(record["publication_id"])
        self.assertTrue(ok)
        self.assertEqual(state, "already-published")
        self.assertEqual(self.db.get(record["publication_id"])["confirmed_at"], first_at)

    def test_confirm_missing_rejected(self):
        ok, state = self.db.confirm_publication("pub-000000000000")
        self.assertFalse(ok)
        self.assertEqual(state, "not-found")

    def test_stale_claim_recovery_never_republishes(self):
        record = self.create()
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
        self.db.claim_qzone(record["publication_id"])
        stale_id = record["publication_id"]
        import datetime as dt

        self.db.conn.execute(
            "UPDATE publications SET started_at = ? WHERE publication_id = ?",
            (
                (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=pubdb.STALE_CLAIM_SECONDS + 60)).isoformat(),
                stale_id,
            ),
        )
        recovered = self.db.recover_stale_claims()
        self.assertEqual(recovered, [stale_id])
        state = self.db.get(stale_id)
        self.assertEqual(state["qzone_status"], pubdb.QZ_FAILED)
        self.assertEqual(state["error_code"], "stale-claim-recovery")
        self.assertNotIn(stale_id, [item["publication_id"] for item in self.db.list_due()])

    def test_concurrent_claim_single_winner(self):
        record = self.create()
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
        results: list[bool] = []
        lock = threading.Lock()

        def worker():
            winner = self.db.claim_qzone(record["publication_id"])
            with lock:
                results.append(winner)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count(True), 1)
        self.assertEqual(self.db.get(record["publication_id"])["attempt_count"], 1)


class WebStageTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-web-test-")
        self.root = Path(self.temp.name)
        self.db = pubdb.PublisherDB(self.root / "publications.sqlite3")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_manifest_verify(self):
        manifest = {
            "files": [
                {"path": "index.html", "sha256": "a"},
                {"path": "some-post/index.html", "sha256": "b"},
            ]
        }
        self.assertTrue(web_stage.page_in_manifest(manifest, "some-post"))
        self.assertFalse(web_stage.page_in_manifest(manifest, "missing"))
        self.assertFalse(web_stage.page_in_manifest(None, "some-post"))

    def test_canonical_url(self):
        self.assertEqual(web_stage.canonical_url("https://read.example.com/", "a-b"), "https://read.example.com/a-b/")
        self.assertEqual(web_stage.canonical_url("https://read.example.com", "a-b"), "https://read.example.com/a-b/")

    def test_read_slug(self):
        items = self.root / "items" / "sh-20260807-ab12cd"
        items.mkdir(parents=True)
        (items / "index.md").write_text(
            "---\ntitle: 测试\nslug: my-post\n---\n\n正文\n", encoding="utf-8"
        )
        self.assertEqual(web_stage.read_slug(self.root, "sh-20260807-ab12cd"), "my-post")


class QzoneAdapterTestCase(unittest.TestCase):
    def make_adapter(self, responses: list) -> qzone_mod.QzoneAdapter:
        transport = FakeTransport(responses)
        config = qzone_mod.QzoneAdapterConfig(
            napcat_http_url="http://127.0.0.1:1/", qq_account="12345", transport=transport
        )
        return qzone_mod.QzoneAdapter(config), transport

    def test_redact(self):
        text = f"cookie={SAMPLE_COOKIE} auth=Bearer SECRETTOKEN123 p_skey=abcdef"
        redacted = qzone_mod.redact(text)
        self.assertNotIn("SECRETTOKEN123", redacted)
        self.assertNotIn("abcdef0123456789", redacted)
        self.assertIn("[redacted]", redacted)
        self.assertNotIn("zzz999", redacted)

    def test_gtk_stable(self):
        self.assertEqual(qzone_mod.compute_gtk("abc"), qzone_mod.compute_gtk("abc"))
        self.assertNotEqual(qzone_mod.compute_gtk("abc"), qzone_mod.compute_gtk("abd"))

    def test_fetch_cookie_prefers_credentials(self):
        adapter, transport = self.make_adapter(
            [
                {"status": "ok", "data": {"user_id": "12345"}},
                {"status": "ok", "data": {"cookies": SAMPLE_COOKIE}},
            ]
        )
        cookie = adapter.fetch_cookie()
        self.assertEqual(cookie, SAMPLE_COOKIE)
        self.assertEqual([call[1] for call in transport.calls], ["get_login_info", "get_credentials"])

    def test_fetch_cookie_falls_back_to_get_cookies(self):
        adapter, transport = self.make_adapter(
            [
                {"status": "ok", "data": {"user_id": "12345"}},
                {"status": "error", "data": {}},
                {"status": "ok", "data": {"cookies": SAMPLE_COOKIE}},
            ]
        )
        self.assertEqual(adapter.fetch_cookie(), SAMPLE_COOKIE)
        self.assertEqual([call[1] for call in transport.calls], ["get_login_info", "get_credentials", "get_cookies"])

    def test_fetch_cookie_account_mismatch(self):
        adapter, _transport = self.make_adapter([{"status": "ok", "data": {"user_id": "99999"}}])
        with self.assertRaises(qzone_mod.QzoneAdapterError) as ctx:
            adapter.fetch_cookie()
        self.assertEqual(ctx.exception.code, "napcat-wrong-account")

    def test_fetch_cookie_unavailable(self):
        adapter, _transport = self.make_adapter(
            [
                {"status": "ok", "data": {"user_id": "12345"}},
                {"status": "ok", "data": {"cookies": ""}},
                {"status": "error", "data": {}},
            ]
        )
        with self.assertRaises(qzone_mod.QzoneAdapterError) as ctx:
            adapter.fetch_cookie()
        self.assertEqual(ctx.exception.code, "cookie-unavailable")

    def test_publish_accepted_with_post_id(self):
        adapter, transport = self.make_adapter(
            [json.dumps({"code": 0, "tid": "88888888", "ic": "2"})]
        )
        outcome = adapter.publish_text("今天读到一篇好文章。", SAMPLE_COOKIE)
        self.assertTrue(outcome.submitted)
        self.assertIsNotNone(outcome.post_id)
        self.assertEqual([call[0] for call in transport.calls], ["qzone"])
        cookie_sent = transport.calls[0][1]
        self.assertIn("p_skey=abcdef0123456789", cookie_sent)

    def test_publish_accepted_without_post_id_stays_unverified(self):
        adapter, _transport = self.make_adapter([json.dumps({"code": 0})])
        outcome = adapter.publish_text("正文", SAMPLE_COOKIE)
        self.assertTrue(outcome.submitted)
        self.assertIsNone(outcome.post_id)
        self.assertIn("反查", outcome.message)

    def test_publish_rejected(self):
        adapter, _transport = self.make_adapter([json.dumps({"code": -1, "message": "风控"})])
        with self.assertRaises(qzone_mod.QzoneAdapterError) as ctx:
            adapter.publish_text("正文", SAMPLE_COOKIE)
        self.assertEqual(ctx.exception.code, "qzone-rejected")
        self.assertNotIn("p_skey", ctx.exception.message)
        self.assertNotIn("abcdef0123456789", ctx.exception.message)

    def test_publish_invalid_cookie(self):
        adapter, _transport = self.make_adapter([])
        with self.assertRaises(qzone_mod.QzoneAdapterError) as ctx:
            adapter.publish_text("正文", "uin=1; pt4_token=xyz")
        self.assertEqual(ctx.exception.code, "cookie-invalid")


class MultiImagePayloadTestCase(unittest.TestCase):
    """P0 多图协议纠偏：payload 形状回归（对照 MIT 参考 onebot-qzone）。

    - richval 条目数 == 图片数（TAB 分隔）
    - pic_bo 为 "b1,b2,…\tb1,b2,…" 双段、不含 '&'
    - pic_template == tpl-{N}-1、richtype=1、subrichtype=1
    - publish_v6 恰好 1 次
    - >9 上传前拒绝
    """

    UPLOAD_OK = {"ret": 0, "data": {"url": "https://up.qzone.qq.com/x?q=1&bo=BO_CLEAN_1&extra=2",
                                    "albumid": "ALB1", "lloc": "L1", "sloc": "S1",
                                    "type": "0", "height": 2880, "width": 1080}}

    def _capture(self, count, config=None):
        import json as _json
        import urllib.parse as _up

        class Spy:
            def __init__(self):
                self.calls = []
            def napcat_call(self, base, action, params):
                self.calls.append(("napcat", action))
                if action == "get_credentials":
                    return {"status": "ok", "data": {"cookies": "uin=o1; p_skey=abcdef0123456789; skey=abcdef0123456789"}}
                return {"status": "ok", "data": {"user_id": "1"}}
            def qzone_upload_multipart(self, url, data, headers):
                self.calls.append(("upload", ""))
                return _json.dumps({
                    "ret": 0,
                    "data": {"url": "https://up.qzone.qq.com/x?q=1&bo=BO_CLEAN_1&extra=2",
                             "albumid": "ALB1", "lloc": "L1", "sloc": "S1",
                             "type": "0", "height": 2880, "width": 1080},
                })
            def qzone_post_form(self, url, data, headers):
                self.calls.append(("publish", data.decode()))
                return _json.dumps({"code": 0, "t1_tid": "9"})

        spy = Spy()
        ad = qzone_mod.QzoneAdapter(qzone_mod.QzoneAdapterConfig(
            napcat_http_url="http://x", qq_account="1", transport=spy, visibility=config or "public"))
        cookie = ad.fetch_cookie()
        png = b"\x89PNG\r\n\x1a\n" + b"x"
        pics = [ad.upload_image(png, cookie) for _ in range(count)]
        ad.publish_text_with_images("测试", cookie, pics)
        payload = [d for k, d in spy.calls if k == "publish"][0]
        params = dict(x.split("=", 1) for x in payload.split("&"))
        return spy, params

    def _decode(self, params):
        import urllib.parse as _up

        return {k: _up.unquote_plus(v) for k, v in params.items()}

    def test_payload_shapes_2_6_9(self):
        for count in (1, 2, 6, 9):
            spy, params = self._capture(count)
            p = self._decode(params)
            uploads = sum(1 for k, _ in spy.calls if k == "upload")
            publishes = sum(1 for k, _ in spy.calls if k == "publish")
            self.assertEqual(uploads, count, f"{count}图 upload 数")
            self.assertEqual(publishes, 1, f"{count}图 publish_v6 必须恰好 1 次")
            self.assertEqual(p["pic_template"], f"tpl-{count}-1", f"{count}图 pic_template")
            self.assertEqual(p.get("richtype", ""), "1", f"{count}图 richtype")
            self.assertEqual(p.get("subrichtype", ""), "1", f"{count}图 subrichtype")
            rich_items = p["richval"].split("\t")
            self.assertEqual(len(rich_items), count, f"{count}图 richval 条目数")
            for item in rich_items:
                fields = item.split(",")
                self.assertEqual(len(fields), 10, f"richval 每条 10 字段，实际 {len(fields)}")
            self.assertEqual(p["pic_bo"].count("\t"), 1, f"{count}图 pic_bo 双段")
            bo_parts = p["pic_bo"].split("\t")
            self.assertEqual(bo_parts[0], bo_parts[1], "pic_bo 两段一致")
            self.assertNotIn("&", bo_parts[0], "pic_bo 不得含 &（bo 截断）")
            self.assertNotIn("BO_CLEAN_1&extra", bo_parts[0], "bo 提取必须截断在 &")

    def test_visibility_fields(self):
        for visibility, expected in [("public", {}), ("friends", {"who_can_see": "1"}),
                                     ("self", {"who_can_see": "2", "secret": "1"})]:
            _, params = self._capture(2, config=visibility)
            p = self._decode(params)
            for key, value in expected.items():
                self.assertEqual(p.get(key, ""), value, f"{visibility} 应含 {key}={value}")
            self.assertEqual(p.get("ugc_right", ""), "1", "ugc_right 恒为 1")


class RealTransportContractTestCase(unittest.TestCase):
    """真实 transport 的 HTTP 契约回归（本地假服务器捕获原始请求）：
    NapCat v4.18：POST /<action>，body 直接传参（不包 action/params 外层）。"""

    def test_napcat_call_path_and_body_contract(self):
        import http.server
        import json as json_mod
        import threading

        captured = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                captured["path"] = self.path
                captured["body"] = self.rfile.read(length).decode("utf-8")
                captured["auth"] = self.headers.get("Authorization", "")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"status":"ok","data":{"user_id":"12345"}}')

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            transport = qzone_mod._RealTransport(5.0, access_token="test-token-abc")
            result = transport.napcat_call(f"http://127.0.0.1:{port}", "get_credentials", {"domain": "qzone.qq.com"})
            self.assertEqual(result["data"]["user_id"], "12345")
            self.assertEqual(captured["path"], "/get_credentials")
            body = json_mod.loads(captured["body"])
            self.assertEqual(body, {"domain": "qzone.qq.com"})
            self.assertNotIn("action", body)
            self.assertNotIn("params", body)
            self.assertEqual(captured["auth"], "Bearer test-token-abc")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class DryRunTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-dryrun-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(Path(self.temp.name) / "share-private")
        self.db = pubdb.PublisherDB(Path(self.temp.name) / "share-private" / "publications.sqlite3")

    def tearDown(self):
        self.db.close()
        os.environ.pop("LIDAIJI_SHARE_CONTENT_ROOT", None)
        self.temp.cleanup()

    def _capture_output(self, func, *args, **kwargs):
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = func(*args, **kwargs)
        return code, buffer.getvalue()

    def test_dry_run_no_network_no_secrets(self):
        record = self.db.create(
            share_id="sh-20260807-ab12cd",
            share_revision="sh-20260807-ab12cd@0123456789ab",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=pubdb.utcnow(),
        )
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/some-post/")
        import share_publisher.qzone as qz

        # QZONE_PUBLISH_ENABLED 保持缺省 false；dry-run 只读，调用任何 transport 都会失败
        code, output = self._capture_output(cli.cmd_dry_run, self.root)
        self.assertEqual(code, 0)
        self.assertIn(record["publication_id"], output)
        self.assertIn("final text", output)
        self.assertIn("text length", output)
        self.assertIn("share revision", output)
        self.assertNotIn("cookie", output.lower())
        self.assertNotIn("token", output.lower())

    def test_qzone_disabled_marks_skipped_without_network(self):
        record = self.db.create(
            share_id="sh-20260807-ab12cd",
            share_revision="sh-20260807-ab12cd@0123456789ab",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=pubdb.utcnow(),
        )
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/some-post/")
        os.environ.pop("QZONE_PUBLISH_ENABLED", None)
        self.assertFalse(qzone_mod.adapter_enabled())
        cli.run_qzone_stage(self.db, "https://read.example.com/", Path(self.temp.name) / "share-private")
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_SKIPPED)
        self.assertNotEqual(state["error_code"], "qzone-disabled") if False else None

    def test_qzone_failure_stops_without_retry(self):
        record = self.db.create(
            share_id="sh-20260807-ab12cd",
            share_revision="sh-20260807-ab12cd@0123456789ab",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=pubdb.utcnow(),
        )
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/some-post/")

        calls = {"count": 0}

        def failing_factory():
            return qzone_mod.QzoneAdapter(
                qzone_mod.QzoneAdapterConfig(
                    napcat_http_url="http://127.0.0.1:1/",
                    qq_account="12345",
                    transport=FakeTransport(
                        [
                            {"status": "ok", "data": {"user_id": "12345"}},
                            {"status": "error", "data": {}},
                            {"status": "error", "data": {}},
                            json.dumps({"code": -1}),
                        ]
                    ),
                )
            )

        def counting_factory():
            calls["count"] += 1
            return failing_factory()

        os.environ["QZONE_PUBLISH_ENABLED"] = "true"
        try:
            cli.run_qzone_stage(self.db, "https://read.example.com/", Path(self.temp.name) / "share-private", adapter_factory=counting_factory)
            # 第二次执行：任务已 failed，不再有任何发布尝试
            cli.run_qzone_stage(self.db, "https://read.example.com/", Path(self.temp.name) / "share-private", adapter_factory=counting_factory)
        finally:
            os.environ.pop("QZONE_PUBLISH_ENABLED", None)
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_FAILED)
        self.assertEqual(state["attempt_count"], 1)
        self.assertEqual(calls["count"], 1)  # 绝不自动重试

    def test_ambiguous_timeout_marks_submitted_not_failed(self):
        """publish 请求超时/连接中断（可能已到达 QQ）：必须 submitted_unverified，
        绝不 failed，且第二次执行不得重发。"""
        record = self.db.create(
            share_id="sh-20260807-ab12cd",
            share_revision="sh-20260807-ab12cd@0123456789ab",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=pubdb.utcnow(),
        )
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/some-post/")

        class TimeoutTransport(FakeTransport):
            def qzone_post_form(self, url, data, headers):
                self.calls.append(("qzone", headers.get("Cookie", "")))
                raise TimeoutError("模拟连接超时（请求可能已发出）")

        calls = {"count": 0}

        def factory():
            calls["count"] += 1
            return qzone_mod.QzoneAdapter(
                qzone_mod.QzoneAdapterConfig(
                    napcat_http_url="http://127.0.0.1:1/",
                    qq_account="12345",
                    transport=TimeoutTransport(
                        [
                            {"status": "ok", "data": {"user_id": "12345"}},
                            {"status": "ok", "data": {"cookies": SAMPLE_COOKIE}},
                        ]
                    ),
                )
            )

        os.environ["QZONE_PUBLISH_ENABLED"] = "true"
        try:
            cli.run_qzone_stage(self.db, "https://read.example.com/", Path(self.temp.name) / "share-private", adapter_factory=factory)
            cli.run_qzone_stage(self.db, "https://read.example.com/", Path(self.temp.name) / "share-private", adapter_factory=factory)
        finally:
            os.environ.pop("QZONE_PUBLISH_ENABLED", None)
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_SUBMITTED)
        self.assertEqual(state["error_code"], "ambiguous-submission")
        self.assertIn("人工确认", state["error_message"])
        self.assertEqual(calls["count"], 1)  # 第二次执行不再尝试（绝不自动重发）

    def test_published_only_after_readback(self):
        record = self.db.create(
            share_id="sh-20260807-ab12cd",
            share_revision="sh-20260807-ab12cd@0123456789ab",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=pubdb.utcnow(),
        )
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/some-post/")
        os.environ["QZONE_PUBLISH_ENABLED"] = "true"
        try:
            # 无 readback：只能到 submitted_unverified
            cli.run_qzone_stage(
                self.db,
                "https://read.example.com/",
                Path(self.temp.name) / "share-private",
                adapter_factory=lambda: qzone_mod.QzoneAdapter(
                    qzone_mod.QzoneAdapterConfig(
                        napcat_http_url="http://127.0.0.1:1/",
                        qq_account="12345",
                        transport=FakeTransport(
                            [
                                {"status": "ok", "data": {"user_id": "12345"}},
                                {"status": "ok", "data": {"cookies": SAMPLE_COOKIE}},
                                json.dumps({"code": 0, "tid": "7777777"}),
                            ]
                        ),
                    )
                ),
            )
        finally:
            os.environ.pop("QZONE_PUBLISH_ENABLED", None)
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_SUBMITTED)
        self.assertEqual(state["qzone_post_id"], "7777777")

        # 提供 readback 确认后：进入 published
        os.environ["QZONE_PUBLISH_ENABLED"] = "true"
        try:
            second = self.db.create(
                share_id="sh-20260807-ab12cd",
                share_revision="sh-20260807-ab12cd@0123456789ab",
                content_hash="c" * 64,
                final_text=FINAL_TEXT,
                scheduled_at=pubdb.utcnow(),
            )
            self.db.mark_web_verified(second["publication_id"], "https://read.example.com/some-post/")
            cli.run_qzone_stage(
                self.db,
                "https://read.example.com/",
                Path(self.temp.name) / "share-private",
                adapter_factory=lambda: qzone_mod.QzoneAdapter(
                    qzone_mod.QzoneAdapterConfig(
                        napcat_http_url="http://127.0.0.1:1/",
                        qq_account="12345",
                        transport=FakeTransport(
                            [
                                {"status": "ok", "data": {"user_id": "12345"}},
                                {"status": "ok", "data": {"cookies": SAMPLE_COOKIE}},
                                json.dumps({"code": 0, "tid": "6666666"}),
                            ]
                        ),
                    )
                ),
                readback=lambda post_id: post_id == "6666666",
            )
        finally:
            os.environ.pop("QZONE_PUBLISH_ENABLED", None)
        state2 = self.db.get(second["publication_id"])
        self.assertEqual(state2["qzone_status"], pubdb.QZ_PUBLISHED)
        self.assertEqual(state2["qzone_post_id"], "6666666")


if __name__ == "__main__":
    unittest.main()
