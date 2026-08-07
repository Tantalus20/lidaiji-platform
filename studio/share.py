"""长文分享内容管理：扫描、读取、事务保存、新建与 URL 计算。

与正式作品（works/essays/archives）完全隔离：
- 内容根由 ``LIDAIJI_SHARE_CONTENT_ROOT`` 指定（缺省为项目根上一级的
  ``lidaiji-share-private``），并强制要求该根目录不在公开仓库内部；
- 分享内容使用独立身份 ``shareId`` / ``shareRevision``，绝不生成
  ``articleId`` 与 ``paragraph-id``；保存时主动剥离已存在的段评锚点注释；
- 保存不进入 ``comments-prepare`` 与评论 manifest 流程。

安全与一致性边界：
- 所有接受路径的函数共用 ``resolve_share_path``：只接受相对路径，
  resolve 后必须位于分享内容根内、文件名必须是 ``index.md``、父目录名
  必须是合法 ``shareId``；符号链接逃逸、绝对路径、``..`` 一律拒绝；
- 保存是事务：备份 → 同目录临时文件 → ``os.replace`` 原子替换，任何失败
  都保持磁盘原文件不动（replace 之后失败则把原文写回）；
- 保存时重新计算 ``shareRevision = shareId@sha256(body)[:12]``，正文未变
  时修订号稳定不变，可验证。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
import re
import secrets
import shutil
import tempfile
from pathlib import Path, PurePosixPath

import yaml

from studio.articles import ArticleFailure, plain_body  # noqa: F401  （复用正文清洗与错误类型）

SHARE_ID_RE = re.compile(r"^sh-\d{8}-[a-f0-9]{6}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PARAGRAPH_MARKER = re.compile(r"^<!--\s*paragraph-id:[\w-]+\s*-->$", re.MULTILINE)
ANCHOR_ANY = re.compile(r"^<!--\s*paragraph-id:.*?-->$", re.MULTILINE)
ARTICLE_ID_KEY = "articleId"

KINDS = ("original-writing", "fiction", "news", "paper", "public-domain-work", "other")
KIND_LABELS = {
    "original-writing": "我的文章",
    "fiction": "小说",
    "news": "新闻",
    "paper": "论文",
    "public-domain-work": "公共领域作品",
    "other": "其他",
}
RIGHTS_MODES = ("original", "public-domain", "licensed", "cc", "excerpt", "link-only")
RIGHTS_LABELS = {
    "original": "原创",
    "public-domain": "公共领域",
    "licensed": "已获授权",
    "cc": "CC许可",
    "excerpt": "摘录",
    "link-only": "仅链接",
}
# 摘录/仅链接不得公开全文：正文只在编辑侧保留，分享站页面不渲染。
META_ONLY_RIGHTS = ("excerpt", "link-only")

# 前端可编辑的 Front Matter 白名单；shareId/shareRevision/slug 一律以磁盘为准。
EDITABLE_FIELDS = (
    "title",
    "author",
    "sourceName",
    "sourceUrl",
    "shareKind",
    "rightsMode",
    "date",
    "draft",
    "description",
    "qqSummary",
    "categories",
)
REQUIRED_FIELDS = ("title", "author")
BACKUP_KEEP = 10

_DEFAULT_ROOT_NAME = "lidaiji-share-private"


def _env_root() -> str:
    return os.environ.get("LIDAIJI_SHARE_CONTENT_ROOT") or ""


def share_root(project_root) -> Path:
    """分享内容根目录；必须位于公开仓库之外，否则拒绝使用。

    双层检查（防 symlink 绕过）：
    - 先检查未解析的原始路径：入口（或任一祖先）位于仓库内部 → 拒绝；
    - 再检查 resolve 后的真实路径：位于仓库内部 → 拒绝。
    仓库内 symlink → 仓库外 的入口同样被第一层检查拦截。
    """
    project_root_raw = Path(project_root)
    project_root = project_root_raw.resolve()
    raw = _env_root() or str(project_root.parent / _DEFAULT_ROOT_NAME)
    raw_path = Path(raw).expanduser()
    root = raw_path.resolve()
    # 词法归一化（折叠 ../ 但不解析符号链接）：用于识别“入口位于仓库内部”的场景。
    lexical = Path(os.path.abspath(raw_path))

    def _inside(path: Path) -> bool:
        # 与 project_root 的原始与解析两种表示都比较：
        # 避免 macOS /var ↔ /private/var 前缀差异造成误判。
        for base in (project_root_raw, project_root):
            if path == base or base in path.parents or path in base.parents:
                return True
        return False

    if _inside(lexical) or _inside(root):
        raise ArticleFailure(
            "forbidden",
            "分享内容根目录位于公开代码仓库内部，已拒绝使用。"
            "请设置环境变量 LIDAIJI_SHARE_CONTENT_ROOT 指向仓库外的私有目录。",
        )
    if raw and not root.is_dir():
        root.mkdir(parents=True, exist_ok=True)
    return root


# ---------------------------------------------------------------------------
# 路径安全
# ---------------------------------------------------------------------------


def resolve_share_path(project_root, rel_path) -> Path:
    """把前端传入的项目相对路径校验并解析为分享内容根内的绝对路径。"""
    root = share_root(project_root)
    text = str(rel_path or "").strip()
    if not text:
        raise ArticleFailure("bad-request", "缺少分享路径。")
    if text.startswith("/") or "\\" in text or re.match(r"^[A-Za-z]:", text):
        raise ArticleFailure("validation-failed", "分享路径必须是相对路径。")
    pure = PurePosixPath(text)
    if any(part in ("..", "", ".") for part in pure.parts):
        raise ArticleFailure("validation-failed", "分享路径含有非法片段。")
    if len(pure.parts) != 3 or pure.parts[0] != "items":
        raise ArticleFailure("validation-failed", "分享必须位于 items/<shareId>/index.md。")
    if not SHARE_ID_RE.fullmatch(pure.parts[1]):
        raise ArticleFailure("validation-failed", "分享目录名必须是合法 shareId（sh-日期-6位hex）。")
    if pure.name != "index.md":
        raise ArticleFailure("validation-failed", "分享路径必须指向 index.md。")
    resolved = (root / pure).resolve()
    if resolved.name != "index.md" or root not in resolved.parents:
        raise ArticleFailure("validation-failed", "分享路径越出了分享内容根范围。")
    if resolved.parent.is_symlink():
        raise ArticleFailure("validation-failed", "分享目录不允许是符号链接。")
    return resolved


# ---------------------------------------------------------------------------
# Front Matter 读写
# ---------------------------------------------------------------------------


def split_source(source: str) -> tuple[dict, str]:
    if not source.startswith("---\n"):
        raise ArticleFailure("validation-failed", "分享缺少 YAML Front Matter。")
    _, raw, body = source.split("---", 2)
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as error:
        raise ArticleFailure("validation-failed", f"Front Matter 无法解析：{error}") from error
    if not isinstance(data, dict):
        raise ArticleFailure("validation-failed", "Front Matter 不是键值结构。")
    return data, body.lstrip("\n")


def render_source(data: dict, body: str) -> str:
    return (
        "---\n"
        + yaml.safe_dump(data, allow_unicode=True, sort_keys=False, width=1000)
        + "---\n\n"
        + body.rstrip("\n")
        + "\n"
    )


def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()[:10]
    return value


def strip_comment_anchors(body: str) -> str:
    """剥离段评锚点等 HTML 注释，保证分享内容不携带正式作品评论身份。"""
    return ANCHOR_ANY.sub("", body).lstrip("\n")


# ---------------------------------------------------------------------------
# 身份
# ---------------------------------------------------------------------------


def new_share_id(day: dt.date | None = None) -> str:
    day = day or dt.date.today()
    return f"sh-{day:%Y%m%d}-{secrets.token_hex(3)}"


def content_hash(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def revision_for(share_id: str, body: str) -> str:
    return f"{share_id}@{content_hash(body)[:12]}"


def share_url(data: dict) -> str:
    slug = str(data.get("slug") or "").strip()
    return f"/{slug}/"


# ---------------------------------------------------------------------------
# 扫描与读取
# ---------------------------------------------------------------------------


def _index_entry(path: Path, data: dict, body: str) -> dict:
    return {
        "path": f"items/{path.parent.name}/index.md",
        "shareId": str(data.get("shareId") or ""),
        "shareRevision": str(data.get("shareRevision") or ""),
        "title": str(data.get("title") or ""),
        "author": str(data.get("author") or ""),
        "shareKind": str(data.get("shareKind") or "other"),
        "rightsMode": str(data.get("rightsMode") or "original"),
        "slug": str(data.get("slug") or path.parent.name),
        "draft": bool(data.get("draft", False)),
        "wordCount": len(plain_body(body).strip()),
        "date": _json_safe(data.get("date") or ""),
        "lastmod": _json_safe(data.get("lastmod") or ""),
        "sourceName": str(data.get("sourceName") or ""),
        "sourceUrl": str(data.get("sourceUrl") or ""),
        "categories": data.get("categories") or [],
        "qqSummary": str(data.get("qqSummary") or ""),
        "description": str(data.get("description") or ""),
    }


def _scan_items(root: Path) -> list[dict]:
    items = root / "items"
    entries: list[dict] = []
    if items.is_dir():
        for index in sorted(items.glob("*/index.md")):
            if not index.is_file() or index.is_symlink():
                continue
            if not SHARE_ID_RE.fullmatch(index.parent.name):
                continue
            try:
                data, body = split_source(index.read_text(encoding="utf-8"))
            except ArticleFailure:
                continue
            entry = _index_entry(index, data, body)
            if entry["shareId"] != index.parent.name:
                entry["shareId"] = index.parent.name
            entries.append(entry)
    entries.sort(key=lambda item: (not item["draft"], str(item["date"]), item["shareId"]), reverse=True)
    return entries


def scan_shares(project_root) -> list[dict]:
    """扫描分享内容根 items/<shareId>/index.md，只读。"""
    return _scan_items(share_root(project_root))


def validate_all(project_root) -> list[str]:
    """对全部分享项做 schema 与身份校验，返回错误消息列表（空 = 通过）。

    校验项：shareId 与目录一致、必填字段、kind/rightsMode 合法、
    sourceUrl 协议、shareRevision 与正文内容 hash 一致。
    """
    errors: list[str] = []
    root = share_root(project_root)
    for entry in scan_shares(project_root):
        try:
            target = resolve_share_path(project_root, entry["path"])
        except ArticleFailure as error:
            errors.append(f"{entry['path']}: {error.message}")
            continue
        if not target.is_file():
            errors.append(f"{entry['path']}: 文件不存在。")
            continue
        try:
            data, body = split_source(target.read_text(encoding="utf-8"))
        except ArticleFailure as error:
            errors.append(f"{entry['path']}: {error.message}")
            continue
        share_id = entry["path"].split("/")[1]
        if str(data.get("shareId") or "") != share_id:
            errors.append(f"{entry['path']}: shareId 与目录名不一致。")
        for key in REQUIRED_FIELDS:
            if not str(data.get(key) or "").strip():
                errors.append(f"{entry['path']}: 缺少字段 {key}。")
        kind = str(data.get("shareKind") or "")
        if kind and kind not in KINDS:
            errors.append(f"{entry['path']}: 未知类型 {kind}。")
        rights_mode = str(data.get("rightsMode") or "")
        if rights_mode and rights_mode not in RIGHTS_MODES:
            errors.append(f"{entry['path']}: 未知版权模式 {rights_mode}。")
        source_url = str(data.get("sourceUrl") or "").strip()
        if source_url and not source_url.startswith(("http://", "https://")):
            errors.append(f"{entry['path']}: 原文链接不是 http(s) 地址。")
        expected_revision = revision_for(share_id, body)
        if str(data.get("shareRevision") or "") != expected_revision:
            errors.append(
                f"{entry['path']}: shareRevision 与正文内容不匹配（应为 {expected_revision}）。"
            )
    return errors


def read_share(project_root, rel_path) -> dict:
    target = resolve_share_path(project_root, rel_path)
    if not target.is_file():
        raise ArticleFailure("not-found", "找不到这篇分享。")
    data, body = split_source(target.read_text(encoding="utf-8"))
    return {
        "path": PurePosixPath(str(rel_path)).as_posix(),
        "frontMatter": _json_safe(data),
        "body": body,
        "url": share_url(data),
        "metaOnly": data.get("rightsMode") in META_ONLY_RIGHTS,
    }


# ---------------------------------------------------------------------------
# 事务保存
# ---------------------------------------------------------------------------


def _backup_path(cache_root: Path, share_id: str) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    directory = cache_root / "backups" / f"share-{share_id}"
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / f"{stamp}-index.md"
    suffix = 1
    while candidate.exists():
        candidate = directory / f"{stamp}-{suffix}-index.md"
        suffix += 1
    return candidate


def _prune_backups(directory: Path) -> None:
    backups = sorted(directory.glob("*-index.md"))
    for old in backups[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)


def save_share(project_root, rel_path, editable_fields: dict, body: str) -> dict:
    """事务保存：白名单合并 → 剥离段评锚点 → 重算 shareRevision → 校验 → 备份 → 原子替换。

    与正式作品保存不同：绝不调用 ``assign_ids``，绝不生成 articleId。
    """
    project_root = Path(project_root).resolve()
    target = resolve_share_path(project_root, rel_path)
    if not target.is_file():
        raise ArticleFailure("not-found", "找不到这篇分享。")
    if not isinstance(editable_fields, dict):
        raise ArticleFailure("bad-request", "frontMatter 必须是对象。")
    if not isinstance(body, str):
        raise ArticleFailure("bad-request", "body 必须是字符串。")

    original_bytes = target.read_bytes()
    data, _old_body = split_source(original_bytes.decode("utf-8"))

    # 分享身份以磁盘为准：shareId/shareRevision 不可由前端修改
    share_id = str(data.get("shareId") or target.parent.name)
    if not SHARE_ID_RE.fullmatch(share_id):
        raise ArticleFailure("validation-failed", "分享缺少合法 shareId。")

    merged = dict(data)
    for key in EDITABLE_FIELDS:
        if key in editable_fields:
            merged[key] = editable_fields[key]
    merged["lastmod"] = dt.date.today().isoformat()
    merged["shareId"] = share_id

    for key in REQUIRED_FIELDS:
        if not str(merged.get(key) or "").strip():
            raise ArticleFailure("validation-failed", f"「{key}」不能为空。")
    kind = str(merged.get("shareKind") or "other")
    if kind not in KINDS:
        raise ArticleFailure("validation-failed", "未知分享类型。")
    rights_mode = str(merged.get("rightsMode") or "original")
    if rights_mode not in RIGHTS_MODES:
        raise ArticleFailure("validation-failed", "未知版权/发布模式。")
    source_url = str(merged.get("sourceUrl") or "").strip()
    if source_url and not source_url.startswith(("http://", "https://")):
        raise ArticleFailure("validation-failed", "原文链接必须是 http(s) 地址。")
    if not body.strip():
        raise ArticleFailure("validation-failed", "正文不能为空。")

    # 分享正文剥离段评锚点，绝不生成新锚点；修订号按内容 hash 稳定重算
    stabilized = strip_comment_anchors(body)
    merged["shareRevision"] = revision_for(share_id, stabilized)

    rendered = render_source(merged, stabilized)
    try:
        roundtrip = yaml.safe_load(rendered.split("---", 2)[1])
    except (yaml.YAMLError, IndexError) as error:
        raise ArticleFailure("validation-failed", f"合并后的 Front Matter 无法序列化：{error}") from error
    if not isinstance(roundtrip, dict):
        raise ArticleFailure("validation-failed", "合并后的 Front Matter 校验失败。")

    backup = _backup_path(project_root / ".cache" / "studio", share_id)
    shutil.copy2(target, backup)
    _prune_backups(backup.parent)

    replaced = False
    temporary = ""
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".index-", suffix=".tmp", dir=target.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
        os.replace(temporary, target)
        temporary = ""
        replaced = True
    except Exception:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
        if replaced:
            try:
                target.write_bytes(original_bytes)
            except OSError:
                pass
        raise

    data_after, body_after = split_source(target.read_text(encoding="utf-8"))
    return {
        "share": _index_entry(target, data_after, body_after),
        "anchorsStripped": ANCHOR_ANY.search(body) is not None,
        # 编辑器必须拿到剥离锚点后的正文，保证与磁盘一致
        "body": stabilized,
    }


# ---------------------------------------------------------------------------
# 新建分享
# ---------------------------------------------------------------------------


def new_share(project_root, fields: dict) -> dict:
    """以模板新建草稿 bundle；shareId 自动生成；目标已存在一律拒绝。"""
    project_root = Path(project_root).resolve()
    if not isinstance(fields, dict):
        raise ArticleFailure("bad-request", "字段必须是对象。")
    title = str(fields.get("title") or "").strip()
    if not title:
        raise ArticleFailure("validation-failed", "标题不能为空。")
    author = str(fields.get("author") or "").strip()
    if not author:
        raise ArticleFailure("validation-failed", "作者不能为空。")
    kind = str(fields.get("shareKind") or "original-writing")
    if kind not in KINDS:
        raise ArticleFailure("validation-failed", "未知分享类型。")
    rights_mode = str(fields.get("rightsMode") or "original")
    if rights_mode not in RIGHTS_MODES:
        raise ArticleFailure("validation-failed", "未知版权/发布模式。")

    root = share_root(project_root)
    share_id = new_share_id()
    items_dir = root / "items"
    items_dir.mkdir(parents=True, exist_ok=True)
    target_dir = items_dir / share_id
    if target_dir.exists():
        raise ArticleFailure("conflict", f"目标已存在：items/{share_id}/")
    requested_slug = str(fields.get("slug") or "").strip()
    if requested_slug and not SLUG_RE.fullmatch(requested_slug):
        raise ArticleFailure(
            "validation-failed",
            "slug只能使用小写英文字母、数字和连字符，且不能以连字符开头或结尾。",
        )
    slug = requested_slug or _slugify(title)
    slug = _unique_slug(root, slug)
    today = dt.date.today().isoformat()
    placeholder = "（正文待写）"
    front_matter = {
        "title": title,
        "author": author,
        "date": today,
        "lastmod": today,
        "slug": slug,
        "draft": True,
        "shareKind": kind,
        "rightsMode": rights_mode,
        "sourceName": "",
        "sourceUrl": "",
        "description": "",
        "qqSummary": "",
        "categories": [],
        "shareId": share_id,
        "shareRevision": revision_for(share_id, placeholder),
    }
    markdown = render_source(front_matter, placeholder)

    temporary = Path(tempfile.mkdtemp(prefix=f".{share_id}.new-", dir=items_dir))
    try:
        (temporary / "index.md").write_text(markdown, encoding="utf-8")
        data_check, _ = split_source((temporary / "index.md").read_text(encoding="utf-8"))
        if not data_check.get("title"):
            raise ArticleFailure("write-failed", "生成的 index.md 缺少有效的 Front Matter。")
        os.replace(temporary, target_dir)
        temporary = ""
    except Exception:
        if temporary and Path(temporary).exists():
            shutil.rmtree(Path(temporary))
        raise

    data_after, body_after = split_source((target_dir / "index.md").read_text(encoding="utf-8"))
    return _index_entry(target_dir / "index.md", data_after, body_after)


def _unique_slug(root: Path, slug: str) -> str:
    existing = {entry["slug"] for entry in _scan_items(root)}
    candidate, suffix = slug, 1
    while candidate in existing:
        suffix += 1
        candidate = f"{slug}-{suffix}"
    return candidate


def _slugify(title: str) -> str:
    """标题拼音 slug 由服务端建议；失败时退回 share。"""
    try:
        from import_stages import assistant_slugify  # noqa: F401

        slug = assistant_slugify(title)
        if SLUG_RE.fullmatch(slug):
            return slug
    except Exception:
        pass
    return "share"
