"""分享站网页发布阶段：独立构建 → 候选 → 敏感扫描 → 验证 → current 原子切换。

与正式作品站发布链完全隔离：只调用 scripts/build-share.sh（独立构建），
不触发主站构建、评论 manifest、正式 release。候选目录：
  <out>/share-candidates/<candidateId>/
      site/            ← 不可变构建产物
      manifest.json    ← 逐文件 SHA-256 + candidateId
      manifest.sha256
  <out>/share          ← 符号链接 → 最新候选（原子切换）
  <out>/share.previous ← 上一候选
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

SLUG_RE = re.compile(r"^slug:\s*(.+)$", re.MULTILINE)


def read_slug(share_root: Path, share_id: str) -> str:
    """从私有内容根读取分享项的 slug（只读，不进入仓库）。"""
    index = share_root / "items" / share_id / "index.md"
    if not index.is_file():
        raise FileNotFoundError(f"分享项不存在：{share_id}")
    source = index.read_text(encoding="utf-8")
    if not source.startswith("---\n"):
        raise ValueError(f"分享项缺少 Front Matter：{share_id}")
    fm = source.split("---\n", 2)[1]
    matched = SLUG_RE.search(fm)
    if not matched:
        raise ValueError(f"分享项缺少 slug：{share_id}")
    return matched.group(1).strip().strip('"').strip("'")


def canonical_url(base_url: str, slug: str) -> str:
    base = base_url.rstrip("/") + "/"
    return f"{base}{slug}/"


def build_share_site(project_root: Path, share_root: Path, base_url: str, out_root: Path, timeout: int = 300) -> dict:
    """运行 scripts/build-share.sh；返回 {success, output, candidate, manifest}。

    build-share.sh 内部完成：候选构建 → manifest → 敏感扫描 → 契约验证 →
    current 原子切换。manifest 从最新候选目录读取。
    """
    script = project_root / "scripts" / "build-share.sh"
    if not script.is_file():
        return {"success": False, "output": "缺少 scripts/build-share.sh。", "candidate": "", "manifest": None}
    env = dict(os.environ)
    env["LIDAIJI_SHARE_CONTENT_ROOT"] = str(share_root)
    env["SHARE_BASE_URL"] = base_url
    env["SHARE_OUT"] = str(out_root)
    try:
        result = subprocess.run(
            ["bash", str(script)],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        output = (error.stdout or "") + f"\n（超过 {timeout} 秒，构建已被强制终止）"
        return {"success": False, "output": output[-20000:], "candidate": "", "manifest": None}
    output = (result.stdout or "") + (result.stderr or "")
    candidate = _latest_candidate(out_root)
    manifest = _read_manifest(candidate)
    return {
        "success": result.returncode == 0,
        "output": output[-20000:],
        "candidate": candidate,
        "manifest": manifest,
    }


def _latest_candidate(out_root: Path) -> str:
    candidates = sorted((out_root / "share-candidates").glob("*"))
    return str(candidates[-1]) if candidates else ""


def _read_manifest(candidate: str) -> dict | None:
    if not candidate:
        return None
    manifest_path = Path(candidate) / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        return json_loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def json_loads(text: str):
    import json

    return json.loads(text)


def page_in_manifest(manifest: dict | None, slug: str) -> bool:
    """验证构建产物确实包含该分享页面（URL 验证）。"""
    if not manifest:
        return False
    target = f"{slug}/index.html"
    return any(file.get("path") == target for file in manifest.get("files", []))
