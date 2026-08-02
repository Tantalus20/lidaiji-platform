"""Stable article and paragraph identities for Markdown imports.

The source marker is intentionally a plain HTML comment so the Markdown remains
portable. Hugo does not need to render the comment; the release post-processor
uses it to attach the same identity to the corresponding HTML paragraph.
"""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from difflib import SequenceMatcher

MARKER = re.compile(r"^<!-- paragraph-id:(p-[a-f0-9]{12}) -->$")
HEADING = re.compile(r"^#{1,6}\s+(.+)$")


@dataclass(frozen=True)
class ParagraphRecord:
    paragraph_id: str
    text: str
    normalized: str
    heading: str
    position: int


@dataclass(frozen=True)
class MatchReport:
    retained: int
    created: int
    ambiguous: tuple[str, ...]
    deleted: tuple[ParagraphRecord, ...]


def new_article_id() -> str:
    return f"article-{secrets.token_hex(8)}"


def new_paragraph_id() -> str:
    return f"p-{secrets.token_hex(6)}"


def normalize_markdown(value: str) -> str:
    value = re.sub(r"\[\^[^\]]+]", "", value)
    value = re.sub(r"!\[[^\]]*]\([^)]*\)", " 图片 ", value)
    value = re.sub(r"\[([^\]]+)]\([^)]*\)", r"\1", value)
    value = re.sub(r"[*_`~\\]", "", value)
    return re.sub(r"\s+", "", value).strip().casefold()


def is_commentable(block: str) -> bool:
    value = block.strip()
    if not value or MARKER.fullmatch(value):
        return False
    blocked = ("#", ">", "-", "* ", "+ ", "|", "![", "{{", "<", "```", "~~~", "[^")
    if value.startswith(blocked) or "\n|" in value:
        return False
    return re.match(r"^\d+[.)]\s+", value) is None


def split_blocks(markdown_body: str) -> list[str]:
    return [item.strip() for item in re.split(r"\n{2,}", markdown_body.strip()) if item.strip()]


def records_from_markdown(markdown_body: str) -> list[ParagraphRecord]:
    blocks = split_blocks(markdown_body)
    records: list[ParagraphRecord] = []
    heading = ""
    pending_id = ""
    for block in blocks:
        heading_match = HEADING.match(block)
        if heading_match:
            heading = normalize_markdown(heading_match.group(1))
            pending_id = ""
            continue
        marker_match = MARKER.fullmatch(block)
        if marker_match:
            pending_id = marker_match.group(1)
            continue
        if is_commentable(block):
            if pending_id:
                records.append(
                    ParagraphRecord(
                        pending_id,
                        block,
                        normalize_markdown(block),
                        heading,
                        len(records),
                    )
                )
            pending_id = ""
        else:
            pending_id = ""
    return records


def _candidate_score(
    new_text: str,
    new_heading: str,
    new_position: int,
    old: ParagraphRecord,
    old_total: int,
    new_total: int,
) -> float:
    text_score = SequenceMatcher(None, new_text, old.normalized, autojunk=False).ratio()
    heading_bonus = 0.08 if new_heading and new_heading == old.heading else 0.0
    old_relative = old.position / max(1, old_total - 1)
    new_relative = new_position / max(1, new_total - 1)
    position_bonus = max(0.0, 0.06 - abs(old_relative - new_relative) * 0.06)
    return text_score + heading_bonus + position_bonus


def assign_ids(markdown_body: str, previous_body: str = "") -> tuple[str, MatchReport]:
    """Add markers while preserving only high-confidence previous identities."""

    old_records = records_from_markdown(previous_body)
    old_by_id = {record.paragraph_id: record for record in old_records}
    used: set[str] = set()
    blocks = split_blocks(markdown_body)
    commentable_total = sum(1 for block in blocks if is_commentable(block))
    output: list[str] = []
    heading = ""
    retained = 0
    created = 0
    ambiguous: list[str] = []
    existing_marker = ""
    position = 0

    for block in blocks:
        marker_match = MARKER.fullmatch(block)
        if marker_match:
            existing_marker = marker_match.group(1)
            continue
        heading_match = HEADING.match(block)
        if heading_match:
            heading = normalize_markdown(heading_match.group(1))
            output.append(block)
            existing_marker = ""
            continue
        if not is_commentable(block):
            output.append(block)
            existing_marker = ""
            continue

        normalized = normalize_markdown(block)
        paragraph_id = ""
        if existing_marker and existing_marker not in used:
            paragraph_id = existing_marker
        else:
            scored = sorted(
                (
                    (
                        _candidate_score(
                            normalized,
                            heading,
                            position,
                            record,
                            len(old_records),
                            commentable_total,
                        ),
                        record,
                    )
                    for record in old_records
                    if record.paragraph_id not in used
                ),
                key=lambda item: item[0],
                reverse=True,
            )
            if scored:
                best_score, best = scored[0]
                next_score = scored[1][0] if len(scored) > 1 else -1.0
                exact = normalized == best.normalized
                confidence = best_score >= (1.0 if exact else 0.96)
                separated = exact or best_score - next_score >= 0.035
                if confidence and separated:
                    paragraph_id = best.paragraph_id
                elif best_score >= 0.90:
                    ambiguous.append(block[:100])

        if paragraph_id:
            retained += 1
        else:
            paragraph_id = new_paragraph_id()
            created += 1
        used.add(paragraph_id)
        output.extend((f"<!-- paragraph-id:{paragraph_id} -->", block))
        existing_marker = ""
        position += 1

    deleted = tuple(record for key, record in old_by_id.items() if key not in used)
    return "\n\n".join(output).strip() + "\n", MatchReport(retained, created, tuple(ambiguous), deleted)


def revision_for(article_id: str, markdown_body: str) -> str:
    digest = hashlib.sha256(markdown_body.encode("utf-8")).hexdigest()[:12]
    return f"{article_id}@{digest}"
