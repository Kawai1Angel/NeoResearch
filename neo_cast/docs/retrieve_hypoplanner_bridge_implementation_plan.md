# LiteratureAgent Phase HypoPlanner Mission Evidence Bridge Implementation Program

Rule additions (2026-09-27, pending implementation and acceptance): sections 5.2 and 5.7 add card-type completeness and mechanism-role gates, aligned with the [knowledge-card rules](../../neoresearch/packages/neoresearch/src/research/literature/README.md). The implementation progress below does not mean these additions are implemented.

Progress achieved (2026-09-21): Bridge functionality, durability, recovery path and offline acceptance have been achieved; The following established failures continue to occur with respect to the full-base testing.
The original design and acceptance requirements are retained below without the complete training/publishing line being marked as green.

| Execute Waves | Completed content | Acceptance location (relative to `neoresearch/packages/neoresearch/`) |
| --- | --- | --- |
| Wave 1 | Rigorous evidence compacts, semantic binding, applicability, coverage/diversity/budget, conflict and exclusion of audits | `test/research/retrieve/task-evidence-builder.test.ts` |
| Wave 2 | deterministic/direct LLM Reference Validation, Illegal Batch Back, Markdown/YAML response | `test/research/hypo-planner-agent.test.ts` |
| Wave 3 | Old Line Migration Default, Real add/update/list, service/store Consistency, fixed proof of session | `test/research/hypothesis-evidence-{migration,tools}.test.ts` |
| Wave 4 | DataAnalysis → Literature → HypoPlanner; repeated recovery, downstream replanning after cache repair, and blocking corrupt source contracts | `test/research/literature-{phase,pipeline}.test.ts` |
| Wave 5 | v1 Diagnosis Compatibility, V2-only Run, Real KnowledgeStore Integration, Service Example and Return Record | `test/research/retrieve/retrieve-agent.test.ts`,`src/research/retrieve/README.md` |

Details of achievement: the budget ceiling remains valid; Unselected Warning Claim will enter excluded detail and same intent selected entries
Conflicts, regulation relationships may appear even if one side is excluded from the budget. HypoPlanner does not use extra top-3 to intercept these warnings.
The failure of a single article was downgraded by the Literature Processed status; Global Bridge Anomalous and Damaged Contracts must fail. Recovery can be reported from active sources
Rebuild caches, but not bypassing damage sources reports; Reconstructing the Literature will remove downstream markers and avoid repeating old assumptions.

Validation record: This Bridge Connection Orientation Test**75 Passed, 0 Failed (16 file, 351 assertion)** Type check, migration consistency check passed.
Complete `service.test.ts --timeout 60000`
This round is ** 26 passed, 46 failed, focusing on existing execution-contract/champion constraints and old checkpoint expectations.
`neo_cast/npm test` 's latest phase in Node is **66 passed, 4 failed**: Test Python missing `jsonschema` (2 item),
Without ETTh1 fixture (1 item), with existing schemtuler coverage incomplete (1 item), the Python phase was not reached.
These failures are recorded in section 11.6 and have not been bypassed by modifying unrelated modules or weakening constraints.

## 1. Objectives and defined decision-making

This program treats search, essay understanding and task evidence assembly as an external `LiteratureAgent` case and completes the verse to
The `HypoPlanner` bridge allows HypoPlanner to use the proven KnowledgeCard in the knowledge base to generate retrospective and perjury research assumptions.

Structure decisions identified:

1. Do not add Agent;
2. Only one external exposure `LiteratureAgent` case; RetrieveAgent and the existing LiteratureAgent are functionally split within the area;
3. Existing LiteratureAgent kernel maintenance tasks are not related, except for dissertation, claim extraction, proof validation and canonical KnowledgeCard;
4. All task-level reprocessing is within RetrieveAgent;
5. Evidence Bundle is a structural product of LiteratureAgent case, not an independent Agent or workforce case;
6. Mandate relevance, BM25 fractions and hypothetical references cannot be written back to canonical KnowledgeCard;
7. HypoPlanner does not directly scan KnowledgeStore or re-execut the search;
8. The first version uses the certainty matching rule and does not introduce new LLM group calls;
9. Allows HypoPlanner to continue in `data_only` if there is no qualified documentary evidence; Contractual damage or inconsistency must fail.

Final boundary:

```text
DataAnalysisAgent
        ↓ dataset_quantitative_analysis_v1
LiteratureAgent phase
        └─ RetrieveAgent.run()
             ├─ Retrieve ex-processing
             │    ├─ Data evidence, scientific concepts, intent to retrieve.
             │    └─ BM25 Recall and Thesis Selection
             ├─ LiteratureAgent.run() (paper understands kernel)
             │    └─ verified canonical KnowledgeCards
             └─ Retrieve Post Processing
                  ├─ Loaded Cards
                  ├─ I'm sorry, but I don't know what to do with you.
                  ├─ Trustworthiness and applicability filter
                  ├─ Cross-paper conflict, coverage and budget processing
                  └─ task_evidence_bundle_v1
                            ↓
                       HypoPlanner
                            ├─ Data evidence + documentary evidence
                            ├─ cardID/revision Reference
                            └─ Application of assumptions and perjury conditions
```

Thus, the external mainstream water lines show only:

```text
DataAnalysisAgent → LiteratureAgent → HypoPlanner
```

`Retrieve(pre) → Literature(core) → Retrieve(post)` belongs only to the internal execution scale of LiteratureAgent case.

## 2. Current foundations and gaps

### 2.1 is capable

The current code has been provided:

- `dataset_quantitative_analysis_v1`, which includes domain, data role, projection range, size, missing, periodicity, trends, drift, spectrum, variable points and cross-lag;
- `DatasetEvidence → ScientificConcept → MethodConcept → RetrievalIntent`;
- BM25 candidate, paper/intents polymer and LiteratureAgent Bridge;
- `KnowledgeCard` applicability, exclusion, limitations, immunisation, confidence, status and protection;
- Paper-level links for `RetrieveResult` paper, inent, Candidate and acceptedCardIDs;
- KnowledgeStore's card review, card registration and precision span;
- deterministic/LLM/session of HypoPlanner has three generation paths and hypothesis pool persistent.

### 2.2 needs to fill the gap

The current link stays at:

```text
paper.intentIDs[] + paper.acceptedCardIDs[]
```

_Other Organiser

```text
cardID
→ matched intentID
→ transformationID
→ conceptID
→ datasetEvidencePath
→ applicability decision
→ hypothesis evidence reference
```

At the same time, there are the following gaps:

- RetrieveAgent did not load the LiteratureAgent back card;
- All accepted cards from the same paper currently share a group of intentIDss, which have not been calibrated;
- HypoPlanner input, prompt, output and YaML do not contain documentary evidence;
- The session-mode drops through the `hypothesis_add/update` library, where there are currently no evidence reference fields;
- Autonomous Pipeline currently enters HypoPlanner directly from DataAnalysis;
- Workflow recovery has no external `literature` phase.
- There are no tests for testing evidence, readinstance or evidence Gap.

## 3. Scope

### 3.1 Achieved during the period

- RetrieveAgent internal task integration;
- I don't know what to do with it.
- Card class intent/concept/data-evidence binding;
- (a) Identification of eligibility and application;
- Cross-paper heavyness, conflict retention, coverage and budget selection;
- RetrieveResult v2 and `task_evidence_bundle.json`;
- HypoPlanner input, output, prompt, tool and durability extension;
- (a) The main time-series, recovery and downscaling strategy for Pipeline;
- Units, integration, migration and end-to-end testing.

### 3.2 Not achieved during the period

- New Age;
- LiteratureAgent task-aware prompt;
- Modifys the job matching for canonical KnowledgeCard;
- Vector search, reranker or online paper API;
- LLM card-intent classifier;
- Automatic repeated Search → Learn → Search cycles.
- Modify KnowledgeCard status based on the results of individual task experiments;
- Automatically generate new cross-dissertation scientific findings.

## 4. Contract design

### 4.1 RetrieveTaskContext

`DatasetQuantitativeAnalysis` already covers the main data features, but does not contain complete research objectives and operational constraints. When calling RetrieveAgent, Research Service should enter a standardized and minimised task context instead of passing the complete database object to the retrieving module.

```ts
export const RetrieveTaskContextSchema = z.object({
  taskType: z.string().min(1),
  domain: z.string().min(1),
  objective: z.object({
    primaryMetric: z.string().min(1).optional(),
    probabilistic: z.boolean(),
  }).strict(),
  constraints: z.object({
    computeProfile: z.enum(["low", "medium", "high", "unknown"]),
    latencyBudget: z.number().finite().positive().optional(),
    parameterBudget: z.number().finite().positive().optional(),
  }).strict(),
}).strict()
```

`RetrieveAgentInput` Add:

```ts
readonly taskContext?: RetrieveTaskContext
```

In order to maintain independent CLI and test capabilities, extrapolate from the quantative report:

- `taskType = forecasting`;
- `domain = report.domain`;
- `probabilistic = false`;
- `computeProfile = unknown`.

The human best must record whether the source of the context is `research_task` or `report_fallback`.

### 4.2 TaskEvidenceEntry

```ts
export const TaskEvidenceEntrySchema = z.object({
  evidenceEntryID: z.string().regex(/^te_[a-f0-9]{16}$/),
  cardID: z.string().regex(/^kc_[a-f0-9]{12}$/),
  cardRevision: z.number().int().positive(),
  paperID: z.string().min(1),
  cardType: z.enum(CARD_TYPES),
  cardStatus: z.enum(["paper_backed", "corroborated", "contradicted"]),
  claim: z.string().min(1),

  linkage: z.object({
    intentIDs: z.array(z.string()).min(1),
    candidateIDs: z.array(z.string()).min(1),
    transformationIDs: z.array(z.string()).min(1),
    conceptIDs: z.array(z.string()).min(1),
    methodConceptIDs: z.array(z.string()),
    datasetEvidencePaths: z.array(z.string().startsWith("$.")).min(1),
  }).strict(),

  roles: z.array(z.enum([
    "supports_mechanism",
    "supports_applicability",
    "suggests_implementation",
    "defines_evaluation",
    "warns_limitation",
    "contradicts",
  ])).min(1),

  relevance: z.object({
    score: z.number().min(0).max(1),
    matchedTerms: z.array(z.string()),
    reasons: z.array(z.string()).min(1),
  }).strict(),

  applicability: z.object({
    status: z.enum(["matched", "partial", "conflicted", "unknown"]),
    matchedConditions: z.array(z.string()),
    violatedConditions: z.array(z.string()),
    uncertainConditions: z.array(z.string()),
  }).strict(),

  evidenceRefs: z.array(z.object({
    evidenceID: z.string(),
    chunkID: z.string(),
    section: z.string(),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    directness: z.enum(["direct", "indirect", "inferred"]),
    verification: z.enum(["exact_span", "normalized_span", "manual_required"]),
  }).strict()).min(1),

  limitations: z.array(z.string()),
  implementation: z.object({
    recipeConcepts: z.array(z.string()),
    registryMappings: z.array(z.string()),
    estimatedComplexity: z.enum(["low", "medium", "high", "unknown"]),
    notes: z.array(z.string()),
  }).strict().optional(),

  confidence: z.object({
    sourceQuality: z.number().min(0).max(1),
    extractionConfidence: z.number().min(0).max(1),
    evidenceDirectness: z.number().min(0).max(1),
    transferability: z.number().min(0).max(1),
  }).strict(),
}).strict()
```

`relevance.score` only indicates the extent to which the card is relevant to the current intent and does not indicate the credibility of the paper.4D confidence remains separate and does not merge into a single trust score.

### 4.3 ExcludedTaskEvidence

All acceptedCardID must have a destination: enter anentries, or enter excruded with cause. It is forbidden to leave silently.

```ts
export const ExcludedTaskEvidenceSchema = z.object({
  cardID: z.string(),
  paperID: z.string(),
  reasons: z.array(z.enum([
    "card_not_found",
    "paper_mismatch",
    "status_not_eligible",
    "no_direct_exact_evidence",
    "no_intent_match",
    "hard_applicability_conflict",
    "duplicate_claim",
    "selection_budget",
  ])).min(1),
  detail: z.array(z.string()),
}).strict()
```

### 4.4 TaskEvidenceBundle

```ts
export const TaskEvidenceBundleSchema = z.object({
  schemaVersion: z.literal("task_evidence_bundle_v1"),
  retrieveRunID: z.string(),
  taskID: z.string(),
  quantitativeReportArtifactID: z.string(),
  taskContextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  readiness: z.enum([
    "ready_with_evidence",
    "ready_data_only",
    "partial_evidence",
    "evidence_conflict",
  ]),
  entries: z.array(TaskEvidenceEntrySchema),
  excluded: z.array(ExcludedTaskEvidenceSchema),
  conflicts: z.array(z.object({
    relationID: z.string(),
    sourceCardID: z.string(),
    targetCardID: z.string(),
    rationale: z.string(),
    confidence: z.number().min(0).max(1),
  }).strict()),
  gaps: z.array(z.object({
    intentID: z.string(),
    conceptIDs: z.array(z.string()),
    mustCover: z.boolean(),
    reason: z.enum([
      "no_candidate",
      "no_local_pdf",
      "literature_failed",
      "no_accepted_card",
      "no_eligible_card",
      "selection_budget",
    ]),
  }).strict()),
  summary: z.object({
    acceptedCardCount: z.number().int().nonnegative(),
    selectedEntryCount: z.number().int().nonnegative(),
    excludedCardCount: z.number().int().nonnegative(),
    coveredIntentCount: z.number().int().nonnegative(),
    uncoveredMustCoverIntentCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
  }).strict(),
}).strict()
```

### 4.5 RetrieveResult Version

Add `retrieve_result_v2` to include required `taskEvidence`:

```ts
{
  schemaVersion: "retrieve_result_v2",
  // Original v1 field
  taskEvidence: TaskEvidenceBundle
}
```

Compatibility strategy:

- Retain `RetrieveResultV1Schema` so that the old artifact is still readable by diagnostic tools;
- `RetrieveAgent.run()` returns only v2;
- Run digest added `taskEvidenceMappingVersion` and `taskContextDigest`, thus not misusing old v1 run;
- Research Service only gives v2 to HypoPlanner;
- The old v1 upgrade did not perform in situ upgrades because the condition of the card review and KnowledgeStore may have changed at that time.

## 5. RetrieveAgent Post Processing Algorithm

### 5.1 KnowledgeStore Access

Add to `RetrieveAgent` a store dependent for reprocessing only:

```ts
type TaskEvidenceKnowledgeSource = {
  getCard(cardID: string): KnowledgeCard | undefined
  listRelations(): CardRelation[]
}
```

Constructor supports injection of `knowledgeSource` for fixture testing. The production environment is used after the completion of the Literature Bridge:

```text
<knowledgeRoot>/knowledge.db
```

Creates `KnowledgeStore` to read cards, and RetrieveAgent closes its own connection at the same time that it closes. LiteratureAgent is not allowed to access the Private store or modify the card.

### 5.2 accepted card integrity check

Processing `literatureResults[].acceptedCardIDs`:

1. `getCard(cardID)` must exist;
2. `card.paperID` shall be equal to Literature result paperID;
3. Saves the actual `card.revision` and prohibits assuming that review is 1;
4. The same cardID was cited as contractual error by multiple paper results;
5. Missing or paper mismatch into excluded, making readies at least `partial_evidence`;
6. Do not modify the canonical card.

Add a new type of completeness check: Validate `model_mechanism` according to the knowledge card rules, `model_mechanism` must have non-empty `problem` and complete `mechanism` with corresponding version types, semantic integrity and evidence overwhelming verification records. Only `paper_backed` states or valid references are insufficient; Mechanisms may not be temporarily replaced by labels, model names or search terms. Missing field into excruded for `mechanism_incomplete`; A new version of the authentication log is missing for access to excruded, due to `card_validation_required`; Confirmed type error record `card_type_mismatch`. Retain cardID, review and rationale for exclusion and recalculate coverage/readiness based on the remaining valid evidence.

The old card is still accessible and audited, but the above-mentioned threshold must not be bypassed. Revalidation or extraction of a new view created by LiteratureAgent without modification of the bridge layer; Rebuild affected effects of new rules after they are activated, and retain the old version quotes from the book so as to reproduce them.

### 5.3 eligibility gate

Proof of support must satisfy:

- Status is `paper_backed` or `corroborated`;
- At least one `directness=direct` of ivence;
- At least one `verification=exact_span` of ivence;
- Evidence type is not `agent_inference`.

Other status processing:

| Card status | Processing |
| --- | --- |
| `paper_backed` | It's a positive piece of evidence. |
| `corroborated` | It can serve as positive evidence and take precedence over a single result |
| `contradicted` | `contradicts`/warning only, not positive support |
| `extracted` | Excruded: Not meeting the evidentiary threshold for dissertation |
| `inconclusive` | Excluded, but retained |
| `deprecated` | excluded |

BM25 scores shall not participate in eligibility judgement.

### 5.4 Card → Intent Binding

Each card matches only the associated intentIDs of its own paper, without scanning any other task indent.

Build card term set:

```text
normalizedClaim.subject/predicate/object
+ claim
+ mechanism.name/principle/components
+ applicability.taskTypes/dataFeatures/domains/horizonProfile/computeProfile
+ implementation.recipeConcepts/registryMappings
+ tags
```

Build inent term set:

```text
scientificConcept.conceptID/label/paperTerms
+ methodConcept.conceptID/label/paperTerms
+ paperLanguage task/phenomenon/method/domain terms
```

First edition certainty matching dimensions:

| Dimensions | Default weight | Annotations |
| --- | ---: | --- |
| scientific/data feature exact or taxonomy alias | 0.35 | Current data phenomenon |
| method/mechanism exact or taxonomy alias | 0.30 | Methodological mechanisms |
| task type | 0.15 | Forecasting etc. |
| domain | 0.10 | You can't go through it alone. |
| Card type compatible with int question | 0.10 | mechanism/limitation/evaluation etc. |

The rules require:

- Domain-only cannot create card-intent binding;
- At least one scientific/data-feature or method/mechanism term;
- Saves the matching cause for each dimension;
- One card can bind multiple inents;
- No intent enters `no_intent_match` through a threshold card;
- score is used only for the current bookgle sorting, and does not return KnowledgeCard.

Threshold and alias release into the version configuration:

```text
retrieve/config/tsf-task-evidence.v1.json
```

### 5.5 project expansion

For each monitored indent:

```text
intent.transformationID
→ transformation.scientificConcepts[].conceptID
→ transformation.methodConcepts[].conceptID
→ transformation.datasetEvidence[].path
```

All references must be obtained through an existing ID check, and re-pregnation based on a string is prohibited.

### 5.6 applicability gate

Use Quantitative Report, RetrieveTaskContext and card application to judge the dimensions:

- task type;
- domain;
- data features;
- data scale;
- horizon profile;
- compute profile;
- `notApplicableWhen`.

Rules:

1. `conflicted` when it is specified that the negative hit condition is `conflicted`;
2. Card declared conditions but could not be judged on the side of the mission as `unknown/partial`, which cannot be speculated;
3. An empty application array means "discussed" and does not automatically match;
4. `notApplicableWhen` only parses controlled terms supported in the version configuration; Unresolved natural language into `uncertainConditions`;
5. Hard conflict cards do not act as positive mechanisms or implement recommendations, but may be retained as limitation/conflict;
6. confidence.transferability only participates in sorting and prompting, and does not overwhelm hard conflicts.

TSF First Edition Fact:

- `regular_sampling`:`irregularIntervalRatio < 0.05`;
- `irregular_sampling`:`irregularIntervalRatio >= 0.05`;
- `long_horizon`: Follow the existing `horizonContextRatio >= 1`;
- Data scale and computer profile thresholds are fully configured, not scattered in code.

### 5.7 roll map

Default map from cardType:

| cardType | roles |
| --- | --- |
| `model_mechanism` | `supports_mechanism` |
| `empirical_finding` | `supports_applicability` |
| `applicability_rule` | `supports_applicability`;`warns_limitation` on Negative Condition |
| `limitation` | `warns_limitation` |
| `evaluation_protocol` | `defines_evaluation` |
| `implementation_hint` | `suggests_implementation` |
| status=`contradicted` or communication description | `contradicts` |

The first version of role is generated by the rule of certainty and is not determined by optimistic language in claim.

The above-mentioned map is valid only for cards that are checked through 5.2 and eligibility.`supports_mechanism` must also be covered by mechanism integrity and evidence; Only the cards that describe contact length, predition lngth, data disaggregation or evaluation indicators are not allowed into this role even if `model_mechanism` is wrongly marked.

`evaluation_protocol` can only provide `defines_evaluation` in the assessment-related task needs and cannot be covered by evidence of mechanism issues. Other types are also used for the compatibility of issues and roles; Matches the same horizon or data set, which does not support model design mechanisms. HypoPlanner ' s structural assumptions must either refer to the eligibility mechanism card or be clearly labelled as Agent, which is subject to test tests, and cannot be packaged into paper support.

Acceptance must contain an end-to-end back example: only the card "Input length 96, predict length 96/192/336/720" cannot output `supports_mechanism` or fill intent coverage even if the original is authentic, BM25 scores are high and in state `paper_backed`; Proper classification and validation can provide an agreed reference for assessing needs. There is also a need to verify that the complete mechanism is properly passed, that old versions of missing field cards are excluded and that rule upgrades from the same input do not repeat the old version's eligible cache.

### 5.8 Cross-paper conflict, weight and budget selection

Read `KnowledgeStore.listRelations()`, keep only the bookle card relation inside:

- `duplicates`: more direct preservation of evidence, stronger status, updated update entry, another entry into excluded;
- `supports`: Both may be retained, but the choice of budgetary priority guarantees different paper;
- `contradicts`: Both are retained and added conflicts, without any average or silent selection;
- `refines`: Keep relationships, and more specific card preference when sorting.

Add in `RetrievalBudgets`:

```ts
maxTaskEvidenceEntries: 12
maxTaskEvidencePerIntent: 3
```

Select order:

1. Ensure that at least one of each must-cover incent;
2. limitation/contradiction for each incent;
3. Sort by relevance, card status, directness, transferability;
4. (a) Differentiated from the same priority;
5. Finally sorted with `paperID/cardID` stability to ensure re-emergence.

### 5.9 reports with Gap

```text
ready_with_evidence
  All must-cover inents have qualified entry and no undiscovered high confidence conflicts

partial_evidence
  At least one eligible entry but must-cover Gap, card missing or forum partial/failed

evidence_conflict
  Key incent has high-trust command that must be displayed in HypoPlanner Visible

ready_data_only
  No qualified card;HypoPlanner allows continuation, but only the output of data_only is assumed
```

No PDF, no candidate and LiteratureAgent failed as a gap, not an anomaly for the entire RetrieveAgent.schema/provenance/KnowledgeStore damage is a hard failure.

## 6. RetrieveAgent code changes

Add:

```text
neoresearch/packages/neoresearch/src/research/retrieve/
├── task-evidence-builder.ts
├── card-intent-binder.ts
├── applicability-matcher.ts
└── config/tsf-task-evidence.v1.json
```

Amendments:

```text
retrieve/contract.ts
retrieve/retrieve-agent.ts
retrieve/retrieve-store.ts
retrieve/report-renderer.ts
retrieve/index.ts
research/service.ts
research/event.ts (modify only if necessary to add metadata without adding Agent event)
```

The additional step for `RetrieveAgent.run()` is after Literature Bridge and before construction results:

```ts
const taskEvidence = buildTaskEvidence({
  report,
  taskContext,
  transformations,
  intents,
  candidates,
  literatureResults,
  knowledgeSource,
  budgets,
})

const result = RetrieveResultV2Schema.parse({
  ...,
  taskEvidence,
})
```

RetrieveStore Add a landing disk file:

```text
.neo-cast/literature-retrieval/runs/<retrieve-run-id>/
├── task_evidence_bundle.json
├── task_evidence_excluded.jsonl
└── The remaining existing documents
```

`report.md` Add:

- readiness;
- intent coverage;
- I don't know what you're talking about.
- applicability conflicts;
- Excluded cards and reasons;
- evidence gaps;
- Readable links to the environment path and paper page.

## 7. HypoPlanner Bridge

### 7.1 input

`HypoPlannerInput` Add:

```ts
readonly taskEvidence?: TaskEvidenceBundle
```

The choice is to accommodate manual calls and old tests; When missing, the value is equal to `ready_data_only` and cannot be forged for documentation support.

### 7.2 HypothesisObject

Add mandatory fields and provide empty values for existing deterministic fallback:

```ts
readonly datasetEvidencePaths: readonly string[]
readonly literatureEvidence: readonly {
  cardID: string
  cardRevision: number
  role: TaskEvidenceRole
}[]
readonly applicabilityAssumptions: readonly string[]
readonly falsificationCriteria: readonly string[]
readonly evidenceLevel: "data_only" | "paper_supported" | "conflicted"
```

Binding:

- `paper_supported` at least quotes a booklet entry;
- `conflicted` must refer to or explain the circumstances;
- literatureEvidence for `data_only` must be empty;
- cardID/revision/role must be fully consistent with the bookle;
- Each datasetEvidencePath must belong to the linkage that quotes intry;
- Thesis only supports mechanisms and conditions, not rewriting reported effect as a guarantee for the current mission;
- Each nonbaseline-control assumes at least one penaltycient.

### 7.3 deterministic hypotheses

Existing Hardcoded Hypothesis rules are reserved as a fallback when no literature or LLM failed. Enhancement rules:

- Finds anentries matching concept/method according to rule bias;
- Add literatureEvidence, claims and attachments to entry;
- Keep `data_only` when no intry is available;
- Not automatically replaced by the presence of KnowledgeCard; Only registryMappings or already method library can achieve the recommendation from anentry.

### 7.4 LLM prompt

`buildHypoPlannerUserPrompt()` adds a compressed `taskEvidence`, does not pass on the entire KnowledgeStore or complete evidenceSpan:

```json
{
  "readiness": "ready_with_evidence",
  "entries": [
    {
      "cardID": "kc_xxx",
      "revision": 2,
      "claim": "...",
      "roles": ["supports_mechanism"],
      "conceptIDs": ["multiple_seasonalities"],
      "datasetEvidencePaths": ["$.statistics.frequency.spectralPeaks"],
      "applicability": { "status": "matched" },
      "limitations": []
    }
  ],
  "conflicts": [],
  "gaps": []
}
```

Prompt rule:

- Only cardID/revision can be quoted;
- BM25 or relevance score may not be considered authentic;
- risk/assumptions must be reflected when there is a communication experience;
- `data_only` must be exported if anentry is not eligible;
- expectedOutcome is a projection to be validated, not a paper guarantee;
- Each hypothesis gives a standard of perjury.

### 7.5 output verification

Add a pure function to the HypoPlanner module:

```ts
validateHypothesisEvidence(hypotheses, taskEvidence)
```

It's not Agent, does not create events or status machines. Direct verification:

- Unknown cardID;
- revision mismatch;
- role mismatch;
- Exceeding authority;
- Concluded card as unconditional positive evidence;
- evidenceLevel does not match the reference;
- Missing falsification critteria.

Direct LLM paths that fail to verify, the whole lot of LLM hypotheses is considered failed and uses deterministic fallback to prevent silent deletion of illegal references from continuing.

## 8. Session-mode and Endurance

This is an integral part of this programme. Current main path priority is given to writing in the database via `hypothesis_add/update` tool; If only prompt and memory type are modified, the reference is lost when you drop in the library.

### 8.1 Database Migration

`research_hypothesis` Add:

```sql
dataset_evidence_paths    TEXT JSON NOT NULL DEFAULT '[]'
literature_evidence      TEXT JSON NOT NULL DEFAULT '[]'
applicability_assumptions TEXT JSON NOT NULL DEFAULT '[]'
falsification_criteria   TEXT JSON NOT NULL DEFAULT '[]'
evidence_level           TEXT NOT NULL DEFAULT 'data_only'
```

Amend at the same time:

- `research/research.sql.ts`;
- New migration SQL;
- map/add/update for `research/hypothesis-store.ts`;
- `research/service.ts` duplicated row mapper and direct insert;
- recovery path;
- hypothesis changed event snapshot.

### 8.2 hypothesis tools

Expand `hypothesis_add` and `hypothesis_update` parameters:

- `datasetEvidencePaths`;
- `literatureEvidence`;
- `applicabilityAssumptions`;
- `falsificationCriteria`;
- `evidenceLevel`.

Loading a bookle from the current `task_evidence_bundle_json` description and calling the same `validateHypothesisEvidence()` before tool execution. Do not copy a set of rules on the Tool layer.

`hypothesis_list` returns the full evidence field to enable subsequent reference turn to see previous references.

## 9. Research Service and Pipeline

### 9.1 Artifact

`runRetrieveAgent()`, in addition to the existing retrieve result registration:

```text
kind = task_evidence_bundle_json
schemaVersion = task_evidence_bundle_v1
retrieveRunID
readiness
selectedEntryCount
uncoveredMustCoverIntentCount
```

HypoPlanner loads bundle via artifact URI, and does not calculate the knowledgeRoot path by itself.

### 9.2 Workflow phase

Add in `PipelineWorkflowPhases`:

```text
literature
```

The name of the key's external display and the face owner are both `LiteratureAgent`. Existing RetrieveAgent/LiteratureAgent started/completed/failed
Events can continue as internal substage events without registering Retrieve's pre- and post-processing as an additional workforce case.

The main pipeline is adjusted to:

```text
data_analysis
→ literature
→ hypo_planning
→ searching
```

Add `recoverRetrieveResult()`:

- Accept only `retrieve_result_v2`;
- Validate taskID, quantitativeReportArtifactID and challenge evidence;
- Rerun RetrieveAgent when recovery failed, not using damage.

### 9.3 Call Time Order

```ts
const literature = completed("literature")
  ? recoverRetrieveResult(task)
  : runRetrieveAgent({ taskID }).tap(markWorkflowPhase)

const hypoPlanning = completed("hypo_planning")
  ? recoverHypoPlanning(task)
  : runHypoPlannerAgent({
      taskID,
      taskEvidenceArtifactID: literature.taskEvidenceArtifactID,
    })
```

`runHypoPlannerAgent()` load and pass the same button to:

- deterministic draft;
- session prompt;
- direct LLM prompt;
- final result builder;
- hypothesis tool validation.

### 9.4 failed and downgraded

| Situation | Behaviour |
| --- | --- |
| No, BM25 candidate | Generate `ready_data_only` roundle, continue HypoPlanner |
| No local PDF | Record. Go on. |
| Single Part Literature Failed | `partial_evidence`, go on. |
| All cards don't qualify. | `ready_data_only`, go on. |
| Exists command | `evidence_conflict`, go on but HypoPlanner must show risk |
| cardID does not exist or paper mismatch | `partial_evidence`; Recorded; Failed if all damage |
| Bundle schema/provenance damage | Pipeline failed, silent downgrade is not allowed |
| KnowledgeStore could not be opened | Pipeline failed and RetrieveAgentFailed event maintained |

## 10. Document-level implementation list

### Wave 1: Retrieve task core

Add:

- `research/retrieve/task-evidence-builder.ts`
- `research/retrieve/card-intent-binder.ts`
- `research/retrieve/applicability-matcher.ts`
- `research/retrieve/config/tsf-task-evidence.v1.json`

Amendments:

- `research/retrieve/contract.ts`
- `research/retrieve/retrieve-agent.ts`
- `research/retrieve/retrieve-store.ts`
- `research/retrieve/report-renderer.ts`
- `research/retrieve/index.ts`

Receiving and inspection: RetrieveAgent runs a single direct output strict verification of `task_evidence_bundle_v1`, which can be audited by each selected/excluded card.

### Wave 2: HypoPlanner Contract and deterministic/direct LLM

Amendments:

- `research/agents/hypo-planner-agent.ts`
- Prompt, Parser and direct LLM calls in `research/service.ts`
- `agent/prompt/research-hypo-planner.txt`
- `research/index.ts`

Receiving and inspection: Stable production of `data_only` in the absence of cards; If you have a card, use cardID/revision as a valid reference and bring evidence paths, attachments and fraud crime.

### Wave 3:session tools and databases

Add:

- `migration/<timestamp>_research_hypothesis_evidence/migration.sql`

Amendments:

- `research/research.sql.ts`
- `research/hypothesis-store.ts`
- `tool/research-hypothesis.ts`
- DB insert/map/recovery for `research/service.ts`

Acceptance and acceptance: `hypothesis_add → DB → hypothesis_list → recoverHypoPlanning` evidence field is fully consistent after return; The illegal card quote was rejected at the tool implementation stage.

### Wave 4: popeline and artifices

Amendments:

- `research/service.ts`
- Metadata schema of `research/event.ts` if necessary
- Corresponding service tests

Receiving and Inspection: External Pipeline is ordered as DataAnalysisAgent LiteratureAgent HypoPlanner, LiteratureAgent case
Retrieve (pre) Literation (core) Retrieve (post) and support for case recovery; No documentation is not blocking, damage bundle is blocking.

### Wave 5: Return and Document

Amendments:

- `research/retrieve/README.md`
- (a) The current status of the implementation programme;
- Example CLI/service;
- schema/registry exports.

Receiving and inspection: relevant data tests, migration check and project testing passed; There was no unspecified change in compatibility.

## 11. Test plan

### 11.1 Retrieve Unit Test

Add `test/research/retrieve/task-evidence-builder.test.ts`, at least over:

1. The same paper hits multiple inents, but the card binds only incents matching semantics;
2. Expand card provenance to the correct transformation/concept/evidence path.
3. `paper_backed + direct + exact_span` can be used as positive evidence;
4. extracted/inconclusive/deprecated cannot be used as positive evidence;
5. (a) Contradicted card can only be used as counter-argument;
6. Missing card and paper metatch will not be ignored silently;
7. `notApplicableWhen` is known to create a hard conflict when the word hits;
8. Unknown natural language conditions enter uncerttain, not miscalculation;
9. Domain-only don't create binding;
10. must-cover inent generated when evidence was missing
11. duplicate/supports/contradicts/refines submission correctly processed;
12. Budget priority guarantees for inert coverage and paper diversity;
13. A change in the order of entry does not affect a stable output;
14. A high BM25 score cannot bypass the evidence gate.

### 11.2 Retrieve Integration Test

Expand existing `retrieve-agent.test.ts`:

- Fixture LiteratureAgent writes real KnowledgeStore;
- RetrieveAgent returns taskEvidence;
- `task_evidence_bundle.json` and report drops;
- Repeat to reuse the same v2 run;
- Ask constext or mamapping version will generate a different runID.

### 11.3 HypoPlanner Test

Extension `hypo-planner-agent.test.ts`:

- data-only fallback;
- paper-supported hypothesis;
- conflict hypothesis;
- revision mismatch;
- cardID;
- role mismatch;
- Exceeding authority;
- (a) Loss of financial resources;
- Markdown/YAML displays references and updates;
- Invalid LLM output retreats deterministic hypotes.

### 11.4 Store/tool/migration Test

- New migration can be upgraded from the existing hypothesis scheme;
- Old lines get a security default;
- add/update/list round-trip;
- Two parts of service are identical.
- The session tool rejects the illegal card quote;
- The evidence field after recover is not lost.

### 11.5 Service/pipeline Test

- Verify the external DataAnalysisAgent → LiteratureAgent → HypoPlanner order.
- Verify Retrieve(pre) → Literature(core) → Retrieve(post) within the LiteratureAgent phase.
- Retrieve artifact is used by HypoPlanner;
- `ready_data_only` is not blocked;
- Literature partial unblocked;
- bundle schema damage blocked;
- Completed literature case can be restored;
- force/retry does not create duplicates of retrieveRunID artifact.

### 11.6 recommended command

```bash
cd neoresearch/packages/neoresearch
bun test test/research/retrieve
bun test test/research/literature
bun test test/research/hypo-planner-agent.test.ts
bun test test/research/model-designer-agent.test.ts
bun test test/research/service.test.ts
bun run script/check-migrations.ts
bun typecheck
```

(b) Finally run the agreed complete testing of the warehouse; Records established failures not related to this change and does not modify unrelated modules.

## 12. Completion standards

The bridge is completed only if the following conditions are met:

1. Do not add Agent;
2. LiteratureAgent contract does not receive, canonical card does not contain task match;
3. RetrieveAgent v2 output `task_evidence_bundle_v1`;
4. All acceded card enters self-listed or excluded with clear reasons;
5. Each self-described entries can be traced back to card review, paper vision, intent, concept transformation and daaset experience path;
6. Keep BM25 relevance and card confidence explicitly separate.
7. Must-cover indent coverage or gap auditable;
8. Commradition and determination are not top-K sorted hidden;
9. HypoPlanner cannot quote booklet outside card;
10. Paper-suppleted hypothesis with applicable assumptions and perjury;
11. HypoPlanner Visible Marker `data_only` when there is no literature;
12. (b) The session tool, database, artifact and return not lost evidence;
13. The default pipeline has access to external LiteratureAgent case, which contains the complete Retrieve/Literature/Retrieve scale;
14. Failure of a single paper does not interrupt the mission, contract or damage does not go down silently;
15. Tightened test, migration check and type check passed.

## 13. Order of recommendations

The recommendations are implemented strictly in the following order:

```text
1. TaskEvidence schema + deterministic builder
2. RetrieveAgent v2 + store/report artifacts
3. HypoPlanner in-memory contract + validator
4. hypothesis DB/tool persistence
5. pipeline wiring + recovery
6. full regression
```

Do not change prompt or pipeline first. HypoPlanner is allowed to consume the product only after certainty contracts and tests have stabilized; Otherwise the task matching logic will be scattered in prompt, service and Agent codes, which cannot be audited later.
