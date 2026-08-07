"""QZone 文字说说适配器（薄封装，不含任何 AstrBot 框架代码）。

协议依据：MIT 许可的 Wyccotccy/astrbot_plugin_qzone_tools（见
THIRD_PARTY_NOTICES.md）所描述/实现的 NapCat + QZone 行为：
- NapCat ``get_login_info`` 取 uin，``get_credentials``（回退
  ``get_cookies``，domain=qzone.qq.com）动态取得当前 QQ 空间 Cookie，
  每次发布都重新获取，不依赖长期静态 Cookie；
- gtk 由 Cookie 中 p_skey/skey 按既定 hash 算法计算；
- 发布走 ``user.qzone.qq.com`` 的 ``emotion_cgi_publish_v6`` 表单接口，
  响应含 ``"code":0`` 视为接口接受（这只是“已提交”凭据，不是反查确认）；
- 超时 30 秒，失败停止，不自动重试。

安全边界：
- 所有日志/异常信息经 ``redact()`` 脱敏，绝不出现 Cookie、token 或
  Authorization 头；
- 本模块只有在调用方显式启用（QZONE_PUBLISH_ENABLED=true）且通过
  mock transport 验证后才会接触真实网络；测试一律注入假 transport；
- 反查（read-back）能力未实现前，发布结果一律视为 submitted_unverified，
  绝不伪造 published。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

QZONE_COOKIE_DOMAIN = "qzone.qq.com"
QZONE_PUBLISH_URL = "https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6"
QZONE_REFERRER = "https://user.qzone.qq.com/{uin}/infocenter"
HTTP_TIMEOUT = 30.0

# 需要脱敏的模式：Cookie 值、各种 token/密钥字段
_SENSITIVE_PATTERNS = [
    re.compile(r"(?i)(cookie\s*[:=]\s*)[^;\n,}]+"),
    re.compile(r"(?i)((?:authorization|auth)\s*[:=]\s*)[^,\n}]+"),
    re.compile(r"(?i)(bearer\s+)[a-z0-9_.\-]+"),
    re.compile(r"(?i)\b(p_skey|skey|p_uin|pt4_token|p_token|session_key|access_key)\b[^;\s,}]*"),
    re.compile(r"(?i)(token\s*[:=]\s*)[a-z0-9_.\-]+"),
    re.compile(r"(?i)(password|secret)\s*[:=]\s*\S+"),
]


def redact(text: str) -> str:
    """脱敏任意文本（日志、异常信息），替换敏感字段为占位符。"""
    text = str(text or "")
    for pattern in _SENSITIVE_PATTERNS:
        text = pattern.sub(lambda m: f"{m.group(1)}[redacted]", text)
    return text


def compute_gtk(skey: str) -> str:
    """由 skey/p_skey 计算 g_tk（协议固定算法）。"""
    value = 5381
    for char in skey:
        value += (value << 5) + ord(char)
    return str(value & 0x7FFFFFFF)


class QzoneAdapterError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class QzoneAdapterConfig:
    napcat_http_url: str = ""  # 例如 http://127.0.0.1:3000
    qq_account: str = ""  # 目标 QQ 号（NapCat 登录账号）
    timeout: float = HTTP_TIMEOUT
    access_token: str = ""  # NapCat HTTP API 访问令牌（Authorization: Bearer）
    # 注入点：测试用假 transport；缺省为真实 urllib
    transport: object = None


@dataclass
class PublishOutcome:
    submitted: bool  # HTTP 请求已被 QZone 接口接受（不代表已公开可见）
    post_id: str | None  # 仅当接口返回可解析的说说 id；否则 None → submitted_unverified
    message: str  # 脱敏后的说明
    error_code: str = ""


class _RealTransport:
    """真实 HTTP transport（urllib 实现）。"""

    def __init__(self, timeout: float):
        self.timeout = timeout

    def __init__(self, timeout: float, access_token: str = ""):
        self.timeout = timeout
        self.access_token = access_token

    def napcat_call(self, base_url: str, action: str, params: dict) -> dict:
        """NapCat v4.18 OneBot11 HTTP 契约（真机验证确认）：
        - action 写在 URL 路径（POST /<snake_case_action>）；
        - body 直接是参数对象（不包 {"action":..., "params":...} 外层）。
        """
        url = f"{base_url.rstrip('/')}/{action}"
        payload = json.dumps(params or {}).encode("utf-8")
        headers = {"Content-Type": "application/json", "X-Client-Name": "lidaiji-share-publisher"}
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            raise QzoneAdapterError(
                "napcat-http-error",
                f"NapCat HTTP 接口返回 {error.code}（{redact(error.reason)}）。",
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise QzoneAdapterError(
                "napcat-unreachable",
                f"无法连接 NapCat：{redact(error.reason if hasattr(error, 'reason') else error)}。",
            ) from error
        return _parse_json(body, "NapCat")

    def qzone_post_form(self, url: str, data: bytes, headers: dict) -> str:
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            raise QzoneAdapterError(
                "qzone-http-error",
                f"QZone 接口返回 {error.code}（{redact(error.reason)}）。",
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            # 连接失败/超时/中断：请求可能已经到达 QQ（ambiguous）。
            # 一律使用 qzone-ambiguous 语义，由调用方标记为 submitted_unverified，
            # 绝不允许调用方把它当作“明确失败”而让用户盲目重发。
            raise QzoneAdapterError(
                "qzone-ambiguous",
                "QZone 请求连接中断/超时，无法确认 QQ 是否已接收；"
                "已标记为「已提交、待人工确认」，请勿直接重发。",
            ) from error


def _parse_json(body: str, source: str) -> dict:
    try:
        parsed = json.loads(body)
    except (ValueError, TypeError) as error:
        raise QzoneAdapterError(
            "bad-response", f"{source} 返回了无法解析的响应（{redact(str(error))}）。"
        ) from error
    if not isinstance(parsed, dict):
        raise QzoneAdapterError("bad-response", f"{source} 返回了非对象响应。")
    return parsed


class QzoneAdapter:
    """NapCat Cookie → QZone 文字说说发布；每次发布动态获取最新 Cookie。"""

    def __init__(self, config: QzoneAdapterConfig | None = None):
        config = config or QzoneAdapterConfig()
        self.config = config
        self._transport = config.transport or _RealTransport(config.timeout, config.access_token)

    def fetch_cookie(self) -> str:
        """通过 NapCat 动态取得当前 QQ 空间 Cookie（不落盘、不进日志）。"""
        if not self.config.napcat_http_url or not self.config.qq_account:
            raise QzoneAdapterError("not-configured", "缺少 NapCat HTTP 地址或 QQ 账号配置。")
        base = self.config.napcat_http_url
        login = self._transport.napcat_call(base, "get_login_info", {})
        if str(login.get("status")) != "ok":
            raise QzoneAdapterError("napcat-not-logged-in", "NapCat 未登录或返回异常。")
        uin = str(login.get("data", {}).get("user_id") or "")
        if not uin:
            raise QzoneAdapterError("napcat-no-uin", "NapCat 未返回登录 QQ 号。")
        if uin != str(self.config.qq_account):
            raise QzoneAdapterError(
                "napcat-wrong-account",
                f"NapCat 登录账号与配置不符（配置 {self.config.qq_account}，实际 {uin}）。",
            )
        cookie = ""
        for action in ("get_credentials", "get_cookies"):
            try:
                result = self._transport.napcat_call(base, action, {"domain": QZONE_COOKIE_DOMAIN})
            except QzoneAdapterError:
                continue
            if str(result.get("status")) == "ok":
                cookie = str(result.get("data", {}).get("cookies") or "")
                if cookie:
                    break
        if not cookie:
            raise QzoneAdapterError(
                "cookie-unavailable",
                "QZone Cookie 获取失败：NapCat 未提供 get_credentials/get_cookies 数据。",
            )
        return cookie

    @staticmethod
    def _cookie_field(cookie: str, key: str) -> str:
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == key:
                return value
        return ""

    def publish_text(self, text: str, cookie: str) -> PublishOutcome:
        """发布纯文字说说；任何异常都先脱敏再抛出。"""
        uin = self.config.qq_account
        skey = self._cookie_field(cookie, "p_skey") or self._cookie_field(cookie, "skey")
        if not skey:
            raise QzoneAdapterError("cookie-invalid", "Cookie 缺少 p_skey/skey，可能已过期。")
        gtk = compute_gtk(skey)
        payload = {
            "syn_tweet_verson": "1",
            "con": text,
            "feedversion": "1",
            "ver": "1",
            "ugc_right": "1",
            "to_sign": "0",
            "hostuin": uin,
            "code_version": "1",
            "format": "fs",
            "qzreferrer": QZONE_REFERRER.format(uin=uin),
        }
        url = f"{QZONE_PUBLISH_URL}?g_tk={gtk}"
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": cookie,
            "Origin": "https://user.qzone.qq.com",
            "Referer": QZONE_REFERRER.format(uin=uin),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        }
        try:
            response = self._transport.qzone_post_form(
                url, urllib.parse.urlencode(payload).encode("utf-8"), headers
            )
        except QzoneAdapterError:
            raise
        except Exception as error:
            raise QzoneAdapterError(
                "qzone-ambiguous",
                "QZone 发布请求出现未预期异常，无法确认是否已接收；请人工确认，勿直接重发。",
            ) from error

        accepted = '"code":0' in response or '"code": 0' in response
        if not accepted:
            raise QzoneAdapterError(
                "qzone-rejected",
                f"QZone 拒绝了发布请求（响应含错误码，已脱敏；"
                f"响应前 {200} 字符：{redact(response[:200])}）。",
            )
        post_id = _extract_post_id(response)
        return PublishOutcome(
            submitted=True,
            post_id=post_id,
            message="已提交，尚未反查确认。" if not post_id else f"已提交，获得说说标识 {post_id}。",
        )


def _extract_post_id(response: str) -> str | None:
    """尝试从响应中解析说说标识；无法确认时返回 None（不伪造成功）。"""
    matched = re.search(r'"(?:tid|post_id|feed_id|ic)"\s*:\s*"?([0-9]{5,})"?', response)
    return matched.group(1) if matched else None


def adapter_enabled() -> bool:
    """真实 QQ 发布总开关：缺省关闭。"""
    import os

    return os.environ.get("QZONE_PUBLISH_ENABLED", "false").strip().lower() in ("1", "true", "yes")
