# HypoPlanner Assumptions Pool Tool Scheme

> Status: Proposal / Not achieved. This document only describes the design, and the code has not been changed.

## 1. Background and objectives

Currently `research-hypo-planner` anent can only output text in session mode by
`parseLLMHypotheses()` ex post parse, then pass `updateTaskHypothesisPlan()`
(service.ts:3971-4037) Delete and recreate `ResearchHypothesisTable` as a whole.

Question

- There is no atom addition/remodification/deletion, every time it's "full replacement", loss of an incremental syntax.
- LLM could not maintain the hypothetical pool incrementally in multiple rounds of interaction (adding new assumptions, amending existing ones and relinquishing those no longer valid)
- History assumes that once replaced, the Reflection phase cannot trace "why has given up a certain direction"

Target: Add four built-in tools for `research-hypo-planner` to allow LLM directly to the hypothetical pool within the session
CRUD:

- `hypothesis_add`
- `hypothesis_update`
- `hypothesis_abandon` (Soft Delete)
- `hypothesis_list` (read-only, LLM query the current pool state in multiple rounds)

## 2. Data model and status machine

### 2.1 status count

`ResearchHypothesisTable.status` (research.sql.ts:164-188) is currently using only `"pending"`.
Expand to:

```
pending | active | testing | confirmed | rejected | abandoned
```

- `pending`: New but not yet incorporated into the current experimental scheme
- `active`: Testable assumptions in the current plan
- `testing`: submitted for experiment, awaiting results
- `confirmed`/ `rejected`: Experimental results support/negates this assumption
- `abandoned`: voluntarily abandoned by HypoPlanner (soft delete)

Status converted by HypoPlanner/ Reflection via `hypothesis_update`/
`hypothesis_abandon` driver, not mandatory binding conversion maps in this proposal, only valid value validation.

### 2.2 Soft Delete Fields

`AbandonHypothesis` does not physically delete:

- `status` to `"abandoned"`
- Add `abandon_reason: text()` (nullable)
- Add `abandoned_at: integer()` (timestamp, Nullable)

History rows are kept in the table for `hypothesis_list` filtering as required (the default excludes `abandoned` but supports)
`includeAbandoned` parameter.

### 2.3 `HypothesisObject` Type Extension

Add `HypothesisObject` to `hypo-planner-agent.ts:3-13`

```ts
status: "pending" | "active" | "testing" | "confirmed" | "rejected" | "abandoned"
abandonReason?: string
```

## 3. Service / Store Layer: Atoms CRUD

Add shared module `src/research/hypothesis-store.ts` (avoiding a dependency cycle between `tool/` and `service.ts`
Cycle dependence, both of which rely on this bottom module:

| Functions | Annotations |
|---|---|
| `resolveTaskIDBySessionID(sessionID)` | Query `ResearchTaskTable WHERE session_id = ?`, return `taskID` (for tool inverting jobs from `ctx.sessionID`) |
| `addHypothesisToPool(taskID, hypothesis)` | Insert Single Line, `id` Generated with `ResearchHypothesisID.ascending()`, `status` Default `"pending"` returns new `hypoID` |
| `updateHypothesisInPool(taskID, hypoID, patch)` | Local field updates; Verify that `hypoID` belongs to the `taskID` or is wrong |
| `abandonHypothesisInPool(taskID, hypoID, reason)` | `status="abandoned"`+ Write to `abandon_reason`/ `abandoned_at` |
| `listHypothesesInPool(taskID, { includeAbandoned? })` | Reuse existing `mapHypothesisRow()` (service.ts:746-759) map to `HypothesisObject[]` |

All writing operations are verified using `validateLLMHypothesisItem()` (service.ts:2650-2687).

`updateTaskHypothesisPlan()` (full replacement) retained as **fallback (no session/
Raw LLM mode)** The writing path is not deleted.

## 4. Tool Definition

New file `src/tool/research-hypothesis.ts`, using `Tool.define(...)`
(Effect-native, cf. `specs/effect/tools.md` and `tool/bash.ts`).

### 4.1 `hypothesis_add`

- Parameter: `HypothesisObject` Remove `id` / `status` / `abandonReason`
  (`statement, motivation[], expectedOutcome, suggestedBackbones[],
  suggestedPreprocessing[], priority, risk, testable`)
- Behaviour: Call `addHypothesisToPool`, `status` Default `pending`
- Return: `{ hypoID, status: "pending" }`

### 4.2 `hypothesis_update`

- Parameters: `{ hypoID: string, patch: Partial<WritableHypothesisFields & { status: HypothesisStatus }> }`
- Behaviour: Call `updateHypothesisInPool`; If `hypoID` is not part of the current task, return error supply
  LLM Self-correction
- Return: complete `HypothesisObject` as updated

### 4.3 `hypothesis_abandon`

- Parameter: `{ hypoID: string, reason: string }`
- Behaviour: Call `abandonHypothesisInPool` (soft delete)
- Return: `{ hypoID, status: "abandoned", abandonReason: reason }`

### 4.4 `hypothesis_list`

- Parameters: `{ includeAbandoned?: boolean, status?: HypothesisStatus[] }` (all options)
- Behaviour: Call `listHypothesesInPool`, default exclusion of `abandoned`
- Return: `HypothesisObject[]` (with `id/status`) for LLM on call
  add/update/abandon first understand the current status of the pool and avoid adding or updating non-existent ones
  `hypoID`

### 4.5 Public Realization Details

`execute(args, ctx)` Unanimously passes:

```ts
const taskID = yield* resolveTaskIDBySessionID(ctx.sessionID)
```

(a) Obtaining the tasks assigned to it; If `taskID` is missing (miscalled in non-research session), return the specified error message.

## 5. Register as a framework tool

By decision of the user, insert directly as a framework-building tool:

- Add to the list of built-in tools for `tool/registry.ts` (~189-207)
  `hypothesis_add` / `hypothesis_update` / `hypothesis_abandon` /
  `hypothesis_list` Four `Tool.Def`
- Global registration does not represent global availability - actual visibility is still available from individual missions
  Control (see section 6), the remaining angent default `"*": "deny"`, not affected

## 6. Agent Permission Adjustment (agent.ts)

`research-hypo-planner` (agent.ts:258-278) Personal release add:

```
"hypothesis_add": "allow"
"hypothesis_update": "allow"
"hypothesis_abandon": "allow"
"hypothesis_list": "allow"
```

The remaining three studies include anent (`research-data-analysis`/`research-reflection`/
`research-model-designer`) remains unchanged. Follow-up to Reflection read-only access to the hypothetical pool,
`hypothesis_list: "allow"` may be added separately (part of this proposal, left for follow-up).

## 7. Prompt Adjustment (research-hypo-planner.txt)

- Explicitly inform the model that assuming the "real value" of the pool is maintained through tools and no longer requires a repetition of all assumptions as
  markdown/JSON block
- Suggested workflow:
  1. Call `hypothesis_list` to understand the current pool status (includes historical `abandoned` items, avoid repeating attempts to verify failed directions)
  2. Call `hypothesis_add` for New Directions
  3. `hypothesis_update` (e.g., profile, status) is called on the basis of the latest test results
     Adjustments) or `hypothesis_abandon` (additional reason)
- Keep a short human readable summary (Reating part) for display in TUI, but not as a source of resolution

## 8. Connection to existing processes

- **session mode (with tools)**:
  - No more `updateTaskHypothesisPlan()` calls (avoid incremental results from overwrite tool)
  - No longer dependent on `parseLLMHypotheses()`
  - After turning, `HypoPlannerResult.hypotheses` passes
    `listHypothesesInPool(taskID)` Reads the latest pool state for summary/incident
- **Fallback (no session/ Raw LLM)**:
  - Maintain status quo: `generateLLMHypotheses()`+`updateTaskHypothesisPlan()`
    Full replacement is the same.

## 9. Event / Stream Update (event.ts)

Add `HypoPlannerAgentHypothesisChanged` event at each time
add/update/abandon tool `execute`

```ts
{
  taskID,
  action: "add" | "update" | "abandon",
  hypoID,
  snapshot: HypothesisObject  // Full object after change
}
```

`hypothesis_list` for read-only query, no event.

TUI / Web assumes that the pool view listens to the event for incremental refreshing without waiting for the entire round to end.

## 10. Test plan

- **store layer monometry** (`test/research/service.test.ts` or new file)
  `hypothesis-store.test.ts`):
  - `addHypothesisToPool` / `updateHypothesisInPool` /
    `abandonHypothesisInPool`/`listHypothesesInPool` Basic Behaviour
  - `resolveTaskIDBySessionID` Correctness
  - Overstepped scene: `hypoID` is wrong when it does not belong to the current `taskID`
  - Include `listHypothesesInPool` in the default exclusion, `includeAbandoned` after `abandon`
- **Tool monometry** (`test/tool/research-hypothesis.test.ts`):
  - mock `ctx.sessionID`, verify execute return value for four tools and DB status
  - Non-research error path for session calls
- **Integration/render testing** (`tsf-domain.test.ts`, cockpit rendering test):
  - Assume that the active/abandoned classification in UI displays correct after an incremental pool update
  - `HypoPlannerAgentHypothesisChanged` Event Trigger UI Refresh

## 11. Recommendations for order of achievement

1. `research.sql.ts`: add `abandon_reason`/ `abandoned_at` column, extension
   `status` take value (script migration)
2. `hypothesis-store.ts`: Atom CRUD+`resolveTaskIDBySessionID`
3. `src/tool/research-hypothesis.ts`: 4 `Tool.define(...)`
4. `tool/registry.ts`: Register four built-in tools
5. `agent.ts`:`research-hypo-planner` permission allowlist
6. `research-hypo-planner.txt`:prompt rewrite
7. Remove in `service.ts`:session mode
   `updateTaskHypothesisPlan` / `parseLLMHypotheses` Dependence, replace
   `listHypothesesInPool` Summary
8. `event.ts`+ issue point: `HypoPlannerAgentHypothesisChanged`
9. Test (Section 10)

## 12. Remaining open issues

- Whether the status map needs to be restrained (e.g. whether `confirmed`/ `rejected` is allowed after)
  `update`)？For the time being, this proposal is open-ended and will be subject to an itemized value verification. ]
- `hypothesis_list` Default page/quantity cap: The pool is expected to be smaller (in more than a dozen places),
  Timeless pages, follow-up `limit` if required
