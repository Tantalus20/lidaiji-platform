#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
历代纪站点统一可用性监控 (schemaVersion 1)

同一脚本部署于:
  - 服务器 (observer=server-local, 额外检查本机评论服务)
  - 作者 Mac (observer=mac-external, 大陆网络外部观测)

功能:
  - 分阶段探测 DNS / TCP / TLS / HTTP / CONTENT, 输出统一 JSONL
  - 邮件告警状态机: HEALTHY -> PENDING_FAILURE -> ALERTING -> (RECOVERED) -> HEALTHY
  - 连续 3 次失败发一次故障邮件; 恢复需连续 2 次成功才发恢复邮件
  - 证书到期分级告警 (30/14/7/3 天, 每阈值一次, 续期后重置)
  - 日志轮转: 服务器端由 logrotate 处理; Mac 端脚本自轮转(按日+大小)

配置: --config <env 文件> (每字段一行 KEY=value, 权限 0600)
  OBSERVER=server-local|mac-external
  CHECK_COMMENTS=0|1
  CHECK_BACKUP=0|1   (server-local 建议开启：检查每日异地备份状态)
  LOG_DIR=<日志目录>
  SMTP_HOST=<host, 留空则禁用邮件>
  SMTP_PORT=465
  SMTP_MODE=ssl|starttls|none
  SMTP_USER=
  SMTP_PASS=
  SMTP_FROM=
  MAIL_TO=

命令:
  默认            : 执行检查+状态机+日志+邮件
  --dry-run       : 只执行检查并打印 JSONL, 不写状态/日志/邮件
  --test-alert    : 发送一封 [测试] 故障邮件, 不持久化任何状态
  --test-recovery : 发送一封 [测试] 恢复邮件, 不持久化任何状态
"""
import argparse
import datetime
import json
import os
import smtplib
import socket
import ssl
import sys
import time

SCHEMA_VERSION = 1
CERT_THRESHOLDS = [30, 14, 7, 3]
BARE_HOST = "xn--mnqv6ix00c.cn"
WWW_HOST = "www.xn--mnqv6ix00c.cn"
BARE_URL = "https://%s/" % BARE_HOST
WWW_URL = "https://%s/" % WWW_HOST
WWW_EXPECTED_LOCATION = BARE_URL
CONTENT_MARKER = b"xn--mnqv6ix00c.cn"
DEFAULT_PORT = 443
BACKUP_STATE_DIR = "/var/lib/lidaiji-monitor/backup-state"
BACKUP_FAILURE_MARKER = os.path.join(BACKUP_STATE_DIR, "backup-failure.marker")
BACKUP_LAST_SUCCESS = os.path.join(BACKUP_STATE_DIR, "backup-last-success")
# 备份计划为每日 04:20 + 随机 15 分钟；超过 26 小时视为过期。
BACKUP_MAX_AGE_HOURS = 26


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def now_epoch_ms():
    return int(time.time() * 1000)


def parse_config(path):
    cfg = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                cfg[k.strip()] = v.strip()
    except Exception as exc:
        raise SystemExit("config error: %s: %s" % (path, exc))
    return cfg


def empty_record(url):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "timestamp": now_iso(),
        "observer": "",
        "url": url,
        "resolvedIp": None,
        "dnsMs": None,
        "tcpMs": None,
        "tlsMs": None,
        "ttfbMs": None,
        "totalMs": None,
        "httpStatus": None,
        "redirectTarget": None,
        "certificateDaysRemaining": None,
        "errorStage": None,
        "errorCode": None,
        "success": False,
    }


def probe_url(url, connect_timeout=8.0, read_timeout=12.0):
    """探测一个 URL, 返回记录 dict. 不包含响应正文. 异常都归入相应阶段."""
    rec = empty_record(url)
    t_start = time.monotonic()
    host_port = url.split("://", 1)[1].split("/", 1)[0]
    scheme = "https" if url.startswith("https://") else "http"
    if ":" in host_port:
        host, port_str = host_port.rsplit(":", 1)
        port = int(port_str)
    else:
        host = host_port
        port = DEFAULT_PORT if scheme == "https" else 80
    rest = url.split("://", 1)[1].split("/", 1)
    path = "/" + rest[1] if len(rest) > 1 else "/"

    # DNS
    t0 = time.monotonic()
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        addr = infos[0]
        ip = addr[4][0]
    except socket.gaierror as exc:
        rec["dnsMs"] = int((time.monotonic() - t0) * 1000)
        rec["errorStage"] = "DNS"
        rec["errorCode"] = "getaddrinfo: %s" % exc
        return rec
    rec["dnsMs"] = int((time.monotonic() - t0) * 1000)
    rec["resolvedIp"] = ip

    # TCP
    t0 = time.monotonic()
    sock = None
    try:
        sock = socket.create_connection((ip, port), timeout=connect_timeout)
    except socket.timeout as exc:
        rec["tcpMs"] = int((time.monotonic() - t0) * 1000)
        rec["errorStage"] = "TCP"
        rec["errorCode"] = "connect timeout"
        return rec
    except socket.error as exc:
        rec["tcpMs"] = int((time.monotonic() - t0) * 1000)
        rec["errorStage"] = "TCP"
        rec["errorCode"] = "connect: %s" % exc
        return rec
    rec["tcpMs"] = int((time.monotonic() - t0) * 1000)

    # TLS
    if scheme == "https":
        t0 = time.monotonic()
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = True
            ctx.verify_mode = ssl.CERT_REQUIRED
            ssl_sock = ctx.wrap_socket(sock, server_hostname=host)
        except ssl.SSLCertVerificationError as exc:
            try:
                sock.close()
            except Exception:
                pass
            rec["tlsMs"] = int((time.monotonic() - t0) * 1000)
            rec["errorStage"] = "TLS"
            rec["errorCode"] = "cert verify: %s" % exc
            return rec
        except ssl.SSLError as exc:
            try:
                sock.close()
            except Exception:
                pass
            rec["tlsMs"] = int((time.monotonic() - t0) * 1000)
            rec["errorStage"] = "TLS"
            rec["errorCode"] = "ssl: %s" % exc
            return rec
        except socket.timeout as exc:
            try:
                sock.close()
            except Exception:
                pass
            rec["tlsMs"] = int((time.monotonic() - t0) * 1000)
            rec["errorStage"] = "TLS"
            rec["errorCode"] = "tls timeout"
            return rec
        rec["tlsMs"] = int((time.monotonic() - t0) * 1000)
        sock = ssl_sock
        try:
            cert = sock.getpeercert()
            rec["certificateDaysRemaining"] = cert_days_remaining(cert)
            rec["_cert_identity"] = cert_identity(cert)
        except Exception:
            pass

    # HTTP request
    sock.settimeout(read_timeout)
    req = "GET %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: lidaiji-monitor/1\r\nConnection: close\r\n\r\n" % (path, host)
    try:
        sock.sendall(req.encode("ascii"))
    except socket.timeout as exc:
        sock.close()
        rec["totalMs"] = int((time.monotonic() - t_start) * 1000)
        rec["errorStage"] = "TIMEOUT"
        rec["errorCode"] = "send timeout"
        return rec
    except socket.error as exc:
        sock.close()
        rec["totalMs"] = int((time.monotonic() - t_start) * 1000)
        rec["errorStage"] = "TCP"
        rec["errorCode"] = "send: %s" % exc
        return rec

    t0 = time.monotonic()
    data = b""
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
            if t0 and (time.monotonic() - t0) > read_timeout:
                rec["errorStage"] = "TIMEOUT"
                rec["errorCode"] = "read timeout"
                break
            if len(data) >= 131072:
                break
    except socket.timeout:
        rec["totalMs"] = int((time.monotonic() - t_start) * 1000)
        rec["errorStage"] = "TIMEOUT"
        rec["errorCode"] = "read timeout"
        sock.close()
        return rec
    except socket.error as exc:
        rec["totalMs"] = int((time.monotonic() - t_start) * 1000)
        rec["errorStage"] = "TCP"
        rec["errorCode"] = "recv: %s" % exc
        sock.close()
        return rec
    try:
        sock.close()
    except Exception:
        pass

    rec["ttfbMs"] = int((time.monotonic() - t_start) * 1000)
    rec["totalMs"] = int((time.monotonic() - t_start) * 1000)
    # ttfb 精确到首字节
    rec["ttfbMs"] = int((t0 - t_start) * 1000) if data else None

    # 解析响应行与头
    try:
        head, _, body = data.partition(b"\r\n\r\n")
        lines = head.split(b"\r\n")
        status_line = lines[0].decode("latin1", "replace")
        parts = status_line.split(" ", 2)
        rec["httpStatus"] = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
        for line in lines[1:]:
            if line.lower().startswith(b"location:"):
                rec["redirectTarget"] = line.split(b":", 1)[1].strip().decode("latin1", "replace")
        rec["_body"] = body
    except Exception:
        rec["httpStatus"] = None

    if rec["httpStatus"] is None:
        rec["errorStage"] = "HTTP"
        rec["errorCode"] = "malformed response"
        return rec
    rec["success"] = True
    return rec


def cert_days_remaining(cert):
    if not cert:
        return None
    na = cert.get("notAfter")
    if not na:
        return None
    try:
        for fmt in ("%Y%m%d%H%M%SZ", "%b %d %H:%M:%S %Y GMT", "%b  %d %H:%M:%S %Y GMT"):
            try:
                d = datetime.datetime.strptime(na.strip(), fmt).replace(tzinfo=datetime.timezone.utc)
                return max(0, (d - datetime.datetime.now(datetime.timezone.utc)).days)
            except ValueError:
                continue
    except Exception:
        return None
    return None


def cert_identity(cert):
    if not cert:
        return None
    serial = cert.get("serialNumber")
    not_after = cert.get("notAfter")
    if not not_after:
        return None
    return "%s|%s" % (serial, not_after)


def validate_bare(rec):
    """裸域名首页: 200 + TLS 有效 + 内容标识"""
    if rec["errorStage"]:
        return rec
    if rec["httpStatus"] != 200:
        rec["success"] = False
        rec["errorStage"] = "HTTP"
        rec["errorCode"] = "status=%s" % rec["httpStatus"]
        return rec
    if b"<" not in rec.get("_body", b"") or CONTENT_MARKER not in rec.get("_body", b""):
        rec["success"] = False
        rec["errorStage"] = "CONTENT"
        rec["errorCode"] = "marker missing"
        return rec
    rec["success"] = True
    return rec


def validate_www(rec):
    """www: 301/308 且 Location == 规范地址"""
    if rec["errorStage"]:
        return rec
    if rec["httpStatus"] not in (301, 308):
        rec["success"] = False
        rec["errorStage"] = "HTTP"
        rec["errorCode"] = "www_status=%s" % rec["httpStatus"]
        return rec
    if rec.get("redirectTarget") != WWW_EXPECTED_LOCATION:
        rec["success"] = False
        rec["errorStage"] = "HTTP"
        rec["errorCode"] = "www_location=%s" % rec.get("redirectTarget")
        return rec
    rec["success"] = True
    return rec


def validate_comments(rec):
    """评论服务 healthz: 200 + ok:true"""
    if rec["errorStage"]:
        return rec
    if rec["httpStatus"] != 200:
        rec["success"] = False
        rec["errorStage"] = "HTTP"
        rec["errorCode"] = "comments_status=%s" % rec["httpStatus"]
        return rec
    if b'"ok":true' not in rec.get("_body", b""):
        rec["success"] = False
        rec["errorStage"] = "CONTENT"
        rec["errorCode"] = "comments_marker_missing"
        return rec
    rec["success"] = True
    return rec


def check_backup(cfg):
    """检查异地备份状态（v0.5.1）：失败标记存在或最近成功过期即视为故障。

    读取 backup-to-cos.sh 写入的状态文件，不涉及任何凭据与备份内容。
    """
    rec = empty_record("file://backup-state")
    rec["httpStatus"] = 200
    try:
        if os.path.isfile(BACKUP_FAILURE_MARKER):
            rec["success"] = False
            rec["errorStage"] = "BACKUP"
            try:
                with open(BACKUP_FAILURE_MARKER, "r", encoding="utf-8") as fh:
                    marker = json.load(fh)
                rec["errorCode"] = "backup_failed:stage=%s code=%s time=%s" % (
                    marker.get("stage", "?"), marker.get("errorCode", "?"), marker.get("time", "?"))
            except Exception:
                rec["errorCode"] = "backup_failed:marker_unreadable"
            return rec
        if not os.path.isfile(BACKUP_LAST_SUCCESS):
            rec["success"] = False
            rec["errorStage"] = "BACKUP"
            rec["errorCode"] = "backup_no_success_record"
            return rec
        with open(BACKUP_LAST_SUCCESS, "r", encoding="utf-8") as fh:
            last = fh.read().strip()
        last_dt = datetime.datetime.fromisoformat(last)
        age_hours = (datetime.datetime.now().astimezone() - last_dt).total_seconds() / 3600.0
        if age_hours > BACKUP_MAX_AGE_HOURS:
            rec["success"] = False
            rec["errorStage"] = "BACKUP"
            rec["errorCode"] = "backup_stale:%.1fh" % age_hours
            return rec
        rec["errorCode"] = "last_success=%s" % last
        rec["success"] = True
        return rec
    except Exception as exc:
        rec["success"] = False
        rec["errorStage"] = "BACKUP"
        rec["errorCode"] = "backup_check_error: %s" % str(exc)
        return rec


def strip_internal(rec):
    """去掉内部字段, 只保留统一 schema 字段 (不含正文/证书原始对象)."""
    rec = dict(rec)
    for k in list(rec.keys()):
        if k.startswith("_"):
            rec.pop(k, None)
    return rec


def primary_error_stage(records):
    """取最主要失败阶段 (DNS > TLS > TCP > HTTP > CONTENT > TIMEOUT)"""
    order = {"DNS": 0, "TLS": 1, "TCP": 2, "HTTP": 3, "CONTENT": 4, "TIMEOUT": 5}
    best = None
    for r in records:
        st = r.get("errorStage")
        if st and st != "INTERNAL":
            if best is None or order.get(st, 9) < order.get(best, 9):
                best = st
    return best or ("INTERNAL" if any(r.get("errorStage") == "INTERNAL" for r in records) else None)


def site_ok(records):
    return all(r.get("success", False) for r in records)


def new_state(observer):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "observer": observer,
        "state": "HEALTHY",
        "consecutiveFailures": 0,
        "consecutiveSuccesses": 0,
        "failureStartedAt": None,
        "lastCheckAt": None,
        "alertSentAt": None,
        "episode": None,
        "cert": {"identity": None, "thresholdsFired": []},
    }


def load_state(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            st = json.load(fh)
        if not isinstance(st, dict):
            return None
        if "consecutiveFailures" not in st:
            return None
        return st
    except Exception:
        return None


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def run_state_machine(state, ok, primary_stage, now_iso_str):
    """纯函数. 返回 (new_state, action), action in (None,'alert','recovery').
    不发送邮件, 由调用方决定是否发送."""
    st = json.loads(json.dumps(state))  # deep copy
    st["lastCheckAt"] = now_iso_str
    st["consecutiveSuccesses"] = st.get("consecutiveSuccesses", 0)
    st["consecutiveFailures"] = st.get("consecutiveFailures", 0)
    cur = st.get("state", "HEALTHY")
    action = None

    if ok:
        st["consecutiveFailures"] = 0
        st["consecutiveSuccesses"] += 1
        if cur in ("ALERTING", "RECOVERED"):
            if st["consecutiveSuccesses"] >= 2:
                st["state"] = "HEALTHY"
                st["failureStartedAt"] = None
                st["episode"] = None
                action = "recovery"
            else:
                st["state"] = "RECOVERED"
        elif cur == "PENDING_FAILURE":
            st["state"] = "HEALTHY"
            st["failureStartedAt"] = None
        else:
            st["state"] = "HEALTHY"
    else:
        st["consecutiveSuccesses"] = 0
        st["consecutiveFailures"] += 1
        if cur in ("HEALTHY", "PENDING_FAILURE"):
            if st["failureStartedAt"] is None:
                st["failureStartedAt"] = now_iso_str
            if st["consecutiveFailures"] >= 3 and st.get("alertSentAt") is None:
                st["state"] = "ALERTING"
                st["episode"] = {
                    "failureCount": st["consecutiveFailures"],
                    "primaryErrorStage": primary_stage,
                    "failureStartedAt": st["failureStartedAt"],
                }
                action = "alert"
            else:
                st["state"] = "PENDING_FAILURE"
        elif cur == "ALERTING":
            st["state"] = "ALERTING"
        elif cur == "RECOVERED":
            st["state"] = "ALERTING"
            # 复发: 已在告警, 不重发
    return st, action


def _smtp_connect(cfg):
    host = cfg.get("SMTP_HOST", "").strip()
    port = int(cfg.get("SMTP_PORT", "465") or "465")
    mode = (cfg.get("SMTP_MODE", "ssl") or "ssl").strip().lower()
    timeout = 20
    if mode == "ssl":
        return smtplib.SMTP_SSL(host, port, timeout=timeout)
    smtp = smtplib.SMTP(host, port, timeout=timeout)
    if mode == "starttls":
        smtp.starttls(context=ssl.create_default_context())
    return smtp


def send_mail(cfg, subject, body):
    """发送邮件. 成功返回 (True, None); 失败返回 (False, 错误摘要).
    SMTP_PASS 永不进入返回/日志."""
    host = cfg.get("SMTP_HOST", "").strip()
    if not host:
        return False, "mail_not_configured"
    try:
        from email.mime.text import MIMEText
        from email.header import Header
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = cfg.get("SMTP_FROM", "").strip() or cfg.get("SMTP_USER", "").strip()
        msg["To"] = cfg.get("MAIL_TO", "").strip()
        smtp = _smtp_connect(cfg)
        user = cfg.get("SMTP_USER", "").strip()
        if user:
            smtp.login(user, cfg.get("SMTP_PASS", ""))
        smtp.sendmail(msg["From"], [msg["To"]], msg.as_string())
        smtp.quit()
        return True, None
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, str(exc))


def build_alert_body(cfg, observer, state, records, recent_time):
    stage = state.get("episode", {}).get("primaryErrorStage") or primary_error_stage(records)
    start = state.get("episode", {}).get("failureStartedAt") or state.get("failureStartedAt")
    lines = []
    lines.append("《历代纪》网站连续 %d 次访问失败" % state.get("consecutiveFailures", 3))
    lines.append("")
    lines.append("观测点    : %s" % observer)
    lines.append("开始失败  : %s" % start)
    lines.append("最近检测  : %s" % recent_time)
    lines.append("主要阶段  : %s" % stage)
    for r in records:
        if not r.get("success", True):
            lines.append("")
            lines.append("故障URL   : %s" % r.get("url"))
            lines.append("错误阶段  : %s" % r.get("errorStage"))
            lines.append("错误码    : %s" % r.get("errorCode"))
            lines.append("解析IP    : %s" % r.get("resolvedIp"))
            lines.append("HTTP状态  : %s" % r.get("httpStatus"))
            lines.append("DNS/TCP/TLS/TTFB: %s/%s/%s/%s ms" % (
                r.get("dnsMs"), r.get("tcpMs"), r.get("tlsMs"), r.get("ttfbMs")))
    lines.append("")
    lines.append("日志位置  : %s/health.jsonl" % cfg.get("LOG_DIR", "?"))
    lines.append("")
    lines.append("本邮件为自动告警, 回复地址无效。")
    return "\n".join(lines)


def build_recovery_body(cfg, observer, episode, last_record, recent_time):
    stage = episode.get("primaryErrorStage") if episode else "?"
    start = episode.get("failureStartedAt") if episode else "?"
    count = episode.get("failureCount") if episode else 0
    lines = []
    lines.append("《历代纪》网站已恢复访问")
    lines.append("")
    lines.append("观测点        : %s" % observer)
    lines.append("开始失败时间  : %s" % start)
    lines.append("恢复时间      : %s" % recent_time)
    lines.append("持续时长      : 见开始/恢复时间差")
    lines.append("失败次数      : %d 次连续失败" % count)
    lines.append("主要错误阶段  : %s" % stage)
    lines.append("恢复后HTTP状态: %s" % last_record.get("httpStatus"))
    lines.append("恢复后响应时间: %.0f ms" % (last_record.get("totalMs") or 0))
    lines.append("")
    lines.append("本邮件为自动恢复通知, 回复地址无效。")
    return "\n".join(lines)


def build_cert_body(observer, days, threshold, not_after):
    return (
        "《历代纪》HTTPS 证书将在 %d 天内到期 (阈值 %d 天)\n"
        "观测点: %s\n"
        "剩余天数: %d\n"
        "证书到期(notAfter): %s\n\n"
        "请尽快安排续期。本邮件为自动告警。" % (days, threshold, observer, days, not_after)
    )


def check_cert_thresholds(state, cert_info, days):
    """返回 (new_state, (threshold, days) or None). 每证书每档只发一次."""
    st = json.loads(json.dumps(state))
    c = st.setdefault("cert", {"identity": None, "thresholdsFired": []})
    if cert_info is None or days is None:
        return st, None
    if c.get("identity") != cert_info:
        c["identity"] = cert_info
        c["thresholdsFired"] = []
    fired = set(c.get("thresholdsFired", []))
    mail_th = None
    for th in CERT_THRESHOLDS:
        if days <= th and th not in fired:
            mail_th = (th, days)
            fired.add(th)
            break
    c["thresholdsFired"] = sorted(fired)
    return st, mail_th


def rotate_jsonl(log_path, keep=30, max_bytes=2 * 1024 * 1024):
    if not os.path.exists(log_path):
        return
    today = datetime.date.today().strftime("%Y%m%d")
    size = os.path.getsize(log_path)
    mtime_day = datetime.date.fromtimestamp(os.path.getmtime(log_path)).strftime("%Y%m%d")
    if size > max_bytes or mtime_day != today:
        dest = "%s.%s" % (log_path, mtime_day)
        if not os.path.exists(dest):
            os.rename(log_path, dest)
    names = sorted(
        p for p in os.listdir(os.path.dirname(log_path))
        if p.startswith(os.path.basename(log_path) + ".")
    )
    for n in names[:-keep]:
        try:
            os.remove(os.path.join(os.path.dirname(log_path), n))
        except OSError:
            pass


def write_jsonl(path, rec):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        fh.write("\n")
        fh.flush()





def perform_checks(cfg, observer):
    """执行所有探测, 返回 (records, cert_info, cert_days). records 已含内部字段."""
    bare = probe_url(BARE_URL)
    validate_bare(bare)
    www = probe_url(WWW_URL)
    validate_www(www)
    records = [bare, www]
    cert_info, cert_days = None, None
    if bare.get("_cert_identity"):
        cert_info = bare["_cert_identity"]
        cert_days = bare.get("certificateDaysRemaining")
    if cfg.get("CHECK_COMMENTS") == "1":
        comments = probe_url("http://127.0.0.1:4317/healthz", connect_timeout=5.0, read_timeout=10.0)
        validate_comments(comments)
        records.append(comments)
    if cfg.get("CHECK_BACKUP") == "1":
        records.append(check_backup(cfg))
    return records, cert_info, cert_days


def process_run(cfg, state_path, log_path):
    observer = cfg.get("OBSERVER", "unknown")
    ok_all = True
    recs_out = []
    cert_info = None
    cert_days = None
    try:
        records, cert_info, cert_days = perform_checks(cfg, observer)
        for r in records:
            r["observer"] = observer
            out = strip_internal(r)
            recs_out.append(out)
        ok_all = site_ok(records)
        primary = primary_error_stage(records)
    except Exception as exc:
        rec = empty_record(BARE_URL)
        rec["observer"] = observer
        rec["errorStage"] = "INTERNAL"
        rec["errorCode"] = "monitor_exception: %s" % str(exc)
        rec["success"] = False
        recs_out.append(strip_internal(rec))
        primary = "INTERNAL"
        ok_all = False

    state = load_state(state_path) or new_state(observer)
    if state.get("observer") != observer:
        state = new_state(observer)

    now = now_iso()
    new_state_obj, action = run_state_machine(state, ok_all, primary, now)
    mail_outcome = None

    if action == "alert":
        new_state_obj, mail_outcome = dispatch_alert(cfg, observer, new_state_obj, recs_out, now)

    if action == "recovery":
        new_state_obj, mail_outcome = dispatch_recovery(cfg, observer, new_state_obj, state, recs_out, now)

    # 证书阈值
    cert_mail = None
    if cert_info is not None and cert_days is not None:
        new_state_obj, cert_mail = check_cert_thresholds(new_state_obj, cert_info, cert_days)
        if cert_mail:
            th, days = cert_mail
            new_state_obj, cert_out = dispatch_cert(cfg, observer, new_state_obj, cert_info, days, th, now)
            if cert_out:
                mail_outcome = cert_out

    # 持久化
    for r in recs_out:
        write_jsonl(log_path, r)
    try:
        save_state(state_path, new_state_obj)
    except Exception as exc:
        rec = empty_record(BARE_URL)
        rec["observer"] = observer
        rec["errorStage"] = "INTERNAL"
        rec["errorCode"] = "state_save: %s" % str(exc)
        write_jsonl(log_path, strip_internal(rec))

    if mail_outcome and not ok_all:
        sys.stderr.write("mail_error: %s\n" % mail_outcome)
    return recs_out


def _mail_configured(cfg):
    return bool(cfg.get("SMTP_HOST", "").strip())


def dispatch_alert(cfg, observer, state, records, now, send_fn=None):
    """连续3次失败的告警分发. 返回 (state, outcome). 邮件失败则退回 PENDING_FAILURE 待重试."""
    send_fn = send_fn or send_mail
    subject = "[历代纪告警] 网站连续3次访问失败"
    body = build_alert_body(cfg, observer, state, records, now)
    outcome = None
    if _mail_configured(cfg):
        ok, err = send_fn(cfg, subject, body)
        if ok:
            state["alertSentAt"] = now
        else:
            outcome = err
            state["state"] = "PENDING_FAILURE"
            state["episode"] = None
    else:
        state["alertSentAt"] = now
        outcome = "mail_not_configured"
    _log_alert(cfg, observer, "ALERT", now, state, records)
    return state, outcome


def dispatch_recovery(cfg, observer, state, old_state, records, now, send_fn=None):
    send_fn = send_fn or send_mail
    episode = old_state.get("episode") or {}
    last_ok = next((r for r in records if r.get("success")), records[-1] if records else {})
    subject = "[历代纪恢复] 网站已恢复访问"
    body = build_recovery_body(cfg, observer, episode, last_ok, now)
    outcome = None
    if _mail_configured(cfg):
        ok, err = send_fn(cfg, subject, body)
        if not ok:
            outcome = err
    else:
        outcome = "mail_not_configured"
    _log_alert(cfg, observer, "RECOVERY", now, state, records)
    return state, outcome


def dispatch_cert(cfg, observer, state, cert_info, days, th, now, send_fn=None):
    send_fn = send_fn or send_mail
    subject = "[历代纪证书] HTTPS证书将在%d天内到期" % th
    body = build_cert_body(observer, days, th, cert_info)
    outcome = None
    if _mail_configured(cfg):
        ok, err = send_fn(cfg, subject, body)
        if not ok:
            outcome = err
            _rollback_cert_threshold(state, th)
    _log_alert(cfg, observer, "CERT(%dd)" % th, now, state, [])
    return state, outcome


def _rollback_cert_threshold(state, threshold):
    fired = set(state.get("cert", {}).get("thresholdsFired", []))
    fired.discard(threshold)
    state.setdefault("cert", {})["thresholdsFired"] = sorted(fired)


def _log_alert(cfg, observer, kind, ts, state, records):
    log_dir = cfg.get("LOG_DIR", ".")
    alerts = os.path.join(log_dir, "alerts.log")
    try:
        with open(alerts, "a", encoding="utf-8") as fh:
            fh.write("%s kind=%s observer=%s state=%s stage=%s\n" % (
                ts, kind, observer, state.get("state"), primary_error_stage(records)))
    except OSError:
        pass


def test_mode_alert(cfg):
    observer = cfg.get("OBSERVER", "test-observer")
    subject = "[测试][历代纪告警] 网站连续3次访问失败"
    fake = empty_record(BARE_URL)
    fake["observer"] = observer
    fake["httpStatus"] = None
    fake["errorStage"] = "TIMEOUT"
    fake["errorCode"] = "测试注入: connect timeout"
    fake["success"] = False
    body = build_alert_body(cfg, observer, {
        "consecutiveFailures": 3, "episode": {
            "primaryErrorStage": "TIMEOUT", "failureStartedAt": now_iso(),
        }}, [fake], now_iso())
    ok, err = send_mail(cfg, subject, body)
    print("send=%s %s" % (ok, err or ""))
    return 0 if ok else 1


def test_mode_recovery(cfg):
    observer = cfg.get("OBSERVER", "test-observer")
    subject = "[测试][历代纪恢复] 网站已恢复访问"
    ep = {"failureCount": 3, "primaryErrorStage": "TIMEOUT", "failureStartedAt": now_iso()}
    last = empty_record(BARE_URL)
    last["observer"] = observer
    last["httpStatus"] = 200
    last["totalMs"] = 150
    last["success"] = True
    body = build_recovery_body(cfg, observer, ep, last, now_iso())
    ok, err = send_mail(cfg, subject, body)
    print("send=%s %s" % (ok, err or ""))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="历代纪站点统一可用性监控")
    ap.add_argument("--config", required=True, help="env 配置文件路径")
    ap.add_argument("--dry-run", action="store_true", help="只检查并打印 JSONL")
    ap.add_argument("--test-alert", action="store_true", help="发送测试故障邮件(不持久化)")
    ap.add_argument("--test-recovery", action="store_true", help="发送测试恢复邮件(不持久化)")
    args = ap.parse_args()

    cfg = parse_config(args.config)
    cfg.setdefault("OBSERVER", "unknown")
    cfg.setdefault("CHECK_COMMENTS", "0")
    cfg.setdefault("CHECK_BACKUP", "0")
    cfg.setdefault("LOG_DIR", ".")
    observer = cfg.get("OBSERVER")

    if args.test_alert:
        return test_mode_alert(cfg)
    if args.test_recovery:
        return test_mode_recovery(cfg)

    log_dir = cfg.get("LOG_DIR")
    if not os.path.isdir(log_dir):
        os.makedirs(log_dir, exist_ok=True)
    state_path = os.path.join(log_dir, "state.json")
    log_path = os.path.join(log_dir, "health.jsonl")

    if args.dry_run:
        records, _, _ = perform_checks(cfg, observer)
        for r in records:
            r["observer"] = observer
            print(json.dumps(strip_internal(r), ensure_ascii=False, separators=(",", ":")))
        return 0

    try:
        rotate_jsonl(log_path)
    except Exception:
        pass
    process_run(cfg, state_path, log_path)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write("INTERNAL monitor crash: %s\n" % exc)
        sys.exit(1)
