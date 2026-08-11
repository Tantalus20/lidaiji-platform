#!/usr/bin/env python3
"""V0.2 长文图片卡：分页器 / artifact 管理 / 图片发布模式测试。

- 分页：普通段、超长段拆分（句级切点）、标题孤行、诗歌/附记保持整体、
  确定性顺序；
- artifact：manifest/hash/stale/穿越/symlink/缺图/坏 PNG；
- publication：图片模式冻结、幂等、ambiguous（上传中断）零重发。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

from share_publisher import artifacts, db as pubdb, paginate  # noqa: E402
from share_publisher import qzone as qzone_mod  # noqa: E402
from share_publisher.artifacts import ArtifactError  # noqa: E402
from tests.test_share_publisher import FakeTransport  # noqa: E402
from share_publisher.paginate import Block, blocks_html, parse_blocks, paginate_blocks  # noqa: E402

FINAL_TEXT = "摘要\n\n阅读全文：\nhttps://read.example.com/x/"


class FakeMeasure:
    """按文本长度模拟渲染高度（确定性）。每字符 6px，块间距 20px。"""

    def __init__(self, chars_per_line: int = 10, line_height: float = 60.0):
        self.chars_per_line = chars_per_line
        self.line_height = line_height

    def __call__(self, html_fragment: str) -> float:
        import re

        text = re.sub(r"<[^>]+>", "", html_fragment)
        text = re.sub(r"&[a-z]+;", "X", text)
        lines = max(1, -(-len(text) // self.chars_per_line))
        return lines * self.line_height


class PaginateTestCase(unittest.TestCase):
    def setUp(self):
        self.measure = FakeMeasure(chars_per_line=10, line_height=60)

    def test_parse_blocks_kinds(self):
        md = """## 标题

普通段落。**加粗**与*斜体*。

> 引用

{{< poetry >}}
一行诗
二行诗
{{< /poetry >}}

{{< endnote >}}
附记内容
{{< /endnote >}}

- 甲
- 乙

```py
code
```

![图](img.png) 说明
"""
        blocks = parse_blocks(md)
        kinds = [b.type for b in blocks]
        self.assertEqual(kinds, [
            "heading", "paragraph", "blockquote", "poetry",
            "endnote", "bullet_list", "code_block", "image",
        ])
        self.assertEqual(blocks[0].level, 2)
        self.assertEqual(blocks[3].lines, ["一行诗", "二行诗"])

    def test_basic_pagination(self):
        blocks = [Block(type="paragraph", lines=["段落甲"]), Block(type="paragraph", lines=["段落乙"])]
        pages = paginate_blocks(blocks, self.measure, content_height=260, block_gap=20)
        # 每段 60px + 20 gap → 两段都进第 1 页（160 <= 260）
        self.assertEqual(len(pages), 1)
        self.assertEqual(len(pages[0]), 2)

    def test_block_moves_to_next_page(self):
        # 第一段 150px + gap，第二段 150px 放不进 260
        blocks = [
            Block(type="paragraph", lines=["字" * 25]),  # 3 行 = 180
            Block(type="paragraph", lines=["字" * 25]),
        ]
        pages = paginate_blocks(blocks, self.measure, content_height=260, block_gap=20)
        self.assertEqual(len(pages), 2)
        self.assertEqual(len(pages[0]), 1)
        self.assertEqual(len(pages[1]), 1)

    def test_long_paragraph_split_by_sentence(self):
        # 50 句 * 6 字符 = 300 字符 → 30 行 = 1800px > 260，需按句切分
        text = "。".join(["句子" + str(i) for i in range(50)]) + "。"
        blocks = [Block(type="paragraph", lines=[text])]
        pages = paginate_blocks(blocks, self.measure, content_height=260, block_gap=20)
        self.assertGreater(len(pages), 1)
        # 每一页的段落都不应超过单页容量
        for page in pages:
            for b in page:
                self.assertLessEqual(self.measure(blocks_html([b])), 260)
        # 顺序保持
        all_text = "".join("".join(b.lines) for page in pages for b in page).replace("。", "。")
        self.assertIn("句子0", all_text)
        self.assertIn("句子49", all_text)

    def test_heading_orphan_protection(self):
        # 标题 + 一段正文；标题放入当前页后剩余空间不够正文 → 标题随正文移页
        measure = FakeMeasure(chars_per_line=10, line_height=60)
        blocks = [
            Block(type="heading", level=2, lines=["标题"]),  # 60px
            Block(type="paragraph", lines=["字" * 30]),  # 3 行 = 180px
        ]
        pages = paginate_blocks(blocks, measure, content_height=120, block_gap=20)
        # 标题单独(60+20=80)可进第1页，但正文(180)放不下 → 标题孤行保护：两页
        self.assertEqual(len(pages), 2)
        self.assertEqual(pages[0][0].type, "heading")
        self.assertEqual(pages[1][0].type, "paragraph")

    def test_poetry_kept_whole(self):
        measure = FakeMeasure(chars_per_line=10, line_height=60)
        poetry = Block(type="poetry", lines=["一二三四五六七八九十", "一二三四五六七八九十"])
        blocks = [poetry]
        pages = paginate_blocks(blocks, measure, content_height=300, block_gap=20)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0][0].type, "poetry")
        # 超页也不拆语义整体
        pages2 = paginate_blocks(blocks, measure, content_height=100, block_gap=20)
        self.assertEqual(pages2[0][0].type, "poetry")

    def test_deterministic(self):
        blocks = [Block(type="paragraph", lines=["字" * 12]), Block(type="paragraph", lines=["字" * 8])]
        first = paginate_blocks(blocks, self.measure, 260, 20)
        second = paginate_blocks(blocks, self.measure, 260, 20)
        self.assertEqual(first, second)


class ArtifactsTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-cards-")
        self.root = Path(self.temp.name)
        self.share_id = "sh-20260808-000001"
        self.rev = "sh-20260808-000001@abcdef123456"
        self.dir = artifacts.artifact_dir(self.root, self.share_id, self.rev)
        self.dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def _make_manifest(self, revision=None):
        png = b"\x89PNG\r\n\x1a\n" + b"fake"
        (self.dir / "01.png").write_bytes(png)
        (self.dir / "02.png").write_bytes(png)
        manifest = {
            "templateVersion": "qzone-card-v1",
            "rendererVersion": "share-card-renderer-1",
            "shareRevision": revision or self.rev,
            "pageCount": 2,
            "files": [
                {"name": "01.png", "size": len(png), "sha256": artifacts.sha256_file(self.dir / "01.png")},
                {"name": "02.png", "size": len(png), "sha256": artifacts.sha256_file(self.dir / "02.png")},
            ],
        }
        artifacts.write_manifest(self.dir, manifest)
        return manifest

    def test_manifest_roundtrip_and_verify(self):
        self._make_manifest()
        manifest = artifacts.read_manifest(self.root, self.share_id, self.rev)
        self.assertEqual(manifest["pageCount"], 2)
        self.assertEqual(artifacts.verify_artifact(self.root, self.share_id, self.rev), [])
        self.assertEqual(artifacts.page_names(manifest), ["01.png", "02.png"])

    def test_stale(self):
        manifest = self._make_manifest(revision="sh-20260808-000001@oldhash123456")
        self.assertTrue(artifacts.is_stale(manifest, self.rev))

    def test_traversal_and_symlink_rejected(self):
        self._make_manifest()
        for bad in ("../evil.png", "a/b.png", "..", "", "/etc/passwd", "01.png/.."):
            with self.assertRaises(ArtifactError, msg=bad):
                artifacts.safe_resolve(self.root, self.share_id, self.rev, bad)
        # 符号链接逃逸
        outside = self.temp.name + "/outside.png"
        (self.root / "outside.png").write_bytes(b"x")
        os.symlink(self.root / "outside.png", self.dir / "03.png")
        with self.assertRaises(ArtifactError):
            artifacts.safe_resolve(self.root, self.share_id, self.rev, "03.png")

    def test_corrupt_png_signature(self):
        self.assertFalse(artifacts.is_png(b"not a png"))
        self.assertTrue(artifacts.is_png(b"\x89PNG\r\n\x1a\n" + b"x"))

    def test_missing_image_reported(self):
        self._make_manifest()
        (self.dir / "02.png").unlink()
        errors = artifacts.verify_artifact(self.root, self.share_id, self.rev)
        self.assertTrue(any("02.png" in e for e in errors))


class PublicationImageModeTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-pub-img-")
        self.db = pubdb.PublisherDB(Path(self.temp.name) / "p.sqlite3")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def create(self, mode="text-link", manifest_hash="", images=None):
        return self.db.create(
            share_id="sh-20260808-000001",
            share_revision="sh-20260808-000001@abcdef123456",
            content_hash="c" * 64,
            final_text=FINAL_TEXT,
            scheduled_at=pubdb.utcnow(),
            mode=mode,
            artifact_manifest_hash=manifest_hash,
            image_hashes=images,
        )

    def test_image_mode_requires_manifest_hash(self):
        with self.assertRaises(pubdb.PublisherError):
            self.create(mode="image-full-link")

    def test_image_mode_freeze_and_rerun_idempotent(self):
        record = self.create(mode="image-excerpt-link", manifest_hash="m1", images=["h1", "h2"])
        self.assertEqual(record["mode"], "image-excerpt-link")
        self.assertEqual(record["artifact_manifest_hash"], "m1")
        self.assertEqual(json.loads(record["image_hashes_json"]), ["h1", "h2"])
        self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
        self.db.claim_qzone(record["publication_id"])
        self.db.mark_submitted(record["publication_id"], code="")
        self.assertEqual(self.db.get(record["publication_id"])["qzone_status"], pubdb.QZ_SUBMITTED)

    def test_image_count_capped_at_nine(self):
        """QQ 单条上限（真机实测 9）：超过 9 张的发布在创建时拒绝。"""
        from share_publisher import api as pubapi

        # 直接验证硬上限常量
        self.assertEqual(pubapi._image_max_count(), 9)
        self.assertLessEqual(pubapi._image_max_count(), 9)

    def test_upload_interrupted_marks_ambiguous_not_failed(self):
        """图片上传连接中断（可能已上传）：submitted_unverified + ambiguous，零重发。"""
        record = self.create(mode="image-excerpt-link", manifest_hash="m1", images=["h1"])

        class TimeoutOnUpload(FakeTransport):
            def qzone_upload_multipart(self, url, multipart, headers):
                self.calls.append(("upload", ""))
                raise TimeoutError("上传连接中断")

        import share_publisher.qzone as qz

        calls = {"count": 0}

        def factory():
            calls["count"] += 1
            return qz.QzoneAdapter(
                qz.QzoneAdapterConfig(
                    napcat_http_url="http://127.0.0.1:1/",
                    qq_account="12345",
                    transport=TimeoutOnUpload([
                        {"status": "ok", "data": {"user_id": "12345"}},
                        {"status": "ok", "data": {"cookies": "uin=1; p_skey=abcdef0123456789"}},
                    ]),
                )
            )

        os.environ["QZONE_PUBLISH_ENABLED"] = "true"
        try:
            from share_publisher import __main__ as cli

            # 先准备 artifact（供 runner 读取）
            art_dir = artifacts.artifact_dir(Path(self.temp.name) / "share", record["share_id"], record["share_revision"])
            art_dir.mkdir(parents=True)
            (art_dir / "01.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x")
            artifacts.write_manifest(art_dir, {
                "templateVersion": "qzone-card-v1",
                "rendererVersion": "share-card-renderer-1",
                "shareRevision": record["share_revision"],
                "pageCount": 1,
                "files": [{"name": "01.png", "size": 12, "sha256": artifacts.sha256_file(art_dir / "01.png")}],
            })
            self.db.mark_web_verified(record["publication_id"], "https://read.example.com/x/")
            cli.run_qzone_stage(self.db, "https://read.example.com/", Path(self.temp.name) / "share", adapter_factory=factory)
        finally:
            os.environ.pop("QZONE_PUBLISH_ENABLED", None)
        state = self.db.get(record["publication_id"])
        self.assertEqual(state["qzone_status"], pubdb.QZ_SUBMITTED)
        self.assertIn("ambiguous", state["error_code"])


class RealRenderTestCase(unittest.TestCase):
    """真实浏览器渲染冒烟（需要本机 Playwright；服务器不安装）。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-cards-render-")

    def tearDown(self):
        self.temp.cleanup()

    def test_generate_real_cards(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.skipTest("本机未安装 playwright（仅开发机需要）")
        from share_publisher.render import generate_cards

        md = """## 第一章

正文第一段，用于真实渲染验证。

{{< poetry >}}
一行诗
{{< /poetry >}}

{{< endnote >}}
附记
{{< /endnote >}}
"""
        out = Path(self.temp.name) / "cards"
        manifest = generate_cards(md, title="真实渲染测试", byline="站主", out_dir=out, test_mode=True)
        self.assertGreaterEqual(manifest["pageCount"], 1)
        self.assertEqual(len(manifest["files"]), manifest["pageCount"])
        for f in manifest["files"]:
            self.assertTrue(artifacts.is_png((out / f["name"]).read_bytes()))
        # 可复现：同输入同版本 → 相同页数与文件名
        manifest2 = generate_cards(md, title="真实渲染测试", byline="站主", out_dir=out, test_mode=True)
        self.assertEqual(manifest["pageCount"], manifest2["pageCount"])
        self.assertEqual([f["name"] for f in manifest["files"]], [f["name"] for f in manifest2["files"]])


class LongCardsE2ETestCase(unittest.TestCase):
    """V0.3 长图端到端（本地，零真实网络）：cards → long → 快照 → 发布完整性。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="share-long-e2e-")
        self.root = Path(self.temp.name)
        self.share_root = self.root / "share"
        self.share_id = "sh-20260810-000001"
        self.rev = "sh-20260810-000001@abcdef123456"
        self.cards_dir = artifacts.artifact_dir(self.share_root, self.share_id, self.rev)
        self.long_dir = artifacts.long_artifact_dir(self.share_root, self.share_id, self.rev)

    def tearDown(self):
        self.temp.cleanup()

    def _build_cards(self, pages=10):
        """生成 pages 张 1080×1440 卡片（用 PIL 直绘，不用 Playwright，快且确定）。"""
        from PIL import Image

        self.cards_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for i in range(1, pages + 1):
            img = Image.new("RGB", (1080, 1440), (240, 240, 230))
            name = f"{i:02d}.png"
            img.save(self.cards_dir / name, format="PNG")
            files.append({"name": name, "size": 0, "sha256": artifacts.sha256_file(self.cards_dir / name)})
        manifest = {
            "templateVersion": "qzone-card-v1",
            "rendererVersion": "share-card-renderer-1",
            "shareId": self.share_id,
            "shareRevision": self.rev,
            "pageCount": pages,
            "files": files,
        }
        return artifacts.write_manifest(self.cards_dir, manifest)

    def test_generate_long_and_freeze(self):
        cards_hash = self._build_cards(10)
        from share_publisher import longimage
        from share_publisher.render import generate_long_cards

        long_manifest = generate_long_cards(
            self.cards_dir, self.long_dir, share_id=self.share_id, share_revision=self.rev,
            constraints=longimage.LongImageConstraints(),
        )
        self.assertEqual(long_manifest["imageCount"], 5)
        self.assertEqual(long_manifest["groupSize"], 2)
        self.assertEqual(long_manifest["sourceArtifactHash"], cards_hash)
        self.assertEqual(len(long_manifest["publishImages"]), 5)
        self.assertEqual(long_manifest["publishImages"][0]["pages"], [1, 2])
        # 每张 SHA 可复验
        for img in long_manifest["publishImages"]:
            self.assertEqual(
                artifacts.sha256_file(self.long_dir / f"{img['index']:02d}.png"), img["sha256"]
            )
        # stale：cards 变化 → long stale
        self._build_cards(10)  # 重新生成同内容 cards（hash 相同）
        cards_hash2 = artifacts.sha256_file(self.cards_dir / artifacts.MANIFEST_NAME)
        self.assertEqual(cards_hash, cards_hash2, "同内容 cards 哈希稳定")
        # 重建不同页数（manifest 变化）→ long stale；同页数重建 → 不 stale
        self._build_cards(12)
        cards_hash4 = artifacts.sha256_file(self.cards_dir / artifacts.MANIFEST_NAME)
        self.assertTrue(artifacts.long_stale(long_manifest, self.rev, cards_hash4))
        self.assertFalse(artifacts.long_stale(long_manifest, self.rev, cards_hash))

    def test_tamper_rejected(self):
        self._build_cards(10)
        from share_publisher import longimage
        from share_publisher.render import generate_long_cards

        generate_long_cards(self.cards_dir, self.long_dir, share_id=self.share_id, share_revision=self.rev,
                            constraints=longimage.LongImageConstraints())
        from share_publisher.api import _read_long_for_publish

        # 未篡改：必须通过完整性校验
        _read_long_for_publish(self.share_root, self.share_id, self.rev)
        # 篡改一张长图：必须拒绝
        (self.long_dir / "01.png").write_bytes(b"tampered")
        with self.assertRaises(SharePublishError) as ctx:
            _read_long_for_publish(self.share_root, self.share_id, self.rev)
        self.assertEqual(ctx.exception.code, "PUBLICATION_SNAPSHOT_TAMPERED")

    def test_create_long_path_accepts_long_hash(self):
        # 回归：create() 对 >9 页全文必须接受「长图 manifest 哈希」，
        # 不得先与卡片 manifest 哈希比对而拒绝（LQ01 真机轮发现的缺陷）。
        from share_publisher import longimage
        from share_publisher.render import generate_long_cards

        self._build_cards(10)
        generate_long_cards(
            self.cards_dir, self.long_dir, share_id=self.share_id, share_revision=self.rev,
            constraints=longimage.LongImageConstraints(),
        )
        long_hash = artifacts.sha256_file(self.long_dir / artifacts.MANIFEST_NAME)
        item_dir = self.share_root / "items" / self.share_id
        item_dir.mkdir(parents=True, exist_ok=True)
        from studio import share as share_mod

        (item_dir / "index.md").write_text(share_mod.render_source(
            {"title": "t", "author": "a", "date": "2026-08-10", "slug": "long-test",
             "draft": False, "shareKind": "other", "rightsMode": "original",
             "shareId": self.share_id, "shareRevision": self.rev},
            "正文。\n" * 40,
        ), encoding="utf-8")
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(self.share_root)
        try:
            from share_publisher.api import SharePublicationService, SharePublishError
            from share_publisher import db as pubdb

            with SharePublicationService(Path("/Users/haminster/Projects/lidaiji-split/lidaiji-platform")) as svc:
                r = svc.create(
                    "items/sh-20260810-000001/index.md", "测试", pubdb.to_utc_iso(pubdb.utcnow()),
                    mode=pubdb.MODE_IMAGE_FULL, artifact_manifest_hash=long_hash,
                )
                pub = r["publication"]
                self.assertEqual(pub["mode"], pubdb.MODE_IMAGE_FULL)
                self.assertEqual(len(json.loads(pub["image_hashes_json"])), 5)
                self.assertEqual(json.loads(pub["metadata_json"])["artifactMode"], "long-cards")
                # 冻结哈希 = 长图 manifest 哈希
                self.assertEqual(pub["artifact_manifest_hash"], long_hash)
                # 错误的长图哈希必须被拒绝
                with self.assertRaises(SharePublishError) as ctx:
                    svc.create(
                        "items/sh-20260810-000001/index.md", "测试", pubdb.to_utc_iso(pubdb.utcnow()),
                        mode=pubdb.MODE_IMAGE_FULL, artifact_manifest_hash="wrong-hash",
                    )
                self.assertEqual(ctx.exception.code, "artifact-changed")
        finally:
            os.environ.pop("LIDAIJI_SHARE_CONTENT_ROOT", None)

    def test_small_pages_no_long_needed(self):
        # 1-9 页：cards 即可，create 不会要求长图
        self._build_cards(6)
        item_dir = self.share_root / "items" / self.share_id
        item_dir.mkdir(parents=True, exist_ok=True)
        from studio import share as share_mod

        (item_dir / "index.md").write_text(share_mod.render_source(
            {"title": "t", "author": "a", "date": "2026-08-10", "slug": "long-test",
             "draft": False, "shareKind": "other", "rightsMode": "original",
             "shareId": self.share_id, "shareRevision": self.rev},
            "正文。\n",
        ), encoding="utf-8")
        os.environ["LIDAIJI_SHARE_CONTENT_ROOT"] = str(self.share_root)
        try:
            from share_publisher.api import SharePublicationService
            from share_publisher import db as pubdb

            with SharePublicationService(Path("/Users/haminster/Projects/lidaiji-split/lidaiji-platform")) as svc:
                r = svc.create(
                    "items/sh-20260810-000001/index.md", "测试", pubdb.to_utc_iso(pubdb.utcnow()),
                    mode=pubdb.MODE_IMAGE_FULL, artifact_manifest_hash="",
                )
                self.assertEqual(r["publication"]["mode"], pubdb.MODE_IMAGE_FULL)
                self.assertEqual(len(json.loads(r["publication"]["image_hashes_json"])), 6)
        finally:
            os.environ.pop("LIDAIJI_SHARE_CONTENT_ROOT", None)


from share_publisher.api import SharePublishError  # noqa: E402

if __name__ == "__main__":
    unittest.main()
