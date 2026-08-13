#!/usr/bin/env python3
"""生成 share 身份清单（浏览统计 V1 用）。

扫描分享私有内容根 items/<shareId>/index.md，输出：
  {schemaVersion:1, baseUrl, generatedAt, items:[{shareId,slug,title,draft}]}

草稿（draft:true）不进入清单 → 统计服务按清单存在性判定「published」。
用法：python3 scripts/build-share-identity-manifest.py <project_root> <out_json>
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("用法：build-share-identity-manifest.py <project_root> <out_json>", file=sys.stderr)
        return 2
    project_root = Path(sys.argv[1]).resolve()
    out_json = Path(sys.argv[2]).resolve()
    sys.path.insert(0, str(project_root))
    sys.path.insert(0, str(project_root / "importer"))

    from studio import share as share_mod
    from share_publisher import web as web_stage  # 仅取 baseURL 语义，未触碰发布

    try:
        share_root = share_mod.share_root(project_root)
    except Exception as error:  # 根目录校验失败（无配置等）
        print(f"share 根目录不可用：{error}", file=sys.stderr)
        return 1

    items: list[dict] = []
    for entry in share_mod.scan_shares(project_root):
        items.append({
            "shareId": entry["shareId"],
            "slug": entry["slug"],
            "title": entry["title"],
            "draft": bool(entry["draft"]),
        })
    items.sort(key=lambda item: item["shareId"])
    manifest = {
        "schemaVersion": 1,
        "baseUrl": os.environ.get("SHARE_BASE_URL", "http://localhost:1314/"),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "itemCount": len(items),
        "items": items,
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    Path(f"{out_json}.sha256").write_text(
        f"{_sha256(out_json)}  {out_json.name}\n", encoding="utf-8"
    )
    print(f"share 身份清单已生成：{out_json}（{len(items)} 项）")
    return 0


def _sha256(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    raise SystemExit(main())
