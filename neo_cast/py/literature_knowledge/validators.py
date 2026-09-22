"""Cross-artifact integrity checks beyond individual JSON Schema validation."""

from __future__ import annotations

import hashlib
from typing import Any

from .schemas import ContractValidationError, validate_contract


def validate_document_bundle(document: dict[str, Any], chunks: list[dict[str, Any]]) -> None:
    validate_contract(document)
    page_numbers = [page["pageNumber"] for page in document["pages"]]
    if page_numbers != list(range(1, len(page_numbers) + 1)):
        raise ContractValidationError("document pages must be sequential and one-based")
    block_ids = [block["blockID"] for page in document["pages"] for block in page["blocks"]]
    if len(block_ids) != len(set(block_ids)):
        raise ContractValidationError("document contains duplicate blockID values")
    known_blocks = set(block_ids)
    for section in document["sections"]:
        unknown = set(section["blockIDs"]) - known_blocks
        if unknown:
            raise ContractValidationError(f"section {section['sectionID']} references unknown blocks")
    chunk_ids = {chunk["chunkID"] for chunk in chunks}
    if len(chunk_ids) != len(chunks):
        raise ContractValidationError("document contains duplicate chunkID values")
    for chunk in chunks:
        validate_contract(chunk)
        if chunk["pageStart"] > chunk["pageEnd"]:
            raise ContractValidationError(f"chunk {chunk['chunkID']} has a reversed page range")
        if chunk["documentID"] != document["documentID"] or chunk["paperID"] != document["paperID"]:
            raise ContractValidationError(f"chunk {chunk['chunkID']} belongs to another document")
        if hashlib.sha256(chunk["text"].encode("utf-8")).hexdigest() != chunk["textSha256"]:
            raise ContractValidationError(f"chunk {chunk['chunkID']} textSha256 mismatch")
        for link in ("previousChunkID", "nextChunkID"):
            if link in chunk and chunk[link] not in chunk_ids:
                raise ContractValidationError(f"chunk {chunk['chunkID']} has broken {link}")
