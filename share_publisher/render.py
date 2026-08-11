"""长文图片卡生成器（V0.2，仅 Mac 开发机）。

流程：Markdown → 块解析 → 浏览器真实排版测量 → 语义分页 →
逐页 HTML → Playwright/Chromium 截图 PNG → artifact manifest。

安全与边界：
- 只在本机执行；服务器不需要 Playwright/Chromium；
- 使用固定版本（PLAYWRIGHT_VERSION / chromium build），记录进 manifest；
- 单 browser/context 顺序生成，不并行开多 Chromium；
- 产物写入 <share-root>/artifacts/<shareId>/<shareRevision>/qzone-card-v1/，
  正文权威仍是 Markdown。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from share_publisher import cards
from share_publisher.artifacts import MANIFEST_NAME, sha256_file, write_manifest
from share_publisher.paginate import Block, blocks_html, paginate_blocks, parse_blocks

PLAYWRIGHT_VERSION = "1.53.0"
CHROMIUM_BUILD = "chromium_headless_shell-1178"


class RenderError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _measure_factory(page):
    def measure(html_fragment: str) -> float:
        result = page.evaluate(
            """(fragment) => {
              const probe = document.createElement("div");
              probe.style.cssText = "position:absolute;visibility:hidden;left:-10000px;top:0;width:968px;";
              probe.className = "article-content";
              probe.innerHTML = fragment;
              document.body.appendChild(probe);
              const h = probe.getBoundingClientRect().height;
              probe.remove();
              return h;
            }""",
            html_fragment,
        )
        return float(result)

    return measure


def generate_cards(
    markdown_body: str,
    *,
    title: str,
    byline: str,
    out_dir: Path,
    share_id: str = "",
    share_revision: str = "",
    site_domain: str = "read.历代纪.cn",
    test_mode: bool = False,
    max_pages: int = cards.MAX_PAGES,
) -> dict:
    """生成图片卡到 out_dir；返回 manifest dict。

    out_dir 由调用方按 artifact 路径构造（shareId/shareRevision/版本）；
    manifest 记录 shareId/shareRevision 用于 stale 判定与可重现身份。
    """
    blocks = parse_blocks(markdown_body)
    if not blocks:
        raise RenderError("empty-content", "正文为空，无法生成图片。")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RenderError(
            "playwright-missing",
            "本机缺少 Playwright（仅 Mac 开发环境需要；服务器不安装）。",
        ) from error

    started = time.monotonic()
    out_dir.mkdir(parents=True, exist_ok=True)
    title_html = ""
    if title:
        byline_html = f'<p class="byline">{byline}</p>' if byline else ""
        title_html = f'<div id="page-title"><h1>{title}</h1>{byline_html}</div>'

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as error:
            raise RenderError("chromium-launch-failed", f"Chromium 启动失败：{error}") from error
        try:
            page = browser.new_page(
                viewport={"width": cards.CARD_WIDTH, "height": cards.CARD_HEIGHT},
                device_scale_factor=cards.DEVICE_SCALE,
            )
            # 空壳页面用于测量（注入 cards.CARD_CSS）
            page.set_content(f"<html><head><style>{cards.CARD_CSS}</style></head><body></body></html>")
            measure = _measure_factory(page)

            # 页脚（页码 + 域名）占用的高度从页内容高度中扣除，避免每页裁剪
            footer_h = float(
                page.evaluate(
                    """() => {
                      const el = document.createElement("div");
                      el.id = "page-footer";
                      el.innerHTML = "<span>read.\u5386\u4ee3\u7eaa.cn</span><span>1 / 9</span>";
                      document.body.appendChild(el);
                      const h = el.getBoundingClientRect().height;
                      el.remove();
                      return h;
                    }"""
                )
            )
            usable_height = float(cards.CONTENT_HEIGHT) - footer_h

            pages = paginate_blocks(
                blocks,
                measure=measure,
                content_height=usable_height,
                block_gap=0.6 * 30.0,  # 块间距 ≈ 0.6em
            )
            if len(pages) > max_pages:
                raise RenderError(
                    "too-many-pages",
                    f"图片将达 {len(pages)} 页，超过单次建议上限 {max_pages} 页；请改用图片节选或摘要+链接。",
                )

            files = []
            for page_index, page_blocks in enumerate(pages):
                html_doc = cards.page_html(
                    blocks_html(page_blocks),
                    title=title if page_index == 0 else "",
                    byline=byline if page_index == 0 else "",
                    page_index=page_index,
                    page_count=len(pages),
                    site_domain=site_domain,
                    test_mode=test_mode,
                )
                page.set_content(html_doc)
                page.wait_for_timeout(40)
                name = f"{page_index + 1:02d}.png"
                target = out_dir / name
                page.screenshot(path=str(target), full_page=False)
                files.append({"name": name, "size": target.stat().st_size, "sha256": sha256_file(target)})
        finally:
            browser.close()

    manifest = {
        "templateVersion": cards.TEMPLATE_VERSION,
        "rendererVersion": cards.RENDERER_VERSION,
        "playwrightVersion": PLAYWRIGHT_VERSION,
        "chromiumBuild": CHROMIUM_BUILD,
        "shareId": share_id,
        "shareRevision": share_revision,
        "width": cards.CARD_WIDTH,
        "height": cards.CARD_HEIGHT,
        "deviceScale": cards.DEVICE_SCALE,
        "pageCount": len(pages),
        "siteDomain": site_domain,
        "files": files,
        "generatedAt": _now_iso(),
        "generationSeconds": round(time.monotonic() - started, 2),
    }
    write_manifest(out_dir, manifest)
    return manifest


def generate_long_cards(
    cards_dir: Path,
    out_dir: Path,
    *,
    share_id: str = "",
    share_revision: str = "",
    constraints=None,
) -> dict:
    """读取 cards artifact → 规划 → 纯拼接合成长图 → 写 long manifest。

    out_dir 为 qzone-long-cards-v1 目录；返回 long manifest。
    """
    from share_publisher import artifacts as art
    from share_publisher import longimage

    cards_manifest = _read_cards_manifest(cards_dir)
    source_hash = sha256_file(cards_dir / art.MANIFEST_NAME)
    page_names = art.page_names(cards_manifest)
    card_paths: dict[int, Path] = {}
    for name in page_names:
        index = int("".join(ch for ch in name if ch.isdigit()) or "0")
        card_paths[index] = cards_dir / name
    plan = longimage.plan_long_images(len(page_names), constraints or longimage.env_constraints())
    results = longimage.compose_long_images(card_paths, plan, out_dir, constraints or longimage.env_constraints())
    page_hashes = [
        {"index": i, "sha256": sha256_file(cards_dir / name)}
        for i, name in enumerate(page_names, start=1)
    ]
    manifest = {
        "templateVersion": art.LONG_TEMPLATE_VERSION,
        "rendererVersion": art.LONG_RENDERER_VERSION,
        "shareId": share_id,
        "shareRevision": share_revision,
        "sourceArtifactHash": source_hash,
        "sourcePageCount": len(page_names),
        "groupSize": len(plan[0]) if plan else 0,
        "imageCount": len(results),
        "width": results[0]["width"] if results else 0,
        "separatorPx": (constraints or longimage.env_constraints()).separator_px,
        "pageCards": page_hashes,
        "publishImages": results,
        "generatedAt": _now_iso(),
    }
    write_manifest(out_dir, manifest)
    return manifest


def _read_cards_manifest(cards_dir: Path) -> dict:
    import json as _json

    return _json.loads((cards_dir / MANIFEST_NAME).read_text(encoding="utf-8"))


def _now_iso() -> str:
    import datetime as dt

    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
