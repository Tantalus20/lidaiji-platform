"""DOCX 导入的三阶段管线：解析（parse）、计划（plan）、提交（commit）。

三个阶段严格分离：

- ``parse_docx`` 只读 Word 文件，结果全部保存在内存，不写任何磁盘文件；
- ``plan_import`` 纯计算，生成可序列化为 JSON 的导入计划（含冲突检测），不写盘；
- ``commit_import`` 依据计划与源文件执行半原子写入，失败时清理临时目录，
  不在 content/ 留半成品。

docx-importer.py 的命令行行为保持不变，只是在内部改为依次调用这三个阶段；
docx-series-importer.py 依赖的旧接口（ImageWriter、render_paragraph 等）也由
docx-importer.py 从这里转发，签名保持兼容。
"""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import os
import re
import shutil
import sys
import tempfile
import zipfile
from dataclasses import asdict, dataclass, field
from importlib import util as importlib_util
from pathlib import Path, PurePosixPath
from typing import Iterable

import yaml
from PIL import Image, ImageOps, UnidentifiedImageError
from docx import Document
from docx.document import Document as DocumentType
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.text.run import Run

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from paragraph_ids import (  # noqa: E402
    MARKER,
    assign_ids,
    new_article_id,  # noqa: F401 供 docx-importer 转发给旧调用方
    records_from_markdown,
    revision_for,
)

VALID_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HEADING_STYLE = re.compile(r"^(?:heading|标题|標題)\s*([1-3])$", re.IGNORECASE)
QUOTE_STYLES = {"quote", "intense quote", "引用", "明显引用", "明顯引用"}
TITLE_STYLES = {"title", "标题", "標題"}
# 视为“正文类”的样式：不给 unknown-style 警告
NORMAL_STYLES = {
    "normal",
    "正文",
    "正文文本",
    "普通",
    "body text",
    "list paragraph",
    "no spacing",
    "无间隔",
}
IMAGE_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/tiff": ".tiff",
    "image/bmp": ".bmp",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/x-emf": ".emf",
    "image/x-wmf": ".wmf",
}


class ImportFailure(RuntimeError):
    """可读的导入失败。"""

    code = "import-failed"


class SourceFailure(ImportFailure):
    """源文件本身不可用（不是.docx、含宏、过大、不是有效压缩包等）。"""

    code = "invalid-source"


class ValidationFailure(ImportFailure):
    """选项或文档内容不满足导入条件（slug非法、标题为空、正文为空等）。"""

    code = "validation-failed"


class ConflictFailure(ImportFailure):
    """导入计划与现有内容冲突且未使用force。"""

    code = "conflict"


class WriteFailure(ImportFailure):
    """写入或写入前校验失败。"""

    code = "write-failed"


@dataclass
class ImportWarning:
    code: str
    message: str
    location: str = ""


@dataclass
class BlockInfo:
    """正文中的一个结构块（段落/标题/引用/列表/表格）。"""

    position: int  # 在正文块中的序号（从1开始，段落与表格统一编号）
    kind: str  # paragraph / heading-1..3 / quote / list-bullet / list-number / table
    style: str  # Word样式名（表格为空）
    text: str  # 纯文本内容


@dataclass
class SourceInfo:
    filename: str
    size: int
    sha256: str


@dataclass
class CollectedImage:
    """解析阶段收集到内存中的一张图片（原图字节 + 可选的WebP字节）。"""

    stem: str  # image-001
    part_name: str  # docx包内部件名，如 word/media/image1.png
    media_type: str
    original_extension: str
    original_bytes: bytes
    webp_bytes: bytes | None  # 转换失败时为None，正文引用原图

    @property
    def original_name(self) -> str:
        return f"{self.stem}{self.original_extension}"

    @property
    def reference(self) -> str:
        """正文中引用的bundle内相对路径。"""
        if self.webp_bytes is not None:
            return f"images/{self.stem}.webp"
        return f"images/original/{self.original_name}"


@dataclass
class ParseResult:
    """parse_docx 的产出：全部在内存中，可直接复用给 plan/commit。"""

    source: SourceInfo
    body_markdown: str  # 渲染后的正文（尚未加段落锚点）
    description: str
    word_title: str  # Word中第一个Title样式段落的文字（无则为空）
    blocks: list[BlockInfo]
    images: list[CollectedImage]
    warnings: list[ImportWarning]
    paragraph_count: int
    heading_count: int
    word_count: int
    footnote_count: int


@dataclass
class ImportOptions:
    """plan_import 的输入选项（与旧CLI参数一一对应，另加可选的article_id）。"""

    title: str
    slug: str
    section: str
    subtitle: str = ""
    collections: list[str] = field(default_factory=list)
    collection_slug: str = ""
    categories: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    series: list[str] = field(default_factory=list)  # 缺省时等于collections
    period: list[str] = field(default_factory=list)
    people: list[str] = field(default_factory=list)
    places: list[str] = field(default_factory=list)
    description: str = ""
    date: str = ""
    weight: int = 10
    draft: bool = True
    article_id: str = ""  # 显式指定；缺省时沿用旧稿或为源文件派生确定ID


@dataclass
class Asset:
    source_name: str  # docx包内部件名
    target_name: str  # 项目相对路径
    media_type: str
    size: int  # 字节数，commit校验用


@dataclass
class Conflict:
    code: str  # target-exists / slug-duplicate / article-id-duplicate
    message: str
    path: str  # 项目相对路径


@dataclass
class ImportPlan:
    """plan_import 的产出：可序列化为JSON，commit不再重新随机任何ID。"""

    source: SourceInfo
    options: ImportOptions
    suggested: dict  # docx-assistant的建议（title/slug/section/collection等）
    target: str  # 项目相对的bundle目录，如 content/works/lidai-ji/ren-zong-ji
    front_matter: dict
    markdown: str  # 含段落锚点的正文
    stats: dict  # wordCount/paragraphCount/headingCount/imageCount/footnoteCount
    assets: list[Asset]
    warnings: list[ImportWarning]
    conflicts: list[Conflict]
    proposed_files: list[str]  # 项目相对路径

    def document_info(self) -> dict:
        """JSON契约中的document字段：建议信息 + 统计。"""
        return {
            "suggestedTitle": self.suggested.get("title", ""),
            "suggestedSlug": self.suggested.get("slug", ""),
            "suggestedSection": self.suggested.get("section", ""),
            "suggestedCollection": self.suggested.get("collection", ""),
            "suggestedCollectionSlug": self.suggested.get("collection_slug", ""),
            "wordTitle": self.suggested.get("word_title", ""),
            "wordCount": self.stats.get("wordCount", 0),
            "paragraphCount": self.stats.get("paragraphCount", 0),
            "headingCount": self.stats.get("headingCount", 0),
            "imageCount": self.stats.get("imageCount", 0),
            "footnoteCount": self.stats.get("footnoteCount", 0),
        }

    def to_json_dict(self) -> dict:
        """固定键序的JSON表示；只含项目相对路径，不含图片字节与本机路径。"""
        return {
            "version": 1,
            "source": {
                "filename": self.source.filename,
                "size": self.source.size,
                "sha256": self.source.sha256,
            },
            "document": self.document_info(),
            "options": asdict(self.options),
            "target": self.target,
            "frontMatter": self.front_matter,
            "markdown": self.markdown,
            "assets": [
                {
                    "sourceName": asset.source_name,
                    "targetName": asset.target_name,
                    "mediaType": asset.media_type,
                    "size": asset.size,
                }
                for asset in self.assets
            ],
            "warnings": [asdict(item) for item in self.warnings],
            "conflicts": [asdict(item) for item in self.conflicts],
            "proposedFiles": list(self.proposed_files),
        }

    @staticmethod
    def from_json_dict(data: dict) -> "ImportPlan":
        """从plan.json还原；只读取已知字段，忽略多余字段。"""
        source = data.get("source") or {}
        options_data = data.get("options") or {}
        option_fields = set(ImportOptions.__dataclass_fields__)
        options = ImportOptions(**{key: value for key, value in options_data.items() if key in option_fields})
        document = data.get("document") or {}
        suggested = {
            "title": document.get("suggestedTitle", ""),
            "slug": document.get("suggestedSlug", ""),
            "section": document.get("suggestedSection", ""),
            "collection": document.get("suggestedCollection", ""),
            "collection_slug": document.get("suggestedCollectionSlug", ""),
            "word_title": document.get("wordTitle", ""),
        }
        stats = {
            "wordCount": document.get("wordCount", 0),
            "paragraphCount": document.get("paragraphCount", 0),
            "headingCount": document.get("headingCount", 0),
            "imageCount": document.get("imageCount", 0),
            "footnoteCount": document.get("footnoteCount", 0),
        }
        assets = [
            Asset(
                source_name=item.get("sourceName", ""),
                target_name=item.get("targetName", ""),
                media_type=item.get("mediaType", ""),
                size=int(item.get("size", 0)),
            )
            for item in data.get("assets") or []
        ]
        warnings = [
            ImportWarning(code=item.get("code", ""), message=item.get("message", ""), location=item.get("location", ""))
            for item in data.get("warnings") or []
        ]
        conflicts = [
            Conflict(code=item.get("code", ""), message=item.get("message", ""), path=item.get("path", ""))
            for item in data.get("conflicts") or []
        ]
        return ImportPlan(
            source=SourceInfo(
                filename=source.get("filename", ""),
                size=int(source.get("size", 0)),
                sha256=source.get("sha256", ""),
            ),
            options=options,
            suggested=suggested,
            target=data.get("target", ""),
            front_matter=data.get("frontMatter") or {},
            markdown=data.get("markdown", ""),
            stats=stats,
            assets=assets,
            warnings=warnings,
            conflicts=conflicts,
            proposed_files=list(data.get("proposedFiles") or []),
        )


@dataclass
class CommitResult:
    output: str
    markdown: str
    title: str
    slug: str
    section: str
    word_count: int
    image_count: int
    backup: str
    warnings: list[ImportWarning]


# ---------------------------------------------------------------------------
# 解析辅助（与旧docx-importer一致的纯函数）
# ---------------------------------------------------------------------------


def validate_slug(value: str, label: str) -> str:
    value = value.strip().lower()
    if not VALID_SLUG.fullmatch(value):
        raise ValidationFailure(f"{label}只能使用小写英文字母、数字和连字符，且不能以连字符开头或结尾。")
    return value


def split_values(values: Iterable[str] | None) -> list[str]:
    result: list[str] = []
    for value in values or []:
        for item in re.split(r"[,，]", value):
            item = item.strip()
            if item and item not in result:
                result.append(item)
    return result


def safe_markdown_text(text: str) -> str:
    text = text.replace("\r", "").replace("\v", "\n")
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"([\\`*_[\]#])", r"\\\1", text)
    return text


def plain_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def visible_word_count(text: str) -> int:
    cjk = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text))
    latin = len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text))
    return cjk + latin


def truncate_description(text: str, limit: int = 160) -> str:
    text = plain_text(text)
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip("，。；、,.!?！？ ") + "…"


def iter_blocks(document: DocumentType):
    """按正文顺序遍历段落与表格。"""
    body = document.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            yield Paragraph(child, document)
        elif child.tag == qn("w:tbl"):
            yield Table(child, document)


def paragraph_runs(paragraph: Paragraph):
    """包含超链接内文字，但不访问链接目标。"""
    for child in paragraph._p.iterchildren():
        if child.tag == qn("w:r"):
            yield Run(child, paragraph)
        elif child.tag == qn("w:hyperlink"):
            for run_element in child.findall(qn("w:r")):
                yield Run(run_element, paragraph)


def style_name(paragraph: Paragraph) -> str:
    if paragraph.style is None:
        return ""
    return (paragraph.style.name or paragraph.style.style_id or "").strip()


def image_alt(run: Run, fallback: str) -> str:
    nodes = run._element.xpath(".//wp:docPr")
    if nodes:
        node = nodes[0]
        for key in ("descr", "title", "name"):
            value = plain_text(node.get(key, ""))
            if value and not re.fullmatch(r"(?:Picture|图片|圖像)\s*\d+", value, re.IGNORECASE):
                return value
    return fallback


def paragraph_kind(name: str) -> str:
    """按样式名归类段落；渲染与统计共用，保证口径一致。"""
    heading = HEADING_STYLE.fullmatch(name.replace(" ", "")) or HEADING_STYLE.fullmatch(name)
    if heading:
        return f"heading-{heading.group(1)}"
    if name.casefold() in {item.casefold() for item in QUOTE_STYLES}:
        return "quote"
    lowered = name.casefold()
    if "list bullet" in lowered or "项目符号" in name:
        return "list-bullet"
    if "list number" in lowered or "编号" in name:
        return "list-number"
    return "paragraph"


def is_recognized_style(name: str) -> bool:
    """已识别或视为正文的样式不触发 unknown-style 警告。"""
    if not name:
        return True
    if paragraph_kind(name) != "paragraph":
        return True
    lowered = name.casefold()
    if lowered in {item.casefold() for item in NORMAL_STYLES}:
        return True
    return lowered in {item.casefold() for item in TITLE_STYLES}


# ---------------------------------------------------------------------------
# 图片：收集（内存）与落盘两步分离
# ---------------------------------------------------------------------------


class ImageCollector:
    """解析阶段在内存中收集图片；落盘由 write_image/write_images 完成。"""

    def __init__(self, document: DocumentType, warnings: list[ImportWarning]):
        self.document = document
        self.warnings = warnings
        self.images: list[CollectedImage] = []
        self.by_relationship: dict[str, str] = {}

    @property
    def count(self) -> int:
        return len(self.images)

    def write_run_images(self, run: Run) -> list[str]:
        """沿用旧接口名；对收集器而言只是“收集”，并不写盘。"""
        markdown: list[str] = []
        for blip in run._element.xpath(".//a:blip"):
            relationship_id = blip.get(qn("r:embed"))
            if not relationship_id:
                self.warnings.append(ImportWarning("linked-image", "发现链接图片，未下载外部资源。"))
                continue
            if relationship_id in self.by_relationship:
                relative = self.by_relationship[relationship_id]
                markdown.append(f"![{safe_markdown_text(image_alt(run, '文章图片'))}]({relative})")
                continue
            part = self.document.part.related_parts.get(relationship_id)
            if part is None or not hasattr(part, "blob"):
                self.warnings.append(ImportWarning("missing-image", "发现无法读取的内嵌图片。"))
                continue
            image = self.collect(part)
            self.by_relationship[relationship_id] = image.reference
            markdown.append(f"![{safe_markdown_text(image_alt(run, f'图片{len(self.images)}'))}]({image.reference})")
        return markdown

    def collect(self, part) -> CollectedImage:
        """把一张内嵌图片收进内存：保留原图字节，并尝试在内存中转WebP。"""
        stem = f"image-{len(self.images) + 1:03d}"
        content_type = getattr(part, "content_type", "")
        extension = IMAGE_CONTENT_TYPES.get(content_type)
        part_name = str(getattr(part, "partname", ""))
        if not extension:
            extension = Path(part_name).suffix.lower() or ".bin"
        original_name = f"{stem}{extension}"
        if len(part.blob) > 5 * 1024 * 1024:
            self.warnings.append(
                ImportWarning("large-image", f"{original_name}超过5MB，建议检查网页加载效果。")
            )
        webp_bytes: bytes | None = None
        try:
            with Image.open(io.BytesIO(part.blob)) as opened:
                image = ImageOps.exif_transpose(opened)
                if max(image.size) > 2400:
                    image.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                buffer = io.BytesIO()
                image.save(buffer, "WEBP", quality=86, method=6)
                webp_bytes = buffer.getvalue()
        except (UnidentifiedImageError, OSError, ValueError):
            self.warnings.append(
                ImportWarning(
                    "unconverted-image",
                    f"{original_name}无法转换为WebP，正文将引用保留的原图。",
                )
            )
        collected = CollectedImage(
            stem=stem,
            part_name=part_name,
            media_type=content_type,
            original_extension=extension,
            original_bytes=part.blob,
            webp_bytes=webp_bytes,
        )
        self.images.append(collected)
        return collected


def write_image(image: CollectedImage, bundle: Path) -> None:
    """把一张收集到的图片落盘：原图存images/original/，WebP存images/。"""
    original_dir = bundle / "images" / "original"
    original_dir.mkdir(parents=True, exist_ok=True)
    (original_dir / image.original_name).write_bytes(image.original_bytes)
    if image.webp_bytes is not None:
        webp_dir = bundle / "images"
        webp_dir.mkdir(parents=True, exist_ok=True)
        (webp_dir / f"{image.stem}.webp").write_bytes(image.webp_bytes)


def write_images(images: Iterable[CollectedImage], bundle: Path) -> None:
    for image in images:
        write_image(image, bundle)


class ImageWriter(ImageCollector):
    """旧接口：渲染过程中直接把图片写入Page Bundle（docx-series-importer仍在使用）。"""

    def __init__(self, document: DocumentType, bundle: Path, warnings: list[ImportWarning]):
        super().__init__(document, warnings)
        self.bundle = Path(bundle)

    def write_run_images(self, run: Run) -> list[str]:
        before = len(self.images)
        markdown = super().write_run_images(run)
        for image in self.images[before:]:
            write_image(image, self.bundle)
        return markdown


# ---------------------------------------------------------------------------
# 渲染（Markdown）
# ---------------------------------------------------------------------------


def render_run(run: Run, images: ImageCollector) -> str:
    text = safe_markdown_text(run.text or "")
    if text:
        if run.bold and run.italic:
            text = f"***{text}***"
        elif run.bold:
            text = f"**{text}**"
        elif run.italic:
            text = f"*{text}*"
    additions = images.write_run_images(run)
    if additions:
        text += ("\n\n" if text else "") + "\n\n".join(additions)
    return text


def render_paragraph(paragraph: Paragraph, images: ImageCollector) -> str:
    content = "".join(render_run(run, images) for run in paragraph_runs(paragraph)).strip()
    if not content:
        return ""
    name = style_name(paragraph)
    kind = paragraph_kind(name)
    if kind.startswith("heading-"):
        return f"{'#' * int(kind[-1])} {content}"
    if kind == "quote":
        return "\n".join(f"> {line}" if line else ">" for line in content.splitlines())
    if kind == "list-bullet":
        return f"- {content}"
    if kind == "list-number":
        return f"1. {content}"
    return content


def render_table(table: Table, warnings: list[ImportWarning]) -> str:
    rows = [[plain_text(cell.text).replace("|", "\\|") for cell in row.cells] for row in table.rows]
    if not rows or not rows[0]:
        warnings.append(ImportWarning("empty-table", "忽略了一个空表格。"))
        return ""
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    warnings.append(ImportWarning("table", "已把Word表格转换为Markdown表格；合并单元格和复杂格式可能需要检查。"))
    lines = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def external_relationship_count(document: DocumentType) -> int:
    count = 0
    for relationship in document.part.rels.values():
        if getattr(relationship, "is_external", False):
            count += 1
    return count


@dataclass
class ConvertedDocument:
    body: str
    description: str
    word_count: int
    word_title: str
    blocks: list[BlockInfo]
    images: list[CollectedImage]
    paragraph_count: int
    heading_count: int
    warnings: list[ImportWarning]


def convert_document(document: DocumentType) -> ConvertedDocument:
    """把python-docx文档渲染为Markdown正文，全部在内存中完成。"""
    warnings: list[ImportWarning] = []
    blocks: list[BlockInfo] = []
    empty_paragraphs = 0
    text_box_count = len(document.element.xpath(".//w:txbxContent"))
    if text_box_count:
        warnings.append(ImportWarning("text-box", f"发现{text_box_count}个文本框；文本框内容无法保证按原位置转换。"))
    external_count = external_relationship_count(document)
    if external_count:
        warnings.append(ImportWarning("external-link", f"发现{external_count}个外部链接关系；工具未访问这些地址。"))

    images = ImageCollector(document, warnings)
    output: list[str] = []
    description = ""
    word_title = ""
    skipped_word_title = False
    all_plain: list[str] = []
    position = 0
    paragraph_count = 0
    heading_count = 0
    for block in iter_blocks(document):
        position += 1
        if isinstance(block, Paragraph):
            raw = plain_text(block.text)
            name = style_name(block)
            if not skipped_word_title and name.casefold() in {item.casefold() for item in TITLE_STYLES} and raw:
                skipped_word_title = True
                word_title = raw
                continue
            kind = paragraph_kind(name)
            rendered = render_paragraph(block, images)
            if not rendered:
                empty_paragraphs += 1
                continue
            output.append(rendered)
            paragraph_count += 1
            if kind.startswith("heading-"):
                heading_count += 1
            if raw:
                all_plain.append(raw)
                blocks.append(BlockInfo(position=position, kind=kind, style=name, text=raw))
                if not description and not HEADING_STYLE.fullmatch(name.replace(" ", "")):
                    description = truncate_description(raw)
                if kind == "paragraph" and not is_recognized_style(name):
                    warnings.append(
                        ImportWarning(
                            "unknown-style",
                            f"第{position}段使用了未识别样式“{name}”，已按普通段落转换。",
                            f"第{position}段",
                        )
                    )
        else:
            rendered = render_table(block, warnings)
            if rendered:
                output.append(rendered)
                text = " ".join(cell.text for row in block.rows for cell in row.cells)
                all_plain.append(text)
                blocks.append(BlockInfo(position=position, kind="table", style="", text=plain_text(text)))
    if empty_paragraphs:
        warnings.append(ImportWarning("empty-paragraph", f"忽略了{empty_paragraphs}个空段落。"))
    body = "\n\n".join(output).strip() + "\n"
    return ConvertedDocument(
        body=body,
        description=description,
        word_count=visible_word_count("\n".join(all_plain)),
        word_title=word_title,
        blocks=blocks,
        images=images.images,
        paragraph_count=paragraph_count,
        heading_count=heading_count,
        warnings=warnings,
    )


def footnote_count(source: Path) -> int:
    """数word/footnotes.xml里的真实脚注（排除分隔符等占位条目）；不实现转换。"""
    try:
        with zipfile.ZipFile(source) as archive:
            names = {name.casefold() for name in archive.namelist()}
            if "word/footnotes.xml" not in names:
                return 0
            xml = archive.read("word/footnotes.xml").decode("utf-8", "ignore")
    except (zipfile.BadZipFile, OSError):
        return 0
    count = 0
    for match in re.finditer(r"<w:footnote\b[^>]*>", xml):
        tag = match.group(0)
        if 'w:type="separator"' in tag or 'w:type="continuationSeparator"' in tag or 'w:type="continuationNotice"' in tag:
            continue
        if 'w:id="-1"' in tag or 'w:id="0"' in tag:
            continue
        count += 1
    return count


# ---------------------------------------------------------------------------
# 第一阶段：parse
# ---------------------------------------------------------------------------


def parse_docx(source_path) -> ParseResult:
    """解析DOCX到内存；做任何写盘之前调用方都可以安全放弃结果。"""
    source = Path(source_path).resolve()
    if source.suffix.lower() != ".docx":
        raise SourceFailure("只接受.docx文件；不接受可能包含宏的.docm文件。")
    if not source.is_file():
        raise SourceFailure(f"找不到Word文件：{source}")
    size = source.stat().st_size
    if size > 100 * 1024 * 1024:
        raise SourceFailure("Word文件超过100MB，为避免耗尽内存已停止导入。")
    try:
        with zipfile.ZipFile(source) as archive:
            names = {name.casefold() for name in archive.namelist()}
            if any(name.endswith("vbaproject.bin") for name in names):
                raise SourceFailure("文档包含VBA宏项目，已拒绝导入。请另存为不含宏的.docx。")
    except zipfile.BadZipFile as error:
        raise SourceFailure("文件不是有效的DOCX压缩包。") from error
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    document = Document(source)
    converted = convert_document(document)
    footnotes = footnote_count(source)
    warnings = list(converted.warnings)
    if footnotes:
        warnings.append(
            ImportWarning(
                "footnote-unsupported",
                f"检测到{footnotes}个脚注；暂不支持转换，导入后脚注内容将丢失。",
            )
        )
    return ParseResult(
        source=SourceInfo(filename=source.name, size=size, sha256=digest),
        body_markdown=converted.body,
        description=converted.description,
        word_title=converted.word_title,
        blocks=converted.blocks,
        images=converted.images,
        warnings=warnings,
        paragraph_count=converted.paragraph_count,
        heading_count=converted.heading_count,
        word_count=converted.word_count,
        footnote_count=footnotes,
    )


# ---------------------------------------------------------------------------
# 第二阶段：plan
# ---------------------------------------------------------------------------


def parse_existing_markdown(path: Path) -> tuple[dict, str]:
    if not path.is_file():
        return {}, ""
    source = path.read_text(encoding="utf-8")
    if not source.startswith("---\n"):
        return {}, source
    _, raw, body = source.split("---", 2)
    return yaml.safe_load(raw) or {}, body.lstrip("\n")


def dump_front_matter(data: dict) -> str:
    return "---\n" + yaml.safe_dump(
        data,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
        width=1000,
    ) + "---\n\n"


def deterministic_article_id(source_sha256: str) -> str:
    """新文章缺省的articleId：由源文件哈希派生，保证同一输入的plan输出稳定。"""
    return "article-" + hashlib.sha256(f"article:{source_sha256}".encode("utf-8")).hexdigest()[:16]


def deterministic_paragraph_id(article_id: str, source_sha256: str, index: int) -> str:
    return "p-" + hashlib.sha256(
        f"paragraph:{article_id}:{source_sha256}:{index}".encode("utf-8")
    ).hexdigest()[:12]


def stabilize_ids(body: str, existing_body: str, article_id: str, source_sha256: str) -> str:
    """把assign_ids为新建段落生成的随机ID替换为确定ID（旧稿保留的ID不动）。

    assign_ids负责身份保留与匹配，这里只重写“本次新建”的锚点，使同一输入
    两次plan得到完全一致的JSON；随机性不进入plan.json。
    """
    old_ids = (
        {record.paragraph_id for record in records_from_markdown(existing_body)} if existing_body.strip() else set()
    )
    used = set(old_ids)
    created = 0
    lines: list[str] = []
    for line in body.splitlines():
        matched = MARKER.fullmatch(line.strip())
        if matched and matched.group(1) not in old_ids:
            candidate = ""
            while not candidate or candidate in used:
                candidate = deterministic_paragraph_id(article_id, source_sha256, created)
                created += 1
            used.add(candidate)
            line = f"<!-- paragraph-id:{candidate} -->"
        lines.append(line)
    result = "\n".join(lines)
    if body.endswith("\n"):
        result += "\n"
    return result


def target_relpath(options: ImportOptions, slug: str) -> PurePosixPath:
    """目标bundle的项目相对路径；slug均已校验，不可能越出content。"""
    if options.section == "works":
        collection_slug = validate_slug(options.collection_slug, "文集slug")
        return PurePosixPath("content") / "works" / collection_slug / slug
    if options.section not in ("essays", "archives"):
        raise ValidationFailure(f"未知栏目：{options.section}（可选works/essays/archives）。")
    return PurePosixPath("content") / options.section / slug


def detect_conflicts(
    project_root: Path,
    slug: str,
    explicit_article_id: str,
    target_abs: Path,
    target_rel: PurePosixPath,
) -> list[Conflict]:
    conflicts: list[Conflict] = []
    if target_abs.exists():
        conflicts.append(
            Conflict(
                "target-exists",
                f"目标已存在：{target_rel.as_posix()}。请更换slug，或明确使用--force覆盖。",
                target_rel.as_posix(),
            )
        )
    content = project_root / "content"
    if not content.is_dir():
        return conflicts
    for index in sorted(content.rglob("index.md")):
        if index.parent == target_abs:
            continue
        data, _ = parse_existing_markdown(index)
        relative = index.relative_to(project_root).as_posix()
        if isinstance(data, dict) and data.get("slug") == slug:
            conflicts.append(Conflict("slug-duplicate", f"slug“{slug}”已被{relative}使用。", relative))
        if explicit_article_id and isinstance(data, dict) and data.get("articleId") == explicit_article_id:
            conflicts.append(
                Conflict("article-id-duplicate", f"articleId“{explicit_article_id}”已被{relative}使用。", relative)
            )
    return conflicts


def build_assets(images: list[CollectedImage], target_rel: PurePosixPath) -> list[Asset]:
    """落盘清单：每张图片的原图 + （成功时）WebP，目标为项目相对路径。"""
    assets: list[Asset] = []
    base = target_rel.as_posix()
    for image in images:
        source_name = image.part_name or image.original_name
        assets.append(
            Asset(
                source_name=source_name,
                target_name=f"{base}/images/original/{image.original_name}",
                media_type=image.media_type,
                size=len(image.original_bytes),
            )
        )
        if image.webp_bytes is not None:
            assets.append(
                Asset(
                    source_name=source_name,
                    target_name=f"{base}/images/{image.stem}.webp",
                    media_type="image/webp",
                    size=len(image.webp_bytes),
                )
            )
    return assets


_ASSISTANT = None


def _load_assistant():
    """动态加载docx-assistant.py（文件名带连字符，不能直接import）。"""
    global _ASSISTANT
    if _ASSISTANT is None:
        path = _HERE / "docx-assistant.py"
        spec = importlib_util.spec_from_file_location("docx_assistant", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("无法载入docx-assistant。")
        module = importlib_util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        _ASSISTANT = module
    return _ASSISTANT


def suggest(source_name: str, project_root: Path) -> dict:
    """按文件名推断标题/slug/栏目/文集的建议；推断失败时返回空dict。"""
    try:
        assistant = _load_assistant()
        result = assistant.infer(Path(source_name), Path(project_root).resolve())
    except Exception:
        return {}
    return {
        "title": str(result.get("title", "")),
        "slug": str(result.get("slug", "")),
        "section": str(result.get("section", "")),
        "collection": str(result.get("collection", "")),
        "collection_slug": str(result.get("collection_slug", "")),
        "url": str(result.get("url", "")),
    }


def assistant_slugify(value: str) -> str:
    try:
        return str(_load_assistant().slugify(value))
    except Exception:
        return ""


def plan_import(parsed: ParseResult, options: ImportOptions, project_root) -> ImportPlan:
    """由解析结果与选项计算完整导入计划；只读现有content，不写盘。"""
    project_root = Path(project_root).resolve()
    slug = validate_slug(options.slug, "文章slug")
    title = options.title.strip()
    if not title:
        raise ValidationFailure("文章标题不能为空。")
    collections = list(options.collections)
    if options.section == "works" and not collections:
        raise ValidationFailure("文集文章必须填写所属文集。")
    target_rel = target_relpath(options, slug)
    target_abs = project_root / Path(str(target_rel))
    if not parsed.body_markdown.strip():
        raise ValidationFailure("Word文档没有可发布的正文。")

    existing_data, existing_body = parse_existing_markdown(target_abs / "index.md")
    warnings = list(parsed.warnings)
    if parsed.word_title and parsed.word_title != title:
        warnings.append(
            ImportWarning(
                "word-title",
                f"Word标题“{parsed.word_title}”与导入标题不同；已采用导入时填写的标题“{title}”。",
            )
        )
    body, paragraph_report = assign_ids(parsed.body_markdown, existing_body)
    if paragraph_report.ambiguous:
        warnings.append(
            ImportWarning(
                "paragraph-match-review",
                f"有{len(paragraph_report.ambiguous)}段无法高置信匹配旧锚点，已生成新ID；请在发布前人工检查。",
            )
        )
    if paragraph_report.deleted:
        warnings.append(
            ImportWarning(
                "paragraphs-removed",
                f"旧稿有{len(paragraph_report.deleted)}个段落已删除；其历史段评将保留并标记为孤立。",
            )
        )
    article_id = options.article_id or str(existing_data.get("articleId") or "") or deterministic_article_id(
        parsed.source.sha256
    )
    body = stabilize_ids(body, existing_body, article_id, parsed.source.sha256)

    series = list(options.series) or list(collections)
    today = options.date or dt.date.today().isoformat()
    front_matter = {
        "title": title,
        "subtitle": options.subtitle.strip(),
        "date": today,
        "lastmod": today,
        "slug": slug,
        "description": options.description.strip() or parsed.description,
        "draft": bool(options.draft),
        "featured": False,
        "weight": options.weight,
        "collections": collections,
        "categories": list(options.categories),
        "tags": list(options.tags),
        "series": series,
        "period": list(options.period),
        "people": list(options.people),
        "places": list(options.places),
        "aliases": [],
        "articleId": article_id,
        "comments": existing_data.get("comments") or {"paragraph": True},
    }
    front_matter["articleRevision"] = revision_for(article_id, body)

    conflicts = detect_conflicts(project_root, slug, options.article_id, target_abs, target_rel)
    suggested = suggest(parsed.source.filename, project_root)
    suggested["word_title"] = parsed.word_title
    stats = {
        "wordCount": parsed.word_count,
        "paragraphCount": parsed.paragraph_count,
        "headingCount": parsed.heading_count,
        "imageCount": len(parsed.images),
        "footnoteCount": parsed.footnote_count,
    }
    assets = build_assets(parsed.images, target_rel)
    proposed_files = [f"{target_rel.as_posix()}/index.md"] + [asset.target_name for asset in assets]
    if options.section == "works" and not (target_abs.parent / "_index.md").exists():
        proposed_files.append(f"{target_rel.parent.as_posix()}/_index.md")
    return ImportPlan(
        source=parsed.source,
        options=ImportOptions(
            title=title,
            slug=slug,
            section=options.section,
            subtitle=options.subtitle.strip(),
            collections=collections,
            collection_slug=options.collection_slug,
            categories=list(options.categories),
            tags=list(options.tags),
            series=series,
            period=list(options.period),
            people=list(options.people),
            places=list(options.places),
            description=options.description.strip(),
            date=today,
            weight=options.weight,
            draft=bool(options.draft),
            article_id=article_id,
        ),
        suggested=suggested,
        target=target_rel.as_posix(),
        front_matter=front_matter,
        markdown=body,
        stats=stats,
        assets=assets,
        warnings=warnings,
        conflicts=conflicts,
        proposed_files=proposed_files,
    )


# ---------------------------------------------------------------------------
# 第三阶段：commit
# ---------------------------------------------------------------------------


def resolve_source(plan: ImportPlan, source) -> ParseResult:
    """取得与计划一致的解析结果：复用内存ParseResult或按sha256校验后重新解析。"""
    if isinstance(source, ParseResult):
        if source.source.sha256 != plan.source.sha256:
            raise ValidationFailure("解析结果与计划不一致（sha256不匹配），请用同一份Word文件。")
        return source
    path = Path(source)
    if not path.is_file():
        raise SourceFailure(f"找不到Word文件：{path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != plan.source.sha256:
        raise ValidationFailure("源文件与计划不一致（sha256不匹配），请确认--source是生成计划时的同一份文件。")
    return parse_docx(path)


def verify_bundle(bundle: Path, plan: ImportPlan) -> None:
    """提交前校验：index.md可读且Front Matter可解析、图片齐全且字节数与清单一致。"""
    index = bundle / "index.md"
    if not index.is_file():
        raise WriteFailure("临时目录中缺少index.md。")
    try:
        data, _ = parse_existing_markdown(index)
    except Exception as error:
        raise WriteFailure(f"生成的index.md无法解析：{error}") from error
    if not isinstance(data, dict) or not data.get("title"):
        raise WriteFailure("生成的index.md缺少有效的Front Matter。")
    base = PurePosixPath(plan.target)
    for asset in plan.assets:
        try:
            inside = PurePosixPath(asset.target_name).relative_to(base)
        except ValueError as error:
            raise WriteFailure(f"资源路径超出目标目录：{asset.target_name}") from error
        path = bundle / Path(str(inside))
        if not path.is_file():
            raise WriteFailure(f"缺少图片文件：{asset.target_name}")
        if path.stat().st_size != asset.size:
            raise WriteFailure(f"图片大小与计划清单不一致：{asset.target_name}")


def commit_import(plan, source, project_root, force: bool = False, backup_dir=None) -> CommitResult:
    """执行半原子写入：临时目录写全部产物→校验→原子替换；失败不留半成品。"""
    project_root = Path(project_root).resolve()
    if isinstance(plan, dict):
        plan = ImportPlan.from_json_dict(plan)
    parsed = resolve_source(plan, source)
    if plan.conflicts and not force:
        raise ConflictFailure("；".join(conflict.message for conflict in plan.conflicts))
    options = plan.options
    slug = str(plan.front_matter.get("slug") or options.slug)
    target = (project_root / Path(plan.target)).resolve()
    content_root = (project_root / "content").resolve()
    if content_root not in target.parents:
        raise ValidationFailure("目标目录超出content范围。")
    if target.exists() and backup_dir is None:
        raise ValidationFailure("覆盖已有文章需要指定备份目录。")

    target_existed = target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{slug}.import-", dir=target.parent))
    rollback: Path | None = None
    saved_backup: Path | None = None
    collection_index: Path | None = None
    collection_index_created = False
    try:
        markdown = dump_front_matter(plan.front_matter) + plan.markdown
        (temporary / "index.md").write_text(markdown, encoding="utf-8")
        write_images(parsed.images, temporary)
        verify_bundle(temporary, plan)
        if options.section == "works":
            collection_index = target.parent / "_index.md"
            if not collection_index.exists():
                collection_name = options.collections[0] if options.collections else ""
                collection_data = {
                    "title": collection_name,
                    "description": "",
                    "status": "连载中",
                }
                collection_index.write_text(
                    "---\n"
                    + yaml.safe_dump(collection_data, allow_unicode=True, sort_keys=False)
                    + "---\n",
                    encoding="utf-8",
                )
                collection_index_created = True
        if target.exists():
            backup_root = Path(backup_dir).expanduser().resolve()
            if backup_root == content_root or content_root in backup_root.parents:
                raise ValidationFailure("导入备份目录不能位于Hugo公开content目录内。")
            backup_root.mkdir(parents=True, exist_ok=True)
            stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            saved_backup = backup_root / f"{options.section}-{slug}_{stamp}"
            suffix = 1
            while saved_backup.exists():
                saved_backup = backup_root / f"{options.section}-{slug}_{stamp}_{suffix}"
                suffix += 1
            shutil.copytree(target, saved_backup)
            rollback = target.with_name(f".{target.name}.before-import")
            if rollback.exists():
                shutil.rmtree(rollback)
            os_replace(target, rollback)
        os_replace(temporary, target)
        if rollback and rollback.exists():
            shutil.rmtree(rollback)
        return CommitResult(
            output=str(target),
            markdown=str(target / "index.md"),
            title=str(plan.front_matter.get("title", "")),
            slug=slug,
            section=options.section,
            word_count=int(plan.stats.get("wordCount", 0)),
            image_count=len(parsed.images),
            backup=str(saved_backup) if saved_backup else "",
            warnings=plan.warnings,
        )
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        if rollback and rollback.exists() and not target.exists():
            os_replace(rollback, target)
        if not target_existed and target.exists():
            shutil.rmtree(target)
        if collection_index_created and collection_index and collection_index.exists():
            collection_index.unlink()
        raise


def os_replace(source: Path, target: Path) -> None:
    """os.replace的薄封装，便于测试模拟提交中途失败。"""
    os.replace(source, target)
