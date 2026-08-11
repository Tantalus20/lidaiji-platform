"""QZone 清理工具测试（fake transport，零真实网络）：TCU01–TCU08。"""

import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "importer"))

from share_publisher import qzone as qzone_mod
from share_publisher import qzone_cleanup as cleanup


def _feed_item(tid, content, created=1786439000):
    return {
        "tid": tid,
        "content": content,
        "conlist": [{"con": content, "type": 2}],
        "created_time": created,
        "ugc_right": 1,
        "secret": 0,
        "name": "测试号",
    }


class FakeNapCat:
    """fake transport：登录与凭证固定；删除成功或按指令失败。"""

    def __init__(self, posts=None, fail_delete_tids=()):
        self.posts = list(posts or [])
        self.fail_delete_tids = set(fail_delete_tids)
        self.login_info = {"status": "ok", "data": {"user_id": "10001", "nickname": "测试号"}}
        self.delete_calls = 0

    def napcat_call(self, base_url, action, params):
        if action == "get_login_info":
            return self.login_info
        if action in ("get_credentials", "get_cookies"):
            return {"status": "ok", "data": {"cookies": "uin=o10001; p_skey=abcdef0123456789; skey=abcdef0123456789"}}
        raise AssertionError(f"意外 action: {action}")

    def qzone_get(self, url, headers):
        return "cb_lidaji(" + json.dumps({"code": 0, "msglist": self.posts}) + ");"

    def qzone_post_form(self, url, data, headers):
        params = dict(part.split("=", 1) for part in data.decode().split("&"))
        tid = params.get("tid", "")
        self.delete_calls += 1
        if tid in self.fail_delete_tids:
            raise qzone_mod.QzoneAdapterError("qzone-delete-rejected", "删除接口 HTTP 500")
        self.posts = [p for p in self.posts if p.get("tid") != tid]
        return json.dumps({"code": 0})


def make_adapter(posts=None, fail_delete_tids=(), login_uin="10001", qq_account="10001"):
    fake = FakeNapCat(posts=posts, fail_delete_tids=fail_delete_tids)
    fake.login_info = {"status": "ok", "data": {"user_id": login_uin, "nickname": "x"}}
    adapter = qzone_mod.QzoneAdapter(qzone_mod.QzoneAdapterConfig(
        napcat_http_url="http://fake", qq_account=qq_account, transport=fake,
    ))
    adapter._transport = fake
    return adapter


def _post(marker="CLEANUP", i=1):
    return _feed_item(f"tid{i:02d}", f"测试动态第 {i} 条 [LIDAIJI_TEST:{marker}]", 1786439000 + i)


class CleanupToolTestCase(unittest.TestCase):

    def setUp(self):
        os.environ["QZONE_TEST_ACCOUNT_ONLY"] = "true"
        os.environ["NAPCAT_QQ"] = "10001"
        os.environ["NAPCAT_HTTP_URL"] = "http://fake"
        os.environ.pop("NAPCAT_ACCESS_TOKEN", None)

    def tearDown(self):
        for key in ("QZONE_TEST_ACCOUNT_ONLY", "NAPCAT_QQ", "NAPCAT_HTTP_URL", "NAPCAT_ACCESS_TOKEN"):
            os.environ.pop(key, None)

    # TCU01 发现测试 marker
    def test_tcu01_discovers_markers(self):
        adapter = make_adapter(posts=[_post(i=1), _post(i=2), _feed_item("tid99", "无标记的普通动态")])
        result = cleanup.run_cleanup(adapter)
        self.assertEqual([c.marker for c in result.candidates], ["CLEANUP", "CLEANUP"])
        self.assertEqual([c.tid for c in result.candidates], ["tid01", "tid02"])
        self.assertTrue(result.dry_run)

    # TCU02 无 marker 跳过
    def test_tcu02_skips_unmarked(self):
        adapter = make_adapter(posts=[_feed_item("tid01", "普通动态"), _feed_item("tid02", "再一条")])
        result = cleanup.run_cleanup(adapter)
        self.assertEqual(result.found, 0)
        self.assertEqual(render_text(result), "发现 0 条候选，无需清理。")

    # TCU03 dry-run 零删除
    def test_tcu03_dry_run_no_delete(self):
        adapter = make_adapter(posts=[_post(i=1), _post(i=2)])
        result = cleanup.run_cleanup(adapter)
        self.assertEqual(adapter._transport.delete_calls, 0)
        self.assertIn("dry-run", render_text(result))

    # TCU04 confirm 恰好删除 N 条
    def test_tcu04_confirm_deletes_exactly_n(self):
        adapter = make_adapter(posts=[_post(i=1), _post(i=2), _post(i=3)])
        result = cleanup.run_cleanup(adapter, confirm=True)
        self.assertEqual(adapter._transport.delete_calls, 3)
        self.assertEqual(sorted(result.deleted), ["tid01", "tid02", "tid03"])
        self.assertEqual(result.failed, [])
        self.assertIn("success: 3", render_text(result))

    # TCU05 重复删除零额外调用
    def test_tcu05_rerun_idempotent(self):
        adapter = make_adapter(posts=[_post(i=1)])
        cleanup.run_cleanup(adapter, confirm=True)
        calls_after_first = adapter._transport.delete_calls
        result = cleanup.run_cleanup(adapter, confirm=True)
        self.assertEqual(adapter._transport.delete_calls, calls_after_first, "重复运行不得再次删除")
        self.assertEqual(result.found, 0)

    # TCU06 正式账号拒绝执行
    def test_tcu06_refuses_non_test_account(self):
        adapter = make_adapter(posts=[_post(i=1)], login_uin="99999", qq_account="10001")
        with self.assertRaises(cleanup.CleanupError) as ctx:
            cleanup.run_cleanup(adapter)
        self.assertIn("正式账号保护", str(ctx.exception))

    def test_tcu06b_requires_flag(self):
        os.environ.pop("QZONE_TEST_ACCOUNT_ONLY")
        adapter = make_adapter(posts=[_post(i=1)])
        with self.assertRaises(cleanup.CleanupError) as ctx:
            cleanup.run_cleanup(adapter)
        self.assertIn("QZONE_TEST_ACCOUNT_ONLY", str(ctx.exception))

    # TCU07 单条删除失败继续处理
    def test_tcu07_delete_failure_continues(self):
        adapter = make_adapter(posts=[_post(i=1), _post(i=2), _post(i=3)], fail_delete_tids={"tid02"})
        result = cleanup.run_cleanup(adapter, confirm=True)
        self.assertEqual(adapter._transport.delete_calls, 3, "失败后仍应继续处理其余")
        self.assertEqual(sorted(result.deleted), ["tid01", "tid03"])
        self.assertEqual([tid for tid, _ in result.failed], ["tid02"])
        text = render_text(result)
        self.assertIn("failed: 1", text)
        self.assertIn("tid02", text)

    # TCU08 日志脱敏：不输出 Cookie/账号
    def test_tcu08_logs_redacted(self):
        adapter = make_adapter(posts=[_post(i=1)])
        original = cleanup.build_adapter
        cleanup.build_adapter = lambda root: adapter
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                cleanup.main(["--project-root", str(Path(__file__).resolve().parents[1])])
        finally:
            cleanup.build_adapter = original
        text = buf.getvalue()
        self.assertNotIn("p_skey", text)
        self.assertNotIn("abcdef0123456789", text)
        self.assertIn("发现测试动态", text)

    def test_tcu08b_marker_output_only_with_confirm_flow(self):
        adapter = make_adapter(posts=[_post(marker="LQ27", i=1)])
        result = cleanup.run_cleanup(adapter)
        text = render_text(result)
        self.assertIn("LIDAIJI_TEST:LQ27", text)


def render_text(result):
    return cleanup.render(result)


if __name__ == "__main__":
    unittest.main()
