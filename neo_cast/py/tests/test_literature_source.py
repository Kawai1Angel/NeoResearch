import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


PY_ROOT = Path(__file__).resolve().parents[1]
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from literature_source import (
    DiscoveryRecord,
    OfficialEntry,
    apply_policy,
    choose_openalex_pdf,
    deduplicate,
    direct_pdf_url,
    expand_openalex_citations,
    historical_discovery_records,
    load_config,
    parse_aaai_archive,
    parse_aaai_issue,
    parse_ijcai_index,
    parse_pvldb_index,
    parse_thuml_source,
    parse_tongji_source,
    parse_venue_year,
    parse_tsc_table_source,
    parse_iclr_index,
    parse_pmlr_index,
    verify_against_official,
)


CONFIG = {
    "policy": {
        "start_year": 2023,
        "include_tiers": ["A"],
        "sections": {
            "Time Series Forecasting": "accepted_core",
            "Time Series Foundation Model": "accepted_adjacent",
        },
    },
    "venue_aliases": {"ICLR": "ICLR", "ICML": "ICML", "arXiv": "arXiv"},
    "venue_tiers": {"A": ["ICLR", "ICML"]},
}


class LiteratureSourceTest(unittest.TestCase):
    def test_parse_filter_and_deduplicate(self) -> None:
        markdown = """
## Time Series Forecasting

| Method Name | Code | Source |
| --- | --- | --- |
| [A Time Series is Worth 64 Words⭐](http://arxiv.org/abs/2211.14730) | [Code](https://example.com/code) | ICLR 2023 |
| [A Time Series is Worth 64 Words](https://openreview.net/forum?id=abc) | None | ICLR 2023 |
| [Old Forecast](https://example.com/old.pdf) | None | ICML 2022 |

## Time Series Foundation Model

| Method Name | Code | Source |
| --- | --- | --- |
| [Classification-only Foundation Model](https://example.com/classification.pdf) | None | ICML 2024 |
"""
        source = {"id": "fixture"}
        records = parse_tsc_table_source(markdown, source, CONFIG)
        filtered = apply_policy(records, CONFIG)
        papers = deduplicate(filtered)

        self.assertEqual(len(papers), 1)
        self.assertEqual(papers[0]["title"], "A Time Series is Worth 64 Words")
        self.assertEqual(papers[0]["pool"], "accepted_core")
        self.assertEqual(len(papers[0]["paper_urls"]), 2)

    def test_public_pdf_url_resolution(self) -> None:
        self.assertEqual(
            direct_pdf_url("https://arxiv.org/abs/2401.01234"),
            "https://arxiv.org/pdf/2401.01234",
        )
        self.assertEqual(
            direct_pdf_url("https://openreview.net/forum?id=paper123"),
            "https://openreview.net/pdf?id=paper123",
        )
        self.assertIsNone(direct_pdf_url("https://dl.acm.org/doi/10.1145/example"))

    def test_workshop_is_not_promoted_to_main_conference(self) -> None:
        self.assertIsNone(
            parse_venue_year("NeurIPS Workshop 2023", CONFIG["venue_aliases"], CONFIG["venue_tiers"])
        )

    def test_openalex_pdf_prefers_public_repository(self) -> None:
        work = {
            "best_oa_location": {"pdf_url": "https://openreview.net/pdf?id=abc"},
            "locations": [
                {"pdf_url": "https://openreview.net/pdf?id=abc"},
                {"pdf_url": "https://arxiv.org/pdf/2401.01234"},
            ],
        }
        self.assertEqual(choose_openalex_pdf(work), "https://arxiv.org/pdf/2401.01234")

    def test_parse_iclr_index_builds_official_pdf_url(self) -> None:
        index_html = (
            '<a title="paper title" href="/paper_files/paper/2025/hash/abc-Abstract-Conference.html">'
            "A &amp; B Forecasting</a>"
        )
        entries = parse_iclr_index(index_html, "https://proceedings.iclr.cc")
        self.assertEqual(entries[0]["title"], "A & B Forecasting")
        self.assertEqual(
            entries[0]["pdf_url"],
            "https://proceedings.iclr.cc/paper_files/paper/2025/file/abc-Paper-Conference.pdf",
        )

    def test_parse_legacy_neurips_index_builds_official_pdf_url(self) -> None:
        index_html = (
            '<a title="paper title" '
            'href="/paper_files/paper/2021/hash/abc-Abstract.html">'
            "Autoformer</a>"
        )
        entries = parse_iclr_index(index_html, "https://proceedings.neurips.cc")
        self.assertEqual(entries[0]["track"], "Main Conference Track")
        self.assertEqual(
            entries[0]["pdf_url"],
            "https://proceedings.neurips.cc/paper_files/paper/2021/file/abc-Paper.pdf",
        )

    def test_parse_pmlr_index_uses_declared_pdf(self) -> None:
        index_html = """
        <div class="paper">
          <p class="title">Selective &amp; Interpretable Forecasting</p>
          <p class="links">
            <a href="https://proceedings.mlr.press/v235/example.html">abs</a>
            <a href="https://raw.githubusercontent.com/mlresearch/v235/main/assets/example/example.pdf">Download PDF</a>
          </p>
        </div>
        """
        entries = parse_pmlr_index(index_html, "https://proceedings.mlr.press")
        self.assertEqual(entries[0]["title"], "Selective & Interpretable Forecasting")
        self.assertTrue(entries[0]["pdf_url"].endswith("example.pdf"))

    def test_parse_aaai_ojs_keeps_track_and_article_id(self) -> None:
        archive = '<a class="title" href="https://ojs.aaai.org/index.php/AAAI/issue/view/648">AAAI-25 Technical Tracks 25</a>'
        self.assertEqual(parse_aaai_archive(archive)[0]["record_id"], "648")
        issue = """
        <h2>AAAI Technical Track on Machine Learning</h2>
        <h3 class="title"><a href="https://ojs.aaai.org/index.php/AAAI/article/view/1">Forecasting &amp; Calibration</a></h3>
        <a href="https://ojs.aaai.org/index.php/AAAI/article/view/1/2">PDF</a>
        """
        entry = parse_aaai_issue(issue, "https://ojs.aaai.org")[0]
        self.assertEqual(entry["record_id"], "1")
        self.assertEqual(entry["track"], "AAAI Technical Track on Machine Learning")
        self.assertEqual(entry["title"], "Forecasting & Calibration")

    def test_parse_ijcai_and_pvldb_official_indexes(self) -> None:
        ijcai = """
        <div class="section"><div class="section_title"><h3>Main Track</h3></div>
        <div id="paper7" class="paper_wrapper"><div class="title">Time-Series Forecasting</div>
        <div class="authors">A. Author</div><div class="details">(<a href="0007.pdf">PDF</a> |
        <a href="/proceedings/2025/7">Details</a>)</div></div></div>
        """
        entry = parse_ijcai_index(ijcai, "https://www.ijcai.org/proceedings/2025/")[0]
        self.assertEqual(entry["track"], "Main Track")
        self.assertEqual(entry["landing_url"], "https://www.ijcai.org/proceedings/2025/7")

        pvldb = '<script>[{"issue":1,"authors":"A","pdf":"p1.pdf","title":"A \\"Quoted\\" Forecast","start_page":1,"end_page":2}]</script>'
        entry = parse_pvldb_index(pvldb, "https://www.vldb.org/pvldb/volumes/17/")[0]
        self.assertEqual(entry["title"], 'A "Quoted" Forecast')
        self.assertEqual(entry["record_id"], "p1")

    def test_independent_sources_classify_accepted_and_external_work(self) -> None:
        config = {
            **CONFIG,
            "venue_aliases": {"ICLR": "ICLR", "ICML": "ICML", "NeurIPS": "NeurIPS"},
            "venue_tiers": {"A": ["ICLR", "ICML", "NeurIPS"]},
            "external_title_classification": {
                "Chronos: Learning the Language of Time Series": "influential_external",
                "Long-term Forecasting with TiDE": "watchlist",
            },
        }
        tongji = """
        ## Foundation Models
        - **One fits all: Power general time series analysis by pretrained LM**
          Authors
          NeurIPS 2023.
          [Paper](https://example.com/paper.pdf) | [Code](https://example.com/code)
        """
        records = parse_tongji_source(tongji, {"id": "tongji"}, config)
        self.assertEqual(records[0].venue, "NeurIPS")
        self.assertEqual(records[0].pool, "accepted_adjacent")

        thuml = """
        ## Models
        - [x] **TiDE** - Long-term Forecasting with TiDE: Time-series Dense Encoder [[arXiv 2023]](https://arxiv.org/pdf/2304.08424.pdf) [[Code]](https://example.com/code)
        """
        records = parse_thuml_source(thuml, {"id": "thuml"}, config)
        self.assertEqual(records[0].pool, "watchlist")
        self.assertEqual(records[0].publication_status, "preprint")

    def test_authority_verification_retains_snapshot_and_track(self) -> None:
        records = parse_tsc_table_source(
            """
## Time Series Forecasting
| Method Name | Code | Source |
| --- | --- | --- |
| [Official Forecast](https://example.com/preprint) | None | ICML 2024 |
""",
            {"id": "fixture"},
            CONFIG,
        )
        papers = deduplicate(records)
        checksum = "a" * 64
        entry = OfficialEntry(
            source_id="pmlr",
            authority="official_proceedings",
            venue="ICML",
            year=2024,
            track="Main proceedings",
            track_type="main",
            record_id="paper-1",
            title="Official Forecast",
            landing_url="https://example.com/official",
            pdf_url="https://example.com/official.pdf",
            doi=None,
            abstract=None,
            snapshot_sha256=checksum,
        )
        snapshots = [{"source_id": "pmlr", "venue": "ICML", "year": 2024, "status": "scanned", "sha256": checksum}]
        verify_against_official(papers, [entry], snapshots, CONFIG)
        self.assertEqual(papers[0]["publication_verification"], "official_proceedings")
        self.assertEqual(papers[0]["official_proceedings"]["record_id"], "paper-1")
        self.assertEqual(papers[0]["official_proceedings"]["snapshot_sha256"], checksum)

    def test_publisher_override_preserves_journal_track(self) -> None:
        record = DiscoveryRecord(
            title="Classic Journal Forecast",
            paper_url="https://doi.org/10.1000/example",
            code_url=None,
            venue="Example Journal",
            year=2000,
            venue_tier="unranked",
            pool="historical_foundation",
            discovered_by="history",
            discovery_section="robust_forecasting",
            source_label="Example Journal 2000",
            publication_track="journal",
            doi="10.1000/example",
        )
        papers = deduplicate([record])
        config = {
            **CONFIG,
            "official_paper_overrides": {
                record.title: {
                    "source_id": "publisher_doi_historical",
                    "record_id": record.doi,
                    "authority": "publisher_metadata",
                    "landing_url": record.paper_url,
                    "track": "Journal article",
                    "track_type": "journal",
                }
            },
        }
        verify_against_official(papers, [], [], config)
        self.assertEqual(papers[0]["publication_verification"], "publisher_metadata")
        self.assertEqual(papers[0]["publication_track"], "journal")
        self.assertIsNone(papers[0]["open_access"]["pdf_url"])

    def test_citation_expansion_audits_missing_api_key(self) -> None:
        config = {
            **CONFIG,
            "citation_expansion": {
                "enabled": True,
                "source_id": "openalex_one_hop_citations",
                "seeds": {"Seed": "Official Forecast"},
            },
        }
        with TemporaryDirectory() as temp_dir, patch.dict(
            "os.environ", {}, clear=True
        ):
            records, report = expand_openalex_citations(
                [], [], config, Path(temp_dir)
            )
        self.assertEqual(records, [])
        self.assertEqual(report["status"], "blocked_missing_api_key")

    def test_historical_foundations_are_explicitly_allowlisted(self) -> None:
        config = {
            **CONFIG,
            "historical_foundations": {
                "source_id": "history",
                "records": [
                    {
                        "title": "Classic Forecast",
                        "aliases": ["Classic Forecasting Model"],
                        "year": 2020,
                        "venue": "ICLR",
                        "venue_tier": "A",
                        "category": "baseline",
                        "paper_url": "https://example.com/classic",
                        "pdf_url": "https://example.com/classic.pdf",
                        "publication_status": "peer_reviewed",
                        "publication_track": "main",
                    }
                ],
            },
        }
        discovered = historical_discovery_records(config)
        unrelated = DiscoveryRecord(
            title="Unrelated Old Paper",
            paper_url="https://example.com/unrelated",
            code_url=None,
            venue="ICLR",
            year=2020,
            venue_tier="A",
            pool="accepted_core",
            discovered_by="fixture",
            discovery_section="fixture",
            source_label="ICLR 2020",
        )
        filtered = apply_policy([*discovered, unrelated], config)
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0].pool, "historical_foundation")
        paper = deduplicate(filtered)[0]
        self.assertEqual(paper["open_access"]["pdf_url"], "https://example.com/classic.pdf")

    def test_default_historical_manifest_is_loaded(self) -> None:
        config = load_config(PY_ROOT.parent / "literature_source" / "source_policy.json")
        historical = config["historical_foundations"]
        self.assertEqual(len(historical["records"]), 26)
        self.assertRegex(historical["manifest_sha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(historical["min_year"], 1964)
        self.assertTrue(
            any(record["title"].startswith("DeepAR:") for record in historical["records"])
        )
        self.assertTrue(
            any(
                record["title"] == "Robust Estimation of a Location Parameter"
                for record in historical["records"]
            )
        )


if __name__ == "__main__":
    unittest.main()
