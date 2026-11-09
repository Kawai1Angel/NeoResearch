# Current task admission policy (2026-10-11, corrected)

Reviews now preserve source prerequisite logic explicitly: `conditionLogic` is AND
across groups and OR within a group's zero-based condition indexes. A matched smoothness
alternative satisfies "smooth OR periodic" even if periodicity is unknown. Groups cite
the original rationale; every necessary condition is covered exactly once. Optional
context, source hyperparameters and unmeasured local gains are not data prerequisites.
Saved legacy reviews without this field remain readable as implicit conjunctions;
fresh mainline reviews must provide it.

`inputStructure` is derived from historical target columns plus observed-past covariates,
with forecast target count recorded separately. Missing metadata remains null. Input-count
conditions cannot use output `targetColumns` as negative evidence. A single forecast target
does not veto multivariate modeling; genuinely missing cross-channel diagnostics still
withhold rules requiring those diagnostics. Spectral energy concentration does not by
itself require stable periodicity.

Each fresh review also checks condition logic, input/output distinctions, family abstraction
and absence of local-replication prerequisites. `revisionAdvice` requests a semantic revision,
an applicability reassessment, or neither. Repairable feedback triggers up to two separate
`architecture_revise` rounds, each followed by a fresh independent source/eligibility review.
The extractor may narrow unsupported wording, retain a source-supported family and disclose
operator differences, or withdraw. It cannot invent diagnostics or discard genuinely necessary
conditions. A revision alone grants no citation authority. Genuine missing prerequisites do
not trigger retries; exhausted, withdrawn or invalid revisions remain excluded.

Original cards remain unchanged. Hashed audit records retain each original proposal, review,
feedback, revision and fresh review. A reviewer can inspect additional source spans on a
decision's cited cards. Inspected sibling cards remain in the full audit, while the final
handoff projects reviews onto selected source cards so unrelated inspection metadata cannot
invalidate an otherwise valid packet. Revision prompts and limits participate in retrieval
cache identity. These changes do not rewrite saved evidence in an already-running task.

The mainline emits `architecture_knowledge_v4_mechanism_family` under
`implementable_family_prediction_v1`. Knowledge answers: **under what data conditions,
which modeling family helps or harms prediction, and why?** The original sources must
support the abstraction. ModelRecipe must express a usable preference or exclusion in
that family; reproducing the paper's exact operator, full architecture, dataset, window
length or measured gains is not required. No local replication prerequisite applies.

A review records `familyMappings`: a registered family, prefer/avoid role, source-backed
rationale and explicit transfer boundaries. Its schema-valid v3 recipe is a witness of
structural expressibility, not a paper replica or the task's experiment configuration.
Program owns legacy encoder adapter declarations and derives witness mechanism IDs from
actual recipe fields, without changing source claims or experiment contracts. Checks compare
the claimed family against those fields, validate registry operations and match necessary data conditions to exact report paths and values.
DLinear can inform affine temporal modeling and trend/residual separation despite the
latent-to-head implementation; PatchTST can inform local patch representations without
requiring its full pipeline or source window. Frequency features support a spectral
representation family but do not implement complex FreMLP/IFFT. Negative knowledge about
an available family can remain useful when a paper's bespoke alternative is unavailable.

Necessary unknown data conditions, known mismatches and efficiency-only rules are withheld.
A missing known-future/static input cannot be removed by abstraction, and absent correlation
diagnostics cannot establish weak channel dependence. Mixed accuracy/efficiency papers are
read for their independently supported accuracy principles. Published theory and attributed
explanations remain eligible at their disclosed scope; full-pipeline gains are not isolated
component effects or current-task gains.

Paper selection records unavailable exact operators as audit information, rather than
rejecting the entire source before family extraction. An explicit source-bound review that
finds no transferable family can still exclude a paper. Capability snapshots, policy,
prompts and versions participate in cache identity. Older packets remain readable but
cannot authorize citations before fresh family review. Empty admission yields data-only
planning. Running applications must reload code and rerun retrieval/planning to replace old
saved evidence; this change does not rewrite active task artifacts.

The previous `executable_matched_prediction_v1` policy incorrectly demanded original-operator
identity. Its zero-admission result does **not** establish that the corpus lacks useful
mechanism-family knowledge. The older v2 description below documents the architecture
pipeline; its allowance for unknown necessary conditions in task handoff is superseded.

# Conditional architectural knowledge

## Automatic mainline

`createLiteraturePhase` supplies the configured 16,384-token model to `RetrieveAgent`.
Every new retrieval automatically runs broad card recall → original-source extraction →
independent semantic/source review → bounded semantic revision and fresh review when needed →
usefulness and redundancy curation. `HypoPlanner`
and `ModelDesigner` receive the resulting `taskEvidence.architectureKnowledge` through
the same evidence handoff used by service execution and session tools. No separate CLI
command or manual copy is required.

Useful knowledge has the form **data condition → prefer/deprioritize a structural choice
→ source-backed explanation and scoped observation**. Window-length sweeps, training
recipes, performance rankings, computational tricks and named-module descriptions alone
are rejected. Published experience is usable without reproducing the authors' experiments.
Unknown target-data conditions remain conditional; author explanations remain attributed
explanations rather than established causal laws.

Default budgets distinguish three different units:

- Paper search: 40 source-catalog candidates per intent plus the local classic library;
  up to 8 new papers per intent and 12 new papers total. Reused paper/intent pairs are
  identified before quotas and do not consume new-paper slots. These are ceilings, not targets.
- Card recall: a paper-diverse pool of up to 128 current and historical v2 cards; LLM
  global LLM shortlisting for original-source reading is capped at 40 cards. Strong complementary evidence from one paper is not discarded by a round-robin reading quota. It is independent of
  the earlier per-intent source-card selection.
- Final handoff: up to `maxTaskEvidenceEntries` architectural decisions (default 12),
  after independent source review and final curation. Zero useful decisions is valid.

Active sealed cards come from the shared KnowledgeV2Store. Historical v2 cards are
read from `<neoCastRoot>/.neo-cast/literature-reruns`; every historical source quote
must match normalized local chunks by document identity, content hash and text span.
Only a provenance-version mismatch may be tolerated for historical discovery. Archives
never overwrite current cards and are never republished. v1 fragments and files under
`docs/` are not mainline discovery sources.

Source extraction reads batches of at most 4 cards, bounded by 220,000 serialized
characters. Sources are not silently truncated. The independent reviewer checks the
condition, non-circularity, structural choice, source fidelity, counterevidence and task
applicability. Final curation removes redundant or unhelpful rules; it does not fill a
quota. Complete JSON fences are accepted; malformed JSON or references receive one repair
attempt. Batch reviews are validated entry by entry: qualified results are retained,
and only missing, duplicated or invalid entries receive bounded single-decision retries.
Valid rejections also remain final reviews unless their explicit semantic revision advice
requires a revision. Invalid JSON is never salvaged by guessing truncated content.

Single-decision review and revision requests contain only the associated cards. Their full
sources, assertions, support/refutation links, experiments and boundaries are retained;
evidence is not limited to the extractor's cited source IDs or truncated to save context.
Revision and fresh review retain the original associated cards too, so removing a citation
cannot hide original counterevidence. Unrelated sibling cards are not sent or authorized.

Artifacts under `.neo-cast/literature-retrieval/runs/<retrieveRunID>/` include:

- `architecture_knowledge.json`: final decisions, immutable source cards, source reviews,
  target applicability, exclusions and warnings.
- `architecture-audit/`: full hashed request/response records for recall, extraction,
  review, optional semantic revision and curation, including review checks and feedback.
- `task_evidence_bundle.json` and `retrieve_result.json`: the same architecture packet
  embedded in the normal task handoff.
- `report.md`: final architectural decisions and separately labelled original selection audit.

Only sources of final approved decisions authorize downstream card/revision/role citations.
The original `bundle.entries` and its intent counts remain source-selection audit data;
validators use `citableTaskEvidence()` / `projectTaskEvidence()`. Planning and design prompts
use `projectPlanningTaskEvidence()`: admitted decisions, exact applicability conditions and
AND/OR logic, limitations, available family mappings and transfer boundaries, and card IDs,
revisions and permitted roles. Decisions appear once; full cards, quotes, source experiments,
review histories and illustrative recipe witnesses stay in the sealed artifact. The designer
retains all complementary source IDs needed for its selected hypothesis. `read_task_evidence`
reads one exact stored section (`knowledge`, `sources`, or `review`) by card ID and revision,
optionally selecting source IDs, with character pagination (default 4,000; maximum 12,000).
It is bound to the session's task evidence artifact, rejects withheld/stale cards, and does not
extract new papers. Direct transport uses the same reader through `evidence_request`, sharing
the existing bounded history-request loop. Planning summaries over 120,000 characters fail
before a model request rather than dropping scientific conditions or citations. No model or no
approved decisions yields `ready_data_only`, with no fallback to old tuning cards.
Partial failures withhold affected proposals and preserve the successfully reviewed subset.
Original v2 bundles without an architecture packet retain their legacy citation contract.

Corpus, model/output budget, prompts, pipeline version and selection limits participate in cache
identity. Completed packets qualify for a full-run cache hit. No-model unavailable packets
can be reused only while no model is configured (adding a model changes the run ID).
Validated per-decision review receipts are keyed by the model, review prompt, decision,
task context and complete related source evidence. Partial runs reuse these receipts and
retry only unresolved entries; cached invalid review responses never suppress a fresh retry.
Changing any of that review context requires a new review. Partial runs also recover using
per-request audit caches. Progress exposes `new_papers`,
`reused_papers`, `reused_cards`, followed by `recall_architecture`, `distill_architecture`
and `review_architecture` with their separate card/decision counts.

Restart an already running application to load these source changes. A task that has
already completed literature retrieval keeps its existing artifact until retrieval and
its downstream planning are explicitly rerun.

## Standalone audit tool

The earlier exploratory CLI remains available for manual audits:

```bash
bun src/research/retrieve/architecture-knowledge-cli.ts \
  --workspace-root /path/to/neoresearch \
  --input /path/to/retrieval/run/input.json \
  --output /path/to/new/output-directory \
  --include-history
```

`--inventory-only` avoids LLM calls. `--selection-file` supplies a complete recall partition.
Unlike the mainline, this legacy tool can also discover exports in `docs/` and produces
preliminary extraction/review results without the final automatic curation stage. Its
output is not a mainline handoff and must not be copied over task artifacts. Keep all
runtime outputs, paper excerpts and request logs local and out of commits.
