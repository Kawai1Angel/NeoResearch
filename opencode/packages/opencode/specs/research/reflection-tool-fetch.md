# Reflection Agent Tool-Fetch Migration Plan

## Background

HypoPlanner takes the required data voluntarily by means of a tool call (`read_reflection`, `experiment_results`, `hypothesis_list` etc.). Reflecting Agent is the opposite of the current pattern: service.ts preloads all data before calling, transforms it into a fat JSON injects LLM through `buildReflectionLLMUserPrompt`.

This plan adds two tools (`read_training_curve`, `read_memory_lessons`) to enable Reflection also to switch to tool-driven data acquisition mode.

---

## Situation analysis

### service.ts preload logic (7659 – 7712 row)

`runReflectionAgent` completes the following tasks before entering session:

| Preload | Source | Counterpart Tool |
|---|---|---|
| Recent Run Results (status, metric, error) | Sort `listRuns`+ | `experiment_results` (available) |
| Previous Reflection | Read File System | `read_reflection` (available) |
| The newest train | Check `runner_progress_jsonl` description Read JSONL files | ** `read_training_curve` (new)** |
| 2 | Sort `listMemory`+ | ** `read_memory_lessons` (new)** |
| Best memory lesson | I've been looking all over for the best. | ** `read_memory_lessons` (new)** |

With the addition of two tools, `ReflectionLLMContext` construction and fat JSON for `buildReflectionLLMUserPrompt` can be deleted.

---

## Add Tool Specification

### Tool 1: `read_training_curve`

**Document:** `src/tool/research-context.ts`

**Description:**
Read the training curve (epoch-by-epoch val loss) for a run in the current research task.
Returns an ordered array of `{ epoch, valLoss, horizon?, elapsedS? }` points, uniformly
sampled to `maxPoints` if the raw log is longer. Returns `{ available: false }` if no
progress artifact exists for the requested run.

**Parameters:**

| Parameters | Type | Default | Annotations |
|---|---|---|---|
| `runID` | `string?` | Ignore | Specify run; Automatically select the last `succeeded` run, then fallback to any recent run |
| `maxPoints` | `number?` | `60` | Returns the maximum number of points (1 — 120), selects evenly in excess, always keeping the end point |

**Implementation process:**
1. `resolveTaskIDBySessionID(ctx.sessionID)` → taskID; Unsolved Return `NOT_IN_RESEARCH_SESSION`
2. If `runID` is passed, check `ResearchRunTable` for attribution; Otherwise press `time_updated DESC` to find the nearest `succeeded`, fallback to any new run
3. Check `ResearchArtifactTable` where `task_id = taskID AND run_id = runID AND kind = "runner_progress_jsonl"` for `uri`
4. Read the file after removing `file://`, parse JSONL lines as `{ epoch, val_loss|valLoss, horizon?, elapsed_s|elapsedS? }`, and skip invalid lines.
5. If Point > maxPoints: even sample, `step = (n-1)/(maxPoints-1)` always contains the 0 and last point
6. Return:
```json
{
  "available": true,
  "runID": "...",
  "runStatus": "succeeded",
  "pointCount": 42,
  "curve": [{ "epoch": 1, "valLoss": 0.45 }, ...]
}
```
Return `{ "available": false }` when no artifact is found

**Reliance on removal:** `extractTrainingCurve` is currently a private function of `service.ts`, to be extracted to `research-context.ts` (or separate `src/research/training-curve.ts`) and export; For `service.ts` read iport.

---

### Tool 2: `read_memory_lessons`

**Document:** `src/tool/research-context.ts`

**Description:**
Read historical experiment memory for the current research task. Returns the most recent
lessons and, optionally, the lesson from the run that achieved the best primary metric.
Use this to avoid repeating known-failing designs and to ground new hypotheses in evidence.

**Parameters:**

| Parameters | Type | Default | Annotations |
|---|---|---|---|
| `recentLimit` | `number?` | `2` | Recent N lesson (1 – 10) |
| `includeBest` | `boolean?` | `true` | Whether or not to return the best metric corresponding lesson (dread, not duplicate with recent) |

**Implementation process:**
1. `resolveTaskIDBySessionID(ctx.sessionID)` → taskID
2. Check `ResearchMemoryTable` where `task_id = taskID`, press `time_created DESC` to take the full amount
3. Pre-`recentLimit` `recentLessons: string[]`
4. If `includeBest`:
   - Check extra `ResearchTaskTable.objective` for `direction` (`"minimize"`) | `"maximize"`)
   - Full mass of memories, read `candidate_summary.bestMetric` (number), press direction to find the best
   - If best memory is not in recentLessons `bestLesson: string`
5. Return:
```json
{
  "totalMemories": 7,
  "recentLessons": ["...", "..."],
  "bestLesson": "..."
}
```
`recentLessons: []`, `bestLesson` omitted when no record

---

## Change File List

| Documentation | Change Type | Contents |
|---|---|---|
| `src/tool/research-context.ts` | Add | `ReadTrainingCurveTool`,`ReadMemoryLessonsTool`; Move to `extractTrainingCurve` Logic |
| `src/tool/registry.ts` | Modify | Two new tools; Initialization of `yield*`; Add `tool map` and `builtin` lists |
| `src/research/service.ts` | Modify | Report `extractTrainingCurve` (if extracted as a separate file);**Subsequent phase** Delete 7659 — 7712 preload blocks, `ReflectionLLMContext`, `buildReflectionLLMUserPrompt` |
| `src/agent/prompt/research-reflection.txt` | Modify | **Follow-up phase** to HypoPlanner style workflow, describing the 4 step tool call process |

> Changes to `src/research/service.ts` and prompt fall under the follow-up phase** and are not included in this scope. This time only two tools + registration are delivered.

---

## Registration mode (registry.ts)

```ts
// import
import {
  ReadReflectionTool,
  ExperimentResultsTool,
  ReadTrainingCurveTool,   // Add
  ReadMemoryLessonsTool,   // Add
} from "./research-context"

// ♪ Layer inside yield*
const readTrainingCurve = yield* ReadTrainingCurveTool
const readMemoryLessons = yield* ReadMemoryLessonsTool

// tool map
readTrainingCurve: Tool.init(readTrainingCurve),
readMemoryLessons: Tool.init(readMemoryLessons),

// biltin list (following readReflection/ experimentResults)
tool.readTrainingCurve,
tool.readMemoryLessons,
```

---

## Follow-up phase: Reflection process workflow (reference)

After tool addition is completed, `research-reflection.txt` becomes:

```
## Workflow
1. Call experiment_results(limit=20) — review recent run outcomes.
2. Call read_reflection              — read what the previous Reflection cycle concluded.
   If { available: false }, this is the first iteration.
3. Call read_training_curve()        — load the training curve for the latest run.
4. Call read_memory_lessons()        — retrieve recent and best historical lessons.
5. Output the 7-key JSON object.
```

`buildReflectionLLMUserPrompt`'s fat JPON payload and service.ts 7659 – 7712 preloads were then deleted.

---

## Order of realization

1. Extract `extractTrainingCurve` logic (from service.ts to research-context.ts)
2. Achieved `ReadTrainingCurveTool`
3. Achieved `ReadMemoryLessonsTool`
4. Update `registry.ts`
5. Run typecheck + associated tests
6. (following) service.ts preload delete +prompt redraft
