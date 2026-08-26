"""QQ 空间长文图片卡（V0.2）：1080×1440 语义分页渲染模板。

- 模板与排版从 share-site 阅读主题抽取（同一套字体/行距/标题/引用/诗歌/
  附记/对齐语义），不重新设计；
- 图片是**可重建衍生物**：正文权威仍是磁盘 Markdown；
- rendererVersion/templateVersion 参与 artifact 身份与可重现性。
"""

from __future__ import annotations

CARD_WIDTH = 1080
CARD_HEIGHT = 1440
PAD = 56
CONTENT_WIDTH = CARD_WIDTH - PAD * 2  # 968
CONTENT_HEIGHT = CARD_HEIGHT - PAD * 2  # 1328
DEVICE_SCALE = 2  # 2x 输出保证手机查看清晰度（PNG 2160×2880）

RENDERER_VERSION = "share-card-renderer-1"
TEMPLATE_VERSION = "qzone-card-v1"
MAX_PAGES = 30  # 超过提示不建议图片全文

FONT_STACK = (
    '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", '
    '"SimSun", "PingFang SC", "Microsoft YaHei", serif'
)

CARD_CSS = f"""
:root {{
  --paper: #f5f1e8;
  --ink: #27231e;
  --ink-soft: #5f574c;
  --ink-faint: #8b8174;
  --line: #d4c7b5;
  --accent: #8a3f32;
  --gold: #9a7840;
  --font-serif: {FONT_STACK};
  --leading: 1.95;
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html, body {{ width: {CARD_WIDTH}px; height: {CARD_HEIGHT}px; background: var(--paper); color: var(--ink); }}
body {{
  font-family: var(--font-serif);
  padding: {PAD}px;
  overflow: hidden;
}}
#page-content {{
  width: {CONTENT_WIDTH}px;
  height: {CONTENT_HEIGHT}px;
  display: flex;
  flex-direction: column;
}}
#body-wrap {{
  flex: 1;
  overflow: hidden;
}}
.article-content {{
  font-size: 30px;
  line-height: var(--leading);
  overflow-wrap: break-word;
  word-break: normal;
}}
.article-content > * + * {{ margin-top: 0.6em; }}
.article-content p {{ text-indent: 2em; }}
.article-content p:first-child {{ text-indent: 0; }}
.article-content h2 {{
  margin-top: 1.2em;
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--line);
  font-size: 1.5em;
  line-height: 1.4;
  font-weight: 600;
}}
.article-content h3 {{ font-size: 1.25em; line-height: 1.4; margin-top: 1em; }}
.article-content blockquote {{
  margin: 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--accent);
  color: var(--ink-soft);
}}
.article-content blockquote p {{ text-indent: 0; }}
.article-content .text-align-left {{ text-align: left; }}
.article-content .text-align-center {{ text-align: center; }}
.article-content .text-align-right {{ text-align: right; }}
.article-content .poetry-block {{
  width: fit-content;
  max-width: 100%;
  margin: 1em auto;
  text-align: left;
}}
.article-content .poetry-block p {{ text-indent: 0; margin: 0.1em 0; line-height: 1.7; }}
.article-content .end-note {{
  margin-top: 1.4em;
  text-align: right;
  font-size: 0.9em;
  line-height: 1.7;
  color: var(--ink-soft);
}}
.article-content .end-note p {{ text-indent: 0; margin: 0.15em 0; }}
.article-content ul, .article-content ol {{ padding-left: 1.6em; }}
.article-content li {{ margin: 0.25em 0; }}
.article-content li p {{ text-indent: 0; }}
.article-content pre {{
  font-size: 0.8em;
  padding: 0.8em;
  border: 1px solid var(--line);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}}
.article-content img {{ max-width: 100%; height: auto; display: block; margin: 0 auto; }}
.article-figure {{ margin: 1em 0; }}
.article-figure figcaption {{ color: var(--ink-faint); font-size: 0.8em; text-align: center; margin-top: 0.4em; }}
#page-title {{
  margin-bottom: 0.9em;
  padding-bottom: 0.5em;
  border-bottom: 1px solid var(--line);
}}
#page-title h1 {{
  font-size: 52px;
  line-height: 1.3;
  letter-spacing: 0.04em;
  font-weight: 600;
  text-wrap: balance;
  overflow-wrap: anywhere;
}}
#page-title .byline {{
  margin-top: 0.6em;
  color: var(--ink-soft);
  font-size: 26px;
}}
#page-footer {{
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0.7em;
  border-top: 1px solid var(--line);
  color: var(--ink-faint);
  font-size: 22px;
}}
.test-badge {{
  position: absolute;
  top: 12px;
  right: 16px;
  color: var(--accent);
  font-size: 18px;
  letter-spacing: 0.1em;
}}
"""




# 连续长图模式（V0.4）：解除固定页高，正文自然流式排布，末尾域名脚注一次。
CONTINUOUS_CSS = f"""
html, body {{ width: {CARD_WIDTH}px; height: auto; background: var(--paper); color: var(--ink); }}
#page-content {{ width: {CARD_WIDTH}px; height: auto; padding: 72px 96px 56px; box-sizing: border-box; }}
#body-wrap {{ overflow: visible; }}
"""


def continuous_html(
    blocks_html: str,
    *,
    title: str = "",
    byline: str = "",
    site_domain: str = "read.历代纪.cn",
    test_mode: bool = False,
) -> str:
    """整篇连续长页 HTML（无分页、无页码；域名脚注仅末尾一次）。"""
    title_block = ""
    if title:
        byline_block = f'<p class="byline">{byline}</p>' if byline else ""
        title_block = f'<div id="page-title"><h1>{title}</h1>{byline_block}</div>'
    badge = '<div class="test-badge">Share V0.2 测试</div>' if test_mode else ""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>{CARD_CSS}</style><style>{CONTINUOUS_CSS}</style></head>
<body>
{badge}
<div id="page-content">
  {title_block}
  <div id="body-wrap"><div class="article-content">{blocks_html}</div></div>
  <div id="page-footer">
    <span>{site_domain}</span>
    <span>长图 · 历代纪</span>
  </div>
</div>
</body></html>"""


def page_html(
    blocks_html: str,
    *,
    title: str = "",
    byline: str = "",
    page_index: int = 0,
    page_count: int = 0,
    site_domain: str = "read.历代纪.cn",
    test_mode: bool = False,
) -> str:
    """单页 HTML（1080×1440）。第一页带标题区，其余页直接正文。"""
    title_block = ""
    if page_index == 0 and title:
        byline_block = f'<p class="byline">{byline}</p>' if byline else ""
        title_block = f'<div id="page-title"><h1>{title}</h1>{byline_block}</div>'
    badge = '<div class="test-badge">Share V0.2 测试</div>' if test_mode else ""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>{CARD_CSS}</style></head>
<body>
{badge}
<div id="page-content">
  {title_block}
  <div id="body-wrap"><div class="article-content">{blocks_html}</div></div>
  <div id="page-footer">
    <span>{site_domain}</span>
    <span>{page_index + 1} / {page_count}</span>
  </div>
</div>
</body></html>"""
