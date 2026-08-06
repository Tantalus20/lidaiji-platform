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
import os
import re
import time
from pathlib import Path

from studio import articles, versions
from studio import candidate_manifest, publish_center, publish_isolated, sensitive_scan

PUBLISH_LOCK_AGE_SECONDS = 900 + 60  # publish.sh 超时上限 + 恢复余量
PREVIEW_FRESH_SECONDS = 30 * 60  # 预览构建标识有效期
DEFAULT_PREVIEW_PORT = 1313
LEDGER_NAME = "publish-history.json"
ANCHOR_RE = re.compile(r"<!-- paragraph-id:(p-[a-f0-9]{12}) -->")


class ArticlePublishError(Exception):
    """可直接转成 JSON 错误响应的失败（可携带结构化字段）。"""

    def __init__(self, code: str, message: str, fields: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.fields = fields or {}


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
            "processId": os.getpid(),
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
    # content/<section>/<slug>/index.md 或 content/works/<文集>/<slug>/index.md
    # → /<section>/.../<slug>/
    if len(parts) >= 4 and parts[0] == "content" and parts[-1] == "index.md":
        return "/" + "/".join(parts[1:-1]) + "/"
    return "/"


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
        "preview": {
            "snapshotId": str((preview or {}).get("snapshotId") or ""),
            "sourceFileSha256": str(((preview or {}).get("snapshot") or {}).get("sourceFileSha256") or "")[:12],
            "createdAt": (preview or {}).get("createdAt"),
            "fresh": preview_fresh,
            "baselineCommit": str(((preview or {}).get("baseline") or {}).get("privateContentCommit") or "")[:12],
            "candidate": (preview or {}).get("candidate"),
        },
        "lock": publish_lock_status(state),
        "result": getattr(state, "article_publish_result", None),
        "candidateSweep": candidate_manifest.sweep_failure_summary(project_root),
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


def rehearsal(project_root: Path, article: dict, baseline: dict | None = None) -> dict:
    """锚点迁移预演：以“当前线上已发布版本”的段落集为基准（而非工作区自身）。

    - retained：线上存在且目标快照仍存在；
    - created：目标快照新增；
    - deleted：线上存在、目标快照已消失（将转 historical）。

    基准优先级：线上 manifest 中该文章的 paragraphs → 账本上次发布锚点 →
    兜底用当前文件自身（仅当两者都缺失时，deleted 恒为 0，门禁不误报）。
    """
    article_id = str(article["frontMatter"].get("articleId") or "")
    before: set[str] = set()
    if baseline is not None:
        for entry in baseline.get("manifest", {}).get("articles", []):
            if entry.get("articleId") == article_id:
                before = {p.get("paragraphId", "") for p in entry.get("paragraphs", []) if p.get("paragraphId")}
                break
    if not before:
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


def article_publish_preview(state, rel_path: str) -> dict:
    """隔离发布预览：基线解析 → 目标快照 → 隔离构建 → 候选差异校验。"""
    import time as _time

    project_root = Path(state.project_root).resolve()
    platform_root = Path(getattr(state, "platform_root", None) or state.project_root).resolve()
    article = articles.read_article(project_root, rel_path)
    fm = article["frontMatter"]
    article_id = str(fm.get("articleId") or "")
    revision = str(fm.get("articleRevision") or "")
    canonical = _canonical_url(article)
    preview_build_id = ""
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

    # 平台/发布工具工作区门禁（脏 → FAIL）
    platform_dirty = publish_isolated.platform_clean_check(platform_root)
    if platform_dirty:
        check("platform-clean", "FAIL", f"平台代码/发布工具存在未提交修改：{'、'.join(platform_dirty[:5])}")
    else:
        check("platform-clean", "PASS", "")

    # 已发布基线解析（fail-closed）
    domain = ""
    settings = publish_center.read_settings(platform_root)
    domain = str(settings.get("WRITING_DOMAIN") or "").strip()
    baseline = None
    baseline_error = ""
    if not domain:
        check("baseline", "FAIL", "缺少 WRITING_DOMAIN 配置，无法确认线上基线。")
    else:
        try:
            baseline = publish_isolated.resolve_published_baseline(state, domain)
            check("baseline", "PASS", f"线上基线：私人仓库提交 {str(baseline['privateContentCommit'])[:8]}，"
                                      f"校验 {baseline['verifiedArticles']} 篇全部一致")
        except publish_isolated.IsolationError as error:
            baseline_error = error.message
            check("baseline", "FAIL", error.message)

    # 无关脏文件摘要（允许存在、不进入候选——仅展示）
    dirty = publish_isolated.unrelated_dirty_summary(state)
    if dirty["count"]:
        check("unrelated-dirty", "WARNING",
              f"作者工作区另有 {dirty['count']} 个未提交文件（其他文章 {dirty['byKind'].get('otherArticle', 0)}、"
              f"其他资源 {dirty['byKind'].get('otherAsset', 0)}、笔记 {dirty['byKind'].get('notes', 0)}、"
              f"其他 {dirty['byKind'].get('other', 0)}）；这些文件不会进入本次发布候选。")

    anchor = rehearsal(project_root, article, baseline)
    affected, reachable = affected_comment_count(state, article_id, anchor["deleted"])
    if anchor["deleted"] and not reachable:
        check("comments-compat", "WARNING", "评论服务不可达，受影响段评数量未知")
        affected = None
    elif affected:
        check("comments-compat", "WARNING", f"受影响段评 {affected} 条（锚点转历史后不公开显示）")
    else:
        check("comments-compat", "PASS", "")
    large_gate = len(anchor["deleted"]) > 100
    if large_gate:
        check("paragraph-large-gate", "FAIL",
              f"本次发布将把 {len(anchor['deleted'])} 个线上段落转为历史，超过大规模失效门禁（100/20%）。"
              "这是有意的段落结构调整时，可在发布确认时勾选“确认大规模段落调整”放行。")
    else:
        check("paragraph-large-gate", "PASS", "")

    snapshot = None
    candidate = None
    candidate_diff = None
    build_result = {"success": False, "output": "", "duration": 0.0}
    # 仅“段落大规模失效门禁”FAIL 不阻断快照/隔离构建（该门禁由发布确认时显式放行）
    failed_so_far = [c for c in checks if c["status"] == "FAIL" and c["name"] != "paragraph-large-gate"]
    if not failed_so_far and baseline is not None:
        try:
            target = publish_isolated._resolve_target(state, rel_path)
            snapshot = publish_isolated.create_target_snapshot(state, rel_path, revision)
            preview_build_id = hashlib.sha256(f"{article_id}|{revision}|{snapshot['snapshotId']}|{_time.time()}".encode()).hexdigest()[:20]
            if snapshot["assetManifest"]["unreferenced"]:
                check("assets", "WARNING",
                      f"未使用资源（不纳入候选）：{'、'.join(snapshot['assetManifest']['unreferenced'][:5])}")
            else:
                check("assets", "PASS", f"引用资源 {len(snapshot['assetManifest']['entries'])} 个")
            merged = publish_isolated.build_merged_content(state, target, snapshot, baseline)
            try:
                iso_env = publish_isolated.isolated_environment(merged, state.workspace_environment)
                build_result = publish_center.run_preflight(
                    platform_root, full=False,
                    content_repo_root=merged["repoRoot"],
                    workspace_environment=iso_env,
                )
                if build_result["success"]:
                    check("hugo-build", "PASS", f"隔离构建成功，耗时 {build_result['duration']} 秒")
                    manifest_path = publish_center.site_output_dir(platform_root) / "comment-manifest.json"
                    if manifest_path.is_file():
                        candidate_diff = publish_isolated.candidate_diff_check(manifest_path, baseline, article_id)
                        if candidate_diff["unrelatedChangedCount"]:
                            check("candidate-diff", "FAIL",
                                  f"候选与线上存在无关差异：{'、'.join(candidate_diff['unrelatedChanges'][:5])}")
                        elif not candidate_diff["targetPresent"]:
                            check("candidate-diff", "FAIL", "候选缺少目标文章页面")
                        else:
                            check("candidate-diff", "PASS", "无关文章候选差异 0，目标文章已包含")
                        if build_result["success"] and candidate_diff["unrelatedChangedCount"] == 0 \
                                and candidate_diff["targetPresent"]:
                            try:
                                candidate = candidate_manifest.materialize_candidate(
                                    project_root, publish_center.site_output_dir(platform_root),
                                    baseline, snapshot, target_url_prefix=canonical,
                                    preview_build_id=preview_build_id,
                                    test_identity=candidate_manifest.build_test_identity())
                                scan = sensitive_scan.scan_candidate(candidate["candidateDir"])
                                unclassified = candidate["manifest"].get("unclassifiedPaths", [])
                                blocked = bool(scan["blocked"]) or bool(unclassified)
                                identity = candidate["manifest"].get("testIdentity") or {}
                                if identity.get("buildMode") == "test":
                                    check("build-mode", "WARNING",
                                          f"测试模式候选（testRunId={identity.get('testRunId')}），正式发布将被拒绝")
                                else:
                                    check("build-mode", "PASS", "正式模式候选（生产发布允许）")
                                if os.environ.get("LIDAIJI_TEST_MODE", "") == "1":
                                    marker_hits = candidate_manifest.slug_marker_hits(candidate["manifest"])
                                    if marker_hits:
                                        check("test-marker", "WARNING",
                                              "fixture 命名纪律提示（非门禁）：" + "、".join(marker_hits[:5]))
                                if scan["blocked"]:
                                    kinds = "、".join(sorted({f["kind"] for f in scan["findings"]}))
                                    check("sensitive-scan", "FAIL",
                                          f"候选命中敏感项已阻断：{kinds}（仅报告类型与位置，不显示内容）")
                                else:
                                    check("sensitive-scan", "PASS", "敏感扫描通过（文件/路径/内容/清单）")
                                if unclassified:
                                    check("candidate-manifest", "FAIL",
                                          f"候选含 {len(unclassified)} 个未分类文件，已阻止："
                                          + "、".join(unclassified[:5]))
                                else:
                                    check("candidate-manifest", "PASS",
                                          f"候选 {candidate['candidateId']} · 清单SHA "
                                          f"{candidate['manifestSha256'][:12]} · 文件 "
                                          f"{len(candidate['manifest']['files'])}")
                                candidate_info = {"candidateId": candidate["candidateId"],
                                                  "manifestSha256": candidate["manifestSha256"],
                                                  "fileCount": len(candidate["manifest"]["files"]),
                                                  "blocked": blocked,
                                                  "buildMode": (candidate["manifest"].get("testIdentity") or {}).get("buildMode", "production"),
                                                  "testRunId": (candidate["manifest"].get("testIdentity") or {}).get("testRunId", ""),
                                                  "error": "敏感扫描或分类未通过" if blocked else ""}
                                state._last_candidate_info = candidate_info
                            except candidate_manifest.CandidateError as error:
                                candidate_info = {"blocked": True, "error": error.message}
                                state._last_candidate_info = candidate_info
                                check("candidate-manifest", "FAIL", error.message)
                    else:
                        check("candidate-diff", "FAIL", "构建产物缺少内容清单")
                else:
                    check("hugo-build", "FAIL", "隔离构建失败（见日志尾部）")
            finally:
                publish_isolated.cleanup_merged_content(merged)
        except publish_isolated.IsolationError as error:
            check("target-snapshot", "FAIL", error.message)
        except Exception as error:
            check("target-snapshot", "FAIL", f"快照/隔离构建异常：{str(error)[:120]}")

    failed = [c for c in checks if c["status"] == "FAIL"]
    gate_only = bool(failed) and all(c["name"] == "paragraph-large-gate" for c in failed)
    candidate_info: dict | None = None
    if (not failed or gate_only) and snapshot is not None:
        candidate_info = getattr(state, "_last_candidate_info", None)
        state.article_preview = {
            "articleId": article_id,
            "revision": revision,
            "snapshotId": snapshot["snapshotId"],
            "snapshot": snapshot,
            "buildId": preview_build_id,
            "createdAt": _time.time(),
            "canonicalUrl": canonical,
            "baseline": baseline,
            "domain": domain,
            "largeRetireGate": gate_only,
            "candidate": candidate_info,
        }
    return {
        "ok": not failed,
        "gateOnly": gate_only,
        "candidate": candidate_info,
        "checks": checks,
        "anchor": {"retained": len(anchor["retained"]), "created": len(anchor["created"]), "deleted": len(anchor["deleted"])},
        "largeRetireGate": len(anchor["deleted"]) > 100,
        "affectedComments": affected,
        "previewBuildId": preview_build_id,
        "snapshotId": (snapshot or {}).get("snapshotId", ""),
        "assetManifest": (snapshot or {}).get("assetManifest", {"entries": [], "unreferenced": []}),
        "baseline": baseline and {
            "privateContentCommit": str(baseline.get("privateContentCommit") or "")[:16],
            "verifiedArticles": baseline.get("verifiedArticles", 0),
        },
        "unrelatedDirty": dirty,
        "candidate": candidate_info,
        "candidateDiff": candidate_diff,
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
    if os.environ.get("STUDIO_DISABLE_PRODUCTION_PUBLISH", "") == "1":
        raise ArticlePublishError("forbidden", "开发模式：本轮仅生成候选，未部署生产（发布到生产已禁用）。")
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

    snapshot_id = str(payload.get("snapshotId") or "")
    allow_large_retire = payload.get("allowLargeRetire") is True
    if not snapshot_id:
        raise ArticlePublishError("validation-failed", "发布参数不完整（缺少snapshotId）。")

    article = articles.read_article(project_root, rel_path)
    article_id = str(article["frontMatter"].get("articleId") or "")
    revision = str(article["frontMatter"].get("articleRevision") or "")
    if revision != draft_revision:
        raise ArticlePublishError("conflict", "草稿已变化，请重新生成发布预览后再发布。")
    if article["frontMatter"].get("draft", True):
        raise ArticlePublishError("validation-failed", "文章仍为草稿状态，无法发布。请先在表单取消勾选「草稿」并保存。")
    preview = getattr(state, "article_preview", None)
    if not preview:
        raise ArticlePublishError("preview-required", "尚未生成发布预览，请先生成。")
    if preview.get("articleId") != article_id or preview.get("buildId") != preview_build_id:
        raise ArticlePublishError("preview-stale", "预览构建标识无效或已过期，请重新生成发布预览。",
                                  fields={"expectedPreviewBuildId": str(preview.get("buildId") or ""),
                                          "actualPreviewBuildId": preview_build_id})
    if preview.get("snapshotId") != snapshot_id:
        raise ArticlePublishError("preview-stale", "snapshotId 与预览不一致，请重新生成发布预览。",
                                  fields={"expectedSnapshotId": str(preview.get("snapshotId") or ""),
                                          "actualSnapshotId": snapshot_id})
    if time.time() - preview.get("createdAt", 0) > PREVIEW_FRESH_SECONDS:
        raise ArticlePublishError("preview-expired", "预览已过期（超过30分钟），请重新生成发布预览。",
                                  fields={"previewCreatedAt": preview.get("createdAt"),
                                          "previewFreshSeconds": PREVIEW_FRESH_SECONDS})

    if preview.get("largeRetireGate") and not allow_large_retire:
        raise ArticlePublishError(
            "confirmation-required",
            "该预览触发了大规模段落失效门禁，请在确认对话框勾选“我确认这是一次有意的段落结构调整”后重试。",
        )

    # 同步重验目标文章快照哈希（预览后文件变化 → 立即拒绝，不启动发布任务）
    snapshot = preview.get("snapshot") or {}
    if snapshot:
        try:
            current = articles.read_article(project_root, rel_path)
            current_sha = hashlib.sha256(
                (Path(project_root) / str(rel_path)).read_bytes()).hexdigest()
            if current_sha != snapshot.get("sourceFileSha256"):
                raise ArticlePublishError("preview-stale", "目标文章在预览后发生变化，请重新生成发布预览。",
                                          fields={"expectedSourceFileSha256": str(snapshot.get("sourceFileSha256") or ""),
                                                  "actualSourceFileSha256": current_sha})
        except OSError:
            raise ArticlePublishError("conflict", "目标文章文件无法读取，请重新生成发布预览。") from None

    # 平台/发布工具工作区门禁（脏 → 阻止；私人内容脏允许且不进入候选）
    platform_dirty = publish_isolated.platform_clean_check(platform_root)
    if platform_dirty:
        raise ArticlePublishError(
            "conflict",
            "平台代码或发布工具存在未提交修改，发布被拒绝："
            + "、".join(platform_dirty[:5]) + "。请先提交或还原后再发布。",
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
        "snapshotId": snapshot_id,
        "canonicalUrl": _canonical_url(article),
        "anchors": anchors_in(article.get("body") or ""),
        "idempotencyKey": idempotency_key,
        "status": "running",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "completedAt": "",
        "releaseId": "",
        "previousReleaseId": "",
        "baselineCommit": (preview.get("baseline") or {}).get("privateContentCommit", ""),
        "error": "",
    }

    def work():
        merged = None
        try:
            target = publish_isolated._resolve_target(state, rel_path)
            # 使用预览时创建的快照（内容寻址不可变）；文件或资源变化会在此校验失败
            merged = publish_isolated.build_merged_content(state, target, preview["snapshot"],
                                                          preview.get("baseline"))
            iso_env = publish_isolated.isolated_environment(merged, state.workspace_environment)
            if allow_large_retire:
                iso_env["COMMENTS_MANIFEST_ALLOW_LARGE_RETIRE"] = "1"
            update_publish_stage(state, "building")
            preflight = publish_center.run_preflight(
                platform_root, full=False, content_repo_root=merged["repoRoot"],
                workspace_environment=iso_env,
            )
            if not preflight["success"]:
                entry["status"] = "failed_preflight"
                entry["error"] = "隔离构建或内容检查失败（见日志）。"
                record_publish(project_root, entry)
                state.article_publish_result = {"articleId": article_id, "ok": False,
                                                "error": "发布前检查失败，请查看日志后重试。"}
                return
            manifest_path = publish_center.site_output_dir(platform_root) / "comment-manifest.json"
            if manifest_path.is_file() and preview.get("baseline"):
                candidate = publish_isolated.candidate_diff_check(manifest_path, preview["baseline"], article_id)
                if candidate["unrelatedChangedCount"]:
                    entry["status"] = "failed_diff"
                    entry["error"] = "候选与线上存在无关差异。"
                    record_publish(project_root, entry)
                    state.article_publish_result = {"articleId": article_id, "ok": False,
                                                    "error": "候选包含无关文章变化，已阻止发布。"}
                    return
                try:
                    rebuilt = candidate_manifest.materialize_candidate(
                        project_root, publish_center.site_output_dir(platform_root), preview["baseline"],
                        preview["snapshot"], target_url_prefix=preview.get("canonicalUrl", ""),
                        preview_build_id=str(preview.get("buildId") or ""),
                        test_identity=candidate_manifest.build_test_identity())
                    expected_id = (preview.get("candidate") or {}).get("candidateId", "")
                    if expected_id and rebuilt["candidateId"] != expected_id:
                        entry["status"] = "failed_diff"
                        entry["error"] = "候选与预览不一致（candidateId 变化）。"
                        record_publish(project_root, entry)
                        state.article_publish_result = {
                            "articleId": article_id, "ok": False,
                            "error": "候选构建结果与预览不一致，已阻止发布。请重新生成预览。",
                            "candidateId": rebuilt["candidateId"]}
                        return
                    scan = sensitive_scan.scan_candidate(rebuilt["candidateDir"])
                    unclassified = rebuilt["manifest"].get("unclassifiedPaths", [])
                    test_identity = rebuilt["manifest"].get("testIdentity") or {}
                    if test_identity.get("buildMode") == "test":
                        entry["status"] = "failed_test_candidate"
                        entry["error"] = "测试候选禁止正式发布。"
                        record_publish(project_root, entry)
                        state.article_publish_result = {
                            "articleId": article_id, "ok": False,
                            "error": "测试候选禁止正式发布（buildMode=test，"
                                     f"testRunId={test_identity.get('testRunId')}）。"}
                        return
                    if scan["blocked"] or unclassified:
                        entry["status"] = "failed_scan"
                        entry["error"] = "候选敏感扫描或分类未通过。"
                        record_publish(project_root, entry)
                        reasons = []
                        if scan["blocked"]:
                            kinds = "、".join(sorted({f["kind"] for f in scan["findings"]}))
                            reasons.append(f"敏感项：{kinds}")
                        if unclassified:
                            reasons.append(f"未分类文件：{'、'.join(unclassified[:5])}")
                        state.article_publish_result = {
                            "articleId": article_id, "ok": False,
                            "error": "候选已阻断（" + "；".join(reasons) + "）"}
                        return
                    entry["candidateId"] = rebuilt["candidateId"]
                    entry["candidateManifestSha256"] = rebuilt["manifestSha256"]
                except candidate_manifest.CandidateError as error:
                    entry["status"] = "failed_scan"
                    entry["error"] = error.message
                    record_publish(project_root, entry)
                    state.article_publish_result = {"articleId": article_id, "ok": False,
                                                    "error": error.message}
                    return
            update_publish_stage(state, "backing-up")
            result = publish_center.run_publish(platform_root, iso_env)
            if not result["success"]:
                entry["status"] = "failed_publish"
                entry["error"] = "发布流程失败（构建/备份/上传/切换任一阶段出错）。"
                record_publish(project_root, entry)
                output_tail = (result.get("output") or "")[-4000:]
                state.article_publish_result = {"articleId": article_id, "ok": False,
                                                "error": "发布失败，请查看日志；服务器仍停留在旧版本。",
                                                "output": output_tail,
                                                "logUrl": _persist_publish_log(state.project_root, entry["id"],
                                                                              result.get("output") or "")}
                return
            entry["status"] = "ok"
            entry["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            entry["releaseId"] = _release_id_from_output(result.get("output", ""))
            record_publish(project_root, entry)
            state.article_preview = None
            output_tail = (result.get("output") or "")[-4000:]
            state.article_publish_result = {
                "articleId": article_id,
                "ok": True,
                "revision": revision,
                "canonicalUrl": _canonical_url(article),
                "releaseId": entry["releaseId"],
                "completedAt": entry["completedAt"],
                "candidateId": entry.get("candidateId", ""),
                "candidateManifestSha256": entry.get("candidateManifestSha256", ""),
                "output": output_tail,
                "logUrl": _persist_publish_log(state.project_root, entry["id"], result.get("output") or ""),
            }
        except Exception as error:  # 线程内兜底：任何异常都写入账本失败状态
            entry["status"] = "failed_internal"
            entry["error"] = str(error)[:300]
            record_publish(project_root, entry)
            state.article_publish_result = {"articleId": article_id, "ok": False,
                                            "error": "发布任务异常中止，请查看日志。"}
        finally:
            if merged is not None:
                publish_isolated.cleanup_merged_content(merged)
            release_publish_lock(state)

    _threading.Thread(target=work, name="article-publish", daemon=True).start()
    return {"ok": True, "task": {"inFlight": True, "stage": "validating", "idempotencyKey": idempotency_key}}



_PUBLISH_LOG_ID_RE = re.compile(r"^pub_[0-9a-f]{12}$")


def _persist_publish_log(project_root: str, log_id: str, output: str) -> str:
    """把发布完整日志写入 .cache/studio/publish-logs/<id>.log，返回下载 URL（失败返回空串）。"""
    if not output:
        return ""
    log_dir = Path(project_root) / ".cache" / "studio" / "publish-logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / f"{log_id}.log").write_text(output, encoding="utf-8")
        return f"/api/article/publish-log?id={log_id}"
    except OSError:
        return ""


_RELEASE_RE = re.compile(r"release=(\S+)")


def _release_id_from_output(output: str) -> str:
    matched = _RELEASE_RE.search(output or "")
    return matched.group(1) if matched else ""
