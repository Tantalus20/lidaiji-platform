"""作者工作台启动入口：python -m studio [--port 4173] [--no-browser] [--project-root ..]"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path

from studio.server import AUTH_MODES, DEFAULT_PORT, create_server
from tools.workspace import resolve_workspace


def main() -> int:
    parser = argparse.ArgumentParser(prog="studio", description="《历代纪》本地作者工作台（Word 导入中心）。")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口（默认 {DEFAULT_PORT}）")
    parser.add_argument("--host", default="127.0.0.1", help="绑定地址；只允许本机回环地址")
    parser.add_argument("--project-root", type=Path, default=_HERE_PARENT, help="项目根目录（默认仓库根）")
    parser.add_argument("--content-repo-root", help="私人内容仓库；优先于环境变量和工作区配置")
    parser.add_argument("--content-root", help="内容目录；优先于环境变量和工作区配置")
    parser.add_argument("--author-notes-root", help="作者评目录；优先于环境变量和工作区配置")
    parser.add_argument("--site-overrides-root", help="私人站点覆盖配置目录")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    args = parser.parse_args()

    auth_mode = os.environ.get("STUDIO_AUTH_MODE", "local-bootstrap").strip()
    if auth_mode not in AUTH_MODES:
        print(f"启动失败：STUDIO_AUTH_MODE 只能是 {'/'.join(AUTH_MODES)}。", file=sys.stderr)
        return 2
    if auth_mode == "local-bootstrap" and not is_loopback_host(args.host):
        print("启动失败：local-bootstrap 模式只允许监听 127.0.0.1/::1。", file=sys.stderr)
        return 2

    try:
        workspace = resolve_workspace(
            args.project_root,
            {
                "contentRepoRoot": args.content_repo_root,
                "contentRoot": args.content_root,
                "authorNotesRoot": args.author_notes_root,
                "siteOverridesRoot": args.site_overrides_root,
            },
            writable_demo=True,
        )
        server = create_server(
            workspace.contentRepoRoot,
            host=args.host,
            port=args.port,
            platform_root=workspace.platformRoot,
            workspace_mode=workspace.mode,
            workspace_label=workspace.label,
            workspace_environment=workspace.environment(),
        )
        server.state.auth_mode = auth_mode
    except ValueError as error:
        print(f"启动失败：{error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"启动失败：{error}", file=sys.stderr)
        return 2

    url = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"《历代纪》作者工作台已启动 {url}", flush=True)
    print(f"AUTH_MODE={auth_mode} 监听地址={args.host}:{server.server_address[1]} 上游已配置={upstream_configured_hint()}", flush=True)
    print(workspace.label, flush=True)
    print("按 Control+C 停止；停止时会自动清理临时文件与预览进程。", flush=True)
    if not args.no_browser and sys.platform == "darwin":
        subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # SIGTERM 也走 finally 清理（临时会话目录 + Hugo 预览进程组），避免残留
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        server.server_close()
    print("作者工作台已停止。", flush=True)
    return 0


def is_loopback_host(host: str) -> bool:
    from studio.server import is_loopback
    return is_loopback(host)


def upstream_configured_hint() -> str:
    """只输出布尔提示，不读取/打印任何凭据。"""
    try:
        from studio import credentials
        credentials.read_comments_credentials()
        return "yes"
    except Exception:
        return "no"


_HERE_PARENT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    raise SystemExit(main())
