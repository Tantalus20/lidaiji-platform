"""候选敏感信息扫描（v0.2.5）。

只报告“命中类型 + 文件相对路径 + 安全截断位置”，绝不输出命中内容本身。

测试只能使用虚构凭据（TEST_TOKEN_DO_NOT_USE / example.invalid / 203.0.113.10）。
"""

from __future__ import annotations

import re
from pathlib import Path

MAX_TEXT_BYTES = 1024 * 1024  # 只扫描 ≤1MB 的文本候选文件
REPORT_LIMIT = 50

# 文件名/路径命中
_NAME_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("env-file", re.compile(r"(^|/)(\.env([\w.-]*))$")),
    ("ds-store", re.compile(r"(^|/)\.DS_Store$")),
    ("ssh-config", re.compile(r"(^|/)\.ssh(/|$)|(^|/)id_rsa$|(^|/)id_ed25519$|(^|/)known_hosts$")),
    ("private-key", re.compile(r"(^|/)[\w.-]*\.(pem|key|p12|pfx)$", re.IGNORECASE)),
    ("author-notes", re.compile(r"(^|/)author-notes(/|$)|(^|/)notes\.yaml$")),
    ("docx", re.compile(r"\.docx?$", re.IGNORECASE)),
    ("sqlite-db", re.compile(r"\.(sqlite3?|db|db-wal|db-shm)$", re.IGNORECASE)),
    ("log-file", re.compile(r"\.(log|log\.\d+)$", re.IGNORECASE)),
    ("tmp-file", re.compile(r"(^|/)tmp(/|$)|\.(tmp|swp|bak|orig)$", re.IGNORECASE)),
    ("credentials-json", re.compile(r"(^|/)(credentials|service-account|gcloud|secrets)[\w.-]*\.json$", re.IGNORECASE)),
    ("backup-archive", re.compile(r"\.(tar|tar\.gz|zip|7z)$", re.IGNORECASE)),
]

# 文本内容命中
_CONTENT_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("private-key-header", re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")),
    ("token-ghp", re.compile(r"\bghp_[A-Za-z0-9]{20,}\b")),
    ("token-gitlab", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    ("token-slack", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("token-aws", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("token-bearer", re.compile(r"\bBearer [A-Za-z0-9._-]{20,}")),
    ("writing-settings", re.compile(r"^WRITING_(SSH_TARGET|DOMAIN|PASSWORD|TOKEN|KEY|SECRET)\s*=", re.MULTILINE)),
    ("private-abs-path", re.compile(r"(^|[^:\w])(/Users/|/opt/writing-site|/var/backups/lidaiji|/etc/lidaiji-comments)")),
    ("test-token", re.compile(r"TEST_TOKEN_DO_NOT_USE")),
    ("password-field", re.compile(r"(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['\"]?[^\s'\"]{6,}", re.IGNORECASE)),
]

# 内容扫描额外排除的二进制后缀
_BINARY_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg",
    ".woff", ".woff2", ".ttf", ".eot", ".ico",
)


class SensitiveScanError(Exception):
    pass


def scan_file(file: Path) -> list[dict]:
    """扫描单个文件；返回 [{kind, at}]（at 为行号或 'filename'）。"""
    findings: list[dict] = []
    name = file.name
    rel = file.relative_to(*file.parts[:1]) if False else file.name
    for kind, pattern in _NAME_PATTERNS:
        if pattern.search(name):
            findings.append({"kind": kind, "at": "filename"})
    if file.stat().st_size > MAX_TEXT_BYTES:
        return findings
    if name.lower().endswith(_BINARY_SUFFIXES):
        return findings
    try:
        text = file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return findings
    for line_no, line in enumerate(text.splitlines(), 1):
        for kind, pattern in _CONTENT_PATTERNS:
            if pattern.search(line):
                findings.append({"kind": kind, "at": f"line {line_no}"})
    return findings


def scan_candidate(candidate_dir) -> dict:
    """扫描候选站点目录；只报告类型与位置，不输出内容。"""
    root = Path(candidate_dir)
    findings: list[dict] = []
    for file in sorted(root.rglob("*")):
        if not file.is_file():
            continue
        try:
            relative = file.relative_to(root).as_posix()
        except ValueError:
            continue
        for item in scan_file(file):
            findings.append({"path": relative, "kind": item["kind"], "at": item["at"]})
    findings = findings[:REPORT_LIMIT]
    return {
        "blocked": bool(findings),
        "findings": findings,
        "findingCount": len(findings),
    }
