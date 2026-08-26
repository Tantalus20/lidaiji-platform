"""长文图片卡 artifact 管理（V0.2）。

产物目录（衍生物，可重建，非正文权威）：
  <share-root>/artifacts/<shareId>/<shareRevision>/qzone-card-v1/
      manifest.json
      01.png ...

安全边界：
- 所有读取路径必须经过 safe_resolve：只允许 artifact 根内文件、禁 `..`、
  禁符号链接逃逸、文件名必须为 manifest 列出的规范名；
- manifest 记录逐文件 SHA-256；same revision + renderer + template 可复现；
- shareRevision 变化 → 旧 artifact 标 stale，禁止发布到新正文 URL。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from share_publisher.cards import RENDERER_VERSION, TEMPLATE_VERSION

MANIFEST_NAME = "manifest.json"
LONG_TEMPLATE_VERSION = "qzone-long-cards-v1"
LONG_RENDERER_VERSION = "share-long-composer-1"


class ArtifactError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def artifact_dir(share_root: Path, share_id: str, share_revision: str) -> Path:
    return share_root / "artifacts" / share_id / share_revision / TEMPLATE_VERSION


def long_artifact_dir(share_root: Path, share_id: str, share_revision: str) -> Path:
    return share_root / "artifacts" / share_id / share_revision / LONG_TEMPLATE_VERSION


def long_manifest_exists(share_root: Path, share_id: str, share_revision: str) -> bool:
    """长图 manifest 是否已生成（路径存在性，不校验内容）。"""
    return (long_artifact_dir(share_root, share_id, share_revision) / MANIFEST_NAME).is_file()


def read_long_manifest(share_root: Path, share_id: str, share_revision: str) -> dict:
    manifest_path = long_artifact_dir(share_root, share_id, share_revision) / MANIFEST_NAME
    if not manifest_path.is_file():
        raise ArtifactError("not-found", "长图 artifact 未生成。")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise ArtifactError("corrupt-manifest", f"长图 manifest 无法解析：{error}") from error
    if not isinstance(data, dict) or data.get("templateVersion") != LONG_TEMPLATE_VERSION:
        raise ArtifactError("corrupt-manifest", "长图 manifest 格式不正确。")
    return data


def long_stale(manifest: dict, current_revision: str, current_cards_hash: str) -> bool:
    return (
        str(manifest.get("shareRevision") or "") != str(current_revision)
        or str(manifest.get("sourceArtifactHash") or "") != str(current_cards_hash)
    )


def safe_resolve(share_root: Path, share_id: str, share_revision: str, name: str, long: bool = False) -> Path:
    """把请求的文件名解析为 artifact 根内的绝对路径（防穿越/符号链接）。

    long=True 时解析到长图目录（qzone-long-cards-v1），否则为卡片目录。
    """
    root = (long_artifact_dir if long else artifact_dir)(share_root, share_id, share_revision).resolve()
    text = str(name or "").strip()
    if not text or "/" in text or "\\" in text or text in (".", ".."):
        raise ArtifactError("invalid-path", "artifact 文件名不合法。")
    target = (root / text).resolve()
    if target.parent != root or not target.is_file():
        raise ArtifactError("not-found", "artifact 文件不存在。")
    if target.is_symlink() or root not in target.parents:
        raise ArtifactError("invalid-path", "artifact 路径不安全。")
    return target


def read_manifest(share_root: Path, share_id: str, share_revision: str) -> dict:
    manifest_path = artifact_dir(share_root, share_id, share_revision) / MANIFEST_NAME
    if not manifest_path.is_file():
        raise ArtifactError("not-found", "图片 artifact 未生成。")
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise ArtifactError("corrupt-manifest", f"artifact manifest 无法解析：{error}") from error
    if not isinstance(data, dict) or data.get("templateVersion") != TEMPLATE_VERSION:
        raise ArtifactError("corrupt-manifest", "artifact manifest 格式不正确。")
    return data


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(candidate: Path, manifest: dict) -> str:
    """写 manifest.json 并返回 manifest SHA-256（作为发布快照指纹）。"""
    text = json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n"
    (candidate / MANIFEST_NAME).write_text(text, encoding="utf-8")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_stale(manifest: dict, current_revision: str) -> bool:
    return str(manifest.get("shareRevision") or "") != str(current_revision)


def page_names(manifest: dict) -> list[str]:
    """按页码排序的 PNG 文件名列表。"""
    names = sorted(
        (file["name"] for file in manifest.get("files", []) if file.get("name", "").endswith(".png")),
        key=lambda n: int(re_digits(n)),
    )
    return names


def re_digits(name: str) -> str:
    import re

    matched = re.search(r"\d+", name)
    return matched.group(0) if matched else "0"


def verify_artifact(share_root: Path, share_id: str, share_revision: str) -> list[str]:
    """字节级校验 artifact：manifest 与 PNG 逐一比对，返回差异（空 = 通过）。"""
    manifest = read_manifest(share_root, share_id, share_revision)
    errors: list[str] = []
    expected = {f["name"]: f["sha256"] for f in manifest.get("files", [])}
    for name, digest in expected.items():
        try:
            target = safe_resolve(share_root, share_id, share_revision, name)
        except ArtifactError as error:
            errors.append(f"{name}: {error.message}")
            continue
        if sha256_file(target) != digest:
            errors.append(f"{name}: 哈希不一致")
    return errors


PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def is_png(data: bytes) -> bool:
    return data[:8] == PNG_MAGIC
