# Current NeoResearch Workflow

This document describes the implemented workflow in opencode/packages/opencode: a research state machine built around persistent Task, Candidate, Run, Artifact, Approval, Memory, and Champion objects.

The main scenario is autonomous time-series forecasting research: begin with a goal or CSV, create a task, analyze data, search candidates, execute through Neo-Cast, verify results, retain experience, and export a final report or model package.

## Workflow Overview

```text
Research goal / CSV
  -> Research Task
  -> Intent Agent clarifies the task
  -> Data Analysis Agent analyzes data
  -> NAS Agent searches and executes candidates
  -> Verifier/Analyst/Librarian validate, evaluate, and remember
  -> Reflection Agent reviews and decides
  -> Publish Agent exports reports or models
```

## Core Objects

| Object | Purpose | Typical source |
| --- | --- | --- |
| `ResearchTask` | Domain, specification, objective, budget, and state. | research create, New CSV Task, or natural-language creation. |
| `ResearchCandidate` | Candidate model or recipe. | Domain baseline, LLM proposal, mutation, or manual creation. |
| `ResearchRun` | Execution stage, status, metrics, resources, and errors. | prepareRun, executeRun, or autonomous loop. |
| `ResearchArtifact` | File index for profiles, plans, reports, and models. | Agent, runners, and exporters. |
| `ResearchApproval` | Human decisions for candidates, budget, protocol, ref_test, and blind_test. | Checkpoints, risky candidates, and permission gates. |
| `ResearchMemory` | Lessons from candidates and outcomes. | Automatically recorded after successful, failed, or rejected runs. |
| `ResearchChampion` | Best candidate and corresponding run. | Updated after evaluating successful runs. |

Objects are stored in the local Research DB; file artifacts generally live under .neo-research/.

## Entrypoints

### TUI

The cockpit is the primary interface:

- New CSV Task: create a TSF task from CSV.
- Natural-language goal: create tasks from a prompt or home.
- Seed Baselines: generate initial candidates.
- Agent Loop: run multiple autonomous iterations.
- Export Bundle: export the final bundle.
- Mode: switch interaction mode.
- Use Project Runner / Edit Runner Root: repair Neo-Cast configuration.
- Slash commands such as /seed, /profile, /agent-loop, /export, /approve, and /reject call the same APIs.

When an autonomous task is created from natural language and its runner is ready, the TUI calls /research/tasks/:taskID/pipeline directly for the full multi-agent pipeline.

### CLI

Main commands:

| Command | Purpose |
| --- | --- |
| `research create` | Create a TSF task. |
| `research profile <taskID>` | Generate profile and data-analysis artifacts. |
| `research prepare-dataset <taskID>` | Materialize a Neo-Cast dataset contract. |
| `research seed <taskID>` | Generate baseline candidates and approvals. |
| `research iterate <taskID>` | Run one autonomous iteration. |
| `research loop <taskID>` | Run multiple iterations. |
| `research pipeline <taskID>` | Run the complete multi-agent pipeline. |
| `research vibe <goal...>` | Create a task from a goal and run the pipeline. |
| `research export <taskID>` | Export a report or model package. |
| `research worker-once` / `research worker-loop` | Consume prepared runs from the file-runtime queue. |

### HTTP API

The TUI calls the service through Research HTTP routes. Key APIs:

| API | Purpose |
| --- | --- |
| `POST /research/tasks` | Create a task. |
| `POST /research/tasks/:taskID/profile` | Generate a profile. |
| `POST /research/tasks/:taskID/prepare-dataset` | Prepare a Neo-Cast dataset. |
| `POST /research/tasks/:taskID/baselines` | Generate baselines. |
| `POST /research/tasks/:taskID/autonomous/iterate` | Run one autonomous iteration. |
| `POST /research/tasks/:taskID/autonomous/loop` | Run an autonomous loop. |
| `POST /research/tasks/:taskID/pipeline` | Run the full pipeline. |
| `POST /research/tasks/:taskID/export` | Export artifacts. |
| `POST /research/approvals/:approvalID/reply` | Respond to an approval. |

## Interaction Modes

There are two user-facing modes:

| Mode | Code value | Behavior |
| --- | --- | --- |
| Companion | `companion` | Pause at key checkpoints for review, approval, or rejection. |
| Socratic | `socratic` | Intent Agent clarifies missing goals, then proceeds automatically when required fields are complete. |

Tasks also have a lower-level mode:

- review: human-review-oriented.
- autonomous: permits autonomous loops and candidate execution.

runFullPipeline requires autonomous mode; Companion advances through checkpoints without being fully automatic.

## Full Pipeline Stages

Research. Service.runFullPipeline(...) is the main orchestrator, with these stages:

```text
intent_gathering
  -> data_analysis
  -> searching
  -> reflection
  -> publishing
```

### 1. Intent Agent

Goals:

- Read the current task.
- Analyze user goals, domain, dataset, metrics, horizons, constraints, and interaction mode.
- Generate an intent_spec_markdown artifact.

Possible outcomes:

- Complete fields: continue.
- Missing fields: create protocol approval, pause the task, and await clarification.

Related states:

- task status: `intent_gathering`
- artifact: `intent_spec_markdown`
- blocker: `intent_clarification_required`

### 2. Dataset Preparation

TSF tasks may prepare Neo-Cast data before analysis:

- Build the dataset contract from taskSpec paths, targets, context length, and prediction lengths.
- Invoke the project runner to materialize data.
- Save dataset_preparation_json.

Runner dataset mismatch generally means prepared data differs from the task. Prepare again or clear the old dataset spec and rerun.

### 3. Data Analysis Agent

Goals:

- Invoke the domain fingerprint/profile.
- Analyze rows, targets, missingness, trends, seasonality, cross-correlation, distribution shift, outliers, and timestamp quality.
- Generate a unified analysis report.

Main artifacts:

- `task_profile_json`
- `dataset_quantitative_analysis_markdown`
- `dataset_qualitative_analysis_markdown`
- `dataset_main_analysis_markdown`
- `dataset_analysis_report`
- Optional plot artifacts.

In Companion mode, analysis completion triggers a human checkpoint:

```text
data_analysis_done
```

Confirm the analysis matches domain understanding before search-space confirmation and model search.

### 4. Search Space Checkpoint

Companion mode creates a search-space checkpoint before searching:

```text
search_space_confirmed
```

Contents:

- Search biases inferred from the dataset profile.
- Planned baseline recipes.
- A request to confirm the search direction.

Pending checkpoints leave the task paused.

### 5. NAS Agent / Autonomous Loop

NAS Agent invokes runAutonomousLoop(...), which calls runAutonomousIteration(...) each round.

One iteration performs:

1. Build the task fingerprint.
2. Merge Reflection Agent's reflectionHypotheses.
3. Seed baselines if no candidates exist.
4. Select an untried approved/auto_approved candidate.
5. If none is available, try an LLM proposal, then a domain proposal.
6. Validate new candidates through the domain.
7. Auto-approve low-risk autonomous candidates; request approval for high-risk or human-dependent decisions.
8. Execute the candidate with executeRun(...).
9. Verify successful runs containing the primary metric.
10. Analyst reads the primary metric and determines validity.
11. Librarian writes research memory.
12. Save candidate-selection and manager-trace artifacts.

NAS stopping conditions:

| Reason | Meaning |
| --- | --- |
| `max_iterations` | Maximum iterations reached. |
| `budget_exhausted` | Budget exhausted; approval required. |
| `approval_required` | Pending candidate, permission, or protocol approval. |
| `seed_failed` | Baseline generation failed. |
| `target_reached` | Objective reached. |
| `plateau` | Consecutive iterations without valid improvement. |
| `time_budget_exhausted` | Time budget exhausted. |
| `crash_streak_exceeded` | Consecutive failure limit reached. |

NAS Agent creates search artifacts:

- `nas_model_search_plan_md`
- `nas_experiment_log_md`
- `nas_leaderboard_md`
- `nas_evaluation_result_md`
- `nas_reflection_notes_md`
- `nas_search_space_yaml`
- `nas_best_model_config_yaml`
- `nas_best_model_py`
- `nas_training_script_py`

Companion mode also has post-NAS checkpoints:

- experiment_budget_extended: decide whether to extend the iteration budget.
- final_model_selection: confirm the champion or accept current results.

### Fixed-Design Inner Optimization

Full TSF searches persist an outer architecture design and its inner training trials.
HypoPlanner and ModelDesigner select a hypothesis and materialize a design once.
OptimizerAgent then uses same-design validation results, training curves and experience
 to propose complete training configurations. Preprocessing, structural dimensions,
branches, output heads, evaluation protocol and seed stay fixed. Compatible loss,
optimizer, learning rate, weight decay, scheduler, clipping, batch size and bounded
training duration may change. Every trial starts with newly initialized weights.

`maxTrialsPerDesign` defaults to 3, including the initial trial;
`maxNoImprovePerDesign` defaults to 2. Both may be supplied to the loop/pipeline API
or under `budget.loop`. Setting `maxTrialsPerDesign=1` disables iterative optimization.
The selected reference baseline is evaluated once before discovery begins.

The two loops share `maxIterations` (default 25). A full execution reserves one
iteration transactionally before dispatch, including failed attempts. Reopening a
search preserves consumed iterations and elapsed time. Verified cache hits refund
the reservation and do not create independent evidence or advance plateau counters.
Smoke checks do not consume full-training iterations and remain bounded by failure
and resource limits. Inner stopping returns to the outer planner; global plateau,
target and resource limits stop the research search.

The `research_design` and `research_training_trial` tables retain immutable recipes,
trial contracts, execution links, optimizer decisions and the best eligible full run.
Initial architecture comparisons keep the hypothesis contract. Later tuning trials
have their own named same-design comparisons; both contracts remain in run facts.
Tuning gains cannot be attributed to architecture changes.

Failed smoke and full attempts can also return to OptimizerAgent for a bounded
training-only repair. If no valid full control exists, the repair uses an
exploratory contract that pins the proposed training strategy and records its
failed source run (`repair_run_id`). It cannot establish a performance contrast.
Once a valid full result exists, subsequent tuning uses that design's best valid
full result as its control, even when the immediately preceding smoke failed.

`timeBudgetSeconds` binds a durable absolute `deadline_at` when the search first
starts (or when an existing cycle is upgraded). Queue waits, model reasoning,
runner initialization, smoke and full execution all share this deadline. The
runner process tree and direct LLM requests are canceled at expiry; final local
result persistence may finish afterward. Restarting the application preserves
the deadline, so downtime also uses the remaining wall-clock budget. Expired
queued workers cannot dispatch; unknown running owners still require reconciliation.

Design-scoped Reflection and HypoPlanner checkpoint accepted reasoning, artifacts
and final results in `phase_receipts`. Reflection completion advances the design
to planning in the same transaction. Applying a HypoPlanner plan, saving its
result and closing the design are also atomic. Recovery reuses committed results
without another model call, repeated plan application or duplicate artifact rows.
An interrupted request that never produced a saved response may need to be sent
again; remote model execution itself cannot be guaranteed exactly once.

Recovery exposes `activeDesignID`, `activeTrialID` and `loopPhase`. A terminal linked
run is replayed without launching training again or charging the budget twice.
Unconfirmed running processes and queued runs without a persisted plan require
reconciliation. Before the first full attempt, failed implementation repair may
create a new outer design while retaining the rejected design and smoke evidence.

### Scoped Reflection in the Dual Loop

In a full dual-loop TSF search, each completed trial, including failed smoke/full attempts, has
a `TrainingReflection` before OptimizerAgent decides the next training intervention.
It captures exact execution evidence, the named same-design training control or
failed repair source, comparison eligibility and separate phase/fold/horizon curve
summaries. Its interpretation is limited to training diagnosis and questions for
OptimizerAgent; it cannot return an architecture verdict or change a recipe.

When inner optimization finishes, `DesignSummary` records all trial outcomes and
the best eligible complete model separately from `architectureEvidence`. Architecture
evidence uses the original outer-contract trial and its named control, with matched
data, evaluation, training configuration and evaluated seed. The best tuned trial
is never substituted into that architectural comparison. Joint architecture/training
changes, failures, duplicate/cache results, smoke results and unmatched evaluations
cannot establish an isolated architecture effect.

`ArchitectureReflection` interprets that completed-design summary plus its training
reflections, then hands the summary and assessment to HypoPlanner. The coordinator
forces an inconclusive hypothesis assessment when architecture evidence is ineligible,
even if the model claims support. Both modes are invoked as ReflectionAgent with
separate prompts and strict output schemas; their sessions have no tool permissions.

The service exposes `runTrainingReflection`, `getDesignSummary` and
`runArchitectureReflection`. Existing `runReflectionAgent` callers can pass
`designID` and `reflectionScope=training|architecture` (plus `trialID` for training).
Design-scoped calls default to architecture mode. Calls without a design retain
the legacy task-level API. Legacy report fields remain available alongside the
typed results, with architectural change lists restricted to the named outer comparison.

Versioned `training-reflection:<trialID>:v2` and
`architecture-reflection:<designID>:v2` receipts retain facts, accepted reasoning,
artifact receipts and final results. `design-summary:v2` retains the design summary.
Old unscoped reflection receipts are preserved and do not satisfy these new stages.
Recovery reports `training_reflection` when a terminal trial awaits its diagnosis.
Both reasoning modes share the durable deadline and do not charge extra training
iterations. At expiry, local factual records and an inconclusive design assessment
are saved without another model call. Model execution whose response was never
saved can still require a retry after an interrupted request.

Scoped reflections may optionally return `experienceDrafts` (at most three); returning
none saves only the working reflection. Both session and direct modes use the same
validated delivery path below. The model never claims a successful memory write.

### Shared Memory Purposes and Delivery

The only memory purposes are `optimization` and `architecture`. Execution failures
belong to optimization observations; `execution` remains a claim type, not a third
purpose. Existing maturity levels and task/project/shared read scopes are independent.
New experiences retain their purpose and, for scoped writes, the committed reflection
origin (`reflectionKey`, design/trial, input digest and permitted source run IDs).
Purpose is assigned and checked by the writer, not accepted as a free model label.
Training-only contrasts cannot become architecture memory, and a joint training/design
change cannot establish an isolated performance claim of either purpose.

The shared SQLite library gains nullable `purpose` and `classification_version` columns
additively. Historical source JSON, IDs, facts and interpretations are not rewritten.
Classification is inferred only from factual contracts/interventions or execution
observations; ambiguous records remain unclassified. Unclassified is an audit state,
not another purpose. Exact reads remain available, but automatic role retrieval excludes
these records unless an exact-ID audit explicitly opts into `includeUnknown`.

Role filters run before ranking and limits: OptimizerAgent/training reflection read
optimization memory; HypoPlanner/ModelDesigner/architecture reflection normally read
architecture memory. A specific execution-error query from HypoPlanner or ModelDesigner
can retrieve optimization failure evidence for execution compatibility, not architecture
attribution. Changing a tool's requested purpose or requesting a known ID does not bypass
the role filter. Query deduplication, thread continuation and curation merges also
preserve purpose. OptimizerAgent derives its query from the current failure, training
question or changed fields rather than a fixed learning-rate query.

Scoped reflections can request up to three bounded `experience_request` lookups,
including exact-parent facts before continuation/promotion. Query responses are saved
in versioned stage receipts and both transports consume the same role-filtered results.
Lookups share the research deadline. No extra training iterations are charged.

Accepted reflection results and draft requests are committed atomically to the research
database's `research_memory_write` outbox. Preparation verifies that the original
reflection evidence has not changed, validates permitted run references, purpose and
parent provenance, then freezes the factual payload. The destination library path is
pinned when the proposal is enqueued. The shared library commits an idempotency receipt
with the source entry in its own transaction. Recovery can safely repeat delivery after
the library commit even when the research DB has not yet recorded success.

Outbox receipts expose `pending`, `prepared`, `applied` or `rejected`. Invalid evidence
is rejected without blocking the architectural decision; storage failures remain retryable.
Reopening/resuming the loop retries pending delivery without another model call or
training attempt. `Research.listExperienceWrites` and `Research.flushExperienceWrites`
provide status/retry access, and reflection completion events include the relevant write
receipts. Frozen prepared payloads retain the original observed facts across retries.
Legacy explicit `write_experience` calls continue to use the validated writer; the
automatic dual-loop path uses the outbox.

`read_experiences` supports `purpose` and exact-ID `includeUnknown` audit filters.
The standalone library CLI also accepts `research experiences --purpose optimization`
or `--purpose architecture`, with `--include-unknown` for deliberate legacy audits.

### 6. Runner Execution

The domain builds TSF run plans for Neo-Cast execution.

TSF runner conventions:

| Stage | Script | Typical metrics |
| --- | --- | --- |
| `smoke` | `py/validate.py smoke ...` | `val_avg_mse`, `val_avg_mae` |
| `low_fidelity` / `full` / `baseline` | `py/runner.py run ...` | `val_avg_mse`, `val_avg_mae` |
| `ref_test` | `py/runner.py ref-test` | `ref_test_avg_mse`, `ref_test_avg_mae` |
| `blind_test` | `py/runner.py blind-test` | `blind_test_avg_mse`, `blind_test_avg_mae` |

Runner root can come from:

- taskSpec.runtime.neoCastProjectRoot
- `NEO_RESEARCH_NEO_CAST_ROOT`
- `NEO_CAST_ROOT`
- Relative-path detection inside the package.

The TUI additionally checks:

- Runner-root existence.
- py/validate.py existence.
- Runtime Python existence and availability.
- Prepared dataset/task compatibility.

### 7. Verifier Agent

Successful runs with a primary metric enter verification.

Checks include:

- Metric validity.
- Horizon coverage.
- Baseline comparison.
- cost/performance.
- Overfitting risk.
- Data leakage risk.

Verifier creates:

- `evaluation_result_md`
- `verifier_decision_json`

Rejected runs receive rejected status, a failure explanation, and recovery guidance.

### 8. Reflection Agent

After NAS, Reflection Agent reviews:

- Effective changes.
- Ineffective changes.
- Failure categories and recovery actions.
- Whether to continue, stop, or request human review.
- Hypotheses for the next experiment.

Main artifacts:

- `reflection_notes_md`
- `next_experiment_plan_md`
- `failure_log_md`

A request_human decision creates protocol approval and pauses the pipeline.

### 9. Publish Agent

Publish Agent exports:

- model_export_package by default.
- research_final_bundle and research_report_markdown are also supported.

A model package generally contains:

- `report/research-report.md`
- `reports/final_report.md`
- `results/runs.json`
- `results/candidates.json`
- `results/champion.json`
- `results/artifacts.json`
- `results/approvals.json`
- `results/memory.json`
- `configs/search_space.yaml`
- `configs/best_model_config.yaml`
- `experiments/*`
- `model/*`
- `manifest.json`

Successful publication sets task status to completed.

Companion mode has a final pre-publication checkpoint:

```text
report_release
```

## Immediate Execution and Queue Worker

There are two execution paths:

| Path | Use | Behavior |
| --- | --- | --- |
| `executeRun(...)` | Local development, immediate TUI execution, deterministic tests. | Write plans, invoke subprocesses, and parse outputs in the OpenCode process. |
| `prepareRun(...)` plus worker | Production-style queue prototype. | Create a queued run and plan artifact, enqueue a file-runtime job, and consume it with worker-once/worker-loop. |

Both share DomainRunPlan, allowing a later production queue/object-store replacement without rewriting the domain.

## Recovery and Repeated Execution

runFullPipeline records completed stages in taskSpec workflow metadata:

```text
completedPhases: data_analysis / searching / reflection / publishing
lastCheckpoint: ...
```

When rerun:

- Restore completed data_analysis from dataset_analysis_report.
- Restore completed searching from research_autonomous_loop_json.
- Restore reflection from its artifacts.
- Restore publishing from its export artifact.

updateTaskSpec(...) clears workflow progress so old profiles, search, and exports are not reused incorrectly with changed specifications.

## State Transitions

Common task statuses:

```text
created
  -> intent_gathering
  -> data_analysis
  -> searching
  -> publishing
  -> completed
```

Possible interrupted states:

| Status | Meaning |
| --- | --- |
| `paused` | Awaiting approval, clarification, or configuration repair. |
| `failed` | A stage failed. |
| `researching` | Research is in progress. |
| `idle` | No active execution. |

Common run statuses:

```text
queued -> running -> succeeded
queued -> running -> failed
queued -> running -> rejected
```

## Common Blockers

| Blocker | Symptom | Action |
| --- | --- | --- |
| Incomplete intent | intent_clarification_required; task paused. | Answer Intent Agent questions and complete slots. |
| Missing runner root | Runner root missing. | Use Project Runner or set taskSpec.runtime.neoCastProjectRoot. |
| Missing py/validate.py | Runner script missing. | Point runner root to Neo-Cast. |
| Missing runtime Python | Runner Python missing. | Initialize runtime under runner root. |
| Dataset mismatch | Runner dataset mismatch. | Prepare a dataset matching taskSpec. |
| Candidate approval | Loop stops at approval_required. | Approve or reject the candidate. |
| Reference/blind-test permission | ref_test/blind_test requires a gate. | Request and approve the corresponding permission. |
| Exhausted budget | budget_exhausted. | Approve or adjust the budget. |
| Verifier rejection | Run becomes rejected. | Inspect verifier_decision_json and follow recovery guidance. |
| Reflection requests review | reflection_requested_human_review. | Read notes and decide to continue, stop, or adjust the task. |

## Current Boundaries

Implemented:

- TSF domain plugin.
- TUI, CLI, and HTTP entrypoints.
- Multi-agent pipeline.
- Neo-Cast subprocess integration.
- Local file-runtime queue prototype.
- Data analysis, NAS, verifier, reflection, and publication artifacts.
- Workflow metadata recovery.
- Approvals and checkpoints.

Local-alpha limitations:

- Production queues, object storage, and metrics storage still use the local driver.
- Long-task supervisors, distributed workers, and lease recovery remain future work.
- Runner environment, prepared data, and model APIs depend on local configuration.
- Some TUI actions are immediate API calls intended for local research rather than multi-user scheduling.

## Recommended Sequence

For a new TSF task:

1. Create the task and confirm dataset, targets, context, horizon, and metric.
2. Configure or repair runner root.
3. Prepare the dataset and verify it matches taskSpec.
4. Run Data Analysis and inspect the profile.
5. In Companion mode, approve analysis and search-space checkpoints.
6. Start Agent Loop or the full pipeline.
7. Inspect the NAS leaderboard, verifier decision, and champion.
8. Approve final model selection.
9. Run Publish Agent / Export Bundle.
10. Inspect manifest.json, the final report, and model package.


### TUI Dual-Loop Progress

The cockpit reads `GET /research/tasks/:taskID/loop-state` for a transactionally
consistent snapshot of the active cycle, ordered designs/trials, ranking eligibility,
scoped reflection receipts, memory delivery receipts and recovery position. Reading
this endpoint never initializes a cycle, reserves training, runs models or flushes
memory. Task/project authorization is checked before any history is returned.

The panel distinguishes reserved full-training attempts from the task's run-record
budget and per-design trial limits. Failed full attempts stay charged; failed smoke
attempts still appear as trials without a full-training charge. Epochs, folds and
horizons are not counted separately. The deadline comes from the persisted cycle and
continues counting down while the TUI is closed or the task is paused.

Use `/loop-status` (or the Design / Trial history link) to inspect all designs in the
current cycle, training changes, earlier best runs, failures, cached/excluded results,
training/architecture diagnoses and actual memory write statuses. The main panel shows
the active design, or the last completed design, and its last three trials. Selecting
a trial expands its details. Current training, training-result finalization, training
reflection, optimization, architecture reflection and outer planning/design are
projected from persisted executions and receipts, not historical candidate counts.

Optimizer stage events include design/trial/cycle identity, the validated decision,
rationale and duration. Scoped reflection streams carry their scope and design/trial
identity, and the cockpit retains them separately. Live events refresh the snapshot;
periodic reads and reopening the TUI recover the same state after disconnects. Legacy
non-dual-loop workflows retain their existing presentation. Configuration and additional
loop-control actions are a separate implementation phase.
