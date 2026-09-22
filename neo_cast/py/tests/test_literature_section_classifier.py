import sys
import unittest
from pathlib import Path


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from literature_knowledge.section_classifier import build_sections, classify_heading


class LiteratureSectionClassifierTest(unittest.TestCase):
    def test_common_headings_are_classified_conservatively(self) -> None:
        self.assertEqual(classify_heading("1 Introduction"), "introduction")
        self.assertEqual(classify_heading("4.2 Ablation Study"), "ablation")
        self.assertEqual(classify_heading("References"), "references")
        self.assertIsNone(classify_heading("This is an ordinary sentence with a result."))

    def test_sections_retain_page_and_block_boundaries(self) -> None:
        pages = [
            {"pageNumber": 1, "blocks": [{"blockID": "b1", "text": "Abstract"}, {"blockID": "b2", "text": "Summary."}]},
            {"pageNumber": 2, "blocks": [{"blockID": "b3", "text": "1 Introduction"}, {"blockID": "b4", "text": "Body."}]},
        ]
        sections = build_sections(pages, "doc_x")
        self.assertEqual([item["normalizedKind"] for item in sections], ["abstract", "introduction"])
        self.assertEqual(sections[1]["startPage"], 2)
        self.assertEqual(sections[1]["blockIDs"], ["b3", "b4"])


if __name__ == "__main__":
    unittest.main()
