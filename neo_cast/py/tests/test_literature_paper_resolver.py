import hashlib
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from literature_knowledge.paper_resolver import SourceIntegrityError, resolve_catalog_paper, resolve_local_pdf


class LiteraturePaperResolverTest(unittest.TestCase):
    def test_catalog_relative_pdf_is_resolved_and_verified(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            catalog = root / "literature_source" / "catalog"
            pdf_dir = root / "literature_source" / "pdfs"
            catalog.mkdir(parents=True)
            pdf_dir.mkdir(parents=True)
            pdf = pdf_dir / "paper.pdf"
            pdf.write_bytes(b"%PDF-fixture")
            digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
            record = {
                "paper_id": "tsf-2026-aaaaaaaaaaaa", "title": "Fixture", "year": 2026,
                "venue": "FixtureConf", "publication_status": "peer_reviewed",
                "download": {"status": "downloaded", "path": "pdfs/paper.pdf", "sha256": digest},
            }
            (catalog / "papers.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8")
            resolved = resolve_catalog_paper(root, record["paper_id"])
            self.assertEqual(resolved.pdf_path, pdf.resolve())
            self.assertEqual(resolved.pdf_sha256, digest)

            record["download"]["sha256"] = "0" * 64
            (catalog / "papers.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8")
            with self.assertRaises(SourceIntegrityError):
                resolve_catalog_paper(root, record["paper_id"])

    def test_local_pdf_id_is_stable(self) -> None:
        with TemporaryDirectory() as directory:
            pdf = Path(directory) / "paper.pdf"
            pdf.write_bytes(b"%PDF-fixture")
            first = resolve_local_pdf(pdf, title="A Stable Title", year=2026)
            second = resolve_local_pdf(pdf, title="A Stable Title", year=2026)
            self.assertEqual(first.paper_id, second.paper_id)


if __name__ == "__main__":
    unittest.main()
