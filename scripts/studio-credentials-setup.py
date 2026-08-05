#!/usr/bin/env python3
"""一次性本机凭据设置：npm run studio:setup。

把《历代纪》评论服务管理员凭据写入 macOS Keychain（其他平台写入
仅当前用户可读的 600 文件）。凭据绝不回显到终端，绝不写入日志。
"""

from __future__ import annotations

import getpass
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from studio.credentials import (  # noqa: E402
    CredentialError,
    clear_comments_credentials,
    read_comments_credentials,
    store_comments_credentials,
)


def main() -> int:
    print("《历代纪》作者工作台 · 本机授权设置")
    print("将写入评论服务管理员凭据（macOS Keychain / 本机 600 文件），输入不会被回显。")
    username = ""
    while not username.strip():
        username = input("评论服务管理员用户名：").strip()
    password = getpass.getpass("评论服务管理员密码：")
    confirm = getpass.getpass("再次输入密码确认：")
    if password != confirm:
        print("两次输入的密码不一致，未写入任何内容。", file=sys.stderr)
        return 1
    try:
        message = store_comments_credentials(username, password)
    except CredentialError as error:
        print(f"写入失败：{error}", file=sys.stderr)
        return 1
    print(message)
    print("已配置。启动工作台（npm run studio）后将自动完成授权，无需再输入账号密码。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
