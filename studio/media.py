"""作者工作台媒体库：扫描 content/ 内图片、上传（校验/校正/缩放/留原图）、回收站删除。

约定与安全边界（与 docs/图片处理.md 及导入器一致）：
- 图片与文章 bundle 同目录，正文用 ``![alt](image-NN.jpg)`` 普通引用；
  处理前原始字节保留在 bundle 的 ``images/original/`` 下；
- 上传：路径走 articles.resolve_article_path 校验；≤20MB；Pillow 验证是
  真图片（伪装扩展名拒绝）；格式限 JPEG/PNG/WEBP/GIF；EXIF 方向校正并去
  EXIF；最长边 >2400 缩到 2400（LANCZOS）；原图 >5MB 只警告不拒绝；
  GIF 原样复制不处理；文件名自动取 ``image-NN.<ext>``（bundle 内现有
  image-* 最大序号 +1，两位起步），永不覆盖既有文件；
- 删除：只允许 content/ 内图片；仍被同 bundle index.md 引用的拒绝；
  删除是移动到 ``.cache/studio/trash/<时间戳>/``，不是真删。
"""

from __future__ import annotations

import datetime as dt
import io
import re
import shutil
from pathlib import Path, PurePosixPath

from PIL import Image, ImageOps

from studio import articles

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
IMAGE_MEDIA_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
}
COVER_NAMES = {"cover.jpg", "cover.jpeg", "cover.png", "cover.webp"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
WARN_ORIGINAL_BYTES = 5 * 1024 * 1024
MAX_SIDE = 2400
IMAGE_NAME = re.compile(r"^image-(\d+)$")
ALT_SAFE = re.compile(r"[0-9A-Za-z_一-鿿-]+")


# ---------------------------------------------------------------------------
# 路径与 bundle
# ---------------------------------------------------------------------------


def resolve_image_path(project_root, rel_path) -> tuple[Path, str]:
    """校验 content/ 内图片路径，返回 (绝对路径, posix 相对路径)。"""
    project_root = Path(project_root).resolve()
    text = str(rel_path or "").strip()
    if not text:
        raise articles.ArticleFailure("bad-request", "缺少图片路径。")
    if text.startswith("/") or "\\" in text or re.match(r"^[A-Za-z]:", text):
        raise articles.ArticleFailure("validation-failed", "图片路径必须是项目内的相对路径。")
    pure = PurePosixPath(text)
    if any(part in ("..", "", ".") for part in pure.parts):
        raise articles.ArticleFailure("validation-failed", "图片路径含有非法片段。")
    if pure.suffix.lower() not in IMAGE_SUFFIXES:
        raise articles.ArticleFailure("validation-failed", "只允许 JPG/PNG/WEBP/GIF 图片。")
    resolved = (project_root / pure).resolve()
    content_root = (project_root / "content").resolve()
    if content_root not in resolved.parents:
        raise articles.ArticleFailure("validation-failed", "图片路径越出了 content/ 范围。")
    return resolved, pure.as_posix()


def _bundle_of(project_root: Path, file: Path) -> Path | None:
    """向上找含 index.md 的目录（即所属文章 bundle），找不到返回 None。"""
    content_root = project_root / "content"
    current = file.parent
    while current != content_root and content_root in current.parents:
        if (current / "index.md").is_file():
            return current
        current = current.parent
    return None


def _article_title(index_path: Path) -> str:
    try:
        data, _ = articles.split_source(index_path.read_text(encoding="utf-8"))
    except Exception:
        return ""
    return str(data.get("title") or "")


# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------


def scan_media(project_root) -> list[dict]:
    """遍历 content/**/ 的图片，附尺寸、所属文章与封面/原图标记。只读。"""
    project_root = Path(project_root).resolve()
    content_root = project_root / "content"
    result: list[dict] = []
    if not content_root.is_dir():
        return result
    title_cache: dict[Path, str] = {}
    for file in sorted(content_root.rglob("*")):
        if not file.is_file() or file.is_symlink():
            continue
        if file.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        rel = file.relative_to(project_root).as_posix()
        parts = PurePosixPath(rel).parts
        is_original = "original" in parts
        try:
            size = file.stat().st_size
        except OSError:
            continue
        width = height = None
        try:
            with Image.open(file) as opened:
                width, height = opened.size
        except Exception:
            pass  # 读不出尺寸不拖垮列表
        bundle = _bundle_of(project_root, file)
        article_path = ""
        article_title = ""
        if bundle is not None:
            index_path = bundle / "index.md"
            article_path = index_path.relative_to(project_root).as_posix()
            if index_path not in title_cache:
                title_cache[index_path] = _article_title(index_path)
            article_title = title_cache[index_path]
        result.append(
            {
                "name": file.name,
                "relPath": rel,
                "articlePath": article_path,
                "articleTitle": article_title,
                "size": size,
                "width": width,
                "height": height,
                "isCover": file.name.lower() in COVER_NAMES and not is_original,
                "isOriginal": is_original,
            }
        )
    return result


# ---------------------------------------------------------------------------
# 上传
# ---------------------------------------------------------------------------


def _next_image_name(bundle: Path, suffix: str) -> str:
    """取 bundle（含 images/ 子目录）内 image-* 最大序号 +1，两位起步。"""
    highest = 0
    candidates = list(bundle.glob("image-*.*"))
    images_dir = bundle / "images"
    if images_dir.is_dir():
        candidates += list(images_dir.glob("image-*.*"))
        original_dir = images_dir / "original"
        if original_dir.is_dir():
            candidates += list(original_dir.glob("image-*.*"))
    for candidate in candidates:
        matched = IMAGE_NAME.match(candidate.stem)
        if matched:
            highest = max(highest, int(matched.group(1)))
    return f"image-{highest + 1:02d}{suffix}"


def _default_alt(filename: str) -> str:
    stem = PurePosixPath(str(filename).split("/")[-1]).stem
    cleaned = " ".join(ALT_SAFE.findall(stem)).strip()
    return cleaned or "插图"


def upload_image(project_root, article_rel_path, filename, data: bytes) -> dict:
    """校验并写入 bundle 根目录 + images/original/ 原图副本，返回 Markdown 引用。"""
    project_root = Path(project_root).resolve()
    target = articles.resolve_article_path(project_root, article_rel_path)
    if not target.is_file():
        raise articles.ArticleFailure("not-found", "找不到这篇文章。")
    bundle = target.parent
    filename = str(filename or "")
    suffix = PurePosixPath(filename.split("/")[-1]).suffix.lower()
    if suffix not in IMAGE_SUFFIXES:
        raise articles.ArticleFailure("validation-failed", "只支持 JPG/PNG/WEBP/GIF 图片。")
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise articles.ArticleFailure("validation-failed", "图片内容为空。")
    data = bytes(data)
    if len(data) > MAX_UPLOAD_BYTES:
        raise articles.ArticleFailure("payload-too-large", "图片超过 20MB，已拒绝。")
    try:
        probe = Image.open(io.BytesIO(data))
        probe.verify()  # 拒绝伪装扩展名的非图片文件
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as error:
        raise articles.ArticleFailure("validation-failed", "文件不是有效的图片。") from error
    real_format = (image.format or "").upper()
    if real_format not in {"JPEG", "PNG", "WEBP", "GIF"}:
        raise articles.ArticleFailure("validation-failed", f"不支持的图片格式：{real_format or '未知'}。")

    warnings: list[str] = []
    if len(data) > WARN_ORIGINAL_BYTES:
        warnings.append("原图超过 5MB，建议先在系统相册/预览里压缩后再上传。")

    # 扩展名以真实格式为准（例如把 PNG 改名 .jpg 时落盘为 .png）
    ext = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif"}[real_format]
    if real_format == "GIF":
        payload = data  # GIF 原样复制，不动帧
        width, height = image.size
    else:
        image = ImageOps.exif_transpose(image)  # 校正方向并去除 EXIF
        if max(image.size) > MAX_SIDE:
            image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        if real_format == "JPEG" and image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        buffer = io.BytesIO()
        if real_format == "JPEG":
            image.save(buffer, "JPEG", quality=90)
        elif real_format == "PNG":
            image.save(buffer, "PNG", optimize=True)
        else:
            image.save(buffer, "WEBP", quality=90)
        payload = buffer.getvalue()
        width, height = image.size

    name = _next_image_name(bundle, ext)
    dest = bundle / name
    if dest.exists():  # 序号保证不覆盖，这里兜底
        raise articles.ArticleFailure("conflict", f"目标图片已存在：{name}")
    original_dir = bundle / "images" / "original"
    original_dir.mkdir(parents=True, exist_ok=True)
    original_dest = original_dir / name
    dest.write_bytes(payload)
    original_dest.write_bytes(data)

    rel = dest.relative_to(project_root).as_posix()
    return {
        "image": {
            "name": name,
            "relPath": rel,
            "size": len(payload),
            "width": width,
            "height": height,
        },
        "markdown": f"![{_default_alt(filename)}]({name})",
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# 删除（回收站）
# ---------------------------------------------------------------------------


def delete_image(project_root, rel_path) -> dict:
    """未被 index.md 引用才允许删除；移动到 .cache/studio/trash/<时间戳>/。"""
    project_root = Path(project_root).resolve()
    resolved, rel = resolve_image_path(project_root, rel_path)
    if not resolved.is_file():
        raise articles.ArticleFailure("not-found", "找不到这张图片。")
    bundle = _bundle_of(project_root, resolved)
    if bundle is not None:
        index_path = bundle / "index.md"
        reference = resolved.relative_to(bundle).as_posix()
        try:
            source = index_path.read_text(encoding="utf-8")
        except OSError:
            source = ""
        if reference in source:
            raise articles.ArticleFailure(
                "conflict",
                f"图片仍被 {index_path.relative_to(project_root).as_posix()} 引用（{reference}），"
                "请先在正文中移除引用后再删除。",
            )
    stamp = dt.datetime.now().strftime("%Y%m%d%H%M%S")
    trash_dir = project_root / ".cache" / "studio" / "trash" / stamp
    counter = 1
    while trash_dir.exists():
        trash_dir = project_root / ".cache" / "studio" / "trash" / f"{stamp}-{counter}"
        counter += 1
    dest = trash_dir / rel
    dest.parent.mkdir(parents=True, exist_ok=False)
    shutil.move(str(resolved), str(dest))
    return {
        "deleted": rel,
        "trashPath": dest.relative_to(project_root).as_posix(),
    }
