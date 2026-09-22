"""Paragraph-preserving, deterministic chunk construction."""

from __future__ import annotations

import hashlib
from typing import Any


CHUNKER_VERSION = "paragraph_chunker_v1"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _chunk_id(document: dict[str, Any], section_id: str, ordinal: int) -> str:
    seed = f"{document['paperID']}|{document['sourceSha256']}|{section_id}|{ordinal}"
    return f"chunk_{_sha256(seed)[:20]}"


def chunk_document(
    document: dict[str, Any],
    *,
    target_chars: int = 3600,
    max_chars: int = 4800,
    overlap_chars: int = 500,
) -> list[dict[str, Any]]:
    """Chunk by source blocks, never splitting a block or sentence mid-string."""
    if not 1 <= overlap_chars < target_chars <= max_chars:
        raise ValueError("expected 1 <= overlap_chars < target_chars <= max_chars")
    block_lookup: dict[str, tuple[int, str]] = {}
    for page in document["pages"]:
        for block in page["blocks"]:
            block_lookup[block["blockID"]] = (page["pageNumber"], block["text"])

    chunks: list[dict[str, Any]] = []
    for section in document["sections"]:
        if section["normalizedKind"] == "references":
            continue
        entries = [block_lookup[item] for item in section["blockIDs"] if item in block_lookup and block_lookup[item][1].strip()]
        ordinal = 0
        cursor = 0
        while cursor < len(entries):
            selected: list[tuple[int, str]] = []
            length = 0
            index = cursor
            while index < len(entries):
                addition = len(entries[index][1]) + (2 if selected else 0)
                if selected and length + addition > max_chars:
                    break
                selected.append(entries[index])
                length += addition
                index += 1
                if length >= target_chars:
                    break
            if not selected:
                selected = [entries[cursor]]
                index = cursor + 1
            text = "\n\n".join(item[1].strip() for item in selected).strip()
            chunk_id = _chunk_id(document, section["sectionID"], ordinal)
            chunks.append({
                "schemaVersion": "document_chunk_v1",
                "chunkID": chunk_id,
                "documentID": document["documentID"],
                "paperID": document["paperID"],
                "sectionID": section["sectionID"],
                "sectionKind": section["normalizedKind"],
                "pageStart": selected[0][0],
                "pageEnd": selected[-1][0],
                "ordinal": ordinal,
                "text": text,
                "textSha256": _sha256(text),
            })
            ordinal += 1
            if index >= len(entries):
                break
            retained = 0
            next_cursor = index
            while next_cursor > cursor + 1 and retained < overlap_chars:
                next_cursor -= 1
                retained += len(entries[next_cursor][1])
            cursor = next_cursor

    for index, chunk in enumerate(chunks):
        if index > 0:
            chunk["previousChunkID"] = chunks[index - 1]["chunkID"]
        if index + 1 < len(chunks):
            chunk["nextChunkID"] = chunks[index + 1]["chunkID"]
    return chunks
