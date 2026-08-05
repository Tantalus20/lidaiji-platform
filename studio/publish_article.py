"""文章级发布闭环（v0.2.2）：编辑器 → 保存草稿 → 预览发布版本 → 确认发布。

复用既有发布链（build.sh / check.sh / publish.sh / server-publish.sh），不另建
重复发布系统：

- ``article_publish_status``：文章发布状态（草稿/已发布/已发布但存在未发布修改、
  最后保存时间、预览是否最新、线上版本、发布历史）；
- ``article_publish_preview``：保存后文章的发布前校验 + 段落锚点迁移预演（以上次
  成功发布记录的锚点集为基准）+ 受影响段评统计（经本地网关只读查询生产计数）
  + Hugo 构建验证，签发预览构建标识；
- ``article_publish``：revision/预览标识校验 + 全局发布锁 + 幂等 + 走既有
  preflight(检查) 与 publish(发布) 流程，记录发布历史。

安全边界：
- 发布操作与站点发布中心共享同一把锁（同一时间只有一个正式发布任务）；
- 草稿保存不自动提交 Git（现有发布链以工作树为内容源；自动提交会与作者手动
  Git 操作冲突，且不满足"只提交本次文章"的原子性保证）；
- 发布历史账本写在 .cache/studio/（Git 忽略），不含任何秘密；
- 幂等键与预览构建标识仅存内存与账本。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

from studio import articles, versions
from studio import publish_center

PUBLISH_LOCK_AGE_SECONDS = 900 + 60  # publish.sh 超时上限 + 恢复余量
PREVIEW_FRESH_SECONDS = 30 * 60  # 预览构建标识有效期
DEFAULT_PREVIEW_PORT = 1313
LEDGER_NAME = "publish-history.json"
ANCHOR_RE = re.compile(r"<!-- paragraph-id:(p-[a-f0-9]{12}) -->")


class ArticlePublishError(Exception):
    """可直接转成 JSON 错误响应的失败。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 发布账本（.cache/studio/publish-history.json）
# ---------------------------------------------------------------------------


def _ledger_path(project_root: Path) -> Path:
    return project_root / ".cache" / "studio" / LEDGER_NAME


def read_ledger(project_root: Path) -> list[dict]:
    path = _ledger_path(project_root)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def record_publish(project_root: Path, entry: dict) -> None:
    path = _ledger_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    entries = read_ledger(project_root)
    entries.append(entry)
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def last_article_record(project_root: Path, article_id: str) -> dict | None:
    for entry in reversed(read_ledger(project_root)):
        if entry.get("articleId") == article_id and entry.get("status") == "ok":
            return entry
    return None


def record_by_idempotency(project_root: Path, idempotency_key: str) -> dict | None:
    for entry in read_ledger(project_root):
        if entry.get("idempotencyKey") == idempotency_key:
            return entry
    return None


# ---------------------------------------------------------------------------
# 发布锁（与站点发布中心共享）
# ---------------------------------------------------------------------------


def acquire_publish_lock(state, idempotency_key: str = "") -> dict:
    """抢占全局发布锁；已被占用且键不同返回（inFlight=True）锁信息。"""
    with state.lock:
        current = getattr(state, "publish_lock_info", None)
        now = time.time()
        if current and current.get("inFlight"):
            if now - current.get("startedAt", now) > PUBLISH_LOCK_AGE_SECONDS:
                current["status"] = "failed_recovery"
                current["inFlight"] = False
                state.publish_lock_info = None
            elif current.get("idempotencyKey") == idempotency_key:
                return current
            else:
                return current
        lock = {
            "inFlight": True,
            "stage": "validating",
            "startedAt": now,
            "articleId": "",
            "kind": "site",
            "status": "running",
            "idempotencyKey": idempotency_key,
        }
        state.publish_lock_info = lock
        return lock


def update_publish_stage(state, stage: str) -> None:
    with state.lock:
        lock = getattr(state, "publish_lock_info", None)
        if lock and lock.get("inFlight"):
            lock["stage"] = stage


def release_publish_lock(state) -> None:
    with state.lock:
        state.publish_lock_info = None


def publish_lock_status(state) -> dict | None:
    lock = getattr(state, "publish_lock_info", None)
    if not lock:
        return None
    result = dict(lock)
    if lock.get("inFlight") and time.time() - lock.get("startedAt", 0) > PUBLISH_LOCK_AGE_SECONDS:
        result["status"] = "failed_recovery"
        result["stage"] = ""
    return result


# ---------------------------------------------------------------------------
# 文章发布状态
# ---------------------------------------------------------------------------


def _canonical_url(article: dict) -> str:
    parts = [p for p in str(article.get("path") or "").split("/") if p]
    # content/<section>/<slug>/index.md
    section = ""
    slug = ""
    if len(parts) >= 3 and parts[0] == "content" and parts[-1] == "index.md":
        section = parts[1]
        slug = parts[-2]
    return f"/{section}/{slug}/"


def _section_slug(article: dict) -> tuple[str, str]:
    parts = [p for p in str(article.get("path") or "").split("/") if p]
    if len(parts) >= 3 and parts[0] == "content" and parts[-1] == "index.md":
        return parts[1], parts[-2]
    return "", ""


def article_publish_status(state, rel_path: str) -> dict:
    """返回编辑器发布面板所需状态（不含任何秘密）。"""
    project_root = Path(state.project_root).resolve()
    article = articles.read_article(project_root, rel_path)
    fm = article["frontMatter"]
    article_id = str(fm.get("articleId") or "")
    revision = str(fm.get("articleRevision") or "")
    draft = bool(fm.get("draft", True))
    last = last_article_record(project_root, article_id)
    section, slug = _section_slug(article)
    saved_mtime = 0.0
    try:
        index = project_root / "content" / section / slug / "index.md"
        saved_mtime = index.stat().st_mtime
    except OSError:
        pass
    preview = getattr(state, "article_preview", None)
    preview_fresh = bool(
        preview
        and preview.get("articleId") == article_id
        and preview.get("revision") == revision
        and time.time() - preview.get("createdAt", 0) <= PREVIEW_FRESH_SECONDS
    )
    return {
        "path": article["path"],
        "articleId": article_id,
        "slug": slug,
        "section": section,
        "canonicalUrl": _canonical_url(article),
        "draft": draft,
        "revision": revision,
        "lastSavedAt": saved_mtime,
        "publishedRevision": (last or {}).get("revision", ""),
        "publishedAt": (last or {}).get("completedAt", ""),
        "release": (last or {}).get("releaseId", ""),
        "previewFresh": preview_fresh,
        "lock": publish_lock_status(state),
        "result": getattr(state, "article_publish_result", None),
        "history": [
            {
                "id": entry.get("id"),
                "revision": entry.get("revision"),
                "status": entry.get("status"),
                "createdAt": entry.get("createdAt"),
                "completedAt": entry.get("completedAt"),
                "releaseId": entry.get("releaseId"),
            }
            for entry in read_ledger(project_root)
            if entry.get("articleId") == article_id
        ][-8:],
    }


# ---------------------------------------------------------------------------
# 段落锚点迁移预演与评论兼容
# ---------------------------------------------------------------------------


def anchors_in(markdown: str) -> list[str]:
    return ANCHOR_RE.findall(markdown or "")


def rehearsal(project_root: Path, article: dict) -> dict:
    """锚点迁移预演：以上次成功发布记录的锚点集为基准。

    - retained：上次发布存在且本次仍存在；
    - created：本次新增；
    - deleted：上次发布存在、本次已消失（将转 historical）。
    """
    article_id = str(article["frontMatter"].get("articleId") or "")
    last = last_article_record(project_root, article_id)
    before = set(last.get("anchors") or []) if last else set(anchors_in(article.get("body") or ""))
    after = set(anchors_in(article.get("body") or ""))
    return {
        "retained": sorted(before & after),
        "created": sorted(after - before),
        "deleted": sorted(before - after),
    }


def affected_comment_count(state, article_id: str, paragraph_ids: list[str]) -> tuple[int, bool]:
    """经本地网关只读查询生产段评计数；评论服务不可达返回 (0, False)。"""
    if not paragraph_ids:
        return 0, True
    try:
        import json as _json
        import urllib.request

        from studio import feedback
        path = f"{feedback.COMMENTS_BASE}/api/comments/v1/articles/{article_id}/counts"
        with urllib.request.urlopen(path, timeout=5) as response:
            data = _json.loads(response.read().decode("utf-8"))
        counts = data.get("counts") or {}
        return sum(int(counts.get(pid, 0)) for pid in paragraph_ids), True
    except Exception:
        return 0, False


# ---------------------------------------------------------------------------
# 预览发布版本
# ---------------------------------------------------------------------------


def _unrelated_uncommitted(project_root: Path, rel_path: str) -> list[str]:
    """私人仓库中与本文无关的未提交修改（任务十六：不得混入其他未提交修改）。

    目标文章自身（保存草稿不提交 Git）不算冲突；其他文件的变化会随全站
    发布进入线上，必须在发布前明确列出并拒绝。
    """
    try:
        status = versions.git_status(project_root)
    except Exception:
        return []
    target = str(rel_path or "").rstrip("/")
    conflicts: list[str] = []
    for item in status.get("files", []):
        path = str(item.get("path") or "").rstrip("/")
        if not path:
            continue
        # 目标文章自身的文件/目录（或其祖先目录）不算冲突
        if path.startswith(target) or target.startswith(path):
            continue
        marker = "未跟踪" if item.get("status") == "?" else f"{item.get('status', '')}"
        conflicts.append(f"{path}（{marker}）")
    return conflicts[:20]


def _check_unrelated_changes(project_root: Path, rel_path: str) -> list[dict]:
    conflicts = _unrelated_uncommitted(project_root, rel_path)
    if not conflicts:
        return []
    return [{
        "name": "workspace-clean",
        "status": "FAIL",
        "detail": f"存在与本文无关的未提交修改：{'、'.join(conflicts[:8])}"
                  + ("（更多…）" if len(conflicts) > 8 else "") + "。请先提交或还原后再发布。",
    }]


def article_publish_preview(state, rel_path: str) -> dict:
    """保存后文章的发布前校验 + 锚点预演 + 受影响段评 + Hugo 构建预检。"""
    project_root = Path(state.project_root).resolve()
    platform_root = Path(getattr(state, "platform_root", None) or state.project_root).resolve()
    article = articles.read_article(project_root, rel_path)
    fm = article["frontMatter"]
    article_id = str(fm.get("articleId") or "")
    revision = str(fm.get("articleRevision") or "")
    checks: list[dict] = []

    def check(name: str, status: str, detail: str = ""):
        checks.append({"name": name, "status": status, "detail": detail})

    title = str(fm.get("title") or "").strip()
    slug = str(fm.get("slug") or "").strip()
    body = str(article.get("body") or "").strip()
    check("front-matter", "PASS" if (title and slug and fm.get("date")) else "FAIL", "标题/slug/日期必须齐全")
    if slug and re.fullmatch(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", slug):
        check("slug-format", "PASS", "")
    else:
        check("slug-format", "FAIL", f"slug 非法：{slug}")
    check("body-nonempty", "PASS" if body else "FAIL", "正文不能为空" if not body else "")
    if slug and re.fullmatch(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", slug):
        conflicts = [
            item for item in articles.search_articles(project_root, "")
            if item.get("slug") == slug and item.get("path") != article["path"]
        ]
        check("slug-unique", "FAIL" if conflicts else "PASS", "与其他文章 slug 冲突" if conflicts else "")

    checks.extend(_check_unrelated_changes(project_root, rel_path))

    anchor = rehearsal(project_root, article)
    affected, reachable = affected_comment_count(state, article_id, anchor["deleted"])
    if anchor["deleted"] and not reachable:
        check("comments-compat", "WARNING", "评论服务不可达，受影响段评数量未知")
        affected = None
    elif affected:
        check("comments-compat", "WARNING", f"受影响段评 {affected} 条（锚点转历史后不公开显示）")
    else:
        check("comments-compat", "PASS", "")
    if len(anchor["deleted"]) > 100:
        check("paragraph-large-gate", "FAIL", f"将转历史的段落 {len(anchor['deleted'])} 个，超过大规模失效门禁（100）")
    else:
        check("paragraph-large-gate", "PASS", "")

    build_result = {"success": False, "output": "", "duration": 0.0}
    failed_so_far = [c for c in checks if c["status"] == "FAIL"]
    if not failed_so_far:
        build_result = publish_center.run_preflight(
            platform_root, full=False, content_repo_root=project_root,
            workspace_environment=state.workspace_environment,
        )
        if build_result["success"]:
            check("hugo-build", "PASS", f"耗时 {build_result['duration']} 秒")
        else:
            check("hugo-build", "FAIL", "Hugo 构建失败（见日志尾部）")

    failed = [c for c in checks if c["status"] == "FAIL"]
    preview_build_id = ""
    canonical = _canonical_url(article)
    if not failed:
        preview_build_id = hashlib.sha256(f"{article_id}|{revision}|{time.time()}".encode()).hexdigest()[:20]
        state.article_preview = {
            "articleId": article_id,
            "revision": revision,
            "buildId": preview_build_id,
            "createdAt": time.time(),
            "canonicalUrl": canonical,
        }
    return {
        "ok": not failed,
        "checks": checks,
        "anchor": {"retained": len(anchor["retained"]), "created": len(anchor["created"]), "deleted": len(anchor["deleted"])},
        "affectedComments": affected,
        "previewBuildId": preview_build_id,
        "canonicalUrl": canonical,
        "previewUrl": f"http://127.0.0.1:{DEFAULT_PREVIEW_PORT}{canonical}",
        "buildOutput": (build_result.get("output") or "")[-3000:],
    }


# ---------------------------------------------------------------------------
# 确认发布
# ---------------------------------------------------------------------------


def article_publish(state, rel_path: str, payload: dict) -> dict:
    """校验后异步执行发布；立即返回任务信息，前端轮询 publish-status。

    同步部分只做校验（revision/预览标识/幂等/草稿状态/锁）；
    长任务（preflight + publish）在守护线程中执行并更新锁阶段与账本。
    """
    import threading as _threading

    project_root = Path(state.project_root).resolve()
    platform_root = Path(getattr(state, "platform_root", None) or state.project_root).resolve()
    draft_revision = str(payload.get("draftRevision") or "")
    preview_build_id = str(payload.get("previewBuildId") or "")
    idempotency_key = str(payload.get("idempotencyKey") or "")
    if not draft_revision or not preview_build_id or not idempotency_key:
        raise ArticlePublishError("validation-failed", "发布参数不完整（缺少revision/预览标识/幂等键）。")
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", idempotency_key):
        raise ArticlePublishError("validation-failed", "幂等键格式无效。")

    prior = record_by_idempotency(project_root, idempotency_key)
    if prior:
        return {"ok": True, "duplicated": True, "task": {"status": prior.get("status")},
                **{k: prior.get(k) for k in (
                    "articleId", "revision", "canonicalUrl", "releaseId", "completedAt")}}

    article = articles.read_article(project_root, rel_path)
    article_id = str(article["frontMatter"].get("articleId") or "")
    revision = str(article["frontMatter"].get("articleRevision") or "")
    if revision != draft_revision:
        raise ArticlePublishError("conflict", "草稿已变化，请重新生成发布预览后再发布。")
    if article["frontMatter"].get("draft", True):
        raise ArticlePublishError("validation-failed", "文章仍为草稿状态，无法发布。请先在表单取消勾选「草稿」并保存。")
    preview = getattr(state, "article_preview", None)
    if not preview or preview.get("articleId") != article_id or preview.get("buildId") != preview_build_id:
        raise ArticlePublishError("preflight-required", "预览构建标识无效或已过期，请重新生成发布预览。")
    if time.time() - preview.get("createdAt", 0) > PREVIEW_FRESH_SECONDS:
        raise ArticlePublishError("preflight-required", "预览已过期（超过30分钟），请重新生成发布预览。")

    conflicts = _unrelated_uncommitted(project_root, rel_path)
    if conflicts:
        raise ArticlePublishError(
            "conflict",
            "存在与本文无关的未提交修改，发布被拒绝："
            + "、".join(conflicts[:8]) + "。请先提交或还原后再发布。",
        )

    lock = acquire_publish_lock(state, idempotency_key)
    if lock.get("inFlight") and lock.get("idempotencyKey") != idempotency_key:
        raise ArticlePublishError("conflict", "已有另一个发布任务正在进行，请稍后再试。")
    lock["articleId"] = article_id
    lock["kind"] = "article"
    lock["idempotencyKey"] = idempotency_key

    entry = {
        "id": f"pub_{hashlib.sha256(idempotency_key.encode()).hexdigest()[:12]}",
        "kind": "article",
        "articleId": article_id,
        "slug": _section_slug(article)[1],
        "revision": revision,
        "canonicalUrl": _canonical_url(article),
        "anchors": anchors_in(article.get("body") or ""),
        "idempotencyKey": idempotency_key,
        "status": "running",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "completedAt": "",
        "releaseId": "",
        "error": "",
    }

    def work():
        try:
            update_publish_stage(state, "building")
            preflight = publish_center.run_preflight(
                platform_root, full=False, content_repo_root=project_root,
                workspace_environment=state.workspace_environment,
            )
            if not preflight["success"]:
                entry["status"] = "failed_preflight"
                entry["error"] = "内容检查或构建失败（见日志）。"
                record_publish(project_root, entry)
                state.article_publish_result = {"articleId": article_id, "ok": False,
                                                "error": "发布前检查失败，请查看日志后重试。"}
                return
            update_publish_stage(state, "backing-up")
            result = publish_center.run_publish(platform_root, state.workspace_environment)
            if not result["success"]:
                entry["status"] = "failed_publish"
                entry["error"] = "发布流程失败（构建/备份/上传/切换任一阶段出错）。"
                record_publish(project_root, entry)
                state.article_publish_result = {"articleId": article_id, "ok": False,
                                                "error": "发布失败，请查看日志；服务器仍停留在旧版本。"}
                return
            entry["status"] = "ok"
            entry["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            entry["releaseId"] = _release_id_from_output(result.get("output", ""))
            record_publish(project_root, entry)
            state.article_preview = None
            state.article_publish_result = {
                "articleId": article_id,
                "ok": True,
                "revision": revision,
                "canonicalUrl": _canonical_url(article),
                "releaseId": entry["releaseId"],
                "completedAt": entry["completedAt"],
                "output": (result.get("output") or "")[-4000:],
            }
        except Exception as error:  # 线程内兜底：任何异常都写入账本失败状态
            entry["status"] = "failed_internal"
            entry["error"] = str(error)[:300]
            record_publish(project_root, entry)
            state.article_publish_result = {"articleId": article_id, "ok": False,
                                            "error": "发布任务异常中止，请查看日志。"}
        finally:
            release_publish_lock(state)

    _threading.Thread(target=work, name="article-publish", daemon=True).start()
    return {"ok": True, "task": {"inFlight": True, "stage": "validating", "idempotencyKey": idempotency_key}}


_RELEASE_RE = re.compile(r"release=(\S+)")


def _release_id_from_output(output: str) -> str:
    matched = _RELEASE_RE.search(output or "")
    return matched.group(1) if matched else ""
