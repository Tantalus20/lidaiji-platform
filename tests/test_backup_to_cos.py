"""自然备份归档缺陷修复定点测试（v0.5.3，全部虚构目录，绝不触碰生产）。

覆盖：current 解析与锁定、快照复制、内部符号链接拒绝、清单源自快照、
解压复验、原子生成、并发锁、断裂/越界/空 release/缺文件/损坏/切换、
路径含空格、凭据与正文不进日志。
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SCRIPT = ROOT / "deploy" / "backup" / "backup-to-cos.sh"

SITE_ID = "20260806_010101"
COMMENTS_ID = "20260806_020202"


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class BackupFixture:
    """虚构备份环境：site/comments release 树 + current 链接 + 评论 DB。"""

    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="lidaiji-backup-test-"))
        self.site_root = self.root / "site-root"
        self.comments_root = self.root / "comments-root"
        self.data_dir = self.root / "comments-data"
        self.state_dir = self.root / "state"
        self.workdir_base = self.root / "work"
        self.keep_dir = self.root / "keep"
        self.lock_file = self.root / "lock" / "backup.lock"
        self.cos_config = self.root / "cos.yaml"
        self.coscli = None
        self.coscli_log = self.root / "coscli-calls.log"
        for d in (self.site_root, self.comments_root, self.data_dir, self.state_dir,
                  self.workdir_base, self.keep_dir, self.lock_file.parent):
            d.mkdir(parents=True, exist_ok=True)
        self.cos_config.write_text("dummy: config\n", encoding="utf-8")
        os.chmod(self.cos_config, 0o600)
        self._create_db()
        self._create_release(self.site_root, SITE_ID, "site")
        self._create_release(self.comments_root, COMMENTS_ID, "comments")
        self._link_current(self.site_root, SITE_ID)
        self._link_current(self.comments_root, COMMENTS_ID)

    def _create_db(self):
        db = self.data_dir / "comments.sqlite3"
        con = sqlite3.connect(db)
        con.execute("CREATE TABLE articles (id TEXT PRIMARY KEY);")
        con.execute("CREATE TABLE paragraphs (id TEXT PRIMARY KEY);")
        con.execute("INSERT INTO articles VALUES ('article-a'), ('article-b');")
        con.execute("CREATE TABLE schema_migrations (version TEXT);")
        con.execute("INSERT INTO schema_migrations VALUES ('1'), ('2'), ('3');")
        con.commit()
        con.close()

    def _create_release(self, root: Path, rid: str, kind: str):
        rel = root / "releases" / rid
        if kind == "site":
            _write(rel / "BUILD_INFO", f"version: 0.4.3\nsourceCommit: {'a'*40}\nbuildTimestamp: T\n")
            _write(rel / "index.html", "<html><body>首页标记</body></html>")
            _write(rel / "index.xml", "<rss></rss>")
            _write(rel / "sitemap.xml", "<urlset></urlset>")
            _write(rel / "comment-manifest.json", json.dumps({"schemaVersion": 1, "articles": []}))
            _write(rel / "archives" / "index.html", "<html>归档</html>")
            _write(rel / "essays" / "fixture-a" / "index.html", "<html>文章A</html>")
            _write(rel / "css" / "site.css", "body{}")
        else:
            _write(rel / "BUILD_INFO", "version: 0.5.1\nsourceCommit: b" * 1)
            _write(rel / "package.json", json.dumps({"name": "comments", "version": "0.5.1"}))
            _write(rel / "src" / "server.js", "// entry")
            _write(rel / "migrations" / "001-initial.sql", "-- migration")

    def _link_current(self, root: Path, rid: str):
        (root / "current").symlink_to(root / "releases" / rid)

    def env(self, **extra) -> dict:
        env = dict(os.environ)
        env.update({
            "COSCLI": "/usr/bin/true",
            "COS_CONFIG": str(self.cos_config),
            "LOCK_FILE": str(self.lock_file),
            "STATE_DIR": str(self.state_dir),
            "SITE_ROOT": str(self.site_root),
            "COMMENTS_ROOT": str(self.comments_root),
            "COMMENTS_DATA_DIR": str(self.data_dir),
            "SRC_ROOT": str(self.site_root),
            "WORKDIR_BASE": str(self.workdir_base),
            "BACKUP_KEEP_DIR": str(self.keep_dir),
            "COS_BACKUP_VALIDATE_ONLY": "1",
        })
        env.update(extra)
        return env

    def run(self, extra_env: dict | None = None, expect_fail: bool = False) -> subprocess.CompletedProcess:
        result = subprocess.run(
            ["bash", str(SCRIPT)], env=self.env(**(extra_env or {})),
            capture_output=True, text=True, timeout=120,
        )
        if expect_fail:
            assert result.returncode != 0, f"预期失败但成功：{result.stdout[-500:]}"
        else:
            assert result.returncode == 0, f"预期成功但失败 rc={result.returncode}: {result.stderr[-800:]}"
        return result

    def kept_archive(self) -> Path:
        archives = sorted(self.keep_dir.glob("*.tar.gz"))
        assert archives, "KEEP_DIR 无归档"
        return archives[-1]

    def counting_coscli(self) -> Path:
        """把 coscli 替换为计数包装器：每次调用追加一行日志。"""
        wrapper = self.root / "fake-coscli.sh"
        self.coscli_log = self.root / "coscli-calls.log"
        wrapper.write_text(
            '#!/usr/bin/env bash\n'
            'echo "$*" >> "$COSCLI_LOG"\n'
            'exit 0\n', encoding="utf-8")
        wrapper.chmod(0o755)
        return wrapper

    def env(self, **extra) -> dict:
        env = dict(os.environ)
        env.update({
            "COSCLI": str(self.coscli or "/usr/bin/true"),
            "COS_CONFIG": str(self.cos_config),
            "LOCK_FILE": str(self.lock_file),
            "STATE_DIR": str(self.state_dir),
            "SITE_ROOT": str(self.site_root),
            "COMMENTS_ROOT": str(self.comments_root),
            "COMMENTS_DATA_DIR": str(self.data_dir),
            "SRC_ROOT": str(self.site_root),
            "WORKDIR_BASE": str(self.workdir_base),
            "BACKUP_KEEP_DIR": str(self.keep_dir),
            "COS_BACKUP_VALIDATE_ONLY": "1",
            "COSCLI_LOG": str(getattr(self, "coscli_log", self.root / "coscli-calls.log")),
            "FAKE_COS_MODE": getattr(self, "fake_cos_mode", "ok"),
            "FAKE_COS_ROOT": str(getattr(self, "fake_cos_root", self.root / "fake-cos")),
        })
        env.update(extra)
        return env

    def failure_marker(self) -> dict:
        marker = self.state_dir / "backup-failure.marker"
        return json.loads(marker.read_text(encoding="utf-8")) if marker.is_file() else {}

    def cleanup(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)


class BackupArchiveTests:
    """mixin：归档断言辅助。"""

    def extract(self, archive: Path) -> Path:
        out = Path(tempfile.mkdtemp(prefix="backup-extract-"))
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(out)], check=True)
        return out


class TestBackupNormalFlow(unittest.TestCase, BackupArchiveTests):
    def setUp(self):
        self.fx = BackupFixture()

    def tearDown(self):
        self.fx.cleanup()

    def test_01_current_normal_archive_contains_real_files(self):
        self.fx.run()
        archive = self.fx.kept_archive()
        members = subprocess.run(["tar", "-tzf", str(archive)], capture_output=True, text=True).stdout
        # 归档包含真实文件，而不是仅 current 链接
        lines = members.splitlines()
        self.assertIn("snapshot/site/index.html", lines)
        self.assertIn("snapshot/comments/package.json", lines)
        self.assertTrue(any(l.startswith("sqlite-backups/") for l in lines))
        self.assertIn("manifests/backup-manifest.json", lines)
        self.assertFalse(any("current" in l for l in lines), "归档不得含 current 链接")
        self.assertIn("snapshot/site/essays/fixture-a/index.html", lines)
        # 解压后内容可复算（VERIFY_ONLY 模式）
        verify = subprocess.run(
            ["bash", str(SCRIPT)], env=self.fx.env(BACKUP_VERIFY_ONLY=str(archive)),
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(verify.returncode, 0, verify.stderr)
        self.assertIn("VERIFY_OK", verify.stdout)

    def test_02_site_and_comments_separately_verified(self):
        self.fx.run()
        manifest = json.loads((self.fx.keep_dir / "backup-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["siteReleaseId"], SITE_ID)
        self.assertEqual(manifest["commentsReleaseId"], COMMENTS_ID)
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertTrue(manifest["archivePayloadVerified"])
        self.assertGreater(manifest["siteFilesCount"], 0)
        self.assertGreater(manifest["commentsFilesCount"], 0)
        # 内容不混淆
        archive = self.fx.kept_archive()
        members = subprocess.run(["tar", "-tzf", str(archive)], capture_output=True, text=True).stdout
        lines = members.splitlines()
        self.assertIn("snapshot/site/BUILD_INFO", lines)
        self.assertIn("snapshot/comments/BUILD_INFO", lines)
        self.assertIn("snapshot/site/index.html", lines)
        self.assertFalse(any(l == "snapshot/comments/index.html" for l in lines))

    def test_13_path_with_spaces_and_special_chars(self):
        # 路径含空格：把站点根移入带空格的目录
        spaced = self.fx.root / "dir with space"
        spaced.mkdir()
        new_root = spaced / "site root"
        os.rename(self.fx.site_root, new_root)
        self.fx.site_root = new_root
        # 移动后重建 current（原符号链接为绝对路径，指向旧位置）
        (self.fx.site_root / "current").unlink()
        (self.fx.site_root / "current").symlink_to(self.fx.site_root / "releases" / SITE_ID)
        self.fx.run()

    def test_14_secrets_and_body_not_in_logs_or_manifest(self):
        _write(self.fx.site_root / "releases" / SITE_ID / "essays" / "fixture-a" / "secret.txt",
               "SECRET-MARKER-XYZ-正文内容")
        result = self.fx.run()
        manifest = (self.fx.keep_dir / "backup-manifest.json").read_text(encoding="utf-8")
        state_log = (self.fx.state_dir / "backup-state.log").read_text(encoding="utf-8")
        self.assertNotIn("SECRET-MARKER-XYZ", result.stdout)
        self.assertNotIn("SECRET-MARKER-XYZ", result.stderr)
        self.assertNotIn("SECRET-MARKER-XYZ", manifest)
        self.assertNotIn("SECRET-MARKER-XYZ", state_log)
        # 正文可通过 SHA 出现，但正文不得出现
        self.assertIn("secret.txt", manifest) if False else None


class TestBackupFailClosed(unittest.TestCase):
    def setUp(self):
        self.fx = BackupFixture()

    def tearDown(self):
        self.fx.cleanup()

    def test_04_broken_current_fails_closed(self):
        (self.fx.site_root / "releases" / SITE_ID).rename(self.fx.site_root / "releases" / "gone")
        self.fx.run(expect_fail=True)
        self.assertEqual(self.fx.failure_marker().get("stage"), "current-broken-site")
        self.assertFalse(list(self.fx.keep_dir.glob("*.tar.gz")))

    def test_05_current_outside_releases_fails(self):
        outside = self.fx.root / "outside"
        outside.mkdir()
        _write(outside / "x.txt", "x")
        (self.fx.site_root / "current").unlink()
        (self.fx.site_root / "current").symlink_to(outside)
        self.fx.run(expect_fail=True)
        self.assertEqual(self.fx.failure_marker().get("stage"), "current-outside-site")

    def test_06_empty_release_fails(self):
        empty = self.fx.site_root / "releases" / "20260806_030303"
        empty.mkdir()
        (self.fx.site_root / "current").unlink()
        (self.fx.site_root / "current").symlink_to(empty)
        self.fx.run(expect_fail=True)
        self.assertEqual(self.fx.failure_marker().get("stage"), "site-required-files")

    def test_07_internal_symlink_escape_fails(self):
        secret = self.fx.root / "secret-outside.txt"
        _write(secret, "TOP-SECRET-OUTSIDE")
        (self.fx.site_root / "releases" / SITE_ID / "escape.txt").symlink_to(secret)
        self.fx.run(expect_fail=True)
        self.assertEqual(self.fx.failure_marker().get("stage"), "snapshot-symlink")
        self.assertFalse(list(self.fx.keep_dir.glob("*.tar.gz")))

    def test_10a_missing_site_build_info_fails(self):
        (self.fx.site_root / "releases" / SITE_ID / "BUILD_INFO").unlink()
        self.fx.run(expect_fail=True)
        self.assertEqual(self.fx.failure_marker().get("stage"), "site-required-files")

    def test_10b_missing_comments_entry_fails(self):
        (self.fx.comments_root / "releases" / COMMENTS_ID / "src" / "server.js").unlink()
        self.fx.run(expect_fail=True)
        self.assertEqual(self.fx.failure_marker().get("stage"), "comments-required-files")

    def test_12_no_partial_final_artifacts_on_failure(self):
        (self.fx.site_root / "current").unlink()  # 制造失败
        self.fx.run(expect_fail=True)
        leftovers = list(self.fx.workdir_base.glob("cos-backup.*"))
        self.assertEqual(leftovers, [], "失败后工作目录必须清理")
        self.assertEqual(list(self.fx.keep_dir.glob("*.tar.gz")), [], "失败不得产出正式归档")
        self.assertTrue(self.fx.failure_marker())


class TestBackupConsistencyAndConcurrency(unittest.TestCase):
    def setUp(self):
        self.fx = BackupFixture()

    def tearDown(self):
        self.fx.cleanup()

    def test_03_switch_during_backup_uses_locked_release(self):
        new_id = "20260806_040404"
        self.fx._create_release(self.fx.site_root, new_id, "site")
        _write(self.fx.site_root / "releases" / new_id / "index.html", "<html>新版本</html>")
        proc = subprocess.Popen(
            ["bash", str(SCRIPT)],
            env=self.fx.env(BACKUP_TEST_HOOK_DELAY_S="3"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        time.sleep(1.2)
        (self.fx.site_root / "current").unlink()
        (self.fx.site_root / "current").symlink_to(self.fx.site_root / "releases" / new_id)
        out, err = proc.communicate(timeout=120)
        self.assertEqual(proc.returncode, 0, err[-600:])
        manifest = json.loads((self.fx.keep_dir / "backup-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["siteReleaseId"], SITE_ID, "必须使用开始时锁定的 release")
        archive = self.fx.kept_archive()
        members = subprocess.run(["tar", "-tzf", str(archive)], capture_output=True, text=True).stdout
        self.assertIn("snapshot/site/index.html", members)
        extract = Path(tempfile.mkdtemp(prefix="switch-extract-"))
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(extract)], check=True)
        content = (extract / "snapshot" / "site" / "index.html").read_text(encoding="utf-8")
        self.assertIn("首页标记", content, "归档内容必须是锁定 release（旧版本）")
        self.assertNotIn("新版本", content, "不得混入切换后的 release")
        switch_notes = self.fx.state_dir / "backup-switch-notes.log"
        self.assertTrue(switch_notes.is_file(), "必须记录备份期间 current 发生变化")
        import shutil
        shutil.rmtree(extract, ignore_errors=True)

    def test_08_corrupted_archive_verify_fails(self):
        self.fx.run()
        archive = self.fx.kept_archive()
        data = bytearray(archive.read_bytes())
        data[100] ^= 0xFF
        archive.write_bytes(bytes(data))
        verify = subprocess.run(
            ["bash", str(SCRIPT)], env=self.fx.env(BACKUP_VERIFY_ONLY=str(archive)),
            capture_output=True, text=True, timeout=60,
        )
        self.assertNotEqual(verify.returncode, 0)
        self.assertIn("VERIFY_FAILED", verify.stderr)

    def test_09_archive_tampered_before_verify_fails(self):
        # 归档生成后（复验前）被篡改 → 上传前验证失败
        hook = Path(tempfile.mkdtemp(prefix="hook-")) / "done"
        proc = subprocess.Popen(
            ["bash", str(SCRIPT)],
            env=self.fx.env(BACKUP_TEST_HOOK_DELAY_3_S="3"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        time.sleep(1.2)
        tars = sorted(self.fx.workdir_base.glob("cos-backup.*/*.tar.gz.tmp"))
        self.assertTrue(tars, "等待归档 .tmp 生成")
        data = bytearray(tars[-1].read_bytes())
        self.assertGreater(len(data), 100, "归档过小")
        data[100] ^= 0xFF
        tars[-1].write_bytes(bytes(data))
        out, err = proc.communicate(timeout=120)
        self.assertNotEqual(proc.returncode, 0, "篡改后必须在上传前失败")
        self.assertTrue("archive-verify-mismatch" in (err + out) or "archive-extract" in (err + out),
                        "必须在复验阶段失败（解压失败或清单不一致）")
        self.assertEqual(list(self.fx.keep_dir.glob("*.tar.gz")), [], "失败不得产出正式归档")

    def test_11_concurrent_backup_single_instance(self):
        env = self.fx.env(BACKUP_TEST_HOOK_DELAY_S="2")
        p1 = subprocess.Popen(["bash", str(SCRIPT)], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(0.5)
        p2 = subprocess.Popen(["bash", str(SCRIPT)], env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        o1, e1 = p1.communicate(timeout=120)
        o2, e2 = p2.communicate(timeout=120)
        self.assertEqual(p1.returncode, 0, e1[-400:])
        self.assertEqual(p2.returncode, 1, "第二个实例必须被锁拒绝")
        self.assertIn("已有 COS 备份任务正在运行", e2)


if __name__ == "__main__":
    unittest.main()


class TestUploadSemantics(unittest.TestCase):
    """上传语义：verify-only 绝不调用 coscli；验证成功前上传调用数为 0。"""

    def setUp(self):
        self.fx = BackupFixture()
        self.fx.coscli = self.fx.counting_coscli()

    def tearDown(self):
        self.fx.cleanup()

    def test_15_verify_only_mode_never_uploads(self):
        self.fx.run()  # 先产生一份正常备份（VALIDATE_ONLY，coscli 也不该被调用）
        calls_after_backup = self.fx.coscli_log.read_text() if self.fx.coscli_log.is_file() else ""
        self.assertEqual(calls_after_backup, "", "VALIDATE_ONLY 模式下不得调用 coscli")
        archive = self.fx.kept_archive()
        verify = subprocess.run(
            ["bash", str(SCRIPT)], env=self.fx.env(BACKUP_VERIFY_ONLY=str(archive)),
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(verify.returncode, 0, verify.stderr)
        calls = self.fx.coscli_log.read_text() if self.fx.coscli_log.is_file() else ""
        self.assertEqual(calls, "", "BACKUP_VERIFY_ONLY 模式上传调用次数必须为 0")

    def test_16_no_upload_on_verify_failure(self):
        proc = subprocess.Popen(
            ["bash", str(SCRIPT)],
            env=self.fx.env(BACKUP_TEST_HOOK_DELAY_3_S="3"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        time.sleep(1.2)
        tars = sorted(self.fx.workdir_base.glob("cos-backup.*/*.tar.gz.tmp"))
        self.assertTrue(tars)
        data = bytearray(tars[-1].read_bytes())
        data[100] ^= 0xFF
        tars[-1].write_bytes(bytes(data))
        out, err = proc.communicate(timeout=120)
        self.assertNotEqual(proc.returncode, 0)
        calls = self.fx.coscli_log.read_text() if self.fx.coscli_log.is_file() else ""
        self.assertEqual(calls, "", "验证失败时上传调用次数必须为 0（不得上传未复验归档）")
        self.assertEqual(list(self.fx.keep_dir.glob("*.tar.gz")), [], "验证失败不得产出正式归档")

    def test_17_verified_flag_only_on_successful_backup(self):
        self.fx.run()
        manifest = json.loads((self.fx.keep_dir / "backup-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertTrue(manifest["archivePayloadVerified"])
        # 验证失败场景：不产生携带该标志的正式归档
        fx2 = BackupFixture()
        fx2.coscli = fx2.counting_coscli()
        (fx2.site_root / "current").unlink()
        subprocess.run(["bash", str(SCRIPT)], env=fx2.env(), capture_output=True, text=True, timeout=60)
        self.assertEqual(list(fx2.keep_dir.glob("*.tar.gz")), [], "失败备份不得产出归档")
        fx2.cleanup()
_FAKE_COSCLI_LINES = [
    "#!/usr/bin/env bash",
    'echo "$*" >> "$COSCLI_LOG"',
    "set -e",
    'MODE="$FAKE_COS_MODE"',
    'OP="$1"; shift',
    'case "$OP" in',
    "  cp)",
    '    SRC="$1"; DST="$2"',
    '    if [[ "$SRC" == cos://* ]]; then',
    '      OBJ="$(printf \'%s\' "$SRC" | sed \'s|cos://[^/]*/||\')"',
    '      TARGET="$FAKE_COS_ROOT/$OBJ"',
    '      mkdir -p "$(dirname "$DST")"',
    '      cp "$TARGET" "$DST"',
    "    else",
    '      OBJ="$(printf \'%s\' "$DST" | sed \'s|cos://[^/]*/||\')"',
    '      TARGET="$FAKE_COS_ROOT/$OBJ"',
    '      if [[ "$MODE" == "upload-fail" ]]; then echo "upload failed" >&2; exit 1; fi',
    '      mkdir -p "$(dirname "$TARGET")"',
    '      cp "$SRC" "$TARGET"',
    '      if [[ "$MODE" == "checksum-fail" && "$OBJ" == *.sha256 ]]; then',
    '        echo "0000000000000000000000000000000000000000000000000000000000000000  x" > "$TARGET"',
    "      fi",
    "    fi",
    "    ;;",
    "  ls)",
    '    PATTERN="${1#cos://*/}"',
    '    find "$FAKE_COS_ROOT" -type f -name "$(basename "$PATTERN")" 2>/dev/null | head -1 || true',
    "    ;;",
    "esac",
    "exit 0",
]


class FakeCoscliMixin:
    """可配置故障的假 coscli：ok / upload-fail / checksum-fail。"""

    def install_fake_coscli(self, mode: str = "ok"):
        root = self.fx.root
        wrapper = root / "fake-coscli.sh"
        fake_root = root / "fake-cos"
        fake_root.mkdir(exist_ok=True)
        wrapper.write_text("\n".join(_FAKE_COSCLI_LINES) + "\n", encoding="utf-8")
        wrapper.chmod(0o755)
        self.fx.coscli = wrapper
        self.fx.coscli_log = root / "coscli-calls.log"
        self.fx.fake_cos_mode = mode
        self.fx.fake_cos_root = fake_root
        return wrapper, fake_root

    def coscli_calls(self) -> str:
        return self.fx.coscli_log.read_text(encoding="utf-8") if self.fx.coscli_log.is_file() else ""


class TestStatusSemantics(unittest.TestCase, FakeCoscliMixin):
    """状态语义：模式化终止状态、BACKUP_COMPLETE 门控、成功时间与结构化记录。"""

    def setUp(self):
        self.fx = BackupFixture()
        self.state_log_path = self.fx.state_dir / "backup-state.log"

    def tearDown(self):
        self.fx.cleanup()

    def state_log(self) -> str:
        return self.state_log_path.read_text(encoding="utf-8")

    def last_verify(self) -> dict:
        p = self.fx.state_dir / "backup-last-verify.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}

    def last_success(self) -> str:
        p = self.fx.state_dir / "backup-last-success"
        return p.read_text(encoding="utf-8").strip() if p.is_file() else ""

    def _run_full(self):
        env = self.fx.env()
        env["COS_BACKUP_VALIDATE_ONLY"] = "0"
        return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120)

    def test_1_validate_only_complete_state(self):
        self.fx.coscli = self.fx.counting_coscli()
        self.fx.run()
        log = self.state_log()
        self.assertEqual(log.count("STATE=LOCAL_VERIFY_DONE"), 1)
        self.assertEqual(log.count("STATE=VALIDATE_ONLY_COMPLETE"), 1)
        self.assertEqual(log.count("STATE=UPLOAD_STARTED"), 0)
        self.assertEqual(log.count("STATE=UPLOAD_DONE"), 0)
        self.assertEqual(log.count("STATE=REMOTE_VERIFY_DONE"), 0)
        self.assertEqual(log.count("STATE=BACKUP_COMPLETE"), 0)
        self.assertEqual(self.coscli_calls(), "", "上传调用次数=0")
        lv = self.last_verify()
        self.assertEqual(lv.get("mode"), "validate-only")
        self.assertFalse(lv.get("remoteUploadPerformed"))
        self.assertFalse(lv.get("remoteVerified"))
        self.assertFalse(lv.get("backupComplete"))
        self.assertTrue(lv.get("archivePayloadVerified"))

    def test_2_verify_only_states(self):
        self.fx.coscli = self.fx.counting_coscli()
        self.fx.run()
        archive = self.fx.kept_archive()
        n_before = len(list(self.fx.keep_dir.glob("*.tar.gz")))
        verify = subprocess.run(
            ["bash", str(SCRIPT)], env=self.fx.env(BACKUP_VERIFY_ONLY=str(archive)),
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(verify.returncode, 0, verify.stderr)
        log = self.state_log()
        self.assertIn("STATE=VERIFY_ONLY_STARTED", log)
        self.assertIn("STATE=VERIFY_ONLY_DONE", log)
        self.assertEqual(log.count("STATE=BACKUP_COMPLETE"), 0)
        self.assertEqual(self.coscli_calls(), "", "verify-only 上传调用=0")
        self.assertEqual(len(list(self.fx.keep_dir.glob("*.tar.gz"))), n_before,
                         "verify-only 不得创建新正式备份")

    def test_3_full_backup_state_order(self):
        self.install_fake_coscli("ok")
        result = self._run_full()
        self.assertEqual(result.returncode, 0, result.stderr[-500:])
        log = self.state_log()
        order = [st for st in ("LOCAL_VERIFY_DONE", "UPLOAD_STARTED", "UPLOAD_DONE",
                               "REMOTE_VERIFY_DONE", "BACKUP_COMPLETE") if f"STATE={st}" in log]
        self.assertEqual(order, ["LOCAL_VERIFY_DONE", "UPLOAD_STARTED", "UPLOAD_DONE",
                                 "REMOTE_VERIFY_DONE", "BACKUP_COMPLETE"])
        self.assertEqual(log.count("STATE=BACKUP_COMPLETE"), 1)
        lv = self.last_verify()
        self.assertEqual(lv.get("mode"), "full")
        self.assertTrue(lv.get("remoteUploadPerformed"))
        self.assertTrue(lv.get("remoteVerified"))
        self.assertTrue(lv.get("backupComplete"))
        self.assertTrue(self.last_success(), "full 成功必须更新最近成功时间")

    def test_4_upload_failure_states(self):
        self.install_fake_coscli("upload-fail")
        result = self._run_full()
        self.assertNotEqual(result.returncode, 0)
        log = self.state_log()
        self.assertIn("STATE=UPLOAD_STARTED", log)
        self.assertEqual(log.count("STATE=UPLOAD_DONE"), 0)
        self.assertEqual(log.count("STATE=REMOTE_VERIFY_DONE"), 0)
        self.assertEqual(log.count("STATE=BACKUP_COMPLETE"), 0)
        marker = self.fx.failure_marker()
        self.assertEqual(marker.get("mode"), "full")
        self.assertTrue(marker.get("remoteUploadPerformed"))
        self.assertFalse(marker.get("remoteVerified"))
        self.assertEqual(self.last_success(), "", "失败不得更新成功时间")

    def test_5_remote_verify_failure_states(self):
        self.install_fake_coscli("checksum-fail")
        result = self._run_full()
        self.assertNotEqual(result.returncode, 0)
        log = self.state_log()
        self.assertIn("STATE=UPLOAD_DONE", log)
        self.assertEqual(log.count("STATE=REMOTE_VERIFY_DONE"), 0)
        self.assertEqual(log.count("STATE=BACKUP_COMPLETE"), 0)
        self.assertEqual(self.last_success(), "")

    def test_6_local_verify_failure_states(self):
        self.fx.coscli = self.fx.counting_coscli()
        proc = subprocess.Popen(
            ["bash", str(SCRIPT)],
            env=self.fx.env(BACKUP_TEST_HOOK_DELAY_3_S="3"),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        time.sleep(1.2)
        tars = sorted(self.fx.workdir_base.glob("cos-backup.*/*.tar.gz.tmp"))
        data = bytearray(tars[-1].read_bytes())
        data[100] ^= 0xFF
        tars[-1].write_bytes(bytes(data))
        proc.communicate(timeout=120)
        log = self.state_log()
        self.assertEqual(log.count("STATE=LOCAL_VERIFY_DONE"), 0)
        self.assertEqual(log.count("STATE=UPLOAD_STARTED"), 0)
        self.assertEqual(log.count("STATE=BACKUP_COMPLETE"), 0)
        marker = self.fx.failure_marker()
        self.assertEqual(marker.get("mode"), "full")
        self.assertFalse(marker.get("remoteUploadPerformed"))

    def test_7_success_time_only_full(self):
        self.fx.coscli = self.fx.counting_coscli()
        self.fx.run()
        self.assertEqual(self.last_success(), "", "validate-only 不得写成功时间")
        archive = self.fx.kept_archive()
        subprocess.run(["bash", str(SCRIPT)], env=self.fx.env(BACKUP_VERIFY_ONLY=str(archive)),
                       capture_output=True, text=True, timeout=60)
        self.assertEqual(self.last_success(), "", "verify-only 不得写成功时间")
        self.install_fake_coscli("ok")
        result = self._run_full()
        self.assertEqual(result.returncode, 0, result.stderr[-400:])
        self.assertTrue(self.last_success(), "full 成功才更新成功时间")

    def test_8_validate_only_no_notification_cleanup_signals(self):
        existing = self.fx.keep_dir / "existing-old-backup.tar.gz"
        existing.write_bytes(b"old")
        self.fx.coscli = self.fx.counting_coscli()
        self.fx.run()
        self.assertFalse((self.fx.state_dir / "backup-failure.marker").exists())
        self.assertTrue(existing.is_file(), "validate-only 不得删除既有保留归档")
        log = self.state_log()
        self.assertEqual(log.count("STATE=VALIDATE_ONLY_COMPLETE"), 1)

    def test_9_restore_selector_cannot_misselect(self):
        self.fx.coscli = self.fx.counting_coscli()
        self.fx.run()
        lv = self.last_verify()
        self.assertEqual(lv["mode"], "validate-only")
        self.assertFalse(lv["backupComplete"])
        self.assertFalse(lv["remoteUploadPerformed"])
        self.assertFalse(lv["remoteVerified"])
        self.assertFalse(lv.get("backupComplete") and lv.get("remoteUploadPerformed")
                          and lv.get("remoteVerified"),
                         "不得被恢复选择器选为完整远端备份")
        archive = self.fx.kept_archive()
        import tarfile
        with tarfile.open(archive, "r:gz") as tf:
            m = json.loads(tf.extractfile("manifests/backup-manifest.json").read())
        self.assertEqual(m["mode"], "validate-only")
        self.assertTrue(m["archivePayloadVerified"])


if __name__ == "__main__":
    unittest.main()
