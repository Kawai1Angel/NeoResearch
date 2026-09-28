# RetrieveAgent

`RetrieveAgent` consumes `dataset_quantitative_analysis_v1`, performs deterministic
evidence-to-concept mapping, runs two local BM25 queries per retrieval intent, and
sends deduplicated local-PDF candidates to `LiteratureAgent` in strict integrated
mode (`includeAgentInference=false`, exact evidence spans required).

The source-catalog route searches ordinary indexed papers. The classic-library
route searches the reviewed identity list in `config/classic-papers.v1.json`
(29 papers spanning normalization, linear/MLP/mixer, patch/Transformer,
recurrent/probabilistic, frequency, convolution and graph modeling). Each entry
lists `recipeComponents` from the current TSF action registry. This is a
retrieval association, not a claim that the whole paper architecture can be
built from those components or that the listed actions form one legal recipe.
An arXiv ID or normalized title joins an entry to a local
catalog record. Both routes use the same local index and PDF checks; a classic
without a local catalog record or PDF cannot be sent to LiteratureAgent. The
screen also rejects a catalog entry whose PDF first-page text clearly conflicts
with its title; its candidate records the identity mismatch as an unusable PDF.
classic route examines every locally indexed library paper, and the fine screen
can match a paper to an intent through its reviewed ModelRecipe components when
the paper title does not contain the intent's exact phrase. Component matches
are recorded in candidate reasons.
per-intent reading budget reserves a slot for each route when both have an
eligible paper. Each candidate records its route, and a paper can be sent only
once after cross-intent deduplication.

Fine screening rejects a paper with an explicitly identified core mechanism
that ModelRecipe cannot express, before it consumes a reading slot. The
`unsupported_model_recipe` decision records the missing action family and
mechanism in candidate reasons and the run report. The screen uses distinctive
title terms or author-owned abstract, preview, and method claims; background mentions alone
do not trigger it. The rule list is intentionally explicit and should be
reviewed when ModelRecipe adds operators. A generic shared term such as
`Transformer`, `patch`, or `frequency` is not treated as mechanism equivalence.

`RetrieveAgentInput.compatibilityReviews` can supply model or human reviews
for partially transferable papers. A `direct` or `adaptable` review retains a
paper despite a missing exact operator, and the candidate still records that
operator as unavailable. A `research_only` or `exclude` review filters the
paper from the reading budget. Reviews must contain the indexed paper ID and its
source SHA-256; stale reviews have no effect. The review list is part of the
run digest, so a changed judgment cannot reuse an old retrieval result. A
missing review leaves the conservative static decision in place.

The Research service exposes the DataAnalysis bridge as:

```ts
yield* service.runRetrieveAgent({ taskID })
```

The task must already have a `dataset_quantitative_analysis_json` artifact. Runtime
outputs are written beneath `.neo-cast/literature-retrieval/`. The full pipeline runs
`data_analysis → literature → hypo_planning`; retrieval and evidence assembly are
internal steps of the literature phase.

`retrieve_result_v2` embeds a `task_evidence_bundle_v1`. The same bundle is written
to `task_evidence_bundle.json` and registered as `task_evidence_bundle_json`.
`task_evidence_excluded.jsonl` and `report.md` expose selection reasons, gaps,
applicability warnings, and conflicts. Task context and mapping version participate
in cache identity. Legacy results remain readable through `AnyRetrieveResultSchema`,
but workflow recovery requires v2 and rebuilds invalid results with `force: true`.

HypoPlanner consumes the registered bundle without querying KnowledgeStore. Each
hypothesis carries dataset paths, card IDs/revisions/roles, applicability assumptions,
falsification criteria, and `data_only`, `paper_supported`, or `conflicted` evidence
level. Direct responses, session tools, and recovered plans validate these references.
The hypothesis database migration preserves these fields and defaults historical
rows to empty evidence arrays and `data_only`.

Empty catalogs and lack of eligible cards produce an auditable `ready_data_only`
bundle. Missing optional statistics are skipped; corrupt contracts or provenance
fail validation. No online paper API, vector retrieval, query expansion, or RRF is
introduced. Matching rules live in `config/tsf-task-evidence.v1.json`.

## Service handoff

After DataAnalysis has registered its quantitative JSON, the explicit handoff is:

```ts
const literature = yield* service.runRetrieveAgent({ taskID })
const artifacts = yield* service.listArtifacts(taskID)
const evidence = artifacts.find((artifact) =>
  artifact.kind === "task_evidence_bundle_json" &&
  artifact.metadata.retrieveRunID === literature.retrieveRunID,
)
if (!evidence) throw new Error("Missing task evidence artifact")
const hypotheses = yield* service.runHypoPlannerAgent({
  taskID,
  taskEvidenceArtifactID: evidence.id,
})
const persisted = yield* service.listHypotheses(taskID)
```

`runFullPipeline` performs this handoff automatically after the intent checkpoint.
Session hypothesis tools pin the same evidence artifact for the duration of the
planner call; later artifacts cannot silently change which citations are valid.
Outside a planner session tools use the latest task bundle. Plan artifacts record
the source artifact ID and readiness, and YAML exposes `literatureReadiness`.

## Recovery and compatibility

- A single paper failure produces a gap; a malformed bridge result or global
  KnowledgeStore failure is a hard error.
- HypoPlanner rejects corrupt evidence. Workflow recovery may rebuild a damaged
  cached bundle from a valid quantitative source; this invalidates downstream
  completed phases. If reconstruction fails, the pipeline stops.
- Force/retry reuses artifact IDs for the same run and refreshes readiness metadata.
- Entry budgets remain strict. Omitted warning claims remain in exclusion details
  and overlapping selected entries' limitations; contradiction records remain
  visible even when a budget excludes one side.
- New hypotheses require nonblank falsification criteria (except baseline controls).
  Literature-backed hypotheses also require applicability assumptions and dataset
  paths. Historical database rows retain safe empty/default values until replanned.

Offline regression coverage includes a real KnowledgeStore fixture, migration of
existing rows, actual session tools, and pipeline execution through the companion
search-space checkpoint with replay and corruption scenarios.
