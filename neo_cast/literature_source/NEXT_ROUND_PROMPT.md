# NeoResearch Literature Source: Next-round Execution Prompt

Continue improving NeoResearch's framework-level literature retrieval source.

## Working Directory and Constraints

Working directory:

```text
/path/to/NeoResearch
```

Read these documents fully before starting:

- Root `AGENTS.md`
- `neo_cast/AGENTS.md`
- `neo_cast/literature_source/README.md`
- `neo_cast/literature_source/source_policy.json`
- `neo_cast/py/literature_source.py`

Follow these constraints:

- Preserve the user's uncommitted work; do not overwrite, revert, or reorganize unrelated changes.
- Edit files using `apply_patch`.
- Retrieval sources belong to the framework and are not built by Literal/Literature Agent at runtime.
- Download only publicly and legally accessible PDFs; do not bypass paywalls.
- Keep main conferences, workshops, and preprints separate; never automatically promote workshops to main tracks.
- Community lists discover candidates but do not establish final venue attribution.
- Continue the existing implementation rather than rebuilding the design.

## Current Baseline

Existing framework components:

- Builder: `neo_cast/py/literature_source.py`
- Collection policy: `neo_cast/literature_source/source_policy.json`
- Paper record schema: `neo_cast/literature_source/paper_record.schema.json`
- Tests: `neo_cast/py/tests/test_literature_source.py`
- Generated local directory: `neo_cast/.neo-cast/literature-source/`

Current catalog statistics:

| Metric | Count |
|---|---:|
| Total papers | 200 |
| `core` | 184 |
| `adjacent` | 16 |
| Tier A | 182 |
| Tier B | 18 |
| Downloaded PDFs | 183 |
| Total PDF size | Approximately 636.6 MiB |
| `no_public_pdf` | 9 |
| `failed` | 8 |
| Verified against official proceedings | 79 (39.5%) |
| OpenAlex ID | 145 |
| DOI | 128 |
| arXiv ID | 157 |
| Code links | 134 |

Year distribution:

| Year | Count |
|---|---:|
| 2023 | 6 |
| 2024 | 47 |
| 2025 | 91 |
| 2026 | 56 |

Venue distribution:

| Venue | Count |
|---|---:|
| ICML | 56 |
| NeurIPS | 37 |
| ICLR | 33 |
| AAAI | 25 |
| KDD | 22 |
| IJCAI | 9 |
| WWW | 9 |
| ICDE | 5 |
| VLDB | 3 |
| WSDM | 1 |

Existing official adapters:

- ICLR 2024–2026
- ICML/PMLR 2023–2025
- NeurIPS 2023–2024
- Two official NeurIPS 2025 coverage entries

Existing discovery sources:

- TSCenter `awesome-time-series-papers`: 191 entries
- qhliu `awesome-time-series-analysis`: 23 entries
- Overlap: 14 entries
- Current sourcing relies too heavily on TSCenter.

## Main Objective

Turn the community-list-driven collection into an official-catalog-driven retrieval source with measurable coverage.

Priorities:

1. Increase official verification from 39.5% toward 90% where possible.
2. Address poor 2023 coverage, currently only six papers.
3. Add official or authoritative publication adapters for AAAI, IJCAI, KDD, WWW, WSDM, VLDB, and ICDE.
4. Integrate independent discovery sources to reduce single-source TSCenter bias.
5. Produce auditable coverage reports identifying scanned and missing venues/years.
6. Keep builds reproducible, incremental, pinned, and auditable.

## Phase 1: Official Venue Scanners

Implement first:

- AAAI:AAAI OJS proceedings,2023–2026
- IJCAI: official proceedings, 2023-2026.
- VLDB: official PVLDB volumes/issues.
- NeurIPS: complete 2025 and add 2026 when available.
- ICML: add the officially published 2026 PMLR volume.
- KDD, WWW, WSDM: official ACM metadata; metadata only when PDFs are not public.
- ICDE: official program, DBLP, Crossref, or IEEE metadata.

Use this pipeline:

```text
All papers in official proceedings
    ↓
Initial title/abstract screening
    ↓
Time-series relevance classification
    ↓
Rule-based review
    ↓
Add to candidate catalog
```

Search beyond titles containing forecasting; also cover:

- time series
- temporal prediction
- sequence prediction
- spatio-temporal
- probabilistic forecasting
- normalization
- non-stationarity
- distribution shift
- concept drift
- frequency domain
- decomposition
- foundation model
- state-space model
- exogenous variables
- uncertainty / calibration

Retain these fields for each official match:

- official source id
- venue
- year
- track
- official title
- landing URL
- PDF URL
- title similarity
- proceedings snapshot checksum
- verification status

## Phase 2: Independent Discovery Sources

Promote these references to formal discovery sources:

- `TongjiFinLab/awesome-time-series-forecasting`
- `THUML/Time-Series-Library`

Retain pinned commit revisions, README checksums, source sections, and original URLs.

During parsing, check these significant works that may currently be missing:

- DLinear
- Koopa
- FreTS
- One Fits All
- TimesFM
- Moirai
- Time-MoE
- Chronos
- TiDE
- TSMixer

Do not add them unconditionally to the main-conference pool. Classify according to actual publication status into:

- `accepted_core`
- `accepted_adjacent`
- `influential_external`
- `watchlist`

If pool structure changes, also update:

- policy
- JSON Schema
- README
- Tests
- Generated statistics

## Phase 3: Citation Expansion

After official scanners and community sources are integrated, use OpenAlex for one-hop citation expansion.

Suggested seeds:

- PatchTST
- DLinear
- TimesNet
- iTransformer
- TimeMixer
- TimesFM
- Moirai
- Chronos
- Time-MoE

Candidate filters:

- Publication year meets the current policy boundary.
- Belongs to a target venue or is placed in influential_external/watchlist.
- Relates to forecasting mechanisms, evaluation, or data phenomena.
- Do not admit papers merely because time or temporal appears.

## Coverage Report

Generate machine-readable and human-readable build reports, for example:

```text
.neo-cast/literature-source/coverage.json
.neo-cast/literature-source/COVERAGE.md
```

Include at least:

- Candidates by venue and year.
- Official catalog scan status.
- Official verification counts and rates.
- curated_venue_claim counts.
- Unmatched candidates.
- Added, removed, and changed records.
- PDF `downloaded` / `failed` / `no_public_pdf`
- DOI, OpenAlex, arXiv, and code-link coverage.
- Unique contributions and overlap by discovery source.
- Counts of workshops, preprints, and main-conference papers.
- Known omissions and entries requiring manual review.

Collection size is not a substitute for coverage.

## PDF Policy

Download priority:

1. Official proceedings PDF.
2. arXiv
3. Public archives such as PMLR and NeurIPS.
4. Public author or institutional repositories.
5. Other lawful open-access locations.

For paid ACM/IEEE pages:

- Preserve DOI, landing page, and publication details.
- Seek a legally public author version.
- Mark no_public_pdf when none is found.
- Do not bypass access restrictions.

Put the 17 unsuccessful downloads in a separate retry queue; absence of a PDF must not remove a catalog entry.

## Quality Requirements

- Stable paper IDs.
- Cached, incremental rebuilds.
- Bounded network retries, backoff, and failure logs.
- Deduplication using normalized titles and DOI/OpenAlex/arXiv rather than exact titles alone.
- Thresholded fuzzy matches with retained scores.
- No automatic workshop-to-main-conference promotion.
- Explicit distinction between curated claims and official verification.
- Keep Literal Agent claim/mechanism extraction outside this round.
- Keep generated files under .neo-cast; do not commit PDFs or caches.
- Include framework configuration, schemas, README, and tests in the npm package.

## Validation Requirements

Run at least:

```bash
cd neo_cast
python3 -m unittest py.tests.test_literature_source -v
python3 -m py_compile py/literature_source.py
python3 -m json.tool literature_source/source_policy.json
python3 -m json.tool literature_source/paper_record.schema.json
npm pack --dry-run --cache .artifacts/npm-cache
git diff --check
```

After rebuilding the complete retrieval source, also verify:

- Catalog record count matches the manifest.
- No duplicate paper_id or normalized titles.
- Downloaded PDF count matches the catalog.
- Every PDF starts with %PDF.
- File sizes and SHA-256 hashes match records.
- No orphan PDFs unreferenced by the catalog.

Repository-wide npm run test:python currently has an unrelated known failure:

```text
test_research_trace.ResearchTraceTest
Expected verification_plan to contain val_avg_mse
```

Do not change that unrelated test for this task; distinguish new test results from the existing failure in the final report.

## Deliverables

Report:

1. Changed files.
2. Added official venue adapters.
3. New papers and deduplicated total.
4. Official verification rate before and after.
5. Statistics by year, venue, and pool.
6. Successful, failed, and unavailable public PDFs.
7. Significant newly discovered omissions.
8. Remaining venue/year coverage gaps.
9. All test and integrity-check results.
10. Whether the next round is ready for claim/mechanism extraction.

Actually retrieve, edit, download, and validate; do not deliver design advice alone.
