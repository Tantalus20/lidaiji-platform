"""作者工作台本机凭据存储（v0.2.1 local-bootstrap）。

凭据来源优先级（与任务书一致）：
  1. macOS Keychain（service = cn.lidaiji.studio，account = 管理员用户名）；
  2. 仅本机用户可读的 600 配置文件（macOS/Linux/Windows 通用兜底）；
  3. 启动时环境变量（LIDAIJI_COMMENTS_ADMIN_USERNAME / _PASSWORD）。

约束：
- 任何读取/写入路径都不得把凭据打印到日志或终端；
- 读取失败必须抛出 CredentialError，绝不回退到空字符串或匿名管理员；
- Keychain 使用 macOS 自带 ``security`` CLI，不引入第三方依赖；
- Windows 兜底文件写入时尝试 icacls 收紧为当前用户（尽力而为）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

KEYCHAIN_SERVICE = "cn.lidaiji.studio"
ENV_USERNAME = "LIDAIJI_COMMENTS_ADMIN_USERNAME"
ENV_PASSWORD = "LIDAIJI_COMMENTS_ADMIN_PASSWORD"


class CredentialError(Exception):
    """凭据缺失或不可用；message 不得包含任何秘密。"""


@dataclass(frozen=True)
class CommentsCredentials:
    username: str
    password: str

    def validate(self) -> None:
        if not str(self.username or "").strip() or not str(self.password or ""):
            raise CredentialError("本机凭据为空，拒绝匿名启动管理功能。")
        if str(self.password or "").strip() != self.password:
            raise CredentialError("本机凭据包含首尾空白，格式无效。")


def _credential_file() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "LidaijiStudio"
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA", str(Path.home()))) / "LidaijiStudio"
    else:
        base = Path.home() / ".config" / "lidaiji-studio"
    return base / "comments-admin.json"


def _read_file_credentials() -> CommentsCredentials | None:
    path = _credential_file()
    if not path.is_file():
        return None
    try:
        mode = path.stat().st_mode & 0o777
        if sys.platform != "win32" and mode & 0o077:
            raise CredentialError("本机凭据文件权限过宽（非 600），已拒绝读取。")
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise CredentialError("本机凭据文件无法读取。") from None
    except ValueError:
        raise CredentialError("本机凭据文件格式无效。") from None
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")
    if not username or not password:
        raise CredentialError("本机凭据文件内容为空。")
    return CommentsCredentials(username, password)


def _read_keychain_credentials() -> CommentsCredentials | None:
    if sys.platform != "darwin":
        return None
    try:
        account = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CredentialError("无法访问 macOS Keychain。") from None
    if account.returncode != 0:
        return None  # 条目不存在 → 交给下一个来源
    username = ""
    for line in account.stdout.splitlines():
        line = line.strip()
        if line.startswith('"acct"'):
            username = line.split("=", 1)[-1].strip().strip('"')
            break
    try:
        password = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CredentialError("无法读取 macOS Keychain 条目。") from None
    if password.returncode != 0 or not username:
        raise CredentialError("macOS Keychain 条目不完整。")
    return CommentsCredentials(username, password.stdout.rstrip("\n"))


def read_comments_credentials() -> CommentsCredentials:
    """按 Keychain → 600 文件 → 环境变量 顺序读取；全部缺失或非法时抛错。"""
    sources = ("macOS Keychain", "本机凭据文件", "环境变量")
    candidates = [
        _read_keychain_credentials(),
        _read_file_credentials(),
        _env_credentials(),
    ]
    for source, candidate in zip(sources, candidates):
        if candidate is None:
            continue
        try:
            candidate.validate()
            return candidate
        except CredentialError:
            raise
    raise CredentialError(
        "作者工作台尚未完成本机授权设置。请先运行：npm run studio:setup"
    )


def _env_credentials() -> CommentsCredentials | None:
    username = os.environ.get(ENV_USERNAME, "").strip()
    password = os.environ.get(ENV_PASSWORD, "")
    if not username and not password:
        return None
    return CommentsCredentials(username, password)


def has_comments_credentials() -> bool:
    """只判断“是否可能读取到凭据”，不打印任何内容。"""
    try:
        read_comments_credentials()
        return True
    except CredentialError:
        return False


def store_comments_credentials(username: str, password: str) -> str:
    """写入凭据；返回使用的存储方式说明（用于 setup 命令的反馈文案）。

    macOS 优先 Keychain；其他平台写 600 文件。绝不把凭据回显到终端。
    """
    credentials = CommentsCredentials(username, password)
    credentials.validate()
    if sys.platform == "darwin":
        try:
            result = subprocess.run(
                ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE,
                 "-a", username, "-w", password],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0:
                return "已写入 macOS Keychain（service: cn.lidaiji.studio）。"
            raise CredentialError("macOS Keychain 写入失败。")
        except (OSError, subprocess.TimeoutExpired):
            raise CredentialError("无法访问 macOS Keychain。") from None
    path = _credential_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"username": username, "password": password}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        path.chmod(0o600)
        if os.name == "nt":
            subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{os.environ.get('USERNAME', '')}:(R,W)"],
                capture_output=True, timeout=10,
            )
        return f"已写入本机凭据文件（仅当前用户可读）：{path}"
    except OSError:
        raise CredentialError("本机凭据文件写入失败。") from None


def clear_comments_credentials() -> None:
    """删除本机凭据（Keychain 条目与兜底文件都尝试清理）。"""
    if sys.platform == "darwin":
        subprocess.run(
            ["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE],
            capture_output=True, timeout=10,
        )
    _credential_file().unlink(missing_ok=True)
