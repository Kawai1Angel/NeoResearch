# LiteratureAgent

## Active knowledge cards: v2

The research pipeline and both `build` / `build-principles` commands now publish
`knowledge_card_v2`. `LiteratureAgent.run` uses `ConfiguredPrincipleModel` for
whole-paper synthesis, consolidation, and independent source review. Missing model
configuration is reported explicitly; there is no fallback to v1 extraction.

One card contains a complete conditional principle: conditions, intervention,
mechanism attribution, expected effect, bound experiments, support/refutation,
observed scope, boundaries, unknowns, proposed falsification and implementation notes.
`KnowledgeV2Store` stores active cards and immutable revisions in separate
`kb_principle` / `kb_principle_revision` tables in the shared `knowledge.db`.
Source chunks and reviews are checked before publication and again on reads.
A complete re-extraction supersedes a paper's active set; partial runs publish
only independently accepted cards without replacing earlier accepted principles.
Exports go to `exports/knowledge_cards_v2.jsonl`.

The active retrieval/handoff format is `task_evidence_bundle_v2`. It embeds the
entire revision-bound card; downstream prompts retain experiments, counterevidence,
qualifications and falsification without separating them from their method.
Old v1 database tables, exports and helpers remain available for explicit audit
(`runLegacyAudit`, `exportLegacyAudit`, `validateLegacyAudit`). They are excluded
from active retrieval. Existing tasks with v1 evidence must rerun literature
retrieval; the full pipeline rebuilds their evidence before planning. Original
PDFs must be available for source-based re-extraction. There is no automatic
v1-to-v2 conversion and no bulk rewrite of historical artifacts.

## Confidence from current experiments

Each v2 card has `confidence` in `[0, 1]`, initially `0.50`, and
`experimentValidations`. Historical v2 cards receive these defaults on read.
Confidence is a selection prior, not a calibrated probability. ReflectionAgent
explicitly decides whether the current experiment supports named card assertions
using `read_knowledge_cards` and `confirm_knowledge`, or optional direct-response
`knowledgeValidations`. Successful execution alone never raises confidence.

Each accepted validation adds `0.01`, capped at `1`. The writer captures actual
task/run IDs, dataset content hash, proposed and executed models, training and
evaluation settings, metrics and artifact references from the experiment store.
Reflection supplies assertion IDs, its rationale, condition and implementation
assessments and limitations. Only independent, execution-verified successful full
runs with a metric and dataset hash qualify; performance claims also require a
comparable full control run. The referenced trial must be the current task's
latest run. Repeated validation of the same card/task/run adds no further credit.

Feedback is committed atomically to `kb_principle_validation` and a new immutable
card revision. It preserves the source assertions and independent paper review,
refreshes the active JSONL export and invalidates future retrieval caches.
Historical task-evidence snapshots retain their original confidence. Re-extraction
of the same source claim preserves feedback; a changed claim receives a new identity.
Unsupported observations produce no automatic decrease.

## Transferable knowledge v2 extraction

`knowledge-v2-validator.ts` checks source identity and exact quotes, assertion
references, experiment binding and complete semantic-review coverage. Construct
new records through `finalizeKnowledgeCandidate`, not a schema parse alone.
Reviews bind to the entire candidate hash; any edit or evidence merge needs a
fresh independent semantic review. Citation existence does not establish semantic
support. The validator cannot detect fabricated causal interpretations by string
matching; the source-reading verifier must assess that explicitly.

Protocols, settings, observations and limitations belong to the principle's
evidence/context. They have no standalone v2 card type. Mechanisms attributed only
to extractor inference cannot pass. Performance effects require a comparison
experiment, while computational or representation claims need not pretend to
have accuracy evidence. Missing experimental fields remain explicitly unreported.

The explicit `build-principles` command runs the paper-level v2 pipeline:

```bash
bun run src/research/literature/dev-cli.ts build-principles \
  --neo-cast-root ../../../neo_cast --paper-id <paper-id> \
  --output-root /absolute/shared-knowledge-root --max-calls 80
```

It uses the existing configured provider. No configured model is an explicit
error; use `parse` for parse-only work. `--max-context-characters` limits the whole
serialized request (default 180000 characters, not tokens); individual collection
batches default to 24000 characters. Existing provider output-token limits still
apply. Oversized chunks or requests are recorded as incomplete instead of silently
truncated. Output-schema repair gets at most one retry per call, counted against
the call budget. Transport failures stop the paper run except during a targeted
material repair, where the affected item is staged with its failure reason.

`source-registry.ts` assigns immutable IDs, hashes, page ranges and character
offsets to contiguous raw source spans. Models select IDs instead of copying
provenance or rewriting quotations. Assertions can cite several independently
locatable spans across column/footer interruptions. The wire candidate contains
source ID strings; hydration restores exact program-owned source objects.
The source inventory is automatically collected from every explicit sourceIDs
binding. The main principle text is derived from its primary assertion instead
of requiring two separately generated copies. Conditions, observed scope and
boundaries already have direct source bindings; these do not need duplicate
support rows, but every assertion still receives independent semantic review.

`paper-principle-extractor.ts` builds an outline, collects source-linked materials
in bounded batches, plans complete principles across the paper, then generates
one complete principle per request (zero is allowed). This controls response size
without turning chunks or components into cards. It independently reviews candidates,
allows one source-based semantic revision, consolidates with explicit lineage,
then independently verifies every final candidate again. The verifier sees raw
source chunks and adverse materials, plus results/ablation/setup/limitations chunks
even when collection did not cite them. Final review failure cannot reuse an
initial approval. Consolidation returns ID groups, not a repeated copy of every
card; each necessary merge gets a separate bounded request and final review.
Merging may drop unused source inventory entries from earlier drafts; every
source cited by the final assertions, experiments and boundaries must still
resolve to the same paper, and the merged candidate receives a fresh review
against original text and counterevidence.
Missing assertion links or mis-typed scope references can receive a targeted
binding repair. It can link existing evidence and add explicitly sourced scope
assertions; it cannot invent evidence IDs or modify experimental values, evidence
relations or existing claims. The full integrity checks run again, followed by
independent semantic verification. Invalid drafts are isolated per planned
principle instead of erasing other candidates.

Review and revision requests carry original text once, with source IDs resolving
through chunk offsets. Related candidate versions are stored once by content hash;
original/sibling references reuse those hashes, preserving revised versions and
all counterevidence without truncation. Audit calls include `inputCharacters`.
Experimental binding repairs may select existing experiments and their sources,
but cannot create experiments, change evidence kinds, or alter reported values.
Missing citation edges can select immutable registered source spans; the program
assigns new edge IDs and scope assertion IDs. These edges are not new observations
and still require source-reading verification. A composite principle may be
supported jointly by multiple evidence units. The same integrity repair applies
after semantic revision; an invalid revision is isolated to its candidate, while
transport, budget and cancellation failures retain their existing fatal behavior.
Experiment source inventories include citations already present in each reported
field, so separate setup and result spans remain connected without changing values
or importing sources from a different experiment. Model inputs explicitly label
zero-based contribution indices; unresolved invalid indices still block acceptance.
Semantic revision targets disputed assertion text and its dependent descriptions;
adding a caveat elsewhere does not repair an unchanged overclaim. Review diagnostics
distinguish missing assertion reviews from assertions reviewed as unsupported.
Incomplete assertion review coverage or a contradictory verdict receives the same bounded
response-repair opportunity as malformed JSON. A valid scientific rejection is
never retried for acceptance, and a persistent protocol failure cannot publish cards.

Verifier v9 separates source fidelity from evidence strength. An `accepted` review
may contain `qualified` assertions when its typed qualification confirms both
`sourceFaithful` and `limitationDisclosed`. Limited experiments, author hypotheses,
unisolated components, missing uncertainty estimates, shared protocols and limited
scope do not by themselves reject a complete source-backed relationship. These
qualifications remain in the stored review and report for hypothesis generation.
Missing mechanisms, fabricated results, wrong experimental bindings, hidden
counterevidence and unsupported generalization still block acceptance. Historical
untyped `qualified` verdicts are not automatically promoted; they need a fresh review.

Verifier v10 also permits partial source review. `reviewedSourceIDs` records the
nonempty subset actually inspected; no complete-source or percentage threshold is
required. Additional IDs from the same paper’s program-registered analysis sources
are allowed, including counterevidence not attached to the candidate. Unreviewed source IDs are reported as non-blocking audit metadata, never
silently marked reviewed. Unknown source IDs still require output repair, and actual
unsupported claims or omitted counterevidence still fail semantic review. Candidate
citations remain program-validated against the document regardless of review coverage.
Changing the verifier version invalidates extraction caches; historical v9 results
are not relabeled or automatically published under v10.

Malformed materials are individually repaired once or staged. Valid siblings
survive. `materialGaps` records affected contribution indexes; candidates tied to
those contributions cannot pass. Unknown gap scope blocks all candidates.
Independent verified principles can remain in a partial run and are eligible
for active publication; unverified or incomplete candidates are excluded. Budget or later fatal execution
failure still clears the paper's publishable card list.

`LiteratureAgent.runPrinciples` saves `result.json`, `review.md`,
`knowledge_cards_v2.jsonl` and a completion manifest under `principle-runs/<runID>`.
The result contains analysis, staged materials, plans, initial/final candidates, dispositions, reviews,
rejections and model call audit records (response, hashes, usage when available,
duration and repair errors). Direct `runPrinciples` calls default to audit-only unless `publish: true` is set.
The main run and CLI publish accepted cards to the v2 store. Completed extraction
cache identity includes source content, parser/chunks, model, review versions and
budgets. Retired cards are never resurrected by cache reads. `force` re-extracts.
Legacy card tables are preserved.

Tests include synthetic pipeline cases and frozen source excerpts from VCformer,
SparseTSF and RSAP-DFM for line wraps, footers and column interleaving. They do not
by themselves establish extraction quality on ETTh1's twelve papers.

The Research service runs this module inside the single `literature` phase between
DataAnalysis and HypoPlanner. Retrieve(pre), Literature(core), and Retrieve(post)
share the existing validation rules and persisted evidence bundle. The standalone
CLI below remains available for explicit catalog IDs and local PDFs. Knowledge is
stored in Neo-Cast's `.neo-cast/literature-knowledge/` directory.

From `opencode/packages/opencode`:

```bash
bun run src/research/literature/dev-cli.ts parse \
  --neo-cast-root ../../../neo_cast --paper-id <paper-id>

bun run src/research/literature/dev-cli.ts build \
  --neo-cast-root ../../../neo_cast --pdf /absolute/paper.pdf \
  --title "Paper title" --publication-status unknown

bun run src/research/literature/dev-cli.ts validate \
  --neo-cast-root ../../../neo_cast

bun run src/research/literature/dev-cli.ts export \
  --neo-cast-root ../../../neo_cast --status paper_backed

bun run src/research/literature/dev-cli.ts show-run <run-id> \
  --neo-cast-root ../../../neo_cast
```

`build` uses the existing Neo-Cast LLM configuration when an API key is
available. Without a configured model it still parses and caches the document,
then records a `partial` run with `llm_not_configured`; it never fabricates
cards. Pass `--no-llm` to request that parse-only partial behavior explicitly.
Tests use `FixtureExtractionModel` for deterministic extraction.

PDF text is untrusted. Extraction and verification prompts forbid executing
paper instructions, and deterministic validation requires every evidence span,
page, section, chunk, and reported number to resolve back to normalized source.

### Legacy v1 audit implementation (not the active pipeline)

Evidence validation v2 resolves section headings through the parsed document's
section table (or a numbered subsection heading present in the supporting chunk).
Extraction requests use the canonical `sectionID`. Whitespace-only quote drift
may be repaired by copying the literal substring from the source; the persisted
`exact_span` is that recovered substring, never the modified quote. Original
candidates and canonical locations remain in the run artifacts for comparison.
Wrong pages, unresolvable headings, changed words, and fabricated numbers still
fail validation. `--allow-normalized-evidence` additionally permits the existing
Unicode-normalized matching path; such evidence remains `normalized_span`.

The configured verifier retries a malformed response once with schema-error
feedback. It accepts an unused `correctedClaim: null` as an omitted optional
field, but never converts invalid directness values into semantic verdicts.
Persistent failures are recorded as `verification_error` and make the run
`partial`. Review reports distinguish quality rejections, verification errors,
and duplicate merges. Extraction/verification prompt versions and the evidence
validation version invalidate affected caches. Unknown sections permit all
requested card types so experimental settings can be classified as protocols.

## Session tools and Cockpit

The initial rollout keeps `direct` execution as the default. Enable the child
session path on a research task by setting:

```json
{ "runtime": { "literatureSessionTools": true } }
```

This is a field within the existing taskSpec runtime object; preserve the task's
other runtime settings. A configured LLM that maps to an OpenCode provider is
required for `session_tool`. Missing credentials, an unavailable provider/session,
or a session that ends before executing the tool fall back to `direct`. Once the
write operation starts, the service reconciles that same operation and validates
persisted results; it never silently reruns an uncertain tool operation. A bad
receipt, corrupt schema/cache/store or mismatched provenance fails the phase.

The hidden `research-literature` agent can use only:

- `literature_list_intents`: fixed report/index/budget snapshot, paginated.
- `literature_search`: existing intent ID and topK within server limits.
- `literature_read_paper`: approved paper ID and bounded chunk/page excerpts.
- `literature_run`: the only evidence-writing entry point; no task/path/force overrides.
- `literature_get_results`: validated current-run summaries, paginated.

All tools require an active service binding to the child session. Exploration
refreshes a changed index before execution; it cannot admit papers independently
of the selector. Repeated and concurrent calls share an execution promise; writers
sharing a KnowledgeStore are serialized within the server process. After a server
restart, workflow recovery validates persisted results instead of resuming an old
LLM conversation. Cancellation/timeout signals stop work at the next progress boundary;
an already pending extraction request may finish before cancellation is observed.
A cancelled operation remains failed for that binding, so retries cannot start a
second write operation. Do not run multiple server processes against the same store.

Cockpit displays DataAnalysis → LiteratureAgent → HypoPlanner, bounded progress,
cache hits and tool status/duration. Completion includes counts, gaps, readiness
and `session_tool`/`direct`. `ready_data_only` is a successful phase with no paper
support. Completion summaries are written to the existing stream log and recovered
from artifact metadata when reopening Cockpit. `/literature-session` opens the
child session during execution or after its result has been registered; it is also a child of the root
research session. No PDF body or raw tool JSON is copied into the root session.

The `research.agent.literature.started/completed/failed` events use the existing
Research stage envelope (`taskID`, `agent`, `stage`, `status`, `metadata`). Completed
metadata includes run/artifact IDs, readiness, counts, callPath and child sessionID.
`research.agent.literature.progress` carries `runID`, `step`, optional `paperID`,
status, counts and cache status. `.stream.delta` and `.part.updated` use the existing
Research streaming envelopes. Legacy RetrieveAgent events remain available.

Internal extraction/verification LLM calls remain inside `literature_run`; they
are represented by progress, not separate OpenCode tool parts. Optional
`literature_process_papers` and `literature_finalize` are intentionally deferred.
No database migration or artifact schema version change is required.

### Mechanism quality and budgets (v3)

New mechanism candidates must carry `problem` and `mechanism` (`mechanismID`, `name`, `principle`, nonempty `components`). The semantic verifier must confirm correct card type, a supported complete operation, and the paper's own method. A quotation of an experimental setting or another paper's model cannot satisfy this gate. Normalization retains these fields. Legacy v1 cards remain readable only through audit helpers; the active task-evidence bridge requires reviewed v2 principles. Re-extract from source to upgrade; never fill missing mechanisms from general knowledge.

Candidate arrays are validated item by item with one feedback repair. `extraction_attempts.jsonl` preserves raw attempts, `candidate_claims.jsonl` preserves all parsed candidates, and `card_validation.jsonl` records accepted card revisions and the validation rule. Adjacent chunks supply context; the current chunk must also support each candidate. Verification and deduplication precede the storage budget, which favors mechanisms while reserving diversity of card types and source pages. `selection_budget` is counted separately from quality rejection and verifier failure. Exact structured operations can merge; merely sharing a mechanism name does not justify merging.

Retrieval uses cached local PDF first-page previews (first two pages, up to 24,000 characters), with failures visible in screening reasons. Previews support recall only and cannot back knowledge-card evidence. Scientific phrase matching is complete, with explicit concept aliases; reading quotas follow scientific re-ranking and round-robin allocation across intents. Conformal/interval methods remain auxiliary for point objectives. This is deterministic screening, not an LLM semantic review. Task-evidence coverage for mechanism questions requires `supports_mechanism`; warnings and definitions may be useful entries without closing those gaps.

The live ETTh1 rerun exposed array-valued enum outputs copied from the verifier's contract examples. `evidence_verifier_v4` describes `verdict` and `evidenceDirectness` as scalar strings; invalid arrays are still rejected, never coerced into support. v3 and v4 share the same semantic quality rule, and both remain eligible after successful validation. A separate second review found that complete mechanism cards can still duplicate a parent operation or misclassify definitions/ablation variants. Card count must not be reported as the number of independent mechanisms; paper-level consolidation and hierarchy remain an open quality gap.
