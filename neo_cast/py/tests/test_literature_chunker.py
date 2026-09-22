import sys
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from literature_knowledge.chunker import chunk_document


def fixture_document() -> dict:
    blocks = [{"blockID": f"b{i}", "text": f"Paragraph {i}. " + ("evidence " * 12)} for i in range(8)]
    return {
        "documentID": "doc_0123456789abcdef", "paperID": "paper-1", "sourceSha256": "a" * 64,
        "pages": [{"pageNumber": 1, "blocks": blocks}],
        "sections": [{"sectionID": "s1", "normalizedKind": "method", "blockIDs": [item["blockID"] for item in blocks]}],
    }


class LiteratureChunkerTest(unittest.TestCase):
    def test_chunk_ids_and_content_are_deterministic(self) -> None:
        first = chunk_document(fixture_document(), target_chars=300, max_chars=420, overlap_chars=80)
        second = chunk_document(fixture_document(), target_chars=300, max_chars=420, overlap_chars=80)
        self.assertEqual(first, second)
        self.assertGreater(len(first), 1)
        self.assertEqual(first[0]["nextChunkID"], first[1]["chunkID"])
        self.assertEqual(first[1]["previousChunkID"], first[0]["chunkID"])
        self.assertTrue(first[0]["text"].startswith("Paragraph 0."))

    def test_references_are_not_chunked(self) -> None:
        document = fixture_document()
        document["sections"][0]["normalizedKind"] = "references"
        self.assertEqual(chunk_document(document), [])


if __name__ == "__main__":
    unittest.main()
