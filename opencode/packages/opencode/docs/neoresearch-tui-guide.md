# NeoResearch TUI Guide

This guide explains the buttons, regions, and states in the NeoResearch Cockpit TUI. The interface supports autonomous time-series forecasting research: task creation, data inspection, agent-led model search, Neo-Cast execution, export, and human confirmation when required.

## Layout

The interface has four main regions:

- Top navigation: task switching, creation, execution controls, and interaction mode.
- Main workspace on the left: Research Agent logs, prompts, checkpoints, and operation results.
- Bottom input: natural-language requests, checkpoint approvals, and slash commands.
- Right sidebar: current task, next action, runner health, AutoResearch progress, and context.

## Top Navigation

| Button | Function | Typical use |
| --- | --- | --- |
| `Home` | Return to the workspace home. | View tasks or leave the cockpit. |
| `Previous Task` | Select the preceding research task. | Inspect another task in the workspace. |
| `Next Task` | Select the next research task. | Switch among concurrent tasks. |
| `New CSV Task` | Create a TSF task from CSV. | Import a time-series dataset. |
| `Seed Baselines` | Generate missing baseline candidates. | Initialize candidates for a new task. |
| `Agent Loop` | Start the automatic research loop. | Generate, execute, evaluate, reflect, and search once the runner is ready. |
| `Export Bundle` | Export task results. | Save reports, candidates, metrics, logs, and artifacts. |
| `Abort` | Cancel the active operation. | Interrupt a stalled request, agent stream, or long operation; gray means none is active. |
| `Mode ...` | Switch interaction modes. | Change human involvement between Companion and Socratic. |

Button colors generally indicate availability:

- Orange: available or primary action.
- Gray: unavailable because no task is selected, the runner is unready, work is busy, or the mode does not support it.

## Main Workspace

The large left region is the cockpit output stream. It displays:

- Research Agent status messages.
- User requests.
- Operation results, such as `runner root set for TSF Autonomous Research`.
- Companion checkpoint prompts.
- Live background output and errors.

For example:

```text
Companion checkpoint: review the proposed next step, approve gates, or ask for a recommendation.
Research Agent: runner root set for TSF Autonomous Research
```

This indicates Companion mode, where key steps await confirmation, and that runner-root repair has already run.

## Input Area

Use the bottom input to interact with Research Agent:

- Natural-language requests such as "continue", "explain why the runner is not ready", or "export current results".
- Checkpoint approvals such as "agree", "continue", or "approve".
- Slash commands, available through `ctrl+p commands` or `/`.

The status line below the input typically shows:

```text
Companion Intent Agent GLM-5.1
```

These are the current interaction mode, agent stage, and model.

Keyboard hints:

| Hint | Meaning |
| --- | --- |
| `esc interrupt` | Interrupt current interaction or background output. |
| `tab agents` | Switch or inspect agent entrypoints. |
| `ctrl+p commands` | Open the command palette. |

## Dual-loop configuration and controls

Use `/loop-config` (also available in the command palette) to edit the shared full-training limit,
Trials per Design, local and global no-improvement limits, Run-record limit, global deadline,
target metric, minimum relative improvement, and consecutive crash limit. Changes stay in a draft
until **Save configuration**. The full-training limit accepts 1–200 attempts. Optional deadline and
target fields accept `none`.

Configuration is editable before a cycle starts. Once bound, the dialog shows the effective policy
and its lock reason. An explicit `/append` creates a new budgeted cycle and unlocks its configuration
before execution. Reopening the TUI, resuming, and stepping through Trials preserve the current
cycle's counters and absolute deadline. Time spent paused still counts toward that deadline.

| Command | Boundary |
| --- | --- |
| `/trial` | Run at most one additional Trial and its Training Reflection, then pause. It can create the initial fixed Design. |
| `/optimize` | Continue the current fixed Design's inner loop, select its best model, and run Architecture Reflection. Pause before HypoPlanner. |
| `/finish-design` | Finish the current Design without additional tuning or training. Requires all its Trials to be finalized; runs Architecture Reflection and pauses before HypoPlanner. |
| `/resume` | Recover an interrupted bounded control at its saved boundary, or continue outer planning after a completed control. |
| `/loop-status` | Inspect Design → Trial history, scoped reflections, budgets, and the saved pause point. |
| `/abort` | Interrupt the active operation; reconcile its original execution before retrying if its final state is unknown. |

The controls are disabled while work is active, recovery requires reconciliation, or prerequisites
are missing. A stale Design selection or task revision is rejected by the server. Repeated requests
with the same idempotency key return the existing operation receipt.

Full-training reservations and Run records are separate budgets: a reserved full attempt uses one
shared training slot; smoke/full Run records also count toward the task's safety limit. CV folds,
schedulers, and execution recovery do not create a fresh training budget. The global stopping
conditions still apply to every bounded control.

The backing endpoints are `GET/PATCH /research/tasks/:taskID/loop-config` and
`POST /research/tasks/:taskID/loop-control`. Configuration writes require `expectedRevision`;
controls require `action`, `expectedRevision`, and `expectedDesignID` (nullable for an initial Trial).

## Right Sidebar

The sidebar is the main place to assess whether execution can continue.

### Title

Shows the selected task name, for example:

```text
TSF Autonomous Research
```

### Task

```text
Task
Task 1/3 · Candidate 0/0
```

This indicates task 1 of 3, with zero candidates out of zero.

### Next Step

```text
Next step
Configure Neo-Cast runner
Set runner root before runs.
```

The system prioritizes runner configuration. Agent Loop and experiment execution require a ready runner.

### Runner

Common states:

| State | Meaning | Action |
| --- | --- | --- |
| `ready` | Runner configured and executable. | Continue Agent Loop or candidate execution. |
| `Runner root missing` | No taskSpec.runtime.neoCastProjectRoot. | Select Use Project Runner or enter the root manually. |
| `Runner script missing` / `Missing py/validate.py` | Root points to a directory without py/validate.py. | Set the Neo-Cast project root. |
| `Runner Python missing` | Runtime not initialized. | Initialize runtime under runner root. |
| `Runner dataset mismatch` | Prepared dataset differs from the task. | Prepare it again to match taskSpec. |

Use Project Runner writes the current project's Neo-Cast root into task configuration. It repairs missing or wrong roots; if the root is correct but the dataset mismatches, prepare the dataset again.

## AutoResearch Progress

```text
▾ AutoResearch progress
✓ Intent Agent
→ Data Analysis Agent
• NAS Agent 0/12 runs
• Publish Agent
```

Symbols:

| Symbol | State |
| --- | --- |
| `✓` | Complete. |
| `→` | Running or next action. |
| `•` | Not started or awaiting prerequisites. |

Agent roles:

| Agent | Purpose |
| --- | --- |
| `Intent Agent` | Parse goals, task type, dataset, metrics, and constraints. |
| `Data Analysis Agent` | Profile data and identify missingness, trends, seasonality, correlation, and targets. |
| `NAS Agent` | Search and execute candidates within budget. 0/12 runs means zero completed out of at most twelve. |
| `Publish Agent` | Summarize the best results and produce reports, bundles, or deliverables. |

Example data summary:

```text
Requirements metric=val_avg_mse
data=ETTh1.csv / targets=OT / horizons=24 /
Profile rows=17420 / targets=1
missing=0 / trend=0.623583
seasonal=0.154844 / xcorr=0
shift=1.08905
```

This summarizes the objective metric, dataset, target columns, forecast horizon, and features extracted by Data Analysis Agent.

## Context

```text
Context
model GLM-5.1
session -
```

Shows model and session information. session - means no external session ID is bound or displayed.

## Version

The lower-right corner typically shows:

```text
.../opencode
NeoResearch v0.1.0-alpha.0
```

This identifies the working-directory suffix and NeoResearch version.

## Interpreting the Example State

If the sidebar shows:

```text
Runner dataset mismatch
Prepared dataset does not match task
```

The runner root and py/validate.py were found, but the dataset, horizons, input length, or targets in .neo-cast/dataset_spec.json differ from taskSpec.

Recommended order:

1. Confirm the intended dataset, targets, and forecast horizons.
2. Ensure runner root points to this project's neo_cast directory.
3. Rerun dataset preparation or Data Analysis to align dataset_spec.json with the task.
4. Once Runner shows ready, start Agent Loop.
