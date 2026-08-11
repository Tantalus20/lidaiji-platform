"""V0.3 长图合成器：把已完成布局的 1080×1440 PageCard 纵向合成为 PublishImage。

原则：
- 长图合成发生在分页器**之后**，绝不重新分页正文（诗歌/标题/段落/附记布局不变）；
- 直接拼接已渲染 PNG（无缩放、无插值、无裁剪），页间可加少量视觉分隔（可关闭）；
- 分组规划确定性：同输入同输出；顺序保持；不重复不遗漏；
- 约束参数化（高度/字节上限），不写死未经真实 QQ 验证的常量；
- 超约束返回 LONG_IMAGE_TOO_TALL / LONG_IMAGE_TOO_LARGE / CANNOT_FIT_SINGLE_POST，
  绝不静默生成异常巨图。
"""

from __future__ import annotations

import hashlib
import io
import os
from dataclasses import dataclass
from pathlib import Path

from share_publisher.cards import CARD_HEIGHT, CARD_WIDTH

MAX_IMAGES = 9  # QQ 单条硬上限（真机实测接口路径）

DEFAULT_MAX_PAGES = 3  # 默认每张最多 3 个阅读页（参数化，真机轮校准）
DEFAULT_MAX_BYTES = 4 * 1024 * 1024  # 默认单张体积上限（参数化）

SEPARATOR_PX = 0  # 默认页间分隔 0px（可配置）


class LongImageError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LongImageConstraints:
    max_images: int = MAX_IMAGES
    max_pages_per_image: int = DEFAULT_MAX_PAGES
    max_bytes: int = DEFAULT_MAX_BYTES
    separator_px: int = SEPARATOR_PX


def plan_long_images(page_count: int, constraints: LongImageConstraints | None = None) -> list[list[int]]:
    """分组规划：返回 [[page_index...], ...]，索引从 1 开始。

    - 顺序保持、不重复、不遗漏；
    - 目标：最终组数尽量 ≤ max_images；
    - 优先「均匀分组」：取能整除 page_count 且 ≤ max_images 张的最大每组页数
      （10→5×2、18→6×3、27→9×3）；
    - 无均匀解时退化为「均衡分布」：base+余数摊给前面的组（如 3,3,2,2）；
    - 高度约束不满足或即使最紧凑分组也超 9 张时抛 LongImageError。
    """
    constraints = constraints or LongImageConstraints()
    if page_count <= 0:
        raise LongImageError("invalid-page-count", "页数必须为正。")
    if page_count <= constraints.max_images:
        return [[i] for i in range(1, page_count + 1)]
    g_max = max(1, constraints.max_pages_per_image)
    if g_max * constraints.max_images < page_count:
        raise LongImageError(
            "CANNOT_FIT_SINGLE_POST",
            f"{page_count} 页即使每张 {g_max} 页也需 {(-(-page_count // g_max))} 张，"
            f"超过单条上限 {constraints.max_images}；请改用节选或增大每张页数上限。",
        )
    # 均匀分组：最大的 g ≤ g_max 且 page_count % g == 0 且组数 ≤ max_images
    for g in range(g_max, 0, -1):
        if page_count % g == 0 and page_count // g <= constraints.max_images:
            return [list(range(i * g + 1, (i + 1) * g + 1)) for i in range(page_count // g)]
    # 均衡分布：N 组，每组 base 或 base+1 页
    group_count = -(-page_count // g_max)
    base = page_count // group_count
    remainder = page_count % group_count
    groups: list[list[int]] = []
    cursor = 1
    for g in range(group_count):
        size = base + (1 if g < remainder else 0)
        groups.append(list(range(cursor, cursor + size)))
        cursor += size
    return groups


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def compose_long_images(
    card_paths: dict[int, Path],
    plan: list[list[int]],
    out_dir: Path,
    constraints: LongImageConstraints | None = None,
) -> list[dict]:
    """按规划合成长图（纯纵向拼接，不缩放）。返回每张的 {index,pages,width,height,bytes,sha256}。"""
    constraints = constraints or LongImageConstraints()
    from PIL import Image

    out_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    total_bytes = 0
    for group_index, pages in enumerate(plan, start=1):
        images = [Image.open(card_paths[p]) for p in pages]
        widths = {img.width for img in images}
        if len(widths) != 1:
            raise LongImageError("LONG_IMAGE_WIDTH_MISMATCH", "卡片宽度不一致，拒绝合成。")
        card_width = widths.pop()
        card_height = images[0].height
        heights = sum(img.height for img in images) + constraints.separator_px * (len(images) - 1)
        # 上限 = N 个阅读页高度 + 分隔线 + 截图取整容差（卡片实际 2880±1px）
        max_height = (
            constraints.max_pages_per_image * card_height
            + constraints.separator_px * max(0, constraints.max_pages_per_image - 1)
            + 4
        )
        if heights > max_height:
            raise LongImageError("LONG_IMAGE_TOO_TALL", f"第 {pages[0]}–{pages[-1]} 页合成高度 {heights} 超上限 {max_height}。")
        canvas = Image.new("RGB", (card_width, heights), "#f5f1e8")
        y = 0
        for img in images:
            canvas.paste(img, (0, y))
            y += img.height + constraints.separator_px
            img.close()
        buffer = io.BytesIO()
        canvas.save(buffer, format="PNG", optimize=False)
        canvas.close()
        payload = buffer.getvalue()
        if constraints.max_bytes and len(payload) > constraints.max_bytes:
            raise LongImageError(
                "LONG_IMAGE_TOO_LARGE",
                f"第 {pages[0]}–{pages[-1]} 页合成体积 {len(payload)} 字节超上限 {constraints.max_bytes}。",
            )
        total_bytes += len(payload)
        name = f"{group_index:02d}.png"
        (out_dir / name).write_bytes(payload)
        results.append({
            "index": group_index,
            "pages": pages,
            "width": card_width,
            "height": heights,
            "bytes": len(payload),
            "sha256": sha256_bytes(payload),
        })
    return results


def env_constraints() -> LongImageConstraints:
    def _int(name: str, default: int) -> int:
        try:
            return max(1, int(os.environ.get(name, str(default))))
        except ValueError:
            return default

    return LongImageConstraints(
        max_images=MAX_IMAGES,
        max_pages_per_image=_int("LONG_IMAGE_MAX_PAGES", DEFAULT_MAX_PAGES),
        max_bytes=_int("LONG_IMAGE_MAX_BYTES", DEFAULT_MAX_BYTES),
        separator_px=max(0, _int("LONG_IMAGE_SEPARATOR_PX", SEPARATOR_PX)),
    )
