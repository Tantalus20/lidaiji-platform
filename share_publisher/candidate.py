"""分享站候选构建清单：文件级 SHA-256 + 可重现 candidateId + 敏感扫描。

参照正式站 candidate_manifest.py 的设计哲学（可重现身份、逐文件哈希、
敏感扫描、不可变 release），但完全独立于正式站发布链：
- 候选 = share-site 构建产物目录的不可变副本；
- candidateId 由可重现部分（文件路径+sha256 清单 + 构建器版本）决定；
- 敏感扫描复用 studio/sensitive_scan.scan_candidate；
- manifest 自身另有 sha256（manifestSha256）。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

SCHEMA_VERSION = 1
BUILDER_VERSION = "share-candidate-1"


class ShareCandidateError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_share_candidate_manifest(site_dir: Path, base_url: str = "") -> dict:
    """扫描构建产物目录，生成 {kind, builderVersion, schemaVersion, baseUrl,
    fileCount, candidateId, files:[{path,size,sha256}], runtime:{createdAt}}。

    candidateId 只由可重现部分决定（不含 runtime）。
    """
    if not site_dir.is_dir():
        raise ShareCandidateError("not-found", f"构建产物目录不存在：{site_dir}")
    files: list[dict] = []
    for path in sorted(site_dir.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(site_dir).as_posix()
        files.append({"path": rel, "size": path.stat().st_size, "sha256": sha256_file(path)})
    if not files:
        raise ShareCandidateError("empty", "构建产物为空。")
    reproducible = {
        "kind": "lidaiji-share-candidate",
        "builderVersion": BUILDER_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "baseUrl": base_url,
        "files": files,
    }
    candidate_id = hashlib.sha256(
        json.dumps(reproducible, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]
    manifest = {
        **reproducible,
        "candidateId": candidate_id,
        "fileCount": len(files),
        "runtime": {"createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds")},
    }
    return manifest


def write_candidate_manifest(candidate_dir: Path, manifest: dict) -> tuple[Path, str]:
    """把 manifest.json 与 manifest.sha256 写入候选目录；返回 (path, sha256)。"""
    manifest_path = candidate_dir / "manifest.json"
    text = json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n"
    manifest_path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    (candidate_dir / "manifest.sha256").write_text(f"{digest}  manifest.json\n", encoding="utf-8")
    return manifest_path, digest


def verify_share_candidate(candidate_dir: Path, manifest: dict) -> list[str]:
    """字节级校验候选：逐文件与 manifest 比对，返回差异消息（空 = 通过）。"""
    errors: list[str] = []
    site_dir = candidate_dir / "site"
    expected = {file["path"]: file["sha256"] for file in manifest.get("files", [])}
    actual: dict[str, str] = {}
    if site_dir.is_dir():
        for path in site_dir.rglob("*"):
            if not path.is_file() or path.is_symlink():
                continue
            actual[path.relative_to(site_dir).as_posix()] = sha256_file(path)
    for name in sorted(set(expected) | set(actual)):
        if name not in expected:
            errors.append(f"候选多出文件：{name}")
        elif name not in actual:
            errors.append(f"候选缺失文件：{name}")
        elif expected[name] != actual[name]:
            errors.append(f"文件哈希不一致：{name}")
    return errors
