#!/usr/bin/env python3
"""用 PIL 生成“历代纪作者工作台”的本地图标（iconset 目录）。

只使用系统自带字体与本机代码绘制，不联网、不下载任何文件。
用法：icon.py --out <iconset目录>；输出目录需不存在或为空。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as error:  # pragma: no cover - 环境缺 Pillow 时给出可读提示
    print(f"icon: 缺少 Pillow（{error}）", file=sys.stderr)
    sys.exit(1)

SIZES = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}

FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
)

BACKGROUND = (43, 74, 111)
FOREGROUND = (255, 255, 255)
TEXT = "历代纪"
MASTER = 1024
CORNER = 180


def load_font(size: int):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return None


def draw_master() -> Image.Image:
    image = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, MASTER - 1, MASTER - 1), radius=CORNER, fill=BACKGROUND)
    font = load_font(340)
    if font is not None:
        box = draw.textbbox((0, 0), TEXT, font=font)
        width = box[2] - box[0]
        height = box[3] - box[1]
        draw.text(
            ((MASTER - width) / 2 - box[0], (MASTER - height) / 2 - box[1]),
            TEXT,
            font=font,
            fill=FOREGROUND,
        )
    return image


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 macOS 应用图标 iconset。")
    parser.add_argument("--out", required=True, help="iconset 输出目录（将自动创建）")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        print(f"icon: 输出目录非空：{out}", file=sys.stderr)
        return 1

    master = draw_master()
    for name, size in SIZES.items():
        master.resize((size, size), Image.LANCZOS).save(out / name)
    print(f"icon: 已生成 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
