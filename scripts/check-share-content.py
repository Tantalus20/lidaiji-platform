#!/usr/bin/env python3
"""分享内容构建前校验：schema、shareId 身份、shareRevision 内容一致性。

任何一项不合格即以非零退出，阻止分享站构建，避免把损坏内容打进发布包。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from studio import share  # noqa: E402


def main() -> int:
    project_root = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT
    try:
        root = share.share_root(project_root)
    except Exception as error:
        print(f"分享内容根不可用：{error}", file=sys.stderr)
        return 1
    items_dir = root / "items"
    if not items_dir.is_dir():
        print(
            f"分享内容校验失败：分享内容根为空（{root}）。请先在 Author Studio「长文分享」新建并保存分享。",
            file=sys.stderr,
        )
        return 1
    errors = share.validate_all(project_root)
    if errors:
        print(f"分享内容校验失败：{len(errors)} 项。", file=sys.stderr)
        for message in errors:
            print(f"- {message}", file=sys.stderr)
        return 1
    count = len(share.scan_shares(project_root))
    print(f"分享内容校验通过：{count} 项（根目录：{root}）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
