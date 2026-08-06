"""文章级隔离发布（v0.2.3）：已发布基线 + 目标文章快照 = 隔离候选。

模型：
    作者工作区（可含多篇未提交修改，发布期间绝不改动）
        ── 目标文章快照（已保存 revision，磁盘 SHA 校验）──┐
    已发布基线（私人仓库 HEAD 树，逐篇与生产 manifest 校验）─┤
    目标文章专属资源（assetManifest）──────────────────────┘
        → 隔离内容仓库（git archive HEAD + 目标覆盖）
        → 既有 build.sh（LIDAIJI_CONTENT_REPO_ROOT 指向隔离仓库）
        → 候选差异校验（无关文章 manifest 与生产字节/语义一致）
        → 既有 publish.sh 正式发布

关键保证：
- 无关文章的未提交修改不进入候选、不被提交、不被改动；
- 作者工作区在发布前后逐文件 SHA 核验（不受任何发布操作影响）；
- 平台代码/发布工具/Hugo 配置脏时仍然阻止发布；
- 线上基线无法唯一确认时 fail-closed。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from studio import articles, versions

# 允许的内容目录（防路径穿越/符号链接逃逸）
ALLOWED_SECTIONS = ("works", "essays", "archives")
PUBLISH_WORKSPACES_ROOT_ENV = "LIDAIJI_PUBLISH_WORKSPACES_ROOT"
MANIFEST_URL_TEMPLATE = "https://{domain}/comment-manifest.json"


class IsolationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 已发布基线解析
# ---------------------------------------------------------------------------


def _published_manifest(state, domain: str) -> dict:
    """获取当前线上发布内容清单（只读；tests 可用本地文件覆盖）。"""
    override = os.environ.get("LIDAIJI_PUBLISH_MANIFEST_FILE", "")
    if override:
        try:
            return json.loads(Path(override).read_text(encoding="utf-8"))
        except Exception as error:
            raise IsolationError("baseline-unavailable", f"无法读取线上内容清单：{error}") from error
    url = MANIFEST_URL_TEMPLATE.format(domain=domain)
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise IsolationError("baseline-unavailable", f"无法读取线上内容清单：{error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("articles"), list):
        raise IsolationError("baseline-unavailable", "线上内容清单格式无效。")
    return data


def _committed_revision(private_repo: Path, rel_path: str) -> tuple[str, str]:
    """私人仓库 HEAD 树中某文章的 (articleId, articleRevision)。"""
    out = subprocess.run(
        ["git", "show", f"HEAD:{rel_path}"],
        capture_output=True, text=True, cwd=private_repo, timeout=30,
    )
    if out.returncode != 0:
        return "", ""
    parts = out.stdout.split("---\n", 2)
    if len(parts) < 3:
        return "", ""
    fm = parts[1]
    aid = re.search(r'"?articleId"?\s*[:=]\s*"?(article-[a-f0-9]{16})', fm)
    rev = re.search(r'"?articleRevision"?\s*[:=]\s*"?(article-[a-f0-9]{16}@[0-9a-f]{12})', fm)
    if not aid or not rev:
        return "", ""
    return aid.group(1), rev.group(1)


def resolve_published_baseline(state, domain: str) -> dict:
    """校验并返回已发布基线。

    规则：线上 manifest 的每篇文章 revision 必须与私人仓库 HEAD 树逐篇一致。
    全部一致 → 基线 = 私人仓库 HEAD 树（不可变）；任一不一致 → fail-closed。
    """
    manifest = _published_manifest(state, domain)
    private_repo = Path(state.project_root).resolve()
    manifest_by_id = {a["articleId"]: a for a in manifest["articles"]}
    mismatches: list[str] = []
    verified: list[str] = []
    public_bundles: dict[str, str] = {}  # articleId -> 文章 bundle 相对路径（公开内容基线）
    for article in manifest["articles"]:
        # 按 articleId 在私人仓库 HEAD 树中定位文件（canonicalPath 无法唯一定位
        # works 文集层级），找不到按未核对处理
        grep = subprocess.run(
            ["git", "grep", "-l", f"{article['articleId']}", "HEAD", "--", "content/"],
            capture_output=True, text=True, cwd=private_repo, timeout=60,
        )
        rels = [line.strip() for line in grep.stdout.splitlines() if line.strip() and ":" in line]
        rel = rels[0].split(":", 1)[1].strip() if rels else ""
        if not rel:
            mismatches.append(f"{article.get('title')}（HEAD 树中找不到该文章）")
            continue
        aid, rev = _committed_revision(private_repo, rel)
        if aid != article["articleId"] or rev != article.get("revision"):
            mismatches.append(f"{article.get('title')}（线上 {article.get('revision', '?')[-12:] } vs 仓库 {rev[-12:] if rev else '无'}）")
        else:
            verified.append(aid)
            public_bundles[aid] = str(Path(rel).parent.as_posix())
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=private_repo, timeout=15)
    baseline_commit = head.stdout.strip() if head.returncode == 0 else ""
    if mismatches:
        raise IsolationError(
            "baseline-mismatch",
            "无法确认当前线上内容基线（以下文章线上版本与私人仓库提交不一致）："
            + "；".join(mismatches[:5]) + "。请先核验发布记录。",
        )
    if len(public_bundles) != len(manifest["articles"]):
        raise IsolationError(
            "baseline-mismatch",
            "无法为全部线上文章定位公开内容文件（公开内容基线无法构造），发布已阻止。",
        )
    return {
        "publicPlatformCommit": "",
        "privateContentCommit": baseline_commit,
        "releaseId": "",
        "verifiedArticles": len(verified),
        "publicArticleBundles": public_bundles,
        "manifestSha256": hashlib.sha256(
            json.dumps(manifest.get("articles", []), sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest(),
        "manifest": manifest,
    }


# ---------------------------------------------------------------------------
# 平台/工具工作区门禁（平台脏 → 阻止；私人内容脏 → 允许且不进入候选）
# ---------------------------------------------------------------------------


# 平台工作区允许豁免的 .cache 受控路径（收窄：未知 .cache 条目必须阻断）
_CACHE_ALLOWLIST = (
    ".cache/studio/candidates",
    ".cache/studio/publish-history.json",
    ".cache/studio/publish-logs",
    ".cache/studio/locks",
)
_CACHE_ID_RE = __import__("re").compile(r"^(cand_[0-9a-f]{20}|pub_[0-9a-f]{12})$")
_PUB_LOG_RE = __import__("re").compile(r"^pub_[0-9a-f]{12}\.log$")


def _validate_cache_entry(platform_root: Path, path: str) -> str | None:
    """校验受控 .cache 条目；返回违规原因（None=合法）。"""
    node = platform_root / path
    try:
        if node.is_symlink() or any(part.is_symlink() for part in node.relative_to(platform_root).parents if part != platform_root and part.exists()):
            return "符号链接"
        if not node.exists():
            return "不存在"
        stat = node.lstat()
        if stat.st_uid != os.getuid():
            return "属主不符"
        if node.is_dir():
            if stat.st_mode & 0o022:
                return "权限过宽（应≤0700）"
        else:
            if stat.st_mode & 0o022:
                return "权限过宽（应≤0600）"
        name = node.name
        if path.startswith(".cache/studio/candidates") and not (_CACHE_ID_RE.match(name) or name in (".",)):
            return "名称格式不符"
        if path.startswith(".cache/studio/publish-logs") and not (_PUB_LOG_RE.match(name) or name in (".",)):
            return "名称格式不符"
    except OSError:
        return "无法读取"
    return None


def platform_clean_check(platform_root: Path) -> list[str]:
    """平台代码/发布工具/配置脏时列出（阻止发布）。

    .cache 只豁免明确受控路径（候选/账本/发布日志/锁），且逐项校验
    realpath/符号链接/属主/权限/名称格式；出现任何未知 .cache 条目即阻断。
    """
    out = subprocess.run(
        ["git", "status", "--porcelain=v1"], capture_output=True, text=True,
        cwd=platform_root, timeout=15,
    )
    if out.returncode != 0:
        return ["平台仓库状态无法读取"]
    lines = [line for line in out.stdout.splitlines() if line.strip()]
    blocked = []
    for line in lines:
        path = line[3:].strip()
        if path in (".author-settings",) or path.startswith("dist/"):
            continue  # 本机配置与构建产物不阻止
        if path.startswith(("content/", "data/", "site-overrides/")):
            continue  # 内容仓库路径（真实架构中不在平台仓库内）
        if path.startswith(".cache/"):
            allowed = any(path == entry or path.startswith(entry + "/") for entry in _CACHE_ALLOWLIST)
            if not allowed:
                blocked.append(f"{path[:120]}（未知 .cache 条目）")
                continue
            issue = _validate_cache_entry(platform_root, path)
            if issue:
                blocked.append(f"{path[:120]}（.cache 条目校验失败：{issue}）")
            continue
        blocked.append(path[:120])
    return blocked[:20]


def unrelated_dirty_summary(state) -> dict:
    """作者工作区中与目标无关的脏文件摘要（允许存在、不进入候选、仅展示数量）。"""
    try:
        status = versions.git_status(Path(state.project_root))
    except Exception:
        return {"count": 0, "byKind": {}}
    by_kind = {"otherArticle": 0, "otherAsset": 0, "notes": 0, "other": 0}
    for item in status.get("files", []):
        path = str(item.get("path") or "")
        if path.startswith("content/"):
            if "/images/" in path:
                by_kind["otherAsset"] += 1
            else:
                by_kind["otherArticle"] += 1
        elif path.startswith("data/author-notes"):
            by_kind["notes"] += 1
        else:
            by_kind["other"] += 1
    return {"count": len(status.get("files", [])), "byKind": by_kind}


# ---------------------------------------------------------------------------
# 目标文章快照
# ---------------------------------------------------------------------------


def _resolve_target(state, rel_path: str) -> dict:
    project_root = Path(state.project_root).resolve()
    parts = [p for p in str(rel_path or "").split("/") if p]
    # content/<section>/<slug>/index.md（随笔/档案）
    # 或 content/works/<文集>/<slug>/index.md（作品含文集层级）
    if (
        len(parts) not in (4, 5)
        or parts[0] != "content"
        or parts[1] not in ALLOWED_SECTIONS
        or parts[-1] != "index.md"
    ):
        raise IsolationError("validation-failed", "文章路径不在允许的内容目录内。")
    section = parts[1]
    slug = parts[-2]
    if not re.fullmatch(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", slug):
        raise IsolationError("validation-failed", "slug 格式非法。")
    index_file = project_root / Path(*parts)
    bundle = index_file.parent
    if bundle.is_symlink() or not bundle.is_dir():
        raise IsolationError("validation-failed", "文章目录无效（符号链接或缺失）。")
    for candidate in [bundle, *(bundle.rglob("*") if bundle.is_dir() else [])]:
        if candidate.is_symlink():
            raise IsolationError("validation-failed", "文章目录含符号链接，拒绝快照。")
    if not index_file.is_file():
        raise IsolationError("not-found", "找不到这篇文章。")
    article = articles.read_article(project_root, rel_path)
    return {
        "article": article,
        "section": section,
        "slug": slug,
        "relBundlePath": str(bundle.relative_to(project_root)),
        "bundle": bundle,
        "indexFile": index_file,
    }


def _verify_revision_matches_file(target: dict, revision: str) -> None:
    """磁盘文件必须与 draftRevision 一致（重算 revision_for）。"""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "importer"))
    from paragraph_ids import assign_ids, revision_for  # type: ignore

    body = target["article"].get("body") or ""
    article_id = str(target["article"]["frontMatter"].get("articleId") or "")
    stabilized, _ = assign_ids(body, body)
    actual = revision_for(article_id, stabilized) if article_id else ""
    if revision and actual != revision:
        raise IsolationError("conflict", "磁盘文件与目标 revision 不一致，请重新保存草稿。")


def create_target_snapshot(state, rel_path: str, revision: str) -> dict:
    """为已保存 revision 创建不可变快照（含资源清单）。

    返回 snapshotId；快照内容 = 磁盘文件字节 + 资源字节的哈希组合，
    后续发布只允许使用该 snapshotId。
    """
    target = _resolve_target(state, rel_path)
    _verify_revision_matches_file(target, revision)
    index_bytes = target["indexFile"].read_bytes()
    file_sha = hashlib.sha256(index_bytes).hexdigest()
    fm = target["article"]["frontMatter"]
    body = target["article"].get("body") or ""
    body_sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    assets = asset_manifest(target)
    snapshot_id = hashlib.sha256(
        f"{fm.get('articleId')}|{revision}|{file_sha}|{assets['manifestSha256']}".encode()
    ).hexdigest()[:20]
    return {
        "snapshotId": snapshot_id,
        "articleId": str(fm.get("articleId") or ""),
        "slug": target["slug"],
        "section": target["section"],
        "draftRevision": revision,
        "sourceFileRelativePath": str(rel_path),
        "sourceFileSha256": file_sha,
        "frontMatterCanonicalHash": hashlib.sha256(json.dumps(fm, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
        "bodySha256": body_sha,
        "assetManifest": assets,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


# ---------------------------------------------------------------------------
# 文章资源清单
# ---------------------------------------------------------------------------


_IMAGE_REF = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_FM_ASSET_KEYS = ("cover", "image", "images")


def asset_manifest(target: dict) -> dict:
    """目标文章 bundle 内资源：引用清单 + 未使用清单（不整目录复制未引用文件）。"""
    bundle = target["bundle"]
    body = target["article"].get("body") or ""
    fm = target["article"]["frontMatter"]
    referenced: set[str] = set()
    for match in _IMAGE_REF.finditer(body):
        ref = match.group(1).strip().lstrip("./")
        if ref.startswith("http://") or ref.startswith("https://") or ref.startswith("#"):
            continue
        referenced.add(Path(ref).as_posix())
    for key in _FM_ASSET_KEYS:
        value = fm.get(key)
        if isinstance(value, str) and value:
            referenced.add(Path(value).lstrip("./").as_posix())
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, str):
                    referenced.add(Path(item).lstrip("./").as_posix())
    entries = []
    unreferenced = []
    for file in sorted(bundle.rglob("*")):
        if not file.is_file() or file.name == "index.md":
            continue
        rel = file.relative_to(bundle).as_posix()
        if rel in referenced:
            entries.append({
                "relativePath": rel,
                "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                "size": file.stat().st_size,
                "mimeType": "application/octet-stream",
                "referenceType": "referenced",
                "exists": True,
            })
        else:
            unreferenced.append(rel)
    manifest_sha = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
    return {
        "entries": entries,
        "unreferenced": unreferenced,
        "manifestSha256": manifest_sha,
    }


# ---------------------------------------------------------------------------
# 隔离内容仓库构建（基线 HEAD 树 + 目标覆盖）
# ---------------------------------------------------------------------------


def _publish_workspaces_root() -> Path:
    configured = os.environ.get(PUBLISH_WORKSPACES_ROOT_ENV, "")
    if configured:
        root = Path(configured).expanduser()
    else:
        base = Path.home() / "Library" / "Application Support" / "历代纪" / "studio" / "publish-workspaces"
        root = base
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def _front_matter_article_id(text: str) -> str:
    """从文章 front matter 文本解析 articleId（无/解析失败返回空串）。"""
    if not text.startswith("---\n"):
        return ""
    end = text.find("\n---", 3)
    if end < 0:
        return ""
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text[3:end])
    except Exception:
        return ""
    if isinstance(data, dict):
        return str(data.get("articleId") or "")
    return ""


def _public_content_pathspecs(private_repo: Path, public_bundles: dict[str, str]) -> list[str]:
    """按"线上清单公开内容"构造 git archive 路径白名单。

    规则：
    - 含 index.md 且 front matter 有 articleId 的目录 = 文章 bundle；
      articleId 不在线上清单（公开集）→ 整个 bundle 从路径白名单排除
      （未发布/私密文章及其资源绝不进入隔离输入）；
    - 非 index.md/_index.md 的 .md 文件 → 排除（普通命名私密 Markdown）；
    - 其余（公开文章 bundle、板块 _index.md、文集级资源）全部保留。
    """
    tree = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD", "--", "content/"],
        capture_output=True, text=True, cwd=private_repo, timeout=30,
    )
    files = [line.strip() for line in tree.stdout.splitlines() if line.strip()]
    excluded_bundles: set[str] = set()
    for rel in files:
        if not rel.endswith("/index.md"):
            continue
        show = subprocess.run(
            ["git", "show", f"HEAD:{rel}"], capture_output=True, text=True,
            cwd=private_repo, timeout=30,
        )
        aid = _front_matter_article_id(show.stdout) if show.returncode == 0 else ""
        if aid and aid not in public_bundles:
            excluded_bundles.add(rel[: -len("index.md")].rstrip("/"))
    includes: list[str] = []
    for rel in files:
        if any(rel.startswith(bundle + "/") for bundle in excluded_bundles):
            continue
        if rel.endswith(".md") and not rel.endswith(("/index.md", "/_index.md")):
            continue
        includes.append(rel)
    return includes


def build_merged_content(state, target: dict, snapshot: dict, baseline: dict | None = None) -> dict:
    """创建隔离内容仓库：公开内容基线（线上清单明确列出的公开文章 bundle +
    板块索引 + site-overrides + 公开作者评）+ 目标文章快照覆盖。

    已提交但未公开/私密的文章 bundle、作者评与其资源绝不进入隔离输入。

    返回 {repoRoot, contentRoot, authorNotesRoot, siteOverridesRoot, id}。
    """
    private_repo = Path(state.project_root).resolve()
    publish_id = f"publish-{time.strftime('%Y%m%d%H%M%S')}-{os.getpid()}"
    work_root = _publish_workspaces_root() / publish_id
    repo = work_root / "content-repo"
    try:
        repo.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        work_root = Path(tempfile.mkdtemp(prefix="lidaiji-iso-", dir=Path(state.project_root).parent))
        repo = work_root / "content-repo"
        repo.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not baseline or not baseline.get("publicArticleBundles"):
        raise IsolationError("baseline-unavailable", "缺少可信公开内容基线，无法构造隔离输入。")
    tree = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD"], capture_output=True, text=True,
        cwd=private_repo, timeout=30,
    )
    tracked = set(tree.stdout.splitlines())
    # 公开内容基线路径白名单：线上清单公开文章 bundle + 板块索引 + 站点覆盖；
    # data/ 不整体归档（作者评按公开文章过滤后选择性复制，见下）。
    # 已提交未公开/私密文章在归档前即被排除，绝不进入隔离输入。
    pathspecs = _public_content_pathspecs(private_repo, baseline["publicArticleBundles"])
    if "site-overrides" in tracked or any(p.startswith("site-overrides/") for p in tracked):
        pathspecs.append("site-overrides")
    archive = subprocess.run(
        ["git", "archive", "HEAD", *pathspecs],
        capture_output=True, cwd=private_repo, timeout=120,
    )
    if archive.returncode != 0:
        raise IsolationError("baseline-unavailable", "无法从私人仓库 HEAD 归档公开内容基线。")
    extract = subprocess.run(["tar", "-xf", "-", "-C", str(repo)], input=archive.stdout, timeout=120)
    if extract.returncode != 0:
        raise IsolationError("baseline-unavailable", "公开内容基线解包失败。")
    # 目标文章覆盖：index.md + 引用资源（未引用资源不纳入）。
    # 所有覆盖文件必须与快照记录哈希一致（快照不可变，拒绝静默替换）。
    target_content = repo / target["relBundlePath"]
    target_content.mkdir(parents=True, exist_ok=True)
    if hashlib.sha256(target["indexFile"].read_bytes()).hexdigest() != snapshot["sourceFileSha256"]:
        raise IsolationError("conflict", "目标文章文件在快照后发生变化，请重新生成发布预览。")
    shutil.copy2(target["indexFile"], target_content / "index.md")
    for entry in snapshot["assetManifest"]["entries"]:
        source = target["bundle"] / entry["relativePath"]
        if not source.is_file():
            raise IsolationError("conflict", f"目标文章资源缺失：{entry['relativePath']}")
        if hashlib.sha256(source.read_bytes()).hexdigest() != entry["sha256"]:
            raise IsolationError("conflict", f"目标文章资源在快照后发生变化：{entry['relativePath']}")
        dest = target_content / entry["relativePath"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
    # 作者评：只复制公开文章（线上清单列出的 articleId + 目标文章）的作者评；
    # 未公开/私密文章的作者评绝不进入隔离输入
    public_ids = set(baseline.get("publicArticleBundles", {}).keys()) | {snapshot["articleId"]}
    notes_src = private_repo / "data" / "author-notes"
    if notes_src.is_dir():
        for note in notes_src.glob("*.yaml"):
            if any(pid in note.name for pid in public_ids):
                shutil.copy2(note, repo / "data" / "author-notes" / note.name)
    return {
        "id": publish_id,
        "workRoot": work_root,
        "repoRoot": repo,
        "contentRoot": repo / "content",
        "authorNotesRoot": repo / "data" / "author-notes",
        "siteOverridesRoot": repo / "site-overrides",
        "targetContentRoot": target_content,
    }


def isolated_environment(merged: dict, base_environment: dict | None = None) -> dict:
    """发布子进程环境：LIDAIJI_* 指向隔离内容仓库（既有 build/publish 脚本原样复用）。"""
    env = dict(base_environment or os.environ)
    env["LIDAIJI_DETERMINISTIC_BUILD"] = "1"  # 隔离构建确定性（候选可复现）
    env["LIDAIJI_CONTENT_REPO_ROOT"] = str(merged["repoRoot"])
    env["LIDAIJI_CONTENT_ROOT"] = str(merged["contentRoot"])
    env["LIDAIJI_AUTHOR_NOTES_ROOT"] = str(merged["authorNotesRoot"])
    env["LIDAIJI_SITE_OVERRIDES_ROOT"] = str(merged["siteOverridesRoot"])
    return env


def cleanup_merged_content(merged: dict) -> None:
    """发布后清理隔离仓库（保留最小报告由调用方处理）。"""
    shutil.rmtree(merged["workRoot"], ignore_errors=True)


# ---------------------------------------------------------------------------
# 候选差异校验（无关文章必须与线上一致）
# ---------------------------------------------------------------------------


def _article_digest(article: dict) -> str:
    paragraphs = sorted(
        (p.get("paragraphId", ""), p.get("position", 0), p.get("checksum", "")) for p in article.get("paragraphs", [])
    )
    return hashlib.sha256(
        json.dumps([article.get("articleId"), article.get("revision"), paragraphs], sort_keys=True).encode()
    ).hexdigest()


def candidate_diff_check(new_manifest_path: Path, baseline: dict, target_article_id: str) -> dict:
    """构建后的 manifest 与线上基线比较：无关文章必须逐篇一致。"""
    new_manifest = json.loads(new_manifest_path.read_text(encoding="utf-8"))
    baseline_by_id = {a["articleId"]: a for a in baseline["manifest"]["articles"]}
    new_by_id = {a["articleId"]: a for a in new_manifest.get("articles", [])}
    unrelated_changes: list[str] = []
    for article_id, baseline_article in baseline_by_id.items():
        if article_id == target_article_id:
            continue
        new_article = new_by_id.get(article_id)
        if new_article is None:
            unrelated_changes.append(f"{article_id}（候选缺失）")
        elif _article_digest(new_article) != _article_digest(baseline_article):
            unrelated_changes.append(f"{article_id}（内容与线上不一致）")
    target_entry = new_by_id.get(target_article_id)
    return {
        "unrelatedChanges": unrelated_changes,
        "unrelatedChangedCount": len(unrelated_changes),
        "targetPresent": target_entry is not None,
        "targetRevision": (target_entry or {}).get("revision", ""),
    }
