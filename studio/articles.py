"""作者工作台文章管理：扫描、读取、事务保存、新建、搜索与 URL 计算。

安全与一致性边界：
- 所有接受路径的函数共用 ``resolve_article_path``：只接受项目相对路径，
  resolve 后必须位于 ``content/`` 内、文件名必须是 ``index.md``、所在
  section 属于 works/essays/archives；符号链接逃逸、绝对路径、``..``
  一律拒绝；
- 扫描与搜索只读，不写任何文件；
- 保存是事务：备份 → 同目录临时文件 → ``os.replace`` 原子替换，任何失败
  都保持磁盘原文件不动（replace 之后失败则把原文写回）；
- 保存时 ``assign_ids(body, body)`` 自匹配补段评锚点并更新
  articleRevision——与 ``scripts/comments-prepare.py --write`` 语义完全
  一致，这是保存的必要步骤，否则只读检查会让 build.sh 失败。
"""

from __future__ import annotations

import datetime as dt
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath

import yaml

_HERE = Path(__file__).resolve().parent
_IMPORTER = _HERE.parent / "importer"
if str(_IMPORTER) not in sys.path:
    sys.path.insert(0, str(_IMPORTER))

import import_stages  # noqa: E402
from paragraph_ids import assign_ids, new_article_id, revision_for  # noqa: E402

SECTIONS = ("works", "essays", "archives")
SLUG_FORMAT = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
ANCHOR_COMMENT = re.compile(r"^<!--\s*paragraph-id:[\w-]+\s*-->$", re.MULTILINE)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
# 前端可编辑的 Front Matter 白名单；slug/articleId/comments/aliases/
# articleRevision/volume 等一律以磁盘为准，前端传了也忽略。
EDITABLE_FIELDS = (
    "title",
    "subtitle",
    "description",
    "date",
    "weight",
    "draft",
    "featured",
    "collections",
    "categories",
    "tags",
    "series",
    "period",
    "people",
    "places",
)
BACKUP_KEEP = 10
SNIPPET_CONTEXT = 40


class ArticleFailure(Exception):
    """可直接转成 JSON 错误响应的失败（code 对应 server.HTTP_BY_CODE）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 路径安全
# ---------------------------------------------------------------------------


def resolve_article_path(project_root, rel_path) -> Path:
    """把前端传入的项目相对路径校验并解析为绝对路径；不合格一律拒绝。"""
    project_root = Path(project_root).resolve()
    text = str(rel_path or "").strip()
    if not text:
        raise ArticleFailure("bad-request", "缺少文章路径。")
    if text.startswith("/") or "\\" in text or re.match(r"^[A-Za-z]:", text):
        raise ArticleFailure("validation-failed", "文章路径必须是项目内的相对路径。")
    pure = PurePosixPath(text)
    if any(part in ("..", "", ".") for part in pure.parts):
        raise ArticleFailure("validation-failed", "文章路径含有非法片段。")
    if pure.name != "index.md":
        raise ArticleFailure("validation-failed", "文章路径必须指向文章 bundle 的 index.md。")
    parts = pure.parts
    if len(parts) < 4 or parts[0] != "content" or parts[1] not in SECTIONS:
        raise ArticleFailure("validation-failed", "文章必须位于 content/works、content/essays 或 content/archives 内。")
    resolved = (project_root / pure).resolve()
    content_root = (project_root / "content").resolve()
    if resolved.name != "index.md" or content_root not in resolved.parents:
        raise ArticleFailure("validation-failed", "文章路径越出了 content/ 范围。")
    section_parts = resolved.relative_to(content_root).parts
    if section_parts[0] not in SECTIONS:
        raise ArticleFailure("validation-failed", "文章所在栏目不受支持。")
    return resolved


# ---------------------------------------------------------------------------
# Front Matter 读写
# ---------------------------------------------------------------------------


def split_source(source: str) -> tuple[dict, str]:
    if not source.startswith("---\n"):
        raise ArticleFailure("validation-failed", "文章缺少 YAML Front Matter。")
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


def json_safe(value):
    """把 yaml 解析出的 date/datetime 等对象转成 JSON 可序列化结构。"""
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()[:10]
    return value


def plain_body(body: str) -> str:
    """去掉锚点注释等 HTML 注释的正文，供字数统计与搜索。"""
    return HTML_COMMENT.sub("", body)


def missing_anchor_count(body: str) -> int:
    """可评论自然段中缺少稳定锚点的数量（与 comments-prepare 口径一致）。"""
    _, report = assign_ids(body, body)
    return report.created


# ---------------------------------------------------------------------------
# 扫描与读取
# ---------------------------------------------------------------------------


def _collection_titles(project_root: Path) -> dict[str, str]:
    titles: dict[str, str] = {}
    works = project_root / "content" / "works"
    if works.is_dir():
        for index in sorted(works.glob("*/_index.md")):
            data, _ = import_stages.parse_existing_markdown(index)
            titles[index.parent.name] = str(data.get("title") or index.parent.name)
    return titles


def _index_entry(project_root: Path, path: Path, data: dict, body: str, collections: dict[str, str]) -> dict:
    rel = path.relative_to(project_root).as_posix()
    parts = PurePosixPath(rel).parts
    section = parts[1]
    collection_slug = parts[2] if section == "works" and len(parts) >= 5 else ""
    return {
        "title": str(data.get("title") or ""),
        "subtitle": str(data.get("subtitle") or ""),
        "path": rel,
        "section": section,
        "collectionSlug": collection_slug,
        "collectionTitle": collections.get(collection_slug, "") if collection_slug else "",
        "slug": str(data.get("slug") or path.parent.name),
        "draft": bool(data.get("draft", False)),
        "wordCount": import_stages.visible_word_count(plain_body(body)),
        "modified": dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
        "date": json_safe(data.get("date") or ""),
        "lastmod": json_safe(data.get("lastmod") or ""),
        "articleId": str(data.get("articleId") or ""),
        "missingAnchors": missing_anchor_count(body),
        "articleRevision": str(data.get("articleRevision") or ""),
    }


def scan_content(project_root) -> list[dict]:
    """扫描 content/{works,essays,archives}/**/index.md（排除 _index.md），只读。"""
    project_root = Path(project_root).resolve()
    collections = _collection_titles(project_root)
    articles: list[dict] = []
    for section in SECTIONS:
        base = project_root / "content" / section
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("index.md")):
            if not path.is_file() or path.is_symlink():
                continue
            try:
                data, body = split_source(path.read_text(encoding="utf-8"))
            except ArticleFailure:
                continue  # 单个文件损坏不拖垮整个列表
            articles.append(_index_entry(project_root, path, data, body, collections))
    order = {name: index for index, name in enumerate(SECTIONS)}
    articles.sort(
        key=lambda item: (
            order.get(item["section"], 99),
            item["collectionSlug"],
            not item["draft"],
            str(item["date"]),
            item["slug"],
        )
    )
    return articles


def article_url(project_root, rel_path) -> str:
    """按 hugo.toml permalinks 规则计算站内路径。"""
    target = resolve_article_path(project_root, rel_path)
    project_root = Path(project_root).resolve()
    data, _ = split_source(target.read_text(encoding="utf-8"))
    rel = target.relative_to(project_root)
    parts = rel.parts
    section = parts[1]
    slug = str(data.get("slug") or target.parent.name)
    if section == "works":
        return f"/works/{parts[2]}/{slug}/"
    return f"/{section}/{slug}/"


def read_article(project_root, rel_path) -> dict:
    target = resolve_article_path(project_root, rel_path)
    if not target.is_file():
        raise ArticleFailure("not-found", "找不到这篇文章。")
    data, body = split_source(target.read_text(encoding="utf-8"))
    return {
        "path": PurePosixPath(str(rel_path)).as_posix(),
        "frontMatter": json_safe(data),
        "body": body,
        "missingAnchors": missing_anchor_count(body),
        "url": article_url(project_root, rel_path),
    }


# ---------------------------------------------------------------------------
# 事务保存
# ---------------------------------------------------------------------------


def _backup_path(cache_root: Path, section: str, slug: str) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    directory = cache_root / "backups" / f"{section}-{slug}"
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


def save_article(project_root, rel_path, editable_fields: dict, body: str) -> dict:
    """事务保存：白名单合并 → 补锚点/更新revision → 校验 → 备份 → 原子替换。"""
    project_root = Path(project_root).resolve()
    target = resolve_article_path(project_root, rel_path)
    if not target.is_file():
        raise ArticleFailure("not-found", "找不到这篇文章。")
    if not isinstance(editable_fields, dict):
        raise ArticleFailure("bad-request", "frontMatter 必须是对象。")
    if not isinstance(body, str):
        raise ArticleFailure("bad-request", "body 必须是字符串。")

    original_bytes = target.read_bytes()
    data, _old_body = split_source(original_bytes.decode("utf-8"))

    # 白名单之外（含 slug/articleId/articleRevision/comments 等）一律以磁盘为准
    merged = dict(data)
    for key in EDITABLE_FIELDS:
        if key in editable_fields:
            merged[key] = editable_fields[key]
    merged["lastmod"] = dt.date.today().isoformat()

    if not body.strip():
        raise ArticleFailure("validation-failed", "正文不能为空。")

    # 自匹配补段评锚点 + 更新 articleRevision（comments-prepare --write 语义）
    stabilized, report = assign_ids(body, body)
    article_id = str(data.get("articleId") or "").strip()
    if article_id:
        merged["articleRevision"] = revision_for(article_id, stabilized)

    rendered = render_source(merged, stabilized)
    try:
        roundtrip = yaml.safe_load(rendered.split("---", 2)[1])
    except (yaml.YAMLError, IndexError) as error:
        raise ArticleFailure("validation-failed", f"合并后的 Front Matter 无法序列化：{error}") from error
    if not isinstance(roundtrip, dict):
        raise ArticleFailure("validation-failed", "合并后的 Front Matter 校验失败。")

    # 备份当前磁盘文件（每篇保留最近 BACKUP_KEEP 份）
    section = target.relative_to(project_root / "content").parts[0]
    slug = str(data.get("slug") or target.parent.name)
    backup = _backup_path(project_root / ".cache" / "studio", section, slug)
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
            # os.replace 已成功但后续失败：把原内容原子写回
            try:
                target.write_bytes(original_bytes)
            except OSError:
                pass
        raise

    data_after, body_after = split_source(target.read_text(encoding="utf-8"))
    collections = _collection_titles(project_root)
    return {
        "article": _index_entry(project_root, target, data_after, body_after, collections),
        "anchors": {"created": report.created, "retained": report.retained},
        # 编辑器必须拿到稳定化后的正文（含新补的锚点），否则下次保存会给
        # 同一段落再发新锚点，破坏段评身份。
        "body": stabilized,
    }


# ---------------------------------------------------------------------------
# 新建文章
# ---------------------------------------------------------------------------


def _validate_slug(value: str, label: str) -> str:
    value = str(value or "").strip()
    if not SLUG_FORMAT.fullmatch(value):
        raise ArticleFailure(
            "validation-failed",
            f"{label}只能使用小写英文字母、数字和连字符，且不能以连字符开头或结尾。",
        )
    return value


def new_article(project_root, fields: dict) -> dict:
    """以 archetypes/default.md 为模板新建草稿 bundle；目标已存在一律拒绝。"""
    project_root = Path(project_root).resolve()
    if not isinstance(fields, dict):
        raise ArticleFailure("bad-request", "字段必须是对象。")
    title = str(fields.get("title") or "").strip()
    if not title:
        raise ArticleFailure("validation-failed", "标题不能为空。")
    subtitle = str(fields.get("subtitle") or "").strip()
    section = str(fields.get("section") or "").strip()
    if section not in SECTIONS:
        raise ArticleFailure("validation-failed", "未知栏目（可选 works/essays/archives）。")
    slug = _validate_slug(fields.get("slug"), "slug")

    collection_slug = ""
    collection_title = ""
    collections: list[str] = []
    if section == "works":
        collection_slug = _validate_slug(fields.get("collectionSlug"), "文集slug")
        collection_dir = project_root / "content" / "works" / collection_slug
        collection_index = collection_dir / "_index.md"
        if collection_index.is_file():
            existing, _ = split_source(collection_index.read_text(encoding="utf-8"))
            collection_title = str(existing.get("title") or collection_slug)
        else:
            collection_title = str(fields.get("collectionTitle") or "").strip()
            if not collection_title:
                raise ArticleFailure("validation-failed", "新建文集必须填写文集名称。")
        collections = [collection_title]
        target = collection_dir / slug
    else:
        target = project_root / "content" / section / slug

    if target.exists():
        raise ArticleFailure("conflict", f"目标已存在：{target.relative_to(project_root).as_posix()}/")

    today = dt.date.today().isoformat()
    article_id = new_article_id()
    front_matter = {
        "title": title,
        "subtitle": subtitle,
        "date": today,
        "lastmod": today,
        "slug": slug,
        "description": "",
        "draft": True,  # 新文章一律草稿，不会发布
        "featured": False,
        "weight": 10,
        "volume": "",
        "collections": collections,
        "categories": [],
        "tags": [],
        "series": [],
        "period": [],
        "people": [],
        "places": [],
        "aliases": [],
        "articleId": article_id,
        "comments": {"paragraph": True},
    }
    placeholder = "在这里开始写作。"
    stabilized, _report = assign_ids(placeholder, "")
    front_matter["articleRevision"] = revision_for(article_id, stabilized)
    markdown = render_source(front_matter, stabilized)

    # 与导入 commit 相同：临时目录写产物 → 校验 → 原子移动；失败不留半成品
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{slug}.studio-new-", dir=target.parent))
    collection_index_created: Path | None = None
    try:
        (temporary / "index.md").write_text(markdown, encoding="utf-8")
        data_check, _ = split_source((temporary / "index.md").read_text(encoding="utf-8"))
        if not data_check.get("title"):
            raise ArticleFailure("write-failed", "生成的 index.md 缺少有效的 Front Matter。")
        if section == "works":
            collection_index = target.parent / "_index.md"
            if not collection_index.exists():
                collection_index.write_text(
                    "---\n"
                    + yaml.safe_dump(
                        {"title": collection_title, "description": "", "status": "连载中"},
                        allow_unicode=True,
                        sort_keys=False,
                    )
                    + "---\n",
                    encoding="utf-8",
                )
                collection_index_created = collection_index
        os.replace(temporary, target)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        if collection_index_created is not None and collection_index_created.exists():
            collection_index_created.unlink()
        raise

    data_after, body_after = split_source((target / "index.md").read_text(encoding="utf-8"))
    return _index_entry(project_root, target / "index.md", data_after, body_after, _collection_titles(project_root))


# ---------------------------------------------------------------------------
# 搜索
# ---------------------------------------------------------------------------


def _list_text(value) -> str:
    if isinstance(value, (list, tuple)):
        return " ".join(str(item) for item in value)
    return str(value or "")


def _snippet(text: str, query: str) -> str:
    folded = text.casefold()
    position = folded.find(query.casefold())
    if position < 0:
        return ""
    start = max(0, position - SNIPPET_CONTEXT)
    end = min(len(text), position + len(query) + SNIPPET_CONTEXT)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return prefix + re.sub(r"\s+", " ", text[start:end]).strip() + suffix


def search_articles(project_root, query: str) -> list[dict]:
    """大小写不敏感子串匹配标题/副标题/各列表字段/正文；空 query 返回空。"""
    query = str(query or "").strip()
    if not query:
        return []
    project_root = Path(project_root).resolve()
    collections = _collection_titles(project_root)
    folded = query.casefold()
    results: list[dict] = []
    for article in scan_content(project_root):
        target = project_root / article["path"]
        try:
            data, body = split_source(target.read_text(encoding="utf-8"))
        except ArticleFailure:
            continue
        metadata_text = " ".join(
            [
                str(data.get("title") or ""),
                str(data.get("subtitle") or ""),
                *(_list_text(data.get(key)) for key in ("categories", "tags", "people", "places", "collections")),
            ]
        )
        entry = dict(article)
        if folded in metadata_text.casefold():
            results.append(entry)
            continue
        plain = plain_body(body)
        if folded in plain.casefold():
            entry["snippet"] = _snippet(plain, query)
            results.append(entry)
    return results
