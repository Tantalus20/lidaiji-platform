"""作者工作台 Git 集成：只读为主，唯一写入口是显式触发的 ``git_commit``。

安全边界：
- 全部 git 调用走 ``subprocess.run(["git", ...])`` 列表参数，不经过 shell；
  git 不存在（FileNotFoundError）→ ``git-unavailable``；目录不是仓库 →
  ``not-a-repo``；
- 所有接受路径的函数共用 ``_resolve_content_path``：只接受项目相对路径，
  resolve 后必须位于 ``content/`` 内；
- ``ref`` 参数只接受纯小写 commit hash（``^[0-9a-f]{7,40}$``），``;``、
  ``--all`` 等注入一律拒绝；
- ``git_commit`` 仅供用户显式触发：message 非空且 ≤500 字（单个 argv 元素
  传递）；files 逐个校验项目相对、存在于当前 status 列表、不得含 ``..``、
  绝对路径或以 ``-`` 开头；除此之外没有任何其他 git 写操作入口。
"""

from __future__ import annotations

import datetime as dt
import re
import subprocess
from pathlib import Path, PurePosixPath

from studio import articles

GIT_TIMEOUT = 30
MAX_DIFF_BYTES = 2 * 1024 * 1024
MAX_MESSAGE_CHARS = 500
MAX_LOG_LIMIT = 200
DEFAULT_LOG_LIMIT = 50
REF_FORMAT = re.compile(r"^[0-9a-f]{7,40}$")
ARTICLE_INDEX = re.compile(r"^content/.*/index\.md$")


# ---------------------------------------------------------------------------
# 基础：git 调用与仓库校验
# ---------------------------------------------------------------------------


def _run_git(project_root: Path, args: list[str]) -> subprocess.CompletedProcess:
    """运行只读 git 命令；git 缺失/超时转成友好错误。"""
    try:
        return subprocess.run(
            ["git", *args],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
        )
    except FileNotFoundError as error:
        raise articles.ArticleFailure(
            "git-unavailable", "本机找不到 git 命令，版本管理功能不可用。"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise articles.ArticleFailure("internal-error", "git 操作超时，请稍后再试。") from error


def ensure_repo(project_root) -> Path:
    """确认项目根是 git 仓库，返回 resolve 后的项目根。"""
    project_root = Path(project_root).resolve()
    result = _run_git(project_root, ["rev-parse", "--is-inside-work-tree"])
    if result.returncode != 0 or result.stdout.strip() != "true":
        raise articles.ArticleFailure("not-a-repo", "项目目录不是 Git 仓库，版本管理功能不可用。")
    return project_root


def _head_exists(project_root: Path) -> bool:
    return _run_git(project_root, ["rev-parse", "--verify", "HEAD"]).returncode == 0


def _resolve_content_path(project_root: Path, rel_path) -> str:
    """校验并规范化 content/ 内的项目相对路径，返回 posix 相对路径。"""
    text = str(rel_path or "").strip()
    if not text:
        raise articles.ArticleFailure("bad-request", "缺少文件路径。")
    if text.startswith("/") or "\\" in text or re.match(r"^[A-Za-z]:", text):
        raise articles.ArticleFailure("validation-failed", "文件路径必须是项目内的相对路径。")
    pure = PurePosixPath(text)
    if any(part in ("..", "", ".") for part in pure.parts):
        raise articles.ArticleFailure("validation-failed", "文件路径含有非法片段。")
    resolved = (project_root / pure).resolve()
    content_root = (project_root / "content").resolve()
    if resolved != content_root and content_root not in resolved.parents:
        raise articles.ArticleFailure("validation-failed", "文件路径越出了 content/ 范围。")
    return pure.as_posix()


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------


def _parse_porcelain(text: str) -> list[dict]:
    """解析 ``git status --porcelain=v1``（已关闭 quotepath）。"""
    entries = []
    for line in text.splitlines():
        if len(line) < 4:
            continue
        xy = line[:2]
        rest = line[3:]
        original = ""
        if " -> " in rest:
            original, rest = rest.split(" -> ", 1)
        status = "?" if xy == "??" else (xy.strip() or "?")
        entries.append({"path": rest, "status": status, "originalPath": original})
    return entries


def git_status(project_root) -> dict:
    """分支、未提交文件列表（含文件系统修改时间）与 clean 布尔。"""
    project_root = ensure_repo(project_root)
    branch_result = _run_git(project_root, ["symbolic-ref", "--short", "HEAD"])
    branch = branch_result.stdout.strip() if branch_result.returncode == 0 else ""
    if not branch:
        #  detached HEAD：退回短 hash
        rev = _run_git(project_root, ["rev-parse", "--short", "HEAD"])
        branch = f"（detached at {rev.stdout.strip()}）" if rev.returncode == 0 else "（尚无提交）"
    result = _run_git(project_root, ["-c", "core.quotepath=false", "status", "--porcelain=v1"])
    if result.returncode != 0:
        raise articles.ArticleFailure("internal-error", f"git status 失败：{result.stderr.strip()[:200]}")
    entries = _parse_porcelain(result.stdout)
    for entry in entries:
        target = project_root / entry["path"]
        try:
            stamp = target.stat().st_mtime
            entry["mtime"] = dt.datetime.fromtimestamp(stamp).isoformat(timespec="seconds")
        except OSError:
            entry["mtime"] = ""
    return {
        "branch": branch,
        "clean": not entries,
        "files": entries,
        "suggestion": suggest_commit_message(project_root, entries),
    }


# ---------------------------------------------------------------------------
# 历史与 Diff
# ---------------------------------------------------------------------------


def _parse_log(text: str) -> list[dict]:
    commits = []
    for line in text.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 3:
            continue
        full, date, subject = parts
        commits.append({"hash": full, "short": full[:7], "date": date, "subject": subject})
    return commits


def git_log(project_root, rel_path=None, limit: int = DEFAULT_LOG_LIMIT) -> list[dict]:
    """提交历史；rel_path 非空时只列影响该文件的提交（--follow）。"""
    project_root = ensure_repo(project_root)
    try:
        limit = max(1, min(int(limit), MAX_LOG_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LOG_LIMIT
    args = [
        "-c", "core.quotepath=false",
        "log", "--format=%H%x1f%aI%x1f%s", "-n", str(limit),
    ]
    if rel_path:
        # --follow 只允许恰好一个 pathspec
        args += ["--follow", "--", _resolve_content_path(project_root, rel_path)]
    result = _run_git(project_root, args)
    if result.returncode != 0:
        raise articles.ArticleFailure("internal-error", f"git log 失败：{result.stderr.strip()[:200]}")
    return _parse_log(result.stdout)


def _truncate_diff(diff: str) -> tuple[str, bool]:
    raw = diff.encode("utf-8")
    if len(raw) <= MAX_DIFF_BYTES:
        return diff, False
    cut = raw[:MAX_DIFF_BYTES].decode("utf-8", "ignore")
    return cut + "\n……（diff 超过 2MB，已截断，完整内容请在终端查看）\n", True


def git_diff(project_root, rel_path=None, ref=None) -> dict:
    """无 ref → 工作树对 HEAD 的 diff；有 ref → 该提交的 diff（git show）。"""
    project_root = ensure_repo(project_root)
    path_arg = _resolve_content_path(project_root, rel_path) if rel_path else ""
    if ref:
        ref = str(ref).strip()
        if not REF_FORMAT.fullmatch(ref):
            raise articles.ArticleFailure("validation-failed", "提交标识格式不正确。")
        args = ["-c", "core.quotepath=false", "show", "--patch", "--format=%H%x1f%aI%x1f%s", ref]
        if path_arg:
            args += ["--", path_arg]
        result = _run_git(project_root, args)
        if result.returncode != 0:
            raise articles.ArticleFailure("not-found", "找不到这个提交，或提交不属于当前仓库。")
        lines = result.stdout.split("\n")
        meta = lines[0].split("\x1f") if lines else []
        commit = None
        if len(meta) == 3:
            commit = {"hash": meta[0], "short": meta[0][:7], "date": meta[1], "subject": meta[2]}
        diff, truncated = _truncate_diff("\n".join(lines[1:]).lstrip("\n"))
        return {"diff": diff, "truncated": truncated, "commit": commit, "note": ""}

    # 工作树对 HEAD
    status = git_status(project_root)
    untracked = {entry["path"] for entry in status["files"] if entry["status"] == "?"}
    if path_arg and path_arg in untracked:
        return {"diff": "", "truncated": False, "commit": None,
                "note": "这是一个新文件，尚未纳入版本管理，提交后即可查看历史。"}
    if not _head_exists(project_root):
        return {"diff": "", "truncated": False, "commit": None,
                "note": "仓库还没有任何提交，暂无可对比的历史版本。"}
    args = ["-c", "core.quotepath=false", "diff", "HEAD"]
    if path_arg:
        args += ["--", path_arg]
    result = _run_git(project_root, args)
    if result.returncode != 0:
        raise articles.ArticleFailure("internal-error", f"git diff 失败：{result.stderr.strip()[:200]}")
    diff, truncated = _truncate_diff(result.stdout)
    note = ""
    if not diff.strip():
        note = "当前没有未提交的修改。"
    elif not path_arg and untracked:
        listed = "、".join(sorted(untracked)[:10])
        more = f" 等 {len(untracked)} 个" if len(untracked) > 10 else ""
        note = f"另有未跟踪的新文件未包含在 diff 中：{listed}{more}。"
    return {"diff": diff, "truncated": truncated, "commit": None, "note": note}


# ---------------------------------------------------------------------------
# 提交（唯一写入口，仅供用户显式触发）
# ---------------------------------------------------------------------------


def _validate_commit_file(project_root: Path, value) -> str:
    text = str(value or "").strip()
    if not text:
        raise articles.ArticleFailure("validation-failed", "文件路径不能为空。")
    if text.startswith("-"):
        raise articles.ArticleFailure("validation-failed", f"非法的文件路径：{text}")
    if text.startswith("/") or "\\" in text or re.match(r"^[A-Za-z]:", text):
        raise articles.ArticleFailure("validation-failed", f"文件路径必须是项目内的相对路径：{text}")
    pure = PurePosixPath(text)
    if any(part in ("..", "", ".") for part in pure.parts):
        raise articles.ArticleFailure("validation-failed", f"文件路径含有非法片段：{text}")
    resolved = (project_root / pure).resolve()
    if project_root != resolved and project_root not in resolved.parents:
        raise articles.ArticleFailure("validation-failed", f"文件路径越出了项目范围：{text}")
    return pure.as_posix()


def git_commit(project_root, files, message: str) -> dict:
    """对勾选文件执行 ``git add --`` + ``git commit -m``；message 走单个 argv。"""
    project_root = ensure_repo(project_root)
    message = str(message or "").strip()
    if not message:
        raise articles.ArticleFailure("validation-failed", "提交信息不能为空。")
    if len(message) > MAX_MESSAGE_CHARS:
        raise articles.ArticleFailure("validation-failed", f"提交信息不能超过 {MAX_MESSAGE_CHARS} 字。")
    if not isinstance(files, list) or not files:
        raise articles.ArticleFailure("validation-failed", "请先勾选要提交的文件。")
    if len(files) > 1000:
        raise articles.ArticleFailure("validation-failed", "一次提交的文件数量过多。")
    validated = []
    for value in files:
        rel = _validate_commit_file(project_root, value)
        if rel not in validated:
            validated.append(rel)
    # 每个文件必须真实出现在当前未提交列表中（ rename 用新路径）
    current = {entry["path"] for entry in git_status(project_root)["files"]}
    unknown = [rel for rel in validated if rel not in current]
    if unknown:
        raise articles.ArticleFailure(
            "validation-failed", f"文件不在未提交列表中：{'、'.join(unknown[:5])}"
        )
    added = _run_git(project_root, ["add", "--", *validated])
    if added.returncode != 0:
        raise articles.ArticleFailure("write-failed", f"git add 失败：{added.stderr.strip()[:300]}")
    committed = _run_git(project_root, ["commit", "-m", message])
    if committed.returncode != 0:
        detail = (committed.stderr or committed.stdout).strip()[:300]
        raise articles.ArticleFailure("write-failed", f"git commit 失败：{detail}")
    rev = _run_git(project_root, ["rev-parse", "HEAD"])
    full = rev.stdout.strip()
    return {
        "hash": full,
        "short": full[:7],
        "subject": message.splitlines()[0],
        "files": validated,
    }


# ---------------------------------------------------------------------------
# 提交信息建议（纯本地规则）
# ---------------------------------------------------------------------------


def suggest_commit_message(project_root, entries: list[dict] | None = None) -> str:
    """基于未提交文件统计生成建议文案，例如「更新 N 篇文章：第一章、第二章」。"""
    project_root = Path(project_root).resolve()
    if entries is None:
        entries = git_status(project_root)["files"]
    if not entries:
        return ""
    article_paths = [entry["path"] for entry in entries if ARTICLE_INDEX.match(entry["path"])]
    titles: list[str] = []
    if article_paths:
        try:
            title_map = {item["path"]: item["title"] for item in articles.scan_content(project_root)}
        except Exception:
            title_map = {}
        for path in article_paths:
            titles.append(title_map.get(path) or PurePosixPath(path).parent.name)
    shown = "、".join(titles[:5])
    if len(titles) > 5:
        shown += f" 等 {len(titles)} 篇"
    others = len(entries) - len(article_paths)
    if article_paths and others:
        return f"更新 {len(article_paths)} 篇文章：{shown}（另有 {others} 个文件）"
    if article_paths:
        return f"更新 {len(article_paths)} 篇文章：{shown}"
    names = [PurePosixPath(entry["path"]).name for entry in entries[:5]]
    label = "、".join(names)
    if len(entries) > 5:
        label += f" 等 {len(entries)} 个"
    return f"更新 {len(entries)} 个文件：{label}"
