"""Deterministic document layer for the standalone literature knowledge base."""

from .chunker import CHUNKER_VERSION, chunk_document
from .paper_resolver import ResolvedPaper, resolve_catalog_paper, resolve_local_pdf
from .pdf_parser import PARSER_VERSION, ParseResult, parse_pdf

__all__ = [
    "CHUNKER_VERSION",
    "PARSER_VERSION",
    "ParseResult",
    "ResolvedPaper",
    "chunk_document",
    "parse_pdf",
    "resolve_catalog_paper",
    "resolve_local_pdf",
]
