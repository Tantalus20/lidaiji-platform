#!/usr/bin/env python3
"""V0.3 长图合成器测试：规划、合成、快照、像素一致性、旧路径兼容。"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

from share_publisher import longimage  # noqa: E402
from share_publisher.longimage import LongImageConstraints, LongImageError  # noqa: E402


class PlanTestCase(unittest.TestCase):
    def check(self, pages, expected_count, max_per_group, max_images=9):
        plan = longimage.plan_long_images(pages, LongImageConstraints(max_images=max_images))
        flat = [p for group in plan for p in group]
        self.assertEqual(len(flat), pages, "不遗漏")
        self.assertEqual(flat, list(range(1, pages + 1)), "顺序保持")
        self.assertEqual(len(set(flat)), pages, "不重复")
        self.assertLessEqual(len(plan), max_images, "最终组数 ≤ 上限")
        self.assertLessEqual(max(len(g) for g in plan), max_per_group, "每组页数")
        return plan

    def test_typical_plans(self):
        self.check(1, 1, 1)
        self.check(6, 6, 1)
        self.check(9, 9, 1)
        plan10 = self.check(10, 5, 2)
        self.assertEqual(plan10, [[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]])
        plan18 = self.check(18, 6, 3)
        self.assertEqual(plan18, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 18]])
        self.check(27, 9, 3)
        # 30 页默认高度上限(3页/张)无法 ≤9 → CANNOT_FIT；放宽到 4 页/张 → 8 张均衡
        with self.assertRaises(LongImageError) as ctx:
            longimage.plan_long_images(30, LongImageConstraints(max_images=9))
        self.assertEqual(ctx.exception.code, "CANNOT_FIT_SINGLE_POST")
        plan30 = longimage.plan_long_images(30, LongImageConstraints(max_images=9, max_pages_per_image=4))
        self.assertLessEqual(len(plan30), 9)
        self.assertLessEqual(max(len(g) for g in plan30), 4)
        # 45 页默认 3 页/张超限；放宽到 5 页/张 → 9 张×5 页
        with self.assertRaises(LongImageError) as ctx:
            longimage.plan_long_images(45, LongImageConstraints(max_images=9))
        self.assertEqual(ctx.exception.code, "CANNOT_FIT_SINGLE_POST")
        plan45 = longimage.plan_long_images(45, LongImageConstraints(max_images=9, max_pages_per_image=5))
        self.assertEqual(plan45, [list(range(i * 5 + 1, (i + 1) * 5 + 1)) for i in range(9)])

    def test_80_pages_cannot_fit(self):
        with self.assertRaises(LongImageError) as ctx:
            longimage.plan_long_images(80, LongImageConstraints(max_images=9, max_pages_per_image=3))
        self.assertEqual(ctx.exception.code, "CANNOT_FIT_SINGLE_POST")

    def test_balance_no_skew(self):
        plan = longimage.plan_long_images(20, LongImageConstraints(max_images=9))
        sizes = [len(g) for g in plan]
        self.assertLessEqual(max(sizes) - min(sizes), 1, "尽量均衡")

    def test_cannot_fit_when_page_limit_too_strict(self):
        # g_max=1（每张只能 1 页）时 10 页必然超过 9 张
        with self.assertRaises(LongImageError) as ctx:
            longimage.plan_long_images(10, LongImageConstraints(max_images=9, max_pages_per_image=1))
        self.assertEqual(ctx.exception.code, "CANNOT_FIT_SINGLE_POST")

    def test_deterministic(self):
        a = longimage.plan_long_images(27, LongImageConstraints())
        b = longimage.plan_long_images(27, LongImageConstraints())
        self.assertEqual(a, b)

    def test_small_pages_keep_old_path(self):
        for pages in (1, 6, 9):
            plan = longimage.plan_long_images(pages, LongImageConstraints())
            self.assertEqual(plan, [[i] for i in range(1, pages + 1)], f"{pages} 页保持每页一张")


class ComposeTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="long-compose-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _card(self, name, color, text_pixel):
        from PIL import Image

        img = Image.new("RGB", (1080, 1440), color)
        img.putpixel((540, 720), text_pixel)
        img.save(self.root / name, format="PNG")
        return img

    def test_compose_3_pages_height_and_pixels(self):
        self._card("1.png", (255, 0, 0), (10, 20, 30))
        self._card("2.png", (0, 255, 0), (40, 50, 60))
        self._card("3.png", (0, 0, 255), (70, 80, 90))
        out = self.root / "out"
        results = longimage.compose_long_images(
            {1: self.root / "1.png", 2: self.root / "2.png", 3: self.root / "3.png"},
            [[1, 2, 3]], out, LongImageConstraints(max_pages_per_image=3),
        )
        self.assertEqual(len(results), 1)
        self.assertEqual((results[0]["width"], results[0]["height"]), (1080, 4320), "3×1440 → 4320")
        from PIL import Image

        composed = Image.open(out / "01.png")
        self.assertEqual(composed.size, (1080, 4320))
        # 关键像素区域一致（各页中心点原样保留，无缩放/插值）
        self.assertEqual(composed.getpixel((540, 720)), (10, 20, 30))
        self.assertEqual(composed.getpixel((540, 720 + 1440)), (40, 50, 60))
        self.assertEqual(composed.getpixel((540, 720 + 2880)), (70, 80, 90))
        composed.close()

    def test_too_tall_at_compose(self):
        # 混合高度卡片：一张异常偏高 → 合成高度超过 max_pages×卡片高度
        from PIL import Image

        Image.new("RGB", (1080, 1440), (0, 0, 0)).save(self.root / "a.png")
        Image.new("RGB", (1080, 2880), (0, 0, 0)).save(self.root / "b.png")
        with self.assertRaises(LongImageError) as ctx:
            longimage.compose_long_images(
                {1: self.root / "a.png", 2: self.root / "b.png"}, [[1, 2]], self.root / "out",
                LongImageConstraints(max_pages_per_image=2),
            )
        self.assertEqual(ctx.exception.code, "LONG_IMAGE_TOO_TALL")

    def test_width_mismatch_rejected(self):
        from PIL import Image

        Image.new("RGB", (1080, 1440), (0, 0, 0)).save(self.root / "a.png")
        Image.new("RGB", (800, 1440), (0, 0, 0)).save(self.root / "b.png")
        with self.assertRaises(LongImageError) as ctx:
            longimage.compose_long_images(
                {1: self.root / "a.png", 2: self.root / "b.png"},
                [[1, 2]], self.root / "out", LongImageConstraints(),
            )
        self.assertEqual(ctx.exception.code, "LONG_IMAGE_WIDTH_MISMATCH")

    def test_too_large_bytes(self):
        self._card("1.png", (255, 0, 0), (1, 2, 3))
        with self.assertRaises(LongImageError) as ctx:
            longimage.compose_long_images(
                {1: self.root / "1.png"}, [[1]], self.root / "out",
                LongImageConstraints(max_bytes=10),
            )
        self.assertEqual(ctx.exception.code, "LONG_IMAGE_TOO_LARGE")

    def test_sha_stable_and_content_sensitive(self):
        self._card("1.png", (255, 0, 0), (1, 2, 3))
        out1 = self.root / "o1"
        out2 = self.root / "o2"
        r1 = longimage.compose_long_images({1: self.root / "1.png"}, [[1]], out1, LongImageConstraints())
        r2 = longimage.compose_long_images({1: self.root / "1.png"}, [[1]], out2, LongImageConstraints())
        self.assertEqual(r1[0]["sha256"], r2[0]["sha256"], "同输入 SHA 稳定")
        self._card("1.png", (255, 0, 0), (9, 9, 9))  # 修改像素
        r3 = longimage.compose_long_images({1: self.root / "1.png"}, [[1]], self.root / "o3", LongImageConstraints())
        self.assertNotEqual(r1[0]["sha256"], r3[0]["sha256"], "内容变化 SHA 变化")


class RealRenderLongTestCase(unittest.TestCase):
    """真实渲染（Playwright）→ 长图合成端到端。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="long-render-")

    def tearDown(self):
        self.temp.cleanup()

    def test_real_cards_to_long(self):
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            self.skipTest("本机未安装 playwright")
        from share_publisher.render import generate_cards

        SENT = "夜色渐深，江面上的渔火明明灭灭，这是虚构测试内容。"
        parts = []
        for i in range(48):
            if i % 6 == 0:
                parts.append(f"## 第 {i // 6 + 1} 节")
            parts.append(SENT * 5)
        md = "\n\n".join(parts)
        cards_dir = Path(self.temp.name) / "cards"
        man = generate_cards(md, title="长图渲染测试", byline="站主", out_dir=cards_dir, test_mode=True)
        self.assertGreater(man["pageCount"], 9)
        # 连续长图（≤9 段；段宽恒等于卡片宽，段高 ≤ 目标）
        from share_publisher.render import generate_long_cards

        out = Path(self.temp.name) / "long"
        long_manifest = generate_long_cards(
            md, out, cards_dir=cards_dir, title="长图渲染测试", byline="站主", test_mode=True,
        )
        self.assertLessEqual(long_manifest["imageCount"], 9)
        self.assertEqual(long_manifest["mode"], "continuous-v1")
        self.assertEqual(long_manifest["sourceArtifactHash"], __import__("hashlib").sha256((cards_dir / "manifest.json").read_bytes()).hexdigest())
        from PIL import Image

        for img in long_manifest["publishImages"]:
            composed = Image.open(out / f"{img['index']:02d}.png")
            self.assertEqual(composed.size, (img["width"], img["height"]))
            self.assertEqual(composed.size[0], 640, "长图段宽 = QQ 下发上限 640")
            composed.close()


if __name__ == "__main__":
    unittest.main()
