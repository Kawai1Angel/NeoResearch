"""Resolve explicit catalog IDs or local PDFs without performing discovery."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


@dataclasses.dataclass(frozen=True)
class ResolvedPaper:
    paper_id: str
    pdf_path: Path
    pdf_sha256: str
    title: str
    year: int | None
    venue: str | None
    publication_status: str
    metadata: dict[str, Any]


class PaperResolutionError(ValueError):
    code = "paper_resolution_error"


class PaperNotFoundError(PaperResolutionError):
    code = "paper_not_found"


class PdfUnavailableError(PaperResolutionError):
    code = "pdf_unavailable"


class SourceIntegrityError(PaperResolutionError):
    code = "source_integrity_error"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _assert_pdf(path: Path) -> None:
    if not path.is_file():
        raise PdfUnavailableError(f"PDF is unavailable: {path}")
    with path.open("rb") as handle:
        signature = handle.read(5)
    if signature != b"%PDF-":
        raise PdfUnavailableError(f"file is not a PDF: {path}")


def _read_catalog(catalog_path: Path) -> list[dict[str, Any]]:
    if not catalog_path.is_file():
        raise PaperNotFoundError(f"catalog is unavailable: {catalog_path}")
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(catalog_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise PaperResolutionError(f"invalid catalog JSON at line {line_number}") from error
    return records


def resolve_catalog_paper(neo_cast_root: Path, paper_id: str) -> ResolvedPaper:
    catalog_candidates = [
        neo_cast_root / ".neo-cast" / "literature-source" / "catalog" / "papers.jsonl",
        neo_cast_root / "literature_source" / "catalog" / "papers.jsonl",
    ]
    catalog_path = next((candidate for candidate in catalog_candidates if candidate.is_file()), catalog_candidates[0])
    record = next((item for item in _read_catalog(catalog_path) if item.get("paper_id") == paper_id), None)
    if record is None:
        raise PaperNotFoundError(f"paper_id is not in catalog: {paper_id}")
    download = record.get("download") if isinstance(record.get("download"), dict) else {}
    if download.get("status") != "downloaded" or not download.get("path"):
        raise PdfUnavailableError(f"catalog paper has no downloaded PDF: {paper_id}")
    raw_path = Path(str(download["path"]))
    if raw_path.is_absolute():
        pdf_path = raw_path
    else:
        candidates = [
            neo_cast_root / raw_path,
            catalog_path.parent.parent / raw_path,
            neo_cast_root / "literature_source" / raw_path,
        ]
        pdf_path = next((candidate for candidate in candidates if candidate.is_file()), candidates[0])
    _assert_pdf(pdf_path)
    actual_hash = sha256_file(pdf_path)
    expected_hash = download.get("sha256")
    if expected_hash and expected_hash != actual_hash:
        raise SourceIntegrityError(f"PDF SHA-256 mismatch for {paper_id}")
    return ResolvedPaper(
        paper_id=paper_id,
        pdf_path=pdf_path.resolve(),
        pdf_sha256=actual_hash,
        title=str(record.get("title") or paper_id),
        year=record.get("year") if isinstance(record.get("year"), int) else None,
        venue=record.get("venue") if isinstance(record.get("venue"), str) else None,
        publication_status=str(record.get("publication_status") or "unknown"),
        metadata=record,
    )


def resolve_local_pdf(
    pdf_path: Path,
    *,
    title: str,
    year: int | None = None,
    venue: str | None = None,
    publication_status: str = "unknown",
    doi: str | None = None,
) -> ResolvedPaper:
    if publication_status not in {"peer_reviewed", "preprint", "unknown"}:
        raise PaperResolutionError(f"invalid publication status: {publication_status}")
    _assert_pdf(pdf_path)
    normalized_title = unicodedata.normalize("NFKC", title).strip()
    if not normalized_title:
        raise PaperResolutionError("local PDF title is required")
    title_key = re.sub(r"[^a-z0-9]+", "", normalized_title.casefold())
    title_hash = hashlib.sha256(title_key.encode("utf-8")).hexdigest()[:12]
    paper_id = f"local-{year or 'unknown'}-{title_hash}"
    return ResolvedPaper(
        paper_id=paper_id,
        pdf_path=pdf_path.resolve(),
        pdf_sha256=sha256_file(pdf_path),
        title=normalized_title,
        year=year,
        venue=venue,
        publication_status=publication_status,
        metadata={
            "title": normalized_title,
            "year": year,
            "venue": venue,
            "publication_status": publication_status,
            "doi": doi,
            "local_pdf": True,
        },
    )
