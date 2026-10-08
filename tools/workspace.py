#!/usr/bin/env python3
"""解析并物化《历代纪》平台/内容双仓库工作区。"""

from __future__ import annotations
# Windows 控制台默认 GBK/cp936 无法编码中文输出；统一强制 UTF-8（跨平台一致）。
import sys
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")
import argparse
import json
import os
import shutil
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


CONFIG_NAME = ".lidaiji-workspace.json"
ENV_KEYS = {
    "contentRepoRoot": "LIDAIJI_CONTENT_REPO_ROOT",
    "contentRoot": "LIDAIJI_CONTENT_ROOT",
    "authorNotesRoot": "LIDAIJI_AUTHOR_NOTES_ROOT",
    "siteOverridesRoot": "LIDAIJI_SITE_OVERRIDES_ROOT",
    "outputRoot": "LIDAIJI_DIST_ROOT",
}
# auto：有工作区配置即 private，否则 demo（公开克隆/CI 的既有行为）。
# private：必须有合法工作区，缺失即 fail-closed，绝不落到平台仓库 content/。
# demo：显式演示模式，忽略工作区配置。
WORKSPACE_MODES = ("auto", "private", "demo")


@dataclass(frozen=True)
class Workspace:
    platformRoot: str
    contentRepoRoot: str
    contentRoot: str
    authorNotesRoot: str
    siteOverridesRoot: str
    outputRoot: str
    mode: str
    label: str

    def environment(self) -> dict[str, str]:
        values = asdict(self)
        return {environment: values[key] for key, environment in ENV_KEYS.items()}


def _load_config(platform_root: Path) -> dict:
    path = platform_root / CONFIG_NAME
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{CONFIG_NAME} 无法读取：{error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"{CONFIG_NAME} 必须是JSON对象。")
    return data


def _resolve_path(value: str, platform_root: Path) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = platform_root / path
    return path.resolve()


def resolve_workspace(
    platform_root: Path,
    overrides: dict | None = None,
    writable_demo: bool = False,
    mode: str | None = None,
) -> Workspace:
    """按 命令行覆盖→环境变量→配置文件 解析工作区；无配置时按模式进入演示。

    ``private`` 模式 fail-closed：缺少合法工作区直接报错，绝不回退到平台仓库内容。
    """
    platform_root = Path(platform_root).resolve()
    requested = str(mode or os.environ.get("LIDAIJI_WORKSPACE_MODE", "") or "auto").strip().lower()
    if requested not in WORKSPACE_MODES:
        raise ValueError("工作区模式只能是 auto/private/demo。")
    config = {} if requested == "demo" else _load_config(platform_root)
    chosen: dict[str, str] = {}
    if requested != "demo":
        for key, environment in ENV_KEYS.items():
            value = (overrides or {}).get(key) or os.environ.get(environment) or config.get(key)
            if value:
                chosen[key] = str(value)
    if requested == "private" and "contentRepoRoot" not in chosen:
        raise ValueError(
            "私人模式要求有效的 .lidaiji-workspace.json（或 --content-repo-root / "
            "LIDAIJI_CONTENT_REPO_ROOT）；不会回退到平台仓库内容。"
        )

    if "contentRepoRoot" not in chosen:
        output_root = str(platform_root / "dist")
        if writable_demo:
            demo_repo = platform_root / ".cache" / "studio-demo-workspace"
            content = demo_repo / "content"
            notes = demo_repo / "data" / "author-notes"
            if not content.exists():
                content.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(platform_root / "examples" / "demo-content", content)
            if not notes.exists():
                notes.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(platform_root / "examples" / "demo-author-notes", notes)
            overrides_root = platform_root / "examples" / "demo-site-overrides"
            return Workspace(
                str(platform_root), str(demo_repo), str(content), str(notes), str(overrides_root),
                output_root, "demo", "演示内容（临时副本）",
            )
        # 只读演示：contentRepoRoot 指向缓存占位目录而非平台仓库根；
        # 任何按 project_root/content 的写入都会失败，而不会落到平台内容。
        return Workspace(
            str(platform_root), str(platform_root / ".cache" / "studio-demo-workspace"),
            str((platform_root / "examples" / "demo-content").resolve()),
            str((platform_root / "examples" / "demo-author-notes").resolve()),
            str((platform_root / "examples" / "demo-site-overrides").resolve()),
            output_root, "demo", "演示内容",
        )

    for key in ENV_KEYS:
        configured = config.get(key)
        if configured and Path(str(configured)).expanduser().is_absolute():
            raise ValueError(f"{CONFIG_NAME} 的 {key} 必须使用相对路径，不要记录私人绝对路径。")

    repo = _resolve_path(chosen["contentRepoRoot"], platform_root)
    content = _resolve_path(chosen.get("contentRoot", str(repo / "content")), platform_root)
    notes = _resolve_path(chosen.get("authorNotesRoot", str(repo / "data" / "author-notes")), platform_root)
    site_overrides = _resolve_path(chosen.get("siteOverridesRoot", str(repo / "site-overrides")), platform_root)
    output_root = _resolve_path(chosen.get("outputRoot", str(platform_root / "dist")), platform_root)
    if not repo.is_dir() or not content.is_dir():
        raise ValueError("私人内容仓库或content目录不存在。")
    if repo not in content.parents:
        raise ValueError("contentRoot必须位于contentRepoRoot内。")
    if repo not in notes.parents or repo not in site_overrides.parents:
        raise ValueError("作者评和站点覆盖目录必须位于contentRepoRoot内。")
    if content != (repo / "content").resolve() or notes != (repo / "data" / "author-notes").resolve():
        raise ValueError("当前版本要求contentRoot和authorNotesRoot使用私人仓库的标准目录结构。")
    notes.mkdir(parents=True, exist_ok=True)
    site_overrides.mkdir(parents=True, exist_ok=True)
    return Workspace(
        str(platform_root), str(repo), str(content), str(notes), str(site_overrides),
        str(output_root), "private", f"私人内容仓库：{repo.name}",
    )


def _flat_yaml(path: Path) -> dict[str, str]:
    """读取仅含一层标量的私人覆盖文件；拒绝复杂或歧义结构。"""
    if not path.is_file():
        return {}
    result: dict[str, str] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"{path.name}:{number} 不是 key: value。")
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if not key.replace("_", "").isalnum():
            raise ValueError(f"{path.name}:{number} 键名不安全。")
        result[key] = value
    return result


def _toml_scalar(value) -> str:
    """把 TOML 标量值序列化为字面量（字符串一律用 JSON 引号保证 UTF-8 安全）。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list) and all(not isinstance(item, (dict, list)) for item in value):
        return "[" + ", ".join(_toml_scalar(item) for item in value) + "]"
    raise ValueError(f"不支持的TOML值类型：{type(value).__name__}")


def is_table(value) -> bool:
    return isinstance(value, dict) or (
        isinstance(value, list) and bool(value) and all(isinstance(item, dict) for item in value)
    )


def _write_toml(data: dict) -> str:
    """把 tomllib 解析结果写回为规范 TOML（标量、表、表数组；不写注释）。

    Hugo 只要求合法 TOML，不依赖注释或原格式；覆盖后的配置以本函数输出为准。
    """
    lines: list[str] = []

    def emit(prefix: str, obj: dict) -> None:
        for key, value in obj.items():
            if not prefix and not is_table(value):
                continue  # 根级标量已在前面写出，避免重复键
            full = f"{prefix}{key}"
            if isinstance(value, dict):
                lines.append(f"[{full}]")
                emit(f"{full}.", value)
            elif isinstance(value, list) and bool(value) and all(isinstance(item, dict) for item in value):
                for item in value:
                    lines.append(f"[[{full}]]")
                    emit(f"{full}.", item)
            else:
                lines.append(f"{key} = {_toml_scalar(value)}")

    for key, value in data.items():
        if not is_table(value):
            lines.append(f"{key} = {_toml_scalar(value)}")
    if any(not is_table(value) for value in data.values()):
        lines.append("")
    emit("", data)
    return "\n".join(lines).rstrip() + "\n"


def _merge_config_toml(path: Path, overrides: dict) -> None:
    """把私有仓库的平面覆盖合并进 Hugo 真实读取的配置文件。

    关键点（v0.5.1 修复）：Hugo 只加载 config/_default/ 下的特殊文件名
    （config/menus/params/…）。此前生成的 zz-workspace.toml 被 Hugo 静默忽略，
    导致私有品牌（title/baseURL/params）从未生效。这里改为直接合并进
    hugo.toml / params.toml，使覆盖真正进入构建。
    """
    import tomllib

    with path.open("rb") as handle:
        data = tomllib.load(handle)
    for key, value in overrides.items():
        if key in data and is_table(data[key]):
            raise ValueError(f"覆盖键{key}与配置表冲突。")
        if key == "languageCode":
            # Hugo 0.158+ 弃用 languageCode，统一映射到 locale，避免构建警告。
            data["locale"] = value
            continue
        data[key] = value
    path.write_text(_write_toml(data), encoding="utf-8")


def materialize(workspace: Workspace, destination: Path) -> Path:
    """在新的空临时目录中用链接组合平台代码与内容，不复制私人正文。"""
    platform = Path(workspace.platformRoot)
    destination = Path(destination).resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("物化目标必须是空目录。")
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("archetypes", "assets", "layouts", "static", "themes"):
        source = platform / name
        if source.exists():
            (destination / name).symlink_to(source, target_is_directory=True)
    (destination / "content").symlink_to(Path(workspace.contentRoot), target_is_directory=True)
    data = destination / "data"
    data.mkdir()
    # 作者评隐私规则（v0.2.5 收口）：作者评默认且始终属于私有内容，
    # 不进入 Hugo 输入目录；data/author-notes 在物化时留空。
    (data / "author-notes").mkdir(exist_ok=True)
    shutil.copytree(platform / "config", destination / "config")
    site = _flat_yaml(Path(workspace.siteOverridesRoot) / "site.yaml")
    branding = _flat_yaml(Path(workspace.siteOverridesRoot) / "branding.yaml")
    if site:
        _merge_config_toml(destination / "config" / "_default" / "hugo.toml", site)
    if branding:
        _merge_config_toml(destination / "config" / "_default" / "params.toml", branding)
    (destination / "workspace.json").write_text(
        json.dumps(asdict(workspace), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="解析《历代纪》双仓库工作区。")
    parser.add_argument("action", choices=("show", "materialize"))
    parser.add_argument("--platform-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--content-repo-root")
    parser.add_argument("--content-root")
    parser.add_argument("--author-notes-root")
    parser.add_argument("--site-overrides-root")
    parser.add_argument("--output-root", help="构建产物根目录；默认平台 dist/")
    parser.add_argument("--mode", choices=WORKSPACE_MODES, help="工作区模式；默认 auto")
    parser.add_argument("--writable-demo", action="store_true")
    args = parser.parse_args()
    overrides = {
        "contentRepoRoot": args.content_repo_root,
        "contentRoot": args.content_root,
        "authorNotesRoot": args.author_notes_root,
        "siteOverridesRoot": args.site_overrides_root,
        "outputRoot": args.output_root,
    }
    try:
        workspace = resolve_workspace(args.platform_root, overrides, args.writable_demo, mode=args.mode)
        if args.action == "materialize":
            if not args.destination:
                raise ValueError("materialize需要--destination。")
            materialize(workspace, args.destination)
        print(json.dumps(asdict(workspace), ensure_ascii=False))
    except ValueError as error:
        print(f"工作区配置错误：{error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
