"""QZone 测试动态清理工具（仅测试环境使用；share-publisher cleanup v0.1.0）。

用途：
  自动发现并删除带有测试标记 ``[LIDAIJI_TEST:<id>]`` 的 QQ 空间说说。
  只服务于 测试 QQ + 测试 NapCat + 开发验收；正式 QQ 禁止使用。

安全边界：
  - 默认 dry-run：只列出候选，绝不删除；删除必须显式 ``--confirm``；
  - 测试账号白名单：必须设置 ``QZONE_TEST_ACCOUNT_ONLY=true``，且 NapCat
    登录账号必须等于 ``NAPCAT_QQ``，否则拒绝执行；
  - 只处理正文含 ``[LIDAIJI_TEST:...]`` 标记的动态；其余动态永远跳过；
  - 不存在「删除全部/最近 N 条/全部图片说说/某日期之前」等批量删除模式；
  - 单条删除失败：继续处理其余动态，最后汇总 success/failed；
  - 幂等：重复运行安全（已删除的动态不再出现，第二次输出 0 候选）；
  - 日志脱敏：不输出 Cookie/账号敏感字段。

真机结论（2026-08-11）：
  动态列表接口可用（emotion_cgi_msglist_v6）；删除接口（emotion_cgi_del_feeds_v6）
  在当前会话上对所有公开参数形态均返回 HTTP 500，NapCat 亦无原生删除动作——
  按任务纪律不逆向，如实报告「无法安全自动删除」；工具仍完整实现流程，
  删除失败按单条失败处理，绝不伪造成功。

用法：
  python -m share_publisher.qzone_cleanup [--project-root <仓库根>] [--confirm]
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "importer"))

TOOL_VERSION = "share-publisher cleanup v0.1.0"
MARKER_RE = re.compile(r"\[LIDAIJI_TEST:([A-Za-z0-9._\-]+)\]")


class CleanupError(Exception):
    """清理工具致命错误（守卫/配置）；不涉及删除失败。"""


@dataclass
class Candidate:
    tid: str
    marker: str
    created_time: object
    title: str

    def created_label(self) -> str:
        if isinstance(self.created_time, (int, float)) and self.created_time:
            try:
                return datetime.fromtimestamp(int(self.created_time)).strftime("%Y-%m-%d %H:%M")
            except (ValueError, OSError, OverflowError):
                pass
        return str(self.created_time or "")


@dataclass
class CleanupResult:
    dry_run: bool
    candidates: list[Candidate] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    remaining: int = 0

    @property
    def found(self) -> int:
        return len(self.candidates)


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default) or default


def guard_test_account(adapter) -> str:
    """测试账号白名单：QZONE_TEST_ACCOUNT_ONLY=true 且登录 QQ == NAPCAT_QQ。"""
    if _env("QZONE_TEST_ACCOUNT_ONLY") != "true":
        raise CleanupError(
            "拒绝执行：QZONE_TEST_ACCOUNT_ONLY 未设为 true（清理工具仅限测试账号使用）。"
        )
    expected = _env("NAPCAT_QQ", "")
    if not expected:
        raise CleanupError("拒绝执行：缺少 NAPCAT_QQ（未配置测试账号）。")
    login = adapter.fetch_login_info()
    actual = str(login.get("user_id") or "")
    if not actual:
        raise CleanupError("拒绝执行：NapCat 未返回登录 QQ 号。")
    if actual != str(expected):
        raise CleanupError(
            f"正式账号保护：当前登录 QQ {actual} ≠ 测试账号 {expected}，拒绝执行。"
        )
    return actual


def discover_candidates(adapter, cookie: str, max_pages: int = 5, page_size: int = 40) -> list[Candidate]:
    """拉取动态 → 解析测试标记 → 候选列表（不删除）。"""
    candidates: list[Candidate] = []
    for post in adapter.list_own_posts(cookie, page_size=page_size, max_pages=max_pages):
        matched = MARKER_RE.search(post.get("content") or "")
        if not matched:
            continue
        title = (post.get("content") or "").strip().replace("\n", " ")[:40]
        candidates.append(Candidate(
            tid=post.get("tid", ""),
            marker=matched.group(1),
            created_time=post.get("created_time"),
            title=title,
        ))
    candidates.sort(key=lambda c: c.created_time or 0)
    return candidates


def run_cleanup(adapter, *, confirm: bool = False, max_pages: int = 5, page_size: int = 40) -> CleanupResult:
    """完整流程：守卫 → 列表 → 解析 → dry-run 输出 / 逐条删除 → 复查。"""
    guard_test_account(adapter)
    cookie = adapter.fetch_cookie()
    candidates = discover_candidates(adapter, cookie, max_pages=max_pages, page_size=page_size)
    result = CleanupResult(dry_run=not confirm, candidates=candidates)
    if not confirm:
        return result
    for candidate in candidates:
        try:
            adapter.delete_post(candidate.tid, cookie)
            result.deleted.append(candidate.tid)
        except Exception as error:  # 单条失败继续处理其余
            code = getattr(error, "code", "delete-failed")
            message = getattr(error, "message", str(error))
            result.failed.append((candidate.tid, f"{code}: {message}"))
    if result.deleted or result.failed:
        remaining = discover_candidates(adapter, cookie, max_pages=max_pages, page_size=page_size)
        result.remaining = len(remaining)
    return result


def format_candidate(index: int, candidate: Candidate) -> str:
    return (
        f"[{index}]\n"
        f"post_id:   {candidate.tid}\n"
        f"marker:    LIDAIJI_TEST:{candidate.marker}\n"
        f"created:   {candidate.created_label()}\n"
        f"title:     {candidate.title}"
    )


def render(result: CleanupResult) -> str:
    """把结果渲染为脱敏文本（测试断言与 CLI 共用）。"""
    lines: list[str] = []
    if result.candidates:
        lines.append("发现测试动态：")
        lines.append("")
        for index, candidate in enumerate(result.candidates, start=1):
            lines.append(format_candidate(index, candidate))
            lines.append("")
        lines.append(f"共 {result.found} 条。")
        if result.dry_run:
            lines.append("dry-run 模式：未删除任何内容；确认删除请加 --confirm。")
        else:
            lines.append("开始逐条删除……")
            lines.append(f"success: {len(result.deleted)}")
            lines.append(f"failed: {len(result.failed)}")
            if result.failed:
                lines.append("failed ids:")
                for tid, reason in result.failed:
                    lines.append(f"  {tid}  {reason}")
            lines.append(f"删除后复查：剩余 {result.remaining} 条候选。")
    else:
        lines.append("发现 0 条候选，无需清理。")
    return "\n".join(lines)


def build_adapter(project_root: Path):
    from share_publisher import qzone as qzone_mod

    return qzone_mod.QzoneAdapter(qzone_mod.QzoneAdapterConfig(
        napcat_http_url=_env("NAPCAT_HTTP_URL"),
        qq_account=_env("NAPCAT_QQ"),
        access_token=_env("NAPCAT_ACCESS_TOKEN"),
    ))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="qzone_cleanup",
        description="QQ 空间测试动态清理工具（仅测试环境；正式 QQ 禁止使用）。",
    )
    parser.add_argument("--project-root", type=Path, default=ROOT)
    parser.add_argument("--confirm", action="store_true", help="确认删除（缺省为 dry-run，绝不删除）")
    parser.add_argument("--max-pages", type=int, default=5, help="列表最多翻页数（默认 5）")
    args = parser.parse_args(argv)

    print(f"{TOOL_VERSION}")
    try:
        result = run_cleanup(
            build_adapter(args.project_root),
            confirm=args.confirm,
            max_pages=args.max_pages,
        )
    except CleanupError as error:
        print(error)
        return 2
    print(render(result))
    if args.confirm and result.failed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
