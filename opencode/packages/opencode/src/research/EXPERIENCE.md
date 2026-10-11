# Research experience

Research experience has three explicit levels:

| Level                    | Content                                                                                              | Use                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `experiment_fact`        | A selected observed run or failure with authoritative factual snapshots                              | Traceable evidence                                    |
| `conditional_experience` | Conditions, intervention, observation, boundaries and a validation plan                              | Generate a hypothesis on another compatible task      |
| `validated_principle`    | A scoped relationship with independent support on multiple dataset contents, and any counterevidence | Inform experiment selection within the observed scope |

## Formation and storage

All runs and artifacts remain the experiment record. Successful runs still update the champion and persist the evaluation decision, including seed and secondary-metric checks, in `resourceUsage.evaluationDecision`. Creating or completing a run does not automatically add a research experience.

ReflectionAgent decides whether a result merits saving and may call `write_experience` zero or more times. Positive, negative, mixed and inconclusive experiences are supported. Its final `distillableMemory` is a report summary, not an implicit write. The direct API fallback can explicitly request the same validated operation through an optional `experienceWrites` array; omitted or empty arrays save nothing. Write outcomes are included in the persisted reflection result.

Each saved entry uses the existing `research_memory` row and a versioned `candidateSummary.experience` payload (`research_experience.v1`). It contains the model-authored interpretation and separately captured facts: task/run/candidate IDs, dataset identity, task profile, evaluation settings, proposed recipe/training configuration, actual execution manifest, verification and independence flags, metrics, evaluation decision, errors and artifact IDs. Actual execution and proposed configuration are distinct fields. Exact retries are deduplicated transactionally by a content key. `derivedFrom` records provenance when refining or promoting entries and retains inherited supporting and opposing evidence.

The outer legacy `outcome` is only a compatibility projection of polarity. Consumers must use the experience level, claim and evidence, rather than interpreting it as a champion decision. Structured experiences do not put a recipe in `candidateSummary.candidateSpec`, so their interpretations do not become positive/negative recipe-training labels in the legacy ranker.

New runs capture dataset and evaluation context at creation in `resourceUsage.experienceContext`, and preserve it across status updates. Dataset files receive full SHA-256 identities (cached while file metadata is unchanged). Copies with identical contents count as one dataset. Missing/unreadable dataset contents and historical runs without a run-time snapshot have unverified dataset identity and cannot establish a multi-dataset validated principle. A later edit to a CSV or task configuration does not change a new run's captured context.

## Evidence validation

- References must resolve to finished runs in the same project and domain, with at least one source run from the writing task.
- The writer accepts source references, not fabricated factual metrics or model snapshots.
- Conditional performance experiences require independent, verified full runs, finite primary metrics and a completed same-task comparison under the same dataset and evaluation settings.
- A validated principle needs support from at least two distinct dataset content hashes. Performance principles also require paired comparisons; execution principles require verified full successes or independently observed failures with error evidence. The count is a minimum evidence gate, not a claim of universal validity or statistical significance.
- Ref-test and blind-test outcomes cannot enter search experience.
- Refinements preserve inherited evidence relations; contradictory observations must be retained and addressed in scope/boundaries.

Performance claims additionally require the predeclared controlled experiment contract and its exact named comparison. All unlisted model and training fields remain frozen. The stored summary is generated from actual field changes and numerical contrasts; model prose remains in `unverifiedInterpretation` for audit and is not transferred as factual memory. Legacy performance experiences without canonical grounding are excluded from experience recall. Observation-only writes preserve numerical facts without implying causal attribution.

## Reading and use

`read_experiences` is available to HypoPlanner and ReflectionAgent. Its default scope includes structured experiences from the same project and domain. It supports task-only scope, level/polarity/text filters, a bounded result count and optional full factual snapshots. The reader selects recent records after filtering; semantic retrieval and automatic applicability scoring are not implemented. The agent checks stated conditions against current-task facts.

HypoPlanner may explicitly read experience through the tool. Direct transport retrieves experiment history on demand; neither transport receives an automatic memory projection. It cites experience and source-run IDs in hypothesis motivation, records transfer assumptions and defines a current-task falsification criterion. Experience IDs are not literature citations. Cross-task memories do not suppress first-iteration baseline selection.

ModelDesigner receives the selected hypothesis, task evidence and complete component semantics, and requests experiment history when needed. Memory and experience summaries are not injected into its design input. Failed legacy configurations from other datasets no longer populate its forbidden-signature list. The existing heuristic ranker can still use local run metrics and the local champion.

## Compatibility

Literature-card feedback is a separate operation: Reflection can explicitly confirm
named v2 assertions through `confirm_knowledge` (or direct `knowledgeValidations`).
The writer attaches authoritative current-experiment facts and scoped assessments
to the card and adds `0.01` confidence once per card/task/run, capped at `1`.
This does not automatically create or promote an experience. See
[literature confidence](literature/README.md#confidence-from-current-experiments).

No destructive database migration is required. Existing rows and exported history remain readable through the legacy memory APIs and reports. They are not automatically relabeled as facts or promoted into transferable experience. The old `createMemory` API is retained for legacy clients, but cannot inject a structured experience payload; it must go through the validated writer. Future experiences are included in existing task exports via `memory.json` and the memory-created event.
