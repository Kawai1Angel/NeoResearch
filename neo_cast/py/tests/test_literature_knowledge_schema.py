import sys
import unittest
import datetime as dt
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from literature_knowledge.schemas import ContractValidationError, validate_contract


class LiteratureKnowledgeSchemaTest(unittest.TestCase):
    def test_quantitative_analysis_schema_is_strict(self) -> None:
        report = {
            "schemaVersion": "dataset_quantitative_analysis_v1", "taskID": "task", "domain": "tsf",
            "dataset": {"samplingFrequency": "hourly", "targetColumns": ["load"], "observedPastCovariates": [], "knownFutureCovariates": [], "staticCovariates": []},
            "forecast": {"contextLength": 24, "predictionLengths": [12], "horizonContextRatio": 0.5},
            "profile": {"rowCount": 100, "missingRate": 0, "trendStrength": 0.2, "seasonalityStrength": 0.8, "crossVarCorrelation": 0, "distributionShift": 0, "outlierRate": 0, "irregularIntervalRatio": 0},
            "statistics": {
                "stationarity": {}, "acf": {"topLag": 24, "topCorrelation": 0.8}, "decomposition": {},
                "frequency": {"spectralPeaks": [{"period": 24, "powerShare": 0.5, "significant": True}]},
                "changepoint": {}, "crossLag": {},
            },
            "warnings": [], "sourceArtifactIDs": [],
        }
        validate_contract(report)
        with self.assertRaises(ContractValidationError):
            validate_contract({**report, "unexpected": True})

    def test_chunk_schema_is_strict(self) -> None:
        chunk = {
            "schemaVersion": "document_chunk_v1", "chunkID": "chunk_" + "a" * 20,
            "documentID": "doc_0123456789abcdef", "paperID": "paper", "sectionID": "section",
            "sectionKind": "method", "pageStart": 1, "pageEnd": 1, "ordinal": 0,
            "text": "A complete evidence paragraph.", "textSha256": "b" * 64,
        }
        validate_contract(chunk)
        with self.assertRaises(ContractValidationError):
            validate_contract({**chunk, "unexpected": True})

    def test_task_validated_status_is_not_part_of_v1(self) -> None:
        schema_path = PY_ROOT.parent / "literature_knowledge" / "knowledge_card.schema.json"
        self.assertNotIn('"task_validated"', schema_path.read_text(encoding="utf-8"))

    def test_minimal_knowledge_card_and_manifest_are_valid(self) -> None:
        timestamp = dt.datetime(2026, 9, 21, tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")
        card = {
            "schemaVersion": "knowledge_card_v1", "cardID": "kc_123456789abc", "revision": 1,
            "paperID": "paper", "cardType": "limitation", "claim": "The method requires regular sampling.",
            "normalizedClaim": {"subject": "method", "predicate": "requires", "object": "regular_sampling"},
            "applicability": {
                "taskTypes": [], "dataFeatures": [], "domains": [], "dataScale": [],
                "horizonProfile": [], "computeProfile": [], "basis": "author_statement",
            },
            "notApplicableWhen": [],
            "evidence": [{
                "evidenceID": "ev_12345678", "evidenceType": "limitation_statement", "chunkID": "chunk_x",
                "section": "Limitations", "pageStart": 8, "pageEnd": 8,
                "evidenceSpan": "The method requires regular sampling.", "directness": "direct", "verification": "exact_span",
            }],
            "limitations": [],
            "confidence": {"sourceQuality": 0.8, "extractionConfidence": 0.9, "evidenceDirectness": 1, "transferability": 0.5},
            "status": "paper_backed", "tags": ["sampling"],
            "provenance": {
                "sourceDocumentID": "doc_x", "sourceDocumentSha256": "a" * 64,
                "sourcePublicationStatus": "peer_reviewed", "extractorModel": "fixture",
                "extractorPromptVersion": "candidate_extractor_v1", "extractionRunID": "lerun_fixture",
                "createdAt": timestamp, "updatedAt": timestamp,
            },
        }
        validate_contract(card)
        manifest = {
            "schemaVersion": "extraction_manifest_v1", "runID": "lerun_fixture", "paperID": "paper",
            "documentID": "doc_x", "inputDigest": "b" * 64, "status": "partial",
            "versions": {
                "parser": "v1", "chunker": "v1", "taxonomy": "v1", "candidatePrompt": "v1",
                "verifierPrompt": "v1", "knowledgeCardSchema": "v1", "model": "fixture",
            },
            "counters": {"candidateCount": 0, "acceptedCount": 0, "rejectedCount": 0, "duplicateCount": 0, "warningCount": 1},
            "error": {"code": "ocr_required"}, "startedAt": timestamp, "finishedAt": timestamp,
        }
        validate_contract(manifest)


if __name__ == "__main__":
    unittest.main()
