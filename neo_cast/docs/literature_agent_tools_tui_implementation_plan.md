# LiteratureAgent Tools and TUI Integration Plan

Status: stages A/B/C implemented; direct remains the default until real-provider/PDF integration acceptance. Optional stage three is not implemented.

Scope: Research pipeline, session tools, and Research Cockpit TUI in opencode/packages/opencode.

Prerequisite: [RetrieveAgent to HypoPlanner evidence bridge](./retrieve_hypoplanner_bridge_implementation_plan.md).

## 1. Goals and Boundaries

Integrate the Literature phase of DataAnalysisAgent -> LiteratureAgent -> HypoPlanner with an OpenCode child session so the TUI displays retrieval, paper processing, evidence assembly, and failure/fallback states. Tools are auditable execution entrypoints; authoritative KnowledgeCard and TaskEvidenceBundle validation rules remain unchanged.

Acceptance requirements:

1. Keep one external literature phase; Retrieve(pre) -> Literature(core) -> Retrieve(post) are internal steps.
2. Give Literature its own child session. Tool calls create message/tool parts for live display and replay of key results after restart.
3. Produce compatible retrieve_result_v2, task_evidence_bundle_v1, KnowledgeCard, and provenance. HypoPlanner consumes validated Evidence Bundles only.
4. Preserve existing fallback for missing PDFs/candidates, individual paper failures, and unconfigured LLMs; schema, cache, or KnowledgeStore corruption remains a hard failure.
5. Do not add online paper search, arbitrary paths, automatic PDF downloads, direct model writes to KnowledgeStore, model-controlled budget expansion, or model declarations of paper_backed evidence.

Root-session integration means a navigable Literature child session and visible cockpit tool trace. Full papers and tool outputs are not copied into root assistant messages.

## 2. Current Implementation and Integration Points

- research/service.ts runFullPipeline executes data_analysis -> literature -> hypo_planning. runRetrieveAgent directly constructs RetrieveAgent, registers two artifacts, and publishes RetrieveAgentStarted/Completed/Failed.
- retrieve/retrieve-agent.ts directly handles concept mapping, BM25, selection, LiteratureAgent.run(), and task evidence. literature/extraction-model.ts directly requests extraction/verification from the LLM.
- requestViaSession creates child sessions and forwards text/tool parts but returns only final text; tool-only execution may be treated as no result.
- tool/registry.ts and agent/agent.ts provide Tool.define, allowlists, and hidden research agents; hypothesis-store.ts resolves child-session ownership.
- TUI handles DataAnalysis/HypoPlanner Part/Delta streams and workflow nodes, but lacks Literature nodes and dedicated Retrieve display events.
- literature/README.md still describes standalone-only operation and must be updated to match current service integration.

These sources are changing; verify current interfaces and preserve unrelated work before implementation.

## 3. Tool Boundaries and Recommended Set

Use hybrid orchestration: the service owns phases, tools perform bounded actions, and deterministic code decides validity. Inputs expose task-local identifiers rather than arbitrary taskID, neoCastRoot, PDF paths, or KnowledgeStore paths.

| Tool | Input | Summary | Side effect | Stage |
| --- | --- | --- | --- | --- |
| literature_run | None; server-controlled force=false if needed | retrieveRunID, cache hit, paper/card counts, readiness, gaps/failures, artifact identifiers | Execute the existing Literature phase | Required stage one |
| literature_list_intents | None | intentID, question, priority, mustCover, query, budget | None | Stage two |
| literature_search | intentID and server-bounded topK | Candidates, BM25 rank/score, matched fields, PDF availability, rationale | None | Stage two |
| literature_read_paper | Selected paperID; optional section/chunk cursor and page size | Bounded excerpts with chunkID/page and parse warnings | May populate parsing cache; no card writes | Stage two |
| literature_get_results | Completed retrieveRunID or current run; pagination | Paper states, card IDs/claims, exclusions, gaps/conflicts, review IDs | None | Stage two |
| literature_process_papers | Server-approved paperID[] | Per-paper runID, state, card count, errors | Parse, extract, verify, and write KnowledgeStore | Optional stage three |
| literature_finalize | Current run ID | Schema/provenance-validated Evidence Bundle summary | Assemble and persist task evidence | Optional stage three |

In stage one, **literature_run is the only write entrypoint**, preserving retrieval results and cache identity. Stage-two exploration tools provide visible search and reading without bypassing selection. Split processing/finalization only after both stages pass acceptance, with server-enforced completion so early agent termination cannot omit must-cover intents.

Do not expose BM25 internals, claim-schema checks, exact-span validation, deduplication, card transactions, or bundle adjudication as separate tools. Extraction/verification LLM requests remain internal to literature_run: **one outer tool call does not turn every internal model request into a tool part**. Fine-grained model traces require a separate session extraction adapter compatible with caches, prompt versions, and call records.

## 4. Execution Architecture

```text
Research Service (phase ownership, state/recovery, artifact registration)
  ├─ Create Literature child session bound to task and quantitative report snapshot
  ├─ SessionPrompt(research-literature)
  │    └─ literature_run tool
  │         └─ Shared LiteraturePhaseExecutor
  │              └─ RetrieveAgent → LiteratureAgent → Evidence Bundle
  ├─ Read and validate receipt, retrieve_result_v2, and bundle provenance
  ├─ Register/refresh the two artifacts and workflow.literature
  └─ Pass taskEvidenceArtifactID to HypoPlanner
```

### 4.1 Shared Execution without Dependency Cycles

Do not make tool/research-literature.ts depend on Research. Service: the service depends on SessionPrompt, which depends on ToolRegistry. Extract root resolution, model construction, RetrieveAgent execution, and cleanup from runRetrieveAgent into research/literature-phase-executor.ts without SessionPrompt/ToolRegistry dependencies. Service and tools share it; the service retains artifacts, workflow, and phase events.

Resolve task ownership through ctx.sessionID, require research-literature, and read the bound report artifact ID/digest and budget snapshot. Inputs cannot override them. Use service-managed context. After restart, validate persisted results through workflow recovery rather than restoring partial LLM conversations. Persistent bindings must keep sessionID/taskID/artifactID consistent and prevent cross-task reuse.

### 4.2 Tool Receipts rather than Final Text

Add a dedicated runner subscribing to child MessageV2. Event. PartUpdated/PartDelta. Parse a structured receipt from **completed literature_run tool parts**, including schemaVersion, taskID, quantitativeReportArtifactID, retrieveRunID, and resultDigest. Do not rely on final natural language or requestViaSession's no-text/undefined rule. Forward parts/deltas through LiteratureAgentStreamDelta/PartUpdated scoped by taskID; direct execution emits phase/progress events only.

The service rereads persisted RetrieveResultSchema/TaskEvidenceBundleSchema and checks receipt, task, report, task-context digest, run ID, and contents before artifact registration. Tool output locates results and reports progress; it is not evidence authority. Use direct fallback only if the session/provider is unavailable or the tool demonstrably never started. For uncertain started execution, reconcile cache/KnowledgeStore by runDigest before retrying. Receipt mismatch or schema/provenance corruption is a hard failure, never ready_data_only or silent fallback. Distinguish successful tools with failed final replies from tools never executed to avoid duplicate cost.

### 4.3 Cache, Concurrency, and Forced Reruns

Keep retrieveRunID and Literature inputDigest unchanged; sessionID, toolCallID, and display text must not enter cache identity. Identical task/report/index/budget calls return the same validated result. Deduplicate or lock by runDigest to prevent KnowledgeStore races. LLMs cannot set force; server recovery or explicit human action may, while refreshing the same artifact registration and readiness metadata.

### 4.4 Permissions and Untrusted Input

- Register hidden research-literature with literature tools and necessary read-only tools only; deny shell, writes, task edits, and general web search by default.
- Validate session/task ownership, phase, allowed intentID/paperID, top-K, and per-paper budgets. Reject arbitrary local paths.
- Treat PDF text as untrusted data and retain injection defenses. Filter secrets, complete prompts, long PDF bodies, and internal paths. Paginate/truncate outputs while keeping complete audit artifacts.
- If implemented, literature_process_papers accepts only admitted, deduplicated candidates. Tool parameters cannot disable exact spans, includeAgentInference=false, card verification, or transactions.

## 5. Events, Root Session, and TUI Contract

Label the external phase LiteratureAgent; retain RetrieveAgent events as internal substages for compatibility. Add phase and optional per-paper progress events with compact structured summaries, without full text:

```ts
research.agent.literature.started   { taskID, phase: "literature", sessionID?, runID? }
research.agent.literature.progress  { taskID, runID?, step, paperID?, status, counts?, cached? }
research.agent.literature.stream.delta / part.updated { taskID, agent, delta or part fields }
research.agent.literature.completed { taskID, retrieveRunID, resultArtifactID, taskEvidenceArtifactID,
                                      readiness, summary, callPath: "session_tool" | "direct" }
research.agent.literature.failed    { taskID, step?, paperID?, code, message, recoverable }
```

progress.step is prepare_intents | search | select | parse | extract | verify | assemble_evidence. Emit only real steps; mark cache hits separately. Order: started -> progress -> completed/failed -> HypoPlanner started. Individual paper failures are warnings and bundle gaps; only global corruption fails the whole phase.

Cockpit changes:

1. Insert LiteratureAgent between DataAnalysis and HypoPlanner. Completion requires a valid task_evidence_bundle_json/workflow phase; activity follows phase events or literature status. Existing cards alone do not establish completion. ready_data_only is successful with zero evidence and explicit gaps.
2. Update researchAgentWorkflowOrder, researchAgentFullStageOrder, and live overlay so events select the right sidebar agent. Do not skip unfinished Literature after analysis. Existing /pipeline hypo-planning may drive the whole pipeline without a new command.
3. Consume Literature stage/progress and child Part/Delta in research-cockpit.tsx. Show intents/candidates, current paper, tool name/state/timing, cards, and gaps. Support live text/tool parts without dumping JSON or full papers into the scrollback.
4. Persist compact completion summaries in stream.log and bounded memory. On reopening, recover from artifact metadata/reports rather than SSE alone. Deduplicate by taskID + retrieveRunID + step/paperID and filter old-task events on switching.
5. Allow navigation from the root session to Literature. Do not duplicate calls/results in root messages. Without a model, use direct execution while showing phase events/summaries and direct or llm_not_configured labels.

Suggested rendering:

```text
[LiteratureAgent] Searching · 6 intents / 24 candidates
  ✓ literature_search · 24 candidates · 82 ms
  ● paper-123 · parse/extract/verify
  ⚠ paper-456 · local PDF unavailable
[LiteratureAgent] Complete · 2 papers / 5 cards / 3 selected / 1 gap · partial_evidence
```

## 6. Implementation Stages and Files

### Stage A: Minimal Tools with Identical Results

1. Extract reusable execution into src/research/literature-phase-executor.ts; direct execution uses the same executor.
2. Add literature_run in src/tool/research-literature.ts; register it in tool/registry.ts and the minimally privileged research-literature agent in agent/agent.ts; add agent/prompt/research-literature.txt.
3. Add the dedicated session runner and completed-part receipt recovery. Service validation/registration precedes workflow updates. Retain direct execution when session/provider is unavailable.
4. Add started/completed/failed events and callPath without immediately removing RetrieveAgent events.

Acceptance: equivalent offline-fixture bundles across paths; empty catalogs yield ready_data_only; tool-only success with empty final text remains successful; repeated calls/recovery create no duplicate cards or artifacts.

### Stage B: Search and Reading Tools

1. Add literature_list_intents/search/read_paper/get_results using current intents, indexes, BM25, parsing caches, and schemas. list/search share the quantitative-report/index snapshot with the final run, even when called first. Index changes rebuild the snapshot rather than mixing results.
2. Add bounded step/paper progress, return sizes, pagination, and budgets. literature_run remains the only final write entrypoint.
3. If session-controlled paper ordering is needed, trial process_papers/finalize. The server must require final dispositions for every selected candidate and the same schema/provenance validation. This optional work does not block TUI integration.

Acceptance: reject or safely deduplicate invalid identifiers, unauthorized sessions, excessive budgets, arbitrary paths, and repeated/concurrent calls. Model arguments cannot lower evidence thresholds.

### Stage C: TUI and Documentation

1. Update nodes, live overlays, event handling, summaries, and replay in research-cockpit-data.ts and research-cockpit.tsx.
2. Update event.ts, API response documentation, and literature/README.md; describe session_tool/direct paths.
3. Add cockpit rendering tests for started/progress/completed/failed, task switching, cache hits, reopening, and ready_data_only.

Acceptance: DataAnalysis -> LiteratureAgent -> HypoPlanner order; visible child-session tool states; persisted completion/summaries after reopening; bounded progress without duplicated rows.

## 7. Regression Tests and Completion Criteria

| Layer | Required cases |
| --- | --- |
| Tool units | Ownership, schemas, permissions, pagination/budgets, receipts, cancellation/timeouts, sensitive-output truncation |
| Literature/Retrieve units | Unchanged ranking/selection, paper failures, missing PDFs/LLMs, cache hits, concurrent deduplication, force/recovery |
| Service integration | Equivalent paths, tool-only replies, once-only exceptional execution, artifact/readiness updates, invalid bundle rejection |
| TUI | Event order, node states, paper progress, replay, task switching, duplicate events, long-stream bounds |
| E2E | Companion checkpoint followed by DataAnalysis -> Literature -> HypoPlanner with literature and data-only paths |

Run package-scoped Bun tests and bun typecheck in opencode/packages/opencode; do not run npm test at the opencode root. Retain direct fallback until real-task caching, recovery, and replay pass. No database/artifact schema change is required for this plan; evaluate migration/versioning separately if optional stage-three state is persisted.

## 8. Implementation and Validation Record

Implemented the shared executor, five restricted tools, hidden research-literature agent, dedicated receipt recovery,
service persistence validation/artifact refresh, cockpit node/progress/replay, and /literature-session navigation.
Phase/artifact registration is serialized per task; KnowledgeStore writes are serialized within the service process. Repeated calls
share one Promise. Cancellation/timeouts stop at the next progress boundary; an in-flight internal model request may finish first.

Enable with runtime.literatureSessionTools=true in taskSpec. Direct remains the default;
fallback is allowed without an available model or before tools start. Started work reconciles the original Promise and persisted results.
Tools expose no task/path/force arguments. Optional process/finalize is not implemented.
See [Literature README](../../opencode/packages/opencode/src/research/literature/README.md) for user instructions and event envelopes.

Validation commands (Bun commands run in opencode/packages/opencode):

```bash
bun run typecheck
bun test test/research/literature-session.test.ts test/research/literature-tools.test.ts \
  test/research/literature-phase.test.ts test/research/literature-pipeline.test.ts \
  test/research/retrieve test/research/literature \
  test/cli/tui/research-cockpit-data.test.ts test/cli/tui/research-literature-state.test.ts --timeout 30000
bun test test/cli/tui/research-cockpit-render.test.tsx \
  --test-name-pattern 'Literature|renders the prompt agent label|tab cycles' --timeout 30000
bun test test/agent/agent.test.ts test/tool/registry.test.ts test/research/domain-registry.test.ts --timeout 30000
# Run in neo_cast:
npm test
```

Core regression, Literature rendering, agent/tool registration and permissions, typechecks, and Neo-Cast Node/Python tests passed.
Broader checks found six preexisting cockpit rendering failures (onboarding/old text/switch assertions) and eight preexisting TSF-domain failures
(baseline fixtures differ from the current baseline set), reproduced against an independent unmodified HEAD copy.
Real-provider/PDF session_tool integration has not been tested; the tool path therefore remains opt-in.
