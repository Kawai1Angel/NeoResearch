# RetrieveAgent

New mainline runs now add automatic **broad card recall → conditional architecture
extraction → independent source review → bounded semantic revision and fresh review → usefulness curation** before planner/designer
handoff. See [architecture-knowledge.md](./architecture-knowledge.md) for budgets,
contracts, artifacts and failure behavior. The architecture packet is authoritative for
new downstream citations; the intent-based entries described below remain source audit
and legacy-bundle compatibility data.

Default search/reading budgets are 40 source candidates per intent, 8 new papers per
intent, and 12 new papers total. Existing paper/intent coverage is removed before
allocating reading quotas. Architecture recall separately considers up to 128 cards
and reads up to 40, including source-verified v2 runtime archives, before selecting up
to 12 useful decisions. These counts are separate ceilings and do not require filling
quotas. Progress distinguishes new reading, reuse, source reading and final decisions.

`RetrieveAgent` consumes `dataset_quantitative_analysis_v1`, performs deterministic
evidence-to-concept mapping, runs two local BM25 queries per retrieval intent, and
sends deduplicated local-PDF candidates to `LiteratureAgent` in strict integrated
mode (`includeAgentInference=false`, exact evidence spans required).

A third route, `knowledge_store`, matches reviewed v2 principles to the current task's
scientific and method intents. It reads the shared KnowledgeV2Store directly, so
reusing reviewed evidence requires neither an exported JSONL nor an available PDF.
The default shared root is `<neoCastRoot>/.neo-cast/literature-knowledge`; callers
can explicitly supply `knowledgeRoot`. This scope is shared across tasks using
that root, not across unrelated installations automatically.

Recalled candidates record `recallScore`, card/revision and source extraction ID
in their reasons. Their BM25 score is zero because they use card/intent matching.
Both shared-card recall and final evidence-budget selection use
`0.9 * relevance + 0.1 * confidence`. Applicability conflicts and implementation
compatibility gates take precedence over this score. Relevance remains separately
reported, and selection reasons show the confidence contribution. Reflection's
experiment-backed confidence revisions participate in the retrieval cache digest.
`reused_knowledge` results pin `cardRevisions` and are counted separately from
papers sent to LiteratureAgent. A paper whose selected intents already have
usable stored evidence does not require another extraction. Reused cards pass
the normal source, review-version, applicability and evidence-role gates. Known
unsupported card operations and source-hash-bound compatibility reviews are also
checked; reuse cannot bypass the ModelRecipe screen. Unknown implementation
mappings remain unresolved and do not imply an available registry operator.

Condition matching uses the complete quantitative diagnosis, including known
future inputs and point/probabilistic objectives. Retrieved concepts do not create
task facts. Missing optional diagnostics or unrecognized conditions remain
uncertain; an absent scientific detection does not prove its opposite. Explicit
condition violations yield `conflicted`, which carries warning roles rather than
positive mechanism support. Free-text compound conditions and source boundaries remain unknown pending explicit assessment.
Matching and task handoff leave the original card intact. Every entry embeds its
complete `knowledge_card_v2` in `knowledge`, including experiments, assertion/source
bindings, contrary evidence, epistemic status and proposed validation. v1 fragments
and their export files are excluded; archived v1 bundles require fresh retrieval.

The retrieval cache includes the shared card/relation snapshot and matching
versions as well as the target report and context. Revisions and withdrawals
invalidate future retrieval; already-written task evidence retains its original
snapshot. A run that creates knowledge may therefore have a different ID on its
next retrieval; subsequent unchanged reads reuse that new snapshot's cache.

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

Fine screening first uses eligible general time-series forecasting papers. A
paper whose title explicitly focuses on a vertical domain (for example stocks,
traffic, job skills, or weather) is deferred for that intent when a general
paper is available. Vertical papers can fill an intent with no eligible general
paper, after general papers have consumed their reading slots. The candidate
records its scope and the deferral reason;
title-based classification is conservative and can be reviewed in the report.

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

`retrieve_result_v2` embeds a `task_evidence_bundle_v2`. The same bundle is written
to `task_evidence_bundle.json` and registered as `task_evidence_bundle_json`.
`task_evidence_excluded.jsonl` and `report.md` expose selection reasons, gaps,
applicability warnings, and conflicts. Task context and mapping version participate
in cache identity. Legacy results remain readable through `AnyRetrieveResultSchema`,
but workflow recovery requires v2 and rebuilds invalid results with `force: true`.

Every active entry has type `transferable_principle`. The card's required
intervention and complete mechanism replace separate mechanism/limitation cards.
Known unsupported operations require a source-hash-bound compatibility review;
unknown implementation mappings remain unresolved. No cross-paper equivalence
or independent corroboration is inferred from a shared method name. Whole-paper
v2 consolidation occurs before independent verification and publication.

HypoPlanner consumes the registered bundle without querying KnowledgeStore. Each
hypothesis carries dataset paths, card IDs/revisions/roles, applicability assumptions,
falsification criteria, and `data_only`, `paper_supported`, or `conflicted` evidence
level. Direct responses, session tools, and recovered plans validate these references.
The hypothesis database migration preserves these fields and defaults historical
rows to empty evidence arrays and `data_only`.

Lack of eligible cards in both shared knowledge and paper retrieval produces an auditable `ready_data_only`
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
