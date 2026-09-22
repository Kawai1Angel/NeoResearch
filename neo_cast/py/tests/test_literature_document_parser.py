import hashlib
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from literature_knowledge.pdf_parser import parse_pdf


try:
    import pymupdf as fitz
except ImportError:
    fitz = None


@unittest.skipIf(fitz is None, "PyMuPDF is not installed")
class LiteratureDocumentParserTest(unittest.TestCase):
    def test_parser_preserves_pages_sections_and_stable_ids(self) -> None:
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "paper.pdf"
            source = fitz.open()
            for page_number, heading in enumerate(("1 Introduction", "2 Method", "3 Results"), start=1):
                page = source.new_page()
                page.insert_text((72, 36), "Repeated Paper Header")
                page.insert_text((72, 100), heading)
                page.insert_text((72, 140), (f"Page {page_number} source evidence. " * 20))
                page.insert_text((72, 790), f"Page {page_number}")
            source.save(pdf_path)
            source.close()
            digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()

            first = parse_pdf(pdf_path, paper_id="local-2026-test", source_sha256=digest, title="Test")
            second = parse_pdf(pdf_path, paper_id="local-2026-test", source_sha256=digest, title="Test")
            self.assertEqual(first.document, second.document)
            self.assertEqual(first.chunks, second.chunks)
            self.assertEqual(len(first.document["pages"]), 3)
            self.assertIn("removed_repeated_headers_or_footers:2", first.document["parseWarnings"])
            self.assertEqual(first.status, "parsed")
            self.assertGreater(len(first.chunks), 0)

    def test_textless_pdf_requires_ocr(self) -> None:
        with TemporaryDirectory() as directory:
            pdf_path = Path(directory) / "scan.pdf"
            source = fitz.open()
            source.new_page()
            source.new_page()
            source.save(pdf_path)
            source.close()
            digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
            result = parse_pdf(pdf_path, paper_id="local-scan", source_sha256=digest)
            self.assertEqual(result.status, "ocr_required")
            self.assertEqual(result.chunks, [])


if __name__ == "__main__":
    unittest.main()
