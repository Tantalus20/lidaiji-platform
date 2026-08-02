"""作者工作台发布中心：只包装既有 scripts/build.sh、check.sh、publish.sh，不改造它们。

安全边界：
- ``.author-settings`` 只解析 ``WRITING_`` 前缀的 KEY=VALUE 行；任何密钥值
  永远不进入接口返回（``publish_status`` 只返回"是否存在/是否已配置"布尔）；
- 发布前检查与发布都是同步子进程：build 180s / check 900s / publish 900s
  超时，输出只保留尾部，失败原样返回；
- 发布运行要求：调用方显式 confirm=True（server 层校验）+ 本会话 30 分钟
  内有一次成功的 preflight（server 层按 StudioState 时间戳校验）；
- ``scripts/publish.sh`` 本身有交互确认（输入"发布"），工作台已在界面上完成
  二次确认，因此以 ``WRITING_ASSUME_CONFIRM=1`` 非交互运行，stdin 关闭，
  禁止任何流式中途交互。
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path

from studio import articles, notes, versions

BUILD_TIMEOUT = 180
CHECK_TIMEOUT = 900
PUBLISH_TIMEOUT = 900
MAX_OUTPUT_CHARS = 60000
REQUIRED_SETTING_KEYS = ("WRITING_SSH_TARGET", "WRITING_DOMAIN")
CHANGELOG_HEADING = re.compile(r"^##\s+(V[\d.]+)\s*(.*)$")
DATE_LINE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _tail(text: str) -> str:
    text = text or ""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return "……（早期输出已省略）\n" + text[-MAX_OUTPUT_CHARS:]


# ---------------------------------------------------------------------------
# .author-settings（只读解析，值不出本模块）
# ---------------------------------------------------------------------------


def read_settings(project_root) -> dict:
    """解析项目根 .author-settings 的 WRITING_ 前缀 KEY=VALUE 行。"""
    project_root = Path(project_root).resolve()
    path = project_root / ".author-settings"
    settings: dict[str, str] = {}
    if not path.is_file():
        return settings
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("WRITING_"):
            settings[key] = value.strip().strip('"').strip("'")
    return settings


# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------


def _changelog_entries(project_root: Path, count: int = 3) -> list[dict]:
    """解析 CHANGELOG.md 的 ``## V...`` 标题行（+紧随的日期行，如有）。"""
    path = project_root / "CHANGELOG.md"
    if not path.is_file():
        return []
    entries: list[dict] = []
    current: dict | None = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        heading = CHANGELOG_HEADING.match(line)
        if heading:
            current = {"version": heading.group(1), "title": heading.group(2).strip(), "date": ""}
            entries.append(current)
            continue
        if current is not None and not current["date"]:
            matched = DATE_LINE.search(line)
            if matched:
                current["date"] = matched.group(1)
    return entries[:count]


def publish_status(project_root, content_repo_root=None) -> dict:
    """本地版本、最近发布记录、最近提交与服务器配置状态（布尔，不含密钥值）。"""
    project_root = Path(project_root).resolve()
    version_file = project_root / "VERSION"
    version = version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else ""
    settings = read_settings(project_root)
    configured_keys = {key: bool(settings.get(key)) for key in REQUIRED_SETTING_KEYS}
    try:
        commits = versions.git_log(Path(content_repo_root or project_root).resolve(), limit=5)
        git_error = ""
    except articles.ArticleFailure as error:
        commits = []
        git_error = error.message
    return {
        "version": version,
        "changelog": _changelog_entries(project_root),
        "commits": commits,
        "gitError": git_error,
        "settings": {
            "filePresent": (project_root / ".author-settings").is_file(),
            "hasSshTarget": configured_keys["WRITING_SSH_TARGET"],
            "hasDomain": configured_keys["WRITING_DOMAIN"],
            "configured": all(configured_keys.values()),
        },
    }


# ---------------------------------------------------------------------------
# 发布前检查与发布
# ---------------------------------------------------------------------------


def _run_script(project_root: Path, script: str, timeout: int, env: dict | None = None) -> dict:
    start = time.monotonic()
    try:
        result = subprocess.run(
            ["bash", script],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        output = error.stdout or ""
        if isinstance(output, bytes):
            output = output.decode("utf-8", "replace")
        return {
            "success": False,
            "output": _tail(output + f"\n（超过 {timeout} 秒，已被强制终止）"),
            "duration": round(time.monotonic() - start, 1),
            "timedOut": True,
            "script": script,
        }
    output = result.stdout or ""
    if result.stderr:
        output += ("\n" if output else "") + result.stderr
    return {
        "success": result.returncode == 0,
        "output": _tail(output),
        "duration": round(time.monotonic() - start, 1),
        "timedOut": False,
        "script": script,
    }


def run_preflight(project_root, full: bool, content_repo_root=None, workspace_environment: dict | None = None) -> dict:
    """跑 scripts/build.sh（full=True 时 scripts/check.sh），同步等待。

    跑脚本前先检查失效批注：已发布段落评的锚点若已不在正文中，前台会静默
    丢批注，此时 preflight 直接失败（success=false），run_publish 的
    30 分钟门控自然阻止发布。
    """
    project_root = Path(project_root).resolve()
    script = "scripts/check.sh" if full else "scripts/build.sh"
    if not (project_root / script).is_file():
        raise articles.ArticleFailure("validation-failed", f"找不到 {script}。")
    broken = notes.broken_notes(Path(content_repo_root or project_root).resolve())
    if broken:
        lines = ["发布前检查未开始：有已发布的作者批注挂在已不存在的段落上（前台不会显示）："]
        for item in broken:
            lines.append(
                f"- 《{item['title']}》（{item['path']}）批注 {item['id']} "
                f"→ 不存在的段落 {item['paragraphId']}：{item['excerpt']}"
            )
        lines.append("请在编辑页「作者评」面板把它们改为草稿、重新关联段落或删除后，再重新运行发布前检查。")
        return {
            "success": False,
            "output": "\n".join(lines),
            "duration": 0.0,
            "timedOut": False,
            "script": script,
        }
    environment = dict(os.environ)
    environment.update(workspace_environment or {})
    return _run_script(project_root, script, CHECK_TIMEOUT if full else BUILD_TIMEOUT, environment)


def run_publish(project_root, workspace_environment: dict | None = None) -> dict:
    """同步跑 scripts/publish.sh；缺配置直接报错不启动，失败原样返回日志。"""
    project_root = Path(project_root).resolve()
    if not (project_root / "scripts" / "publish.sh").is_file():
        raise articles.ArticleFailure("validation-failed", "找不到 scripts/publish.sh。")
    settings = read_settings(project_root)
    missing = [key for key in REQUIRED_SETTING_KEYS if not settings.get(key)]
    if missing:
        raise articles.ArticleFailure(
            "validation-failed",
            f".author-settings 缺少 {'、'.join(missing)}，请先在项目根的 .author-settings "
            "文件中配置（格式：KEY=VALUE，每行一条）。",
        )
    env = dict(os.environ)
    env.update(settings)
    env.update(workspace_environment or {})
    # 界面已完成二次确认；publish.sh 的交互“输入发布”在此非交互跳过
    env["WRITING_ASSUME_CONFIRM"] = "1"
    start = time.monotonic()
    process = subprocess.Popen(
        ["bash", "scripts/publish.sh"],
        cwd=project_root,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        output, _ = process.communicate(timeout=PUBLISH_TIMEOUT)
        timed_out = False
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate()
        output = (output or "") + f"\n（超过 {PUBLISH_TIMEOUT} 秒，已被强制终止）"
        timed_out = True
    return {
        "success": process.returncode == 0 and not timed_out,
        "output": _tail(output or ""),
        "duration": round(time.monotonic() - start, 1),
        "timedOut": timed_out,
        "script": "scripts/publish.sh",
    }
