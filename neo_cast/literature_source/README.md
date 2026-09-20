# NeoResearch Literature Source

This component builds the framework-owned paper source consumed by a future
Literature Agent. It discovers papers and materializes an auditable local
catalog; it does not summarize papers or turn author claims into knowledge.
The reviewed pre-2023 seed list is stored in
`literature_source/historical_foundations.json` and validated by the adjacent
strict JSON Schema.

## Scope

The default source is `patchtst_era_top_venue_tsf_v2`:

- Inclusive start year: 2023, anchored at PatchTST / ICLR 2023.
- Tier A: ICLR, ICML, NeurIPS, KDD, AAAI, IJCAI.
- Tier B: AISTATS, UAI, CIKM, WWW, WSDM, ICDM, ICDE, SIGMOD, VLDB, ECML-PKDD.
- `accepted_core`: peer-reviewed, direct time-series forecasting work.
- `accepted_adjacent`: peer-reviewed foundation-model, benchmark, and
  forecasting-analysis work.
- `influential_external`: influential work published outside the configured
  venue tiers.
- `watchlist`: relevant preprints that must not be represented as accepted
  main-conference papers.
- `historical_foundation`: an explicit, reviewed allowlist of pre-2023 papers
  that define the architectural and evaluation lineage of modern forecasting.
  This pool is reported separately and does not lower the main 2023+ boundary.

The historical manifest currently contains 26 works from 1964–2022. Six
methodological foundations cover robust estimation and forecasting, point and
quantile forecasts, and proper scoring rules: Huber (1964), Koenker–Bassett
(1978), Gneiting–Raftery (2007), Gneiting (2011), Adaptive Huber Regression
(2020), and a direct Huber-based crude-oil forecasting application (2020). The
remaining 20 works span probabilistic forecasting, recurrent and convolutional
baselines, graph and spatio-temporal models, interpretable forecasting,
efficient Transformers, decomposition/frequency methods, and
non-stationarity. Inclusion is title/year allowlisted; the builder does not
admit every older paper found in community lists.

The four discovery sources are version-pinned: TSCenter, qhliu,
TongjiFinLab, and THUML Time-Series-Library. They are candidate finders, not
publication authorities. OpenAlex is used only to enrich stable identifiers
and locate legal open-access copies.

The builder scans AAAI OJS, IJCAI, PVLDB, ICLR, ICML/PMLR, and NeurIPS official
proceedings. ACM KDD/WWW/WSDM and IEEE ICDE records are checked against
publisher-deposited Crossref metadata. The catalog distinguishes
`official_proceedings`, `publisher_metadata`, `curated_venue_claim`, and
`unverified_external`; publisher metadata is never mislabeled as a public PDF
or official proceedings page.

Historical authority checks additionally scan the applicable older AAAI,
ICML, NeurIPS, IJCAI, KDD, and SIGIR directories plus publisher-deposited
Crossref metadata for the International Journal of Forecasting and Machine
Learning. The earlier methodological foundations are tied to their journal
DOIs; a missing public PDF is recorded as `no_public_pdf`, not replaced with an
unverified copy. Older ICLR records are tied to explicit OpenReview IDs.
ETSformer is kept as a preprint rather than represented as a peer-reviewed
main-track paper.

## Build

From `neo_cast/`:

```bash
python py/literature_source.py
```

The generated source is written to:

```text
.neo-cast/literature-source/
├── source_manifest.json
├── coverage.json
├── COVERAGE.md
├── retry_queue.jsonl
├── citation_expansion.json
├── catalog/papers.jsonl
├── cache/discovery/*
├── cache/openalex/*.json
├── cache/proceedings/*
└── pdfs/*.pdf
```

Useful development modes:

```bash
python py/literature_source.py --skip-download
python py/literature_source.py --skip-openalex --max-downloads 5
python py/literature_source.py --source-readme /path/to/README.md
python py/literature_source.py --skip-download --refresh-official
OPENALEX_API_KEY=... python py/literature_source.py --skip-download --refresh-citations
```

Reruns are incremental: fixed-revision discovery snapshots, official directory
snapshots, existing valid PDFs, and cached OpenAlex responses are reused.
`--refresh-discovery` and `--refresh-official` explicitly refresh their
respective caches. PDF files are local research artifacts under `.neo-cast`
and are not committed. Copyright remains with each paper's rights holder; the
builder does not bypass paywalls and records `no_public_pdf` when no public
copy is known. Failed and unavailable PDFs remain in `retry_queue.jsonl` and
are never removed from the catalog.

OpenAlex now requires a personal API key for non-demo use. Put it only in the
`OPENALEX_API_KEY` environment variable; it is never written to policy,
manifests, caches, or reports. Without a key, cached identifier/OA enrichment
continues to work and `citation_expansion.json` records
`blocked_missing_api_key` rather than repeatedly issuing doomed requests. Use
`--skip-citations` only when intentionally disabling the configured one-hop
seed expansion.

## Provenance and trust

The source uses curated lists as high-recall discovery aids, not as authorities.
Every record retains the list and section that discovered it. The generated
manifest records exact upstream revisions and SHA-256 digests. Authority
matches include a source record ID, track, landing page, optional public PDF,
title similarity, authority type, and snapshot digest. Workshop-like tracks
are retained as such and never promoted to the main track.

`coverage.json` is the audit contract. It reports the venue/year scan matrix,
official and publisher-metadata verification separately, unmatched curated
claims, incremental changes, PDF and identifier coverage, discovery-source
unique contributions/overlap, and items requiring manual review. `COVERAGE.md`
is the compact human-readable view. This framework build remains separate from
the Literature Agent's runtime search and interpretation responsibilities.
