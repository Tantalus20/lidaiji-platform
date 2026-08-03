"""Studio 正文近似渲染：markdown-it-py（语法接近 Hugo/goldmark）。

保留预览契约：
- 每个顶层块带 ``class="block"`` 与 ``data-block="N"``（从 1 开始），
  供前端按导入警告“第N段”近似定位高亮；
- 段评锚点注释 ``<!-- paragraph-id:... -->`` 不渲染，转为紧随其后的
  段落上的 ``data-paragraph-id`` 属性（作者评入口依赖它）；
- 图片走 asset_map 替换成本次会话 URL；缺失时输出 missing-image 占位；
- 原始 HTML 一律不输出（注释剥离、其他标签不渲染），文本由
  markdown-it 统一转义，绝不输出未经转义的用户 HTML；
- 段落排版短代码渲染为受控类名：
  ``{{< align center|right >}}`` → ``<div class="text-align-...">``、
  ``{{< poetry >}}`` → ``<div class="poetry-block">``、
  ``{{< endnote >}}`` → ``<div class="end-note">``；容器内段落不占
  data-block 序号。

渲染器按“容器深度”只给顶层块编号：列表项/表格单元格/引用/排版容器内的
段落不占 data-block 序号，与旧渲染器（及导入报告的“第N段”）口径一致。
"""

from __future__ import annotations

import html as html_module
import re

from markdown_it import MarkdownIt
from markdown_it.renderer import RendererHTML as HTMLRenderer

_ANCHOR = re.compile(r"^<!--\s*paragraph-id:([\w-]+)\s*-->$")
_SHORTCODE_OPEN = re.compile(r"^\{\{< (align) (?:\"?)(left|center|right)(\"?)? >\}\}$|^\{\{< (poetry|endnote) >\}\}$")
_SHORTCODE_CLOSE = re.compile(r"^\{\{< /(align|poetry|endnote) >\}\}$")
_CONTAINER_CLASS = {
    ("align", "center"): "text-align-center",
    ("align", "right"): "text-align-right",
    ("align", "left"): "text-align-left",
    ("poetry", ""): "poetry-block",
    ("endnote", ""): "end-note",
}


def shortcode_block_rule(state, start_line: int, end_line: int, silent: bool) -> bool:
    """把 `{{< align|poetry|endnote >}} ... {{< /... >}}` 块解析为容器 token。"""
    opening = _SHORTCODE_OPEN.match(state.src.split("\n")[start_line].strip())
    if not opening:
        return False
    name = "align" if opening.group(1) == "align" else opening.group(4)
    align = opening.group(2) if name == "align" else ""
    close_pattern = re.compile(r"^\{\{< /" + name + r" >\}\}$")
    close_line = -1
    for cursor in range(start_line + 1, end_line):
        if close_pattern.match(state.src.split("\n")[cursor].strip()):
            close_line = cursor
            break
    if close_line < 0:
        return False
    if silent:
        return True
    cls = _CONTAINER_CLASS.get((name, align), "")
    open_token = state.push("lidaiji_container_open", "div", 1)
    open_token.attrs = {"class": cls} if cls else {}
    open_token.block = True
    state.md.block.tokenize(state, start_line + 1, close_line)
    close_token = state.push("lidaiji_container_close", "div", -1)
    close_token.block = True
    state.line = close_line + 1
    return True


class PreviewRenderer(HTMLRenderer):
    def __init__(self, asset_map: dict[str, str] | None = None):
        super().__init__()
        self.asset_map = asset_map or {}
        self.block_index = 0
        self.pending_pid = ""
        self.container_depth = 0

    def render(self, tokens, options, env):
        self.block_index = 0
        self.pending_pid = ""
        self.container_depth = 0
        return super().render(tokens, options, env)

    def lidaiji_container_open(self, tokens, idx, options, env):
        self.pending_pid = ""
        cls = tokens[idx].attrGet("class") or ""
        if self.container_depth == 0:
            self.block_index += 1
            classes = "block" + (f" {cls}" if cls else "")
            attrs = f' class="{classes}" data-block="{self.block_index}"'
        else:
            attrs = f' class="{cls}"' if cls else ""
        self.container_depth += 1
        return f"<div{attrs}>"

    def lidaiji_container_close(self, tokens, idx, options, env):
        self.container_depth = max(0, self.container_depth - 1)
        return "</div>"

    def _enter_container(self, tag: str) -> str:
        attrs = ""
        if self.container_depth == 0:
            self.block_index += 1
            attrs = f' class="block" data-block="{self.block_index}"'
        self.container_depth += 1
        return f"<{tag}{attrs}>"

    def _leave_container(self, tag: str) -> str:
        self.container_depth = max(0, self.container_depth - 1)
        return f"</{tag}>"

    def paragraph_open(self, tokens, idx, options, env):
        if self.container_depth > 0:
            return "<p>"
        self.block_index += 1
        attrs = f' class="block" data-block="{self.block_index}"'
        if self.pending_pid:
            attrs += f' data-paragraph-id="{html_module.escape(self.pending_pid, quote=True)}"'
            self.pending_pid = ""
        return f"<p{attrs}>"

    def heading_open(self, tokens, idx, options, env):
        self.pending_pid = ""
        return self._enter_container(tokens[idx].tag)

    def heading_close(self, tokens, idx, options, env):
        return f"</{tokens[idx].tag}>"

    def blockquote_open(self, tokens, idx, options, env):
        self.pending_pid = ""
        return self._enter_container("blockquote")

    def blockquote_close(self, tokens, idx, options, env):
        return self._leave_container("blockquote")

    def bullet_list_open(self, tokens, idx, options, env):
        self.pending_pid = ""
        return self._enter_container("ul")

    def bullet_list_close(self, tokens, idx, options, env):
        return self._leave_container("ul")

    def ordered_list_open(self, tokens, idx, options, env):
        self.pending_pid = ""
        return self._enter_container("ol")

    def ordered_list_close(self, tokens, idx, options, env):
        return self._leave_container("ol")

    def table_open(self, tokens, idx, options, env):
        self.pending_pid = ""
        return self._enter_container("table")

    def table_close(self, tokens, idx, options, env):
        return self._leave_container("table")

    def code_block(self, tokens, idx, options, env):
        self.pending_pid = ""
        attrs = ""
        if self.container_depth == 0:
            self.block_index += 1
            attrs = f' class="block" data-block="{self.block_index}"'
        token = tokens[idx]
        content = html_module.escape(token.content or "", quote=False)
        info = (token.info or "").strip()
        language = f' class="language-{html_module.escape(info, quote=True)}"' if info else ""
        return f"<pre{attrs}><code{language}>{content}</code></pre>\n"

    def html_block(self, tokens, idx, options, env):
        match = _ANCHOR.match((tokens[idx].content or "").strip())
        if match:
            self.pending_pid = match.group(1)
        return ""

    def html_inline(self, tokens, idx, options, env):
        return ""

    def image(self, tokens, idx, options, env):
        token = tokens[idx]
        src = token.attrGet("src") or ""
        alt = token.content or ""
        url = self.asset_map.get(src)
        if not url:
            return f'<span class="missing-image">[图片 {html_module.escape(src, quote=True)}]</span>'
        return (
            f'<img src="{html_module.escape(url, quote=True)}" '
            f'alt="{html_module.escape(alt, quote=True)}" loading="lazy">'
        )


def render_markdown(markdown: str, asset_map: dict[str, str] | None = None) -> str:
    """把 Markdown 渲染为 HTML 片段；asset_map 缺省时图片显示为占位文字。"""
    parser = MarkdownIt("commonmark", {"html": True}).enable("table")
    parser.block.ruler.before("paragraph", "lidaiji_shortcode", shortcode_block_rule)
    parser.renderer = PreviewRenderer(asset_map or {})
    return parser.render(str(markdown or ""))
