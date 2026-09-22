"""Page-preserving PDF normalization using PyMuPDF."""

from __future__ import annotations

import dataclasses
import hashlib
import re
from collections import Counter
from pathlib import Path
from typing import Any

from .chunker import chunk_document
from .section_classifier import build_sections


PARSER_VERSION = "pymupdf_document_v1"
PROMPT_INJECTION_RE = re.compile(
    r"(?:ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt|you\s+are\s+chatgpt|do\s+not\s+follow\s+the\s+instructions)",
    re.IGNORECASE,
)


@dataclasses.dataclass(frozen=True)
class ParseResult:
    status: str
    document: dict[str, Any]
    chunks: list[dict[str, Any]]


class PdfParseError(ValueError):
    code = "pdf_parse_error"


def _normalize_text(text: str) -> str:
    text = text.replace("\u00ad", "").replace("\u00a0", " ")
    return "\n".join(" ".join(line.split()) for line in text.splitlines() if line.strip()).strip()


def _repetition_key(text: str) -> str:
    return re.sub(r"\d+", "#", " ".join(text.casefold().split()))[:160]


def _language(text: str) -> str:
    latin = len(re.findall(r"[A-Za-z]", text))
    han = len(re.findall(r"[\u3400-\u9fff]", text))
    if han > latin * 0.35:
        return "zh"
    return "en" if latin else "und"


def _extract_raw_pages(pdf_path: Path) -> tuple[list[list[dict[str, Any]]], str]:
    try:
        import pymupdf as fitz
    except ImportError as error:  # pragma: no cover - dependency error is environment-specific
        raise RuntimeError("PyMuPDF is required for literature PDF parsing") from error
    try:
        source = fitz.open(pdf_path)
    except Exception as error:
        raise PdfParseError(f"unable to open PDF: {error}") from error
    pages: list[list[dict[str, Any]]] = []
    try:
        for page in source:
            height = float(page.rect.height or 1)
            raw_blocks = page.get_text("blocks", sort=True)
            blocks: list[dict[str, Any]] = []
            for raw in raw_blocks:
                if len(raw) < 5:
                    continue
                x0, y0, x1, y1, raw_text = raw[:5]
                text = _normalize_text(str(raw_text))
                if not text:
                    continue
                blocks.append({
                    "text": text,
                    "bbox": [round(float(x0), 3), round(float(y0), 3), round(float(x1), 3), round(float(y1), 3)],
                    "edge": "top" if float(y0) < height * 0.12 else "bottom" if float(y1) > height * 0.9 else "body",
                })
            pages.append(blocks)
        metadata_title = str(source.metadata.get("title") or "").strip() if source.metadata else ""
    finally:
        source.close()
    return pages, metadata_title


def parse_pdf(
    pdf_path: Path,
    *,
    paper_id: str,
    source_sha256: str,
    title: str | None = None,
) -> ParseResult:
    raw_pages, metadata_title = _extract_raw_pages(pdf_path)
    if not raw_pages:
        raise PdfParseError("PDF contains no pages")
    page_count = len(raw_pages)
    edge_counts = Counter(
        _repetition_key(block["text"])
        for page in raw_pages
        for block in page
        if block["edge"] != "body" and len(block["text"]) <= 200
    )
    repeated_edges = {
        key for key, count in edge_counts.items()
        if page_count >= 3 and count >= max(3, int(page_count * 0.5))
    }
    document_id = f"doc_{hashlib.sha256(f'{paper_id}|{source_sha256}|{PARSER_VERSION}'.encode()).hexdigest()[:16]}"
    pages: list[dict[str, Any]] = []
    prompt_injection_found = False
    for page_number, raw_blocks in enumerate(raw_pages, start=1):
        blocks: list[dict[str, Any]] = []
        for raw_index, raw_block in enumerate(raw_blocks):
            if raw_block["edge"] != "body" and _repetition_key(raw_block["text"]) in repeated_edges:
                continue
            text = raw_block["text"]
            prompt_injection_found = prompt_injection_found or PROMPT_INJECTION_RE.search(text) is not None
            blocks.append({
                "blockID": f"block_{page_number:04d}_{raw_index:04d}",
                "text": text,
                "bbox": raw_block["bbox"],
            })
        pages.append({
            "pageNumber": page_number,
            "text": "\n\n".join(block["text"] for block in blocks),
            "blocks": blocks,
        })

    full_text = "\n".join(page["text"] for page in pages)
    visible_chars = len(re.findall(r"[\w\u3400-\u9fff]", full_text))
    text_pages = sum(1 for page in pages if len(page["text"].strip()) >= 40)
    warnings: list[str] = []
    if repeated_edges:
        warnings.append(f"removed_repeated_headers_or_footers:{len(repeated_edges)}")
    if prompt_injection_found:
        warnings.append("prompt_injection_pattern_detected")
    ocr_required = visible_chars < max(200, page_count * 80) or text_pages < max(1, int(page_count * 0.4))
    if ocr_required:
        warnings.append("ocr_required")
    document: dict[str, Any] = {
        "schemaVersion": "normalized_document_v1",
        "documentID": document_id,
        "paperID": paper_id,
        "sourcePath": str(pdf_path.resolve()),
        "sourceSha256": source_sha256,
        "parser": {"name": "PyMuPDF", "version": PARSER_VERSION},
        "language": _language(full_text),
        **({"title": title or metadata_title} if title or metadata_title else {}),
        "pages": pages,
        "sections": build_sections(pages, document_id),
        "parseWarnings": warnings,
    }
    chunks = [] if ocr_required else chunk_document(document)
    return ParseResult(status="ocr_required" if ocr_required else "parsed", document=document, chunks=chunks)
