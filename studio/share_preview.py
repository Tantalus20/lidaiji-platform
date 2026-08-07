"""分享站预览进程管理（独立于正式作品站预览，端口 1314）。"""

from __future__ import annotations

import signal
import socket
import subprocess
import time
from pathlib import Path

SHARE_PREVIEW_PORT = 1314
SHARE_PREVIEW_WAIT_SECONDS = 10.0


class SharePreviewError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def port_ready(port: int = SHARE_PREVIEW_PORT, timeout: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def ensure_share_preview(state) -> None:
    """分享站 Hugo 预览未运行时启动它（独立进程组，随工作台退出清理）。"""
    with state.lock:
        process = state.share_preview_process
        if process is not None and process.poll() is None:
            return
        if port_ready():
            return
        script = state.project_root / "scripts" / "preview-share.sh"
        if not script.is_file():
            raise SharePreviewError("validation-failed", "找不到 scripts/preview-share.sh。")
        state.share_preview_process = subprocess.Popen(
            ["bash", str(script)],
            cwd=state.project_root,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def stop_share_preview(state) -> None:
    with state.lock:
        process = state.share_preview_process
        state.share_preview_process = None
        if process is None or process.poll() is not None:
            return
        try:
            import os

            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            try:
                import os

                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def share_preview_status(state) -> dict:
    process = state.share_preview_process
    running = process is not None and process.poll() is None
    return {
        "running": running,
        "port": SHARE_PREVIEW_PORT,
        "url": f"http://127.0.0.1:{SHARE_PREVIEW_PORT}/",
    }
