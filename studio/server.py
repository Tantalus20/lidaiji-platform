"""作者工作台 HTTP 服务：标准库 http.server 实现，只监听 127.0.0.1。

安全边界：
- 绑定地址强制回环，``--host`` 传入任何非回环地址都会被拒绝；
- 所有请求在路由前精确校验当前端口的回环 Host，API 另要求首页初始化的
  仅内存会话 Cookie，阻断 DNS rebinding 与跨站读取；
- 所有 POST /api/* 要求自定义头 ``X-Studio-Request: 1`` 与 ``X-Studio-CSRF``
  （与进程绑定的不可预测令牌），且若带 Origin 头必须指向
  127.0.0.1/localhost（CSRF 防线）；不发送任何 CORS 头；
- 认证模式（STUDIO_AUTH_MODE）：
  * local-bootstrap（默认）：启动即授权——本机会话在首次回环导航时签发，
    评论服务管理员登录由网关服务端从本机凭据源自动完成，浏览器不显示
    登录表单，也不接触任何上游凭据/会话；
  * password：保留原有账号密码登录流程（故障排查/特殊部署用）。
- 上传只认 .docx：魔数、必备部件、100MB 大小上限、500MB 解压总量上限，
  全部内存校验，不解压落盘（无 Zip Slip 面）；文件名仅用于显示；
- 前端只能传 token 与元数据字段，任何「路径」字段一律拒绝；
- 图片接口的 name 走白名单正则，token 走固定格式校验，无路径穿越面。

进程内直接调用 importer/import_stages.py 的三阶段管线（sys.path 注入
importer/ 后 import import_stages），不走子进程。
"""

from __future__ import annotations

import atexit
import hmac
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile
from dataclasses import dataclass, field
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_IMPORTER = _HERE.parent / "importer"
if str(_IMPORTER) not in sys.path:
    sys.path.insert(0, str(_IMPORTER))

import import_stages  # noqa: E402
from import_api import document_info  # noqa: E402

from studio import articles  # noqa: E402
from studio import credentials, feedback, media, notes, publish_article, publish_center, versions  # noqa: E402
from studio import share as share_articles  # noqa: E402
from studio import share_preview  # noqa: E402
from studio.preview_render import render_markdown  # noqa: E402

from share_publisher import api as share_api  # noqa: E402

DEFAULT_PORT = 4173
AUTH_MODES = ("local-bootstrap", "password")
SESSION_MAX_AGE_SECONDS = 8 * 3600  # 本地会话最长 8 小时；进程退出即失效优先
MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100MB，与 parse_docx 一致
MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024  # 压缩炸弹防护
MAX_JSON_BYTES = 1024 * 1024
MAX_RENDER_BYTES = 2 * 1024 * 1024  # 编辑器实时预览/保存的请求体上限
MAX_MEDIA_UPLOAD_BYTES = 21 * 1024 * 1024  # 媒体库上传：20MB 图片 + multipart 开销
PREFLIGHT_FRESH_SECONDS = 30 * 60  # preflight 结果保鲜期，超时发布前必须重跑
PREVIEW_PORT = 1313
PREVIEW_WAIT_SECONDS = 8.0
REQUIRED_ZIP_PARTS = {"[content_types].xml", "word/document.xml"}
ASSET_NAME = re.compile(r"^image-\d{3}\.(?:webp|png|jpe?g|gif|svg)$")
TOKEN_FORMAT = re.compile(r"^[0-9a-f]{32}$")
DATE_FORMAT = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CANONICAL_PATH = re.compile(r"^/[a-z0-9/_-]*/$")
PARAGRAPH_ID = re.compile(r"^p-[0-9a-f]{12}$")
LOOPBACK_HOSTS = {"localhost"}
STUDIO_SESSION_COOKIE = "lidaiji_studio_session"
STUDIO_CSRF_HEADER = "X-Studio-CSRF"
STATIC_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}
CSP_HEADER = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app-bundle.js": ("app-bundle.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/vendor/prosemirror-bundle.js": ("vendor/prosemirror-bundle.js", "text/javascript; charset=utf-8"),
}
ASSET_MEDIA_TYPES = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}
# 元数据白名单：前端只允许这些字段；任何路径类字段都不存在于此，天然被拒。
METADATA_FIELDS = {
    "title",
    "subtitle",
    "slug",
    "section",
    "collections",
    "collectionSlug",
    "description",
    "date",
    "weight",
    "draft",
    "articleId",
}
SECTIONS = ("works", "essays", "archives")

HTTP_BY_CODE = {
    "invalid-source": 400,
    "validation-failed": 400,
    "confirmation-required": 400,
    "conflict": 409,
    "write-failed": 500,
    "forbidden": 403,
    "not-found": 404,
    "bad-request": 400,
    "payload-too-large": 413,
    "preview-failed": 500,
    "git-unavailable": 500,
    "not-a-repo": 409,
    "preflight-required": 409,
    "internal-error": 500,
    "not-logged-in": 401,
    "login-failed": 401,
    "rate-limited": 429,
    "service-unavailable": 503,
    "service-error": 502,
}


class StudioError(Exception):
    """可直接转成 JSON 错误响应的失败。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# 工作台持久状态（会话清扫必须保留）：
# - backups/ trash/：既有保留目录；
# - candidates/：隔离发布候选（跨重启可读，任务书 16.10）；
# - publish-logs/：发布完整日志（下载入口）；
# - publish-history.json：发布账本（幂等/历史依据）。
_PERSISTENT_CACHE_ENTRIES = frozenset(
    {"backups", "trash", "candidates", "publish-logs", "publish-history.json"})


def sweep_cache(cache_root: Path) -> None:
    """清扫会话缓存目录，但保留持久状态（账本/候选/发布日志/备份/回收站）。"""
    if not cache_root.is_dir():
        return
    for child in cache_root.iterdir():
        if child.name in _PERSISTENT_CACHE_ENTRIES:
            continue
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)


@dataclass
class Session:
    """一次上传会话：源文件落 .cache/studio/<token>/，解析结果与计划驻留内存。"""

    token: str
    directory: Path
    parsed: import_stages.ParseResult
    display_name: str = ""  # 作者原始文件名，仅用于建议推断与显示
    plan: import_stages.ImportPlan | None = None
    committed_target: str = ""  # commit 成功后的项目相对 bundle 目录


@dataclass
class StudioState:
    project_root: Path
    cache_root: Path
    platform_root: Path | None = None
    workspace_mode: str = "legacy"
    workspace_label: str = "当前项目"
    workspace_environment: dict[str, str] = field(default_factory=dict)
    sessions: dict[str, Session] = field(default_factory=dict)
    preview_process: subprocess.Popen | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    preflight_ok_at: float = 0.0  # 本会话最近一次成功发布前检查的时间戳
    feedback_session: dict | None = None  # 评论服务管理会话（仅内存）
    comments_process: subprocess.Popen | None = None  # 本工作台启动的评论服务
    share_preview_process: subprocess.Popen | None = None  # 分享站预览进程（1314 端口）
    auth_mode: str = "local-bootstrap"
    studio_session_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    studio_csrf_token: str = field(default_factory=lambda: secrets.token_urlsafe(24))
    locked: bool = False

    def session(self, token: str) -> Session:
        if not TOKEN_FORMAT.fullmatch(token or ""):
            raise StudioError("bad-request", "会话标识格式不正确。")
        found = self.sessions.get(token)
        if found is None:
            raise StudioError("not-found", "会话不存在或已过期，请重新上传 Word 文件。")
        return found

    def drop_session(self, token: str) -> None:
        found = self.sessions.pop(token, None)
        if found is not None:
            shutil.rmtree(found.directory, ignore_errors=True)

    def rotate_local_auth(self) -> None:
        """锁定/重新授权时轮换本地会话与CSRF令牌：旧Cookie立即失效。"""
        self.studio_session_token = secrets.token_urlsafe(32)
        self.studio_csrf_token = secrets.token_urlsafe(24)
        self.locked = False

    def cleanup(self) -> None:
        for token in list(self.sessions):
            self.drop_session(token)
        sweep_cache(self.cache_root)
        self.stop_preview()
        share_preview.stop_share_preview(self)
        feedback.stop_service(self)

    def stop_preview(self) -> None:
        process = self.preview_process
        self.preview_process = None
        if process is None or process.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=5)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


# ---------------------------------------------------------------------------
# 上传校验
# ---------------------------------------------------------------------------


def parse_multipart(body: bytes, content_type: str) -> tuple[str, bytes]:
    """极简 multipart 解析（Python 3.13 已移除 cgi 模块）；只取第一个文件部件。

    返回 (文件名, 文件字节)。文件名只作显示与扩展名校验，绝不拼路径。
    """
    matched = re.search(r"boundary=([^;]+)", content_type)
    if not matched:
        raise StudioError("bad-request", "缺少multipart边界。")
    boundary = matched.group(1).strip().strip('"')
    delimiter = b"--" + boundary.encode("utf-8", "replace")
    for segment in body.split(delimiter)[1:]:
        if segment.startswith(b"--"):
            break
        header_raw, separator, content = segment.partition(b"\r\n\r\n")
        if not separator:
            continue
        disposition = ""
        for line in header_raw.decode("utf-8", "replace").split("\r\n"):
            name, _, value = line.partition(":")
            if name.strip().lower() == "content-disposition":
                disposition = value.strip()
        named = re.search(r'filename="([^"]*)"', disposition) or re.search(r"filename=([^;\s]+)", disposition)
        if not named:
            continue
        if content.endswith(b"\r\n"):
            content = content[:-2]
        return named.group(1), content
    raise StudioError("bad-request", "请求中没有文件部件。")


def parse_multipart_parts(body: bytes, content_type: str) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]]:
    """多部件 multipart 解析：返回 (文本字段, 文件字段)；文件名绝不拼路径。"""
    matched = re.search(r"boundary=([^;]+)", content_type)
    if not matched:
        raise StudioError("bad-request", "缺少multipart边界。")
    boundary = matched.group(1).strip().strip('"')
    delimiter = b"--" + boundary.encode("utf-8", "replace")
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for segment in body.split(delimiter)[1:]:
        if segment.startswith(b"--"):
            break
        header_raw, separator, content = segment.partition(b"\r\n\r\n")
        if not separator:
            continue
        disposition = ""
        for line in header_raw.decode("utf-8", "replace").split("\r\n"):
            name, _, value = line.partition(":")
            if name.strip().lower() == "content-disposition":
                disposition = value.strip()
        field_named = re.search(r'name="([^"]*)"', disposition)
        if not field_named:
            continue
        field_name = field_named.group(1)
        if content.endswith(b"\r\n"):
            content = content[:-2]
        file_named = re.search(r'filename="([^"]*)"', disposition) or re.search(r"filename=([^;\s]+)", disposition)
        if file_named:
            files[field_name] = (file_named.group(1), content)
        else:
            fields[field_name] = content.decode("utf-8", "replace")
    return fields, files


def validate_upload(filename: str, data: bytes) -> None:
    """在内存中校验 docx：扩展名、魔数、必备部件、解压总量。不落盘、不解压。"""
    if not filename.lower().endswith(".docx"):
        raise StudioError("invalid-source", "只接受 .docx 文件。")
    if not data:
        raise StudioError("invalid-source", "文件内容为空。")
    if len(data) > MAX_UPLOAD_BYTES:
        raise StudioError("invalid-source", "Word 文件超过 100MB，已拒绝。")
    if not data.startswith(b"PK\x03\x04") and not data.startswith(b"PK\x05\x06"):
        raise StudioError("invalid-source", "文件不是有效的 DOCX（缺少压缩包魔数）。")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = {name.casefold() for name in archive.namelist()}
            if not REQUIRED_ZIP_PARTS.issubset(names):
                raise StudioError("invalid-source", "文件不是有效的 DOCX（缺少必备部件）。")
            total = sum(info.file_size for info in archive.infolist())
            if total > MAX_UNCOMPRESSED_BYTES:
                raise StudioError("invalid-source", "解压后体积超过 500MB，已拒绝（疑似压缩炸弹）。")
    except zipfile.BadZipFile as error:
        raise StudioError("invalid-source", "文件不是有效的 DOCX 压缩包。") from error


def build_options(metadata: dict, parsed: import_stages.ParseResult, suggested: dict) -> import_stages.ImportOptions:
    """把前端元数据映射为 ImportOptions；白名单之外的字段一律拒绝。"""
    unknown = set(metadata) - METADATA_FIELDS
    if unknown:
        raise StudioError("validation-failed", f"不支持的元数据字段：{'、'.join(sorted(unknown))}")
    for key, value in metadata.items():
        if isinstance(value, (dict,)) or (key != "collections" and isinstance(value, list)):
            raise StudioError("validation-failed", f"元数据字段 {key} 的格式不正确。")

    title = str(metadata.get("title") or "").strip() or suggested.get("title", "") or parsed.word_title
    slug = str(metadata.get("slug") or "").strip() or suggested.get("slug", "")
    section = str(metadata.get("section") or "").strip() or suggested.get("section", "") or "essays"
    if section not in SECTIONS:
        raise StudioError("validation-failed", f"未知栏目：{section}（可选 works/essays/archives）。")
    collections_raw = metadata.get("collections") or []
    if isinstance(collections_raw, str):
        collections_raw = [collections_raw]
    collections = import_stages.split_values(collections_raw)
    if not collections and suggested.get("collection"):
        collections = [suggested["collection"]]
    collection_slug = str(metadata.get("collectionSlug") or "").strip() or suggested.get("collection_slug", "")
    if section == "works" and not collection_slug and collections:
        collection_slug = import_stages.assistant_slugify(collections[0])
    if collection_slug:
        try:
            collection_slug = import_stages.validate_slug(collection_slug, "文集slug")
        except import_stages.ValidationFailure as error:
            raise StudioError("validation-failed", str(error)) from error
    date = str(metadata.get("date") or "").strip()
    if date and not DATE_FORMAT.fullmatch(date):
        raise StudioError("validation-failed", "发布日期必须是 YYYY-MM-DD 格式。")
    try:
        weight = int(metadata.get("weight", 10))
    except (TypeError, ValueError) as error:
        raise StudioError("validation-failed", "weight 必须是整数。") from error
    if not 0 <= weight <= 99999:
        raise StudioError("validation-failed", "weight 超出允许范围。")
    return import_stages.ImportOptions(
        title=title,
        subtitle=str(metadata.get("subtitle") or ""),
        slug=slug,
        section=section,
        collections=collections,
        collection_slug=collection_slug,
        description=str(metadata.get("description") or ""),
        date=date,
        weight=weight,
        draft=bool(metadata.get("draft", True)),
        article_id=str(metadata.get("articleId") or "").strip(),
    )


def list_collections(project_root: Path) -> list[dict]:
    """扫描 content/works 下既有文集（slug + _index.md 的标题），供表单下拉。"""
    works = project_root / "content" / "works"
    result: list[dict] = []
    if not works.is_dir():
        return result
    for child in sorted(works.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        data, _ = import_stages.parse_existing_markdown(child / "_index.md")
        result.append({"slug": child.name, "title": str(data.get("title") or child.name)})
    return result


def asset_entries(session: Session) -> list[dict]:
    """本次会话可访问的图片清单（name 白名单格式 + 完整 URL）。"""
    entries = []
    for image in session.parsed.images:
        if image.webp_bytes is not None:
            name = f"{image.stem}.webp"
        else:
            name = image.original_name
        entries.append({"name": name, "url": f"/api/import/asset?token={session.token}&name={name}"})
    return entries


def asset_map(session: Session) -> dict[str, str]:
    """bundle 相对路径 → 会话图片 URL，供近似渲染替换 src。"""
    mapping = {}
    for image in session.parsed.images:
        if image.webp_bytes is not None:
            mapping[f"images/{image.stem}.webp"] = f"/api/import/asset?token={session.token}&name={image.stem}.webp"
        mapping[f"images/original/{image.original_name}"] = (
            f"/api/import/asset?token={session.token}&name={image.original_name}"
        )
    return mapping


# ---------------------------------------------------------------------------
# Hugo 预览进程
# ---------------------------------------------------------------------------


def port_ready(port: int = PREVIEW_PORT) -> bool:
    """1313 端口是否已有服务在监听（可能是工作台起的，也可能是手工起的）。"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3):
            return True
    except OSError:
        return False


def wait_for_port(port: int = PREVIEW_PORT, timeout: float = PREVIEW_WAIT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_ready(port):
            return True
        time.sleep(0.2)
    return port_ready(port)


def ensure_preview(state: StudioState) -> None:
    """Hugo 预览未运行时启动它（复用 preview_process 进程组管理）。"""
    with state.lock:
        running = state.preview_process is not None and state.preview_process.poll() is None
        if running or port_ready():
            return
        platform_root = state.platform_root or state.project_root
        script = platform_root / "scripts" / "preview.sh"
        if not script.is_file():
            raise StudioError("validation-failed", "找不到 scripts/preview.sh。")
        environment = dict(os.environ)
        environment.update(state.workspace_environment)
        state.preview_process = subprocess.Popen(
            ["bash", "scripts/preview.sh"],
            cwd=platform_root,
            env=environment,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------


class StudioHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler_class, state: StudioState):
        self.state = state
        super().__init__(address, handler_class)
        atexit.register(self._cleanup_once)

    def _cleanup_once(self) -> None:
        self.state.cleanup()

    def server_close(self) -> None:
        self._cleanup_once()
        super().server_close()


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "LidaijiStudio/0.2.5"

    @property
    def state(self) -> StudioState:
        return self.server.state  # type: ignore[attr-defined]

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - 沿用基类签名
        sys.stderr.write("[studio] %s\n" % (format % args))

    # -- 基础输出 ----------------------------------------------------------

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP_HEADER)
        for name, value in STATIC_SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, code: str, message: str, status: int | None = None,
                        fields: dict | None = None) -> None:
        error = {"code": code, "message": message}
        if fields:
            error.update(fields)
        self.send_json({"ok": False, "error": error}, status or HTTP_BY_CODE.get(code, 500))

    # -- 安全闸 ------------------------------------------------------------

    def check_host(self) -> bool:
        """精确校验HTTP authority，阻断DNS rebinding和畸形Host。"""
        values = self.headers.get_all("Host") or []
        if len(values) != 1:
            self.send_error_json("forbidden", "Host缺失或格式不正确。", 403)
            return False
        raw = values[0]
        try:
            parsed = urllib.parse.urlsplit(f"//{raw}", allow_fragments=False)
            host = parsed.hostname
            port = parsed.port
        except ValueError:
            self.send_error_json("forbidden", "Host缺失或格式不正确。", 403)
            return False
        if (
            not host
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or host.casefold() not in {"localhost", "127.0.0.1", "::1"}
            or port != self.server.server_port  # type: ignore[attr-defined]
        ):
            self.send_error_json("forbidden", "Host不是当前Studio回环地址。", 403)
            return False
        return True

    def check_studio_session(self) -> bool:
        """所有API必须携带由同源首页初始化的内存会话Cookie。"""
        try:
            cookies = SimpleCookie()
            cookies.load(self.headers.get("Cookie") or "")
            morsel = cookies.get(STUDIO_SESSION_COOKIE)
            supplied = morsel.value if morsel is not None else ""
        except (CookieError, ValueError):
            supplied = ""
        if not hmac.compare_digest(supplied, self.state.studio_session_token):
            self.send_error_json("forbidden", "Studio会话不存在或已经失效，请重新打开工作台。", 403)
            return False
        if self.state.locked:
            self.send_error_json("forbidden", "工作台已锁定，请重新授权。", 403)
            return False
        return True

    def check_csrf(self) -> bool:
        """所有 POST /api/* 的 CSRF 防线：自定义头 + 进程绑定CSRF令牌 + 同源端口Origin。"""
        if self.headers.get("X-Studio-Request") != "1":
            self.send_error_json("forbidden", "缺少 X-Studio-Request 请求头。", 403)
            return False
        supplied = str(self.headers.get(STUDIO_CSRF_HEADER) or "")
        if not supplied or not hmac.compare_digest(supplied, self.state.studio_csrf_token):
            self.send_error_json("forbidden", "缺少或错误的 X-Studio-CSRF 令牌。", 403)
            return False
        origin = self.headers.get("Origin")
        if origin:
            parsed = urllib.parse.urlparse(origin)
            host = parsed.hostname or ""
            if (
                parsed.scheme != "http"
                or not is_loopback(host)
                or parsed.port not in (None, self.server.server_port)
            ):
                self.send_error_json("forbidden", "Origin 不是当前工作台同源地址。", 403)
                return False
        return True

    def read_json_body(self, max_bytes: int = MAX_JSON_BYTES) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > max_bytes:
            raise StudioError("payload-too-large", "请求体过大。")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError as error:
            raise StudioError("bad-request", "请求体不是有效的 JSON。") from error
        if not isinstance(data, dict):
            raise StudioError("bad-request", "请求体必须是 JSON 对象。")
        return data

    # -- 路由 --------------------------------------------------------------

    def do_GET(self) -> None:
        if not self.check_host():
            return
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/") and not self.check_studio_session():
            return
        try:
            if path == "/api/system/status":
                self.handle_status()
            elif path == "/api/stats/views":
                self.handle_stats_views()
            elif path == "/api/import/asset":
                self.handle_asset()
            elif path == "/api/articles":
                self.handle_articles()
            elif path == "/api/articles/search":
                self.handle_articles_search()
            elif path == "/api/articles/suggest-slug":
                self.handle_suggest_slug()
            elif path == "/api/article":
                self.handle_article_read()
            elif path == "/api/article/publish-status":
                self.handle_article_publish_status()
            elif path == "/api/article/publish-log":
                self.handle_article_publish_log()
            elif path == "/api/article/candidate":
                self.handle_article_candidate()
            elif path == "/api/git/status":
                self.handle_git_status()
            elif path == "/api/git/log":
                self.handle_git_log()
            elif path == "/api/git/diff":
                self.handle_git_diff()
            elif path == "/api/publish/status":
                self.handle_publish_status()
            elif path == "/api/media":
                self.handle_media_list()
            elif path == "/api/media/file":
                self.handle_media_file()
            elif path == "/api/feedback/status":
                self.handle_feedback_status()
            elif path == "/api/feedback/comments":
                self.handle_feedback_comments()
            elif path == "/api/notes":
                self.handle_notes_read()
            elif path == "/api/notes/summary":
                self.handle_notes_summary()
            elif path == "/api/notes/paragraphs":
                self.handle_notes_paragraphs()
            elif path == "/api/share/items":
                self.handle_share_items()
            elif path == "/api/share/item":
                self.handle_share_item()
            elif path == "/api/share/publications":
                self.handle_share_publications()
            elif path == "/api/share/publish-status":
                self.handle_share_publish_status()
            elif path == "/api/share/preview-status":
                self.handle_share_preview_status()
            elif path == "/api/share/images/status":
                self.handle_share_images_status()
            elif path == "/api/share/images/file":
                self.handle_share_images_file()
            elif path == "/api/share/images/long-file":
                self.handle_share_images_long_file()
            elif path in STATIC_FILES:
                self.serve_static(path)
            else:
                self.send_error_json("not-found", "没有这个地址。", 404)
        except StudioError as error:
            self.send_error_json(error.code, error.message)
        except articles.ArticleFailure as error:
            self.send_error_json(error.code, error.message)
        except publish_article.ArticlePublishError as error:
            self.send_error_json(error.code, error.message, fields=error.fields or None)
        except (feedback.FeedbackFailure, notes.NoteFailure) as error:
            self.send_error_json(error.code, error.message)
        except (share_api.SharePublishError, share_preview.SharePreviewError) as error:
            self.send_error_json(error.code, error.message)
        except BrokenPipeError:
            pass
        except Exception:
            self.send_error_json("internal-error", "服务器内部错误。")

    def do_POST(self) -> None:
        if not self.check_host():
            return
        path = urllib.parse.urlparse(self.path).path
        if not path.startswith("/api/"):
            self.send_error_json("not-found", "没有这个地址。", 404)
            return
        if not self.check_studio_session():
            return
        if not self.check_csrf():
            return
        handlers = {
            "/api/import/inspect": self.handle_inspect,
            "/api/import/plan": self.handle_plan,
            "/api/import/commit": self.handle_commit,
            "/api/import/abort": self.handle_abort,
            "/api/system/open-folder": self.handle_open_folder,
            "/api/system/preview": self.handle_preview,
            "/api/system/lock": self.handle_lock,
            "/api/article/save": self.handle_article_save,
            "/api/article/new": self.handle_article_new,
            "/api/article/open-page": self.handle_article_open_page,
            "/api/article/publish-preview": self.handle_article_publish_preview,
            "/api/article/publish": self.handle_article_publish,
            "/api/render": self.handle_render,
            "/api/git/commit": self.handle_git_commit,
            "/api/publish/preflight": self.handle_publish_preflight,
            "/api/publish/run": self.handle_publish_run,
            "/api/media/upload": self.handle_media_upload,
            "/api/media/delete": self.handle_media_delete,
            "/api/feedback/login": self.handle_feedback_login,
            "/api/feedback/logout": self.handle_feedback_logout,
            "/api/feedback/service": self.handle_feedback_service,
            "/api/feedback/moderate": self.handle_feedback_moderate,
            "/api/feedback/open-location": self.handle_feedback_open_location,
            "/api/notes/save": self.handle_notes_save,
            "/api/notes/delete": self.handle_notes_delete,
            "/api/share/item/new": self.handle_share_new,
            "/api/share/item/save": self.handle_share_save,
            "/api/share/preview": self.handle_share_preview,
            "/api/share/publication": self.handle_share_publication_create,
            "/api/share/publication/cancel": self.handle_share_publication_cancel,
            "/api/share/images/generate": self.handle_share_images_generate,
            "/api/share/images/generate-long": self.handle_share_images_generate_long,
        }
        handler = handlers.get(path)
        if handler is None:
            self.send_error_json("not-found", "没有这个接口。", 404)
            return
        try:
            handler()
        except StudioError as error:
            self.send_error_json(error.code, error.message)
        except articles.ArticleFailure as error:
            self.send_error_json(error.code, error.message)
        except publish_article.ArticlePublishError as error:
            self.send_error_json(error.code, error.message, fields=error.fields or None)
        except (feedback.FeedbackFailure, notes.NoteFailure) as error:
            self.send_error_json(error.code, error.message)
        except (share_api.SharePublishError, share_preview.SharePreviewError) as error:
            self.send_error_json(error.code, error.message)
        except import_stages.ImportFailure as error:
            self.send_error_json(error.code, str(error))
        except BrokenPipeError:
            pass
        except OSError as error:
            self.send_error_json("write-failed", str(error))
        except Exception:
            self.send_error_json("internal-error", "服务器内部错误。")

    # -- 静态页 ------------------------------------------------------------

    def serve_static(self, path: str) -> None:
        filename, content_type = STATIC_FILES[path]
        target = _HERE / "static" / filename
        if not target.is_file():
            self.send_error_json("not-found", "静态资源缺失。", 404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # 工作台页面无内联脚本/样式，可安全收紧 CSP；样式由 CSSOM 设置不受 style-src 限制
        self.send_header("Content-Security-Policy", CSP_HEADER)
        for name, value in STATIC_SECURITY_HEADERS.items():
            self.send_header(name, value)
        if path in ("/", "/index.html"):
            # 顶层同源导航 = 重新授权：发放（可能已轮换的）本地会话Cookie。
            # 锁定状态在重新授权导航时清除；锁定期间所有API仍被 check_studio_session 拒绝。
            self.state.locked = False
            self.send_header(
                "Set-Cookie",
                f"{STUDIO_SESSION_COOKIE}={self.state.studio_session_token}; "
                f"Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_MAX_AGE_SECONDS}",
            )
        self.end_headers()
        self.wfile.write(body)

    # -- 导入 API ----------------------------------------------------------

    def handle_inspect(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise StudioError("bad-request", "请求体为空。")
        if length > MAX_UPLOAD_BYTES + 1024 * 1024:
            raise StudioError("invalid-source", "Word 文件超过 100MB，已拒绝。")
        content_type = self.headers.get("Content-Type") or ""
        filename, data = parse_multipart(self.rfile.read(length), content_type)
        validate_upload(filename, data)

        token = secrets.token_hex(16)
        directory = self.state.cache_root / token
        directory.mkdir(parents=True, exist_ok=False)
        source_path = directory / "source.docx"
        try:
            source_path.write_bytes(data)
            parsed = import_stages.parse_docx(source_path)
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        session = Session(token=token, directory=directory, parsed=parsed)
        session.display_name = filename
        self.state.sessions[token] = session

        # 建议按作者原始文件名推断（落盘名固定为 source.docx，无推断价值）
        suggested = import_stages.suggest(filename, self.state.project_root)
        report = {
            "source": {
                "filename": filename,  # 原始文件名仅用于显示；落盘名固定 source.docx
                "size": parsed.source.size,
                "sha256": parsed.source.sha256,
            },
            "document": document_info(parsed, suggested),
            "suggested": suggested,
            "warnings": [
                {"code": item.code, "message": item.message, "location": item.location} for item in parsed.warnings
            ],
            "collections": list_collections(self.state.project_root),
        }
        self.send_json({"ok": True, "token": token, "report": report})

    def handle_plan(self) -> None:
        data = self.read_json_body()
        session = self.state.session(str(data.get("token") or ""))
        metadata = data.get("metadata") or {}
        if not isinstance(metadata, dict):
            raise StudioError("bad-request", "metadata 必须是对象。")
        suggested = import_stages.suggest(session.display_name, self.state.project_root)
        options = build_options(metadata, session.parsed, suggested)
        try:
            plan = import_stages.plan_import(session.parsed, options, self.state.project_root)
        except import_stages.ImportFailure as error:
            raise StudioError(error.code, str(error)) from error
        session.plan = plan
        self.send_json(
            {
                "ok": True,
                "plan": plan.to_json_dict(),
                "previewHtml": render_markdown(plan.markdown, asset_map(session)),
                "assetUrls": asset_entries(session),
            }
        )

    def handle_commit(self) -> None:
        data = self.read_json_body()
        session = self.state.session(str(data.get("token") or ""))
        if session.plan is None:
            raise StudioError("validation-failed", "还没有生成导入计划，请先完成上一步。")
        if session.plan.conflicts:
            message = "；".join(conflict.message for conflict in session.plan.conflicts)
            raise StudioError("conflict", message)
        try:
            result = import_stages.commit_import(session.plan, session.parsed, self.state.project_root)
        except import_stages.ImportFailure as error:
            raise StudioError(error.code, str(error)) from error
        target_rel = session.plan.target
        session.committed_target = target_rel
        self.send_json(
            {
                "ok": True,
                "result": {
                    "target": target_rel,
                    "markdown": f"{target_rel}/index.md",
                    "title": result.title,
                    "slug": result.slug,
                    "section": result.section,
                    "wordCount": result.word_count,
                    "imageCount": result.image_count,
                    "warnings": [
                        {"code": item.code, "message": item.message, "location": item.location}
                        for item in result.warnings
                    ],
                },
            }
        )

    def handle_abort(self) -> None:
        data = self.read_json_body()
        session = self.state.session(str(data.get("token") or ""))
        self.state.drop_session(session.token)
        self.send_json({"ok": True})

    def handle_asset(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = (query.get("token") or [""])[0]
        name = (query.get("name") or [""])[0]
        session = self.state.session(token)
        if not ASSET_NAME.fullmatch(name):
            raise StudioError("bad-request", "图片名称格式不正确。")
        for image in session.parsed.images:
            if name == f"{image.stem}.webp" and image.webp_bytes is not None:
                payload = image.webp_bytes
                break
            if name == image.original_name and image.webp_bytes is None:
                payload = image.original_bytes
                break
        else:
            raise StudioError("not-found", "没有这张图片。")
        media_type = ASSET_MEDIA_TYPES.get(Path(name).suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # -- 文章管理 API ------------------------------------------------------

    def handle_articles(self) -> None:
        self.send_json({"ok": True, "articles": articles.scan_content(self.state.project_root)})

    def handle_stats_views(self) -> None:
        """只读代理：批量浏览数（统计服务，stats V0.1）。

        Studio 对浏览统计仅允许查看；本接口只转发 GET，不做任何修改。
        """
        import json as _json
        import urllib.request as _request

        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        namespace = (query.get("namespace") or [""])[0]
        if namespace not in ("works", "share"):
            self.send_json({"ok": False, "error": "命名空间不存在。", "items": {}})
            return
        base = os.environ.get("LIDAIJI_STATS_BASE", "http://127.0.0.1:4317")
        try:
            with _request.urlopen(
                f"{base}/api/stats/views?namespace={namespace}", timeout=8
            ) as response:
                payload = _json.loads(response.read().decode("utf-8", "replace"))
            self.send_json({"ok": True, "namespace": namespace, "items": payload.get("items", {})})
        except Exception:
            self.send_json({"ok": False, "error": "统计服务暂时不可用。", "items": {}})

    def handle_articles_search(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        keyword = (query.get("q") or [""])[0]
        self.send_json({"ok": True, "results": articles.search_articles(self.state.project_root, keyword)})

    def handle_suggest_slug(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        title = (query.get("title") or [""])[0]
        slug = import_stages.assistant_slugify(title) if title.strip() else ""
        self.send_json({"ok": True, "slug": slug})

    def handle_article_read(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        self.send_json({"ok": True, "article": articles.read_article(self.state.project_root, rel_path)})

    def handle_article_publish_status(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        self.send_json({"ok": True, "status": publish_article.article_publish_status(self.state, rel_path)})

    def handle_article_candidate(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        candidate_id = (query.get("id") or [""])[0]
        try:
            manifest = publish_article.candidate_manifest.load_candidate_manifest(
                Path(self.state.project_root), candidate_id)
        except publish_article.candidate_manifest.CandidateError as error:
            self.send_error_json(error.code, error.message,
                                 status={"not-found": 404, "validation-failed": 400}.get(error.code))
            return
        summary = {
            "candidateId": manifest.get("candidateId"),
            "baselineId": manifest.get("baselineId"),
            "snapshotId": manifest.get("snapshotId"),
            "buildMode": (manifest.get("testIdentity") or {}).get("buildMode", "production"),
            "testRunId": (manifest.get("testIdentity") or {}).get("testRunId", ""),
            "targetArticleId": manifest.get("targetArticleId"),
            "targetSlug": manifest.get("targetSlug"),
            "fileCount": len(manifest.get("files", [])),
            "totalBytes": sum(int(f.get("size", 0)) for f in manifest.get("files", [])),
            "classifications": {},
            "manifestSha256": manifest.get("manifestSha256"),
            "createdAt": manifest.get("runtime", {}).get("createdAt", ""),
        }
        for f in manifest.get("files", []):
            cls = f.get("classification", "?")
            summary["classifications"][cls] = summary["classifications"].get(cls, 0) + 1
        self.send_json({"ok": True, "manifest": summary})

    def handle_article_publish_log(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        log_id = (query.get("id") or [""])[0]
        if not publish_article._PUBLISH_LOG_ID_RE.match(log_id):
            self.send_error_json("validation-failed", "日志标识格式不正确。")
            return
        log_path = Path(self.state.project_root) / ".cache" / "studio" / "publish-logs" / f"{log_id}.log"
        if not log_path.is_file():
            self.send_error_json("not-found", "日志不存在。", 404)
            return
        try:
            content = log_path.read_bytes()
        except OSError:
            self.send_error_json("not-found", "日志不存在。", 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="publish-{log_id}.log"')
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def handle_article_publish_preview(self) -> None:
        data = self.read_json_body()
        result = publish_article.article_publish_preview(self.state, str(data.get("path") or ""))
        self.send_json({"ok": result["ok"], **result})

    def handle_article_publish(self) -> None:
        data = self.read_json_body()
        result = publish_article.article_publish(self.state, str(data.get("path") or ""), data)
        self.send_json(result)

    def handle_article_save(self) -> None:
        data = self.read_json_body(MAX_RENDER_BYTES)
        result = articles.save_article(
            self.state.project_root,
            str(data.get("path") or ""),
            data.get("frontMatter") or {},
            data.get("body") if isinstance(data.get("body"), str) else "",
        )
        self.send_json({"ok": True, "article": result["article"], "anchors": result["anchors"], "body": result["body"]})

    def handle_article_new(self) -> None:
        data = self.read_json_body()
        allowed = {"title", "subtitle", "section", "slug", "collectionSlug", "collectionTitle"}
        unknown = set(data) - allowed
        if unknown:
            raise StudioError("validation-failed", f"不支持的字段：{'、'.join(sorted(unknown))}")
        article = articles.new_article(self.state.project_root, data)
        self.send_json({"ok": True, "article": article})

    def handle_article_open_page(self) -> None:
        data = self.read_json_body()
        url = articles.article_url(self.state.project_root, str(data.get("path") or ""))
        ensure_preview(self.state)
        if not wait_for_port():
            raise StudioError("preview-failed", "Hugo 预览端口长时间未就绪，请检查 1313 端口。")
        if sys.platform == "darwin":
            subprocess.run(["open", f"http://127.0.0.1:{PREVIEW_PORT}{url}"], check=False)
        else:
            raise StudioError("validation-failed", "当前系统不支持自动打开浏览器。")
        self.send_json({"ok": True, "url": url})

    def handle_render(self) -> None:
        data = self.read_json_body(MAX_RENDER_BYTES)
        markdown = data.get("markdown")
        if not isinstance(markdown, str):
            raise StudioError("bad-request", "markdown 必须是字符串。")
        self.send_json({"ok": True, "html": render_markdown(markdown)})

    # -- 版本管理（Git）API -------------------------------------------------

    def handle_git_status(self) -> None:
        self.send_json({"ok": True, "status": versions.git_status(self.state.project_root)})

    def handle_git_log(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        limit = (query.get("limit") or [""])[0]
        commits = versions.git_log(self.state.project_root, rel_path or None, limit or None)
        self.send_json({"ok": True, "commits": commits})

    def handle_git_diff(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        ref = (query.get("ref") or [""])[0]
        result = versions.git_diff(self.state.project_root, rel_path or None, ref or None)
        self.send_json({"ok": True, "result": result})

    def handle_git_commit(self) -> None:
        data = self.read_json_body()
        files = data.get("files")
        message = str(data.get("message") or "")
        result = versions.git_commit(self.state.project_root, files, message)
        self.send_json({"ok": True, "commit": result})

    # -- 发布中心 API --------------------------------------------------------

    def handle_publish_status(self) -> None:
        platform_root = self.state.platform_root or self.state.project_root
        self.send_json({
            "ok": True,
            "status": publish_center.publish_status(platform_root, self.state.project_root),
        })

    def handle_publish_preflight(self) -> None:
        data = self.read_json_body()
        platform_root = self.state.platform_root or self.state.project_root
        result = publish_center.run_preflight(
            platform_root,
            bool(data.get("full")),
            self.state.project_root,
            self.state.workspace_environment,
        )
        if result["success"]:
            self.state.preflight_ok_at = time.time()
        self.send_json({"ok": True, "preflight": result})

    def handle_publish_run(self) -> None:
        data = self.read_json_body()
        if data.get("confirm") is not True:
            raise StudioError("confirmation-required", "发布必须显式确认（confirm: true）。")
        age = time.time() - self.state.preflight_ok_at
        if self.state.preflight_ok_at <= 0 or age > PREFLIGHT_FRESH_SECONDS:
            raise StudioError("preflight-required", "请先运行一次成功的发布前检查（30 分钟内有效）。")
        site_key = f"site-{secrets.token_hex(8)}"
        lock = publish_article.acquire_publish_lock(self.state, idempotency_key=site_key)
        if lock.get("idempotencyKey") != site_key:
            raise StudioError("conflict", "已有另一个发布任务正在进行，请稍后再试。")
        platform_root = self.state.platform_root or self.state.project_root
        try:
            publish_article.update_publish_stage(self.state, "building")
            result = publish_center.run_publish(platform_root, self.state.workspace_environment)
            if not result["success"]:
                raise StudioError("service-error", "发布失败，请查看日志；服务器可能仍停留在旧版本。")
            return self.send_json({"ok": True, "publish": result})
        finally:
            publish_article.release_publish_lock(self.state)

    # -- 媒体库 API ----------------------------------------------------------

    def handle_media_list(self) -> None:
        self.send_json({"ok": True, "media": media.scan_media(self.state.project_root)})

    def handle_media_file(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        resolved, _rel = media.resolve_image_path(self.state.project_root, rel_path)
        if not resolved.is_file():
            raise StudioError("not-found", "找不到这张图片。")
        payload = resolved.read_bytes()
        media_type = media.IMAGE_MEDIA_TYPES.get(resolved.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def handle_media_upload(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise StudioError("bad-request", "请求体为空。")
        if length > MAX_MEDIA_UPLOAD_BYTES:
            raise StudioError("payload-too-large", "图片超过 20MB，已拒绝。")
        content_type = self.headers.get("Content-Type") or ""
        fields, files = parse_multipart_parts(self.rfile.read(length), content_type)
        if "file" not in files:
            raise StudioError("bad-request", "请求中没有图片文件部件。")
        filename, data = files["file"]
        result = media.upload_image(self.state.project_root, fields.get("articlePath") or "", filename, data)
        self.send_json({"ok": True, **result})

    def handle_media_delete(self) -> None:
        data = self.read_json_body()
        result = media.delete_image(self.state.project_root, str(data.get("path") or ""))
        self.send_json({"ok": True, **result})

    # -- 阅读反馈（评论服务代理）API -----------------------------------------

    def handle_feedback_status(self) -> None:
        running = feedback.service_running(self.state)
        session = self.state.feedback_session
        upstream = feedback.upstream_state(self.state)
        payload = {
            "ok": True,
            "service": {
                "running": running,
                "url": feedback.COMMENTS_BASE,
                "source": feedback.service_source(),
                "sourceLabel": feedback.service_source_label(),
            },
            "authMode": self.state.auth_mode,
            "loggedIn": False,
            "upstream": upstream,
        }
        if self.state.auth_mode == "local-bootstrap" and running:
            try:
                feedback.ensure_upstream_session(self.state)
                session = self.state.feedback_session
            except feedback.FeedbackFailure as error:
                payload["upstreamError"] = error.message
        if running and session:
            try:
                counts = feedback.pending_counts(self.state)
                payload["loggedIn"] = True
                payload["username"] = session["username"]
                payload["stats"] = counts
            except feedback.FeedbackFailure as error:
                if error.code != "not-logged-in":
                    payload["serviceError"] = error.message
        self.send_json(payload)

    def handle_feedback_login(self) -> None:
        if self.state.auth_mode == "local-bootstrap":
            # 本地免登录模式下不接受浏览器提交的账号密码。
            raise StudioError("forbidden", "本地免登录模式不提供账号密码登录。")
        data = self.read_json_body()
        result = feedback.login(self.state, data.get("username"), data.get("password") or "")
        self.send_json({"ok": True, **result})

    def handle_feedback_logout(self) -> None:
        feedback.logout(self.state)
        self.send_json({"ok": True})

    def handle_feedback_service(self) -> None:
        data = self.read_json_body()
        action = str(data.get("action") or "")
        if action == "start":
            feedback.start_service(self.state)
        elif action == "stop":
            feedback.stop_service(self.state)
        else:
            raise StudioError("bad-request", "action 只能是 start 或 stop。")
        self.handle_feedback_status()

    def handle_feedback_comments(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        filters = {key: (query.get(key) or [""])[0] for key in feedback.LIST_FILTERS}
        self.send_json(feedback.list_comments(self.state, filters))

    def handle_feedback_moderate(self) -> None:
        data = self.read_json_body()
        action = str(data.get("action") or "")
        if action == "delete" and data.get("confirm") is not True:
            raise StudioError("confirmation-required", "删除评论必须显式确认（confirm: true）。")
        result = feedback.moderate(
            self.state,
            str(data.get("id") or ""),
            action,
            data.get("reason") if isinstance(data.get("reason"), str) else None,
        )
        self.send_json(result)

    def handle_feedback_open_location(self) -> None:
        data = self.read_json_body()
        canonical = str(data.get("canonicalPath") or "")
        if not CANONICAL_PATH.fullmatch(canonical):
            raise StudioError("validation-failed", "文章站内路径格式不正确。")
        scope = str(data.get("scope") or "")
        paragraph_id = str(data.get("paragraphId") or "")
        if scope == "paragraph" and paragraph_id:
            if not PARAGRAPH_ID.fullmatch(paragraph_id):
                raise StudioError("validation-failed", "段落锚点格式不正确。")
            anchor = paragraph_id
        else:
            anchor = "article-comments"
        ensure_preview(self.state)
        if not wait_for_port():
            raise StudioError("preview-failed", "Hugo 预览端口长时间未就绪，请检查 1313 端口。")
        url = f"http://127.0.0.1:{PREVIEW_PORT}{canonical}#{anchor}"
        if sys.platform == "darwin":
            subprocess.run(["open", url], check=False)
        else:
            raise StudioError("validation-failed", "当前系统不支持自动打开浏览器。")
        self.send_json({"ok": True, "url": url})

    # -- 作者批注 API ---------------------------------------------------------

    def handle_notes_read(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        self.send_json({"ok": True, "notes": notes.read_notes(self.state.project_root, rel_path)})

    def handle_notes_summary(self) -> None:
        self.send_json({"ok": True, "summary": notes.notes_summary(self.state.project_root)})

    def handle_notes_paragraphs(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        self.send_json({"ok": True, "paragraphs": notes.list_paragraphs(self.state.project_root, rel_path)})

    def handle_notes_save(self) -> None:
        data = self.read_json_body(MAX_RENDER_BYTES)
        result = notes.save_note(self.state.project_root, str(data.get("path") or ""), data.get("note"))
        self.send_json({"ok": True, **result})

    def handle_notes_delete(self) -> None:
        data = self.read_json_body()
        if data.get("confirm") is not True:
            raise StudioError("confirmation-required", "删除批注必须显式确认（confirm: true）。")
        remaining = notes.delete_note(self.state.project_root, str(data.get("path") or ""), str(data.get("id") or ""))
        self.send_json({"ok": True, "notes": remaining})

    # -- 长文分享 API -------------------------------------------------------

    def _share_service(self) -> share_api.SharePublicationService:
        return share_api.SharePublicationService(self.state.project_root)

    def handle_share_items(self) -> None:
        self.send_json({"ok": True, "items": share_articles.scan_shares(self.state.project_root)})

    def handle_share_item(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        self.send_json({"ok": True, "share": share_articles.read_share(self.state.project_root, rel_path)})

    def handle_share_new(self) -> None:
        data = self.read_json_body()
        allowed = {"title", "author", "shareKind", "rightsMode"}
        unknown = set(data) - allowed
        if unknown:
            raise StudioError("validation-failed", f"不支持的字段：{'、'.join(sorted(unknown))}")
        entry = share_articles.new_share(self.state.project_root, data)
        self.send_json({"ok": True, "share": entry})

    def handle_share_save(self) -> None:
        data = self.read_json_body(MAX_RENDER_BYTES)
        result = share_articles.save_share(
            self.state.project_root,
            str(data.get("path") or ""),
            data.get("frontMatter") or {},
            data.get("body") if isinstance(data.get("body"), str) else "",
        )
        self.send_json({
            "ok": True,
            "share": result["share"],
            "anchorsStripped": result["anchorsStripped"],
            "body": result["body"],
        })

    def handle_share_preview(self) -> None:
        data = self.read_json_body()
        action = str(data.get("action") or "")
        if action == "start":
            share_preview.ensure_share_preview(self.state)
        elif action == "stop":
            share_preview.stop_share_preview(self.state)
        else:
            raise StudioError("bad-request", "action 只能是 start 或 stop。")
        self.send_json({"ok": True, "preview": share_preview.share_preview_status(self.state)})

    def handle_share_preview_status(self) -> None:
        self.send_json({"ok": True, "preview": share_preview.share_preview_status(self.state)})

    def handle_share_publish_status(self) -> None:
        with self._share_service() as service:
            self.send_json({"ok": True, "status": service.status()})

    def handle_share_publications(self) -> None:
        with self._share_service() as service:
            self.send_json({"ok": True, "publications": service.list_publications()})

    def handle_share_publication_create(self) -> None:
        data = self.read_json_body(MAX_RENDER_BYTES)
        path = str(data.get("path") or "")
        final_text = data.get("finalText") if isinstance(data.get("finalText"), str) else ""
        scheduled_at = str(data.get("scheduledAt") or "")
        mode = str(data.get("mode") or "text-link")
        artifact_manifest_hash = str(data.get("artifactManifestHash") or "")
        with self._share_service() as service:
            result = service.create(
                path,
                final_text,
                scheduled_at,
                mode=mode,
                artifact_manifest_hash=artifact_manifest_hash,
            )
            self.send_json({"ok": True, **result})

    def handle_share_publication_cancel(self) -> None:
        data = self.read_json_body()
        publication_id = str(data.get("publicationId") or "")
        with self._share_service() as service:
            service.cancel(publication_id)
            self.send_json({"ok": True})

    # -- 长文分享图片卡 API（V0.2） ------------------------------------------

    def _share_manifest_hash(self, share_root, share_id, share_revision, long=False):
        import hashlib as _hashlib

        from share_publisher.artifacts import MANIFEST_NAME, artifact_dir, long_artifact_dir

        directory = (long_artifact_dir if long else artifact_dir)(share_root, share_id, share_revision)
        target = directory / MANIFEST_NAME
        if not target.is_file():
            return ""
        return _hashlib.sha256(target.read_bytes()).hexdigest()

    def _share_item_meta(self, rel_path: str):
        item = share_articles.read_share(self.state.project_root, rel_path)
        return item, share_articles.share_root(self.state.project_root)

    def handle_share_images_status(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        item, share_root = self._share_item_meta(rel_path)
        data = item["frontMatter"]
        share_id = str(data.get("shareId") or "")
        share_revision = str(data.get("shareRevision") or "")
        from share_publisher import artifacts

        try:
            manifest = artifacts.read_manifest(share_root, share_id, share_revision)
            payload = {
                "generated": True,
                "pageCount": manifest.get("pageCount", 0),
                "stale": artifacts.is_stale(manifest, share_revision),
                "manifestHash": self._share_manifest_hash(share_root, share_id, share_revision),
                "files": artifacts.page_names(manifest),
            }
        except artifacts.ArtifactError:
            payload = {"generated": False, "pageCount": 0, "stale": False, "manifestHash": "", "files": []}
        # 长图信息（V0.3）
        try:
            long_manifest = artifacts.read_long_manifest(share_root, share_id, share_revision)
            cards_hash = self._share_manifest_hash(share_root, share_id, share_revision)
            payload["long"] = {
                "generated": True,
                "imageCount": long_manifest.get("imageCount", 0),
                "sourcePageCount": long_manifest.get("sourcePageCount", 0),
                "groupSize": long_manifest.get("groupSize", 0),
                "stale": artifacts.long_stale(long_manifest, share_revision, cards_hash),
                "manifestHash": self._share_manifest_hash(share_root, share_id, share_revision, long=True),
                "images": [
                    {"file": f"{img['index']:02d}.png", "pages": img["pages"], "height": img["height"]}
                    for img in long_manifest.get("publishImages", [])
                ],
            }
        except artifacts.ArtifactError:
            payload["long"] = {"generated": False}
        self.send_json({"ok": True, "images": payload})

    def handle_share_images_generate(self) -> None:
        import time as _time

        from share_publisher import artifacts
        from share_publisher.render import RenderError, generate_cards

        data = self.read_json_body(MAX_RENDER_BYTES)
        rel_path = str(data.get("path") or "")
        item, share_root = self._share_item_meta(rel_path)
        fm = item["frontMatter"]
        share_id = str(fm.get("shareId") or "")
        share_revision = str(fm.get("shareRevision") or "")
        if not share_id or not share_revision:
            raise StudioError("validation-failed", "分享缺少身份信息。")
        out_dir = artifacts.artifact_dir(share_root, share_id, share_revision)
        started = _time.monotonic()
        try:
            manifest = generate_cards(
                item["body"],
                title=str(fm.get("title") or ""),
                byline=str(fm.get("author") or ""),
                out_dir=out_dir,
                share_id=share_id,
                share_revision=share_revision,
                test_mode=os.environ.get("SHARE_IMAGE_TEST_MODE") == "1",
            )
        except RenderError as error:
            raise StudioError(error.code, error.message) from error
        manifest_hash = artifacts.write_manifest(out_dir, manifest)
        self.send_json({
            "ok": True,
            "images": {
                "generated": True,
                "pageCount": manifest["pageCount"],
                "stale": False,
                "manifestHash": manifest_hash,
                "files": artifacts.page_names(manifest),
                "durationSeconds": round(_time.monotonic() - started, 2),
            },
        })

    def handle_share_images_file(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        name = (query.get("name") or [""])[0]
        item, share_root = self._share_item_meta(rel_path)
        share_id = str(item["frontMatter"].get("shareId") or "")
        share_revision = str(item["frontMatter"].get("shareRevision") or "")
        from share_publisher import artifacts

        try:
            target = artifacts.safe_resolve(share_root, share_id, share_revision, name)
            payload = target.read_bytes()
        except artifacts.ArtifactError as error:
            raise StudioError(error.code, error.message) from error
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def handle_share_images_generate_long(self) -> None:
        from share_publisher import artifacts
        from share_publisher import longimage
        from share_publisher.render import generate_long_cards

        data = self.read_json_body(MAX_RENDER_BYTES)
        rel_path = str(data.get("path") or "")
        item, share_root = self._share_item_meta(rel_path)
        fm = item["frontMatter"]
        share_id = str(fm.get("shareId") or "")
        share_revision = str(fm.get("shareRevision") or "")
        cards_dir = artifacts.artifact_dir(share_root, share_id, share_revision)
        out_dir = artifacts.long_artifact_dir(share_root, share_id, share_revision)
        try:
            manifest = generate_long_cards(
                cards_dir, out_dir, share_id=share_id, share_revision=share_revision,
                constraints=longimage.env_constraints(),
            )
        except (artifacts.ArtifactError, longimage.LongImageError) as error:
            raise StudioError(error.code, error.message) from error
        self.send_json({
            "ok": True,
            "long": {
                "generated": True,
                "imageCount": manifest["imageCount"],
                "sourcePageCount": manifest["sourcePageCount"],
                "groupSize": manifest["groupSize"],
                "stale": False,
                "manifestHash": self._share_manifest_hash(share_root, share_id, share_revision, long=True),
                "images": [
                    {"file": f"{img['index']:02d}.png", "pages": img["pages"], "height": img["height"]}
                    for img in manifest["publishImages"]
                ],
            },
        })

    def handle_share_images_long_file(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        rel_path = (query.get("path") or [""])[0]
        name = (query.get("name") or [""])[0]
        item, share_root = self._share_item_meta(rel_path)
        share_id = str(item["frontMatter"].get("shareId") or "")
        share_revision = str(item["frontMatter"].get("shareRevision") or "")
        from share_publisher import artifacts

        try:
            manifest = artifacts.read_long_manifest(share_root, share_id, share_revision)
            target = None
            for img in manifest.get("publishImages", []):
                if f"{img['index']:02d}.png" == name:
                    from share_publisher.artifacts import safe_resolve

                    target = safe_resolve(share_root, share_id, share_revision, name, long=True)
                    break
            if target is None:
                raise artifacts.ArtifactError("not-found", "长图文件不在 manifest 中。")
            payload = target.read_bytes()
        except artifacts.ArtifactError as error:
            raise StudioError(error.code, error.message) from error
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # -- 系统 API ----------------------------------------------------------

    def handle_open_folder(self) -> None:
        data = self.read_json_body()
        rel_path = str(data.get("path") or "")
        if rel_path:
            # 文章管理语义：打开任意文章 bundle 目录（校验规则与文章接口一致）
            target = articles.resolve_article_path(self.state.project_root, rel_path).parent
            if not target.is_dir():
                raise StudioError("not-found", "找不到这个文章目录。")
        else:
            # 导入会话语义：只允许本次会话 commit 成功的目标目录
            session = self.state.session(str(data.get("token") or ""))
            if not session.committed_target:
                raise StudioError("validation-failed", "本次会话还没有成功导入，没有可打开的目录。")
            target = (self.state.project_root / session.committed_target).resolve()
            content_root = (self.state.project_root / "content").resolve()
            if content_root not in target.parents or not target.is_dir():
                raise StudioError("validation-failed", "目标目录不在 content/ 范围内。")
        if sys.platform == "darwin":
            subprocess.run(["open", str(target)], check=False)
        else:
            raise StudioError("validation-failed", "当前系统不支持自动打开文件夹。")
        self.send_json({"ok": True})

    def handle_preview(self) -> None:
        data = self.read_json_body()
        action = str(data.get("action") or "")
        if action == "start":
            ensure_preview(self.state)
        elif action == "stop":
            with self.state.lock:
                self.state.stop_preview()
        else:
            raise StudioError("bad-request", "action 只能是 start 或 stop。")
        self.handle_status()

    def handle_lock(self) -> None:
        """退出本次工作台：轮换本地会话与CSRF、尽力登出上游、返回已锁定。"""
        with self.state.lock:
            feedback.logout(self.state)  # 尽力撤销上游Session
            self.state.rotate_local_auth()
            self.state.locked = True
        body = b'{"ok":true,"locked":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP_HEADER)
        for name, value in STATIC_SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header(
            "Set-Cookie",
            f"{STUDIO_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        )
        self.end_headers()
        self.wfile.write(body)

    def handle_status(self) -> None:
        process = self.state.preview_process
        running = process is not None and process.poll() is None
        self.send_json({
            "ok": True,
            "version": self.server_version,
            "deployDisabled": os.environ.get("STUDIO_DISABLE_PRODUCTION_PUBLISH", "") == "1",
            "preview": {"running": running, "url": "http://127.0.0.1:1313/"},
            "workspace": {
                "mode": self.state.workspace_mode,
                "label": self.state.workspace_label,
                "contentRepoRoot": str(self.state.project_root),
                "platformRoot": str(self.state.platform_root or self.state.project_root),
            },
            "auth": {
                "mode": self.state.auth_mode,
                "locked": self.state.locked,
            },
            "csrfToken": self.state.studio_csrf_token,
        })


# ---------------------------------------------------------------------------
# 服务工厂
# ---------------------------------------------------------------------------


def is_loopback(host: str) -> bool:
    if host in LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def create_server(
    project_root,
    host: str = "127.0.0.1",
    port: int = DEFAULT_PORT,
    *,
    platform_root=None,
    workspace_mode: str = "legacy",
    workspace_label: str = "当前项目",
    workspace_environment: dict[str, str] | None = None,
) -> StudioHTTPServer:
    """构建（尚未启动的）服务；project_root 可指向任意项目根（测试用临时目录）。"""
    if not is_loopback(host):
        raise ValueError(f"作者工作台只监听本机回环地址，拒绝绑定：{host}")
    if not 0 <= int(port) <= 65535:
        raise ValueError(f"端口不合法：{port}")
    project_root = Path(project_root).resolve()
    cache_root = project_root / ".cache" / "studio"
    # 启动时清扫上次异常退出留下的会话目录（保留 backups/）
    sweep_cache(cache_root)
    cache_root.mkdir(parents=True, exist_ok=True)
    state = StudioState(
        project_root=project_root,
        cache_root=cache_root,
        platform_root=Path(platform_root).resolve() if platform_root else project_root,
        workspace_mode=workspace_mode,
        workspace_label=workspace_label,
        workspace_environment=dict(workspace_environment or {}),
    )
    return StudioHTTPServer(("127.0.0.1", int(port)), StudioHandler, state)
