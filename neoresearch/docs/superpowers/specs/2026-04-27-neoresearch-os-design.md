# NeoResearch OS on NeoResearch Fork: Design description

Date: 2026-04-27

## 1. Background

The target is fork NeoResearch directly and re-constructs it from a generic coding agent product to a common Research OS. The first version has TSF / Neo-Cast as the first domain pugin, but the structure needs to maintain clear boundaries for subsequent access to other scientific fields.

Neo-Cast now has candidate driver runtime, CandidateRecipe, TSF data protocol, training assessment, runner, export. NeoResearch has a mature foundation for provider, server, eventbus, session, TUI/Web, mission, tool reporting, plugin/MCP. NeoResearch should revert to NeoResearch's anent runtime capital, but switch the default product object from coding session to research desk.

## 2. Design objectives

- Change NeoResearch fork to a Research-first product instead of adding a small function to the original product.
- Keep TUI + Web + CLI + Server API, with all access points sharing the same set of research procedures/ run / event / description API.
- Web default is Research Dashboard, TUI default is Research Cockpit.
- Two modes of interaction are supported:
  - Review Mode: Agent presented a candidate and pilot project, which was approved by Human and implemented.
  - Autonomous Mode: Upon the approval of mandates and budgets by Human, Agent is autonomous within the budget, requesting approval for key nodes.
- The first version of the built-in TSF domain plugin runs through CandidateRecipe - smoke/full track - mittics - champion - curmory - à autofact.
- Keeps NeoResearch original coding skills as debug/admin, but no longer as default master experience.

## 3. Non-target

- v0.1 does not seek to support all fields of scientific research, but only requires that domain pugin be abstracted and stable enough.
- v0.1 does not seek full replacement of NeoResearch all old session/UI codes, which can be hidden or downgraded first.
- v0.1 does not write essays Agent, open literature review Agent or production deployment platform.
- v0.1 does not require the governance of multi-tenant enterprises, but only preserves future scalable competencies and audit boundaries.

## 4. NeoResearch Adaptation of Borders

Retain and reuse:

- `provider`: Model provider, certification, model configuration.
- `server`: Unify HTTP/API and event stream.
- `bus/event`: Run-state event broadcast.
- `permission`: as a bottom-up mechanism for research applications.
- `storage/session`: Moves to a permanent layer of research task / run / memory.
- `TUI/Web`: Retain the technical basis for rendering and subscription events, and redo the information architecture.
- `plugin/MCP`: Follow-up for domain plugin and extension tool.

Weakened or relocated:

- `bash/read/edit/write/apply_patch` etc. is no longer the main entrance but only enabled in debug/admin anent.
- The original chat-to-edit-code experience is moving into legacy/debug namespace.
- The original coding program and agent mode are no longer used as the default start path.

New Core Catalogue Proposal:

```text
packages/neoresearch/src/research/
  task/
  run/
  domain/
  candidate/
  evaluator/
  memory/
  artifact/
  approval/
  orchestrator/
  event/
```

The product default path switch to NeoResearch. The old NeoResearch working session can be kept in hidden commands or debug mode to avoid unnecessary risks arising from the first phase of large-scale deletion.

## 5. Core data model

The core of NeoResearch business is no longer `Session -> Message -> Part`, but:

```text
ResearchTask
  -> ResearchRun
  -> Candidate
  -> Evaluation
  -> Champion
  -> Artifact
  -> MemoryItem
```

NeoResearch session still serves as an interactive container for users and Agent:

```text
ResearchSession = interactive, log and event stream around a ResearchTask
ResearchTask = scientific mission entity that can operate, assess and reproduce independently
```

Core entity:

```ts
type ResearchTask = {
  id: string
  title: string
  domainId: string
  taskSpec: unknown
  objective: ResearchObjective
  mode: "review" | "autonomous"
  status: "created" | "profiling" | "baselining" | "researching" | "paused" | "completed" | "failed"
  budget: ResearchBudget
  createdAt: string
  updatedAt: string
}

type Candidate = {
  id: string
  taskId: string
  parentCandidateId?: string
  domainId: string
  candidateSpec: unknown
  rationale: string
  riskLevel: "low" | "medium" | "high"
  approvalStatus: "pending" | "approved" | "auto_approved" | "rejected"
  generatedBy: "llm" | "heuristic" | "mutation" | "human"
}

type ResearchRun = {
  id: string
  taskId: string
  candidateId: string
  stage: "profile" | "baseline" | "smoke" | "low_fidelity" | "full" | "ref_test"
  status: "queued" | "running" | "succeeded" | "failed" | "rejected"
  metrics: Record<string, unknown>
  resourceUsage: Record<string, unknown>
  artifactRefs: string[]
}

type Champion = {
  taskId: string
  candidateId: string
  runId: string
  primaryMetric: number
  utility: number
  acceptedAt: string
}

type MemoryItem = {
  id: string
  taskId: string
  domainId: string
  fingerprintSummary: Record<string, unknown>
  candidateSummary: Record<string, unknown>
  outcome: "accepted" | "rejected" | "failed"
  lesson: string
}
```

Research state has to deduce from these entities, not rely on chat history.

## 6. Domain Plugin Abstract

NeoResearch is the generic Research OS, domain pugin field-specific logic. Release 1 is built into TSF only, but interfaces are designed in a generic format.

```ts
interface ResearchDomain {
  id: string
  displayName: string
  schemas: DomainSchemas
  createTask(input: unknown): Promise<TaskSpec>
  profileTask(task: ResearchTask): Promise<TaskFingerprint>
  buildBaselines(task: ResearchTask): Promise<Candidate[]>
  proposeCandidates(input: ProposalInput): Promise<Candidate[]>
  validateCandidate(candidate: Candidate): Promise<ValidationResult>
  runCandidate(input: RunInput): Promise<RunResult>
  evaluateRun(input: EvaluationInput): Promise<EvaluationResult>
  compareChampion(input: ChampionInput): Promise<ChampionDecision>
  writeMemory(input: MemoryInput): Promise<MemoryItem>
  exportArtifact(input: ArtifactInput): Promise<ArtifactRef>
}
```

TSF domain plugin corresponds to Neo-Cast:

- `TaskSpec`: Data set, horizons, context length, target column, budget, evaluation protocol.
- `CandidateSpec`:CandidateRecipe.
- `Evaluator`:val/ref-test MSE/MAE,utility,Pareto.
- `ArtifactExporter`: Model checkpoint, metadata, preprocess, reference, MCP forecast tool.

Domain pugin does not directly control UI. UI only consumes uniform search API and domain-proved schema metadata.

## 7. Two modes of operation

### Review Mode

Process:

```text
Task created
-> Domain profiler
-> Baseline
-> Agent proposes Candidate
-> Human reviews candidate and run plan
-> Approved candidate enters smoke/full run
-> Evaluation updates champion and memory
-> Agent proposes next candidate
```

Review Mode is suited to early missions, high-risk experiments, budget sensitive scenarios. TUI/Web needs to clearly show candidate diff, estimated cost, risk cause and approval buttons.

### Autonomous Mode

Process:

```text
Human approves task + budget + policy
-> Agent loops within budget
-> Low-risk candidates auto-approved
-> Smoke/full run
-> Evaluation and champion update
-> Memory update
-> Stop on budget, convergence, crash streak, or human stop
```

Autonomous Mode's approval strategy:

- Ref-test/blind-test query must be manually approved.
- Overbudgeting, the use of new domain action and amendments to assessment protocols require manual approval.
- Low-risk candidates can be automatically approved.
- The continuous crash reaches the threshold automatically suspends.

## 8. Research Orchestrator

NeoResearch old SessionPrompt/ SessionProcessor handles LLM stread and tool call. NeoResearch needs to add a new ResearchOrchestrator to handle research loop.

Core cycle:

```text
load task state
load task/domain memory
ask domain proposer or LLM proposer for candidates
validate candidate
apply approval policy
run smoke
run full if smoke passes
evaluate metrics
compare champion
write memory
emit events
repeat until stop condition
```

Orchestra output structured ResearchEvent instead of relying on any text:

- `task.created`
- `task.profiled`
- `candidate.proposed`
- `approval.requested`
- `run.started`
- `run.metric`
- `run.finished`
- `champion.updated`
- `memory.written`
- `artifact.exported`
- `task.paused`
- `task.completed`

NeoResearch may continue to carry these events.

## 9. TUI and Web

### TUI:Research Cockpit

TUI default for real-time operations:

- Current task status.
- Agent's current step.
- candidates.
- Requests for approval.
- The latest run logs and indicators.
- Current Campion.
- Stop /pause / approve / project operation.

TUI is not a complete analytical platform, focusing on rapid monitoring and intervention.

### Web:Research Dashboard

Web default for overview and analysis:

- Task list.
- Just ask dashboard.
- Runs table.
- Metrics trend.
- Champion / Challenger comparison.
- Candidate lineage.
- Artifact browser.
- Memory / lessons.

Web does not directly call domain runner by reading status via the same server API and event stage.

## 10. TSF v0.1 Vertical Slice

The first version of `domainId = "tsf"`, which is built in, aims to run through the complete autonomous research closed loop.

TSF v0.1 capability:

- Create TSF ResearchTask.
- Bind local CSV or existing Neo-Cast dataset contract.
- Generate TaskFingerprint.
- Run NLinear baseline.
- Let Agent generate CandidateRecipe.
- Support for Review / Autonomous Mode.
- Run smoke/full track.
- Record val metrics.
- Update.
- Write memory.
- Export artifact.

CandidateRecipe for TSF v0.1

- preprocessing:`none`, `instance_norm`, `series_decomposition`
- embedding:`none`, `patch`, `multiscale_patch`
- backbone:`linear`, `mlp`, `transformer`, `dlinear`, `tcn`
- fusion:`temporal`
- head:`linear`
- loss:`mse`, `huber`
- optimizer:`adam`, `adamw`

You can move from the existing Python runtime to the Neo-Cast or call as a subprocess before gradually constricting to NeoResearch fork internal domain runner.

## 11. Storage and API

v0.1 uses NeoResearch for existing storage/sql infrastructure, adding new research data:

- `research_task`
- `research_candidate`
- `research_run`
- `research_metric`
- `research_artifact`
- `research_memory`
- `research_approval`

Server API recommends:

```text
POST   /research/tasks
GET    /research/tasks
GET    /research/tasks/:id
POST   /research/tasks/:id/start
POST   /research/tasks/:id/pause
POST   /research/tasks/:id/stop
GET    /research/tasks/:id/runs
GET    /research/tasks/:id/candidates
POST   /research/approvals/:id/reply
GET    /research/tasks/:id/artifacts
GET    /research/events?taskId=...
```

The old session API can be retained, but Web/TUI defaults to use a research API.

## 12. Relationship to NeoResearchTool / Mission

NeoResearch should not let LLM default to own coding tools. The default Agent capability should read:

- `propose_candidate`
- `validate_candidate`
- `run_experiment`
- `evaluate_run`
- `write_memory`
- `export_artifact`
- `ask_approval`

These can be achieved as ResearchTool or directly by Orchestra service method. Universal working tables are enabled only under debug/admin Mode.

ApprovalPolicy:

```text
tool permission -> research action permission
ask/allow/deny -> approve/auto_approve/reject
```

This allows NeoResearch to interact with UI, but the semantics are more relevant to the research process.

## 13. Steps for relocation

5 is recommended to be advanced in stages.

### Stage 1:Research data model and API skeleton

- Adds a `src/research` module.
- Add a new search story scheme.
- Add task/run/candidate/artifact/memory service.
- Add a new server routes.
- Web/TUI can show the mock research task.

### Stage 2:TSF domain plugin adapter

- Accesses Neo-Cast runtime, allowing a subprocess to call first.
- Fulfill TSF TaskSpec, CandidateRecipe schema, runner adapter.
- Run through baseline and a full run.

### Stage 3:Review Mode

- Agent creates a candidate.
- UI shows candidate and run plan.
- Human approve/reject.
- Execute smoke/full/eval after approval.

### Stage 4:Autonomous Mode

- Add Bridget policy.
- Add autonomous loop.
- Add crash streak, bugged exhausted, no improvement stop condition.
- Write memory.

### Stage 5:Research-first UX

- TUI Default Cockpit.
- Web default Dashboard.
- The old coding mode hides to debug/legacy company.
- Perfecting artific Browner and Campion lineage.

## 14. Test Policy

Unit testing:

- ResearchTask status transition.
- ApprovalPolicy.
- DomainPlugin contract.
- TSF CandidateRecipe validation.
- Champion decision.

Integrated testing:

- Creates TSF task.
- baseline run.
- Review Mode application followed by run.
- Autonomous Mode completes at least one round of propose/run/evaluate/memory in a small budget.
- artifact export.

End-to-end test:

- CLI creates tasks and starts them.
- TUI receives approval event.
- Web Dashboard displays run and champion.

Return test:

- Provider config still works.
- Server event still can be consumed by TUI/Web.
- Debug coding tools does not affect research default mode.

## 15. Risk and control

Main risks:

- The NeoResearch original session/chat logic is mixed with the research task logic.
- The first edition, which also maintains TUI/Web/Agent loop, is broad in scope.
- The TSF runtime process boundary with TypeScript server may be complex.
- At an early stage, Autonomous Mode may have wasted the budget or repeatedly generated low-quality candidates.

Control mode:

- ResearchTask became the only source of business status, and the Board only made interactive packagings.
- Use TSF subprocesses first to avoid one-time rewrite training runtime.
- Review Mode landed first, Autonomous Mode returns to the same approximation policy.
- All autonomous loop must have buttons, crash streak and stop condition.
- The old coding tools is closed by default, only opened in debug/admin mode.

## 16. Criteria for success

v0.1 success criteria:

- Can create TSF ResearchTask in NeoResearch fork.
- Web dashboard can show yask, runs, metrics, champion, artifact.
- TUI cockpit can show the current anggent loop, run event, program prompt.
- Human-approved candidate run.
- Autonomous Mode can complete multiple rounds of propose/run/evaluate/memory within budget.
- TSF analysis can be exported and include metada, model, preprocess, eval report.
- The old coding agent is no longer the default product entry but retains debug/admin usability.

