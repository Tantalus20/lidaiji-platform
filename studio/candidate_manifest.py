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
import shutil
import time
from pathlib import Path

SCHEMA_VERSION = 1
BUILDER_VERSION = "candidate-manifest-1"
# 允许的派生/构建产物路径（相对候选站点根）
DERIVED_INDEX_PREFIXES = (
    "about/", "archives/", "categories/", "collections/", "people/",
    "periods/", "places/", "series/", "tags/", "search/",
)
DERIVED_INDEX_FILES = {"index.html", "index.xml", "sitemap.xml",
                       "robots.txt", "search-index.json"}
# 板块根页（essays/works/archives/about 的 index 本身是派生列表页；
# 注意不能整目录放行——其他文章页面必须保持"目标前缀才允许"）
SECTION_ROOT_FILES = {"essays/index.html", "works/index.html",
                      "archives/index.html", "about/index.html"}
BUILD_METADATA_FILES = {"BUILD_INFO", "comment-manifest.json"}
BUILD_METADATA_DIRS = ("css/", "js/", "fonts/", "img/", "images/", "favicon/")
CANDIDATE_ID_RE = __import__("re").compile(r"^cand_[0-9a-f]{20}$")


class CandidateError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _candidates_root(project_root: Path) -> Path:
    return Path(project_root).resolve() / ".cache" / "studio" / "candidates"


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
    if rel in DERIVED_INDEX_FILES or rel in SECTION_ROOT_FILES:
        return "derived-index"
    if any(rel.startswith(prefix) for prefix in DERIVED_INDEX_PREFIXES):
        return "derived-index"
    if rel in BUILD_METADATA_FILES:
        return "build-metadata"
    if any(rel.startswith(prefix) for prefix in BUILD_METADATA_DIRS):
        return "build-metadata"
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
) -> dict:
    """扫描候选目录生成清单。

    candidateDir 顶层即站点根（由调用方把构建产物复制进来）。
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
    candidate_id = "cand_" + hashlib.sha256(
        f"{baseline_id}|{str(snapshot.get('snapshotId') or '')}|{BUILDER_VERSION}|{files_digest}".encode()
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
                          target_url_prefix: str, preview_build_id: str = "") -> dict:
    """把构建产物复制进不可变候选目录并生成清单。

    返回 {candidateId, candidateDir, manifest, manifestSha256}；
    候选目录同名已存在时直接复用（幂等）。
    """
    project_root = Path(project_root).resolve()
    if not baseline:
        raise CandidateError("baseline-unavailable", "缺少可信基线，无法生成候选清单。")
    # 先复制到一个临时名，算出 candidateId 后落位（避免半成品目录）
    tmp_dir = _candidates_root(project_root) / f"tmp-{os.getpid()}-{int(time.time())}"
    tmp_site = tmp_dir / "site"
    try:
        tmp_site.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copytree(site_dir, tmp_site)
        manifest = build_candidate_manifest(tmp_site, baseline, snapshot,
                                            target_url_prefix, preview_build_id)
        manifest["unclassifiedPaths"] = [
            f["path"] for f in manifest["files"] if f["classification"] == "unclassified"]
        final_dir = _candidates_root(project_root) / manifest["candidateId"]
        if final_dir.is_dir():
            shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            tmp_site.rename(final_dir)
        (final_dir / "candidate-manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        manifest["manifestSha256"] = hashlib.sha256(
            (final_dir / "candidate-manifest.json").read_bytes()).hexdigest()
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
