"""作者批注：按稳定 articleId 存放在 data/author-notes/ 下。

与评论服务完全无关——这是作者自己的内容文件，和 index.md 一样受 git 与
保存备份保护。前台只展示 ``status: published`` 的条目（过滤在 Hugo 模板
侧完成，见 themes/lidaiji/layouts/partials/author-notes.html）。

安全与一致性边界：
- 路径走与文章接口完全相同的 ``articles.resolve_article_path`` 校验；
- **绝不改动 index.md**——批注只读写 data/author-notes/<articleId>.yaml；
- 写入是与 articles 相同的事务：备份 → 同目录临时文件 → os.replace 原子
  替换，失败清理临时文件，磁盘原文件保持不动；
- scope=paragraph 的 paragraphId 必须存在于该文当前正文的段评锚点里，
  防止批注挂到不存在的段落上。
"""

from __future__ import annotations

import datetime as dt
import os
import re
import secrets
import shutil
import tempfile
from pathlib import Path

import yaml

from studio import articles

LEGACY_NOTES_FILENAME = "author-notes.yaml"
NOTES_DIRECTORY = Path("data") / "author-notes"
ARTICLE_ID = re.compile(r"^article-[0-9a-z][0-9a-z_-]{0,127}$")
NOTE_ID = re.compile(r"^note-[0-9a-f]{12}$")
PARAGRAPH_ID = re.compile(r"^p-[0-9a-f]{12}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ANCHOR = re.compile(r"<!--\s*paragraph-id:(p-[0-9a-f]{12})\s*-->")
SCOPES = ("paragraph", "article")
STATUSES = ("draft", "published")
BODY_MAX = 5000
BACKUP_KEEP = 10
EXCERPT_MAX = 60


class NoteFailure(Exception):
    """可直接转成 JSON 错误响应的失败（code 对应 server.HTTP_BY_CODE）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 结构校验
# ---------------------------------------------------------------------------


def _fail(message: str) -> None:
    raise NoteFailure("validation-failed", message)


def _validate_note(item) -> dict:
    """校验单条批注结构并返回规范化的 dict（键序固定）。"""
    if not isinstance(item, dict):
        _fail("批注条目必须是键值结构。")
    note_id = str(item.get("id") or "")
    if not NOTE_ID.fullmatch(note_id):
        _fail(f"批注 ID 格式不正确：{note_id or '（空）'}")
    scope = str(item.get("scope") or "")
    if scope not in SCOPES:
        _fail(f"批注 {note_id} 的 scope 必须是 paragraph 或 article。")
    paragraph_id = item.get("paragraphId")
    if scope == "paragraph":
        paragraph_id = str(paragraph_id or "")
        if not PARAGRAPH_ID.fullmatch(paragraph_id):
            _fail(f"批注 {note_id} 缺少合法的段落锚点 paragraphId。")
    else:
        if paragraph_id:
            _fail(f"批注 {note_id} 是篇章评，不应带 paragraphId。")
        paragraph_id = None
    body = item.get("body")
    if not isinstance(body, str):
        _fail(f"批注 {note_id} 的正文必须是字符串。")
    if not body.strip():
        _fail(f"批注 {note_id} 的正文不能为空。")
    if len(body) > BODY_MAX:
        _fail(f"批注 {note_id} 的正文超过 {BODY_MAX} 字上限。")
    status = str(item.get("status") or "")
    if status not in STATUSES:
        _fail(f"批注 {note_id} 的 status 必须是 draft 或 published。")
    created = str(item.get("created") or "")
    updated = str(item.get("updated") or "")
    if not DATE.fullmatch(created) or not DATE.fullmatch(updated):
        _fail(f"批注 {note_id} 的 created/updated 必须是 YYYY-MM-DD。")
    return {
        "id": note_id,
        "scope": scope,
        "paragraphId": paragraph_id,
        "body": body,
        "status": status,
        "created": created,
        "updated": updated,
    }


def _load_file(notes_path: Path) -> list[dict]:
    """解析并校验 author-notes.yaml；坏文件报 validation-failed 而不是崩溃。"""
    try:
        data = yaml.safe_load(notes_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as error:
        raise NoteFailure("validation-failed", f"author-notes.yaml 无法解析：{error}") from error
    if not isinstance(data, dict) or data.get("version") != 1:
        _fail("author-notes.yaml 缺少 version: 1 头。")
    notes = data.get("notes")
    if notes is None:
        return []
    if not isinstance(notes, list):
        _fail("author-notes.yaml 的 notes 必须是列表。")
    validated = [_validate_note(item) for item in notes]
    ids = [note["id"] for note in validated]
    if len(set(ids)) != len(ids):
        _fail("author-notes.yaml 存在重复的批注 ID。")
    return validated


def _render(notes: list[dict]) -> str:
    return yaml.safe_dump(
        {"version": 1, "notes": notes},
        allow_unicode=True,
        sort_keys=False,
        width=1000,
    )


# ---------------------------------------------------------------------------
# 读取
# ---------------------------------------------------------------------------


def _resolve(project_root, rel_path) -> Path:
    try:
        return articles.resolve_article_path(project_root, rel_path)
    except articles.ArticleFailure as error:
        raise NoteFailure(error.code, error.message) from error


def _body_of(target: Path) -> str:
    try:
        _data, body = articles.split_source(target.read_text(encoding="utf-8"))
    except articles.ArticleFailure as error:
        raise NoteFailure(error.code, error.message) from error
    return body


def _article_id_of(target: Path) -> str:
    try:
        data, _body = articles.split_source(target.read_text(encoding="utf-8"))
    except articles.ArticleFailure as error:
        raise NoteFailure(error.code, error.message) from error
    article_id = str(data.get("articleId") or "").strip()
    if not ARTICLE_ID.fullmatch(article_id):
        _fail("文章缺少合法且稳定的 articleId，不能保存作者评。")
    return article_id


def notes_path_for_article(project_root: Path, target: Path) -> Path:
    """返回不会被Hugo复制到产物的作者评源文件路径。"""
    return project_root / NOTES_DIRECTORY / f"{_article_id_of(target)}.yaml"


def _atomic_write(path: Path, rendered: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = ""
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".author-notes-", suffix=".tmp", dir=path.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(rendered)
        os.replace(temporary, path)
        temporary = ""
    except Exception:
        if temporary:
            Path(temporary).unlink(missing_ok=True)
        raise


def migrate_legacy_notes(project_root: Path, target: Path) -> Path:
    """幂等迁移旧Page Bundle作者评，冲突时拒绝覆盖任一侧。"""
    destination = notes_path_for_article(project_root, target)
    legacy = target.parent / LEGACY_NOTES_FILENAME
    if not legacy.is_file():
        return destination

    legacy_notes = _load_file(legacy)
    rendered = _render(legacy_notes)
    if destination.is_file():
        current_notes = _load_file(destination)
        if _render(current_notes) != rendered:
            raise NoteFailure("conflict", "旧作者评与新存储位置内容不同，已停止迁移且未覆盖文件。")
    else:
        _atomic_write(destination, rendered)
        if _render(_load_file(destination)) != rendered:
            raise NoteFailure("write-failed", "作者评迁移写入后的内容校验失败。")
    legacy.unlink()
    return destination


def read_notes(project_root, rel_path) -> list[dict]:
    """读取该文全部批注；文件不存在返回空列表。"""
    target = _resolve(project_root, rel_path)
    project_root = Path(project_root).resolve()
    notes_path = migrate_legacy_notes(project_root, target)
    if not notes_path.is_file():
        return []
    return _load_file(notes_path)


def list_paragraphs(project_root, rel_path) -> list[dict]:
    """该文当前正文里的全部段评锚点及段落摘录（供批注选择段落）。"""
    target = _resolve(project_root, rel_path)
    if not target.is_file():
        raise NoteFailure("not-found", "找不到这篇文章。")
    body = _body_of(target)
    paragraphs: list[dict] = []
    for matched in ANCHOR.finditer(body):
        rest = body[matched.end():]
        excerpt = ""
        for line in rest.splitlines():
            line = line.strip()
            if not line or ANCHOR.search(line):
                continue
            excerpt = re.sub(r"[#*_>`\[\]()!]+", "", line).strip()
            break
        if len(excerpt) > EXCERPT_MAX:
            excerpt = excerpt[:EXCERPT_MAX] + "…"
        paragraphs.append({"paragraphId": matched.group(1), "excerpt": excerpt})
    return paragraphs


# ---------------------------------------------------------------------------
# 事务写入
# ---------------------------------------------------------------------------


def _backup_path(cache_root: Path, section: str, slug: str) -> Path:
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    directory = cache_root / "backups" / f"{section}-{slug}"
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / f"notes-{stamp}.yaml"
    suffix = 1
    while candidate.exists():
        candidate = directory / f"notes-{stamp}-{suffix}.yaml"
        suffix += 1
    return candidate


def _prune_backups(directory: Path) -> None:
    backups = sorted(directory.glob("notes-*.yaml"))
    for old in backups[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)


def _write_transaction(project_root: Path, target: Path, notes: list[dict]) -> None:
    """备份 → 同目录临时文件 → os.replace；空列表则删除文件（先备份）。"""
    notes_path = migrate_legacy_notes(project_root, target)
    if notes_path.is_file():
        section = target.relative_to(project_root / "content").parts[0]
        try:
            data, _ = articles.split_source(target.read_text(encoding="utf-8"))
            slug = str(data.get("slug") or target.parent.name)
        except articles.ArticleFailure:
            slug = target.parent.name
        backup = _backup_path(project_root / ".cache" / "studio", section, slug)
        shutil.copy2(notes_path, backup)
        _prune_backups(backup.parent)
    if not notes:
        notes_path.unlink(missing_ok=True)
        return
    rendered = _render(notes)
    _atomic_write(notes_path, rendered)


def _anchors_of(target: Path) -> set[str]:
    return set(ANCHOR.findall(_body_of(target)))


def save_note(project_root, rel_path, note_input: dict) -> dict:
    """新建或更新一条批注；id 为空新建，否则按 id 更新（scope 不可改）。"""
    project_root = Path(project_root).resolve()
    target = _resolve(project_root, rel_path)
    if not target.is_file():
        raise NoteFailure("not-found", "找不到这篇文章。")
    if not isinstance(note_input, dict):
        raise NoteFailure("bad-request", "note 必须是对象。")
    notes_path = migrate_legacy_notes(project_root, target)
    existing = _load_file(notes_path) if notes_path.is_file() else []
    anchors = _anchors_of(target)
    today = dt.date.today().isoformat()

    note_id = str(note_input.get("id") or "").strip()
    if note_id:
        found = next((note for note in existing if note["id"] == note_id), None)
        if found is None:
            raise NoteFailure("not-found", "没有这条批注。")
        if "scope" in note_input and str(note_input["scope"]) != found["scope"]:
            _fail("批注的 scope 不可更改。")
        body = note_input.get("body", found["body"])
        status = str(note_input.get("status") or found["status"])
        if found["scope"] == "paragraph":
            paragraph_id = str(note_input.get("paragraphId") or found["paragraphId"])
            # 重新关联到其他段落时锚点必须存在；保留原锚点不校验——否则正文删段
            # 后失效的批注连「改为草稿」都无法保存（修复路径会被堵死），失效
            # 状态由 broken_notes/发布前检查负责拦截。
            if paragraph_id != found["paragraphId"] and paragraph_id not in anchors:
                _fail(f"段落锚点 {paragraph_id} 在该文当前正文中不存在。")
        else:
            if note_input.get("paragraphId"):
                _fail("篇章评不应带 paragraphId。")
            paragraph_id = None
        candidate = {
            "id": found["id"],
            "scope": found["scope"],
            "paragraphId": paragraph_id,
            "body": body,
            "status": status,
            "created": found["created"],
            "updated": today,
        }
        validated = _validate_note(candidate)
        notes = [validated if note["id"] == note_id else note for note in existing]
    else:
        scope = str(note_input.get("scope") or "")
        if scope not in SCOPES:
            _fail("scope 必须是 paragraph 或 article。")
        paragraph_id = None
        if scope == "paragraph":
            paragraph_id = str(note_input.get("paragraphId") or "")
            if not PARAGRAPH_ID.fullmatch(paragraph_id):
                _fail("请选择批注对应的段落。")
            if paragraph_id not in anchors:
                _fail(f"段落锚点 {paragraph_id} 在该文当前正文中不存在。")
        elif note_input.get("paragraphId"):
            _fail("篇章评不应带 paragraphId。")
        candidate = {
            "id": f"note-{secrets.token_hex(6)}",
            "scope": scope,
            "paragraphId": paragraph_id,
            "body": note_input.get("body"),
            "status": str(note_input.get("status") or "draft"),
            "created": today,
            "updated": today,
        }
        validated = _validate_note(candidate)
        notes = [*existing, validated]

    _write_transaction(project_root, target, notes)
    return {"note": validated, "notes": notes}


def delete_note(project_root, rel_path, note_id: str) -> list[dict]:
    """按 id 移除一条批注（作品内容，有 git+备份兜底，允许真删）。"""
    project_root = Path(project_root).resolve()
    target = _resolve(project_root, rel_path)
    note_id = str(note_id or "").strip()
    if not NOTE_ID.fullmatch(note_id):
        _fail("批注 ID 格式不正确。")
    existing = read_notes(project_root, rel_path)
    notes = [note for note in existing if note["id"] != note_id]
    if len(notes) == len(existing):
        raise NoteFailure("not-found", "没有这条批注。")
    _write_transaction(project_root, target, notes)
    return notes


# ---------------------------------------------------------------------------
# 汇总（首页卡片）与失效锚点检测（发布阻断）
# ---------------------------------------------------------------------------


def broken_notes(project_root) -> list[dict]:
    """已发布段落评但锚点在该文当前正文中已不存在的批注清单。

    正文删改导致锚点消失时，挂在该段落上的 published 批注在前台静默消失；
    这里把它们列出来，供发布前检查阻断发布、首页卡片提醒。
    """
    project_root = Path(project_root).resolve()
    broken: list[dict] = []
    for article in articles.scan_content(project_root):
        notes_file = project_root / article["path"]
        yaml_path = migrate_legacy_notes(project_root, notes_file)
        if not yaml_path.is_file() or not notes_file.is_file():
            continue
        try:
            candidates = [
                note
                for note in _load_file(yaml_path)
                if note["scope"] == "paragraph" and note["status"] == "published"
            ]
        except NoteFailure:
            continue  # 坏文件由 summary 的 error 标记负责，这里不重复报告
        if not candidates:
            continue
        anchors = set(ANCHOR.findall(notes_file.read_text(encoding="utf-8")))
        for note in candidates:
            if note["paragraphId"] not in anchors:
                excerpt = re.sub(r"\s+", " ", note["body"].strip())[:60]
                broken.append(
                    {
                        "path": article["path"],
                        "title": article["title"],
                        "id": note["id"],
                        "paragraphId": note["paragraphId"],
                        "excerpt": excerpt,
                    }
                )
    return broken


def notes_summary(project_root) -> dict:
    """全 content 扫描：每文 draft/published 数、总 draft 数与失效批注清单。"""
    project_root = Path(project_root).resolve()
    items: list[dict] = []
    total_draft = 0
    total_published = 0
    for article in articles.scan_content(project_root):
        notes_path = project_root / article["path"]
        notes_file = migrate_legacy_notes(project_root, notes_path)
        if not notes_file.is_file():
            continue
        entry = {"path": article["path"], "title": article["title"], "draft": 0, "published": 0, "error": False}
        try:
            for note in _load_file(notes_file):
                entry[note["status"]] += 1
        except NoteFailure:
            entry["error"] = True
        total_draft += entry["draft"]
        total_published += entry["published"]
        items.append(entry)
    broken = broken_notes(project_root)
    return {
        "totalDraft": total_draft,
        "totalPublished": total_published,
        "articles": items,
        "brokenPublished": len(broken),
        "broken": broken,
    }
