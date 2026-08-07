"""长文分享发布调度：SQLite 数据层（状态机、原子认领、幂等）。

权威数据仍是磁盘 Markdown；本模块只存调度信息、状态、ID、hash、URL 与
QQ 发布结果。数据库文件位于分享私有内容根内（publications.sqlite3），
绝不出现在公开仓库。

状态设计（两个维度，分别对应两个发行阶段）：
- web_status:   pending → building → verified | failed
- qzone_status: scheduled → publishing → submitted_unverified → published
                                                              └→ failed（停止，不自动重试）
                                                              └→ skipped（QQ 未启用/未配置）
                cancelled（用户取消；网页保持已发布，不回滚）

安全边界：
- 每次认领都在 ``fcntl.flock`` 文件锁 + ``BEGIN IMMEDIATE`` 事务内完成，
  同一 publication 只会被一个进程认领一次；
- 幂等键：publication_id 唯一；同一正文可因用户显式新建新任务再次发布；
- 崩溃恢复：卡在 publishing 超过 STALE_CLAIM_SECONDS 的任务被标记为
  failed（stale-claim-recovery），绝不自动重发，避免重复说说；
- 发布成功状态只允许由 ``mark_published`` 写入，且要求传入真实凭据
  （qzone_post_id）；无法反查时保持 submitted_unverified。
"""

from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import os
import secrets
import sqlite3
import threading
import uuid
from pathlib import Path

WEB_PENDING = "pending"
WEB_BUILDING = "building"
WEB_VERIFIED = "verified"
WEB_FAILED = "failed"

QZ_SCHEDULED = "scheduled"
QZ_PUBLISHING = "publishing"
QZ_SUBMITTED = "submitted_unverified"
QZ_PUBLISHED = "published"
QZ_FAILED = "failed"
QZ_CANCELLED = "cancelled"
QZ_SKIPPED = "skipped"

STALE_CLAIM_SECONDS = 600  # 认领后超过 10 分钟未完成 → 视为崩溃残留
QQ_TEXT_MAX = 2000  # 保守上限：按任务书以约 2000 字为界，服务端仍以 API 响应为准

SCHEMA = """
CREATE TABLE IF NOT EXISTS publications (
  publication_id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  share_revision TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  canonical_url TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL UNIQUE,
  scheduled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  web_status TEXT NOT NULL DEFAULT 'pending',
  qzone_status TEXT NOT NULL DEFAULT 'scheduled',
  final_text TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  qzone_post_id TEXT,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  confirmed_at TEXT,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_publications_due
  ON publications (qzone_status, scheduled_at);
"""


class PublisherError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def to_utc_iso(value) -> str:
    """把 ISO 时间串（或 datetime）规范化为带 +00:00 的 UTC ISO，保证字典序可比。"""
    if isinstance(value, dt.datetime):
        parsed = value
    else:
        text = str(value or "").strip()
        if not text:
            raise PublisherError("validation-failed", "缺少发布时间。")
        try:
            parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError as error:
            raise PublisherError("validation-failed", f"发布时间格式不正确：{error}") from error
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def new_publication_id() -> str:
    return f"pub-{secrets.token_hex(6)}"


def final_text_for(qq_summary: str, canonical_url: str) -> str:
    """QQ 空间最终文案：摘要 + 空行 + 阅读全文链接。"""
    summary = str(qq_summary or "").strip()
    url = str(canonical_url or "").strip()
    parts = [part for part in (summary, "阅读全文：", url) if part]
    return "\n\n".join(parts)


def text_length(text: str) -> int:
    """按 Python 字符（Unicode code point）计数；用于 UI 与保守预警。"""
    return len(text)


class PublisherDB:
    """SQLite 发布数据库；所有写操作带 fcntl 文件锁 + 事务。"""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.lock_path = self.db_path.with_suffix(self.db_path.suffix + ".lock")
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.init_schema()

    # -- 连接 ------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    @contextlib.contextmanager
    def _lock(self):
        """进程级文件锁（fcntl），配合事务实现跨进程原子认领。"""
        with open(self.lock_path, "a+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @contextlib.contextmanager
    def _transaction(self):
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def init_schema(self) -> None:
        # executescript 会隐式提交；因此只在文件锁内直接执行，不套事务
        with self._lock():
            self.conn.executescript(SCHEMA)
            # 轻量列迁移：既有数据库补 confirmed_at/confirmed_by（人工确认审计）
            columns = {row[1] for row in self.conn.execute("PRAGMA table_info(publications)")}
            for name in ("confirmed_at", "confirmed_by"):
                if name not in columns:
                    self.conn.execute(f"ALTER TABLE publications ADD COLUMN {name} TEXT")

    # -- 查询 ------------------------------------------------------------

    @staticmethod
    def _row(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        return dict(row)

    def get(self, publication_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM publications WHERE publication_id = ?", (publication_id,)
        ).fetchone()
        return self._row(row)

    def list_all(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM publications ORDER BY created_at DESC"
        ).fetchall()
        return [self._row(row) for row in rows]

    def list_due(self, now: str | None = None) -> list[dict]:
        """已到时间且等待 QQ 发布的出版物（不含失败/取消/已发布/跳过）。"""
        now = now or utcnow()
        rows = self.conn.execute(
            "SELECT * FROM publications WHERE qzone_status = ? AND scheduled_at <= ? "
            "ORDER BY scheduled_at ASC",
            (QZ_SCHEDULED, now),
        ).fetchall()
        return [self._row(row) for row in rows]

    def list_pending_web(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM publications WHERE web_status = ? ORDER BY created_at ASC",
            (WEB_PENDING,),
        ).fetchall()
        return [self._row(row) for row in rows]

    def list_stale_claims(self) -> list[dict]:
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=STALE_CLAIM_SECONDS)).isoformat(
            timespec="seconds"
        )
        rows = self.conn.execute(
            "SELECT * FROM publications WHERE (web_status = ? OR qzone_status = ?) "
            "AND started_at IS NOT NULL AND started_at <= ?",
            (WEB_BUILDING, QZ_PUBLISHING, cutoff),
        ).fetchall()
        return [self._row(row) for row in rows]

    # -- 创建 ------------------------------------------------------------

    def create(
        self,
        share_id: str,
        share_revision: str,
        content_hash: str,
        final_text: str,
        scheduled_at: str,
        canonical_url: str = "",
        metadata: dict | None = None,
    ) -> dict:
        if not share_id or not share_revision or not content_hash:
            raise PublisherError("validation-failed", "创建发布任务缺少分享身份信息。")
        if text_length(final_text) > QQ_TEXT_MAX:
            raise PublisherError(
                "validation-failed",
                f"QQ 最终文案过长（{text_length(final_text)} 字，上限 {QQ_TEXT_MAX} 字）。",
            )
        publication_id = new_publication_id()
        now = utcnow()
        scheduled_utc = to_utc_iso(scheduled_at)
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "INSERT INTO publications "
                    "(publication_id, share_id, share_revision, content_hash, canonical_url, idempotency_key, "
                    " scheduled_at, created_at, web_status, qzone_status, final_text, metadata_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        publication_id,
                        share_id,
                        share_revision,
                        content_hash,
                        canonical_url,
                        publication_id,
                        scheduled_utc,
                        now,
                        WEB_PENDING,
                        QZ_SCHEDULED,
                        final_text,
                        _json_dumps(metadata or {}),
                    ),
                )
        return self.get(publication_id)

    # -- 认领（原子） -----------------------------------------------------

    def claim_web(self, publication_id: str) -> bool:
        """pending → building；返回是否成功认领（同一任务只认领一次）。"""
        with self._lock():
            with self._transaction():
                cursor = self.conn.execute(
                    "UPDATE publications SET web_status = ?, started_at = ? "
                    "WHERE publication_id = ? AND web_status = ?",
                    (WEB_BUILDING, utcnow(), publication_id, WEB_PENDING),
                )
                return cursor.rowcount == 1

    def claim_qzone(self, publication_id: str, now: str | None = None) -> bool:
        """scheduled → publishing（要求网页已 verified 且到时间）；原子幂等。"""
        now = now or utcnow()
        with self._lock():
            with self._transaction():
                cursor = self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, started_at = ?, "
                    "attempt_count = attempt_count + 1 "
                    "WHERE publication_id = ? AND qzone_status = ? AND web_status = ? AND scheduled_at <= ?",
                    (QZ_PUBLISHING, now, publication_id, QZ_SCHEDULED, WEB_VERIFIED, now),
                )
                return cursor.rowcount == 1

    # -- 结果写入 ---------------------------------------------------------

    def mark_web_verified(self, publication_id: str, canonical_url: str) -> None:
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET web_status = ?, canonical_url = ?, finished_at = ? "
                    "WHERE publication_id = ?",
                    (WEB_VERIFIED, canonical_url, utcnow(), publication_id),
                )

    def mark_web_failed(self, publication_id: str, code: str, message: str) -> None:
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET web_status = ?, finished_at = ?, "
                    "error_code = ?, error_message = ? WHERE publication_id = ?",
                    (WEB_FAILED, utcnow(), code, message[:2000], publication_id),
                )

    def mark_submitted(
        self,
        publication_id: str,
        post_id: str | None = None,
        code: str = "",
        message: str = "",
    ) -> None:
        """HTTP 已提交但未反查确认：绝不写入 published。

        ambiguous（连接中断，可能已到达 QQ）也走本方法：状态为
        submitted_unverified + 说明，绝不标 failed，避免用户误以为没发而重发。
        """
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, qzone_post_id = ?, finished_at = ?, "
                    "error_code = ?, error_message = ? WHERE publication_id = ?",
                    (QZ_SUBMITTED, post_id, utcnow(), code, message[:2000], publication_id),
                )

    def mark_published(self, publication_id: str, post_id: str) -> None:
        """只有携带真实 post_id 才允许进入 published。"""
        if not post_id:
            raise PublisherError("validation-failed", "缺少 QQ 说说 post id，禁止标记为已发布。")
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, qzone_post_id = ?, finished_at = ? "
                    "WHERE publication_id = ?",
                    (QZ_PUBLISHED, post_id, utcnow(), publication_id),
                )

    def confirm_publication(self, publication_id: str, confirmed_by: str = "manual") -> tuple[bool, str]:
        """人工确认说说真实存在：submitted_unverified → published。

        - 只允许从 submitted_unverified 进入 published（绝不从 scheduled/failed
          伪造成功）；
        - 重复 confirm 幂等（已 published 直接成功）；
        - 记录确认时间与确认人（审计）。
        """
        with self._lock():
            with self._transaction():
                row = self.conn.execute(
                    "SELECT qzone_status FROM publications WHERE publication_id = ?",
                    (publication_id,),
                ).fetchone()
                if row is None:
                    return False, "not-found"
                status = row[0]
                if status == QZ_PUBLISHED:
                    return True, "already-published"
                if status != QZ_SUBMITTED:
                    return False, f"invalid-state:{status}"
                now = utcnow()
                self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, finished_at = ?, "
                    "confirmed_at = ?, confirmed_by = ?, error_code = '', error_message = '' "
                    "WHERE publication_id = ?",
                    (QZ_PUBLISHED, now, now, confirmed_by, publication_id),
                )
                return True, "confirmed"

    def mark_skipped(self, publication_id: str, code: str, message: str) -> None:
        """QQ 自动发布未启用/未配置：记录 skipped，绝不伪造发布。"""
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, finished_at = ?, "
                    "error_code = ?, error_message = ? WHERE publication_id = ?",
                    (QZ_SKIPPED, utcnow(), code, message[:2000], publication_id),
                )

    def mark_failed(self, publication_id: str, code: str, message: str) -> None:
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, finished_at = ?, "
                    "error_code = ?, error_message = ? WHERE publication_id = ?",
                    (QZ_FAILED, utcnow(), code, message[:2000], publication_id),
                )

    def cancel(self, publication_id: str) -> bool:
        """取消：只允许取消仍未发布的任务；网页发布结果不回滚。"""
        with self._lock():
            with self._transaction():
                cursor = self.conn.execute(
                    "UPDATE publications SET qzone_status = ?, finished_at = ?, "
                    "error_code = 'cancelled', error_message = '用户取消' "
                    "WHERE publication_id = ? AND qzone_status IN (?, ?)",
                    (QZ_CANCELLED, utcnow(), publication_id, QZ_SCHEDULED, QZ_PUBLISHING),
                )
                return cursor.rowcount == 1

    def recover_stale_claims(self) -> list[str]:
        """崩溃恢复：卡在 building/publishing 超过阈值的任务标记 failed，绝不重发。"""
        recovered: list[str] = []
        with self._lock():
            with self._transaction():
                for row in self.list_stale_claims():
                    if row["web_status"] == WEB_BUILDING:
                        self.conn.execute(
                            "UPDATE publications SET web_status = ?, finished_at = ?, "
                            "error_code = ?, error_message = ? WHERE publication_id = ?",
                            (
                                WEB_FAILED,
                                utcnow(),
                                "stale-claim-recovery",
                                "网页构建在执行中断开，已标记失败；请检查后重新建立任务。",
                                row["publication_id"],
                            ),
                        )
                    if row["qzone_status"] == QZ_PUBLISHING:
                        self.conn.execute(
                            "UPDATE publications SET qzone_status = ?, finished_at = ?, "
                            "error_code = ?, error_message = ? WHERE publication_id = ?",
                            (
                                QZ_FAILED,
                                utcnow(),
                                "stale-claim-recovery",
                                "QQ 发布在执行中断开，为避免重复发布已标记失败；"
                                "请人工确认未发出后重新建立任务。",
                                row["publication_id"],
                            ),
                        )
                    recovered.append(row["publication_id"])
        return recovered

    def touch_attempt(self, publication_id: str) -> None:
        """发布执行期间周期性续约认领时间，避免长执行被误判为残留。"""
        with self._lock():
            with self._transaction():
                self.conn.execute(
                    "UPDATE publications SET started_at = ? WHERE publication_id = ?",
                    (utcnow(), publication_id),
                )


def _json_dumps(value: dict) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, sort_keys=True)
