"""作者工作台近似渲染器（markdown-it-py）自动测试。

契约（前端依赖，改动前必须保持）：
- 顶层块带 class="block" 与 data-block="N"（从 1 开始，容器内段落不占号）；
- 段评锚点注释转为紧随段落的 data-paragraph-id，注释本身不输出；
- **加粗**/*斜体*/***粗斜*** 渲染为语义化 strong/em；
- 链接渲染为 <a>；行内代码渲染为 <code>；图片缺 asset_map 时输出
  missing-image 占位；
- 原始 HTML 一律不输出（注释剥离、标签不渲染），文本全部转义。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "studio"))

from preview_render import render_markdown  # noqa: E402


class PreviewRenderTests(unittest.TestCase):
    def test_锚点与块序号(self):
        html = render_markdown(
            "<!-- paragraph-id:p-100000000001 -->\n\n第一段。\n\n> 引用。\n\n"
            "<!-- paragraph-id:p-100000000003 -->\n\n第二段。\n"
        )
        self.assertIn('class="block" data-block="1" data-paragraph-id="p-100000000001"', html)
        self.assertIn('class="block" data-block="3" data-paragraph-id="p-100000000003"', html)
        self.assertIn('class="block" data-block="2"', html)  # 引用占一个块号
        self.assertNotIn("<!-- paragraph-id", html)
        # 引用块不应带锚点
        self.assertNotIn("blockquote class=\"block\" data-block=\"2\" data-paragraph-id", html)

    def test_容器内段落不占块序号(self):
        html = render_markdown("- 一\n- 二\n\n1. 甲\n1. 乙\n\n> 引用第一行\n> 引用第二行\n")
        blocks = []
        for match in __import__("re").finditer(r'data-block="(\d+)"', html):
            blocks.append(int(match.group(1)))
        self.assertEqual(blocks, [1, 2, 3])  # ul/ol/blockquote 各占一个号，内部段落不计

    def test_加粗斜体粗斜体(self):
        html = render_markdown("**加粗**与*斜体*和***粗斜***。\n")
        self.assertIn("<strong>加粗</strong>", html)
        self.assertIn("<em>斜体</em>", html)
        # markdown-it 与 Hugo/goldmark 一致：***x*** 渲染为 <em><strong>x</strong></em>
        self.assertIn("<em><strong>粗斜</strong></em>", html)

    def test_链接与行内代码(self):
        html = render_markdown("[链接](https://example.com)与`代码`。\n")
        self.assertIn('<a href="https://example.com">链接</a>', html)
        self.assertIn("<code>代码</code>", html)

    def test_图片占位与asset_map(self):
        html = render_markdown("![插图](images/a.webp)\n")
        self.assertIn('class="missing-image"', html)
        self.assertIn("[图片 images/a.webp]", html)
        html2 = render_markdown(
            "![插图](images/a.webp)\n",
            {"images/a.webp": "http://127.0.0.1:4173/api/import/asset?token=t&name=a.webp"},
        )
        self.assertIn('<img src="http://127.0.0.1:4173/api/import/asset?token=t&amp;name=a.webp"', html2)
        self.assertNotIn("missing-image", html2)

    def test_表格与代码块(self):
        html = render_markdown("| 甲 | 乙 |\n| --- | --- |\n| 1\\|1 | 2 |\n\n```python\nx = 1\n```\n")
        self.assertIn("<table", html)
        self.assertIn("<th>甲</th>", html)
        self.assertIn("<td>1|1</td>", html)
        self.assertIn("<pre", html)
        self.assertIn('<code class="language-python">x = 1\n</code>', html)

    def test_原始HTML不输出且文本转义(self):
        html = render_markdown("<script>alert(1)</script>\n\n带 <b>标签</b> 与 & 符号。\n")
        self.assertNotIn("<script>", html)
        self.assertNotIn("<b>", html)
        self.assertNotIn("alert(", html)
        self.assertIn("带 标签 与 &amp; 符号。", html)

    def test_多行段落与空输入(self):
        html = render_markdown("第一行\n第二行\n\n结尾。\n")
        self.assertIn("第一行", html)
        self.assertIn("第二行", html)
        self.assertEqual(render_markdown(""), "")
        self.assertEqual(render_markdown(None), "")

    def test_锚点后紧跟非段落块时不挂载(self):
        html = render_markdown("<!-- paragraph-id:p-100000000001 -->\n\n- 列表项\n")
        self.assertNotIn("data-paragraph-id", html)

    def test_段落排版短代码渲染为受控类名(self):
        html = render_markdown(
            "{{< align center >}}\n\n**加粗**题记\n\n{{< /align >}}\n\n正文段。\n\n"
            "{{< poetry >}}\n\n山有木兮*木有枝*\n\n心悦君兮君不知\n\n{{< /poetry >}}\n\n"
            "{{< endnote >}}\n\n写于二〇二六年八月\n\n**君纪鉴**\n\n{{< /endnote >}}\n"
        )
        self.assertIn('class="block text-align-center" data-block="1"', html)
        self.assertIn("<strong>加粗</strong>", html)
        self.assertIn('class="block" data-block="2"', html)  # 正文段占一个块号
        self.assertIn('class="block poetry-block" data-block="3"', html)
        self.assertIn("<em>木有枝</em>", html)
        self.assertIn('class="block end-note" data-block="4"', html)
        self.assertIn("<strong>君纪鉴</strong>", html)
        self.assertNotIn("{{<", html, "短代码标签不应出现在输出中")
        # 容器内段落不占 data-block 序号
        self.assertNotIn('data-block="5"', html)

    def test_右对齐短代码与未闭合降级(self):
        html = render_markdown("{{< align right >}}\n\n落款\n\n{{< /align >}}\n")
        self.assertIn('class="block text-align-right" data-block="1"', html)
        # 未闭合的短代码按普通文本显示（零丢失）
        html2 = render_markdown("{{< align center >}}\n\n未闭合\n")
        self.assertIn("&lt;", html2)
        self.assertIn("未闭合", html2)


if __name__ == "__main__":
    unittest.main()
