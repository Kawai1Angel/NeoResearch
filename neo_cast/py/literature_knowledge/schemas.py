"""Load and validate the versioned literature knowledge JSON contracts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "literature_knowledge"
SCHEMA_FILES = {
    "normalized_document_v1": "normalized_document.schema.json",
    "document_chunk_v1": "document_chunk.schema.json",
    "knowledge_card_v1": "knowledge_card.schema.json",
    "extraction_manifest_v1": "extraction_manifest.schema.json",
    "dataset_quantitative_analysis_v1": "dataset_quantitative_analysis.schema.json",
    "retrieval_candidate_v1": "retrieval_candidate.schema.json",
    "retrieve_result_v1": "retrieve_result.schema.json",
}


class ContractValidationError(ValueError):
    """Raised when a persisted knowledge artifact violates its contract."""


def load_schema(schema_version: str) -> dict[str, Any]:
    filename = SCHEMA_FILES.get(schema_version)
    if filename is None:
        raise ContractValidationError(f"unsupported schemaVersion: {schema_version}")
    return json.loads((SCHEMA_DIR / filename).read_text(encoding="utf-8"))


def validate_contract(value: dict[str, Any]) -> None:
    version = value.get("schemaVersion")
    if not isinstance(version, str):
        raise ContractValidationError("schemaVersion is required")
    schema = load_schema(version)
    try:
        import jsonschema
    except ImportError as error:  # pragma: no cover - dependency error is environment-specific
        raise RuntimeError("jsonschema is required to validate literature contracts") from error
    try:
        jsonschema.Draft202012Validator(schema).validate(value)
    except jsonschema.ValidationError as error:
        location = ".".join(str(item) for item in error.absolute_path) or "$"
        raise ContractValidationError(f"{location}: {error.message}") from error


def validate_json_file(path: Path) -> None:
    validate_contract(json.loads(path.read_text(encoding="utf-8")))


def validate_jsonl_file(path: Path) -> int:
    count = 0
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            validate_contract(json.loads(raw_line))
        except (json.JSONDecodeError, ContractValidationError) as error:
            raise ContractValidationError(f"{path}:{line_number}: {error}") from error
        count += 1
    return count
