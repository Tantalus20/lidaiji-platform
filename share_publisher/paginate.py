"""QQ 长文图片卡语义分页器（V0.2）。

- 输入：与编辑器同方言的 Markdown（短代码 align/poetry/endnote、
  heading/paragraph/blockquote/list/code/image）；
- 按语义块分页：整块优先放入当前页，放不下则整块移入下一页；
- 超长段落：用浏览器真实排版测量 + 句级切点二分查找拆分（不按固定字数）；
- 标题孤行保护：标题后必须能容纳至少一行正文，否则标题随正文移页；
- 诗歌/附记/引用/图片尽量保持整体（不跨页拆分语义）；
- 块级图片等比缩放，放不下随页移动。

measure 是注入的测量函数（Playwright 真实渲染；测试可注入固定高度）。
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from typing import Callable

# ---------------------------------------------------------------- 块模型

@dataclass
class Block:
    type: str
    level: int = 0  # heading 1-6
    align: str | None = None  # left/center/right（align 短代码）
    lines: list[str] = field(default_factory=list)  # 原文本行
    alt: str = ""
    src: str = ""
    caption: str = ""
    kind: str = ""  # 列表样式：bullet/ordered


_HEADING = re.compile(r"^(#{1,6})\s+(.+)$")
_UL = re.compile(r"^[-*]\s+(.+)$")
_OL = re.compile(r"^\d+[.)]\s+(.+)$")
_IMAGE = re.compile(r"^!\[([^\]]*)\]\(([^)\s]+)\)\s*(.*)$")
_ALIGN_OPEN = re.compile(r"^\{\{<\s*align\s+(left|center|right)\s*>\}\}$")
_POETRY_OPEN = re.compile(r"^\{\{<\s*poetry\s*>\}\}$")
_ENDNOTE_OPEN = re.compile(r"^\{\{<\s*endnote\s*>\}\}$")
_CLOSE = re.compile(r"^\{\{<\s*/\s*(align|poetry|endnote)\s*>\}\}$")
_ANCHOR = re.compile(r"^<!--\s*paragraph-id:[\w-]+\s*-->$")


def split_blocks(markdown_body: str) -> list[str]:
    return [item.strip() for item in re.split(r"\n{2,}", markdown_body.strip()) if item.strip()]


def parse_blocks(markdown_body: str) -> list[Block]:
    """把 Markdown 解析为块序列（与编辑器 JSON 块模型同方言）。"""
    blocks: list[Block] = []
    raw_blocks = split_blocks(markdown_body)
    i = 0
    while i < len(raw_blocks):
        stripped = raw_blocks[i].strip()
        if _ANCHOR.match(stripped):
            i += 1
            continue
        # 短代码容器（同一 raw block 内按行解析，允许块内多行）
        first_line = stripped.splitlines()[0] if stripped else ""
        container = None
        for pattern, ctype in ((_ALIGN_OPEN, "align"), (_POETRY_OPEN, "poetry"), (_ENDNOTE_OPEN, "endnote")):
            m = pattern.match(first_line)
            if m:
                container = (ctype, m.group(1) if ctype == "align" else None)
                break
        if container:
            ctype, align = container
            lines = stripped.splitlines()[1:]
            inner_lines: list[str] = []
            for line in lines:
                if _CLOSE.match(line.strip()):
                    break
                inner_lines.append(line)
            if ctype == "align":
                inner_blocks = parse_blocks("\n\n".join(inner_lines)) if inner_lines else []
                blocks.append(Block(type=ctype, align=align, lines=[b for b in inner_blocks]))
            else:
                blocks.append(Block(type=ctype, align=align, lines=[ln for ln in inner_lines if ln.strip()]))
            i += 1
            continue
        if stripped.startswith(">"):
            lines = [ln.lstrip(">").strip() for ln in stripped.splitlines() if ln.strip().lstrip(">").strip()]
            blocks.append(Block(type="blockquote", lines=lines))
            i += 1
            continue
        if stripped.startswith("```"):
            lines = stripped.splitlines()[1:]
            if lines and lines[-1].strip().startswith("```"):
                lines = lines[:-1]
            blocks.append(Block(type="code_block", lines=lines))
            i += 1
            continue
        m = _HEADING.match(stripped)
        if m:
            blocks.append(Block(type="heading", level=len(m.group(1)), lines=[m.group(2)]))
            i += 1
            continue
        m = _IMAGE.match(stripped)
        if m:
            blocks.append(Block(type="image", alt=m.group(1), src=m.group(2), caption=m.group(3)))
            i += 1
            continue
        first_line = stripped.splitlines()[0]
        um0 = _UL.match(first_line)
        om0 = _OL.match(first_line)
        if um0 or om0:
            ordered = om0 is not None
            items = []
            for line in stripped.splitlines():
                um = _UL.match(line)
                om = _OL.match(line)
                if um and not ordered:
                    items.append(um.group(1))
                elif om and ordered:
                    items.append(om.group(1))
                else:
                    break
            blocks.append(Block(
                type="ordered_list" if ordered else "bullet_list",
                lines=items,
                kind="ordered" if ordered else "bullet",
            ))
            i += 1
            continue
        blocks.append(Block(type="paragraph", lines=[stripped]))
        i += 1
    return blocks


# ---------------------------------------------------------------- HTML 渲染

_INLINE_BOLD = re.compile(r"\*\*(.+?)\*\*")
_INLINE_EM = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")


def inline_html(text: str) -> str:
    text = html.escape(text, quote=False)
    text = _LINK.sub(r"<a>\1</a>", text)
    text = _INLINE_BOLD.sub(r"<strong>\1</strong>", text)
    text = _INLINE_EM.sub(r"<em>\1</em>", text)
    return text


def _paragraph_html(text: str, indent: bool = True) -> str:
    return f"<p>{inline_html(text)}</p>"


def block_html(block: Block) -> str:
    """块 → HTML（测量与最终渲染共用，保证一致）。"""
    t = block.type
    if t == "heading":
        level = min(block.level, 3)
        return f"<h{level}>{inline_html(' '.join(block.lines))}</h{level}>"
    if t == "paragraph":
        return _paragraph_html(" ".join(block.lines))
    if t == "blockquote":
        inner = "".join(_paragraph_html(line, indent=False) for line in block.lines)
        return f"<blockquote>{inner}</blockquote>"
    if t in ("bullet_list", "ordered_list"):
        tag = "ul" if t == "bullet_list" else "ol"
        items = "".join(f"<li>{inline_html(line)}</li>" for line in block.lines)
        return f"<{tag}>{items}</{tag}>"
    if t == "code_block":
        return f"<pre>{html.escape(chr(10).join(block.lines))}</pre>"
    if t == "image":
        fig = f'<figure class="article-figure"><img src="{html.escape(block.src, quote=True)}" alt="{html.escape(block.alt)}">'
        if block.caption:
            fig += f"<figcaption>{inline_html(block.caption)}</figcaption>"
        return fig + "</figure>"
    if t == "align":
        inner = "".join(block_html(b) for b in block.lines)
        return f'<div class="text-align-{block.align}">{inner}</div>'
    if t == "poetry":
        lines = "".join(f"<p>{inline_html(line)}</p>" for line in block.lines)
        return f'<div class="poetry-block">{lines}</div>'
    if t == "endnote":
        lines = "".join(f"<p>{inline_html(line)}</p>" for line in block.lines)
        return f'<div class="end-note">{lines}</div>'
    return _paragraph_html(" ".join(block.lines))


def blocks_html(blocks: list[Block]) -> str:
    return "".join(block_html(b) for b in blocks)


# ---------------------------------------------------------------- 分页算法

_SENTENCE_END = re.compile(r"[。！？；!?;]")


def _sentence_candidates(text: str) -> list[int]:
    """句级切点（切点保留结尾标点）。"""
    ends = [m.end() for m in _SENTENCE_END.finditer(text)]
    return ends or [len(text)]


class Paginator:
    """按块累积 + 测量高度分页。

    measure(html: str) -> float 返回渲染高度（px）；content_height 为页内容高度。
    """

    def __init__(self, measure: Callable[[str], float], content_height: float, block_gap: float):
        self.measure = measure
        self.content_height = content_height
        self.gap = block_gap

    def _block_height(self, block: Block) -> float:
        return self.measure(block_html(block))

    def paginate(self, blocks: list[Block], title_html: str = "") -> list[list[Block]]:
        pages: list[list[Block]] = []
        current: list[Block] = []
        current_height = 0.0
        if title_html:
            current_height = self.measure(title_html) + self.gap

        def flush():
            nonlocal current, current_height
            if current:
                pages.append(current)
                current = []
                current_height = 0.0

        def fits(extra: float) -> bool:
            return current_height + extra <= self.content_height

        index = 0
        while index < len(blocks):
            block = blocks[index]
            bh = self._block_height(block)

            # 标题孤行保护：标题后正文放不进剩余空间时，标题随正文移页
            if block.type == "heading" and current:
                next_bh = self._block_height(blocks[index + 1]) if index + 1 < len(blocks) else 0.0
                if next_bh > 0 and not fits(bh + self.gap + next_bh):
                    flush()
                    current.append(block)
                    current_height = bh + self.gap
                    index += 1
                    continue

            if fits(bh + self.gap):
                current.append(block)
                current_height += bh + self.gap
                index += 1
                continue

            # 空页放不下 → 超长块拆分（仅普通段落；语义整体块整块占页）
            if not current:
                pieces = self._split_oversized(block)
                for piece in pieces:
                    ph = self._block_height(piece)
                    if current and not fits(ph + self.gap):
                        flush()
                    current.append(piece)
                    current_height += ph + self.gap
                index += 1
                continue

            flush()
            current.append(block)
            current_height = bh + self.gap
            index += 1
        flush()
        return pages

    def _split_oversized(self, block: Block) -> list[Block]:
        """超长普通段落：句级切点 + 二分查找最大可容纳范围。

        语义整体块（诗歌/附记/引用/列表/代码/图片/对齐）不拆分，
        整块占一页（浏览器内自然截断，V0.2 不实现块内禁则）。
        """
        if block.type != "paragraph":
            return [block]
        text = " ".join(block.lines)
        pieces: list[Block] = []
        remaining = text
        limit = max(self.content_height - self.gap, 1)
        while remaining:
            candidates = _sentence_candidates(remaining)
            lo, hi = 0, len(candidates)
            best = 0
            while lo < hi:
                mid = (lo + hi) // 2
                head, _ = self._split_at(remaining, candidates[mid])
                probe = Block(type="paragraph", lines=[head])
                if self._block_height(probe) <= limit:
                    best = mid
                    lo = mid + 1
                else:
                    hi = mid
            cut = candidates[best]
            if cut <= 0:
                cut = min(len(remaining), max(1, len(remaining) // 2))
            head, remaining = self._split_at(remaining, cut)
            if not head:
                break
            pieces.append(Block(type="paragraph", lines=[head]))
        return pieces

    @staticmethod
    def _split_at(text: str, cut: int) -> tuple[str, str]:
        return text[:cut].rstrip(), text[cut:].lstrip()


def paginate_blocks(blocks: list[Block], measure: Callable[[str], float],
                    content_height: float, block_gap: float) -> list[list[Block]]:
    """顶层入口：返回页列表（每页为块列表）。"""
    return Paginator(measure, content_height, block_gap).paginate(blocks)
