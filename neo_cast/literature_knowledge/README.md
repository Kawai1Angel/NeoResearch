# Literature knowledge contracts

This directory contains the versioned, provider-independent contracts shared by
the Python PDF parser and the standalone TypeScript `LiteratureAgent`.

- `NormalizedDocument` and `DocumentChunk` contain only source-derived data.
- `KnowledgeCard` is an atomic claim with locatable evidence and revision metadata.
- `extraction_manifest` records every version that contributes to an idempotency key.
- `taxonomy.v1.json` is curated. Unknown terms are exported as suggestions and are
  never written into this file automatically.
- `dataset_quantitative_analysis_v1` is the machine-readable DataAnalysisAgent handoff.
- RetrieveAgent contracts preserve the evidence → concept → intent → candidate →
  LiteratureAgent run → KnowledgeCard provenance chain.

Runtime data belongs under `.neo-cast/literature-knowledge/` and must not be
committed. PDF text is untrusted input; parsers do not execute embedded content.
