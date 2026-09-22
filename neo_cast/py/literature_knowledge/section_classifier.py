"""Conservative heading recognition for normalized literature documents."""

from __future__ import annotations

import hashlib
import re
from typing import Any


SECTION_KINDS = (
    "abstract", "introduction", "related_work", "method", "experiment_setup",
    "results", "ablation", "complexity", "limitations", "conclusion", "references", "unknown",
)

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("abstract", re.compile(r"^abstract$", re.I)),
    ("introduction", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?introduction$", re.I)),
    ("related_work", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:related work|background|preliminar(?:y|ies))$", re.I)),
    ("method", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:method(?:ology)?|approach|model|architecture|proposed method)$", re.I)),
    ("experiment_setup", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:experimental setup|experiment setup|datasets? and metrics?|implementation details)$", re.I)),
    ("results", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:experiments?|results?|evaluation)$", re.I)),
    ("ablation", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:ablation(?: study| analysis)?|analysis)$", re.I)),
    ("complexity", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:complexity|computational complexity|efficiency)$", re.I)),
    ("limitations", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:limitations?|broader impact)$", re.I)),
    ("conclusion", re.compile(r"^(?:\d+(?:\.\d+)*\s+)?(?:conclusions?|discussion and conclusion)$", re.I)),
    ("references", re.compile(r"^(?:references|bibliography)$", re.I)),
]


def normalize_heading(text: str) -> str:
    return " ".join(text.replace("\n", " ").split()).strip(" .:-")


def classify_heading(text: str) -> str | None:
    heading = normalize_heading(text)
    if not heading or len(heading) > 120:
        return None
    for kind, pattern in _PATTERNS:
        if pattern.fullmatch(heading):
            return kind
    numbered = re.match(r"^(?:\d+(?:\.\d+)*|[IVX]+)\.?\s+[A-Z][A-Za-z0-9 ,/&()-]{2,80}$", heading)
    if numbered:
        return "unknown"
    return None


def build_sections(pages: list[dict[str, Any]], document_id: str) -> list[dict[str, Any]]:
    ordered: list[tuple[int, dict[str, Any]]] = []
    for page in pages:
        for block in page["blocks"]:
            ordered.append((page["pageNumber"], block))
    if not ordered:
        return []

    starts: list[tuple[int, str, str]] = []
    for index, (_, block) in enumerate(ordered):
        kind = classify_heading(block["text"])
        if kind is not None:
            starts.append((index, normalize_heading(block["text"]), kind))
    if not starts or starts[0][0] != 0:
        starts.insert(0, (0, "Unclassified front matter", "unknown"))

    sections: list[dict[str, Any]] = []
    for section_index, (start, heading, kind) in enumerate(starts):
        end = starts[section_index + 1][0] if section_index + 1 < len(starts) else len(ordered)
        entries = ordered[start:end]
        if not entries:
            continue
        digest = hashlib.sha256(f"{document_id}|{section_index}|{heading}".encode()).hexdigest()[:12]
        sections.append({
            "sectionID": f"section_{digest}",
            "heading": heading,
            "normalizedKind": kind,
            "startPage": entries[0][0],
            "endPage": entries[-1][0],
            "blockIDs": [entry[1]["blockID"] for entry in entries],
        })
    return sections
