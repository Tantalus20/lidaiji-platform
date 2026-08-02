"""极简 Markdown → HTML 近似渲染，仅供作者台预览使用。

只支持本站导入产物实际用到的语法：h1-h3、段落、引用、有序/无序列表、
表格、粗体/斜体、图片。渲染前对文本整体转义，绝不输出原始 HTML；
段落锚点注释 ``<!-- paragraph-id:... -->`` 不渲染。

每个块级元素带 ``data-block="N"``（从 1 开始的近似序号），供前端按
警告 location（“第N段”）做近似定位高亮——只是近似，不保证与 Word
段落严格一一对应。
"""

from __future__ import annotations

import html
import re

_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_BULLET = re.compile(r"^[-*]\s+(.*)$")
_NUMBERED = re.compile(r"^\d+\.\s+(.*)$")
_TABLE_SEP = re.compile(r"^\|?[\s:\-|]+\|?$")
_ANCHOR = re.compile(r"^<!--\s*paragraph-id:([\w-]+)\s*-->$")
_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
_BOLD = re.compile(r"\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*")
_ITALIC = re.compile(r"\*(.+?)\*")


def _inline(text: str, asset_map: dict[str, str]) -> str:
    """转义后处理粗体/斜体/图片；asset_map 把 bundle 相对路径换成本次会话的图片 URL。"""
    escaped = html.escape(text, quote=False)

    def image(match: re.Match) -> str:
        alt, src = match.group(1), match.group(2)
        url = asset_map.get(src)
        if not url:
            return f'<span class="missing-image">[图片 {html.escape(src, quote=True)}]</span>'
        return f'<img src="{html.escape(url, quote=True)}" alt="{alt}" loading="lazy">'

    escaped = _IMAGE.sub(image, escaped)
    escaped = _BOLD.sub(lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", escaped)
    escaped = _ITALIC.sub(r"<em>\1</em>", escaped)
    return escaped


def _table(lines: list[str], asset_map: dict[str, str]) -> str:
    rows = []
    for line in lines:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        rows.append(cells)
    output = ["<table>"]
    for index, cells in enumerate(rows):
        if index == 1:  # 分隔行
            continue
        tag = "th" if index == 0 else "td"
        output.append("<tr>" + "".join(f"<{tag}>{_inline(cell, asset_map)}</{tag}>" for cell in cells) + "</tr>")
    output.append("</table>")
    return "".join(output)


def render_markdown(markdown: str, asset_map: dict[str, str] | None = None) -> str:
    """把 Markdown 渲染为 HTML 片段；asset_map 缺省时图片显示为占位文字。"""
    asset_map = asset_map or {}
    lines = markdown.splitlines()
    output: list[str] = []
    block_index = 0
    index = 0
    pending_paragraph_id = ""

    def emit(fragment: str) -> None:
        nonlocal block_index
        block_index += 1
        output.append(fragment.replace('class="block"', f'class="block" data-block="{block_index}"', 1))

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        anchor = _ANCHOR.match(stripped)
        if anchor:
            pending_paragraph_id = anchor.group(1)
            index += 1
            continue
        heading = _HEADING.match(line)
        if heading:
            pending_paragraph_id = ""
            level = len(heading.group(1))
            emit(f'<h{level} class="block">{_inline(heading.group(2).strip(), asset_map)}</h{level}>')
            index += 1
            continue
        if line.startswith(">"):
            pending_paragraph_id = ""
            quote_lines = []
            while index < len(lines) and lines[index].startswith(">"):
                quote_lines.append(lines[index].lstrip(">").strip())
                index += 1
            emit(f'<blockquote class="block">{_inline(" ".join(quote_lines), asset_map)}</blockquote>')
            continue
        bullet = _BULLET.match(line)
        if bullet:
            pending_paragraph_id = ""
            items = []
            while index < len(lines):
                matched = _BULLET.match(lines[index])
                if not matched:
                    break
                items.append(f"<li>{_inline(matched.group(1), asset_map)}</li>")
                index += 1
            emit(f'<ul class="block">{"".join(items)}</ul>')
            continue
        numbered = _NUMBERED.match(line)
        if numbered:
            pending_paragraph_id = ""
            items = []
            while index < len(lines):
                matched = _NUMBERED.match(lines[index])
                if not matched:
                    break
                items.append(f"<li>{_inline(matched.group(1), asset_map)}</li>")
                index += 1
            emit(f'<ol class="block">{"".join(items)}</ol>')
            continue
        if stripped.startswith("|") and index + 1 < len(lines) and _TABLE_SEP.match(lines[index + 1].strip()):
            pending_paragraph_id = ""
            table_lines = [line, lines[index + 1]]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_lines.append(lines[index])
                index += 1
            emit(f'<div class="block">{_table(table_lines, asset_map)}</div>')
            continue
        paragraph_lines = [line]
        index += 1
        while index < len(lines) and lines[index].strip() and not _ANCHOR.match(lines[index].strip()):
            if _HEADING.match(lines[index]) or _BULLET.match(lines[index]) or _NUMBERED.match(lines[index]):
                break
            if lines[index].startswith(">"):
                break
            paragraph_lines.append(lines[index])
            index += 1
        paragraph_attr = (
            f' data-paragraph-id="{html.escape(pending_paragraph_id, quote=True)}"'
            if pending_paragraph_id
            else ""
        )
        emit(f'<p class="block"{paragraph_attr}>{_inline(" ".join(paragraph_lines), asset_map)}</p>')
        pending_paragraph_id = ""
    return "\n".join(output)
