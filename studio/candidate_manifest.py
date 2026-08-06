"""候选构建清单（v0.2.5）：隔离候选的文件级 SHA-256 manifest 与分类。

设计要点（对应文章级隔离发布任务书第 10 节）：
- 候选 = 构建产物目录（dist/site 的不可变副本），逐文件记录
  path/size/sha256/classification；
- 分类：target-article / target-resource / derived-index / build-metadata /
  unclassified（未分类即阻断）；
- candidateId 由“可重现部分”（文件清单 + 基线 + 快照 + 构建器版本）决定，
  相同输入重复构建得到相同 candidateId 与文件清单；
- 运行元数据（createdAt/previewBuildId）单独存放于 runtime 节，不参与哈希；
- 不记录绝对私人路径、不记录正文、不记录凭据；
- manifest 自身另算 sha256（manifestSha256）。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path

SCHEMA_VERSION = 1
BUILDER_VERSION = "candidate-manifest-1"
# 允许的派生/构建产物路径（相对候选站点根）
DERIVED_INDEX_FILES = {"index.html", "index.xml", "sitemap.xml",
                       "robots.txt", "search-index.json"}
# 板块根页与板块 Feed（essays/works/archives/about/timeline 的 index 是派生列表页；
# 注意不能整目录放行——其他文章页面必须走 baseline-content 分类）
SECTION_PAGE_RE = __import__("re").compile(
    r"^(essays|works|archives|about|timeline)/index\.(html|xml)$")
# 分类体系页（taxonomy 列表）
TAXONOMY_PREFIXES = ("categories/", "collections/", "people/", "periods/",
                     "places/", "series/", "tags/", "search/")
# 已知文章板块（essays/<slug>、works/<文集>/<slug>、archives/<slug>）：
# 非目标文章页面归类为 baseline-content —— 由候选差异检查（manifest 逐篇
# digest）保证与线上一致（候选内容来自基线 HEAD 树，构造上不可能含无关脏文件）
ARTICLE_SECTION_PREFIXES = ("essays/", "works/", "archives/")
BUILD_METADATA_FILES = {"BUILD_INFO", "comment-manifest.json"}
BUILD_METADATA_DIRS = ("css/", "js/", "fonts/", "img/", "images/", "favicon/")
CANDIDATE_ID_RE = __import__("re").compile(r"^cand_[0-9a-f]{20}$")


class CandidateError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


TEST_MODE_ENV = "LIDAIJI_TEST_MODE"
TEST_RUN_ID_ENV = "LIDAIJI_TEST_RUN_ID"
TEST_SOURCE_KIND_ENV = "LIDAIJI_TEST_SOURCE_KIND"


def build_test_identity(environment: dict | None = None) -> dict:
    """候选测试身份：仅由受信任的 Studio 启动环境签发。

    前端请求参数、文章 front matter 与 slug 均不参与；
    未启用测试模式 → 恒为 production/fixture=false。
    """
    env = environment if environment is not None else os.environ
    if str(env.get(TEST_MODE_ENV, "")).strip() == "1":
        return {
            "buildMode": "test",
            "fixture": True,
            "testRunId": str(env.get(TEST_RUN_ID_ENV, "")).strip() or "test",
            "sourceKind": str(env.get(TEST_SOURCE_KIND_ENV, "")).strip() or "acceptance-fixture",
        }
    return {"buildMode": "production", "fixture": False, "testRunId": "", "sourceKind": ""}


PRODUCTION_IDENTITY = {"buildMode": "production", "fixture": False, "testRunId": "", "sourceKind": ""}


def _candidates_root(project_root: Path) -> Path:
    """候选根目录：位于发布工作区根（内容仓库之外，不被公开备份/云同步/
    Git 收集）；tests 可用 LIDAIJI_PUBLISH_WORKSPACES_ROOT 覆盖。"""
    from studio import publish_isolated
    return publish_isolated._publish_workspaces_root() / "candidates"


def classify_file(rel_path: str, target_url_prefix: str, asset_sha256: set[str],
                  file_sha256: str) -> str:
    """对候选内相对路径分类。未分类 → 'unclassified'（调用方须阻断）。"""
    rel = rel_path.replace(os.sep, "/")
    if rel.startswith("media/") or rel.startswith("static/"):
        if file_sha256 in asset_sha256:
            return "target-resource"
        return "unclassified"
    prefix = target_url_prefix.lstrip("/")
    if not prefix.endswith("/"):
        prefix += "/"
    if rel == "index.html" or rel == "404.html":
        return "derived-index"
    if prefix and rel.startswith(prefix):
        if rel.endswith(".html") and rel.count("/") <= prefix.count("/"):
            return "target-article"
        return "target-resource"
    if rel in DERIVED_INDEX_FILES or SECTION_PAGE_RE.match(rel):
        return "derived-index"
    if any(rel.startswith(prefix) for prefix in TAXONOMY_PREFIXES):
        return "derived-index"
    if rel in BUILD_METADATA_FILES:
        return "build-metadata"
    if any(rel.startswith(prefix) for prefix in BUILD_METADATA_DIRS):
        return "build-metadata"
    if any(rel.startswith(prefix) for prefix in ARTICLE_SECTION_PREFIXES):
        return "baseline-content"
    return "unclassified"


def snapshot_asset_shas(snapshot: dict) -> set[str]:
    """快照资源清单的 SHA-256 集合（用于把候选中的资源归属到目标文章）。"""
    shas: set[str] = set()
    for entry in (snapshot or {}).get("assetManifest", {}).get("entries", []):
        if entry.get("sha256"):
            shas.add(str(entry["sha256"]))
    return shas


def build_candidate_manifest(
    candidate_dir: Path,
    baseline: dict,
    snapshot: dict,
    target_url_prefix: str,
    preview_build_id: str = "",
    test_identity: dict | None = None,
) -> dict:
    """扫描候选目录生成清单。

    candidateDir 顶层即站点根（由调用方把构建产物复制进来）。
    testIdentity 由受信环境签发，参与 manifestSha256 与 candidateId 计算。
    """
    candidate_dir = Path(candidate_dir)
    if not candidate_dir.is_dir():
        raise CandidateError("candidate-unavailable", "候选目录不存在。")
    asset_shas = snapshot_asset_shas(snapshot)
    files: list[dict] = []
    for file in sorted(candidate_dir.rglob("*")):
        if not file.is_file():
            continue
        rel = file.relative_to(candidate_dir).as_posix()
        if rel in ("candidate-manifest.json",):
            continue
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        files.append({
            "path": rel,
            "size": file.stat().st_size,
            "sha256": digest,
            "classification": classify_file(rel, target_url_prefix, asset_shas, digest),
        })
    unclassified = [f for f in files if f["classification"] == "unclassified"]
    baseline_id = str(baseline.get("privateContentCommit") or "")[:16]
    # 确定性：BUILD_INFO 含 buildTimestamp，属于运行元数据，不参与文件清单哈希
    reproducible_files = [f for f in files if f["path"] != "BUILD_INFO"]
    files_digest = hashlib.sha256(
        json.dumps(reproducible_files, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    identity = dict(test_identity or PRODUCTION_IDENTITY)
    identity["buildMode"] = "test" if identity.get("buildMode") == "test" else "production"
    identity["fixture"] = bool(identity.get("fixture"))
    candidate_id = "cand_" + hashlib.sha256(
        f"{baseline_id}|{str(snapshot.get('snapshotId') or '')}|{BUILDER_VERSION}"
        f"|{identity['buildMode']}:{int(identity['fixture'])}|{files_digest}".encode()
    ).hexdigest()[:20]
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "candidateId": candidate_id,
        "baselineId": baseline_id,
        "baselineManifestSha256": str(baseline.get("manifestSha256") or ""),
        "snapshotId": str(snapshot.get("snapshotId") or ""),
        "targetArticleId": str(snapshot.get("articleId") or ""),
        "targetSlug": str(snapshot.get("slug") or ""),
        "builderVersion": BUILDER_VERSION,
        "testIdentity": identity,
        "runtime": {
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "previewBuildId": preview_build_id,
            "targetUrlPrefix": target_url_prefix,
        },
        "files": files,
        "unclassifiedCount": len(unclassified),
        "reproducible": True,
    }
    payload = {k: v for k, v in manifest.items() if k != "manifestSha256"}
    manifest["manifestSha256"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return manifest


def materialize_candidate(project_root, site_dir: Path, baseline: dict, snapshot: dict,
                          target_url_prefix: str, preview_build_id: str = "",
                          test_identity: dict | None = None) -> dict:
    """把构建产物复制进不可变候选目录并生成清单。

    返回 {candidateId, candidateDir, manifest, manifestSha256}；
    候选目录同名已存在时直接复用（幂等）。
    testIdentity 由受信环境签发（未传入时按环境推导）。
    """
    project_root = Path(project_root).resolve()
    if not baseline:
        raise CandidateError("baseline-unavailable", "缺少可信基线，无法生成候选清单。")
    identity = test_identity if test_identity is not None else build_test_identity()
    # 先复制到一个临时名，算出 candidateId 后落位（避免半成品目录）
    tmp_dir = _candidates_root(project_root) / f"tmp-{os.getpid()}-{int(time.time())}"
    tmp_site = tmp_dir / "site"
    try:
        tmp_site.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copytree(site_dir, tmp_site)
        manifest = build_candidate_manifest(tmp_site, baseline, snapshot,
                                            target_url_prefix, preview_build_id, identity)
        manifest["unclassifiedPaths"] = [
            f["path"] for f in manifest["files"] if f["classification"] == "unclassified"]
        # manifestSha256 必须基于最终载荷（含 unclassifiedPaths）计算
        final_payload = {k: v for k, v in manifest.items() if k != "manifestSha256"}
        manifest["manifestSha256"] = hashlib.sha256(
            json.dumps(final_payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        final_dir = _candidates_root(project_root) / manifest["candidateId"]
        if final_dir.is_dir():
            # 复用路径：必须先完整重验（防篡改/半成品目录）
            manifest_file = final_dir / "candidate-manifest.json"
            if not manifest_file.is_file():
                raise CandidateError("candidate-tampered", "候选清单缺失（半成品目录），已阻止复用。")
            stored = json.loads(manifest_file.read_text(encoding="utf-8"))
            violations = verify_candidate(final_dir, stored, baseline, snapshot)
            if violations:
                raise CandidateError(
                    "candidate-tampered",
                    "候选已被篡改或损坏，已阻止：" + "；".join(violations[:5]))
            manifest = stored
            shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            tmp_site.rename(final_dir)
            violations = verify_candidate(final_dir, manifest, baseline, snapshot)
            if violations:
                raise CandidateError("candidate-tampered", "候选自检失败：" + "；".join(violations[:5]))
        for file in sorted(final_dir.rglob("*")):
            try:
                if file.is_symlink():
                    raise CandidateError("candidate-tampered", "候选目录含符号链接。")
                if file.is_dir():
                    file.chmod(0o700)
                else:
                    file.chmod(0o600)
            except OSError as error:
                raise CandidateError("candidate-tampered", f"候选权限设置失败：{error}") from error
        (final_dir / "candidate-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        # 生命周期清理：保留当前使用中候选；已发布候选按账本识别
        published_ids: set[str] = set()
        try:
            from studio import publish_article as _pa
            for entry in _pa.read_ledger(Path(project_root)):
                if entry.get("status") == "ok" and entry.get("candidateId"):
                    published_ids.add(str(entry["candidateId"]))
        except Exception:
            pass
        sweep_candidates(project_root, keep_id=manifest["candidateId"], published_ids=published_ids)
        return {
            "candidateId": manifest["candidateId"],
            "candidateDir": str(final_dir),
            "manifest": manifest,
            "manifestSha256": manifest["manifestSha256"],
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def load_candidate_manifest(project_root: Path, candidate_id: str) -> dict:
    if not CANDIDATE_ID_RE.match(candidate_id or ""):
        raise CandidateError("validation-failed", "候选标识格式不正确。")
    manifest_path = _candidates_root(project_root) / candidate_id / "candidate-manifest.json"
    if not manifest_path.is_file():
        raise CandidateError("not-found", "候选不存在。")
    return json.loads(manifest_path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 候选完整性重验（复用与正式发布前必须执行）
# ---------------------------------------------------------------------------

_CLASS_TYPE_RULES = {
    "target-article": lambda rel: rel.endswith(".html"),
    "derived-index": lambda rel: rel.endswith((".html", ".xml"))
    or rel in ("robots.txt", "search-index.json", "404.html", "index.html"),
    "build-metadata": lambda rel: rel in ("BUILD_INFO", "comment-manifest.json")
    or any(rel.startswith(p) for p in BUILD_METADATA_DIRS),
    "baseline-content": lambda rel: rel.endswith(".html"),
    "target-resource": lambda rel: not rel.endswith(".html"),
}


def verify_candidate(candidate_dir: Path, manifest: dict, baseline: dict | None = None,
                     snapshot: dict | None = None) -> list[str]:
    """候选文件树完整性重验；返回违规清单（空 = 通过）。"""
    violations: list[str] = []
    candidate_dir = Path(candidate_dir)
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        violations.append("manifest schema 版本不符")
    cid = str(manifest.get("candidateId") or "")
    if not CANDIDATE_ID_RE.match(cid):
        violations.append("candidateId 格式非法")
    identity = manifest.get("testIdentity")
    if not isinstance(identity, dict) or identity.get("buildMode") not in ("test", "production"):
        violations.append("testIdentity 缺失或非法")
    files = manifest.get("files")
    if not isinstance(files, list):
        return violations + ["manifest 缺少 files 列表"]
    # manifestSha256 重算
    payload = {k: v for k, v in manifest.items() if k != "manifestSha256"}
    if hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest() != str(manifest.get("manifestSha256") or ""):
        violations.append("manifestSha256 不匹配")
    # candidateId 重算（需基线+快照）
    if baseline is not None and snapshot is not None and isinstance(identity, dict):
        reproducible = [f for f in files if f.get("path") != "BUILD_INFO"]
        digest = hashlib.sha256(json.dumps(reproducible, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        expected = "cand_" + hashlib.sha256(
            f"{str(baseline.get('privateContentCommit') or '')[:16]}|{str(snapshot.get('snapshotId') or '')}|{BUILDER_VERSION}"
            f"|{identity.get('buildMode')}:{int(bool(identity.get('fixture')))}|{digest}".encode()
        ).hexdigest()[:20]
        if expected != cid:
            violations.append("candidateId 与内容不匹配")
    # 目录遍历：无符号链接、无额外文件
    actual: set[str] = set()
    for root, dirs, names in os.walk(candidate_dir, followlinks=False):
        for name in dirs + names:
            node = Path(root) / name
            if node.is_symlink():
                violations.append(f"符号链接：{node.relative_to(candidate_dir).as_posix()}")
                continue
            if node.is_file() and node.name != "candidate-manifest.json":
                actual.add(node.relative_to(candidate_dir).as_posix())
    expected = {str(f["path"]) for f in files if f.get("path")}
    for rel in sorted(expected - actual):
        violations.append(f"缺失文件：{rel}")
    for rel in sorted(actual - expected):
        violations.append(f"额外文件：{rel}")
    for entry in files:
        rel = str(entry.get("path") or "")
        if not rel or rel.startswith(("/", "../")) or ".." in rel.split("/") or "\\" in rel:
            violations.append(f"路径越界：{rel}")
            continue
        node = candidate_dir / rel
        if not node.is_file():
            violations.append(f"文件不存在：{rel}")
            continue
        if int(entry.get("size", -1)) != node.stat().st_size:
            violations.append(f"大小不符：{rel}")
        if str(entry.get("sha256") or "") != hashlib.sha256(node.read_bytes()).hexdigest():
            violations.append(f"SHA-256 不符：{rel}")
        rule = _CLASS_TYPE_RULES.get(str(entry.get("classification") or ""))
        if rule and not rule(rel):
            violations.append(f"文件类型与分类不符：{rel}（{entry.get('classification')}）")
    return violations


# ---------------------------------------------------------------------------
# slug 前缀启发式已移除（审计阻断项）：slug 不以 acc-/iso-/ce-shi-/layout-test/
# fixture- 开头作为测试判定。测试身份只来自 build_test_identity 的受信环境。
# 以下仅保留“测试模式下检查 fixture 命名纪律”的辅助（不参与任何门禁）。
# ---------------------------------------------------------------------------

TEST_MARKER_SEGMENTS = ("acc-", "iso-", "ce-shi-", "layout-test", "fixture-", "test-fixture")


def slug_marker_hits(manifest: dict) -> list[str]:
    """仅测试模式下的 fixture 命名纪律提示（非门禁）。"""
    hits: list[str] = []
    for entry in manifest.get("files", []):
        rel = str(entry.get("path") or "")
        segments = [seg for seg in rel.split("/") if seg]
        if any(any(seg.startswith(marker) for marker in TEST_MARKER_SEGMENTS) for seg in segments):
            hits.append(rel)
    return hits


# ---------------------------------------------------------------------------
# 候选生命周期
# ---------------------------------------------------------------------------

KEEP_VALID_DAYS = 7
KEEP_BLOCKED_DAYS = 1
KEEP_PUBLISHED_DAYS = 30


_SWEEP_FAILURE_LOG_NAME = "sweep-failures.log"
_SWEEP_LOG_MAX_BYTES = 1024 * 1024


def _redact_sweep_error(message: str) -> str:
    """安全截断与脱敏：不记录正文、Token、绝对私人路径、凭据。"""
    text = str(message or "")[:300]
    text = re.sub(r"[/\\]Users[/\\][^:\s]+", "<path>", text)
    text = re.sub(r"\b(ghp_|glpat-|AKIA|xox[abprs]-)[A-Za-z0-9_-]+", r"\1<redacted>", text)
    text = re.sub(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----", "<private-key>", text)
    return text


def _sweep_log_path(project_root) -> Path:
    return Path(project_root).resolve() / ".cache" / "studio" / "publish-logs" / _SWEEP_FAILURE_LOG_NAME


def _append_sweep_failure(project_root, entry: dict) -> None:
    """清理失败安全日志（受控 publish-logs 目录，JSONL 追加，大小上限 1MB）。"""
    try:
        log_path = _sweep_log_path(project_root)
        log_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if log_path.is_file() and log_path.stat().st_size > _SWEEP_LOG_MAX_BYTES:
            log_path.unlink(missing_ok=True)  # 超限轮转：重写为仅保留最近条目（下次追加）
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 日志写入失败绝不触发递归崩溃


def sweep_candidates(project_root, keep_id: str = "", published_ids: set[str] | None = None) -> dict:
    """清理过期候选；保留：当前使用中（keep_id）、已发布（published_ids，30 天）、
    有效未发布（7 天）、BLOCKED（1 天）。清理只针对校验过的候选目录。

    清理失败写入受控日志（publish-logs/sweep-failures.log，脱敏），
    不阻断、不扩大范围、不跟随符号链接；下一次清理自然重试。
    """
    from datetime import datetime
    root = _candidates_root(project_root)
    if not root.is_dir():
        return {"removed": [], "failed": []}
    removed: list[str] = []
    failed: list[str] = []
    now = datetime.now().astimezone()
    published_ids = published_ids or set()
    for child in sorted(root.iterdir()):
        if not CANDIDATE_ID_RE.match(child.name):
            continue
        if child.name == keep_id:
            continue
        stage = "remove"
        status = "unknown"
        try:
            manifest = json.loads((child / "candidate-manifest.json").read_text(encoding="utf-8"))
        except Exception as read_error:
            # 半删除/清单缺失（如上次删除中途失败）：目录已不可用，
            # 下一安全周期直接整体修复清理（不评估保留期）
            try:
                shutil.rmtree(child, ignore_errors=False)
                removed.append(f"{child.name} (repair)")
            except Exception as repair_error:
                failed.append(f"{child.name}: {_redact_sweep_error(repair_error)}")
                _append_sweep_failure(project_root, {
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "candidateId": child.name,
                    "status": "repair",
                    "stage": "remove",
                    "errorType": type(repair_error).__name__,
                    "message": _redact_sweep_error(repair_error),
                })
            continue
        try:
            created_raw = (manifest.get("runtime") or {}).get("createdAt", "")
            created = datetime.fromisoformat(created_raw)
            age_days = (now - created).total_seconds() / 86400.0
            blocked = bool(manifest.get("unclassifiedCount")) \
                or (manifest.get("testIdentity") or {}).get("buildMode") == "test"
            if child.name in published_ids:
                keep = KEEP_PUBLISHED_DAYS
                status = "published"
            elif blocked:
                keep = KEEP_BLOCKED_DAYS
                status = "blocked"
            else:
                keep = KEEP_VALID_DAYS
                status = "valid"
            stage = "evaluate"
            if age_days > keep:
                stage = "remove"
                shutil.rmtree(child, ignore_errors=False)
                removed.append(child.name)
        except Exception as error:  # 清理失败不阻断：安全记录，下次重试
            failed.append(f"{child.name}: {_redact_sweep_error(error)}")
            _append_sweep_failure(project_root, {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "candidateId": child.name,
                "status": status,
                "stage": stage,
                "errorType": type(error).__name__,
                "message": _redact_sweep_error(error),
            })
    return {"removed": removed, "failed": failed}


def sweep_failure_summary(project_root) -> dict:
    """清理失败日志摘要（状态接口可展示；不泄露正文/秘密）。"""
    log_path = _sweep_log_path(project_root)
    if not log_path.is_file():
        return {"count": 0, "recent": []}
    entries: list[dict] = []
    try:
        for line in log_path.read_text(encoding="utf-8").splitlines()[-50:]:
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
    except OSError:
        return {"count": 0, "recent": []}
    return {"count": len(entries), "recent": [
        {k: e.get(k) for k in ("ts", "candidateId", "stage", "errorType")} for e in entries[-3:]]}
