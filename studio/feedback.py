"""评论服务代理：作者工作台 ↔ 本地 comments-service（默认 127.0.0.1:4317）。

边界与约定：
- 只用标准库 urllib 发请求，不引入第三方依赖；
- 管理会话（cookie + csrfToken + 用户名）只保存在 StudioState 内存里，
  不落盘、不写日志，工作台退出即失效；
- 登录请求按评论服务要求带 ``Origin: http://127.0.0.1:4317`` 头；
  写操作（审核动作）带 Cookie + ``X-CSRF-Token`` 头；
- 评论服务进程管理仿照 server.py 的 preview_process：进程组启动、
  退出时 killpg 清理；4317 已被占用（作者自己起的）则直接复用；
- 本模块不改评论服务的任何数据模型，只是 admin API 的本地代理。
"""

from __future__ import annotations

import json
import os
import re
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

COMMENTS_BASE = "http://127.0.0.1:4317"
COMMENTS_PORT = 4317
HEALTH_TIMEOUT = 2.0
REQUEST_TIMEOUT = 10.0
COMMENT_ID = re.compile(r"^comment_[A-Za-z0-9_-]+$")
ACTIONS = ("approve", "reject", "spam", "hide", "delete")
LIST_FILTERS = ("status", "scope", "page", "q", "articleId")


class FeedbackFailure(Exception):
    """可直接转成 JSON 错误响应的失败（code 对应 server.HTTP_BY_CODE）。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# 底层 HTTP
# ---------------------------------------------------------------------------


def _request(method: str, path: str, payload: dict | None = None, headers: dict | None = None, timeout: float = REQUEST_TIMEOUT):
    """发一次请求；返回 (status, headers, body_bytes)。网络不可达抛 service-unavailable。"""
    request = urllib.request.Request(
        COMMENTS_BASE + path,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers=headers or {},
        method=method,
    )
    if payload is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:  # 服务在线但拒绝（4xx/5xx）
        return error.code, error.headers, error.read()
    except (urllib.error.URLError, OSError) as error:
        raise FeedbackFailure("service-unavailable", "评论服务无法连接，请先启动评论服务。") from error


def _parse_json(body: bytes) -> dict:
    try:
        data = json.loads(body or b"{}")
    except ValueError as error:
        raise FeedbackFailure("service-error", "评论服务返回了无法理解的响应。") from error
    return data if isinstance(data, dict) else {}


def _remote_message(body: bytes, fallback: str) -> str:
    data = _parse_json(body)
    error = data.get("error")
    if isinstance(error, dict) and error.get("message"):
        return str(error["message"])
    return fallback


# ---------------------------------------------------------------------------
# 服务可用性与会话
# ---------------------------------------------------------------------------


def service_available() -> bool:
    """GET /healthz 探测（2 秒超时）。"""
    try:
        status, _headers, _body = _request("GET", "/healthz", timeout=HEALTH_TIMEOUT)
        return status == 200
    except FeedbackFailure:
        return False


def _session(state) -> dict:
    session = getattr(state, "feedback_session", None)
    if not session:
        raise FeedbackFailure("not-logged-in", "尚未登录评论服务，请先登录。")
    return session


def _auth_headers(state) -> dict:
    session = _session(state)
    return {
        "Cookie": f"lidaiji_admin={session['cookie']}",
        "X-CSRF-Token": session["csrf"],
    }


def _clear_session(state) -> None:
    state.feedback_session = None


def _expired(state) -> FeedbackFailure:
    _clear_session(state)
    return FeedbackFailure("not-logged-in", "登录已过期，请重新登录。")


def login(state, username: str, password: str) -> dict:
    """POST admin/login（带 Origin 头）；成功把 cookie/csrf/username 存进内存会话。"""
    username = str(username or "").strip()
    if not username or not password:
        raise FeedbackFailure("validation-failed", "用户名和密码不能为空。")
    status, headers, body = _request(
        "POST",
        "/api/comments/v1/admin/login",
        {"username": username, "password": str(password)},
        headers={"Origin": COMMENTS_BASE},
    )
    if status == 401:
        raise FeedbackFailure("login-failed", _remote_message(body, "用户名或密码不正确。"))
    if status == 429:
        raise FeedbackFailure("rate-limited", _remote_message(body, "登录尝试过多，请稍后再试。"))
    if status != 200:
        raise FeedbackFailure("service-error", _remote_message(body, f"评论服务拒绝了登录（HTTP {status}）。"))
    data = _parse_json(body)
    csrf = str(data.get("csrfToken") or "")
    cookie = ""
    for header in headers.get_all("Set-Cookie") or []:
        matched = re.search(r"(?:^|;\s*)lidaiji_admin=([^;\s]+)", header)
        if matched:
            cookie = matched.group(1)
            break
    if not csrf or not cookie:
        raise FeedbackFailure("service-error", "评论服务登录响应不完整（缺少会话凭证）。")
    state.feedback_session = {"cookie": cookie, "csrf": csrf, "username": str(data.get("username") or username)}
    return {"username": state.feedback_session["username"]}


def logout(state) -> None:
    """尽力通知服务销毁会话，然后清空内存会话。"""
    session = getattr(state, "feedback_session", None)
    if session:
        try:
            _request(
                "POST",
                "/api/comments/v1/admin/logout",
                {},
                headers={
                    "Origin": COMMENTS_BASE,
                    "Cookie": f"lidaiji_admin={session['cookie']}",
                    "X-CSRF-Token": session["csrf"],
                },
            )
        except FeedbackFailure:
            pass
    _clear_session(state)


def list_comments(state, filters: dict) -> dict:
    """GET admin/comments（带 Cookie），白名单透传分页/筛选参数。"""
    query = {}
    for key in LIST_FILTERS:
        value = str(filters.get(key) or "").strip()
        if value:
            query[key] = value[:100]
    path = "/api/comments/v1/admin/comments"
    if query:
        path += "?" + urllib.parse.urlencode(query)
    status, _headers, body = _request("GET", path, headers=_auth_headers(state))
    if status == 401:
        raise _expired(state)
    if status != 200:
        raise FeedbackFailure("service-error", _remote_message(body, f"评论服务拒绝了列表请求（HTTP {status}）。"))
    return _parse_json(body)


def moderate(state, comment_id: str, action: str, reason: str | None = None) -> dict:
    """POST admin/comments/{id}/{action}（带 Cookie + X-CSRF-Token）。"""
    comment_id = str(comment_id or "")
    action = str(action or "")
    if not COMMENT_ID.fullmatch(comment_id):
        raise FeedbackFailure("validation-failed", "评论 ID 格式不正确。")
    if action not in ACTIONS:
        raise FeedbackFailure("validation-failed", "审核动作不受支持。")
    payload = {"reason": str(reason or "")[:500]}
    status, _headers, body = _request(
        "POST",
        f"/api/comments/v1/admin/comments/{comment_id}/{action}",
        payload,
        headers=_auth_headers(state),
    )
    if status == 401:
        raise _expired(state)
    if status == 404:
        raise FeedbackFailure("not-found", _remote_message(body, "这条评论不存在。"))
    if status != 200:
        raise FeedbackFailure("service-error", _remote_message(body, f"评论服务拒绝了审核操作（HTTP {status}）。"))
    return _parse_json(body)


def pending_counts(state) -> dict:
    """待审核段评/章评计数（供状态接口与首页卡片）。"""
    paragraph = list_comments(state, {"status": "pending", "scope": "paragraph"})
    article = list_comments(state, {"status": "pending", "scope": "article"})
    return {
        "paragraphPending": int(paragraph.get("total") or 0),
        "articlePending": int(article.get("total") or 0),
    }


# ---------------------------------------------------------------------------
# 评论服务进程管理（仿 server.py 的 preview_process）
# ---------------------------------------------------------------------------


def _service_port() -> int:
    return urllib.parse.urlparse(COMMENTS_BASE).port or 80


def port_ready(port: int | None = None) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port or _service_port()), timeout=0.3):
            return True
    except OSError:
        return False


def service_running(state) -> bool:
    """评论服务在线：本工作台管的进程活着，或 4317 已被占用（作者自己起的）。"""
    managed = getattr(state, "comments_process", None)
    if managed is not None and managed.poll() is None:
        return True
    return port_ready()


def start_service(state) -> None:
    """以进程组启动 scripts/comments-local.sh（首次含构建，较慢，前端轮询等待）。"""
    with state.lock:
        if service_running(state):
            return
        script = state.project_root / "scripts" / "comments-local.sh"
        if not script.is_file():
            raise FeedbackFailure("validation-failed", "找不到 scripts/comments-local.sh。")
        state.comments_process = subprocess.Popen(
            ["bash", "scripts/comments-local.sh"],
            cwd=state.project_root,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def stop_service(state) -> None:
    """停止本工作台启动的评论服务进程组；作者自己起的服务不动。"""
    with state.lock:
        process = getattr(state, "comments_process", None)
        state.comments_process = None
        if process is None or process.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=8)
        except (ProcessLookupError, PermissionError):
            pass
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def wait_for_service(timeout: float = 120.0) -> bool:
    """等服务健康检查通过（首次启动含完整构建，可能很慢）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if service_available():
            return True
        time.sleep(1.0)
    return service_available()
