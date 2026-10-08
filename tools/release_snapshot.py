#!/usr/bin/env python3
"""不可变 release snapshot：冻结一次发布的全部构建输入。

设计约束（P0-B）：
- 平台代码必须来自已提交的 Git commit（工作树必须 clean，含未跟踪文件）；
  不接受 dirty diff，也不在构建期间重新读取工作树。
- 私人内容允许未提交修改，但必须先冻结为不可变快照；快照一旦封存，
  后续修改原工作树不影响该快照。
- 作者评（data/author-notes）永远不是公开构建输入，不进入快照内容清单，
  也不写入任何元数据。
- site-overrides 只允许白名单文件（site.yaml/branding.yaml），且必须通过
  敏感扫描（绝对私人路径、疑似凭据）。
- 快照目录内容寻址：相同输入 → 相同 snapshotId；复用前必须复验全部文件。

本模块只使用标准库；供 build.sh、create-source-package.sh、publish.sh 与
Studio 隔离发布共用。"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from workspace import _flat_yaml, _merge_config_toml  # noqa: E402

SCHEMA_VERSION = 1
SNAPSHOT_MODES = ("full_site", "article_isolated")
ALLOWED_OVERRIDE_FILES = ("site.yaml", "branding.yaml")
RELEASE_DIR_NAME = "releases"
AUTHOR_NOTES_DIR = "data/author-notes"

_OVERRIDE_FORBIDDEN = (
    ("private-abs-path", re.compile(r"(/Users/|/home/[^/\s]+/|[A-Za-z]:\\\\?Users\\\\?|/opt/writing-site|/var/backups/lidaiji|/etc/lidaiji-comments)")),
    ("writing-settings", re.compile(r"^WRITING_(SSH_TARGET|DOMAIN|PASSWORD|TOKEN|KEY|SECRET)\s*=", re.MULTILINE)),
    ("credential-field", re.compile(r"(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['\"]?[^\s'\"]{6,}", re.IGNORECASE)),
)


class SnapshotError(Exception):
    pass


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run_git(root: Path, args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as error:
        raise SnapshotError("未找到 git，无法固定平台代码来源。") from error
    except subprocess.CalledProcessError as error:
        raise SnapshotError(f"git {' '.join(args)} 失败：{error.stderr.strip()}") from error
    return result.stdout


def platform_commit(root: Path, requested: str | None = None) -> str:
    inside = _run_git(root, ["rev-parse", "--is-inside-work-tree"]).strip()
    if inside != "true":
        raise SnapshotError("平台代码必须来自 Git 仓库提交；当前目录不是 Git 工作树。")
    status = _run_git(root, ["status", "--porcelain", "--untracked-files=all"])
    if status.strip():
        raise SnapshotError(
            "平台代码工作树不干净（含未跟踪文件），拒绝生成正式发布快照。"
            "请先提交或清理；构建产物目录（.cache/dist 等）已被 gitignore，不会触发此门禁。"
        )
    commit = _run_git(root, ["rev-parse", "HEAD"]).strip()
    if requested and requested != commit:
        raise SnapshotError(f"指定 platformCommit {requested} 与当前 HEAD {commit} 不一致。")
    return commit


def extract_archive(root: Path, commit: str, destination: Path) -> None:
    data = subprocess.run(
        ["git", "-C", str(root), "archive", "--format=tar", commit],
        capture_output=True,
        check=True,
    ).stdout
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            name = member.name
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts:
                raise SnapshotError(f"平台归档包含非法路径：{name}")
            if member.issym() or member.islnk():
                raise SnapshotError(f"平台归档包含符号链接：{name}")
            if member.isdir():
                continue
            if not member.isfile():
                raise SnapshotError(f"平台归档包含非常规文件：{name}")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise SnapshotError(f"平台归档无法读取：{name}")
            with target.open("wb") as handle:
                shutil.copyfileobj(source, handle)
            os.chmod(target, member.mode & 0o777)


def copy_tree_checked(source: Path, destination: Path, skip_drafts: bool = False) -> int:
    """复制内容目录；拒绝符号链接、特殊文件与路径穿越。

    skip_drafts=True 时排除 Hugo front matter 标记 draft: true 的 Markdown，
    保证 full_site 快照只包含明确获准公开的内容集合。返回排除的草稿数。
    """
    source = Path(source).resolve()
    if not source.is_dir():
        raise SnapshotError(f"内容目录不存在：{source}")
    destination.mkdir(parents=True, exist_ok=True)
    excluded = 0
    for dirpath, dirnames, filenames in os.walk(source, followlinks=False):
        base = Path(dirpath)
        for name in list(dirnames):
            candidate = base / name
            if candidate.is_symlink():
                raise SnapshotError(f"内容目录包含符号链接：{candidate.relative_to(source)}")
        for name in filenames:
            candidate = base / name
            if candidate.is_symlink():
                raise SnapshotError(f"内容目录包含符号链接：{candidate.relative_to(source)}")
            if not candidate.is_file():
                raise SnapshotError(f"内容目录包含非常规文件：{candidate.relative_to(source)}")
            relative = candidate.relative_to(source)
            if ".." in relative.parts:
                raise SnapshotError(f"内容路径越界：{relative}")
            if skip_drafts and _is_draft_file(candidate):
                excluded += 1
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(candidate, target)
    return excluded


_DRAFT_LINE = re.compile(r"^\s*draft\s*[:=]\s*[\"']?true[\"']?\s*$", re.IGNORECASE | re.MULTILINE)


def _is_draft_file(path: Path) -> bool:
    """只解析 YAML(---) 或 TOML(+++) front matter 中的 draft: true。"""
    if path.suffix.lower() not in (".md", ".markdown"):
        return False
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:8192]
    except OSError:
        return False
    lines = head.splitlines()
    if not lines:
        return False
    fence = lines[0].strip()
    if fence not in ("---", "+++"):
        return False
    end = next((index for index, line in enumerate(lines[1:], 1) if line.strip() == fence), None)
    if end is None:
        return False
    return bool(_DRAFT_LINE.search("\n".join(lines[1:end])))


def scan_overrides(path: Path, text: str) -> None:
    for kind, pattern in _OVERRIDE_FORBIDDEN:
        if pattern.search(text):
            raise SnapshotError(f"site-overrides/{path.name} 命中敏感规则 {kind}，拒绝进入发布快照。")


def copy_site_overrides(source_root: Path | None, tree: Path) -> list[str]:
    """只允许 site.yaml/branding.yaml；返回已复制文件名。"""
    copied: list[str] = []
    if not source_root:
        return copied
    source_root = Path(source_root)
    if not source_root.exists():
        return copied
    if source_root.is_symlink():
        raise SnapshotError("site-overrides 根目录不得是符号链接。")
    overrides_dir = tree / "site-overrides"
    for name in ALLOWED_OVERRIDE_FILES:
        candidate = source_root / name
        if not candidate.exists():
            continue
        if candidate.is_symlink() or not candidate.is_file():
            raise SnapshotError(f"site-overrides/{name} 必须是常规文件。")
        text = candidate.read_text(encoding="utf-8")
        scan_overrides(candidate, text)
        overrides_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(candidate, overrides_dir / name)
        copied.append(name)
    return copied


def build_content_manifest(tree: Path) -> tuple[dict, str]:
    entries: list[dict] = []
    for base_name in ("content", "site-overrides"):
        base = tree / base_name
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if path.is_symlink():
                raise SnapshotError(f"快照树包含符号链接：{path.relative_to(tree)}")
            if not path.is_file():
                continue
            relative = path.relative_to(tree).as_posix()
            entries.append({
                "path": relative,
                "type": "file",
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            })
    manifest = {"schemaVersion": 1, "entries": entries, "totalFiles": len(entries)}
    payload = canonical_json(manifest) + "\n"
    return manifest, sha256_bytes(payload.encode("utf-8"))


def config_fingerprint(tree: Path) -> str:
    config_root = tree / "config"
    if not config_root.exists():
        return sha256_bytes(b"")
    digest = hashlib.sha256()
    for path in sorted(config_root.rglob("*")):
        if path.is_symlink():
            raise SnapshotError("配置目录包含符号链接。")
        if not path.is_file():
            continue
        digest.update(path.relative_to(tree).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256_file(path).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _builder_version(tree: Path) -> str:
    version_file = tree / "VERSION"
    site_version = version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else "unknown"
    return f"release-snapshot/{SCHEMA_VERSION};site={site_version}"


def _fingerprint(fields: dict) -> tuple[str, str]:
    fingerprint = sha256_bytes((canonical_json(fields) + "\n").encode("utf-8"))
    return fingerprint, fingerprint[:16]


def _remove_author_notes(tree: Path) -> None:
    notes = tree / AUTHOR_NOTES_DIR
    if notes.exists():
        shutil.rmtree(notes)
    notes.mkdir(parents=True, exist_ok=True)


def _seal_permissions(root: Path) -> None:
    if os.name == "nt":
        return
    for path in [root, *root.rglob("*")]:
        try:
            if path.is_dir() or (path.stat().st_mode & 0o111):
                os.chmod(path, 0o700)
            else:
                os.chmod(path, 0o600)
        except OSError:
            pass


def create_snapshot(
    platform_root: Path,
    content_root: Path,
    site_overrides_root: Path | None,
    mode: str,
    snapshot_root: Path | None = None,
    requested_commit: str | None = None,
    baseline_release_id: str = "",
    target_article_sha256: str = "",
) -> dict:
    if mode not in SNAPSHOT_MODES:
        raise SnapshotError(f"snapshotMode 只能是 {'/'.join(SNAPSHOT_MODES)}。")
    if mode == "article_isolated" and not baseline_release_id:
        raise SnapshotError("article_isolated 模式必须提供可信基线 releaseId。")
    platform_root = Path(platform_root).resolve()
    commit = platform_commit(platform_root, requested_commit)
    snapshot_root = Path(snapshot_root).resolve() if snapshot_root else platform_root / ".cache" / RELEASE_DIR_NAME
    snapshot_root.mkdir(parents=True, exist_ok=True)

    temporary = Path(tempfile.mkdtemp(prefix=".tmp-", dir=snapshot_root))
    old_umask = os.umask(0o077)
    try:
        tree = temporary / "tree"
        extract_archive(platform_root, commit, tree)
        copy_tree_checked(Path(content_root), tree / "content", skip_drafts=(mode == "full_site"))
        _remove_author_notes(tree)
        copy_site_overrides(site_overrides_root, tree)
        for name in ALLOWED_OVERRIDE_FILES:
            override = tree / "site-overrides" / name
            if not override.is_file():
                continue
            flat = _flat_yaml(override)
            target = "hugo.toml" if name == "site.yaml" else "params.toml"
            if flat:
                _merge_config_toml(tree / "config" / "_default" / target, flat)

        manifest, manifest_sha = build_content_manifest(tree)
        (temporary / "content-manifest.json").write_text(
            canonical_json(manifest) + "\n", encoding="utf-8"
        )
        builder = _builder_version(tree)
        fingerprint_fields = {
            "snapshotSchemaVersion": SCHEMA_VERSION,
            "snapshotMode": mode,
            "platformCommit": commit,
            "builderVersion": builder,
            "configFingerprint": config_fingerprint(tree),
            "contentManifestSha256": manifest_sha,
            "baselineReleaseId": baseline_release_id or "",
            "targetArticleSha256": target_article_sha256 or "",
        }
        fingerprint, snapshot_id = _fingerprint(fingerprint_fields)
        metadata = {
            "snapshotSchemaVersion": SCHEMA_VERSION,
            "snapshotId": snapshot_id,
            "snapshotFingerprint": fingerprint,
            "snapshotMode": mode,
            "platformCommit": commit,
            "builderVersion": builder,
            "configFingerprint": fingerprint_fields["configFingerprint"],
            "contentManifestSha256": manifest_sha,
            "baselineReleaseId": baseline_release_id or "",
            "targetArticleSha256": target_article_sha256 or "",
            "contentFileCount": manifest["totalFiles"],
        }
        (temporary / "snapshot.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        verify_snapshot(temporary, expected_fingerprint=fingerprint)

        final = snapshot_root / snapshot_id
        if final.exists():
            existing = verify_snapshot(final)
            if existing["snapshotFingerprint"] != fingerprint:
                raise SnapshotError(
                    f"快照目录 {snapshot_id} 已存在但指纹不同；拒绝覆盖已有快照。"
                )
            shutil.rmtree(temporary, ignore_errors=True)
            metadata["tree"] = str(final / "tree")
            metadata["snapshotDir"] = str(final)
            metadata["reused"] = True
            return metadata

        os.replace(temporary, final)
        _seal_permissions(final)
        metadata["tree"] = str(final / "tree")
        metadata["snapshotDir"] = str(final)
        metadata["reused"] = False
        return metadata
    finally:
        os.umask(old_umask)
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)


def verify_snapshot(snapshot_dir: Path, expected_fingerprint: str | None = None) -> dict:
    snapshot_dir = Path(snapshot_dir).resolve()
    metadata_path = snapshot_dir / "snapshot.json"
    manifest_path = snapshot_dir / "content-manifest.json"
    tree = snapshot_dir / "tree"
    if not metadata_path.is_file() or not manifest_path.is_file() or not tree.is_dir():
        raise SnapshotError(f"快照结构不完整：{snapshot_dir}")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        stored_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SnapshotError(f"快照元数据无法读取：{error}") from error

    required = (
        "snapshotSchemaVersion", "snapshotId", "snapshotFingerprint", "snapshotMode",
        "platformCommit", "builderVersion", "configFingerprint", "contentManifestSha256",
    )
    for key in required:
        if key not in metadata:
            raise SnapshotError(f"快照元数据缺少字段：{key}")
    if metadata["snapshotSchemaVersion"] != SCHEMA_VERSION:
        raise SnapshotError("快照 schema 版本不兼容。")
    if metadata["snapshotMode"] not in SNAPSHOT_MODES:
        raise SnapshotError("快照模式非法。")

    manifest, manifest_sha = build_content_manifest(tree)
    if canonical_json(manifest) != canonical_json(stored_manifest):
        raise SnapshotError("快照内容清单与实际文件不一致（可能被篡改）。")
    if manifest_sha != metadata["contentManifestSha256"]:
        raise SnapshotError("快照内容清单摘要不一致。")

    notes_dir = tree / AUTHOR_NOTES_DIR
    if notes_dir.exists() and any(notes_dir.iterdir()):
        raise SnapshotError("快照包含作者评文件，拒绝使用。")
    for path in tree.rglob("*"):
        if path.is_symlink():
            raise SnapshotError(f"快照树包含符号链接：{path.relative_to(tree)}")

    if config_fingerprint(tree) != metadata["configFingerprint"]:
        raise SnapshotError("快照配置指纹不一致。")
    fingerprint_fields = {
        "snapshotSchemaVersion": metadata["snapshotSchemaVersion"],
        "snapshotMode": metadata["snapshotMode"],
        "platformCommit": metadata["platformCommit"],
        "builderVersion": metadata["builderVersion"],
        "configFingerprint": metadata["configFingerprint"],
        "contentManifestSha256": metadata["contentManifestSha256"],
        "baselineReleaseId": metadata.get("baselineReleaseId", ""),
        "targetArticleSha256": metadata.get("targetArticleSha256", ""),
    }
    fingerprint, snapshot_id = _fingerprint(fingerprint_fields)
    if fingerprint != metadata["snapshotFingerprint"] or snapshot_id != metadata["snapshotId"]:
        raise SnapshotError("快照指纹校验失败。")
    if expected_fingerprint and fingerprint != expected_fingerprint:
        raise SnapshotError("快照指纹与期望值不一致。")

    result = dict(metadata)
    result["tree"] = str(tree)
    result["snapshotDir"] = str(snapshot_dir)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="不可变 release snapshot（P0-B）。")
    sub = parser.add_subparsers(dest="action", required=True)

    create = sub.add_parser("create")
    create.add_argument("--platform-root", type=Path, required=True)
    create.add_argument("--content-root", type=Path, required=True)
    create.add_argument("--site-overrides-root", type=Path)
    create.add_argument("--mode", choices=SNAPSHOT_MODES, default="full_site")
    create.add_argument("--snapshot-root", type=Path)
    create.add_argument("--platform-commit")
    create.add_argument("--baseline-release-id", default="")
    create.add_argument("--target-article-sha256", default="")

    verify = sub.add_parser("verify")
    verify.add_argument("--snapshot", type=Path, required=True)

    show = sub.add_parser("show")
    show.add_argument("--snapshot", type=Path, required=True)

    args = parser.parse_args()
    try:
        if args.action == "create":
            result = create_snapshot(
                platform_root=args.platform_root,
                content_root=args.content_root,
                site_overrides_root=args.site_overrides_root,
                mode=args.mode,
                snapshot_root=args.snapshot_root,
                requested_commit=args.platform_commit,
                baseline_release_id=args.baseline_release_id,
                target_article_sha256=args.target_article_sha256,
            )
        else:
            result = verify_snapshot(args.snapshot)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except SnapshotError as error:
        print(f"发布快照错误：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
