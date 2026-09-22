#!/usr/bin/env python3
"""Standalone document parsing and contract validation CLI."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .paper_resolver import PaperResolutionError, resolve_catalog_paper, resolve_local_pdf
from .pdf_parser import PdfParseError, parse_pdf
from .schemas import ContractValidationError, validate_json_file, validate_jsonl_file
from .validators import validate_document_bundle


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _write_jsonl(path: Path, values: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text("".join(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n" for value in values), encoding="utf-8")
    temporary.replace(path)


def parse_command(args: argparse.Namespace) -> dict[str, Any]:
    neo_cast_root = Path(args.neo_cast_root).resolve()
    if args.paper_id:
        paper = resolve_catalog_paper(neo_cast_root, args.paper_id)
    else:
        paper = resolve_local_pdf(
            Path(args.pdf), title=args.title, year=args.year, venue=args.venue,
            publication_status=args.publication_status, doi=args.doi,
        )
    result = parse_pdf(
        paper.pdf_path,
        paper_id=paper.paper_id,
        source_sha256=paper.pdf_sha256,
        title=paper.title,
    )
    validate_document_bundle(result.document, result.chunks)
    output_root = Path(args.output_root).resolve() if args.output_root else neo_cast_root / ".neo-cast" / "literature-knowledge"
    document_dir = output_root / "documents" / paper.paper_id
    document_path = document_dir / f"{paper.pdf_sha256}.document.json"
    chunks_path = document_dir / f"{paper.pdf_sha256}.chunks.jsonl"
    metadata_path = document_dir / f"{paper.pdf_sha256}.paper.json"
    _write_json(document_path, result.document)
    _write_jsonl(chunks_path, result.chunks)
    _write_json(metadata_path, paper.metadata)
    return {
        "command": "parse", "status": result.status, "paperID": paper.paper_id,
        "documentID": result.document["documentID"], "documentPath": str(document_path),
        "chunksPath": str(chunks_path), "chunkCount": len(result.chunks),
        "warningCount": len(result.document["parseWarnings"]),
        "publicationStatus": paper.publication_status,
    }


def validate_command(args: argparse.Namespace) -> dict[str, Any]:
    path = Path(args.path).resolve()
    count = validate_jsonl_file(path) if path.suffix == ".jsonl" else (validate_json_file(path) or 1)
    return {"command": "validate", "status": "valid", "path": str(path), "recordCount": count}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    parse = subparsers.add_parser("parse", help="resolve and normalize one explicit PDF")
    parse.add_argument("--neo-cast-root", required=True)
    source = parse.add_mutually_exclusive_group(required=True)
    source.add_argument("--paper-id")
    source.add_argument("--pdf")
    parse.add_argument("--title")
    parse.add_argument("--year", type=int)
    parse.add_argument("--venue")
    parse.add_argument("--publication-status", choices=["peer_reviewed", "preprint", "unknown"], default="unknown")
    parse.add_argument("--doi")
    parse.add_argument("--output-root")
    validate = subparsers.add_parser("validate", help="validate a JSON or JSONL contract artifact")
    validate.add_argument("path")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "parse" and args.pdf and not args.title:
        parser.error("--title is required with --pdf")
    try:
        summary = parse_command(args) if args.command == "parse" else validate_command(args)
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    except (PaperResolutionError, PdfParseError, ContractValidationError, OSError, RuntimeError) as error:
        code = getattr(error, "code", "literature_knowledge_error")
        print(json.dumps({"status": "failed", "error": {"code": code, "message": str(error)}}, ensure_ascii=False, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
